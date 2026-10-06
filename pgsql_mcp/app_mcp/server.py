"""MCP Server for PostgreSQL schema discovery — stdio transport."""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from dataclasses import asdict
from typing import Any

import re

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

from log4py import init, LoggingConfig
from .config import ObjectFilter, load_config
from .introspect import PgIntrospector, SchemaObject

log = logging.getLogger(__name__)


# ── Enabled Objects Store ─────────────────────────────────────────────────────

class EnabledStore:
    """Tracks which database objects are enabled for AI context."""

    def __init__(self) -> None:
        self._enabled: set[str] = set()  # "schema.type.name" keys

    @staticmethod
    def _key(schema: str, obj_type: str, name: str) -> str:
        return f"{schema}.{obj_type}.{name}"

    def enable(self, schema: str, obj_type: str, name: str) -> None:
        self._enabled.add(self._key(schema, obj_type, name))

    def disable(self, schema: str, obj_type: str, name: str) -> None:
        self._enabled.discard(self._key(schema, obj_type, name))

    def is_enabled(self, schema: str, obj_type: str, name: str) -> bool:
        return self._key(schema, obj_type, name) in self._enabled

    def list_enabled(self) -> list[dict[str, str]]:
        result = []
        for key in sorted(self._enabled):
            parts = key.split(".", 2)
            if len(parts) == 3:
                result.append({"schema": parts[0], "type": parts[1], "name": parts[2]})
        return result

    def enable_all(self, objects: list[SchemaObject]) -> None:
        for obj in objects:
            self.enable(obj.schema, obj.type, obj.name)

    def clear(self) -> None:
        self._enabled.clear()

    @property
    def count(self) -> int:
        return len(self._enabled)


# ── MCP Server ────────────────────────────────────────────────────────────────

_URL_PASSWORD = re.compile(r"(\b[a-z][a-z0-9+.-]*://[^:/\s@]+:)([^@\s/]+)(@)", re.IGNORECASE)
_KV_PASSWORD = re.compile(r"(\bpassword\s*=\s*)('(?:[^'\\]|\\.)*'|\S+)", re.IGNORECASE)
_SECRET_KEYS = {"password", "passwd", "pwd", "secret", "token", "api_key", "apikey"}


def _redact(value: Any) -> Any:
    """Mask passwords in connection strings and secret-looking keys before logging."""
    if isinstance(value, str):
        return _KV_PASSWORD.sub(r"\1****", _URL_PASSWORD.sub(r"\1****\3", value))
    if isinstance(value, dict):
        return {k: ("****" if str(k).lower() in _SECRET_KEYS else _redact(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact(v) for v in value]
    return value


def create_server(conninfo: str, obj_filter: ObjectFilter | None = None) -> Server:
    """Create and configure the MCP server with all tools."""

    server = Server("app-mcp")
    introspector = PgIntrospector(conninfo)
    store = EnabledStore()
    filt = obj_filter or ObjectFilter()

    # Connect on startup
    introspector.connect()

    @server.list_tools()
    async def list_tools() -> list[Tool]:
        return [
            Tool(
                name="discover_schemas",
                description="List all schemas in the connected PostgreSQL database",
                inputSchema={"type": "object", "properties": {}, "required": []},
            ),
            Tool(
                name="discover_objects",
                description="List all database objects (tables, views, functions, sequences, enums) in a schema. Use discover_schemas first to see available schemas.",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "schema": {"type": "string", "description": "Schema name — use the schema from the user's context, do NOT assume 'public'"},
                    },
                    "required": ["schema"],
                },
            ),
            Tool(
                name="describe_table",
                description="Get full detail for a table or view: columns, types, constraints, indexes, triggers, row estimate",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "schema": {"type": "string", "description": "Schema name — use the schema from the user's context, do NOT assume 'public'"},
                        "name": {"type": "string", "description": "Table or view name"},
                    },
                    "required": ["schema", "name"],
                },
            ),
            Tool(
                name="describe_function",
                description="Get function signature, body, language, and volatility",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "schema": {"type": "string", "description": "Schema name — use the schema from the user's context, do NOT assume 'public'"},
                        "name": {"type": "string", "description": "Function name"},
                    },
                    "required": ["schema", "name"],
                },
            ),
            Tool(
                name="describe_sequence",
                description="Get sequence details: data type, start, increment, current value, owned by",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "schema": {"type": "string", "description": "Schema name — use the schema from the user's context, do NOT assume 'public'"},
                        "name": {"type": "string", "description": "Sequence name"},
                    },
                    "required": ["schema", "name"],
                },
            ),
            Tool(
                name="enable_objects",
                description="Enable specific database objects for AI context. Only enabled objects are included when generating SQL.",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "objects": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "schema": {"type": "string", "description": "Schema name"},
                                    "type": {"type": "string", "enum": ["table", "view", "function", "sequence", "enum"]},
                                    "name": {"type": "string"},
                                },
                                "required": ["schema", "name", "type"],
                            },
                            "description": "List of objects to enable",
                        },
                    },
                    "required": ["objects"],
                },
            ),
            Tool(
                name="disable_objects",
                description="Disable specific database objects from AI context",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "objects": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "schema": {"type": "string", "description": "Schema name"},
                                    "type": {"type": "string"},
                                    "name": {"type": "string"},
                                },
                                "required": ["schema", "name", "type"],
                            },
                        },
                    },
                    "required": ["objects"],
                },
            ),
            Tool(
                name="list_enabled",
                description="Show all currently enabled database objects",
                inputSchema={"type": "object", "properties": {}, "required": []},
            ),
            Tool(
                name="enable_all_in_schema",
                description="Enable ALL objects in a schema for AI context",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "schema": {"type": "string", "description": "Schema name — use the schema from the user's context"},
                    },
                    "required": ["schema"],
                },
            ),
            Tool(
                name="get_enabled_context",
                description="Get the full schema context text for all enabled objects. This is what gets injected into AI prompts.",
                inputSchema={"type": "object", "properties": {}, "required": []},
            ),
            Tool(
                name="run_readonly_query",
                description="Execute ONE read-only query (SELECT, WITH, EXPLAIN, SHOW, VALUES or TABLE) for schema exploration, in a read-only transaction with a 10s timeout. Returns at most `limit` rows (max 1000).",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "sql": {"type": "string", "description": "SELECT query to execute"},
                        "limit": {"type": "integer", "default": 100, "description": "Max rows to return"},
                    },
                    "required": ["sql"],
                },
            ),
            Tool(
                name="get_ddl",
                description="Get the full SQL DDL definition (CREATE statement source code) for any database object: table, view, function, sequence, or enum",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "schema": {"type": "string", "description": "Schema name — use the schema from the user's context, do NOT assume 'public'"},
                        "name": {"type": "string", "description": "Object name (table, view, function, sequence, or enum)"},
                        "object_type": {"type": "string", "enum": ["table", "view", "function", "sequence", "enum"], "description": "Type of database object"},
                    },
                    "required": ["schema", "name", "object_type"],
                },
            ),
            Tool(
                name="compare_schemas",
                description=(
                    "Compare the schema of the primary connected database against a second database. "
                    "Returns a structured diff: objects only in left (source), only in right (target), "
                    "present in both but with different DDL (drift), and objects identical in both. "
                    "Use this to detect schema drift between ST and PROD environments."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "second_conn": {
                            "type": "string",
                            "description": "Connection string for the second (target) database, e.g. postgresql://user:password@host:5432/dbname",
                        },
                        "schema": {
                            "type": "string",
                            "default": "public",
                            "description": "Schema to compare in both databases (default: public)",
                        },
                        "object_types": {
                            "type": "array",
                            "items": {"type": "string", "enum": ["table", "view", "function", "sequence", "enum"]},
                            "default": ["table", "view", "function"],
                            "description": "Object types to include in the comparison",
                        },
                    },
                    "required": ["second_conn"],
                },
            ),
        ]

    @server.call_tool()
    async def call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
        try:
            log.info("tool_call: %s args=%s", name, json.dumps(_redact(arguments), default=str))
            result = _handle_tool(name, arguments, introspector, store, filt)
            log.debug("tool_result: %s -> %d chars", name, len(json.dumps(result, default=str)))
            return [TextContent(type="text", text=json.dumps(result, indent=2, default=str))]
        except Exception as e:
            log.exception("tool_error: %s -> %s", name, e)
            return [TextContent(type="text", text=json.dumps({"error": str(e)}))]

    return server


def _handle_tool(
    name: str,
    args: dict[str, Any],
    db: PgIntrospector,
    store: EnabledStore,
    filt: ObjectFilter,
) -> Any:
    """Route tool calls to appropriate handlers."""

    if name == "discover_schemas":
        schemas = db.list_schemas()
        # Filter schemas if config specifies allowed ones
        if filt.schemas:
            allowed = set(filt.schemas)
            schemas = [s for s in schemas if s in allowed]
            log.debug("discover_schemas: filtered %d → %d schemas (allowed=%s)", len(db.list_schemas()), len(schemas), filt.schemas)
        return {"schemas": schemas}

    elif name == "discover_objects":
        schema = args.get("schema")
        if not schema:
            return {"error": "'schema' is required. Call discover_schemas first to see available schemas, then pass the correct schema name from the user's context."}
        if not filt.is_schema_allowed(schema):
            return {"schema": schema, "object_count": 0, "objects": [], "filtered": True, "reason": f"Schema '{schema}' not in allowed list"}
        objects = db.list_objects(schema)
        # Apply config filter
        if filt.is_active:
            objects = [o for o in objects if filt.is_object_allowed(o.schema, o.type, o.name)]
        return {
            "schema": schema,
            "object_count": len(objects),
            "objects": [asdict(o) for o in objects],
        }

    elif name == "describe_table":
        schema = args.get("schema")
        if not schema:
            return {"error": "'schema' is required. Use the schema from the user's context — do NOT assume 'public'."}
        detail = db.describe_table(schema, args["name"])
        return asdict(detail)

    elif name == "describe_function":
        schema = args.get("schema")
        if not schema:
            return {"error": "'schema' is required. Use the schema from the user's context — do NOT assume 'public'."}
        detail = db.describe_function(schema, args["name"])
        if not detail:
            return {"error": f"Function '{schema}.{args['name']}' not found"}
        return asdict(detail)

    elif name == "describe_sequence":
        schema = args.get("schema")
        if not schema:
            return {"error": "'schema' is required. Use the schema from the user's context — do NOT assume 'public'."}
        detail = db.describe_sequence(schema, args["name"])
        if not detail:
            return {"error": f"Sequence '{schema}.{args['name']}' not found"}
        return asdict(detail)

    elif name == "enable_objects":
        for obj in args.get("objects", []):
            schema = obj.get("schema")
            if not schema:
                return {"error": "Each object must include 'schema'. Do not assume 'public'."}
            store.enable(schema, obj["type"], obj["name"])
        return {"enabled_count": store.count, "enabled": store.list_enabled()}

    elif name == "disable_objects":
        for obj in args.get("objects", []):
            schema = obj.get("schema")
            if not schema:
                return {"error": "Each object must include 'schema'. Do not assume 'public'."}
            store.disable(schema, obj["type"], obj["name"])
        return {"enabled_count": store.count, "enabled": store.list_enabled()}

    elif name == "list_enabled":
        return {"enabled_count": store.count, "enabled": store.list_enabled()}

    elif name == "enable_all_in_schema":
        schema = args.get("schema")
        if not schema:
            return {"error": "'schema' is required. Use the schema from the user's context — do NOT assume 'public'."}
        objects = db.list_objects(schema)
        store.enable_all(objects)
        return {"enabled_count": store.count, "schema": schema, "objects_enabled": len(objects)}

    elif name == "get_enabled_context":
        return _build_enabled_context(db, store)

    elif name == "run_readonly_query":
        sql = args["sql"]
        limit = args.get("limit", 100)
        return db.run_readonly_query(sql, limit)

    elif name == "get_ddl":
        schema = args.get("schema")
        if not schema:
            return {"error": "'schema' is required. Use the schema from the user's context — do NOT assume 'public'."}
        obj_name = args.get("name")
        obj_type = args.get("object_type", "table")
        ddl = db.get_ddl(schema, obj_name, obj_type)
        return {"schema": schema, "name": obj_name, "object_type": obj_type, "ddl": ddl}

    elif name == "compare_schemas":
        second_conn = args.get("second_conn")
        if not second_conn:
            return {"error": "'second_conn' is required — provide the connection string for the target database"}
        schema = args.get("schema", "public")
        object_types = args.get("object_types", ["table", "view", "function"])
        return _compare_schemas_impl(db, second_conn, schema, object_types)

    else:
        return {"error": f"Unknown tool: {name}"}


def _build_enabled_context(db: PgIntrospector, store: EnabledStore) -> dict[str, Any]:
    """Build the full schema context text for all enabled objects."""
    enabled = store.list_enabled()
    if not enabled:
        return {"context": "", "object_count": 0, "message": "No objects enabled. Use enable_objects or enable_all_in_schema first."}

    sections: list[str] = []
    tables_described = 0
    functions_described = 0

    for obj in enabled:
        schema, obj_type, name = obj["schema"], obj["type"], obj["name"]

        if obj_type in ("table", "view"):
            detail = db.describe_table(schema, name)
            cols = ", ".join(
                f"{c.name} {c.data_type}{'?' if c.is_nullable else ''}"
                + (f" DEFAULT {c.column_default}" if c.column_default else "")
                for c in detail.columns
            )
            pks = [c for con in detail.constraints if con.type == "PRIMARY KEY" for c in con.columns]
            pk_str = f" PK({', '.join(pks)})" if pks else ""
            fks = [
                f"FK({', '.join(con.columns)} -> {con.foreign_table})"
                for con in detail.constraints if con.type == "FOREIGN KEY"
            ]
            fk_str = (" " + " ".join(fks)) if fks else ""
            idx_str = ""
            non_pk_idxs = [i for i in detail.indexes if not i.is_primary]
            if non_pk_idxs:
                idx_str = " IDX(" + ", ".join(i.name for i in non_pk_idxs) + ")"

            section = f"-- {obj_type.upper()}: {schema}.{name} (~{detail.row_estimate} rows){pk_str}{fk_str}{idx_str}\n"
            section += f"-- Columns: {cols}"
            if detail.description:
                section += f"\n-- Comment: {detail.description}"
            sections.append(section)
            tables_described += 1

        elif obj_type == "function":
            detail_f = db.describe_function(schema, name)
            if detail_f:
                section = f"-- FUNCTION: {schema}.{name}({detail_f.arguments}) -> {detail_f.return_type} [{detail_f.language}, {detail_f.volatility}]"
                if detail_f.description:
                    section += f"\n-- Comment: {detail_f.description}"
                sections.append(section)
                functions_described += 1

        elif obj_type == "sequence":
            detail_s = db.describe_sequence(schema, name)
            if detail_s:
                owned = f" owned by {detail_s.owned_by}" if detail_s.owned_by else ""
                sections.append(f"-- SEQUENCE: {schema}.{name} ({detail_s.data_type}, inc={detail_s.increment}){owned}")

        elif obj_type == "enum":
            detail_e = db.describe_enum(schema, name)
            if detail_e:
                sections.append(f"-- ENUM: {schema}.{name} = ({', '.join(detail_e['values'])})")

    context_text = "\n\n".join(sections)
    return {
        "context": context_text,
        "object_count": len(enabled),
        "tables": tables_described,
        "functions": functions_described,
    }


def _compare_schemas_impl(
    db: PgIntrospector,
    second_conn: str,
    schema: str,
    object_types: list[str],
) -> dict:
    """Compare schema objects between primary and secondary database."""
    second_db = PgIntrospector(second_conn)
    second_db.connect()

    try:
        left_objects = {o.name: o for o in db.list_objects(schema) if o.type in object_types}
        right_objects = {o.name: o for o in second_db.list_objects(schema) if o.type in object_types}

        left_names = set(left_objects)
        right_names = set(right_objects)

        only_in_left = []
        only_in_right = []
        drifted = []
        in_sync = []

        for name in sorted(left_names - right_names):
            obj = left_objects[name]
            # The source DDL, so a migration can create the object in the target
            only_in_left.append({"name": name, "type": obj.type, "schema": schema,
                                 "left_ddl": db.get_ddl(schema, name, obj.type) or ""})

        for name in sorted(right_names - left_names):
            obj = right_objects[name]
            only_in_right.append({"name": name, "type": obj.type, "schema": schema})

        for name in sorted(left_names & right_names):
            obj = left_objects[name]
            # Fetch DDL from both sides for drift detection
            left_ddl = db.get_ddl(schema, name, obj.type) or ""
            right_ddl = second_db.get_ddl(schema, name, obj.type) or ""

            # Normalise whitespace for comparison
            left_norm = " ".join(left_ddl.split())
            right_norm = " ".join(right_ddl.split())

            if left_norm == right_norm:
                in_sync.append({"name": name, "type": obj.type, "schema": schema})
            else:
                drifted.append({
                    "name": name,
                    "type": obj.type,
                    "schema": schema,
                    "left_ddl": left_ddl,
                    "right_ddl": right_ddl,
                })

        return {
            "schema": schema,
            "object_types": object_types,
            "summary": {
                "only_in_source": len(only_in_left),
                "only_in_target": len(only_in_right),
                "drifted": len(drifted),
                "in_sync": len(in_sync),
                "total_compared": len(left_names & right_names),
            },
            "only_in_source": only_in_left,
            "only_in_target": only_in_right,
            "drifted": drifted,
            "in_sync": in_sync,
        }
    finally:
        second_db.close()


# ── Entry Point ───────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="app-mcp: PostgreSQL MCP Server for DMCR")
    parser.add_argument(
        "--conn",
        default=os.environ.get("APP_PG_CONN", ""),
        help="PostgreSQL connection string (or set APP_PG_CONN env var)",
    )
    parser.add_argument(
        "--config",
        default=os.environ.get("APP_MCP_CONFIG", ""),
        help="Path to app_mcp.yaml/json config file (or set APP_MCP_CONFIG env var)",
    )
    args = parser.parse_args()

    # Initialize log4py — logs go to ./logs/app-mcp.log
    log_home = os.environ.get("APP_MCP_LOG_HOME", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "logs"))
    init(LoggingConfig(app_name="app-mcp", log_home=log_home))

    conninfo = args.conn
    if not conninfo:
        log.error("No connection string provided. Use --conn or set APP_PG_CONN.")
        sys.exit(1)

    # Load config filter (optional — if not found, all objects exposed)
    obj_filter = load_config(args.config or None)

    # ── Big startup banner ────────────────────────────────────────────────────
    db_host = conninfo.split('@')[-1].split('/')[0] if '@' in conninfo else '(unknown)'
    db_name = conninfo.rsplit('/', 1)[-1] if '/' in conninfo else '(unknown)'
    config_path = args.config or '(auto-discovered)'
    cwd = os.getcwd()

    filter_status = "ACTIVE" if obj_filter.is_active else "NONE (all objects exposed)"
    schemas_str = ", ".join(obj_filter.schemas) if obj_filter.schemas else "(all)"
    include_str = (
        f"tables={len(obj_filter.include_tables)} views={len(obj_filter.include_views)} "
        f"funcs={len(obj_filter.include_functions)} seqs={len(obj_filter.include_sequences)}"
    )
    exclude_str = (
        f"tables={len(obj_filter.exclude_tables)} views={len(obj_filter.exclude_views)} "
        f"funcs={len(obj_filter.exclude_functions)} seqs={len(obj_filter.exclude_sequences)}"
    )

    banner_lines = [
        f"  Version     : app-mcp v0.1.0",
        f"  Python      : {sys.executable}",
        f"  CWD         : {cwd}",
        f"  DB Host     : {db_host}",
        f"  DB Name     : {db_name}",
        f"  Config      : {config_path}",
        f"  Log Home    : {log_home}",
        f"  Filter      : {filter_status}",
        f"  Schemas     : {schemas_str}",
        f"  Include     : {include_str}",
        f"  Exclude     : {exclude_str}",
    ]
    width = max(len(line) for line in banner_lines) + 4
    border = "=" * width

    log.info("")
    log.info(border)
    log.info("  APP-MCP SERVER STARTUP")
    log.info(border)
    for line in banner_lines:
        log.info(line)
    log.info(border)
    log.info("")

    server = create_server(conninfo, obj_filter)
    log.info("  Status: connected, serving tools via stdio")

    import asyncio
    asyncio.run(_run(server))


async def _run(server: Server) -> None:
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    main()
