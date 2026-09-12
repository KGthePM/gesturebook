/* gestures.js — MediaPipe HandLandmarker driving pinch-to-grab page turns.
 *
 * Coordinates are MIRRORED to selfie view (1 - x) so moving your hand left
 * on your side moves the pointer left on screen and turns to the NEXT page —
 * matching natural "flick the page away" intuition.
 *
 * v2.0 — pinch-to-grab (primary):
 *   idle → (thumb+index pinched: ratio < PINCH_ON) → grabbing
 *   grabbing: page direction locks once the hand moves > GRAB_DEADZONE
 *     (hand-left = forward/next, hand-right = backward/previous);
 *     the page then follows hand x from the grab anchor (page-follow).
 *   dragging (pinch-owned): RELEASING the pinch decides —
 *     progress > COMMIT_AT → commit, else cancel (snap home).
 *   Release before moving → idle, nothing happens.
 *   Hysteresis: grab at ratio < PINCH_ON, release at ratio > PINCH_OFF,
 *   so the pinch can't flutter at the boundary.
 *
 * Fast wrist-flick (secondary quick-turn) is kept for an open hand:
 *   idle → (wrist moves ≥ ENGAGE in ≤ WINDOW_MS) → dragging
 *   dragging (flick-owned): commit on progress > COMMIT_AT or flick
 *   velocity ≥ FLICK; cancel on retreat or hand loss.
 *
 * v3.0 additions:
 *   - DWELL TOGGLE: while pinched (grabbing, page not yet lifted), hold the
 *     pinch pointer inside the mode-toggle button for DWELL_MS → fires
 *     onDwellToggle() once, then requires an unpinch. Moving out of the
 *     button resets the dwell; dragging never starts while inside it.
 *   - PINCH-PAN (half mode): when canPan() is true, a pinch-grab becomes a
 *     scroll instead of a page turn — onPanStart/onPanMove/onPanEnd.
 *
 * One gesture owns the frame: pan/dwell only run from the grabbing state.
 */

import { HandLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const WASM_ROOT = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

/* ---------- tuning knobs (Kyle: nudge these, nowhere else) ---------- */

const PINCH_ON = 0.30;        // pinch ratio below this GRABS the page (lower = need tighter pinch)
const PINCH_OFF = 0.42;       // pinch ratio above this RELEASES (hysteresis; keep > PINCH_ON)
const GRAB_DEADZONE = 0.015;  // hand travel before direction locks & page lifts (small = eager)
const TRACK_SPAN = 0.30;      // hand travel (normalized x) for a full page turn (lower = easier)
const COMMIT_AT = 0.32;       // release past this progress commits the turn (lower = easier)

const WINDOW_MS = 150;        // velocity look-back (flick path)
const ENGAGE = 0.10;          // wrist x displacement to start a flick drag (open hand)
const FLICK = 0.30;           // fast-swipe commit threshold within window (flick path)
const COOLDOWN_MS = 700;      // ignore gestures right after a commit/cancel

const PALM_HOLD_MS = 1000;    // open palm held → show controls

const DWELL_MS = 2000;        // pinch-hold on the toggle button before it fires (lower = faster)
const DWELL_PAD = 44;         // px of slack around the button that still counts as "on it"
const PAN_GAIN = 1.15;        // page pans this multiple of hand movement (higher = faster pan)

const ENABLE_ZOOM = false;    // legacy single-hand pinch/spread zoom (dormant)
const PINCH_IN = 0.30;        // (zoom, dormant) ratio for zoom-in
const SPREAD_OUT = 1.0;       // (zoom, dormant) ratio for zoom-out
const PINCH_LOCK_MS = 400;    // (zoom, dormant) min gap between zoom steps

const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp01 = (v) => Math.max(0, Math.min(1, v));

export class GestureEngine {
  constructor({ video, overlayCanvas, pointerEl, dwellEl, callbacks }) {
    this.video = video;
    this.overlayCanvas = overlayCanvas;   // kept for API compat; no longer drawn
    this.pointerEl = pointerEl;           // fingertip glow element over the book
    this.dwellEl = dwellEl;               // mode-toggle button (dwell target); may be null
    this.cb = callbacks;   // { canDrag, onDragStart, onDragProgress, onDragCommit,
                           //   onDragCancel, onZoom, onPalmHold, onStatus,
                           //   canPan, onPanStart, onPanMove, onPanEnd,
                           //   onDwell, onDwellToggle }
    this.landmarker = null;
    this.running = false;
    this.stream = null;
    this.lastVideoTime = -1;

    this.buf = [];               // wrist samples [{t, x}]
    this.state = "idle";         // idle | grabbing | dragging | panning | cooldown
    this.stateT = 0;
    this.dir = null;
    this.anchorX = 0;
    this.pinchOwner = false;     // true → pinch-grab drag (release decides)
    this.pinchArmed = true;      // requires unpinch between grabs (no double-turn)

    this.pinchNeutral = true;    // requires return-to-neutral between zoom gestures
    this.lastPinchT = 0;

    this.palmSince = 0;
    this.palmFired = false;

    /* dwell toggle */
    this.dwellT = 0;             // ms accumulated inside the button this pinch
    this.dwellInside = false;
    this.dwellFired = false;     // one shot per pinch; reset on unpinch

    /* pinch-pan */
    this.panX = 0; this.panY = 0;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 }, audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    if (!this.landmarker) {
      const fileset = await FilesetResolver.forVisionTasks(WASM_ROOT);
      const opts = (delegate) => ({
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        runningMode: "VIDEO",
        numHands: 1,
      });
      try {
        this.landmarker = await HandLandmarker.createFromOptions(fileset, opts("GPU"));
      } catch (e) {
        console.warn("GPU delegate unavailable, using CPU:", e);
        this.landmarker = await HandLandmarker.createFromOptions(fileset, opts("CPU"));
      }
    }
    this.running = true;
    this._loop();
  }

  stop() {
    this.running = false;
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    this.video.srcObject = null;
    const ctx = this.overlayCanvas.getContext("2d");
    ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    if (this.state === "dragging") { this._cancel(); }
    if (this.state === "panning" && this.cb.onPanEnd) this.cb.onPanEnd();
    this._resetDwell();
    this.state = "idle";
    if (this.pointerEl) this.pointerEl.classList.remove("on");
  }

  /* ---------- per-frame ---------- */

  _loop() {
    if (!this.running) return;
    if (this.landmarker && this.video.readyState >= 2 &&
        this.video.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = this.video.currentTime;
      const now = performance.now();
      const res = this.landmarker.detectForVideo(this.video, now);
      this._process(res, now);
      this._pointer(res);
    }
    requestAnimationFrame(() => this._loop());
  }

  /* pinch ratio: thumb-index tip distance normalized by hand span (wrist→middle MCP) */
  _pinchRatio(lm) {
    const span = Math.max(d(lm[0], lm[9]), 1e-6);
    return d(lm[4], lm[8]) / span;
  }

  _resetDwell() {
    this.dwellT = 0;
    this.dwellInside = false;
    if (this.cb.onDwell) this.cb.onDwell(0);
  }

  /* dwell hit test against the toggle button (inflated by DWELL_PAD px) */
  _dwellHit(px, py) {
    const el = this.dwellEl;
    if (!el || el.classList.contains("hidden") || el.offsetParent === null) return false;
    const r = el.getBoundingClientRect();
    return px >= r.left - DWELL_PAD && px <= r.right + DWELL_PAD &&
           py >= r.top - DWELL_PAD && py <= r.bottom + DWELL_PAD;
  }

  _process(res, now) {
    const hasHand = res.landmarks && res.landmarks.length > 0;

    if (!hasHand) {
      this.buf = [];
      if (this.state === "dragging") this._cancel(now);       // lost tracking mid-drag
      else if (this.state === "panning") { this.state = "idle"; if (this.cb.onPanEnd) this.cb.onPanEnd(); }
      else if (this.state === "grabbing") { this.state = "idle"; this._resetDwell(); }
      else if (this.state === "cooldown" && now - this.stateT > COOLDOWN_MS) this.state = "idle";
      this.pinchNeutral = true;
      this.palmSince = 0;
      return;
    }

    const lm = res.landmarks[0];
    const x = 1 - lm[0].x;             // mirror to selfie view: hand-left = screen-left
    const tipX = (1 - lm[8].x) * window.innerWidth;   // pinch pointer (index tip, mirrored)
    const tipY = lm[8].y * window.innerHeight;
    const ratio = this._pinchRatio(lm);
    this.buf.push({ t: now, x });
    while (this.buf.length && now - this.buf[0].t > WINDOW_MS) this.buf.shift();
    const dx = x - this.buf[0].x;

    if (this.state === "cooldown" && now - this.stateT > COOLDOWN_MS) {
      this.state = "idle"; this.buf = [{ t: now, x }];
    }

    if (this.state === "idle") {
      if (ratio > PINCH_OFF) { this.pinchArmed = true; this.dwellFired = false; }
      if (this.pinchArmed && !this.dwellFired && ratio < PINCH_ON) {
        this._grab(x);
      } else if (dx <= -ENGAGE && this.cb.canDrag("forward")) {
        this._engageFlick("forward", x, now);
      } else if (dx >= ENGAGE && this.cb.canDrag("backward")) {
        this._engageFlick("backward", x, now);
      }
    } else if (this.state === "grabbing") {
      /* v3 dwell: pinch held over the toggle button → accumulate, never drag */
      const hit = !this.dwellFired && this._dwellHit(tipX, tipY);
      if (hit !== this.dwellInside) {
        this.dwellInside = hit;
        if (!hit) this.dwellT = 0;
      }
      if (this.dwellInside) {
        this.anchorX = x;                     // keep the drag anchor fresh
        this.dwellT += 33;                    // ~one video frame at 30fps
        if (this.cb.onDwell) this.cb.onDwell(clamp01(this.dwellT / DWELL_MS));
        if (this.dwellT >= DWELL_MS) {
          this.dwellFired = true;
          this._resetDwell();
          this.state = "cooldown"; this.stateT = now; this.buf = [];
          this.cb.onDwellToggle();
        }
      } else if (ratio > PINCH_OFF) {
        this.state = "idle"; this.buf = [{ t: now, x }];   // released before moving
        this._resetDwell();
        this.cb.onStatus("released");
      } else {
        /* v3 pan: zoomed-in single mode steals the grab */
        if (this.cb.canPan && this.cb.canPan()) {
          this.state = "panning";
          this.panX = tipX; this.panY = tipY;
          if (this.cb.onPanStart) this.cb.onPanStart();
          this.cb.onStatus("grabbed \u00b7 panning");
        } else {
          const off = x - this.anchorX;
          if (Math.abs(off) > GRAB_DEADZONE) {
            const dir = off < 0 ? "forward" : "backward";    // mirrored: hand-left = next
            if (this.cb.canDrag(dir)) {
              this._engageGrab(dir, now);
            } else {
              this.anchorX = x;   // can't turn that way — recenter and let them reverse
            }
          }
        }
      }
    } else if (this.state === "panning") {
      if (ratio > PINCH_OFF) {                              // release ends the pan
        this.state = "cooldown"; this.stateT = now; this.buf = [];
        if (this.cb.onPanEnd) this.cb.onPanEnd();
        this.cb.onStatus("pan released");
      } else {
        const dxpx = (tipX - this.panX) * PAN_GAIN;
        const dypx = (tipY - this.panY) * PAN_GAIN;
        this.panX = tipX; this.panY = tipY;
        if (this.cb.onPanMove) this.cb.onPanMove(-dxpx, dypx);  // drag content, not viewport
      }
      return;
    }

    if (this.state === "dragging") {
      const travel = this.dir === "forward" ? this.anchorX - x : x - this.anchorX;
      const progress = travel / TRACK_SPAN;
      this.cb.onDragProgress(this.dir, clamp01(progress));
      if (this.pinchOwner) {
        if (ratio > PINCH_OFF) {                            // release DECIDES
          if (progress > COMMIT_AT) this._commit(now);
          else this._cancel(now);
        }
      } else if (progress > COMMIT_AT || (this.dir === "forward" ? dx < -FLICK : dx > FLICK)) {
        this._commit(now);
      } else if (travel < 0.02 && Math.abs(dx) < 0.03) {
        this._cancel(now);       // hand drifted back — snap home
      }
    }

    if (ENABLE_ZOOM && this.state === "idle") {   // one gesture owns the frame
      this._pinch(lm, now);
      this._palm(lm, now);
    }
  }

  _grab(x) {
    this.state = "grabbing";
    this.pinchArmed = false;      // must unpinch before the next grab
    this.anchorX = x;
    this.dwellT = 0;
    this.dwellInside = false;
    this.cb.onStatus("pinch \u00b7 page grabbed");
  }

  _engageGrab(dir, now) {
    this.state = "dragging";
    this.pinchOwner = true;
    this.dir = dir;
    this.stateT = now;
    this._resetDwell();
    this.cb.onDragStart(dir);
    this.cb.onStatus(dir === "forward" ? "grabbed \u00b7 following hand \u2192 next page"
                                       : "grabbed \u00b7 following hand \u2190 previous page");
  }

  _engageFlick(dir, x, now) {
    this.state = "dragging";
    this.pinchOwner = false;
    this.dir = dir;
    this.anchorX = x;
    this.stateT = now;
    this.cb.onDragStart(dir);
    this.cb.onStatus(dir === "forward" ? "following swipe \u2192 next page"
                                       : "following swipe \u2190 previous page");
  }

  _commit(now) {
    this.state = "cooldown"; this.stateT = now; this.buf = [];
    this.cb.onDragCommit();
    this.cb.onStatus(this.dir === "forward" ? "page turned \u2192" : "page turned \u2190");
  }

  _cancel(now = performance.now()) {
    this.state = "cooldown"; this.stateT = now; this.buf = [];
    this.cb.onDragCancel();
    this.cb.onStatus("page returned");
  }

  /* pinch-in → zoom in · finger-spread → zoom out (latched, with neutral reset) */
  _pinch(lm, now) {
    const ratio = this._pinchRatio(lm);
    if (ratio > 0.5 && ratio < 0.95) { this.pinchNeutral = true; return; }
    if (!this.pinchNeutral || now - this.lastPinchT < PINCH_LOCK_MS) return;
    if (ratio < PINCH_IN) {
      this.pinchNeutral = false; this.lastPinchT = now;
      this.cb.onZoom(+1); this.cb.onStatus("pinch \u00b7 zoom in");
    } else if (ratio > SPREAD_OUT) {
      this.pinchNeutral = false; this.lastPinchT = now;
      this.cb.onZoom(-1); this.cb.onStatus("spread \u00b7 zoom out");
    }
  }

  /* all four fingers extended (tip farther from wrist than PIP) for PALM_HOLD_MS */
  _palm(lm, now) {
    const extended = [[8,6],[12,10],[16,14],[20,18]].every(([tip, pip]) =>
      d(lm[tip], lm[0]) > d(lm[pip], lm[0]) * 1.12);
    if (extended) {
      if (!this.palmSince) this.palmSince = now;
      if (!this.palmFired && now - this.palmSince >= PALM_HOLD_MS) {
        this.palmFired = true;
        this.cb.onPalmHold();
        this.cb.onStatus("open palm \u00b7 controls");
      }
    } else {
      this.palmSince = 0;
      this.palmFired = false;
    }
  }

  /* ---------- on-book fingertip pointer ---------- */
  /* Instead of a POV camera feed, a soft glow tracks the index fingertip
   * (mirrored) over the whole viewport — spatial feedback without video. */
  _pointer(res) {
    const el = this.pointerEl;
    if (!el) return;
    if (!res.landmarks || !res.landmarks.length) {
      el.classList.remove("on");
      return;
    }
    const tip = res.landmarks[0][8];       // index fingertip
    const x = (1 - tip.x) * window.innerWidth;
    const y = tip.y * window.innerHeight;
    el.style.transform = `translate(${x}px, ${y}px)`;
    el.classList.add("on");
  }
}
