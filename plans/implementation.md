# Implementation Plan: Local HTTP File Server

> Pure Bun, zero dependencies, incremental delivery with testing gates.
> Derived from SPEC.md — this is the execution blueprint.

---

## Execution Strategy

- **Build model**: Incremental — complete each phase, verify it works, then proceed.
- **Testing approach**: Manual verification via curl/browser after each phase. No test framework through Phase 2; acceptance criteria from SPEC.md serve as checklists. Automated security tests (bun:test, zero deps) added during Phase 3+ refactoring to cover path traversal edge cases (`..%252f`, symlink escapes, regressions).
- **Dependency policy**: Zero npm packages. All utilities (slug generation, response formatting, range parsing) implemented inline.
- **File structure**: Single entry point + one HTML file. Utilities extracted only when they appear in 2+ locations (DRY).

---

## File Structure (Final)

```
project-root/
├── index.ts              # Entry point — server bootstrap + all routing logic
├── dashboard.html        # Phase 5 — self-contained management UI
├── package.json          # Minimal — name, type, bun script only (no dependencies)
└── plans/
    └── implementation.md # This file
```

No module splitting. Shared helpers live at the top of `index.ts` as named functions; the routing logic follows below.

---

## Shared Helpers (DRY Extraction Points)

These helpers will be created upfront since they are used across multiple phases and handlers. They live at the top of `index.ts`.

### 1. Response Formatter

Used by: GET, POST, DELETE, PUT handlers (Phase 1+)

**Purpose:** Enforce consistent JSON response shape per SPEC.md section 6 ("Response Format"). Eliminates repetition of `{ status, message, data/details, hint }` structure across 4+ handlers.

**Signature:**
```
ok(message, data?, hint?)     → Response (200/201)
err(message, status, details?, hint?) → Response (4xx/5xx)
```

**Design decisions:**
- Returns `Response.json()` directly — caller never constructs JSON shapes inline
- `ok()` defaults to 200; accepts optional status override (e.g., 201 for POST)
- `err()` accepts HTTP status code explicitly — no magic status code assignment
- `hint` parameter is always optional — omit when there's nothing useful to suggest

### 2. Slug Generator

Used by: POST handler (auto-generation), potentially PUT handler (if slug update without new name provided)

**Purpose:** Generate unique, URL-safe slugs from folder paths without external dependencies.

**Algorithm:**
```
input: "/home/user/My Documents"
  ↓ extract basename: "My Documents"
  ↓ normalize to ASCII slug: lowercase, replace spaces/special chars with hyphens, strip non-alphanumeric except hyphens
  → "my-documents"
  ↓ append cryptographically random suffix (8 chars from URL-safe alphabet)
  → "my-documents-a3k9xZqR"
```

**Components (both inline):**
- **Slug normalization (~9 lines):** Regex-based replacement pipeline: lowercase → replace unicode diacritics via `.normalize('NFD')` + strip accents → replace non-alphanumeric with `-` → collapse multiple hyphens → trim edge hyphens → **post-normalization guard**: if result is empty or doesn't start with `[a-z0-9]`, force `"folder"` as base
- **Note:** User-provided slugs bypass this normalization entirely — they go straight to the Slug Validator regex. Invalid user slugs are rejected with 400, not corrected.
- **Random suffix (~5 lines):** Use `Bun.crypto.randomUUID()` or `crypto.getRandomValues()` to generate bytes, encode against alphabet `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-` (URL-safe, 64 chars), take first 8 characters

**Edge cases handled:**
- Root path `/` → basename resolves to `"root"`
- Folder names that normalize to empty (e.g., `"___"`, `" "`) → post-normalization guard forces `"folder"` base
- Already-taken slug → append different random suffix and retry (max 3 attempts; with 8-char suffix collision is effectively impossible)

### 3. Slug Validator

Used by: POST handler (user-provided slug validation), PUT handler (slug update validation)

**Purpose:** Validate user-provided slugs against SPEC.md rules before accepting them.

**Rules:**
- Regex: `^[a-z0-9][a-z0-9_-]{0,63}$`
- Not already in registry Map keys
- Returns `{ valid: true }` or `{ valid: false, reason: string }`

**Rejection semantics:** When POST/PUT receives an invalid slug, the handler returns `400 Bad Request` with a clear message and hint — it does **not** silently fall back to auto-generation. Auto-generation only kicks in when the `slug` field is omitted, null, or empty.

---

### Phase 2 Helpers (created during Phase 2)

### 4. Path Safety Checker

Used by: File serving handler (Phase 2+)

**Purpose:** Ensure resolved file paths stay within registered folder root — prevents path traversal attacks.

**Algorithm:**
```
function isPathSafe(resolvedFilePath: string, folderRoot: string): boolean {
  // Both must be absolute and normalized via path.resolve() before comparison
  return resolvedFilePath === folderRoot
    || resolvedFilePath.startsWith(folderRoot + "/");
}
```

**Design decisions:**
- Operates on *resolved* absolute paths only — callers must pass `path.resolve()` output
- Handles symlink targets naturally (Bun.file() resolves symlinks at C level; the prefix check operates on the final resolved path)
- Returns boolean — no partial matches, no warning levels

### 5. Subdomain Extractor

Used by: File serving handler (Phase 2+)

**Purpose:** Parse Host header to extract subdomain slug for subdomain-based routing.

**Algorithm:**
```
input: url.hostname = "documents-a3k9xZ.localhost"
  ↓ check if hostname is an IP address (IPv4 or IPv6) → return null
  ↓ split on "."
  → ["documents-a3k9xZ", "localhost"]
  ↓ if parts.length > 1, return parts[0]; else return null
```

**IP detection (before split):**
- IPv4: `hostname.match(/^\d{1,3}(\.\d{1,3}){3}$/)` → return null
- IPv6 literal: `hostname.startsWith("[")` → return null

**Edge cases handled:**
- `localhost` → returns null (no subdomain)
- `127.0.0.1` → returns null (caught by IPv4 regex)
- `[::1]` → returns null (caught by bracket check)
- `a.b.c.localhost` → returns `"a"` (only first segment treated as subdomain)

---

### Phase 3 Helpers (created during Phase 3)

### 6. Range Request Parser

Used by: File serving handler (Phase 3)

**Purpose:** Parse HTTP `Range` header and compute byte slice boundaries for partial content responses.

**Algorithm:**
```
input: Range: "bytes=0-999"
  ↓ parse regex match for start and end values
  ↓ clamp to file size (handle missing end = to EOF)
  ↓ return { status: 206, start, end, contentLength } | null
```

**Design decisions:**
- Supports only single-byte-range requests (most common case: `bytes=START-END`)
- Multi-range requests (`bytes=0-999,2000-2999`) → ignored, serve full file (not a security concern)
- Invalid/unsatisfiable ranges → return null, fall through to full 200 response
- Returns `Content-Range` header value string pre-computed
- **Byte reading:** Use `Bun.file(path).slice(start, end)` — returns a BunFile representing the byte range, which is then passed to `new Response()` for streaming. No manual file descriptor lifecycle.

---

## Phase Execution Details

### Phase 1 — Core CRUD API

**Files created:** `package.json`, `index.ts`

**Steps (in order):**

1. **Initialize project**
   - Create `package.json` with `type: "module"`, bun run script
   - Create `index.ts` skeleton with shared helpers (§ Response Formatter, § Slug Generator, § Slug Validator)
   - Phase 2 adds: § Path Safety Checker, § Subdomain Extractor
   - Phase 3 adds: § Range Request Parser

2. **Implement registry data structure**
   - Define `FolderEntry` interface
   - Instantiate `Map<string, FolderEntry>` as module-level constant

3. **Implement GET /**
   - Parse Accept header (but serve JSON always for now — dashboard is Phase 5)
   - Convert Map entries to array of serializable objects
   - Return via `ok()` helper
   - Handle empty state explicitly

4. **Implement POST /**
   - Parse JSON body; handle parse failures with `err("Invalid JSON", 400)`
   - Validate `folder_path`: non-empty, absolute path, exists on FS, is directory, is readable
   - Validate optional `slug` via slug validator — if provided and invalid, return `400 Bad Request` with hint (do **not** silently auto-generate)
   - Auto-generate slug only when `slug` field is omitted, null, or empty
   - Check for duplicate path (already registered) → 409
   - Insert into Map
   - Return `ok(...)` with 201 status

5. **Implement DELETE /**
   - Extract identifier from query string OR JSON body (check both)
   - Look up entry by slug or by path (linear scan if identified by path)
   - Remove from Map
   - Return `ok(...)` with removed entry details
   - Handle missing identifier → 400, not found → 404

6. **Implement PUT /**
   - Parse JSON body
   - **Lookup rule:** When both `slug` and `folder_path` are provided, `slug` is always the lookup key; `folder_path` is always the update target. When only one is provided, it serves as the lookup key.
   - Determine update target (the other field)
   - If neither provided → 400 "no changes specified"
   - If new slug provided → validate format + collision check
   - If new path provided → validate existence + readability
   - For slug change: delete old key, insert new key (Map doesn't support key rename)
   - Update `updatedAt` timestamp
   - Return `ok(...)` with diff information (old vs new values)

7. **Wire up Bun.serve()**
   - Bind to port from env `PORT` or default 8080
   - Bind hostname to `0.0.0.0`
   - Single `fetch` handler routes by method on `/` path
   - Unknown methods → 405 Method Not Allowed
   - Non-`/` paths → 404 (file serving not yet implemented)

8. **Add console logging**
   - Log each API request: method, path, status code, timestamp
   - Format: `[TIMESTAMP] METHOD PATH → STATUS`

**Verification checklist:**
- [ ] `curl http://localhost:8080/` returns empty folder list
- [ ] `curl -X POST -H 'Content-Type: application/json' -d '{"folder_path": "/tmp"}' http://localhost:8080/` returns 201 with slug
- [ ] POST with missing folder_path returns 400
- [ ] POST with non-existent directory returns 400
- [ ] POST with duplicate path returns 409
- [ ] POST with invalid user-provided slug returns 400 (not auto-generated)
- [ ] GET / shows registered folder after POST
- [ ] DELETE with valid slug returns 200 and removes entry
- [ ] DELETE with invalid slug returns 404
- [ ] PUT to change path works and updates Map
- [ ] PUT to change slug works (old URL dead, new URL live in registry)
- [ ] PUT without identifier returns 400
- [ ] All responses follow { status, message, data/details, hint } format

---

### Phase 2 — File Serving

**Files modified:** `index.ts`

**Steps (in order):**

1. **Add Path Safety Checker helper** (§ from Shared Helpers above)

2. **Add Subdomain Extractor helper** (§ from Shared Helpers above)

3. **Implement slug resolution logic**
   - If subdomain extracted → use as slug lookup key directly
   - If no subdomain → extract first path segment after `/` as potential slug
   - Look up slug in registry Map
   - Not found → return structured 404 JSON via `err()` helper

4. **Implement file path resolution**
   - Compute relative file path: strip slug prefix from request pathname (or use full pathname for subdomain access)
   - Decode URI components (handle `%2F` etc.)
   - Join with registered folder root using `path.resolve()`
   - Run through Path Safety Checker — reject traversal attempts with 403

5. **Serve files via Bun.file()**
   - Check file existence via `BunFile.exists()`
   - Create `new Response(file)` — auto Content-Type, streaming body
   - Add custom headers: `X-Slug`, `X-Folder-Path` (truncated to `path.basename()` — last path component only, e.g., `/home/user/documents` → `documents`)
   - File not found → structured 404 JSON

6. **Implement directory redirect**
   - Stat resolved path to check if it's a directory
   - If directory and URL lacks trailing slash → 301 redirect adding `/`
   - If directory with trailing slash → return `501 Not Implemented` with JSON: `{ "status": "error", "message": "Directory listing is not yet implemented.", "hint": "Access files directly by name (e.g., /<slug>/filename.txt). Directory listing will be added in a future update." }` — honest about the current capability gap; replaced during Phase 4

7. **Wire into fetch handler**
   - Place file serving logic after API route check (`/` path exact match)
   - **Middleware ordering:** slug resolution → path safety check → stat (file vs dir) → if file then serve (with ETag/range from Phase 3), if dir then return 501. ETag/cache headers apply only to successful file responses (200/206), never to directory responses.
   - Unknown method on non-root paths → still serve files for GET, reject others with 405

**Verification checklist:**
- [ ] Register a folder with known test files inside
- [ ] `curl http://localhost:8080/<slug>/test.txt` returns file contents
- [ ] Response has correct Content-Type header
- [ ] `curl http://localhost:8080/<unknown-slug>/` returns 404 JSON
- [ ] `curl http://localhost:8080/<slug>/missing-file` returns 404 JSON
- [ ] `curl http://localhost:8080/<slug>/%2e%2e/%2e%2e/etc/passwd` returns 403
- [ ] Subdomain access works: `curl -H 'Host: <slug>.localhost:8080' http://localhost:8080/test.txt`
- [ ] Directory URL without trailing slash redirects to add `/`
- [ ] Large files (>1MB) stream correctly (not buffered entirely in memory)

---

### Phase 3 — Range Requests + Caching

**Files modified:** `index.ts`

**Steps (in order):**

1. **Add Range Request Parser helper** (§ from Shared Helpers above)

2. **Implement ETag generation (no cache)**
   - Compute fresh per request from slug + `stat().size` + `stat().mtime`
   - Format: RFC 7232 weak validator `W/"${slug}-${size}-${mtime}"` with proper double-quote enclosure
   - Including slug eliminates cross-folder ETag collisions when two files in different folders share size+mtime
   - No in-memory cache — stat() is O(1) and avoids stale data / orphaned key bugs entirely (KISS-aligned)

3. **Implement conditional request handling**
   - Check `If-None-Match` header against computed ETag → 304 if match
   - Check `If-Modified-Since` header against file mtime → 304 if file unchanged
   - Return before range processing (304 takes priority)

4. **Implement range request handling**
   - Parse `Range` header via helper
   - If valid range → use `Bun.file(path).slice(start, end)` to get the byte range, pass to `new Response()` for streaming
   - Return 206 Partial Content with `Content-Range`, `Accept-Ranges: bytes`, adjusted `Content-Length`
   - If no range or invalid → fall through to full 200 response

5. **Add cache headers to all file responses**
   - `Cache-Control: public, max-age=3600`
   - `ETag: <computed-value>`
   - `Last-Modified: <file mtime as HTTP date>`
   - `Accept-Ranges: bytes`

**Verification checklist:**
- [ ] First request returns 200 with ETag and Cache-Control headers
- [ ] Second request with matching If-None-Match returns 304
- [ ] `curl -H 'Range: bytes=0-99' http://localhost:8080/<slug>/large-file` returns 206 with correct byte slice
- [ ] Range beyond file size handled gracefully (server rejects or clamps)
- [ ] Large file (>10MB) range request does NOT spike memory usage (verifies Bun.file().slice() not full-buffer approach)
- [ ] Video file playable in browser with seeking (manual test)
- [ ] All file responses include Accept-Ranges: bytes header

---

### Phase 4 — Directory Listing

**Files modified:** `index.ts`

**Steps (in order):**

1. **Implement directory detection in file serving flow**
   - After resolving path and passing safety check, stat the target
   - If file → serve as before
   - If directory → proceed to listing generation

2. **Read directory entries**
   - Use `fs.readdir(path, { withFileTypes: true })` (Node fs compat available in Bun)
   - Sort: directories first, then files; alphabetical within each group

3. **Generate HTML listing**
   - Inline template string (~30 lines of minimal HTML)
   - Include breadcrumb navigation back to slug root
   - Parent directory link (`..`) when not at root
   - Each entry shown with: name, size (or `<dir>`), type indicator
   - Links point to relative paths under current URL prefix
   - Minimal inline CSS for readability (no external stylesheets)

4. **Wire into existing file serving flow**
   - Replace previous "directory returns 404 with hint" behavior with actual listing
   - Response content-type: `text/html; charset=utf-8`

**Verification checklist:**
- [ ] `GET /<slug>/` shows HTML listing of folder root contents
- [ ] Directories shown with `/` suffix and clickable links
- [ ] Files shown with sizes and clickable links
- [ ] Nested directory access works: `/<slug>/subdir/` shows subdir listing
- [ ] Parent directory link navigates up correctly
- [ ] Empty directories show "This folder is empty" message
- [ ] Listing page itself passes path traversal protection

---

### Phase 5 — Dashboard UI

**Files created:** `dashboard.html`
**Files modified:** `index.ts` (GET / Accept header handling)

**Steps (in order):**

1. **Create `dashboard.html`**
   - Self-contained single file: HTML + inline CSS + inline JavaScript
   - No external dependencies, no CDN calls
   - **XSS discipline:** All dynamic content rendered via `document.createElement()` + `.textContent` exclusively — zero `innerHTML` usage. Single `renderRow(data)` function constructs DOM programmatically.
   - Structure:
     - Header/title area
     - "Register Folder" form (POST to `/`)
     - Table/list showing registered folders with slug, path, registration date
     - Per-row action buttons: Edit (PUT), Delete (DELETE)
     - Edit modal or inline form for updating slug/path
     - Access URL display per folder (both path-based and subdomain patterns)
     - Toast/notification area for API error messages

2. **Dashboard JavaScript logic**
   - On load: `fetch('/')` with `Accept: application/json` to populate list
   - Register form: POST to `/`, re-fetch list on success
   - Delete button: DELETE to `/?slug=...`, re-fetch list on success
   - Edit form: PUT to `/` with both fields, re-fetch list on success
   - All operations use the server's own JSON API — dashboard is a thin client
   - Error responses parsed from `{ status, message }` format and displayed in UI

3. **Wire into GET /**
   - Check `Accept` header in fetch handler — simple heuristic: if Accept contains `application/json`, serve JSON. Otherwise serve HTML dashboard. No RFC quality-value parsing.
   - **Override:** `?format=json` query parameter forces JSON response regardless of Accept header — gives scripts and LLM agents explicit control without needing to set headers.
   - If not JSON → serve `Bun.file('./dashboard.html')`
   - Browser requests default to HTML (Accept includes text/html)
   - curl without Accept header → defaults to HTML; use `?format=json` or `-H 'Accept: application/json'` for JSON

4. **Minimal styling**
   - System font stack, neutral color palette
   - Table with hover states
   - Responsive layout (works on mobile viewport)
   - No framework — plain CSS Grid or Flexbox

**Verification checklist:**
- [ ] `http://localhost:8080/` in browser shows dashboard (not raw JSON)
- [ ] `curl -H 'Accept: application/json' http://localhost:8080/` returns JSON
- [ ] Register folder via form → appears in table immediately
- [ ] Delete button removes entry and updates table
- [ ] Edit form allows changing slug or path
- [ ] Validation errors shown in UI (from API error messages)
- [ ] Access URLs displayed per folder and clickable
- [ ] Empty state shown when no folders registered

---

### Phase 6 — Optional Persistence

**Files modified:** `index.ts`

**Steps (in order):**

1. **Define persistence configuration**
   - Check `PERSIST` env var or `--persist` CLI flag
   - Default: disabled (in-memory only)
   - File path: `registry.json` in project root

2. **Implement load on startup**
   - Before starting server, check if `registry.json` exists
   - If yes → read, parse JSON, populate Map entries
   - Validate each loaded entry's path still exists on filesystem (stale entries from moved/deleted folders are silently skipped with console warning)
   - If file corrupted or invalid JSON → log warning, start with empty registry

3. **Implement save on mutation**
   - After every successful POST, PUT, DELETE → serialize Map to JSON array → write to `registry.json`
   - Write synchronously (not critical perf; mutations are infrequent)
   - On write failure → log error but don't crash (server stays functional)

4. **Handle graceful shutdown**
   - Listen for `SIGINT`/`SIGTERM` signals
   - Final save before exit
   - Ensures registry is persisted even if process killed cleanly

**Verification checklist:**
- [ ] Start server with PERSIST=true → no registry.json created yet (no data)
- [ ] Register a folder via API → registry.json appears with correct content
- [ ] Stop and restart server → registered folder persists
- [ ] Remove PERSIST flag → persistence disabled, registry in-memory only
- [ ] Corrupt registry.json → server starts fresh with warning logged
- [ ] Registered folder path deleted from disk → stale entry skipped on load with warning
- [ ] Graceful shutdown (Ctrl+C) → final save occurs before exit

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Bun.file() MIME type gaps for uncommon extensions | Medium | Low | Fall through gracefully — browser handles unknown types. Can add manual Content-Type override in Phase 2 if specific types needed. |
| Path traversal via symlinks within registered folders | Low | High | Path safety checker operates on resolved absolute paths — symlink targets are checked against folder root prefix. Document this behavior. |
| Range request byte slicing performance for very large files (>1GB) | Low | Medium | `Bun.file().slice(start, end)` returns a BunFile handle for the byte range — no full-file buffer. Test with large file. |
| Slug collision with auto-generation (8-char suffix = ~2^48 space) | Effectively zero | Low | 8-char suffix eliminates practical collision risk. Retry with new suffix if collision detected (max 3 attempts).
| TOCTOU race on concurrent POST/PUT | Near zero | Low | Accepted as known limitation — single-process model makes this extremely unlikely. Documented explicitly.
| Synchronous registry.json writes block event loop | Low | Low | Accepted for local use — correctness over throughput. If bulk registration becomes a concern, add write coalescing.
| Dashboard XSS from folder paths containing HTML characters | Low | Medium | All user-controlled data rendered via `textContent` (text) and `encodeURIComponent` (URLs in href attributes). Zero `innerHTML` usage. No external deps needed. |
| Bun API changes between versions breaking code | Low | Medium | Pin Bun version in package.json engines field. Code uses stable APIs (serve, file) unlikely to change. |

---

## DRY Opportunities Identified

| Repetition Pattern | Extraction | Phase |
|-------------------|-----------|-------|
| JSON response shape `{ status, message, ... }` across 4 handlers | Response Formatter helper (§1) | Before Phase 1 |
| Slug validation regex and collision check used in POST + PUT | Slug Validator helper (§3) | Before Phase 1 |
| Path traversal check needed for every file request | Path Safety Checker helper (§4) | Phase 2 |
| Host header subdomain parsing logic reused if multiple routes add | Subdomain Extractor helper (§5) | Phase 2 |
| ETag computation and conditional response headers | Embedded in Range Request Parser (§6) | Phase 3 |

**Not extracted (too small):** Individual error messages — each is context-specific enough that templating them would add complexity without real reuse benefit.

---

## KISS Compliance Checklist

- [x] Single process architecture — no workers, no clustering
- [x] Zero external dependencies — everything inline
- [x] One entry point file — `index.ts` handles all routing
- [x] No ORM, no database — Map-based registry, optional JSON persistence
- [x] No build step — `bun run index.ts` starts the server directly
- [x] Dashboard is a single HTML file — no bundler, no framework
- [x] Error handling is explicit per route — no try/catch middleware layers
- [x] Configuration via env vars only — no config files to manage

---

## Phase Dependencies Graph

```
Phase 1 (CRUD API)
    │
    ├──→ Phase 2 (File Serving)
    │       │
    │       ├──→ Phase 3 (Range + Caching)
    │       │
    │       └──→ Phase 4 (Directory Listing)
    │
    └──→ Phase 5 (Dashboard UI)     ← depends on Phase 1 only (JSON API)
    
Phase 6 (Persistence)               ← independent of all except Phase 1
```

**Minimum viable product:** Phases 1 + 2. Everything after is incremental improvement.
