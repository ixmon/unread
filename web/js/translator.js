// UI for translate.html. The model runs in a Web Worker (js/translator-worker.js).
//
// Model location (default: Hugging Face Hub, int8 ONNX, Transformers.js layout):
//   default            -> DEFAULT_REMOTE_MODEL on huggingface.co (onnx/*_quantized.onnx + patched tokenizer.json)
//   ?local=1           -> dev override: local files at web/models/atf-to-english/ (gitignored, not deployed)
//   ?model=<hf-id>     -> another Hub repo, e.g. ?model=montycrypto/atf-to-english
//   ?model=<name>      -> a local folder web/models/<name>/ (no slash = local)
//   ?dtype=fp32|q8     -> weights variant (default q8 = int8 *_quantized.onnx)
//   ?revision=<sha|tag>-> pin a Hub revision (default from model-choice: B2c or Compact v4e)
//                        ?revision=v4e-2026-10-11 loads the previous ~94 MB T5-small build
//   ?id=P123456[&from=N] -> prefill the textarea with ATF lines (bundled data/texts/<id>.json, else /api/text/<id>)
//   window.UNREAD_TRANSLATOR_CONFIG = {model, dtype, revision, localModelPath, remoteHost} also works
//   (remoteHost is for tests/mirrors only: a server laid out like huggingface.co/<model>/resolve/<rev>/…).
import {
  DEFAULT_REMOTE_MODEL,
  MODELS,
  resolveChoice,
  openModelModal,
  mountModelSelect,
  modelLabelFor,
  setSavedChoice,
  isV4eRevision,
  B2C_REVISION,
  V4E_REVISION,
} from "./model-choice.js";

export { DEFAULT_REMOTE_MODEL, B2C_REVISION as DEFAULT_REVISION, V4E_REVISION, MODELS };
export const MODEL_VERSION = MODELS.b2c.versionLabel;
export const V4E_MODEL_VERSION = MODELS.v4e.versionLabel;
export const V4E_SHA = "2889e854d3cd1fd8a8d963f2fb0284f80d113339";

const LOCAL_MODEL = "atf-to-english";
const PREFILL_LIMIT = 48;
const params = new URLSearchParams(location.search);

const baseCfg = Object.assign(
  {
    model: params.get("model") || (params.get("local") === "1" ? LOCAL_MODEL : DEFAULT_REMOTE_MODEL),
    dtype: params.get("dtype") || "q8",
    revision: params.get("revision") || null, // filled after choice
    localModelPath: new URL("models/", location.href).href,
    remoteHost: null,
  },
  window.UNREAD_TRANSLATOR_CONFIG || {},
);

let choice = resolveChoice(params);
// Custom ?model= (non-default repo / local name) skips the B2c/v4e chooser.
if (baseCfg.model !== DEFAULT_REMOTE_MODEL && !params.get("revision")) {
  choice = {
    id: null,
    custom: true,
    model: baseCfg.model,
    revision: baseCfg.revision || (params.get("model") ? "main" : B2C_REVISION),
    fromUrl: true,
    needsPrompt: false,
    versionLabel: baseCfg.model,
    shortLabel: baseCfg.model,
  };
}

let cfg = buildCfg(choice);
let MODEL_LABEL = labelFor(cfg, choice);

const $ = (s) => document.querySelector(s);
$("#model-id").textContent = cfg.model;
$("#model-src").textContent = srcText(cfg);
let prefill = null; // {text, labels} when lines came from ?id=

let worker = null;
const files = new Map();
let running = false;
let stopRequested = false;
let pending = null;
/** @type {{atf: string, en: string, modelId: string, label: string}[]} */
let translationLog = [];
let selectApi = null;
let choiceReady = null; // Promise resolved once modal (if any) finishes

function buildCfg(ch) {
  const c = {
    ...baseCfg,
    model: ch.custom ? ch.model : (baseCfg.model.includes("/") || params.get("local") === "1" ? baseCfg.model : DEFAULT_REMOTE_MODEL),
    revision: ch.revision || baseCfg.revision || B2C_REVISION,
  };
  // local folder name (no slash) when ?local=1 or ?model=name without slash
  if (!c.model.includes("/") && params.get("local") !== "1" && !ch.custom) {
    c.model = DEFAULT_REMOTE_MODEL;
  }
  c.remote = c.model.includes("/");
  return c;
}

function labelFor(c, ch) {
  if (ch && ch.id && !ch.custom) return modelLabelFor(ch.id, c.dtype);
  const ver = isV4eRevision(c.revision) ? MODELS.v4e.versionLabel : (ch?.versionLabel || MODELS.b2c.versionLabel);
  return `${ver} ${c.dtype === "q8" ? "int8" : c.dtype}` +
    (c.remote ? ` (${c.model}${c.revision !== "main" ? `@${(/^[0-9a-f]{7,}$/i.test(c.revision) ? c.revision.slice(0, 7) : c.revision)}` : ""})` : " (local files)");
}

function srcText(c) {
  return c.remote
    ? `${c.remoteHost ? c.remoteHost : "Hugging Face Hub"}${c.revision !== "main" ? ` @ ${c.revision}` : ""}`
    : `local: ${c.localModelPath}${c.model}/`;
}

function currentModelId() {
  if (choice.id) return choice.id;
  return isV4eRevision(cfg.revision) ? "v4e" : "b2c";
}

function sizeHint(id) {
  const m = MODELS[id] || MODELS.b2c;
  return `≈${m.sizeMB} MB download on first use, then cached`;
}

function setStatus(t) { $("#status").textContent = t; }
function progress(pct, label) {
  $("#progress").hidden = false;
  $("#progress-fill").style.width = `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`;
  $("#progress-label").textContent = label;
}

function bindWorker(w) {
  w.onmessage = (e) => {
    const m = e.data;
    if (m.type === "download") {
      if (m.file) files.set(m.file, { loaded: m.loaded || 0, total: m.total || 0 });
      let loaded = 0, total = 0;
      for (const f of files.values()) { loaded += f.loaded; total += f.total; }
      if (total) progress((loaded / total) * 100, `Downloading model ${(loaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`);
    } else if (m.type === "ready") {
      setStatus(`Model ready (${m.ms} ms load) · ${MODEL_LABEL}.`);
    } else if (m.type === "result" || m.type === "error") {
      pending?.(m);
      pending = null;
    }
  };
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./translator-worker.js", import.meta.url), { type: "module" });
  bindWorker(worker);
  return worker;
}

function killWorker() {
  if (worker) {
    try { worker.terminate(); } catch (_) { /* ignore */ }
    worker = null;
  }
  files.clear();
  pending = null;
}

function translateOne(line) {
  return new Promise((resolve) => {
    pending = resolve;
    ensureWorker().postMessage({ type: "translate", text: line });
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function applyChoice(ch) {
  choice = ch;
  cfg = buildCfg(ch);
  MODEL_LABEL = labelFor(cfg, choice);
  $("#model-id").textContent = cfg.model;
  $("#model-src").textContent = srcText(cfg);
  const id = currentModelId();
  setStatus(`Model not loaded yet (${sizeHint(id)}).`);
  if (selectApi) selectApi.setValue(id);
  // Expose for tests / toolbar
  window.__translatorChoice = { id, revision: cfg.revision, label: MODEL_LABEL, cfg };
}

async function ensureChoice() {
  if (choiceReady) return choiceReady;
  choiceReady = (async () => {
    if (choice.needsPrompt && !choice.custom) {
      const id = await openModelModal({ preselect: choice.id || undefined });
      applyChoice({ id, custom: false, model: DEFAULT_REMOTE_MODEL, fromUrl: false, needsPrompt: false, ...MODELS[id] });
    } else {
      // Persist device/url resolution so the reader toolbar matches.
      if (choice.id && !choice.fromUrl) setSavedChoice(choice.id);
      else if (choice.id && choice.fromUrl) { /* URL wins; don't overwrite unless user picks */ }
      else if (choice.id) setSavedChoice(choice.id);
      applyChoice(choice);
    }
    return currentModelId();
  })();
  return choiceReady;
}

function switchModel(id) {
  if (running) {
    setStatus("Stop the current run before switching models.");
    if (selectApi) selectApi.setValue(currentModelId());
    return;
  }
  const prev = currentModelId();
  if (id === prev && choice.id === id) return;
  setSavedChoice(id);
  killWorker();
  // Keep prior rows but they stay tagged with data-model; clear the live result pane for a clean run.
  const out = $("#results");
  if (out) {
    // Archive note at top if there were unlabelled rows from the previous model
    out.querySelectorAll(".result-row:not([data-model])").forEach((row) => {
      row.dataset.model = prev;
    });
  }
  applyChoice({ id, custom: false, model: DEFAULT_REMOTE_MODEL, fromUrl: false, needsPrompt: false, ...MODELS[id] });
  $("#draft-label").hidden = true;
  setStatus(`Switched to ${MODELS[id].label}. ${sizeHint(id)}. Previous lines stay labelled with the model that produced them.`);
  $("#progress").hidden = true;
}

async function run() {
  await ensureChoice();
  const raw = $("#atf-input").value;
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const labels = prefill && prefill.text === raw ? prefill.labels : null;
  if (!lines.length) return setStatus("Nothing to translate.");
  running = true; stopRequested = false;
  $("#btn-run").disabled = true; $("#btn-stop").disabled = false;
  const out = $("#results");
  // Keep prior model outputs above a separator so caches don't look mixed.
  if (out.children.length) {
    const sep = document.createElement("div");
    sep.className = "results-sep";
    sep.textContent = `—— ${MODEL_LABEL} ——`;
    out.appendChild(sep);
  }
  const modelId = currentModelId();
  const rows = lines.map((l, i) => {
    const row = document.createElement("div");
    row.className = "result-row";
    row.dataset.model = modelId;
    row.dataset.modelLabel = MODEL_LABEL;
    row.innerHTML = `<div class="res-n">${escapeHtml(labels?.[i] ?? String(i + 1))}</div><div class="res-atf">${escapeHtml(l)}</div><div class="res-en pending"><span class="res-model-tag">${escapeHtml(MODELS[modelId]?.shortLabel || modelId)}</span>…</div>`;
    out.appendChild(row);
    return row;
  });
  ensureWorker().postMessage({ type: "load", cfg });
  for (let i = 0; i < lines.length && !stopRequested; i++) {
    setStatus(`Translating line ${i + 1} / ${lines.length} with ${MODELS[modelId]?.shortLabel || modelId}…`);
    const r = await translateOne(lines[i]);
    const cell = rows[i].querySelector(".res-en");
    cell.classList.remove("pending");
    const tag = `<span class="res-model-tag">${escapeHtml(MODELS[modelId]?.shortLabel || modelId)}</span>`;
    if (r.type === "error") { cell.innerHTML = `${tag}Error: ${escapeHtml(r.error)}`; cell.classList.add("err"); break; }
    cell.innerHTML = `${tag}${escapeHtml(r.text)}`;
    translationLog.push({ atf: lines[i], en: r.text, modelId, label: MODEL_LABEL });
    progress(((i + 1) / lines.length) * 100, `Translated ${i + 1} / ${lines.length} lines (${MODELS[modelId]?.shortLabel || modelId})`);
  }
  const date = new Date().toISOString().slice(0, 10);
  const dl = $("#draft-label");
  dl.hidden = false;
  dl.textContent = `Machine draft, model ${MODEL_LABEL}, ${date}. Not a scholarly translation; verify against a published edition.`;
  setStatus(stopRequested ? "Stopped." : `Done (${MODELS[modelId]?.shortLabel || modelId}).`);
  running = false;
  $("#btn-run").disabled = false; $("#btn-stop").disabled = true;
  window.__lastTranslations = rows.map((r) => {
    const cell = r.querySelector(".res-en");
    const tag = cell.querySelector(".res-model-tag");
    const text = tag ? cell.textContent.slice(tag.textContent.length).trim() : cell.textContent;
    return { text, modelId: r.dataset.model, modelLabel: r.dataset.modelLabel };
  });
  window.__translationLog = translationLog.slice();
}

// Corpus API (same as search.html / map.html): same-origin /api on the live site, the public API elsewhere.
const TEXT_API = (
  params.get("textapi") ||
  (location.hostname.endsWith("unreadatlas.com") || location.hostname === "localhost" || location.hostname === "127.0.0.1"
    ? `${location.origin}/api`
    : "https://unreadatlas.com/api")
);

async function loadBundled(id) {
  try {
    const man = await fetch("data/texts/manifest.json").then((r) => (r.ok ? r.json() : []));
    if (!man.some((m) => m.id === id)) return null;
    const res = await fetch(`data/texts/${encodeURIComponent(id)}.json`);
    if (!res.ok) return null;
    const t = await res.json();
    return { ...t, atf_source: t.atf_source ? `CDLI, ${t.atf_source}` : "CDLI" };
  } catch (_) {
    return null;
  }
}

/** /api/text/<id>, adapted to {id, designation, atf_source, lines:[{type,n,atf,surface}]}; or {withheld}. */
async function loadFromApi(id) {
  const res = await fetch(`${TEXT_API}/text/${encodeURIComponent(id).replace(/%3A/gi, ":")}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(res.status === 404 ? "not found in the corpus" : `HTTP ${res.status}`);
  const d = await res.json();
  const eds = d.editions || [];
  const hasAtf = (e) => !e.atf_withheld && Array.isArray(e.lines) && e.lines.some((l) => l.atf);
  const ed = eds.find(hasAtf);
  if (!ed) {
    const why = [...new Set(eds.map((e) => e.atf_withheld && `${e.source?.name || e.src}: ${e.atf_withheld}`).filter(Boolean))];
    return { id: d.id || id, designation: eds[0]?.designation, withheld: why.join(" ") || "No transliteration in the corpus for this tablet." };
  }
  return {
    id: d.id || id,
    designation: ed.designation,
    atf_source: ed.source?.name || ed.src,
    lines: ed.lines.filter((l) => l.atf).map((l) => ({ type: "line", n: l.n, atf: l.atf, surface: l.surface || "" })),
  };
}

async function prefillFromText(id, from) {
  if (!id || id.length > 200) return;
  const prevStatus = $("#status").textContent, loadingMsg = `Loading ATF for ${id}…`;
  setStatus(loadingMsg);
  try {
    const t = (await loadBundled(id)) || (await loadFromApi(id));
    const src = $("#prefill-src");
    if (t.withheld) {
      $("#atf-input").value = "";
      if (src) {
        src.hidden = false;
        src.innerHTML = `<strong>No ATF to load for <a href="map.html?id=${encodeURIComponent(t.id)}">${escapeHtml(t.designation || t.id)}</a>.</strong> ` +
          `${escapeHtml(t.withheld)} <a href="search.html?text=${encodeURIComponent(t.id)}">Catalogue record</a>`;
      }
      return setStatus(`ATF for ${id} can't be shown on this site.`);
    }
    const all = (t.lines || []).filter((l) => l.type === "line" && l.atf);
    const start = Math.max(0, Math.min(from, all.length));
    const chunk = all.slice(start, start + PREFILL_LIMIT);
    if (!chunk.length) return setStatus(`No untranslated ATF lines left in ${id}.`);
    const text = chunk.map((l) => l.atf).join("\n");
    $("#atf-input").value = text;
    if ($("#status").textContent === loadingMsg) setStatus(prevStatus);
    const SURF = { obverse: "o", reverse: "r" };
    const surf = (x) => (x ? SURF[x] ?? x.split(/\s+/).map((w) => w[0]).join("") : "");
    prefill = { text, labels: chunk.map((l) => `${surf(l.surface)} ${l.n ?? ""}`.trim()) };
    if (src) {
      src.hidden = false;
      src.innerHTML = `Loaded ATF lines ${start + 1}–${start + chunk.length} of ${all.length} from
        <a href="map.html?id=${encodeURIComponent(t.id)}">${escapeHtml(t.designation || t.id)}</a>
        (transliteration: ${escapeHtml(t.atf_source || "CDLI")}).
        ${start + chunk.length < all.length ? `<a href="?${escapeHtml(String(new URLSearchParams({ ...Object.fromEntries(params), from: String(start + chunk.length) })))}">Next ${Math.min(PREFILL_LIMIT, all.length - start - chunk.length)} lines</a>` : ""}`;
    }
  } catch (err) {
    setStatus(`Could not load ATF for ${id}: ${err.message || err}`);
  }
}

function mountToolbar() {
  const host = $("#model-toolbar");
  if (!host) return;
  selectApi = mountModelSelect(host, {
    value: currentModelId(),
    onChange: (id) => switchModel(id),
  });
}

$("#btn-run").addEventListener("click", () => { if (!running) run(); });
$("#btn-stop").addEventListener("click", () => { stopRequested = true; });

// Boot: resolve choice (modal if needed), mount toolbar, optional prefill/autorun.
const prefillReady = params.get("id")
  ? prefillFromText(params.get("id"), parseInt(params.get("from") || "0", 10) || 0)
  : Promise.resolve();

choiceReady = ensureChoice().then(() => {
  mountToolbar();
  return prefillReady;
}).then(() => {
  if (params.get("autorun") === "1") run();
});

// Test hooks
window.__ensureChoice = ensureChoice;
window.__switchModel = switchModel;
window.__openModelModal = openModelModal;
