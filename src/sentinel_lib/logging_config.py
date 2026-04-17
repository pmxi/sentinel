"""Shared logging configuration for Sentinel runtimes and library code."""

import logging
import logging.handlers
import os
import time
from pathlib import Path
from typing import Optional

FILE_FORMAT = "%(asctime)s.%(msecs)03dZ %(levelname)-5s %(name)s %(filename)s:%(lineno)d - %(message)s"
FILE_DATEFMT = "%Y-%m-%dT%H:%M:%S"

CONSOLE_FORMAT = "%(asctime)sZ %(levelname)-5s %(name)s: %(message)s"
CONSOLE_DATEFMT = "%H:%M:%S"


class _UTCFormatter(logging.Formatter):
    """Formatter that emits timestamps in UTC regardless of host timezone."""

    converter = time.gmtime


_file_handler: Optional[logging.Handler] = None


def _get_or_create_file_handler(log_dir: Optional[str] = None) -> logging.Handler:
    """Get or create the shared rotating file handler."""
    global _file_handler

    if _file_handler is None:
        log_dir = log_dir or os.getenv("SENTINEL_LOG_DIR", "logs")
        log_path = Path(log_dir)
        log_path.mkdir(parents=True, exist_ok=True)
        file_path = log_path / "sentinel.log"

        _file_handler = logging.handlers.RotatingFileHandler(
            file_path, maxBytes=10 * 1024 * 1024, backupCount=5
        )
        _file_handler.setLevel(logging.DEBUG)
        _file_handler.setFormatter(_UTCFormatter(FILE_FORMAT, datefmt=FILE_DATEFMT))

    return _file_handler


def setup_logging(name: str, level: Optional[str] = None) -> logging.Logger:
    """Configure a logger with standard console and file handlers."""
    console_level = (level or os.getenv("LOG_LEVEL", "INFO")).upper()

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
