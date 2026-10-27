// Shared Web Worker load / translate / progress for translate.html and the reader cog.
import { MODELS, B2C_REVISION, isV4eRevision, DEFAULT_REMOTE_MODEL, modelLabelFor } from "./model-choice.js";

/**
 * @typedef {{
 *   onDownload?: (p: {pct:number, loaded:number, total:number, file?:string, label:string}) => void,
 *   onReady?: (info: {ms:number, label:string}) => void,
 *   onError?: (err: string) => void,
 * }} RuntimeHooks
 */

export function buildCfgForId(id, overrides = {}) {
  const m = MODELS[id] || MODELS.b2c;
  const base = Object.assign(
    {
      model: DEFAULT_REMOTE_MODEL,
      dtype: "q8",
      revision: m.revision || B2C_REVISION,
      localModelPath: new URL("models/", location.href).href,
      remoteHost: null,
      remote: true,
    },
    window.UNREAD_TRANSLATOR_CONFIG || {},
    overrides,
  );
  base.remote = String(base.model).includes("/");
  if (!base.revision) base.revision = m.revision;
  return base;
}

export function createTranslatorRuntime(hooks = {}) {
  let worker = null;
  const files = new Map();
  let pending = null;
  let cfg = null;
  let modelId = null;
  let ready = false;

  function bind(w) {
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === "download") {
        if (m.file) files.set(m.file, { loaded: m.loaded || 0, total: m.total || 0 });
        let loaded = 0, total = 0;
        for (const f of files.values()) { loaded += f.loaded; total += f.total; }
        const pct = total ? (loaded / total) * 100 : 0;
        const label = total
          ? `Downloading ${MODELS[modelId]?.shortLabel || "model"}… ${pct.toFixed(0)}% (${(loaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB)`
          : `Downloading ${MODELS[modelId]?.shortLabel || "model"}…`;
        hooks.onDownload?.({ pct, loaded, total, file: m.file, label });
      } else if (m.type === "ready") {
        ready = true;
        // Cached loads often skip progress events — surface 100%.
        hooks.onDownload?.({
          pct: 100,
          loaded: [...files.values()].reduce((s, f) => s + (f.loaded || f.total || 0), 0),
          total: [...files.values()].reduce((s, f) => s + (f.total || 0), 0) || 1,
          label: `Model ready (${m.ms} ms)`,
        });
        hooks.onReady?.({ ms: m.ms, label: modelLabelFor(modelId) });
      } else if (m.type === "result" || m.type === "error") {
        if (m.type === "error") hooks.onError?.(m.error);
        pending?.(m);
        pending = null;
      }
    };
    w.onerror = (err) => {
      hooks.onError?.(String(err?.message || err));
    };
  }

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(new URL("./translator-worker.js", import.meta.url), { type: "module" });
    bind(worker);
    return worker;
  }

  return {
    get modelId() { return modelId; },
    get ready() { return ready; },
    get label() { return modelId ? modelLabelFor(modelId) : ""; },

    /** Kill worker so the next load() fetches a different revision. */
    reset() {
      if (worker) {
        try { worker.terminate(); } catch (_) { /* ignore */ }
        worker = null;
      }
      files.clear();
      pending = null;
      ready = false;
      cfg = null;
      modelId = null;
    },

    /** Start (or reuse) loading the given model id. */
    load(id, cfgOverrides = {}) {
      if (modelId && modelId !== id) this.reset();
      modelId = id === "v4e" ? "v4e" : "b2c";
      cfg = buildCfgForId(modelId, cfgOverrides);
      files.clear();
      ready = false;
      ensureWorker().postMessage({ type: "load", cfg });
      return cfg;
    },

    translateOne(line) {
      return new Promise((resolve) => {
        pending = resolve;
        ensureWorker().postMessage({ type: "translate", text: line });
      });
    },

    async translateLines(lines, { signal, onLine } = {}) {
      const out = [];
      for (let i = 0; i < lines.length; i++) {
        if (signal?.aborted) break;
        const r = await this.translateOne(lines[i]);
        if (r.type === "error") {
          out.push({ ok: false, error: r.error, atf: lines[i] });
          onLine?.(i, out[i]);
          break;
        }
        out.push({ ok: true, text: r.text, atf: lines[i], modelId });
        onLine?.(i, out[i]);
      }
      return out;
    },
  };
}
