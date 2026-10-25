# SOURCE-OFFER.md — GPLv3 §5 written source offer

**Status: source URL published (2026-10-25). Seller contact block below is
still a placeholder and MUST be filled in before the first sale or physical
shipment.**

> This file is part of ReviveBench's compliance set (see `../PRODUCT.md` §8 and
> `../packaging/SELLER.md` §6). Ship it, unchanged except for the placeholders,
> in every distribution: installer download **and** every USB stick
> (`/THIRD_PARTY/SOURCE-OFFER.md` on the REVBENCH partition).

---

## Written offer

To any recipient of ReviveBench version 1.0 in object code form (whether
purchased as a download or delivered on physical media), including the
`payload/legacy-ios-kit/` directory and any other component licensed under the
GNU General Public License version 3:

**We offer to give you a machine-readable copy of the complete Corresponding
Source of every GPL-3.0-covered component included in this product, for a period
of three years from the date of your acquisition of the product.**

Choose either of the following:

1. **Network access (no charge).** Copy the complete Corresponding Source,
   including all scripts and configuration files used to control compilation and
   installation of the covered components, from:

   ```
   https://github.com/mikewithoutthemechanics/revivebench/releases/tag/v1.0.0
   ```

   The archive is published as `revivebench-<version>-gpl-source.tar.gz` next to
   a `SHA256SUMS` file and the matching `SOURCE-OFFER.md` (same release page,
   alongside a `.zip` of the same tree). Future versions are published the same
   way on the repository's Releases page:
   <https://github.com/mikewithoutthemechanics/revivebench/releases>

2. **Physical medium (cost only).** Request a copy on a durable physical medium
   customarily used for software interchange by contacting:

   ```
   Seller/contact:  EXAMPLE SELLER NAME           ← PLACEHOLDER
   Email:           source@example.com            ← PLACEHOLDER
   Postal:          EXAMPLE ADDRESS               ← PLACEHOLDER
   ```

   We will charge you no more than our reasonable cost of physically performing
   this conveying of source.

## Scope of this offer

Covers the Corresponding Source of every work distributed under GPL-3.0 that is
included in or shipped with this product, in particular:

| Component | Upstream | Shipped as |
|---|---|---|
| Legacy-iOS-Kit (`restore.sh`, `resources/`, `bin/`) | <https://github.com/LukeZGD/Legacy-iOS-Kit> | `payload/legacy-ios-kit/` (unmodified) |
| Any other GPL-3.0 script added to `payload/` in a future release | — | listed in `NOTICE` |

Legacy-iOS-Kit is invoked by ReviveBench as a separate program and is **not
modified** by us; its Corresponding Source is therefore the upstream tree at the
revision we shipped, which is included in our source archive (plus the upstream
repository URL above, which remains valid indefinitely).

Components licensed Apache-2.0 (`Legacy iOS Activator`) are **not** part of this
offer; their license text is in `Apache-2.0.txt` and their source is at
<https://github.com/maksimka539/legacyactivator>. ReviveBench's proprietary
`bench/`, `desktop/` and `packaging/` code is not GPL-licensed and is not
offered under this document.

## Validity

This offer is valid for three years from the date you acquire the product, and
for as long as we offer spare parts or customer support for that product model,
in accordance with GNU GPL v3 section 6(b) (and section 5 where applicable).

If the URL above ever moves, we will keep a redirect in place for at least three
years and publish the new address in the product's `THIRD_PARTY/NOTICE` file.

---

### Checklist before first sale (owner)

- [x] Replace `https://EXAMPLE.COM/revivebench/source/` with the real URL.
- [ ] Replace seller name, email, and postal address.
- [x] Publish `revivebench-1.0.0-gpl-source.tar.gz` + `SHA256SUMS` there.
- [ ] Confirm `SELLER.md` §6 and this file agree on the URL.
- [ ] Verify the file exists on the REVBENCH partition of a production stick.
