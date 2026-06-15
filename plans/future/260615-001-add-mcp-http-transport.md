# Add MCP Streamable HTTP Transport

## Task Overview

Implement MCP server over HTTP (Streamable HTTP transport) alongside the existing stdio transport. Mutually exclusive modes (`--mcp stdio` vs `--mcp http`), sharing the same `McpServer` instance and tool definitions. Stateless sessions, `/mcp` endpoint, reserved slug.

## Decisions (from grilling session)

| Decision | Choice |
|----------|--------|
| Session mode | Stateless (no session tracking, no resumption) |
| Endpoint path | `/mcp` (hardcoded, non-configurable) |
| Reserved slug | `mcp` blocked from user registration |
| Coexistence with stdio | Mutually exclusive — one transport per process |
| CLI flag | `--mcp http` (validates value, rejects unknown) |
| Config shape | `mcpTransport: "stdio" \| "http" \| null` (replaces `mcpStdio: boolean`) |
| Startup banner | Include MCP URL when HTTP mode is active |
| Dashboard | Always-visible MCP client config section when HTTP mode is active |
| Tool definitions | Reuse existing `createMcpServer()` — zero changes to `mcp.ts` |
| Wiring | Extract `fetchHandler` as configurable factory accepting optional transport |
| Tests | Add to existing `tests/mcp-integration.test.ts` (spawned server + HTTP client) |
| Auth | None (trusted local network, documented limitation) |
| Persistence | No change — handlers are shared, `saveRegistry()` behavior unchanged |

## File-by-File Plan

### Step 1: `cli.ts` — Config refactor

**Goal:** Replace `mcpStdio: boolean` with `mcpTransport: "stdio" | "http" | null`.

Changes:
- Update `CliConfig` interface: `mcpTransport: "stdio" | "http" | null`
- In `parseCliArgs()`, when `--mcp` is encountered, read next arg:
  - `"stdio"` → `mcpTransport = "stdio"`
  - `"http"` → `mcpTransport = "http"`
  - anything else → `console.error("Unknown MCP transport: <value>. Use 'stdio' or 'http'.")` + `process.exit(1)`
- Default: `mcpTransport = null`
- Update `log` function: `config.mcpTransport === "stdio" ? console.error : console.log`
- Export updated `CliConfig` type

**DRY note:** The `log` function and `logRequest` both depend on the transport check — keep it as a single expression derived from config, no duplication.

### Step 2: `handlers.ts` — Reserve `mcp` slug

**Goal:** Reject `mcp` as a user-provided slug.

Changes in `handleRegister`:
- After slug is determined (user-provided or auto-generated), check: `if (slug === "mcp")` → return 400 error with message `"Slug 'mcp' is reserved for the MCP HTTP endpoint."` and hint `"Choose a different slug or omit it to auto-generate one."`
- Place the check after format validation (regex) but before collision check (registry lookup)

**KISS note:** Single string comparison. No reserved words array — just `mcp` for now. If more reserved slugs are needed later, refactor to a set.

### Step 3: `http.ts` — Fetch handler factory

**Goal:** Make the fetch handler configurable with an optional MCP transport.

Changes:
- Define interface: `interface HttpServerOptions { mcpTransport?: object; }` — use `object` to avoid importing the SDK's Transport type into http.ts (keeps deps acyclic; http.ts doesn't need to know MCP internals)
- Create factory: `export function createFetchHandler(options?: HttpServerOptions): (req: Request) => Promise<Response>`
- Inside the returned handler, add early guard before existing routing:
  ```
  if (options?.mcpTransport && (pathname === "/mcp" || pathname.startsWith("/mcp/"))) {
    return (options.mcpTransport as any).handleRequest(req);
  }
  ```
  The `any` cast is acceptable here — http.ts delegates to the transport without inspecting its internals. The transport's `handleRequest` signature (`Request → Promise<Response>`) matches `Bun.serve` exactly.
- Update `startHttpServer` to accept `HttpServerOptions` and pass to factory
- Dashboard serving (GET /): when MCP HTTP mode is active, read `dashboard.html` as text and inject the config snippet before returning. Detection: check if `options?.mcpTransport` exists.

Dashboard injection approach:
- Read file: `const content = (await Bun.file("./dashboard.html").text())`
- Inject before `</body>`: a `<div class="card">` with heading "MCP Client Config" and a `<pre><code>` block containing the JSON config with the actual port
- String replacement: `content.replace('</body>', configSnippet + '</body>')`

### Step 4: `index.ts` — Wire HTTP transport

**Goal:** Create and connect the appropriate transport based on config.

Changes:
- Import: `import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"`
- Branch on `config.mcpTransport`:
  - `"stdio"`: existing behavior (StdioServerTransport, connect, log banner)
  - `"http"`: create `McpServer`, create `WebStandardStreamableHTTPServerTransport` (no options → stateless), connect, pass to `startHttpServer({ mcpTransport: transport })`, log banner with MCP URL
  - `null`: existing non-MCP behavior
- Banner for HTTP mode: `MCP HTTP endpoint: http://0.0.0.0:<port>/mcp`

**KISS note:** The `WebStandardStreamableHTTPServerTransport` constructor takes no required options for stateless mode. Pass `{}` or omit entirely.

### Step 5: `dashboard.html` — No changes needed

The dashboard is served statically. The config snippet is injected server-side in Step 3's factory. The HTML file itself stays untouched.

The injected section format:
```html
<div class="card" style="margin-top: 1rem;">
  <h2>MCP Client Config</h2>
  <p style="font-size: 0.85rem; color: #666; margin-bottom: 0.5rem;">
    Add this to your MCP client config to connect:
  </p>
  <pre style="background: #f5f5f5; padding: 0.75rem; border-radius: 4px; font-size: 0.85rem; overflow-x: auto;">
{
  "url": "http://localhost:8080/mcp"
}
  </pre>
</div>
```

Port is injected via string replacement of `8080` placeholder during server-side injection.

### Step 6: `tests/mcp-integration.test.ts` — HTTP transport tests

**Goal:** Add HTTP transport integration tests alongside existing stdio tests.

Changes:
- Add new `describe("MCP HTTP transport (StreamableHTTP)")` block
- Spawn server with `--mcp http --port <TEST_PORT>`
- Use a dedicated port (e.g., `19879`) to avoid collision with stdio integration tests
- Tests:
  1. **Server starts and /mcp is reachable** — POST JSON-RPC initialize to `/mcp`, expect valid response
  2. **register_folder works end-to-end** — call tool via HTTP, assert `CrudResult`
  3. **list_folders returns entries** — register then list
  4. **Non-MCP routes unaffected** — verify `GET /` still returns dashboard/JSON
  5. **Reserved slug `mcp` rejected** — try to register with `slug: "mcp"`, expect error
  6. **HTTP server running alongside MCP** — register via MCP, then fetch file via HTTP URL
- Use `afterEach` to kill spawned processes
- For JSON-RPC over HTTP: construct POST requests manually with `Content-Type: application/json` and JSON-RPC payload (no MCP client SDK needed — raw HTTP is sufficient and more transparent for testing)

**DRY note:** The stdio integration tests already cover tool correctness. HTTP tests focus on transport-layer behavior (endpoint routing, coexistence with file serving). Keep HTTP tests minimal — verify the transport works, not every tool permutation.

### Step 7: Docs

**`SPEC.md`:**
- Add section "MCP HTTP Endpoint" after API Specification
- Document: `POST /mcp` accepts JSON-RPC 2.0 requests, returns JSON-RPC responses
- Include example request/response
- Note: stateless mode, no session tracking

**`AGENTS.md`:**
- Commands table: add `bun run src/index.ts --mcp http`
- Architecture section: note the two transport options

**`CONTEXT.md`:** Already updated during grilling session.

## Dependency Graph

```
Step 1 (cli.ts) ──┬──► Step 4 (index.ts)
                   └──► Step 3 (http.ts) ──► Step 5 (dashboard injection)
Step 2 (handlers.ts) ──► (independent, can do anytime)
Step 6 (tests) ── depends on Steps 1-5
Step 7 (docs) ── independent
```

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| SDK transport API changes | Low | SDK v1.29.0 is stable; integration test catches breakage |
| `handleRequest` returns streaming Response that Bun can't handle | Very low | `WebStandardStreamableHTTPServerTransport` uses Web Standard APIs (Request/Response/ReadableStream) — Bun's native stack |
| Dashboard injection breaks HTML structure | Low | String replace on `</body>` is safe; test with visual check |
| Port collision in tests | Medium | Dedicated test ports (19878 stdio, 19879 http) |

## Out of Scope

- OAuth / authentication (documented limitation)
- Stateful sessions with resumption
- SSE transport (deprecated in SDK)
- Configurable MCP endpoint path
- Simultaneous stdio + HTTP transport
- MCP client SDK usage in tests (raw HTTP POST is sufficient)

## Estimated Effort

~200-250 lines of code across 5 source files + 1 test file + 2 doc files.
