# opencode-gnosis

OpenCode memory plugin backed by a self-hosted [gnosis](https://github.com/astra-hq/gnosis) service.

Implements the same memory-provider contract as [hermes-gnosis](https://github.com/nolgiainc/hermes-gnosis) but as a native OpenCode TypeScript plugin. Exposes five model-callable memory tools, automatic recall injection before each turn, and session compaction sync.

## Install

### From a checkout (recommended for development)

```bash
git clone https://github.com/astra-hq/opencode-gnosis.git
cd opencode-gnosis
npm install
npm run build
```

Then symlink or copy the built plugin into OpenCode's plugin directory:

```bash
mkdir -p ~/.config/opencode/plugins
ln -s "$(pwd)/dist/plugin.js" ~/.config/opencode/plugins/opencode-gnosis.js
```

OpenCode auto-discovers `.ts` and `.js` files at the top level of the plugin directory, so no explicit `plugin` entry is required in `opencode.json`.

### From npm (when published)

```bash
npm install -g opencode-gnosis
```

Then add to your `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-gnosis"]
}
```

## Configure

Create `~/.config/opencode/opencode-gnosis.json`:

```json
{
  "gnosis_url": "http://localhost:8080",
  "tenant_id": "nolgia",
  "agent_id": "opencode",
  "user_id": "opencode-user",
  "recall_mode": "context"
}
```

Set the service token via environment variable (preferred — never written to the JSON file):

```bash
export GNOSIS_SERVICE_TOKEN="your-bearer-token"
```

### Configuration precedence

1. `GNOSIS_SERVICE_TOKEN` environment variable (always wins for the token)
2. Plugin options from `opencode.json` tuple form
3. Project-local `.opencode/opencode-gnosis.json`
4. Global `~/.config/opencode/opencode-gnosis.json`
5. Environment variable defaults (`GNOSIS_URL`, `GNOSIS_USER_ID`, etc.)

### Settings

| Setting | Environment | Default | Meaning |
|---------|-------------|---------|---------|
| `gnosis_url` | `GNOSIS_URL` | *(required)* | Gnosis base URL |
| `gnosis_token` | `GNOSIS_SERVICE_TOKEN` | *(required)* | Bearer token |
| `user_id` | `GNOSIS_USER_ID` | `opencode-user` | Canonical user identifier |
| `agent_id` | `GNOSIS_AGENT_ID` | `opencode` | Agent scope component |
| `tenant_id` | `GNOSIS_TENANT_ID` | `nolgia` | Gnosis tenant |
| `timeout` | `GNOSIS_TIMEOUT` | `10` | HTTP timeout for reads (seconds) |
| `add_timeout` | `GNOSIS_ADD_TIMEOUT` | `30` | HTTP timeout for adds (seconds) |
| `recall_mode` | `GNOSIS_RECALL_MODE` | `context` | `context` (full pipeline) or `search` (raw vector) |

## Tools

The plugin registers exactly five tools:

| Tool | Behavior |
|------|----------|
| `gnosis_search` | Ranked semantic search; `limit` defaults to 10 and is capped at 50 |
| `gnosis_list` | Unranked paginated listing; `page_size` defaults to 100 and is capped at 200 |
| `gnosis_add` | Stores text verbatim with `infer=false` |
| `gnosis_update` | Replaces a memory by ID from a prior search/list result |
| `gnosis_delete` | Deletes a memory by ID from a prior search/list result |

Update and delete require the Gnosis server to have `GNOSIS_MEMORY_EDIT_ENABLED=true`.

## Auto-recall

Before each turn, the plugin automatically searches gnosis for memories relevant to the user's latest message and injects them as a synthetic system message. This uses OpenCode's `experimental.chat.messages.transform` hook.

- `recall_mode: "context"` (default): uses gnosis's full read pipeline (`/v1/memory/context`), which includes adaptive routing, supersession, graph-QA fusion, and Chain-of-Note
- `recall_mode: "search"`: uses raw vector search (`/v1/memories/search`)

If the context endpoint fails, the plugin degrades gracefully to raw search.

## Session compaction

When OpenCode compacts a session, the plugin sends the compacted summary to gnosis with `infer=true` for server-side fact extraction. This uses the `experimental.session.compacting` hook.

## Circuit breaker

The plugin maintains a consecutive-failure counter and opens its circuit after **5 consecutive failures**. While open, API calls are skipped for **120 seconds** and tools return a temporary-unavailable error. After the cooldown, calls resume automatically.

- `gnosis_list`, `gnosis_search`, `gnosis_update`, and `gnosis_delete` do not count HTTP 4xx errors as breaker failures
- `gnosis_add` counts any request exception, including HTTP 4xx
- Startup fetches and compaction sync count any request exception

## Scope and privacy

Every request carries this scope:

```json
{
  "tenant_id": "<tenant_id>",
  "space_id": "opencode",
  "agent_id": "<agent_id>",
  "session_id": "opencode",
  "user_id": "<user_id>",
  "visibility": "private_user"
}
```

Long-term recall spans sessions for a given `tenant_id` + `user_id`. The `session_id` records write provenance rather than partitioning reads.

## Development

```bash
cd opencode-gnosis
npm install
npm run dev     # watch mode
npm run build   # one-shot
npm run lint    # type-check only
```

The plugin is pure TypeScript with zero runtime dependencies (uses native `fetch`). It expects `zod` to be available in the OpenCode runtime for tool schema validation.

## Gnosis-side requirements

The configured service must expose these authenticated v1 endpoints:

- `POST /v1/memories` — verbatim adds and `infer=true` extraction
- `POST /v1/memories/search` — raw search
- `POST /v1/memory/context` — full read pipeline (for `recall_mode: "context"`)
- `POST /v1/memories/list` — paginated listing
- `PATCH /v1/memories/{id}` — updates
- `DELETE /v1/memories/{id}` — deletes

See the [gnosis getting-started guide](https://github.com/astra-hq/gnosis/blob/main/docs/getting-started.md) for service setup.

## License

MIT
