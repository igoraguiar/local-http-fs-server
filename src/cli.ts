// ─── CLI Config ───────────────────────────────────────────────────────────────

interface CliConfig {
	port: number;
	host: string;
	mcpStdio: boolean;
	persist: boolean;
	registryFile: string;
	printTemplate?: string;
}

function parseCliArgs(): CliConfig {
	const args = process.argv.slice(2);
	let port = parseInt(process.env.PORT || "6868", 10);
	const host = "0.0.0.0";
	let mcpStdio = false;
	let persist = process.env.PERSIST === "true";
	let registryFile = "registry.json";
	let printTemplate: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--mcp" && args[i + 1] === "stdio") {
			mcpStdio = true;
			i++;
		} else if (arg === "--port" && args[i + 1]) {
			port = parseInt(args[i + 1]!, 10);
			i++;
		} else if (arg.startsWith("--port=")) {
			port = parseInt(arg.split("=")[1]!, 10);
		} else if (arg === "--persist") {
			persist = true;
		} else if (arg.startsWith("--persist=")) {
			persist = true;
			const val = arg.split("=")[1];
			if (val) registryFile = val;
		} else if (arg === "--print-template" && args[i + 1]) {
			printTemplate = args[i + 1]!;
			i++;
		}
	}

	if (isNaN(port) || port < 0 || port > 65535) {
		console.error(`Invalid port: ${port}. Using default 6868.`);
		port = 6868;
	}

	return { port, host, mcpStdio, persist, registryFile, printTemplate };
}

const config = parseCliArgs();

// stdout carries MCP JSON-RPC when active; all logs go to stderr
const log = config.mcpStdio
	? console.error.bind(console)
	: console.log.bind(console);

function logRequest(method: string, path: string, status: number): void {
	log(`[${new Date().toISOString()}] ${method} ${path} → ${status}`);
}

export { config, log, logRequest, type CliConfig };
