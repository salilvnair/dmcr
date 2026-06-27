"""
log4py core.py - Logback-style logging utilities for Python.

Provides:
- Size + time based rolling logs (daily + maxBytes)
- Archived logs retention (maxHistoryDays) and optional total size cap
- MDC-like context (per thread/async context) for correlation IDs, etc.
- Flask / Flask-RESTX API request/response audit logging:
  - Enabled per-endpoint via @log4py.api(...)
  - Supports extracting MDC values from headers or JSON body via JSONPath (jsonpath-ng optional)
  - Logs JSON bodies only; for non-JSON or oversized bodies logs "content skipped ..."

"""

import logging
import os
import re
import time
import json
import contextvars
import socket
from dataclasses import dataclass
from datetime import datetime, date, timezone
from pathlib import Path
from typing import Optional, Mapping, Any, Literal, Sequence, Callable, cast

# Flask is optional; only required if you use FlaskApiLogHandler / decorator resolution at runtime
try:
    from flask import current_app, g, request  # type: ignore
except ImportError:  # pragma: no cover
    current_app = None  # type: ignore
    g = None  # type: ignore
    request = None  # type: ignore

# jsonpath-ng is optional; used for complex JSONPath extraction
_jsonpath_parse: Optional[Callable[[str], Any]]
try:
    from jsonpath_ng import parse as _jsonpath_parse  # type: ignore
except ImportError:  # pragma: no cover
    _jsonpath_parse = None

# -----------------------------------------------------------------------------
# MDC (mapped diagnostic context) - thread/task safe via contextvars
# -----------------------------------------------------------------------------

_mdc: contextvars.ContextVar[dict[str, str]] = contextvars.ContextVar("mdc", default={})

def mdc_put(key: str, value: Any) -> contextvars.Token:
    """
    Put a key/value into the current context (like MDC.put).
    Returns a token you can pass to mdc_reset() to restore previous state.
    """
    current = _mdc.get()
    new_map = dict(current)
    new_map[str(key)] = str(value)
    return _mdc.set(new_map)

def mdc_remove(key: str) -> contextvars.Token:
    """Remove a key from context. Returns token for mdc_reset()."""
    current = _mdc.get()
    if key not in current:
        return _mdc.set(dict(current))  # no-op but still returns token
    new_map = dict(current)
    new_map.pop(key, None)
    return _mdc.set(new_map)

def mdc_clear() -> contextvars.Token:
    """Clear all MDC values for current context. Returns token for mdc_reset()."""
    return _mdc.set({})

def mdc_set(values: Mapping[str, Any]) -> contextvars.Token:
    """Replace MDC map for current context. Returns token for mdc_reset()."""
    return _mdc.set({str(k): str(v) for k, v in values.items()})

def mdc_reset(token: contextvars.Token) -> None:
    """Reset MDC to previous state using token returned from put/remove/clear/set."""
    _mdc.reset(token)

def mdc_get() -> dict[str, str]:
    return dict(_mdc.get())

def _render_mdc(values: dict[str, str]) -> str:
    if not values:
        return "-"
    return ", ".join(f"{k}={values[k]}" for k in sorted(values))

# -----------------------------------------------------------------------------
# Logging config + handler (size + time)
# -----------------------------------------------------------------------------

@dataclass(frozen=True)
class LoggingConfig:
    app_name: str
    log_home: str
    level: int = logging.DEBUG
    max_bytes: int = 100 * 1024 * 1024  # 100MB
    max_history_days: int = 30
    total_size_cap_bytes: Optional[int] = 10 * 1024 * 1024 * 1024  # 10GB, set None to disable
    encoding: str = "utf-8"
    use_utc: bool = False
    pattern="%(asctime)s %(name)s [%(threadName)s] [%(filename)s:%(lineno)d] [%(host)s] [%(mdc)s] %(levelname)s - %(message)s"

class SizeAndTimeRotatingFileHandler(logging.Handler):
    """
    Logback-like "SizeAndTimeBasedRollingPolicy" for Python:
      - Active file: <log_home>/<app_name>.log
      - Rolled files: <log_home>/archived/<app_name>.YYYY-MM-DD.i.log
      - Rolls on:
          * midnight (date boundary), OR
          * when active file size exceeds max_bytes
      - Retention:
          * delete archives older than max_history_days
          * optional total archive size cap (delete oldest first)
    """

    def __init__(
        self,
        app_name: str,
        log_home: Path,
        max_bytes: int,
        max_history_days: int,
        total_size_cap_bytes: Optional[int] = None,
        encoding: str = "utf-8",
        use_utc: bool = False,
    ) -> None:
        super().__init__()
        self.app_name = app_name
        self.log_home = Path(log_home)
        self.archive_dir = self.log_home / "archived"
        self.archive_dir.mkdir(parents=True, exist_ok=True)

        self.active_file = self.log_home / f"{self.app_name}.log"
        self.max_bytes = int(max_bytes)
        self.max_history_days = int(max_history_days)
        self.total_size_cap_bytes = total_size_cap_bytes if total_size_cap_bytes is None else int(total_size_cap_bytes)
        self.encoding = encoding
        self.use_utc = bool(use_utc)

        self._stream = None
        self._current_date = self._now_date()
        self._open()

        self._rollover_if_active_from_previous_day()

        self._cleanup_archives()

    def _now_date(self) -> date:
        if self.use_utc:
            return datetime.now(timezone.utc).date()
        return datetime.now().date()

    def _rollover_if_active_from_previous_day(self) -> None:
        """
        If <app_name>.log exists and its mtime is from a previous date,
        roll it to archived/<app_name>.YYYY-MM-DD.i.log immediately.

        This matches the common Logback behavior where the active file is effectively
        "for today" and previous-day content is archived.
        """
        try:
            if not self.active_file.exists():
                return

            st = self.active_file.stat()
            if st.st_size <= 0:
                return

            file_dt = datetime.fromtimestamp(
                st.st_mtime,
                tz=timezone.utc if self.use_utc else None,
            )
            file_date = file_dt.date()
            today = self._now_date()

            if file_date >= today:
                return

            # Roll using the file's date so the archive name matches the day the content was written.
            if self._stream:
                self._stream.close()
                self._stream = None

            rolled_date = file_date.strftime("%Y-%m-%d")
            next_index = self._next_index_for_date(rolled_date)
            dest = self.archive_dir / f"{self.app_name}.{rolled_date}.{next_index}.log"
            dest.parent.mkdir(parents=True, exist_ok=True)

            os.replace(self.active_file, dest)

            # After rolling, ensure current date is today and reopen active file
            self._current_date = today
            self._open()
        except OSError:
            # Best-effort; don't break app startup due to rollover issues
            try:
                if self._stream is None:
                    self._open()
            except OSError:
                pass

    def _open(self) -> None:
        self.log_home.mkdir(parents=True, exist_ok=True)
        self._stream = open(self.active_file, mode="a", encoding=self.encoding, buffering=1)

    def close(self) -> None:
        try:
            if self._stream:
                self._stream.close()
                self._stream = None
        finally:
            super().close()

    def emit(self, record: logging.LogRecord) -> None:
        try:
            msg = self.format(record)
            if self._should_rollover(len(msg) + 1):
                self._do_rollover()

            if not self._stream:
                self._open()

            self._stream.write(msg + "\n")
        except (OSError, ValueError, TypeError, AttributeError) as exc:
            # logging contract: never raise from emit; delegate to logging's error handling
            try:
                record._log4py_emit_error = f"{type(exc).__name__}: {exc}"
            except (AttributeError, TypeError):
                pass
            self.handleError(record)

    def _active_size(self) -> int:
        try:
            return self.active_file.stat().st_size
        except FileNotFoundError:
            return 0

    def _should_rollover(self, incoming_bytes: int) -> bool:
        # time-based rollover
        now_date = self._now_date()
        if now_date != self._current_date:
            return True

        # size-based rollover (only if max_bytes > 0)
        if 0 < self.max_bytes <= (self._active_size() + incoming_bytes):
            return True

        return False

    def _do_rollover(self) -> None:
        # close current stream so Windows can rename
        if self._stream:
            self._stream.close()
            self._stream = None

        if self.active_file.exists() and self.active_file.stat().st_size > 0:
            rolled_date = self._current_date.strftime("%Y-%m-%d")
            next_index = self._next_index_for_date(rolled_date)
            dest = self.archive_dir / f"{self.app_name}.{rolled_date}.{next_index}.log"

            dest.parent.mkdir(parents=True, exist_ok=True)
            os.replace(self.active_file, dest)

        # update date and reopen
        self._current_date = self._now_date()
        self._open()

        # cleanup after rolling
        self._cleanup_archives()

    def _next_index_for_date(self, ymd: str) -> int:
        pattern = re.compile(rf"^{re.escape(self.app_name)}\.{re.escape(ymd)}\.(\d+)\.log$")
        max_i = 0
        for p in self.archive_dir.glob(f"{self.app_name}.{ymd}.*.log"):
            m = pattern.match(p.name)
            if m:
                max_i = max(max_i, int(m.group(1)))
        return max_i + 1

    def _cleanup_archives(self) -> None:
        # 1) delete older than max_history_days (by file mtime)
        if self.max_history_days > 0:
            cutoff = time.time() - (self.max_history_days * 24 * 60 * 60)
            for p in self.archive_dir.glob(f"{self.app_name}.*.log"):
                try:
                    if p.stat().st_mtime < cutoff:
                        p.unlink(missing_ok=True)
                except OSError:
                    # ignore files we can't delete
                    pass

        # 2) enforce total size cap across archived logs
        if self.total_size_cap_bytes is not None and self.total_size_cap_bytes > 0:
            archives = []
            total = 0
            for p in self.archive_dir.glob(f"{self.app_name}.*.log"):
                try:
                    st = p.stat()
                    archives.append((st.st_mtime, p, st.st_size))
                    total += st.st_size
                except OSError:
                    pass

            if total <= self.total_size_cap_bytes:
                return

            # delete oldest first until under cap
            archives.sort(key=lambda t: t[0])
            for _, p, sz in archives:
                if total <= self.total_size_cap_bytes:
                    break
                try:
                    p.unlink(missing_ok=True)
                    total -= sz
                except OSError:
                    pass

class ContextEnricherFilter(logging.Filter):
    """Adds `host` and `mdc` attributes for formatters: %(host)s and %(mdc)s."""
    def __init__(self, host: str) -> None:
        super().__init__()
        self._host = host

    def filter(self, record: logging.LogRecord) -> bool:
        record.host = self._host
        record.mdc = _render_mdc(mdc_get())
        return True

def init(cfg: LoggingConfig) -> None:
    """
    Initialize root logging with LoggingConfig.
    """
    _setup_logging(
        app_name=cfg.app_name,
        log_home=cfg.log_home,
        level=cfg.level,
        max_bytes=cfg.max_bytes,
        max_history_days=cfg.max_history_days,
        total_size_cap_bytes=cfg.total_size_cap_bytes,
        pattern=cfg.pattern,
    )    

def _setup_logging(
    app_name: str,
    log_home: str,
    level: int = logging.DEBUG,
    max_bytes: int = 100 * 1024 * 1024,
    max_history_days: int = 30,
    total_size_cap_bytes: Optional[int] = 10 * 1024 * 1024 * 1024,
    pattern: str = "%(asctime)s - %(levelname)s - %(message)s",
) -> None:
    """
    Initialize root logging with SizeAndTimeRotatingFileHandler and MDC/host enrichment.
    """
    log_home = Path(log_home)
    log_home.mkdir(parents=True, exist_ok=True)

    handler = SizeAndTimeRotatingFileHandler(
        app_name=app_name,
        log_home=log_home,
        max_bytes=max_bytes,
        max_history_days=max_history_days,
        total_size_cap_bytes=total_size_cap_bytes,
        encoding="utf-8",
        use_utc=False,
    )

    host = socket.gethostname()
    handler.addFilter(ContextEnricherFilter(host))
    handler.setFormatter(logging.Formatter(pattern))

    root = logging.getLogger()
    root.setLevel(level)
    root.handlers.clear()
    root.addHandler(handler)

# -----------------------------------------------------------------------------
# Flask / Flask-RESTX per-endpoint annotation + audit logging
# -----------------------------------------------------------------------------

MdcKeyIn = Literal["header", "body"]
_API_META_ATTR = "__log4py_api_meta__"

@dataclass(frozen=True)
class MdcParam:
    """
    One extraction rule to populate MDC.

    - If mdc_key_in == "header": source is header named by mdc_key
    - If mdc_key_in == "body": source is JSONPath expression in mdc_value_json_path
    """
    mdc_key_in: MdcKeyIn                 # "header" | "body"
    mdc_key: str                         # MDC key to set
    mdc_value_json_path: str

@dataclass(frozen=True)
class ApiMeta:
    name: str
    enabled: bool = True
    mdc_params: tuple[MdcParam, ...] = ()



@dataclass(frozen=True)
class ErrorInfo:
    """
    Structured error details to include in the API audit log.
    """
    error_id: Optional[str] = None
    message: Optional[str] = None
    payload: Optional[Mapping[str, Any]] = None
    exception_type: Optional[str] = None
    exception_message: Optional[str] = None

def capture_error(
    *,
    error_id: Optional[str] = None,
    message: Optional[str] = None,
    payload: Optional[Mapping[str, Any]] = None,
    exception: Optional[BaseException] = None,
) -> None:
    """
    Store structured error info for the current request so FlaskApiLogHandler can log it.

    Call this from your Flask/Flask-RESTX error handlers.

    Example:
        log4py.capture_error(error_id="...", message="...", payload=response_json, exception=e)
    """
    if g is None:
        return

    if error_id is not None:
        g._log4py_error_id = str(error_id)
    if message is not None:
        g._log4py_error_message = str(message)
    if payload is not None:
        # store as plain dict for JSON serialization
        g._log4py_error_payload = dict(payload)
    if exception is not None:
        g._log4py_exception_type = type(exception).__name__
        g._log4py_exception_message = str(exception)


def _format_error_block(api_name: str) -> Optional[str]:
    """
    Build an error details block from values stored on flask.g.
    Returns None if nothing captured.
    """
    if g is None:
        return None

    payload = getattr(g, "_log4py_error_payload", None)
    err_id = getattr(g, "_log4py_error_id", None)
    err_msg = getattr(g, "_log4py_error_message", None)
    ex_type = getattr(g, "_log4py_exception_type", None)
    ex_msg = getattr(g, "_log4py_exception_message", None)

    if payload is None and err_id is None and err_msg is None and ex_type is None and ex_msg is None:
        return None

    lines = []
    if err_id is not None:
        lines.append(f"\t\"errorId\": {err_id},")
    if err_msg is not None:
        lines.append(f"\t\"message\": {err_msg},")
    if ex_type is not None:
        lines.append(f"\t\"exception_type\": {ex_type},")
    if ex_msg is not None:
        lines.append(f"\t\"exception_message\": {ex_msg},")
    if payload is not None:
        try:
            lines.append("\t"+_json_pretty(payload))
        except (TypeError, ValueError):
            lines.append("\t"+str(payload))
    joined_lines =  "\n".join(lines)
    joined_lines = "\nerrors: {" +   joined_lines
    joined_lines += "\n }"



@dataclass(frozen=True)
class ApiLoggingConfig:
    """
    Common API audit logging config applied across all annotated endpoints.
    """
    logger_name: str = "api.audit"
    level: int = logging.INFO

    log_request_headers: bool = True
    log_request_body: bool = True
    log_response_headers: bool = True
    log_response_body: bool = True

    max_body_chars: int = 20_000
    max_header_chars: int = 10_000

    include_query_string: bool = True

    error_extractor: Optional[Callable[[BaseException], Optional[ErrorInfo]]] = None

    is_error_response: Optional[Callable[[int], bool]] = None


class Log4pyExceptionCaptureMiddleware:
    """
    WSGI middleware that captures exceptions raised by the Flask app and stores
    extracted error details into flask.g (if available).

    This lets you keep log4py free of werkzeug/flask-restx exception imports,
    while still logging error payloads.
    """
    def __init__(self, wsgi_app: Callable, cfg: ApiLoggingConfig) -> None:
        self._wsgi_app = wsgi_app
        self._cfg = cfg

    def __call__(self, environ, start_response):
        try:
            return self._wsgi_app(environ, start_response)
        except BaseException as exc:
            # Only attempt extraction if Flask request context exists (g != None)
            if self._cfg.error_extractor is not None and g is not None:
                try:
                    info = self._cfg.error_extractor(exc)
                except (TypeError, ValueError, KeyError, AttributeError):
                    info = None

                if info is not None:
                    capture_error(
                        error_id=info.error_id,
                        message=info.message,
                        payload=info.payload,
                        exception=exc,
                    )
                else:
                    # at least capture exception type/message
                    capture_error(exception=exc)

            raise


def install_exception_capture(app: Any, cfg: ApiLoggingConfig) -> None:
    """
    Install exception capture middleware:
        install_exception_capture(app, api_cfg)

    Call this after creating the Flask app.
    """
    try:
        app.wsgi_app = Log4pyExceptionCaptureMiddleware(app.wsgi_app, cfg)
    except (AttributeError, TypeError):
        # Not a Flask app or no wsgi_app
        return


def api(
    name: str,
    enabled: bool = True,
    mdc_params: Optional[Sequence[MdcParam]] = None,
    # Back-compat single-param inputs (optional)
    mdc_key_in: Optional[MdcKeyIn] = None,
    mdc_key: Optional[str] = None,
    mdc_value_json_path: Optional[str] = None):
    """
    Decorator to annotate Flask endpoints:

        @api.route("/x", methods=["POST"])
        @log4py.api(name="CreateOrder", enabled=True)
        def create_order(): ...

    or above/below @route (either is fine).

    Preferred:
        @log4py.api(
            name="VALIDATE",
            enabled=True,
            mdc_params=[
                log4py.MdcParam("header", "requestId", "X-Request-Id"),
                log4py.MdcParam("body", "orderId", "$.order.id"),
            ],
        )

    Back-compat (single):
        @log4py.api(name="X", mdc_key_in="header", mdc_key="requestId", mdc_value_json_path="X-Request-Id")
    """
    params: list[MdcParam] = []
    if mdc_params:
        params.extend(list(mdc_params))

    if mdc_key_in is not None and mdc_key and mdc_value_json_path:
        params.append(
            MdcParam(
                mdc_key_in=cast(MdcKeyIn, mdc_key_in),
                mdc_key=mdc_key,
                mdc_value_json_path=mdc_value_json_path,
            )
        )
    def _decorator(func):
        setattr(func, _API_META_ATTR, ApiMeta(name=name, enabled=enabled, mdc_params=tuple(params)))
        return func

    return _decorator

def _apply_api_mdc(meta: ApiMeta) -> None:
    """
    Apply all MDC params for this API (if enabled).
    """
    if request is None:
        return
    if not meta.enabled or not meta.mdc_params:
        return

    body_obj: Any = None
    body_loaded = False

    for param in meta.mdc_params:
        try:
            if param.mdc_key_in == "header":
                val = request.headers.get(param.mdc_key)
                if val is not None and val != "":
                    mdc_put(param.mdc_key, val)
                continue

            if param.mdc_key_in == "body":
                if not request.is_json:
                    continue

                if not body_loaded:
                    body_obj = request.get_json(silent=True)
                    body_loaded = True

                if body_obj is None:
                    continue

                extracted = _extract_from_jsonpath(body_obj, param.mdc_value_json_path)
                if extracted is None:
                    continue

                if isinstance(extracted, (list, dict)):
                    mdc_put(param.mdc_key, json.dumps(extracted, ensure_ascii=False))
                else:
                    mdc_put(param.mdc_key, extracted)
                continue
        except (ValueError, TypeError, KeyError):
            continue

_jsonpath_cache: dict[str, Any] = {}

def _extract_from_jsonpath(body_obj: Any, expr: str) -> Optional[Any]:
    """
    Extract values using jsonpath-ng if installed.
    Returns None if jsonpath-ng isn't available or nothing matches.
    If multiple matches exist, returns a list.
    """
    if body_obj is None or not expr:
        return None

    if _jsonpath_parse is None:
        return None

    jp = _jsonpath_cache.get(expr)
    if jp is None:
        # jsonpath-ng parse can raise ValueError for bad expressions
        try:
            jp = _jsonpath_parse(expr)
        except ValueError:
            return None
        _jsonpath_cache[expr] = jp

    matches = [m.value for m in jp.find(body_obj)]
    if not matches:
        return None
    if len(matches) == 1:
        return matches[0]
    return matches

def _safe_truncate(s: str, limit: int) -> str:
    if s is None:
        return ""
    if limit is None or limit <= 0:
        return ""
    if len(s) <= limit:
        return s
    return s[:limit] + f"...(truncated, {len(s)} chars)"

def _headers_to_dict(headers: Any) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        for k, v in headers.items():
            out[str(k)] = str(v)
    except (AttributeError, TypeError):
        pass
    return out

def _json_pretty(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2)

def _guess_json_request_body_text() -> Optional[str]:
    if request is None:
        return None
    try:
        obj = request.get_json(silent=True)
        if obj is None:
            return None
        return _json_pretty(obj)
    except (ValueError, TypeError):
        return None

def _response_body_text(resp: Any) -> Optional[str]:
    """
    Best-effort: only for non-streaming responses.
    """
    try:
        body_bytes = resp.get_data(as_text=False)
        return body_bytes.decode("utf-8", errors="replace")
    except (AttributeError, TypeError, UnicodeDecodeError, RuntimeError):
        return None

def _resolve_api_meta() -> Optional[ApiMeta]:
    """
    Determine if current endpoint is annotated with @log4py.api(...).
    Returns ApiMeta if present, else None.

     Supports:
      - plain Flask view functions
      - Flask-RESTX / Flask-RESTful Resource methods (get/post/put/delete/...)
    """
    if request is None or current_app is None:
        return None

    try:
        # Prefer url_rule.endpoint (more reliable than request.endpoint in some integrations)
        endpoint: Optional[str] = None
        try:
            if request.url_rule is not None:
                endpoint = request.url_rule.endpoint
        except (AttributeError, RuntimeError, TypeError):
            endpoint = None

        if not endpoint:
            endpoint = request.endpoint

        if not endpoint:
            return None

        view_func = current_app.view_functions.get(endpoint)
        if not view_func:
            return None

        # 1) Plain Flask: metadata attached directly to view function
        meta = getattr(view_func, _API_META_ATTR, None)
        if meta:
            return meta

        # 2) Flask-RESTX / Flask-RESTful: view_func is often a wrapper.
        # Try to locate the Resource class + its method handler.
        resource_cls = getattr(view_func, "view_class", None)
        if resource_cls is None:
            # Some wrappers stash it under different attribute names; try common ones
            resource_cls = getattr(view_func, "cls", None) or getattr(view_func, "resource_class", None)

        if resource_cls is None:
            return None

        # Map HTTP method to method name on the Resource class (get/post/...)
        method_name = (request.method or "").lower()
        handler = getattr(resource_cls, method_name, None)
        if handler is None:
            return None

        # 1) Prefer method-level annotation
        meta = getattr(handler, _API_META_ATTR, None) if handler else None
        if meta:
            return meta

        # 2) Fallback: class-level annotation
        return getattr(resource_cls, _API_META_ATTR, None)
    except (AttributeError, KeyError, TypeError, RuntimeError):
        return None

def _is_json_content_type(content_type: Optional[str]) -> bool:
    if not content_type:
        return False
    return "application/json" in content_type.lower()

def _maybe_log_json_request_body(cfg: ApiLoggingConfig) -> str:
    """
    Returns:
      - pretty JSON string if small enough
      - 'content skipped due to size' if too big
      - 'content skipped (non-json)' if not json
      - '' if no body
    """
    if request is None:
        return ""

    # Only JSON
    if not request.is_json:
        return "content skipped (non-json)"

    # Try parse JSON
    try:
        obj = request.get_json(silent=True)
        if obj is None:
            return ""
        text = _json_pretty(obj)
    except (ValueError, TypeError):
        return ""

    if 0 < cfg.max_body_chars < len(text):
        return "content skipped due to size"

    return text

def _maybe_log_json_response_body(resp: Any, cfg: ApiLoggingConfig) -> str:
    """
    Logs response body only when response is JSON and below size limit.
    """
    try:
        ct = resp.headers.get("Content-Type")
    except (AttributeError, TypeError):
        ct = None

    if not _is_json_content_type(ct):
        return "content skipped (non-json)"

    body_text = _response_body_text(resp)
    if not body_text:
        return ""

    if 0 < cfg.max_body_chars < len(body_text):
        return "content skipped due to size"

    return body_text

class FlaskApiLogHandler:
    """
    Consumer calls:
        handler.before_request()
        handler.after_request(response)

    Only logs when the matched endpoint function is decorated with @log4py.api(...)
    and enabled=True.
    """

    def __init__(self, cfg: ApiLoggingConfig) -> None:
        self.cfg = cfg
        self._logger = logging.getLogger(cfg.logger_name)

    def before_request(self) -> None:
        if request is None or g is None:
            return

        meta = _resolve_api_meta()
        if not meta or not meta.enabled:
            # mark as "do not log" for after_request too
            g._log4py_api_enabled = False
            return

        # apply MDC params
        _apply_api_mdc(meta)

        g._log4py_api_enabled = True
        g._log4py_api_name = meta.name
        g._log4py_start = time.perf_counter()

        incoming_url = request.host_url + request.full_path if self.cfg.include_query_string else request.host_url + request.path
        resource_path = request.path
        method = request.method
        req_size = request.content_length if request.content_length is not None else -1

        lines = [
            f"\n\n====================================={meta.name} REQUEST BEGINS==========================================================",
            f"incoming_url: {incoming_url}",
            f"resource_path: {resource_path}",
            f"method: {method}",
            f"request_size: {req_size}",
        ]

        if self.cfg.log_request_headers:
            hdrs = _headers_to_dict(request.headers)
            hdr_text = _safe_truncate(_json_pretty(hdrs), self.cfg.max_header_chars)
            lines.append(f"\nheaders: {hdr_text}")

        if self.cfg.log_request_body:
            body_text = _maybe_log_json_request_body(self.cfg)
            if body_text:
                clean_body_text = _safe_truncate(body_text, self.cfg.max_body_chars)
                lines.append(f"\nbody: {clean_body_text}")

        lines.append(f"\n====================================={meta.name} REQUEST ENDS============================================================\n")
        self._logger.log(self.cfg.level, "\n".join(lines))

    def after_request(self, resp: Any):
        if g is None:
            return resp

        enabled = getattr(g, "_log4py_api_enabled", False)
        if not enabled:
            return resp

        api_name = getattr(g, "_log4py_api_name", "API")
        start = getattr(g, "_log4py_start", None)
        total_ms = (time.perf_counter() - start) * 1000.0 if start is not None else None

        # response size (best effort)
        resp_size = -1
        try:
            cl = resp.calculate_content_length()
            if cl is not None:
                resp_size = int(cl)
        except (AttributeError, TypeError):
            pass

        status = getattr(resp, "status", "")
        status_code = getattr(resp, "status_code", -1)

        lines = [
            f"\n\n====================================={api_name} RESPONSE BEGINS=========================================================\n",
            f"total_time_ms: {total_ms:.3f}" if total_ms is not None else "total_time_ms: -",
            f"response_size: {resp_size}",
            f"status: {status}",
            f"status_code: {status_code}",
        ]

        if self.cfg.log_response_headers:
            hdrs = _headers_to_dict(resp.headers)
            hdr_text = _safe_truncate(_json_pretty(hdrs), self.cfg.max_header_chars)
            lines.append(f"\nheaders: {hdr_text}")

        if self.cfg.log_response_body:
            body_text = _maybe_log_json_response_body(resp, self.cfg)
            if body_text:
                clean_body_text = _safe_truncate(body_text, self.cfg.max_body_chars)
                lines.append(f"\nbody: {clean_body_text}")

        # NEW: if 4xx/5xx, include captured error payload/details (if any)
        try:
            is_error = isinstance(status_code, int) and status_code >= 400
        except TypeError:
            is_error = False

        if is_error:
            err_block = _format_error_block(api_name)
            if err_block:
                lines.append(err_block)

        lines.append(f"\n====================================={api_name} RESPONSE ENDS===========================================================\n")
        self._logger.log(self.cfg.level, "\n".join(lines))

        return resp

