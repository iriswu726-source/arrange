const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../js/capture.js');

/* 假背包長圖：4 欄、ROWS 列，格子 30px、間隙 6px（間隙顏色均勻），每格畫不同的色塊。 */
const CELL = 30, GAP = 6, PITCH = CELL + GAP, COLS = 4;
function bagImage(rows, emptyFrom = rows) {
  const w = COLS * PITCH + GAP, h = rows * PITCH + GAP;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const gx = (x - GAP) % PITCH, gy = (y - GAP) % PITCH;
    const inCell = x >= GAP && y >= GAP && gx < CELL && gy < CELL;
    let c = [160, 160, 156]; // 間隙
    if (inCell) {
      const r = Math.floor((y - GAP) / PITCH), col = Math.floor((x - GAP) / PITCH);
      c = [150, 150, 140]; // 格子底色
      if (r < emptyFrom && gx > 5 && gx < 25 && gy > 4 && gy < 24) {
        const k = r * COLS + col;
        c = [(k * 53) % 256, (k * 97 + 40) % 256, (k * 31 + 90) % 256];
        if ((gx + gy + k) % 7 === 0) c = [0, 0, 0];
      }
    }
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
  }
  return { data, width: w, height: h };
}
function view(img, top, h) {
  const out = new Uint8ClampedArray(img.width * h * 4);
  out.set(img.data.subarray(top * img.width * 4, (top + h) * img.width * 4));
  return { data: out, width: img.width, height: h };
}

test('捲動中不接；停下來才接，只接新出現的線（平滑捲動也可以）', () => {
  const bag = bagImage(12);
  const H = 200;
  const st = K.createStitcher();
  const feed = (top) => { st.add(K.lineSigs(view(bag, top, H))); return st.add(K.lineSigs(view(bag, top, H))); };
  assert.equal(st.add(K.lineSigs(view(bag, 0, H))).status, 'moving');
  assert.equal(st.add(K.lineSigs(view(bag, 0, H))).status, 'first');
  assert.equal(feed(0).status, 'same');
  let r = feed(17); // 不是整列的位移
  assert.equal(r.status, 'added');
  assert.equal(r.lines, 17);
  r = feed(36 + 17);
  assert.equal(r.lines, 36);
  for (const top of [100, 150, bag.height - H]) feed(top);
  assert.equal(st.total, bag.height);
});

test('捲太多、往上捲的畫面不接', () => {
  const bag = bagImage(12);
  const H = 150;
  const st = K.createStitcher();
  const feed = (top) => { st.add(K.lineSigs(view(bag, top, H))); return st.add(K.lineSigs(view(bag, top, H))); };
  feed(0);
  assert.equal(feed(140).status, 'gap');
  assert.equal(feed(70).status, 'added');
  assert.equal(feed(30).status, 'gap'); // 往上捲
  assert.equal(st.total, 150 + 70);
});

test('從大概的框找出格子欄、列', () => {
  const bag = bagImage(10, 7);
  // 欄：框得比格子大一點
  const c = K.fitColumns(bag, COLS);
  assert.ok(Math.abs(c.pitch - PITCH) < 1, 'pitch ' + c.pitch);
  assert.ok(Math.abs(c.x - GAP / 2) < 3, 'x ' + c.x);
  const r = K.fitRows(bag, c.pitch);
  assert.ok(Math.abs(r.pitch - PITCH) < 1, 'row pitch ' + r.pitch);
  assert.ok(Math.abs(r.y - GAP / 2) < 3, 'y ' + r.y);
  assert.equal(r.rows, 10);
});

test('視窗移動後找回標題列', () => {
  const W = 400, H = 300;
  const frame = (ox, oy) => {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      let v = ((x * 7 + y * 13) % 50) + 40; // 背景花紋
      const lx = x - ox, ly = y - oy;
      if (lx >= 0 && lx < 80 && ly >= 0 && ly < 24) v = 200 - ((lx * 5 + ly * 11) % 90); // 標題列
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
    return { data, width: W, height: H };
  };
  const f0 = frame(50, 40);
  const crop = (img, x, y, w, h) => { const d = new Uint8ClampedArray(w * h * 4); for (let j = 0; j < h; j++) d.set(img.data.subarray(((y + j) * img.width + x) * 4, ((y + j) * img.width + x + w) * 4), j * w * 4); return { data: d, width: w, height: h }; };
  const anchor = { img: crop(f0, 50, 40, 80, 24), x: 50, y: 40 };
  assert.deepEqual([K.locate(f0, anchor).x, K.locate(f0, anchor).y], [50, 40]);
  const p = K.locate(frame(233, 171), anchor);
  assert.deepEqual([p.x, p.y], [233, 171]);
  assert.ok(p.diff < 5);
});

test('框到不會動的外框：算出最下面幾條不動的線', () => {
  const bag = bagImage(12);
  const H = 180, STILL = 12;
  // 最下面 STILL 條線固定是外框顏色
  const framed = (top) => {
    const v = view(bag, top, H);
    for (let y = H - STILL; y < H; y++) for (let x = 0; x < v.width; x++) { const i = (y * v.width + x) * 4; v.data[i] = 90; v.data[i + 1] = 100; v.data[i + 2] = 120; }
    return K.lineSigs(v);
  };
  const st = K.createStitcher();
  const feed = (top) => { st.add(framed(top)); return st.add(framed(top)); };
  feed(0);
  const r = feed(40);
  assert.equal(r.status, 'added');
  assert.equal(r.lines, 40);
  assert.equal(r.still, STILL);
});
