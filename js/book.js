/* book.js — two-page spread rendering + CSS 3D page turns with live page-follow,
 * plus a v3 single-page Read view with cross-fade slide transitions.
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
    this.readMode = "book";     // "book" | "single" | "half"
    this.page = 1;              // 1-based page in single/half mode
    this._slide = null;
    this._slideDir = null;
    this._slideFrom = 0;

    /* half-mode continuous scroll strip */
    this._halfStrip = null;
    this._halfSlots = null;      // Map<pageNum, {slot, canvas}>
    this._halfRendered = null;   // Set<pageNum> with live pixels
    this._halfObserver = null;
  }

  /* ---------- v3: single-page read mode ---------- */

  get isSingle() { return this.readMode !== "book"; }
  get isHalf() { return this.readMode === "half"; }

  setReadMode(mode) {
    if (mode === this.readMode || !this.pdfDoc) return;
    if (this.busy) return;
    const prevMode = this.readMode;
    this.readMode = mode;
    if (prevMode === "half") this._teardownHalfStrip();
    if (mode === "book") {
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
    if (prevMode === "book") this.page = Math.min(this.spread + 1, this.numPages);
    this._applySingle(true);
    const render = mode === "half" ? this._buildHalfStrip() : this.renderCurrentPage();
    render.then(() => {
      this.busy = false;
      if (this.onSpreadChange) this.onSpreadChange(this.spread, this.numPages);
    });
  }

  _applySingle(on) {
    document.documentElement.classList.toggle("single-mode", !!on);
    document.documentElement.classList.toggle("half-mode", !!on && this.isHalf);
    if (!on) this.rightCanvas.style.transform = "";
  }

  /* ---------- v4: half-mode continuous scroll strip ----------
   * One fixed-size slot (div + canvas) per page, laid out up front so scroll
   * geometry never shifts under the user; only pixel content is lazily
   * rendered/evicted as slots cross the viewport (IntersectionObserver). */

  async _buildHalfStrip() {
    const strip = document.createElement("div");
    strip.className = "half-strip";
    this._halfSlots = new Map();
    this._halfRendered = new Set();

    for (let n = 1; n <= this.numPages; n++) {
      const { w, h } = await this._boxFor(n);
      const slot = document.createElement("div");
      slot.className = "half-slot";
      slot.style.height = `${h}px`;
      slot.dataset.page = String(n);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(w));
      canvas.height = Math.max(1, Math.floor(h));
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#f7f4ec";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      slot.appendChild(canvas);
      strip.appendChild(slot);
      this._halfSlots.set(n, { slot, canvas, w, h });
    }

    this.rightCanvas.parentElement.appendChild(strip);
    this._halfStrip = strip;
    strip.scrollTop = this._halfSlots.get(this.page).slot.offsetTop;
    this._onHalfScroll = this._onHalfScroll.bind(this);
    strip.addEventListener("scroll", this._onHalfScroll);

    this._halfObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const n = Number(entry.target.dataset.page);
        const { canvas, w, h } = this._halfSlots.get(n);
        if (entry.isIntersecting) {
          if (!this._halfRendered.has(n)) {
            this._halfRendered.add(n);
            this.renderPage(n, canvas, w, h);
          }
        } else if (this._halfRendered.has(n)) {
          this._halfRendered.delete(n);
          canvas.width = 0;
          canvas.height = 0;
        }
      }
    }, { root: strip, rootMargin: "100% 0px" });
    for (const { slot } of this._halfSlots.values()) this._halfObserver.observe(slot);
  }

  _teardownHalfStrip() {
    if (!this._halfStrip) return;
    if (this._halfObserver) this._halfObserver.disconnect();
    this._halfStrip.removeEventListener("scroll", this._onHalfScroll);
    this._halfStrip.remove();
    this._halfStrip = null;
    this._halfSlots = null;
    this._halfRendered = null;
    this._halfObserver = null;
    this._halfScrollQueued = false;
  }

  _onHalfScroll() {
    if (this._halfScrollQueued) return;
    this._halfScrollQueued = true;
    requestAnimationFrame(() => {
      this._halfScrollQueued = false;
      if (!this._halfStrip) return;
      const top = this._halfStrip.scrollTop;
      let current = 1;
      for (const [n, { slot }] of this._halfSlots) {
        if (slot.offsetTop <= top) current = n; else break;
      }
      if (current !== this.page) {
        this.page = current;
        if (this.onSpreadChange) this.onSpreadChange(this.spread, this.numPages);
      }
    });
  }

  /* Vertical scroll by pixels of pinch-hand movement (half mode only). */
  readPan(dy) {
    if (this._halfStrip) this._halfStrip.scrollTop -= dy;
  }

  /* Keyboard scroll: dir -1 (up) / +1 (down), stepping ~90% of the visible box. */
  scrollHalf(dir) {
    if (!this._halfStrip) return;
    const step = this._halfStrip.clientHeight * 0.9;
    this._halfStrip.scrollBy({ top: dir < 0 ? -step : step, behavior: "smooth" });
  }

  /* Smooth-scroll to the top of `pageNum` (half mode's coarse ←/→ jump). */
  jumpToPage(pageNum, { smooth = true } = {}) {
    if (!this._halfStrip) return;
    const n = Math.max(1, Math.min(this.numPages, pageNum));
    const entry = this._halfSlots.get(n);
    if (!entry) return;
    this._halfStrip.scrollTo({ top: entry.slot.offsetTop, behavior: smooth ? "smooth" : "auto" });
  }

  /* Box to render `pageNum` into for the current mode: fit-page normally,
   * or fit-width-and-taller-than-the-box in half mode (so it overflows and
   * scrolls) — unless the page is wide enough that fit-width already fits. */
  async _boxFor(pageNum = this.page) {
    const box = this.pageBox();
    if (!this.isHalf) return box;
    const page = await this.pdfDoc.getPage(pageNum);
    const vp = page.getViewport({ scale: 1 });
    const tallH = box.w * (vp.height / vp.width);
    return tallH <= box.h ? box : { w: box.w, h: tallH };
  }

  async renderCurrentPage() {
    const { w, h } = await this._boxFor();
    await this.renderPage(this.page, this.rightCanvas, w, h);
  }

  get numPages() { return this.pdfDoc ? this.pdfDoc.numPages : 0; }

  setDocument(pdfDoc) {
    this._teardownHalfStrip();
    this.pdfDoc = pdfDoc;
    this.spread = this.isSingle ? 0 : this.spread;
    this.page = 1;
    this.setZoom(1);
    this._cleanupFlip();
    this.busy = false;
    this._applySingle(this.isSingle);
    if (this.isHalf) return this._buildHalfStrip();
    return this.isSingle ? this.renderCurrentPage() : this.renderSpread();
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

  /* Mode-aware re-render for resize: single/half mode tracks `page`, not `spread`. */
  async renderCurrent() {
    if (this.isHalf) {
      this._teardownHalfStrip();
      await this._buildHalfStrip();
    } else if (this.isSingle) {
      await this.renderCurrentPage();
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
    if (this.isHalf) return false;   // half mode turns pages via continuous scroll, not slides
    this.busy = true;
    if (dir === "forward") {
      // clone current page to slide away; render the next page underneath
      const cur = this._cloneCanvas(this.rightCanvas);
      this._slide = this._buildSlide(cur);
      this._slideDir = "forward";
      this._slideFrom = this.page;
      this._slide.style.transform = "translateX(0)";
      const { w, h } = await this._boxFor(this.page + 1);
      await this.renderPage(this.page + 1, this.rightCanvas, w, h);
    } else {
      // previous page slides in from the left over the current one
      const prev = document.createElement("canvas");
      const { w, h } = await this._boxFor(this.page - 1);
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
        const { w, h } = await this._boxFor(this.page);
        await this.renderPage(this.page, this.rightCanvas, w, h);
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
          const { w, h } = await this._boxFor(this._slideFrom);
          await this.renderPage(this._slideFrom, this.rightCanvas, w, h);
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
    if (this.isHalf) { this.jumpToPage(this.page + 1); return true; }
    if (!(await this.beginDrag("forward"))) return false;
    this.commitDrag();
    return true;
  }

  async turnBackward() {
    if (!this.canDrag("backward")) return false;
    if (this.isHalf) { this.jumpToPage(this.page - 1); return true; }
    if (!(await this.beginDrag("backward"))) return false;
    this.commitDrag();
    return true;
  }
}
