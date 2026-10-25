# ReviveBench — `resources/bench/`

This directory is **copied verbatim to the REVBENCH partition root as `/bench/`**
by `desktop/scripts/write_stick.ps1` (robocopy `/E`).

Contract expected by the writer and by `start-bench.sh` (which the writer writes at
the partition root):

```
bench/bench_gui.py        ← entry point; started as: python3 <mount>/bench/bench_gui.py
bench/static/index.html   ← bench web UI (served on http://127.0.0.1:8777)
bench/static/app.js
bench/static/style.css
bench/license_adapter.py  ← Lemon Squeezy adapter (mirrors desktop/license.js)
```

Notes for whoever fills this in:

- Everything must run with **python3 stdlib only** — no pip at runtime, no wheels,
  no compiled extensions (Linux live session, spec §3).
- `bench_gui.py` must bind `127.0.0.1:8777` and auto-open the browser itself.
- The writer aborts if this directory is empty, so at minimum keep a placeholder
  file here until the real GUI lands.
- Do not add files outside `resources/bench/` — the writer only copies this tree
  to `/bench/`.

## Contents are synced, not edited here

The real files come from the repo's `bench/` directory (Linux-bench agent).
`scripts/sync_bench.ps1` copies them in, and both pack scripts run it first
(PRODUCT.md: `desktop/resources/bench/...  (copied at build time)`):

```
npm run sync:bench     # manual copy
npm run pack:win       # sync + electron-builder --win
npm run pack:dir       # sync + electron-builder --dir
```

So **this folder is a build artifact** — edit `bench/`, not here. The sync only
takes `*.py` / `*.html` / `*.js` / `*.css` / `*.json` / `*.txt` / `*.md`, skips
`__pycache__`, `*.pyc`, `node_modules` and `.git`, and leaves this README alone.
A missing `bench/` directory is a warning (the desktop half can still be
packaged); pass `-Required` to turn it into a hard failure.

