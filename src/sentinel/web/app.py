"""Sentinel web console (multi-tenant).

Sign in with Google, connect inboxes (Gmail via OAuth, or any provider via
IMAP app-password), edit your classification criteria, and enable Web Push
notifications. Everything is scoped to the signed-in user. The console never
displays email content — alerts go out-of-band (Web Push to the installed PWA);
the inbox lives in your mail client.
"""

from __future__ import annotations

import functools
import secrets
from pathlib import Path
from typing import Any, Dict, List, Optional

from flask import (
    Flask,
    abort,
    g,
    jsonify,
    redirect,
    render_template,
    request,
    send_from_directory,
    session,
    url_for,
)
from werkzeug.middleware.proxy_fix import ProxyFix

from sentinel.logging_config import get_logger
from sentinel.classifier.openai_classifier import _default_criteria
from sentinel.email.mail_config import AccountSettings, AuthConfig, AuthMethod, MailAccountConfig, MailProvider
from sentinel.config import settings
from sentinel.database import Database
from sentinel.web.auth import GMAIL_SCOPES, SIGNIN_SCOPES, build_flow, client_config_json, userinfo_from_credentials
from sentinel.web.imap_probe import probe_imap

logger = get_logger(__name__)

_STATIC_DIR = Path(__file__).parent / "static"

# service_worker + web_manifest are public so the browser can fetch them
# before / outside an authenticated page context (the SW controls the whole
# origin and must load at the root scope).
_PUBLIC_ENDPOINTS = {
    "home",
    "login",
    "auth_google",
    "oauth_callback",
    "static",
    "service_worker",
    "web_manifest",
}


def _require_google_oauth(view):
    """Abort with a clear error if Google OAuth isn't configured."""
    @functools.wraps(view)
    def wrapped(*args, **kwargs):
        if not settings.google_oauth_configured():
            abort(500, "Google OAuth not configured (set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).")
        return view(*args, **kwargs)
    return wrapped


def create_app(database_url: Optional[str] = None, debug: bool = False) -> Flask:
    app = Flask(__name__, template_folder="templates", static_folder="static")
    app.debug = debug
    # In production the app sits behind Nginx terminating TLS. Trust the proxy's
    # forwarded headers so request.url reflects the public https:// URL — the
    # OAuth token exchange (fetch_token(authorization_response=request.url)) and
    # oauthlib's https check depend on it. Nginx must send X-Forwarded-Proto/Host.
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
    app.config["DATABASE_URL"] = database_url or settings.require_database_url()
    app.secret_key = settings.require_session_secret()
    # Web Push is the only alert channel — fail fast if the keypair is missing
    # rather than letting users connect inboxes that can never reach them.
    settings.require_vapid()
    # Harden the session cookie when served over HTTPS. Gated on the redirect
    # scheme so the http:// dev setup (where Secure cookies wouldn't be sent)
    # still works without configuration.
    app.config.update(
        SESSION_COOKIE_SECURE=settings.GOOGLE_REDIRECT_URI.startswith("https://"),
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
    )

    def get_db() -> Database:
        """One Database per request, opened lazily and closed on teardown."""
        if "db" not in g:
            g.db = Database(app.config["DATABASE_URL"])
        return g.db

    @app.teardown_appcontext
    def _close_db(_exc: Optional[BaseException] = None) -> None:
        db = g.pop("db", None)
        if db is not None:
            db.close()

    @app.context_processor
    def inject_user():
        return {"current_email": session.get("email")}

    @app.before_request
    def require_login():
        if request.endpoint in _PUBLIC_ENDPOINTS:
            return None
        uid = session.get("user_id")
        if uid is None:
            return redirect(url_for("login"))
        # Presence isn't enough — the row must still exist. A stale cookie (e.g.
        # the user's row was deleted) would otherwise pass and then crash the
        # first FK insert. Drop the orphaned session and make them re-auth.
        user = get_db().get_user(uid)
        if user is None:
            session.clear()
            return redirect(url_for("login"))
        # Validated for the rest of the request — handlers read g.user_id /
        # g.user instead of indexing the session directly.
        g.user_id = int(uid)
        g.user = user
        # First-run onboarding: a never-onboarded user hitting the dashboard is
        # diverted to the welcome walkthrough once. Gating only `console` keeps
        # the JSON push_* fetch routes and /welcome itself out of the redirect.
        if request.endpoint == "console" and user.get("onboarded_at") is None:
            return redirect(url_for("welcome"))
        return None

    def _csrf_token() -> str:
        token = session.get("_csrf_token")
        if not token:
            token = secrets.token_urlsafe(32)
            session["_csrf_token"] = token
        return token

    @app.context_processor
    def inject_csrf():
        # Exposed to every template as {{ csrf_token }} for the hidden field.
        return {"csrf_token": _csrf_token()}

    @app.before_request
    def csrf_protect():
        # All state-changing routes are POST and behind login; the OAuth
        # callback is a GET guarded by its own state check. Reject any POST
        # whose token doesn't match the session's. Form posts send it as a
        # hidden field; JSON fetch() calls (the push endpoints) send it as the
        # X-CSRF-Token header.
        if request.method == "POST":
            sent = request.form.get("csrf_token") or request.headers.get("X-CSRF-Token", "")
            expected = session.get("_csrf_token", "")
            if not expected or not secrets.compare_digest(sent, expected):
                abort(400, "Invalid or missing CSRF token — reload the page and try again.")
        return None

    # ---- auth -----------------------------------------------------------

    @app.route("/login")
    def login():
        if session.get("user_id"):
            return redirect(url_for("console"))
        return render_template("login.html", google_oauth=settings.google_oauth_configured())

    @app.route("/auth/google")
    @_require_google_oauth
    def auth_google():
        flow = build_flow(SIGNIN_SCOPES)
        url, state = flow.authorization_url(
            access_type="online", include_granted_scopes="true", prompt="select_account"
        )
        session["oauth_state"] = state
        session["oauth_action"] = "login"
        return redirect(url)

    @app.route("/gmail/connect")
    @_require_google_oauth
    def gmail_connect():
        flow = build_flow(GMAIL_SCOPES)
        url, state = flow.authorization_url(
            access_type="offline", include_granted_scopes="true", prompt="consent"
        )
        session["oauth_state"] = state
        session["oauth_action"] = "connect_gmail"
        return redirect(url)

    @app.route("/oauth/google/callback")
    def oauth_callback():
        state = session.pop("oauth_state", None)
        action = session.pop("oauth_action", None)
        if request.args.get("error"):
            abort(400, f"Google returned: {request.args.get('error')}")
        if not state or request.args.get("state") != state:
            abort(400, "OAuth state mismatch — please try again.")
        # Require an explicit action set by the route that started the flow —
        # never default to "login", which would mask a bug and could process a
        # connect-Gmail callback as a sign-in.
        if action not in ("login", "connect_gmail"):
            abort(400, "Unknown OAuth action — please restart from the sign-in page.")

        scopes = GMAIL_SCOPES if action == "connect_gmail" else SIGNIN_SCOPES
        flow = build_flow(scopes, state=state)
        flow.fetch_token(authorization_response=request.url)
        creds = flow.credentials
        info = userinfo_from_credentials(creds)

        db = get_db()
        if action == "connect_gmail":
            uid = session.get("user_id")
            if uid is None or db.get_user(uid) is None:
                # No live user behind the session — don't attempt an insert
                # that would violate the stream→user FK; re-auth instead.
                session.clear()
                return redirect(url_for("login"))
            config = MailAccountConfig(
                provider=MailProvider.GMAIL_API,
                auth=AuthConfig(
                    method=AuthMethod.OAUTH2,
                    client_config_json=client_config_json(),
                    token_json=creds.to_json(),
                ),
            )
            db.upsert_inbox(
                f"gmail:{info['email']}", config.model_dump_json(),
                user_id=uid,
            )
        else:
            user = db.upsert_user(info["sub"], info["email"], info.get("name"))
            session["user_id"] = int(user["id"])
            session["email"] = user["email"]
        return redirect(url_for("console"))

    @app.route("/logout", methods=["POST"])
    def logout():
        session.clear()
        return redirect(url_for("login"))

    # ---- public homepage ------------------------------------------------

    @app.route("/")
    def home():
        # Signed-in visitors skip the marketing page and go to their dashboard.
        if session.get("user_id"):
            return redirect(url_for("console"))
        return render_template("home.html", google_oauth=settings.google_oauth_configured())

    # ---- onboarding -----------------------------------------------------

    @app.route("/welcome")
    def welcome():
        # Shown once after first sign-in (see require_login). Reuses the push
        # enable/disable block so notifications can be turned on right here.
        return render_template(
            "welcome.html",
            push_enabled=bool(get_db().get_push_subscriptions(g.user_id)),
            vapid_public_key=settings.VAPID_PUBLIC_KEY,
        )

    @app.route("/welcome/done", methods=["POST"])
    def mark_onboarded():
        get_db().mark_user_onboarded(g.user_id)
        return redirect(url_for("console"))

    # ---- dashboard ------------------------------------------------------

    @app.route("/dashboard", methods=["GET", "POST"])
    def console():
        uid = g.user_id
        db = get_db()
        if request.method == "POST":
            db.set_user_criteria(uid, request.form.get("criteria", ""))
            return redirect(url_for("console", saved=1))
        user = db.get_user(uid) or {}
        inboxes = _inbox_view_rows(db.list_inboxes_for_user(uid))
        return render_template(
            "console.html",
            inboxes=inboxes,
            notifications=db.list_notifications(uid),
            criteria=(user.get("criteria") or _default_criteria()),
            push_enabled=bool(db.get_push_subscriptions(uid)),
            vapid_public_key=settings.VAPID_PUBLIC_KEY,
            google_oauth=settings.google_oauth_configured(),
            saved=request.args.get("saved") == "1",
        )

    @app.route("/inbox/connect", methods=["GET", "POST"])
    def connect_inbox():
        providers = _imap_provider_presets()
        if request.method == "POST":
            form = request.form
            preset_key = form.get("preset", "custom")
            preset = providers.get(preset_key) or providers["custom"]

            name = form.get("name", "").strip()
            username = form.get("username", "").strip()
            password = form.get("password", "")
            server = (form.get("server", "").strip() or preset["server"]).strip()
            port_str = form.get("port", "").strip() or str(preset["port"])

            errors: List[str] = []
            if not name:
                errors.append("Pick a name for this inbox.")
            if not username:
                errors.append("Email address is required.")
            if not password:
                errors.append("App password is required.")
            if not server:
                errors.append("IMAP server is required.")
            try:
                port = int(port_str)
            except ValueError:
                errors.append(f"Port must be a number (got {port_str!r}).")
                port = 993

            db = get_db()
            if name and db.get_inbox(name):
                errors.append(f"You already have an inbox named {name!r}. Pick a different name.")
            if not errors:
                probe = probe_imap(server, port, username, password)
                if not probe.ok:
                    errors.append(probe.error or "Connection failed.")
            if not errors:
                config = MailAccountConfig(
                    provider=MailProvider.IMAP,
                    server=server,
                    port=port,
                    auth=AuthConfig(
                        method=AuthMethod.PASSWORD,
                        username=username,
                        password=password,
                    ),
                    settings=AccountSettings(),
                )
                db.upsert_inbox(name, config.model_dump_json(), user_id=g.user_id)
                return redirect(url_for("console"))

            return render_template(
                "new_email_stream.html",
                providers=providers,
                errors=errors,
                form={
                    "preset": preset_key,
                    "name": name,
                    "username": username,
                    "server": server,
                    "port": port_str,
                },
            )

        return render_template(
            "new_email_stream.html",
            providers=providers,
            errors=[],
            form={"preset": "gmail", "name": "", "username": "", "server": "", "port": ""},
        )

    @app.route("/inbox/<name>/delete", methods=["POST"])
    def delete_inbox(name: str):
        db = get_db()
        row = db.get_inbox(name)
        # Only let a user delete their own inbox.
        if row and row.get("user_id") == g.user_id:
            db.delete_inbox(name)
        return redirect(url_for("console"))

    # ---- web push -------------------------------------------------------

    @app.route("/push/subscribe", methods=["POST"])
    def push_subscribe():
        """Register the calling browser's push subscription for this user.
        Body is the JSON PushSubscription object the service worker produced."""
        sub = request.get_json(silent=True) or {}
        endpoint = sub.get("endpoint")
        keys = sub.get("keys") or {}
        p256dh, auth = keys.get("p256dh"), keys.get("auth")
        if not (endpoint and p256dh and auth):
            return jsonify(error="malformed subscription"), 400
        get_db().add_push_subscription(g.user_id, endpoint, p256dh, auth)
        return jsonify(ok=True), 201

    @app.route("/push/unsubscribe", methods=["POST"])
    def push_unsubscribe():
        sub = request.get_json(silent=True) or {}
        endpoint = sub.get("endpoint")
        if endpoint:
            get_db().delete_push_subscription(endpoint)
        return jsonify(ok=True)

    @app.route("/sw.js")
    def service_worker():
        # Served from the origin root so the service worker can claim the whole
        # scope; Service-Worker-Allowed lets a root-scope SW live under /static.
        resp = send_from_directory(_STATIC_DIR, "sw.js")
        resp.headers["Content-Type"] = "application/javascript"
        resp.headers["Service-Worker-Allowed"] = "/"
        resp.headers["Cache-Control"] = "no-cache"
        return resp

    @app.route("/manifest.webmanifest")
    def web_manifest():
        resp = send_from_directory(_STATIC_DIR, "manifest.webmanifest")
        resp.headers["Content-Type"] = "application/manifest+json"
        return resp

    return app


def _inbox_view_rows(inboxes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Shape stored inbox rows into what the console template renders: a clean
    email, a provider label + key (the key drives the per-provider accent
    colour), and a short detail line. Tolerates bad config."""
    rows: List[Dict[str, Any]] = []
    for row in inboxes:
        name = row["name"]
        entry: Dict[str, Any] = {
            "name": name,
            # `name` is stored as "<provider>:<email>"; fall back to it whole.
            "email": name.split(":", 1)[-1],
            "enabled": True,
            "provider_key": "imap",
            "provider_label": "IMAP",
            "detail": "",
            "error": None,
        }
        try:
            cfg = MailAccountConfig.model_validate_json(row["config_json"])
            entry["enabled"] = cfg.enabled
            if cfg.provider == MailProvider.IMAP:
                entry["provider_key"] = "imap"
                entry["provider_label"] = "IMAP"
                entry["email"] = cfg.auth.username or entry["email"]
                entry["detail"] = cfg.server or ""
            else:
                entry["provider_key"] = "gmail"
                entry["provider_label"] = "Gmail"
        except Exception as exc:
            entry["error"] = str(exc)
            entry["enabled"] = False
        rows.append(entry)
    return rows


def _imap_provider_presets() -> Dict[str, Dict[str, Any]]:
    return {
        "gmail": {
            "label": "Gmail",
            "server": "imap.gmail.com",
            "port": 993,
            "app_password_url": "https://myaccount.google.com/apppasswords",
            "note": "2-Step Verification must be enabled on your Google account before app passwords are available.",
        },
        "icloud": {
            "label": "iCloud",
            "server": "imap.mail.me.com",
            "port": 993,
            "app_password_url": "https://appleid.apple.com",
            "note": "Apple ID → Sign-In and Security → App-Specific Passwords.",
        },
        "fastmail": {
            "label": "Fastmail",
            "server": "imap.fastmail.com",
            "port": 993,
            "app_password_url": "https://app.fastmail.com/settings/security",
            "note": "Settings → Password & Security → New app password.",
        },
        "outlook": {
            "label": "Outlook.com",
            "server": "outlook.office365.com",
            "port": 993,
            "app_password_url": "https://account.microsoft.com/security",
            "note": "Consumer outlook.com accounts only. Enterprise Microsoft 365 tenants require OAuth, which isn't supported yet.",
        },
        "yahoo": {
            "label": "Yahoo",
            "server": "imap.mail.yahoo.com",
            "port": 993,
            "app_password_url": "https://login.yahoo.com/account/security",
            "note": "Account security → Generate app password.",
        },
        "custom": {
            "label": "Custom IMAP server",
            "server": "",
            "port": 993,
            "app_password_url": "",
            "note": "Enter the IMAP server hostname and port yourself.",
        },
    }


def run(host: str = "127.0.0.1", port: int = 8765, debug: bool = False) -> None:
    app = create_app(debug=debug)
    app.run(host=host, port=port, debug=debug)


def main() -> None:
    run()


if __name__ == "__main__":
    main()
