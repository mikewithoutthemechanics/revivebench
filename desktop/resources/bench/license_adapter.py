"""ReviveBench license adapter (Lemon Squeezy License API).

One file, one class -- this is the ONLY place that knows about Lemon Squeezy.
Swapping the backend later (Paddle / Polar / our own service) means editing this
file (or dropping in a new class with the same three methods) and touching
nothing else in bench_gui.py.

Public surface (see PRODUCT.md §3 "LS API facts"):

    client = LicenseClient()                  # real HTTP
    client = LicenseClient(mock=True)         # canned responses (BENCH_MOCK)
    client.validate("RB-XXXX-XXXX")           -> dict
    client.activate("RB-XXXX-XXXX", "RB-<ECID>-<YYYYMMDD>") -> dict
    client.deactivate("RB-XXXX-XXXX", "<instance_id>")      -> dict

Every method returns a NORMALIZED dict -- never a raw HTTP body -- so the UI and
the state machine never have to care which backend is in play:

    {
      "ok": bool,                  # True only for a usable, active license
      "status": "active"|"inactive"|"expired"|"disabled"|"invalid"|"error",
      "activation_limit": int|None,
      "activation_usage": int|None,
      "remaining": int|None,       # limit - usage, clamped at 0
      "instance_id": str|None,     # set by activate()
      "instance_name": str|None,   # echo of what we sent on activate()
      "error": str|None,           # human readable, safe to show in the UI
      "error_kind": "network"|"rate_limited"|"rejected"|"bad_response"|None,
      "retryable": bool,           # network / rate limit => show Retry button
      "raw": dict,                 # parsed response, for the diagnostics dump
    }

HTTP facts encoded here (as of 2026, per PRODUCT.md):
  * POST form-encoded (application/x-www-form-urlencoded), NOT JSON.
  * Endpoints: /licenses/validate, /licenses/activate, /licenses/deactivate
  * activate() requires instance_name.
  * Responses: license_key.{status,activation_limit,activation_usage},
    plus instance.{id} on activate and meta.is_url on deactivate.
  * Rate limit: 60 requests/minute -> client-side sliding-window throttle with a
    friendly retryable error instead of a raw 429.
  * Internet is required: there is no offline/signed mode (fail closed).
"""

from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_BASE_URL = "https://api.lemonsqueezy.com/v1"
DEFAULT_TIMEOUT = 20.0
DEFAULT_RATE_LIMIT = 60          # requests per window
DEFAULT_RATE_WINDOW = 60.0       # seconds

_VALID_STATUSES = ("active", "inactive", "expired", "disabled")


class LicenseError(Exception):
    """Raised only where callers prefer exceptions; validate/activate catch it."""


class RateLimiter:
    """Sliding-window client-side throttle (60 req/min by default).

    Keeps us polite to the LS API and turns a would-be 429 into a clean,
    retryable client-side error before we even send the request.
    """

    def __init__(self, limit: int = DEFAULT_RATE_LIMIT, window: float = DEFAULT_RATE_WINDOW):
        self.limit = max(1, int(limit))
        self.window = float(window)
        self._stamps: list[float] = []
        self._lock = threading.Lock()

    def acquire(self, block: bool = True) -> bool:
        while True:
            with self._lock:
                now = time.monotonic()
                self._stamps = [t for t in self._stamps if now - t < self.window]
                if len(self._stamps) < self.limit:
                    self._stamps.append(now)
                    return True
                if not block:
                    return False
                wait = self.window - (now - self._stamps[0]) + 0.05
            time.sleep(max(wait, 0.05))


def _result(**kw) -> dict:
    base = {
        "ok": False,
        "status": "error",
        "activation_limit": None,
        "activation_usage": None,
        "remaining": None,
        "instance_id": None,
        "instance_name": None,
        "error": None,
        "error_kind": None,
        "retryable": False,
        "raw": {},
    }
    base.update(kw)
    if base["activation_limit"] is not None and base["activation_usage"] is not None:
        base["remaining"] = max(0, int(base["activation_limit"]) - int(base["activation_usage"]))
    return base


def _failure(error: str, kind: str, retryable: bool = False, **kw) -> dict:
    return _result(error=error, error_kind=kind, retryable=retryable, **kw)


# --------------------------------------------------------------------------
# Canned responses for BENCH_MOCK=1 (also used by unit-style smoke tests).
# Demo keys are deliberately tiny and memorable so a tech can demo the flow
# on the bench without burning a real code.
# --------------------------------------------------------------------------
MOCK_KEYS = {
    # key: (status, limit, usage)
    "RB-DEMO-0001-0001": ("active", 5, 1),    # healthy, 4 remaining
    "RB-DEMO-0002-0002": ("active", 5, 5),    # exhausted -> fail closed
    "RB-DEMO-0003-0003": ("disabled", 5, 0),  # disabled  -> fail closed
    "RB-DEMO-0004-0004": ("expired", 5, 2),   # expired   -> fail closed
}


class LicenseClient:
    """Thin, swap-friendly Lemon Squeezy license API client (stdlib only)."""

    def __init__(
        self,
        base_url: str | None = None,
        timeout: float = DEFAULT_TIMEOUT,
        rate_limit: int = DEFAULT_RATE_LIMIT,
        rate_window: float = DEFAULT_RATE_WINDOW,
        mock: bool = False,
        transport=None,
    ):
        self.base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
        self.timeout = timeout
        self.mock = bool(mock)
        self.limiter = RateLimiter(rate_limit, rate_window)
        # transport(method, url, data_bytes, headers) -> (status:int, body:bytes)
        # Lets tests (and future backends) intercept HTTP without touching callers.
        self._transport = transport
        self._mock_state = dict(MOCK_KEYS)  # copy: activate() bumps usage in mock
        self._mock_instances: dict[str, int] = {}

    # -- public API --------------------------------------------------------

    def validate(self, license_key: str) -> dict:
        """POST /licenses/validate -- check a code WITHOUT consuming it."""
        key = (license_key or "").strip()
        if not key:
            return _failure("Enter a license code.", "rejected")
        if self.mock:
            return self._mock_validate(key)
        return self._post("/licenses/validate", {"license_key": key})

    def activate(self, license_key: str, instance_name: str) -> dict:
        """POST /licenses/activate -- consume one unlock (this is the BURN)."""
        key = (license_key or "").strip()
        name = (instance_name or "").strip()
        if not key:
            return _failure("Enter a license code.", "rejected")
        if not name:
            return _failure("Missing activation instance name.", "rejected")
        if self.mock:
            return self._mock_activate(key, name)
        return self._post(
            "/licenses/activate",
            {"license_key": key, "instance_name": name},
        )

    def deactivate(self, license_key: str, instance_id: str) -> dict:
        """POST /licenses/deactivate -- give an unlock back (support/refund path)."""
        key = (license_key or "").strip()
        iid = (instance_id or "").strip()
        if not key or not iid:
            return _failure("Missing license key or instance id.", "rejected")
        if self.mock:
            if iid in self._mock_instances:
                k = self._mock_instances.pop(iid)
                st, lim, use = self._mock_state.get(k, ("active", 1, 1))
                self._mock_state[k] = (st, lim, max(0, use - 1))
            return _result(ok=True, status="active", instance_id=iid)
        return self._post(
            "/licenses/deactivate",
            {"license_key": key, "instance_id": iid},
        )

    def check_throttle(self) -> dict:
        """Non-destructive throttle probe used by the UI's network indicator."""
        if self.mock:
            return _result(ok=True, status="active")
        remaining = self.limiter.limit - len(self.limiter._stamps)
        return _result(ok=True, status="active", raw={"throttle_remaining": max(0, remaining)})

    # -- HTTP --------------------------------------------------------------

    def _post(self, path: str, fields: dict) -> dict:
        url = f"{self.base_url}{path}"
        data = urllib.parse.urlencode(fields).encode("utf-8")
        headers = {
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
            "User-Agent": "ReviveBench/1.0 (license-adapter)",
        }

        if not self.limiter.acquire(block=False):
            return _failure(
                "License service is rate limiting us (60 requests/min). "
                "Wait a few seconds and press Retry.",
                "rate_limited",
                retryable=True,
            )

        try:
            status, body = self._transport("POST", url, data, headers) if self._transport \
                else self._urllib_transport("POST", url, data, headers)
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            return _failure(
                f"Cannot reach the license service: {exc}. "
                "Check the bench PC's internet connection and press Retry.",
                "network",
                retryable=True,
            )

        if status == 429:
            return _failure(
                "License service said 'too many requests' (60/min). "
                "Wait a few seconds and press Retry.",
                "rate_limited",
                retryable=True,
            )

        try:
            payload = json.loads(body.decode("utf-8", "replace") or "{}")
        except (ValueError, UnicodeDecodeError):
            return _failure(
                "License service returned a response we could not read.",
                "bad_response",
                retryable=True,
            )
        return self._normalize(path, status, payload, fields)

    @staticmethod
    def _urllib_transport(method: str, url: str, data: bytes, headers: dict):
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=DEFAULT_TIMEOUT) as resp:
                return resp.getcode(), resp.read()
        except urllib.error.HTTPError as exc:  # 4xx/5xx still carry a JSON body
            try:
                return exc.code, exc.read()
            except Exception:
                return exc.code, b""

    def _normalize(self, path: str, status: int, payload: dict, fields: dict) -> dict:
        err = payload.get("error") or payload.get("errors")
        lk = payload.get("license_key") if isinstance(payload.get("license_key"), dict) else {}

        if err or status >= 400:
            msg = _flatten_error(err) or f"License service returned HTTP {status}."
            # LS invalid-key responses are 4xx with an error body such as
            # "license_key not found." -- that is a rejected code, not a
            # transport problem (404 = unknown key on this API).
            kind = "rejected" if status in (400, 401, 403, 404, 422) else "bad_response"
            return _failure(msg, kind, retryable=(kind == "bad_response"), raw=payload)

        st = lk.get("status")
        if st not in _VALID_STATUSES:
            st = lk.get("status") or "invalid"

        res = _result(
            ok=(st == "active"),
            status=st,
            activation_limit=_as_int(lk.get("activation_limit")),
            activation_usage=_as_int(lk.get("activation_usage")),
            instance_id=(payload.get("instance") or {}).get("id"),
            instance_name=fields.get("instance_name"),
            raw=payload,
        )
        _apply_limit_gate(res)
        if not res["ok"]:
            res["error"] = _status_message(st, res)
            res["error_kind"] = "rejected"
        return res

    # -- mock --------------------------------------------------------------

    def _mock_validate(self, key: str) -> dict:
        if key not in self._mock_state:
            return _failure(
                "Invalid license code. Codes look like RB-DEMO-0001-0001.",
                "rejected",
            )
        st, lim, use = self._mock_state[key]
        res = _result(
            ok=(st == "active"),
            status=st,
            activation_limit=lim,
            activation_usage=use,
            raw={"mock": True, "license_key": {"status": st}},
        )
        _apply_limit_gate(res)
        if not res["ok"]:
            res["error"] = _status_message(st, res)
            res["error_kind"] = "rejected"
        return res

    def _mock_activate(self, key: str, name: str) -> dict:
        res = self._mock_validate(key)
        if not res["ok"]:
            return res
        if res["remaining"] == 0:
            res["ok"] = False
            res["error"] = "Code already consumed (no unlocks remaining)."
            res["error_kind"] = "rejected"
            return res
        st, lim, use = self._mock_state[key]
        use += 1
        self._mock_state[key] = (st, lim, use)
        iid = f"mock-{name}"
        self._mock_instances[iid] = key
        return _result(
            ok=True,
            status="active",
            activation_limit=lim,
            activation_usage=use,
            instance_id=iid,
            instance_name=name,
            raw={"mock": True, "instance": {"id": iid}},
        )


# -- helpers ---------------------------------------------------------------


def _apply_limit_gate(res: dict) -> dict:
    """Fail closed when a 'valid' code has no unlocks left (PRODUCT.md §3 step 2:
    activation_usage >= activation_limit -> red state, stop)."""
    if res.get("ok") and res.get("activation_limit") is not None \
            and res.get("activation_usage") is not None and res.get("remaining") == 0:
        res["ok"] = False
        res["error"] = "Code already consumed (no unlocks remaining)."
        res["error_kind"] = "rejected"
    return res


def _as_int(v) -> int | None:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _flatten_error(err) -> str:
    if isinstance(err, str):
        return err
    if isinstance(err, dict):
        parts = []
        for k, v in err.items():
            if isinstance(v, (list, tuple)):
                v = ", ".join(str(x) for x in v)
            parts.append(f"{k}: {v}" if k else str(v))
        return "; ".join(parts)
    if isinstance(err, (list, tuple)):
        return "; ".join(_flatten_error(e) for e in err)
    return str(err) if err else ""


def _status_message(status: str, res: dict) -> str:
    if status == "disabled":
        return "This code has been disabled. Contact the seller."
    if status == "expired":
        return "This code has expired. Contact the seller."
    if status == "inactive":
        return "This code is not yet active. Contact the seller."
    if res.get("remaining") == 0:
        return "Code already consumed (no unlocks remaining)."
    return f"License not usable (status: {status})."
