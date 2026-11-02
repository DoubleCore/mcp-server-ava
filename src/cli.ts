#!/usr/bin/env node
/**
 * stdio entry point for `ava-mcp-server`.
 *
 * Configure model access through the environment so client configs stay
 * secret-free:
 *   OPENAI_API_KEY, OPENAI_MODEL, OPENAI_BASE_URL
 *   AVA_MCP_MAX_ROWS  — hard cap on rows returned per query (default 200)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createServer } from './index.js';

const maxRows = Number.parseInt(process.env.AVA_MCP_MAX_ROWS ?? '', 10);

const { server, session } = createServer(Number.isFinite(maxRows) && maxRows > 0 ? { maxRows } : {});

const transport = new StdioServerTransport();

async function shutdown(): Promise<void> {
  await session.dispose();
  await server.close();
}

process.on('SIGINT', () => void shutdown().finally(() => process.exit(0)));
process.on('SIGTERM', () => void shutdown().finally(() => process.exit(0)));

await server.connect(transport);
// Anything written to stdout corrupts the protocol, so diagnostics go to stderr.
process.stderr.write(`ava-mcp-server ready (maxRows=${maxRows || 200})\n`);
