# Local HTTP File Server

A lightweight HTTP file server built with [Bun](https://bun.sh) that dynamically registers local directories at runtime. Each folder receives a unique URL slug and becomes accessible via path-based routes and subdomain-based access.

> **Entirely LLM-generated** — every line of code in this project was written by [Qwen3.6-27B](https://qwen.ai). No human-written source code.

## Features

- **Runtime folder registration** — add, remove, and update served directories without restarting
- **Slug-based routing** — automatic URL-safe slugs (`/documents-a3k9xZ/`) or custom slugs
- **Subdomain access** — serve via `slug.localhost` in addition to path-based URLs
- **CRUD API** — full JSON API for managing folder registrations (`GET`, `POST`, `PUT`, `DELETE`)
- **File serving** — automatic MIME detection, range requests (206), ETags, and conditional responses (304)
- **Directory listing** — HTML directory browsing with parent links and file sizes
- **Dashboard UI** — self-contained HTML interface for visual management
- **MCP stdio server** — `--mcp stdio` mode for AI agent integration via Model Context Protocol
- **Optional persistence** — survive restarts via `registry.json` on disk
- **Path traversal protection** — resolved paths validated against registered folder roots
- **Minimal dependencies** — only `@modelcontextprotocol/sdk` and `zod`

## Quick Start

```bash
# Install dependencies (type definitions only)
bun install

# Start the server
bun run src/index.ts

# Or with persistence enabled
PERSIST=true bun run src/index.ts

# Custom port
PORT=3000 bun run src/index.ts

# MCP stdio mode (for AI agents)
bun run src/index.ts --mcp stdio
```

Server starts on `http://0.0.0.0:6868` by default.

## Usage

### Register a Folder

```bash
curl -X POST http://localhost:6868/ \
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
    "url": "http://localhost:6868/documents-a3k9xZ",
    "subdomain_url": "http://documents-a3k9xZ.localhost:6868",
    "registered_at": "2025-01-15T10:30:00.000Z"
  },
  "hint": "Access files at http://localhost:6868/documents-a3k9xZ/filename.txt"
}
```

### List Registered Folders

```bash
curl http://localhost:6868/?format=json
```

### Access Files

```bash
# Path-based
curl http://localhost:6868/documents-a3k9xZ/readme.txt

# Subdomain-based
curl -H "Host: documents-a3k9xZ.localhost:6868" http://localhost:6868/readme.txt
```

### Update a Registration

```bash
# Change the folder path
curl -X PUT http://localhost:6868/ \
  -H 'Content-Type: application/json' \
  -d '{"slug": "documents-a3k9xZ", "folder_path": "/home/user/new-documents"}'

# Change the slug
curl -X PUT http://localhost:6868/ \
  -H 'Content-Type: application/json' \
  -d '{"folder_path": "/home/user/documents", "slug": "new-name"}'
```

### Unregister a Folder

```bash
# By slug
curl -X DELETE "http://localhost:6868/?slug=documents-a3k9xZ"

# By path
curl -X DELETE http://localhost:6868/ \
  -H 'Content-Type: application/json' \
  -d '{"folder_path": "/home/user/documents"}'
```

### Dashboard

Open `http://localhost:6868/` in your browser for a visual management interface.

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

| Option | Default | Description |
|--------|---------|-------------|
| `PORT` env or `--port <n>` | `6868` | Server port |
| `PERSIST` env or `--persist` | `false` | Enable `registry.json` persistence |
| `--mcp stdio` | off | Start MCP stdio server alongside HTTP |

## Security

- **Path traversal protection** — all resolved paths are validated to stay within the registered folder root
- **No full path exposure** — file responses include only the basename of the folder path via `X-Folder-Path` header
- **Slug validation** — slugs must match `^[a-z0-9][a-z0-9_-]{0,63}$`
- **Absolute paths required** — `folder_path` must start with `/`

## Testing

```bash
bun test
```

Runs the test suite covering CRUD API, file serving, persistence, and MCP integration.

## Project Structure

```
src/
  index.ts        — Entry point: start HTTP, conditionally start MCP, wire signals
  cli.ts          — CLI config and logging
  registry.ts     — In-memory registry Map and persistence
  slug.ts         — Slug generation and validation
  handlers.ts     — CRUD business logic (returns CrudResult)
  http.ts         — Bun.serve fetch handler, routing, file serving
  mcp.ts          — MCP tool definitions and server setup
  utils.ts        — Helpers: ok/err responses, path safety, ETag, range parsing
dashboard.html    — Self-contained HTML dashboard
tests/            — bun:test suite (CRUD, file serving, persistence, MCP)
package.json      — Bun configuration
tsconfig.json     — TypeScript strict config
SPEC.md           — Full API specification
CONTEXT.md        — Glossary and architectural decisions
```

## Acknowledgments

This project would not exist without:

- **[Bun](https://bun.sh)** — the runtime that makes this zero-overhead single-process server possible
- **[Qwen](https://qwen.ai)** — the Qwen3.6-27B model that wrote every line of code
- **[llama.cpp](https://github.com/ggerganov/llama.cpp)** — the inference engine that powers local LLM execution
- **[llama-swap](https://github.com/mostlygeek/llama-swap)** — the memory management tool that makes running large models feasible on consumer hardware
- **[pi coding agent](https://github.com/earendil-works/pi-coding-agent)** — the AI coding agent that orchestrated the entire project

## License

MIT
