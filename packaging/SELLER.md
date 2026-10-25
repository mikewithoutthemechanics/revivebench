# ReviveBench — Seller Guide

Audience: the person who sells ReviveBench and owns the storefront, the Lemon
Squeezy store, refunds, and buyer vetting. (The technician-facing runbook is
[`TECHNICIAN.md`](TECHNICIAN.md).)

---

## 1. What you are selling (say this plainly)

ReviveBench is a **repair-shop tool for legacy iOS activation repair**. It boots
a Linux live USB stick and guides a technician through the SSH-ramdisk flow that
restores a supported device to a *usable, activated* state.

**Honest one-liner for the storefront:**

> Guided Linux bench tool for repair shops: walks a technician through
> DFU → SSH-ramdisk → activation repair on supported 32-bit iOS devices, one
> prepaid license code per successfully unlocked device.

### What it does
- Removes the **activation setup screen** so the device boots to a usable home
  screen after a repair (activation-state repair over SSH ramdisk).
- Guides DFU timing with an animated timer and live cable detection.
- Verifies the result programmatically (`ActivationState != Unactivated`)
  before it consumes a license code.

### What it does NOT do — state this in every listing
- **It does not remove an iCloud/Activation Lock account** and does not make a
  device *yours*. It repairs the activation state on hardware the customer
  owns; it does not defeat ownership checks. (Upstream activator README says
  the same: bypass of the activation *screen*, not iCloud removal.)
- No signal/baseband repair, no passcode removal, no iOS 11+ support.
- It cannot fix passcode-locked or "iPhone Locked to Owner" states.

Anything beyond the above in a listing = mis-sale. Keep the wording identical
across storefront, PDF quick-start, and support macros.

---

## 2. Supported-device matrix (ship this table verbatim)

| Status | Device / iOS | Notes |
|---|---|---|
| ✅ Proven | **iPad mini 1 (iPad2,5), iOS 9.3.5** | dev unit, full flow verified |
| Likely | 32-bit iOS 5.0–10.3.4 (A4/A5 family) | per upstream docs; not all models tested by us |
| Untested | 64-bit devices | upstream calls these "untested" |
| ❌ Not supported | iOS 11+ (checkm8/palera1n generation) | different product entirely |
| ❌ Not supported | Passcode-locked / "Locked to Owner" states | tool cannot clear these |

Pre-listing rule: **if the buyer's exact model+iOS is not in the table, do not
promise it works.** "Likely" = buyer's risk, say so.

---

## 3. License semantics (1 code = 1 device)

- A code is **validated** on the Windows app and again on the bench — never
  activated early.
- A code is **burned only after the bench verifies the unlock**
  (`ActivationState != Unactivated`). Instance name in the Lemon Squeezy
  dashboard: `RB-<ECID>-<YYYYMMDD>`, plus `-PoP1` when the technician checked
  the proof-of-ownership box.
- The dashboard's `activation_usage / activation_limit` is your audit trail:
  who unlocked what, on which ECID, on which day, with attestation or not.
- Codes are a **consumable**: unlocking device A then device B takes two codes.
- Lemon Squeezy rate limit is **60 requests/minute**. A shop hammering the API
  (multiple benches, one code per machine) will see friendly "rate limited"
  errors in the bench — tell them to wait a few seconds and press Retry.

### Store configuration checklist
- [ ] Product is a **license-key** product (LS generates keys at purchase).
- [ ] Activation limit set to **1** (or the number of unlocks per code you sell).
- [ ] License status = active; no expiry unless intentionally sold that way.
- [ ] Refund window shorter than your "burn" expectations — see §5.
- [ ] Storefront description includes §1's "does NOT" paragraph.

---

## 4. Delivery

1. Buyer purchases → LS emails the code.
2. Buyer downloads the Windows app + `ReviveBench.iso` (or receives the
   pre-imaged stick).
3. Windows app writes the stick: part 1 = raw Mint ISO, part 2 = FAT32
   `REVBENCH` partition containing `/bench`, `/payload`, `/start-bench.sh`.
4. Buyer boots the stick, runs `start-bench.sh`, enters the code, unlocks.

If you sell physical sticks: image them with the app's writer (never `diskpart`
by hand), then run one dry validation: boot → `sha256sum
/media/mint/REVBENCH/payload/Legacy-iOS-Activator2-7.tar.gz` must equal
`97ac871064c944845816d004a5aebe340670dd48545cd15733bf13d59ceed783`.

---

## 5. Refunds & support paths

| Situation | What happened | Action |
|---|---|---|
| Network down at burn time | Unlock **succeeded**, code **not** consumed | Bench shows "Retry burn" — tell them not to unplug. If they restart the bench anyway: unlock happened, code not burned → refund or re-issue is a business call, no technical fix needed. |
| Code hits activation limit | Unlock succeeded, code already fully used | Fail-closed red screen. This is the "sold more unlocks than the code has" case → refund/upsell. |
| Unlock failed mid-flow | Code **not** burned | Nothing to reverse. Troubleshoot via `TECHNICIAN.md`. |
| Buyer wants a refund after a successful unlock | Code burned | Your policy; LS lets you deactivate an instance (`instance_id` from the dashboard) to return one activation. |
| Corrupt stick / tarball hash mismatch | Bench refuses to run the activator | Re-image the stick; do not tell them to "skip the check". |

The bench writes diagnostics to `~/revivebench_diag.txt` — ask for that file
first in every support ticket. It contains state, tool output, and the license
error, and no customer personal data beyond device identifiers.

---

## 6. Compliance obligations (yours, not optional)

Encoded in `THIRD_PARTY/`:

- **Legacy-iOS-Kit is GPL-3.0.** We invoke it as a separate, unmodified
  program, so our proprietary GUI is fine — but every distribution (download
  and physical stick) must carry `THIRD_PARTY/GPL-3.0.txt` and
  `THIRD_PARTY/SOURCE-OFFER.md` (the GPLv3 §5 written offer for the bundled
  GPL scripts). The offer URL in `SOURCE-OFFER.md` is a placeholder: **replace
  it with a real, persistent URL before the first sale.**
- **Activator is Apache-2.0.** Ship `THIRD_PARTY/Apache-2.0.txt` and
  `THIRD_PARTY/NOTICE`, keep the attribution intact.
- **Store listing must honestly describe the tool** (§1). No euphemisms that
  hide what the tool does, and no claims it cannot back (no iCloud removal).
- The PoP checkbox is the audit artifact: it only writes `-PoP1` into the
  activation instance name. It stores no customer identity.

---

## 7. Support macros (copy/paste)

**"The unlock worked but says the code wasn't recorded."**
> The unlock did succeed on your device — do not unplug anything. The bench is
> waiting to record the code and has kept the record. Press **Retry burn** once
> your internet is stable. If the bench was closed, reply with your order
> number and we'll sort out the code.

**"My code says already consumed."**
> A code covers one unlock. Check the dashboard line
> `RB-<ECID>-<date>` — if it isn't your device, send us the ECID shown on the
> bench screen and your order number.

**"Will it unlock an iPhone 8 / iOS 12?"**
> No. ReviveBench v1 covers 32-bit iOS 5.0–10.3.4 devices; iOS 11+ is a
> different toolchain we don't ship. See the supported-device table on the
> product page.

**"Can I use it to remove an iCloud account?"**
> No. It repairs the activation state on hardware your customer owns; it does
> not remove iCloud accounts or activation locks.
