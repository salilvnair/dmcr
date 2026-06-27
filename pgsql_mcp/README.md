# app_mcp — PostgreSQL MCP Server for DMCR

A **Model Context Protocol (MCP)** server that connects to PostgreSQL and exposes database schema discovery tools. Designed for use with the DMCR VS Code extension to give AI full knowledge of your database structure when generating migration SQL.

---

## What Does This Do?

When you ask an AI to write or review SQL, it has no idea what tables, columns, or constraints exist in your database. This MCP server solves that by giving AI **live, read-only access** to your PostgreSQL schema — so it can generate accurate SQL instead of guessing.

Out of hundreds of objects in your database, you can enable only the ones you're working with, keeping AI context focused and token usage low.

---

## Features

- **Full schema discovery** — tables, views, columns, indexes, sequences, functions, triggers, constraints, enums, extensions
- **Selective object filtering** — expose only the objects you need via `app_mcp.yaml` config
- **Enable/disable at runtime** — toggle specific objects for AI context on the fly
- **Read-only queries** — run safe `SELECT` queries for schema exploration
- **MCP protocol** — stdio transport, JSON-RPC 2.0, compatible with any MCP client
- **Schema-scoped** — discover objects per-schema, defaults to `public`

---

## Getting Started

### Step 1: Install

```bash
pip install -e .
```

### Step 2: Set Your Connection String

Choose one of two methods:

**Option A — Command-line argument:**

```bash
app-mcp --conn "postgresql://user:password@hostname:5432/dbname"
```

**Option B — Environment variable:**

```bash
export APP_PG_CONN="postgresql://user:password@hostname:5432/dbname"
app-mcp
```

### Step 3: Register MCP Server
**Settings** → **MCP Servers** tab → click **Add server** and fill in:

| Field | Value |
|-------|-------|
| **Name** | `app-postgres` (or any friendly name) |
| **Transport** | `stdio (spawn subprocess)` |
| **Command** | Full path to your venv Python, e.g. `C:\Users\you\workspace\postgres_mcp\.venv\Scripts\python.exe` (Windows) or `/path/to/postgres_mcp/.venv/bin/python` (Linux/Mac) |
| **Arguments** | `-m` (line 1) <br> `app_mcp.server` (line 2) <br> `--conn` (line 3) <br> `postgresql://user:password@hostname:5432/dbname` (line 4) |
| **Environment** | *(leave empty — or use* `APP_PG_CONN=...` *instead of `--conn` in args)* |

> **Important:** Do **not** use bare `python` as the command — DMCR won't know about your virtual environment. Use the full path to the `.venv` Python executable so it picks up the installed `app_mcp` package.

Click **Save**. The extension will spawn the MCP server automatically. You should see startup output in stderr like:

```
app-mcp v0.1.0 starting...
  Python : C:\Users\you\workspace\postgres_mcp\.venv\Scripts\python.exe
  Host   : hostname:5432
  DB     : dbname
  Filter : none — all objects exposed
  Status : connected, serving tools via stdio
```

Click **Tools** on the server row to verify the discovered tools.

> **Alternative (manual JSON):** You can also configure via `.vscode/mcp.json`:
> ```json
> {
>   "mcpServers": {
>     "app-postgres": {
>       "command": "C:\\Users\\you\\workspace\\postgres_mcp\\.venv\\Scripts\\python.exe",
>       "args": ["-m", "app_mcp.server", "--conn", "postgresql://user:password@hostname:5432/dbname"],
>       "env": {}
>     }
>   }
> }
> ```

### Step 4: (Optional) Filter Exposed Objects

By default, **all** objects in all schemas are exposed. To limit what the AI sees, create an `app_mcp.yaml` config file.

Copy the example and edit it:

```bash
cp app_mcp.example.yaml app_mcp.yaml
```

The config supports include/exclude rules with wildcards:

```yaml
# Only expose these schemas
schemas:
  - schema_name

# Only expose objects matching these patterns
include:
  tables:
    - schema_name.zp_*
  views:
    - schema_name.v_*
  functions:
    - schema_name.fn_*

# Hide specific objects even if they match include rules
exclude:
  tables:
    - schema_name.temp_*
```

Config file is searched in this order:
1. `APP_MCP_CONFIG` environment variable (explicit path)
2. `./app_mcp.yaml` (project root)
3. `~/.app_mcp.yaml` (user home)

---

## MCP Tools Reference

| Tool | Description |
|------|-------------|
| `discover_schemas` | List all schemas in the database |
| `discover_objects` | List all objects (tables, views, functions, sequences, enums) in a schema |
| `describe_table` | Get full DDL-level detail for a table (columns, types, constraints, indexes) |
| `describe_function` | Get function signature and body |
| `describe_sequence` | Get sequence details |
| `get_enabled_context` | Get the full schema context for all currently enabled objects (used by AI) |
| `enable_objects` | Enable specific objects for AI context |
| `disable_objects` | Disable specific objects from AI context |
| `list_enabled` | Show currently enabled objects |
| `run_readonly_query` | Execute a read-only (`SELECT`) query for schema exploration |

---

## Architecture

```
VS Code / MCP Client
    │  stdio (JSON-RPC 2.0)
    ▼
app_mcp (this server)
    │  psycopg3
    ▼
PostgreSQL Database
    └── information_schema + pg_catalog queries
```

---

## Project Structure

```
app_mcp/
├── server.py       # MCP server entry point, tool definitions, stdio transport
├── introspect.py   # PostgreSQL introspection queries (schema, tables, columns, etc.)
├── config.py       # Config file loader and object filter logic
└── __init__.py
app_mcp.example.yaml  # Example config for filtering exposed objects
mcp-config.example.json # Example VS Code MCP client config
pyproject.toml          # Package metadata and dependencies
```

---

## How This Compares to Industry

The pattern of giving AI database awareness via MCP is becoming standard:

| Project | Approach |
|---------|----------|
| **Supabase MCP** | Official MCP server for Supabase/PostgreSQL. Auto-discovers tables for AI SQL generation. |
| **Prisma MCP** | Exposes Prisma schema to AI tools. |
| **PlanetScale MCP** | MySQL schema discovery via MCP. |
| **Custom MCP servers** | Many teams build thin MCP wrappers over their database for read-only introspection. |

The shared pattern: **MCP server → schema discovery → selective context → AI prompt enrichment**. The AI sees only the objects you've enabled, keeping token usage manageable and answers focused.
