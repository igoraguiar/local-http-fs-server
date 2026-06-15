# Add MCP stdio server mode for AI agent folder management

## Task Overview

Add an MCP (Model Context Protocol) stdio server option to the local HTTP file server. The user launches the CLI with `--mcp stdio`, and the app starts in dual mode: the HTTP server continues serving files on its configured port, while an MCP stdio listener on stdin/stdout lets an AI coding agent manage folder registrations programmatically. The agent's primary workflow is registering a web project folder, getting back an HTTP URL, and having the browser load it — all without the agent needing to start a separate HTTP server.

**Decisions locked (grilled session, 2026-06-14):**

| # | Decision | Result |
|---|----------|--------|
| 1 | Dependency | `@modelcontextprotocol/sdk` (full `Server` class + `StdioServerTransport`) — first runtime dependency, recorded in ADR-0001 |
| 2 | Tools | 4: `register_folder`, `unregister_folder`, `update_folder`, `list_folders` |
| 3 | CLI | `--mcp stdio`, `--port <n>`, `--persist[=<path>]`; precedence: switches > env vars > defaults |
| 4 | Responses | Rich — mirror HTTP API format (slug, path, url, subdomain_url, timestamps) |
| 5 | SDK depth | Full integration — `Server` class handles JSON-RPC, handshake, tool registration |
| 6 | Refactoring | Extract shared CRUD functions from HTTP `fetch` callback; both HTTP and MCP call the same functions |
| 7 | Tool params | Mirror HTTP API params; clarify non-obvious behavior (PUT lookup rules) in tool descriptions |
| 8 | stdout/stderr | When MCP active: stdout = MCP JSON-RPC only; stderr = all logs |

## Plan

### Phase 0 — package.json (5 min)

Add `@modelcontextprotocol/sdk` as a runtime dependency. Can be done first so `bun install` runs before any coding.

### Phase 1 — CLI argument parser (~40 lines, 30 min)

Replace the hardcoded `PORT`, `PERSIST`, `REGISTRY_FILE` constants with a parsed config object:

```typescript
interface CliConfig {
  port: number;
  mcpStdio: boolean;
  persist: boolean;
  registryFile: string;
}

function parseCliArgs(): CliConfig { /* ... */ }
```

Precedence: CLI switch > env var > default. Handles:
- `--mcp stdio` (positional after flag)
- `--port 3000` (value after space)
- `--persist` (boolean) and `--persist=/path/to/file.json` (value after `=`)

No external parser — manual `process.argv` iteration.

### Phase 2 — Extract shared CRUD functions (~150 lines refactoring, 60 min)

Pull the 4 CRUD operations out of the `fetch` callback into standalone functions. Each returns a `CrudResult`:

```typescript
interface CrudResult {
  ok: boolean;
  status: number;
  message: string;
  data?: Record<string, unknown>;
  details?: Record<string, unknown>;
  hint?: string;
}
```

Functions:
- `handleList(port: number): CrudResult` — ~20 lines (from 37, minus Accept negotiation)
- `handleRegister(body: Record<string, unknown>, port: number): Promise<CrudResult>` — ~80 lines (from 120, minus JSON parsing and Response wrapping)
- `handleUnregister(identifier: { slug?: string; folder_path?: string }): CrudResult` — ~40 lines (from 66)
- `handleUpdate(body: Record<string, unknown>, port: number): Promise<CrudResult>` — ~80 lines (from PUT block)

The HTTP `fetch` callback becomes a thin adapter: parse request → call handler → wrap `CrudResult` in `Response.json()` via existing `ok()`/`err()` helpers.

**Gate:** Run `bash test.sh` after this phase to verify zero HTTP regression.

### Phase 3 — MCP server setup (~80 lines, 45 min)

Import and wire `@modelcontextprotocol/sdk`:

1. Create `Server` instance with name, version, capabilities
2. Register 4 tools via `server.tool()`, each calling the shared CRUD function and adapting `CrudResult` → MCP response format (`{ content: [{ type: "text", text: JSON.stringify(result) }], isError?: boolean }`)
3. Each tool definition includes: name, description (with lookup rules clarified), JSON schema for parameters
4. Connect server to `StdioServerTransport`

Tool schemas:
- `register_folder`: `{ folder_path: "string", slug: "string" }` — slug optional
- `unregister_folder`: `{ slug: "string", folder_path: "string" }` — at least one required
- `update_folder`: `{ slug: "string", folder_path: "string" }` — description explains: "Provide `slug` to identify the entry and `folder_path` to change its path. If only `folder_path` is given, it is the lookup key and `slug` becomes the new slug."
- `list_folders`: `{}` (no params)

### Phase 4 — Dual-mode startup + stdout/stderr split (~30 lines, 15 min)

At the bottom of `index.ts`:

1. **Logging split:** When MCP mode is active, all `console.log()` calls are redirected to `stderr` to keep stdout clean for MCP JSON-RPC. Single-line swap:

```typescript
const log = config.mcpStdio ? console.error.bind(console) : console.log.bind(console);
```

Replace all `console.log(...)` with `log(...)`. Existing `console.warn()` and `console.error()` stay as-is (already stderr).

2. Always start `Bun.serve()` with HTTP server (unchanged behavior)
3. If `config.mcpStdio` is true: initialize and connect MCP server to stdio
4. Print startup banner via `log()` (stdout without MCP, stderr with MCP)

### Phase 5 — Polish (~10 min)

- Verify `test.sh` passes (HTTP-only, no MCP flag)
- Manual smoke test: `bun run index.ts --mcp stdio` + MCP client calls
- Verify no stdout corruption (no log lines leaking into MCP stream)

### Phase 6 — bun:test suite (~120 lines, 45 min)

Two test files, both using `bun:test` (zero deps beyond Bun):

**`mcp.test.ts` — In-memory transport (unit tests, fast)**

Uses `InMemoryTransport.createLinkedPair()` to link a `Server` and `Client` in the same process. No child process, no stdio, no HTTP server. Tests the MCP tool logic directly.

Setup per test: create linked transports → build server with tool registrations → connect client → `client.initialize()` → run assertions.

Tests:
1. **tools/list returns 4 tools** — `client.listTools()` has `register_folder`, `unregister_folder`, `update_folder`, `list_folders`
2. **register_folder creates entry and returns URL** — call tool, assert `slug`, `path`, `url` in response; verify `list_folders` shows it
3. **register_folder rejects non-absolute path** — assert error response
4. **register_folder rejects non-existent directory** — assert error response
5. **register_folder rejects duplicate path** — assert 409-style error
6. **register_folder accepts custom slug** — pass `slug` param, assert it's used
7. **unregister_folder removes entry** — register then unregister, verify `list_folders` is empty
8. **unregister_folder rejects unknown slug** — assert error response
9. **update_folder changes path** — register, update with new path, verify new URL
10. **update_folder changes slug** — register, update with new slug, verify new slug
11. **list_folders returns empty array on start** — fresh server, no registrations
12. **list_folders returns all entries** — register 2 folders, verify count and URLs

**`mcp-integration.test.ts` — Stdio transport (integration test, slower)**

Uses `StdioClientTransport` to spawn `bun run index.ts --mcp stdio` as a child process. Tests the full pipeline: CLI parsing → server construction → stdio communication.

Tests:
1. **server starts and responds to initialize** — spawn process, connect client, verify handshake
2. **register_folder works end-to-end** — call tool over stdio, assert response
3. **HTTP server is running alongside MCP** — after registering via MCP, `fetch()` the HTTP URL and verify 200
4. **stderr has logs, stdout is clean JSON** — capture stderr from child, verify startup banner is there; verify no log lines leaked into MCP stream

Cleanup: kill child process after each test.

## Dependencies Between Phases

```
Phase 0 (package.json) ───────────────────────────────┐
                                                       ↓
Phase 1 (CLI parser) ──────────┐                      ↓
                               ↓                  Phase 3 (MCP server)
Phase 2 (CRUD extraction) ─────┤                      ↑
                               ↓                      ↑
                               └────→ Phase 4 (startup + logging) ←┘
                                                    
Phase 5 (polish/tests)
    ↓
Phase 6 (bun:test suite)
```

- Phase 6 depends on Phases 2 and 3 (shared CRUD functions + MCP server construction)
- For in-memory tests: import CRUD functions and server setup directly (no process spawning)
- For integration tests: spawn the full binary with `--mcp stdio`

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| SDK API differs from expected (types, constructor) | Medium | Read SDK types before coding; adapt at Phase 3 |
| Stdin chunking corrupts JSON-RPC messages | Low | SDK's `StdioServerTransport` handles this |
| CRUD extraction breaks HTTP behavior | Medium | `bash test.sh` gate after Phase 2 |
| `console.log` leak into stdout during MCP | Low | `log` variable swap catches all paths; grep for `console.log` before merge |
| `--persist=` parsing edge cases | Low | Manual test: `--persist`, `--persist=foo.json`, `--persist=` (empty) |
| InMemoryTransport requires server to be constructable without Bun.serve | Medium | Factor MCP server construction into a function (e.g., `createMcpServer(registry, config)`) so tests can call it without starting the HTTP server |

## Estimated Effort

| Phase | Lines | Time |
|-------|-------|------|
| 0. package.json | ~3 | 5 min |
| 1. CLI parser | ~40 | 30 min |
| 2. CRUD extraction | ~150 (refactor) | 60 min |
| 3. MCP server | ~80 | 45 min |
| 3b. Factor `createMcpServer()` | ~10 (refactor) | 10 min |
| 4. Dual-mode startup + logging | ~30 | 15 min |
| 5. Polish | ~0 | 10 min |
| 6. bun:test suite | ~120 | 45 min |
| **Total** | **~430** | **~3.75 hours** |


