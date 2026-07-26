/**
 * OpenCode memory plugin backed by a self-hosted gnosis service.
 *
 * Implements the same memory-provider contract as hermes-gnosis but as an
 * OpenCode TypeScript plugin. Exposes five model-callable memory tools,
 * automatic recall injection before each turn, and session compaction sync.
 */

import { z } from "zod";
import { loadConfig, type GnosisConfig, DEFAULT_USER_ID } from "./config.js";
import { GnosisClient, CircuitBreaker, type MemoryScope } from "./client.js";
import {
  GnosisTools,
  SearchArgs,
  ListArgs,
  AddArgs,
  UpdateArgs,
  DeleteArgs,
} from "./tools.js";

// ---------------------------------------------------------------------------
// Plugin types (minimal — OpenCode provides these at runtime)
// ---------------------------------------------------------------------------

interface PluginInput {
  client: unknown;
  project: { name?: string; path?: string };
  directory: string;
  $: { shell: (cmd: string) => Promise<{ stdout: string; stderr: string }> };
}

interface ToolDef<T extends z.ZodType> {
  description: string;
  args: T;
  execute: (args: z.infer<T>) => Promise<string> | string;
}

interface PluginHooks {
  config?: (cfg: Record<string, unknown>) => void;
  tool?: Record<string, ToolDef<z.ZodType>>;
  "experimental.chat.messages.transform"?: (
    input: { messages: Array<Record<string, unknown>> },
    output: { messages: Array<Record<string, unknown>> },
  ) => Promise<void> | void;
  "experimental.session.compacting"?: (
    input: { context: string[] },
    output: { prompt?: string; context?: string[] },
  ) => Promise<void> | void;
}

type Plugin = (input: PluginInput, options?: Record<string, unknown>) => Promise<PluginHooks>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FALLBACK_SESSION_ID = "opencode";

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default (async (_input: PluginInput, options?: Record<string, unknown>): Promise<PluginHooks> => {
  const config = loadConfig(options as Partial<GnosisConfig> | undefined);

  if (!config.gnosis_url || !config.gnosis_token) {
    console.warn(
      "[opencode-gnosis] Not configured. Set GNOSIS_URL and GNOSIS_SERVICE_TOKEN " +
        "environment variables, or create ~/.config/opencode/opencode-gnosis.json",
    );
    // Return empty hooks so the plugin loads but does nothing
    return {};
  }

  const client = new GnosisClient(config.gnosis_url, config.gnosis_token, config.timeout, config.add_timeout);
  const breaker = new CircuitBreaker();

  // Resolve user_id: if explicitly configured (not the default), use it;
  // otherwise let the gateway assign a native id.
  const effectiveUserId = config.user_id === DEFAULT_USER_ID ? DEFAULT_USER_ID : config.user_id;

  const scope: MemoryScope = {
    tenant_id: config.tenant_id,
    space_id: "opencode",
    agent_id: config.agent_id,
    session_id: FALLBACK_SESSION_ID,
    user_id: effectiveUserId,
    visibility: "private_user",
  };

  const metadata: Record<string, unknown> = { channel: "opencode" };
  const tools = new GnosisTools(client, scope, breaker, metadata);

  // -------------------------------------------------------------------------
  // Auto-recall: before each turn, search gnosis and inject relevant memories
  // -------------------------------------------------------------------------

  const autoRecall = async (
    _input: { messages: Array<Record<string, unknown>> },
    output: { messages: Array<Record<string, unknown>> },
  ): Promise<void> => {
    if (breaker.isOpen()) return;

    // Find the latest user message to use as the recall query
    const messages = output.messages;
    let query = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg && msg.role === "user" && typeof msg.content === "string") {
        query = msg.content;
        break;
      }
    }

    if (!query) return;

    try {
      let memoryBlock = "";

      if (config.recall_mode === "context") {
        // Prefer gnosis's full read pipeline
        try {
          const sections = await client.getMemoryContext(scope, query, {
            includeShortTerm: false,
            includeLongTerm: true,
            includeReasoning: false,
            includeGraph: true,
            maxItems: 10,
          });
          memoryBlock = renderContextSections(sections);
        } catch {
          // Degrade to raw search if context endpoint fails
          const results = await client.search(scope, query, 10);
          memoryBlock = renderSearchResults(results);
        }
      } else {
        const results = await client.search(scope, query, 10);
        memoryBlock = renderSearchResults(results);
      }

      breaker.recordSuccess();

      if (memoryBlock) {
        // Prepend a synthetic system message with the memory context
        // OpenCode will inject this into the prompt for the model
        messages.unshift({
          role: "system",
          content: memoryBlock,
          synthetic: true,
        });
      }
    } catch (error) {
      breaker.recordFailure();
      console.debug("[opencode-gnosis] Auto-recall failed:", error);
    }
  };

  // -------------------------------------------------------------------------
  // Session compaction: store the session summary as a memory
  // -------------------------------------------------------------------------

  const onCompacting = async (
    input: { context: string[] },
    output: { prompt?: string; context?: string[] },
  ): Promise<void> => {
    if (breaker.isOpen()) return;

    const context = output.context ?? input.context;
    if (!context || context.length === 0) return;

    const summary = context.join("\n").trim();
    if (!summary) return;

    try {
      await client.add(scope, {
        content: `Session summary:\n${summary}`,
        infer: true,
        metadata: { ...metadata, source: "compaction" },
      });
      breaker.recordSuccess();
    } catch (error) {
      breaker.recordFailure();
      console.debug("[opencode-gnosis] Compaction sync failed:", error);
    }
  };

  // -------------------------------------------------------------------------
  // Return hooks
  // -------------------------------------------------------------------------

  return {
    tool: {
      gnosis_search: {
        description:
          "Search the user's memories by meaning; returns facts ranked by relevance. " +
          "Use this BEFORE answering any question that could depend on prior context " +
          "(the user's preferences, facts, history, people, projects, or earlier decisions).",
        args: SearchArgs,
        execute: (args) => tools.search(args),
      },
      gnosis_list: {
        description:
          "List ALL stored memories about the user, unranked and paginated. " +
          "Use for a full overview/audit, or to browse everything when you don't have a specific query.",
        args: ListArgs,
        execute: (args) => tools.list(args),
      },
      gnosis_add: {
        description:
          "Store a durable fact about the user, verbatim (no LLM extraction). " +
          "Call this the moment the user states a lasting preference, correction, decision, " +
          "or personal detail worth recalling on future turns.",
        args: AddArgs,
        execute: (args) => tools.add(args),
      },
      gnosis_update: {
        description:
          "Replace the text of an existing memory by its ID (take the ID from a " +
          "gnosis_search or gnosis_list result). Use when a stored fact has changed or was wrong.",
        args: UpdateArgs,
        execute: (args) => tools.update(args),
      },
      gnosis_delete: {
        description:
          "Delete a memory by its ID (take the ID from a gnosis_search or gnosis_list result). " +
          "Use when a stored fact is obsolete or the user asks you to forget it.",
        args: DeleteArgs,
        execute: (args) => tools.delete(args),
      },
    },

    "experimental.chat.messages.transform": autoRecall,
    "experimental.session.compacting": onCompacting,
  };
}) satisfies Plugin;

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function renderContextSections(sections: Array<{ source?: string; content?: string }>): string {
  const parts: string[] = [];
  for (const section of sections) {
    if (section.source === "short_term") continue;
    const content = (section.content ?? "").trim();
    if (content) parts.push(content);
  }
  if (parts.length === 0) return "";
  return "## Gnosis Memory\n" + parts.join("\n\n");
}

function renderSearchResults(results: Array<{ content?: string }>): string {
  const lines = results.map((r) => r.content).filter((c): c is string => Boolean(c));
  if (lines.length === 0) return "";
  return "## Gnosis Memory\n" + lines.map((l) => `- ${l}`).join("\n");
}
