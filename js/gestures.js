/* gestures.js — MediaPipe HandLandmarker driving page-follow swipes,
 * pinch/spread zoom, and open-palm hold.
 *
 * Swipe state machine:
 *   idle → (wrist moves ≥ ENGAGE in ≤150ms) → dragging
 *   dragging: page angle tracks hand x (page-follow)
 *     commit  when progress > 0.55 or flick velocity ≥ FLICK
 *     cancel  when hand retreats or is lost
 *   cooldown 700ms, then idle.
 */

import { HandLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const WASM_ROOT = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

const WINDOW_MS = 150;      // velocity look-back
const ENGAGE = 0.10;        // normalized wrist x displacement to start a drag
const FLICK = 0.30;         // fast-swipe commit threshold within window
const TRACK_SPAN = 0.40;    // hand travel (normalized x) for a full page turn
const COMMIT_AT = 0.55;     // progress past which a drag commits
const COOLDOWN_MS = 700;

const PINCH_IN = 0.32;      // thumb-index distance / hand-span thresholds
const SPREAD_OUT = 1.12;
const PINCH_LOCK_MS = 800;

const PALM_HOLD_MS = 1000;  // open palm held → show controls

const HAND_CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17],
];

const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export class GestureEngine {
  constructor({ video, overlayCanvas, callbacks }) {
    this.video = video;
    this.overlayCanvas = overlayCanvas;
    this.cb = callbacks;   // { canDrag, onDragStart, onDragProgress, onDragCommit,
                           //   onDragCancel, onZoom, onPalmHold, onStatus }
    this.landmarker = null;
    this.running = false;
    this.stream = null;
    this.lastVideoTime = -1;

    this.buf = [];               // wrist samples [{t, x}]
    this.state = "idle";         // idle | dragging | cooldown
    this.stateT = 0;
    this.dir = null;
    this.anchorX = 0;

    this.pinchNeutral = true;    // requires return-to-neutral between zoom gestures
    this.lastPinchT = 0;

    this.palmSince = 0;
    this.palmFired = false;
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
    this.state = "idle";
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
      this._draw(res);
    }
    requestAnimationFrame(() => this._loop());
  }

  _process(res, now) {
    const hasHand = res.landmarks && res.landmarks.length > 0;

    if (!hasHand) {
      this.buf = [];
      if (this.state === "dragging") this._cancel();
      else if (this.state === "cooldown" && now - this.stateT > COOLDOWN_MS) this.state = "idle";
      this.pinchNeutral = true;
      this.palmSince = 0;
      return;
    }

    const lm = res.landmarks[0];
    const x = lm[0].x;
    this.buf.push({ t: now, x });
    while (this.buf.length && now - this.buf[0].t > WINDOW_MS) this.buf.shift();
    const dx = x - this.buf[0].x;

    if (this.state === "cooldown" && now - this.stateT > COOLDOWN_MS) {
      this.state = "idle"; this.buf = [{ t: now, x }];
    }

    if (this.state === "idle") {
      if (dx <= -ENGAGE && this.cb.canDrag("forward")) {
        this._engage("forward", x, now);
      } else if (dx >= ENGAGE && this.cb.canDrag("backward")) {
        this._engage("backward", x, now);
      }
    }

    if (this.state === "dragging") {
      const travel = this.dir === "forward" ? this.anchorX - x : x - this.anchorX;
      const progress = travel / TRACK_SPAN;
      this.cb.onDragProgress(this.dir, Math.max(0, Math.min(1, progress)));
      if (progress > COMMIT_AT || (this.dir === "forward" ? dx < -FLICK : dx > FLICK)) {
        this._commit(now);
      } else if (travel < 0.02 && Math.abs(dx) < 0.03) {
        this._cancel(now);       // hand drifted back — snap home
      }
    }

    this._pinch(lm, now);
    this._palm(lm, now);
  }

  _engage(dir, x, now) {
    this.state = "dragging";
    this.dir = dir;
    this.anchorX = x;
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
    const span = Math.max(d(lm[0], lm[9]), 1e-6);
    const ratio = d(lm[4], lm[8]) / span;
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

  /* ---------- preview skeleton ---------- */

  _draw(res) {
    const c = this.overlayCanvas;
    if (c.width !== this.video.videoWidth || c.height !== this.video.videoHeight) {
      c.width = this.video.videoWidth || 320;
      c.height = this.video.videoHeight || 240;
    }
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
    if (!res.landmarks || !res.landmarks.length) return;
    const lm = res.landmarks[0];
    ctx.strokeStyle = "rgba(140, 225, 170, 0.85)";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.beginPath();
      ctx.moveTo(lm[a].x * c.width, lm[a].y * c.height);
      ctx.lineTo(lm[b].x * c.width, lm[b].y * c.height);
      ctx.stroke();
    }
    ctx.fillStyle = "#ffd166";
    for (const p of lm) {
      ctx.beginPath();
      ctx.arc(p.x * c.width, p.y * c.height, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    // highlight thumb–index pinch pair
    ctx.fillStyle = "#8ab4f8";
    for (const i of [4, 8]) {
      ctx.beginPath();
      ctx.arc(lm[i].x * c.width, lm[i].y * c.height, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
