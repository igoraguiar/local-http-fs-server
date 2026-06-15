# AGENTS.md

## Project Context

Local HTTP File Server is a Bun application that dynamically registers filesystem directories at runtime and serves them via slug-based URL routes and subdomain-based access. It targets local development workflows — humans, curl scripts, and LLM agents alike — providing a structured JSON API for CRUD management, a self-contained HTML dashboard, and an MCP stdio server mode for AI agent integration.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Bun (>= 1.0.0) — native APIs only (`Bun.serve`, `Bun.file`) |
| Language | TypeScript 5 (ESNext, strict mode, no emit) |
| Module System | ESM (`"type": "module"`, `"module": "Preserve"`) |
| Testing | Bash-based curl test suite (`test.sh`) — no test framework |
| Persistence | Optional JSON file (`registry.json`) — gated by `PERSIST=true` |
| MCP | `@modelcontextprotocol/sdk` + `zod` — stdio server mode via `--mcp stdio` |

## Directory Map

```
src/
  index.ts        — Entry point: parse config, start HTTP + MCP, wire signals
  cli.ts          — CliConfig, parseCliArgs, log variable, logRequest
  registry.ts     — FolderEntry, registry Map, loadRegistry, saveRegistry
  slug.ts         — randomSuffix, normalizeSlugBase, validateSlug, generateSlug
  handlers.ts     — CrudResult, handleList, handleRegister, handleUnregister, handleUpdate
  mcp.ts          — createMcpServer, tool registrations
  http.ts         — Bun.serve fetch callback, routing logic, file serving
  utils.ts        — ok(), err(), isPathSafe, extractSubdomain, parseRange, generateETag, httpDate, buildDirListing
dashboard.html    — Self-contained HTML dashboard (served at GET /).
test.sh           — Automated curl-based test suite covering all phases.
package.json      — Bun config, scripts, dev dependencies.
tsconfig.json     — TypeScript strict config (noEmit).
CONTEXT.md        — Glossary, terminology, and key architectural decisions.
SPEC.md           — Full API specification with request/response examples.
plans/            — Implementation planning artifacts.
```

## Commands

| Action | Command |
|--------|---------|
| Start server | `bun run src/index.ts` |
| Start with persistence | `PERSIST=true bun run src/index.ts` |
| Start with MCP mode | `bun run src/index.ts --mcp stdio` |
| Custom port | `PORT=3000 bun run src/index.ts` |
| Run tests | `bash test.sh` |
| Run tests on custom port | `TEST_PORT=9200 bash test.sh` |

No linter or formatter is configured. Follow the existing code style in `src/` modules.

## Architecture

- **Multi-module architecture:** 8 focused modules under `src/` — see Directory Map above.
- **In-memory registry:** `Map<string, FolderEntry>` keyed by slug — exported from `src/registry.ts`, imported by handlers and HTTP layer.
- **Request flow:** `Bun.serve()` → extract slug from path or Host subdomain → dispatch to CRUD handler or file serving logic.
- **MCP mode:** `--mcp stdio` starts both HTTP server and MCP stdio listener; stdout = JSON-RPC only, stderr = logs.
- **Response format:** Every API response uses `{ status, message, data|details, hint }` — see SPEC.md §6 for canonical examples.
- **Content negotiation:** `GET /` returns HTML dashboard by default; `Accept: application/json` or `?format=json` forces JSON.
- **Security:** Path traversal protection via `isPathSafe()` — resolved paths must stay within registered folder root.
- **Persistence:** Synchronous JSON writes on every mutation when `PERSIST=true`. Loaded on startup, validated against filesystem.

## Key Terminology (from CONTEXT.md)

- **Slug:** URL-safe folder identifier, format `^[a-z0-9][a-z0-9_-]{0,63}$`. Used as route prefix and subdomain.
- **Registry:** In-memory `Map<string, FolderEntry>` holding active folder registrations.
- **FolderEntry:** `{ slug, path, createdAt, updatedAt }` — one per registered directory.
- **Accept Heuristic:** `Accept.includes('application/json')` → JSON, else HTML. No RFC 7231 quality parsing.

## Rules of Engagement

### ✅ Always

- Use `node:fs/promises` (async) for I/O in request handlers; `node:fs` (sync) only for startup/shutdown persistence.
- Return structured JSON via `ok()` / `err()` helpers for all API responses.
- Validate `folder_path` is absolute (`/` prefix) and exists as a readable directory before registration.
- Validate slugs against `SLUG_REGEX` — reject with 400, never silently correct.
- Check path safety with `isPathSafe()` before serving any file.
- Use `Bun.file()` for file serving (auto MIME type detection).
- Add `X-Slug` and `X-Folder-Path` headers to file responses (path truncated to basename only).
- Log requests with `logRequest(method, path, status)` for observability.
- Reference `SPEC.md` for API contract and `CONTEXT.md` for terminology before making changes.

### 🚫 Never

- Add npm dependencies beyond `@modelcontextprotocol/sdk` and `zod` — minimal deps by design.
- Use `any` types — TypeScript strict mode is enforced. Use proper types or `unknown` with narrowing.
- Commit `.env` files or `registry.json` (both in `.gitignore`).
- Expose full absolute paths in file-serving responses — use `basename()` truncation.
- Use `innerHTML` in `dashboard.html` — use `textContent` and `createElement` for XSS safety.
- Break the existing response format (`{ status, message, data, hint }`).
- Modify `test.sh` assertions without updating the corresponding behavior first.
- Introduce build steps or bundlers — the app runs directly via `bun run src/index.ts`.

## Golden Example

```typescript
// Registering a new folder — follows all project conventions
case "POST": {
    let body: Record<string, unknown>;
    try {
        body = (await req.json()) as Record<string, unknown>;
    } catch {
        logRequest(method, pathname, 400);
        return err(
            "Invalid JSON body. Provide a valid JSON object.",
            400,
            undefined,
            'Example: POST with { "folder_path": "/home/user/documents" }',
        );
    }

    const folderPath = body.folder_path as string | undefined;
    if (!folderPath) {
        logRequest(method, pathname, 400);
        return err(
            "Missing required field 'folder_path'.",
            400,
            { field: "folder_path", received: null },
            'Example: POST with { "folder_path": "/home/user/documents" }',
        );
    }

    // Validate path exists and is a directory
    try {
        const s = await stat(folderPath);
        if (!s.isDirectory()) {
            logRequest(method, pathname, 400);
            return err(`Path '${folderPath}' is not a directory.`, 400);
        }
    } catch {
        logRequest(method, pathname, 400);
        return err(`Directory '${folderPath}' does not exist.`, 400);
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

    logRequest(method, pathname, 201);
    return ok(
        `Folder '${slug}' registered.`,
        { slug, path: folderPath },
        `Access files at http://localhost:${PORT}/${slug}/`,
        201,
    );
}
```
