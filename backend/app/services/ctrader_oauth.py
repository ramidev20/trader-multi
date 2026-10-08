"""cTrader ID login (OAuth 2.0 authorization-code flow) for the Open API app.

One application (CTRADER_CLIENT_ID / CTRADER_CLIENT_SECRET) serves every PC
and every person: each user signs in with their own cTrader ID, approves the
app, and gets their own access/refresh token pair.

Flow: `begin_login()` builds the id.ctrader.com consent URL; cTrader sends the
browser back to CTRADER_REDIRECT_URI (the backend's /ctrader/callback) with a
one-time `code`; `complete_login()` exchanges it for tokens and lists the
trading accounts they cover. Access tokens live ~30 days; `refresh_tokens()`
renews them, and doing so invalidates the previous pair.
"""

from __future__ import annotations

import json
import os
import secrets
import threading
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .ctrader_client import HOSTS, CTraderConnection, CTraderError
from .ctrader_proto import OpenApiMessages_pb2 as msg
from .env_utils import load_project_env

AUTHORIZE_URL = "https://id.ctrader.com/my/settings/openapi/grantingaccess/"
TOKEN_URL = "https://openapi.ctrader.com/apps/token"
DEFAULT_REDIRECT_URI = "http://127.0.0.1:8000/ctrader/callback"
# A started login is kept this long for the browser round trip and for adding
# the accounts it found; the tokens it holds stay valid far longer.
_LOGIN_TTL_SEC = 30 * 60

_logins: dict[str, dict[str, Any]] = {}
_logins_lock = threading.Lock()


class CTraderOAuthError(RuntimeError):
    pass


def _app_credentials() -> tuple[str, str]:
    load_project_env()
    client_id = os.getenv("CTRADER_CLIENT_ID", "").strip()
    client_secret = os.getenv("CTRADER_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        raise CTraderOAuthError("CTRADER_CLIENT_ID and CTRADER_CLIENT_SECRET must be set in .env.")
    return client_id, client_secret


def redirect_uri() -> str:
    load_project_env()
    return os.getenv("CTRADER_REDIRECT_URI", "").strip() or DEFAULT_REDIRECT_URI


def _token_request(method: str, params: dict[str, str]) -> dict[str, Any]:
    request = Request(f"{TOKEN_URL}?{urlencode(params)}", method=method, headers={"Accept": "application/json"})
    try:
        with urlopen(request, timeout=20) as response:
            body = response.read().decode("utf-8", errors="replace")
    except HTTPError as ex:
        body = ex.read().decode("utf-8", errors="replace")
    except URLError as ex:
        raise CTraderOAuthError(f"Could not reach openapi.ctrader.com: {ex.reason}") from ex
    try:
        data = json.loads(body)
    except ValueError as ex:
        raise CTraderOAuthError(f"Unexpected reply from the cTrader token endpoint: {body[:200]}") from ex
    if data.get("errorCode") or not data.get("accessToken"):
        raise CTraderOAuthError(f"{data.get('errorCode') or 'TOKEN_ERROR'}: {data.get('description') or 'no access token returned'}")
    return {
        "access_token": str(data["accessToken"]),
        "refresh_token": str(data.get("refreshToken") or ""),
        "expires_at": int(time.time()) + int(data.get("expiresIn") or 0),
    }


def exchange_code(code: str) -> dict[str, Any]:
    client_id, client_secret = _app_credentials()
    return _token_request(
        "GET",
        {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri(),
            "client_id": client_id,
            "client_secret": client_secret,
        },
    )


def refresh_tokens(refresh_token: str) -> dict[str, Any]:
    """New access/refresh pair; cTrader invalidates the old pair immediately."""
    client_id, client_secret = _app_credentials()
    return _token_request(
        "POST",
        {
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": client_id,
            "client_secret": client_secret,
        },
    )


def list_token_accounts(access_token: str) -> list[dict[str, Any]]:
    """Trading accounts (demo and live) the user granted this token."""
    client_id, client_secret = _app_credentials()
    conn = CTraderConnection(HOSTS["demo"])
    try:
        conn.connect()
        conn.request_one(msg.ProtoOAApplicationAuthReq(clientId=client_id, clientSecret=client_secret))
        reply = conn.request_one(msg.ProtoOAGetAccountListByAccessTokenReq(accessToken=access_token))
    except (CTraderError, OSError) as ex:
        raise CTraderOAuthError(f"Could not list the accounts for this cTrader ID: {ex}") from ex
    finally:
        conn.close("account list done")
    return [
        {
            "login": int(account.traderLogin),
            "account_id": int(account.ctidTraderAccountId),
            "environment": "live" if account.isLive else "demo",
            "broker": str(account.brokerTitleShort or ""),
        }
        for account in reply.ctidTraderAccount
    ]


def _prune_logins() -> None:
    cutoff = time.time() - _LOGIN_TTL_SEC
    for state in [key for key, login in _logins.items() if login["created_at"] < cutoff]:
        _logins.pop(state, None)


def begin_login() -> dict[str, str]:
    client_id, _secret = _app_credentials()
    state = secrets.token_urlsafe(24)
    with _logins_lock:
        _prune_logins()
        _logins[state] = {"status": "pending", "created_at": time.time()}
    query = urlencode(
        {
            "client_id": client_id,
            "redirect_uri": redirect_uri(),
            "scope": "trading",
            "product": "web",
            "state": state,
        }
    )
    return {"state": state, "url": f"{AUTHORIZE_URL}?{query}"}


def complete_login(state: str, code: str, error: str = "") -> dict[str, Any]:
    """Handle the redirect back from cTrader. Returns the login's public view."""
    with _logins_lock:
        _prune_logins()
        if state not in _logins:
            # cTrader does not document echoing `state`; this app runs one
            # login at a time on this PC, so fall back to the newest pending one.
            pending = [key for key, item in _logins.items() if item["status"] == "pending"]
            state = max(pending, key=lambda key: _logins[key]["created_at"]) if pending else ""
        login = _logins.get(state)
        if login is None:
            raise CTraderOAuthError("This cTrader login link has expired or was not started from the app. Start it again from the app.")
        if login["status"] != "pending":
            return public_login(state)
    try:
        if error:
            raise CTraderOAuthError(f"cTrader did not grant access ({error}).")
        if not code:
            raise CTraderOAuthError("cTrader returned no authorization code.")
        tokens = exchange_code(code)
        accounts = list_token_accounts(tokens["access_token"])
        update = {"status": "done", "tokens": tokens, "accounts": accounts, "error": None}
    except CTraderOAuthError as ex:
        update = {"status": "error", "error": str(ex)}
    with _logins_lock:
        _logins.get(state, {}).update(update)
    return public_login(state)


def public_login(state: str) -> dict[str, Any]:
    """What the UI may see: status and accounts, never the tokens."""
    with _logins_lock:
        _prune_logins()
        login = _logins.get(state)
        if login is None:
            return {"status": "expired", "accounts": [], "error": "This cTrader login has expired. Connect again."}
        return {"status": login["status"], "accounts": list(login.get("accounts", [])), "error": login.get("error")}


def login_tokens(state: str, account_login: int) -> dict[str, Any]:
    """Tokens of a finished login, checked to cover `account_login`."""
    with _logins_lock:
        _prune_logins()
        login = _logins.get(state)
        if login is None or login["status"] != "done":
            raise CTraderOAuthError("This cTrader login has expired. Click Connect with cTrader again.")
        if not any(int(a["login"]) == int(account_login) for a in login["accounts"]):
            raise CTraderOAuthError(f"Account {account_login} was not granted in this cTrader login.")
        return dict(login["tokens"])
