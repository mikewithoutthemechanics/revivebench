# ReviveBench — Technician Runbook

Audience: the repair-shop technician at the bench. Follow the steps in order.
Everything happens on the Linux stick; the Windows PC is only used to write the
stick and to read this file.

---

## 0. Before you start

- [ ] Supported device (see the matrix in [`SELLER.md`](SELLER.md)) — **iPad
      mini 1 / iPad2,5 on iOS 9.3.5 is the proven combo.**
- [ ] Device is charged (>30%), **passcode off / screen unlocked if it boots**.
- [ ] The shop PC has **internet** (needed at license check and at the burn).
- [ ] Use a **direct USB-A port** — no hubs, docks, USB-C adapters.
- [ ] A5 devices (iPad 2/3, iPhone 4S, iPod touch 5) additionally need the
      device to reach **pwned DFU** (`checkm8-a5` hardware: Raspberry Pi Pico or
      Arduino + USB host shield). The bench will tell you if it isn't pwned.
- [ ] One **license code** per device you intend to unlock.

---

## 1. Boot the bench

1. Plug the stick in, power on, spam **F12** (or F2 → BIOS → Secure Boot **off**
   if the stick doesn't appear in UEFI).
2. Pick **UEFI: your stick** → **Start Linux Mint**.
3. Mint auto-mounts the data partition at `/media/mint/REVBENCH/`.
4. Open Files → `REVBENCH` → right-click `start-bench.sh` → **Run in terminal**
   (double-click works if the terminal prompt appears; if neither works, open a
   terminal and run `bash /media/mint/REVBENCH/start-bench.sh`).
5. The GUI opens automatically at `http://127.0.0.1:8777` (browser should pop;
   otherwise open that address by hand).

The bench shows **8 step cards** on the left and a **live log** on the right.
A yellow **SIMULATION MODE** badge means `BENCH_MOCK=1` — nothing real runs.

---

## 2. Step by step

### Step 1 — Prepare tools
Press **Prepare tools**. Installs the Apple USB utilities (`apt`) and makes
sure `legacy-ios-kit/` is present (cloned from GitHub or copied from
`/payload/`). Idempotent — press it any time. Green "Tools ready" = move on.

### Step 2 — License code
Type the code → **Check code**. You'll see **unlocks remaining**.
- ❌ red = invalid / disabled / expired / no unlocks left → stop, contact seller.
- ✅ green → **the code is not consumed yet**; it burns only in step 8.

### Step 3 — Device detection
Plug the device in (screen on, unlocked, if it boots). The card updates every
second:
- `iPad2,5 — connected` → normal mode, go to step 4.
- `DFU mode ✓` → already in DFU, skip to step 5.
- `Nothing connected` → try another USB-A port, no hub.

### Step 4 — DFU mode
Press **Start DFU guide** and follow the timeline:

| Phase | You do | Timer |
|---|---|---|
| 1 | Hold **Power + Home** together | **10 s** |
| 2 | Release **Power**, keep holding **Home** | **5 s** |
| 3 | Keep holding **Home** until the screen is black | detection is automatic |

- The moment the cable reports DFU the card flips to **DFU detected ✓** by
  itself — you don't press anything.
- If you see the cable/iTunes logo → that's **recovery**, not DFU. Red
  **Redo the sequence** button, force-restart, try again.
- Timing tips: start from the device powered on; count on the on-screen timer,
  not your head; if it lands in recovery, hold **Power+Home 10 s** to force it
  off first.

### Step 5 — Boot the SSH ramdisk
Press **Boot ramdisk**. Runs `restore.sh --sshrd` and streams its output.
Typical runtime **2–4 minutes** (downloads firmware on first run — internet
required). Watch for:
- `[Log] Device should now boot to SSH ramdisk mode.` → success (the bench
  stops the script there on purpose; the script's own menu is not used).
- `NOT IN PWNED DFU` / checkm8-a5 text → A5 device isn't pwned yet. Pwn it with
  your checkm8-a5 hardware, re-enter DFU, retry.
- Network/download errors → fix internet, press the button again. Re-runnable.

### Step 6 — Run activator
Press **Run activator**. The bench first checks the payload tarball's SHA256
(pinned) and refuses to run a corrupt copy, then extracts and drives the
activator, answering its prompts (port **6414**). Watch the log for
`[+] activation bypass complete`.

> iOS 9 quirk: if the data partition won't mount afterwards, run
> `fsck_hfs -f /dev/disk0s1s2` on the device (via the ramdisk SSH) and retry.

### Step 7 — Verify unlock
Press **Check unlock**. Polls `ActivationState` for up to **120 s** while the
device boots normally. Green `Activated ✓` is required before the code can be
burned. Timeout → device rebooted wrong or wasn't actually unlocked: go back to
step 5/6 (the code has **not** been consumed).

### Step 8 — Consume license code
1. Tick **Customer ownership verified (invoice/receipt on file)** if you have
   the proof — it writes `-PoP1` into the audit record (no personal data).
2. Press **Burn 1 code**. You'll see the exact instance name:
   `RB-<ECID>-<YYYYMMDD>[-PoP1]`.
3. Success: *Unlock complete — 1 code consumed (usage N/LIMIT)*.

**Network died during the burn?** The unlock itself succeeded and the bench
keeps the record. Red box says *do NOT unplug* → fix internet → **Retry burn**.
Restarting the bench loses that pending record — only do it with support.

### Repeat
**Unlock another device** appears when codes remain. Detection restarts; the
same code stays validated.

---

## 3. Troubleshooting

| Symptom | Fix |
|---|---|
| Stick doesn't appear in boot menu | F2 BIOS → **Secure Boot off**, enable legacy/USB boot, try another port (USB-A, not hub). |
| `Nothing connected` in step 3 | Direct USB-A port; different cable; `lsusb` should show Apple/Vendor ID. |
| DFU never detected | Full 10 s hold, then 5 s. Start from powered-on. Avoid USB-C docks entirely. |
| Recovery detected | Redo sequence; force-restart (Power+Home 10 s) first. |
| `restore.sh` stalls on a question | Check the live log — a prompt is usually "press Enter"; the bench feeds Enter automatically, so a stall usually means a stale `tmp/` folder in the LIK dir (the bench clears those) or an unsupported mode. |
| `A5 device NOT in PWNED DFU` | Use checkm8-a5 hardware (Pico/Arduino), or use kDFU from a jailbroken device. |
| Activator exits non-zero | Re-run step 6; if SHA mismatch → re-image the stick; if it still fails, capture diagnostics. |
| Data partition won't mount (iOS 9) | `fsck_hfs -f /dev/disk0s1s2` then retry. |
| Burn fails with "rate limited" | Wait ~10 s, press **Retry burn** (60 requests/min limit). |
| Something is just weird | Press **Copy diagnostics** → sends `~/revivebench_diag.txt`. |

---

## 4. Safety rules

- **Never** power-cycle or unplug during steps 5–8 unless the bench says so.
- **Never** run the activator from a modified payload — the SHA256 gate exists
  for a reason; a mismatch means re-image the stick.
- The bench binds only to `127.0.0.1:8777` (this machine). Don't expose it.
- One bench instance at a time (Legacy-iOS-Kit does not support parallel runs).
- Keep the Windows PC out of the loop during the unlock: no sleeps, no
  disconnects.
