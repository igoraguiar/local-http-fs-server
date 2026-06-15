import { describe, it, expect, beforeEach } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./src/mcp.js";
import { registry } from "./src/registry.js";

describe("MCP tools (InMemoryTransport)", () => {
	let client: Client;
	let serverTransport: InMemoryTransport;
	let clientTransport: InMemoryTransport;

	beforeEach(() => {
		// Clear registry between tests
		registry.clear();

		// Create linked transports
		[serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

		// Create and connect server
		const server = createMcpServer();
		server.connect(serverTransport);

		// Create and connect client
		client = new Client(
			{ name: "test-client", version: "1.0.0" },
			{ capabilities: {} },
		);
		client.connect(clientTransport);
	});

	it("tools/list returns 4 tools", async () => {
		const tools = await client.listTools();
		expect(tools.tools.length).toBe(4);
		const names = tools.tools.map((t) => t.name).sort();
		expect(names).toEqual(
			[
				"list_folders",
				"register_folder",
				"unregister_folder",
				"update_folder",
			].sort(),
		);
	});

	it("list_folders returns empty array on start", async () => {
		const result = await client.callTool({
			name: "list_folders",
			arguments: {},
		});
		const parsed = JSON.parse(
			(result.content as Array<{ type: string; text: string }>)[0]!.text,
		);
		expect(parsed.ok).toBe(true);
		expect(parsed.data.folders).toEqual([]);
	});

	it("register_folder creates entry and returns URL", async () => {
		const testDir = "/tmp";
		const result = await client.callTool({
			name: "register_folder",
			arguments: { folder_path: testDir },
		});
		const parsed = JSON.parse(
			(result.content as Array<{ type: string; text: string }>)[0]!.text,
		);
		expect(parsed.ok).toBe(true);
		expect(parsed.data.slug).toBeDefined();
		expect(parsed.data.path).toBe(testDir);
		expect(parsed.data.url).toContain(parsed.data.slug);

		// Verify list_folders shows it
		const listResult = await client.callTool({
			name: "list_folders",
			arguments: {},
		});
		const listParsed = JSON.parse(
			(listResult.content as Array<{ type: string; text: string }>)[0]!.text,
		);
		expect(listParsed.data.folders.length).toBe(1);
	});

	it("register_folder rejects non-absolute path", async () => {
		const result = await client.callTool({
			name: "register_folder",
			arguments: { folder_path: "relative/path" },
		});
		const parsed = JSON.parse(
			(result.content as Array<{ type: string; text: string }>)[0]!.text,
		);
		expect(parsed.ok).toBe(false);
		expect(result.isError).toBe(true);
	});

	it("register_folder rejects non-existent directory", async () => {
		const result = await client.callTool({
			name: "register_folder",
			arguments: { folder_path: "/nonexistent/path/that/does/not/exist" },
		});
		const parsed = JSON.parse(
			(result.content as Array<{ type: string; text: string }>)[0]!.text,
		);
		expect(parsed.ok).toBe(false);
		expect(result.isError).toBe(true);
	});

	it("register_folder rejects duplicate path", async () => {
		const testDir = "/tmp";
		// Register once
		await client.callTool({
			name: "register_folder",
			arguments: { folder_path: testDir },
		});
		// Register same path again
		const result = await client.callTool({
			name: "register_folder",
			arguments: { folder_path: testDir },
		});
		const parsed = JSON.parse(
			(result.content as Array<{ type: string; text: string }>)[0]!.text,
		);
		expect(parsed.ok).toBe(false);
		expect(result.isError).toBe(true);
	});

	it("register_folder accepts custom slug", async () => {
		const result = await client.callTool({
			name: "register_folder",
			arguments: { folder_path: "/tmp", slug: "my-custom-slug" },
		});
		const parsed = JSON.parse(
			(result.content as Array<{ type: string; text: string }>)[0]!.text,
		);
		expect(parsed.ok).toBe(true);
		expect(parsed.data.slug).toBe("my-custom-slug");
	});

	it("unregister_folder removes entry", async () => {
		// Register first
		const regResult = await client.callTool({
			name: "register_folder",
			arguments: { folder_path: "/tmp" },
		});
		const regParsed = JSON.parse(
			(regResult.content as Array<{ type: string; text: string }>)[0]!.text,
		);
		const slug = regParsed.data.slug;

		// Unregister
		const unregResult = await client.callTool({
			name: "unregister_folder",
			arguments: { slug },
		});
		const unregParsed = JSON.parse(
			(unregResult.content as Array<{ type: string; text: string }>)[0]!.text,
		);
		expect(unregParsed.ok).toBe(true);

		// Verify empty
		const listResult = await client.callTool({
			name: "list_folders",
			arguments: {},
		});
		const listParsed = JSON.parse(
			(listResult.content as Array<{ type: string; text: string }>)[0]!.text,
		);
		expect(listParsed.data.folders.length).toBe(0);
	});

	it("unregister_folder rejects unknown slug", async () => {
		const result = await client.callTool({
			name: "unregister_folder",
			arguments: { slug: "nonexistent-slug" },
		});
		const parsed = JSON.parse(
			(result.content as Array<{ type: string; text: string }>)[0]!.text,
		);
		expect(parsed.ok).toBe(false);
		expect(result.isError).toBe(true);
	});

	it("update_folder changes path", async () => {
		// Register
		const regResult = await client.callTool({
			name: "register_folder",
			arguments: { folder_path: "/tmp" },
		});
		const regParsed = JSON.parse(
			(regResult.content as Array<{ type: string; text: string }>)[0]!.text,
		);
		const slug = regParsed.data.slug;

		// Update path
		const updateResult = await client.callTool({
			name: "update_folder",
			arguments: { slug, folder_path: "/var" },
		});
		const updateParsed = JSON.parse(
			(updateResult.content as Array<{ type: string; text: string }>)[0]!.text,
		);
		expect(updateParsed.ok).toBe(true);
		expect(updateParsed.data.path).toBe("/var");
		expect(updateParsed.data.slug).toBe(slug);
	});

	it("update_folder changes slug", async () => {
		// Register
		await client.callTool({
			name: "register_folder",
			arguments: { folder_path: "/tmp" },
		});
		// Update slug by providing new slug + folder_path lookup
		const updateResult = await client.callTool({
			name: "update_folder",
			arguments: { slug: "new-slug", folder_path: "/tmp" },
		});
		const updateParsed = JSON.parse(
			(updateResult.content as Array<{ type: string; text: string }>)[0]!.text,
		);
		expect(updateParsed.ok).toBe(true);
		expect(updateParsed.data.slug).toBe("new-slug");
		expect(updateParsed.data.path).toBe("/tmp");
	});

	it("list_folders returns all entries", async () => {
		// Register two folders
		await client.callTool({
			name: "register_folder",
			arguments: { folder_path: "/tmp" },
		});
		await client.callTool({
			name: "register_folder",
			arguments: { folder_path: "/var" },
		});

		const result = await client.callTool({
			name: "list_folders",
			arguments: {},
		});
		const parsed = JSON.parse(
			(result.content as Array<{ type: string; text: string }>)[0]!.text,
		);
		expect(parsed.ok).toBe(true);
		expect(parsed.data.folders.length).toBe(2);

		// Each entry has slug, path, url
		for (const entry of parsed.data.folders) {
			expect(entry.slug).toBeDefined();
			expect(entry.path).toBeDefined();
			expect(entry.url).toBeDefined();
		}
	});
});
