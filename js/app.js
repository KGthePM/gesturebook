/* app.js — GestureBook entry: PDF loading (PDF.js), UI chrome, session restore,
 * and wiring between the webcam GestureEngine and the Book. */

import { Book } from "./book.js";
import { GestureEngine } from "./gestures.js";
import { initThemePicker, playCoverOpen } from "./theme.js";

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

const SESSION_KEY = "gesturebook:session";
const MODE_KEY = "gesturebook:mode";
const ZOOM_LEVELS = [1, 1.25, 1.6, 2.0];
let zoomIdx = 0;

let currentName = null;
let pillTimer = null;
let idleTimer = null;

/* ---------- book ---------- */

const book = new Book({
  bookEl,
  leftCanvas: $("canvas-left"),
  rightCanvas: $("canvas-right"),
  flipLayer: $("flip-layer"),
  onSpreadChange: (spread, numPages) => {
    pageLabel.textContent = book.label();
    updateModeToggle();
    if (currentName) {
      try {
        localStorage.setItem(SESSION_KEY,
          JSON.stringify({ name: currentName, spread, numPages,
                           mode: book.readMode, page: book.page }));
      } catch (_) { /* storage unavailable — non-fatal */ }
    }
  },
});

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
  let coverDone = Promise.resolve();
  const savedMode = preferredMode();
  try {
    coverDone = playCoverOpen(dropzone);     // v3: cover swings while PDF parses
    showLoading(`Opening ${file.name}…`);
    const buf = await file.arrayBuffer();
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

    currentName = file.name;
    zoomIdx = 0;
    await coverDone;                          // let the cover finish its swing
    dropzone.classList.add("fade-out");       // short cross-fade to reader
    bookEl.classList.remove("hidden");
    setTimeout(() => dropzone.classList.add("hidden"), 300);

    let restored = 0;
    let restoredPage = 0;
    try {
      const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
      if (saved && saved.name === file.name && saved.numPages === pdfDoc.numPages) {
        const maxSpread = Math.max(0, pdfDoc.numPages - 2);
        restored = Math.min(saved.spread | 0, maxSpread);
        restoredPage = Math.min(saved.page | 0 || 1, pdfDoc.numPages);
      }
    } catch (_) { /* corrupt session — start fresh */ }

    await book.setDocument(pdfDoc);
    const restoringReader = savedMode === "single" || savedMode === "half";
    if (restoringReader) {
      book.page = Math.max(1, restoredPage);
      await book.setReadMode(savedMode);   // re-applies class + renders this.page
      book.page = Math.max(1, restoredPage);
      await book.renderCurrentPage();
    } else if (restored > 0) {
      book.spread = restored;
      await book.renderSpread();
    }
    if (restoringReader || restored > 0) {
      setStatus(restoringReader
        ? `resumed ${file.name} at page ${book.page}`
        : `resumed ${file.name} at page ${restored + 1}`);
    } else {
      setStatus(`opened ${file.name} \u00b7 ${pdfDoc.numPages} pages`);
    }
    hint.classList.remove("fade");
    setTimeout(() => hint.classList.add("fade"), 9000);
    wakeChrome();
    if (gestures.running && modeFab) modeFab.classList.remove("hidden");
  } catch (e) {
    setStatus("could not open: " + (e && e.message ? e.message : e));
    dropzone.classList.remove("cover-open", "fade-out");   // re-close the book
  } finally {
    hideLoading();
  }
}

fileInput.addEventListener("change", () => {
  if (fileInput.files && fileInput.files[0]) openFile(fileInput.files[0]);
});
dropzone.addEventListener("click", () => fileInput.click());

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
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.add("hidden");
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

/* ---------- v3: read-mode toggle (3-way: book -> single -> half -> book) ---------- */

const NEXT_MODE = { book: "single", single: "half", half: "book" };
const MODE_LABEL = { book: "Book view", single: "Read view", half: "Half page" };
const MODE_STATUS = {
  book: "book view \u00b7 two-page spread",
  single: "read view \u00b7 one page \u00b7 pinch to grab \u00b7 swipe to turn",
  half: "half-page \u00b7 pinch to scroll \u00b7 swipe to turn",
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
    canDrag: (dir) => book.canDrag(dir),
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
    onPanEnd: () => { book._applyReadTransform(); },

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

setStatus("Open a PDF to begin");
initThemePicker();
