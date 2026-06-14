# Project Specification: Local HTTP File Server

> Dynamic file server with runtime folder registration, slug-based routing, and subdomain access.  
> Built with Pure Bun native APIs — single process, zero external dependencies.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Design Principles](#2-design-principles)
3. [Architecture](#3-architecture)
4. [Data Model](#4-data-model)
5. [Slug Generation](#5-slug-generation)
6. [API Specification](#6-api-specification)
   - [Response Format](#response-format)
   - [GET /](#get-)
   - [POST /](#post-)
   - [DELETE /](#delete-)
   - [PUT /](#put-)
   - [File Serving Routes](#file-serving-routes)
7. [Security](#7-security)
8. [Subdomain Routing](#8-subdomain-routing)
9. [Implementation Phases](#9-implementation-phases)
10. [Non-Functional Requirements](#10-non-functional-requirements)
11. [Out of Scope (Future)](#11-out-of-scope-future)

---

## 1. Overview

A lightweight HTTP file server that allows clients (human or AI agent) to dynamically register local filesystem directories at runtime. Each registered folder receives a unique URL slug and becomes immediately accessible via path-based routes (`/slug`) and subdomain-based routes (`slug.<host>`). The server exposes a CRUD API for managing registrations, serves files with automatic MIME type detection, and provides a self-contained dashboard UI for visual management.

**Key characteristics:**
- Runtime addition/removal of served directories — no config files, no restarts
- Dual access patterns: `/slug` paths and `slug.localhost` subdomains
- Responses formatted for both human readability and LLM agent parsing
- Single-process Bun application with zero external dependencies
- Local HTTP only (no TLS in initial scope)

---

## 2. Design Principles

| Principle | Rationale |
|-----------|-----------|
| **Single process, zero deps** | Eliminate operational complexity. No Caddy, no Nginx, no npm packages beyond optional helpers. Kill one process, everything stops. |
| **Explicit over implicit** | Every response format, status code, and error message is deliberate. No framework magic between the request and the handler. |
| **LLM-agent first** | Responses include structured data fields (`status`, `message`, `data`, `hint`) that make programmatic consumption reliable for AI agents while remaining readable for humans. |
| **Breadth before polish** | Core CRUD + file serving shipped first. Range requests, caching headers, directory listing, and persistence follow as incremental improvements. |
| **Minimal surface area** | One entry point file (`index.ts`). Registry lives in memory. Dashboard is a single embedded HTML document. Easy to audit, easy to understand. |

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Bun Process                          │
│                                                          │
│  ┌──────────────┐    ┌──────────────────────────────┐   │
│  │  Registry     │    │  Bun.serve() fetch(req)      │   │
│  │              │    │                               │   │
│  │  Map<slug,   │◄──►│  1. Parse URL + Host header   │   │
│  │     Entry>   │    │  2. Match route               │   │
│  │              │    │  3. Dispatch handler           │   │
│  │ (in-memory)  │    │  4. Return Response            │   │
│  └──────────────┘    └──────────────────────────────┘   │
│                                                          │
│  Binds: 0.0.0.0:<port>                                   │
│  Default port: 8080 (configurable via CLI/env)          │
└─────────────────────────────────────────────────────────┘
```

### Request Flow

```
Client Request
    │
    ▼
Bun.serve() → fetch(req)
    │
    ├── Extract slug from path prefix or Host subdomain
    │
    ├── Check if request targets API (/) or file serving
    │
    ├── API Request (method = GET/POST/DELETE/PUT on /):
    │   ├── Route to CRUD handler based on method
    │   ├── Mutate Registry Map
    │   └── Return structured JSON response
    │
    └── File Serving Request:
        ├── Look up slug in Registry Map
        ├── Resolve relative file path within registered folder
        ├── Validate path stays within folder root (security)
        ├── Bun.file(resolvedPath)
        └── Return new Response(file) with auto MIME type
```

---

## 4. Data Model

### Registry Entry

Each registered folder is stored as an entry in an in-memory `Map<string, FolderEntry>`:

```typescript
interface FolderEntry {
  slug: string;           // URL-safe unique identifier (e.g., "documents-a3k9xZ")
  path: string;           // Absolute filesystem path to the registered folder
  createdAt: Date;        // Registration timestamp
  updatedAt: Date;        // Last modification timestamp (slug or path changes)
}
```

### Registry State

```typescript
// Primary data structure — key is the slug
const registry: Map<string, FolderEntry> = new Map();
```

**Lifecycle:** Entries are created via `POST /`, removed via `DELETE /`, updated via `PUT /`. The Map is queried by both slug (key lookup) and path (linear scan for DELETE/PUT operations that target by path).

**Persistence:** None in Phase 1 (in-memory only). Phase 6 adds optional file-backed persistence (`registry.json`).

---

## 5. Slug Generation

### Strategy

Slugs combine a human-readable component derived from the folder name with a cryptographically random suffix to ensure uniqueness:

```
<readable_folder_name>-<random_suffix>

Examples:
  "My Documents"      → "my-documents-a3k9xZ"
  "/tmp/report v2"    → "report-v2-k7bMnL"
  "/data"             → "data-mQp3rT"
```

### Components

| Component | Library | Parameters | Output |
|-----------|---------|------------|--------|
| Readable part | `slugify` | `lower: true`, `strict: true` | ASCII lowercase, hyphens as separators |
| Random suffix | `nanoid` | Length: 8 characters | URL-safe alphanumeric string (~2^48 entropy) |

### User-Provided Slugs

POST request may optionally include a custom slug:
```json
{
  "folder_path": "/path/to/folder",
  "slug": "my-custom-name"
}
```

If provided, validation ensures:
- Only lowercase letters, digits, hyphens, underscores allowed
- Not already taken (collision check against existing Map keys)
- Not empty or excessively long (>64 characters)

If invalid or omitted, auto-generation is used.

### Edge Cases

| Case | Behavior |
|------|----------|
| Two folders with identical base names | Different nanoid suffixes guarantee unique slugs |
| User provides duplicate slug | Return `409 Conflict` with message explaining the collision |
| Folder name contains unicode/special chars | `slugify` normalizes to ASCII (e.g., "résumé" → "resume") |
| Folder path points to root (`/`) | Base name resolves to `"root"` for slug generation |

---

## 6. API Specification

All endpoints operate on the root path `/`. The HTTP method determines the action. File serving operates on paths beneath `/` that match registered slugs.

### Response Format

Every API response follows a consistent JSON structure optimized for both human reading and LLM agent parsing:

**Success responses:**
```json
{
  "status": "success",
  "message": "Human-readable description of what happened",
  "data": {
    /* contextual data — varies by operation */
  },
  "hint": "Optional suggestion for next action or related information"
}
```

**Error responses:**
```json
{
  "status": "error",
  "message": "Human-readable explanation of what went wrong",
  "details": {
    /* optional structured error details */
  },
  "hint": "Optional suggestion for how to fix the issue"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `status` | Yes | `"success"` or `"error"` |
| `message` | Yes | Clear, actionable human-readable text. Also serves as primary parse target for LLM agents. |
| `data` | Success only | Operation-specific data (created entries, updated values, listings) |
| `details` | Error only | Structured error context (validation errors, constraint violations) |
| `hint` | Optional | Actionable guidance — e.g., next API call to make, common fix, or example URL |

---

### GET /

List all registered folders. Behavior depends on `Accept` header.

#### Dashboard Response

- **Method:** `GET`
- **Path:** `/`
- **Content-Type in request:** `Accept: text/html` (or no Accept header — HTML is default when accessed from browser)
- **Status code:** `200 OK`
- **Response body:** Dashboard HTML page showing all registered folders with actions to add/delete/update.

#### JSON Listing

- **Method:** `GET`
- **Path:** `/`
- **Content-Type in request:** `Accept: application/json`
- **Status code:** `200 OK`

**Response:**
```json
{
  "status": "success",
  "message": "List of registered folders. POST to add, DELETE/PUT to manage.",
  "data": {
    "count": 3,
    "folders": [
      {
        "slug": "documents-a3k9xZ",
        "path": "/home/user/documents",
        "url": "http://localhost:8080/documents-a3k9xZ",
        "subdomain_url": "http://documents-a3k9xZ.localhost:8080",
        "registered_at": "2025-01-15T10:30:00.000Z"
      },
      {
        "slug": "images-k7bMnL",
        "path": "/mnt/photos",
        "url": "http://localhost:8080/images-k7bMnL",
        "subdomain_url": "http://images-k7bMnL.localhost:8080",
        "registered_at": "2025-01-15T11:00:00.000Z"
      }
    ]
  },
  "hint": "To register a new folder, POST with { \"folder_path\": \"/path/to/folder\" }"
}
```

**Empty registry:**
```json
{
  "status": "success",
  "message": "No folders registered yet. POST with { \"folder_path\": \"/path/to/folder\" } to add one.",
  "data": {
    "count": 0,
    "folders": []
  },
  "hint": "Register your first folder to start serving files."
}
```

---

### POST /

Register a new folder for serving.

- **Method:** `POST`
- **Path:** `/`
- **Request Content-Type:** `application/json`
- **Request body:**
```json
{
  "folder_path": "/path/to/folder",
  "slug": "optional-custom-name"
}
```

#### Field Validation

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `folder_path` | string | Yes | Must be non-empty, must be an absolute path, directory must exist on filesystem, directory must be readable |
| `slug` | string | No | If provided: lowercase alphanumeric + hyphens/underscores only, max 64 chars, not already in use |

#### Success Response

- **Status code:** `201 Created`

**Response:**
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
  "hint": "Access files at http://localhost:8080/documents-a3k9xZ/filename.txt or use curl -H \"Host: documents-a3k9xZ.localhost:8080\" http://localhost:8080/filename.txt"
}
```

#### Error Responses

**Missing folder_path:**
- **Status code:** `400 Bad Request`
```json
{
  "status": "error",
  "message": "Missing required field 'folder_path'. Provide an absolute path to a directory.",
  "details": {
    "field": "folder_path",
    "received": null,
    "expected": "string (absolute path to an existing directory)"
  },
  "hint": "Example: POST with { \"folder_path\": \"/home/user/documents\" }"
}
```

**Directory does not exist:**
- **Status code:** `400 Bad Request`
```json
{
  "status": "error",
  "message": "Directory '/nonexistent/path' does not exist or is not accessible.",
  "details": {
    "folder_path": "/nonexistent/path",
    "reason": "ENOENT"
  },
  "hint": "Check that the path exists and is a readable directory."
}
```

**Slug already taken:**
- **Status code:** `409 Conflict`
```json
{
  "status": "error",
  "message": "Slug 'documents-a3k9xZ' is already in use by '/home/user/old-documents'.",
  "details": {
    "slug": "documents-a3k9xZ",
    "existing_path": "/home/user/old-documents"
  },
  "hint": "Provide a different slug or omit it to auto-generate a unique one."
}
```

**Duplicate registration (same path):**
- **Status code:** `409 Conflict`
```json
{
  "status": "error",
  "message": "Folder '/home/user/documents' is already registered with slug 'documents-a3k9xZ'.",
  "details": {
    "folder_path": "/home/user/documents",
    "existing_slug": "documents-a3k9xZ"
  },
  "hint": "Use PUT to update the existing registration, or DELETE it first and re-register."
}
```

---

### DELETE /

Unregister a previously registered folder.

- **Method:** `DELETE`
- **Path:** `/`
- **Identification:** Via query parameter or JSON body:
  - Query string: `/?slug=my-slug` or `/?folder_path=/path/to/folder`
  - JSON body: `{ "slug": "my-slug" }` or `{ "folder_path": "/path/to/folder" }`

#### Success Response

- **Status code:** `200 OK`

**Response:**
```json
{
  "status": "success",
  "message": "Folder 'documents-a3k9xZ' unregistered. Files are no longer accessible.",
  "data": {
    "slug": "documents-a3k9xZ",
    "path": "/home/user/documents",
    "was_registered_at": "2025-01-15T10:30:00.000Z"
  },
  "hint": "Folder contents were not deleted from disk — only the serving registration was removed."
}
```

#### Error Responses

**Not found (no matching slug or path):**
- **Status code:** `404 Not Found`
```json
{
  "status": "error",
  "message": "No registration found with slug 'unknown-slug' or path '/some/path'.",
  "details": {
    "slug": "unknown-slug",
    "folder_path": "/some/path"
  },
  "hint": "Use GET / to list all registered folders and their slugs."
}
```

**Missing identification:**
- **Status code:** `400 Bad Request`
```json
{
  "status": "error",
  "message": "DELETE requires identification. Provide a 'slug' or 'folder_path' as query parameter or in JSON body.",
  "hint": "Example: DELETE /?slug=my-slug or DELETE / with { \"slug\": \"my-slug\" }"
}
```

---

### PUT /

Update an existing folder registration — either the path, the slug, or both.

- **Method:** `PUT`
- **Path:** `/`
- **Request Content-Type:** `application/json`
- **Request body (update path by slug):**
```json
{
  "slug": "documents-a3k9xZ",
  "folder_path": "/home/user/new-documents"
}
```
- **Request body (update slug by path):**
```json
{
  "folder_path": "/home/user/documents",
  "slug": "new-name"
}
```

At least one identifier (`slug` OR `folder_path`) must be provided to locate the entry. At least one update field (the other of `slug`/`folder_path`) must be provided to change.

#### Field Validation

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `slug` | string | One of slug/folder_path required for lookup; optional for update | If used as new value: same rules as POST (format, not taken) |
| `folder_path` | string | One of slug/folder_path required for lookup; optional for update | If used as new value: must exist, must be readable directory |

#### Success Response

- **Status code:** `200 OK`

**Response:**
```json
{
  "status": "success",
  "message": "Folder registration updated. Slug changed from 'documents-a3k9xZ' to 'new-name'.",
  "data": {
    "slug": "new-name",
    "path": "/home/user/documents",
    "url": "http://localhost:8080/new-name",
    "subdomain_url": "http://new-name.localhost:8080",
    "changes": {
      "slug": {
        "from": "documents-a3k9xZ",
        "to": "new-name"
      }
    },
    "updated_at": "2025-01-15T12:00:00.000Z"
  },
  "hint": "Files are now accessible at the new URL. The old URL returns 404."
}
```

**Response for path change:**
```json
{
  "status": "success",
  "message": "Folder registration updated. Path changed from '/home/user/documents' to '/home/user/new-documents'.",
  "data": {
    "slug": "documents-a3k9xZ",
    "path": "/home/user/new-documents",
    "url": "http://localhost:8080/documents-a3k9xZ",
    "subdomain_url": "http://documents-a3k9xZ.localhost:8080",
    "changes": {
      "path": {
        "from": "/home/user/documents",
        "to": "/home/user/new-documents"
      }
    },
    "updated_at": "2025-01-15T12:00:00.000Z"
  },
  "hint": "The folder now serves files from the new path at the same URL."
}
```

#### Error Responses

**Entry not found:**
- **Status code:** `404 Not Found`
```json
{
  "status": "error",
  "message": "No registration found with slug 'unknown-slug' or path '/some/path'.",
  "details": {
    "slug": "unknown-slug",
    "folder_path": "/some/path"
  },
  "hint": "Use GET / to list all registered folders and their slugs."
}
```

**New path invalid:**
- **Status code:** `400 Bad Request`
```json
{
  "status": "error",
  "message": "New directory '/nonexistent/path' does not exist or is not accessible.",
  "details": {
    "field": "folder_path",
    "value": "/nonexistent/path"
  },
  "hint": "Provide a valid absolute path to an existing, readable directory."
}
```

**New slug already taken:**
- **Status code:** `409 Conflict`
```json
{
  "status": "error",
  "message": "Slug 'other-slug' is already in use by another registration.",
  "details": {
    "slug": "other-slug",
    "existing_path": "/home/user/other-folder"
  },
  "hint": "Choose a different slug or omit it to keep the current one."
}
```

**No changes specified:**
- **Status code:** `400 Bad Request`
```json
{
  "status": "error",
  "message": "PUT requires at least one update field. Provide a new 'slug' or 'folder_path' to change.",
  "hint": "Example: PUT with { \"slug\": \"current-slug\", \"folder_path\": \"/new/path\" } to update the path."
}
```

---

### File Serving Routes

Files from registered folders are served via two access patterns. Both resolve through the same internal logic.

#### Path-Based Access

- **Pattern:** `GET /<slug>/<file-path>`
- **Example:** `http://localhost:8080/documents-a3k9xZ/readme.txt`
- **Resolves to:** `/home/user/documents/readme.txt` (using the registered path)

#### Subdomain-Based Access

- **Pattern:** `GET http://<slug>.<host>:<port>/<file-path>`
- **Example:** `http://documents-a3k9xZ.localhost:8080/readme.txt`
- **Resolution:** Host header parsed for subdomain prefix, matched against registry Map
- **Curl syntax:** `curl -H "Host: documents-a3k9xZ.localhost:8080" http://localhost:8080/readme.txt`

#### Successful File Response

- **Status code:** `200 OK`
- **Content-Type:** Auto-detected by `Bun.file().type` (MIME type based on file extension)
- **Body:** File contents, streamed

**Headers included in response:**
| Header | Value |
|--------|-------|
| `Content-Type` | MIME type from `BunFile.type` |
| `Content-Length` | File size in bytes |
| `X-Slug` | Slug of the folder this file belongs to |
| `X-Folder-Path` | Original registered path (truncated to directory name only — no full path exposure) |

#### Error Responses

**Slug not found:**
- **Status code:** `404 Not Found`
```json
{
  "status": "error",
  "message": "Slug 'unknown' not found. Use GET / to list registered folders.",
  "hint": "Register a folder with POST / to create a new slug."
}
```

**File not found within registered folder:**
- **Status code:** `404 Not Found`
```json
{
  "status": "error",
  "message": "File '/readme.txt' not found in folder 'documents-a3k9xZ'.",
  "details": {
    "slug": "documents-a3k9xZ",
    "requested_path": "/readme.txt",
    "folder_path_display": ".../user/documents"
  },
  "hint": "Check the filename and path within the folder. Use trailing slash (e.g., /documents-a3k9xZ/) for directory listing."
}
```

**Directory access (trailing slash):**
- **Status code:** `200 OK` (directory listing) or `301 Moved Permanently` (redirect to trailing slash)
- **Behavior:** When URL ends with `/` or points to a directory, return an HTML listing of contents (see Phase 4). If URL does not end with `/` but target is a directory, redirect to add trailing slash.

---

## 7. Security

### Path Traversal Protection

**Critical requirement.** All file path resolutions must validate that the resolved path stays within the registered folder root:

```
Requested: /documents-a3k9xZ/../etc/passwd
Slug maps to: /home/user/documents
Resolved path: /home/user/etc/passwd
✓ Valid: starts with /home/user/documents → SERVE
✗ Invalid: does not start with /home/user/documents → BLOCK
```

Implementation approach:
1. Resolve both registered folder path and requested file path to absolute paths using `path.resolve()`
2. Verify `resolvedFilepath.startsWith(resolvedFolderRoot + "/")` or `resolvedFilepath === resolvedFolderRoot`
3. Reject any request where the check fails with `403 Forbidden`

**Symlink handling:** By default, follow symlinks within the registered folder (standard `Bun.file()` behavior). The traversal check operates on the *target* of any symlink, so escaping via symlinks is also blocked by the prefix check.

### No Filesystem Information Leakage

- Full absolute paths are **not** exposed in file-serving responses (only displayed in API CRUD responses where the client explicitly registered them)
- Error messages include truncated paths (last 2-3 path segments) instead of full absolute paths
- Directory listings show relative paths within the slug's folder only

### Request Validation

| Input | Validation |
|-------|-----------|
| `folder_path` in POST/PUT | Must be absolute path (`/` prefix on Unix), must exist as directory, must be readable |
| `slug` in POST/PUT | Regex: `^[a-z0-9][a-z0-9_-]{0,63}$` — starts with alphanumeric, allows lowercase letters, digits, hyphens, underscores |
| DELETE identification | Must provide exactly one identifier (`slug` OR `folder_path`), both valid |
| JSON bodies | Parse failure returns `400 Bad Request` with clear message |

---

## 8. Subdomain Routing

### Implementation Approach

**Host header parsing** — no DNS configuration required. The server binds to `0.0.0.0:<port>` and inspects the `Host` request header for subdomain extraction.

### Extraction Logic

```
Host header value → hostname extraction → subdomain split
"http://documents-a3k9xZ.localhost:8080/file.txt"
         ↓
hostname = "documents-a3k9xZ.localhost"
         ↓
split on "." → ["documents-a3k9xZ", "localhost"]
         ↓
subdomain = parts[0] if parts.length > 1 else null
```

### Matching Rules

| Host Header | Extracted Subdomain | Behavior |
|-------------|-------------------|----------|
| `documents-a3k9xZ.localhost` | `documents-a3k9xZ` | Lookup in registry, serve files from that folder |
| `localhost` | `null` | Normal path-based routing (check `/` path prefix) |
| `unknown.localhost` | `unknown` | Slug not found → 404 with LLM-friendly error |
| `a.b.c.localhost` | `a` | Only first segment treated as subdomain; rest ignored |
| `127.0.0.1:8080` | `null` | IP-only access — path-based routing only |

### Access Patterns

The dashboard displays both access methods for each registered folder:

| Pattern | URL Example | Notes |
|---------|------------|-------|
| Path-based | `http://localhost:8080/my-slug/file.txt` | Works everywhere — browsers, curl, AI agents |
| Subdomain (curl) | `curl -H "Host: my-slug.localhost:8080" http://localhost:8080/file.txt` | Requires manual Host header in curl |
| Subdomain (browser) | `http://my-slug.localhost:8080/file.txt` | Requires `/etc/hosts` entry or wildcard DNS — shown with note that it may not resolve |

---

## 9. Implementation Phases

### Phase 1 — Core CRUD API

**Goal:** Registry Map + full CRUD at `GET/POST/DELETE/PUT /` with LLM-friendly JSON responses.

**Deliverables:**
- `index.ts` entry point with `Bun.serve()` configuration
- `Map<string, FolderEntry>` registry
- GET / — JSON listing of all folders (empty state included)
- POST / — Register folder with auto-generated slug, full validation
- DELETE / — Unregister by slug or path
- PUT / — Update slug and/or path
- Consistent response format across all operations
- Console logging of requests

**Acceptance criteria:**
- All 4 HTTP methods on `/` return correct status codes
- Validation errors produce structured error JSON
- Slug generation produces unique, URL-safe identifiers
- Duplicate registrations rejected with 409
- Non-existent directories rejected with 400
- GET returns empty list when no folders registered
- All messages readable by humans AND parseable by LLM agents

**Estimated size:** ~150 lines TypeScript

---

### Phase 2 — File Serving

**Goal:** Serve files from registered folders via path-based and subdomain-based access.

**Deliverables:**
- Slug extraction from request path (`/<slug>/*`) or Host header subdomain
- `Bun.file()` integration for file serving with automatic MIME types
- Path traversal protection (validated path resolution)
- 404 responses for unknown slugs and missing files
- Directory redirect (no trailing slash → redirect to trailing slash)
- Response headers: `Content-Type`, `Content-Length`, `X-Slug`

**Acceptance criteria:**
- `GET /my-slug/file.txt` serves file from registered folder
- `curl -H "Host: my-slug.localhost:8080" http://localhost:8080/file.txt` serves same file
- Path traversal attempts (`/../etc/passwd`) blocked with 403
- Unknown slug returns structured 404 JSON
- Missing file within valid slug returns structured 404 JSON
- Files served with correct Content-Type
- Directory URLs without trailing slash redirect to add trailing slash

**Estimated size:** ~80 lines TypeScript

---

### Phase 3 — Range Requests + Caching

**Goal:** Support HTTP partial content and conditional requests for better client experience.

**Deliverables:**
- `Range` header parsing → 206 Partial Content responses with correct `Content-Range` header
- ETag generation from file size + modification time
- `If-None-Match` / `If-Modified-Since` support → 304 Not Modified responses
- `Cache-Control` headers on file responses (configurable max-age)

**Acceptance criteria:**
- Video/audio files playable in browser with seeking
- Browser sends If-None-Match on repeat visits; server returns 304 for unchanged files
- Content-Range header correctly formatted for partial responses
- Multiple byte ranges supported (at minimum, single range)

**Estimated size:** ~50 lines TypeScript (range request helper)

---

### Phase 4 — Directory Listing

**Goal:** Auto-generated HTML directory listing when accessing a slug root or subdirectory.

**Deliverables:**
- When URL points to directory (trailing `/` or detected dir):
  - Read directory entries with `fs.readdir`
  - Sort: directories first, then files, alphabetical within each group
  - Render minimal HTML with links to subdirectories and files
  - Show "parent directory" link when inside nested directories
  - Display file sizes
- When URL is ambiguous (could be file or directory): resolve stat and handle accordingly

**Acceptance criteria:**
- `GET /my-slug/` returns HTML directory listing
- Subdirectories shown with `/` suffix and clickable link
- Files shown with size and clickable link
- Parent directory link appears for nested paths
- File icons or type indicators (optional — keep minimal)

**Estimated size:** ~60 lines TypeScript + inline HTML template string

---

### Phase 5 — Dashboard UI

**Goal:** Self-contained HTML dashboard at `GET /` for visual management of registrations.

**Deliverables:**
- Single HTML file (`dashboard.html`) served when `Accept: text/html` on `GET /`
- Displays current folder list with slugs, paths, registration dates
- Form to add new folder (POST)
- Button to delete folder (DELETE) per entry
- Modal/form to update slug or path (PUT)
- Real-time updates after each operation (fetch JSON API, re-render list)
- Minimal styling — functional over beautiful

**UI layout:**
```
┌─────────────────────────────────────────────────┐
│  Local HTTP File Server                         │
├─────────────────────────────────────────────────┤
│  [+ Register Folder]                            │
│                                                 │
│  ┌─────────────┬──────────┬──────────┬────────┐ │
│  │ Slug        │ Path     │ Added    │ Action │ │
│  ├─────────────┼──────────┼──────────┼────────┤ │
│  │ docs-a3k9xZ │ ...docs  │ Jan 15   │ ✎ 🗑   │ │
│  │ imgs-k7bMnL │ ...imgs  │ Jan 15   │ ✎ 🗑   │ │
│  └─────────────┴──────────┴──────────┴────────┘ │
│                                                 │
│  Access files:                                  │
│    http://localhost:8080/docs-a3k9xZ/file.txt   │
│    curl -H "Host: docs-a3k9xZ.localhost:8080" .. │
└─────────────────────────────────────────────────┘
```

**Acceptance criteria:**
- Dashboard accessible at `http://localhost:8080/` from browser
- All 4 CRUD operations executable from UI
- List refreshes after each operation
- Error messages from API displayed in UI
- Access URLs shown per folder (both path and subdomain patterns)

**Estimated size:** ~200 lines HTML + inline JavaScript (fetched via fetch() to own JSON API)

---

### Phase 6 — Optional Persistence

**Goal:** Survive process restarts by persisting registry to disk.

**Deliverables:**
- On startup: check for `registry.json` in project root, load into Map if exists
- On every mutation (POST/PUT/DELETE): write updated Map to `registry.json`
- File format: JSON array of `{ slug, path, createdAt, updatedAt }`
- Configurable via CLI flag or env var (`--persist` / `PERSIST=true`)
- Default: disabled (in-memory only)

**Acceptance criteria:**
- Registry survives `Ctrl+C` and `bun run index.ts`
- Invalid/corrupted `registry.json` handled gracefully (skip load, start fresh)
- Concurrent writes not an issue (single-process guarantee)

**Estimated size:** ~30 lines TypeScript

---

## 10. Non-Functional Requirements

| Requirement | Target | Notes |
|-------------|--------|-------|
| Startup time | < 500ms | Bun cold start is fast; no framework loading overhead |
| Memory footprint | < 50MB typical | In-memory Map + single-process Bun runtime |
| Request latency | < 10ms for API calls | No database, no network I/O for CRUD operations |
| File serving throughput | Limited by disk I/O | uWebSockets layer adds negligible overhead |
| Maximum registrations | Unlimited (practical limit: RAM for Map entries) | 1000+ slugs with no performance impact expected |
| Concurrency | Single-process event loop | Handles hundreds of concurrent connections via async I/O |
| Port configuration | CLI flag (`--port`) or env var (`PORT`), default 8080 | Standard convention |
| Node.js compatibility | **Not applicable** — Bun-native APIs only | Not compatible with Node.js runtime |

---

## 11. Out of Scope (Future)

Features that are explicitly deferred. They may be revisited after core functionality is complete:

| Feature | Complexity | Notes |
|---------|-----------|-------|
| TLS/HTTPS support | Low | Bun supports `tls: { certName }` in serve options — trivial to wire up |
| Authentication/API keys | Medium | Basic auth header or token-based access control |
| Webhook notifications | Low | HTTP POST to configured URL on registration changes |
| Watch mode (auto-reflect filesystem changes) | Medium | `fs.watch` on registered folders for real-time awareness |
| Multi-instance / clustering | High | `Bun.spawn` worker processes or move behind reverse proxy |
| Automatic `/etc/hosts` management | Low-Medium | `child_process.exec` to add/remove DNS entries; requires root |
| Caddy/Nginx reverse proxy integration | Medium | For production deployment with automatic HTTPS and compression |
| SQLite persistence backend | Low | Replace JSON file with `Bun.sql()` for queryable history |
| File upload support | Medium | Accept PUT to file paths within registered folders |
| Access logs (file-based) | Low | Write request log to `access.log` in Common Log Format |
| Rate limiting | Low | Per-IP request throttling for API endpoints |
| WebSocket live updates for dashboard | Low | Push registry changes to connected dashboard instances |
