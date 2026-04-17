import json
from typing import Callable, Optional

from google.auth.transport.requests import Request  # type: ignore
from google.oauth2.credentials import Credentials  # type: ignore
from google_auth_oauthlib.flow import InstalledAppFlow  # type: ignore

from sentinel_core.config import settings


class GmailAuth:
    """OAuth2 flow for Gmail that works entirely off in-memory strings.

    `client_config_json` is the JSON body of the Google OAuth client
    (previously a credentials.json file). `token_json`, if provided, is the
    serialized authorized-user token. When a new token is minted or refreshed,
    `on_token_refreshed` is called with the fresh `creds.to_json()` string so
    the caller can persist it back to the database.
    """

    def __init__(
        self,
        client_config_json: str,
        token_json: Optional[str],
        scopes: Optional[list[str]] = None,
        on_token_refreshed: Optional[Callable[[str], None]] = None,
    ):
        self.client_config = json.loads(client_config_json)
        self.token_json = token_json
        self.scopes: list[str] = scopes if scopes is not None else settings.GMAIL_SCOPES
        self.on_token_refreshed = on_token_refreshed

    def get_credentials(self) -> Credentials:
        creds: Optional[Credentials] = None

        if self.token_json:
            creds = Credentials.from_authorized_user_info(
                json.loads(self.token_json), self.scopes
            )

        if not creds or not creds.valid:
            if creds and creds.expired and creds.refresh_token:
                creds.refresh(Request())
            else:
                flow = InstalledAppFlow.from_client_config(
                    self.client_config, self.scopes
                )
                creds = flow.run_local_server(port=0)

            if self.on_token_refreshed:
                self.on_token_refreshed(creds.to_json())

        return creds  # type: ignore
