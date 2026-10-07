// UI for translate.html. The model runs in a Web Worker (js/translator-worker.js).
//
// Model location is configurable:
//   default            -> local files at web/models/atf-to-english/ (env.allowRemoteModels=false)
//   ?model=<hf-id>     -> load from Hugging Face Hub, e.g. ?model=montycrypto/atf-to-english
//                        (needs an onnx/ folder in that repo)
//   ?dtype=fp32|q8     -> weights variant (default q8 = int8 *_quantized.onnx)
//   window.UNREAD_TRANSLATOR_CONFIG = {model, dtype, localModelPath} also works.
const params = new URLSearchParams(location.search);
const cfg = Object.assign(
  {
    model: params.get("model") || "atf-to-english",
    dtype: params.get("dtype") || "q8",
    localModelPath: new URL("models/", location.href).href,
  },
  window.UNREAD_TRANSLATOR_CONFIG || {},
);
cfg.remote = cfg.model.includes("/"); // HF ids look like owner/name
const MODEL_LABEL = `atf-en-best-v2 ${cfg.dtype === "q8" ? "int8" : cfg.dtype}`;

const $ = (s) => document.querySelector(s);
$("#model-id").textContent = cfg.model;
$("#model-src").textContent = cfg.remote ? "Hugging Face Hub" : `local: ${cfg.localModelPath}${cfg.model}/`;

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
  const lines = $("#atf-input").value.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return setStatus("Nothing to translate.");
  running = true; stopRequested = false;
  $("#btn-run").disabled = true; $("#btn-stop").disabled = false;
  const out = $("#results");
  out.innerHTML = "";
  const rows = lines.map((l, i) => {
    const row = document.createElement("div");
    row.className = "result-row";
    row.innerHTML = `<div class="res-n">${i + 1}</div><div class="res-atf">${escapeHtml(l)}</div><div class="res-en pending">…</div>`;
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

$("#btn-run").addEventListener("click", () => { if (!running) run(); });
$("#btn-stop").addEventListener("click", () => { stopRequested = true; });
if (params.get("autorun") === "1") run();
