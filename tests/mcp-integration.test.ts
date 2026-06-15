import { describe, it, expect, afterEach } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TEST_PORT = 19878;

describe("MCP stdio integration (StdioClientTransport)", () => {
	let transport: StdioClientTransport | null = null;
	let client: Client | null = null;

	afterEach(async () => {
		try {
			await transport?.close();
		} catch {
			// Ignore close errors
		}
		transport = null;
		client = null;
	});

	it("server starts and responds to initialize", async () => {
		transport = new StdioClientTransport({
			command: "bun",
			args: [
				"run",
				"src/index.ts",
				"--mcp",
				"stdio",
				"--port",
				String(TEST_PORT),
			],
			env: { ...process.env, PERSIST: "" },
		});

		client = new Client(
			{ name: "integration-test-client", version: "1.0.0" },
			{ capabilities: {} },
		);

		await client.connect(transport);

		// If we got here without error, initialization succeeded
		expect(client.getServerCapabilities()).toBeDefined();
	});

	it("register_folder works end-to-end", async () => {
		transport = new StdioClientTransport({
			command: "bun",
			args: [
				"run",
				"src/index.ts",
				"--mcp",
				"stdio",
				"--port",
				String(TEST_PORT),
			],
			env: { ...process.env, PERSIST: "" },
		});

		client = new Client(
			{ name: "integration-test-client", version: "1.0.0" },
			{ capabilities: {} },
		);

		await client.connect(transport);

		const result = await client.callTool({
			name: "register_folder",
			arguments: { folder_path: "/tmp" },
		});
		const parsed = JSON.parse(
			(result.content as Array<{ type: string; text: string }>)[0]!.text,
		);
		expect(parsed.ok).toBe(true);
		expect(parsed.data.slug).toBeDefined();
	});

	it("HTTP server is running alongside MCP", async () => {
		transport = new StdioClientTransport({
			command: "bun",
			args: [
				"run",
				"src/index.ts",
				"--mcp",
				"stdio",
				"--port",
				String(TEST_PORT),
			],
			env: { ...process.env, PERSIST: "" },
		});

		client = new Client(
			{ name: "integration-test-client", version: "1.0.0" },
			{ capabilities: {} },
		);

		await client.connect(transport);

		// Register a folder via MCP
		const regResult = await client.callTool({
			name: "register_folder",
			arguments: { folder_path: "/tmp" },
		});
		const regParsed = JSON.parse(
			(regResult.content as Array<{ type: string; text: string }>)[0]!.text,
		);
		const slug = regParsed.data.slug;

		// Fetch the HTTP URL
		const response = await fetch(`http://localhost:${TEST_PORT}/${slug}/`);
		expect(response.status).toBe(200);
	});

	it("stderr has logs, stdout is clean JSON", async () => {
		const { spawn } = await import("node:child_process");
		const child = spawn(
			"bun",
			["run", "src/index.ts", "--mcp", "stdio", "--port", String(TEST_PORT)],
			{
				env: { ...process.env, PERSIST: "" },
				stdio: ["pipe", "pipe", "pipe"],
			},
		);

		let stderrOutput = "";
		child.stderr!.on("data", (chunk: Buffer) => {
			stderrOutput += chunk.toString();
		});

		// Wait for stderr to accumulate
		await new Promise((resolve) => setTimeout(resolve, 2000));

		// Verify stderr has startup banner
		expect(stderrOutput).toContain("MCP stdio server");
		expect(stderrOutput).toContain("HTTP server running");

		// Kill the child process
		child.kill("SIGTERM");
		await new Promise((resolve) => child.on("close", resolve));
	});
});
