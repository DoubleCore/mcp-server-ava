/**
 * AVA MCP server.
 *
 * Exposes AVA's data and analysis capabilities as Model Context Protocol tools.
 * One dataset is loaded per server process; loading again replaces it. Tools
 * return JSON-serializable results only, so any MCP client can consume them.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { AVASession, toChartSummary, toTableResult } from './session.js';

import type { AVAToolsConfig } from './session.js';
import type { DataSourceConfig, Schema } from '@antv/ava';

export const SERVER_NAME = 'ava';
export const SERVER_VERSION = '0.1.0';

const DEFAULT_MAX_ROWS = 200;

const csvSource = z.object({ type: z.literal('csv'), csv: z.string().min(1) });
const jsonSource = z.object({ type: z.literal('json'), data: z.array(z.record(z.string(), z.unknown())).min(1) });
const textSource = z.object({ type: z.literal('text'), text: z.string().min(1) });
const fileSource = z.object({ type: z.enum(['csv-file', 'json-file', 'parquet', 'excel']), path: z.string().min(1) });

const sourceSchema = z.discriminatedUnion('type', [csvSource, jsonSource, textSource, fileSource]);

type SourceInput = z.infer<typeof sourceSchema>;

function toSourceConfig(source: SourceInput): DataSourceConfig {
  switch (source.type) {
    case 'csv':
      return { type: 'csv', options: { csv: source.csv } };
    case 'json':
      return { type: 'json', options: { data: source.data } };
    case 'text':
      return { type: 'text', options: { text: source.text } };
    default:
      return { type: source.type, options: { path: source.path } } as DataSourceConfig;
  }
}

function schemaPayload(schema: Schema) {
  return {
    tables: schema.models.map((model) => ({
      name: model.name,
      columns: model.columns.map((column) => ({ name: column.name, type: column.type ?? 'UNKNOWN' })),
    })),
    relationships: schema.relationships ?? [],
  };
}

/** Convert any thrown value into an MCP error result instead of a protocol crash. */
function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

/**
 * Build the MCP server and the AVA session behind it.
 *
 * The session is exposed so the caller can dispose of the engine when the
 * transport closes.
 */
export function createServer(config: AVAToolsConfig = {}) {
  const session = new AVASession(config);
  const maxRows = config.maxRows ?? DEFAULT_MAX_ROWS;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    'ava_load_data',
    {
      title: 'Load data into AVA',
      description:
        'Load a dataset and return its schema. Replaces the previously loaded dataset. ' +
        'Use inline CSV or JSON for small pasted data, or a file path for larger local files.',
      inputSchema: { source: sourceSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ source }) => {
      try {
        return jsonResult(schemaPayload(await session.load(toSourceConfig(source as SourceInput))));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'ava_schema',
    {
      title: 'Inspect the loaded dataset',
      description: 'Return table names, columns, and types for the loaded dataset.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => {
      try {
        return jsonResult(schemaPayload(await session.schema()));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'ava_profile',
    {
      title: 'Profile the loaded dataset',
      description: 'Compute column statistics (row count, nulls, distinct, min, max, mean, median) for the dataset.',
      inputSchema: {
        metrics: z
          .array(z.enum(['row_count', 'null_count', 'distinct_count', 'min', 'max', 'mean', 'median']))
          .optional()
          .describe('Statistics to compute. Omit for AVA defaults.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ metrics }) => {
      try {
        return jsonResult(await session.profile(metrics));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'ava_query',
    {
      title: 'Run SQL against the dataset',
      description:
        'Execute one read-only SELECT statement with DuckDB semantics. ' +
        'Aggregate, filter, and sort in SQL so the result stays small.',
      inputSchema: {
        sql: z.string().min(1).describe('A single SELECT statement, using table names from ava_schema.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ sql }) => {
      try {
        return jsonResult(toTableResult(await session.query(sql), maxRows));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'ava_analyze',
    {
      title: 'Answer a question in natural language',
      description:
        'Ask a question about the loaded dataset. AVA writes and executes the SQL, then summarizes the result. ' +
        'Requires OPENAI_API_KEY (and optionally OPENAI_MODEL / OPENAI_BASE_URL) in the server environment.',
      inputSchema: {
        question: z.string().min(1).describe('The question to answer from the data.'),
        includeSummary: z.boolean().optional().describe('Whether to write a prose answer. Defaults to true.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ question, includeSummary }) => {
      try {
        const result = await session.analyze(question, includeSummary ?? true);
        return jsonResult({
          ...toTableResult(result, maxRows),
          query: result.query,
          ...(result.sql ? { sql: result.sql } : {}),
          text: result.text,
          ...(result.markdown ? { markdown: result.markdown } : {}),
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'ava_translate',
    {
      title: 'Translate a question to SQL',
      description: 'Translate a question into SQL without running it, so a human can review the statement first.',
      inputSchema: { question: z.string().min(1) },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ question }) => {
      try {
        return jsonResult({ sql: await session.translate(question) });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'ava_suggest',
    {
      title: 'Suggest questions about the data',
      description: 'Suggest questions worth asking about the loaded dataset. Requires a model configuration.',
      inputSchema: { count: z.number().int().min(1).max(10).optional() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ count }) => {
      try {
        return jsonResult({ suggestions: await session.suggest(count ?? 3) });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'ava_visualize',
    {
      title: 'Build a chart for a result',
      description:
        'Recommend a chart for rows from ava_query or ava_analyze. Returns a GPT-Vis config, which ' +
        'AVA renders to standalone HTML with the `viz --spec` CLI command.',
      inputSchema: {
        question: z.string().min(1).describe('The question the rows answer.'),
        data: z.array(z.record(z.string(), z.unknown())).min(1).describe('Rows from a previous tool call.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ question, data }) => {
      try {
        const spec = await session.recommend({ query: question, data });
        return jsonResult(spec ? toChartSummary(spec) : { chartType: null, message: 'The data does not need a chart.' });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  return { server, session, dispose: () => session.dispose() };
}
