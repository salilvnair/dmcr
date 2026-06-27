"""
log4py package public API.

Consumers should import from `log4py` directly, not internal modules.
"""

from .core import (
    # init + config
    init,
    LoggingConfig,

    # MDC
    mdc_put,
    mdc_reset,
    mdc_set,
    mdc_clear,
    mdc_get,

    # API annotation + handler
    api,
    capture_error,
    ApiLoggingConfig,
    FlaskApiLogHandler,

    # MDC extraction param type
    MdcParam,
)

__all__ = [
    "init",
    "LoggingConfig",
    "mdc_put",
    "mdc_reset",
    "mdc_set",
    "mdc_clear",
    "mdc_get",
    "api",
    "capture_error",
    "ApiLoggingConfig",
    "FlaskApiLogHandler",
    "MdcParam",
]