# Context: Local HTTP File Server

> Created during plan grilling session (2026-06-14). Captures terminology and key decisions for future sessions.

---

## Glossary

| Term | Definition |
|------|-----------|
| **MCP Server Mode** | Optional mode activated by `--mcp <transport>`. Two mutually exclusive transports: `stdio` (JSON-RPC on stdout, logs on stderr) and `http` (Streamable HTTP on `/mcp` endpoint, stateless sessions). Both share the same `McpServer` instance, same 4 tools, and same in-memory registry. |
| **MCP HTTP Transport** | Streamable HTTP transport (`WebStandardStreamableHTTPServerTransport`) serving MCP JSON-RPC on `/mcp` endpoint. Stateless mode (no session tracking). Same tools and handlers as stdio mode. No authentication (trusted local network). `mcp` slug is reserved and blocked from user registration. |
| **MCP Tool** | A named function exposed by the MCP server, with a JSON schema for parameters and a structured response. Mirrors the HTTP CRUD API (register, unregister, update, list) with rich responses including HTTP URLs. |
| **CLI Precedence** | Configuration resolution order: CLI switches > env vars > hardcoded defaults. E.g., `--port 3000` overrides `PORT=6868`, which overrides the default `6868`. |
| **Slug** | URL-safe unique identifier for a registered folder, composed of a readable basename + random suffix (8 chars). Format: `^[a-z0-9][a-z0-9_-]{0,63}$`. Used as route prefix (`/<slug>/`) and subdomain (`<slug>.localhost`). |
| **Registry** | In-memory `Map<string, FolderEntry>` keyed by slug. Holds all active folder registrations. Backed by `registry.json` on disk when persistence is enabled. |
| **FolderEntry** | Interface with fields: `slug`, `path` (absolute), `createdAt`, `updatedAt`. One entry per registered directory. |
| **Path Safety Checker** | Helper that validates resolved file paths stay within the registered folder root. Prevents path traversal attacks. |
| **Accept Heuristic** | Phase 5 uses simple string check: if Accept header *contains* `application/json`, serve JSON. Otherwise serve HTML dashboard. No RFC 7231 quality-value parsing. |

## Key Decisions

### Slug Generation
- **Suffix length:** 8 characters (not 6). ~2^48 entropy space eliminates practical collision risk.
- **User-provided slugs:** Validated against regex, rejected with 400 if invalid — never silently corrected. Auto-generation only when slug is omitted/empty.
- **Auto-generation:** Normalized basename + 8-char random suffix. No retry escalation needed (collision probability near zero at 8 chars).

### PUT Handler Lookup
- **Strict rule:** When both `slug` and `folder_path` are in the request body, `slug` is always the lookup key and `folder_path` is always the update target. Eliminates ambiguity.

### Dashboard Content Negotiation
- **Simple heuristic** (no RFC parsing): `Accept.includes('application/json')` → JSON. Everything else → HTML dashboard.
- curl without Accept defaults to HTML. Use `-H 'Accept: application/json'` for JSON.

### Security Testing
- **Manual verification through Phase 2.** Automated security tests (bun:test, zero deps) added during Phase 3+ to cover path traversal edge cases (`..%252f`, symlink escapes, regressions).

### Persistence
- **Synchronous writes** on every mutation. Chosen for correctness over throughput. Event loop blocked briefly per mutation — acceptable for local use.

### Helper Extraction Strategy
- **Incremental:** Only create helpers when their phase arrives. Phase 1 creates Response Formatter, Slug Generator, Slug Validator. Phase 2 adds Path Safety Checker and Subdomain Extractor. Phase 3 adds Range Request Parser.

### Response Headers
- **X-Folder-Path:** Truncated to `path.basename()` (last path component only). E.g., `/home/user/documents` → `documents`. No full path exposure in file-serving responses.

### Phase Dependencies
- **Phase 5 depends only on Phase 1.** Dashboard uses the JSON CRUD API exclusively — does not require file serving (Phase 2) to function.

### ETag Computation
- **Slug-inclusive:** ETag is `W/"${slug}-${size}-${mtime}"` — includes slug to eliminate cross-folder collisions when two files in different folders share identical size+mtime.

### GET / Format Override
- **Query parameter:** `?format=json` forces JSON response regardless of Accept header. Provides explicit control for scripts and LLM agents without requiring header manipulation.

### PUT Handler Operation Order
- **Validate-and-go:** Delete old Map entry first, then insert new. TOCTOU window accepted as near-zero for single-process model.

### XSS Protection
- Dashboard uses `textContent` for all dynamic text and `encodeURIComponent` for URLs in href attributes. Zero `innerHTML` usage. No external dependencies (no DOMPurify).

### Module Structure (Phase 7)
- **8 modules under `src/`:** `index.ts` (entry), `cli.ts` (config), `registry.ts` (state), `slug.ts` (slug utils), `handlers.ts` (CRUD), `mcp.ts` (MCP server), `http.ts` (Bun.serve), `utils.ts` (shared helpers).
- **Acyclic dependencies:** `utils.ts` and `slug.ts` are leaf modules (no internal deps). `index.ts` is the only orchestrator.
- **Entry point:** `src/index.ts` — runs via `bun run src/index.ts`.

### MCP Server Mode
- **4 tools:** `register_folder`, `unregister_folder`, `update_folder`, `list_folders`. No `read_file` or `list_directory` — agents have native filesystem access.
- **Rich responses:** MCP tool responses mirror the HTTP API format (slug, path, url, subdomain_url, timestamps). Agent gets ready-to-use HTTP URLs.
- **Two transports:** `--mcp stdio` (JSON-RPC on stdout, logs on stderr) and `--mcp http` (Streamable HTTP on `/mcp`, stateless sessions). Mutually exclusive. Both share the same `McpServer` instance and in-memory registry.
- **stdout/stderr split:** Only applies to stdio mode. HTTP mode logs normally to stdout.
- **Parameter schema:** MCP tools accept the same parameters as the HTTP API (e.g., optional `slug` in `register_folder`). Tool definitions are identical across transports.
- **SDK integration:** Full `@modelcontextprotocol/sdk` usage — `McpServer` class handles JSON-RPC, handshake, tool registration. `StdioServerTransport` for stdio mode, `WebStandardStreamableHTTPServerTransport` for HTTP mode.
- **Reserved slug:** `mcp` is blocked from user registration to avoid collision with the `/mcp` endpoint.

## Architecture Principles

- **Single process, minimal deps:** Two runtime dependencies (`@modelcontextprotocol/sdk` + `zod` for MCP mode). No build step. See [ADR-0001](./docs/adr/0001-mcp-sdk-dependency.md).
- **KISS over feature completeness:** Breadth before polish. Incremental delivery with manual verification gates.
- **LLM-agent first:** Structured JSON responses with `status`, `message`, `data/details`, `hint` fields for programmatic consumption.
