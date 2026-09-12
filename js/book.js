/* book.js — two-page spread rendering + CSS 3D page turns with live page-follow.
 * Exposes a drag API so gestures can steer the flip: beginDrag(dir) → dragTo(p) → commit/cancel.
 */

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
  }

  setDocument(pdfDoc) {
    this.pdfDoc = pdfDoc;
    this.spread = 0;
    this.setZoom(1);
    this._cleanupFlip();
    this.busy = false;
    return this.renderSpread();
  }

  get numPages() { return this.pdfDoc ? this.pdfDoc.numPages : 0; }

  pageBox() {
    const p = this.leftCanvas.parentElement;
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

  label() {
    if (!this.pdfDoc) return "No PDF loaded";
    const n = this.numPages;
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
    return dir === "forward" ? this.spread + 3 <= this.numPages : this.spread > 0;
  }

  async beginDrag(dir) {
    if (!this.canDrag(dir)) return false;
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

  dragTo(p) {                            // p in 0..1 (1 = fully turned)
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
    if (!this._flip) return;
    const newSpread = this._flipDir === "forward" ? this.spread + 2 : this.spread - 2;
    this._animateTo(this._flipDir === "forward" ? -180 : 0, newSpread);
  }

  cancelDrag() {
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
