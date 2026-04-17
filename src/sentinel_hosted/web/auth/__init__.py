"""Hosted identity provider exports."""

from sentinel_hosted.web.auth.base import IdentityProvider
from sentinel_hosted.web.auth.google import GoogleOAuthIdentity


def build_provider(db_path: str) -> IdentityProvider:
    return GoogleOAuthIdentity(db_path=db_path)


__all__ = ["IdentityProvider", "GoogleOAuthIdentity", "build_provider"]
