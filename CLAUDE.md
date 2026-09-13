# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
./start.sh                      # serve on the first free port from 8787 up, print the URL, auto-open the browser
python3 -m http.server 8787      # manual fallback: serve from the repo root, then open http://localhost:8787
python3 generate_sample.py       # regenerate sample.pdf (8 numbered pages, hand-rolled PDF 1.4)
```

`start.sh` honors `PORT=`/`BIND=` env overrides and binds `127.0.0.1` by default.

No build step, no package manager, no test suite. Editing a file and reloading the page is the whole
dev loop. The camera needs a secure context — `localhost` counts, a `file://` URL does not, so always
serve rather than opening `index.html` directly.

Verification is manual: load `sample.pdf`, turn pages with `←`/`→` (works without the camera), then
start the camera to exercise gestures.

## Architecture

Four ES modules loaded by `index.html` via `<script type="module" src="js/app.js">`. All third-party
code comes from pinned CDNs at runtime — PDF.js 3.11.174 (global `window.pdfjsLib`, cdnjs),
`@mediapipe/tasks-vision` 0.10.14 (ESM import in `gestures.js`, jsDelivr + its `/wasm` fileset), and
the `hand_landmarker.task` float16 model from storage.googleapis.com. First load needs internet.
The table-of-contents panel uses PDF.js's `getOutline()`/`getDestination()`/`getPageIndex()` to
resolve outline entries to page numbers; the Contents button in `#topbar` stays hidden whenever a
PDF has no outline (`getOutline()` returns null/empty — true of the generated `sample.pdf`).

- **`js/app.js`** — entry point. Owns PDF loading (file input + full-window drag/drop), the loading
  card, the status pill, chrome auto-hide, keyboard fallback, the IndexedDB/localStorage
  restore-on-load boot sequence, and the tap-to-jump/table-of-contents UI. It is the only place
  that knows about DOM ids; `book.js` and `gestures.js` receive elements.
- **`js/book.js`** — `Book` class: all PDF.js rendering and page-turn animation. Holds the three
  view modes and their separate coordinate systems.
- **`js/gestures.js`** — `GestureEngine`: MediaPipe HandLandmarker state machine. Knows nothing
  about pages or PDFs; it only calls the callbacks `app.js` passes in.
- **`js/theme.js`** — theme persistence + the cover-open transition promise.
- **`js/storage.js`** — IndexedDB wrapper caching the last-opened PDF's bytes, so a reload can
  resume without the user re-picking the file. Same try/catch-everywhere philosophy as the
  localStorage access below.

### app.js ↔ gestures.js contract

`GestureEngine` is constructed with a `callbacks` object and never touches `book` directly. The
callbacks split into query hooks the engine polls (`canDrag(dir)`, `canPan()`) and drive hooks it
fires (`onDragStart/Progress/Commit/Cancel`, `onPanStart/Move/End`, `onDwell/onDwellToggle`,
`onPalmHold`, `onStatus`, `onZoom`). Gesture semantics live entirely in `gestures.js`; what a
gesture *means for the document* lives in the callback bodies in `app.js`.

### Three view modes

`Book.readMode` is `"book"` (two-page spread, `this.spread` 0-based, visible pages
`spread+1`/`spread+2`), `"single"` (one page fit-to-page, Read view), or `"half"` (one page
fit-to-width at full resolution, cropped to a short box and scrolled vertically — Half-page view).
`isSingle` is `readMode !== "book"` (true for both reader modes — most call sites only care "book
vs. reader"); `isHalf` is `readMode === "half"`. Both reader modes track `this.page` (1-based). The
mode is mirrored into CSS as `html.single-mode` (hides `.page.left` and the spine) plus, for half
mode specifically, `html.half-mode`. Turns animate differently per mode and share one drag API:

    canDrag(dir) → beginDrag(dir) → dragTo(p)… → commitDrag() | cancelDrag()

`p` is 0..1 progress. Book mode builds a `.flip-page` (CSS 3D `rotateY` 0 → −180, with front/back
faces holding cloned canvases); the reader modes build a `.slide-page` (`translateX`). Both live in
`#flip-layer`, both arm a `transitionend` listener **plus a 900 ms `setTimeout` safety net** because
`transitionend` can be dropped — keep that pattern when adding animations. `this.busy` gates
re-entrancy and is cleared only in those finish paths.

Rendering is mode-aware via `Book._boxFor(pageNum)` / `renderCurrentPage()`: book and Read view
render fit-to-page into `pageBox()`'s dimensions as before; half mode renders fit-to-width into a
box *taller than the visible container* (`{ w: pageBox().w, h: pageBox().w * pageAspect }`, unless
that's already shorter than the box, e.g. a landscape page). Every render call site (`setDocument`,
`setReadMode`, `renderCurrent`, the slide plumbing, and `app.js`'s session restore) goes through
this helper rather than inlining `pageBox()` — that's the one place mode-specific sizing lives.
The half-mode box itself is sized independently of the page's aspect ratio in CSS
(`html.half-mode .page.right { aspect-ratio: auto; width: …; height: … }`) — if it kept the normal
`.page` aspect-ratio, the fit-width render would exactly fill it and there'd be nothing to scroll.

Book-mode zoom is unrelated and untouched: discrete `ZOOM_LEVELS` steps via `setZoom`, driven by
the dormant legacy `onZoom`/`ENABLE_ZOOM` pinch gesture. Half mode scrolls instead of zooming:
`readPan(dy)` (pinch-drag) and `scrollHalf(dir)` (↑/↓ keys) adjust `this.readY`, clamped to
`[-maxY, 0]` in `_applyReadTransform()` where `maxY = rightCanvas.offsetHeight - pageBox().h`
(offsetHeight is the tall canvas's real layout height; `pageBox().h` is the clipped box). A
committed page turn always resets `readY = 0` (land at top); a cancelled one leaves it untouched
(cancelling restores the *same* page, so it should stay where you scrolled to). Two-hand zoom
(v3) was removed entirely, along with `numHands: 2` — one hand is tracked now.

`pageBox()` deliberately measures the **right** page container — the left one is `display:none` in
the reader modes and measuring it yielded a blank 1×1 canvas (see commit 3a93dcb).

`Book.goToPage(pageNum)` is the mode-aware direct-jump primitive (no animation, respects
`this.busy`) used by tap-to-jump and the table-of-contents panel in `app.js`. It generalizes the
same direct spread/page assignment the session-restore code in `app.js` already did by hand — reuse
it for any future "jump to an arbitrary page" feature rather than re-deriving the per-mode branch.

### Gesture state machine

States: `idle → grabbing → dragging | panning → cooldown`. Two ways to turn a page:

1. **Pinch-to-grab** (primary) — pinch ratio (thumb–index distance / wrist–middle-MCP span) drops
   below `PINCH_ON`; direction locks after `GRAB_DEADZONE` of travel; the page then follows the hand;
   **releasing the pinch decides** commit vs. cancel against `COMMIT_AT`. Hysteresis via `PINCH_OFF`,
   and `pinchArmed` requires a full unpinch between grabs so one pinch can't turn two pages.
2. **Wrist flick** (secondary, open hand) — `ENGAGE` displacement within `WINDOW_MS`; commits on
   progress or `FLICK` velocity.

From `grabbing`, the pinch can be stolen by two other gestures: **dwell-to-toggle** (pinch pointer
held inside `#mode-fab`, inflated by `DWELL_PAD`, for `DWELL_MS`) and **pinch-pan** (when
`canPan()` is true, i.e. half mode — a pinch there always scrolls, never turns a page; page turns
in half mode only happen via flick or ←/→).

The invariant to preserve: **one gesture owns the frame.** Each detector checks state and returns
early rather than letting two interpretations fire together.

All coordinates are mirrored to selfie view (`1 - x`), so moving the hand left turns *forward*.

Tuning constants are grouped at the top of `gestures.js` under a "tuning knobs" comment — change
thresholds there, not inline. `ENABLE_ZOOM` guards the dormant legacy single-hand pinch/spread zoom
(and with it `_palm()`, so the open-palm-for-controls gesture is currently unreachable).

### Camera UI

No video preview is shown — `#cam-video` is `display:none` and only feeds the landmarker. Spatial
feedback is `#hand-pointer`, a glow that follows the mirrored index fingertip. `overlayCanvas` is a
vestigial API parameter; `app.js` passes a no-op stub.

### Theming

Three themes (`classic`, `seattle`, `boston`) as `:root[data-theme=...]` CSS custom-property blocks
in `style.css`. An inline script in `<head>` applies the saved theme **before first paint** to avoid
a flash; `theme.js` only wires the picker and persists. `classic` is the absence of the attribute.
`--paper` stays identical across themes so page continuity is preserved. Decorative layers (glows,
lamp, motes, rain) are empty divs in `#dropzone` driven entirely by theme variables — Seattle's rain
only shows via `:root[data-theme="seattle"] #dropzone:not(.cover-open) .rain`.

Motion respects `prefers-reduced-motion` in `theme.js` (`playCoverOpen` resolves immediately).

### localStorage keys

`gesturebook:session` (`{name, spread, page, numPages, mode}`, restored only when filename **and**
page count match), `gesturebook:mode`, `gesturebook:theme`. Every access is wrapped in try/catch —
storage being unavailable must never be fatal.

### IndexedDB

`js/storage.js` owns a `gesturebook` database (v1), object store `pdf`, single fixed key
`"current"` — one PDF slot, no recent-files list. Record shape: `{ name, size, bytes, savedAt }`
with `bytes` as the raw `ArrayBuffer` PDF.js was given. Written on every successful
*user-initiated* open (`app.js`'s `openBuffer`, `!isRestore`), which naturally overwrites the slot
when a different file is opened; cleared only when a restore attempt itself fails, so a corrupted
record doesn't keep failing on every future reload. `app.js` calls `loadPdf()` once at boot and,
if a record exists, reopens it through the same `openBuffer` code path used for a manual open
(`isRestore: true`) — the existing `gesturebook:session` position/mode restore applies exactly as
it does for a manually re-picked file. If IndexedDB is unavailable/blocked, every call resolves to
a safe fallback (`null`/no-op) instead of throwing, and the app behaves exactly as it did before
this feature existed.

## Notes

`README.md` describes the current v4 interaction model (book/read/half-page, pinch-to-grab, city
themes). Keep it in sync alongside behavior changes.
