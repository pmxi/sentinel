from typing import Optional

import requests

from src.notify.notifier import Notifier
from src.logging_config import get_logger

logger = get_logger(__name__)


class TelegramNotifier(Notifier):
    """Notifier class for sending notifications via Telegram Bot API."""

    def __init__(self, bot_token: str, chat_id: str):
        """Initialize the notifier with Telegram credentials.
        
        Args:
            bot_token: Telegram bot token
            chat_id: Telegram chat ID to send messages to
        """
        if not bot_token:
            raise ValueError("bot_token is required")
        if not chat_id:
            raise ValueError("chat_id is required")

        self.bot_token = bot_token
        self.chat_id = chat_id
        self.api_url = f"https://api.telegram.org/bot{self.bot_token}"

    def send(self, text: str) -> Optional[str]:
        """Send a text message via Telegram.
        
        Args:
            text: The message to send
            
        Returns:
            The message ID if successful, None if failed
        """
        try:
            # https://core.telegram.org/bots/api#sendmessage
            response = requests.post(
                f"{self.api_url}/sendMessage",
                json={
                    "chat_id": self.chat_id,
                    "text": text,
                    "parse_mode": "MarkdownV2",
                    "disable_notification": False,
                },
            )

            if response.status_code == 200:
                result = response.json()
                return str(result.get("result", {}).get("message_id"))
            else:
                logger.error(
                    f"Failed to send Telegram notification: {response.status_code} - {response.text}"
                )
                return None

        except Exception as e:
            logger.error(f"Failed to send notification: {e}")
            return None

    def _escape_markdown(self, text: str) -> str:
        """Escape special characters for Telegram MarkdownV2."""
        special_chars = [
            "_",
            "*",
            "[",
            "]",
            "(",
            ")",
            "~",
            "`",
            ">",
            "#",
            "+",
            "-",
            "=",
            "|",
            "{",
            "}",
            ".",
            "!",
        ]
        for char in special_chars:
            text = text.replace(char, f"\\{char}")
        return text
