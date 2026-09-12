# Half-page reader mode — implementation plan

**Status:** not yet implemented · **Date drafted:** 2026-09-12
**Scope:** add a fit-width "half-page" reading mode with gesture scrolling; remove the two-hand zoom feature entirely.

## Background

Readers like Reader View (single page) but want a closer view; the two-hand zoom
gesture is hard to discover and perform. Two observations from the current code:

1. **Zoom is fundamentally blurry.** `setReadZoom` CSS-scales a canvas rendered at
   fit-page resolution (`book.js`, `_applyReadTransform`), so even when two-hand
   zoom works, text is upscaled mush. A half-page mode that re-renders the page
   fit-to-width gives crisp text at the closer size — better quality than zoom
   ever had.
2. **Removing two-hand zoom deletes real complexity.** It is the only reason for
   `numHands: 2`, and it falsely owns the frame in book mode today (shows
   "two hands · spread to zoom" while `onReadZoom` no-ops because `!book.isSingle`).

## Decisions (locked with Kyle, 2026-09-12)

| Question | Decision |
| --- | --- |
| Mode lineup | **Add alongside** — 3-way cycle: Book → Read → Half-page |
| Boundary turns | **No overshoot** — scrolling strictly scrolls; page turns via wrist flick or ←/→ keys only |
| Scroll gesture | **Pinch-drag** (reuses the existing pinch-pan path unchanged; open hand stays free for flick) |
| Zoom removal | **Delete entirely** — `onReadZoom`/`onReadZoomAnchor` callbacks, two-hand block in `gestures.js`, `numHands` back to 1 |

Design note: "half-page" means **fit-width, not a literal 50% height crop**. The
page fills the viewport width and the reader scrolls vertically. A fixed 50% crop
breaks on landscape/wide pages (horizontal cropping); fit-width adapts per page
and never needs horizontal pan. On A4-ish pages it lands around "half the page
visible," which is what readers asked for.

## Changes by file

### js/book.js

- `readMode` becomes `"book" | "single" | "half"`.
  - `get isSingle()` returns `readMode !== "book"` (covers both reader views —
    existing call sites keep working); add `get isHalf()`.
- **Fit-width rendering** — reuse `renderPage` by passing a tall box: get the
  page aspect via `getViewport({scale: 1})`, render at `(w, w * aspect)`. The
  existing `min(cw/bw, ch/bh) * 0.97` scale picks fit-width automatically, so
  text re-renders **crisp** instead of CSS-upscaled.
  - If the page is wider than tall (aspect ≤ box aspect), fall back to plain
    fit-page render — no scroll needed.
- `_applySingle(on)`: toggles `single-mode` for both reader modes; additionally
  toggles a `half-mode` class on `<html>`.
- `_applyReadTransform()`: in half mode, vertical only — `translateY(readY)`,
  clamped to `[-maxY, 0]` where `maxY = max(0, rightCanvas.offsetHeight - box.h)`
  (`offsetHeight` is the untransformed layout height). `readX` stays 0.
- **Page turns:** `canDrag(dir)` in half mode = same bounds check as single (the
  `readZoom > 1.01` guard dies with zoom). Slide plumbing
  (`_beginSlide`/`_finishSlide`/`cancelDrag`) swaps its re-render calls to a
  mode-aware helper; on commit/cancel in half mode, reset `readY = 0`
  (land at top).
- **Delete:** `MAX_READ_ZOOM`, `setReadZoom()`, the `readZoom` field;
  `_resetReadView` shrinks to a pan reset.
- `setReadMode` handles `"half"` (same entry path as `"single"`);
  `renderCurrent()` re-renders fit-width + re-clamps on resize.
- Add `scrollHalf(dy)` for keyboard: clamped ±90%-viewport steps.

### js/gestures.js

- Delete the two-hand zoom block in `_process` (~lines 203-224), the
  `zoomAnchor`/`zoomBase`/`twoHand` fields, the `ZOOM_MIN_SPAN`/`OPEN_RATIO`
  tuning constants, and `onReadZoom`/`onReadZoomAnchor` from the callbacks
  contract comment.
- `numHands: 2` → `1` (faster, fewer misdetections).
- Pinch-pan path unchanged — driven purely by `canPan()`.

### js/app.js

- Remove the `onReadZoom`/`onReadZoomAnchor` callbacks.
- `canPan: () => book.isHalf && !book.busy` (never in single mode; the
  busy-guard prevents transforming the canvas mid-slide).
- `toggleReadMode()` → 3-way cycle; `updateModeToggle()` labels the **next**
  mode ("Read view" / "Half page" / "Book view"); per-mode status strings, e.g.
  "half-page · pinch to scroll · swipe to turn".
- Keyboard: `S` cycles (already does, now 3-way); add `↑`/`↓` →
  `book.scrollHalf(∓)` in half mode.
- Session/mode restore: accept `"half"` in both the `gesturebook:session` mode
  restore and `gesturebook:mode`.

### style.css

- `html.half-mode .page.right { overflow: hidden; }`
- `html.half-mode .page.right canvas, html.half-mode .slide-page canvas { height: auto; }`
  (tall canvas keeps its intrinsic aspect; `height: 100%` would squash it)
- `html.half-mode .slide-page { overflow: hidden; }`
- Optional polish: a thin vertical scroll-progress indicator in half mode.

### index.html

- Update the `#hint` line and the `#mode-toggle` title for the 3 modes.

### Docs

- Update `README.md` (v4 interaction model: three modes, half-page scrolling,
  zoom removed) and `CLAUDE.md` (modes section, gestures contract: zoom gone,
  `canPan` = half mode, `numHands` 1). CLAUDE.md notes README should be updated
  alongside behavior changes anyway.

## Verification (manual — no test suite)

Serve with `python3 -m http.server 8787`, open `http://localhost:8787`,
load `sample.pdf`:

1. `S` cycles Book → Read → Half → Book; labels/status/persistence correct
   after reload.
2. Half mode: crisp fit-width render; pinch-drag scrolls vertically only and
   clamps at both edges; flick and ←/→ turn pages; the new page starts at top
   (forward and backward both).
3. Two-hand zoom gone in all modes (raise both hands → nothing claims the
   frame); single-hand tracking works.
4. Resize mid-half-page re-renders and re-clamps; a square/landscape page falls
   back to no-scroll.

## Caveats

- `.slide-page` canvas sizing during half-mode turns is the fiddliest bit
  (tall clone inside a slide frame sized for the page box) — verify it visually
  first during implementation.
- `renderPage`'s `0.97` padding factor applies to the tall box too; keep it for
  visual consistency with the other modes.
