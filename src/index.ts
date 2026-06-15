import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config, log } from "./cli.js";
import { saveRegistry } from "./registry.js";
import { createMcpServer } from "./mcp.js";
import { startHttpServer } from "./http.js";

// ─── Startup ──────────────────────────────────────────────────────────────────

startHttpServer();

if (config.mcpStdio) {
	log(
		`MCP stdio server + HTTP server running at http://${config.host}:${config.port}`,
	);
	log(
		`MCP tools: register_folder, unregister_folder, update_folder, list_folders`,
	);

	const mcpServer = createMcpServer();
	const transport = new StdioServerTransport();
	mcpServer.connect(transport);
} else {
	log(`Local HTTP File Server running at http://${config.host}:${config.port}`);
	log(`API: http://localhost:${config.port}/`);
	log(`Dashboard: http://localhost:${config.port}/ (browser)`);
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
