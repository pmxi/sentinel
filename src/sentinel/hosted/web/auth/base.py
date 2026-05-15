"""IdentityProvider ABC.

Concrete providers (local, google) own auth-related routes, the
login_required decorator, and current_user_id resolution. The rest of
the web app calls into the provider through this contract and doesn't
care which mode it's running in.
"""

from abc import ABC, abstractmethod
from typing import Callable, Optional

from flask import Flask


class IdentityProvider(ABC):
    @abstractmethod
    def init_app(self, app: Flask) -> None:
        """Register auth routes on the Flask app and bind any state."""

    @abstractmethod
    def login_required(self, view: Callable) -> Callable:
        """Decorator: gate a view behind this provider's auth check."""

    @abstractmethod
    def current_user_id(self) -> Optional[int]:
        """Return the id of the currently-authenticated user, or None."""

    @abstractmethod
    def current_user_email(self) -> Optional[str]:
        """Return the current user's email if known (for header display)."""

    @abstractmethod
    def is_enabled(self) -> bool:
        """True if this provider exposes a login flow (template conditional)."""
