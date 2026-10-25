#!/usr/bin/env python3
"""ReviveBench Bench GUI -- Linux-side guided unlock flow.

Python 3 standard library ONLY (the Mint live session has no pip).

    BENCH_MOCK=1 python3 bench_gui.py      # full simulation, runs anywhere
    python3 bench_gui.py                   # real tools (Linux, LIK installed)

Serves a one-page big-type UI from ./static on http://127.0.0.1:8777 and opens
the browser automatically. The UI polls GET /api/state and posts commands to
the endpoints below; the server drives subprocesses and streams their output
into per-step log buffers that the UI renders.

State machine (PRODUCT.md §3, linear + re-entrant on failure):

    setup -> license -> device -> dfu -> ramdisk -> activator -> verify -> burn
                                                                      -> done

Endpoints
    GET  /api/state                 full state snapshot (poll ~700ms)
    GET  /api/diagnostics           diagnostics text (same as POST, read-only)
    POST /api/setup                 apt deps + ensure legacy-ios-kit/ clone
    POST /api/license/validate      {license_key} -> LS validate (no burn)
    POST /api/device/refresh        force one poll cycle now
    POST /api/dfu/start | /api/dfu/retry
    POST /api/ramdisk               run restore.sh --sshrd (streamed)
    POST /api/activator             verify tarball sha256, extract, run activator
    POST /api/verify                poll ActivationState until != Unactivated
    POST /api/burn                  {proof_of_purchase} -> LS activate (the burn)
    POST /api/burn/retry            re-attempt a failed/pending burn
    POST /api/repeat                unlock another device (keeps a valid code)
    POST /api/diagnostics           write ~/revivebench_diag.txt, return text
    POST /api/reset                 full reset back to setup (also used by tests)

Environment (all optional, so a seller can override paths without editing code)
    BENCH_MOCK=1              simulate everything (no Apple tools, no network)
    BENCH_HOST=127.0.0.1      bind address (kept loopback on purpose)
    BENCH_PORT=8777           bind port
    BENCH_NO_BROWSER=1        do not auto-open the browser
    RB_LIK_DIR=/path          Legacy-iOS-Kit checkout (default: <cwd>/legacy-ios-kit)
    RB_PAYLOAD_DIR=/path      payload dir with the activator tarball (default: <cwd>/payload)
    RB_RESTORE_SH=path        restore.sh override (default: $RB_LIK_DIR/restore.sh)
    RB_ACTIVATOR=path         extracted activator binary override
    RB_IDEVICE_ID / RB_IRECOVERY / RB_IDEVICEINFO / RB_IDEVICE_ACTIVATION
                              tool path overrides (defaults: names on PATH)
    RB_ACTIVATOR_ARGS="..."   extra argv for the activator (see INTEGRATION notes)
    RB_ACTIVATOR_ANSWERS='["6414",""]'  explicit stdin answers, in order

Activator integration (verified against the shipped binary, see report):
the PyInstaller/PyArmor build is obfuscated, so its argv flags cannot be read
statically. We therefore run it with an empty-or-configured argv and drive it
over stdin, replying to each prompt (port questions -> 6414, y/n + Enter ->
default). Configure via RB_ACTIVATOR_ARGS / RB_ACTIVATOR_ANSWERS when a future
release exposes real flags.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import platform
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import traceback
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import license_adapter  # noqa: E402  (sibling module, same folder)

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(HERE, "static")
VERSION = "1.0.0"

MOCK = os.environ.get("BENCH_MOCK", "") == "1"
HOST = os.environ.get("BENCH_HOST", "127.0.0.1")
PORT = int(os.environ.get("BENCH_PORT", "8777"))
OPEN_BROWSER = os.environ.get("BENCH_NO_BROWSER", "") != "1"

PAYLOAD_DIR = os.environ.get("RB_PAYLOAD_DIR") or os.path.join(HERE, "..", "payload")
LIK_DIR = os.environ.get("RB_LIK_DIR") or os.path.join(HERE, "legacy-ios-kit")
RESTORE_SH = os.environ.get("RB_RESTORE_SH") or os.path.join(LIK_DIR, "restore.sh")
ACTIVATOR_BIN = os.environ.get("RB_ACTIVATOR", "")

IDEVICE_ID = os.environ.get("RB_IDEVICE_ID", "idevice_id")
IRECOVERY = os.environ.get("RB_IRECOVERY", "irecovery")
IDEVICEINFO = os.environ.get("RB_IDEVICEINFO", "ideviceinfo")
IDEVICE_ACTIVATION = os.environ.get("RB_IDEVICE_ACTIVATION", "ideviceactivation")

ACTIVATOR_TARBALL = "Legacy-iOS-Activator2-7.tar.gz"
ACTIVATOR_SHA256 = "97ac871064c944845816d004a5aebe340670dd48545cd15733bf13d59ceed783"

APT_PACKAGES = (
    "git curl libimobiledevice-utils libirecovery-utils usbmuxd "
    "libplist3 python3 unzip"
)

STEPS = ["setup", "license", "device", "dfu", "ramdisk", "activator", "verify", "burn"]
STEP_TITLES = {
    "setup": "1. Prepare tools",
    "license": "2. License code",
    "device": "3. Device detection",
    "dfu": "4. DFU mode",
    "ramdisk": "5. Boot SSH ramdisk",
    "activator": "6. Run activator",
    "verify": "7. Verify unlock",
    "burn": "8. Consume license code",
}

# restore.sh markers (verified in research/restore.sh)
MARKER_RAMDISK_OK = "Device should now boot to SSH ramdisk mode."
MARKER_RAMDISK_BOOTING = "Booting, please wait..."
MARKER_RAMDISK_SSH = "Waiting for device..."

MAX_LOG_LINES = 3000
PROMPT_PAT = re.compile(
    r"(press enter|enter/return|press return|\[Input\]|select y/n|y/n\)|password"
    r"|port\?|port:|\?\s*$)",
    re.IGNORECASE,
)


def now() -> float:
    return time.time()


def today() -> str:
    return time.strftime("%Y%m%d")


def new_license_client():
    """Build the license client. RB_LS_BASE_URL lets a seller point the adapter
    at a different Lemon Squeezy-compatible endpoint (or a stub) without code
    changes -- the swap itself still lives entirely in license_adapter.py."""
    return license_adapter.LicenseClient(
        mock=MOCK,
        base_url=os.environ.get("RB_LS_BASE_URL") or None,
    )


# --------------------------------------------------------------------------
# Shared state
# --------------------------------------------------------------------------

class BenchState:
    """Everything the UI renders, guarded by one lock."""

    def __init__(self):
        self.lock = threading.RLock()
        self.started = now()
        self.step = "setup"
        self.steps = {k: {"status": "pending", "error": None} for k in STEPS}
        self.device = {
            "mode": "none",          # none | normal | dfu | recovery
            "product": None,
            "model": None,
            "ios": None,
            "ecid": None,
            "udid": None,
            "pwnd": None,
            "raw": {},
            "last_poll": None,
            "poll_error": None,
        }
        self.dfu = {"active": False, "started_at": None, "note": None}
        self.license = {
            "key": None,
            "valid": False,
            "status": None,
            "limit": None,
            "usage": None,
            "remaining": None,
            "error": None,
            "retryable": False,
        }
        self.verify = {"state": "idle", "activation_state": None, "error": None}
        self.burn = {
            "state": "idle",        # idle | pending | done | failed
            "instance_name": None,
            "instance_id": None,
            "usage": None,
            "limit": None,
            "error": None,
            "pop": False,
            "attempt": 0,
        }
        self.last_error = None
        self.log: list[dict] = []
        self._running: set[str] = set()
        self.client = new_license_client()

    def reset_client(self) -> None:
        self.client = new_license_client()

    # -- logging ---------------------------------------------------------

    def log_line(self, step: str, line: str, level: str = "info") -> None:
        if isinstance(line, bytes):
            line = line.decode("utf-8", "replace")
        entry = {"t": round(now(), 2), "step": step, "line": str(line).rstrip("\r"), "level": level}
        with self.lock:
            self.log.append(entry)
            if len(self.log) > MAX_LOG_LINES:
                del self.log[: len(self.log) - MAX_LOG_LINES]

    def logs_for(self, step: str | None = None, tail: int | None = None) -> list[dict]:
        with self.lock:
            rows = [r for r in self.log if step in (None, r["step"])]
            return rows[-tail:] if tail else rows

    # -- step bookkeeping ------------------------------------------------

    def set_step(self, step: str) -> None:
        with self.lock:
            if step in STEPS:
                self.step = step

    def mark(self, step: str, status: str, error: str | None = None) -> None:
        with self.lock:
            self.steps[step]["status"] = status
            self.steps[step]["error"] = error
            if status == "error":
                self.last_error = error
            if status == "done":
                # linear flow: current step = first step not yet done
                cur = next((s for s in STEPS if self.steps[s]["status"] != "done"), None)
                if cur:
                    self.step = cur

    def _next_pending(self, after: str) -> str | None:
        try:
            idx = STEPS.index(after)
        except ValueError:
            return None
        for s in STEPS[idx + 1:]:
            if self.steps[s]["status"] != "done":
                return s
        return "done"

    def begin(self, step: str) -> bool:
        """Guard against double-starting a step; False if already running."""
        with self.lock:
            if step in self._running:
                return False
            self._running.add(step)
            self.steps[step]["status"] = "running"
            self.steps[step]["error"] = None
            self.step = step
            return True

    def end(self, step: str) -> None:
        with self.lock:
            self._running.discard(step)

    def is_running(self, step: str) -> bool:
        with self.lock:
            return step in self._running

    # -- snapshot --------------------------------------------------------

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "version": VERSION,
                "mock": MOCK,
                "platform": platform.platform(),
                "started": self.started,
                "step": self.step,
                "steps": json.loads(json.dumps(self.steps)),
                "titles": STEP_TITLES,
                "device": json.loads(json.dumps(self.device)),
                "dfu": json.loads(json.dumps(self.dfu)),
                "dfu_phase": self._dfu_phase_locked(),
                "license": json.loads(json.dumps(self.license)),
                "verify": json.loads(json.dumps(self.verify)),
                "burn": json.loads(json.dumps(self.burn)),
                "last_error": self.last_error,
                "log_tail": json.loads(json.dumps(self.log[-400:])),
                "config": {
                    "payload_dir": os.path.abspath(PAYLOAD_DIR),
                    "lik_dir": os.path.abspath(LIK_DIR),
                    "restore_sh": RESTORE_SH,
                    "rate_limit": "60 req/min",
                },
            }

    def _dfu_phase_locked(self) -> str:
        d = self.dfu
        if not d["active"]:
            return "idle"
        mode = self.device["mode"]
        if mode == "dfu":
            return "detected"
        if mode == "recovery":
            return "recovery"
        el = now() - (d["started_at"] or now())
        if el < 10:
            return "power_home"
        if el < 15:
            return "release_power"
        return "hold_home"

    def dfu_elapsed(self) -> float:
        with self.lock:
            if not self.dfu["active"]:
                return 0.0
            return now() - (self.dfu["started_at"] or now())


STATE = BenchState()


# --------------------------------------------------------------------------
# Subprocess helpers
# --------------------------------------------------------------------------

def _which_or(path: str) -> str:
    """Resolve a tool: absolute path as-is, bare name via PATH (or 'missing')."""
    if os.path.sep in path or (os.path.altsep and os.path.altsep in path):
        return path
    return shutil.which(path) or path


def run_capture(argv, timeout=30, cwd=None, env=None) -> tuple[int, str]:
    """Run a short command, return (returncode, combined output). Never raises."""
    try:
        p = subprocess.run(
            argv, cwd=cwd, env=env, timeout=timeout,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            errors="replace",
        )
        return p.returncode, p.stdout or ""
    except FileNotFoundError:
        return 127, f"tool not found: {argv[0]}"
    except subprocess.TimeoutExpired:
        return 124, f"timed out after {timeout}s: {' '.join(argv)}"
    except OSError as exc:
        return 1, f"{exc}"


def run_streaming(
    step: str,
    argv,
    cwd=None,
    timeout=900,
    stop_markers=(),
    env=None,
    stdin_script=None,
    on_line=None,
    answer_fn=None,
) -> tuple[int, bool]:
    """Run a long command, streaming every line into the log buffer.

    Returns (returncode, stopped_early) where stopped_early=True means a success
    marker appeared and we terminated the process on purpose (restore.sh falls
    into an interactive menu after booting the ramdisk -- we do not want it).

    stdin_script: optional list of answers fed to the child whenever it prints a
    prompt-looking line (restore.sh uses `pause`/`read` in a few places).
    answer_fn: optional callable(line) -> str | None, consulted per prompt so a
    caller can answer conditionally (e.g. "port?" -> 6414).
    """
    STATE.log_line(step, f"$ {' '.join(argv)}  (cwd={cwd or os.getcwd()})", "cmd")
    if MOCK:
        return _mock_stream(step, argv, timeout, stop_markers)

    stop_event = threading.Event()
    stopped_early = {"flag": False}
    answers = list(stdin_script or [])

    try:
        proc = subprocess.Popen(
            argv,
            cwd=cwd,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            errors="replace",
        )
    except OSError as exc:
        STATE.log_line(step, f"failed to start: {exc}", "error")
        return 1, False

    def feed(what: str) -> None:
        try:
            if proc.stdin:
                proc.stdin.write(what)
                proc.stdin.flush()
        except (BrokenPipeError, OSError):
            pass

    def reader() -> None:
        try:
            for raw in proc.stdout:
                line = raw.rstrip("\n")
                if not stop_event.is_set():
                    STATE.log_line(step, line)
                    if on_line:
                        try:
                            on_line(line)
                        except Exception:
                            pass
                    if any(m in line for m in stop_markers):
                        stopped_early["flag"] = True
                        stop_event.set()
                        break
                    if PROMPT_PAT.search(line):
                        reply = answer_fn(line) if answer_fn else None
                        if reply is None:
                            reply = answers.pop(0) if answers else "\n"
                        feed(reply)
        except (ValueError, OSError):
            pass

    t = threading.Thread(target=reader, daemon=True)
    t.start()

    deadline = now() + timeout
    while not stop_event.is_set():
        if proc.poll() is not None:
            break
        if now() > deadline:
            STATE.log_line(step, f"timeout after {timeout}s -- terminating", "error")
            stop_event.set()
            try:
                proc.terminate()
            except OSError:
                pass
            break
        time.sleep(0.2)

    if stop_event.is_set() and proc.poll() is None:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            try:
                proc.kill()
            except OSError:
                pass
    try:
        if proc.stdin:
            proc.stdin.close()
    except OSError:
        pass
    t.join(timeout=3)

    rc = proc.poll()
    if rc is None:
        rc = 0
    STATE.log_line(step, f"exit code {rc}", "cmd")
    return rc, stopped_early["flag"]


def _mock_stream(step: str, argv, timeout, stop_markers) -> tuple[int, bool]:
    """Canned output for BENCH_MOCK=1 -- realistic shape, a few seconds long."""
    script = _MOCK_SCRIPTS.get(step, ["(mock) nothing to do"])
    for line in script:
        if isinstance(line, (int, float)):
            time.sleep(line)
            continue
        STATE.log_line(step, line)
    return 0, bool(stop_markers)


_MOCK_SCRIPTS = {
    "setup": [
        0.2,
        "$ sudo apt-get install -y git curl libimobiledevice-utils ...",
        "Reading package lists... Done",
        "git is already the newest version.",
        "curl is already the newest version.",
        "libimobiledevice-utils is already the newest version.",
        "libirecovery-utils is already the newest version.",
        "usbmuxd is already the newest version.",
        "libplist3 is already the newest version.",
        "unzip is already the newest version.",
        "0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.",
        "Cloning Legacy-iOS-Kit... (or reusing payload bundle)",
        "Already up to date.",
        "[Log] tools ready",
        0.3,
    ],
    "ramdisk": [
        0.3,
        " *** Legacy iOS Kit ***",
        " - Script by LukeZGD -",
        "[Log] Checking for device... device found: iPad2,5 (DFU mode)",
        "[Log] Device is on iOS 9+, using 9.3.5 (13G36) ramdisk",
        "[Log] Getting firmware keys for iPad2,5 13G36",
        "[Log] iBSS", "[Log] iBEC", "[Log] DeviceTree", "[Log] Kernelcache",
        "[Log] RestoreRamdisk",
        "[Log] Patching files",
        "[Log] Sending iBSS/iBEC to device",
        "[Log] Booting, please wait...",
        1.2,
        "[Log] Waiting for device...",
        1.0,
        "[Log] Device should now boot to SSH ramdisk mode.",
        "* Mount filesystems with this command: mount.sh",
        "(mock) terminating restore.sh before its interactive menu",
        0.3,
    ],
    "activator": [
        0.3,
        "(mock) verifying Legacy-iOS-Activator2-7.tar.gz sha256... OK",
        "(mock) extracting activator binary",
        "(mock) launching: ./Legacy iOS Activator",
        "DFU/SSH port? [6414]: 6414",
        "[*] connected to device on port 6414",
        "[*] booting activation services",
        "[+] activation bypass complete",
        "(mock) activator exited with code 0",
        0.3,
    ],
}


# --------------------------------------------------------------------------
# Device polling
# --------------------------------------------------------------------------

def _parse_irecovery(text: str) -> dict:
    out = {}
    for line in text.splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            out[k.strip().upper()] = v.strip()
    return out


def poll_device_once() -> dict:
    """One detection cycle: irecovery -q (DFU/recovery) + idevice_id (normal)."""
    if MOCK:
        return _mock_poll()

    dev = {"mode": "none", "product": None, "model": None, "ios": None,
           "ecid": None, "udid": None, "pwnd": None, "raw": {}, "poll_error": None}

    rc, out = run_capture([_which_or(IRECOVERY), "-q"], timeout=8)
    if rc == 0 and out.strip():
        info = _parse_irecovery(out)
        if info:
            dev["raw"]["irecovery"] = info
            mode = (info.get("MODE") or "").upper()
            dev["product"] = info.get("PRODUCT") or dev["product"]
            dev["ecid"] = info.get("ECID") or dev["ecid"]
            dev["pwnd"] = info.get("PWND")
            if mode == "DFU":
                dev["mode"] = "dfu"
            elif mode == "RECOVERY":
                dev["mode"] = "recovery"

    if dev["mode"] == "none":
        rc, ids = run_capture([_which_or(IDEVICE_ID), "-l"], timeout=8)
        udids = [u for u in ids.split() if u.strip()]
        if rc == 0 and udids:
            dev["mode"] = "normal"
            dev["udid"] = udids[0]
            for key, field in (("ProductType", "product"),
                               ("ProductVersion", "ios"),
                               ("UniqueChipID", "ecid")):
                rc2, val = run_capture([_which_or(IDEVICEINFO), "-k", key], timeout=8)
                if rc2 == 0 and val.strip():
                    dev[field] = val.strip().splitlines()[-1].strip()
            rc2, val = run_capture([_which_or(IDEVICEINFO), "-k", "ActivationState"], timeout=8)
            if rc2 == 0 and val.strip():
                dev["raw"]["ActivationState"] = val.strip().splitlines()[-1].strip()

    dev["last_poll"] = now()
    return dev


def _mock_poll() -> dict:
    dev = {"mode": "none", "product": "iPad2,5", "model": "j71b", "ios": "9.3.5",
           "ecid": "1234567890123456", "udid": None, "pwnd": None,
           "raw": {"mock": True}, "poll_error": None, "last_poll": now()}
    present = os.environ.get("BENCH_MOCK_DEVICE", "present") != "absent"
    if not present:
        dev.update(product=None, model=None, ios=None, ecid=None)
        return dev

    forced = os.environ.get("BENCH_MOCK_MODE", "").lower()
    with STATE.lock:
        dfu_active = STATE.dfu["active"]
        el = now() - (STATE.dfu["started_at"] or now())

    if forced in ("dfu", "recovery"):
        dev["mode"] = forced
    elif dfu_active and el >= 8:
        dev["mode"] = "dfu"
        dev["pwnd"] = "checkm8-a5" if os.environ.get("BENCH_MOCK_PWNED", "1") == "1" else None
        dev["ios"] = None  # DFU mode: no lockdown info
    else:
        dev["mode"] = "normal"
        dev["raw"]["ActivationState"] = "Unactivated"
    if dev["mode"] in ("dfu", "recovery"):
        dev["ios"] = None
    return dev


def device_poller():
    """1s cadence poll loop; also drives the DFU guide's auto-advance."""
    while True:
        try:
            dev = poll_device_once()
            with STATE.lock:
                prev = STATE.device["mode"]
                STATE.device.update(dev)
                # DFU guide reacts to what the cable actually reports
                if STATE.dfu["active"]:
                    if dev["mode"] == "dfu":
                        STATE.dfu["note"] = None
                        if STATE.steps["dfu"]["status"] != "done":
                            STATE.log_line("dfu", "DFU mode detected ✓", "info")
                            STATE.mark("dfu", "done")
                    elif dev["mode"] == "recovery" and prev != "recovery":
                        STATE.dfu["note"] = "recovery_seen"
                        STATE.log_line(
                            "dfu",
                            "Recovery mode detected (cable/iTunes logo) -- that is not DFU. "
                            "Redo the sequence.",
                            "error",
                        )
                if dev["mode"] != "none" and STATE.steps["device"]["status"] == "pending":
                    STATE.mark("device", "done")
            if dev.get("poll_error"):
                STATE.log_line("device", f"poll error: {dev['poll_error']}", "error")
        except Exception:  # poller must never die
            STATE.log_line("device", "poller exception: " + traceback.format_exc(limit=1), "error")
        time.sleep(1.0)


# --------------------------------------------------------------------------
# Step implementations
# --------------------------------------------------------------------------

def do_setup():
    step = "setup"
    if not STATE.begin(step):
        return
    try:
        STATE.log_line(step, f"payload dir: {os.path.abspath(PAYLOAD_DIR)}")
        STATE.log_line(step, f"legacy-ios-kit dir: {os.path.abspath(LIK_DIR)}")

        if MOCK:
            run_streaming(step, ["mock", "setup"], stop_markers=())
        else:
            apt = ["sudo", "apt-get", "install", "-y"] + APT_PACKAGES.split()
            rc, out = run_capture(apt, timeout=600)
            for line in out.splitlines():
                STATE.log_line(step, line, "error" if rc not in (0,) and "E:" in line else "info")
            if rc != 0:
                STATE.log_line(step, "apt-get returned non-zero (continuing if tools exist)", "warn")

            if os.path.isdir(LIK_DIR) and os.path.isfile(RESTORE_SH):
                STATE.log_line(step, "legacy-ios-kit already present")
            else:
                bundled = os.path.join(PAYLOAD_DIR, "legacy-ios-kit")
                if os.path.isdir(bundled):
                    STATE.log_line(step, f"copying bundled legacy-ios-kit from {bundled}")
                    if os.path.isdir(LIK_DIR):
                        shutil.rmtree(LIK_DIR, ignore_errors=True)
                    shutil.copytree(bundled, LIK_DIR, symlinks=True)
                else:
                    STATE.log_line(step, "cloning Legacy-iOS-Kit from GitHub")
                    rc, out = run_capture(
                        ["git", "clone", "--filter=blob:none",
                         "https://github.com/LukeZGD/Legacy-iOS-Kit", LIK_DIR],
                        timeout=900,
                    )
                    for line in out.splitlines():
                        STATE.log_line(step, line)

            # verify the tools we depend on later
            for tool in (IDEVICE_ID, IRECOVERY, IDEVICEINFO):
                name = os.path.basename(tool)
                found = shutil.which(tool) if os.path.sep not in tool else (
                    tool if os.path.exists(tool) else None)
                STATE.log_line(step, f"{name}: {'ok' if found else 'NOT FOUND -- check apt step'}",
                               "info" if found else "warn")

            if not os.path.isfile(RESTORE_SH):
                STATE.mark(step, "error", f"restore.sh not found at {RESTORE_SH}")
                return

        STATE.mark(step, "done")
    except Exception as exc:
        STATE.mark(step, "error", f"{exc}\n{traceback.format_exc(limit=2)}")
    finally:
        STATE.end(step)


def do_license_validate(payload: dict) -> dict:
    key = (payload or {}).get("license_key") or ""
    res = STATE.client.validate(key)
    with STATE.lock:
        STATE.license.update({
            "key": key.strip(),
            "valid": bool(res["ok"]),
            "status": res["status"],
            "limit": res["activation_limit"],
            "usage": res["activation_usage"],
            "remaining": res["remaining"],
            "error": res["error"],
            "retryable": res["retryable"],
        })
        if res["ok"]:
            STATE.mark("license", "done")
            STATE.license["error"] = None
        else:
            STATE.mark("license", "error", res["error"])
    STATE.log_line("license", f"validate -> {res['status']}"
                  + (f", {res['remaining']} remaining" if res["remaining"] is not None else "")
                  + (f" ({res['error']})" if res["error"] else ""),
                  "info" if res["ok"] else "error")
    return res


def start_step_thread(fn, *args):
    t = threading.Thread(target=fn, args=args, daemon=True)
    t.start()
    return t


def do_dfu_start():
    step = "dfu"
    with STATE.lock:
        STATE.dfu = {"active": True, "started_at": now(), "note": None}
        STATE.steps[step]["status"] = "running"
        STATE.steps[step]["error"] = None
        STATE.step = step
    STATE.log_line(step, "DFU guide started -- hold Power + Home now (10s), "
                         "then keep holding Home (5s) until the screen is black.")


def do_dfu_retry():
    with STATE.lock:
        STATE.dfu = {"active": True, "started_at": now(), "note": None}
        STATE.steps["dfu"]["status"] = "running"
        STATE.steps["dfu"]["error"] = None
    STATE.log_line("dfu", "Retry: hold Power + Home now (10s), then keep holding Home (5s).")


def do_ramdisk():
    step = "ramdisk"
    if not STATE.begin(step):
        return

    def work():
        try:
            with STATE.lock:
                mode = STATE.device["mode"]
            if mode not in ("dfu",) and not MOCK:
                STATE.log_line(step, f"device mode is '{mode}' -- restore.sh expects DFU", "warn")
                if mode == "recovery":
                    STATE.mark(step, "error", "Device is in recovery mode, not DFU. Redo step 4.")
                    return

            # Clean stale tmp dirs: leftover instances make restore.sh prompt
            # (select_yesno on startup) which would stall a scripted run.
            if not MOCK and os.path.isdir(LIK_DIR):
                for name in os.listdir(LIK_DIR):
                    if name.startswith("tmp") and os.path.isdir(os.path.join(LIK_DIR, name)):
                        STATE.log_line(step, f"removing stale {name}/")
                        shutil.rmtree(os.path.join(LIK_DIR, name), ignore_errors=True)

            argv = ["bash", RESTORE_SH,
                    "--sshrd",            # boot the SSH ramdisk (device_enter_ramdisk)
                    "--no-color",         # no tput escapes in our log panel
                    "--no-version-check", # never block on GitHub update prompts
                    "--no-internet-check"]
            cwd = None if MOCK else (LIK_DIR or None)

            rc, stopped = run_streaming(
                step, argv, cwd=cwd, timeout=1800,
                stop_markers=(MARKER_RAMDISK_OK,),
                stdin_script=["\n"],
            )
            if stopped:
                STATE.log_line(step, "ramdisk boot confirmed -- stopping restore.sh "
                                     "(it would otherwise open its interactive menu)")
                STATE.mark(step, "done")
            elif rc == 0:
                STATE.mark(step, "done")
            else:
                hint = ""
                low = "\n".join(r["line"] for r in STATE.logs_for(step, tail=60)).lower()
                if "internet" in low:
                    hint = " -- LIK needs internet to download firmware components"
                elif "not in pwned dfu" in low or "checkm8-a5" in low:
                    hint = (" -- A5 device must be in PWNED DFU (checkm8-a5 hardware) "
                            "or in kDFU mode")
                elif "no device found" in low:
                    hint = " -- no device seen; replug on a direct USB-A port and retry"
                STATE.mark(step, "error", f"restore.sh exited {rc}.{hint}")
        except Exception as exc:
            STATE.mark(step, "error", f"{exc}\n{traceback.format_exc(limit=2)}")
        finally:
            STATE.end(step)

    start_step_thread(work)


def _activator_paths() -> tuple[str | None, str | None]:
    """Return (tarball_path, binary_path) -- whichever exist."""
    tarball = os.path.join(PAYLOAD_DIR, ACTIVATOR_TARBALL)
    if not os.path.isfile(tarball):
        alt = os.path.join(HERE, "..", "payload", ACTIVATOR_TARBALL)
        tarball = alt if os.path.isfile(alt) else tarball
    binary = ACTIVATOR_BIN
    if not binary:
        guess = os.path.join(PAYLOAD_DIR, "activator", "Legacy iOS Activator")
        binary = guess if os.path.isfile(guess) else None
    return (tarball if os.path.isfile(tarball) else None,
            binary if binary and os.path.isfile(binary) else None)


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def do_activator():
    step = "activator"
    if not STATE.begin(step):
        return

    def work():
        try:
            tarball, binary = _activator_paths()

            if MOCK:
                run_streaming(step, ["mock", "activator"], stop_markers=())
                STATE.mark(step, "done")
                return

            # 1) pin the payload tarball before trusting anything from it (§6)
            if tarball:
                digest = _sha256(tarball)
                STATE.log_line(step, f"tarball sha256: {digest}")
                if digest != ACTIVATOR_SHA256:
                    STATE.mark(step, "error",
                               "activator tarball SHA256 mismatch -- stick may be corrupt. "
                               f"expected {ACTIVATOR_SHA256}, got {digest}")
                    return
                STATE.log_line(step, "sha256 matches the pinned value")
            else:
                STATE.log_line(step, f"{ACTIVATOR_TARBALL} not found in payload dir", "warn")

            # 2) extract if we don't have a binary yet
            if not binary and tarball:
                dest = os.path.join(PAYLOAD_DIR, "activator")
                STATE.log_line(step, f"extracting to {dest}")
                with tarfile.open(tarball, "r:gz") as tf:
                    tf.extractall(dest, filter="data")
                for root, _dirs, files in os.walk(dest):
                    for f in files:
                        if f == "Legacy iOS Activator":
                            binary = os.path.join(root, f)
                            break
                    if binary:
                        break
            if not binary:
                STATE.mark(step, "error", "activator binary not found in payload")
                return

            os.chmod(binary, 0o755)
            extra = shlex.split(os.environ.get("RB_ACTIVATOR_ARGS", ""))
            argv = [binary] + extra

            # 3) drive it: PyArmor-obfuscated build -> prompt-driven over stdin.
            #    Answers can be pinned with RB_ACTIVATOR_ANSWERS='["6414",""]'.
            #    Default behaviour: a question mentioning the port gets 6414
            #    (the SSH port this flow uses), everything else gets Enter.
            answers: list[str] = []
            answers_env = os.environ.get("RB_ACTIVATOR_ANSWERS", "")
            if answers_env:
                try:
                    parsed = json.loads(answers_env)
                    if isinstance(parsed, list):
                        answers = [str(a) for a in parsed]
                except ValueError:
                    answers = [a.strip() for a in answers_env.split(",")]

            def answer_fn(line: str) -> str | None:
                low = line.lower()
                if "port" in low or "6414" in low:
                    return (answers.pop(0) if answers else "6414\n")
                if answers:
                    return answers.pop(0)
                if re.search(r"y/n|\[y\]|\[n\]|yes|no", low):
                    return "y\n"
                return "\n"

            rc, _ = run_streaming(
                step, argv, cwd=os.path.dirname(binary), timeout=900,
                answer_fn=answer_fn,
            )
            if rc == 0:
                STATE.mark(step, "done")
            else:
                STATE.mark(step, "error",
                           f"activator exited {rc} -- see log. iOS 9 quirk: if the data "
                           "partition will not mount, run `fsck_hfs -f /dev/disk0s1s2`.")
        except Exception as exc:
            STATE.mark(step, "error", f"{exc}\n{traceback.format_exc(limit=2)}")
        finally:
            STATE.end(step)

    start_step_thread(work)


def do_verify():
    step = "verify"
    if not STATE.begin(step):
        return

    def work():
        try:
            with STATE.lock:
                STATE.verify = {"state": "running", "activation_state": None, "error": None}
            timeout = 8 if MOCK else 120
            deadline = now() + timeout
            state_val = None
            while now() < deadline:
                if MOCK:
                    time.sleep(2.0)
                    state_val = "Activated"
                    break
                mode = STATE.device["mode"]
                if mode in ("dfu", "recovery"):
                    STATE.log_line(step, f"waiting: device still in {mode} mode")
                    state_val = "Unactivated"
                else:
                    rc, out = run_capture([_which_or(IDEVICEINFO), "-k", "ActivationState"], timeout=10)
                    state_val = out.strip().splitlines()[-1].strip() if (rc == 0 and out.strip()) else None
                    STATE.log_line(step, f"ActivationState={state_val or 'unknown'}")
                    if state_val and state_val != "Unactivated":
                        break
                time.sleep(2.0)

            ok = bool(state_val and state_val != "Unactivated")
            with STATE.lock:
                STATE.verify = {
                    "state": "done" if ok else "timeout",
                    "activation_state": state_val,
                    "error": None if ok else
                        "Device did not reach an activated state within "
                        f"{timeout}s (last value: {state_val}).",
                }
                if ok:
                    STATE.mark(step, "done")
                else:
                    STATE.mark(step, "error", STATE.verify["error"])
        except Exception as exc:
            STATE.mark(step, "error", f"{exc}\n{traceback.format_exc(limit=2)}")
        finally:
            STATE.end(step)

    start_step_thread(work)


def build_instance_name(pop: bool) -> str:
    with STATE.lock:
        ecid = STATE.device.get("ecid") or STATE.device.get("product") or "UNKNOWN"
    name = f"RB-{ecid}-{today()}"
    if pop:
        name += "-PoP1"
    return name


def do_burn(payload: dict | None = None):
    payload = payload or {}
    pop = bool(payload.get("proof_of_purchase"))
    step = "burn"

    with STATE.lock:
        key = STATE.license.get("key")
        if not STATE.license.get("valid"):
            STATE.steps[step]["status"] = "error"
            STATE.steps[step]["error"] = "License is not validated -- go back to step 2."
            return
        if STATE.steps["verify"]["status"] != "done":
            STATE.steps[step]["status"] = "error"
            STATE.steps[step]["error"] = "Unlock not verified yet -- step 7 must pass first."
            return
        STATE.steps[step]["status"] = "running"
        STATE.steps[step]["error"] = None
        STATE.step = step
        STATE.burn.update({"state": "running", "pop": pop, "error": None,
                           "attempt": STATE.burn.get("attempt", 0) + 1})

    instance = build_instance_name(pop)
    STATE.log_line(step, f"burning license (attempt {STATE.burn['attempt']}): {instance}")
    res = STATE.client.activate(key, instance)

    with STATE.lock:
        if res["ok"]:
            STATE.burn.update({
                "state": "done",
                "instance_name": instance,
                "instance_id": res["instance_id"],
                "usage": res["activation_usage"],
                "limit": res["activation_limit"],
                "error": None,
            })
            STATE.license["usage"] = res["activation_usage"]
            STATE.license["remaining"] = res["remaining"]
            STATE.mark(step, "done")
            STATE.log_line(step, f"burn OK -- usage {res['activation_usage']}/{res['activation_limit']}")
        else:
            # §6: unlock DID succeed; keep the retry state alive until restart.
            retryable = res["retryable"] or res["error_kind"] in ("network", "rate_limited")
            STATE.burn.update({
                "state": "pending" if retryable else "failed",
                "instance_name": instance,
                "error": res["error"],
            })
            STATE.mark(step, "error", res["error"])
            STATE.log_line(step, f"burn FAILED ({res['error_kind']}): {res['error']}", "error")
            if retryable:
                STATE.log_line(
                    step,
                    "The unlock itself succeeded -- do NOT unplug the device. "
                    "Press 'Retry burn' once the network is back.",
                    "warn",
                )


def do_repeat():
    with STATE.lock:
        if STATE.license.get("remaining") is not None and STATE.license["remaining"] <= 0:
            return {"ok": False, "error": "No unlocks remaining on this code."}
        for s in ("device", "dfu", "ramdisk", "activator", "verify", "burn"):
            STATE.steps[s] = {"status": "pending", "error": None}
        STATE.dfu = {"active": False, "started_at": None, "note": None}
        STATE.verify = {"state": "idle", "activation_state": None, "error": None}
        STATE.burn = {"state": "idle", "instance_name": None, "instance_id": None,
                      "usage": None, "limit": None, "error": None, "pop": False, "attempt": 0}
        STATE.last_error = None
        STATE.step = "device"
    STATE.log_line("device", "Starting the next device.")
    return {"ok": True}


def do_reset():
    with STATE.lock:
        STATE.steps = {k: {"status": "pending", "error": None} for k in STEPS}
        STATE.step = "setup"
        STATE.device = {"mode": "none", "product": None, "model": None, "ios": None,
                        "ecid": None, "udid": None, "pwnd": None, "raw": {},
                        "last_poll": None, "poll_error": None}
        STATE.dfu = {"active": False, "started_at": None, "note": None}
        STATE.license = {"key": None, "valid": False, "status": None, "limit": None,
                         "usage": None, "remaining": None, "error": None, "retryable": False}
        STATE.verify = {"state": "idle", "activation_state": None, "error": None}
        STATE.burn = {"state": "idle", "instance_name": None, "instance_id": None,
                      "usage": None, "limit": None, "error": None, "pop": False, "attempt": 0}
        STATE.last_error = None
        STATE.log.clear()
        STATE.reset_client()
    STATE.log_line("setup", "state reset")
    return {"ok": True}


# --------------------------------------------------------------------------
# Diagnostics
# --------------------------------------------------------------------------

def diagnostics_text() -> str:
    snap = STATE.snapshot()
    snap.pop("log_tail", None)
    lines = [
        "ReviveBench diagnostics",
        f"generated: {time.strftime('%Y-%m-%d %H:%M:%S')}",
        f"bench version: {VERSION}",
        f"python: {sys.version.split()[0]}  platform: {platform.platform()}",
        f"mock: {MOCK}",
        "",
        "--- state ---",
        json.dumps(snap, indent=2, default=str),
        "",
        "--- log ---",
    ]
    for r in STATE.logs_for(None):
        lines.append(f"[{time.strftime('%H:%M:%S', time.localtime(r['t']))}] "
                     f"{r['step']:<9} {r['line']}")
    return "\n".join(lines) + "\n"


def write_diagnostics() -> tuple[str, str]:
    text = diagnostics_text()
    path = os.path.join(os.path.expanduser("~"), "revivebench_diag.txt")
    try:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
    except OSError as exc:
        path = f"(could not write {path}: {exc})"
    return path, text


# --------------------------------------------------------------------------
# HTTP layer
# --------------------------------------------------------------------------

class BenchHTTPServer(ThreadingHTTPServer):
    """ThreadingHTTPServer that stays quiet about clients that hang up mid-request
    (the UI polls aggressively and PowerShell/curl reset connections on exit)."""

    daemon_threads = True

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, BrokenPipeError, TimeoutError)):
            return
        super().handle_error(request, client_address)


class Handler(BaseHTTPRequestHandler):
    server_version = "ReviveBench/1.0"
    protocol_version = "HTTP/1.1"

    # -- plumbing --------------------------------------------------------

    def log_message(self, fmt, *args):  # silence default stderr access log
        if os.environ.get("BENCH_HTTP_LOG") == "1":
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, obj, code: int = 200) -> None:
        body = json.dumps(obj, default=str).encode("utf-8")
        self._send(code, body, "application/json; charset=utf-8")

    def _read_json(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return {}
        raw = self.rfile.read(min(length, 1 << 20))
        try:
            return json.loads(raw.decode("utf-8") or "{}")
        except (ValueError, UnicodeDecodeError):
            return {}

    # -- GET -------------------------------------------------------------

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path in ("/", "/index.html"):
            return self._file("index.html")
        if path.startswith("/static/"):
            return self._file(path[len("/static/"):])
        if path == "/favicon.ico":
            return self._send(204, b"", "image/x-icon")
        if path == "/api/state":
            return self._json(STATE.snapshot())
        if path == "/api/diagnostics":
            return self._send(200, diagnostics_text().encode("utf-8"),
                              "text/plain; charset=utf-8")
        return self._json({"error": "not found"}, 404)

    def _file(self, rel: str) -> None:
        rel = rel.split("?")[0]
        full = os.path.normpath(os.path.join(STATIC_DIR, rel))
        if not full.startswith(os.path.normpath(STATIC_DIR)) or not os.path.isfile(full):
            return self._json({"error": "not found"}, 404)
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        with open(full, "rb") as fh:
            self._send(200, fh.read(), f"{ctype}; charset=utf-8"
                      if ctype.startswith(("text/", "application/javascript")) else ctype)

    # -- POST ------------------------------------------------------------

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        payload = self._read_json()
        try:
            if path == "/api/setup":
                start_step_thread(do_setup)
                return self._json({"ok": True})
            if path == "/api/license/validate":
                return self._json(do_license_validate(payload))
            if path == "/api/device/refresh":
                dev = poll_device_once()
                with STATE.lock:
                    STATE.device.update(dev)
                    if dev["mode"] != "none":
                        STATE.mark("device", "done")
                return self._json(STATE.snapshot())
            if path == "/api/dfu/start":
                do_dfu_start()
                return self._json({"ok": True})
            if path == "/api/dfu/retry":
                do_dfu_retry()
                return self._json({"ok": True})
            if path == "/api/ramdisk":
                do_ramdisk()
                return self._json({"ok": True})
            if path == "/api/activator":
                do_activator()
                return self._json({"ok": True})
            if path == "/api/verify":
                do_verify()
                return self._json({"ok": True})
            if path == "/api/burn":
                start_step_thread(do_burn, payload)
                return self._json({"ok": True})
            if path == "/api/burn/retry":
                start_step_thread(do_burn, {"proof_of_purchase": STATE.burn.get("pop")})
                return self._json({"ok": True})
            if path == "/api/repeat":
                return self._json(do_repeat())
            if path == "/api/reset":
                return self._json(do_reset())
            if path == "/api/diagnostics":
                p, text = write_diagnostics()
                return self._json({"ok": True, "path": p, "text": text[:200000]})
        except Exception as exc:
            STATE.log_line("server", f"{path} failed: {exc}", "error")
            return self._json({"ok": False, "error": str(exc)}, 500)
        return self._json({"error": "not found"}, 404)


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description="ReviveBench Bench GUI")
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--host", default=HOST)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    if MOCK:
        print("BENCH_MOCK=1 -- simulation mode (no Apple tools, no license network calls)")
    os.makedirs(STATIC_DIR, exist_ok=True)

    threading.Thread(target=device_poller, daemon=True).start()

    httpd = BenchHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    url = f"http://{args.host}:{args.port}"
    print(f"ReviveBench Bench GUI {VERSION} -> {url}")

    if OPEN_BROWSER and not args.no_browser:
        def opener():
            time.sleep(0.8)
            try:
                webbrowser.open(url)
            except Exception:
                if platform.system() == "Linux":
                    subprocess.Popen(["xdg-open", url],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        threading.Thread(target=opener, daemon=True).start()

    try:
        httpd.serve_forever(poll_interval=0.3)
    except KeyboardInterrupt:
        print("\nshutting down")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
