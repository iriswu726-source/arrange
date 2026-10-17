const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../js/capture.js');

/* 假背包：每列一種顏色（同字母同顏色），畫成 imgData；看得到 rows 列，從第 top 列開始 */
const COLORS = { A: [200, 30, 30], B: [30, 200, 30], C: [30, 30, 200], D: [200, 200, 30], E: [60, 50, 40], F: [200, 30, 200], G: [30, 200, 200] };
function frame(bag, top, rows, cols = 4, cell = 12) {
  const w = cols * cell, h = rows * cell;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ch = bag[top + Math.floor(y / cell)][Math.floor(x / cell)];
    const c = COLORS[ch];
    const i = (y * w + x) * 4;
    // 格子裡畫個小圖示，讓同一列不同格不一樣
    const inner = x % cell > 3 && x % cell < 9 && y % cell > 3 && y % cell < 9;
    data[i] = inner ? 255 - c[0] : c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
  }
  return K.rowSigs({ data, width: w, height: h }, { x: 0, y: 0, w, h }, cols, rows);
}
const bag = ['AAAA', 'BBBB', 'CCCC', 'DDDD', 'EEEE', 'EEEE', 'FFFF', 'GGGG'];

test('捲動中的畫面不接，停下來才接；重疊的列只算一次', () => {
  const st = K.createStitcher();
  assert.equal(st.add(frame(bag, 0, 4)).status, 'moving');
  assert.equal(st.add(frame(bag, 0, 4)).status, 'first');
  assert.equal(st.add(frame(bag, 0, 4)).status, 'same');
  assert.equal(st.add(frame(bag, 1, 4)).status, 'moving');
  const r = st.add(frame(bag, 1, 4));
  assert.equal(r.status, 'added');
  assert.deepEqual(r.rows, [3]);
  assert.equal(st.total, 5);
  st.add(frame(bag, 3, 4));
  const r2 = st.add(frame(bag, 3, 4));
  assert.deepEqual(r2.rows, [2, 3]);
  st.add(frame(bag, 4, 4));
  assert.deepEqual(st.add(frame(bag, 4, 4)).rows, [3]);
  assert.equal(st.total, 8);
});

test('連續一樣的空列也算對列數', () => {
  const st = K.createStitcher();
  st.add(frame(bag, 0, 4)); st.add(frame(bag, 0, 4)); // A B C D
  st.add(frame(bag, 2, 4)); st.add(frame(bag, 2, 4)); // C D E E
  assert.equal(st.total, 6);
  st.add(frame(bag, 4, 4)); st.add(frame(bag, 4, 4)); // E E F G
  assert.equal(st.total, 8);
});

test('捲太多、對不上的畫面不接', () => {
  const st = K.createStitcher();
  st.add(frame(bag, 0, 3)); st.add(frame(bag, 0, 3)); // A B C
  st.add(frame(bag, 4, 3));
  assert.equal(st.add(frame(bag, 4, 3)).status, 'gap'); // E E F：和 C 接不上
  assert.equal(st.total, 3);
  st.add(frame(bag, 2, 3));
  assert.equal(st.add(frame(bag, 2, 3)).status, 'added'); // C D E
  assert.equal(st.total, 5);
});
