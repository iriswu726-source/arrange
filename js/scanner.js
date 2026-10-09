/* 掃圖核心：把背包截圖切成格子、判斷空格、算圖示特徵、比對圖示庫、準備數量 OCR 用的影像。
 * 只處理 {data, width, height} 形式的像素資料（與 canvas ImageData 相同），不碰 DOM。 */
(function (root) {
  'use strict';

  const GRID = 12; // 特徵取樣解析度 GRID x GRID x RGB
  const ICON_TOP = 0.06; // 圖示區域（相對格子）：去掉邊框與下方數字
  const ICON_BOTTOM = 0.7;
  const ICON_SIDE = 0.08;
  const DIGIT_TOP = 0.6; // 數字區域：格子下方

  function lum(r, g, b) {
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }

  /* 依框選範圍與欄列數切格。 */
  function gridCells(rect, cols, rows) {
    cols = Math.max(1, Math.floor(cols));
    rows = Math.max(1, Math.floor(rows));
    const cw = rect.w / cols;
    const rh = rect.h / rows;
    const cells = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        cells.push({
          index: r * cols + c,
          col: c,
          row: r,
          x: rect.x + c * cw,
          y: rect.y + r * rh,
          w: cw,
          h: rh,
        });
      }
    }
    return cells;
  }

  function subRect(cell, left, top, right, bottom) {
    return {
      x: cell.x + cell.w * left,
      y: cell.y + cell.h * top,
      w: cell.w * (right - left),
      h: cell.h * (bottom - top),
    };
  }

  function iconRect(cell) {
    return subRect(cell, ICON_SIDE, ICON_TOP, 1 - ICON_SIDE, ICON_BOTTOM);
  }

  function digitRect(cell) {
    return subRect(cell, 0.04, DIGIT_TOP, 0.96, 0.98);
  }

  function clampRect(img, r) {
    const x0 = Math.max(0, Math.floor(r.x));
    const y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(img.width, Math.ceil(r.x + r.w));
    const y1 = Math.min(img.height, Math.ceil(r.y + r.h));
    return { x0, y0, x1, y1 };
  }

  /* 區域內亮度的平均與標準差，用來判斷空格（空格幾乎是單色）。 */
  function regionStats(img, r) {
    const { x0, y0, x1, y1 } = clampRect(img, r);
    let n = 0, sum = 0, sum2 = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * img.width + x) * 4;
        const l = lum(img.data[i], img.data[i + 1], img.data[i + 2]);
        sum += l;
        sum2 += l * l;
        n++;
      }
    }
    if (!n) return { mean: 0, std: 0 };
    const mean = sum / n;
    return { mean, std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)) };
  }

  function isEmptyCell(img, cell, threshold) {
    return regionStats(img, iconRect(cell)).std < (threshold == null ? 10 : threshold);
  }

  /* 把區域以面積平均縮成 GRID x GRID 的 RGB 向量。 */
  function sampleRegion(img, r, grid) {
    grid = grid || GRID;
    const out = new Array(grid * grid * 3).fill(0);
    const { x0, y0, x1, y1 } = clampRect(img, r);
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return out;
    const cnt = new Array(grid * grid).fill(0);
    for (let y = y0; y < y1; y++) {
      const gy = Math.min(grid - 1, Math.floor(((y - y0) * grid) / h));
      for (let x = x0; x < x1; x++) {
        const gx = Math.min(grid - 1, Math.floor(((x - x0) * grid) / w));
        const g = gy * grid + gx;
        const i = (y * img.width + x) * 4;
        out[g * 3] += img.data[i];
        out[g * 3 + 1] += img.data[i + 1];
        out[g * 3 + 2] += img.data[i + 2];
        cnt[g]++;
      }
    }
    for (let g = 0; g < grid * grid; g++) {
      const c = cnt[g] || 1;
      out[g * 3] = Math.round(out[g * 3] / c);
      out[g * 3 + 1] = Math.round(out[g * 3 + 1] / c);
      out[g * 3 + 2] = Math.round(out[g * 3 + 2] / c);
    }
    return out;
  }

  function cellFeature(img, cell) {
    return sampleRegion(img, iconRect(cell), GRID);
  }

  /* 0（完全相同）～1（完全不同）。 */
  function featureDistance(a, b) {
    if (!a || !b || a.length !== b.length || !a.length) return 1;
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / (a.length * 255);
  }

  /* 在圖示庫中找最接近者；只考慮同分頁或未指定分頁的圖示。 */
  function matchIcon(feat, icons, tab, maxDist) {
    const limit = maxDist == null ? 0.08 : maxDist;
    let best = null, bestDist = Infinity;
    for (const ic of icons || []) {
      if (tab && ic.tab && ic.tab !== tab) continue;
      const d = featureDistance(feat, ic.feat);
      if (d < bestDist) {
        bestDist = d;
        best = ic;
      }
    }
    return { icon: best && bestDist <= limit ? best : null, nearest: best, dist: bestDist };
  }

  /* 取出格子下方數字的二值遮罩（1 = 字）。soften=false 時不補細筆畫（切字用）。 */
  function digitMask(img, cell, threshold, soften) {
    threshold = threshold == null ? 175 : threshold;
    const r = clampRect(img, digitRect(cell));
    const sw = Math.max(0, r.x1 - r.x0), sh = Math.max(0, r.y1 - r.y0);
    const L = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const i = ((r.y0 + y) * img.width + (r.x0 + x)) * 4;
        L[y * sw + x] = lum(img.data[i], img.data[i + 1], img.data[i + 2]);
      }
    }
    // 遊戲數字是「亮字＋深色描邊」。和裁切邊緣相連的亮區是格子底色，
    // 被深色描邊圍住的亮區才是字；太大的亮塊也不是字。
    const N = sw * sh;
    const label = new Uint8Array(N); // 0 = 非亮, 1 = 字, 2 = 底色
    for (let p = 0; p < N; p++) label[p] = L[p] >= threshold ? 1 : 0;
    const comp = new Int32Array(N);
    const fill = (start, mark) => {
      // 4-連通 flood fill，回傳區塊大小與是否碰到邊緣
      let n = 0, edge = false, head = 0;
      comp[0] = start;
      let tail = 1;
      label[start] = mark;
      while (head < tail) {
        const p = comp[head++];
        n++;
        const x = p % sw, y = (p - x) / sw;
        if (x === 0 || y === 0 || x === sw - 1 || y === sh - 1) edge = true;
        const nb = [x > 0 ? p - 1 : -1, x < sw - 1 ? p + 1 : -1, y > 0 ? p - sw : -1, y < sh - 1 ? p + sw : -1];
        for (const q of nb) if (q >= 0 && label[q] === 1) { label[q] = mark; comp[tail++] = q; }
      }
      return { n, edge, list: comp.slice(0, tail) };
    };
    const maxGlyph = N * 0.2;
    for (let p = 0; p < N; p++) {
      if (label[p] !== 1) continue;
      const c = fill(p, 3); // 先暫標 3
      const keep = !c.edge && c.n <= maxGlyph;
      for (const q of c.list) label[q] = keep ? 4 : 2;
    }
    // 補回反鋸齒造成的細筆畫：與字相鄰、亮度略低的像素也算字
    const soft = soften === false ? Infinity : threshold - 60;
    const glyph = new Uint8Array(N);
    for (let p = 0; p < N; p++) {
      if (label[p] === 4) { glyph[p] = 1; continue; }
      if (label[p] === 2 || L[p] < soft) continue;
      const x = p % sw;
      if ((x > 0 && label[p - 1] === 4) || (x < sw - 1 && label[p + 1] === 4) ||
          (p >= sw && label[p - sw] === 4) || (p + sw < N && label[p + sw] === 4)) glyph[p] = 1;
    }
    let ink = 0;
    for (let p = 0; p < N; p++) ink += glyph[p];
    return { mask: glyph, w: sw, h: sh, ink };
  }

  /* 把數字區域放大並二值化（亮色描邊數字 → 黑字白底），給 OCR 用。 */
  function digitImage(img, cell, scale, threshold) {
    scale = scale || 4;
    const m = digitMask(img, cell, threshold, true);
    const sw = m.w, sh = m.h;
    const pad = 4 * scale;
    const width = sw * scale + pad * 2, height = sh * scale + pad * 2;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        if (!m.mask[y * sw + x]) continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const o = ((pad + y * scale + dy) * width + (pad + x * scale + dx)) * 4;
            data[o] = data[o + 1] = data[o + 2] = 0;
          }
        }
      }
    }
    return { data, width, height, ink: m.ink };
  }

  /* 依直行投影把遮罩切成一個個字（由左到右）。 */
  function segmentGlyphs(m) {
    const segs = [];
    let x0 = -1;
    const colInk = (x) => {
      for (let y = 0; y < m.h; y++) if (m.mask[y * m.w + x]) return true;
      return false;
    };
    for (let x = 0; x <= m.w; x++) {
      const on = x < m.w && colInk(x);
      if (on && x0 < 0) x0 = x;
      else if (!on && x0 >= 0) {
        let y0 = m.h, y1 = -1, n = 0;
        for (let y = 0; y < m.h; y++) {
          for (let xx = x0; xx < x; xx++) {
            if (!m.mask[y * m.w + xx]) continue;
            n++;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
        if (n >= 2) segs.push({ x0, x1: x - 1, y0, y1 });
        x0 = -1;
      }
    }
    // 去掉明顯不是數字的雜點（高度遠小於最高的字）
    const hMax = segs.reduce((a, g) => Math.max(a, g.y1 - g.y0 + 1), 0);
    return segs.filter((g) => g.y1 - g.y0 + 1 >= hMax * 0.6);
  }

  const GW = 5, GH = 7;
  /* 單一字的特徵：GW x GH 的覆蓋率 + 寬高比。 */
  function glyphFeature(m, g) {
    const w = g.x1 - g.x0 + 1, h = g.y1 - g.y0 + 1;
    const f = new Array(GW * GH + 1).fill(0);
    const cnt = new Array(GW * GH).fill(0);
    for (let y = g.y0; y <= g.y1; y++) {
      const gy = Math.min(GH - 1, Math.floor(((y - g.y0) * GH) / h));
      for (let x = g.x0; x <= g.x1; x++) {
        const gx = Math.min(GW - 1, Math.floor(((x - g.x0) * GW) / w));
        f[gy * GW + gx] += m.mask[y * m.w + x];
        cnt[gy * GW + gx]++;
      }
    }
    for (let i = 0; i < GW * GH; i++) f[i] = cnt[i] ? Math.round((f[i] / cnt[i]) * 100) / 100 : 0;
    f[GW * GH] = Math.round((w / h) * 100) / 100;
    return f;
  }

  function glyphDistance(a, b) {
    let s = 0;
    for (let i = 0; i < GW * GH; i++) s += Math.abs(a[i] - b[i]);
    return s / (GW * GH) + Math.abs(a[GW * GH] - b[GW * GH]) * 0.5;
  }

  function cellGlyphs(img, cell, threshold) {
    const m = digitMask(img, cell, threshold, false);
    return m.ink ? segmentGlyphs(m).map((g) => glyphFeature(m, g)) : [];
  }

  /* 用已學會的數字模板讀數量。全部字都對得上才回傳數字，否則 null。
   * templates: [{ d: '0'..'9', feat: [...] }] */
  function readDigits(img, cell, templates, threshold, maxDist) {
    if (!templates || !templates.length) return null;
    const limit = maxDist == null ? 0.12 : maxDist;
    const glyphs = cellGlyphs(img, cell, threshold);
    if (!glyphs.length || glyphs.length > 5) return null;
    let text = '';
    for (const f of glyphs) {
      let best = null, bd = Infinity;
      for (const t of templates) {
        const d = glyphDistance(f, t.feat);
        if (d < bd) { bd = d; best = t; }
      }
      if (!best || bd > limit) return null;
      text += best.d;
    }
    return parseQty(text);
  }

  /* 使用者確認數量後，從該格學數字模板（字數要和數量位數一致）。 */
  function learnDigits(img, cell, qty, threshold) {
    const text = String(qty);
    if (!/^[0-9]+$/.test(text)) return [];
    const glyphs = cellGlyphs(img, cell, threshold);
    if (glyphs.length !== text.length) return [];
    return glyphs.map((feat, i) => ({ d: text[i], feat }));
  }

  /* 合併新模板；每個數字最多保留 perDigit 個彼此不太像的樣本。 */
  function mergeDigitTemplates(templates, learned, perDigit) {
    perDigit = perDigit || 4;
    const out = (templates || []).slice();
    for (const t of learned) {
      const same = out.filter((x) => x.d === t.d);
      if (same.some((x) => glyphDistance(x.feat, t.feat) < 0.03)) continue;
      if (same.length >= perDigit) out.splice(out.indexOf(same[0]), 1);
      out.push(t);
    }
    return out;
  }

  /* OCR 文字 → 數量；讀不到就是 null。 */
  function parseQty(text) {
    const digits = String(text == null ? '' : text)
      .replace(/[oO]/g, '0')
      .replace(/[lI|]/g, '1')
      .replace(/[^0-9]/g, '');
    if (!digits) return null;
    const n = parseInt(digits, 10);
    return n > 0 && n < 100000 ? n : null;
  }

  /* 整張圖的辨識流程（不含 OCR）：回傳每個非空格的特徵與比對結果。 */
  function analyze(img, rect, cols, rows, opts) {
    opts = opts || {};
    const cells = gridCells(rect, cols, rows);
    const results = [];
    for (const cell of cells) {
      if (isEmptyCell(img, cell, opts.emptyThreshold)) continue;
      const feat = cellFeature(img, cell);
      const m = matchIcon(feat, opts.icons, opts.tab, opts.maxDist);
      results.push({ cell, feat, icon: m.icon, nearest: m.nearest, dist: m.dist });
    }
    return results;
  }

  /* ---------- 圖鑑比對（和網站圖片比）----------
   * 網站圖片是透明背景、尺寸不同；截圖裡的圖示有格子底色、可能被縮放、還壓著數量數字。
   * 所以先把「前景」（圖示本體）切出來，用它的外框重新取樣，跟背景與縮放無關。 */
  const SG = 10; // 形狀特徵 SG x SG

  /* 由前景遮罩取樣：每格的覆蓋率與前景平均色，加上外框寬高比。 */
  function shapeFromMask(w, h, isFg, rgbAt) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!isFg(x, y)) continue;
        n++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (n < 12) return null;
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const cov = new Array(SG * SG).fill(0);
    const tot = new Array(SG * SG).fill(0);
    const rgb = new Array(SG * SG * 3).fill(0);
    for (let y = y0; y <= y1; y++) {
      const gy = Math.min(SG - 1, Math.floor(((y - y0) * SG) / bh));
      for (let x = x0; x <= x1; x++) {
        const g = gy * SG + Math.min(SG - 1, Math.floor(((x - x0) * SG) / bw));
        tot[g]++;
        if (!isFg(x, y)) continue;
        cov[g]++;
        const c = rgbAt(x, y);
        rgb[g * 3] += c[0];
        rgb[g * 3 + 1] += c[1];
        rgb[g * 3 + 2] += c[2];
      }
    }
    for (let g = 0; g < SG * SG; g++) {
      if (cov[g]) for (let k = 0; k < 3; k++) rgb[g * 3 + k] = Math.round(rgb[g * 3 + k] / cov[g]);
      cov[g] = tot[g] ? Math.round((cov[g] / tot[g]) * 100) / 100 : 0;
    }
    return { cov, rgb, aspect: Math.round((bw / bh) * 100) / 100 };
  }

  /* 透明背景的圖示（網站圖片）→ 形狀特徵。 */
  function iconImageShape(img) {
    const at = (x, y) => (y * img.width + x) * 4;
    return shapeFromMask(img.width, img.height,
      (x, y) => img.data[at(x, y) + 3] >= 128,
      (x, y) => { const i = at(x, y); return [img.data[i], img.data[i + 1], img.data[i + 2]]; });
  }

  /* 截圖格子 → 形狀特徵：以格子邊緣的顏色當底色，和底色差很多的就是圖示；數量數字的區域排除。 */
  function cellShape(img, cell, digitThreshold) {
    const r = clampRect(img, subRect(cell, 0.06, 0.06, 0.94, 0.94));
    const w = r.x1 - r.x0, h = r.y1 - r.y0;
    if (w < 4 || h < 4) return null;
    const px = (x, y) => { const i = ((r.y0 + y) * img.width + r.x0 + x) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };
    // 底色：外圈像素各通道的中位數
    const ring = [];
    for (let x = 0; x < w; x++) { ring.push(px(x, 0), px(x, h - 1)); }
    for (let y = 1; y < h - 1; y++) { ring.push(px(0, y), px(w - 1, y)); }
    const bg = [0, 1, 2].map((k) => { const v = ring.map((c) => c[k]).sort((a, b) => a - b); return v[v.length >> 1]; });
    // 數字（含描邊）排除：數字遮罩往外擴 2px
    const excl = new Uint8Array(w * h);
    const dm = digitMask(img, cell, digitThreshold, true);
    const dr = clampRect(img, digitRect(cell));
    for (let y = 0; y < dm.h; y++) {
      for (let x = 0; x < dm.w; x++) {
        if (!dm.mask[y * dm.w + x]) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const cx = dr.x0 + x + dx - r.x0, cy = dr.y0 + y + dy - r.y0;
            if (cx >= 0 && cy >= 0 && cx < w && cy < h) excl[cy * w + cx] = 1;
          }
        }
      }
    }
    const isFg = (x, y) => {
      if (excl[y * w + x]) return false;
      const c = px(x, y);
      return Math.max(Math.abs(c[0] - bg[0]), Math.abs(c[1] - bg[1]), Math.abs(c[2] - bg[2])) > 40;
    };
    return shapeFromMask(w, h, isFg, px);
  }

  /* 0（一樣）～ 約 1（完全不同）。 */
  function shapeDistance(a, b) {
    if (!a || !b) return 1;
    let cov = 0, col = 0, nc = 0;
    for (let g = 0; g < SG * SG; g++) {
      cov += Math.abs(a.cov[g] - b.cov[g]);
      if (a.cov[g] > 0.25 && b.cov[g] > 0.25) {
        col += (Math.abs(a.rgb[g * 3] - b.rgb[g * 3]) + Math.abs(a.rgb[g * 3 + 1] - b.rgb[g * 3 + 1]) + Math.abs(a.rgb[g * 3 + 2] - b.rgb[g * 3 + 2])) / 765;
        nc++;
      }
    }
    const asp = Math.min(1, Math.abs(Math.log(a.aspect / b.aspect)));
    return 0.45 * (cov / (SG * SG)) + 0.45 * (nc ? col / nc : 1) + 0.1 * asp;
  }

  /* 依相似度排出前 n 名圖鑑道具。 */
  function rankCatalog(shape, catalog, tab, n) {
    if (!shape) return [];
    const out = [];
    for (const it of catalog || []) {
      if (tab && it.tab && it.tab !== tab) continue;
      out.push({ item: it, dist: shapeDistance(shape, it.shape) });
    }
    out.sort((a, b) => a.dist - b.dist);
    return out.slice(0, n || 5);
  }

  const api = {
    GRID, gridCells, iconRect, digitRect, regionStats, isEmptyCell, sampleRegion, cellFeature,
    featureDistance, matchIcon, digitMask, digitImage, segmentGlyphs, glyphFeature, glyphDistance,
    readDigits, learnDigits, mergeDigitTemplates, parseQty, analyze,
    iconImageShape, cellShape, shapeDistance, rankCatalog,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ArrScanner = api;
})(typeof self !== 'undefined' ? self : this);
