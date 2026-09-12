# GestureBook

A local PDF reader you turn and scroll with webcam hand gestures (MediaPipe
HandLandmarker). Dark reading-room UI, no build step, no dependencies to
install.

## Run

    cd ~/apps/gesturebook
    python3 -m http.server 8787
    open http://localhost:8787

A `sample.pdf` (8 pages) is included — regenerate with `python3 generate_sample.py`.

Camera access requires `localhost` or HTTPS — both are satisfied when serving
locally. First load needs internet for the CDNs listed below.

## Views

Press **S** (or pinch-hold the floating mode button ~2s) to cycle:

**Book** → two-page spread, page-flip animation.
**Read** → one page at a time, fit-to-page, slide transitions.
**Half-page** → one page rendered fit-to-width at full resolution — crisper
text than Read view — cropped to a wide, short window that you scroll
vertically; page turns are still whole-page jumps (flick or arrow keys), not
part of the scroll.

## Controls

| Input | Action |
|---|---|
| Pinch (thumb + index) and drag left / right | Grab the page and turn it; release decides commit vs. cancel |
| Quick open-hand swipe left / right | Flick-turn without a full pinch-drag |
| Pinch and drag, in Half-page view | Scroll the page vertically (clamped at top/bottom — doesn't turn pages) |
| Pinch-hold the mode button ~2s | Cycle Book → Read → Half-page |
| Open palm, hold ~1s | Bring back the top controls |
| ← / → keys | Turn pages without the camera |
| ↑ / ↓ keys, in Half-page view | Scroll without the camera |
| S key | Cycle views |
| Drag-and-drop / Open PDF | Load any PDF |

All hand coordinates are mirrored to selfie view, so moving your hand left
turns the page forward, matching how it looks turning a real page.

A soft green ring tracks your index fingertip over the book for spatial
feedback (no camera feed shown). Two-hand zoom has been removed — Half-page
view replaces it with a crisper, simpler way to read closer.

Last PDF name, page/spread, and view mode are remembered via localStorage and
restored when you reopen the same file.

## Stack

- **PDF.js 3.11.174** — cdnjs (`pdf.min.js`, `pdf.worker.min.js`)
- **@mediapipe/tasks-vision 0.10.14** — jsDelivr ESM (`vision_bundle.mjs`, `/wasm`)
- **Hand model** — `hand_landmarker.task` (float16) from storage.googleapis.com
- Plain HTML/CSS/JS modules; served by `python3 -m http.server`
