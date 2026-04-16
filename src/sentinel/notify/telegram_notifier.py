from typing import Optional

import requests

from sentinel.logging_config import get_logger
from sentinel.notify.notifier import Notifier

logger = get_logger(__name__)


class TelegramNotifier(Notifier):
    """Sends messages via Telegram Bot API using MarkdownV2 parse mode."""

    def __init__(self, bot_token: str, chat_id: str):
        if not bot_token:
            raise ValueError("bot_token is required")
        if not chat_id:
            raise ValueError("chat_id is required")

        self.bot_token = bot_token
        self.chat_id = chat_id
        self.api_url = f"https://api.telegram.org/bot{self.bot_token}"

    def send(self, text: str) -> Optional[str]:
        try:
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
                return str(response.json().get("result", {}).get("message_id"))
            logger.error(
                f"Failed to send Telegram notification: {response.status_code} - {response.text}"
            )
            return None
        except Exception as e:
            logger.error(f"Failed to send notification: {e}")
            return None
