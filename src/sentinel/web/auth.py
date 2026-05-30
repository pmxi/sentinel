"""Google OAuth — sign-in (OIDC) + Connect-Gmail (gmail.readonly).

One Google client serves both flows via incremental auth: sign-in requests
`openid email profile`; "Connect Gmail" additionally requests `gmail.readonly`.

Uses google-auth-oauthlib's web `Flow` so a connected Gmail token is directly
usable by the existing GmailClient (`credentials.to_json()`).
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional

import google.auth.transport.requests
import google.oauth2.id_token
from google_auth_oauthlib.flow import Flow

from sentinel.config import settings

# oauthlib refuses non-HTTPS redirects and rejects Google's habit of adding
# `openid` to the granted scope set. Relax both — insecure transport only when
# the redirect is the http:// dev URL (prod is https and stays strict).
os.environ.setdefault("OAUTHLIB_RELAX_TOKEN_SCOPE", "1")
if settings.GOOGLE_REDIRECT_URI.startswith("http://"):
    os.environ.setdefault("OAUTHLIB_INSECURE_TRANSPORT", "1")

_AUTH_URI = "https://accounts.google.com/o/oauth2/auth"
_TOKEN_URI = "https://oauth2.googleapis.com/token"

SIGNIN_SCOPES: List[str] = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
]
GMAIL_SCOPES: List[str] = SIGNIN_SCOPES + ["https://www.googleapis.com/auth/gmail.readonly"]


def _client_config() -> Dict[str, Any]:
    return {
        "web": {
            "client_id": settings.GOOGLE_CLIENT_ID,
            "client_secret": settings.GOOGLE_CLIENT_SECRET,
            "auth_uri": _AUTH_URI,
            "token_uri": _TOKEN_URI,
            "redirect_uris": [settings.GOOGLE_REDIRECT_URI],
        }
    }


def client_config_json() -> str:
    """The OAuth client JSON, in the shape GmailClient/GmailAuth expects."""
    return json.dumps(_client_config())


def build_flow(scopes: List[str], state: Optional[str] = None) -> Flow:
    flow = Flow.from_client_config(_client_config(), scopes=scopes, state=state)
    flow.redirect_uri = settings.GOOGLE_REDIRECT_URI
    return flow


def userinfo_from_credentials(creds) -> Dict[str, Any]:
    """Verify the id_token and return {sub, email, name}."""
    req = google.auth.transport.requests.Request()
    info = google.oauth2.id_token.verify_oauth2_token(
        creds.id_token, req, settings.GOOGLE_CLIENT_ID
    )
    return {"sub": info["sub"], "email": info.get("email", ""), "name": info.get("name")}
