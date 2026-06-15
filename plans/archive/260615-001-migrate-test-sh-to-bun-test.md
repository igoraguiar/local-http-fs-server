# Migrate test.sh to bun:test

## Task Overview

Replace the bash/curl test suite (`test.sh`, ~65 assertions across 6 phases) with native `bun:test` files using direct fetch handler invocation. No architecture refactor — keep module-level singleton registry, run tests sequentially.

## Decisions Locked (Grilling Session, 2026-06-15)

| # | Decision | Result |
|---|----------|--------|
| 1 | Test pattern | Direct handler invocation — export fetch handler, call with mock `Request`, assert `Response` |
| 2 | Architecture refactor | **Skipped** — keep singleton registry, no factory/class |
| 3 | Test isolation | `registry.clear()` in `beforeEach`, sequential execution within single `describe` |
| 4 | Test fixtures | Create temp dirs/files in `beforeAll`, cleanup in `afterAll` — only generated temp dir, no `/tmp` dependencies |
| 5 | Persistence tests | `Bun.spawn()` inside bun:test for process-restart scenarios |
| 6 | Port discovery | `--print-template` CLI flag prints machine-parseable output (e.g. `$port` → `32787`) |
| 7 | CLI port 0 | Allow `--port 0` in `cli.ts` (`port < 0` instead of `port < 1`) |
| 8 | Server return | `startHttpServer()` returns `Bun.Server` so `server.port` is accessible |
| 9 | test.sh fate | **Delete** — all tests move to bun:test, single source of truth |
| 10 | Assertion grouping | Same response object = one `it` block; independent scenarios = separate `it` blocks |
| 11 | --print-template | Prints **in addition to** existing banners (normal usage unaffected) |

## Plan

### Phase 0 — Production code prep (~15 lines across 4 files, 20 min)

**Goal:** Make the fetch handler testable and port discoverable.

#### 0a. `src/http.ts` — Extract fetch handler

The ~300-line `async fetch(req) { ... }` callback inside `startHttpServer()` becomes a standalone exported function. Everything inside the callback body moves verbatim.

```typescript
// NEW: exported for testing
export async function fetchHandler(req: Request): Promise<Response> {
    // ... entire current fetch callback body, unchanged ...
}

// CHANGED: thin wrapper, returns server
function startHttpServer(): Bun.Server {
    const server = Bun.serve({
        hostname: config.host,
        port: config.port,
        fetch: fetchHandler,
    });
    return server;
}

export { startHttpServer, fetchHandler };
```

**Risk:** Cut-and-paste is mechanical. The function body references only imports and closure variables (`config`, `registry`) — no local state is lost.

#### 0b. `src/cli.ts` — Allow port 0, add printTemplate

```typescript
interface CliConfig {
    port: number;
    host: string;
    mcpStdio: boolean;
    persist: boolean;
    registryFile: string;
    printTemplate?: string;  // NEW
}

// In parseCliArgs():
else if (arg === "--print-template" && args[i + 1]) {
    printTemplate = args[i + 1]!;
    i++;
}

// Change validation:
if (isNaN(port) || port < 0 || port > 65535) {  // was: port < 1
```

#### 0c. `src/index.ts` — Capture server, log actual port, print template

```typescript
const server = startHttpServer();  // was: startHttpServer();

if (config.mcpStdio) {
    log(`MCP stdio server + HTTP server running at http://${config.host}:${server.port}`);
    // ... rest unchanged ...
} else {
    log(`Local HTTP File Server running at http://${config.host}:${server.port}`);
    log(`API: http://localhost:${server.port}/`);
    log(`Dashboard: http://localhost:${server.port}/ (browser)`);
}

// NEW: machine-parseable template output (prints in addition to banners above)
if (config.printTemplate) {
    log(config.printTemplate.replace("$port", String(server.port)));
}
```

#### 0d. `src/registry.ts` — Export clearRegistry

```typescript
function clearRegistry(): void {
    registry.clear();
}

export { registry, generateSlug, validateSlug, saveRegistry, clearRegistry, type FolderEntry };
```

**Gate:** `bash test.sh` passes. Zero behavior change for normal usage.

---

### Phase 1 — `tests/http-api.test.ts` (~45 tests, direct handler, 60 min)

**File:** `tests/http-api.test.ts`

**Structure:** Single top-level `describe` (sequential within describe). Nested `describe` blocks per category.

```
beforeAll  → create temp dir + fixtures
beforeEach → clearRegistry()
afterAll   → fs.rm(tempDir, { recursive: true })
```

**Helper:** A `register()` helper that calls `fetchHandler` with a POST request and returns the slug, used by file-serving tests that need a registered folder.

#### Test inventory

**"CRUD API" (~18 tests)**

| Test | Assertions |
|------|-----------|
| GET / empty list | status 200, json status "success", count 0 |
| POST register folder | status 201, slug in response data, path matches |
| POST missing folder_path | status 400 |
| POST non-absolute path | status 400 |
| POST non-existent directory | status 400 |
| POST not a directory | status 400 (register a file path) |
| POST duplicate path | status 409 |
| POST invalid slug | status 400 |
| POST custom slug | status 201, slug matches custom value |
| POST duplicate custom slug | status 409 |
| GET / after registration | count 1, slug in list |
| DELETE by slug | status 200, slug in response |
| DELETE by path | status 200 |
| DELETE missing identifier | status 400 |
| DELETE unknown slug | status 404 |
| PUT change path | status 200, changes.path in response |
| PUT change slug | status 200, changes.slug in response |
| PATCH / not allowed | status 405 |

**"File serving" (~10 tests)**

Each test registers a folder via the `register()` helper first.

| Test | Assertions |
|------|-----------|
| Serve file content | status 200, body === "test file content" |
| File response headers | Content-Type, X-Slug, X-Folder-Path, Accept-Ranges, ETag, Cache-Control all present |
| File not found | status 404, json error |
| Unknown slug | status 404, json error |
| Path traversal | status 403 |
| Directory redirect (no trailing /) | status 301, Location header has trailing / |
| Directory listing (trailing /) | status 200, Content-Type text/html |
| Subdomain access (Host header) | status 200, correct file content |
| HEAD method | status 200, no body, headers present |
| POST on file path | status 405 |

**"Range + caching" (~4 tests)**

| Test | Assertions |
|------|-----------|
| Range request | status 206, Content-Range header correct, body length matches range |
| If-None-Match | status 304 |
| If-Modified-Since (future) | status 304 |
| Invalid range | status 200 (falls through to full response) |

**"Directory listing" (~3 tests)**

| Test | Assertions |
|------|-----------|
| Nested directory listing | body contains file names, "Parent directory" link |
| Parent link URL correct | body contains correct parent href |
| Empty directory | status 200 |

**"Dashboard" (~3 tests)**

| Test | Assertions |
|------|-----------|
| GET / default (no Accept) | status 200, body contains "DOCTYPE" |
| GET / Accept: application/json | status 200, body contains "success" |
| GET /?format=json | status 200, body contains "success" |

**Gate:** `bun test tests/http-api.test.ts` — all ~45 tests pass.

---

### Phase 2 — `tests/http-persistence.test.ts` (~5 tests, spawned server, 30 min)

**File:** `tests/http-persistence.test.ts`

**Pattern:** Each test spawns its own server process. No shared state between tests. Uses `--print-template '$port'` for port discovery.

**Helper:** `spawnServer(extraArgs?: string[], envOverrides?: Record<string, string>)` — returns `{ process, port, baseUrl }`.

```typescript
async function spawnServer(extraArgs = [], envOverrides = {}) {
    const process = Bun.spawn(
        ["bun", "run", "src/index.ts", "--port", "0", "--print-template", "$port", ...extraArgs],
        { stderr: "pipe", env: { ...process.env, PERSIST: "true", ...envOverrides } },
    );

    // Collect stderr until we get the template line
    const stderr = process.stderr!;
    let port = 0;
    for await (const chunk of stderr) {
        const line = chunk.toString().trim();
        // The template line is just the port number (e.g. "32787")
        const match = line.match(/^(\d{4,5})$/);
        if (match) {
            port = parseInt(match[1]!, 10);
            break;
        }
    }

    // Wait for server to be ready
    await waitForPort(port);

    return { process, port, baseUrl: `http://localhost:${port}` };
}
```

**Tests:**

| Test | Scenario |
|------|----------|
| registry.json exists after registration | POST via fetch → check file exists with `fs.access` |
| registry.json has valid JSON | read file, `JSON.parse()`, assert `slug` field present |
| folder survives process restart | spawn → register → kill → respawn → GET / → assert count > 0 |
| stale entry skipped on reload | spawn → register → kill → corrupt registry.json paths → respawn → assert count 0 |
| no persistence = empty registry | spawn with `PERSIST=""` → GET / → assert count 0 |

**Cleanup:** Each test kills its process and removes `registry.json` in `afterEach`.

**Gate:** `bun test tests/http-persistence.test.ts` — all 5 tests pass.

---

### Phase 3 — Cleanup (~5 min)

1. `git rm test.sh`
2. Update `AGENTS.md`:
   - Commands table: remove `bash test.sh` rows (keep `bun test`)
   - Tech Stack: change testing row to `bun:test in tests/`
   - Directory Map: add `tests/` entry if not present
3. Verify `bun test` runs all three test files (mcp, http-api, http-persistence)

---

## Dependencies Between Phases

```
Phase 0 (production prep) ──→ Phase 1 (http-api.test.ts)
                                  │
Phase 0 (production prep) ──→ Phase 2 (http-persistence.test.ts)
                                  │
                              Phase 3 (cleanup)
```

- Phase 1 and 2 are independent after Phase 0 — can be implemented in parallel
- Phase 3 depends on both passing

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Handler extraction breaks HTTP behavior | Medium | Run `bash test.sh` after Phase 0 as gate |
| `Bun.file()` behaves differently under direct handler vs network | Low | Same Bun runtime, same file handle; body assertions catch drift |
| Port template parsing fails | Low | Exact format control (`$port` → digits only); clear error if no match |
| Singleton registry causes test pollution | Low | `beforeEach` clear + sequential execution |
| Temp file cleanup fails | Low | `afterAll` with `force: true`; each persistence test cleans its own registry.json |
| Spawn tests are slow (~2s per test for server startup) | Certain | Acceptable — only 5 spawn tests, rest are in-memory microseconds |

## Estimated Effort

| Phase | Files | Lines | Time |
|-------|-------|-------|------|
| 0a. Extract handler | http.ts | ~5 changed | 10 min |
| 0b. CLI changes | cli.ts | ~8 changed | 5 min |
| 0c. Index changes | index.ts | ~8 changed | 5 min |
| 0d. Registry clear | registry.ts | ~3 added | 2 min |
| 1. HTTP API tests | http-api.test.ts | ~200 new | 60 min |
| 2. Persistence tests | http-persistence.test.ts | ~80 new | 30 min |
| 3. Cleanup | test.sh, AGENTS.md | ~0 | 5 min |
| **Total** | **7 files** | **~304** | **~2.25 hours** |

## Status

| Phase | Status | Commit |
|-------|--------|--------|
| 0. Production prep | ✅ Done | |
| 1. HTTP API tests | ✅ Done | |
| 2. Persistence tests | ✅ Done | |
| 3. Cleanup | ✅ Done | |
