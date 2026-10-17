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
      const dist = t.feat.length === QLEN ? qtyDistance : glyphDistance;
      if (same.some((x) => x.feat.length === t.feat.length && dist(x.feat, t.feat) < 0.03)) continue;
      if (same.length >= perDigit) out.splice(out.indexOf(same[0]), 1);
      out.push(t);
    }
    return out;
  }

  /* ---------- 數量數字（新版） ----------
   * 遊戲的數量是「白色筆畫＋粗黑描邊」，緊貼在格子左下角。截圖亮度、縮放都可能不同，所以：
   * - 門檻跟著格子走：比格子下半部亮度中位數的 0.6 倍亮就算「亮」；
   * - 被黑描邊整個圍住、不碰到邊的亮區才是字的筆畫，每個字是一塊（0 的洞併進去）；
   * - 只留上下緣對齊、從左邊連續排列的幾塊（擋在後面的圖示會被排除）；
   * - 每塊縮放到自己的外框，取 6x9 覆蓋率＋寬高比，和數字樣本比最像的。 */
  const QW = 6, QH = 9, QLEN = QW * QH + 3; // 覆蓋率 + 寬高比 + 洞的數量 + 洞的高度位置

  function qtyGlyphs(img, cell, k) {
    k = k || 0.6;
    // 往左多看一點：框得比格子小時，第一個字才不會被切掉
    const r = clampRect(img, { x: cell.x - cell.w * 0.04, y: cell.y + cell.h * 0.5, w: cell.w * 1.04, h: cell.h * 0.5 });
    const w = Math.max(0, r.x1 - r.x0), h = Math.max(0, r.y1 - r.y0), N = w * h;
    if (!N) return { glyphs: [], w, h, lab: null };
    const L = new Float32Array(N);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = ((r.y0 + y) * img.width + (r.x0 + x)) * 4;
      L[y * w + x] = lum(img.data[i], img.data[i + 1], img.data[i + 2]);
    }
    const sorted = Array.from(L).sort((a, b) => a - b);
    const th = sorted[N >> 1] * k;
    const lab = new Int32Array(N).fill(-1);
    const comps = [];
    const stack = [];
    for (let p = 0; p < N; p++) {
      if (lab[p] !== -1 || L[p] < th) continue;
      const id = comps.length;
      let n = 0, edge = false, x0 = w, x1 = 0, y0 = h, y1 = 0;
      lab[p] = id;
      stack.push(p);
      while (stack.length) {
        const c = stack.pop();
        n++;
        const x = c % w, y = (c - x) / w;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        if (x > 0 && lab[c - 1] === -1 && L[c - 1] >= th) { lab[c - 1] = id; stack.push(c - 1); }
        if (x < w - 1 && lab[c + 1] === -1 && L[c + 1] >= th) { lab[c + 1] = id; stack.push(c + 1); }
        if (y > 0 && lab[c - w] === -1 && L[c - w] >= th) { lab[c - w] = id; stack.push(c - w); }
        if (y < h - 1 && lab[c + w] === -1 && L[c + w] >= th) { lab[c + w] = id; stack.push(c + w); }
        // 斜角相連也算同一筆（縮放後 7 之類的斜筆畫常只剩斜角接著）
        for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const d = ny * w + nx;
          if (lab[d] === -1 && L[d] >= th) { lab[d] = id; stack.push(d); }
        }
      }
      comps.push({ id, n, edge, x0, x1, y0, y1 });
    }
    let g = comps.filter((c) => !c.edge && c.n >= 6 && c.n < N * 0.2);
    const hMax = g.reduce((a, c) => Math.max(a, c.y1 - c.y0 + 1), 0);
    g = g.filter((c) => c.y1 - c.y0 + 1 >= hMax * 0.6 && c.y1 - c.y0 + 1 >= h * 0.15).sort((a, b) => a.x0 - b.x0);
    // 在別的字外框裡面的是洞（0 的中間），不算
    const merged = [];
    for (const c of g) if (!merged.some((o) => c.x0 >= o.x0 - 1 && c.x1 <= o.x1 + 1)) merged.push(c);
    // 上下緣對齊的一組（最多字共用的底線）
    let best = [];
    for (const ref of merged) {
      const grp = merged.filter((c) => Math.abs(c.y1 - ref.y1) <= 2 && Math.abs(c.y0 - ref.y0) <= 3);
      if (grp.length > best.length) best = grp;
    }
    // 從左邊開始連續排列
    const glyphs = [];
    for (const c of best) {
      if (glyphs.length && c.x0 - glyphs[glyphs.length - 1].x1 > (c.y1 - c.y0) * 0.6) break;
      glyphs.push(c);
    }
    return { glyphs, w, h, lab };
  }

  function qtyFeature(q, c) {
    const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
    const f = new Array(QLEN).fill(0), n = new Array(QW * QH).fill(0);
    for (let y = c.y0; y <= c.y1; y++) {
      for (let x = c.x0; x <= c.x1; x++) {
        const g = Math.min(QH - 1, Math.floor(((y - c.y0) * QH) / bh)) * QW + Math.min(QW - 1, Math.floor(((x - c.x0) * QW) / bw));
        n[g]++;
        if (q.lab[y * q.w + x] === c.id) f[g]++;
      }
    }
    for (let i = 0; i < QW * QH; i++) f[i] = n[i] ? Math.round((f[i] / n[i]) * 100) / 100 : 0;
    f[QW * QH] = Math.round((bw / bh) * 100) / 100;
    // 洞：外框內、不是筆畫、又連不到外框邊緣的區域（0 一個在中間、6 在下、9 在上、8 兩個）
    const pw = bw + 2, ph = bh + 2;
    const inGlyph = (x, y) => x >= 1 && y >= 1 && x <= bw && y <= bh && q.lab[(c.y0 + y - 1) * q.w + (c.x0 + x - 1)] === c.id;
    const seen = new Uint8Array(pw * ph);
    const flood = (sx, sy) => {
      const st = [sy * pw + sx];
      seen[sy * pw + sx] = 1;
      let n2 = 0, sy2 = 0;
      while (st.length) {
        const p = st.pop();
        const x = p % pw, y = (p - x) / pw;
        n2++; sy2 += y;
        for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
          if (nx < 0 || ny < 0 || nx >= pw || ny >= ph) continue;
          const k = ny * pw + nx;
          if (seen[k] || inGlyph(nx, ny)) continue;
          seen[k] = 1;
          st.push(k);
        }
      }
      return { n: n2, cy: sy2 / n2 };
    };
    flood(0, 0); // 外面
    const holes = [];
    for (let y = 1; y <= bh; y++) for (let x = 1; x <= bw; x++) {
      if (!seen[y * pw + x] && !inGlyph(x, y)) { const h = flood(x, y); if (h.n >= Math.max(2, bw * bh * 0.015)) holes.push(h); }
    }
    holes.sort((a, b) => b.n - a.n);
    f[QW * QH + 1] = Math.min(2, holes.length);
    f[QW * QH + 2] = holes.length ? Math.round(((holes[0].cy - 1) / bh) * 100) / 100 : -1;
    return f;
  }

  function qtyDistance(a, b) {
    let s = 0;
    for (let i = 0; i < QW * QH; i++) s += Math.abs(a[i] - b[i]);
    s = s / (QW * QH) + Math.abs(a[QW * QH] - b[QW * QH]) * 0.5;
    s += Math.abs(a[QW * QH + 1] - b[QW * QH + 1]) * 0.15; // 洞的數量不同
    const ya = a[QW * QH + 2], yb = b[QW * QH + 2];
    if (ya >= 0 && yb >= 0) s += Math.abs(ya - yb) * 0.4; // 洞的位置不同（6 和 9）
    return s;
  }

  /* 亮度門檻要試幾個：截圖經過縮放、影像壓縮後描邊會變淡，固定一個比例容易讓字的筆畫漏到底色裡 */
  const QKS = [0.6, 0.5, 0.7, 0.8];

  /* 這格有沒有數字、有幾個字（各門檻裡最多的） */
  function qtyCount(img, cell) {
    let n = 0;
    for (const k of QKS) n = Math.max(n, qtyGlyphs(img, cell, k).glyphs.length);
    return n;
  }

  function classify(q, T, limit) {
    let text = '', sum = 0;
    for (const c of q.glyphs) {
      const f = qtyFeature(q, c);
      let best = null, bd = Infinity;
      for (const t of T) {
        const d = qtyDistance(f, t.feat);
        if (d < bd) { bd = d; best = t; }
      }
      if (!best || bd > limit) return null;
      text += best.d;
      sum += bd;
    }
    return { text, avg: sum / q.glyphs.length };
  }

  /* 用數字樣本讀數量。每個門檻各讀一次，取「每個字都對得上」裡字數最多、最像的。都對不上回傳 null。
   * templates: [{ d, feat }]（舊格式的樣本會略過） */
  function readQty(img, cell, templates, maxDist) {
    const T = (templates || []).filter((t) => t && t.feat && t.feat.length === QLEN);
    if (!T.length) return null;
    const limit = maxDist == null ? 0.3 : maxDist;
    let best = null;
    for (const k of QKS) {
      const q = qtyGlyphs(img, cell, k);
      if (!q.glyphs.length || q.glyphs.length > 5) continue;
      const r = classify(q, T, limit);
      if (r && (!best || r.text.length > best.text.length || (r.text.length === best.text.length && r.avg < best.avg))) best = r;
    }
    return best ? parseQty(best.text) : null;
  }

  /* 使用者確認數量後學樣本：用字數剛好等於位數的門檻（字數要和位數一樣） */
  function learnQty(img, cell, qty) {
    const text = String(qty);
    if (!/^[0-9]+$/.test(text)) return [];
    for (const k of QKS) {
      const q = qtyGlyphs(img, cell, k);
      if (q.glyphs.length === text.length) return q.glyphs.map((c, i) => ({ d: text[i], feat: qtyFeature(q, c) }));
    }
    return [];
  }

  /* 給 OCR 的圖：只畫找到的字（黑字白底、放大） */
  function qtyImage(img, cell, scale) {
    scale = scale || 4;
    let q = null;
    for (const k of QKS) { const t = qtyGlyphs(img, cell, k); if (!q || t.glyphs.length > q.glyphs.length) q = t; }
    const pad = 4 * scale;
    const width = q.w * scale + pad * 2, height = q.h * scale + pad * 2;
    const data = new Uint8ClampedArray(Math.max(0, width * height * 4)).fill(255);
    let ink = 0;
    for (const c of q.glyphs) {
      for (let y = c.y0; y <= c.y1; y++) {
        for (let x = c.x0; x <= c.x1; x++) {
          if (q.lab[y * q.w + x] !== c.id) continue;
          ink++;
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              const o = ((pad + y * scale + dy) * width + (pad + x * scale + dx)) * 4;
              data[o] = data[o + 1] = data[o + 2] = 0;
            }
          }
        }
      }
    }
    return { data, width, height, ink };
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
    const mean = [0, 0, 0];
    for (let g = 0; g < SG * SG; g++) {
      for (let k = 0; k < 3; k++) mean[k] += rgb[g * 3 + k];
      if (cov[g]) for (let k = 0; k < 3; k++) rgb[g * 3 + k] = Math.round(rgb[g * 3 + k] / cov[g]);
      cov[g] = tot[g] ? Math.round((cov[g] / tot[g]) * 100) / 100 : 0;
    }
    // 整體平均色：形狀相同、只差顏色的道具（例如各成功率的捲軸）靠這個分辨
    return { cov, rgb, aspect: Math.round((bw / bh) * 100) / 100, mean: mean.map((v) => Math.round(v / n)) };
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
    // 只排除「字大小」的區塊：圖示本身亮色、有黑框的大區塊不是數字
    const keep = new Uint8Array(dm.w * dm.h);
    const seen = new Uint8Array(dm.w * dm.h);
    const maxW = cell.w * 0.25, maxH = cell.h * 0.3;
    for (let p0 = 0; p0 < dm.w * dm.h; p0++) {
      if (!dm.mask[p0] || seen[p0]) continue;
      const comp = [p0];
      seen[p0] = 1;
      let x0 = dm.w, x1 = -1, y0 = dm.h, y1 = -1;
      for (let k = 0; k < comp.length; k++) {
        const q = comp[k], x = q % dm.w, y = (q - x) / dm.w;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        for (const nq of [x > 0 ? q - 1 : -1, x < dm.w - 1 ? q + 1 : -1, y > 0 ? q - dm.w : -1, y < dm.h - 1 ? q + dm.w : -1]) {
          if (nq >= 0 && dm.mask[nq] && !seen[nq]) { seen[nq] = 1; comp.push(nq); }
        }
      }
      // 遊戲數量是白字：區塊平均要接近白色（低彩度），圖示上的米黃、淺色亮部不算
      let satSum = 0;
      for (const q of comp) {
        const x = q % dm.w, y = (q - x) / dm.w;
        const i = ((dr.y0 + y) * img.width + dr.x0 + x) * 4;
        satSum += Math.max(img.data[i], img.data[i + 1], img.data[i + 2]) - Math.min(img.data[i], img.data[i + 1], img.data[i + 2]);
      }
      const whiteish = satSum / comp.length < 45;
      if (whiteish && x1 - x0 + 1 <= maxW && y1 - y0 + 1 <= maxH) for (const q of comp) keep[q] = 1;
    }
    for (let y = 0; y < dm.h; y++) {
      for (let x = 0; x < dm.w; x++) {
        if (!keep[y * dm.w + x]) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const cx = dr.x0 + x + dx - r.x0, cy = dr.y0 + y + dy - r.y0;
            if (cx >= 0 && cy >= 0 && cx < w && cy < h) excl[cy * w + cx] = 1;
          }
        }
      }
    }
    // 從外圈往內淹：和底色接近的像素是背景；被圖示黑框圍住的區域即使顏色接近底色也算圖示
    // 半透明陰影 = 底色等比例變暗（三個通道的比例一致），也當作背景；黑框太暗不算
    const shadow = (c) => {
      const k = [0, 1, 2].map((i) => c[i] / Math.max(1, bg[i]));
      return k[0] > 0.55 && k[0] < 1 && Math.max(...k) - Math.min(...k) < 0.06;
    };
    const near = (x, y) => {
      const c = px(x, y);
      return Math.max(Math.abs(c[0] - bg[0]), Math.abs(c[1] - bg[1]), Math.abs(c[2] - bg[2])) <= 40 || shadow(c);
    };
    const outside = new Uint8Array(w * h);
    const queue = [];
    for (let x = 0; x < w; x++) { queue.push(x, (h - 1) * w + x); }
    for (let y = 0; y < h; y++) { queue.push(y * w, y * w + w - 1); }
    while (queue.length) {
      const q = queue.pop();
      if (outside[q]) continue;
      const x = q % w, y = (q - x) / w;
      if (!near(x, y) && !excl[q]) continue;
      outside[q] = 1;
      if (x > 0) queue.push(q - 1);
      if (x < w - 1) queue.push(q + 1);
      if (y > 0) queue.push(q - w);
      if (y < h - 1) queue.push(q + w);
    }
    const isFg = (x, y) => !excl[y * w + x] && !outside[y * w + x];
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
    const mean = a.mean && b.mean ? (Math.abs(a.mean[0] - b.mean[0]) + Math.abs(a.mean[1] - b.mean[1]) + Math.abs(a.mean[2] - b.mean[2])) / 765 : 0;
    return 0.35 * (cov / (SG * SG)) + 0.35 * (nc ? col / nc : 1) + 0.2 * Math.min(1, mean * 3) + 0.1 * asp;
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
    qtyGlyphs, qtyFeature, qtyDistance, qtyCount, readQty, learnQty, qtyImage,
    iconImageShape, cellShape, shapeDistance, rankCatalog,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ArrScanner = api;
})(typeof self !== 'undefined' ? self : this);
