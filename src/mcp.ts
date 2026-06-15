import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	handleList,
	handleRegister,
	handleUnregister,
	handleUpdate,
} from "./handlers.js";

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
				folder_path: z
					.string()
					.describe("Absolute path to an existing, readable directory."),
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
				slug: z
					.string()
					.optional()
					.describe("Slug of the folder to unregister."),
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

	server.registerTool(
		"list_folders",
		{
			description:
				"List all registered folders with their slugs, paths, and URLs.",
			inputSchema: z.object({}),
		},
		async () => {
			const result = handleList();
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
				isError: !result.ok,
			};
		},
	);

	return server;
}

export { createMcpServer };
