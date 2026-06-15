# First npm dependency: @modelcontextprotocol/sdk

**Status:** accepted

The project adds its first external dependency, `@modelcontextprotocol/sdk`, to support MCP stdio server mode. This breaks the zero-deps rule established in the project's design principles.

## Context

The project was designed as a zero-dependency Bun application — no npm packages beyond type definitions (`@types/bun`, `@types/node`). Adding MCP stdio mode required implementing JSON-RPC 2.0 and the MCP protocol (initialize handshake, tools/list, tools/call, error framing). Two paths were considered:

1. **Manual implementation** (~250 lines of hand-rolled JSON-RPC + MCP protocol code) — preserves zero-deps but adds maintenance burden and edge-case risk (stdin chunking, error codes, lifecycle).
2. **@modelcontextprotocol/sdk** (~30 lines using `Server` class + `StdioServerTransport`) — leverages battle-tested protocol handling; first runtime dependency.

## Decision

Use `@modelcontextprotocol/sdk` (full integration — `Server` class, not just types). The SDK handles JSON-RPC framing, the initialize/initialized handshake, tool registration, error formatting, and graceful shutdown. The ~200 lines saved outweigh the philosophical cost of a single well-maintained dependency.

## Consequences

- `package.json` gains a runtime dependency (not dev-only).
- The zero-deps claim in SPEC.md §2 and CONTEXT.md needs updating.
- Future dependency additions should carry the same bar: does the SDK save significant complexity vs. rolling it ourselves?
