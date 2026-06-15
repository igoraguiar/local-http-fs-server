import { basename } from "node:path";

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

// ─── Slug Validator ───────────────────────────────────────────────────────────

const SLUG_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function validateSlug(
	slug: string,
	registry: Map<string, FolderEntry>,
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

async function generateSlug(
	folderPath: string,
	registry: Map<string, FolderEntry>,
): Promise<string> {
	const base = normalizeSlugBase(folderPath);
	for (let attempt = 0; attempt < 3; attempt++) {
		const candidate = `${base}-${randomSuffix()}`;
		if (!registry.has(candidate)) return candidate;
	}
	return `${base}-${randomSuffix(12)}`;
}

export {
	randomSuffix,
	normalizeSlugBase,
	validateSlug,
	generateSlug,
	SLUG_REGEX,
};

// Forward-declare FolderEntry for type usage in validateSlug/generateSlug
interface FolderEntry {
	slug: string;
	path: string;
	createdAt: Date;
	updatedAt: Date;
}
