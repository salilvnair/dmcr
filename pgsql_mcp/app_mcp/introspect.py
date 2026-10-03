"""PostgreSQL schema introspection via information_schema + pg_catalog.

Connection management uses psycopg_pool.ConnectionPool (Python's HikariCP):
  - Health-checks connections on borrow (check=check_connection)
  - Idle timeout eviction (max_idle)
  - Connection recycling (max_lifetime)
  - Auto-reconnect on dead connections
  - Read-only enforcement via configure callback
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any

import psycopg
from psycopg_pool import ConnectionPool

log = logging.getLogger(__name__)


# ── Data Models ───────────────────────────────────────────────────────────────

@dataclass
class ColumnInfo:
    name: str
    data_type: str
    is_nullable: bool
    column_default: str | None
    ordinal_position: int
    character_maximum_length: int | None = None
    numeric_precision: int | None = None

@dataclass
class ConstraintInfo:
    name: str
    type: str  # PRIMARY KEY, UNIQUE, FOREIGN KEY, CHECK, EXCLUDE
    columns: list[str]
    definition: str | None = None
    foreign_table: str | None = None
    foreign_columns: list[str] | None = None

@dataclass
class IndexInfo:
    name: str
    columns: list[str]
    is_unique: bool
    is_primary: bool
    definition: str

@dataclass
class TriggerInfo:
    name: str
    event: str
    timing: str
    function_name: str
    definition: str

@dataclass
class TableDetail:
    schema: str
    name: str
    type: str  # 'table' or 'view'
    columns: list[ColumnInfo]
    constraints: list[ConstraintInfo]
    indexes: list[IndexInfo]
    triggers: list[TriggerInfo]
    row_estimate: int = 0
    description: str | None = None

@dataclass
class FunctionDetail:
    schema: str
    name: str
    language: str
    return_type: str
    arguments: str
    body: str
    volatility: str
    description: str | None = None

@dataclass
class SequenceDetail:
    schema: str
    name: str
    data_type: str
    start_value: int
    increment: int
    min_value: int
    max_value: int
    current_value: int | None = None
    owned_by: str | None = None

@dataclass
class SchemaObject:
    schema: str
    name: str
    type: str  # table, view, function, sequence, enum, extension, trigger, index
    description: str | None = None


# ── Introspector (Repository) ─────────────────────────────────────────────────

class PgIntrospector:
    """PostgreSQL schema introspection backed by ConnectionPool.

    Equivalent to a Spring @Repository with injected DataSource:
      - ConnectionPool handles borrow/return/health-check/eviction
      - Each method borrows via `with self._pool.connection() as conn:`
      - Connection auto-returns to pool on exit (no leaks)
      - Pool config: min=1, max=3, idle=60s, lifetime=10min, health-check on borrow
    """

    def __init__(self, conninfo: str):
        self._conninfo = conninfo
        self._pool: ConnectionPool | None = None

    def connect(self) -> None:
        """Initialize the connection pool (call once at startup)."""
        if self._pool:
            self._pool.close()

        self._pool = ConnectionPool(
            conninfo=self._conninfo,
            min_size=1,
            max_size=3,
            max_idle=60.0,
            max_lifetime=600.0,
            timeout=10.0,
            check=ConnectionPool.check_connection,
            configure=self._configure_conn,
            open=True,
            name="app-mcp-pool",
        )
        log.info("Connection pool opened: min=1 max=3 idle=60s lifetime=600s")

    @staticmethod
    def _configure_conn(conn: psycopg.Connection) -> None:
        """Applied to every new connection (like HikariCP connectionInitSql)."""
        conn.autocommit = True
        conn.execute("SET default_transaction_read_only = ON")

    def close(self) -> None:
        """Shutdown pool."""
        if self._pool:
            self._pool.close()
            self._pool = None
            log.info("Connection pool closed")

    @property
    def pool(self) -> ConnectionPool:
        if not self._pool:
            self.connect()
        assert self._pool is not None
        return self._pool

    # ── Schema listing ────────────────────────────────────────────────────

    def list_schemas(self) -> list[str]:
        with self.pool.connection() as conn:
            rows = conn.execute(
                "SELECT schema_name FROM information_schema.schemata "
                "WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast') "
                "ORDER BY schema_name"
            ).fetchall()
        return [r[0] for r in rows]

    # ── Object listing ────────────────────────────────────────────────────

    def list_objects(self, schema: str = "public") -> list[SchemaObject]:
        objects: list[SchemaObject] = []

        with self.pool.connection() as conn:
            # Tables & views
            rows = conn.execute(
                "SELECT table_name, table_type FROM information_schema.tables "
                "WHERE table_schema = %s ORDER BY table_name",
                (schema,),
            ).fetchall()
            for name, ttype in rows:
                obj_type = "view" if ttype == "VIEW" else "table"
                objects.append(SchemaObject(schema=schema, name=name, type=obj_type))

            # Functions
            rows = conn.execute(
                "SELECT routine_name FROM information_schema.routines "
                "WHERE routine_schema = %s AND routine_type = 'FUNCTION' "
                "ORDER BY routine_name",
                (schema,),
            ).fetchall()
            seen_funcs: set[str] = set()
            for (name,) in rows:
                if name not in seen_funcs:
                    seen_funcs.add(name)
                    objects.append(SchemaObject(schema=schema, name=name, type="function"))

            # Sequences
            rows = conn.execute(
                "SELECT sequence_name FROM information_schema.sequences "
                "WHERE sequence_schema = %s ORDER BY sequence_name",
                (schema,),
            ).fetchall()
            for (name,) in rows:
                objects.append(SchemaObject(schema=schema, name=name, type="sequence"))

            # Enums
            rows = conn.execute(
                "SELECT t.typname FROM pg_catalog.pg_type t "
                "JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace "
                "WHERE n.nspname = %s AND t.typtype = 'e' ORDER BY t.typname",
                (schema,),
            ).fetchall()
            for (name,) in rows:
                objects.append(SchemaObject(schema=schema, name=name, type="enum"))

        return objects

    # ── Table detail ──────────────────────────────────────────────────────

    def describe_table(self, schema: str, name: str) -> TableDetail:
        with self.pool.connection() as conn:
            # Columns
            cols_rows = conn.execute(
                "SELECT column_name, data_type, is_nullable, column_default, "
                "ordinal_position, character_maximum_length, numeric_precision "
                "FROM information_schema.columns "
                "WHERE table_schema = %s AND table_name = %s "
                "ORDER BY ordinal_position",
                (schema, name),
            ).fetchall()
            columns = [
                ColumnInfo(
                    name=r[0], data_type=r[1], is_nullable=(r[2] == "YES"),
                    column_default=r[3], ordinal_position=r[4],
                    character_maximum_length=r[5], numeric_precision=r[6],
                )
                for r in cols_rows
            ]

            # Constraints
            constraints = self._get_constraints(conn, schema, name)

            # Indexes
            indexes = self._get_indexes(conn, schema, name)

            # Triggers
            triggers = self._get_triggers(conn, schema, name)

            # Row estimate
            row_est_row = conn.execute(
                "SELECT reltuples::bigint FROM pg_catalog.pg_class c "
                "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace "
                "WHERE n.nspname = %s AND c.relname = %s",
                (schema, name),
            ).fetchone()
            row_estimate = max(0, int(row_est_row[0])) if row_est_row else 0

            # Is it a view?
            type_row = conn.execute(
                "SELECT table_type FROM information_schema.tables "
                "WHERE table_schema = %s AND table_name = %s",
                (schema, name),
            ).fetchone()
            obj_type = "view" if type_row and type_row[0] == "VIEW" else "table"

            # Description
            desc_row = conn.execute(
                "SELECT obj_description(c.oid) FROM pg_catalog.pg_class c "
                "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace "
                "WHERE n.nspname = %s AND c.relname = %s",
                (schema, name),
            ).fetchone()
            description = desc_row[0] if desc_row else None

        return TableDetail(
            schema=schema, name=name, type=obj_type, columns=columns,
            constraints=constraints, indexes=indexes, triggers=triggers,
            row_estimate=row_estimate, description=description,
        )

    @staticmethod
    def _get_constraints(conn: psycopg.Connection, schema: str, table: str) -> list[ConstraintInfo]:
        rows = conn.execute("""
            SELECT
                tc.constraint_name,
                tc.constraint_type,
                array_agg(kcu.column_name ORDER BY kcu.ordinal_position) AS columns,
                pg_get_constraintdef(pgc.oid) AS definition,
                ccu.table_name AS foreign_table,
                array_agg(DISTINCT ccu.column_name) FILTER (WHERE tc.constraint_type = 'FOREIGN KEY') AS foreign_columns
            FROM information_schema.table_constraints tc
            JOIN pg_catalog.pg_constraint pgc
                ON pgc.conname = tc.constraint_name
                AND pgc.connamespace = (SELECT oid FROM pg_namespace WHERE nspname = tc.constraint_schema)
            LEFT JOIN information_schema.key_column_usage kcu
                ON kcu.constraint_name = tc.constraint_name
                AND kcu.constraint_schema = tc.constraint_schema
            LEFT JOIN information_schema.constraint_column_usage ccu
                ON ccu.constraint_name = tc.constraint_name
                AND ccu.constraint_schema = tc.constraint_schema
            WHERE tc.table_schema = %s AND tc.table_name = %s
            GROUP BY tc.constraint_name, tc.constraint_type, pgc.oid, ccu.table_name
            ORDER BY tc.constraint_type, tc.constraint_name
        """, (schema, table)).fetchall()

        return [
            ConstraintInfo(
                name=r[0], type=r[1], columns=r[2] or [],
                definition=r[3], foreign_table=r[4],
                foreign_columns=r[5] if r[5] else None,
            )
            for r in rows
        ]

    @staticmethod
    def _get_indexes(conn: psycopg.Connection, schema: str, table: str) -> list[IndexInfo]:
        rows = conn.execute("""
            SELECT
                i.relname AS index_name,
                array_agg(a.attname ORDER BY x.n) AS columns,
                ix.indisunique,
                ix.indisprimary,
                pg_get_indexdef(ix.indexrelid) AS definition
            FROM pg_catalog.pg_index ix
            JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
            JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
            JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
            CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS x(attnum, n)
            JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.attnum
            WHERE n.nspname = %s AND t.relname = %s
            GROUP BY i.relname, ix.indisunique, ix.indisprimary, ix.indexrelid
            ORDER BY i.relname
        """, (schema, table)).fetchall()

        return [
            IndexInfo(
                name=r[0], columns=r[1] or [], is_unique=r[2],
                is_primary=r[3], definition=r[4],
            )
            for r in rows
        ]

    @staticmethod
    def _get_triggers(conn: psycopg.Connection, schema: str, table: str) -> list[TriggerInfo]:
        rows = conn.execute("""
            SELECT
                t.tgname,
                em.text AS event,
                CASE WHEN t.tgtype & 2 = 2 THEN 'BEFORE'
                     WHEN t.tgtype & 64 = 64 THEN 'INSTEAD OF'
                     ELSE 'AFTER' END AS timing,
                p.proname AS function_name,
                pg_get_triggerdef(t.oid) AS definition
            FROM pg_catalog.pg_trigger t
            JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
            CROSS JOIN LATERAL (
                SELECT string_agg(
                    CASE bit
                        WHEN 4 THEN 'INSERT'
                        WHEN 8 THEN 'DELETE'
                        WHEN 16 THEN 'UPDATE'
                        WHEN 32 THEN 'TRUNCATE'
                    END, ' OR '
                ) AS text
                FROM unnest(ARRAY[4,8,16,32]) AS bit
                WHERE t.tgtype & bit = bit
            ) em
            WHERE n.nspname = %s AND c.relname = %s AND NOT t.tgisinternal
            ORDER BY t.tgname
        """, (schema, table)).fetchall()

        return [
            TriggerInfo(
                name=r[0], event=r[1] or "", timing=r[2],
                function_name=r[3], definition=r[4],
            )
            for r in rows
        ]

    # ── Function detail ───────────────────────────────────────────────────

    def describe_function(self, schema: str, name: str) -> FunctionDetail | None:
        with self.pool.connection() as conn:
            row = conn.execute("""
                SELECT
                    p.proname,
                    l.lanname,
                    pg_get_function_result(p.oid) AS return_type,
                    pg_get_function_identity_arguments(p.oid) AS arguments,
                    pg_get_functiondef(p.oid) AS body,
                    CASE p.provolatile
                        WHEN 'v' THEN 'VOLATILE'
                        WHEN 's' THEN 'STABLE'
                        WHEN 'i' THEN 'IMMUTABLE'
                    END AS volatility,
                    obj_description(p.oid) AS description
                FROM pg_catalog.pg_proc p
                JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                JOIN pg_catalog.pg_language l ON l.oid = p.prolang
                WHERE n.nspname = %s AND p.proname = %s
                LIMIT 1
            """, (schema, name)).fetchone()

        if not row:
            return None

        return FunctionDetail(
            schema=schema, name=row[0], language=row[1],
            return_type=row[2], arguments=row[3], body=row[4],
            volatility=row[5], description=row[6],
        )

    # ── Sequence detail ───────────────────────────────────────────────────

    def describe_sequence(self, schema: str, name: str) -> SequenceDetail | None:
        with self.pool.connection() as conn:
            row = conn.execute(
                "SELECT data_type, start_value::bigint, increment::bigint, "
                "minimum_value::bigint, maximum_value::bigint "
                "FROM information_schema.sequences "
                "WHERE sequence_schema = %s AND sequence_name = %s",
                (schema, name),
            ).fetchone()

            if not row:
                return None

            # Get current value safely
            current = None
            try:
                cv = conn.execute(
                    f"SELECT last_value FROM {schema}.{name}"  # noqa: S608 — schema/name validated via info_schema
                ).fetchone()
                current = cv[0] if cv else None
            except Exception:
                pass

            # Check if owned by a column
            owned_row = conn.execute("""
                SELECT a.attname, c.relname
                FROM pg_catalog.pg_depend d
                JOIN pg_catalog.pg_class s ON s.oid = d.objid
                JOIN pg_catalog.pg_namespace sn ON sn.oid = s.relnamespace
                JOIN pg_catalog.pg_class c ON c.oid = d.refobjid
                JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.refobjsubid
                WHERE sn.nspname = %s AND s.relname = %s
                AND d.deptype = 'a'
                LIMIT 1
            """, (schema, name)).fetchone()
            owned_by = f"{owned_row[1]}.{owned_row[0]}" if owned_row else None

        return SequenceDetail(
            schema=schema, name=name, data_type=row[0],
            start_value=int(row[1]), increment=int(row[2]),
            min_value=int(row[3]), max_value=int(row[4]),
            current_value=current, owned_by=owned_by,
        )

    # ── Enum detail ───────────────────────────────────────────────────────

    def describe_enum(self, schema: str, name: str) -> dict[str, Any] | None:
        with self.pool.connection() as conn:
            rows = conn.execute("""
                SELECT e.enumlabel
                FROM pg_catalog.pg_enum e
                JOIN pg_catalog.pg_type t ON t.oid = e.enumtypid
                JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
                WHERE n.nspname = %s AND t.typname = %s
                ORDER BY e.enumsortorder
            """, (schema, name)).fetchall()

        if not rows:
            return None

        return {"schema": schema, "name": name, "type": "enum", "values": [r[0] for r in rows]}

    # ── DDL Generation ────────────────────────────────────────────────────

    def get_ddl(self, schema: str, name: str, object_type: str) -> str:
        """Return the full SQL DDL/definition for a database object.

        Uses PostgreSQL catalog functions for accurate DDL generation:
          - Tables: Reconstructs CREATE TABLE with columns, constraints, indexes
          - Views:  pg_get_viewdef()
          - Functions: pg_get_functiondef()
          - Sequences: Reconstructs CREATE SEQUENCE from attributes
          - Enums: Reconstructs CREATE TYPE ... AS ENUM
        """
        obj_type = object_type.lower()

        if obj_type == 'table':
            return self._get_table_ddl(schema, name)
        elif obj_type == 'view':
            return self._get_view_ddl(schema, name)
        elif obj_type == 'function':
            return self._get_function_ddl(schema, name)
        elif obj_type == 'sequence':
            return self._get_sequence_ddl(schema, name)
        elif obj_type == 'enum':
            return self._get_enum_ddl(schema, name)
        else:
            return ""

    def _get_table_ddl(self, schema: str, name: str) -> str:
        """Reconstruct CREATE TABLE DDL from catalog."""
        with self.pool.connection() as conn:
            # Columns
            cols = conn.execute("""
                SELECT
                    a.attname,
                    pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
                    a.attnotnull,
                    pg_get_expr(d.adbin, d.adrelid) AS default_val
                FROM pg_catalog.pg_attribute a
                JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
                JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                WHERE n.nspname = %s AND c.relname = %s
                  AND a.attnum > 0 AND NOT a.attisdropped
                ORDER BY a.attnum
            """, (schema, name)).fetchall()

            if not cols:
                return ""

            # Constraints
            constraints = conn.execute("""
                SELECT pg_get_constraintdef(c.oid), c.conname, c.contype
                FROM pg_catalog.pg_constraint c
                JOIN pg_catalog.pg_class r ON r.oid = c.conrelid
                JOIN pg_catalog.pg_namespace n ON n.oid = r.relnamespace
                WHERE n.nspname = %s AND r.relname = %s
                ORDER BY c.contype, c.conname
            """, (schema, name)).fetchall()

            # Indexes (non-constraint)
            indexes = conn.execute("""
                SELECT pg_get_indexdef(i.indexrelid)
                FROM pg_catalog.pg_index i
                JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
                JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = %s AND c.relname = %s
                  AND NOT i.indisprimary
                  AND NOT EXISTS (
                      SELECT 1 FROM pg_catalog.pg_constraint con
                      WHERE con.conindid = i.indexrelid
                  )
                ORDER BY i.indexrelid
            """, (schema, name)).fetchall()

        # Build DDL
        lines = []
        for col_name, data_type, notnull, default_val in cols:
            col_def = f"    {col_name} {data_type}"
            if default_val:
                col_def += f" DEFAULT {default_val}"
            if notnull:
                col_def += " NOT NULL"
            lines.append(col_def)

        # Add constraints
        for con_def, con_name, _con_type in constraints:
            lines.append(f"    CONSTRAINT {con_name} {con_def}")

        ddl = f"CREATE TABLE {schema}.{name} (\n"
        ddl += ",\n".join(lines)
        ddl += "\n);\n"

        # Append indexes as separate statements
        for (idx_def,) in indexes:
            ddl += f"\n{idx_def};\n"

        return ddl

    def _get_view_ddl(self, schema: str, name: str) -> str:
        """Get CREATE VIEW DDL using pg_get_viewdef."""
        with self.pool.connection() as conn:
            row = conn.execute("""
                SELECT pg_get_viewdef(c.oid, true)
                FROM pg_catalog.pg_class c
                JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = %s AND c.relname = %s AND c.relkind IN ('v', 'm')
            """, (schema, name)).fetchone()

        if not row or not row[0]:
            return ""

        kind = "VIEW"
        # Check if materialized
        with self.pool.connection() as conn:
            mat = conn.execute("""
                SELECT c.relkind FROM pg_catalog.pg_class c
                JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = %s AND c.relname = %s
            """, (schema, name)).fetchone()
        if mat and mat[0] == 'm':
            kind = "MATERIALIZED VIEW"

        return f"CREATE OR REPLACE {kind} {schema}.{name} AS\n{row[0]};\n"

    def _get_function_ddl(self, schema: str, name: str) -> str:
        """Get CREATE FUNCTION DDL using pg_get_functiondef."""
        with self.pool.connection() as conn:
            row = conn.execute("""
                SELECT pg_get_functiondef(p.oid)
                FROM pg_catalog.pg_proc p
                JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = %s AND p.proname = %s
                LIMIT 1
            """, (schema, name)).fetchone()

        if not row or not row[0]:
            return ""
        return row[0] + ";\n"

    def _get_sequence_ddl(self, schema: str, name: str) -> str:
        """Reconstruct CREATE SEQUENCE DDL from attributes."""
        with self.pool.connection() as conn:
            row = conn.execute("""
                SELECT
                    s.seqtypid::regtype::text AS data_type,
                    s.seqstart,
                    s.seqincrement,
                    s.seqmin,
                    s.seqmax,
                    s.seqcache,
                    s.seqcycle
                FROM pg_catalog.pg_sequence s
                JOIN pg_catalog.pg_class c ON c.oid = s.seqrelid
                JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = %s AND c.relname = %s
            """, (schema, name)).fetchone()

        if not row:
            return ""

        data_type, start, inc, minv, maxv, cache, cycle = row
        parts = [f"CREATE SEQUENCE {schema}.{name}"]
        if data_type != 'bigint':
            parts.append(f"    AS {data_type}")
        parts.append(f"    INCREMENT BY {inc}")
        parts.append(f"    MINVALUE {minv}")
        parts.append(f"    MAXVALUE {maxv}")
        parts.append(f"    START WITH {start}")
        parts.append(f"    CACHE {cache}")
        parts.append(f"    {'CYCLE' if cycle else 'NO CYCLE'}")

        # Check ownership
        with self.pool.connection() as conn:
            owned = conn.execute("""
                SELECT c.relname, a.attname
                FROM pg_catalog.pg_depend d
                JOIN pg_catalog.pg_class s ON s.oid = d.objid
                JOIN pg_catalog.pg_namespace sn ON sn.oid = s.relnamespace
                JOIN pg_catalog.pg_class c ON c.oid = d.refobjid
                JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.refobjsubid
                WHERE sn.nspname = %s AND s.relname = %s AND d.deptype = 'a'
                LIMIT 1
            """, (schema, name)).fetchone()

        ddl = "\n".join(parts) + ";\n"
        if owned:
            ddl += f"\nALTER SEQUENCE {schema}.{name} OWNED BY {owned[0]}.{owned[1]};\n"
        return ddl

    def _get_enum_ddl(self, schema: str, name: str) -> str:
        """Reconstruct CREATE TYPE ... AS ENUM DDL."""
        with self.pool.connection() as conn:
            rows = conn.execute("""
                SELECT e.enumlabel
                FROM pg_catalog.pg_enum e
                JOIN pg_catalog.pg_type t ON t.oid = e.enumtypid
                JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
                WHERE n.nspname = %s AND t.typname = %s
                ORDER BY e.enumsortorder
            """, (schema, name)).fetchall()

        if not rows:
            return ""

        values = ", ".join(f"'{r[0]}'" for r in rows)
        return f"CREATE TYPE {schema}.{name} AS ENUM ({values});\n"

    # ── Read-only query ───────────────────────────────────────────────────

    # Statements a read-only exploration query may start with.
    READONLY_FIRST_WORDS = ("SELECT", "WITH", "EXPLAIN", "SHOW", "VALUES", "TABLE")
    # Functions that act on the server even inside a read-only transaction.
    BLOCKED_FUNCTIONS = re.compile(
        r"\b(pg_terminate_backend|pg_cancel_backend|pg_sleep\w*|set_config|pg_reload_conf|"
        r"pg_rotate_logfile|pg_read_file|pg_read_binary_file|pg_ls_\w+|pg_stat_file|lo_\w+|"
        r"dblink\w*|pg_advisory\w*|pg_switch_wal|pg_create_\w+|pg_drop_\w+|pg_promote|"
        r"pg_logical_\w+|pg_replication_\w+|nextval|setval)\s*\(",
        re.IGNORECASE,
    )
    MAX_ROWS = 1000
    STATEMENT_TIMEOUT = "10s"

    def run_readonly_query(self, sql: str, limit: int = 100) -> dict[str, Any]:
        """Run ONE read-only statement and return at most `limit` rows (capped at MAX_ROWS).

        Safety does not rely on text checks alone:
          - the statement is sent with the extended query protocol (prepare=True), which the
            server rejects if it contains more than one command, so `SELECT 1; COMMIT; ...`
            cannot break out;
          - it runs in its own READ ONLY transaction with a statement timeout;
          - the first keyword must be a read-only statement, and functions that act on the
            server even when read-only (pg_terminate_backend, pg_sleep, set_config, dblink,
            file readers, ...) are refused.
        """
        if not isinstance(sql, str) or not sql.strip():
            raise ValueError("'sql' is required")
        try:
            row_limit = int(limit)
        except (TypeError, ValueError):
            raise ValueError("'limit' must be an integer") from None
        row_limit = max(1, min(row_limit, self.MAX_ROWS))

        stripped = sql.strip().rstrip(";").strip()
        first_word = stripped.split(None, 1)[0].upper() if stripped else ""
        if first_word not in self.READONLY_FIRST_WORDS:
            raise ValueError(
                "Only read-only statements are allowed (" + ", ".join(self.READONLY_FIRST_WORDS) + ")"
            )
        blocked = self.BLOCKED_FUNCTIONS.search(stripped)
        if blocked:
            raise ValueError(f"'{blocked.group(1)}' is not allowed in read-only exploration queries")

        with self.pool.connection() as conn:
            with conn.transaction():
                conn.execute("SET TRANSACTION READ ONLY")
                conn.execute(f"SET LOCAL statement_timeout = '{self.STATEMENT_TIMEOUT}'")
                cur = conn.cursor()
                cur.execute(stripped, prepare=True)
                columns = [desc[0] for desc in cur.description or []]
                fetched = cur.fetchmany(row_limit) if cur.description else []
                rows = [[str(v) if v is not None else None for v in row] for row in fetched]
        return {"columns": columns, "rows": rows, "row_count": len(rows), "limit": row_limit}
