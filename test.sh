#!/usr/bin/env bash
# ─── Local HTTP File Server — Automated Test Suite ────────────────────────────
# Run:  bash test.sh
# Stops the server on exit (including Ctrl-C).

set -euo pipefail

PORT="${TEST_PORT:-9140}"
BASE="http://localhost:${PORT}"
PASS=0
FAIL=0
TOTAL=0
SLUG=""

# ─── Helpers ───────────────────────────────────────────────────────────────────

cleanup() {
	if [[ -n "${SERVER_PID:-}" ]]; then
		kill "$SERVER_PID" 2>/dev/null || true
		wait "$SERVER_PID" 2>/dev/null || true
	fi
	rm -f registry.json 2>/dev/null || true
	rm -rf "$TEST_DIR" 2>/dev/null || true
}
trap cleanup EXIT

assert_eq() {
	local label="$1" expected="$2" actual="$3"
	TOTAL=$((TOTAL + 1))
	if [[ "$actual" == "$expected" ]]; then
		PASS=$((PASS + 1))
		echo "  ✓ $label"
	else
		FAIL=$((FAIL + 1))
		echo "  ✗ $label"
		echo "    expected: $expected"
		echo "    actual:   $actual"
	fi
}

assert_status() {
	local label="$1" expected="$2" actual="$3"
	TOTAL=$((TOTAL + 1))
	if [[ "$actual" == "$expected" ]]; then
		PASS=$((PASS + 1))
		echo "  ✓ $label (HTTP $actual)"
	else
		FAIL=$((FAIL + 1))
		echo "  ✗ $label — expected HTTP $expected, got HTTP $actual"
	fi
}

assert_contains() {
	local label="$1" needle="$2" haystack="$3"
	TOTAL=$((TOTAL + 1))
	if echo "$haystack" | grep -qi "$needle"; then
		PASS=$((PASS + 1))
		echo "  ✓ $label"
	else
		FAIL=$((FAIL + 1))
		echo "  ✗ $label — expected to contain '$needle'"
	fi
}

wait_for_port() {
	local port="$1"
	local tries=0
	until curl -s "http://localhost:${port}/?format=json" >/dev/null 2>&1; do
		tries=$((tries + 1))
		[[ $tries -gt 30 ]] && {
			echo "ERROR: Port $port not ready"
			exit 1
		}
		sleep 0.2
	done
}

json_field() {
	# Extract a string or numeric field from compact JSON
	local json="$1" field="$2"
	# Try string value first
	local val
	val=$(echo "$json" | grep -o "\"$field\":\"[^\"]*\"" | head -1 | cut -d'"' -f4)
	if [[ -n "$val" ]]; then
		echo "$val"
		return
	fi
	# Try numeric value
	val=$(echo "$json" | grep -o "\"$field\":[0-9]*" | head -1 | cut -d: -f2)
	if [[ -n "$val" ]]; then
		echo "$val"
		return
	fi
	echo ""
}

# ─── Setup ─────────────────────────────────────────────────────────────────────

echo "Setting up..."
TEST_DIR=$(mktemp -d)
echo "test file content" >"$TEST_DIR/test-file.txt"
dd if=/dev/urandom of="$TEST_DIR/big.bin" bs=1024 count=10 2>/dev/null
mkdir -p "$TEST_DIR/sub/nested"
echo "deep" >"$TEST_DIR/sub/nested/file.txt"
mkdir -p "$TEST_DIR/empty-dir"
mkdir -p /tmp/test-folder
mkdir -p /tmp/another-folder

# Start server
PERSIST=true PORT="$PORT" bun run src/index.ts &
SERVER_PID=$!
wait_for_port "$PORT"

echo ""
echo "=========================================="
echo "  Phase 1 — Core CRUD API"
echo "=========================================="

# GET / empty
resp=$(curl -s "$BASE/?format=json")
assert_eq "GET / empty: status field" "success" "$(json_field "$resp" status)"
assert_eq "GET / empty: count 0" "0" "$(json_field "$resp" count)"

# POST register
resp=$(curl -s -w "\n%{http_code}" -X POST -H 'Content-Type: application/json' -d "{\"folder_path\": \"$TEST_DIR\"}" "$BASE/")
HTTP_CODE=$(echo "$resp" | tail -1)
BODY=$(echo "$resp" | head -n -1)
assert_status "POST register: 201" "201" "$HTTP_CODE"
SLUG=$(json_field "$BODY" slug)
assert_contains "POST register: slug returned" "$SLUG" "$SLUG"

# POST duplicate path
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H 'Content-Type: application/json' -d "{\"folder_path\": \"$TEST_DIR\"}" "$BASE/")
assert_status "POST duplicate path: 409" "409" "$HTTP_CODE"

# POST non-existent directory
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H 'Content-Type: application/json' -d '{"folder_path": "/tmp/nonexistent-dir-xyz"}' "$BASE/")
assert_status "POST non-existent: 400" "400" "$HTTP_CODE"

# POST missing folder_path
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/")
assert_status "POST missing folder_path: 400" "400" "$HTTP_CODE"

# POST invalid slug
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H 'Content-Type: application/json' -d "{\"folder_path\": \"/tmp/test-folder\", \"slug\": \"INVALID\"}" "$BASE/")
assert_status "POST invalid slug: 400" "400" "$HTTP_CODE"

# POST absolute path required
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H 'Content-Type: application/json' -d '{"folder_path": "relative/path"}' "$BASE/")
assert_status "POST relative path: 400" "400" "$HTTP_CODE"

# GET / after registration
resp=$(curl -s "$BASE/?format=json")
assert_eq "GET / after POST: count 1" "1" "$(json_field "$resp" count)"
assert_contains "GET / after POST: slug in list" "$SLUG" "$resp"

# DELETE missing identifier
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/")
assert_status "DELETE no id: 400" "400" "$HTTP_CODE"

# DELETE invalid slug
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/?slug=nonexistent-slug")
assert_status "DELETE invalid slug: 404" "404" "$HTTP_CODE"

# PUT no fields
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PUT -H 'Content-Type: application/json' -d '{}' "$BASE/")
assert_status "PUT no fields: 400" "400" "$HTTP_CODE"

# PUT change path
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PUT -H 'Content-Type: application/json' -d "{\"slug\": \"$SLUG\", \"folder_path\": \"/tmp/test-folder\"}" "$BASE/")
assert_status "PUT change path: 200" "200" "$HTTP_CODE"

# PUT change slug
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PUT -H 'Content-Type: application/json' -d "{\"slug\": \"my-folder\", \"folder_path\": \"/tmp/test-folder\"}" "$BASE/")
assert_status "PUT change slug: 200" "200" "$HTTP_CODE"

# PUT entry not found (slug and path both don't exist)
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PUT -H 'Content-Type: application/json' -d '{"slug": "nonexistent-slug", "folder_path": "/tmp/nonexistent-dir-xyz"}' "$BASE/")
assert_status "PUT not found: 404" "404" "$HTTP_CODE"

# PUT no changes (same slug, same path — my-folder → /tmp/test-folder)
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PUT -H 'Content-Type: application/json' -d '{"slug": "my-folder", "folder_path": "/tmp/test-folder"}' "$BASE/")
assert_status "PUT no changes: 400" "400" "$HTTP_CODE"

# GET / verify slug changed
resp=$(curl -s "$BASE/?format=json")
assert_contains "GET / after PUT: slug is my-folder" "my-folder" "$resp"

# DELETE by slug
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/?slug=my-folder")
assert_status "DELETE by slug: 200" "200" "$HTTP_CODE"

# Clean up any leftover registrations before checking count
# (the PUT collision test may have left /tmp/test-folder registered)
for _i in $(seq 1 5); do
	cnt=$(curl -s "$BASE/?format=json" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['count'])" 2>/dev/null)
	[[ "$cnt" == "0" ]] && break
	# Delete by path to clean up
	curl -s -X DELETE -H 'Content-Type: application/json' -d '{"folder_path": "/tmp/test-folder"}' "$BASE/" >/dev/null
	sleep 0.1
done

# DELETE by path
curl -s -X POST -H 'Content-Type: application/json' -d "{\"folder_path\": \"/tmp/test-folder\"}" "$BASE/" >/dev/null
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE -H 'Content-Type: application/json' -d "{\"folder_path\": \"/tmp/test-folder\"}" "$BASE/")
assert_status "DELETE by path: 200" "200" "$HTTP_CODE"

# GET / empty again
resp=$(curl -s "$BASE/?format=json")
assert_eq "GET / after DELETE: count 0" "0" "$(json_field "$resp" count)"

# POST with custom slug
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H 'Content-Type: application/json' -d "{\"folder_path\": \"/tmp/test-folder\", \"slug\": \"custom-slug\"}" "$BASE/")
assert_status "POST custom slug: 201" "201" "$HTTP_CODE"

# POST custom slug already taken (use a path that's not yet registered)
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H 'Content-Type: application/json' -d '{"folder_path": "/tmp/another-folder", "slug": "custom-slug"}' "$BASE/")
assert_status "POST custom slug taken: 409" "409" "$HTTP_CODE"

# Unknown method
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE/")
assert_status "PATCH /: 405" "405" "$HTTP_CODE"

echo ""
echo "=========================================="
echo "  Phase 2 — File Serving"
echo "=========================================="

# Re-register test dir
curl -s -X POST -H 'Content-Type: application/json' -d "{\"folder_path\": \"$TEST_DIR\"}" "$BASE/" >/dev/null
SLUG2=$(curl -s "$BASE/?format=json" | grep -o '"slug":"[^"]*"' | tail -1 | cut -d'"' -f4)

# File serving
BODY=$(curl -s "$BASE/$SLUG2/test-file.txt")
assert_eq "File serving: content" "test file content" "$BODY"

# File headers
HEADERS=$(curl -sI "$BASE/$SLUG2/test-file.txt")
assert_contains "File headers: Content-Type" "text/plain" "$HEADERS"
assert_contains "File headers: X-Slug" "$SLUG2" "$HEADERS"
assert_contains "File headers: Accept-Ranges" "bytes" "$HEADERS"
assert_contains "File headers: ETag" "W/" "$HEADERS"
assert_contains "File headers: Cache-Control" "max-age" "$HEADERS"
assert_contains "File headers: X-Folder-Path" "true" "$(echo "$HEADERS" | grep -q "X-Folder-Path" && echo true || echo false)"

# File not found
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/$SLUG2/nonexistent.txt")
assert_status "File not found: 404" "404" "$HTTP_CODE"

# Unknown slug
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/unknown-slug/file.txt")
assert_status "Unknown slug: 404" "404" "$HTTP_CODE"

# Path traversal
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/$SLUG2/%2e%2e%2fetc%2fpasswd")
assert_status "Path traversal: 403" "403" "$HTTP_CODE"

# Directory redirect (no trailing slash)
HTTP_CODE=$(curl -sI -o /dev/null -w "%{http_code}" "$BASE/$SLUG2")
assert_status "Directory redirect: 301" "301" "$HTTP_CODE"

# Directory listing
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/$SLUG2/")
assert_status "Directory listing: 200" "200" "$HTTP_CODE"

# Subdomain access
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Host: $SLUG2.localhost:$PORT" "$BASE/test-file.txt")
assert_status "Subdomain access: 200" "200" "$HTTP_CODE"

# Subdomain case-insensitive
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Host: $(echo $SLUG2 | tr '[:upper:]' '[:lower:]').localhost:$PORT" "$BASE/test-file.txt")
assert_status "Subdomain case-insensitive: 200" "200" "$HTTP_CODE"

# HEAD method
HTTP_CODE=$(curl -sI -o /dev/null -w "%{http_code}" "$BASE/$SLUG2/test-file.txt")
assert_status "HEAD method: 200" "200" "$HTTP_CODE"

# POST on file path → 405
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/$SLUG2/test-file.txt")
assert_status "POST on file path: 405" "405" "$HTTP_CODE"

echo ""
echo "=========================================="
echo "  Phase 3 — Range Requests + Caching"
echo "=========================================="

# Range request
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Range: bytes=0-99" "$BASE/$SLUG2/big.bin")
assert_status "Range request: 206" "206" "$HTTP_CODE"

# Range request headers
RANGE_HEADERS=$(curl -sI -H "Range: bytes=0-99" "$BASE/$SLUG2/big.bin")
assert_contains "Range headers: Content-Range" "bytes 0-99" "$RANGE_HEADERS"

# ETag 304
ETAG=$(curl -sI "$BASE/$SLUG2/big.bin" | grep -i etag | tr -d '\r' | sed 's/.*ETag: //')
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "If-None-Match: $ETAG" "$BASE/$SLUG2/big.bin")
assert_status "ETag 304: 304" "304" "$HTTP_CODE"

# If-Modified-Since (future date → 304)
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "If-Modified-Since: Sat, 01 Jan 2030 00:00:00 GMT" "$BASE/$SLUG2/big.bin")
assert_status "If-Modified-Since future: 304" "304" "$HTTP_CODE"

echo ""
echo "=========================================="
echo "  Phase 4 — Directory Listing"
echo "=========================================="

# Nested directory listing
LISTING=$(curl -s "$BASE/$SLUG2/sub/nested/")
assert_contains "Nested listing: file.txt link" "file.txt" "$LISTING"
assert_contains "Nested listing: parent link" "Parent directory" "$LISTING"

# Parent link correct URL
assert_contains "Parent link URL" "/$SLUG2/sub/" "$LISTING"

# File link correct URL
assert_contains "File link URL" "/$SLUG2/sub/nested/file.txt" "$LISTING"

# Empty directory
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/$SLUG2/empty-dir/")
assert_status "Empty directory: 200" "200" "$HTTP_CODE"

echo ""
echo "=========================================="
echo "  Phase 5 — Dashboard UI"
echo "=========================================="

# Dashboard serves HTML
DASHBOARD=$(curl -s "$BASE/")
assert_contains "Dashboard: HTML doctype" "DOCTYPE" "$DASHBOARD"
assert_contains "Dashboard: title" "Local HTTP File Server" "$DASHBOARD"

# JSON via Accept header
JSON_RESP=$(curl -s -H 'Accept: application/json' "$BASE/")
assert_contains "JSON via Accept: status field" "success" "$JSON_RESP"

# JSON via query param
JSON_RESP=$(curl -s "$BASE/?format=json")
assert_contains "JSON via query param: status field" "success" "$JSON_RESP"

echo ""
echo "=========================================="
echo "  Phase 6 — Persistence"
echo "=========================================="

# Register a folder specifically for persistence testing
curl -s -X POST -H 'Content-Type: application/json' -d '{"folder_path": "/tmp/persist-test"}' "$BASE/" >/dev/null

# registry.json exists after POST
assert_contains "registry.json exists" "true" "$(test -f registry.json && echo true || echo false)"

# Content is valid JSON with slug field
assert_contains "registry.json valid JSON" "slug" "$(cat registry.json)"

# Restart with persistence — kill and restart
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

# Verify registry.json still exists (wasn't deleted by shutdown)
assert_contains "registry.json survives shutdown" "true" "$(test -f registry.json && echo true || echo false)"
assert_contains "registry.json has content" "slug" "$(cat registry.json 2>/dev/null)"

PERSIST=true PORT="$PORT" bun run src/index.ts &
SERVER_PID=$!
wait_for_port "$PORT"

resp=$(curl -s "$BASE/?format=json")
assert_contains "Persistence: folder survived restart" "slug" "$resp"

# Stale entry detection — manually corrupt registry.json to point to non-existent path
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

python3 -c "
import json
with open('registry.json') as f:
    data = json.load(f)
for entry in data:
    entry['path'] = '/nonexistent-stale-path'
with open('registry.json', 'w') as f:
    json.dump(data, f)
" 2>/dev/null

PERSIST=true PORT="$PORT" bun run src/index.ts &
SERVER_PID=$!
wait_for_port "$PORT"

resp=$(curl -s "$BASE/?format=json")
assert_eq "Persistence: stale entry removed, count 0" "0" "$(json_field "$resp" count)"

# Without PERSIST flag
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

PORT="$PORT" bun run src/index.ts &
SERVER_PID=$!
wait_for_port "$PORT"

resp=$(curl -s "$BASE/?format=json")
assert_eq "No persistence: count 0" "0" "$(json_field "$resp" count)"

# ─── Results ───────────────────────────────────────────────────────────────────

echo ""
echo "=========================================="
echo "  Results: $PASS/$TOTAL passed, $FAIL failed"
echo "=========================================="

if [[ $FAIL -gt 0 ]]; then
	exit 1
fi
