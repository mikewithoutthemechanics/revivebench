# ReviveBench — Product Specification (v1 MVP)

Working name: **ReviveBench** (single string in `branding.json`, renameable).
One-line pitch: *Desktop tool for repair shops: guides a tech through booting a
Linux stick, running the SSH-ramdisk activation-repair flow, and consuming one
prepaid license code per successful device unlock.*

## 0. Business decisions (already made by the owner — do not revisit)

| Decision | Value |
|---|---|
| Shape | Windows desktop wizard app + guided Linux live-USB stick |
| License semantics | **1 code = 1 device unlock** (burned only after verified success) |
| License backend | **Hosted key service: Lemon Squeezy License API**, behind our own adapter so it can be swapped (Paddle/Polar) later |
| Buyers | Repair shops / technicians (B2B, proof-of-purchase workflow) |
| Our code license | Proprietary (sold). Third-party: see §8 compliance |

## 1. The two halves and the hand-off

The exploit (checkm8-era SSH ramdisk + activation bypass) only runs in Linux
over a physical USB cable. Therefore:

```
WINDOWS PC (buyer)                          LINUX LIVE STICK (buyer boots it)
┌──────────────────────────┐                ┌─────────────────────────────────┐
│ ReviveBench desktop app  │                │ ReviveBench Bench GUI           │
│ 1. validate license code │  writes stick  │ (python stdlib web GUI, :8777)  │
│ 2. write product ISO  ───┼──► USB stick ──│ 5. re-enter/confirm code        │
│ 3. write payload ────────┘   (2 parts)    │ 6. guided DFU (animated timer)  │
│ 4. boot instructions                        │ 7. auto ramdisk + activator   │
└──────────────────────────┘                │ 8. verify success → BURN code   │
                                            └─────────────────────────────────┘
```

Stick layout after the Windows app finishes (16GB stick example):
- **Part 1**: hybrid Linux Mint 22.3 XFCE ISO written raw (dd-style) — unchanged proven path.
- **Part 2**: FAT32 partition in the remaining tail space, label `REVBENCH`, contains:
  ```
  /bench/            ← Bench GUI (python + static web UI), copied from app resources
  /payload/          ← Legacy-iOS-Activator2-7.tar.gz (25MB, sha256-pinned) + legacy-ios-kit bundle
  /AUTORUN.txt       ← plain "Open bench/index.html launcher" instructions (fallback)
  /start-bench.sh    ← chmod +x; runs: python3 /path/to/bench/bench_gui.py
  ```
  Mint auto-mounts it under `/media/mint/REVBENCH/`. The GUI is launched by
  double-clicking `start-bench.sh` (Files → right-click → Run in terminal is
  acceptable fallback; document both). v2 (not this MVP) remasters the ISO for autostart.

## 2. Windows app (`desktop/`) — Electron

Stack: Electron ≥33, plain HTML/CSS/JS renderer (no React — keep bundle small),
electron-builder → NSIS installer + portable exe. Node 24 + npm are installed
on the dev machine. No rust, no WSL needed.

### Screens (wizard, one step per screen, always-visible back nav)
1. **Welcome** — branding, "Repair-shop license tool", requirements list
   (8GB+ USB stick, internet, supported device). Link to supported-device matrix.
2. **License** — code input. Calls Lemon Squeezy `POST https://api.lemonsqueezy.com/v1/licenses/validate`
   with `license_key`. Fail-closed UX: invalid/`disabled`/`expired` or
   `activation_usage >= activation_limit` → red state, stop. Valid → green,
   show "unlocks remaining: N". **Do NOT activate here.**
3. **ISO select** — app first looks for `ReviveBench.iso` next to the exe/install
   dir; else file picker. Verify SHA256 against pinned hash in `branding.json`
   (warn-only if seller replaced ISO: show computed hash + expected, require typing CONFIRM).
4. **USB** — list candidate disks (PnP/`Get-Disk`, BusType=USB, size ≥ 6GB,
   **never list BusType != USB**), show size+model, typed confirmation, then elevate.
5. **Write** — elevated `scripts/write_stick.ps1` (see §3), progress %, log tail.
6. **Done** — "Reboot → spam F12 → boot UEFI: stick → Start Linux Mint →
   open REVBENCH → Start Bench" + link to TECHNICIAN.md steps. Includes the
   Secure-Boot-disabled fallback text (F2 BIOS → Secure Boot off).

### Elevation pattern (proven on this machine)
```powershell
Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',$script,'-IsoPath',$iso,'-DiskNumber',$n -Wait -PassThru
```
User approves UAC once. Script appends to `$env:TEMP\revivebench_write_log.txt`;
app tails that file for progress. Dev machine's PowerShell lacks `Get-FileHash`
→ use `certutil -hashfile <f> SHA256` everywhere.

### `scripts/write_stick.ps1` (adapt from the proven, already-run writer at
`C:\Users\micha\write_usb.ps1` — READ IT FIRST; keep its guards)
Guards, all aborting pre-touch: iso exists → certutil hash check →
`Get-Disk` target must be BusType USB + size ≥ iso size → `diskpart clean`
only that disk → raw write via `\\.\PhysicalDriveN` FileStream (1MB buffer,
`Flush($true)`) → byte-count equality → **then** (NEW, this MVP) `diskpart`:
`create partition primary` in the free tail → `format fs=fat32 quick label=REVBENCH`
→ `assign` → `robocopy <resources>\bench <new>:\bench /E` + `robocopy <resources>\payload <new>:\payload /E` → rescan → partition report.
Guards stay: refuse if BusType≠USB, refuse Disk 0, refuse size mismatch.

## 3. Linux Bench GUI (`bench/`) — python3 stdlib ONLY (no pip in live session)

Single file server `bench_gui.py` (http.server + ThreadingHTTPServer),
binds `127.0.0.1:8777`, auto-opens `http://127.0.0.1:8777` via `webbrowser`
(xdg-open). State machine with a `/api/state` polling endpoint + command
endpoints; server streams subprocess output into per-step buffers the UI polls.
The UI (`static/index.html` + `app.js` + `style.css`) is one-page, big-type,
shop-friendly (dark theme, large progress states). **No framework.**

### Steps (linear, each re-entrant if a step fails)
1. **Setup check** — `sudo apt-get install -y git curl libimobiledevice-utils
   libirecovery-utils usbmuxd libplist3 python3 unzip` (stream output; already
   present after seller's base setup — idempotent), then ensure
   `legacy-ios-kit/` exists: `git clone --filter=blob:none https://github.com/LukeZGD/Legacy-iOS-Kit`
   (or copy from `/payload/` if we bundle it). UI button "Prepare tools".
2. **License** — code entry → LS `validate` (same as Windows). Show remaining.
3. **Device detect** — poll `idevice_id -l` (normal mode) and `irecovery -q`
   (DFU/recovery). Show detected state: "connected, iOS 9.3.5, iPad2,5" or
   "in DFU" or "nothing connected". Poll loop, 1s cadence, big status card.
4. **DFU guide** — animated timeline: t=0 hold Power+Home → countdown 10s →
   release Power, keep Home → countdown 5s → screen must be BLACK = DFU ✓.
   Driven by live polling: as soon as `irecovery -q` reports DFU mode, jump to
   "DFU detected ✓" automatically. If recovery-mode (cable/iTunes logo) is
   detected instead, show "That's recovery mode — redo" with one-tap retry.
   Help text: direct USB-A port, no hub/USB-C dock (LIK's own advice).
5. **Ramdisk boot** — run from the LIK clone dir:
   `./restore.sh --sshrd` (flag confirmed present in restore.sh usage;
   LIK detects device and proceeds; may internally call DFU helper first —
   if `--sshrd` alone isn't sufficient, retry logic: `--dfuhelper` first, then `--sshrd`).
   Stream combined stdout/stderr into the UI log panel. Expected 2–4 min.
   LIK needs internet (downloads firmware components) — surface network errors clearly.
6. **Activator** — payload tarball sha256 `97ac871064c944845816d004a5aebe340670dd48545cd15733bf13d59ceed783`
   (filename `Legacy-iOS-Activator2-7.tar.gz`; extract → single binary `Legacy iOS Activator`,
   ELF x86_64 PyInstaller, bundles its own linux_x86_64/{irecovery,ideviceenterrecovery,sshpass}).
   **Builder must first INSPECT it** (we have it at `C:\Users\micha\legacyactivator\`):
   determine non-interactive invocation — it uses argparse (string present);
   find argv flags (e.g. port/ssh choice). If it's menu-only (`input()`), drive it
   via `Popen(stdin=PIPE)` writing the menu answer + "\n" (the choice is DFU/SSH **port 6414**
   per project docs). Never hardcode guesses — verify against the binary/repo README
   (`maksimka539/legacyactivator`, Apache-2.0).
   iOS 9 quirk: if data partition won't mount, note `fsck_hfs -f /dev/disk0s1s2`.
7. **Verify success** — poll lockdown: `ideviceinfo -k ActivationState` (or
   `ideviceactivation state`) until value != `Unactivated` AND device left
   DFU/recovery (normal boot). Timeout 120s. **Only then → step 8.**
8. **BURN license** — `POST /v1/licenses/activate` with `license_key` and
   `instance_name = "RB-" + ECID/serial + "-" + YYYYMMDD`. This is the audit
   trail (visible in LS dashboard). Response `activation_usage++` → success
   screen: "Unlock complete — 1 code consumed (usage N/LIMIT)" + checkbox
   "Customer ownership verified (invoice/receipt on file)" (attestation, stored
   only in the activation instance name via suffix `-PoP1`).
   If activation hits the limit → red "code already consumed" (fail-closed; the
   unlock already happened — support/refund path, documented for seller).
9. **Repeat** — "Unlock another device" (only if remaining > 0).

### LS API facts (as of 2026 — adapter lives in `bench/license_adapter.py`
and `desktop/license.js`; one config for base URL/endpoints)
- `POST https://api.lemonsqueezy.com/v1/licenses/validate` `license_key=...`
- `POST https://api.lemonsqueezy.com/v1/licenses/activate` `license_key=...&instance_name=...`
- `POST https://api.lemonsqueezy.com/v1/licenses/deactivate` `license_key=...&instance_id=...`
- Responses include `license_key.{status,activation_limit,activation_usage}`; statuses:
  inactive/active/expired/disabled. Rate limit **60 req/min** — client-side
  throttle + friendly retry. No offline/signed mode → **internet required** at step 2 and 8.
- Lemon Squeezy is alive but winding toward Stripe Managed Payments (Jan 2026
  update, no shutdown date) → adapter must make a future swap a 1-file change.

## 4. What we deliberately do NOT automate
- Physical DFU button timing (human; we animate + poll).
- The seller's storefront, refunds, and buyer vetting (documented in SELLER.md).

## 5. Supported-device matrix (v1 honest scope)
Proven in the field: **iPad mini 1 (iPad2,5), iOS 9.3.5** (the dev unit).
Likely-working family per upstream docs: 32-bit iOS 5.0–10.3.4 devices
(legacyactivator scope; 64-bit "untested" per its README). NOT supported:
iOS 11+ (palera1n/checkm8 path is a different product), passcode-locked
iCloud states the tool explicitly can't clear (README says bypass of activation
*screen*, not iCloud removal — SELLER.md must state this to avoid mis-selling).
v1 ships the matrix as a table the UI checks before DFU (ProductType via
ideviceinfo when reachable; otherwise warn-only).

## 6. Failure/edge behavior
- All subprocess calls: timeout + captured stderr surfaced in UI log panel + "Copy diagnostics" button (writes `~/revivebench_diag.txt`).
- License network down at burn time → the unlock DID succeed; UI must say
  "unlock succeeded but license could not be recorded — do not unplug; retry
  burn" with a Retry-burn button (state kept until process restarts).
- Stick read-only/ISO corrupt → Windows side catches pre-boot (hash), bench side re-verifies payload tarball sha before running.
- Never write to disk 0; Windows writer re-verifies BusType=USB at execution time (not just at listing).

## 7. Repo layout (git init at `C:\Users\micha\revivebench`)
```
PRODUCT.md                 (this file — source of truth)
branding.json              name, iso sha256 pin, ls endpoint overrides, support url
desktop/                   Electron app (Agent A)
  package.json  main.js  preload.js  renderer/{index.html,app.js,style.css}
  scripts/write_stick.ps1  license.js
  resources/bench/…  resources/payload/…   (copied at build time)
bench/                     Linux-side (Agent B)
  bench_gui.py  static/{index.html,app.js,style.css}  license_adapter.py
packaging/
  iso/build_iso.sh         (v2 optional remaster — stub + docs only for v1)
  SELLER.md  TECHNICIAN.md
THIRD_PARTY/               GPL-3.0.txt (Legacy-iOS-Kit), Apache-2.0.txt (activator),
                           NOTICE (attribution list) + SOURCE-OFFER.md (GPL §5 offer URL placeholder)
research/restore.sh        (517KB official LIK script — read-only reference)
```

## 8. Compliance (owner's obligations — encode where possible)
- Legacy-iOS-Kit is **GPL-3.0**: we aggregate (invoke it as a separate program,
  unmodified) → our proprietary GUI is fine; still ship GPL text + a
  **source-offer** for any bundled/modified GPL scripts (`SOURCE-OFFER.md`).
- Activator is **Apache-2.0**: ship license + NOTICE, keep headers.
- Store listing must **honestly describe** the tool (activation repair for
  shops with verified ownership) — no disguising what it does.
- PoP attestation checkbox at burn time = audit artifact (instance name).

## 9. Dev-machine facts (this Windows 11 box, non-elevated shell)
- PowerShell lacks `Get-FileHash` (use certutil); `python -c` quoting mangles → write .py files.
- Elevation: Start-Process -Verb RunAs (owner clicks UAC).
- runtimes: Node v24.19, npm 11.17, Python 3.14; no rust/docker/WSL.
- Assets: ISO `C:\Users\micha\Downloads\linuxmint-22.3-xfce-64bit.iso`
  sha256 `45a835b5dddaf40e84d776549e0b19b3fbd49673b6cc6434ebddbfcd217df776`;
  activator tarball `C:\Users\micha\legacyactivator\Legacy-iOS-Activator2-7.tar.gz`
  (sha above); extracted binary `C:\Users\micha\legacyactivator\extracted\Legacy iOS Activator`;
  proven writer `C:\Users\micha\write_usb.ps1`; wipe script `C:\Users\micha\wipe_usb.ps1`.
- The owner's personal stick currently boots stock Mint for their own iPad job —
  do NOT overwrite it during development; test against a spare stick if one appears,
  otherwise unit-test the writer logic with guards dry-run flag `-WhatIf` (add it).
