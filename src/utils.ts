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
		const sizeLabel = entry.isDir ? "&lt;dir&gt;" : `${entry.size} B`;
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

export {
	ok,
	err,
	isPathSafe,
	extractSubdomain,
	parseRange,
	generateETag,
	httpDate,
	buildDirListing,
};
export type { RangeResult };
