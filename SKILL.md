---
name: serve-web-app
description: Serve any local directory as a live HTTP URL so you can inspect or interact with web apps in a browser. Uses the local-http-fs-server HTTP API. Ideal for previewing builds, testing with Playwright, or debugging with Chrome DevTools.
---

# Serve Web App Skill

Serve any local directory as a live HTTP URL using the **local-http-fs-server**. This gives you an immediate, stable URL to open in a browser, inspect with DevTools, or drive with Playwright — without needing project-specific dev servers.

## When to Use

- You need to serve any folder over HTTP — web apps, assets, data files, whatever
- You built a web app (`dist/`, `build/`, `out/`) and need a live URL to test it
- You need to drive the app with Playwright or Chrome DevTools
- You're debugging a static site and want to serve it quickly
- You have multiple directories and want isolated URLs without port conflicts

## Prerequisites

The **local-http-fs-server** must already be running. It is **not** the agent's responsibility to start it.

1. **If the port is known** (from context or prior conversation) — use it directly
2. **If unknown** — assume `6868` (default). Verify with a quick check:

```bash
curl -s http://localhost:6868/ -H "Accept: application/json"
```

If it returns JSON with a `"status"` field, you're good. If it fails, ask the user: *"Is local-http-fs-server running, and on which port?"*

Set `BASE_URL` to `http://localhost:<port>` for all subsequent calls.

---

## API Quick Reference

All endpoints hit `<BASE_URL>/`. The HTTP method determines the action.

### 1. List Registered Folders

```bash
curl -s <BASE_URL>/ -H "Accept: application/json"
```

**Response:**
```json
{
  "status": "success",
  "data": {
    "count": 1,
    "folders": [
      {
        "slug": "my-app-a3k9xZ",
        "path": "/home/user/my-app/dist",
        "url": "http://localhost:6868/my-app-a3k9xZ",
        "registered_at": "2025-01-15T10:30:00.000Z"
      }
    ]
  }
}
```

### 2. Register a Folder

```bash
curl -s -X POST <BASE_URL>/ \
  -H "Content-Type: application/json" \
  -d '{"folder_path": "/home/user/my-app/dist"}'
```

| Field | Type | Description |
|-------|------|-------------|
| `folder_path` | string | Absolute path to an existing, readable directory |
| `slug` | string (optional) | Custom slug like `"my-app"`. Must match `^[a-z0-9][a-z0-9_-]{0,63}$`. Omit to auto-generate. |

**Success (201):** Extract `data.url` from the response — that's the base URL to open in a browser.

**Common errors:**

| Status | Cause | Fix |
|--------|-------|-----|
| 400 | `folder_path` missing or not absolute | Provide absolute path starting with `/` |
| 400 | Directory doesn't exist | Check the path exists and is readable |
| 409 | Same path already registered | Use the existing slug, or DELETE first |
| 409 | Custom slug already taken | Omit `slug` to auto-generate, or pick another |

### 3. Unregister a Folder

```bash
# By slug (query parameter)
curl -s -X DELETE "<BASE_URL>/?slug=my-app-a3k9xZ"

# By path (JSON body)
curl -s -X DELETE <BASE_URL>/ \
  -H "Content-Type: application/json" \
  -d '{"folder_path": "/home/user/my-app/dist"}'
```

Files on disk are untouched — only the HTTP serving stops.

### 4. Update a Registration

```bash
# Change the path (lookup by slug)
curl -s -X PUT <BASE_URL>/ \
  -H "Content-Type: application/json" \
  -d '{"slug": "my-app-a3k9xZ", "folder_path": "/home/user/my-app/dist-v2"}'

# Change the slug (lookup by path)
curl -s -X PUT <BASE_URL>/ \
  -H "Content-Type: application/json" \
  -d '{"slug": "new-name", "folder_path": "/home/user/my-app/dist"}'
```

Provide one identifier to locate the entry, and the other field as the new value.

---

## File Access

Once registered, files are served at `/<slug>/<relative-path>`:

```
/<slug>/              → directory listing (HTML)
/<slug>/index.html    → serve index.html
/<slug>/css/app.css   → serve CSS file
/<slug>/js/bundle.js  → serve JS bundle
```

The server auto-detects MIME types and supports:
- **ETag / 304** — efficient caching for browser reloads
- **Range requests (206)** — partial content for media
- **Directory listings** — HTML index with trailing `/`
- **Path traversal protection** — `../` escapes blocked with 403

---

## Workflows

### Preview a Build Output

```bash
curl -s -X POST <BASE_URL>/ \
  -H "Content-Type: application/json" \
  -d '{"folder_path": "/home/user/my-app/dist", "slug": "preview"}'
# → open <BASE_URL>/preview/index.html
```

### Test with Playwright

```typescript
// After registering via POST /
await page.goto("<BASE_URL>/my-app-a3k9xZ/index.html");
await page.click("button");
const text = await page.textContent("h1");
```

### Debug with Chrome DevTools

1. Register the folder: `POST /` with `{"folder_path": "/path/to/app"}`
2. Extract `data.url` from response
3. Navigate Chrome DevTools to `<data.url>/index.html`
4. Inspect elements, check console, debug network requests

### Multi-Project Setup

```bash
curl -s -X POST <BASE_URL>/ -H "Content-Type: application/json" \
  -d '{"folder_path": "/home/user/app-a/dist", "slug": "app-a"}'
curl -s -X POST <BASE_URL>/ -H "Content-Type: application/json" \
  -d '{"folder_path": "/home/user/app-b/dist", "slug": "app-b"}'
# → <BASE_URL>/app-a/  and  <BASE_URL>/app-b/
```

### Cleanup

```bash
curl -s -X DELETE "<BASE_URL>/?slug=app-a"
curl -s -X DELETE "<BASE_URL>/?slug=app-b"
```

---

## Tips

- **Always use absolute paths** — `folder_path` must start with `/`
- **Omit `slug`** for auto-generated unique identifiers (safest for scripts)
- **Provide `slug`** when you need a predictable URL (e.g., `"preview"`)
- **Check for 409** before registering — same path or slug may already be taken
- **Directory listings** require trailing slash: `/my-slug/` not `/my-slug`
- **Files serve with proper MIME types** — HTML, CSS, JS, images, fonts all work out of the box

## Troubleshooting

| Symptom | Check |
|---------|-------|
| `400: does not exist` | Verify the path exists and is a directory (`ls -la /path`) |
| `409: already registered` | List registrations (`GET /`) and use the existing slug |
| `404: slug not found` | Slug may have been unregistered; list and re-register |
| `403: access denied` | Path traversal detected — check URL doesn't escape the folder |
| Wrong MIME type | Check file extension; `Bun.file()` detects from extension |
| Blank page in browser | Open DevTools Network tab — check if assets (CSS/JS) loaded correctly relative to the HTML |
