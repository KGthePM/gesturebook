/* book.js — two-page spread rendering + CSS 3D page turns with live page-follow,
 * plus a v3 single-page Read view with cross-fade slide transitions.
 * Exposes a drag API so gestures can steer the flip: beginDrag(dir) → dragTo(p) → commit/cancel.
 */

const MAX_READ_ZOOM = 3;   // single-mode zoom ceiling (1 = fit page)

export class Book {
  constructor({ bookEl, leftCanvas, rightCanvas, flipLayer, onSpreadChange }) {
    this.bookEl = bookEl;
    this.leftCanvas = leftCanvas;
    this.rightCanvas = rightCanvas;
    this.flipLayer = flipLayer;
    this.onSpreadChange = onSpreadChange;
    this.pdfDoc = null;
    this.spread = 0;        // 0-based; visible pages = spread+1, spread+2
    this.busy = false;      // flip in progress (triggered or manual drag)
    this.zoom = 1;
    this._flip = null;
    this._finish = null;
    this.readMode = "book";     // "book" | "single"
    this.page = 1;              // 1-based page in single mode
    this.readZoom = 1;          // single-mode zoom level (1 = fit)
    this.readX = 0;             // pan offsets (px, page-box units at zoom)
    this.readY = 0;
    this._slide = null;
    this._slideDir = null;
    this._slideFrom = 0;
  }

  /* ---------- v3: single-page read mode ---------- */

  get isSingle() { return this.readMode === "single"; }

  setReadMode(mode) {
    if (mode === this.readMode || !this.pdfDoc) return;
    if (this.busy) return;
    this.readMode = mode;
    if (mode === "single") {
      this.page = Math.min(this.spread + 1, this.numPages);
      this._resetReadView();
    } else {
      // return to book view: put the spread on the same page the reader left off
      this.spread = Math.max(0, Math.min(this.page - 1, this.numPages - 2));
      this.page = 0;
      this.setZoom(1);  // clear any book-zoom transform
      this._applySingle(false);
      this.renderSpread().then(() => {
        this.busy = false;
        if (this.onSpreadChange) this.onSpreadChange(this.spread, this.numPages);
      });
      return;
    }
    this._applySingle(true);
    this.renderPage(this.page, this.rightCanvas, ...Object.values(this.pageBox()))
      .then(() => { this.busy = false; if (this.onSpreadChange) this.onSpreadChange(this.spread, this.numPages); });
  }

  _resetReadView() {
    this.readZoom = 1; this.readX = 0; this.readY = 0;
  }

  _applySingle(on) {
    document.documentElement.classList.toggle("single-mode", !!on);
    if (on) this._applyReadTransform();
    else this._clearReadTransform();
  }

  _clearReadTransform() {
    this.rightCanvas.style.transform = "";
  }

  _applyReadTransform() {
    const { w, h } = this.pageBox();
    const maxX = Math.max(0, (w * this.readZoom - w) / 2);
    const maxY = Math.max(0, (h * this.readZoom - h) / 2);
    const px = Math.max(-maxX, Math.min(maxX, this.readX));
    const py = Math.max(-maxY, Math.min(maxY, this.readY));
    this.readX = px; this.readY = py;
    this.rightCanvas.style.transform =
      `translate(${px}px, ${py}px) scale(${this.readZoom})`;
  }

  /* Continuous two-hand zoom: factor > 1 zooms in. Clamped to [1, MAX_READ_ZOOM]. */
  setReadZoom(factor) {
    const z = Math.max(1, Math.min(MAX_READ_ZOOM, factor));
    if (z === this.readZoom) return;
    // keep the pan clamped as we zoom out (content shrinks back toward fit)
    this.readZoom = z;
    this._applyReadTransform();
  }

  /* Pan by pixels of hand movement mapped through the current zoom. */
  readPan(dx, dy) {
    this.readX += dx;
    this.readY += dy;
    this._applyReadTransform();
  }

  get numPages() { return this.pdfDoc ? this.pdfDoc.numPages : 0; }

  setDocument(pdfDoc) {
    this.pdfDoc = pdfDoc;
    this.spread = this.isSingle ? 0 : this.spread;
    this.page = 1;
    this._resetReadView();
    this.setZoom(1);
    this._cleanupFlip();
    this.busy = false;
    this._applySingle(this.isSingle);
    return this.isSingle
      ? this.renderPage(this.page, this.rightCanvas, ...Object.values(this.pageBox()))
      : this.renderSpread();
  }

  pageBox() {
    // measure the RIGHT page container — the left one is display:none in
    // single mode, which zeroed w/h and rendered a blank 1×1 canvas.
    const p = this.rightCanvas.parentElement;
    return { w: p.clientWidth, h: p.clientHeight };
  }

  _cloneCanvas(src) {
    const c = document.createElement("canvas");
    c.width = src.width; c.height = src.height;
    c.getContext("2d").drawImage(src, 0, 0);
    return c;
  }

  async renderPage(pageNum, canvas, w, h) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#f7f4ec";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!this.pdfDoc || !pageNum || pageNum < 1 || pageNum > this.pdfDoc.numPages) return;
    const page = await this.pdfDoc.getPage(pageNum);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(canvas.width / base.width, canvas.height / base.height) * 0.97;
    const vp = page.getViewport({ scale });
    const ox = (canvas.width - vp.width) / 2;
    const oy = (canvas.height - vp.height) / 2;
    await page.render({
      canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, ox, oy],
    }).promise;
  }

  async renderSpread() {
    const { w, h } = this.pageBox();
    await Promise.all([
      this.renderPage(this.spread + 1, this.leftCanvas, w, h),
      this.renderPage(this.spread + 2, this.rightCanvas, w, h),
    ]);
    if (this.onSpreadChange) this.onSpreadChange(this.spread, this.numPages);
  }

  /* Mode-aware re-render for resize: single mode tracks `page`, not `spread`. */
  async renderCurrent() {
    if (this.isSingle) {
      await this.renderPage(this.page, this.rightCanvas, ...Object.values(this.pageBox()));
      this._applyReadTransform();
    } else {
      await this.renderSpread();
    }
  }

  label() {
    if (!this.pdfDoc) return "No PDF loaded";
    const n = this.numPages;
    if (this.isSingle) return `${this.page} of ${n}`;
    const l = Math.min(this.spread + 1, n);
    const r = Math.min(this.spread + 2, n);
    return `${l}\u2013${r} of ${n}`;
  }

  setZoom(z) {
    this.zoom = z;
    this.bookEl.style.transform = z === 1 ? "" : `scale(${z})`;
    this.bookEl.style.boxShadow = z === 1 ? "" :
      "0 1px 2px rgba(0,0,0,0.4), 0 16px 44px rgba(0,0,0,0.55), 0 48px 120px rgba(0,0,0,0.6)";
  }

  /* ---------- flip plumbing ---------- */

  _buildFlip(frontCanvas, backCanvas) {
    const flip = document.createElement("div");
    flip.className = "flip-page";
    const f = document.createElement("div"); f.className = "face front"; f.appendChild(frontCanvas);
    const b = document.createElement("div"); b.className = "face back";  b.appendChild(backCanvas);
    flip.appendChild(f); flip.appendChild(b);
    return flip;
  }

  _cleanupFlip() {
    if (this._flip) { this._flip.remove(); this._flip = null; }
    if (this._slide) { this._slide.remove(); this._slide = null; }
    if (this._finish) { this._finish = null; }
  }

  _armFinish(flip, newSpread) {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      this.spread = newSpread;
      this._cleanupFlip();
      this.renderSpread().then(() => { this.busy = false; });
    };
    flip.addEventListener("transitionend", finish);
    setTimeout(finish, 900);          // safety net if transitionend never fires
  }

  /* A forward flip turns the right page leftward: rotateY 0 → -180.
   * A backward flip starts at -180 (lying on the left half) and rotates → 0. */

  canDrag(dir) {
    if (!this.pdfDoc || this.busy) return false;
    if (this.isSingle) {
      if (this.readZoom > 1.01) return false;   // zoomed: pinch-grab pans instead
      return dir === "forward" ? this.page < this.numPages : this.page > 1;
    }
    return dir === "forward" ? this.spread + 3 <= this.numPages : this.spread > 0;
  }

  /* ---------- v3: single-page slide turns ----------
   * forward: current page slides left, next page already rendered underneath.
   * backward: previous page slides in from the left over the current one. */

  _buildSlide(canvas) {
    const slide = document.createElement("div");
    slide.className = "slide-page";
    slide.appendChild(canvas);
    return slide;
  }

  async beginDrag(dir) {
    if (!this.canDrag(dir)) return false;
    if (this.isSingle) return this._beginSlide(dir);
    this.busy = true;
    const { w, h } = this.pageBox();
    if (dir === "forward") {
      const front = this._cloneCanvas(this.rightCanvas);        // old right page
      const back = document.createElement("canvas");            // new left page
      await this.renderPage(this.spread + 3, back, w, h);
      await this.renderPage(this.spread + 4, this.rightCanvas, w, h);  // revealed underneath
      this._flip = this._buildFlip(front, back);
      this._flipDir = "forward";
      this._flip.style.transform = "rotateY(0deg)";
    } else {
      const back = this._cloneCanvas(this.leftCanvas);          // old left page
      const front = document.createElement("canvas");           // new right page
      await this.renderPage(this.spread, front, w, h);
      await this.renderPage(this.spread - 1, this.leftCanvas, w, h);   // revealed underneath
      this._flip = this._buildFlip(front, back);
      this._flipDir = "backward";
      this._flip.style.transform = "rotateY(-180deg)";
    }
    this.flipLayer.appendChild(this._flip);
    this._flip.getBoundingClientRect();   // force reflow so the first drag frame is clean
    return true;
  }

  /* ---------- single-mode slide plumbing ---------- */

  async _beginSlide(dir) {
    this.busy = true;
    const { w, h } = this.pageBox();
    if (dir === "forward") {
      // clone current page to slide away; render the next page underneath
      const cur = this._cloneCanvas(this.rightCanvas);
      this._slide = this._buildSlide(cur);
      this._slideDir = "forward";
      this._slideFrom = this.page;
      this._slide.style.transform = "translateX(0)";
      await this.renderPage(this.page + 1, this.rightCanvas, w, h);
      this._applyReadTransform();
    } else {
      // previous page slides in from the left over the current one
      const prev = document.createElement("canvas");
      await this.renderPage(this.page - 1, prev, w, h);
      this._slide = this._buildSlide(prev);
      this._slideDir = "backward";
      this._slideFrom = this.page;
      this._slide.style.transform = "translateX(-100%)";
    }
    this.flipLayer.appendChild(this._slide);
    this._slide.getBoundingClientRect();
    return true;
  }

  _slideTo(p) {                          // p 0..1 (1 = fully turned)
    if (!this._slide) return;
    const clamped = Math.max(0, Math.min(1.04, p));
    const pct = this._slideDir === "forward" ? -100 * clamped : -100 * (1 - clamped);
    this._slide.style.transform = `translateX(${pct}%)`;
  }

  _finishSlide(newPage, fromPct) {
    const slide = this._slide;
    if (!slide) { this.busy = false; return; }
    slide.classList.add("anim");
    slide.getBoundingClientRect();
    const to = this._slideDir === "forward" ? -100 : 0;
    requestAnimationFrame(() => { slide.style.transform = `translateX(${to}%)`; });
    let done = false;
    const finish = async () => {
      if (done) return;
      done = true;
      this.page = newPage;
      if (this._slideDir === "backward") {
        // the incoming page was only ever drawn on the slide's own throwaway
        // canvas — sync it onto rightCanvas before uncovering it, or the old
        // page's stale pixels show through once the slide is removed.
        const { w, h } = this.pageBox();
        await this.renderPage(this.page, this.rightCanvas, w, h);
        this._applyReadTransform();
      }
      slide.remove();
      this._slide = null;
      this.busy = false;
      if (this.onSpreadChange) this.onSpreadChange(this.spread, this.numPages);
    };
    slide.addEventListener("transitionend", finish);
    setTimeout(finish, 900);
  }

  dragTo(p) {                            // p in 0..1 (1 = fully turned)
    if (this._slide) { this._slideTo(p); return; }
    if (!this._flip) return;
    const clamped = Math.max(0, Math.min(1.04, p));
    const deg = this._flipDir === "forward" ? -180 * clamped : -180 * (1 - clamped);
    this._flip.style.transform = `rotateY(${deg}deg)`;
  }

  _animateTo(deg, newSpread) {
    const flip = this._flip;
    if (!flip) { this.busy = false; return; }
    flip.classList.add("anim");
    flip.getBoundingClientRect();
    requestAnimationFrame(() => { flip.style.transform = `rotateY(${deg}deg)`; });
    this._armFinish(flip, newSpread);
  }

  commitDrag() {
    if (this._slide) {
      this._finishSlide(this._slideDir === "forward" ? this._slideFrom + 1 : this._slideFrom - 1);
      return;
    }
    if (!this._flip) return;
    const newSpread = this._flipDir === "forward" ? this.spread + 2 : this.spread - 2;
    this._animateTo(this._flipDir === "forward" ? -180 : 0, newSpread);
  }

  cancelDrag() {
    if (this._slide) {
      const slide = this._slide;
      slide.classList.add("anim");
      slide.getBoundingClientRect();
      const home = this._slideDir === "forward" ? 0 : -100;
      requestAnimationFrame(() => { slide.style.transform = `translateX(${home}%)`; });
      let done = false;
      const restore = async () => {
        if (done) return;
        done = true;
        slide.remove();
        this._slide = null;
        if (this._slideDir === "forward") {
          // put the original page back on the main canvas
          const { w, h } = this.pageBox();
          await this.renderPage(this._slideFrom, this.rightCanvas, w, h);
          this._applyReadTransform();
        }
        this.busy = false;
      };
      slide.addEventListener("transitionend", restore);
      setTimeout(restore, 900);
      return;
    }
    if (!this._flip) { this.busy = false; return; }
    const startDeg = this._flipDir === "forward" ? 0 : -180;
    const flip = this._flip;
    flip.classList.add("anim");
    flip.getBoundingClientRect();
    requestAnimationFrame(() => { flip.style.transform = `rotateY(${startDeg}deg)`; });
    let done = false;
    const restore = () => {
      if (done) return;
      done = true;
      this._cleanupFlip();
      this.renderSpread().then(() => { this.busy = false; });
    };
    flip.addEventListener("transitionend", restore);
    setTimeout(restore, 900);
  }

  /* ---------- keyboard / fallback triggered turns ---------- */

  async turnForward() {
    if (!this.canDrag("forward")) return false;
    if (!(await this.beginDrag("forward"))) return false;
    this.commitDrag();
    return true;
  }

  async turnBackward() {
    if (!this.canDrag("backward")) return false;
    if (!(await this.beginDrag("backward"))) return false;
    this.commitDrag();
    return true;
  }
}
