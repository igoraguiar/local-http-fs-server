import { readdir, stat } from "node:fs/promises";
import { statSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

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

// ─── Shared CRUD Result ───────────────────────────────────────────────────────

interface CrudResult {
	ok: boolean;
	status: number;
	message: string;
	data?: Record<string, unknown>;
	details?: Record<string, unknown>;
	hint?: string;
}

// ─── CLI Config ───────────────────────────────────────────────────────────────

interface CliConfig {
	port: number;
	host: string;
	mcpStdio: boolean;
	persist: boolean;
	registryFile: string;
}

function parseCliArgs(): CliConfig {
	const args = process.argv.slice(2);
	let port = parseInt(process.env.PORT || "8080", 10);
	let mcpStdio = false;
	let persist =
		process.env.PERSIST === "true" || process.argv.includes("--persist");
	let registryFile = process.env.REGISTRY_FILE || "registry.json";

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--port" && i + 1 < args.length) {
			port = parseInt(args[++i]!, 10);
		} else if (arg === "--mcp" && i + 1 < args.length) {
			const mode = args[++i]!;
			if (mode === "stdio") mcpStdio = true;
		} else if (arg.startsWith("--persist")) {
			persist = true;
			if (arg.includes("=")) {
				const val = arg.split("=", 2)[1];
				if (val) registryFile = val;
			}
		}
	}

	return { port, host: "0.0.0.0", mcpStdio, persist, registryFile };
}

const config = parseCliArgs();

// stdout carries MCP JSON-RPC when active; all logs go to stderr
const log = config.mcpStdio
	? console.error.bind(console)
	: console.log.bind(console);

function logRequest(method: string, path: string, status: number): void {
	log(`[${new Date().toISOString()}] ${method} ${path} → ${status}`);
}

// ─── Persistence ──────────────────────────────────────────────────────────────

function loadRegistry(): void {
	if (!config.persist) return;
	try {
		const content = readFileSync(config.registryFile, "utf-8");
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
		log(
			`Persistence: loaded ${registry.size} entries from ${config.registryFile}`,
		);
	} catch {
		console.warn(
			`Persistence: could not load ${config.registryFile}, starting with empty registry.`,
		);
	}
}

function saveRegistry(): void {
	if (!config.persist) return;
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
		writeFileSync(
			config.registryFile,
			JSON.stringify(entries, null, 2),
			"utf-8",
		);
	} catch (e) {
		console.error(`Persistence: failed to save registry: ${e}`);
	}
}

loadRegistry();

// ─── MCP Server ───────────────────────────────────────────────────────────────

function createMcpServer(): McpServer {
	const server = new McpServer(
		{ name: "local-http-fs-server", version: "0.1.0" },
		{ capabilities: { tools: {} } },
	);

	server.registerTool(
		"register_folder",
		{
			description:
				"Register a folder to serve over HTTP. Returns the slug and URLs to access files.",
			inputSchema: z.object({
				folder_path: z.string().describe(
					"Absolute path to an existing, readable directory.",
				),
				slug: z
					.string()
					.optional()
					.describe(
						"Optional custom slug. Must match ^[a-z0-9][a-z0-9_-]{0,63}$. Omit to auto-generate.",
					),
			}),
		},
		async (args) => {
			const result = await handleRegister(args);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
				isError: !result.ok,
			};
		},
	);

	server.registerTool(
		"unregister_folder",
		{
			description:
				"Unregister a folder, stopping its HTTP serving. Provide slug or folder_path.",
			inputSchema: z.object({
				slug: z.string().optional().describe("Slug of the folder to unregister."),
				folder_path: z
					.string()
					.optional()
					.describe("Absolute path of the folder to unregister."),
			}),
		},
		async (args) => {
			const result = handleUnregister(args);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
				isError: !result.ok,
			};
		},
	);

	server.registerTool(
		"update_folder",
		{
			description:
				"Update a folder registration (slug or path). Provide slug to identify the entry and folder_path to change its path. If only folder_path is given, it is the lookup key and slug becomes the new slug.",
			inputSchema: z.object({
				slug: z
					.string()
					.optional()
					.describe(
						"Current slug to identify the entry, or new slug if looking up by folder_path.",
					),
				folder_path: z
					.string()
					.optional()
					.describe(
						"Current path to identify the entry, or new path if looking up by slug.",
					),
			}),
		},
		async (args) => {
			const result = await handleUpdate(args);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
				isError: !result.ok,
			};
		},
	);

	server.registerTool("list_folders", {
		description:
			"List all registered folders with their slugs, paths, and URLs.",
		inputSchema: z.object({}),
	}, async () => {
		const result = handleList();
		return {
			content: [{ type: "text" as const, text: JSON.stringify(result) }],
			isError: !result.ok,
		};
	});

	return server;
}

function handleList(): CrudResult {
	const folders: Array<Record<string, unknown>> = [];
	for (const entry of registry.values()) {
		folders.push({
			slug: entry.slug,
			path: entry.path,
			url: `http://localhost:${config.port}/${entry.slug}`,
			subdomain_url: `http://${entry.slug}.localhost:${config.port}`,
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
	return {
		ok: true,
		status: 200,
		message,
		data: { count: folders.length, folders },
		hint,
	};
}

async function handleRegister(
	body: Record<string, unknown>,
): Promise<CrudResult> {
	const folderPath = body.folder_path as string | undefined;
	if (!folderPath) {
		return {
			ok: false,
			status: 400,
			message:
				"Missing required field 'folder_path'. Provide an absolute path to a directory.",
			details: {
				field: "folder_path",
				received: null,
				expected: "string (absolute path to an existing directory)",
			},
			hint: 'Example: POST with { "folder_path": "/home/user/documents" }',
		};
	}

	if (!folderPath.startsWith("/")) {
		return {
			ok: false,
			status: 400,
			message: `Path '${folderPath}' is not absolute. Provide an absolute path starting with '/'.`,
			details: { field: "folder_path", value: folderPath },
			hint: 'Example: POST with { "folder_path": "/home/user/documents" }',
		};
	}

	try {
		const s = await stat(folderPath);
		if (!s.isDirectory()) {
			return {
				ok: false,
				status: 400,
				message: `Path '${folderPath}' exists but is not a directory.`,
				details: { folder_path: folderPath, reason: "not a directory" },
				hint: "Check that the path exists and is a readable directory.",
			};
		}
	} catch (e: unknown) {
		const reason = (e as { code?: string }).code || "UNKNOWN";
		return {
			ok: false,
			status: 400,
			message: `Directory '${folderPath}' does not exist or is not accessible.`,
			details: { folder_path: folderPath, reason },
			hint: "Check that the path exists and is a readable directory.",
		};
	}

	for (const entry of registry.values()) {
		if (entry.path === folderPath) {
			return {
				ok: false,
				status: 409,
				message: `Folder '${folderPath}' is already registered with slug '${entry.slug}'.`,
				details: { folder_path: folderPath, existing_slug: entry.slug },
				hint: "Use PUT to update the existing registration, or DELETE it first and re-register.",
			};
		}
	}

	let slug: string;
	if (body.slug && typeof body.slug === "string" && body.slug.trim()) {
		const validation = validateSlug(body.slug.trim());
		if (!validation.valid) {
			const statusCode = validation.isConflict ? 409 : 400;
			return {
				ok: false,
				status: statusCode,
				message: `Invalid slug '${body.slug.trim()}'. ${validation.reason}`,
				details: {
					field: "slug",
					value: body.slug.trim(),
					reason: validation.reason,
				},
				hint: "Provide a valid slug or omit it to auto-generate a unique one.",
			};
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

	return {
		ok: true,
		status: 201,
		message: `Folder '${slug}' registered at '${folderPath}'. Serving files now.`,
		data: {
			slug,
			path: folderPath,
			url: `http://localhost:${config.port}/${slug}`,
			subdomain_url: `http://${slug}.localhost:${config.port}`,
			registered_at: now.toISOString(),
		},
		hint: `Access files at http://localhost:${config.port}/${slug}/filename.txt or use curl -H "Host: ${slug}.localhost:${config.port}" http://localhost:${config.port}/filename.txt`,
	};
}

function handleUnregister(identifier: {
	slug?: string;
	folder_path?: string;
}): CrudResult {
	const { slug: identifierSlug, folder_path: identifierPath } = identifier;

	if (!identifierSlug && !identifierPath) {
		return {
			ok: false,
			status: 400,
			message:
				"DELETE requires identification. Provide a 'slug' or 'folder_path' as query parameter or in JSON body.",
			hint: 'Example: DELETE /?slug=my-slug or DELETE / with { "slug": "my-slug" }',
		};
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
		return {
			ok: false,
			status: 404,
			message: `No registration found with slug '${identifierSlug || ""}' or path '${identifierPath || ""}'.`,
			details: {
				slug: identifierSlug || undefined,
				folder_path: identifierPath || undefined,
			},
			hint: "Use GET / to list all registered folders and their slugs.",
		};
	}

	registry.delete(entryToRemove.slug);
	saveRegistry();

	return {
		ok: true,
		status: 200,
		message: `Folder '${entryToRemove.slug}' unregistered. Files are no longer accessible.`,
		data: {
			slug: entryToRemove.slug,
			path: entryToRemove.path,
			was_registered_at: entryToRemove.createdAt.toISOString(),
		},
		hint: "Folder contents were not deleted from disk — only the serving registration was removed.",
	};
}

async function handleUpdate(
	body: Record<string, unknown>,
): Promise<CrudResult> {
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
		return {
			ok: false,
			status: 400,
			message:
				"PUT requires at least one identifier field. Provide a 'slug' or 'folder_path' to locate the entry.",
			hint: 'Example: PUT with { "slug": "current-slug", "folder_path": "/new/path" } to update the path.',
		};
	}

	if (!entryToUpdate) {
		return {
			ok: false,
			status: 404,
			message: `No registration found with slug '${providedSlug || ""}' or path '${providedPath || ""}'.`,
			details: {
				slug: providedSlug || undefined,
				folder_path: providedPath || undefined,
			},
			hint: "Use GET / to list all registered folders and their slugs.",
		};
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
			return {
				ok: false,
				status: 400,
				message:
					"PUT requires at least one update field. Provide a new 'slug' or 'folder_path' to change.",
				hint: 'Example: PUT with { "slug": "current-slug", "folder_path": "/new/path" } to update the path.',
			};
		}
		updateSlug = providedSlug.trim();
	} else if (providedPath?.trim() && !providedSlug?.trim()) {
		if (entryByPath) {
			return {
				ok: false,
				status: 400,
				message:
					"PUT requires at least one update field. Provide a new 'slug' or 'folder_path' to change.",
				hint: 'Example: PUT with { "slug": "current-slug", "folder_path": "/new/path" } to update the path.',
			};
		}
		updatePath = providedPath.trim();
	}

	if (!updateSlug && !updatePath) {
		return {
			ok: false,
			status: 400,
			message:
				"PUT requires at least one update field. Provide a new 'slug' or 'folder_path' to change.",
			hint: 'Example: PUT with { "slug": "current-slug", "folder_path": "/new/path" } to update the path.',
		};
	}

	if (updateSlug) {
		const validation = validateSlug(updateSlug);
		if (!validation.valid) {
			return {
				ok: false,
				status: 400,
				message: `Invalid slug '${updateSlug}'. ${validation.reason}`,
				details: {
					field: "slug",
					value: updateSlug,
					reason: validation.reason,
				},
				hint: "Choose a different slug or omit it to keep the current one.",
			};
		}
		for (const [key, e] of registry.entries()) {
			if (key !== entryToUpdate.slug && key === updateSlug) {
				return {
					ok: false,
					status: 409,
					message: `Slug '${updateSlug}' is already in use by '${e.path}'.`,
					details: { slug: updateSlug, existing_path: e.path },
					hint: "Choose a different slug or omit it to keep the current one.",
				};
			}
		}
	}

	if (updatePath) {
		if (!updatePath.startsWith("/")) {
			return {
				ok: false,
				status: 400,
				message: `New path '${updatePath}' is not absolute.`,
				details: { field: "folder_path", value: updatePath },
				hint: "Provide a valid absolute path to an existing, readable directory.",
			};
		}
		try {
			const s = await stat(updatePath);
			if (!s.isDirectory()) {
				return {
					ok: false,
					status: 400,
					message: `New directory '${updatePath}' does not exist or is not accessible.`,
					details: { field: "folder_path", value: updatePath },
					hint: "Provide a valid absolute path to an existing, readable directory.",
				};
			}
		} catch {
			return {
				ok: false,
				status: 400,
				message: `New directory '${updatePath}' does not exist or is not accessible.`,
				details: { field: "folder_path", value: updatePath },
				hint: "Provide a valid absolute path to an existing, readable directory.",
			};
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

	return {
		ok: true,
		status: 200,
		message: `Folder registration updated. ${changeDesc}.`,
		data: {
			slug: entryToUpdate.slug,
			path: entryToUpdate.path,
			url: `http://localhost:${config.port}/${entryToUpdate.slug}`,
			subdomain_url: `http://${entryToUpdate.slug}.localhost:${config.port}`,
			changes,
			updated_at: entryToUpdate.updatedAt.toISOString(),
		},
		hint: "Files are now accessible at the new URL. The old URL returns 404.",
	};
}

process.on("SIGINT", () => {
	log("Shutting down...");
	saveRegistry();
	process.exit(0);
});
process.on("SIGTERM", () => {
	log("Shutting down...");
	saveRegistry();
	process.exit(0);
});

Bun.serve({
	hostname: config.host,
	port: config.port,
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

					const result = handleList();
					logRequest(method, pathname, result.status);
					return result.ok
						? ok(result.message, result.data, result.hint, result.status)
						: err(result.message, result.status, result.details, result.hint);
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

					const result = await handleRegister(body);
					logRequest(method, pathname, result.status);
					return result.ok
						? ok(result.message, result.data, result.hint, result.status)
						: err(result.message, result.status, result.details, result.hint);
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

					const result = handleUnregister({
						slug: querySlug || bodySlug || undefined,
						folder_path: queryPath || bodyPath || undefined,
					});
					logRequest(method, pathname, result.status);
					return result.ok
						? ok(result.message, result.data, result.hint, result.status)
						: err(result.message, result.status, result.details, result.hint);
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

					const result = await handleUpdate(body);
					logRequest(method, pathname, result.status);
					return result.ok
						? ok(result.message, result.data, result.hint, result.status)
						: err(result.message, result.status, result.details, result.hint);
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

// ─── Startup ──────────────────────────────────────────────────────────────────

if (config.mcpStdio) {
	log(
		`MCP stdio server + HTTP server running at http://${config.host}:${config.port}`,
	);
	log(`MCP tools: register_folder, unregister_folder, update_folder, list_folders`);

	const mcpServer = createMcpServer();
	const transport = new StdioServerTransport();
	mcpServer.connect(transport);
} else {
	log(
		`Local HTTP File Server running at http://${config.host}:${config.port}`,
	);
	log(`API: http://localhost:${config.port}/`);
	log(`Dashboard: http://localhost:${config.port}/ (browser)`);
}
