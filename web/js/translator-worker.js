// Web Worker: loads the ATF->English T5 model with Transformers.js v3 and translates one line per request.
import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5";

const PREFIX = "translate Akkadian to English: ";
// Note: Transformers.js 3.7 has no beam search; num_beams is ignored and decoding is greedy
// (verified: output == PyTorch greedy, token for token). Python/server drafts use 4 beams.
// repetition_penalty 1.2 matches the v4e reference decoding (also in the model's generation_config.json).
// no_repeat_ngram_size is deliberately off: n-gram 3 cost ~3 BLEU (ATF formulae repeat legitimately).
// The Python drafts' custom loop-block processor is not available in Transformers.js.
const GEN = { num_beams: 4, max_new_tokens: 100, early_stopping: true, repetition_penalty: 1.2 };
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
      if (p.status === "progress" || p.status === "done")
        self.postMessage({ type: "download", file: p.file, loaded: p.loaded ?? p.total, total: p.total });
    },
  }).then((p) => {
    self.postMessage({ type: "ready", ms: Math.round(performance.now() - t0) });
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
      const out = await pipe(PREFIX + m.text, GEN);
      self.postMessage({ type: "result", text: out[0].generated_text });
    }
  } catch (err) {
    self.postMessage({ type: "error", error: String(err?.message || err) });
  }
};
