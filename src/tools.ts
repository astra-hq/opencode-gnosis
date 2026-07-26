/**
 * Tool definitions for the opencode-gnosis plugin.
 *
 * Exposes five memory tools matching the hermes-gnosis surface:
 *   gnosis_search — ranked semantic search
 *   gnosis_list   — unranked paginated listing
 *   gnosis_add    — verbatim fact storage
 *   gnosis_update — replace memory by ID
 *   gnosis_delete — delete memory by ID
 */

import { z } from "zod";
import { GnosisClient, CircuitBreaker, type MemoryScope } from "./client.js";

const EDIT_DISABLED_MSG = "memory editing is disabled on the gnosis server";

export const SearchArgs = z.object({
  query: z.string().describe("What to search for."),
  limit: z
    .number()
    .min(1)
    .max(50)
    .optional()
    .describe("Max results (default: 10, max: 50)."),
});

export const ListArgs = z.object({
  page: z.number().min(1).optional().describe("Page number (default: 1)."),
  page_size: z
    .number()
    .min(1)
    .max(200)
    .optional()
    .describe("Results per page (default: 100, max: 200)."),
});

export const AddArgs = z.object({
  content: z.string().describe("The fact to store."),
});

export const UpdateArgs = z.object({
  memory_id: z.string().describe("Memory ID to update (from search/list result)."),
  content: z.string().describe("New text content."),
});

export const DeleteArgs = z.object({
  memory_id: z.string().describe("Memory ID to delete (from search/list result)."),
});

export type SearchInput = z.infer<typeof SearchArgs>;
export type ListInput = z.infer<typeof ListArgs>;
export type AddInput = z.infer<typeof AddArgs>;
export type UpdateInput = z.infer<typeof UpdateArgs>;
export type DeleteInput = z.infer<typeof DeleteArgs>;

function toolError(message: string): string {
  return JSON.stringify({ error: message });
}

export class GnosisTools {
  constructor(
    private client: GnosisClient,
    private scope: MemoryScope,
    private breaker: CircuitBreaker,
    private metadata: Record<string, unknown>,
  ) {}

  private checkBreaker(): string | null {
    if (this.breaker.isOpen()) {
      return toolError(
        "Gnosis temporarily unavailable (multiple consecutive failures). " +
          "Will retry automatically. Check that the gnosis service is running.",
      );
    }
    return null;
  }

  async search(input: SearchInput): Promise<string> {
    const blocked = this.checkBreaker();
    if (blocked) return blocked;

    try {
      const limit = Math.max(1, Math.min(input.limit ?? 10, 50));
      const results = await this.client.search(this.scope, input.query, limit);
      this.breaker.recordSuccess();

      if (results.length === 0) {
        return JSON.stringify({ result: "No relevant memories found." });
      }

      const items = results.map((r) => ({
        id: r.memory_id,
        memory: r.content,
        score: r.score,
      }));
      return JSON.stringify({ results: items, count: items.length });
    } catch (error) {
      if (!CircuitBreaker.isClientError(error)) {
        this.breaker.recordFailure();
      }
      return toolError(`Search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async list(input: ListInput): Promise<string> {
    const blocked = this.checkBreaker();
    if (blocked) return blocked;

    try {
      const page = Math.max(1, input.page ?? 1);
      const pageSize = Math.max(1, Math.min(input.page_size ?? 100, 200));
      const response = await this.client.list(this.scope, page, pageSize);
      this.breaker.recordSuccess();

      if (response.results.length === 0) {
        return JSON.stringify({ result: "No memories stored yet." });
      }

      const items = response.results.map((r) => ({
        id: r.memory_id,
        memory: r.content,
      }));
      return JSON.stringify({
        results: items,
        total: response.total,
        page: response.page,
        page_size: response.page_size,
      });
    } catch (error) {
      if (!CircuitBreaker.isClientError(error)) {
        this.breaker.recordFailure();
      }
      return toolError(`Failed to list memories: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async add(input: AddInput): Promise<string> {
    const blocked = this.checkBreaker();
    if (blocked) return blocked;

    try {
      const response = await this.client.add(this.scope, {
        content: input.content,
        infer: false,
        metadata: this.metadata,
      });
      this.breaker.recordSuccess();

      const results = Array.isArray(response.results) ? response.results : [];
      const memoryId =
        results.length > 0 && typeof results[0] === "object" && results[0] !== null
          ? (results[0] as Record<string, unknown>).memory_id
          : undefined;

      return JSON.stringify({
        result: "Fact stored.",
        memory_id: memoryId,
      });
    } catch (error) {
      this.breaker.recordFailure();
      return toolError(`Failed to store: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async update(input: UpdateInput): Promise<string> {
    const blocked = this.checkBreaker();
    if (blocked) return blocked;

    try {
      await this.client.update(this.scope, input.memory_id, input.content);
      this.breaker.recordSuccess();
      return JSON.stringify({ result: "Memory updated.", memory_id: input.memory_id });
    } catch (error) {
      if (error instanceof Error && error.message.includes("403")) {
        return toolError(EDIT_DISABLED_MSG);
      }
      if (CircuitBreaker.isClientError(error)) {
        return toolError(`Memory not found: ${input.memory_id}`);
      }
      this.breaker.recordFailure();
      return toolError(`Update failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async delete(input: DeleteInput): Promise<string> {
    const blocked = this.checkBreaker();
    if (blocked) return blocked;

    try {
      await this.client.delete(this.scope, input.memory_id);
      this.breaker.recordSuccess();
      return JSON.stringify({ result: "Memory deleted.", memory_id: input.memory_id });
    } catch (error) {
      if (error instanceof Error && error.message.includes("403")) {
        return toolError(EDIT_DISABLED_MSG);
      }
      if (CircuitBreaker.isClientError(error)) {
        return toolError(`Memory not found: ${input.memory_id}`);
      }
      this.breaker.recordFailure();
      return toolError(`Delete failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
