"""Configuration file loader for app_mcp.

Supports an optional config file (app_mcp.yaml or app_mcp.json) that restricts
which database objects are exposed via MCP tools.

If no config file is found → ALL objects are exposed (no filter).
If a config file is found → only listed objects are returned by discover_objects
and describe_* tools.

Config format (YAML or JSON):
─────────────────────────────
schemas:
  - public
  - schema_1

include:
  tables:
    - public.users
    - public.orders
    - schema_1.app_*         # wildcards supported
  views:
    - public.active_users_v
  functions:
    - public.calc_*
  sequences:
    - public.*_seq
  enums:
    - public.status_type

exclude:
  tables:
    - public.temp_*
    - public._*

# If include is specified, only matching objects are exposed.
# If exclude is specified, matching objects are hidden.
# If both are specified, include wins (then exclude filters from included set).
# If neither is specified (or config not present), all objects are exposed.
"""

from __future__ import annotations

import fnmatch
import json
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)


@dataclass
class ObjectFilter:
    """Filter configuration for app_mcp."""

    schemas: list[str] = field(default_factory=list)
    include_tables: list[str] = field(default_factory=list)
    include_views: list[str] = field(default_factory=list)
    include_functions: list[str] = field(default_factory=list)
    include_sequences: list[str] = field(default_factory=list)
    include_enums: list[str] = field(default_factory=list)
    exclude_tables: list[str] = field(default_factory=list)
    exclude_views: list[str] = field(default_factory=list)
    exclude_functions: list[str] = field(default_factory=list)
    exclude_sequences: list[str] = field(default_factory=list)
    exclude_enums: list[str] = field(default_factory=list)

    @property
    def has_include(self) -> bool:
        return bool(
            self.include_tables or self.include_views or self.include_functions
            or self.include_sequences or self.include_enums
        )

    @property
    def has_exclude(self) -> bool:
        return bool(
            self.exclude_tables or self.exclude_views or self.exclude_functions
            or self.exclude_sequences or self.exclude_enums
        )

    @property
    def is_active(self) -> bool:
        """True if any filter rules are configured."""
        return bool(self.schemas or self.has_include or self.has_exclude)

    def is_schema_allowed(self, schema: str) -> bool:
        """Check if a schema is allowed (empty schemas list = all allowed)."""
        if not self.schemas:
            return True
        return schema in self.schemas

    def is_object_allowed(self, schema: str, obj_type: str, name: str) -> bool:
        """Check if a specific object passes the filter."""
        if not self.is_active:
            return True

        if not self.is_schema_allowed(schema):
            return False

        fqn = f"{schema}.{name}"
        include_list = self._get_include_list(obj_type)
        exclude_list = self._get_exclude_list(obj_type)

        # If include rules exist for this type, object must match at least one
        if include_list:
            if not _matches_any(fqn, include_list) and not _matches_any(name, include_list):
                return False

        # If exclude rules exist, object must NOT match any
        if exclude_list:
            if _matches_any(fqn, exclude_list) or _matches_any(name, exclude_list):
                return False

        return True

    def _get_include_list(self, obj_type: str) -> list[str]:
        mapping = {
            "table": self.include_tables,
            "view": self.include_views,
            "function": self.include_functions,
            "sequence": self.include_sequences,
            "enum": self.include_enums,
        }
        return mapping.get(obj_type, [])

    def _get_exclude_list(self, obj_type: str) -> list[str]:
        mapping = {
            "table": self.exclude_tables,
            "view": self.exclude_views,
            "function": self.exclude_functions,
            "sequence": self.exclude_sequences,
            "enum": self.exclude_enums,
        }
        return mapping.get(obj_type, [])


def _matches_any(value: str, patterns: list[str]) -> bool:
    """Check if value matches any fnmatch pattern in the list."""
    return any(fnmatch.fnmatch(value, p) for p in patterns)


def load_config(config_path: str | None = None) -> ObjectFilter:
    """Load filter config from file. Returns empty (no-filter) if not found.

    Search order (if config_path not given):
      1. APP_MCP_CONFIG env var
      2. <package_root>/app_mcp.yaml|yml|json
      3. <cwd>/app_mcp.yaml|yml|json
      4. ~/.app_mcp.yaml|yml|json
    """
    path = _resolve_config_path(config_path)
    if not path:
        log.warning("No app_mcp config found — all objects will be exposed (cwd=%s)", os.getcwd())
        return ObjectFilter()  # No filter — expose everything

    log.info("Loaded config from: %s", path.resolve())
    data = _load_file(path)
    if not data:
        log.warning("Config file found but empty/unparseable: %s", path)
        return ObjectFilter()

    filt = _parse_config(data)
    log.info("  schemas=%s, include_tables=%d patterns, include_views=%d, include_functions=%d",
             filt.schemas or ['(all)'], len(filt.include_tables), len(filt.include_views), len(filt.include_functions))
    return filt


def _resolve_config_path(explicit: str | None) -> Path | None:
    """Find the config file."""
    if explicit:
        p = Path(explicit)
        return p if p.is_file() else None

    env_path = os.environ.get("APP_MCP_CONFIG")
    if env_path:
        p = Path(env_path)
        if p.is_file():
            return p

    # Look relative to the project root (parent of this package) first,
    # then cwd, then user home. This ensures the config is found regardless
    # of which directory the process was spawned from.
    package_root = Path(__file__).resolve().parent.parent

    candidates = [
        package_root / "app_mcp.yaml",
        package_root / "app_mcp.yml",
        package_root / "app_mcp.json",
        Path("app_mcp.yaml"),
        Path("app_mcp.yml"),
        Path("app_mcp.json"),
        Path.home() / ".app_mcp.yaml",
        Path.home() / ".app_mcp.yml",
        Path.home() / ".app_mcp.json",
    ]
    for c in candidates:
        if c.is_file():
            return c

    return None


def _load_file(path: Path) -> dict[str, Any] | None:
    """Load YAML or JSON config file."""
    content = path.read_text(encoding="utf-8")

    if path.suffix in (".yaml", ".yml"):
        try:
            import yaml
        except ImportError:
            log.error("pyyaml is NOT installed! Cannot parse %s. Run: pip install pyyaml", path)
            return None
        try:
            return yaml.safe_load(content) or {}
        except Exception as e:
            log.error("Failed to parse YAML config %s: %s", path, e)
            return None

    try:
        return json.loads(content)
    except json.JSONDecodeError as e:
        log.error("Failed to parse JSON config %s: %s", path, e)
        return None


def _parse_config(data: dict[str, Any]) -> ObjectFilter:
    """Parse raw config dict into ObjectFilter."""
    schemas = data.get("schemas", [])
    include = data.get("include", {})
    exclude = data.get("exclude", {})

    return ObjectFilter(
        schemas=schemas if isinstance(schemas, list) else [],
        include_tables=_as_list(include.get("tables")),
        include_views=_as_list(include.get("views")),
        include_functions=_as_list(include.get("functions")),
        include_sequences=_as_list(include.get("sequences")),
        include_enums=_as_list(include.get("enums")),
        exclude_tables=_as_list(exclude.get("tables")),
        exclude_views=_as_list(exclude.get("views")),
        exclude_functions=_as_list(exclude.get("functions")),
        exclude_sequences=_as_list(exclude.get("sequences")),
        exclude_enums=_as_list(exclude.get("enums")),
    )


def _as_list(val: Any) -> list[str]:
    """Coerce to list of strings."""
    if val is None:
        return []
    if isinstance(val, list):
        return [str(v) for v in val]
    return [str(val)]
