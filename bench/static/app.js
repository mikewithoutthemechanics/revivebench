/* ReviveBench Bench GUI — plain JS, no framework.
   Polls GET /api/state and renders; posts commands to /api/*. */

"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const STEP_ORDER = ["setup", "license", "device", "dfu", "ramdisk", "activator", "verify", "burn"];

let S = null;            // last state snapshot
let tick = 0;
let visibleLogKey = "";
let dfuTimer = null;

/* ------------------------------------------------------------------ utils */

async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  try { return await res.json(); }
  catch (e) { return { ok: false, error: "bad response from server" }; }
}

function toast(msg, ms = 3200) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, ms);
}

function fmtCountdown(sec) {
  return Math.max(0, Math.ceil(sec));
}

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

/* ------------------------------------------------------------- state poll */

async function poll() {
  try {
    const res = await fetch("/api/state", { cache: "no-store" });
    S = await res.json();
    $("#conn-badge").textContent = "● connected";
    $("#conn-badge").className = "badge badge-ok";
    render();
  } catch (e) {
    $("#conn-badge").textContent = "● disconnected";
    $("#conn-badge").className = "badge badge-bad";
  }
  tick++;
}

/* ---------------------------------------------------------------- render */

function render() {
  if (!S) return;
  $("#mock-badge").hidden = !S.mock;
  renderRail();
  renderPanels();
  renderLicense();
  renderDevice();
  renderDfu();
  renderBurn();
  renderMini("ramdisk-log", "ramdisk");
  renderMini("activator-log", "activator");
  renderLog();
}

function renderRail() {
  const rail = $("#rail");
  if (!rail._built) {
    rail.innerHTML = STEP_ORDER.map((k) =>
      `<div class="step" data-step="${k}"><span class="dot"></span>` +
      `<span class="step-title">${esc(S.titles[k])}</span></div>`).join("");
    rail._built = true;
    rail.addEventListener("click", (e) => {
      const card = e.target.closest(".step");
      if (card) showPanel(card.dataset.step, true);
    });
  }
  $$("#rail .step").forEach((el) => {
    const k = el.dataset.step;
    const st = S.steps[k].status;
    el.className = "step" +
      (st === "done" ? " is-done" : "") +
      (st === "running" ? " is-running" : "") +
      (st === "error" ? " is-error" : "") +
      (S.step === k ? " is-current" : "");
  });
}

let forcedPanel = null;

function showPanel(name, force) {
  forcedPanel = force ? name : forcedPanel;
  $$(".panel").forEach((p) => { p.hidden = p.dataset.panel !== name; });
}

function renderPanels() {
  // keep showing a manually clicked panel until the flow moves on
  let target = S.step;
  if (!STEP_ORDER.includes(target)) target = forcedPanel || "burn";
  if (forcedPanel && S.step !== forcedPanel &&
      S.steps[forcedPanel] && S.steps[forcedPanel].status === "running") {
    target = forcedPanel; // follow the step the user is watching while it runs
  }
  if (forcedPanel && STEP_ORDER.indexOf(S.step) > STEP_ORDER.indexOf(forcedPanel) &&
      S.steps[forcedPanel].status === "done") {
    forcedPanel = null;   // flow moved past the panel they were watching
  }
  showPanel(STEP_ORDER.includes(target) ? target : "burn");

  // setup button state
  const setup = S.steps.setup;
  const btnSetup = $("#btn-setup");
  btnSetup.disabled = setup.status === "running";
  btnSetup.textContent = setup.status === "running" ? "Working…" :
    (setup.status === "done" ? "Re-run setup" : "Prepare tools");
  $("#setup-hint").textContent = setup.error || (setup.status === "done" ? "✓ Tools ready." : "");
  $("#setup-hint").className = "hint" + (setup.error ? " err" : "");

  // ramdisk / activator / verify buttons follow their step status
  syncRunButton("#btn-ramdisk", S.steps.ramdisk, "Boot ramdisk", "Running…", "Re-run");
  syncRunButton("#btn-activator", S.steps.activator, "Run activator", "Running…", "Re-run");
  syncRunButton("#btn-verify", S.steps.verify, "Check unlock", "Checking…", "Check again");
  $("#ramdisk-hint").textContent = S.steps.ramdisk.error || "";
  $("#ramdisk-hint").className = "hint" + (S.steps.ramdisk.error ? " err" : "");
  $("#activator-hint").textContent = S.steps.activator.error || "";
  $("#activator-hint").className = "hint" + (S.steps.activator.error ? " err" : "");

  // verify card
  const vs = S.verify;
  const vcard = $("#verify-status");
  if (vs.state === "idle") {
    vcard.hidden = true;
  } else {
    vcard.hidden = false;
    vcard.className = "bigstatus " + (vs.state === "done" ? "ok" : (vs.state === "running" ? "info" : "bad"));
    $("#verify-mode").textContent =
      vs.state === "running" ? "Checking activation state…" :
      vs.state === "done" ? "Activated ✓" : "Not activated yet";
    $("#verify-detail").textContent =
      `ActivationState: ${vs.activation_state ?? "—"}` + (vs.error ? ` — ${vs.error}` : "");
  }
}

function syncRunButton(sel, step, label, running, again) {
  const b = $(sel);
  if (!b) return;
  b.disabled = step.status === "running";
  b.textContent = step.status === "running" ? running
    : (step.status === "done" || step.status === "error") ? again : label;
}

/* ------------------------------------------------------------- license */

function renderLicense() {
  const L = S.license;
  const res = $("#license-result");
  const counters = $("#license-counters");
  if (!L.key && !L.error) { res.hidden = true; counters.hidden = true; return; }
  res.hidden = false;
  if (L.valid) {
    res.className = "result ok";
    res.textContent = `Code accepted — ${L.remaining} unlock${L.remaining === 1 ? "" : "s"} remaining`;
    counters.hidden = false;
    $("#cnt-remaining").textContent = L.remaining ?? "–";
    $("#cnt-usage").textContent = L.usage ?? "–";
    $("#cnt-limit").textContent = L.limit ?? "–";
  } else {
    res.className = "result bad";
    res.textContent = L.error || "Code not valid.";
    counters.hidden = true;
  }
  $("#btn-validate").disabled = false;
  $("#btn-validate").textContent = "Check code";
}

/* -------------------------------------------------------------- device */

function renderDevice() {
  const d = S.device;
  const card = $("#device-card");
  const mode = $("#device-mode");
  const detail = $("#device-detail");
  card.className = "bigstatus";
  if (d.mode === "dfu") {
    card.classList.add("ok");
    mode.textContent = "DFU mode ✓";
    detail.textContent = "Device is in DFU — ready for the ramdisk step." +
      (d.pwnd ? ` (pwned: ${d.pwnd})` : "");
  } else if (d.mode === "recovery") {
    card.classList.add("bad");
    mode.textContent = "Recovery mode — not DFU";
    detail.textContent = "Cable/iTunes logo means recovery. Redo the DFU sequence from step 4.";
  } else if (d.mode === "normal") {
    card.classList.add("info");
    mode.textContent = `${d.product || "Device"} — connected`;
    detail.textContent = "Normal mode detected. Next: put it in DFU mode.";
  } else {
    mode.textContent = "Nothing connected";
    detail.textContent = "Plug the device in directly (USB-A port, no hub).";
  }
  const rows = [
    ["Product", d.product], ["iOS", d.ios], ["ECID", d.ecid],
    ["Mode", d.mode], ["PWND", d.pwnd], ["Last poll", d.last_poll ? new Date(d.last_poll * 1000).toLocaleTimeString() : "—"],
  ];
  $("#device-kv").innerHTML = rows
    .filter(([k, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `<div><b>${k}</b><span>${esc(v)}</span></div>`).join("");
}

/* ----------------------------------------------------------------- DFU */

function renderDfu() {
  const active = S.dfu.active;
  const phase = S.dfu_phase;
  const phases = $$(".tl-phase");
  const start = S.dfu.started_at ? Number(S.dfu.started_at) : null;
  const elapsed = start ? (Date.now() / 1000 - start) : 0;

  phases.forEach((el) => el.classList.remove("active", "done", "bad"));

  const status = $("#dfu-status");
  const mode = status.querySelector(".bigstatus-mode");
  const detail = status.querySelector(".bigstatus-detail");
  status.className = "bigstatus";

  $("#btn-dfu-retry").hidden = !(phase === "recovery" || (phase === "idle" && active === false));

  if (!active) {
    $("#tl-num-1").textContent = "10";
    $("#tl-num-2").textContent = "5";
    $("#tl-bar-1").style.width = "0";
    $("#tl-bar-2").style.width = "0";
    $("#tl-bar-3").style.width = "0";
    mode.textContent = "Ready when you are";
    detail.textContent = "Press “Start DFU guide” and hold the buttons.";
    status.classList.add("info");
    return;
  }

  if (phase === "power_home") {
    phases[0].classList.add("active");
    $("#tl-num-1").textContent = fmtCountdown(10 - elapsed);
    $("#tl-num-2").textContent = "5";
    $("#tl-bar-1").style.width = Math.min(100, (elapsed / 10) * 100) + "%";
    $("#tl-bar-2").style.width = "0";
    mode.textContent = "Hold Power + Home";
    detail.textContent = "Keep both buttons pressed until the countdown finishes.";
    status.classList.add("info");
  } else if (phase === "release_power") {
    phases[0].classList.add("done");
    phases[1].classList.add("active");
    $("#tl-num-1").textContent = "0";
    $("#tl-num-2").textContent = fmtCountdown(15 - elapsed);
    $("#tl-bar-2").style.width = Math.min(100, ((elapsed - 10) / 5) * 100) + "%";
    $("#tl-bar-3").style.width = "0";
    mode.textContent = "Release Power — keep holding Home";
    detail.textContent = "Screen should be black. Keep Home pressed.";
    status.classList.add("info");
  } else if (phase === "hold_home") {
    phases[0].classList.add("done");
    phases[1].classList.add("done");
    phases[2].classList.add("active");
    $("#tl-num-1").textContent = "0";
    $("#tl-num-2").textContent = "0";
    $("#tl-bar-3").style.width = "55%";
    mode.textContent = "Waiting for DFU…";
    detail.textContent = "Keep holding Home for a few more seconds. Detection is automatic.";
    status.classList.add("info");
  } else if (phase === "detected") {
    phases.forEach((el) => el.classList.add("done"));
    $("#tl-num-1").textContent = "0";
    $("#tl-num-2").textContent = "0";
    $("#tl-bar-3").style.width = "100%";
    mode.textContent = "DFU detected ✓";
    detail.textContent = "Moving on to the ramdisk step.";
    status.classList.add("ok");
  } else if (phase === "recovery") {
    phases[0].classList.add("bad");
    mode.textContent = "That is recovery mode — redo";
    detail.textContent = "The device booted the cable/iTunes screen instead of DFU. " +
      "Hold Power+Home for 10 s to force it off, then try again.";
    status.classList.add("bad");
    $("#btn-dfu-retry").hidden = false;
  }

  // recovery note surfaced by the poller
  if (S.dfu.note === "recovery_seen" && phase !== "recovery") {
    status.classList.add("bad");
    mode.textContent = "Recovery mode seen — redo the sequence";
  }

  clearInterval(dfuTimer);
  if (active && ["power_home", "release_power", "hold_home"].includes(phase)) {
    dfuTimer = setInterval(renderDfu, 400);   // local countdown smoothing
  }
}

/* ---------------------------------------------------------------- burn */

function instanceName() {
  const ecid = S.device.ecid || S.device.product || "UNKNOWN";
  const d = new Date();
  const ymd = d.getFullYear() +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0");
  return `RB-${ecid}-${ymd}` + ($("#pop-check").checked ? "-PoP1" : "");
}

function renderBurn() {
  $("#instance-preview").textContent = instanceName();

  const B = S.burn;
  const btn = $("#btn-burn");
  const warn = $("#burn-warning");
  const success = $("#burn-success");
  const burnStep = S.steps.burn;

  warn.hidden = B.state !== "pending";
  success.hidden = B.state !== "done";
  btn.hidden = B.state === "done";

  if (B.state === "pending") {
    $("#burn-warning-body").textContent =
      `${B.error || "The license service could not be reached."} ` +
      `The unlock itself succeeded — do NOT unplug the device. ` +
      `Instance "${B.instance_name}" is kept and will be sent on retry ` +
      `(attempt ${B.attempt}).`;
  }

  if (B.state === "done") {
    $("#burn-success-detail").textContent =
      `1 code consumed — usage ${B.usage}/${B.limit}` +
      ` · instance ${B.instance_name}`;
    $("#pop-state").textContent = B.pop
      ? "Attestation recorded: customer ownership verified (PoP1)."
      : "Attestation: not checked.";
    $("#btn-repeat").hidden = !(S.license.remaining > 0);
  } else {
    $("#btn-repeat").hidden = true;
  }

  btn.disabled = burnStep.status === "running";
  btn.textContent = burnStep.status === "running" ? "Burning…" : "Burn 1 code";
}

/* ---------------------------------------------------------------- logs */

function renderMini(sel, step) {
  const el = $(sel);
  if (!el) return;
  const rows = S.log_tail.filter((r) => r.step === step).slice(-60);
  const text = rows.map((r) => r.line).join("\n");
  if (el._last !== text) {
    el.textContent = text;
    el._last = text;
    el.scrollTop = el.scrollHeight;
  }
}

function renderLog() {
  const el = $("#log");
  const rows = S.log_tail;
  const key = rows.length ? `${rows.length}:${rows[rows.length - 1].t}` : "0";
  if (key === visibleLogKey) return;
  visibleLogKey = key;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  el.innerHTML = rows.map((r) => {
    const hh = new Date(r.t * 1000).toLocaleTimeString();
    return `<div class="l ${r.level}"><span class="tag">${hh} ${esc(r.step)}</span> ${esc(r.line)}</div>`;
  }).join("");
  if (atBottom) el.scrollTop = el.scrollHeight;
}

/* --------------------------------------------------------------- events */

function bind() {
  $("#btn-setup").addEventListener("click", async () => {
    await post("/api/setup");
    toast("Preparing tools…");
  });

  $("#btn-validate").addEventListener("click", async () => {
    const key = $("#license-input").value.trim();
    if (!key) { toast("Enter a license code first"); return; }
    $("#btn-validate").disabled = true;
    $("#btn-validate").textContent = "Checking…";
    const r = await post("/api/license/validate", { license_key: key });
    if (!r.ok && r.retryable) toast(r.error || "Network problem — try again", 5000);
    await poll();
  });
  $("#license-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#btn-validate").click();
  });

  $("#btn-refresh").addEventListener("click", async () => {
    await post("/api/device/refresh");
    await poll();
  });

  $("#btn-dfu-start").addEventListener("click", async () => {
    await post("/api/dfu/start");
    await poll();
    toast("Timer started — hold Power + Home now");
  });
  $("#btn-dfu-retry").addEventListener("click", async () => {
    await post("/api/dfu/retry");
    await poll();
    toast("Restarted — hold Power + Home now");
  });

  $("#btn-ramdisk").addEventListener("click", async () => {
    await post("/api/ramdisk");
    toast("Booting ramdisk… watch the log");
  });
  $("#btn-activator").addEventListener("click", async () => {
    await post("/api/activator");
    toast("Running activator…");
  });
  $("#btn-verify").addEventListener("click", async () => {
    await post("/api/verify");
    toast("Checking activation state…");
  });

  $("#pop-check").addEventListener("change", () => {
    $("#instance-preview").textContent = instanceName();
  });

  $("#btn-burn").addEventListener("click", async () => {
    const pop = $("#pop-check").checked;
    if (!confirm(`Burn one license code?\n\nInstance: ${instanceName()}\n\n` +
                 `This consumes an unlock and cannot be undone automatically.`)) return;
    await post("/api/burn", { proof_of_purchase: pop });
    await poll();
  });

  $("#btn-burn-retry").addEventListener("click", async () => {
    await post("/api/burn/retry");
    toast("Retrying burn…");
  });

  $("#btn-repeat").addEventListener("click", async () => {
    const r = await post("/api/repeat");
    if (!r.ok) { toast(r.error || "No unlocks remaining"); return; }
    await poll();
    forcedPanel = null;
    toast("Next device — detection running");
  });

  $("#btn-diag").addEventListener("click", async () => {
    const r = await post("/api/diagnostics", {});
    try {
      if (navigator.clipboard && r.text) await navigator.clipboard.writeText(r.text);
      toast(`Diagnostics copied — file saved to ${r.path}`);
    } catch (e) {
      toast(`Diagnostics saved to ${r.path}`);
    }
  });

  $("#btn-clear-log").addEventListener("click", () => {
    visibleLogKey = null;
    $("#log").innerHTML = "";
  });
}

/* ----------------------------------------------------------------- init */

bind();
poll();
setInterval(poll, 700);
