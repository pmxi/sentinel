import json
from typing import Callable, Optional

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials

GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"


class GmailAuth:
    """Load Gmail API credentials from an in-memory authorized-user token.

    `token_json` is the serialized authorized-user token, always minted by the
    web Connect-Gmail flow (the only place Gmail tokens are created). When the
    token is refreshed, `on_token_refreshed` is called with the fresh
    `creds.to_json()` so the caller can persist it back to the database.
    """

    def __init__(
        self,
        token_json: Optional[str],
        on_token_refreshed: Optional[Callable[[str], None]] = None,
    ):
        self.token_json = token_json
        self.on_token_refreshed = on_token_refreshed

    def get_credentials(self) -> Credentials:
        if not self.token_json:
            raise RuntimeError(
                "Gmail is not authorized for this inbox; reconnect it in the web console."
            )
        creds = Credentials.from_authorized_user_info(
            json.loads(self.token_json), [GMAIL_READONLY_SCOPE]
        )
        if not creds.valid:
            if creds.expired and creds.refresh_token:
                creds.refresh(Request())
                if self.on_token_refreshed:
                    self.on_token_refreshed(creds.to_json())
            else:
                raise RuntimeError(
                    "Gmail credentials are invalid and cannot be refreshed; "
                    "reconnect Gmail in the web console."
                )
        return creds
