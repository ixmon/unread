// UI for translate.html. The model runs in a Web Worker (js/translator-worker.js).
//
// Model location (default: Hugging Face Hub, int8 ONNX, Transformers.js layout):
//   default            -> DEFAULT_REMOTE_MODEL on huggingface.co (onnx/*_quantized.onnx + patched tokenizer.json)
//   ?local=1           -> dev override: local files at web/models/atf-to-english/ (gitignored, not deployed)
//   ?model=<hf-id>     -> another Hub repo, e.g. ?model=montycrypto/atf-to-english
//   ?model=<name>      -> a local folder web/models/<name>/ (no slash = local)
//   ?dtype=fp32|q8     -> weights variant (default q8 = int8 *_quantized.onnx)
//   ?revision=<sha>    -> pin a Hub revision (default "main")
//   ?id=P123456[&from=N] -> prefill the textarea with ATF lines of data/texts/<id>.json
//   window.UNREAD_TRANSLATOR_CONFIG = {model, dtype, revision, localModelPath, remoteHost} also works
//   (remoteHost is for tests/mirrors only: a server laid out like huggingface.co/<model>/resolve/<rev>/…).
export const DEFAULT_REMOTE_MODEL = "montycrypto/atf-to-english-onnx";
const LOCAL_MODEL = "atf-to-english";
const PREFILL_LIMIT = 48;
const params = new URLSearchParams(location.search);
const cfg = Object.assign(
  {
    model: params.get("model") || (params.get("local") === "1" ? LOCAL_MODEL : DEFAULT_REMOTE_MODEL),
    dtype: params.get("dtype") || "q8",
    revision: params.get("revision") || "main",
    localModelPath: new URL("models/", location.href).href,
    remoteHost: null,
  },
  window.UNREAD_TRANSLATOR_CONFIG || {},
);
cfg.remote = cfg.model.includes("/"); // HF ids look like owner/name
const MODEL_LABEL =
  `atf-en-best-v2 ${cfg.dtype === "q8" ? "int8" : cfg.dtype}` +
  (cfg.remote ? ` (${cfg.model}${cfg.revision !== "main" ? `@${cfg.revision.slice(0, 7)}` : ""})` : " (local files)");

const $ = (s) => document.querySelector(s);
$("#model-id").textContent = cfg.model;
$("#model-src").textContent = cfg.remote
  ? `${cfg.remoteHost ? cfg.remoteHost : "Hugging Face Hub"}${cfg.revision !== "main" ? ` @ ${cfg.revision}` : ""}`
  : `local: ${cfg.localModelPath}${cfg.model}/`;
let prefill = null; // {text, labels} when lines came from ?id=

const worker = new Worker(new URL("./translator-worker.js", import.meta.url), { type: "module" });
const files = new Map();
let running = false;
let stopRequested = false;
let pending = null;

function setStatus(t) { $("#status").textContent = t; }
function progress(pct, label) {
  $("#progress").hidden = false;
  $("#progress-fill").style.width = `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`;
  $("#progress-label").textContent = label;
}

worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === "download") {
    if (m.file) files.set(m.file, { loaded: m.loaded || 0, total: m.total || 0 });
    let loaded = 0, total = 0;
    for (const f of files.values()) { loaded += f.loaded; total += f.total; }
    if (total) progress((loaded / total) * 100, `Downloading model ${(loaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`);
  } else if (m.type === "ready") {
    setStatus(`Model ready (${m.ms} ms load).`);
  } else if (m.type === "result" || m.type === "error") {
    pending?.(m);
    pending = null;
  }
};

function translateOne(line) {
  return new Promise((resolve) => {
    pending = resolve;
    worker.postMessage({ type: "translate", text: line });
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function run() {
  const raw = $("#atf-input").value;
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const labels = prefill && prefill.text === raw ? prefill.labels : null;
  if (!lines.length) return setStatus("Nothing to translate.");
  running = true; stopRequested = false;
  $("#btn-run").disabled = true; $("#btn-stop").disabled = false;
  const out = $("#results");
  out.innerHTML = "";
  const rows = lines.map((l, i) => {
    const row = document.createElement("div");
    row.className = "result-row";
    row.innerHTML = `<div class="res-n">${escapeHtml(labels?.[i] ?? String(i + 1))}</div><div class="res-atf">${escapeHtml(l)}</div><div class="res-en pending">…</div>`;
    out.appendChild(row);
    return row;
  });
  worker.postMessage({ type: "load", cfg });
  for (let i = 0; i < lines.length && !stopRequested; i++) {
    setStatus(`Translating line ${i + 1} / ${lines.length}…`);
    const r = await translateOne(lines[i]);
    const cell = rows[i].querySelector(".res-en");
    cell.classList.remove("pending");
    if (r.type === "error") { cell.textContent = `Error: ${r.error}`; cell.classList.add("err"); break; }
    cell.textContent = r.text;
    progress(((i + 1) / lines.length) * 100, `Translated ${i + 1} / ${lines.length} lines`);
  }
  const date = new Date().toISOString().slice(0, 10);
  const dl = $("#draft-label");
  dl.hidden = false;
  dl.textContent = `Machine draft, model ${MODEL_LABEL}, ${date}. Not a scholarly translation; verify against a published edition.`;
  setStatus(stopRequested ? "Stopped." : "Done.");
  running = false;
  $("#btn-run").disabled = false; $("#btn-stop").disabled = true;
  window.__lastTranslations = rows.map((r) => r.querySelector(".res-en").textContent); // for tests
}

async function prefillFromText(id, from) {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return;
  try {
    const res = await fetch(`data/texts/${encodeURIComponent(id)}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const t = await res.json();
    const all = (t.lines || []).filter((l) => l.type === "line" && l.atf);
    const start = Math.max(0, Math.min(from, all.length));
    const chunk = all.slice(start, start + PREFILL_LIMIT);
    if (!chunk.length) return setStatus(`No untranslated ATF lines left in ${id}.`);
    const text = chunk.map((l) => l.atf).join("\n");
    $("#atf-input").value = text;
    const SURF = { obverse: "o", reverse: "r" };
    const surf = (x) => (x ? SURF[x] ?? x.split(/\s+/).map((w) => w[0]).join("") : "");
    prefill = { text, labels: chunk.map((l) => `${surf(l.surface)} ${l.n ?? ""}`.trim()) };
    const src = $("#prefill-src");
    if (src) {
      src.hidden = false;
      src.innerHTML = `Loaded ATF lines ${start + 1}–${start + chunk.length} of ${all.length} from
        <a href="index.html?id=${encodeURIComponent(t.id)}">${escapeHtml(t.designation || t.id)}</a>
        (transliteration: CDLI${t.atf_source ? `, ${escapeHtml(t.atf_source)}` : ""}).
        ${start + chunk.length < all.length ? `<a href="?${new URLSearchParams({ ...Object.fromEntries(params), from: String(start + chunk.length) })}">Next ${Math.min(PREFILL_LIMIT, all.length - start - chunk.length)} lines</a>` : ""}`;
    }
  } catch (err) {
    setStatus(`Could not load ATF for ${id}: ${err.message || err}`);
  }
}

$("#btn-run").addEventListener("click", () => { if (!running) run(); });
$("#btn-stop").addEventListener("click", () => { stopRequested = true; });
const prefillReady = params.get("id") ? prefillFromText(params.get("id"), parseInt(params.get("from") || "0", 10) || 0) : Promise.resolve();
prefillReady.then(() => { if (params.get("autorun") === "1") run(); });
