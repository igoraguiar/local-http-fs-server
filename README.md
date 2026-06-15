# Local HTTP File Server

A lightweight, zero-dependency HTTP file server built with [Bun](https://bun.sh) that dynamically registers local directories at runtime. Each folder receives a unique URL slug and becomes accessible via path-based routes and subdomain-based access.

## Features

- **Runtime folder registration** — add, remove, and update served directories without restarting
- **Slug-based routing** — automatic URL-safe slugs (`/documents-a3k9xZ/`) or custom slugs
- **Subdomain access** — serve via `slug.localhost` in addition to path-based URLs
- **CRUD API** — full JSON API for managing folder registrations (`GET`, `POST`, `PUT`, `DELETE`)
- **File serving** — automatic MIME detection, range requests (206), ETags, and conditional responses (304)
- **Directory listing** — HTML directory browsing with parent links and file sizes
- **Dashboard UI** — self-contained HTML interface for visual management
- **Optional persistence** — survive restarts via `registry.json` on disk
- **Path traversal protection** — resolved paths validated against registered folder roots
- **Zero dependencies** — single-process Bun app, no npm packages

## Quick Start

```bash
# Install dependencies (type definitions only)
bun install

# Start the server
bun run index.ts

# Or with persistence enabled
PERSIST=true bun run index.ts

# Custom port
PORT=3000 bun run index.ts
```

Server starts on `http://0.0.0.0:8080` by default.

## Usage

### Register a Folder

```bash
curl -X POST http://localhost:8080/ \
  -H 'Content-Type: application/json' \
  -d '{"folder_path": "/home/user/documents"}'
```

Response:

```json
{
  "status": "success",
  "message": "Folder 'documents-a3k9xZ' registered at '/home/user/documents'. Serving files now.",
  "data": {
    "slug": "documents-a3k9xZ",
    "path": "/home/user/documents",
    "url": "http://localhost:8080/documents-a3k9xZ",
    "subdomain_url": "http://documents-a3k9xZ.localhost:8080",
    "registered_at": "2025-01-15T10:30:00.000Z"
  },
  "hint": "Access files at http://localhost:8080/documents-a3k9xZ/filename.txt"
}
```

### List Registered Folders

```bash
curl http://localhost:8080/?format=json
```

### Access Files

```bash
# Path-based
curl http://localhost:8080/documents-a3k9xZ/readme.txt

# Subdomain-based
curl -H "Host: documents-a3k9xZ.localhost:8080" http://localhost:8080/readme.txt
```

### Update a Registration

```bash
# Change the folder path
curl -X PUT http://localhost:8080/ \
  -H 'Content-Type: application/json' \
  -d '{"slug": "documents-a3k9xZ", "folder_path": "/home/user/new-documents"}'

# Change the slug
curl -X PUT http://localhost:8080/ \
  -H 'Content-Type: application/json' \
  -d '{"folder_path": "/home/user/documents", "slug": "new-name"}'
```

### Unregister a Folder

```bash
# By slug
curl -X DELETE "http://localhost:8080/?slug=documents-a3k9xZ"

# By path
curl -X DELETE http://localhost:8080/ \
  -H 'Content-Type: application/json' \
  -d '{"folder_path": "/home/user/documents"}'
```

### Dashboard

Open `http://localhost:8080/` in your browser for a visual management interface.

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | List folders (JSON with `?format=json` or `Accept: application/json`, else HTML dashboard) |
| `POST` | `/` | Register a new folder |
| `PUT` | `/` | Update slug and/or path of an existing registration |
| `DELETE` | `/` | Unregister a folder (by slug or path) |
| `GET` | `/<slug>/<path>` | Serve a file or directory listing |

Full API specification with all request/response examples is in [SPEC.md](SPEC.md).

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Server port |
| `PERSIST` | `false` | Enable `registry.json` persistence (`true` / `false`) |

## Security

- **Path traversal protection** — all resolved paths are validated to stay within the registered folder root
- **No full path exposure** — file responses include only the basename of the folder path via `X-Folder-Path` header
- **Slug validation** — slugs must match `^[a-z0-9][a-z0-9_-]{0,63}$`
- **Absolute paths required** — `folder_path` must start with `/`

## Testing

```bash
bash test.sh
```

Runs a comprehensive curl-based test suite covering all CRUD operations, file serving, range requests, caching headers, directory listings, dashboard UI, and persistence.

## Project Structure

```
index.ts          — Server entry point (all logic)
dashboard.html    — Dashboard UI
test.sh           — Automated test suite
package.json      — Bun configuration
tsconfig.json     — TypeScript strict config
SPEC.md           — Full API specification
CONTEXT.md        — Glossary and architectural decisions
```

## License

MIT
