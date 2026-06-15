import { readdir } from "node:fs/promises";
import { statSync } from "node:fs";
import * as path from "node:path";
import { config, logRequest } from "./cli.js";
import { registry } from "./registry.js";
import {
	handleList,
	handleRegister,
	handleUnregister,
	handleUpdate,
} from "./handlers.js";
import {
	ok,
	err,
	isPathSafe,
	extractSubdomain,
	parseRange,
	generateETag,
	httpDate,
	buildDirListing,
} from "./utils.js";

export async function fetchHandler(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const method = req.method.toUpperCase();
	const pathname = decodeURIComponent(url.pathname);
	const hostname = url.hostname;
	const subdomainSlug = extractSubdomain(hostname);

	// ── API routes: exact path "/" ──────────────────────────────────────────
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

	// Case-insensitive slug lookup
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

	const resolvedFolderRoot = path.resolve(entry.path);
	let resolvedFilePath: string;
	if (relativePath === "" || relativePath === "/") {
		resolvedFilePath = resolvedFolderRoot;
	} else {
		resolvedFilePath = path.resolve(entry.path, relativePath);
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
				folder_path_display: `.../${path.basename(entry.path)}`,
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

		let dirEntries: Array<{
			name: string;
			isDir: boolean;
			size: number;
		}> = [];
		try {
			const dirContents = await readdir(resolvedFilePath, {
				withFileTypes: true,
			});
			const filePromises = dirContents.map(
				async (d: { name: string; isDirectory: () => boolean }) => {
					const fullPath = path.join(resolvedFilePath, d.name);
					try {
						const s = statSync(fullPath);
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

		const html = buildDirListing(dirEntries, relativePath, slug!);
		logRequest(method, pathname, 200);
		return new Response(html, {
			status: 200,
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"X-Slug": slug!,
			},
		});
	}

	const etag = generateETag(slug!, fileStat.size, fileStat.mtimeMs);
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
	let body: Blob | null;
	let status = 200;
	const responseHeaders: Record<string, string> = {
		"Content-Type": file.type || "application/octet-stream",
		"Content-Length": String(fileStat.size),
		"X-Slug": slug!,
		"X-Folder-Path": path.basename(entry!.path),
		ETag: etag,
		"Last-Modified": lastModified,
		"Cache-Control": "public, max-age=3600",
		"Accept-Ranges": "bytes",
	};

	if (rangeResult) {
		status = rangeResult.status;
		body = file.slice(rangeResult.start, rangeResult.end);
		responseHeaders["Content-Length"] = String(rangeResult!.contentLength);
		responseHeaders["Content-Range"] = rangeResult!.contentRange;
	} else {
		body = method === "HEAD" ? null : (file ?? null);
	}

	logRequest(method, pathname, status);
	return new Response(body, { status, headers: responseHeaders });
}

function startHttpServer(): Bun.Server<unknown> {
	const server = Bun.serve({
		hostname: config.host,
		port: config.port,
		fetch: fetchHandler,
	});
	return server;
}

export { startHttpServer };
