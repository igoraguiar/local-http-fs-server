import { readdir, stat } from "node:fs/promises";
import { statSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join, basename } from "node:path";

// ─── Data Model ───────────────────────────────────────────────────────────────

interface FolderEntry {
	slug: string;
	path: string;
	createdAt: Date;
	updatedAt: Date;
}

const registry: Map<string, FolderEntry> = new Map();

// ─── Response Formatter ───────────────────────────────────────────────────────

function ok(
	message: string,
	data?: Record<string, unknown>,
	hint?: string,
	status = 200,
): Response {
	const body: Record<string, unknown> = { status: "success", message };
	if (data !== undefined) body.data = data;
	if (hint) body.hint = hint;
	return Response.json(body, { status });
}

function err(
	message: string,
	status: number,
	details?: Record<string, unknown>,
	hint?: string,
): Response {
	const body: Record<string, unknown> = { status: "error", message };
	if (details) body.details = details;
	if (hint) body.hint = hint;
	return Response.json(body, { status });
}

// ─── Slug Generator ───────────────────────────────────────────────────────────

const SLUG_SUFFIX_ALPHABET =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function randomSuffix(length = 8): string {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	let result = "";
	for (let i = 0; i < length; i++) {
		const idx = Number(bytes[i]) % SLUG_SUFFIX_ALPHABET.length;
		result += SLUG_SUFFIX_ALPHABET[idx]!;
	}
	return result;
}

function normalizeSlugBase(folderPath: string): string {
	const baseName = folderPath === "/" ? "root" : basename(folderPath);
	let slug = baseName.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
	slug = slug
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!slug || !/^[a-z0-9]/.test(slug)) slug = "folder";
	return slug;
}

async function generateSlug(folderPath: string): Promise<string> {
	const base = normalizeSlugBase(folderPath);
	for (let attempt = 0; attempt < 3; attempt++) {
		const candidate = `${base}-${randomSuffix()}`;
		if (!registry.has(candidate)) return candidate;
	}
	return `${base}-${randomSuffix(12)}`;
}

// ─── Slug Validator ───────────────────────────────────────────────────────────

const SLUG_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function validateSlug(
	slug: string,
): { valid: true } | { valid: false; reason: string; isConflict?: true } {
	if (!slug || !SLUG_REGEX.test(slug))
		return {
			valid: false,
			reason: "Slug must match ^[a-z0-9][a-z0-9_-]{0,63}$",
		};
	if (registry.has(slug))
		return {
			valid: false,
			reason: `Slug '${slug}' is already in use`,
			isConflict: true,
		};
	return { valid: true };
}

// ─── Path Safety Checker ──────────────────────────────────────────────────────

function isPathSafe(resolvedFilePath: string, folderRoot: string): boolean {
	return (
		resolvedFilePath === folderRoot ||
		resolvedFilePath.startsWith(folderRoot + "/")
	);
}

// ─── Subdomain Extractor ──────────────────────────────────────────────────────

function extractSubdomain(hostname: string): string | null {
	if (!hostname) return null;
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return null;
	if (hostname.startsWith("[")) return null;
	const parts = hostname.split(".");
	return parts.length > 1 ? parts[0]! : null;
}

// ─── Range Request Parser ─────────────────────────────────────────────────────

interface RangeResult {
	status: 206;
	start: number;
	end: number;
	contentLength: number;
	contentRange: string;
}

function parseRange(
	rangeHeader: string | null,
	fileSize: number,
): RangeResult | null {
	if (!rangeHeader) return null;
	const match = rangeHeader.match(/^bytes=(\d+)-(\d+)?$/);
	if (!match) return null;
	const start = parseInt(match[1]!, 10);
	const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
	if (start >= fileSize || start > end) return null;
	const clampedEnd = Math.min(end, fileSize - 1);
	return {
		status: 206,
		start,
		end: clampedEnd,
		contentLength: clampedEnd - start + 1,
		contentRange: `bytes ${start}-${clampedEnd}/${fileSize}`,
	};
}

// ─── ETag Generator ───────────────────────────────────────────────────────────

function generateETag(slug: string, size: number, mtimeMs: number): string {
	return `W/"${slug}-${size}-${mtimeMs}"`;
}

function httpDate(ms: number): string {
	return new Date(ms).toUTCString();
}

// ─── Directory Listing HTML Generator ─────────────────────────────────────────

function buildDirListing(
	entries: Array<{ name: string; isDir: boolean; size: number }>,
	currentPath: string,
	slug: string,
): string {
	const slugPath = `/${slug}`;
	const breadcrumb =
		currentPath === "/" ? `${slugPath}/` : `${slugPath}/${currentPath}/`;
	const parentPath =
		currentPath === "/"
			? slugPath
			: `${slugPath}/${currentPath.replace(/\/$/, "").replace(/\/[^/]*$/, "")}`;

	let rows = "";
	for (const entry of entries) {
		const href = `${breadcrumb}${encodeURIComponent(entry.name)}${entry.isDir ? "/" : ""}`;
		const sizeLabel = entry.isDir ? "<dir>" : `${entry.size} B`;
		rows += `<tr><td><a href="${href}">${entry.name}</a></td><td>${sizeLabel}</td></tr>`;
	}

	return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Directory listing: ${currentPath}</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem}a{color:#0066cc}table{border-collapse:collapse}td{padding:0.25rem 1rem}</style>
</head><body>
<h1>Directory listing: ${currentPath}</h1>
${currentPath !== "/" ? `<p><a href="${parentPath}/">Parent directory</a></p>` : ""}
<table>${rows}</table>
</body></html>`;
}

// ─── Server ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "8080", 10);
const HOST = "0.0.0.0";
const PERSIST =
	process.env.PERSIST === "true" || process.argv.includes("--persist");
const REGISTRY_FILE = "registry.json";

function logRequest(method: string, path: string, status: number): void {
	console.log(`[${new Date().toISOString()}] ${method} ${path} → ${status}`);
}

// ─── Persistence ──────────────────────────────────────────────────────────────

function loadRegistry(): void {
	if (!PERSIST) return;
	try {
		const content = readFileSync(REGISTRY_FILE, "utf-8");
		const entries: Array<{
			slug: string;
			path: string;
			createdAt: string;
			updatedAt: string;
		}> = JSON.parse(content);
		for (const e of entries) {
			try {
				const s = statSync(e.path);
				if (s.isDirectory()) {
					registry.set(e.slug, {
						slug: e.slug,
						path: e.path,
						createdAt: new Date(e.createdAt),
						updatedAt: new Date(e.updatedAt),
					});
				} else {
					console.warn(
						`Persistence: skipping stale entry '${e.slug}' — path '${e.path}' no longer exists or is not a directory.`,
					);
				}
			} catch {
				console.warn(
					`Persistence: skipping stale entry '${e.slug}' — path '${e.path}' no longer exists or is not a directory.`,
				);
			}
		}
		console.log(
			`Persistence: loaded ${registry.size} entries from ${REGISTRY_FILE}`,
		);
	} catch {
		console.warn(
			`Persistence: could not load ${REGISTRY_FILE}, starting with empty registry.`,
		);
	}
}

function saveRegistry(): void {
	if (!PERSIST) return;
	try {
		const entries: Array<{
			slug: string;
			path: string;
			createdAt: string;
			updatedAt: string;
		}> = [];
		for (const e of registry.values()) {
			entries.push({
				slug: e.slug,
				path: e.path,
				createdAt: e.createdAt.toISOString(),
				updatedAt: e.updatedAt.toISOString(),
			});
		}
		writeFileSync(REGISTRY_FILE, JSON.stringify(entries, null, 2), "utf-8");
	} catch (e) {
		console.error(`Persistence: failed to save registry: ${e}`);
	}
}

loadRegistry();

process.on("SIGINT", () => {
	console.log("Shutting down...");
	saveRegistry();
	process.exit(0);
});
process.on("SIGTERM", () => {
	console.log("Shutting down...");
	saveRegistry();
	process.exit(0);
});

Bun.serve({
	hostname: HOST,
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);
		const method = req.method.toUpperCase();
		const pathname = decodeURIComponent(url.pathname);
		const hostname = url.hostname;
		const subdomainSlug = extractSubdomain(hostname);

		// ── API routes: exact path "/" ──────────────────────────────────────────
		// Skip API routes when a valid subdomain slug matches a registered folder
		// so subdomain requests fall through to file serving
		const subdomainMatchesRegistry =
			subdomainSlug !== null &&
			(registry.has(subdomainSlug) ||
				[...registry.keys()].some(
					(k) => k.toLowerCase() === subdomainSlug!.toLowerCase(),
				));

		if ((pathname === "/" || pathname === "") && !subdomainMatchesRegistry) {
			switch (method) {
				case "GET": {
					const accept = req.headers.get("accept") || "";
					const formatJson = url.searchParams.get("format");
					const wantJson =
						formatJson === "json" || accept.includes("application/json");

					if (!wantJson) {
						const dashboardFile = Bun.file("./dashboard.html");
						logRequest(method, pathname, 200);
						return new Response(dashboardFile, {
							status: 200,
							headers: { "Content-Type": "text/html; charset=utf-8" },
						});
					}

					const folders: Array<Record<string, unknown>> = [];
					for (const entry of registry.values()) {
						folders.push({
							slug: entry.slug,
							path: entry.path,
							url: `http://localhost:${PORT}/${entry.slug}`,
							subdomain_url: `http://${entry.slug}.localhost:${PORT}`,
							registered_at: entry.createdAt.toISOString(),
						});
					}
					const message =
						folders.length === 0
							? 'No folders registered yet. POST with { "folder_path": "/path/to/folder" } to add one.'
							: "List of registered folders. POST to add, DELETE/PUT to manage.";
					const hint =
						folders.length === 0
							? "Register your first folder to start serving files."
							: 'To register a new folder, POST with { "folder_path": "/path/to/folder" }';
					logRequest(method, pathname, 200);
					return ok(message, { count: folders.length, folders }, hint);
				}

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
							"Missing required field 'folder_path'. Provide an absolute path to a directory.",
							400,
							{
								field: "folder_path",
								received: null,
								expected: "string (absolute path to an existing directory)",
							},
							'Example: POST with { "folder_path": "/home/user/documents" }',
						);
					}

					if (!folderPath.startsWith("/")) {
						logRequest(method, pathname, 400);
						return err(
							`Path '${folderPath}' is not absolute. Provide an absolute path starting with '/'.`,
							400,
							{ field: "folder_path", value: folderPath },
							'Example: POST with { "folder_path": "/home/user/documents" }',
						);
					}

					try {
						const s = await stat(folderPath);
						if (!s.isDirectory()) {
							logRequest(method, pathname, 400);
							return err(
								`Path '${folderPath}' exists but is not a directory.`,
								400,
								{ folder_path: folderPath, reason: "not a directory" },
								"Check that the path exists and is a readable directory.",
							);
						}
					} catch (e: unknown) {
						const reason = (e as { code?: string }).code || "UNKNOWN";
						logRequest(method, pathname, 400);
						return err(
							`Directory '${folderPath}' does not exist or is not accessible.`,
							400,
							{ folder_path: folderPath, reason },
							"Check that the path exists and is a readable directory.",
						);
					}

					for (const entry of registry.values()) {
						if (entry.path === folderPath) {
							logRequest(method, pathname, 409);
							return err(
								`Folder '${folderPath}' is already registered with slug '${entry.slug}'.`,
								409,
								{ folder_path: folderPath, existing_slug: entry.slug },
								"Use PUT to update the existing registration, or DELETE it first and re-register.",
							);
						}
					}

					let slug: string;
					if (body.slug && typeof body.slug === "string" && body.slug.trim()) {
						const validation = validateSlug(body.slug.trim());
						if (!validation.valid) {
							const statusCode = validation.isConflict ? 409 : 400;
							logRequest(method, pathname, statusCode);
							return err(
								`Invalid slug '${body.slug.trim()}'. ${validation.reason}`,
								statusCode,
								{
									field: "slug",
									value: body.slug.trim(),
									reason: validation.reason,
								},
								"Provide a valid slug or omit it to auto-generate a unique one.",
							);
						}
						slug = body.slug.trim();
					} else {
						slug = await generateSlug(folderPath);
					}

					const now = new Date();
					const entry: FolderEntry = {
						slug,
						path: folderPath,
						createdAt: now,
						updatedAt: now,
					};
					registry.set(slug, entry);
					saveRegistry();

					logRequest(method, pathname, 201);
					return ok(
						`Folder '${slug}' registered at '${folderPath}'. Serving files now.`,
						{
							slug,
							path: folderPath,
							url: `http://localhost:${PORT}/${slug}`,
							subdomain_url: `http://${slug}.localhost:${PORT}`,
							registered_at: now.toISOString(),
						},
						`Access files at http://localhost:${PORT}/${slug}/filename.txt or use curl -H "Host: ${slug}.localhost:${PORT}" http://localhost:${PORT}/filename.txt`,
						201,
					);
				}

				case "DELETE": {
					const querySlug = url.searchParams.get("slug");
					const queryPath = url.searchParams.get("folder_path");
					let bodySlug: string | null = null;
					let bodyPath: string | null = null;
					try {
						const jsonBody = (await req.json()) as Record<string, unknown>;
						bodySlug = (jsonBody.slug as string) || null;
						bodyPath = (jsonBody.folder_path as string) || null;
					} catch {
						// No body or invalid JSON
					}

					const identifierSlug = querySlug || bodySlug;
					const identifierPath = queryPath || bodyPath;

					if (!identifierSlug && !identifierPath) {
						logRequest(method, pathname, 400);
						return err(
							"DELETE requires identification. Provide a 'slug' or 'folder_path' as query parameter or in JSON body.",
							400,
							undefined,
							'Example: DELETE /?slug=my-slug or DELETE / with { "slug": "my-slug" }',
						);
					}

					let entryToRemove: FolderEntry | undefined;
					if (identifierSlug) {
						entryToRemove = registry.get(identifierSlug);
					}
					if (!entryToRemove && identifierPath) {
						for (const e of registry.values()) {
							if (e.path === identifierPath) {
								entryToRemove = e;
								break;
							}
						}
					}

					if (!entryToRemove) {
						logRequest(method, pathname, 404);
						return err(
							`No registration found with slug '${identifierSlug || ""}' or path '${identifierPath || ""}'.`,
							404,
							{
								slug: identifierSlug || undefined,
								folder_path: identifierPath || undefined,
							},
							"Use GET / to list all registered folders and their slugs.",
						);
					}

					registry.delete(entryToRemove.slug);
					saveRegistry();
					logRequest(method, pathname, 200);
					return ok(
						`Folder '${entryToRemove.slug}' unregistered. Files are no longer accessible.`,
						{
							slug: entryToRemove.slug,
							path: entryToRemove.path,
							was_registered_at: entryToRemove.createdAt.toISOString(),
						},
						"Folder contents were not deleted from disk — only the serving registration was removed.",
					);
				}

				case "PUT": {
					let body: Record<string, unknown>;
					try {
						body = (await req.json()) as Record<string, unknown>;
					} catch {
						logRequest(method, pathname, 400);
						return err(
							"Invalid JSON body. Provide a valid JSON object.",
							400,
							undefined,
							'Example: PUT with { "slug": "current-slug", "folder_path": "/new/path" }',
						);
					}

					const providedSlug = body.slug as string | undefined;
					const providedPath = body.folder_path as string | undefined;

					let entryBySlug: FolderEntry | undefined;
					let entryByPath: FolderEntry | undefined;

					if (providedSlug && providedSlug.trim()) {
						entryBySlug = registry.get(providedSlug.trim());
					}
					if (providedPath && providedPath.trim()) {
						for (const e of registry.values()) {
							if (e.path === providedPath.trim()) {
								entryByPath = e;
								break;
							}
						}
					}

					const entryToUpdate = entryBySlug || entryByPath;
					const lookupWasBySlug = !!entryBySlug;

					if (!providedSlug?.trim() && !providedPath?.trim()) {
						logRequest(method, pathname, 400);
						return err(
							"PUT requires at least one identifier field. Provide a 'slug' or 'folder_path' to locate the entry.",
							400,
							undefined,
							'Example: PUT with { "slug": "current-slug", "folder_path": "/new/path" } to update the path.',
						);
					}

					if (!entryToUpdate) {
						logRequest(method, pathname, 404);
						return err(
							`No registration found with slug '${providedSlug || ""}' or path '${providedPath || ""}'.`,
							404,
							{
								slug: providedSlug || undefined,
								folder_path: providedPath || undefined,
							},
							"Use GET / to list all registered folders and their slugs.",
						);
					}

					const changes: Record<string, { from: string; to: string }> = {};
					let updateSlug: string | null = null;
					let updatePath: string | null = null;

					if (providedSlug?.trim() && providedPath?.trim()) {
						if (lookupWasBySlug) {
							if (providedPath.trim() !== entryToUpdate.path)
								updatePath = providedPath.trim();
						} else {
							if (providedSlug.trim() !== entryToUpdate.slug)
								updateSlug = providedSlug.trim();
						}
					} else if (providedSlug?.trim() && !providedPath?.trim()) {
						if (lookupWasBySlug) {
							logRequest(method, pathname, 400);
							return err(
								"PUT requires at least one update field. Provide a new 'slug' or 'folder_path' to change.",
								400,
								undefined,
								'Example: PUT with { "slug": "current-slug", "folder_path": "/new/path" } to update the path.',
							);
						}
						updateSlug = providedSlug.trim();
					} else if (providedPath?.trim() && !providedSlug?.trim()) {
						if (entryByPath) {
							logRequest(method, pathname, 400);
							return err(
								"PUT requires at least one update field. Provide a new 'slug' or 'folder_path' to change.",
								400,
								undefined,
								'Example: PUT with { "slug": "current-slug", "folder_path": "/new/path" } to update the path.',
							);
						}
						updatePath = providedPath.trim();
					}

					if (!updateSlug && !updatePath) {
						logRequest(method, pathname, 400);
						return err(
							"PUT requires at least one update field. Provide a new 'slug' or 'folder_path' to change.",
							400,
							undefined,
							'Example: PUT with { "slug": "current-slug", "folder_path": "/new/path" } to update the path.',
						);
					}

					if (updateSlug) {
						const validation = validateSlug(updateSlug);
						if (!validation.valid) {
							logRequest(method, pathname, 400);
							return err(
								`Invalid slug '${updateSlug}'. ${validation.reason}`,
								400,
								{ field: "slug", value: updateSlug, reason: validation.reason },
								"Choose a different slug or omit it to keep the current one.",
							);
						}
						for (const [key, e] of registry.entries()) {
							if (key !== entryToUpdate.slug && key === updateSlug) {
								logRequest(method, pathname, 409);
								return err(
									`Slug '${updateSlug}' is already in use by '${e.path}'.`,
									409,
									{ slug: updateSlug, existing_path: e.path },
									"Choose a different slug or omit it to keep the current one.",
								);
							}
						}
					}

					if (updatePath) {
						if (!updatePath.startsWith("/")) {
							logRequest(method, pathname, 400);
							return err(
								`New path '${updatePath}' is not absolute.`,
								400,
								{ field: "folder_path", value: updatePath },
								"Provide a valid absolute path to an existing, readable directory.",
							);
						}
						try {
							const s = await stat(updatePath);
							if (!s.isDirectory()) {
								logRequest(method, pathname, 400);
								return err(
									`New directory '${updatePath}' does not exist or is not accessible.`,
									400,
									{ field: "folder_path", value: updatePath },
									"Provide a valid absolute path to an existing, readable directory.",
								);
							}
						} catch {
							logRequest(method, pathname, 400);
							return err(
								`New directory '${updatePath}' does not exist or is not accessible.`,
								400,
								{ field: "folder_path", value: updatePath },
								"Provide a valid absolute path to an existing, readable directory.",
							);
						}
					}

					const oldSlug = entryToUpdate.slug;
					const oldPath = entryToUpdate.path;

					if (updateSlug) {
						registry.delete(oldSlug);
						entryToUpdate.slug = updateSlug;
						changes.slug = { from: oldSlug, to: updateSlug };
					}

					if (updatePath) {
						entryToUpdate.path = updatePath;
						changes.path = { from: oldPath, to: updatePath };
					}

					entryToUpdate.updatedAt = new Date();
					registry.set(entryToUpdate.slug, entryToUpdate);
					saveRegistry();

					const changeDesc = Object.entries(changes)
						.map(([k, v]) => `${k} changed from '${v.from}' to '${v.to}'`)
						.join("; ");

					logRequest(method, pathname, 200);
					return ok(
						`Folder registration updated. ${changeDesc}.`,
						{
							slug: entryToUpdate.slug,
							path: entryToUpdate.path,
							url: `http://localhost:${PORT}/${entryToUpdate.slug}`,
							subdomain_url: `http://${entryToUpdate.slug}.localhost:${PORT}`,
							changes,
							updated_at: entryToUpdate.updatedAt.toISOString(),
						},
						"Files are now accessible at the new URL. The old URL returns 404.",
					);
				}

				default:
					logRequest(method, pathname, 405);
					return err(
						`Method ${method} is not allowed on this resource.`,
						405,
						{ method },
						"Use GET, POST, DELETE, or PUT.",
					);
			}
		}

		// ── File serving ────────────────────────────────────────────────────────
		if (method !== "GET" && method !== "HEAD") {
			logRequest(method, pathname, 405);
			return err(
				`Method ${method} is not allowed for file serving.`,
				405,
				{ method },
				"Use GET to access files.",
			);
		}

		let slug: string | null = null;
		let relativePath: string = "";

		if (subdomainSlug) {
			slug = subdomainSlug;
			relativePath = pathname.replace(/^\//, "");
		} else {
			const segments = pathname.split("/").filter(Boolean);
			if (segments.length === 0) {
				return new Response("Not found", { status: 404 });
			}
			slug = segments[0]!;
			relativePath = segments.slice(1).join("/");
		}

		// Case-insensitive slug lookup (DNS is case-insensitive)
		if (!slug) {
			logRequest(method, pathname, 404);
			return err("No slug found.", 404);
		}
		let entry = registry.get(slug);
		if (!entry) {
			const lowerSlug = slug.toLowerCase();
			for (const [key, val] of registry.entries()) {
				if (key.toLowerCase() === lowerSlug) {
					entry = val;
					break;
				}
			}
		}
		if (!entry) {
			logRequest(method, pathname, 404);
			return err(
				`Slug '${slug}' not found. Use GET / to list registered folders.`,
				404,
				{ slug },
				"Register a folder with POST / to create a new slug.",
			);
		}

		const resolvedFolderRoot = resolve(entry.path);
		let resolvedFilePath: string;
		if (relativePath === "" || relativePath === "/") {
			resolvedFilePath = resolvedFolderRoot;
		} else {
			resolvedFilePath = resolve(entry.path, relativePath);
		}

		if (!isPathSafe(resolvedFilePath, resolvedFolderRoot)) {
			logRequest(method, pathname, 403);
			return err(
				"Access denied. The requested path attempts to escape the registered folder.",
				403,
				{ slug, requested_path: relativePath },
				"Only paths within the registered folder are accessible.",
			);
		}

		let fileStat;
		try {
			fileStat = statSync(resolvedFilePath);
		} catch {
			logRequest(method, pathname, 404);
			return err(
				`File '${relativePath}' not found in folder '${slug}'.`,
				404,
				{
					slug,
					requested_path: relativePath,
					folder_path_display: `.../${basename(entry.path)}`,
				},
				"Check the filename and path within the folder. Use trailing slash (e.g., /documents-a3k9xZ/) for directory listing.",
			);
		}

		if (fileStat.isDirectory()) {
			if (!pathname.endsWith("/")) {
				logRequest(method, pathname, 301);
				return new Response(null, {
					status: 301,
					headers: { Location: pathname + "/" },
				});
			}

			let dirEntries: Array<{ name: string; isDir: boolean; size: number }> =
				[];
			try {
				const dirContents = await readdir(resolvedFilePath, {
					withFileTypes: true,
				});
				const filePromises = dirContents.map(
					async (d: { name: string; isDirectory: () => boolean }) => {
						const fullPath = join(resolvedFilePath, d.name);
						try {
							const s = await stat(fullPath);
							return { name: d.name, isDir: d.isDirectory(), size: s.size };
						} catch {
							return { name: d.name, isDir: d.isDirectory(), size: 0 };
						}
					},
				);
				dirEntries = await Promise.all(filePromises);
			} catch {
				logRequest(method, pathname, 500);
				return err(
					"Unable to read directory contents.",
					500,
					{ slug, requested_path: relativePath },
					"Check that the directory is readable.",
				);
			}

			dirEntries.sort((a, b) => {
				if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
				return a.name.localeCompare(b.name);
			});

			const html = buildDirListing(dirEntries, relativePath, slug);
			logRequest(method, pathname, 200);
			return new Response(html, {
				status: 200,
				headers: {
					"Content-Type": "text/html; charset=utf-8",
					"X-Slug": slug,
				},
			});
		}

		const etag = generateETag(slug, fileStat.size, fileStat.mtimeMs);
		const lastModified = httpDate(fileStat.mtimeMs);

		const ifNoneMatch = req.headers.get("if-none-match");
		if (ifNoneMatch && ifNoneMatch === etag) {
			logRequest(method, pathname, 304);
			return new Response(null, {
				status: 304,
				headers: { ETag: etag, "Last-Modified": lastModified },
			});
		}

		const ifModifiedSince = req.headers.get("if-modified-since");
		if (ifModifiedSince) {
			const imsDate = new Date(ifModifiedSince);
			if (!isNaN(imsDate.getTime()) && imsDate.getTime() >= fileStat.mtimeMs) {
				logRequest(method, pathname, 304);
				return new Response(null, {
					status: 304,
					headers: { ETag: etag, "Last-Modified": lastModified },
				});
			}
		}

		const rangeHeader = req.headers.get("range");
		const rangeResult = parseRange(rangeHeader, fileStat.size);

		const file = Bun.file(resolvedFilePath);
		let body: any;
		let status = 200;
		const responseHeaders: Record<string, string> = {
			"Content-Type": file.type || "application/octet-stream",
			"Content-Length": String(fileStat.size),
			"X-Slug": slug,
			"X-Folder-Path": basename(entry.path),
			ETag: etag,
			"Last-Modified": lastModified,
			"Cache-Control": "public, max-age=3600",
			"Accept-Ranges": "bytes",
		};

		if (rangeResult) {
			status = rangeResult.status;
			body = file.slice(rangeResult.start, rangeResult.end);
			responseHeaders["Content-Length"] = String(rangeResult.contentLength);
			responseHeaders["Content-Range"] = rangeResult.contentRange;
		} else {
			body = method === "HEAD" ? null : (file ?? null);
		}

		logRequest(method, pathname, status);
		return new Response(body, { status, headers: responseHeaders });
	},
});

console.log(`Local HTTP File Server running at http://${HOST}:${PORT}`);
console.log(`API: http://localhost:${PORT}/`);
console.log(`Dashboard: http://localhost:${PORT}/ (browser)`);
