/* app.js — GestureBook entry: PDF loading (PDF.js), UI chrome, session restore,
 * and wiring between the webcam GestureEngine and the Book. */

import { Book } from "./book.js";
import { GestureEngine } from "./gestures.js";
import { initThemePicker, playCoverOpen } from "./theme.js";
import { savePdf, loadPdf, clearPdf,
         saveLibraryEntry, listLibrary, touchLibraryPosition, deleteLibraryEntry } from "./storage.js";

const pdfjsLib = window.pdfjsLib;
if (pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

const $ = (id) => document.getElementById(id);
const fileInput = $("pdf-file");
const pageLabel = $("page-label");
const camToggle = $("cam-toggle");
const bookEl = $("book");
const dropzone = $("dropzone");
const loading = $("loading");
const loadTitle = $("load-title");
const loadFill = $("load-fill");
const loadPct = $("load-pct");
const statusPill = $("status-pill");
const hint = $("hint");
const dropOverlay = $("drop-overlay");
const camOverlay = $("cam-overlay");
const topbar = $("topbar");
const modeToggle = $("mode-toggle");
const modeFab = $("mode-fab");
const pageJumpInput = $("page-jump-input");
const tocToggle = $("toc-toggle");
const tocPanel = $("toc-panel");
const openPdfBtn = $("open-pdf-btn");
const libraryToggle = $("library-toggle");
const libraryPanel = $("library-panel");

const SESSION_KEY = "gesturebook:session";
const MODE_KEY = "gesturebook:mode";
const ZOOM_LEVELS = [1, 1.25, 1.6, 2.0];
let zoomIdx = 0;

let currentName = null;
let pillTimer = null;
let idleTimer = null;

const canPickHandle = "showOpenFilePicker" in window;
let pendingResume = null;   // library entry awaiting a manual re-pick (no/failed handle)

/* ---------- book ---------- */

const book = new Book({
  bookEl,
  leftCanvas: $("canvas-left"),
  rightCanvas: $("canvas-right"),
  flipLayer: $("flip-layer"),
  onSpreadChange: (spread, numPages) => {
    pageLabel.textContent = `${progressPercent()}% · ${book.label()}`;
    updateModeToggle();
    if (currentName) {
      try {
        localStorage.setItem(SESSION_KEY,
          JSON.stringify({ name: currentName, spread, numPages,
                           mode: book.readMode, page: book.page }));
      } catch (_) { /* storage unavailable — non-fatal */ }
      touchLibraryPosition(currentName, { spread, page: book.page, mode: book.readMode });
    }
  },
});

function progressPercent() {
  if (!book.pdfDoc) return 0;
  const cur = book.isSingle ? book.page : Math.min(book.spread + 2, book.numPages);
  return Math.round((cur / book.numPages) * 100);
}

/* ---------- status pill ---------- */

function setStatus(text, { quiet = false } = {}) {
  statusPill.textContent = text;
  statusPill.classList.remove("dim");
  if (!quiet) {
    statusPill.classList.remove("flash");
    void statusPill.offsetWidth;          // restart animation
    statusPill.classList.add("flash");
  }
  clearTimeout(pillTimer);
  pillTimer = setTimeout(() => statusPill.classList.add("dim"), 3500);
}

/* ---------- chrome auto-hide ---------- */

function wakeChrome({ pin = false } = {}) {
  topbar.classList.remove("idle");
  clearTimeout(idleTimer);
  const hide = () => {
    if (!book.pdfDoc) return;
    topbar.classList.add("idle");
  };
  idleTimer = pin ? setTimeout(hide, 4000) : setTimeout(hide, 3000);
}
["mousemove", "keydown", "pointerdown"].forEach((ev) =>
  window.addEventListener(ev, () => wakeChrome()));
topbar.addEventListener("mouseenter", () => clearTimeout(idleTimer));
topbar.addEventListener("mouseleave", () => wakeChrome());

/* ---------- PDF loading ---------- */

function showLoading(title) {
  loadTitle.textContent = title;
  loadFill.style.width = "0%";
  loadPct.textContent = "";
  loading.classList.remove("hidden");
}
function hideLoading() { loading.classList.add("hidden"); }

async function openFile(file) {
  return openBuffer(file.name, await file.arrayBuffer());
}

/* Opens a file picker (File System Access API when supported, so we get back
 * a persistable handle instead of a one-shot File) and opens whatever comes
 * back. Falls back to the classic hidden <input type=file> in browsers that
 * don't support showOpenFilePicker. */
async function pickAndOpen() {
  if (canPickHandle) {
    let handle;
    try {
      [handle] = await window.showOpenFilePicker({
        types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }],
      });
    } catch (_) {
      return;   // user cancelled — don't also fall back to the classic input
    }
    const file = await handle.getFile();
    return openBuffer(file.name, await file.arrayBuffer(), { handle });
  }
  fileInput.click();
}

async function openBuffer(name, buf, { isRestore = false, handle = null, resumePosition = null } = {}) {
  let coverDone = Promise.resolve();
  try {
    coverDone = playCoverOpen(dropzone);     // v3: cover swings while PDF parses
    showLoading(isRestore || resumePosition ? `Resuming ${name}…` : `Opening ${name}…`);
    // PDF.js transfers `buf` to its worker (detaching the ArrayBuffer), so keep
    // a copy for the IndexedDB cache before handing it over.
    const storable = buf.slice(0);
    const task = pdfjsLib.getDocument({
      data: buf,
      onProgress: ({ loaded, total }) => {
        if (total) {
          const pct = Math.round((loaded / total) * 100);
          loadFill.style.width = `${pct}%`;
          loadPct.textContent = `${pct}%`;
        }
      },
    });
    const pdfDoc = await task.promise;

    // a library row without its own handle (or with a stale one) falls back
    // to a manual re-pick — recognize it here once we know numPages match
    if (!resumePosition && pendingResume && pendingResume.name === name &&
        pendingResume.numPages === pdfDoc.numPages) {
      resumePosition = pendingResume;
    }
    pendingResume = null;
    const savedMode = resumePosition ? (resumePosition.mode || "book") : preferredMode();

    currentName = name;
    zoomIdx = 0;
    if (!isRestore) savePdf(name, storable);
    await coverDone;                          // let the cover finish its swing
    dropzone.classList.add("fade-out");       // short cross-fade to reader
    bookEl.classList.remove("hidden");
    setTimeout(() => dropzone.classList.add("hidden"), 300);

    let restored = 0;
    let restoredPage = 0;
    if (resumePosition) {
      const maxSpread = Math.max(0, pdfDoc.numPages - 2);
      restored = Math.min(resumePosition.spread | 0, maxSpread);
      restoredPage = Math.min(resumePosition.page | 0 || 1, pdfDoc.numPages);
    } else {
      try {
        const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
        if (saved && saved.name === name && saved.numPages === pdfDoc.numPages) {
          const maxSpread = Math.max(0, pdfDoc.numPages - 2);
          restored = Math.min(saved.spread | 0, maxSpread);
          restoredPage = Math.min(saved.page | 0 || 1, pdfDoc.numPages);
        }
      } catch (_) { /* corrupt session — start fresh */ }
    }

    await book.setDocument(pdfDoc);
    const restoringReader = savedMode === "single" || savedMode === "half";
    if (restoringReader) {
      book.page = Math.max(1, restoredPage);
      await book.setReadMode(savedMode);   // re-applies class + renders/builds (may reset page)
      if (book.isHalf) {
        book.jumpToPage(restoredPage, { smooth: false });
        book.page = Math.max(1, restoredPage);
      } else {
        book.page = Math.max(1, restoredPage);
        await book.renderCurrentPage();
      }
    } else if (restored > 0) {
      book.spread = restored;
      await book.renderSpread();
    }
    if (restoringReader || restored > 0) {
      setStatus(restoringReader
        ? `resumed ${name} at page ${book.page}`
        : `resumed ${name} at page ${restored + 1}`);
    } else {
      setStatus(`opened ${name} \u00b7 ${pdfDoc.numPages} pages`);
    }

    const libEntry = { name, numPages: pdfDoc.numPages, spread: book.spread,
                        page: book.page, mode: book.readMode, savedAt: Date.now() };
    if (handle) libEntry.handle = handle;   // omit rather than clobber a previously-saved one
    saveLibraryEntry(libEntry);
    renderLibrary();

    hint.classList.remove("fade");
    setTimeout(() => hint.classList.add("fade"), 9000);
    wakeChrome();
    if (gestures.running && modeFab) modeFab.classList.remove("hidden");
    await updateOutline(pdfDoc);
  } catch (e) {
    if (isRestore) {
      clearPdf();
      setStatus("Open a PDF to begin");
    } else {
      setStatus("could not open: " + (e && e.message ? e.message : e));
    }
    dropzone.classList.remove("cover-open", "fade-out");   // re-close the book
  } finally {
    hideLoading();
  }
}

fileInput.addEventListener("change", () => {
  if (fileInput.files && fileInput.files[0]) openFile(fileInput.files[0]);
});
if (openPdfBtn) openPdfBtn.addEventListener("click", pickAndOpen);
dropzone.addEventListener("click", pickAndOpen);

/* drag & drop with full-screen overlay */
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  if (++dragDepth === 1) dropOverlay.classList.remove("hidden");
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) { dragDepth = 0; dropOverlay.classList.add("hidden"); }
});
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.add("hidden");
  const item = e.dataTransfer.items && e.dataTransfer.items[0];
  let handle = null;
  if (item && item.getAsFileSystemHandle) {
    try {
      const h = await item.getAsFileSystemHandle();
      if (h && h.kind === "file") handle = h;
    } catch (_) { /* fall back to plain File below */ }
  }
  if (handle) {
    const file = await handle.getFile();
    openBuffer(file.name, await file.arrayBuffer(), { handle });
    return;
  }
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) openFile(f);
});

/* keyboard fallback */
window.addEventListener("keydown", (e) => {
  if (e.key === "ArrowRight") book.turnForward();
  if (e.key === "ArrowLeft") book.turnBackward();
  if (e.key === "ArrowUp" && book.isHalf) book.scrollHalf(-1);
  if (e.key === "ArrowDown" && book.isHalf) book.scrollHalf(1);
  if (e.key === "s" || e.key === "S") toggleReadMode();
});

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (book.pdfDoc && !book.busy) book.renderCurrent(); }, 200);
});

/* ---------- tap-to-jump: click the page label to type a page number ---------- */

function openPageJump() {
  if (!book.pdfDoc || !pageJumpInput) return;
  pageLabel.classList.add("hidden");
  pageJumpInput.classList.remove("hidden");
  pageJumpInput.max = String(book.numPages);
  pageJumpInput.value = String(book.isSingle ? book.page : book.spread + 1);
  pageJumpInput.focus();
  pageJumpInput.select();
}
function closePageJump() {
  if (!pageJumpInput) return;
  pageJumpInput.classList.add("hidden");
  pageLabel.classList.remove("hidden");
}
if (pageJumpInput) {
  pageLabel.addEventListener("click", openPageJump);
  pageJumpInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const n = parseInt(pageJumpInput.value, 10);
      closePageJump();
      if (Number.isFinite(n) && !book.goToPage(n)) setStatus("still turning — try again");
    } else if (e.key === "Escape") {
      closePageJump();
    }
  });
  pageJumpInput.addEventListener("blur", closePageJump);
}

/* ---------- library: recent PDFs, linked (not copied) ---------- */

function relativeTime(ts) {
  if (!ts) return "";
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

async function renderLibrary() {
  if (!libraryPanel || !libraryToggle) return;
  const entries = await listLibrary();
  libraryToggle.classList.toggle("hidden", entries.length === 0);
  libraryPanel.replaceChildren();
  const ul = document.createElement("ul");
  for (const entry of entries) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "lib-row";
    btn.setAttribute("role", "menuitem");
    const nameEl = document.createElement("span");
    nameEl.className = "lib-name";
    nameEl.textContent = entry.name;
    const subEl = document.createElement("span");
    subEl.className = "lib-sub";
    subEl.textContent = `page ${entry.page || 1} of ${entry.numPages} · ${relativeTime(entry.savedAt)}`;
    btn.appendChild(nameEl);
    btn.appendChild(subEl);
    btn.addEventListener("click", () => {
      libraryPanel.classList.add("hidden");
      libraryToggle.setAttribute("aria-expanded", "false");
      resumeLibraryEntry(entry);
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "lib-remove";
    del.title = "Remove from library";
    del.setAttribute("aria-label", `Remove ${entry.name} from library`);
    del.textContent = "×";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteLibraryEntry(entry.name).then(renderLibrary);
    });
    li.appendChild(btn);
    li.appendChild(del);
    ul.appendChild(li);
  }
  libraryPanel.appendChild(ul);
}

async function resumeLibraryEntry(entry) {
  if (entry.handle) {
    try {
      let perm = await entry.handle.queryPermission({ mode: "read" });
      if (perm !== "granted") perm = await entry.handle.requestPermission({ mode: "read" });
      if (perm === "granted") {
        const file = await entry.handle.getFile();
        await openBuffer(file.name, await file.arrayBuffer(),
          { handle: entry.handle, resumePosition: entry });
        return;
      }
    } catch (_) { /* file moved/deleted/denied — fall through to a manual re-pick */ }
  }
  pendingResume = entry;
  setStatus(`locate "${entry.name}" to resume`);
  pickAndOpen();
}

if (libraryToggle && libraryPanel) {
  libraryToggle.addEventListener("click", () => {
    const opening = libraryPanel.classList.contains("hidden");
    if (opening) renderLibrary();
    libraryPanel.classList.toggle("hidden", !opening);
    libraryToggle.setAttribute("aria-expanded", String(opening));
  });
}

/* ---------- table of contents (PDF outline, when present) ---------- */

async function destToPage(dest) {
  const explicit = typeof dest === "string" ? await book.pdfDoc.getDestination(dest) : dest;
  if (!explicit || !explicit[0]) return null;
  return (await book.pdfDoc.getPageIndex(explicit[0])) + 1;
}

function renderOutline(items) {
  const ul = document.createElement("ul");
  for (const item of items) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("role", "menuitem");
    btn.textContent = item.title;
    btn.addEventListener("click", async () => {
      const n = await destToPage(item.dest);
      tocPanel.classList.add("hidden");
      tocToggle.setAttribute("aria-expanded", "false");
      if (n && !book.goToPage(n)) setStatus("still turning — try again");
    });
    li.appendChild(btn);
    if (item.items && item.items.length) li.appendChild(renderOutline(item.items));
    ul.appendChild(li);
  }
  return ul;
}

async function updateOutline(pdfDoc) {
  if (!tocToggle || !tocPanel) return;
  tocPanel.classList.add("hidden");
  tocToggle.setAttribute("aria-expanded", "false");
  tocPanel.replaceChildren();
  tocToggle.classList.add("hidden");
  let outline = null;
  try { outline = await pdfDoc.getOutline(); } catch (_) { outline = null; }
  if (outline && outline.length) {
    tocPanel.appendChild(renderOutline(outline));
    tocToggle.classList.remove("hidden");
  }
}

if (tocToggle && tocPanel) {
  tocToggle.addEventListener("click", () => {
    const opening = tocPanel.classList.contains("hidden");
    tocPanel.classList.toggle("hidden", !opening);
    tocToggle.setAttribute("aria-expanded", String(opening));
  });
}

/* ---------- v3: read-mode toggle (3-way: book -> single -> half -> book) ---------- */

const NEXT_MODE = { book: "single", single: "half", half: "book" };
const MODE_LABEL = { book: "Book view", single: "Read view", half: "Half page" };
const MODE_STATUS = {
  book: "book view \u00b7 two-page spread",
  single: "read view \u00b7 one page \u00b7 pinch to grab \u00b7 swipe to turn",
  half: "half-page \u00b7 pinch to scroll \u00b7 \u2190/\u2192 to jump pages",
};

function updateModeToggle() {
  const pressed = String(book.isSingle);
  if (modeToggle) {
    modeToggle.textContent = MODE_LABEL[NEXT_MODE[book.readMode]];
    modeToggle.setAttribute("aria-pressed", pressed);
    modeToggle.classList.toggle("active", book.isSingle);
  }
  if (modeFab) {
    modeFab.setAttribute("aria-pressed", pressed);
    modeFab.dataset.mode = book.readMode;
  }
}

function toggleReadMode() {
  if (!book.pdfDoc) { setStatus("open a PDF first"); return; }
  book.setReadMode(NEXT_MODE[book.readMode]);
  updateModeToggle();
  try { localStorage.setItem(MODE_KEY, book.readMode); } catch (_) {}
  setStatus(MODE_STATUS[book.readMode]);
}
if (modeToggle) modeToggle.addEventListener("click", toggleReadMode);
if (modeFab) modeFab.addEventListener("click", toggleReadMode);

/* restore preferred mode across sessions (applied when a PDF opens) */
function preferredMode() {
  try { return localStorage.getItem(MODE_KEY) || "book"; } catch (_) { return "book"; }
}

/* ---------- gestures ---------- */

const gestures = new GestureEngine({
  video: $("cam-video"),
  overlayCanvas: { getContext: () => ({ clearRect: () => {} }) },  // stub: preview removed
  pointerEl: $("hand-pointer"),
  dwellEl: modeFab,
  callbacks: {
    canDrag: (dir) => !book.isHalf && book.canDrag(dir),
    onDragStart: (dir) => book.beginDrag(dir),
    onDragProgress: (dir, p) => book.dragTo(p),
    onDragCommit: () => book.commitDrag(),
    onDragCancel: () => book.cancelDrag(),
    onZoom: (delta) => {
      zoomIdx = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, zoomIdx + delta));
      const z = ZOOM_LEVELS[zoomIdx];
      book.setZoom(z);
      setStatus(z === 1 ? "zoom reset" : `zoom ${Math.round(z * 100)}%`);
    },
    onPalmHold: () => wakeChrome({ pin: true }),
    onStatus: (text) => setStatus(text),

    /* v4: pinch-drag scrolls the page in half mode */
    canPan: () => book.isHalf && !book.busy,
    onPanStart: () => {},
    onPanMove: (dx, dy) => book.readPan(dy),
    onPanEnd: () => {},

    /* v3: dwell-to-toggle (pinch-hold the mode button ~2s) */
    onDwell: (p) => {
      if (!modeFab) return;
      modeFab.style.setProperty("--dwell", String(p));
      modeFab.classList.toggle("dwelling", p > 0);
    },
    onDwellToggle: () => toggleReadMode(),
  },
});

camToggle.addEventListener("click", async () => {
  if (gestures.running) {
    gestures.stop();
    camOverlay.classList.add("hidden");
    camToggle.textContent = "Start camera";
    if (modeFab) modeFab.classList.add("hidden");
    setStatus("camera off");
    return;
  }
  camToggle.disabled = true;
  try {
    camOverlay.classList.remove("hidden");
    setStatus("starting camera\u2026");
    await gestures.start();
    camToggle.textContent = "Stop camera";
    if (book.pdfDoc && modeFab) modeFab.classList.remove("hidden");
    setStatus("camera on \u00b7 swipe to turn pages");
  } catch (e) {
    camOverlay.classList.add("hidden");
    setStatus("camera error: " + (e && e.message ? e.message : e));
  } finally {
    camToggle.disabled = false;
  }
});

(async () => {
  renderLibrary();
  const record = await loadPdf();
  if (record && record.bytes) {
    await openBuffer(record.name, record.bytes, { isRestore: true });
  } else {
    setStatus("Open a PDF to begin");
  }
})();
initThemePicker();
