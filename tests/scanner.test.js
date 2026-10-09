const test = require('node:test');
const assert = require('node:assert/strict');
const SC = require('../js/scanner.js');

const CELL = 32;

/* 產生假的背包圖：cols x rows 格，每格是灰底，可放純色方塊圖示與亮色「數字」像素。 */
function makeImage(cols, rows, fill) {
  const width = cols * CELL, height = rows * CELL;
  const data = new Uint8ClampedArray(width * height * 4);
  const set = (x, y, [r, g, b]) => {
    const i = (y * width + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) set(x, y, [200, 200, 205]);
  for (const [idx, spec] of Object.entries(fill)) {
    const cx = (idx % cols) * CELL, cy = Math.floor(idx / cols) * CELL;
    for (let y = 6; y < 20; y++) for (let x = 8; x < 24; x++) set(cx + x, cy + y, (x + y) % 4 ? spec.color : spec.edge || [20, 20, 20]);
    if (spec.digits) {
      // 白字黑描邊，跟遊戲裡的數量文字一樣
      for (let y = 23; y < 31; y++) for (let x = 2; x < 4 + spec.digits * 4; x++) set(cx + x, cy + y, [10, 10, 10]);
      for (let y = 24; y < 30; y++) for (let x = 3; x < 3 + spec.digits * 4; x += 2) set(cx + x, cy + y, [255, 255, 255]);
    }
  }
  return { data, width, height };
}

const RED = { color: [220, 40, 40] };
const BLUE = { color: [40, 60, 220] };
const rect = (cols, rows) => ({ x: 0, y: 0, w: cols * CELL, h: rows * CELL });

test('切格位置正確', () => {
  const cells = SC.gridCells({ x: 10, y: 20, w: 100, h: 50 }, 4, 2);
  assert.equal(cells.length, 8);
  assert.deepEqual([cells[5].col, cells[5].row, cells[5].x, cells[5].y, cells[5].w, cells[5].h], [1, 1, 35, 45, 25, 25]);
});

test('判斷空格', () => {
  const img = makeImage(2, 1, { 0: RED });
  const cells = SC.gridCells(rect(2, 1), 2, 1);
  assert.equal(SC.isEmptyCell(img, cells[0]), false);
  assert.equal(SC.isEmptyCell(img, cells[1]), true);
});

test('相同圖示距離小、不同圖示距離大，數字不影響比對', () => {
  const img = makeImage(3, 1, { 0: RED, 1: { ...RED, digits: 3 }, 2: BLUE });
  const cells = SC.gridCells(rect(3, 1), 3, 1);
  const [f0, f1, f2] = cells.map((c) => SC.cellFeature(img, c));
  assert.ok(SC.featureDistance(f0, f1) < 0.01, 'same icon with qty digits');
  assert.ok(SC.featureDistance(f0, f2) > 0.08, 'different icon');
  assert.equal(SC.featureDistance(f0, [1]), 1);
});

test('analyze 用圖示庫辨識並略過空格', () => {
  const img = makeImage(4, 2, { 0: RED, 1: BLUE, 5: { ...RED, digits: 2 } });
  const cells = SC.gridCells(rect(4, 2), 4, 2);
  const icons = [
    { id: 'r', name: '紅色藥水', tab: 'use', feat: SC.cellFeature(img, cells[0]) },
    { id: 'b', name: '藍色藥水', tab: 'etc', feat: SC.cellFeature(img, cells[1]) },
  ];
  const res = SC.analyze(img, rect(4, 2), 4, 2, { icons, tab: 'use' });
  assert.deepEqual(res.map((r) => r.cell.index), [0, 1, 5]);
  assert.equal(res[0].icon.name, '紅色藥水');
  assert.equal(res[1].icon, null, '不同分頁的圖示不參與比對');
  assert.equal(res[2].icon.name, '紅色藥水');
});

test('數字區二值化：有數字才有墨水', () => {
  const img = makeImage(2, 1, { 0: { ...RED, digits: 3 }, 1: RED });
  const cells = SC.gridCells(rect(2, 1), 2, 1);
  const withDigits = SC.digitImage(img, cells[0], 3);
  const without = SC.digitImage(img, cells[1], 3);
  assert.ok(withDigits.ink > 0);
  assert.equal(without.ink, 0);
  assert.equal(withDigits.data.length, withDigits.width * withDigits.height * 4);
});

test('parseQty 容錯', () => {
  assert.equal(SC.parseQty(' 1 2O\n'), 120);
  assert.equal(SC.parseQty('l5'), 15);
  assert.equal(SC.parseQty(''), null);
  assert.equal(SC.parseQty('0'), null);
  assert.equal(SC.parseQty('abc'), null);
});

/* 3x5 點陣數字，白字黑框，與遊戲數量字型相同的畫法 */
const FONT = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001',
  '111100111001111', '111100111101111', '111001010010010', '111101111101111', '111101111001111'];
function drawNumber(img, cellIdx, cols, text) {
  const cx = (cellIdx % cols) * CELL, cy = Math.floor(cellIdx / cols) * CELL;
  const set = (x, y, v) => { const i = ((cy + y) * img.width + cx + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; };
  for (const pass of [10, 255]) {
    for (let i = 0; i < text.length; i++) {
      const bits = FONT[Number(text[i])];
      for (let k = 0; k < 15; k++) {
        if (bits[k] !== '1') continue;
        const x = 3 + i * 8 + (k % 3) * 2, y = 20 + Math.floor(k / 3) * 2;
        const o = pass === 10 ? 1 : 0;
        for (let dy = -o; dy < 2 + o; dy++) for (let dx = -o; dx < 2 + o; dx++) set(x + dx, y + dy, pass);
      }
    }
  }
}

test('數字模板：學會後能讀出沒看過的組合', () => {
  const numbers = ['120', '87', '345', '96', '200', '9'];
  const img = makeImage(numbers.length, 1, Object.fromEntries(numbers.map((_, i) => [i, RED])));
  numbers.forEach((n, i) => drawNumber(img, i, numbers.length, n));
  const cells = SC.gridCells(rect(numbers.length, 1), numbers.length, 1);
  assert.equal(SC.readDigits(img, cells[0], []), null, '沒有模板時讀不出來');
  let T = [];
  for (let i = 0; i < 4; i++) T = SC.mergeDigitTemplates(T, SC.learnDigits(img, cells[i], Number(numbers[i])));
  assert.deepEqual(Array.from(new Set(T.map((t) => t.d))).sort().join(''), '0123456789');
  assert.equal(SC.readDigits(img, cells[4], T), 200);
  assert.equal(SC.readDigits(img, cells[5], T), 9);
  // 位數不符就不學
  assert.deepEqual(SC.learnDigits(img, cells[0], 12), []);
  // 重複樣本不會一直累加
  assert.equal(SC.mergeDigitTemplates(T, SC.learnDigits(img, cells[0], 120)).length, T.length);
});

/* ---- 圖鑑比對：透明背景、不同大小的圖示要能對上截圖裡的格子 ---- */
const SHAPES = {
  ball: (u, v) => (u - 0.5) ** 2 + (v - 0.55) ** 2 < 0.16 ? [220, 40, 40] : null,
  box: (u, v) => u > 0.1 && u < 0.9 && v > 0.25 && v < 0.75 ? [240, 200, 60] : null,
  gem: (u, v) => Math.abs(u - 0.5) + Math.abs(v - 0.5) < 0.45 ? [120, 70, 220] : null,
  leaf: (u, v) => ((u - 0.5) / 0.45) ** 2 + ((v - 0.5) / 0.25) ** 2 < 1 ? [40, 170, 90] : null,
  blueball: (u, v) => (u - 0.5) ** 2 + (v - 0.55) ** 2 < 0.16 ? [40, 70, 220] : null,
};
/* 透明背景的網站圖片，size x size */
function iconPng(shape, size) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const c = SHAPES[shape]((x + 0.5) / size, (y + 0.5) / size);
    if (!c) continue;
    const i = (y * size + x) * 4;
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
  }
  return { data, width: size, height: size };
}
/* 畫進截圖格子：灰底、圖示 22px、可加數量 */
function drawIcon(img, cellIdx, cols, shape) {
  const cx = (cellIdx % cols) * CELL + 5, cy = Math.floor(cellIdx / cols) * CELL + 3;
  for (let y = 0; y < 22; y++) for (let x = 0; x < 22; x++) {
    const c = SHAPES[shape]((x + 0.5) / 22, (y + 0.5) / 22);
    if (!c) continue;
    const i = ((cy + y) * img.width + cx + x) * 4;
    img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2];
  }
}

test('圖鑑比對：不受背景、大小、數量數字影響', () => {
  const names = Object.keys(SHAPES);
  const catalog = names.map((n) => ({ name: n, tab: 'use', shape: SC.iconImageShape(iconPng(n, 64)) }));
  const order = ['gem', 'ball', 'leaf', 'blueball', 'box'];
  const img = makeImage(order.length, 1, {});
  order.forEach((n, i) => drawIcon(img, i, order.length, n));
  drawNumber(img, 1, order.length, '87');
  drawNumber(img, 2, order.length, '200');
  const cells = SC.gridCells(rect(order.length, 1), order.length, 1);
  order.forEach((n, i) => {
    const ranked = SC.rankCatalog(SC.cellShape(img, cells[i]), catalog, 'use', 3);
    assert.equal(ranked[0].item.name, n, `格子 ${i} 應該是 ${n}`);
    assert.ok(ranked[0].dist < ranked[1].dist - 0.03, `${n} 要明顯勝過第二名`);
  });
  assert.deepEqual(SC.rankCatalog(SC.cellShape(img, cells[0]), catalog, 'equip'), [], '分頁不同不比');
  assert.equal(SC.cellShape(makeImage(1, 1, {}), cells[0]), null, '空格沒有前景');
});
