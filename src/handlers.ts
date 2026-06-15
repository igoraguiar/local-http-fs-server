import { stat } from "node:fs/promises";
import { config } from "./cli.js";
import {
	registry,
	generateSlug,
	validateSlug,
	saveRegistry,
	type FolderEntry,
} from "./registry.js";

// ─── Shared CRUD Result ───────────────────────────────────────────────────────

interface CrudResult {
	ok: boolean;
	status: number;
	message: string;
	data?: Record<string, unknown>;
	details?: Record<string, unknown>;
	hint?: string;
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

export {
	handleList,
	handleRegister,
	handleUnregister,
	handleUpdate,
	type CrudResult,
};
