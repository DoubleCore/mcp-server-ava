/**
 * End-to-end smoke test against the built stdio binary.
 *
 * Run after `npm run build`:
 *   node scripts/smoke.mjs
 *
 * It spawns the real CLI over stdio, loads data, runs SQL, and — when
 * OPENAI_API_KEY is set — asks AVA a natural-language question and requests a
 * chart. Exits non-zero on the first failure so CI can gate on it.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';

const CSV = 'region,product,sales\nEast,Laptop,3\nWest,Laptop,7\nNorth,Monitor,5\nWest,Monitor,6\n';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(import.meta.dirname, '../dist/cli.js')],
  env: { ...process.env },
  stderr: 'inherit',
});

const client = new Client({ name: 'ava-mcp-smoke', version: '1.0.0' });
await client.connect(transport);

function body(result) {
  return JSON.parse(result.content[0].text);
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const { tools } = await client.listTools();
assert(tools.length === 8, `expected 8 tools, got ${tools.length}`);
console.log(`✓ listed ${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`);

const loaded = await client.callTool({ name: 'ava_load_data', arguments: { source: { type: 'csv', csv: CSV } } });
const schema = body(loaded);
assert(schema.tables[0].columns.length === 3, 'schema did not report three columns');
console.log(`✓ loaded CSV → ${schema.tables[0].name}(${schema.tables[0].columns.map((c) => c.name).join(', ')})`);

const query = body(
  await client.callTool({
    name: 'ava_query',
    arguments: { sql: 'SELECT region, SUM(sales) AS total FROM data GROUP BY region ORDER BY total DESC' },
  })
);
assert(query.rows.length === 3 && query.rows[0].region === 'West', 'aggregate query returned unexpected rows');
console.log(`✓ SQL aggregate → ${JSON.stringify(query.rows)}`);

if (process.env.OPENAI_API_KEY) {
  const analyzed = body(
    await client.callTool({ name: 'ava_analyze', arguments: { question: 'Which region sells the most?' } })
  );
  assert(analyzed.text.length > 0, 'analyze returned no summary');
  console.log(`✓ analyze → ${analyzed.text.slice(0, 120)}`);

  const chart = body(
    await client.callTool({ name: 'ava_visualize', arguments: { question: 'Sales by region', data: query.rows } })
  );
  assert(chart.chartType, 'visualize did not recommend a chart');
  console.log(`✓ visualize → ${chart.chartType}`);
} else {
  console.log('- skipped AI tools (OPENAI_API_KEY not set)');
}

await client.close();
console.log('smoke test passed');
process.exit(0);
