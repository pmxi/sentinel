"""Centralized logging configuration for Sentinel."""

import logging
import logging.handlers
import os
from pathlib import Path
from typing import Optional

# Default formats
FILE_FORMAT = "%(asctime)s - %(name)s - %(levelname)s - [%(filename)s:%(lineno)d] - %(funcName)s() - %(message)s"
CONSOLE_FORMAT = FILE_FORMAT

# Global file handler to share across all loggers
_file_handler = None


def _get_or_create_file_handler(log_dir: Optional[str] = None) -> logging.Handler:
    """Get or create the shared file handler for all modules."""
    global _file_handler

    if _file_handler is None:
        # Get log directory from environment or use default
        log_dir = log_dir or os.getenv("SENTINEL_LOG_DIR", "logs")
        
        # Create log directory
        log_path = Path(log_dir)
        log_path.mkdir(parents=True, exist_ok=True)

        # Single log file for entire application
        file_path = log_path / "sentinel.log"

        # Rotating file handler with sensible defaults
        _file_handler = logging.handlers.RotatingFileHandler(
            file_path, maxBytes=10 * 1024 * 1024, backupCount=5  # 10MB, 5 backups
        )
        _file_handler.setLevel(logging.DEBUG)  # File gets all details
        file_formatter = logging.Formatter(FILE_FORMAT)
        _file_handler.setFormatter(file_formatter)

    return _file_handler


def setup_logging(
    name: str,
    level: Optional[str] = None,
) -> logging.Logger:
    """
    Set up logging configuration for a module.

    Args:
        name: Logger name. This is typically the module name.
        level: Log level (DEBUG, INFO, WARNING, ERROR, CRITICAL) this overrides the envvar LOG_LEVEL

    Returns:
        Configured logger instance
    
    Environment Variables:
        LOG_LEVEL: Set logging level (default: INFO)
        SENTINEL_LOG_DIR: Set log directory (default: logs)
    """
    # Get log level from environment or parameter
    log_level = level or os.getenv("LOG_LEVEL", "INFO")

    # Create logger
    logger = logging.getLogger(name)
    logger.setLevel(getattr(logging, log_level.upper()))

    # Prevent duplicate handlers
    if logger.handlers:
        return logger

    # Console handler
    console_handler = logging.StreamHandler()
    console_handler.setLevel(getattr(logging, log_level.upper()))
    console_formatter = logging.Formatter(CONSOLE_FORMAT, datefmt="%H:%M:%S")
    console_handler.setFormatter(console_formatter)
    logger.addHandler(console_handler)

    # File handler uses the shared handler
    file_handler = _get_or_create_file_handler()
    logger.addHandler(file_handler)

    return logger


def get_logger(name: str) -> logging.Logger:
    """Get or create a logger with the standard configuration."""
    return setup_logging(name)
