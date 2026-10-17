/* 擷取遊戲畫面時，把捲動背包得到的多個畫面接成一張長圖。
 * 每個畫面只看格子範圍：每一列算一個「列特徵」，新畫面的前幾列和已接好的最後幾列一樣 → 是重疊的部分，只接後面新的列。
 * 不依賴 DOM，方便測試；畫面的裁切與合成由 app.js 負責。 */
(function (root) {
  'use strict';

  const BLOCKS = 4; // 每格切成 4x4 小塊，每塊取平均顏色

  /* 每一列的特徵：cols*4*4 個小塊的 RGB 平均。 */
  function rowSigs(imgData, rect, cols, rows) {
    const { data, width, height } = imgData;
    const cw = rect.w / cols, rh = rect.h / rows;
    const out = [];
    for (let r = 0; r < rows; r++) {
      const sig = [];
      for (let c = 0; c < cols; c++) {
        for (let by = 0; by < BLOCKS; by++) {
          for (let bx = 0; bx < BLOCKS; bx++) {
            const x0 = Math.floor(rect.x + c * cw + (bx * cw) / BLOCKS), x1 = Math.max(x0 + 1, Math.floor(rect.x + c * cw + ((bx + 1) * cw) / BLOCKS));
            const y0 = Math.floor(rect.y + r * rh + (by * rh) / BLOCKS), y1 = Math.max(y0 + 1, Math.floor(rect.y + r * rh + ((by + 1) * rh) / BLOCKS));
            let sr = 0, sg = 0, sb = 0, n = 0;
            for (let y = y0; y < y1 && y < height; y++) {
              for (let x = x0; x < x1 && x < width; x++) {
                const i = (y * width + x) * 4;
                sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; n++;
              }
            }
            n = n || 1;
            sig.push(sr / n, sg / n, sb / n);
          }
        }
      }
      out.push(sig);
    }
    return out;
  }

  /* 兩列的差異（0～1）。 */
  function rowDiff(a, b) {
    if (!a || !b || a.length !== b.length) return 1;
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length / 255;
  }

  const SAME = 0.025;
  const same = (a, b) => rowDiff(a, b) < SAME;

  /* acc 的最後 k 列 == sigs 的前 k 列，回傳最大的 k（沒有重疊回傳 0）。 */
  function overlap(acc, sigs) {
    for (let k = Math.min(acc.length, sigs.length); k >= 1; k--) {
      let ok = true;
      for (let i = 0; i < k && ok; i++) ok = same(acc[acc.length - k + i], sigs[i]);
      if (ok) return k;
    }
    return 0;
  }

  function sameFrame(a, b) {
    return !!a && !!b && a.length === b.length && a.every((row, i) => same(row, b[i]));
  }

  /* 接圖器：每次給一個畫面的列特徵，回傳
   *   { status: 'first' | 'added' | 'same' | 'moving' | 'gap', rows: [要接上的列 index…], total }
   * 畫面要連續兩次一樣（停下來了）才採用，避免捲動中的半張畫面。
   * 'gap'：和已接好的部分對不上（捲太快、或被滑鼠提示擋住），這張不接。 */
  function createStitcher() {
    let acc = [];
    let last = null;
    let lastUsed = null;
    return {
      add(sigs) {
        const stable = sameFrame(sigs, last);
        last = sigs;
        if (!stable) return { status: 'moving', rows: [], total: acc.length };
        if (sameFrame(sigs, lastUsed)) return { status: 'same', rows: [], total: acc.length };
        if (!acc.length) {
          acc = sigs.slice();
          lastUsed = sigs;
          return { status: 'first', rows: sigs.map((_, i) => i), total: acc.length };
        }
        const k = overlap(acc, sigs);
        if (k === 0) return { status: 'gap', rows: [], total: acc.length };
        lastUsed = sigs;
        const rows = [];
        for (let i = k; i < sigs.length; i++) { acc.push(sigs[i]); rows.push(i); }
        return { status: rows.length ? 'added' : 'same', rows, total: acc.length };
      },
      get total() { return acc.length; },
    };
  }

  const api = { rowSigs, rowDiff, overlap, sameFrame, createStitcher };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ArrCapture = api;
})(typeof self !== 'undefined' ? self : this);
