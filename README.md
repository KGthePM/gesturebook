# GestureBook

A local PDF reader you turn and scroll with webcam hand gestures (MediaPipe
HandLandmarker). Dark reading-room UI, no build step, no dependencies to
install.

The landing page stages the closed book like a product shot: serif headline
("Turn pages with a pinch.") above a spotlit, gently floating book with a
hover sheen, an "Open a PDF" pill below it, and a per-theme backdrop
(classic dusk wash, Seattle rain, Boston lamplight). The whole landing page
is the drop target — click anywhere (or the pill) to browse for a file.

## Run

    ./start.sh

That picks the first free port from 8787 upward, prints the URL, and opens
it in your browser. Overrides: `PORT=9000 ./start.sh` to start elsewhere,
`BIND=0.0.0.0 ./start.sh` to also serve your local network.

The manual equivalent:

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
text than Read view — cropped to a wide, short window you scroll vertically.
Scrolling is continuous: keep scrolling past the bottom of a page and it
flows straight into the next one, with no page-turn animation. The open-hand
swipe/flick is disabled in this view; ← / → jump straight to the top of the
next/previous page as a coarse shortcut.

## Controls

| Input | Action |
|---|---|
| Pinch (thumb + index) and drag left / right | Grab the page and turn it; release decides commit vs. cancel (Book / Read views) |
| Quick open-hand swipe left / right | Flick-turn without a full pinch-drag (Book / Read views) |
| Pinch and drag, in Half-page view | Scroll continuously through the document, across page boundaries (clamped at the very first/last page) |
| Pinch-hold the mode button ~2s | Cycle Book → Read → Half-page |
| Open palm, hold ~1s | Bring back the top controls |
| ← / → keys | Turn pages (Book / Read); jump to the next/previous page's top (Half-page) |
| ↑ / ↓ keys, in Half-page view | Scroll continuously without the camera |
| S key | Cycle views |
| Drag-and-drop / Open PDF | Load any PDF |

All hand coordinates are mirrored to selfie view, so moving your hand left
turns the page forward, matching how it looks turning a real page.

A soft green ring tracks your index fingertip over the book for spatial
feedback (no camera feed shown). Two-hand zoom has been removed — Half-page
view replaces it with a crisper, simpler way to read closer.

The last-opened PDF itself is cached in the browser (IndexedDB) and automatically
resumes — reloading the page reopens it at the same page/spread and view mode with
no clicks needed. If storage is unavailable, it falls back to the old behavior of
remembering position/mode only, applied when you manually reopen the same file.

Click the page counter to type a page number and jump straight to it, in any view
mode. PDFs with bookmarks show a Contents button next to it; clicking an entry
jumps to that page. A reading-progress percentage is shown alongside the page
counter too.

## Stack

- **PDF.js 3.11.174** — cdnjs (`pdf.min.js`, `pdf.worker.min.js`)
- **@mediapipe/tasks-vision 0.10.14** — jsDelivr ESM (`vision_bundle.mjs`, `/wasm`)
- **Hand model** — `hand_landmarker.task` (float16) from storage.googleapis.com
- Plain HTML/CSS/JS modules; served by `python3 -m http.server`
