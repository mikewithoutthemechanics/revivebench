'use strict';
/**
 * ReviveBench wizard renderer (plain JS, no framework).
 *
 * Screens: 1 Welcome -> 2 License -> 3 ISO -> 4 USB -> 5 Write -> 6 Done.
 * Navigation is gated by `canProceed()`; Back is always available (except while
 * a write is running). Every async call resolves into an explicit UI state:
 * loading / ok / error — never a silent happy path.
 */

const $ = (id) => document.getElementById(id);

const state = {
  step: 1,
  maxStep: 1,
  branding: null,
  license: { pending: false, ok: null, message: '', remaining: null, limit: null, usage: null, status: null },
  iso: {
    path: null, size: null, hash: null, expected: null,
    hashOk: null, checking: false, error: null, confirmText: '', auto: false
  },
  disks: { loading: false, list: [], error: null },
  diskNumber: null,
  usbConfirm: '',
  dryRun: false,
  write: {
    running: false, done: false, ok: false, pct: 0, phase: 'Waiting to start…',
    lines: [], error: null, reason: null, started: false, dryRun: false
  }
};

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function fmtBytes(n) {
  if (!n && n !== 0) return '';
  const gb = n / 1073741824;
  if (gb >= 1) return gb.toFixed(gb >= 10 ? 0 : 1) + ' GB';
  return Math.round(n / 1048576) + ' MB';
}

function shortHash(h) {
  return h ? h.slice(0, 16) + '…' + h.slice(-8) : '—';
}

let toastTimer = null;
let logFollow = true; // auto-scroll the writer log unless the user scrolled up
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

/* ------------------------------------------------------------------ */
/* navigation                                                          */
/* ------------------------------------------------------------------ */

function goto(n, opts) {
  const force = opts && opts.force;
  n = Math.max(1, Math.min(6, Number(n) || 1));
  if (!force && n > state.step && !canProceed(state.step)) return false;

  state.step = n;
  state.maxStep = Math.max(state.maxStep, n);

  for (const sec of document.querySelectorAll('section.step')) {
    sec.hidden = Number(sec.dataset.step) !== n;
  }

  const heading = document.querySelector('section.step:not([hidden]) h1');
  if (heading) heading.focus({ preventScroll: true });
  $('main').scrollTop = 0;

  onEnterStep(n);
  render();
  return true;
}

function onEnterStep(n) {
  if (n === 3 && !state.iso.path && !state.iso.checking) detectIso();
  if (n === 4 && !state.disks.list.length && !state.disks.loading) refreshDisks();
}

function canProceed(step) {
  switch (step) {
    case 1: return true;
    case 2: return state.license.ok === true;
    case 3:
      if (!state.iso.path || state.iso.checking) return false;
      if (state.iso.error) return false;
      if (state.iso.hashOk === false) return state.iso.confirmText.trim().toUpperCase() === 'CONFIRM';
      return true;
    case 4: {
      if (state.diskNumber === null) return false;
      return state.usbConfirm.trim().toUpperCase() === ('ERASE-' + state.diskNumber);
    }
    case 5: return state.write.done && state.write.ok;
    case 6: return false;
    default: return false;
  }
}

function hintFor(step) {
  if (step === 2 && state.license.ok !== true) return 'Enter and check a license code to continue.';
  if (step === 3 && state.iso.checking) return 'Verifying checksum…';
  if (step === 3 && state.iso.hashOk === false && state.iso.confirmText.trim().toUpperCase() !== 'CONFIRM')
    return 'Type CONFIRM to accept a non-matching ISO.';
  if (step === 4 && state.diskNumber === null) return 'Select a USB stick.';
  if (step === 4 && state.usbConfirm.trim().toUpperCase() !== ('ERASE-' + state.diskNumber))
    return 'Type ' + ('ERASE-' + state.diskNumber) + ' to confirm.';
  if (step === 5 && !state.write.done) return state.write.running ? 'Write in progress — do not unplug the stick.' : '';
  if (step === 5 && !state.write.ok) return 'Fix the problem on the USB step, then try again.';
  return '';
}

function onPrimaryAction() {
  const step = state.step;
  if (step === 4) {
    if (!goto(5)) return;
    startWrite();
    return;
  }
  goto(step + 1);
}

/* ------------------------------------------------------------------ */
/* render                                                              */
/* ------------------------------------------------------------------ */

function render() {
  const b = state.branding || {};
  if (b.productName) {
    $('brandName').textContent = b.productName;
    $('brandTag').textContent = b.tagline || '';
    $('heroName').textContent = b.productName;
    $('isoFileName').textContent = (b.iso && b.iso.fileName) || 'ReviveBench.iso';
  }

  // rail
  for (const li of document.querySelectorAll('#railList li')) {
    const n = Number(li.dataset.rail);
    li.dataset.state = n === state.step ? 'current' : (n < state.step ? 'done' : 'todo');
    if (n === state.step) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  }
  $('stepCount').textContent = 'Step ' + state.step + ' of 6';

  renderLicense();
  renderIso();
  renderDisks();
  renderWrite();

  // nav
  const back = $('btnBack');
  back.disabled = state.step === 1 || state.write.running;
  const next = $('btnNext');
  next.hidden = state.step === 6;
  next.textContent = state.step === 4 ? (state.dryRun ? 'Run dry checks →' : 'Write the stick →') : 'Continue →';
  const allowed = canProceed(state.step);
  next.disabled = !allowed || (state.step === 5 && state.write.running);
  $('navHint').textContent = hintFor(state.step);
}

function renderLicense() {
  const l = state.license;
  const box = $('licenseStatus');
  const text = $('licenseStatusText');
  const btn = $('btnValidate');
  btn.disabled = l.pending;

  if (l.pending) {
    box.dataset.state = 'loading';
    box.querySelector('.status-icon').textContent = '◌';
    box.querySelector('.status-icon').classList.add('spin');
    text.textContent = 'Checking code with the license server…';
    return;
  }
  box.querySelector('.status-icon').classList.remove('spin');

  if (l.ok === true) {
    box.dataset.state = 'ok';
    box.querySelector('.status-icon').textContent = '✓';
    const remaining = l.remaining === null ? 'unlimited unlocks remaining' :
      l.remaining + ' unlock' + (l.remaining === 1 ? '' : 's') + ' remaining';
    text.innerHTML = '<strong>License OK</strong> — ' + remaining +
      ' <span class="muted">(status: ' + (l.status || 'active') + ')</span>';
  } else if (l.ok === false) {
    box.dataset.state = 'error';
    box.querySelector('.status-icon').textContent = '✕';
    text.textContent = l.message || 'License check failed.';
  } else {
    box.dataset.state = 'idle';
    box.querySelector('.status-icon').textContent = '•';
    text.textContent = 'Waiting for a code.';
  }
}

function renderIso() {
  const i = state.iso;
  $('isoPath').textContent = i.path || '— none selected —';
  $('isoPath').title = i.path || '';
  $('isoSize').textContent = i.size ? fmtBytes(i.size) + (i.hash ? ' · sha256 ' + shortHash(i.hash) : '') : '';

  const box = $('isoVerify');
  const text = $('isoVerifyText');
  const icon = box.querySelector('.status-icon');
  icon.classList.toggle('spin', i.checking);

  if (i.checking) {
    box.dataset.state = 'loading';
    icon.textContent = '◌';
    text.textContent = 'Computing SHA-256 of ' + (i.path ? i.path.split(/[\\/]/).pop() : 'the ISO') + '… this takes a few seconds.';
  } else if (i.error) {
    box.dataset.state = 'error';
    icon.textContent = '✕';
    text.textContent = i.error;
  } else if (!i.path) {
    box.dataset.state = 'idle';
    icon.textContent = '•';
    text.textContent = 'No file selected yet.';
  } else if (i.hashOk === true) {
    box.dataset.state = 'ok';
    icon.textContent = '✓';
    text.innerHTML = '<strong>Checksum matches</strong> — pinned SHA-256 verified.';
  } else if (i.hashOk === false) {
    box.dataset.state = 'error';
    icon.textContent = '⚠';
    text.innerHTML = '<strong>Checksum differs from the pin</strong> — review below to continue.';
  } else {
    box.dataset.state = 'idle';
    icon.textContent = '•';
    text.textContent = 'No pinned checksum configured for this build.';
  }

  const mismatch = i.hashOk === false;
  $('isoMismatch').hidden = !mismatch;
  if (mismatch) {
    $('hashComputed').textContent = i.hash || '—';
    $('hashExpected').textContent = i.expected || '(none pinned)';
  }
}

function renderDisks() {
  const d = state.disks;
  $('diskLoading').hidden = !d.loading;
  $('diskError').hidden = !d.error;
  if (d.error) $('diskErrorText').textContent = d.error;

  const listEl = $('diskList');
  const visible = !d.loading && !d.error && d.list.length > 0;
  listEl.hidden = !visible;
  $('diskEmpty').hidden = !(d.list.length === 0 && !d.loading && !d.error);

  const fingerprint = d.list.map((x) => x.number).join(',');
  if (visible && listEl.dataset.fingerprint !== fingerprint) {
    listEl.dataset.fingerprint = fingerprint;
    listEl.querySelectorAll('.disk-card').forEach((el) => el.remove());
    for (const disk of d.list) {
      const label = document.createElement('label');
      label.className = 'disk-card';
      label.htmlFor = 'disk-' + disk.number;
      label.innerHTML =
        '<input type="radio" name="disk" id="disk-' + disk.number + '" value="' + disk.number + '">' +
        '<span><span class="disk-name"></span><br><span class="disk-meta"></span></span>' +
        '<span class="disk-size"></span>';
      label.querySelector('.disk-name').textContent = disk.model || ('Disk ' + disk.number);
      label.querySelector('.disk-meta').textContent =
        'Disk ' + disk.number + ' · ' + (disk.bus || 'USB') + ' · ' + (disk.partitionStyle || '') +
        (disk.readOnly ? ' · read-only' : '') + (disk.label ? ' · "' + disk.label + '"' : '');
      label.querySelector('.disk-size').textContent = fmtBytes(disk.sizeBytes);
      label.querySelector('input').addEventListener('change', () => selectDisk(disk.number));
      listEl.appendChild(label);
    }
  }

  for (const card of listEl.querySelectorAll('.disk-card')) {
    const input = card.querySelector('input');
    input.checked = Number(input.value) === state.diskNumber;
    card.classList.toggle('selected', input.checked);
  }

  const selected = d.list.find((x) => x.number === state.diskNumber) || null;
  $('diskConfirmBox').hidden = !selected;
  $('elevateHint').hidden = !selected;
  if (selected) {
    $('confirmTarget').innerHTML = '';
    const strong = document.createElement('strong');
    strong.textContent = (selected.model || 'Disk ' + selected.number) + ' — ' + fmtBytes(selected.sizeBytes);
    $('confirmTarget').append('You are about to erase ', strong, '. This cannot be undone.');
    $('usbToken').textContent = 'ERASE-' + selected.number;
  }

  $('dryRun').checked = state.dryRun;
}

function renderWrite() {
  const w = state.write;
  $('writePhase').textContent = w.phase;
  $('writePct').textContent = w.pct + '%';
  const bar = $('writeBar');
  if (bar.value !== w.pct) bar.value = w.pct;

  const logEl = $('writeLog');
  if (w.lines.length) logEl.textContent = w.lines.join('\n');
  if (logFollow) logEl.scrollTop = logEl.scrollHeight;

  $('writeError').hidden = !w.error;
  if (w.error) $('writeErrorText').textContent = w.error;
  $('writeWarn').textContent = w.dryRun
    ? 'Dry run — no disk was modified.'
    : 'Do not unplug the stick or shut down this PC.';
}

/* ------------------------------------------------------------------ */
/* actions                                                             */
/* ------------------------------------------------------------------ */

async function doValidate() {
  const code = $('licenseInput').value.trim();
  state.license = { pending: true, ok: null, message: '', remaining: null, limit: null, usage: null, status: null };
  render();
  try {
    const res = await window.rb.validateLicense(code);
    state.license = {
      pending: false,
      ok: !!(res && res.ok),
      message: (res && res.message) || 'License check failed.',
      remaining: res ? res.remaining : null,
      limit: res ? res.limit : null,
      usage: res ? res.usage : null,
      status: res ? res.status : null
    };
  } catch (err) {
    state.license = { pending: false, ok: false, message: 'License check failed: ' + err.message, remaining: null, limit: null, usage: null, status: null };
  }
  render();
  if (state.license.ok && state.step === 2) goto(3);
}

async function detectIso() {
  try {
    const res = await window.rb.discoverIso();
    if (res && res.path) {
      state.iso.auto = true;
      await inspectIso(res.path);
    }
  } catch (err) { /* stay in idle state */ }
}

async function inspectIso(filePath) {
  state.iso = Object.assign({}, state.iso, { path: filePath, checking: true, error: null, confirmText: '' });
  $('isoConfirm').value = '';
  render();
  try {
    const r = await window.rb.inspectIso(filePath);
    state.iso = {
      path: (r && r.path) || filePath,
      size: (r && r.size) || null,
      hash: (r && r.hash) || null,
      expected: (r && r.expected) || null,
      hashOk: r && typeof r.hashOk === 'boolean' ? r.hashOk : null,
      checking: false,
      error: (r && r.error) || null,
      confirmText: '',
      auto: state.iso.auto
    };
  } catch (err) {
    state.iso = Object.assign({}, state.iso, { checking: false, error: 'Could not read the file: ' + err.message });
  }
  render();
}

async function browseIso() {
  try {
    const res = await window.rb.pickIso();
    if (res && res.path) {
      state.iso.auto = false;
      await inspectIso(res.path);
    }
  } catch (err) {
    state.iso = Object.assign({}, state.iso, { error: 'File picker failed: ' + err.message });
    render();
  }
}

async function refreshDisks() {
  state.disks = { loading: true, list: [], error: null };
  render();
  try {
    const res = await window.rb.listUsbDisks();
    if (res && res.ok) {
      const list = res.disks || [];
      state.disks = { loading: false, list, error: null };
      if (state.diskNumber !== null && !list.some((d) => d.number === state.diskNumber)) {
        state.diskNumber = null;
        state.usbConfirm = '';
        $('usbConfirm').value = '';
      }
    } else {
      state.disks = { loading: false, list: [], error: (res && res.error) || 'Disk listing failed.' };
    }
  } catch (err) {
    state.disks = { loading: false, list: [], error: 'Disk listing failed: ' + err.message };
  }
  render();
}

function selectDisk(number) {
  state.diskNumber = number;
  state.usbConfirm = '';
  $('usbConfirm').value = '';
  render();
  $('usbConfirm').focus();
}

async function startWrite() {
  const disk = state.disks.list.find((d) => d.number === state.diskNumber);
  state.write = {
    running: true, done: false, ok: false, pct: 0,
    phase: state.dryRun ? 'Running checks (dry run)…' : 'Requesting administrator approval…',
    lines: [], error: null, reason: null, started: false, dryRun: state.dryRun
  };
  render();

  try {
    const res = await window.rb.startWrite({
      dryRun: state.dryRun,
      isoPath: state.iso.path,
      diskNumber: state.diskNumber,
      expectedSha256: state.iso.hashOk === false ? state.iso.hash : (state.branding && state.branding.iso && state.branding.iso.sha256) || '',
      skipHashCheck: state.iso.hashOk === false && state.iso.confirmText.trim().toUpperCase() === 'CONFIRM'
    });
    if (!res || !res.started) {
      state.write.running = false;
      state.write.done = true;
      state.write.ok = false;
      state.write.error = (res && res.error) || 'Could not start the writer.';
      state.write.phase = 'Failed to start';
      render();
    }
  } catch (err) {
    state.write.running = false;
    state.write.done = true;
    state.write.ok = false;
    state.write.error = 'Could not start the writer: ' + err.message;
    state.write.phase = 'Failed to start';
    render();
  }
}

function handleWriteEvent(ev) {
  if (!ev) return;
  const w = state.write;
  switch (ev.type) {
    case 'started':
      state.write = {
        running: true, done: false, ok: false, pct: 0,
        phase: ev.dryRun ? 'Running checks (dry run)…' : 'Starting elevated writer…',
        lines: [], error: null, reason: null, started: true, dryRun: !!ev.dryRun
      };
      $('logPathLabel').textContent = ev.dryRun ? 'dry run' : '';
      break;
    case 'line':
      w.lines.push(ev.line);
      if (w.lines.length > 600) w.lines.splice(0, w.lines.length - 600);
      if (/^ABORT/i.test(ev.line)) w.phase = 'Aborted — see log';
      if (w.started && !w.pct && !w.dryRun) w.phase = 'Writing…';
      break;
    case 'progress':
      w.pct = ev.pct;
      if (ev.pct > 0 && ev.pct < 100) w.phase = w.dryRun ? 'Running checks…' : 'Writing…';
      break;
    case 'phase':
      w.phase = ev.text;
      break;
    case 'result':
      // only trust a detail message here; generic ABORT text is derived from the
      // log tail in the 'done' handler below.
      if (!ev.ok && ev.detail) w.error = ev.detail;
      break;
    case 'done':
      w.running = false;
      w.done = true;
      w.ok = !!ev.ok;
      if (ev.ok) {
        w.pct = 100;
        w.phase = w.dryRun ? 'Dry run complete — all checks passed' : 'Stick ready';
      } else {
        w.phase = w.dryRun ? 'Dry run failed' : 'Write failed';
        if (ev.reason === 'elevation_cancelled') w.error = 'Administrator approval was cancelled — the stick was not touched.';
        else if (ev.reason === 'elevation_failed') w.error = 'Could not obtain administrator approval: ' + (ev.stderr || 'unknown error');
        else if (!w.error) {
          const abortLine = w.lines.find((l) => /^ABORT/i.test(l));
          w.error = abortLine ? abortLine.replace(/^ABORT:?/i, '').trim() : 'The writer exited with code ' + ev.code + '.';
        }
      }
      break;
    default:
      break;
  }
  render();
}

async function copyDiagnostics() {
  const b = state.branding || {};
  const text = [
    'ReviveBench diagnostics ' + new Date().toISOString(),
    'product: ' + (b.productName || '') + ' ' + (b.version || ''),
    'step: ' + state.step + ' | dryRun: ' + state.write.dryRun,
    'iso: ' + state.iso.path + ' | hashOk: ' + state.iso.hashOk + ' | hash: ' + state.iso.hash,
    'expected: ' + state.iso.expected,
    'disk: ' + JSON.stringify(state.disks.list.find((d) => d.number === state.diskNumber) || null),
    'license: ' + JSON.stringify({ ok: state.license.ok, status: state.license.status, message: state.license.message }),
    '--- writer log ---',
    state.write.lines.join('\n')
  ].join('\n');
  const res = await window.rb.copyText(text);
  toast(res && res.ok ? 'Diagnostics copied to clipboard.' : 'Copy failed — select the log manually.');
}

async function openTechnician() {
  const res = await window.rb.openTechnicianDoc();
  const note = $('techNote');
  if (res && res.ok) {
    note.hidden = true;
  } else {
    note.hidden = false;
    const err = res && res.error ? String(res.error) : '';
    const where = (state.branding && state.branding.support && state.branding.support.url) || 'the support site';
    note.textContent = err === 'TECHNICIAN.md not bundled with this build.'
      ? 'TECHNICIAN.md was not bundled with this build. See ' + where + '.'
      : 'Could not open TECHNICIAN.md' + (err ? ' (' + err + ')' : '') + '. See ' + where + '.';
  }
}

function resetForAnotherStick() {
  state.diskNumber = null;
  state.usbConfirm = '';
  $('usbConfirm').value = '';
  state.write = {
    running: false, done: false, ok: false, pct: 0, phase: 'Waiting to start…',
    lines: [], error: null, reason: null, started: false, dryRun: false
  };
  $('logPathLabel').textContent = '';
  refreshDisks();
  goto(4, { force: true });
}

/* ------------------------------------------------------------------ */
/* wiring                                                              */
/* ------------------------------------------------------------------ */

function bind() {
  $('btnNext').addEventListener('click', onPrimaryAction);
  $('btnBack').addEventListener('click', () => goto(state.step - 1, { force: true }));

  $('btnValidate').addEventListener('click', doValidate);
  $('licenseInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !state.license.pending) doValidate();
  });

  $('btnDetect').addEventListener('click', detectIso);
  $('btnBrowse').addEventListener('click', browseIso);
  $('isoConfirm').addEventListener('input', (e) => {
    state.iso.confirmText = e.target.value;
    render();
  });

  $('btnRefreshDisks').addEventListener('click', refreshDisks);
  $('usbConfirm').addEventListener('input', (e) => {
    state.usbConfirm = e.target.value;
    render();
  });
  $('dryRun').addEventListener('change', (e) => {
    state.dryRun = e.target.checked;
    render();
  });

  $('btnDiag').addEventListener('click', copyDiagnostics);
  $('btnRetry').addEventListener('click', () => goto(4, { force: true }));
  $('writeLog').addEventListener('scroll', (e) => {
    const el = e.target;
    logFollow = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
  });
  $('btnTech').addEventListener('click', openTechnician);
  $('btnAgain').addEventListener('click', resetForAnotherStick);
  $('btnFinish').addEventListener('click', () => window.rb.quit());

  $('linkDevices').addEventListener('click', (e) => {
    e.preventDefault();
    const url = state.branding && state.branding.support && state.branding.support.devicesUrl;
    if (url) window.rb.openExternal(url).then((r) => { if (!r.ok) toast(r.error); });
  });
  $('linkSupport1').addEventListener('click', (e) => {
    e.preventDefault();
    const url = state.branding && state.branding.support && state.branding.support.url;
    if (url) window.rb.openExternal(url).then((r) => { if (!r.ok) toast(r.error); });
  });

  window.rb.onWriteEvent(handleWriteEvent);

  // minimal debug/QA surface (renderer-only; no privileged APIs)
  window.__rb = {
    showStep: (n) => goto(n, { force: true }),
    getState: () => JSON.parse(JSON.stringify(state)),
    inspectPath: (p) => inspectIso(p),
    refreshDisks
  };
}

async function init() {
  bind();
  try {
    state.branding = await window.rb.getBranding();
  } catch (err) {
    state.branding = { productName: 'ReviveBench' };
  }
  render();
  goto(1, { force: true });
}

document.addEventListener('DOMContentLoaded', init);
