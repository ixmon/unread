// Mounts the B2c / Compact v4e selector on the map.html reader toolbar.
import {
  resolveChoice,
  mountModelSelect,
  setSavedChoice,
  MODELS,
  getSavedChoice,
  defaultModelId,
} from "./model-choice.js";

function currentId() {
  const ch = resolveChoice(new URLSearchParams(location.search));
  if (ch.id) return ch.id;
  return getSavedChoice() || defaultModelId();
}

function mount() {
  const host = document.getElementById("reader-model-toolbar");
  if (!host) return;
  let id = currentId();
  // Seed storage so translate.html and links agree, without forcing the modal's "needsPrompt" away
  // when the visitor has never chosen — only persist when they use the select.
  const api = mountModelSelect(host, {
    value: id,
    onChange: (next) => {
      id = next;
      setSavedChoice(next);
      // Refresh any visible "Open in translator" links so they carry ?revision=
      document.querySelectorAll('a[href*="translate.html"]').forEach((a) => {
        try {
          const u = new URL(a.getAttribute("href"), location.href);
          if (next === "v4e") u.searchParams.set("revision", MODELS.v4e.revision);
          else u.searchParams.set("revision", MODELS.b2c.revision);
          a.setAttribute("href", u.pathname.split("/").pop() + u.search + u.hash);
        } catch (_) { /* ignore */ }
      });
      const note = document.getElementById("reader-model-note");
      if (note) note.textContent = MODELS[next].blurb;
      // Announce for tests / screen readers
      host.dataset.model = next;
      window.__readerModel = next;
    },
  });
  host.dataset.model = id;
  window.__readerModel = id;
  // Tiny blurb under the select (toolbar wraps)
  if (!document.getElementById("reader-model-note")) {
    const note = document.createElement("span");
    note.id = "reader-model-note";
    note.className = "model-select-note";
    note.textContent = MODELS[id].blurb;
    host.appendChild(note);
  }
  // Re-mount when reader shell becomes visible (toolbar exists from the start, so ok now)
  window.__readerModelSelect = api;
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
else mount();
