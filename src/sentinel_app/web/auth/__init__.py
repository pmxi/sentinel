"""Identity provider abstraction for the Sentinel web app.

Two implementations:
  - LocalIdentity: null-auth, single implicit user. For self-hosted use.
  - GoogleOAuthIdentity: real OAuth, multi-tenant. For hosted deployments.

Selected at create_app() time based on Settings.DEPLOYMENT_MODE.
"""

from typing import TYPE_CHECKING

from sentinel_app.web.auth.base import IdentityProvider
from sentinel_app.web.auth.google import GoogleOAuthIdentity
from sentinel_app.web.auth.local import LocalIdentity

if TYPE_CHECKING:
    pass


def build_provider(mode: str, db_path: str) -> IdentityProvider:
    """Pick an IdentityProvider implementation by deployment mode."""
    if mode == "local":
        return LocalIdentity(db_path=db_path)
    if mode == "hosted":
        return GoogleOAuthIdentity(db_path=db_path)
    raise ValueError(f"Unknown DEPLOYMENT_MODE: {mode!r} (expected 'local' or 'hosted')")


__all__ = ["IdentityProvider", "LocalIdentity", "GoogleOAuthIdentity", "build_provider"]
