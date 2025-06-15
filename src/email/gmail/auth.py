import json
import os

# Import settings from parent directory
import sys
from pathlib import Path

from google.auth.transport.requests import Request  # type: ignore
from google.oauth2.credentials import Credentials  # type: ignore
from google_auth_oauthlib.flow import InstalledAppFlow  # type: ignore

sys.path.append(os.path.dirname(os.path.dirname(__file__)))
from src.config import settings


class GmailAuth:
    def __init__(
        self, credentials_file: Path, token_file: Path, scopes: list[str] | None = None
    ):
        """Initialize auth with explicit credential and token paths and optional scopes."""
        # could be simplified to use `or` but [] is falsy.
        # TODO delete this failback to settings.
        self.scopes: list[str] = scopes if scopes is not None else settings.GMAIL_SCOPES
        self.credentials_file: Path = credentials_file
        self.token_file: Path = token_file

    def get_credentials(self) -> Credentials:
        """Get valid Gmail API credentials"""
        creds = None

        if os.path.exists(self.token_file):
            with open(self.token_file, "r") as token:
                token_data = json.load(token)
                creds = Credentials.from_authorized_user_info(token_data, self.scopes)

        if not creds or not creds.valid:
            if creds and creds.expired and creds.refresh_token:
                creds.refresh(Request())
            else:
                flow = InstalledAppFlow.from_client_secrets_file(
                    self.credentials_file, self.scopes
                )
                creds = flow.run_local_server(port=0)

            with open(self.token_file, "w") as token:
                json.dump(json.loads(creds.to_json()), token)

        return creds  # type: ignore
