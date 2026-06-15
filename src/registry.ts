import { statSync, readFileSync, writeFileSync } from "node:fs";
import { config, log } from "./cli.js";
import {
	generateSlug as generateSlugFn,
	validateSlug as validateSlugFn,
} from "./slug.js";

// ─── Data Model ───────────────────────────────────────────────────────────────

interface FolderEntry {
	slug: string;
	path: string;
	createdAt: Date;
	updatedAt: Date;
}

const registry: Map<string, FolderEntry> = new Map();

// Re-export slug functions with registry bound
async function generateSlug(folderPath: string): Promise<string> {
	return generateSlugFn(folderPath, registry);
}

function validateSlug(slug: string):
	| {
			valid: true;
	  }
	| { valid: false; reason: string; isConflict?: true } {
	return validateSlugFn(slug, registry);
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

export { registry, generateSlug, validateSlug, saveRegistry, type FolderEntry };
