/**
 * HTTP client for the gnosis memory service API (v1).
 *
 * Endpoint contract:
 *   POST   {base}/v1/memories          — add
 *   POST   {base}/v1/memories/search   — search
 *   POST   {base}/v1/memory/context    — full read pipeline
 *   POST   {base}/v1/memories/list     — list
 *   PATCH  {base}/v1/memories/{id}     — update
 *   DELETE {base}/v1/memories/{id}     — delete
 *
 * Auth: Authorization: Bearer <token>
 */

export interface MemoryScope {
  tenant_id: string;
  space_id: string;
  agent_id: string;
  session_id: string;
  user_id: string;
  visibility: "private_user";
}

export interface GnosisMemory {
  memory_id?: string;
  content?: string;
  score?: number;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface ContextSection {
  source: string;
  memory_type?: string;
  content: string;
  facts?: unknown[];
}

export class GnosisError extends Error {
  statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "GnosisError";
    this.statusCode = statusCode;
  }
}

export class GnosisPermissionError extends GnosisError {
  constructor(message: string) {
    super(message, 403);
    this.name = "GnosisPermissionError";
  }
}

export class GnosisClient {
  private baseUrl: string;
  private token: string;
  private timeout: number;
  private addTimeout: number;

  constructor(baseUrl: string, token: string, timeout = 10, addTimeout = 30) {
    if (!baseUrl) throw new Error("gnosis base_url is required");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.timeout = timeout;
    this.addTimeout = addTimeout;
  }

  private async request(
    method: string,
    path: string,
    jsonBody: Record<string, unknown>,
    timeout?: number,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeoutMs = (timeout ?? this.timeout) * 1000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(jsonBody),
        signal: controller.signal,
      });

      if (response.status === 403) {
        throw new GnosisPermissionError(
          `gnosis returned 403 for ${method} ${path}`,
        );
      }

      if (response.status >= 400) {
        const detail = await response.text();
        throw new GnosisError(
          `gnosis API error ${response.status} for ${method} ${path}: ${detail.slice(0, 500)}`,
          response.status,
        );
      }

      if (!response.body) {
        return {};
      }

      const data = (await response.json()) as unknown;
      return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
    } catch (error) {
      if (error instanceof GnosisError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new GnosisError(`gnosis request timed out after ${timeoutMs}ms: ${method} ${path}`);
      }
      throw new GnosisError(`gnosis request failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async add(
    scope: MemoryScope,
    options: {
      messages?: Array<{ role: string; content: string }>;
      content?: string;
      infer?: boolean;
      metadata?: Record<string, unknown>;
    },
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { scope, infer: options.infer ?? false };
    if (options.messages !== undefined) body.messages = options.messages;
    if (options.content !== undefined) body.content = options.content;
    if (options.metadata !== undefined) body.metadata = options.metadata;
    return this.request("POST", "/v1/memories", body, this.addTimeout);
  }

  async search(scope: MemoryScope, query: string, limit = 10): Promise<GnosisMemory[]> {
    const body = { scope, query, limit };
    const response = await this.request("POST", "/v1/memories/search", body);
    const results = response.results;
    return Array.isArray(results) ? (results as GnosisMemory[]) : [];
  }

  async getMemoryContext(
    scope: MemoryScope,
    query: string,
    options: {
      includeShortTerm?: boolean;
      includeLongTerm?: boolean;
      includeReasoning?: boolean;
      includeGraph?: boolean;
      maxItems?: number;
    } = {},
  ): Promise<ContextSection[]> {
    const body: Record<string, unknown> = {
      scope,
      query,
      include_short_term: options.includeShortTerm ?? false,
      include_long_term: options.includeLongTerm ?? true,
      include_reasoning: options.includeReasoning ?? false,
      include_graph: options.includeGraph ?? true,
      max_items: options.maxItems ?? 10,
    };
    const response = await this.request("POST", "/v1/memory/context", body);
    const sections = response.sections;
    return Array.isArray(sections) ? (sections as ContextSection[]) : [];
  }

  async list(scope: MemoryScope, page = 1, pageSize = 100): Promise<{
    results: GnosisMemory[];
    total: number;
    page: number;
    page_size: number;
  }> {
    const body = { scope, page, page_size: pageSize };
    const response = await this.request("POST", "/v1/memories/list", body);
    const results = Array.isArray(response.results) ? (response.results as GnosisMemory[]) : [];
    return {
      results,
      total: typeof response.total === "number" ? response.total : results.length,
      page: typeof response.page === "number" ? response.page : page,
      page_size: typeof response.page_size === "number" ? response.page_size : pageSize,
    };
  }

  async update(scope: MemoryScope, memoryId: string, content: string): Promise<Record<string, unknown>> {
    const body = { scope, content };
    return this.request("PATCH", `/v1/memories/${memoryId}`, body);
  }

  async delete(scope: MemoryScope, memoryId: string): Promise<Record<string, unknown>> {
    const body = { scope };
    return this.request("DELETE", `/v1/memories/${memoryId}`, body);
  }
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_SECS = 120;

export class CircuitBreaker {
  private consecutiveFailures = 0;
  private breakerOpenUntil = 0;

  isOpen(): boolean {
    if (this.consecutiveFailures < BREAKER_THRESHOLD) {
      return false;
    }
    if (Date.now() >= this.breakerOpenUntil) {
      this.consecutiveFailures = 0;
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= BREAKER_THRESHOLD) {
      this.breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_SECS * 1000;
      console.warn(
        `Gnosis circuit breaker tripped after ${this.consecutiveFailures} consecutive failures. ` +
          `Pausing API calls for ${BREAKER_COOLDOWN_SECS}s.`,
      );
    }
  }

  static isClientError(error: unknown): boolean {
    if (error instanceof GnosisError && error.statusCode !== undefined) {
      return error.statusCode >= 400 && error.statusCode < 500;
    }
    return false;
  }
}
