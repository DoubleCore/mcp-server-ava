/**
 * Shared AVA session and result shaping for the MCP tools.
 *
 * This mirrors the session used by `ai-sdk-ava`; the packages stay
 * independent so each can be installed on its own.
 */

import { createRequire } from 'node:module';

import type { AnalysisResponse, ChartSpec, DataSourceConfig, ExecutionResult, LLMConfig, Profile, Schema } from '@antv/ava';

/**
 * AVA ships a CommonJS build, but its `esm/` output keeps extensionless
 * directory imports (`import { DuckDBEngine } from './duckdb'`), so
 * `import '@antv/ava'` fails under Node ESM with ERR_UNSUPPORTED_DIR_IMPORT.
 * Loading the CommonJS entry through `createRequire` works from both module
 * systems on Node 22+.
 */
const require = createRequire(import.meta.url);
const avaModule = require('@antv/ava') as typeof import('@antv/ava');

export const DEFAULT_MAX_ROWS = 200;

export interface AVAToolsConfig {
  /** Provider settings for natural-language analysis and charts. Falls back to OPENAI_* env vars. */
  llm?: LLMConfig;
  /** Engine used for loaded data. Defaults to DuckDB. */
  engine?: 'duckdb' | 'python' | 'javascript';
  /** Hard cap on rows returned per call. Default 200. */
  maxRows?: number;
}

export interface TableResult {
  columns: { name: string; type: string }[];
  rows: Record<string, unknown>[];
  rowCount?: number;
  truncated?: boolean;
  truncatedBy?: 'maxRows' | 'maxResultBytes';
}

export function resolveLLMConfig(config: AVAToolsConfig = {}): LLMConfig | undefined {
  if (config.llm) return config.llm;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return undefined;

  return {
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
  };
}

export function toTableResult(result: ExecutionResult, maxRows: number): TableResult {
  return {
    columns: result.schema.map((column) => ({ name: column.name, type: column.type ?? 'UNKNOWN' })),
    rows: result.data.slice(0, maxRows),
    ...(result.rowCount === undefined ? {} : { rowCount: result.rowCount }),
    ...(result.truncated || result.data.length > maxRows ? { truncated: true, truncatedBy: 'maxRows' as const } : {}),
  };
}

export function toChartSummary(spec: ChartSpec) {
  return { chartType: spec.chartType, config: spec.config };
}

export class AVASession {
  private readonly config: AVAToolsConfig;
  private ava: import('@antv/ava').AVA | null = null;
  private loaded: DataSourceConfig | null = null;

  constructor(config: AVAToolsConfig = {}) {
    this.config = config;
  }

  get hasDataset(): boolean {
    return this.loaded !== null;
  }

  private instance(): import('@antv/ava').AVA {
    if (this.ava) return this.ava;
    const llm = resolveLLMConfig(this.config);
    this.ava = new avaModule.AVA({
      // Deterministic operations ignore the key; AI commands surface a clear
      // provider error when no key is configured.
      llm: llm ?? { model: 'gpt-4o-mini', apiKey: 'unset-configure-OPENAI_API_KEY' },
      engine: { type: this.config.engine ?? 'duckdb' },
    });
    return this.ava;
  }

  async load(source: DataSourceConfig): Promise<Schema> {
    const ava = this.instance();
    await ava.source(source);
    this.loaded = source;
    return ava.schema();
  }

  async schema(): Promise<Schema> {
    return this.require().schema();
  }

  async profile(metrics?: string[]): Promise<Profile> {
    return this.require().profile(metrics?.length ? { metrics } : {});
  }

  async query(sql: string): Promise<ExecutionResult> {
    return this.require().query(sql, { maxRows: this.config.maxRows ?? DEFAULT_MAX_ROWS });
  }

  async analyze(question: string, includeSummary = true): Promise<AnalysisResponse> {
    return this.require().analyze(question, {
      maxRows: this.config.maxRows ?? DEFAULT_MAX_ROWS,
      includeSummary,
    });
  }

  async translate(question: string): Promise<string> {
    return this.require().translate(question);
  }

  async recommend(result: Pick<AnalysisResponse, 'query' | 'data'>): Promise<ChartSpec | null> {
    return this.require().recommend(result);
  }

  async suggest(count: number): Promise<{ query: string; score: number; reason: string }[]> {
    return this.require().suggest(count);
  }

  async dispose(): Promise<void> {
    const ava = this.ava;
    this.ava = null;
    this.loaded = null;
    if (ava) await ava.dispose();
  }

  private require(): import('@antv/ava').AVA {
    if (!this.loaded) {
      throw new Error('No dataset loaded. Call ava_load_data first with a CSV, JSON, or text source.');
    }
    return this.instance();
  }
}
