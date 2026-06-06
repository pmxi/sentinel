"""Shared Telegram Bot API URL helper."""

TELEGRAM_API = "https://api.telegram.org"


def telegram_url(token: str, method: str) -> str:
    """Build the Bot API URL for a method, e.g. sendMessage / getUpdates."""
    return f"{TELEGRAM_API}/bot{token}/{method}"
