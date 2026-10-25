# ReviveBench — `resources/payload/`

This directory is **copied verbatim to the REVBENCH partition root as `/payload/`**
by `desktop/scripts/write_stick.ps1` (robocopy `/E`).

Layout contract (spec §1):

```
payload/Legacy-iOS-Activator2-7.tar.gz   ← sha256-pinned, see below
payload/legacy-ios-kit/…                 ← optional bundled Legacy-iOS-Kit clone
                                            (otherwise the bench git-clones it at runtime)
```

Pinned hashes (checked by the writer before the write, and re-checked on the
stick after the copy):

| file | sha256 |
|---|---|
| `Legacy-iOS-Activator2-7.tar.gz` | `97ac871064c944845816d004a5aebe340670dd48545cd15733bf13d59ceed783` |

The tarball shipped here is a byte-for-byte copy of
`C:\Users\micha\legacyactivator\Legacy-iOS-Activator2-7.tar.gz` (25,408,871 bytes,
verified with `certutil -hashfile … SHA256` at build time).

Also written at the partition root by the writer (NOT stored in this folder):

- `AUTORUN.txt` — plain-text boot/run instructions
- `start-bench.sh` — `python3 <mount>/bench/bench_gui.py`

Rules for additions:

- Nothing here may require network access to *install*; the bench verifies the
  pinned tarball sha256 before running it (spec §6).
- Keep files under the FAT32 limits: no filenames with `: * ? " < > |`,
  keep individual files < 4 GB.
- The writer aborts if this folder is empty or if the pinned tarball is missing
  or has the wrong hash (override exists only for development: `-SkipPayloadHash`).

Placeholder folder — the legacy-ios-kit bundle and any extra payload are added by
the Linux-bench agent.
