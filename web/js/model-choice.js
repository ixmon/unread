// Shared translation-source choice for translate.html and the map.html reader (cog).
// Sources: cached (pre-computed site drafts), B2c in-browser, Compact v4e in-browser.
// URL ?revision= / ?model= override; otherwise localStorage; otherwise a context default.

export const STORAGE_KEY = "unread.translator.model";

export const DEFAULT_REMOTE_MODEL = "montycrypto/atf-to-english-onnx";
export const B2C_REVISION = "cb93faed82ce9440a03755ae0a8b12eba0db3bbb";
export const V4E_REVISION = "v4e-2026-10-11";
export const V4E_SHA = "2889e854d3cd1fd8a8d963f2fb0284f80d113339";

/** @typedef {'cached'|'b2c'|'v4e'} SourceId */
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
    radioHint: "B2c in-browser (best quality, ~810 MB download, desktop recommended)",
  },
  v4e: {
    id: "v4e",
    label: "Compact v4e",
    shortLabel: "v4e",
    versionLabel: "atf-en-best-v4e (2026-10-11)",
    revision: V4E_REVISION,
    sizeMB: 94,
    blurb: "Faster · ~94 MB · for phones / low memory",
    radioHint: "Compact v4e in-browser (~94 MB, faster, for phones/low memory)",
  },
};

export const CACHED = {
  id: "cached",
  label: "Cached translation",
  shortLabel: "cached",
  blurb: "Machine draft already shipped with this text (no download)",
  radioHint: "Cached translation shipped with this text — no download",
};
/** @deprecated use CACHED */
export const CANNED = CACHED;

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
    if (typeof window !== "undefined" && window.matchMedia) {
      if (window.matchMedia("(max-width: 720px)").matches) return true;
      if (window.matchMedia("(pointer: coarse)").matches && window.matchMedia("(max-width: 1024px)").matches)
        return true;
    }
  } catch (_) { /* ignore */ }
  return false;
}

export function defaultModelId() {
  return preferCompact() ? "v4e" : "b2c";
}

/**
 * Default source for the reader: cached when the text has one; else device model
 * (but caller must not auto-download — only preselect in the modal).
 * @param {{ hasCached?: boolean, hasCanned?: boolean }} [ctx]
 * @returns {SourceId}
 */
export function defaultSourceId(ctx = {}) {
  if (ctx.hasCached || ctx.hasCanned) return "cached";
  return defaultModelId();
}

/** @returns {SourceId|null} */
export function getSavedChoice() {
  try {
    let v = localStorage.getItem(STORAGE_KEY);
    // Migrate legacy "canned" → "cached"
    if (v === "canned") {
      try { localStorage.setItem(STORAGE_KEY, "cached"); } catch (_) { /* ignore */ }
      v = "cached";
    }
    if (v === "b2c" || v === "v4e" || v === "cached") return v;
  } catch (_) { /* private mode */ }
  return null;
}

/** @param {SourceId} id */
export function setSavedChoice(id) {
  if (id === "canned") id = "cached"; // accept legacy callers
  if (id !== "b2c" && id !== "v4e" && id !== "cached") return;
  try { localStorage.setItem(STORAGE_KEY, id); } catch (_) { /* ignore */ }
}

/**
 * Resolve which in-browser model to use (translate.html / URL).
 * URL ?revision= / ?model= wins; else saved b2c/v4e; else device default.
 * Saved "cached" is ignored here (no site draft on translate.html) → falls through to device default + prompt.
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
  if (saved === "b2c" || saved === "v4e") {
    return { id: saved, custom: false, model: DEFAULT_REMOTE_MODEL, fromUrl: false, needsPrompt: false, ...MODELS[saved] };
  }
  // saved cached or null → prompt for an in-browser model on translate.html
  const id = defaultModelId();
  return { id, custom: false, model: DEFAULT_REMOTE_MODEL, fromUrl: false, needsPrompt: true, ...MODELS[id] };
}

/**
 * Resolve reader source (cached / b2c / v4e). URL ?revision= forces a browser model.
 * @param {{ hasCached?: boolean, hasCanned?: boolean, params?: URLSearchParams }} opts
 */
export function resolveReaderSource(opts) {
  const params = opts.params || new URLSearchParams(typeof location !== "undefined" ? location.search : "");
  const urlRev = params.get("revision");
  const urlModel = params.get("model");
  const hasCached = !!(opts.hasCached ?? opts.hasCanned);
  if (urlRev || (urlModel && (urlModel === "b2c" || urlModel === "v4e" || urlModel === DEFAULT_REMOTE_MODEL))) {
    let id = "b2c";
    if (urlModel === "v4e" || isV4eRevision(urlRev)) id = "v4e";
    else if (urlModel === "b2c") id = "b2c";
    else if (urlRev) id = isV4eRevision(urlRev) ? "v4e" : "b2c";
    return { id, fromUrl: true, needsPrompt: false };
  }
  // Accept legacy ?model=canned as cached
  if (urlModel === "cached" || urlModel === "canned") return { id: "cached", fromUrl: true, needsPrompt: false };
  const saved = getSavedChoice();
  if (saved === "cached" && hasCached) return { id: "cached", fromUrl: false, needsPrompt: false };
  if (saved === "b2c" || saved === "v4e") return { id: saved, fromUrl: false, needsPrompt: false };
  if (saved === "cached" && !hasCached) {
    // remembered cached but this text has none — fall back to device default, prompt via cog (no auto-download)
    return { id: defaultModelId(), fromUrl: false, needsPrompt: false, awaitingChoice: true };
  }
  if (hasCached) return { id: "cached", fromUrl: false, needsPrompt: false };
  // No cached draft: do not auto-download; show placeholder until the visitor uses the cog.
  return { id: defaultModelId(), fromUrl: false, needsPrompt: false, awaitingChoice: true };
}

function focusable(root) {
  return [...root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
}

/**
 * Model / source chooser modal.
 * @param {{
 *   preselect?: SourceId,
 *   title?: string,
 *   lede?: string,
 *   hasCached?: boolean,
 *   hasCanned?: boolean, // legacy alias of hasCached
 *   allowDismiss?: boolean,
 *   mode?: 'reader'|'translate',
 * }} [opts]
 * @returns {Promise<SourceId|null>} null if dismissed
 */
export function openModelModal(opts = {}) {
  const hasCachedOpt = !!(opts.hasCached ?? opts.hasCanned);
  const mode = opts.mode || (hasCachedOpt ? "reader" : "translate");
  const hasCached = hasCachedOpt && mode === "reader";
  const preRaw = opts.preselect || (hasCached ? "cached" : defaultModelId());
  const pre = preRaw === "canned" ? "cached" : preRaw;
  const allowDismiss = opts.allowDismiss !== false && mode === "reader";

  return new Promise((resolve) => {
    const prev = document.getElementById("model-choice-modal");
    if (prev) prev.remove();

    const options = [];
    if (hasCached) {
      options.push({
        value: "cached",
        title: "Cached translation",
        blurb: CACHED.radioHint,
      });
    }
    options.push(
      { value: "b2c", title: "B2c", blurb: MODELS.b2c.radioHint },
      { value: "v4e", title: "Compact v4e", blurb: MODELS.v4e.radioHint },
    );

    const wrap = document.createElement("div");
    wrap.id = "model-choice-modal";
    wrap.className = "model-modal-root";
    wrap.innerHTML = `
      <div class="model-modal-backdrop" data-backdrop></div>
      <div class="model-modal" role="dialog" aria-modal="true" aria-labelledby="model-modal-title" tabindex="-1">
        <h2 id="model-modal-title">${opts.title || (mode === "reader" ? "Machine translation source" : "Choose a translation model")}</h2>
        <p class="model-modal-lede">${opts.lede || (mode === "reader"
          ? "Pick the English shown in the Machine column. In-browser models download once, then stay cached."
          : "The model runs on this device. Pick once — you can change it later in the toolbar.")}</p>
        <form class="model-modal-form">
          ${options.map((o) => `
          <label class="model-option">
            <input type="radio" name="model" value="${o.value}" ${pre === o.value ? "checked" : ""} />
            <span class="model-option-body">
              <span class="model-option-title">${o.title}</span>
              <span class="model-option-blurb">${o.blurb}</span>
            </span>
          </label>`).join("")}
          <div class="model-modal-actions">
            ${allowDismiss ? `<button type="button" class="btn" data-cancel>Cancel</button>` : ""}
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

    const readId = () => {
      const v = form.elements.model.value;
      if (v === "v4e") return "v4e";
      if (v === "cached" || v === "canned") return "cached";
      return "b2c";
    };

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const id = readId();
      setSavedChoice(id);
      close(id);
    });

    wrap.querySelector("[data-cancel]")?.addEventListener("click", () => close(null));

    wrap.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (allowDismiss) close(null);
        else {
          const id = readId();
          setSavedChoice(id);
          close(id);
        }
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

    requestAnimationFrame(() => {
      dialog.focus();
      const checked = form.querySelector('input[name="model"]:checked');
      if (checked) checked.focus();
    });
  });
}

/**
 * Compact <select> for translate.html toolbar (in-browser models only).
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

export function sourceTag(id) {
  if (id === "cached" || id === "canned") return "cached";
  if (id === "v4e") return "v4e";
  if (id === "b2c") return "B2c";
  return String(id || "");
}
