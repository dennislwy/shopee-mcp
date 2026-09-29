/**
 * Live smoke test / health check.
 *
 * Spawns the real MCP server over stdio and calls each tool against live Shopee
 * through the browser session. Because Shopee gates data behind a login, a PASS
 * means one of two healthy states:
 *   - real product data came back (you are logged in), OR
 *   - the clean "please log in" prompt came back (pipeline works, no session yet).
 *
 * A FAIL means the pipeline itself broke (browser launch, JSON parse, crash).
 *
 * Run with: npm test
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tsxBin = resolve(__dirname, '../node_modules/.bin/tsx');
const serverEntry = resolve(__dirname, '../src/index.ts');

// Markers that mean the pipeline actually broke (vs. data or a login prompt).
const HARD_FAILURES = [
  '❌ Error:',
  'Shopee API Error',
  'Unknown error occurred',
  'Invalid JSON',
  'Browser error',
];

interface Check {
  tool: string;
  /** A thunk so a check can build on what an earlier one returned. */
  args: Record<string, unknown> | (() => Record<string, unknown>);
  // A pass requires at least one of these substrings.
  expect: string[];
  /** Offered the response text, so later checks can use it. */
  capture?: (text: string) => void;
}

/**
 * Product to look up, discovered from the search results rather than hardcoded.
 *
 * A fixed item id is only valid on the region that hosts it: the previous
 * Indonesian fixture returned Shopee error 266900002 ("item not found") against
 * shopee.com.my, and any hardcoded listing can be delisted later. Deriving it
 * keeps this check honest for whatever SHOPEE_DOMAIN is configured, and
 * exercises the real search -> detail path a user follows.
 */
let discovered: { shopId: string; itemId: string } | null = null;

// Used only when search yields nothing to derive from — e.g. signed out, where
// every tool short-circuits to the login prompt regardless of the ids passed.
const PLACEHOLDER = { shopId: '1', itemId: '1' };

const CHECKS: Check[] = [
  {
    tool: 'search_products',
    args: { query: 'laptop', limit: 3 },
    // Either real results, an empty-but-valid result, or the login prompt.
    expect: ['Search Results', 'No products found', 'Not signed in to Shopee'],
    capture: (text) => {
      const m = text.match(/\/product\/(\d+)\/(\d+)/);
      if (m) discovered = { shopId: m[1], itemId: m[2] };
    },
  },
  {
    tool: 'get_product_detail',
    args: () => discovered ?? PLACEHOLDER,
    expect: ['Price:', 'Could not read product', 'Not signed in to Shopee'],
  },
  {
    tool: 'check_login_status',
    args: {},
    expect: ['Logged in to', 'Not logged in to'],
  },
];

async function main() {
  const transport = new StdioClientTransport({
    command: tsxBin,
    args: [serverEntry],
    env: { ...process.env } as Record<string, string>,
  });
  const client = new Client({ name: 'smoke-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log(
    `\n🔌 Connected. Server exposes ${tools.length} tool(s): ${tools.map((t) => t.name).join(', ')}\n`,
  );

  let failures = 0;
  for (const check of CHECKS) {
    let text = '';
    let status: 'PASS' | 'FAIL' = 'FAIL';
    let note: string;
    try {
      const args = typeof check.args === 'function' ? check.args() : check.args;
      const res = (await client.callTool({ name: check.tool, arguments: args })) as {
        content: Array<{ type: string; text?: string }>;
      };
      text = res.content.map((c) => c.text ?? '').join('\n');
      check.capture?.(text);

      const hardFail = HARD_FAILURES.find((m) => text.includes(m));
      if (hardFail) {
        note = `hard failure: "${hardFail}" — ${text.slice(0, 100).replace(/\n/g, ' ')}`;
      } else if (check.expect.some((m) => text.toLowerCase().includes(m.toLowerCase()))) {
        status = 'PASS';
        note = text.includes('Not signed in')
          ? 'login prompt (pipeline OK, no session)'
          : 'returned data';
      } else {
        note = `unexpected — got: ${text.slice(0, 100).replace(/\n/g, ' ')}`;
      }
    } catch (err) {
      note = `threw: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (status === 'FAIL') failures++;
    console.log(`${status === 'PASS' ? '✅' : '❌'} ${check.tool.padEnd(20)} ${note}`);
  }

  await client.close();
  console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
