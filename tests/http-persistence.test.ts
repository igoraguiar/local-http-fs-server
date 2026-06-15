import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, rm, access, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function waitForPort(port: number, timeout = 5000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		try {
			const resp = await fetch(`http://localhost:${port}/`, {
				method: "GET",
				headers: { Accept: "application/json" },
			});
			if (resp.ok) return;
		} catch {
			// Server not ready yet
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`Timeout waiting for port ${port}`);
}

type ChildProcess = ReturnType<typeof Bun.spawn>;

function spawnServer(
	extraArgs: string[] = [],
	envOverrides: Record<string, string> = {},
): ChildProcess {
	const child = Bun.spawn(
		[
			"bun",
			"run",
			"src/index.ts",
			"--port",
			"0",
			"--print-template",
			"$port",
			...extraArgs,
		],
		{
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, PERSIST: "true", ...envOverrides },
		},
	);

	return child;
}

async function discoverPort(
	child: ChildProcess,
): Promise<{ port: number; baseUrl: string }> {
	const stdout = child.stdout as ReadableStream<Uint8Array>;
	const reader = stdout.getReader();
	const decoder = new TextDecoder();
	let accumulated = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			accumulated += decoder.decode(value, { stream: true });

			// Check each line in the accumulated output
			const lines = accumulated.split("\n");
			// Keep the last partial line
			accumulated = lines.pop() || "";

			for (const line of lines) {
				const trimmed = line.trim();
				const match = trimmed.match(/^(\d{4,5})$/);
				if (match) {
					const port = parseInt(match[1]!, 10);
					await waitForPort(port);
					return { port, baseUrl: `http://localhost:${port}` };
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
	throw new Error("Failed to discover server port");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("HTTP Persistence (spawned server)", () => {
	let tempDir: string;
	let workDir: string;
	let child: ChildProcess | null = null;
	let baseUrl: string = "";

	afterEach(async () => {
		if (child) {
			child.kill();
			child = null;
		}
		if (workDir) {
			// Clean up registry.json
			const registryPath = path.join(workDir, "registry.json");
			try {
				await rm(registryPath, { force: true });
			} catch {
				// ignore
			}
		}
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("registry.json exists after registration", async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "persist-test-"));
		workDir = await mkdtemp(path.join(tmpdir(), "persist-work-"));
		const registryPath = path.join(workDir, "registry.json");

		child = spawnServer(["--persist=" + registryPath]);
		const { baseUrl: url } = await discoverPort(child!);
		baseUrl = url;

		// Register a folder
		const res = await fetch(`${baseUrl}/`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ folder_path: tempDir }),
		});
		expect(res.status).toBe(201);

		// Check registry.json exists
		let fileExists = false;
		try {
			await access(registryPath);
			fileExists = true;
		} catch {
			// file doesn't exist
		}
		expect(fileExists).toBe(true);
	});

	it("registry.json has valid JSON with slug field", async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "persist-test-"));
		workDir = await mkdtemp(path.join(tmpdir(), "persist-work-"));
		const registryPath = path.join(workDir, "registry.json");

		child = spawnServer(["--persist=" + registryPath]);
		const { baseUrl: url } = await discoverPort(child!);
		baseUrl = url;

		// Register a folder
		const res = await fetch(`${baseUrl}/`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ folder_path: tempDir }),
		});
		expect(res.status).toBe(201);

		// Read and validate registry.json
		const content = await readFile(registryPath, "utf-8");
		const entries = JSON.parse(content) as Array<{
			slug: string;
			path: string;
		}>;
		expect(entries.length).toBeGreaterThan(0);
		expect(entries[0]!.slug).toBeDefined();
		expect(entries[0]!.path).toBe(tempDir);
	});

	it("folder survives process restart", async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "persist-test-"));
		workDir = await mkdtemp(path.join(tmpdir(), "persist-work-"));
		const registryPath = path.join(workDir, "registry.json");

		// First server: register a folder
		child = spawnServer(["--persist=" + registryPath]);
		const { baseUrl: url1 } = await discoverPort(child!);

		const regRes = await fetch(`${url1}/`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ folder_path: tempDir, slug: "survives-test" }),
		});
		expect(regRes.status).toBe(201);

		// Kill first server
		child!.kill();
		child = null;

		// Second server: restart with same registry
		child = spawnServer(["--persist=" + registryPath]);
		const { baseUrl: url2 } = await discoverPort(child!);

		// Check folder is still registered
		const listRes = await fetch(`${url2}/`, {
			headers: { Accept: "application/json" },
		});
		expect(listRes.status).toBe(200);
		const json = (await listRes.json()) as {
			data: { count: number; folders: Array<{ slug: string }> };
		};
		expect(json.data.count).toBeGreaterThan(0);
		expect(json.data.folders.some((f) => f.slug === "survives-test")).toBe(
			true,
		);
	});

	it("stale entry skipped on reload", async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "persist-test-"));
		workDir = await mkdtemp(path.join(tmpdir(), "persist-work-"));
		const registryPath = path.join(workDir, "registry.json");

		// First server: register a folder
		child = spawnServer(["--persist=" + registryPath]);
		const { baseUrl: url1 } = await discoverPort(child!);

		const regRes = await fetch(`${url1}/`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				folder_path: tempDir,
				slug: "stale-test",
			}),
		});
		expect(regRes.status).toBe(201);

		// Kill first server
		child!.kill();
		child = null;

		// Brief pause to ensure file handle is released
		await new Promise((r) => setTimeout(r, 200));

		// Corrupt registry.json with non-existent paths
		await writeFile(
			registryPath,
			JSON.stringify([
				{
					slug: "stale-test",
					path: "/nonexistent-stale-path",
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				},
			]),
			"utf-8",
		);

		// Restart server
		child = spawnServer(["--persist=" + registryPath]);
		const { baseUrl: url2 } = await discoverPort(child!);

		// Check stale entry was skipped
		const listRes = await fetch(`${url2}/`, {
			headers: { Accept: "application/json" },
		});
		const json = (await listRes.json()) as { data: { count: number } };
		expect(json.data.count).toBe(0);
	});

	it("no persistence = empty registry", async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "persist-test-"));
		workDir = await mkdtemp(path.join(tmpdir(), "persist-work-"));

		// Start server without persistence (PERSIST not set to "true")
		child = spawnServer([], { PERSIST: "" });
		const { baseUrl: url } = await discoverPort(child!);

		// Registry should be empty (persistence disabled, no entries loaded)
		const listRes = await fetch(`${url}/`, {
			headers: { Accept: "application/json" },
		});
		const json = (await listRes.json()) as { data: { count: number } };
		expect(json.data.count).toBe(0);
	});
});
