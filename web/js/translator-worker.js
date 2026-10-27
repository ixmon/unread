// Web Worker: loads the ATF->English T5 model with Transformers.js v3 and translates one line per request.
import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5";
import { modelInput, decode, PREFIX } from "./tokfix.js";

// Note: Transformers.js 3.7 has no beam search; num_beams is ignored and decoding is greedy
// (verified: output == PyTorch greedy, token for token). Python/server drafts use 4 beams.
// repetition_penalty 1.2 matches the B2c / v4e generation_config.
// no_repeat_ngram_size is deliberately off: n-gram 3 cost ~3 BLEU (ATF formulae repeat legitimately).
// The Python drafts' custom loop-block processor is not available in Transformers.js.
const GEN_B2C = { num_beams: 4, max_new_tokens: 256, early_stopping: true, repetition_penalty: 1.2 };
const GEN_V4E = { num_beams: 4, max_new_tokens: 100, early_stopping: true, repetition_penalty: 1.2 };

// Hub tag of the previous T5-small browser build; also selectable via ?revision=v4e-2026-10-11.
const V4E_TAG = "v4e-2026-10-11";
const V4E_SHA = "2889e854d3cd1fd8a8d963f2fb0284f80d113339";

function isV4e(cfg) {
  const r = cfg.revision || "";
  return r === V4E_TAG || r === V4E_SHA || r.startsWith("2889e854");
}

let pipePromise = null;

function load(cfg) {
  if (pipePromise) return pipePromise;
  if (cfg.remote) {
    env.allowRemoteModels = true;
    env.allowLocalModels = false;
    if (cfg.remoteHost) env.remoteHost = cfg.remoteHost; // mirrors / tests (huggingface.co layout)
  } else {
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = cfg.localModelPath;
  }
  const t0 = performance.now();
  pipePromise = pipeline("text2text-generation", cfg.model, {
    dtype: cfg.dtype,
    revision: cfg.revision || "main",
    progress_callback: (p) => {
      if (p.status === "progress" || p.status === "done" || p.status === "initiate") {
        self.postMessage({
          type: "download",
          file: p.file,
          loaded: p.status === "initiate" ? 0 : (p.loaded ?? 0),
          total: p.total || 0,
          status: p.status,
        });
      }
    },
  }).then((p) => {
    self.postMessage({ type: "ready", ms: Math.round(performance.now() - t0), v4e: isV4e(cfg) });
    return p;
  });
  pipePromise.catch(() => { pipePromise = null; });
  return pipePromise;
}

let cfgSeen = null;
self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "load") { cfgSeen = m.cfg; load(m.cfg); return; }
    if (m.type === "translate") {
      const pipe = await load(cfgSeen);
      const v4e = isV4e(cfgSeen);
      // B2c: Unicode ATF → CDLI-ASCII + &-escapes (tokfix). v4e: prefix + raw text (legacy browser path).
      const prompt = v4e ? (PREFIX + m.text) : modelInput(m.text);
      const out = await pipe(prompt, v4e ? GEN_V4E : GEN_B2C);
      const text = v4e ? out[0].generated_text : decode(out[0].generated_text);
      self.postMessage({ type: "result", text });
    }
  } catch (err) {
    self.postMessage({ type: "error", error: String(err?.message || err) });
  }
};
