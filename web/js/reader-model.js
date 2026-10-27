// Reader Machine-column cog: choose cached vs in-browser (B2c / Compact v4e),
// show download progress, label each machine line with its source.
import {
  resolveReaderSource,
  openModelModal,
  setSavedChoice,
  getSavedChoice,
  MODELS,
  CACHED,
  sourceTag,
  modelLabelFor,
} from "./model-choice.js";
import { createTranslatorRuntime } from "./translator-runtime.js";

const LIVE_LIMIT_DEFAULT = 48; // match packaged draft length; tests may lower via window.__readerLiveLimit

let runtime = null;
let abortCtrl = null;
let activeSource = null; // last applied source for current text
let applying = false;

function api() {
  return window.UnreadReader || null;
}

function hasCached(text) {
  if (!text) return false;
  const bridge = api();
  if (typeof bridge?.hasCachedMachine === "function") return !!bridge.hasCachedMachine(text);
  if (typeof bridge?.hasCannedMachine === "function") return !!bridge.hasCannedMachine(text); // legacy
  if ((text.translations || []).some((o) => o.kind === "machine" && (o.english || []).some(Boolean))) return true;
  if (Array.isArray(text.english) && text.english.some(Boolean) && text.english_kind !== "human") return true;
  if (text.has_machine_draft) return true;
  return false;
}

function atfLines(text) {
  if (typeof api()?.getAtfLines === "function") return api().getAtfLines(text);
  return (text.lines || []).filter((l) => l.type === "line" && l.atf).map((l) => l.atf);
}

function findHeads() {
  // Aligned API grid: Machine column header(s)
  const aligned = [...document.querySelectorAll('.lg-head-en[data-key="machine"]')];
  // Packaged / non-aligned English column
  const col = document.querySelector("#col-english");
  const plain = [];
  if (col && col.style.display !== "none") {
    const h = col.querySelector(".col-head");
    if (h) plain.push(h);
  }
  return { aligned, plain };
}

function ensureChrome(head, { aligned }) {
  let tools = head.querySelector(".mt-head-tools");
  if (!tools) {
    tools = document.createElement("span");
    tools.className = "mt-head-tools";
    tools.innerHTML = `
      <span class="mt-source-label" data-mt-source-label></span>
      <div class="mt-progress" data-mt-progress hidden>
        <div class="mt-progress-track">
          <div class="mt-progress-fill" data-mt-progress-fill></div>
        </div>
        <span class="mt-progress-text" data-mt-progress-text
              role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"></span>
      </div>
      <button type="button" class="mt-info" data-mt-info aria-label="Machine draft provenance" title="Machine draft provenance" aria-expanded="false" aria-haspopup="dialog">ⓘ</button>
      <button type="button" class="mt-cog" data-mt-cog aria-label="Choose machine translation source" title="Machine translation source">
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
          <path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.8a.5.5 0 0 0-.49.42l-.36 2.54c-.57.23-1.12.54-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.84a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.14.24.43.34.68.22l2.39-.96c.5.4 1.05.72 1.63.94l.36 2.54c.05.24.25.42.49.42h3.8c.24 0 .44-.18.49-.42l.36-2.54c.57-.23 1.12-.54 1.63-.94l2.39.96c.25.12.54.02.68-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5z"/>
        </svg>
      </button>`;
    if (aligned) {
      // Keep ⓘ on the far right if present; insert tools before it.
      const info = head.querySelector(".lg-info");
      if (info) head.insertBefore(tools, info);
      else head.appendChild(tools);
    } else {
      // Replace the right-hand "model / draft" span with tools (keep left title).
      const spans = [...head.children].filter((el) => el.tagName === "SPAN" && !el.classList.contains("mt-head-tools"));
      if (spans.length >= 2) spans[spans.length - 1].remove();
      head.appendChild(tools);
    }
    tools.querySelector("[data-mt-cog]").addEventListener("click", onCogClick);
    const infoBtn = tools.querySelector("[data-mt-info]");
    if (infoBtn) bindMtInfo(infoBtn);
  }
  return tools;
}

function provenanceText() {
  const fn = api()?.getEnglishProvenance;
  if (typeof fn === "function") {
    const t = fn();
    if (t) return t;
  }
  const text = api()?.getText?.();
  if (!text) return "Machine draft. Unreviewed machine output, not a scholarly translation.";
  const bits = [text.english_note, text.translation_label, text.translation_detail].filter(Boolean);
  return bits.join(" · ") || "Machine draft. Unreviewed machine output, not a scholarly translation.";
}

function closeMtInfo() {
  const pop = document.getElementById("mt-info-pop");
  if (!pop) return;
  const btn = pop._btn;
  pop.remove();
  if (btn) btn.setAttribute("aria-expanded", "false");
}

function openMtInfo(btn) {
  closeMtInfo();
  const pop = document.createElement("div");
  pop.id = "mt-info-pop";
  pop.className = "mt-info-pop";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Machine draft provenance");
  pop._btn = btn;
  const body = provenanceText();
  pop.innerHTML = `<p class="mt-info-pop-body"></p>`;
  pop.querySelector(".mt-info-pop-body").textContent = body;
  document.body.appendChild(pop);
  btn.setAttribute("aria-expanded", "true");
  const r = btn.getBoundingClientRect();
  const w = Math.min(360, window.innerWidth - 16);
  pop.style.width = w + "px";
  pop.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + "px";
  pop.style.top = r.bottom + 6 + "px";
  pop.addEventListener("click", (e) => e.stopPropagation());
}

function bindMtInfo(btn) {
  if (btn.dataset.bound) return;
  btn.dataset.bound = "1";
  let ignoreClick = false;
  const show = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (ignoreClick) return;
    const open = document.getElementById("mt-info-pop");
    if (open && open._btn === btn) closeMtInfo();
    else openMtInfo(btn);
  };
  btn.addEventListener("click", show);
  // Hover (desktop): open on enter, close on leave of btn+popover
  btn.addEventListener("mouseenter", () => {
    if (window.matchMedia("(hover: hover)").matches) openMtInfo(btn);
  });
  btn.addEventListener("mouseleave", () => {
    if (!window.matchMedia("(hover: hover)").matches) return;
    setTimeout(() => {
      const pop = document.getElementById("mt-info-pop");
      if (pop && !pop.matches(":hover") && document.activeElement !== btn) closeMtInfo();
    }, 120);
  });
  // Focus opens for keyboard users; ignore the click that often follows a tap-focus on mobile.
  btn.addEventListener("focus", () => {
    openMtInfo(btn);
    ignoreClick = true;
    setTimeout(() => {
      ignoreClick = false;
    }, 400);
  });
  btn.addEventListener("blur", () => {
    setTimeout(() => {
      const pop = document.getElementById("mt-info-pop");
      if (pop && !pop.contains(document.activeElement) && document.activeElement !== btn) closeMtInfo();
    }, 0);
  });
}

document.addEventListener("click", (e) => {
  const pop = document.getElementById("mt-info-pop");
  if (!pop) return;
  if (e.target.closest && (e.target.closest("#mt-info-pop") || e.target.closest("[data-mt-info]"))) return;
  closeMtInfo();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMtInfo();
});

function setProgress(tools, { pct, label, hidden }) {
  const box = tools.querySelector("[data-mt-progress]");
  const fill = tools.querySelector("[data-mt-progress-fill]");
  const text = tools.querySelector("[data-mt-progress-text]");
  if (!box) return;
  if (hidden) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const v = Math.max(0, Math.min(100, pct || 0));
  fill.style.width = `${v.toFixed(1)}%`;
  text.textContent = label || `${v.toFixed(0)}%`;
  text.setAttribute("aria-valuenow", String(Math.round(v)));
  text.setAttribute("aria-valuetext", label || `${v.toFixed(0)} percent`);
}

function setSourceLabel(tools, id) {
  const el = tools.querySelector("[data-mt-source-label]");
  if (!el) return;
  const tag = sourceTag(id);
  el.textContent = tag;
  el.dataset.source = id || "";
  el.title =
    id === "cached"
      ? CACHED.blurb
      : id === "b2c" || id === "v4e"
        ? MODELS[id].blurb
        : "";
}

function injectChrome(sourceId) {
  const { aligned, plain } = findHeads();
  const heads = [...aligned, ...plain];
  for (const head of heads) {
    const tools = ensureChrome(head, { aligned: aligned.includes(head) });
    setSourceLabel(tools, sourceId);
  }
  // Subtle per-line tags on machine English
  tagMachineLines(sourceId);
  window.__readerModel = sourceId;
  window.__readerSource = sourceId;
}

function tagMachineLines(sourceId) {
  const tag = sourceTag(sourceId);
  if (!tag) return;
  // Packaged english column
  document.querySelectorAll("#english-body .line-en .en-text").forEach((el) => {
    if (el.querySelector(".mt-line-tag")) {
      el.querySelector(".mt-line-tag").textContent = tag;
      return;
    }
    const span = document.createElement("span");
    span.className = "mt-line-tag";
    span.textContent = tag;
    el.prepend(span);
  });
  // Aligned grid machine cells
  document.querySelectorAll(".lg-en.lg-machine .en-text").forEach((el) => {
    if (el.querySelector(".mt-line-tag")) {
      el.querySelector(".mt-line-tag").textContent = tag;
      return;
    }
    const span = document.createElement("span");
    span.className = "mt-line-tag";
    span.textContent = tag;
    el.prepend(span);
  });
}

function allTools() {
  return [...document.querySelectorAll(".mt-head-tools")];
}

function updateAllProgress(p) {
  for (const tools of allTools()) setProgress(tools, p);
}

async function onCogClick(ev) {
  ev.preventDefault();
  const text = api()?.getText?.() || null;
  const cached = hasCached(text);
  const current = activeSource || getSavedChoice() || (cached ? "cached" : null) || "b2c";
  const picked = await openModelModal({
    mode: "reader",
    hasCached: cached,
    preselect: current === "cached" && !cached ? (preferFallback()) : current,
    allowDismiss: true,
  });
  if (!picked) return;
  await applySource(picked, { fromCog: true });
}

function preferFallback() {
  return resolveReaderSource({ hasCached: false }).id;
}

async function applySource(id, { fromCog = false } = {}) {
  const text = api()?.getText?.();
  if (!text) return;
  const cached = hasCached(text);

  if (id === "cached") {
    if (!cached) return;
    abortLive();
    setSavedChoice("cached");
    activeSource = "cached";
    api()?.restoreCachedMachine?.();
    // restore triggers re-render → our listener re-injects chrome
    injectChrome("cached");
    updateAllProgress({ hidden: true });
    return;
  }

  // In-browser model
  if (id !== "b2c" && id !== "v4e") return;
  const lines = atfLines(text);
  if (!lines.length) {
    setSavedChoice(id);
    activeSource = id;
    injectChrome(id);
    return;
  }

  setSavedChoice(id);
  activeSource = id;
  injectChrome(id);

  abortLive();
  abortCtrl = new AbortController();
  const signal = abortCtrl.signal;
  applying = true;

  if (!runtime) {
    runtime = createTranslatorRuntime({
      onDownload: (p) => updateAllProgress({ pct: p.pct, label: p.label, hidden: false }),
      onReady: (info) => updateAllProgress({ pct: 100, label: info.label || "Model ready", hidden: false }),
      onError: (err) => {
        updateAllProgress({ pct: 0, label: `Error: ${err}`, hidden: false });
        console.error("[reader-model]", err);
      },
    });
  }

  try {
    runtime.load(id);
    const limit = Number(window.__readerLiveLimit) > 0 ? Number(window.__readerLiveLimit) : LIVE_LIMIT_DEFAULT;
    const slice = lines.slice(0, limit);
    const results = Array(slice.length).fill("");
    // Initial remount with placeholders so line slots exist, then soft-update each line.
    api()?.setLiveMachineLines?.(results.slice(), {
      modelId: id,
      label: modelLabelFor(id),
      rerender: true,
    });
    injectChrome(id);
    await runtime.translateLines(slice, {
      signal,
      onLine: (i, row) => {
        if (!row.ok) return;
        results[i] = row.text;
        updateAllProgress({
          pct: 100,
          label: `Translating… ${i + 1} / ${slice.length} (${MODELS[id].shortLabel})`,
          hidden: false,
        });
        api()?.setLiveMachineLines?.(results.slice(), {
          modelId: id,
          label: modelLabelFor(id),
          rerender: false,
        });
        injectChrome(id);
      },
    });
    if (signal.aborted) return;
    const finalLines = results.map((t) => t || "");
    api()?.setLiveMachineLines?.(finalLines, {
      modelId: id,
      label: modelLabelFor(id),
      rerender: true,
    });
    injectChrome(id);
    updateAllProgress({
      pct: 100,
      label: `Done · ${MODELS[id].shortLabel} (${finalLines.filter(Boolean).length} lines)`,
      hidden: false,
    });
    // Hide progress after a beat
    setTimeout(() => {
      if (activeSource === id) updateAllProgress({ hidden: true });
    }, 2500);
  } catch (err) {
    updateAllProgress({ pct: 0, label: `Error: ${err?.message || err}`, hidden: false });
  } finally {
    applying = false;
  }
}

function abortLive() {
  if (abortCtrl) {
    try { abortCtrl.abort(); } catch (_) { /* ignore */ }
    abortCtrl = null;
  }
}

function onRendered() {
  const text = api()?.getText?.();
  if (!text) return;
  // Progressive live paint re-enters here; don't restart a run mid-flight.
  if (applying) {
    injectChrome(activeSource);
    return;
  }
  const cached = hasCached(text);
  const resolved = resolveReaderSource({ hasCached: cached });

  // Always show cog when Machine/English column is up and (cached exists OR ATF available)
  const lines = atfLines(text);
  if (!cached && !lines.length) return;

  injectChrome(resolved.awaitingChoice ? null : resolved.id);

  // Auto-apply saved/URL browser model; never auto-download when awaitingChoice (no cached, never picked).
  if (resolved.awaitingChoice) {
    activeSource = null;
    // Show a muted label so the cog is discoverable
    for (const tools of allTools()) {
      const el = tools.querySelector("[data-mt-source-label]");
      if (el) {
        el.textContent = "choose…";
        el.dataset.source = "";
        el.title = "Click the cog to pick a model (no pre-computed draft for this text)";
      }
    }
    return;
  }

  if (resolved.id === "cached") {
    activeSource = "cached";
    // Ensure cached content is showing (e.g. after a prior live run on another text)
    if (api()?.isLiveMachine?.()) api()?.restoreCachedMachine?.();
    injectChrome("cached");
    return;
  }

  if ((resolved.id === "b2c" || resolved.id === "v4e") && !applying) {
    // Re-run when text id changes or source differs
    const textId = text.id;
    if (activeSource === resolved.id && window.__readerLiveForId === textId && api()?.isLiveMachine?.()) {
      injectChrome(resolved.id);
      return;
    }
    window.__readerLiveForId = textId;
    applySource(resolved.id);
  }
}

function mount() {
  // Remove legacy chip-toolbar host if present
  document.getElementById("reader-model-toolbar")?.remove();

  document.addEventListener("unread:reader-rendered", () => {
    // Defer so DOM from renderReader is queryable
    requestAnimationFrame(() => onRendered());
  });

  // If reader already open when this module loads
  if (api()?.getText?.()) requestAnimationFrame(() => onRendered());

  // Test hooks
  window.__openReaderModelModal = () => onCogClick({ preventDefault() {} });
  window.__applyReaderSource = (id) => applySource(id, { fromCog: true });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
else mount();
