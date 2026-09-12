# GestureBook

A local PDF reader that renders any PDF as a two-page book you turn with
webcam hand swipes (MediaPipe HandLandmarker). Dark reading-room UI, no
build step, no dependencies to install.

## Run

    cd ~/apps/gesturebook
    python3 -m http.server 8787
    open http://localhost:8787

A `sample.pdf` (8 pages) is included — regenerate with `python3 generate_sample.py`.

## Controls

| Input | Action |
|---|---|
| Swipe hand left / right | Turn to next / previous spread (page follows your hand mid-swipe; mirrored to selfie view) |
| Open palm, hold ~1s | Bring back the top controls |
| ← / → keys | Turn pages without the camera |
| Drag-and-drop / Open PDF | Load any PDF |

A soft green ring tracks your index fingertip over the book for spatial feedback
(no camera feed shown). Zoom gestures (pinch/spread) are currently disabled —
flip `ENABLE_ZOOM` in `js/gestures.js` to experiment.

Last PDF name and page are remembered via localStorage and restored when you
reopen the same file.

## Stack

- **PDF.js 3.11.174** — cdnjs (`pdf.min.js`, `pdf.worker.min.js`)
- **@mediapipe/tasks-vision 0.10.14** — jsDelivr ESM (`vision_bundle.mjs`, `/wasm`)
- **Hand model** — `hand_landmarker.task` (float16) from storage.googleapis.com
- Plain HTML/CSS/JS modules; served by `python3 -m http.server`

Camera access requires `localhost` or HTTPS — both are satisfied when serving
locally. First load needs internet for the three CDNs above.
