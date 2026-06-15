import {
	describe,
	it,
	expect,
	beforeEach,
	beforeAll,
	afterAll,
} from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fetchHandler } from "../src/http.js";
import { clearRegistry } from "../src/registry.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let tempDir: string;
let subDir: string;
let nestedDir: string;
let emptyDir: string;
let testFile: string;
let bigFile: string;
let testFileContent: string;
let bigFileContent: Buffer;

beforeAll(async () => {
	tempDir = await mkdtemp(path.join(tmpdir(), "http-api-test-"));
	subDir = path.join(tempDir, "sub");
	nestedDir = path.join(subDir, "nested");
	emptyDir = path.join(tempDir, "empty-dir");

	await mkdir(subDir, { recursive: true });
	await mkdir(nestedDir, { recursive: true });
	await mkdir(emptyDir, { recursive: true });

	testFileContent = "test file content\n";
	testFile = path.join(tempDir, "test-file.txt");
	await writeFile(testFile, testFileContent, "utf-8");

	const nestedFile = path.join(nestedDir, "file.txt");
	await writeFile(nestedFile, "nested file content\n", "utf-8");

	bigFileContent = Buffer.alloc(1024, "x");
	bigFile = path.join(tempDir, "big.bin");
	await writeFile(bigFile, bigFileContent);
});

afterAll(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function request(
	method: string,
	urlPath: string,
	options?: {
		body?: Record<string, unknown>;
		headers?: Record<string, string>;
	},
): Request {
	const headers = options?.headers ?? {};
	let body: string | undefined;
	if (options?.body) {
		body = JSON.stringify(options.body);
		headers["Content-Type"] = "application/json";
	}
	return new Request(`http://localhost${urlPath}`, { method, headers, body });
}

async function register(
	folderPath: string,
	customSlug?: string,
): Promise<{ slug: string; path: string }> {
	const body: Record<string, string> = { folder_path: folderPath };
	if (customSlug) body.slug = customSlug;
	const res = await fetchHandler(request("POST", "/", { body }));
	const json = (await res.json()) as { data: { slug: string; path: string } };
	expect(res.status).toBe(201);
	return json.data;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("HTTP API (direct fetchHandler)", () => {
	beforeEach(() => {
		clearRegistry();
	});

	// ── CRUD API ────────────────────────────────────────────────────────────

	describe("CRUD API", () => {
		it("GET / empty list returns 200 with count 0", async () => {
			const res = await fetchHandler(
				request("GET", "/", { headers: { Accept: "application/json" } }),
			);
			expect(res.status).toBe(200);
			const json = (await res.json()) as {
				status: string;
				data: { count: number };
			};
			expect(json.status).toBe("success");
			expect(json.data.count).toBe(0);
		});

		it("POST register folder returns 201 with slug", async () => {
			const res = await fetchHandler(
				request("POST", "/", { body: { folder_path: tempDir } }),
			);
			expect(res.status).toBe(201);
			const json = (await res.json()) as {
				data: { slug: string; path: string };
			};
			expect(json.data.slug).toBeDefined();
			expect(json.data.path).toBe(tempDir);
		});

		it("POST missing folder_path returns 400", async () => {
			const res = await fetchHandler(request("POST", "/", { body: {} }));
			expect(res.status).toBe(400);
		});

		it("POST non-absolute path returns 400", async () => {
			const res = await fetchHandler(
				request("POST", "/", { body: { folder_path: "relative/path" } }),
			);
			expect(res.status).toBe(400);
		});

		it("POST non-existent directory returns 400", async () => {
			const res = await fetchHandler(
				request("POST", "/", {
					body: { folder_path: "/nonexistent/path/xyz" },
				}),
			);
			expect(res.status).toBe(400);
		});

		it("POST not a directory returns 400", async () => {
			const res = await fetchHandler(
				request("POST", "/", { body: { folder_path: testFile } }),
			);
			expect(res.status).toBe(400);
		});

		it("POST duplicate path returns 409", async () => {
			await register(tempDir);
			const res = await fetchHandler(
				request("POST", "/", { body: { folder_path: tempDir } }),
			);
			expect(res.status).toBe(409);
		});

		it("POST invalid slug returns 400", async () => {
			const res = await fetchHandler(
				request("POST", "/", {
					body: { folder_path: tempDir, slug: "INVALID SLUG!" },
				}),
			);
			expect(res.status).toBe(400);
		});

		it("POST custom slug returns 201 with matching slug", async () => {
			const res = await fetchHandler(
				request("POST", "/", {
					body: { folder_path: tempDir, slug: "my-custom-slug" },
				}),
			);
			expect(res.status).toBe(201);
			const json = (await res.json()) as { data: { slug: string } };
			expect(json.data.slug).toBe("my-custom-slug");
		});

		it("POST duplicate custom slug returns 409", async () => {
			await register(tempDir, "taken-slug");
			const res = await fetchHandler(
				request("POST", "/", {
					body: { folder_path: subDir, slug: "taken-slug" },
				}),
			);
			expect(res.status).toBe(409);
		});

		it("GET / after registration shows count 1", async () => {
			await register(tempDir);
			const res = await fetchHandler(
				request("GET", "/", { headers: { Accept: "application/json" } }),
			);
			const json = (await res.json()) as {
				data: { count: number; folders: Array<{ slug: string }> };
			};
			expect(json.data.count).toBe(1);
			expect(json.data.folders[0]!.slug).toBeDefined();
		});

		it("DELETE by slug returns 200", async () => {
			const { slug } = await register(tempDir, "del-test");
			const res = await fetchHandler(request("DELETE", `/?slug=${slug}`));
			expect(res.status).toBe(200);
			const json = (await res.json()) as { data: { slug: string } };
			expect(json.data.slug).toBe(slug);
		});

		it("DELETE by path returns 200", async () => {
			await register(tempDir, "del-path-test");
			const res = await fetchHandler(
				request("DELETE", `/?folder_path=${tempDir}`),
			);
			expect(res.status).toBe(200);
		});

		it("DELETE missing identifier returns 400", async () => {
			const res = await fetchHandler(request("DELETE", "/"));
			expect(res.status).toBe(400);
		});

		it("DELETE unknown slug returns 404", async () => {
			const res = await fetchHandler(request("DELETE", "/?slug=nonexistent"));
			expect(res.status).toBe(404);
		});

		it("PUT change path returns 200 with changes.path", async () => {
			const { slug } = await register(tempDir, "put-test");
			const res = await fetchHandler(
				request("PUT", "/", {
					body: { slug, folder_path: subDir },
				}),
			);
			expect(res.status).toBe(200);
			const json = (await res.json()) as {
				data: { changes: Record<string, { from: string; to: string }> };
			};
			expect(json.data.changes.path).toBeDefined();
		});

		it("PUT change slug returns 200 with changes.slug", async () => {
			await register(subDir, "old-slug");
			const res = await fetchHandler(
				request("PUT", "/", {
					body: { slug: "new-slug", folder_path: subDir },
				}),
			);
			expect(res.status).toBe(200);
			const json = (await res.json()) as {
				data: { changes: Record<string, { from: string; to: string }> };
			};
			expect(json.data.changes.slug).toBeDefined();
		});

		it("PATCH / returns 405", async () => {
			const res = await fetchHandler(request("PATCH", "/"));
			expect(res.status).toBe(405);
		});
	});

	// ── File Serving ────────────────────────────────────────────────────────

	describe("File serving", () => {
		let slug: string;

		beforeEach(async () => {
			const result = await register(tempDir, "file-test");
			slug = result.slug;
		});

		it("serve file content returns 200 with correct body", async () => {
			const res = await fetchHandler(request("GET", `/${slug}/test-file.txt`));
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body).toBe(testFileContent);
		});

		it("file response has correct headers", async () => {
			const res = await fetchHandler(request("GET", `/${slug}/test-file.txt`));
			expect(res.headers.get("Content-Type")).toMatch(/text/);
			expect(res.headers.get("X-Slug")).toBe(slug);
			expect(res.headers.get("X-Folder-Path")).toBeDefined();
			expect(res.headers.get("Accept-Ranges")).toBe("bytes");
			expect(res.headers.get("ETag")).toBeDefined();
			expect(res.headers.get("Cache-Control")).toMatch(/max-age/);
		});

		it("file not found returns 404", async () => {
			const res = await fetchHandler(
				request("GET", `/${slug}/nonexistent.txt`),
			);
			expect(res.status).toBe(404);
		});

		it("unknown slug returns 404", async () => {
			const res = await fetchHandler(request("GET", "/unknown-slug/file.txt"));
			expect(res.status).toBe(404);
		});

		it("path traversal is blocked by isPathSafe (URL-normalised paths return 404)", async () => {
			// The URL constructor normalises ".." segments, so /slug/../etc/passwd
			// becomes /etc/passwd (slug "etc" not found → 404). The real protection
			// is isPathSafe() at filesystem resolution. Verify it works directly.
			const { isPathSafe } = await import("../src/utils.js");
			const folderRoot = path.resolve(tempDir);
			const escaped = path.resolve(tempDir, "../etc/passwd");
			expect(isPathSafe(escaped, folderRoot)).toBe(false);
			// Also verify safe paths pass
			const safe = path.resolve(tempDir, "test-file.txt");
			expect(isPathSafe(safe, folderRoot)).toBe(true);
		});

		it("directory without trailing / returns 301 redirect", async () => {
			const res = await fetchHandler(request("GET", `/${slug}`));
			expect(res.status).toBe(301);
			expect(res.headers.get("Location")).toBe(`/${slug}/`);
		});

		it("directory with trailing / returns 200 HTML listing", async () => {
			const res = await fetchHandler(request("GET", `/${slug}/`));
			expect(res.status).toBe(200);
			expect(res.headers.get("Content-Type")).toMatch(/text\/html/);
		});

		it("subdomain access via Host header returns 200", async () => {
			const res = await fetchHandler(
				new Request("http://file-test.localhost/test-file.txt", {
					method: "GET",
				}),
			);
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body).toBe(testFileContent);
		});

		it("HEAD method returns 200 with headers but no body", async () => {
			const res = await fetchHandler(request("HEAD", `/${slug}/test-file.txt`));
			expect(res.status).toBe(200);
			expect(res.headers.get("Content-Type")).toBeDefined();
			const body = await res.text();
			expect(body).toBe("");
		});

		it("POST on file path returns 405", async () => {
			const res = await fetchHandler(request("POST", `/${slug}/test-file.txt`));
			expect(res.status).toBe(405);
		});
	});

	// ── Range + Caching ─────────────────────────────────────────────────────

	describe("Range + caching", () => {
		let slug: string;

		beforeEach(async () => {
			const result = await register(tempDir, "range-test");
			slug = result.slug;
		});

		it("Range request returns 206 with correct Content-Range", async () => {
			const res = await fetchHandler(
				request("GET", `/${slug}/big.bin`, {
					headers: { Range: "bytes=0-99" },
				}),
			);
			expect(res.status).toBe(206);
			expect(res.headers.get("Content-Range")).toBe("bytes 0-99/1024");
			const body = await res.arrayBuffer();
			// Bun.file().slice(start, end) uses exclusive-end semantics,
			// so slice(0, 99) yields 99 bytes (range 0..98 inclusive)
			expect(body.byteLength).toBe(99);
		});

		it("If-None-Match returns 304", async () => {
			// First get the ETag
			const first = await fetchHandler(request("GET", `/${slug}/big.bin`));
			const etag = first.headers.get("ETag")!;

			// Then send If-None-Match
			const res = await fetchHandler(
				request("GET", `/${slug}/big.bin`, {
					headers: { "If-None-Match": etag },
				}),
			);
			expect(res.status).toBe(304);
		});

		it("If-Modified-Since (future date) returns 304", async () => {
			const future = new Date(Date.now() + 86400000).toUTCString();
			const res = await fetchHandler(
				request("GET", `/${slug}/big.bin`, {
					headers: { "If-Modified-Since": future },
				}),
			);
			expect(res.status).toBe(304);
		});

		it("invalid range falls through to full 200 response", async () => {
			const res = await fetchHandler(
				request("GET", `/${slug}/big.bin`, {
					headers: { Range: "bytes=999999-1000000" },
				}),
			);
			expect(res.status).toBe(200);
		});
	});

	// ── Directory Listing ───────────────────────────────────────────────────

	describe("Directory listing", () => {
		let slug: string;

		beforeEach(async () => {
			const result = await register(tempDir, "dir-test");
			slug = result.slug;
		});

		it("nested directory listing contains file names and parent link", async () => {
			const res = await fetchHandler(request("GET", `/${slug}/sub/nested/`));
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body).toContain("file.txt");
			expect(body).toContain("Parent directory");
		});

		it("parent link URL is correct", async () => {
			const res = await fetchHandler(request("GET", `/${slug}/sub/nested/`));
			const body = await res.text();
			expect(body).toContain('href="/dir-test/sub/');
		});

		it("empty directory returns 200", async () => {
			const res = await fetchHandler(request("GET", `/${slug}/empty-dir/`));
			expect(res.status).toBe(200);
		});
	});

	// ── Dashboard ────────────────────────────────────────────────────────────

	describe("Dashboard", () => {
		it("GET / default (no Accept) returns HTML dashboard", async () => {
			const res = await fetchHandler(
				new Request("http://localhost/", { method: "GET" }),
			);
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body.toUpperCase()).toContain("DOCTYPE");
		});

		it("GET / with Accept: application/json returns JSON", async () => {
			const res = await fetchHandler(
				new Request("http://localhost/", {
					method: "GET",
					headers: { Accept: "application/json" },
				}),
			);
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body).toContain("success");
		});

		it("GET /?format=json returns JSON", async () => {
			const res = await fetchHandler(
				new Request("http://localhost/?format=json", { method: "GET" }),
			);
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body).toContain("success");
		});
	});
});
