import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from '../src/index.js';

const CSV = 'region,product,sales\nEast,Laptop,3\nWest,Laptop,7\nNorth,Monitor,5\nWest,Monitor,6\n';

/** Connect a real MCP client to the in-memory transport pair. */
async function connect(config: Parameters<typeof createServer>[0] = {}) {
  const { server, session } = createServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'vitest', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, session };
}

function textOf(result: { content: unknown }): unknown {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0].text);
}

describe('ava MCP server', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it('lists the AVA tools with titles and schemas', async () => {
    const { client, session } = await connect();
    cleanups.push(() => session.dispose());

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'ava_analyze',
      'ava_load_data',
      'ava_profile',
      'ava_query',
      'ava_schema',
      'ava_suggest',
      'ava_translate',
      'ava_visualize',
    ]);
    const load = tools.find((tool) => tool.name === 'ava_load_data');
    expect(load?.title).toBe('Load data into AVA');
    expect(load?.description).toMatch(/inline CSV/);
    expect(Object.keys((load?.inputSchema as { properties: object }).properties)).toContain('source');
    const query = tools.find((tool) => tool.name === 'ava_query');
    expect(query?.annotations?.readOnlyHint).toBe(true);
  });

  it('loads a dataset over the protocol and returns the schema', async () => {
    const { client, session } = await connect();
    cleanups.push(() => session.dispose());

    const result = await client.callTool({ name: 'ava_load_data', arguments: { source: { type: 'csv', csv: CSV } } });
    expect(textOf(result as never)).toEqual({
      tables: [
        {
          name: 'data',
          columns: [
            { name: 'region', type: 'VARCHAR' },
            { name: 'product', type: 'VARCHAR' },
            { name: 'sales', type: 'BIGINT' },
          ],
        },
      ],
      relationships: [],
    });
  });

  it('runs SQL and returns JSON rows', async () => {
    const { client, session } = await connect({ maxRows: 2 });
    cleanups.push(() => session.dispose());

    await client.callTool({ name: 'ava_load_data', arguments: { source: { type: 'csv', csv: CSV } } });
    const result = await client.callTool({
      name: 'ava_query',
      arguments: { sql: 'SELECT * FROM data ORDER BY sales DESC' },
    });

    expect(textOf(result as never)).toMatchObject({
      rows: [
        { region: 'West', product: 'Laptop', sales: 7 },
        { region: 'West', product: 'Monitor', sales: 6 },
      ],
      truncated: true,
    });
  });

  it('reports a missing dataset as an MCP error instead of crashing', async () => {
    const { client, session } = await connect();
    cleanups.push(() => session.dispose());

    const result = await client.callTool({ name: 'ava_query', arguments: { sql: 'SELECT 1' } });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toMatch(/No dataset loaded/);
  });

  it('reports invalid SQL as an MCP error with the engine message', async () => {
    const { client, session } = await connect();
    cleanups.push(() => session.dispose());

    await client.callTool({ name: 'ava_load_data', arguments: { source: { type: 'json', data: [{ a: 1 }] } } });

    const write = await client.callTool({ name: 'ava_query', arguments: { sql: 'DELETE FROM data' } });
    expect(write.isError).toBe(true);
    expect((write.content as { text: string }[])[0].text).toMatch(/delete/i);

    const multi = await client.callTool({ name: 'ava_query', arguments: { sql: 'SELECT 1; SELECT 2;' } });
    expect(multi.isError).toBe(true);
    expect((multi.content as { text: string }[])[0].text).toMatch(/read-only/i);
  });

  it('profiles columns', async () => {
    const { client, session } = await connect();
    cleanups.push(() => session.dispose());

    await client.callTool({ name: 'ava_load_data', arguments: { source: { type: 'csv', csv: CSV } } });
    const result = await client.callTool({ name: 'ava_profile', arguments: { metrics: ['min', 'max'] } });
    const payload = textOf(result as never) as { models: { metrics: object; columns: { name: string; metrics: object }[] }[] };

    expect(payload.models[0].metrics).toEqual({});
    const sales = payload.models[0].columns.find((column) => column.name === 'sales');
    expect(sales?.metrics).toEqual({ min: 3, max: 7 });
  });
});
