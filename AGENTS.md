# AGENTS.md

## Project Context

Local HTTP File Server is a Bun application that dynamically registers filesystem directories at runtime and serves them via slug-based URL routes and subdomain-based access. It targets local development workflows — humans, curl scripts, and LLM agents alike — providing a structured JSON API, a self-contained HTML dashboard, and an MCP stdio server mode for AI agent integration.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Bun (>= 1.0.0) — native APIs only (`Bun.serve`, `Bun.file`) |
| Language | TypeScript 5 (ESNext, strict mode, no emit) |
| Module System | ESM (`"type": "module"`, `"module": "Preserve"`) |
| Testing | `bun:test` in `tests/` (direct handler invocation + spawned server) |
| Persistence | Optional JSON file (`registry.json`) — gated by `PERSIST=true` |
| MCP | `@modelcontextprotocol/sdk` + `zod` — stdio server mode via `--mcp stdio` |
| CI/CD | GitHub Actions on `v*` tag push → build all platforms → release artifacts |

## Directory Map

```
src/
  index.ts        — Entry point: start HTTP, conditionally start MCP, wire signals
  cli.ts          — CliConfig, parseCliArgs, log (stdout/stderr split), logRequest
  registry.ts     — FolderEntry, registry Map, load/save persistence, re-exports slug fn
  slug.ts         — SLUG_REGEX, randomSuffix, normalizeSlugBase, validateSlug, generateSlug
  handlers.ts     — CrudResult, handleList, handleRegister, handleUnregister, handleUpdate
  mcp.ts          — createMcpServer, 4 tool registrations (mirror HTTP CRUD)
  http.ts         — startHttpServer, Bun.serve fetch callback, routing + file serving
  utils.ts        — ok/err responses, isPathSafe, extractSubdomain, parseRange,
                    generateETag, httpDate, buildDirListing
dashboard.html    — Self-contained HTML dashboard (served at GET / without JSON Accept)
tests/
  http-api.test.ts            — Direct handler invocation tests (CRUD, file serving)
  http-persistence.test.ts    — Spawned server persistence tests
  mcp.test.ts                 — MCP tool unit tests
  mcp-integration.test.ts     — MCP integration tests
.github/workflows/release.yml — Build all platforms on v* tag, upload as release assets
CHANGELOG.md                  — Keep a Changelog format
SPEC.md                       — Full API specification with request/response examples
CONTEXT.md                    — Glossary and architectural decisions
plans/                        — Active and future plans only
plans/archive/                — Completed plans (historical reference)
```

## Commands

| Action | Command |
|--------|---------|
| Install dependencies | `bun install` |
| Start server | `bun run src/index.ts` |
| Start with persistence | `PERSIST=true bun run src/index.ts` |
| Start with MCP mode | `bun run src/index.ts --mcp stdio` |
| Custom port | `PORT=3000 bun run src/index.ts` |
| Run all tests | `bun test` |
| Build native binary | `bun run build` |
| Build all platforms | `bun run build:all` |
| Build specific platform | `bun run build:linux-x64` (see README for full list) |

No linter or formatter is configured. Follow the existing code style in `src/` modules.

## Architecture

- **8-module architecture** under `src/` — acyclic dependencies. `utils.ts` and `slug.ts` are leaf modules (no internal deps). `index.ts` is the sole orchestrator.
- **In-memory registry:** `Map<string, FolderEntry>` keyed by slug — exported from `src/registry.ts`, imported by handlers and HTTP layer.
- **Handler pattern:** CRUD logic lives in `handlers.ts` returning `CrudResult` (pure business logic). `http.ts` wraps results into `ok()`/`err()` `Response` objects. This separation lets MCP tools reuse handler logic directly.
- **Request flow:** `Bun.serve()` → extract slug from path or Host subdomain → dispatch to CRUD handler or file serving logic.
- **MCP mode:** `--mcp stdio` starts both HTTP server and MCP stdio listener; stdout = JSON-RPC only, stderr = logs.
- **Response format:** Every API response uses `{ status, message, data|details, hint }` — see SPEC.md §6 for canonical examples.
- **Content negotiation:** `GET /` returns HTML dashboard by default; `Accept: application/json` or `?format=json` forces JSON.
- **Security:** Path traversal protection via `isPathSafe()` — resolved paths must stay within registered folder root.
- **Persistence:** Synchronous JSON writes on every mutation when `PERSIST=true`. Loaded on startup, validated against filesystem.
- **Slug generation:** Base from directory name (normalized, lowercased, ASCII-safe) + 8-char random suffix. Up to 3 attempts before falling back to 12-char suffix.

## Key Terminology (from CONTEXT.md)

- **Slug:** URL-safe folder identifier, format `^[a-z0-9][a-z0-9_-]{0,63}$`. Used as route prefix and subdomain.
- **Registry:** In-memory `Map<string, FolderEntry>` holding active folder registrations.
- **FolderEntry:** `{ slug, path, createdAt, updatedAt }` — one per registered directory.
- **CrudResult:** `{ ok, status, message, data?, details?, hint? }` — shared return type for all handler functions.
- **Accept Heuristic:** `Accept.includes('application/json')` → JSON, else HTML. No RFC 7231 quality parsing.

## Rules of Engagement

### ✅ Always

- Use `node:fs/promises` (async) for I/O in request handlers; `node:fs` (sync) only for startup/shutdown persistence and `statSync` in file-serving where sync is acceptable.
- Return structured JSON via `ok()` / `err()` helpers from `utils.ts` for all API responses.
- Keep CRUD business logic in `handlers.ts` returning `CrudResult`; let `http.ts` and `mcp.ts` consume it.
- Validate `folder_path` is absolute (`/` prefix) and exists as a readable directory before registration.
- Validate slugs against `SLUG_REGEX` — reject with 400, never silently correct.
- Check path safety with `isPathSafe()` before serving any file.
- Use `Bun.file()` for file serving (auto MIME type detection).
- Add `X-Slug` and `X-Folder-Path` headers to file responses (path truncated to basename only).
- Log requests with `logRequest(method, path, status)` for observability.
- Reference `SPEC.md` for API contract and `CONTEXT.md` for terminology before making changes.
- Define `FolderEntry` in `registry.ts` only — import it elsewhere rather than duplicating.
- Update `CHANGELOG.md` under `[Unreleased]` for every user-visible change.

### 📋 Plans Lifecycle

- `plans/` holds **active and future plans only** — working documents for ongoing work.
- When a plan is fully implemented, move it to `plans/archive/`.
- Do not delete archived plans — they are historical reference for future sessions.

### 🚫 Never

- Add npm dependencies beyond `@modelcontextprotocol/sdk` and `zod` — minimal deps by design.
- Use `any` types — TypeScript strict mode is enforced. Use proper types or `unknown` with narrowing.
- Commit `.env` files or `registry.json` (both in `.gitignore`).
- Expose full absolute paths in file-serving responses — use `basename()` truncation.
- Use `innerHTML` in `dashboard.html` — use `textContent` and `createElement` for XSS safety.
- Break the existing response format (`{ status, message, data, hint }`).
- Introduce build steps or bundlers for development — the app runs directly via `bun run src/index.ts`. Use `bun run build` only for distribution binaries.
- Define `FolderEntry` in multiple files — it is a single source of truth in `registry.ts`.

## Golden Example

```typescript
// handlers.ts — CRUD logic returns CrudResult (reused by HTTP + MCP)
async function handleRegister(
	body: Record<string, unknown>,
): Promise<CrudResult> {
	const folderPath = body.folder_path as string | undefined;
	if (!folderPath) {
		return {
			ok: false,
			status: 400,
			message: "Missing required field 'folder_path'.",
			details: { field: "folder_path", received: null },
			hint: 'POST with { "folder_path": "/path/to/dir" }',
		};
	}

	if (!folderPath.startsWith("/")) {
		return {
			ok: false,
			status: 400,
			message: `Path '${folderPath}' is not absolute.`,
			details: { field: "folder_path", value: folderPath },
			hint: 'Provide an absolute path starting with "/".',
		};
	}

	try {
		const s = await stat(folderPath);
		if (!s.isDirectory()) {
			return { ok: false, status: 400, message: `Not a directory: ${folderPath}` };
		}
	} catch (e: unknown) {
		return {
			ok: false,
			status: 400,
			message: `Directory '${folderPath}' does not exist.`,
			details: { folder_path: folderPath, reason: (e as { code?: string }).code },
		};
	}

	const slug = await generateSlug(folderPath);
	const entry: FolderEntry = {
		slug,
		path: folderPath,
		createdAt: new Date(),
		updatedAt: new Date(),
	};
	registry.set(slug, entry);
	saveRegistry();

	return {
		ok: true,
		status: 201,
		message: `Folder '${slug}' registered.`,
		data: { slug, path: folderPath },
		hint: `Access at http://localhost:${config.port}/${slug}/`,
	};
}
```
