#!/usr/bin/env bash
# ReviveBench — build_iso.sh
#
# STATUS: STUB. v1 ships the stick as two partitions written by the Windows app
# (raw Mint ISO + FAT32 REVBENCH tail, see desktop/scripts/write_stick.ps1).
# This script is the v2 path: remaster the Mint ISO so the bench GUI autostarts
# after boot. It deliberately does NOT produce an ISO yet — it prints the exact
# xorriso recipe below so the v2 implementer does not have to rediscover it.
#
# -----------------------------------------------------------------------------
# v2 REMASTER RECIPE (Linux host, xorriso >= 1.5)
# -----------------------------------------------------------------------------
#   1. Extract the upstream ISO preserving bootability:
#        xorriso -osirrox on -indev linuxmint-22.3-xfce-64bit.iso -extract / iso_root
#        chmod -R u+w iso_root
#
#      Why -osirrox: it copies the El Torito boot image, grubcfg and EFI/ESP
#      blobs byte-for-byte, which plain 7z/unsquashfs extraction does not.
#
#   2. Copy the bench + payload into the live filesystem root:
#        cp -a bench/        iso_root/casper/revivebench/bench/
#        cp -a payload/      iso_root/casper/revivebench/payload/
#        cp -a THIRD_PARTY/  iso_root/casper/revivebench/THIRD_PARTY/
#
#      Mint 22 boots from /casper; the squashfs is read-only, so the bench dir
#      must be copied to a tmpfs overlay at boot (step 3) before python runs.
#
#   3. Autostart: drop a systemd unit + xdg autostart entry, e.g.
#        iso_root/etc/systemd/system/revivebench.service   (WantedBy=multi-user)
#        iso_root/etc/xdg/autostart/revivebench.desktop    (XFCE session)
#      Both must run as the live user (mint), never root:
#        ExecStart=/usr/bin/python3 /usr/bin/revivebench-copy/bench/bench_gui.py
#      with WorkingDirectory set to a writable copy:
#        ExecStartPre=/bin/bash -c 'cp -a /casper/revivebench /tmp/revivebench && \
#                                    chmod -R u+w /tmp/revivebench'
#      (restore.sh creates tmp*/ dirs next to itself, so it needs a writable dir.)
#
#   4. Rebuild the ISO with the ORIGINAL boot options:
#        xorriso -as mkisofs \
#          -r -J -joliet-long -l -cache-inodes \
#          -iso-level 3 \
#          -isohybrid-mbr /usr/lib/ISOLINUX/isohdpfx.bin \   # BIOS hybrid
#          -partition_offset 16 \
#          -A "ReviveBench Mint 22.3 remaster" \
#          -b isolinux.bin -c isolinux.cat -no-emul-boot -boot-load-size 4 \
#            -boot-info-table \
#          -eltorito-alt-boot -e --interval:appended_partition_2:all:: \
#            -no-emul-boot \                                  # EFI (UEFI)
#          -append_partition 2 0xef /path/to/efiboot.img \
#          -output ReviveBench.iso \
#          iso_root
#
#      BIOS bits come from the extracted tree (isolinux.bin / isolinux.cat);
#      EFI is reattached with -eltorito-alt-boot + -append_partition 2 so the
#      stick still boots UEFI and legacy BIOS. Keep -isohybrid-mbr so dd-style
#      raw writes (our Windows writer) stay bootable.
#
#   5. Verify before shipping:
#        xorriso -indev ReviveBench.iso -report_el_torito plain \
#                -report_el_torito platform any -report_system_area plain
#        sha256sum ReviveBench.iso        # pin into branding.json
#      Then boot-test on real hardware: F12 → UEFI: stick → Mint → bench
#      autostarts on 127.0.0.1:8777.
#
#   6. Pin the payload tarball hash in the ISO build too:
#        sha256sum payload/Legacy-iOS-Activator2-7.tar.gz
#        # expect 97ac871064c944845816d004a5aebe340670dd48545cd15733bf13d59ceed783
#
# -----------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "$0")"

ISO_IN="${1:-}"
OUT="${2:-ReviveBench.iso}"

echo "ReviveBench build_iso.sh (v2 remaster) — STUB, no ISO is produced in v1."
echo
echo "Inputs seen:"
echo "  source ISO : ${ISO_IN:-<none given>}"
echo "  output     : ${OUT}"
echo "  repo root  : $(cd ../.. && pwd)"
echo
echo "v1 ships instead:"
echo "  * part 1 = raw upstream Mint ISO (dd'd by desktop/scripts/write_stick.ps1)"
echo "  * part 2 = FAT32 'REVBENCH' tail with /bench, /payload, /start-bench.sh"
echo
echo "To implement v2, follow the xorriso recipe embedded in this file's header."
echo "Deliberately exiting non-zero so CI cannot mistake this for a real build."

exit 1
