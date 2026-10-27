// Shared B2c vs Compact v4e choice for translate.html and the map.html reader toolbar.
// URL ?revision= / ?model= override; otherwise localStorage; otherwise a device default.

export const STORAGE_KEY = "unread.translator.model";

export const DEFAULT_REMOTE_MODEL = "montycrypto/atf-to-english-onnx";
export const B2C_REVISION = "cb93faed82ce9440a03755ae0a8b12eba0db3bbb";
export const V4E_REVISION = "v4e-2026-10-11";
export const V4E_SHA = "2889e854d3cd1fd8a8d963f2fb0284f80d113339";

/** @typedef {'b2c'|'v4e'} ModelId */

export const MODELS = {
  b2c: {
    id: "b2c",
    label: "B2c",
    shortLabel: "B2c",
    versionLabel: "B2c (2026-10-27)",
    revision: B2C_REVISION,
    sizeMB: 810,
    blurb: "Best quality · ~810 MB download · desktop recommended",
    radioHint: "B2c (best quality, ~810 MB download, desktop recommended)",
  },
  v4e: {
    id: "v4e",
    label: "Compact v4e",
    shortLabel: "v4e",
    versionLabel: "atf-en-best-v4e (2026-10-11)",
    revision: V4E_REVISION,
    sizeMB: 94,
    blurb: "Faster · ~94 MB · for phones / low memory",
    radioHint: "Compact v4e (~94 MB, faster, for phones/low memory)",
  },
};

export function isV4eRevision(rev) {
  const r = String(rev || "");
  return r === V4E_REVISION || r === V4E_SHA || r.startsWith("2889e854");
}

/** Compact on mobile / low memory; B2c otherwise. */
export function preferCompact() {
  try {
    if (typeof navigator !== "undefined") {
      if (typeof navigator.deviceMemory === "number" && navigator.deviceMemory <= 4) return true;
      const ua = navigator.userAgent || "";
      if (/Mobi|Android|iPhone|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua)) return true;
    }
    if (typeof window !== "undefined") {
      if (window.matchMedia) {
        if (window.matchMedia("(max-width: 720px)").matches) return true;
        if (window.matchMedia("(pointer: coarse)").matches && window.matchMedia("(max-width: 1024px)").matches)
          return true;
      }
    }
  } catch (_) { /* ignore */ }
  return false;
}

export function defaultModelId() {
  return preferCompact() ? "v4e" : "b2c";
}

/** @returns {ModelId|null} */
export function getSavedChoice() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "b2c" || v === "v4e") return v;
  } catch (_) { /* private mode */ }
  return null;
}

/** @param {ModelId} id */
export function setSavedChoice(id) {
  if (id !== "b2c" && id !== "v4e") return;
  try { localStorage.setItem(STORAGE_KEY, id); } catch (_) { /* ignore */ }
}

/**
 * Resolve which model to use.
 * URL ?revision= / ?model= wins; else saved choice; else device default.
 * When URL forces a non-default-repo model, returns { custom: true, ... }.
 */
export function resolveChoice(params = new URLSearchParams(typeof location !== "undefined" ? location.search : "")) {
  const urlModel = params.get("model");
  const urlRev = params.get("revision");
  if (urlModel && urlModel !== DEFAULT_REMOTE_MODEL) {
    return {
      id: null,
      custom: true,
      model: urlModel,
      revision: urlRev || "main",
      fromUrl: true,
      needsPrompt: false,
    };
  }
  if (urlRev) {
    const id = isV4eRevision(urlRev) ? "v4e" : "b2c";
    return { id, custom: false, model: DEFAULT_REMOTE_MODEL, revision: urlRev, fromUrl: true, needsPrompt: false, ...MODELS[id] };
  }
  const saved = getSavedChoice();
  if (saved) {
    return { id: saved, custom: false, model: DEFAULT_REMOTE_MODEL, fromUrl: false, needsPrompt: false, ...MODELS[saved] };
  }
  const id = defaultModelId();
  return { id, custom: false, model: DEFAULT_REMOTE_MODEL, fromUrl: false, needsPrompt: true, ...MODELS[id] };
}

function focusable(root) {
  return [...root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
}

/**
 * Show the first-load model chooser. Resolves with the chosen ModelId.
 * @param {{ preselect?: ModelId, title?: string }} [opts]
 * @returns {Promise<ModelId>}
 */
export function openModelModal(opts = {}) {
  const pre = opts.preselect || defaultModelId();
  return new Promise((resolve) => {
    const prev = document.getElementById("model-choice-modal");
    if (prev) prev.remove();

    const wrap = document.createElement("div");
    wrap.id = "model-choice-modal";
    wrap.className = "model-modal-root";
    wrap.innerHTML = `
      <div class="model-modal-backdrop" data-backdrop></div>
      <div class="model-modal" role="dialog" aria-modal="true" aria-labelledby="model-modal-title" tabindex="-1">
        <h2 id="model-modal-title">${opts.title || "Choose a translation model"}</h2>
        <p class="model-modal-lede">The model runs on this device. Pick once — you can change it later in the toolbar.</p>
        <form class="model-modal-form">
          <label class="model-option">
            <input type="radio" name="model" value="b2c" ${pre === "b2c" ? "checked" : ""} />
            <span class="model-option-body">
              <span class="model-option-title">B2c</span>
              <span class="model-option-blurb">${MODELS.b2c.radioHint}</span>
            </span>
          </label>
          <label class="model-option">
            <input type="radio" name="model" value="v4e" ${pre === "v4e" ? "checked" : ""} />
            <span class="model-option-body">
              <span class="model-option-title">Compact v4e</span>
              <span class="model-option-blurb">${MODELS.v4e.radioHint}</span>
            </span>
          </label>
          <div class="model-modal-actions">
            <button type="submit" class="btn primary" data-confirm>Continue</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(wrap);
    document.body.classList.add("model-modal-open");

    const dialog = wrap.querySelector(".model-modal");
    const form = wrap.querySelector("form");
    const previouslyFocused = document.activeElement;

    const close = (id) => {
      wrap.remove();
      document.body.classList.remove("model-modal-open");
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
      resolve(id);
    };

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const id = form.elements.model.value === "v4e" ? "v4e" : "b2c";
      setSavedChoice(id);
      close(id);
    });

    wrap.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        const id = form.elements.model.value === "v4e" ? "v4e" : "b2c";
        setSavedChoice(id);
        close(id);
        return;
      }
      if (e.key !== "Tab") return;
      const nodes = focusable(dialog);
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });

    // Don't dismiss on backdrop click — choosing a model is required before load.
    requestAnimationFrame(() => {
      dialog.focus();
      const checked = form.querySelector('input[name="model"]:checked');
      if (checked) checked.focus();
    });
  });
}

/**
 * Mount a compact <select> for the reader / translator toolbar.
 * @param {HTMLElement} host
 * @param {{ value: ModelId, onChange: (id: ModelId) => void, disabled?: boolean }} opts
 */
export function mountModelSelect(host, opts) {
  host.innerHTML = "";
  host.classList.add("toolbar-group", "model-select-group");
  const label = document.createElement("label");
  label.htmlFor = "model-select";
  label.textContent = "Model";
  const sel = document.createElement("select");
  sel.id = "model-select";
  sel.setAttribute("aria-label", "In-browser translation model");
  sel.title = "Model used by the in-browser translator. Switching downloads the other weights (~810 MB or ~94 MB).";
  for (const m of [MODELS.b2c, MODELS.v4e]) {
    const o = document.createElement("option");
    o.value = m.id;
    o.textContent = `${m.shortLabel} (~${m.sizeMB} MB)`;
    sel.appendChild(o);
  }
  sel.value = opts.value === "v4e" ? "v4e" : "b2c";
  if (opts.disabled) sel.disabled = true;
  sel.addEventListener("change", () => {
    const id = sel.value === "v4e" ? "v4e" : "b2c";
    const other = MODELS[id];
    const ok = window.confirm(
      `Switch to ${other.label}?\n\n${other.blurb}\n\nThe other model will download on first use (then cached). Current translations stay labelled with the model that produced them.`,
    );
    if (!ok) {
      sel.value = opts.value === "v4e" ? "v4e" : "b2c";
      return;
    }
    setSavedChoice(id);
    opts.onChange(id);
  });
  host.appendChild(label);
  host.appendChild(sel);
  return {
    setValue(id) {
      sel.value = id === "v4e" ? "v4e" : "b2c";
      opts.value = id;
    },
    el: sel,
  };
}

export function modelLabelFor(id, dtype = "q8") {
  const m = MODELS[id] || MODELS.b2c;
  const rev = String(m.revision);
  const short = /^[0-9a-f]{7,}$/i.test(rev) ? rev.slice(0, 7) : rev;
  return `${m.versionLabel} ${dtype === "q8" ? "int8" : dtype} (${DEFAULT_REMOTE_MODEL}@${short})`;
}
