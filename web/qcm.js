import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ComfyUI-QueueControlMax: queue manager docked on the right side of ComfyUI.

const PREFS_KEY = "qcm.prefs.v1";
const HISTORY_PAGE = 40;

const prefs = loadPrefs();
const state = {
  paused: false, running: [], pending: [], parkedCount: 0, parked: [],
  history: [], historyTotal: 0, historyLoading: false,
  search: "", progress: null, settings: null, saves: [], importState: null, menu: null,
};
let panel = null, topButtons = null, lightbox = null;

function loadPrefs() {
  try {
    return { open: false, width: 440, tab: "queue", view: "list", histStatus: "", starred: false, ...JSON.parse(localStorage.getItem(PREFS_KEY)) };
  } catch {
    return { open: false, width: 440, tab: "queue", view: "list", histStatus: "", starred: false };
  }
}

function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* storage unavailable */ }
}

// ── small helpers ────────────────────────────────────────────────
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

const post = (path, data) => api.fetchApi(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data ?? {}) });
const getJson = async (path) => (await api.fetchApi(path)).json();

function toast(detail, severity = "info") {
  const t = app.extensionManager?.toast;
  if (t) t.add({ severity, summary: "Queue", detail, life: 4000 });
  else console.log("[QueueControlMax]", detail);
}

const fileQuery = (f) => `filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder ?? "")}&type=${encodeURIComponent(f.type ?? "output")}`;
const thumbUrl = (f) => api.apiURL(`/qcm/thumb?${fileQuery(f)}&size=320`);
const viewUrl = (f) => api.apiURL(`/view?${fileQuery(f)}`);
const isVideo = (f) => /\.(mp4|webm|mov|mkv|gif)$/i.test(f.filename);

function ago(ts) {
  if (!ts) return "";
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts * 1000).toLocaleString();
}

const dur = (s) => (s == null ? "" : s < 60 ? `${s.toFixed(0)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`);

// ── actions ──────────────────────────────────────────────────────
async function openWorkflow(id, name) {
  try {
    const job = await getJson(`/qcm/job/${encodeURIComponent(id)}`);
    const title = name || `Job ${id.replace(/^file:.*\//, "").slice(0, 24)}`;
    if (job.workflow) await app.loadGraphData(job.workflow, true, true, title);
    else if (job.prompt) await app.loadApiJson(job.prompt, title);
    else return toast("This job has no saved workflow.", "warn");
    toast("Workflow opened in a new tab.", "success");
  } catch (e) {
    console.error("[QueueControlMax]", e);
    toast("Could not open the workflow.", "error");
  }
}

async function copyPrompt(text) {
  try {
    await navigator.clipboard.writeText(text || "");
    toast("Prompt copied.", "success");
  } catch {
    toast("Clipboard is not available.", "warn");
  }
}

async function reveal(f) {
  const r = await post("/qcm/reveal", f);
  if (!r.ok) toast("File not found on disk.", "warn");
}

async function setPaused(paused) {
  const r = await (await post("/qcm/pause", { paused })).json();
  state.paused = r.paused;
  render();
}

async function move(id, to) {
  await post("/qcm/move", { id, to });
  refreshQueue();
}

// ── data ─────────────────────────────────────────────────────────
let queueTimer = null;
function refreshQueueSoon() {
  clearTimeout(queueTimer);
  queueTimer = setTimeout(refreshQueue, 150);
}

async function refreshQueue() {
  try {
    const q = await getJson("/qcm/queue");
    Object.assign(state, { paused: q.paused, running: q.running, pending: q.pending, parkedCount: q.parked });
    if (!state.running.length) state.progress = null;
  } catch (e) {
    console.warn("[QueueControlMax] queue refresh failed", e);
  }
  updateTopButtons();
  render();
}

async function refreshParked() {
  state.parked = await getJson("/qcm/parked");
  render();
}

async function refreshHistory(reset = true) {
  if (state.historyLoading) return;
  state.historyLoading = true;
  try {
    const offset = reset ? 0 : state.history.length;
    const params = new URLSearchParams({ offset, limit: HISTORY_PAGE, search: state.search, status: prefs.histStatus, starred: prefs.starred ? "1" : "0" });
    const r = await getJson(`/qcm/history?${params}`);
    state.history = reset ? r.items : state.history.concat(r.items);
    state.historyTotal = r.total;
  } finally {
    state.historyLoading = false;
  }
  render();
}

async function pollStatus() {
  try {
    const s = await getJson("/qcm/status");
    for (const n of s.notices) toast(n, "info");
    const wasImporting = state.importState?.running;
    state.importState = s.import;
    if (wasImporting && !s.import.running) {
      toast(`Imported ${s.import.added} past image entries into the history.`, "success");
      refreshHistory(true);
    }
    if (s.paused !== state.paused) { state.paused = s.paused; updateTopButtons(); }
    if (prefs.open && (s.import.running || wasImporting)) render();
  } catch { /* server restarting */ }
}

// ── rendering ────────────────────────────────────────────────────
function chips(e, extra) {
  const row = h("div", { class: "qcm-chips" });
  if (extra) row.append(extra);
  if (e.workflow_name) row.append(h("button", { class: "qcm-chip wf", title: "Filter by this workflow", onclick: () => setSearch(e.workflow_name) }, e.workflow_name));
  if (e.model) row.append(h("span", { class: "qcm-chip model", title: "Model" }, e.model));
  for (const l of e.loras ?? []) row.append(h("span", { class: "qcm-chip lora", title: "LoRA" }, `${l.name} ×${l.strength}`));
  return row;
}

function promptBlock(e) {
  const t = h("div", { class: "qcm-prompt", title: "Click to expand" }, e.positive || "(no prompt text)");
  t.addEventListener("click", () => t.classList.toggle("open"));
  const parts = [t];
  if (e.negative) parts.push(h("div", { class: "qcm-neg" }, "Negative: " + e.negative));
  const meta = [e.size, e.settings].filter(Boolean).join(" · ");
  if (meta) parts.push(h("div", { class: "qcm-meta" }, meta));
  return parts;
}

function iconBtn(label, title, onclick, cls = "") {
  return h("button", { class: "qcm-btn " + cls, title, "aria-label": title, onclick }, label);
}

function matchesSearch(e) {
  const hay = `${e.positive} ${e.model} ${e.workflow_name} ${(e.loras ?? []).map((l) => l.name).join(" ")}`.toLowerCase();
  return state.search.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

function setSearch(text) {
  state.search = text;
  if (panel) panel.querySelector(".qcm-search").value = text;
  if (prefs.tab === "history") refreshHistory(true);
  else render();
}

function runningCard() {
  const r = state.running[0];
  if (!r) return h("div", { class: "qcm-idle" }, state.paused ? "Paused - nothing is running." : "Nothing running.");
  const pct = state.progress && state.progress.max ? Math.round((100 * state.progress.value) / state.progress.max) : null;
  return h("div", { class: "qcm-card running" },
    chips(r, h("span", { class: "qcm-chip state run" }, "Running")),
    promptBlock(r),
    h("div", { class: "qcm-progress" }, h("div", { class: "qcm-progress-bar", style: `width:${pct ?? 0}%` })),
    h("div", { class: "qcm-actions" },
      pct != null ? h("span", { class: "qcm-meta" }, `Step ${state.progress.value}/${state.progress.max}`) : null,
      iconBtn("Open workflow", "Open this job's workflow in a new tab", () => openWorkflow(r.id, r.workflow_name)),
      iconBtn("Copy prompt", "Copy the prompt", () => copyPrompt(r.positive)),
      iconBtn("Stop", "Interrupt the running job", () => post("/interrupt", { prompt_id: r.id }), "danger")));
}

let dragId = null;
function queueCard(e, i, total) {
  const card = h("div", { class: "qcm-card", draggable: "true" },
    chips(e, h("span", { class: "qcm-chip state" + (e.front ? " front" : ""), title: e.front ? "Sent to the front (Shift+Run)" : "" }, `#${i + 1}`)),
    promptBlock(e),
    h("div", { class: "qcm-actions" },
      iconBtn("⤒", "Move to the top", () => move(e.id, "top"), i === 0 ? "dim" : ""),
      iconBtn("↑", "Move up one", () => move(e.id, "up"), i === 0 ? "dim" : ""),
      iconBtn("↓", "Move down one", () => move(e.id, "down"), i === total - 1 ? "dim" : ""),
      iconBtn("⤓", "Move to the bottom", () => move(e.id, "bottom"), i === total - 1 ? "dim" : ""),
      iconBtn("Open workflow", "Open this job's workflow in a new tab", () => openWorkflow(e.id, e.workflow_name)),
      iconBtn("Copy prompt", "Copy the prompt", () => copyPrompt(e.positive)),
      iconBtn("Park", "Take it out of the queue and keep it in Parked to run later", async () => { await post("/qcm/park", { ids: [e.id] }); refreshQueue(); }),
      iconBtn("✕", "Remove from the queue", async () => { await post("/qcm/delete", { ids: [e.id] }); refreshQueue(); }, "danger")));
  card.addEventListener("dragstart", (ev) => { dragId = e.id; ev.dataTransfer.effectAllowed = "move"; card.classList.add("dragging"); });
  card.addEventListener("dragend", () => { dragId = null; card.classList.remove("dragging"); });
  card.addEventListener("dragover", (ev) => { if (dragId && dragId !== e.id) { ev.preventDefault(); card.classList.add("drop"); } });
  card.addEventListener("dragleave", () => card.classList.remove("drop"));
  card.addEventListener("drop", (ev) => { ev.preventDefault(); card.classList.remove("drop"); if (dragId && dragId !== e.id) move(dragId, i); });
  return card;
}

function parkedCard(e) {
  const run = async (front) => { await post("/qcm/unpark", { ids: [e.id], front, client_id: api.clientId }); refreshParked(); refreshQueue(); };
  return h("div", { class: "qcm-card" },
    chips(e, h("span", { class: "qcm-chip state" }, "Parked")),
    e.note ? h("div", { class: "qcm-note" }, e.note) : null,
    promptBlock(e),
    h("div", { class: "qcm-actions" },
      iconBtn("Run", "Add to the end of the queue", () => run(false), "primary"),
      iconBtn("Run next", "Add to the front of the queue", () => run(true)),
      iconBtn("Open workflow", "Open this job's workflow in a new tab", () => openWorkflow(e.id, e.workflow_name)),
      iconBtn("Copy prompt", "Copy the prompt", () => copyPrompt(e.positive)),
      iconBtn("✕", "Delete this parked job", async () => { await post("/qcm/parked/delete", { ids: [e.id] }); refreshParked(); refreshQueue(); }, "danger")));
}

const STATUS_LABEL = { success: "Done", error: "Failed", interrupted: "Stopped" };

function historyCard(e, flatIndex) {
  const thumbs = h("div", { class: "qcm-thumbs" });
  (e.outputs ?? []).slice(0, 8).forEach((f, k) => {
    thumbs.append(isVideo(f)
      ? h("button", { class: "qcm-thumb video", title: f.filename, onclick: () => openLightbox(flatIndex + k) }, "▶")
      : h("img", { class: "qcm-thumb", loading: "lazy", alt: f.filename, title: f.filename, src: thumbUrl(f), onclick: () => openLightbox(flatIndex + k) }));
  });
  if ((e.outputs ?? []).length > 8) thumbs.append(h("span", { class: "qcm-more" }, `+${e.outputs.length - 8}`));
  const label = e.source === "imported" ? "Imported" : STATUS_LABEL[e.status] ?? e.status;
  const cls = e.status === "success" ? "ok" : e.status === "error" ? "err" : "";
  return h("div", { class: "qcm-card" },
    e.outputs?.length ? thumbs : null,
    chips(e, h("span", { class: `qcm-chip state ${cls}` }, label)),
    promptBlock(e),
    h("div", { class: "qcm-meta" }, [ago(e.finished_at), dur(e.duration)].filter(Boolean).join(" · ")),
    h("div", { class: "qcm-actions" },
      iconBtn("Open workflow", "Open the exact workflow that made this (same prompt, LoRAs, seed)", () => openWorkflow(e.id, e.workflow_name), "primary"),
      iconBtn("Copy prompt", "Copy the prompt", () => copyPrompt(e.positive)),
      iconBtn("Run again", "Queue this exact job again (same seed)", async () => {
        const r = await post("/qcm/history/requeue", { id: e.id, client_id: api.clientId });
        const j = await r.json();
        toast(j.error ? "Could not queue: " + j.error : "Queued again.", j.error ? "error" : "success");
        refreshQueue();
      }),
      e.outputs?.length ? iconBtn("Folder", "Show the image in its folder", () => reveal(e.outputs[0])) : null,
      iconBtn(e.starred ? "★" : "☆", "Star (starred entries survive 'Clear history')", async () => {
        e.starred = !e.starred;
        await post("/qcm/history/star", { id: e.id, starred: e.starred });
        render();
      }, e.starred ? "on" : ""),
      iconBtn("✕", "Remove from history (the image files stay)", async () => {
        await post("/qcm/history/delete", { ids: [e.id] });
        state.history = state.history.filter((x) => x.id !== e.id);
        state.historyTotal--;
        render();
      }, "danger")));
}

// every image of the loaded history entries, in order, for the lightbox and grid view
function flatImages() {
  const out = [];
  for (const e of state.history) for (const f of e.outputs ?? []) out.push({ f, e });
  return out;
}

function listBody() {
  const list = h("div", { class: "qcm-list" });
  if (prefs.tab === "queue") {
    const items = state.pending.filter(matchesSearch);
    if (!items.length) list.append(h("p", { class: "qcm-empty" }, state.pending.length ? "No queued job matches the filter." : "The queue is empty."));
    items.forEach((e) => list.append(queueCard(e, state.pending.indexOf(e), state.pending.length)));
  } else if (prefs.tab === "parked") {
    const items = state.parked.filter(matchesSearch);
    if (!items.length) list.append(h("p", { class: "qcm-empty" }, "Nothing parked. Use Park on a queued job to keep it here for later."));
    items.forEach((e) => list.append(parkedCard(e)));
  } else {
    if (prefs.view === "grid") {
      const grid = h("div", { class: "qcm-grid" });
      flatImages().forEach(({ f }, k) => grid.append(isVideo(f)
        ? h("button", { class: "qcm-thumb video", title: f.filename, onclick: () => openLightbox(k) }, "▶")
        : h("img", { class: "qcm-thumb", loading: "lazy", alt: f.filename, src: thumbUrl(f), onclick: () => openLightbox(k) })));
      list.append(grid);
    } else {
      let k = 0;
      for (const e of state.history) {
        list.append(historyCard(e, k));
        k += (e.outputs ?? []).length;
      }
    }
    if (!state.history.length && !state.historyLoading) list.append(h("p", { class: "qcm-empty" }, "No finished jobs yet. Settings ⚙ → Import past images to add what is already in your output folder."));
    if (state.history.length < state.historyTotal) {
      list.append(h("button", { class: "qcm-btn qcm-loadmore", onclick: () => refreshHistory(false) }, `Load more (${state.historyTotal - state.history.length} left)`));
    }
  }
  return list;
}

function menuBody() {
  if (state.menu === "saves") {
    return h("div", { class: "qcm-menu" },
      h("div", { class: "qcm-menu-title" }, "Saved queues"),
      state.saves.length ? null : h("p", { class: "qcm-empty" }, "No saved queues yet."),
      state.saves.map((s) => h("div", { class: "qcm-menu-row" },
        h("span", { class: "qcm-grow" }, `${s.name} (${s.count})`),
        iconBtn("Load", "Add these jobs to the end of the queue", async () => {
          const r = await (await post("/qcm/load", { name: s.name, client_id: api.clientId })).json();
          toast(`Loaded ${r.added} job(s)` + (r.parked ? `, ${r.parked} moved to Parked (invalid)` : ""), "success");
          state.menu = null; refreshQueue();
        }, "primary"),
        iconBtn("✕", "Delete this save", async () => { await post("/qcm/saves/delete", { name: s.name }); state.saves = await getJson("/qcm/saves"); render(); }, "danger"))));
  }
  if (state.menu === "settings") {
    const st = state.settings ?? {};
    const imp = state.importState;
    const sel = h("select", { class: "qcm-select", onchange: async (ev) => { state.settings = await (await post("/qcm/settings", { resume_after_restore: ev.target.value })).json(); } },
      h("option", { value: "crash" }, "Only after a crash (launcher sets QCM_RESTARTED_AFTER_CRASH)"),
      h("option", { value: "always" }, "Always resume automatically"),
      h("option", { value: "never" }, "Never - stay paused"));
    sel.value = st.resume_after_restore ?? "crash";
    return h("div", { class: "qcm-menu" },
      h("div", { class: "qcm-menu-title" }, "Settings"),
      h("label", { class: "qcm-field" }, h("span", {}, "When the queue is restored at startup, resume it:"), sel),
      h("div", { class: "qcm-menu-row" },
        h("span", { class: "qcm-grow" }, imp?.running ? `Importing past images… ${imp.done}/${imp.total}` : "Add images already in your output folder to the history (reads the workflow saved inside each PNG)."),
        iconBtn("Import past images", "Scan the output folder", async () => { await post("/qcm/history/import_outputs"); pollStatus(); }, imp?.running ? "dim" : "")),
      h("div", { class: "qcm-menu-row" },
        h("span", { class: "qcm-grow" }, "Clear the history list (starred entries and image files are kept)."),
        iconBtn("Clear history", "Clear history", async () => {
          if (!confirm("Clear the history list? Starred entries and the image files themselves are kept.")) return;
          await post("/qcm/history/clear", { keep_starred: true });
          refreshHistory(true);
        }, "danger")));
  }
  return null;
}

function render() {
  if (!panel || !prefs.open) return;
  const body = panel.querySelector(".qcm-body");
  const scroll = body.querySelector(".qcm-list")?.scrollTop ?? 0;
  const pauseBtn = panel.querySelector(".qcm-pause");
  pauseBtn.textContent = state.paused ? "▶ Resume" : "⏸ Pause";
  pauseBtn.classList.toggle("paused", state.paused);
  panel.querySelector(".qcm-count").textContent = `${state.running.length} running · ${state.pending.length} waiting`;
  for (const [tab, label] of [["queue", `Queue (${state.pending.length})`], ["parked", `Parked (${state.parkedCount})`], ["history", `History (${state.historyTotal})`]]) {
    const b = panel.querySelector(`.qcm-tab[data-tab=${tab}]`);
    b.textContent = label;
    b.classList.toggle("on", prefs.tab === tab);
  }
  const histTools = panel.querySelector(".qcm-histtools");
  histTools.hidden = prefs.tab !== "history";
  histTools.querySelector(".qcm-status").value = prefs.histStatus;
  histTools.querySelector(".qcm-starred").classList.toggle("on", prefs.starred);
  histTools.querySelector(".qcm-view").textContent = prefs.view === "grid" ? "▤ List" : "▦ Grid";
  body.replaceChildren(runningCard(), ...[menuBody()].filter(Boolean), listBody());
  const list = body.querySelector(".qcm-list");
  if (list) list.scrollTop = scroll;
}

// ── lightbox ─────────────────────────────────────────────────────
function openLightbox(index) {
  const images = flatImages();
  if (!images.length) return;
  closeLightbox();
  let i = Math.max(0, Math.min(index, images.length - 1));
  lightbox = h("div", { class: "qcm-lightbox", onclick: (ev) => { if (ev.target === lightbox) closeLightbox(); } });
  const paint = () => {
    const { f, e } = images[i];
    lightbox.replaceChildren(
      h("div", { class: "qcm-lb-stage" },
        isVideo(f) ? h("video", { src: viewUrl(f), controls: true, autoplay: true, loop: true }) : h("img", { src: viewUrl(f), alt: f.filename })),
      h("button", { class: "qcm-lb-nav prev", title: "Previous (←)", onclick: () => { i = (i - 1 + images.length) % images.length; paint(); } }, "‹"),
      h("button", { class: "qcm-lb-nav next", title: "Next (→)", onclick: () => { i = (i + 1) % images.length; paint(); } }, "›"),
      h("div", { class: "qcm-lb-bar" },
        h("div", { class: "qcm-lb-prompt" }, e.positive || f.filename),
        h("div", { class: "qcm-actions" },
          h("span", { class: "qcm-meta" }, `${i + 1} / ${images.length}${images.length < state.historyTotal ? "+" : ""}`),
          iconBtn("Open workflow", "Open the workflow that made this image", () => { closeLightbox(); openWorkflow(e.id, e.workflow_name); }, "primary"),
          iconBtn("Copy prompt", "Copy the prompt", () => copyPrompt(e.positive)),
          iconBtn("Folder", "Show in folder", () => reveal(f)),
          h("a", { class: "qcm-btn", href: viewUrl(f), target: "_blank", rel: "noopener", title: "Open full size in a new browser tab" }, "Full size"),
          iconBtn("✕", "Close (Esc)", closeLightbox))));
  };
  lightbox.qcmKey = (ev) => {
    if (ev.key === "Escape") closeLightbox();
    else if (ev.key === "ArrowLeft") { i = (i - 1 + images.length) % images.length; paint(); }
    else if (ev.key === "ArrowRight") { i = (i + 1) % images.length; paint(); }
    else return;
    ev.preventDefault();
    ev.stopPropagation();
  };
  window.addEventListener("keydown", lightbox.qcmKey, true);
  document.body.append(lightbox);
  paint();
}

function closeLightbox() {
  if (!lightbox) return;
  window.removeEventListener("keydown", lightbox.qcmKey, true);
  lightbox.remove();
  lightbox = null;
}

// ── panel shell ──────────────────────────────────────────────────
function buildPanel() {
  panel = h("div", { class: "qcm-panel", hidden: true });
  const handle = h("div", { class: "qcm-resize", title: "Drag to resize" });
  const search = h("input", { type: "search", class: "qcm-search", placeholder: "Filter by prompt, model, LoRA or workflow…", "aria-label": "Filter jobs" });
  let searchTimer = null;
  search.addEventListener("input", () => {
    state.search = search.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => (prefs.tab === "history" ? refreshHistory(true) : render()), 250);
  });
  const fileInput = h("input", { type: "file", accept: ".json,application/json", hidden: true });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const r = await (await post("/qcm/import", { data, client_id: api.clientId })).json();
      toast(`Imported ${r.added} job(s)` + (r.parked ? `, ${r.parked} moved to Parked (invalid)` : ""), "success");
      refreshQueue();
    } catch {
      toast("That file is not a queue export.", "error");
    }
  });
  const toggleMenu = async (name) => {
    state.menu = state.menu === name ? null : name;
    if (state.menu === "saves") state.saves = await getJson("/qcm/saves");
    if (state.menu === "settings") state.settings = await getJson("/qcm/settings");
    render();
  };
  panel.append(
    handle,
    h("div", { class: "qcm-head" },
      h("div", { class: "qcm-titlerow" },
        h("strong", { class: "qcm-title" }, "Queue"),
        h("span", { class: "qcm-count qcm-meta" }),
        h("span", { class: "qcm-grow" }),
        iconBtn("⚙", "Settings", () => toggleMenu("settings")),
        iconBtn("✕", "Close panel (Alt+Q)", () => setOpen(false))),
      h("div", { class: "qcm-toolbar" },
        h("button", { class: "qcm-btn qcm-pause", title: "Pause / resume the queue (the running job finishes)", onclick: () => setPaused(!state.paused) }),
        iconBtn("Save", "Save the waiting queue under a name", async () => {
          const name = prompt("Name for this saved queue:", new Date().toLocaleString().replace(/[/:]/g, "-"));
          if (name == null) return;
          const r = await (await post("/qcm/save", { name })).json();
          toast(`Saved ${r.count} job(s) as "${r.name}".`, "success");
        }),
        iconBtn("Saves ▾", "Load or delete saved queues", () => toggleMenu("saves")),
        iconBtn("Export", "Download the waiting queue as a file", () => window.open(api.apiURL("/qcm/export"), "_blank")),
        iconBtn("Import", "Add jobs from an exported file", () => fileInput.click()),
        iconBtn("Clear", "Remove every waiting job (the running one continues)", async () => {
          if (!confirm(`Remove all ${state.pending.length} waiting jobs? (Tip: Save first if you might want them back.)`)) return;
          await post("/qcm/clear");
          refreshQueue();
        }, "danger"),
        fileInput),
      h("div", { class: "qcm-tabs" },
        ...["queue", "parked", "history"].map((tab) => h("button", { class: "qcm-tab", "data-tab": tab, onclick: () => setTab(tab) }))),
      search,
      h("div", { class: "qcm-histtools" },
        h("select", { class: "qcm-select qcm-status", onchange: (ev) => { prefs.histStatus = ev.target.value; savePrefs(); refreshHistory(true); } },
          h("option", { value: "" }, "All"), h("option", { value: "done" }, "Done"), h("option", { value: "failed" }, "Failed / stopped")),
        iconBtn("★ Starred", "Show only starred", () => { prefs.starred = !prefs.starred; savePrefs(); refreshHistory(true); }, "qcm-starred"),
        iconBtn("▦ Grid", "Switch between list and image grid", () => { prefs.view = prefs.view === "grid" ? "list" : "grid"; savePrefs(); render(); }, "qcm-view"),
        iconBtn("↻", "Refresh", () => refreshHistory(true)))),
    h("div", { class: "qcm-body" }));

  handle.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    const startX = ev.clientX, startW = prefs.width;
    const onMove = (e) => { prefs.width = Math.max(320, Math.min(window.innerWidth * 0.7, startW + (startX - e.clientX))); applyWidth(); };
    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); savePrefs(); window.dispatchEvent(new Event("resize")); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  const dock = document.querySelector(".comfyui-body-right");
  if (dock) dock.append(panel);
  else { panel.classList.add("floating"); document.body.append(panel); }
}

function applyWidth() {
  if (panel) panel.style.width = `${prefs.width}px`;
}

function setTab(tab) {
  prefs.tab = tab;
  state.menu = null;
  savePrefs();
  if (tab === "parked") refreshParked();
  if (tab === "history") refreshHistory(true);
  render();
}

function setOpen(open) {
  prefs.open = open;
  savePrefs();
  if (!panel) buildPanel();
  panel.hidden = !open;
  applyWidth();
  updateTopButtons();
  window.dispatchEvent(new Event("resize"));
  if (open) {
    refreshQueue();
    if (prefs.tab === "history") refreshHistory(true);
    if (prefs.tab === "parked") refreshParked();
  }
}

// ── top bar ──────────────────────────────────────────────────────
async function addTopButtons() {
  try {
    const { ComfyButton } = await import("../../scripts/ui/components/button.js");
    const { ComfyButtonGroup } = await import("../../scripts/ui/components/buttonGroup.js");
    const pause = new ComfyButton({ icon: "pause", content: "Pause", tooltip: "Pause / resume the queue", action: () => setPaused(!state.paused), classList: "comfyui-button qcm-top-pause" });
    const queue = new ComfyButton({ icon: "format-list-numbered", content: "Queue", tooltip: "Show / hide the queue panel (Alt+Q)", action: () => setOpen(!prefs.open), classList: "comfyui-button" });
    topButtons = { pause, queue };
    app.menu?.settingsGroup.element.before(new ComfyButtonGroup(pause.element, queue.element).element);
    updateTopButtons();
  } catch (e) {
    console.warn("[QueueControlMax] could not add top-bar buttons; use Alt+Q", e);
  }
}

function updateTopButtons() {
  if (!topButtons) return;
  const { pause, queue } = topButtons;
  pause.icon = state.paused ? "play" : "pause";
  pause.content = state.paused ? "Resume" : "Pause";
  pause.element.classList.toggle("paused", state.paused);
  queue.content = `Queue (${state.pending.length + state.running.length})`;
  queue.element.classList.toggle("on", prefs.open);
}

// remember which workflow tab each job came from
function tagWorkflowName() {
  const orig = api.fetchApi.bind(api);
  api.fetchApi = async (route, options) => {
    if (route === "/prompt" && options?.method === "POST" && typeof options.body === "string") {
      try {
        const body = JSON.parse(options.body);
        const name = app.extensionManager?.workflow?.activeWorkflow?.filename;
        if (name && body.prompt) {
          body.extra_data = { ...(body.extra_data ?? {}), qcm_workflow_name: name };
          options = { ...options, body: JSON.stringify(body) };
        }
      } catch { /* leave the request untouched */ }
    }
    return orig(route, options);
  };
}

function css() {
  const style = document.createElement("style");
  style.textContent = `
  .qcm-panel { position:relative; height:100%; box-sizing:border-box; display:flex; flex-direction:column; min-width:320px;
    background: var(--comfy-menu-bg, #202020); color: var(--fg-color, #ddd); border-left:1px solid var(--border-color, #444); font-size:13px; }
  .qcm-panel.floating { position:fixed; right:0; top:var(--qcm-top, 40px); bottom:0; z-index:1000; box-shadow:-6px 0 18px rgba(0,0,0,.35); }
  .qcm-panel[hidden] { display:none; }
  .qcm-resize { position:absolute; left:-4px; top:0; bottom:0; width:8px; cursor:ew-resize; z-index:2; }
  .qcm-head { display:flex; flex-direction:column; gap:8px; padding:10px 12px 8px; border-bottom:1px solid var(--border-color, #444); }
  .qcm-titlerow, .qcm-toolbar, .qcm-tabs, .qcm-histtools, .qcm-actions, .qcm-menu-row { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
  .qcm-histtools[hidden] { display:none; }
  .qcm-title { font-size:15px; }
  .qcm-grow { flex:1; min-width:0; }
  .qcm-body { flex:1; min-height:0; display:flex; flex-direction:column; gap:8px; padding:10px 12px; }
  .qcm-list { flex:1; min-height:0; overflow-y:auto; display:flex; flex-direction:column; gap:8px; padding-right:2px; }
  .qcm-btn { border-radius:6px; padding:5px 9px; font:inherit; font-size:12px; line-height:1.2; cursor:pointer; text-decoration:none;
    border:1px solid var(--border-color, #444); background: var(--comfy-input-bg, #2b2b2b); color: var(--fg-color, #ddd); }
  .qcm-btn:hover { filter:brightness(1.25); }
  .qcm-btn.primary, .qcm-btn.on, .qcm-tab.on { background:#2f6fd6; border-color:#2f6fd6; color:#fff; }
  .qcm-btn.danger:hover { background:#8a2b2b; border-color:#b33; color:#fff; }
  .qcm-btn.dim { opacity:.4; }
  .qcm-pause { background:#2a7a2a; border-color:#3a9a3a; color:#fff; font-weight:600; }
  .qcm-pause.paused { background:#b33; border-color:#d44; }
  .qcm-top-pause.paused { background:#b33 !important; color:#fff !important; }
  .qcm-tab { flex:1; border-radius:6px; padding:6px 4px; font:inherit; font-size:12px; cursor:pointer; border:1px solid var(--border-color, #444);
    background: var(--comfy-input-bg, #2b2b2b); color: var(--fg-color, #ddd); }
  .qcm-search, .qcm-select { background: var(--comfy-input-bg, #222); color: var(--input-text, #ddd); border:1px solid var(--border-color, #444);
    border-radius:6px; padding:6px 8px; font:inherit; font-size:12px; box-sizing:border-box; }
  .qcm-search { width:100%; }
  .qcm-panel :is(button, input, select, a):focus-visible { outline:2px solid #2f6fd6; outline-offset:1px; }
  .qcm-card { border:1px solid var(--border-color, #444); border-radius:8px; padding:9px; display:flex; flex-direction:column; gap:7px; background: rgba(255,255,255,.02); }
  .qcm-card.running { border-color:#2f6fd6; background: rgba(47,111,214,.08); }
  .qcm-card.dragging { opacity:.4; }
  .qcm-card.drop { border-color:#2f6fd6; box-shadow: inset 0 3px 0 #2f6fd6; }
  .qcm-card[draggable=true] { cursor:grab; }
  .qcm-chips { display:flex; flex-wrap:wrap; gap:4px; }
  .qcm-chip { font-size:11px; padding:1px 7px; border-radius:999px; border:1px solid var(--border-color, #555); overflow-wrap:anywhere; background:transparent; color:inherit; font-family:inherit; }
  .qcm-chip.wf { background:#2f4f3a; border-color:#3f8e4b; color:#fff; cursor:pointer; }
  .qcm-chip.model { background:#1f3b66; border-color:#2f6fd6; color:#fff; }
  .qcm-chip.lora { background:#4a2a52; border-color:#a1309b; color:#fff; }
  .qcm-chip.state { background:#333; }
  .qcm-chip.state.run { background:#2f6fd6; color:#fff; }
  .qcm-chip.state.front { background:#2a7a2a; color:#fff; }
  .qcm-chip.state.ok { background:#2a5a2a; color:#fff; }
  .qcm-chip.state.err { background:#8a2b2b; color:#fff; }
  .qcm-prompt { white-space:pre-wrap; overflow-wrap:anywhere; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; cursor:pointer; line-height:1.4; }
  .qcm-prompt.open { -webkit-line-clamp:unset; }
  .qcm-neg { font-size:11px; color:#e0a0a0; overflow-wrap:anywhere; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .qcm-note { font-size:12px; color:#ffb4a8; }
  .qcm-meta { font-size:11px; color: var(--descrip-text, #999); overflow-wrap:anywhere; font-variant-numeric: tabular-nums; }
  .qcm-empty, .qcm-idle { color: var(--descrip-text, #999); font-size:12px; margin:4px 0; }
  .qcm-progress { height:4px; border-radius:4px; background: var(--border-color, #444); overflow:hidden; }
  .qcm-progress-bar { height:100%; background:#2f6fd6; transition: width .2s; }
  .qcm-thumbs { display:flex; gap:6px; overflow-x:auto; padding-bottom:2px; }
  .qcm-thumb { width:88px; height:88px; flex:none; object-fit:cover; border-radius:6px; cursor:zoom-in; background:#111; border:1px solid var(--border-color, #444); }
  .qcm-thumb.video { display:flex; align-items:center; justify-content:center; color:#fff; font-size:20px; }
  .qcm-more { align-self:center; font-size:12px; color: var(--descrip-text, #999); }
  .qcm-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap:6px; }
  .qcm-grid .qcm-thumb { width:100%; height:auto; aspect-ratio:1; }
  .qcm-loadmore { align-self:center; margin:6px 0 12px; }
  .qcm-menu { border:1px solid var(--border-color, #444); border-radius:8px; padding:10px; display:flex; flex-direction:column; gap:8px; background: rgba(0,0,0,.2); }
  .qcm-menu-title { font-weight:600; }
  .qcm-field { display:flex; flex-direction:column; gap:4px; font-size:12px; }
  .qcm-lightbox { position:fixed; inset:0; z-index:10000; background:rgba(0,0,0,.88); display:flex; flex-direction:column; }
  .qcm-lb-stage { flex:1; min-height:0; display:flex; align-items:center; justify-content:center; padding:16px 60px 0; }
  .qcm-lb-stage :is(img, video) { max-width:100%; max-height:100%; object-fit:contain; box-shadow:0 8px 30px rgba(0,0,0,.6); }
  .qcm-lb-nav { position:absolute; top:45%; width:44px; height:64px; border:none; border-radius:8px; background:rgba(255,255,255,.12); color:#fff; font-size:34px; cursor:pointer; }
  .qcm-lb-nav.prev { left:10px; } .qcm-lb-nav.next { right:10px; }
  .qcm-lb-bar { padding:10px 16px 14px; display:flex; flex-direction:column; gap:8px; color:#eee; font-size:13px; }
  .qcm-lb-prompt { max-height:4.2em; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; }
  @media (prefers-reduced-motion: reduce) { .qcm-progress-bar { transition:none; } }
  `;
  document.head.append(style);
}

app.registerExtension({
  name: "QueueControlMax",
  commands: [{ id: "QueueControlMax.toggle", label: "Toggle queue panel", icon: "pi pi-list", function: () => setOpen(!prefs.open) }],
  keybindings: [{ combo: { key: "q", alt: true }, commandId: "QueueControlMax.toggle" }],
  async setup() {
    css();
    tagWorkflowName();
    await addTopButtons();
    api.addEventListener("status", refreshQueueSoon);
    api.addEventListener("reconnected", () => { refreshQueue(); pollStatus(); });
    api.addEventListener("execution_start", refreshQueueSoon);
    api.addEventListener("progress", ({ detail }) => {
      state.progress = { value: detail.value, max: detail.max };
      const bar = panel?.querySelector(".qcm-progress-bar");
      if (bar && detail.max) bar.style.width = `${Math.round((100 * detail.value) / detail.max)}%`;
    });
    for (const ev of ["execution_success", "execution_error", "execution_interrupted"]) {
      api.addEventListener(ev, () => setTimeout(() => { refreshQueue(); if (prefs.open && prefs.tab === "history") refreshHistory(true); else refreshHistoryCount(); }, 700));
    }
    await refreshQueue();
    refreshHistoryCount();
    if (prefs.open) setOpen(true);
    pollStatus();
    setInterval(pollStatus, 3000);
    setInterval(() => { if (prefs.open) refreshQueue(); }, 5000);
  },
});

async function refreshHistoryCount() {
  try {
    const r = await getJson("/qcm/history?limit=1");
    state.historyTotal = r.total;
    render();
  } catch { /* ignore */ }
}
