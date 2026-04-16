"""Quick IMAP connection test used by /accounts/new before we save the config.

Fast path (login + SELECT INBOX + logout) — this confirms the server is
reachable, the credentials work, and IMAP access is actually enabled for
the account (Workspace admins sometimes disable it).
"""

from __future__ import annotations

import imaplib
import socket
import ssl
from dataclasses import dataclass
from typing import Optional

from sentinel.logging_config import get_logger

logger = get_logger(__name__)

_CONNECT_TIMEOUT_S = 15


@dataclass
class ProbeResult:
    ok: bool
    error: Optional[str] = None


def probe_imap(server: str, port: int, username: str, password: str) -> ProbeResult:
    """Return ProbeResult(ok=True) if we can log in and open INBOX.
    Otherwise ok=False and `error` holds a human-readable reason."""
    socket.setdefaulttimeout(_CONNECT_TIMEOUT_S)
    conn = None
    try:
        conn = imaplib.IMAP4_SSL(server, port)
        conn.login(username, password)
        status, _ = conn.select("INBOX", readonly=True)
        if status != "OK":
            return ProbeResult(ok=False, error=f"Could not open INBOX (status {status})")
        return ProbeResult(ok=True)
    except imaplib.IMAP4.error as e:
        msg = str(e).lower()
        if "authenticationfailed" in msg or "invalid credentials" in msg or "login failed" in msg:
            return ProbeResult(ok=False, error="Wrong username or password. For Gmail/iCloud/etc. you need an *app password*, not your regular account password.")
        if "logindisabled" in msg or "login disabled" in msg:
            return ProbeResult(ok=False, error="IMAP login is disabled for this account. Your email provider or organization admin has turned it off.")
        return ProbeResult(ok=False, error=f"IMAP error: {e}")
    except socket.timeout:
        return ProbeResult(ok=False, error=f"Connection to {server}:{port} timed out after {_CONNECT_TIMEOUT_S}s.")
    except socket.gaierror:
        return ProbeResult(ok=False, error=f"Could not resolve hostname '{server}'. Check the server address.")
    except ssl.SSLError as e:
        return ProbeResult(ok=False, error=f"TLS/SSL error: {e}")
    except OSError as e:
        return ProbeResult(ok=False, error=f"Network error: {e}")
    finally:
        if conn is not None:
            try:
                conn.logout()
            except Exception:
                pass
