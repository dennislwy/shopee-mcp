#!/usr/bin/env node
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerSearchTools } from './tools/search.js';
import { registerProductTools } from './tools/product.js';
import { registerVariantTools } from './tools/variants.js';
import { registerStatusTools } from './tools/status.js';
import { closeContext, DEBUG } from './browser/session.js';

// Read the version from package.json at runtime so it can't drift from the
// published package version (this file previously hardcoded a stale string).
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8')) as {
  version: string;
};

async function main() {
  const server = new McpServer({
    name: 'shopee-mcp',
    version: pkg.version,
  });

  // Register tool groups. Every tool runs through the shared, logged-in browser
  // session (see src/browser/session.ts) — sign in once with `npm run login`.
  registerSearchTools(server);
  registerProductTools(server);
  registerVariantTools(server);
  registerStatusTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (DEBUG) {
    process.stderr.write('[shopee-mcp] Server started via stdio (browser-backed discovery)\n');
  }
}

// Tidy up the browser on shutdown.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void closeContext().finally(() => process.exit(0));
  });
}

main().catch((err) => {
  process.stderr.write(`[shopee-mcp] Fatal error: ${err}\n`);
  process.exit(1);
});
