# Research: Dynamic HTTP File Server with Folder Registration

> Generated from research session on TASK.md requirements.
> Covers ready-to-use solutions, server wrappers (Caddy/Nginx/Bun), framework comparisons, libraries, and architectural trade-offs.

---

## Table of Contents

1. [Task Requirements Summary](#1-task-requirements-summary)
2. [Ready-to-Use Solutions](#2-ready-to-use-solutions)
3. [Server Wrapper Approaches](#3-server-wrapper-approaches)
   - [Caddy Server + Admin API](#3a-caddy-server--admin-api)
   - [Nginx (Open Source)](#3b-nginx-open-source)
   - [OpenResty (Nginx + Lua)](#3c-openresty-nginx--lua)
4. [Bun-Native Server Approach](#4-bun-native-server-approach)
5. [Framework-Based Approaches](#5-framework-based-approaches)
   - [Fastify](#5a-fastify-recommended-for-nodejs)
   - [Express](#5b-express)
   - [Hono](#5c-hono)
   - [Python (FastAPI + Starlette)](#5d-python-fastapi--starlette)
6. [Key Libraries & Packages by Concern](#6-key-libraries--packages-by-concern)
7. [Subdomain Routing on Localhost](#7-subdomain-routing-on-localhost)
8. [Architecture Patterns](#8-architecture-patterns)
9. [Comprehensive Pros & Cons Matrix](#9-comprehensive-pros--cons-matrix)
10. [Final Recommendation](#10-final-recommendation)

---

## 1. Task Requirements Summary

The task is to create an HTTP server that serves files in a dynamic fashion with the following capabilities:

### Core Features

| Feature | Description |
|---------|-------------|
| **Folder Registration** | Clients register folders via `POST /` with `{ "folder_path": "/path/to/folder" }`. Server generates a unique slug. |
| **Path-Based Serving** | Registered folder served at `http://<host>:<port>/<slug>` and all nested files beneath it. |
| **Subdomain Serving** | Same folder also accessible at `http://<slug>.<host>:<port>`. |
| **Dashboard (GET /)** | Lists all registered folders with slugs, links, and management UI. |
| **Unregister (DELETE /)** | Remove a folder registration by slug or folder_path. |
| **Update (PUT /)** | Update folder_path for a given slug, or update slug by providing folder_path. |
| **Response Format** | All operations return appropriate HTTP status codes and messages suitable for both humans and LLM AI Agents. |
| **Initial Scope** | HTTP only (no HTTPS), localhost only. Backend first, dashboard later. |

### Key Constraints

- No off-the-shelf solution satisfies this combination of features.
- The server must handle **runtime/dynamic** addition and removal of served directories — not pre-configured static paths.
- Responses must be structured for both human readability and LLM agent parsing.

---

## 2. Ready-to-Use Solutions

### Summary: None Exist

After exhaustive research across Node.js, Python, Go, and general-purpose web servers, **no ready-to-use tool matches the full set of requirements**. The gap is specifically in combining dynamic runtime folder registration, CRUD API, subdomain routing, and a management dashboard in one package.

### Closest Tools (and Why They Fall Short)

| Tool | Language | What It Does | Gap vs Requirements |
|------|----------|-------------|---------------------|
| `http-server` | Node.js | Zero-config CLI static server for a single directory | Single directory only, no API, no runtime registration |
| `serve` (Vercel) | Node.js | Production-grade static file server | Pre-configured directory, no API, no runtime changes |
| `light-server` | Node.js | Lightweight local dev server | Single directory, no CRUD API |
| `browser-sync` | Node.js | Dev server + live reload | Not designed as a file-sharing server, no CRUD |
| `python -m http.server` | Python | Built-in simple HTTP server | Single directory, no API |
| Go `static-server` (eliben) | Go | CLI static content server for local testing | Fixed directory at startup, no API |
| Caddy Proxy Manager | Go/Next.js | Web UI to manage Caddy proxies | Full Docker dependency, reverse proxy manager (not file server with CRUD API) |

### Static File Serving Packages (Not Solutions, But Building Blocks)

| Package | Notes |
|---------|-------|
| `serve-static-bun` (v0.5.3) | **Unmaintained** — author abandoned it (2 years ago). Middleware-style for `Bun.serve`. ~6 dependents. Zero dependencies. Supports path stripping, dotfiles, trailing slash redirects. |
| `@fastify/static` | Mature, supports prefix routing and multiple root directories via array. Production-ready. |
| `express.static()` | Classic Express middleware. Single root per call, chainable for multiple roots. |
| `@honojs/serve-static` | Hono's static serving middleware. **Had CVE-2026-29087** (path traversal via encoded slashes `%2F`). Patched in `@hono/node-server >= 1.19.10`. |
| Starlette `StaticFiles` | Python/ASGI static files. Runtime mount via `app.router.routes.append(Mount(...))`. |

---

## 3. Server Wrapper Approaches

The idea of wrapping an existing production-grade web server is valid. Two candidates stand out: Caddy (excellent fit) and Nginx (poor fit).

### 3.A — Caddy Server + Admin API ⭐ Best External Server Match

Caddy has a **built-in REST Admin API** on `localhost:2019` specifically designed for programmatic runtime configuration. It is the best "wrap an existing server" option for this task.

#### Admin API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/load` | Sets or replaces the entire active configuration. Blocks until reload completes or fails. Zero downtime. Rolls back automatically on failure. Accepts JSON (`application/json`) or Caddyfile (`text/caddyfile`). |
| `POST` | `/stop` | Gracefully shuts down the server process. |
| `GET` | `/config/[path]` | Exports current configuration at the given path as JSON. Full tree traversal. |
| `POST` | `/config/[path]` | Creates/replaces object; appends to array. Supports `...` suffix to append multiple items to arrays. |
| `PUT` | `/config/[path]` | Inserts into array at index; strictly creates new value for objects. |
| `PATCH` | `/config/[path]` | Strictly replaces an existing value or array element. |
| `DELETE` | `/config/[path]` | Removes configuration at the named path. E.g., `DELETE /config/apps/http/servers/myserver` removes that server block entirely. |
| `POST` | `/adapt` | Adapts a configuration (e.g., Caddyfile) to JSON **without** loading/running it. Useful for validation. |
| `GET` | `/pki/ca/<id>` | Returns PKI CA information. |
| `GET` | `/reverse_proxy/upstreams` | Returns status of reverse proxy upstreams (active requests, failures). |

#### Example: Loading Configuration via API

```bash
# Load full JSON config:
curl "http://localhost:2019/load" \
  -H "Content-Type: application/json" \
  -d @caddy.json

# Load Caddyfile format:
curl "http://localhost:2019/load" \
  -H "Content-Type: text/caddyfile" \
  --data-binary @Caddyfile

# Check current config:
curl "http://localhost:2019/config/" | jq .
```

#### How TASK.md Maps to Caddy API

| Operation | Caddy Approach |
|-----------|---------------|
| Register folder (`POST /`) | Generate Caddy JSON config with new route entry + `file_server` handler, then `POST /load` full config (or `POST /config/apps/http/servers/myserver/routes/...` to append route) |
| Serve files by slug | Route with path matcher `{ "path": ["/{slug}/*"] }` → `file_server` handler with `root` set to registered directory |
| Serve by subdomain | Route with host matcher `{ "host": ["{slug}.localhost"] }` → same `file_server` handler |
| Unregister (`DELETE /`) | `DELETE /config/apps/http/servers/myserver/routes/N` to remove the route entry, or regenerate full config minus that entry and `POST /load` |
| Update (`PUT /`) | `PATCH /config/apps/http/servers/myserver/routes/N` to update root or slug values, or full `POST /load` |
| Dashboard | Static HTML served as another `file_server` route within Caddy itself |

#### Caddy Concurrency & Safety

The Admin API provides **ACID guarantees for individual requests**. For multi-request changes:

- Responses include `Etag` header with content hash
- Send `If-Match` header on mutative requests to prevent collisions
- If response is `412 Precondition Failed`, retry from `GET /config/...`

Config persistence is built in:
- Latest configuration saved to disk after any changes (unless disabled)
- Resume last working config: `caddy run --resume`
- Guarantees config durability across power cycles

#### Node.js/Bun SDK

A **Caddy API Client for Node.js/Bun** was published by ASD (Accelerated Software Development) in February 2026. It wraps all Admin API endpoints:

- Configuration loading/reloading
- Caddyfile adaptation (Caddyfile → JSON)
- Health checks and server info
- Works with both Node.js and Bun runtimes
- Fills the gap where JavaScript ecosystem previously lacked production-grade Caddy Admin API client

There is also **Caddy Proxy Manager** (caddyproxymanager.com), a full management UI built on Next.js + shadcn/ui that sits on top of Caddy. Overkill for this task but demonstrates the API's capability.

#### Pros

- Caddy is a production-grade web server — best-in-class file serving with MIME types, compression, range requests, caching headers out of the box
- Built-in automatic HTTPS provisioning (for future upgrade beyond localhost)
- Zero-downtime configuration reloads
- Config persistence baked into Caddy (`--resume`)
- ETag-based optimistic concurrency for multi-client safety
- The Admin API is designed exactly for programmatic dynamic configuration
- `file_server` handler is battle-tested and handles edge cases you'd need to implement manually
- Subdomain/host-based routing via matchers — native support

#### Cons

- **External process dependency** — Caddy binary must be installed separately from the Bun application
- Config updates require generating full Caddy JSON or Caddyfile, then posting it (more overhead than in-memory registry)
- For real subdomain resolution (`slug.localhost`), still requires `/etc/hosts` entries or wildcard DNS
- Architecture adds complexity: Bun app ↔ Caddy Admin API (HTTP calls on port 2019) ↔ actual HTTP serving
- Dashboard would run as separate concern unless embedded in Caddy config itself
- Learning curve for Caddy JSON config structure (nested apps → http → servers → routes → handle)

---

### 3.B — Nginx (Open Source)

**Verdict: Not viable for this use case.**

The open-source version of Nginx has **no dynamic configuration API**. Adding or removing virtual hosts, location blocks, or static file roots requires editing `.conf` files on disk and sending a reload signal:

```bash
nginx -s reload  # Reload after editing conf files
```

There is no REST API, no programmatic CRUD interface, no runtime route registration.

#### Feature Comparison: Open Source vs NGINX Plus

| Feature | Open Source | NGINX Plus (Paid) |
|---------|------------|-------------------|
| Dynamic upstream server config | ❌ No | ✅ REST API available |
| Dynamic vhost/location blocks | ❌ No | ❌ No |
| Dynamic static file roots | ❌ No | ❌ No |
| Runtime reload | `nginx -s reload` only | Partial API support |
| JavaScript extension | njs module (very limited) | njs module (enhanced) |

NGINX Plus's dynamic configuration API (documented at docs.nginix.com) applies **only to upstream server groups** — not to routes, location blocks, or static file serving. Even the paid version doesn't solve our problem.

#### Workarounds Attempted by Others

- **njs module**: Embeds JavaScript (ES5.1 strict mode with some ES6 extensions) inside Nginx. Can manipulate headers, responses, and basic routing. Extremely limited compared to modern JS. Not suitable for building a CRUD API + dashboard. The npm ecosystem requires transpilation to run under njs.

- **Config file generation from external process**: Write new `.conf` files from Node.js/Bun via `child_process.exec("nginx -s reload")`. Fragile, race-condition prone, and error-prone on concurrent modifications.

- **redx** (github.com/rstudio/redx): Archived project that used Redis + Lua within OpenResty to dynamically manage frontends/backends in Nginx. Was used in production at shinyapps.io but has been **unmaintained since 2021** (repository deleted March 2021). Demonstrates the concept but is no longer available.

---

### 3.C — OpenResty (Nginx + LuaJIT)

OpenResty bundles Nginx with LuaJIT, enabling runtime request manipulation through Lua code embedded in Nginx config files.

#### Capabilities

- Dynamic per-request routing based on shared dictionaries (`ngx.shared.DICT`)
- Real-time response manipulation (`content_by_lua`, `rewrite_by_lua`, `access_by_lua`)
- Non-blocking I/O via cosockets (basis of `lua-resty-*` libraries)
- Cookie, JWT, and authentication handling
- Layer 4 traffic handling via stream module

#### How It Would Work for This Task

1. Store slug-to-folder mappings in a Lua shared dictionary (shared memory across workers)
2. In `rewrite_by_lua_block`, look up the request's host/path prefix in the dictionary
3. Rewrite the URI to point to the correct folder root
4. Use `root` directive or internal redirect to serve files

#### Pros

- True dynamic routing without config reloads
- Extremely high performance (C-level nginx workers + JIT-compiled Lua)
- Shared dictionary persists across requests within process lifetime

#### Cons

- **Lua development** — must write logic in Lua, not TypeScript/JavaScript
- No native REST API for CRUD — you'd need to build one inside Lua handlers or run a separate process to update shared dicts
- Steep learning curve for OpenResty ecosystem
- Dashboard would need to be served from within Nginx static context, managed separately
- Complex architecture: external process writes to shared dict ↔ Nginx workers read it
- Overkill for a localhost tool

---

## 4. Bun-Native Server Approach ⭐ Best Dev Experience

Building the server directly with Bun's native APIs eliminates all external dependencies and gives complete control over every aspect of the system.

### Bun Native APIs Available

#### `Bun.serve()` — HTTP Server

Built on uWebSockets (uWS), supporting HTTP/1.1, HTTP/2, WebSocket protocols.

```ts
// Basic server
Bun.serve({
  port: 8080,
  fetch(req: Request) {
    return new Response("Hello world");
  },
});
```

Two routing approaches:

```ts
// Declarative routes (static at startup)
Bun.serve({
  routes: {
    "/": () => new Response("Home"),
    "/api/version": async () => Response.json({ version: "1.0" }),
    "/users/:id": ({ params }) => Response.json({ id: params.id }),
    "/files/*": ({ params }) => { /* wildcard */ },
  },
  fetch() {
    return new Response("Unmatched route"); // fallback
  },
});
```

**Limitation**: `routes` property is static at `Bun.serve()` call time — routes cannot be added or removed dynamically after server starts.

**Solution**: Use only the `fetch` handler as a catch-all and implement a manual in-memory routing table with a `Map`. This is simpler and more flexible than framework-level dynamic routing.

#### `Bun.file()` — File I/O

Creates a lazily-loaded file handle. No disk I/O until actually read.

```ts
const file = Bun.file("/path/to/file.txt");

file.size;       // number of bytes
file.type;       // MIME type (auto-detected)
await file.exists(); // boolean
await file.text();   // contents as string
await file.json();   // contents as JSON object
await file.stream(); // ReadableStream
await file.arrayBuffer(); // ArrayBuffer
await file.bytes();      // Uint8Array
await file.delete();     // delete from disk
```

MIME types auto-detected for common extensions: `.json`, `.txt`, `.tsx`, `.png`, `.html`, etc. Default fallback: `text/plain;charset=utf-8`. Can be overridden with options: `Bun.file(path, { type: "application/json" })`.

#### `new Response(BunFile)` — Streaming File Responses

```ts
// Serve a file — Bun auto-sets Content-Type based on extension
const file = Bun.file("./package.json");
const response = new Response(file);
// response.headers.get("Content-Type") => "application/json;charset=utf-8"

// Static file server in 4 lines
Bun.serve({
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const file = Bun.file(path);
    return new Response(file);
  },
});
```

#### Performance Architecture

`Bun.serve()` builds on:
- **uWebSockets** (uWS) tree-based routing engine
- SIMD-accelerated URI decoding (`decodeURIComponentSIMD`)
- JavaScriptCore structure caching for route handlers
- Benchmark range: ~25,000–35,000 req/s (comparable to Fastify, significantly faster than Express)

### Implementation Sketch for TASK.md

```ts
import { join } from "path";

interface RegistryEntry {
  slug: string;
  path: string;
  createdAt: Date;
}

const registry = new Map<string, RegistryEntry>();

async function handleDashboard(req: Request): Promise<Response> {
  // For GET / — render dashboard HTML or return JSON listing
  if (req.headers.get("accept")?.includes("text/html")) {
    return new Response(Bun.file("./dashboard.html"));
  }

  const folders = Array.from(registry.values()).map((entry) => ({
    slug: entry.slug,
    path: entry.path,
    url: `http://localhost:8080/${entry.slug}`,
    subdomain_url: `http://${entry.slug}.localhost:8080`,
    registered_at: entry.createdAt.toISOString(),
  }));

  return Response.json({
    message: "Registered folders. POST to add, DELETE/PUT to manage.",
    count: folders.length,
    folders,
  });
}

async function handleRegister(req: Request): Promise<Response> {
  // For POST / with body { "folder_path": "/path/to/folder" }
  const body = await req.json();
  const folderPath = body.folder_path;

  if (!folderPath || typeof folderPath !== "string") {
    return Response.json(
      { error: "Missing or invalid 'folder_path'. Provide a valid directory path." },
      { status: 400 }
    );
  }

  // Generate slug from folder basename + unique suffix
  const baseName = folderPath.split("/").filter(Boolean).pop() ?? "root";
  const slug = `${baseName}-${nanoid(6)}`;

  registry.set(slug, { slug, path: folderPath, createdAt: new Date() });

  return Response.json(
    {
      message: `Folder registered successfully. Access at http://localhost:8080/${slug}`,
      slug,
      path: folderPath,
    },
    { status: 201 }
  );
}

// Main server
Bun.serve({
  port: 8080,
  hostname: "0.0.0.0",
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // Parse subdomain from Host header
    const hostParts = url.hostname.split(".");
    const subdomain = hostParts.length > 1 ? hostParts[0] : null;

    // API endpoint: /
    if (pathname === "/" && !subdomain) {
      switch (req.method) {
        case "GET":
          return handleDashboard(req);
        case "POST":
          return handleRegister(req);
        case "DELETE":
          return handleUnregister(req, url);
        case "PUT":
          return handleUpdate(req, url);
      }
    }

    // File serving — by subdomain or path prefix
    const slug = subdomain || pathname.slice(1).split("/")[0];
    const entry = registry.get(slug);

    if (!entry) {
      return Response.json(
        { error: `Slug '${slug}' not found. Use GET / to list registered folders.` },
        { status: 404 }
      );
    }

    // Compute relative file path within the registered folder
    const fileRelPath = subdomain
      ? pathname
      : pathname.slice(`/${slug}`.length) || "/";

    const filePath = join(entry.path, decodeURIComponent(fileRelPath));
    const file = Bun.file(filePath);

    if (await file.exists()) {
      return new Response(file); // auto Content-Type + streaming
    }

    return Response.json(
      { error: `File not found: '${fileRelPath}' in slug '${slug}'` },
      { status: 404 }
    );
  },
});
```

### Pros

- **Single process, zero external dependencies** — no Nginx, no Caddy, no Redis
- **Full control over every aspect** — API responses, error messages, LLM-friendly formatting
- **Dead simple architecture** — one Map as registry, one fetch handler for all routing
- **Estimated code size**: ~150–200 lines of TypeScript for full CRUD + file serving
- **Subdomain routing via Host header** — works without `/etc/hosts` modifications
- **LLM-friendly responses are trivial** — you control exact JSON structure and message wording
- **Dashboard is a single HTML page** served via `Bun.file("./dashboard.html")`
- **Native TypeScript support** — zero configuration
- **Built on uWebSockets** — ~35k+ req/s performance
- **`Bun.file()` handles MIME types automatically** — no need for `mime-types` package
- **Streaming responses** — large files don't block the event loop

### Cons

- **Range requests (HTTP partial content) need manual implementation** — required for proper video/audio playback and resumable downloads. `Bun.file().slice(start, end)` or stream manipulation needed.
- **Cache-Control / ETag headers** must be set manually in responses
- **No automatic HTTPS** — though Bun supports TLS via `{ tls: { certName: "..." } }` in serve options
- **Directory listing** needs to be implemented manually (Node.js `fs.readdirSync` or Bun equivalent for when user visits `/slug/` without a specific file)
- **MIME type detection** works for common extensions but may miss less common file types
- **`routes` property is static** — dynamic routing requires the `fetch` catch-all pattern (which actually turns out to be simpler)
- **Path traversal security** — must validate that resolved paths stay within the registered folder (no `../` escaping)

---

## 5. Framework-Based Approaches

These are included for completeness since they were considered during initial research. They use Node.js rather than Bun, but are valid alternatives.

### 5.A — Fastify (Recommended for Node.js)

Fastify is the fastest Node.js web framework, offering ~30k req/s throughput.

#### Why It Was Recommended Initially

- Built-in JSON Schema validation (perfect for structured LLM-friendly responses)
- Plugin architecture with encapsulation
- `@fastify/static` supports prefix routing (`prefix: "/slug"`) and multiple roots
- Host constraints: `{ constraints: { host: "slug.localhost" } }` for subdomain routing
- Built-in JSON body parsing
- Excellent TypeScript support
- `pino` logger bundled

#### Dynamic Routes in Fastify

```ts
// Register a route
fastify.get<{ Params: { file: string } }>(
  "/:slug/*",
  { handler: serveFiles },
);

// Remove a route
fastify.deleteRoute({ method: "GET", url: "/:slug/*" });
```

**Challenge**: `deleteRoute()` interacts with Fastify's encapsulation model. Removing routes added by plugins can be tricky — the route must be removed from the correct scope. This adds complexity to the unregister flow.

#### Static Serving via `@fastify/static`

```ts
await fastify.register(import("@fastify/static"), {
  root: path.join(__dirname, "public"),
  prefix: "/dashboard/",
});
```

Supports arrays of directories for multiple roots ("first found, first served"). However, adding new static directories at runtime requires re-registering the plugin, which is not cleanly supported.

#### Pros
- Best performance in Node.js ecosystem
- Schema validation built-in
- Clean host constraint matching for subdomains
- Strong TypeScript support

#### Cons
- Dynamic static directory registration is awkward
- Route removal has encapsulation caveats
- Node.js-specific (not compatible with Bun natively)
- Encapsulation model adds mental overhead

---

### 5.B — Express

The most established Node.js framework with the largest ecosystem.

#### Static File Serving

```ts
app.use("/slug1", express.static("/path/to/folder1"));
app.use("/slug2", express.static("/path/to/folder2"));
```

Multiple `express.static()` calls chained together serve different directories under different prefixes.

#### Subdomain Routing

No native subdomain routing. Must parse `req.headers.host` manually:

```ts
app.use((req, res, next) => {
  const host = req.headers.host; // "my-docs.localhost:8080"
  const parts = host.split(".");
  const subdomain = parts[0];
  // route based on subdomain
  next();
});
```

#### Dynamic Routes

Express does not cleanly support adding/removing middleware or routes at runtime. The internal router stack (`app._router.stack`) can be manipulated, but this is undocumented and fragile:

```ts
// Fragile — not officially supported
const layerIndex = app._router.stack.findIndex(
  (layer) => layer.route?.path === "/slug/*"
);
if (layerIndex !== -1) {
  app._router.stack.splice(layerIndex, 1);
}
```

#### Pros
- Largest ecosystem and most tutorials
- Simplest learning curve
- Massive third-party middleware library
- Trivial to find help and examples

#### Cons
- Slowest performance (~15k req/s, half of Fastify)
- No built-in validation (need ajv/express-validator)
- Dynamic route manipulation is hacky and undocumented
- Subdomain routing requires manual Host header parsing
- Node.js-specific

---

### 5.C — Hono

A modern, lightweight framework gaining rapid adoption. ~25k req/s.

#### Static File Serving

```ts
import { serveStatic } from "@hono/node-server/serve-static";

app.use("/web/*", serveStatic({ root: "./public" }));
app.get("/web/*", serveStatic({ path: "./public/index.html" }));
```

Uses `@honojs/serve-static` middleware. Supports root directory, path rewriting, and index file fallback.

#### Security Note

**CVE-2026-29087**: Published March 2026. `@hono/node-server < 1.19.10` had authorization bypass via encoded slashes (`%2F`) in static file paths — routing layer and static handler normalized URLs differently, allowing protected resources to be accessed without running middleware. **Fixed in 1.19.10+**. Relevant if you build on Hono for file serving.

#### Pros
- Modern API, lightweight
- Edge computing compatible (Cloudflare Workers, Deno, Bun)
- Clean type safety
- Surprisingly fast (~25k req/s)

#### Cons
- Smallest ecosystem among the three
- Recent security vulnerability in static file serving (now patched)
- Limited route removal support
- Less mature plugin system than Fastify/Express
- Bun compatibility may require `@hono/bun` adapter

---

### 5.D — Python (FastAPI + Starlette)

Included for completeness as a cross-language option.

#### Dynamic Static File Mounting

```python
from starlette.staticfiles import StaticFiles
from starlette.routing import Mount

# Runtime addition
app.router.routes.append(
    Mount("/slug", StaticFiles(directory="/path/to/folder"), name="slug")
)
```

Starlette's `Mount` allows adding static file directories at runtime by appending to the router's route list.

#### Pros
- Great if team prefers Python
- `Mount` supports dynamic addition cleanly
- FastAPI provides auto-generated OpenAPI docs
- Rich Python filesystem tools (pathlib, etc.)

#### Cons
- Less common for local HTTP tooling compared to Node.js/Bun ecosystem
- No native subdomain routing — must use middleware
- Performance lower than Bun/Fastify for file serving
- Requires separate process for running + would need different build tooling
- Dashboard would be in Python templates (Jinja2) or separate SPA

---

## 6. Key Libraries & Packages by Concern

### Slug Generation

| Package | Description | Output Example | Notes |
|---------|------------|----------------|-------|
| `nanoid` | URL-safe unique ID generator. Default: 21 chars, cryptographically secure. ~1KB bundle. | `V1StGXR8_Z5jdHi6B-myT` | **Recommended.** Tiny, fast, no dependencies. Customizable alphabet and size: `nanoid(6)` → `a3k9xZ`. |
| `uuid` (v4) | RFC 4122 standard UUID. 36 characters with hyphens. | `9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d` | Standard-compliant, widely interoperable. Longer strings. ~70KB bundle. |
| `short-uuid` | Encodes UUID v4 to shorter base57 string. | `v4f1yZKQbMxR` | Depends on uuid internally. Shorter but extra conversion step. |
| `cuid` | Collision-resistant IDs with monotonic timestamps. | `cj5o0rlo20000l86btg29stbk` | Not recommended — security issues in older versions, deprecated. |
| `ulid` | Lexicographically sortable unique IDs. 26 chars, base32. | `01ARZ3NDEKTSV4RRFFQ69G5FAV` | Good for database ordering, overkill for slugs. |

#### Recommended Slug Strategy

Combine human-readable name + unique suffix:

```ts
import { nanoid } from "nanoid";
import { slugify } from "slugify";

function generateSlug(folderPath: string): string {
  const baseName = folderPath.split("/").filter(Boolean).pop() ?? "root";
  const readablePart = slugify(baseName, { lower: true, strict: true });
  const uniqueSuffix = nanoid(6);
  return `${readablePart}-${uniqueSuffix}`;
}

// "My Documents" → "my-documents-a3k9xZ"
// "/tmp/share/report v2" → "report-v2-k7bMnL"
```

| Package | Purpose | Notes |
|---------|---------|-------|
| `slugify` | Convert arbitrary strings to URL-safe slugs | Handles special chars, unicode, spaces. e.g., `"My Folder!"` → `"my-folder"` |
| `nanoid` | Generate unique random suffix | `nanoid(6)` produces 6-char cryptographically secure random string |

### Other Key Packages

| Concern | Package | Description |
|---------|---------|-------------|
| File serving (Bun) | `Bun.file()` | Native — auto MIME detection, streaming, lazy loading |
| File serving (Node) | `serve-static-bun` | Unmaintained middleware for Bun.serve / Bao.js |
| Path joining | `path.join` / `path.resolve` | Node.js stdlib (available in Bun) — for safe path construction |
| Body parsing (Bun) | Native `req.json()` | Web Standard API, built into Bun Request |
| Logging | Console logging or custom | No external package needed for MVP; Bun has native console |

---

## 7. Subdomain Routing on Localhost

This is a non-trivial problem. `slug.localhost` does not resolve to `127.0.0.1` by default.

### Three Approaches

#### 1. Host Header Parsing (Recommended for MVP)

The server binds to `0.0.0.0:8080`. Client sends requests with arbitrary Host headers:

```bash
curl -H "Host: my-docs.localhost:8080" http://127.0.0.1:8080/
```

Or via URL with direct IP:
```bash
curl http://my-docs.localhost:8080/  # Won't work without DNS
curl -H "Host: my-docs.localhost:8080" http://localhost:8080/  # Works!
```

**Pros**: No system configuration changes, works immediately
**Cons**: Users must manually set Host header or use special browser extensions for testing; raw URL `http://my-docs.localhost:8080` won't resolve in browsers

#### 2. `/etc/hosts` Entries

Add entries for each slug:
```
127.0.0.1  my-docs.localhost
127.0.0.1  report.localhost
127.0.0.1  images.localhost
```

The dashboard/API could automate this by running `sudo echo "..." >> /etc/hosts` on registration, but this requires root privileges and is a poor UX.

**Pros**: URLs work in browsers natively (`http://my-docs.localhost:8080`)
**Cons**: Requires sudo, manual maintenance, platform-specific paths, bad for automated/programmatic use

#### 3. Wildcard DNS / mDNS

Use a local DNS server (dnsmasq, systemd-resolved) to resolve `*.localhost` to `127.0.0.1`:

```bash
# dnsmasq config
address=/localhost/127.0.0.1
```

Or mDNS (.local addresses via Avahi/Zeroconf).

**Pros**: All subdomains work automatically
**Cons**: Requires system-level setup, not portable, overkill for localhost tooling

### Recommendation

For the initial version: **Host header parsing (approach 1)**. It works without any system configuration. The dashboard can show both the direct URL format and curl examples with Host headers. Add `/etc/hosts` automation as an optional feature later.

---

## 8. Architecture Patterns

### Pattern 1: In-Memory Registry + Single Catch-All Route (Recommended)

```
┌─────────────────────────────────────────────┐
│                 Bun Process                  │
│                                              │
│  ┌──────────┐    ┌─────────────────────┐    │
│  │  Map<     │    │  fetch(req) handler  │    │
│  │   slug,   │    │                     │    │
│  │   {path}  │◄──►│  - API routing      │    │
│  └──────────┘    │    (/, GET/POST/     │    │
│                  │     DELETE/PUT)       │    │
│                  │  - Slug extraction    │    │
│                  │    (path or subdomain) │    │
│                  │  - Bun.file() serve   │    │
│                  └─────────────────────┘    │
│                                              │
│  Binds: 0.0.0.0:8080                        │
└─────────────────────────────────────────────┘
```

**Pros**: Simple, single process, easy to debug, memory-efficient for typical usage, clean separation of concerns
**Cons**: Registry lost on restart (no persistence), no built-in range requests/caching headers

### Pattern 2: Caddy Backend + Bun CRUD API

```
┌──────────┐    Admin API     ┌──────────────┐
│ Bun App  │◄──fetch / config──│   Caddy      │
│          │                   │              │
│ POST /   │──POST /load──────►│ file_server  │
│ (register)│  (reload config)  │ handler      │
└──────────┘                   └──────────────┘
                                  ↓ serves files
                              HTTP clients
```

**Pros**: Production-grade file serving, automatic MIME/range/compression, HTTPS ready
**Cons**: Two processes to manage, more complex debugging, external dependency

### Pattern 3: Catch-All Route with Filesystem Routing

Instead of per-slug static middleware, use a single route that reads the slug from the URL/Host header and serves directly via `Bun.file()`:

```ts
// No dynamic middleware registration needed
// Single handler checks Map, resolves path, serves via Bun.file()
```

This is essentially Pattern 1 but called out explicitly as the preferred sub-pattern over trying to dynamically register static middleware.

---

## 9. Comprehensive Pros & Cons Matrix

### By Approach

| Approach | Build Time | Runtime Perf | Complexity | External Deps | Subdomain | File Serving Quality | HTTPS Ready |
|----------|-----------|-------------|------------|---------------|-----------|---------------------|-------------|
| **Pure Bun** | Fast (~150-200 lines) | High (35k+ req/s) | Low | None | Host header parsing | Good (auto MIME), missing range requests | Via `tls` option |
| **Caddy + Bun API** | Medium (config gen + client) | Very High (Caddy engine) | Medium | Caddy binary | Native matchers | Excellent (built-in compression, range, caching) | ✅ Automatic |
| **Fastify (Node.js)** | Medium (~200-300 lines) | High (30k req/s) | Medium-High | @fastify/static, etc. | Host constraints | Good (@fastify/static) | Via tls-cert |
| **Express (Node.js)** | Medium (~200-300 lines) | Medium (15k req/s) | Low-Medium | express, mime-types | Manual host parse | Good (express.static) | Via express-sslify |
| **Hono** | Medium (~150-200 lines) | High (25k req/s) | Low-Medium | @hono/* adapters | Manual host parse | Good (@honojs/serve-static) | Via adapter |
| **Python/FastAPI** | Medium (~200-300 lines) | Medium (10-15k req/s) | Medium | fastapi, uvicorn | Manual middleware | Good (StaticFiles) | Via uvicorn ssl |
| **OpenResty + Lua** | Slow (Lua dev + nginx config) | Very High (100k+ req/s) | Very High | OpenResty, lua libs | Native server blocks | Excellent (nginx file serving) | ✅ Native |
| **Nginx (OSS)** | N/A — not viable | N/A | N/A | — | — | — | — |

### By Design Choice

| Choice | Pros | Cons |
|--------|------|------|
| In-memory registry (Map) | Fast, simple, zero I/O overhead | Lost on process restart |
| File-based persistence (JSON file) | Survives restarts, human-readable | I/O overhead, concurrent write concerns |
| SQLite persistence | ACID transactions, queryable history | External dependency, overkill for this task |
| Host header subdomain routing | Zero system config required | Raw URLs don't resolve in browsers; requires curl -H or browser extension |
| /etc/hosts entries | URLs work natively in browsers | Requires root, manual maintenance, bad UX |
| Wildcard DNS | All subdomains auto-resolve | System-level setup, not portable, overkill |
| Full config reload (Caddy POST /load) | Simple to reason about, atomic rollback | Slower per-operation than incremental PATCH |
| Incremental config (Caddy PATCH/DELETE) | Targeted changes, no full config regen | Complex path management, race condition risks |

### By Framework

| Framework | Best For | Avoid When |
|-----------|----------|------------|
| **Bun native** | Localhost tools, rapid prototyping, minimal deps | Need production HTTPS/range requests out of box |
| **Fastify** | Node.js projects needing schema validation + performance | Prefer Bun runtime or want zero-framework approach |
| **Express** | Teams deeply familiar with Express ecosystem | Performance is a concern or dynamic routes are needed |
| **Hono** | Edge deployments (Cloudflare Workers) or multi-runtime needs | Need mature plugin ecosystem or route removal APIs |
| **Caddy wrapper** | Production deployment with automatic HTTPS and enterprise file serving | Want single-process simplicity or avoid external dependencies |
| **OpenResty** | High-traffic production environments needing nginx performance | Anything localhost/tooling-related — massive overkill |

---

## 10. Final Recommendation

### Recommended Stack

```
Runtime:        Bun (latest stable)
Server:         Bun.serve() with fetch catch-all handler
Registry:       Map<slug, {path, createdAt}> (in-memory)
File serving:   Bun.file() → new Response(file) (auto MIME, streaming)
Slug generation: nanoid(6) + slugify(folder_basename)
Dashboard:      Single embedded HTML page served via Bun.file("./dashboard.html")
Subdomain:      Host header parsing (subdomain from url.hostname.split("."))
Path security:  Resolve and validate that final path starts with registered folder root
Language:       TypeScript
```

### Why This Stack

1. **Matches stated preference**: Native Bun APIs, no frameworks, no external processes.
2. **Simplest possible architecture**: One process, one file, ~150 lines of TypeScript.
3. **All TASK.md requirements covered**:
   - `GET /` → dashboard listing or JSON endpoint
   - `POST /` → register folder, generate slug, store in Map
   - `DELETE /` → remove from Map by slug or path
   - `PUT /` → update mapping in Map
   - File serving at `/<slug>/*` and `<slug>.hostname/*`
   - Human + LLM-friendly JSON responses (full control over structure)
4. **No external dependencies**: Zero npm/bun packages required if you inline a simple nanoid implementation. Optional: `nanoid` and `slugify` for convenience.
5. **Extensible**: Dashboard UI can be added later as a separate phase (as stated in TASK.md). HTTPS support available via `Bun.serve({ tls: {...} })`. Persistence layer (SQLite/JSON file) can be added when needed.

### Future Enhancements (Post-MVP)

| Enhancement | Approach |
|-------------|----------|
| Persistent registry | Save `registry` Map to JSON file on changes, load on startup |
| Range requests | Parse `Range` header, use `Bun.file().slice(start, end)` |
| Cache-Control headers | Add `Cache-Control`, `ETag`, `Last-Modified` to file responses |
| Automatic HTTPS | Configure TLS in `Bun.serve` options |
| Directory listing | Implement `fs.readdir` fallback when URL ends with `/` |
| Automated /etc/hosts | `child_process.exec` to add/remove entries on register/unregister |
| Caddy reverse proxy | Add Caddy in front for production deployment with automatic HTTPS and compression |
