"""Centralized logging configuration for Sentinel.

Timestamps are UTC everywhere — no per-host timezone drift when the daemon
runs on servers in one tz and someone reads the logs from another.
"""

import logging
import logging.handlers
import os
import time
from pathlib import Path
from typing import Optional

# File: full detail for debugging / grep — ISO 8601 UTC with milliseconds.
FILE_FORMAT = "%(asctime)s.%(msecs)03dZ %(levelname)-5s %(name)s %(filename)s:%(lineno)d — %(message)s"
FILE_DATEFMT = "%Y-%m-%dT%H:%M:%S"

# Console: terse, same UTC tz as the file (short HH:MM:SSZ).
CONSOLE_FORMAT = "%(asctime)sZ %(levelname)-5s %(name)s: %(message)s"
CONSOLE_DATEFMT = "%H:%M:%S"


class _UTCFormatter(logging.Formatter):
    """Formatter that emits timestamps in UTC regardless of host timezone."""

    converter = time.gmtime


_file_handler: Optional[logging.Handler] = None


def _get_or_create_file_handler(log_dir: Optional[str] = None) -> logging.Handler:
    """Get or create the shared rotating file handler (10MB × 5 backups)."""
    global _file_handler

    if _file_handler is None:
        log_dir = log_dir or os.getenv("SENTINEL_LOG_DIR", "logs")
        log_path = Path(log_dir)
        log_path.mkdir(parents=True, exist_ok=True)
        file_path = log_path / "sentinel.log"

        _file_handler = logging.handlers.RotatingFileHandler(
            file_path, maxBytes=10 * 1024 * 1024, backupCount=5
        )
        _file_handler.setLevel(logging.DEBUG)  # File always captures full detail.
        _file_handler.setFormatter(_UTCFormatter(FILE_FORMAT, datefmt=FILE_DATEFMT))

    return _file_handler


def setup_logging(name: str, level: Optional[str] = None) -> logging.Logger:
    """Configure a logger with a terse UTC console handler and the shared file handler.

    Environment variables:
        LOG_LEVEL (default INFO) — console level; file is always DEBUG.
        SENTINEL_LOG_DIR (default 'logs') — directory for sentinel.log.
    """
    console_level = (level or os.getenv("LOG_LEVEL", "INFO")).upper()

    # Logger is DEBUG so every record reaches the handlers; each handler
    # then decides for itself whether to emit. This is what lets the file
    # capture full detail while the console respects LOG_LEVEL.
    logger = logging.getLogger(name)
    logger.setLevel(logging.DEBUG)

    if logger.handlers:
        return logger

    console_handler = logging.StreamHandler()
    console_handler.setLevel(getattr(logging, console_level))
    console_handler.setFormatter(_UTCFormatter(CONSOLE_FORMAT, datefmt=CONSOLE_DATEFMT))
    logger.addHandler(console_handler)

    logger.addHandler(_get_or_create_file_handler())

    return logger


def get_logger(name: str) -> logging.Logger:
    """Get or create a logger with the standard configuration."""
    return setup_logging(name)
