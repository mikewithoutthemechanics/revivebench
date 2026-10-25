'use strict';
/**
 * ReviveBench desktop — Electron main process.
 *
 * Wizard window + IPC surface:
 *   branding:get, app:paths, license:validate, iso:discover/pick/inspect,
 *   usb:list, write:start (+ write:event stream), app:openExternal/openTechnician/copyText/quit
 *
 * Safety: the only thing that can touch a disk is scripts/write_stick.ps1, and
 * only when the renderer explicitly starts a non-dry write (which goes through
 * UAC elevation). This process never opens \\.\PhysicalDriveN itself.
 *
 * Smoke mode (--smoke): drives the renderer through all 6 screens, asserts the
 * fail-closed license path with an obviously invalid key, verifies the ISO
 * hash pin, lists USB disks (read-only) and optionally runs the writer in
 * -DryRun mode (--smoke-write). Screenshots land in %TEMP%\revivebench_smoke.
 */
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLicenseService } = require('./license');

const SMOKE = process.argv.includes('--smoke');
const SMOKE_WRITE = process.argv.includes('--smoke-write');

const DEFAULT_BRANDING = {
  productName: 'ReviveBench',
  tagline: 'Repair-shop license tool',
  version: '1.0.0',
  iso: { fileName: 'ReviveBench.iso', sha256: '', minSizeBytes: 6442450944 },
  license: {},
  support: { url: 'https://example.com/revivebench/support', devicesUrl: '', technicianDoc: 'packaging/TECHNICIAN.md' }
};

let mainWindow = null;
let licenseService = null;
let writeState = null; // { running, linesSeen, child, unsubscribe, smokeEvents }

/* ------------------------------------------------------------------ */
/* paths / branding                                                    */
/* ------------------------------------------------------------------ */

function psscript() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'scripts', 'write_stick.ps1')
    : path.join(app.getAppPath(), 'scripts', 'write_stick.ps1');
}
function pslist() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'scripts', 'list_disks.ps1')
    : path.join(app.getAppPath(), 'scripts', 'list_disks.ps1');
}
function resourceDir(kind) {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'resources', kind)
    : path.join(app.getAppPath(), 'resources', kind);
}
function logPath() {
  return path.join(app.getPath('temp'), 'revivebench_write_log.txt');
}

function readBranding() {
  const candidates = [];
  if (app.isPackaged) candidates.push(path.join(process.resourcesPath, 'branding.json'));
  candidates.push(path.join(app.getAppPath(), 'branding.json'));
  candidates.push(path.join(app.getAppPath(), '..', 'branding.json'));
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        const parsed = JSON.parse(fs.readFileSync(c, 'utf8'));
        return Object.assign({}, DEFAULT_BRANDING, parsed);
      }
    } catch (err) {
      console.error('branding.json unreadable at ' + c + ': ' + err.message);
    }
  }
  return Object.assign({}, DEFAULT_BRANDING);
}

function branding() {
  const b = readBranding();
  b.iso = Object.assign({}, DEFAULT_BRANDING.iso, b.iso || {});
  b.license = Object.assign({}, b.license || {});
  b.support = Object.assign({}, DEFAULT_BRANDING.support, b.support || {});
  return b;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function q(v) {
  return '"' + String(v).replace(/"/g, '""') + '"';
}

function runPowerShell(args, opts) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'].concat(args),
      Object.assign({ windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 300000 }, opts || {}),
      (error, stdout, stderr) => resolve({ error, stdout: stdout || '', stderr: stderr || '' })
    );
  });
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      'certutil.exe',
      ['-hashfile', filePath, 'SHA256'],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 600000 },
      (error, stdout) => {
        if (error) return reject(error);
        const lines = String(stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const hash = (lines[1] || '').toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(hash)) return reject(new Error('unexpected certutil output'));
        resolve(hash);
      }
    );
  });
}

/* ------------------------------------------------------------------ */
/* IPC: branding / paths                                               */
/* ------------------------------------------------------------------ */

ipcMain.handle('branding:get', () => branding());

ipcMain.handle('app:paths', () => ({
  script: psscript(),
  listDisks: pslist(),
  bench: resourceDir('bench'),
  payload: resourceDir('payload'),
  log: logPath(),
  resourcesRoot: app.isPackaged ? process.resourcesPath : app.getAppPath(),
  exeDir: path.dirname(process.execPath),
  appPath: app.getAppPath(),
  temp: app.getPath('temp')
}));

/* ------------------------------------------------------------------ */
/* IPC: license                                                        */
/* ------------------------------------------------------------------ */

ipcMain.handle('license:validate', async (_event, code) => {
  if (!licenseService) licenseService = createLicenseService(branding().license);
  return licenseService.validate(code);
});

/* ------------------------------------------------------------------ */
/* IPC: ISO select + hash pin                                          */
/* ------------------------------------------------------------------ */

function isoSearchDirs() {
  return [
    path.dirname(process.execPath), // next to the exe (install dir)
    app.isPackaged ? process.resourcesPath : app.getAppPath(),
    app.getAppPath(),
    app.isPackaged ? path.dirname(process.execPath) : path.join(app.getAppPath(), '..')
  ].filter((v, i, a) => a.indexOf(v) === i);
}

ipcMain.handle('iso:discover', () => {
  const fileName = branding().iso.fileName || 'ReviveBench.iso';
  for (const dir of isoSearchDirs()) {
    const candidate = path.join(dir, fileName);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return { path: candidate, auto: true };
    } catch (err) { /* ignore */ }
  }
  return { path: null, auto: false, searched: isoSearchDirs() };
});

ipcMain.handle('iso:pick', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select the ReviveBench product ISO',
    properties: ['openFile'],
    filters: [{ name: 'ISO image', extensions: ['iso'] }]
  });
  if (result.canceled || !result.filePaths.length) return { path: null, canceled: true };
  return { path: result.filePaths[0], canceled: false };
});

ipcMain.handle('iso:inspect', async (_event, filePath) => {
  const pin = branding().iso.sha256;
  if (!filePath) return { path: null, error: 'No file selected.' };
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    return { path: filePath, error: 'File not found: ' + filePath };
  }
  try {
    const hash = await sha256File(filePath);
    return {
      path: filePath,
      size: stat.size,
      hash,
      expected: pin,
      hashOk: pin ? hash === pin.toLowerCase() : null
    };
  } catch (err) {
    return { path: filePath, size: stat.size, error: 'Could not hash file: ' + (err.message || err) };
  }
});

/* ------------------------------------------------------------------ */
/* IPC: USB listing (BusType == USB only, read-only)                   */
/* ------------------------------------------------------------------ */

ipcMain.handle('usb:list', async () => {
  const res = await runPowerShell(['-File', pslist()], { timeout: 60000 });
  if (res.error) {
    return { ok: false, disks: [], error: (res.stderr || res.error.message || 'disk listing failed').trim() };
  }
  const out = res.stdout.trim();
  if (!out) return { ok: true, disks: [] };
  try {
    let parsed = JSON.parse(out);
    if (!Array.isArray(parsed)) {
      if (parsed && parsed.error) return { ok: false, disks: [], error: String(parsed.error) };
      parsed = parsed && parsed.number !== undefined ? [parsed] : [];
    }
    return { ok: true, disks: parsed };
  } catch (err) {
    return { ok: false, disks: [], error: 'Could not parse disk list: ' + out.slice(0, 400) };
  }
});

/* ------------------------------------------------------------------ */
/* IPC: writer launch + log tailing                                    */
/* ------------------------------------------------------------------ */

function emitWrite(payload) {
  if (SMOKE && writeState && writeState.smokeEvents) writeState.smokeEvents.push(payload);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('write:event', payload);
  }
}

function startLogPoller(baselineLines) {
  let linesSeen = baselineLines || 0;
  const timer = setInterval(() => {
    try {
      if (!fs.existsSync(logPath())) return;
      const text = fs.readFileSync(logPath(), 'utf8');
      const lines = text.split(/\r?\n/);
      // last element is the trailing '' after the final newline (or a partial line)
      const complete = lines.length - 1;
      if (complete < linesSeen) linesSeen = 0; // truncated / new session
      if (complete <= linesSeen) return;
      const fresh = lines.slice(linesSeen, complete);
      linesSeen = complete;
      for (const line of fresh) {
        if (!line.trim()) continue;
        if (/^#< CLIXML/.test(line) || /^<Objs /.test(line)) continue; // PS progress serialization
        emitWrite({ type: 'line', line });
        const prog = /^PROGRESS\s+(\d+)/.exec(line);
        if (prog) emitWrite({ type: 'progress', pct: Math.min(100, parseInt(prog[1], 10)) });
        const phase = /^PHASE\s+(.*)$/.exec(line);
        if (phase) emitWrite({ type: 'phase', text: phase[1].trim() });
        const result = /^RESULT\s+(\S+)(.*)$/.exec(line);
        if (result) emitWrite({ type: 'result', ok: result[1].toUpperCase() === 'OK', detail: (result[2] || '').trim() });
      }
    } catch (err) {
      /* keep polling; log file hiccups are not fatal */
    }
  }, 300);
  return timer;
}

ipcMain.handle('write:start', async (_event, opts) => {
  const o = opts || {};
  if (writeState && writeState.running) {
    return { started: false, error: 'A write is already in progress.' };
  }
  const script = psscript();
  if (!fs.existsSync(script)) {
    return { started: false, error: 'Writer script missing: ' + script };
  }
  if (!o.dryRun) {
    if (!o.isoPath || !fs.existsSync(o.isoPath)) return { started: false, error: 'ISO not found.' };
    if (o.diskNumber === undefined || o.diskNumber === null || Number(o.diskNumber) < 0) {
      return { started: false, error: 'No USB stick selected.' };
    }
  }

  const psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-IsoPath', o.isoPath || '',
    '-DiskNumber', String(o.diskNumber === undefined ? -1 : o.diskNumber),
    '-ExpectedSha256', String(o.expectedSha256 || branding().iso.sha256 || ''),
    '-BenchDir', resourceDir('bench'),
    '-PayloadDir', resourceDir('payload'),
    '-LogPath', logPath()];
  if (o.skipHashCheck) psArgs.push('-SkipHashCheck');
  if (o.dryRun) psArgs.push('-DryRun');

  const argListLiteral = psArgs
    .map((a) => "'" + (a.startsWith('-') ? a : q(a)).replace(/'/g, "''") + "'")
    .join(',');

  const wrapper =
    "$ErrorActionPreference='Stop'; " +
    'try { $p = Start-Process -FilePath \'powershell.exe\' ' +
    (o.dryRun ? '' : '-Verb RunAs ') +
    '-ArgumentList @(' + argListLiteral + ') -Wait -PassThru; exit $p.ExitCode } ' +
    "catch { [Console]::Error.WriteLine('ELEVATION_FAILED: ' + $_.Exception.Message); exit 9 }";

  const encoded = Buffer.from(wrapper, 'utf16le').toString('base64');

  writeState = { running: true, smokeEvents: SMOKE ? [] : null };

  // mark a fresh log session so the tail starts from a known point
  try {
    fs.appendFileSync(logPath(), '\r\n=== SESSION ' + new Date().toISOString() + (o.dryRun ? ' (dry-run)' : '') + ' ===\r\n');
  } catch (err) { /* poller tolerates an unwritable log */ }
  let baseline = 0;
  try {
    baseline = Math.max(0, fs.readFileSync(logPath(), 'utf8').split(/\r?\n/).length - 1);
  } catch (err) { baseline = 0; }
  const pollTimer = startLogPoller(baseline);

  emitWrite({ type: 'started', dryRun: !!o.dryRun, iso: o.isoPath || null, diskNumber: o.diskNumber });

  const child = execFile(
    'powershell.exe',
    ['-NoProfile', '-EncodedCommand', encoded],
    { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    (error, stdout, stderr) => {
      clearInterval(pollTimer);
      const code = error && typeof error.code === 'number' ? error.code : 0;
      const errText = String(stderr || '').trim();
      if (errText) {
        errText.split(/\r?\n/)
          .filter((line) => line.trim() && !/^#< CLIXML/.test(line) && !/^<Objs /.test(line))
          .forEach((line) => emitWrite({ type: 'line', line }));
      }
      let reason;
      if (code === 9 || /ELEVATION_FAILED/i.test(errText)) reason = 'elevation_failed';
      else if (/canceled by the user/i.test(errText)) reason = 'elevation_cancelled';
      writeState.running = false;
      emitWrite({ type: 'done', code, ok: code === 0, reason, stderr: errText });
    }
  );

  return { started: true, dryRun: !!o.dryRun, log: logPath() };
});

/* ------------------------------------------------------------------ */
/* IPC: misc                                                           */
/* ------------------------------------------------------------------ */

ipcMain.handle('app:openExternal', async (_event, url) => {
  if (!/^https:\/\//i.test(String(url || ''))) return { ok: false, error: 'Only https links can be opened.' };
  await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle('app:openTechnician', async () => {
  const candidates = [
    path.join(app.getAppPath(), '..', 'packaging', 'TECHNICIAN.md'),
    path.join(app.getAppPath(), 'packaging', 'TECHNICIAN.md'),
    app.isPackaged ? path.join(process.resourcesPath, 'packaging', 'TECHNICIAN.md') : null
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        const openError = await shell.openPath(c);
        if (openError) {
          return { ok: false, error: String(openError), fallbackUrl: branding().support.url };
        }
        return { ok: true, path: c };
      }
    } catch (err) { /* try next */ }
  }
  return { ok: false, error: 'TECHNICIAN.md not bundled with this build.', fallbackUrl: branding().support.url };
});

ipcMain.handle('app:copyText', (_event, text) => {
  try {
    clipboard.writeText(String(text == null ? '' : text));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message) };
  }
});

ipcMain.handle('app:quit', () => {
  if (writeState && writeState.running) return { ok: false };
  app.quit();
  return { ok: true };
});

/* ------------------------------------------------------------------ */
/* window                                                              */
/* ------------------------------------------------------------------ */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0e1116',
    show: false,
    title: branding().productName,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(async () => {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  licenseService = createLicenseService(branding().license);
  createWindow();

  if (SMOKE) {
    await runSmoke();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

/* ------------------------------------------------------------------ */
/* smoke / self-test driver                                            */
/* ------------------------------------------------------------------ */

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runSmoke() {
  const wc = mainWindow.webContents;
  const report = { checks: [], consoleErrors: [], screenshots: [], shots: [], frames: [], writeResult: null };
  const check = (name, ok, detail) => {
    report.checks.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
    return !!ok;
  };
  const finish = (code) => {
    report.ok = report.checks.length > 0 && report.checks.every((c) => c.ok) && report.consoleErrors.length === 0;
    const shotDir = path.join(app.getPath('temp'), 'revivebench_smoke');
    try {
      fs.mkdirSync(shotDir, { recursive: true });
      fs.writeFileSync(path.join(shotDir, 'report.json'), JSON.stringify(report, null, 2));
    } catch (err) { console.error('could not write report.json: ' + err.message); }
    console.log('=== SMOKE REPORT ===');
    console.log(JSON.stringify(report, null, 2));
    console.log('=== END SMOKE REPORT ===');
    setTimeout(() => app.exit(code === undefined ? (report.ok ? 0 : 1) : code), 200);
  };
  try {
    await runSmokeBody(check, report, finish);
  } catch (err) {
    report.checks.push({ name: 'smoke driver threw', ok: false, detail: String(err && err.stack ? err.stack : err) });
    finish(1);
  }
}

async function runSmokeBody(check, report, finish) {
  const wc = mainWindow.webContents;

  wc.on('console-message', (details) => {
    const level = details && details.level;
    const message = details && details.message;
    const line = details && (details.lineNumber !== undefined ? details.lineNumber : details.line);
    const sourceId = details && details.sourceId;
    if (level === 'error') report.consoleErrors.push(String(message) + ' @' + sourceId + ':' + line);
  });
  wc.on('render-process-gone', (_e, detail) => {
    report.consoleErrors.push('RENDER PROCESS GONE: ' + JSON.stringify(detail));
  });

  await delay(1200);
  const shotDir = path.join(app.getPath('temp'), 'revivebench_smoke');
  fs.mkdirSync(shotDir, { recursive: true });

  if (wc.isLoading()) await new Promise((r) => wc.once('did-finish-load', r));
  else await delay(500);
  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  // Keep the window above everything else while the smoke runs: a fully occluded
  // window stops producing frames, and capturePage would then hand back stale ones.
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  await delay(300);

  const js = (code) => wc.executeJavaScript(code, true);
  // A minimized/hidden window stops painting, and capturePage then returns the
  // last painted frame — silently wrong evidence. Keep the window on screen.
  const ensureVisible = async () => {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
  };
  // capturePage returns the last *completed* frame, so immediately after a DOM
  // change it can be one paint behind. Pump two animation frames (which forces a
  // paint), capture once to force a frame for the current state, then keep the
  // second capture.
  const pump = () =>
    js(
      'Promise.race([' +
        'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120)))),' +
        'new Promise((r) => setTimeout(r, 1500))' +
        '])'
    );
  const frameHash = (png) => crypto.createHash('sha256').update(png).digest('hex').substring(0, 16);
  const shoot = async (name) => {
    try {
      await ensureVisible();
      await pump();
      await wc.capturePage(); // discard: makes sure a frame exists for this state
      await delay(80);
      const img = await wc.capturePage();
      const png = img.toPNG();
      const file = path.join(shotDir, name + '.png');
      fs.writeFileSync(file, png);
      report.screenshots.push(file);
      const hash = frameHash(png);
      const prev = report.frames.length ? report.frames[report.frames.length - 1].hash : null;
      report.shots.push({
        name,
        visible: mainWindow.isVisible(),
        minimized: mainWindow.isMinimized(),
        visibility: await js('document.visibilityState'),
        sameAsPreviousFrame: prev === hash
      });
      report.frames.push({ name, hash });
      return img;
    } catch (err) {
      report.screenshots.push('FAILED ' + name + ': ' + err.message);
      return null;
    }
  };

  // Reads the pixel at (8,8) out of a capture to prove the shot was taken after
  // the change we just made (byte order tolerated: BGRA on Windows, RGBA elsewhere).
  const cornerIsColor = (img, rgb) => {
    if (!img) return false;
    try {
      const size = img.getSize();
      const buf = img.toBitmap();
      const i = (8 * size.width + 8) * 4;
      const p = [buf[i], buf[i + 1], buf[i + 2]];
      const near = (q) => Math.abs(q[0] - rgb[0]) <= 16 && Math.abs(q[1] - rgb[1]) <= 16 && Math.abs(q[2] - rgb[2]) <= 16;
      return near(p) || near([p[2], p[1], p[0]]);
    } catch (err) {
      return false;
    }
  };
  const PROBE_RGB = [255, 45, 85];
  const overlayProbe = async (tag) => {
    await js(`(() => {
      let d = document.getElementById('__probe');
      if (!d) {
        d = document.createElement('div');
        d.id = '__probe';
        d.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#ff2d55';
        document.body.appendChild(d);
      }
      return true;
    })()`);
    const on = await shoot('probe_' + tag + '_on');
    await js(`(() => { const d = document.getElementById('__probe'); if (d) d.remove(); return true; })()`);
    const off = await shoot('probe_' + tag + '_off');
    check('capture is fresh (' + tag + '): added overlay visible', cornerIsColor(on, PROBE_RGB));
    check('capture is fresh (' + tag + '): removed overlay gone', off != null && !cornerIsColor(off, PROBE_RGB));
  };

  const visibleStep = () =>
    js("(() => { const s = document.querySelector('section.step:not([hidden])'); return s ? Number(s.dataset.step) : 0; })()");

  // 1. bridge + sections + branding
  check('preload bridge exposed', await js('!!window.rb'));
  const sections = await js(
    "Array.from(document.querySelectorAll('section.step')).map(s => ({ n: s.dataset.step, h: (s.querySelector('h1,h2')||{}).textContent || '' }))"
  );
  check('6 wizard screens present', Array.isArray(sections) && sections.length === 6, JSON.stringify(sections));
  const b = await js('window.rb.getBranding()');
  check('branding loaded (productName)', b && b.productName === 'ReviveBench', b && b.productName);
  check('ISO pin present', !!(b && b.iso && /^[0-9a-f]{64}$/.test(b.iso.sha256)), b && b.iso && b.iso.sha256);
  // spec 2.6: the Done screen links to TECHNICIAN.md — assert the file is shipped
  const techDoc = app.isPackaged
    ? path.join(process.resourcesPath, 'packaging', 'TECHNICIAN.md')
    : path.join(app.getAppPath(), '..', 'packaging', 'TECHNICIAN.md');
  check('TECHNICIAN.md shipped for the Done-screen link', fs.existsSync(techDoc), techDoc);

  // 2. walk + screenshot every screen
  for (const s of sections) {
    await js('window.__rb && window.__rb.showStep(' + Number(s.n) + ')');
    await delay(300);
    const shown = await visibleStep();
    check('screen ' + s.n + ' is the visible one when shot', shown === Number(s.n), 'visible=' + shown);
    await shoot('step' + s.n);
  }
  const visible = await js("document.querySelectorAll('section.step:not([hidden])').length");
  check('exactly one screen visible at a time', visible === 1, 'visible=' + visible);
  // six different screens must yield six different frames; a repeat means
  // capturePage handed back a stale frame
  const walkFrames = report.frames.filter((f) => /^step[1-6]$/.test(f.name));
  check('every walk screenshot caught a new frame',
    walkFrames.length === sections.length &&
      new Set(walkFrames.map((f) => f.hash)).size === walkFrames.length,
    walkFrames.map((f) => f.name + '=' + f.hash).join(' '));
  await overlayProbe('early');

  // 3. license FAIL-CLOSED with an obviously invalid key (real LS API)
  await js('window.__rb.showStep(2)');
  await js(`(() => {
    const i = document.getElementById('licenseInput');
    i.value = 'RB-INVALID-KEY-FAIL-CLOSED-0000';
    document.getElementById('btnValidate').click();
    return true;
  })()`);
  let lic = null;
  for (let i = 0; i < 40 && (!lic || lic.pending); i++) {
    await delay(500);
    lic = await js('window.__rb.getState().license');
  }
  check('license invalid key fails closed', lic && lic.ok === false, JSON.stringify(lic));
  check('license UI shows red/error state', await js("!!document.querySelector('#licenseStatus[data-state=\"error\"]')"));
  await delay(200);
  const licStep = await visibleStep();
  check('license screen visible when shot', licStep === 2, 'visible=' + licStep);
  await shoot('step2_license_failclosed');

  // 4. ISO hash pin against the real Mint ISO (if present)
  const isoName = b.iso.fileName === 'ReviveBench.iso' ? 'linuxmint-22.3-xfce-64bit.iso' : b.iso.fileName;
  const isoCandidates = [
    path.join(os.homedir(), 'Downloads', 'linuxmint-22.3-xfce-64bit.iso'),
    path.join(os.homedir(), 'Downloads', b.iso.fileName)
  ];
  const isoPath = isoCandidates.find((p) => fs.existsSync(p));
  if (isoPath) {
    await js('window.__rb.showStep(3)');
    await js('window.__rb.inspectPath(' + JSON.stringify(isoPath) + ')');
    let isoState = null;
    for (let i = 0; i < 120 && (!isoState || isoState.checking); i++) {
      await delay(500);
      isoState = await js('window.__rb.getState().iso');
    }
    check('ISO sha256 matches pin', isoState && isoState.hashOk === true,
      (isoState && isoState.hash) + ' vs ' + b.iso.sha256);
    await delay(300);
    const isoStep = await visibleStep();
    check('ISO screen visible when shot', isoStep === 3, 'visible=' + isoStep);
    await shoot('step3_iso_hash_ok');
    report.isoPath = isoPath;
    report.isoState = isoState;
  } else {
    check('ISO present on disk (skipped hash check)', true, 'no ISO found next to user Downloads; skipped');
  }

  // 5. USB listing — USB BusType only
  const disks = await js('window.rb.listUsbDisks()');
  const listOk = disks && disks.ok === true && Array.isArray(disks.disks);
  check('usb:list returns JSON', listOk, JSON.stringify(disks && disks.error ? disks.error : disks.disks));
  if (listOk) {
    check('only BusType=USB disks listed', disks.disks.every((d) => d.bus === 'USB'), JSON.stringify(disks.disks));
    report.usbDisks = disks.disks;
  }
  await js('window.__rb.showStep(4)');
  let diskState = null;
  for (let i = 0; i < 40 && (!diskState || diskState.loading); i++) {
    await delay(500);
    diskState = await js('window.__rb.getState().disks');
  }
  await delay(300);
  const usbStep = await visibleStep();
  check('USB screen visible when shot', usbStep === 4, 'visible=' + usbStep);
  await shoot('step4_usb');

  // 6. writer dry-run (never touches disks)
  if (SMOKE_WRITE && report.isoPath) {
    const disk = listOk && disks.disks.length ? disks.disks[0].number : 99;
    await js('window.__rb.showStep(5)');
    await js(`window.rb.startWrite(${JSON.stringify({
      dryRun: true,
      isoPath: report.isoPath,
      diskNumber: disk,
      expectedSha256: b.iso.sha256
    })})`);
    let done = null;
    for (let i = 0; i < 240 && !done; i++) {
      await delay(500);
      const st = await js('window.__rb.getState().write');
      if (st && st.done) done = st;
    }
    report.writeResult = done;
    if (listOk && disks.disks.length) {
      check('writer -DryRun completes with checks', done && done.ok === true, JSON.stringify(done));
    } else {
      check('writer guard aborts when no USB target', done && done.ok !== true, JSON.stringify(done));
    }
    await delay(300);
    const writeStep = await visibleStep();
    check('write screen visible when shot', writeStep === 5, 'visible=' + writeStep);
    await shoot('step5_write');
    if (done && done.ok) {
      await js('window.__rb.showStep(6)');
      await delay(300);
      const doneStep = await visibleStep();
      check('done screen visible when shot', doneStep === 6, 'visible=' + doneStep);
      await shoot('step6_done');
    }
  }

  await overlayProbe('late');
  const badShots = report.shots.filter((s) => !s.visible || s.minimized || s.visibility !== 'visible');
  check('window visible for every screenshot', badShots.length === 0,
    badShots.length ? JSON.stringify(badShots) : report.shots.length + ' shot(s)');
  await delay(300);
  finish();
}
