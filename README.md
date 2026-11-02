# ava-mcp-server

[Model Context Protocol](https://modelcontextprotocol.io) server for [AVA](https://github.com/antvis/AVA). Load a dataset, inspect it, run SQL, ask questions in natural language, and get charts — from Claude Desktop, Cursor, ChatGPT, or any other MCP client.

AVA does the data access, SQL execution, and chart specs; your MCP client's own agent does the reasoning. No AVA CLI or extra API key is needed for deterministic work.

## Install

```bash
npm install -g ava-mcp-server
# or run it without installing:
npx -y ava-mcp-server
```

Requires Node.js ≥ 22.13.

## Client configuration

Add the server to your MCP client config. The `env` block is only needed for the model-backed tools (`ava_analyze`, `ava_translate`, `ava_suggest`, `ava_visualize`).

**Claude Desktop** (`claude_desktop_config.json`) / **Cursor** (`~/.cursor/mcp.json`) / most clients:

```json
{
  "mcpServers": {
    "ava": {
      "command": "npx",
      "args": ["-y", "ava-mcp-server"],
      "env": {
        "OPENAI_API_KEY": "sk-...",
        "OPENAI_MODEL": "gpt-4o-mini",
        "OPENAI_BASE_URL": "https://api.openai.com/v1",
        "AVA_MCP_MAX_ROWS": "200"
      }
    }
  }
}
```

Any OpenAI-compatible endpoint works — set `OPENAI_BASE_URL` for Azure, OpenRouter, a local vLLM, or an internal gateway.

## Tools

| Tool | What it does | Needs a model |
| --- | --- | --- |
| `ava_load_data` | Load inline CSV/JSON/text or a file path (`.csv`, `.json`, `.parquet`, `.xlsx`). Replaces the current dataset and returns the schema. | only for `text` |
| `ava_schema` | Table names, columns, and types. | no |
| `ava_profile` | Row count, nulls, distinct, min/max/mean/median per column. | no |
| `ava_query` | One read-only SQL statement with DuckDB semantics; results capped at `AVA_MCP_MAX_ROWS`. | no |
| `ava_analyze` | Natural-language question → AVA writes SQL, executes it, and summarizes the answer. | yes |
| `ava_translate` | Natural-language question → SQL, without executing it, so a human can review it. | yes |
| `ava_suggest` | Suggest questions worth asking about the loaded dataset. | yes |
| `ava_visualize` | Recommend a chart for rows from a previous call; returns GPT-Vis JSON. | yes |

Every tool returns JSON text. Failures (no dataset loaded, invalid SQL, engine errors) come back as MCP error results, so the agent sees the message instead of a dead connection.

## Example conversation

> **You:** Load `examples/sales.csv` and tell me which region sells the most, then chart it.
>
> **Agent:** calls `ava_load_data` → `ava_query` (`SELECT region, SUM(sales)…`) → `ava_visualize`, replies *"West sells the most at 13 units"* and returns chart JSON.

## Rendering a returned chart

`ava_visualize` returns a spec, not HTML. Render it to a standalone page with the AVA CLI, which is already installed alongside this package:

```bash
npx ava viz --spec chart.json --output chart.html
```

## Configuration

| Env var | Default | Notes |
| --- | --- | --- |
| `OPENAI_API_KEY` | — | Enables the model-backed tools. Without it they return a clear error. |
| `OPENAI_MODEL` | `gpt-4o-mini` | Any chat model your endpoint exposes. |
| `OPENAI_BASE_URL` | OpenAI | Point at an OpenAI-compatible gateway. |
| `AVA_MCP_MAX_ROWS` | `200` | Hard cap per `query` / `analyze` result. Truncation is reported in the payload. |

## Safety notes

- One dataset per server process; loading again replaces it. Run separate servers for separate datasets.
- SQL is read-only: writes, DDL, and multi-statement scripts are rejected by the engine.
- Results are truncated to the row cap and flagged with `truncated: true`.
- Diagnostics go to stderr — stdout is reserved for the MCP protocol.

## Development

```bash
npm install
npm run build
npm test                              # vitest: in-memory MCP client over the real server
node scripts/smoke.mjs                # end-to-end over stdio against the built binary
OPENAI_API_KEY=... node scripts/smoke.mjs   # also exercises analyze + visualize
```

## License

MIT
