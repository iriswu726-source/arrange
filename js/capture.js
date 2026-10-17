/* 擷取遊戲畫面：捲動背包時把多個畫面接成一張長圖，並自動找出格子位置。
 * - 接圖：每個畫面只看背包格子範圍，每一條像素橫線算一個特徵；新畫面往上移了幾條線，就只接下面新出現的那幾條。
 *   遊戲是一格一格捲或平滑捲動都可以。
 * - 找格子：格子之間的間隙是一條條顏色均勻的線，用等距的「梳子」去對，算出格子大小與位置（框選只要大概就好）。
 * - 跟著視窗：記住背包視窗上方標題列的樣子，視窗被移到別的位置時，在新畫面上找回來。
 * 不依賴 DOM，方便測試；畫面的裁切與合成由 app.js 負責。 */
(function (root) {
  'use strict';

  const XB = 16; // 每條線切成 16 段，每段取平均顏色

  /* 每條橫線的特徵（長度 XB*3）。 */
  function lineSigs(img) {
    const { data, width, height } = img;
    const out = new Array(height);
    for (let y = 0; y < height; y++) {
      const sig = new Float32Array(XB * 3);
      for (let b = 0; b < XB; b++) {
        const x0 = Math.floor((b * width) / XB), x1 = Math.max(x0 + 1, Math.floor(((b + 1) * width) / XB));
        let r = 0, g = 0, bl = 0;
        for (let x = x0; x < x1; x++) { const i = (y * width + x) * 4; r += data[i]; g += data[i + 1]; bl += data[i + 2]; }
        const n = x1 - x0;
        sig[b * 3] = r / n; sig[b * 3 + 1] = g / n; sig[b * 3 + 2] = bl / n;
      }
      out[y] = sig;
    }
    return out;
  }

  function lineDiff(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length / 255;
  }

  /* cur 往上移 dy 條線後和 prev 的差異：去掉最差的 15%（滑鼠游標、閃爍的提示）再平均 */
  function shiftDiff(prev, cur, dy) {
    const n = cur.length - dy;
    if (n <= 0) return 1;
    const step = Math.max(1, Math.floor(n / 120));
    const ds = [];
    for (let y = 0; y < n; y += step) ds.push(lineDiff(cur[y], prev[y + dy]));
    ds.sort((a, b) => a - b);
    const keep = Math.max(1, Math.ceil(ds.length * 0.85));
    let s = 0;
    for (let i = 0; i < keep; i++) s += ds[i];
    return s / keep;
  }

  const SAME = 0.02;

  /* 接圖器：每次給一個畫面的線特徵，回傳
   *   { status: 'first' | 'added' | 'same' | 'moving' | 'gap', lines: 要從畫面底部接上的線數, total }
   * 畫面要和上一次取樣一樣（停下來了）才採用，避免捲動中的畫面。
   * 'gap'：和已接好的部分對不上（捲太快、往上捲，或被提示框擋住），這張不接。
   * 有很多個位移都對得上（例如一大片空格）時，取最小的位移，所以請慢慢捲。 */
  function createStitcher(opts) {
    const minOverlap = (opts && opts.minOverlap) || 0.25; // 新舊畫面至少要重疊的比例
    let last = null, used = null, total = 0;
    return {
      add(lines) {
        const stable = last && last.length === lines.length && shiftDiff(last, lines, 0) < SAME;
        last = lines;
        if (!stable) return { status: 'moving', lines: 0, total };
        if (!used) { used = lines; total = lines.length; return { status: 'first', lines: lines.length, total }; }
        if (shiftDiff(used, lines, 0) < SAME) return { status: 'same', lines: 0, total };
        const maxDy = Math.floor(lines.length * (1 - minOverlap));
        const ds = [];
        let min = Infinity;
        for (let dy = 1; dy <= maxDy; dy++) { ds[dy] = shiftDiff(used, lines, dy); min = Math.min(min, ds[dy]); }
        if (!(min < SAME)) return { status: 'gap', lines: 0, total };
        // 最像的位移；幾個一樣像（重複的空格）時取最小的
        let dy = 1;
        while (ds[dy] > min + 0.002) dy++;
        used = lines;
        total += dy;
        return { status: 'added', lines: dy, total };
      },
      get total() { return total; },
    };
  }

  /* 每條線（axis 'y' = 橫線、'x' = 直線）有多「均勻」：和這條線的中位數顏色相近的像素比例。格子間隙接近 1。 */
  function lineScores(img, axis) {
    const { data, width, height } = img;
    const n = axis === 'y' ? height : width, len = axis === 'y' ? width : height;
    const out = new Float32Array(n);
    const step = Math.max(1, Math.floor(len / 200));
    const br = [];
    for (let k = 0; k < n; k++) {
      br.length = 0;
      for (let t = 0; t < len; t += step) {
        const i = axis === 'y' ? (k * width + t) * 4 : (t * width + k) * 4;
        br.push((data[i] + data[i + 1] + data[i + 2]) / 3);
      }
      const sorted = br.slice().sort((a, b) => a - b);
      const med = sorted[sorted.length >> 1];
      let c = 0;
      for (const v of br) if (Math.abs(v - med) <= 8) c++;
      out[k] = c / br.length;
    }
    // 間隙有好幾條線寬，平滑後最高點會落在間隙中間
    const sm = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      let s = 0, m = 0;
      for (let d = -2; d <= 2; d++) if (k + d >= 0 && k + d < n) { s += out[k + d]; m++; }
      sm[k] = s / m;
    }
    return sm;
  }

  /* 用等距梳子對間隙：回傳 { pitch, phase, score }，phase + k*pitch 是第 k 條間隙的中心。 */
  function fitComb(scores, minP, maxP) {
    const n = scores.length;
    const at = (v) => { const i = Math.round(v); return i >= 0 && i < n ? scores[i] : null; };
    let best = { pitch: minP, phase: 0, score: -1 };
    for (let p = minP; p <= maxP; p += 0.1) {
      for (let ph = 0; ph < p; ph += 0.5) {
        let s = 0, m = 0;
        for (let v = ph; v < n; v += p) {
          const a = at(v), b = at(v + p / 2);
          if (a === null || b === null) continue;
          s += a - b; m++;
        }
        if (m >= 2 && s / m > best.score) best = { pitch: p, phase: ph, score: s / m };
      }
    }
    return best;
  }

  /* 在大概框的範圍裡找出 cols 欄格子的左右位置與寬度。img = 框選範圍的畫面。 */
  function fitColumns(img, cols) {
    const approx = img.width / cols;
    const f = fitComb(lineScores(img, 'x'), approx * 0.8, approx * 1.1);
    // 第一條間隙：最靠近左邊、而且後面放得下 cols 格的那一條
    let x0 = f.phase;
    while (x0 - f.pitch >= -f.pitch * 0.3) x0 -= f.pitch;
    while (x0 + cols * f.pitch > img.width + f.pitch * 0.3 && x0 - f.pitch >= -f.pitch * 0.5) x0 -= f.pitch;
    if (x0 < -f.pitch * 0.3) x0 += f.pitch;
    return { x: x0, pitch: f.pitch, score: f.score };
  }

  /* 長圖上格子的上下位置：回傳 { y, pitch, rows } */
  function fitRows(img, approxPitch) {
    const f = fitComb(lineScores(img, 'y'), approxPitch * 0.8, approxPitch * 1.25);
    let y0 = f.phase;
    while (y0 - f.pitch >= -f.pitch * 0.3) y0 -= f.pitch;
    const rows = Math.max(1, Math.floor((img.height - y0 + f.pitch * 0.15) / f.pitch));
    return { y: y0, pitch: f.pitch, rows };
  }

  /* ---------- 跟著視窗：在畫面上找回記住的標題列 ---------- */
  function toGray(img, k) {
    const w = Math.floor(img.width / k), h = Math.floor(img.height / k);
    const g = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) {
        const i = ((y * k + dy) * img.width + x * k + dx) * 4;
        s += img.data[i] + img.data[i + 1] + img.data[i + 2];
      }
      g[y * w + x] = s / (3 * k * k);
    }
    return { w, h, g };
  }

  function sad(A, ax, ay, P, limit) {
    let s = 0;
    for (let y = 0; y < P.h; y++) {
      const ro = (ay + y) * A.w + ax, po = y * P.w;
      for (let x = 0; x < P.w; x++) s += Math.abs(A.g[ro + x] - P.g[po + x]);
      if (s > limit) return s;
    }
    return s;
  }

  /* 在 frame 上找 anchor（{ img: 標題列畫面, x, y }）。回傳 { x, y, diff }（diff 是平均每像素差異 0～255）。
   * 先看原本位置；不像的話縮小 8 倍全畫面找，再在附近細找。 */
  function locate(frame, anchor) {
    const P1 = toGray(anchor.img, 1);
    const n1 = P1.w * P1.h;
    const F1 = toGray(frame, 1);
    const fine = (cx, cy, r) => {
      let best = { x: cx, y: cy, diff: Infinity };
      for (let y = Math.max(0, cy - r); y <= Math.min(F1.h - P1.h, cy + r); y++) {
        for (let x = Math.max(0, cx - r); x <= Math.min(F1.w - P1.w, cx + r); x++) {
          const s = sad(F1, x, y, P1, best.diff * n1) / n1;
          if (s < best.diff) best = { x, y, diff: s };
        }
      }
      return best;
    };
    if (anchor.x + P1.w <= F1.w && anchor.y + P1.h <= F1.h) {
      const here = fine(anchor.x, anchor.y, 2);
      if (here.diff < 12) return here;
    }
    const K = 8;
    const F8 = toGray(frame, K), P8 = toGray(anchor.img, K);
    if (P8.w < 2 || P8.h < 2) return { x: anchor.x, y: anchor.y, diff: Infinity };
    const n8 = P8.w * P8.h;
    const cands = [];
    for (let y = 0; y + P8.h <= F8.h; y++) {
      for (let x = 0; x + P8.w <= F8.w; x++) cands.push({ x, y, d: sad(F8, x, y, P8, Infinity) / n8 });
    }
    cands.sort((a, b) => a.d - b.d);
    let best = { x: anchor.x, y: anchor.y, diff: Infinity };
    for (const c of cands.slice(0, 5)) {
      const f = fine(c.x * K, c.y * K, K);
      if (f.diff < best.diff) best = f;
    }
    return best;
  }

  const api = { lineSigs, shiftDiff, createStitcher, lineScores, fitComb, fitColumns, fitRows, locate, toGray };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ArrCapture = api;
})(typeof self !== 'undefined' ? self : this);
