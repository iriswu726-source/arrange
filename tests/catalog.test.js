const test = require('node:test');
const assert = require('node:assert/strict');
const CAT = require('../js/catalog.js');

test('錢袋 x1～x4 只留一個，名稱去掉 xN', () => {
  const items = [
    { id: 'a', name: '錢袋 x1', nameEn: 'Meso Bag x1' },
    { id: 'b', name: '錢袋 x2', nameEn: 'Meso Bag x2' },
    { id: 'c', name: '錢袋(x3)' },
    { id: 'd', name: '錢袋×4' },
    { id: 'e', name: '紅色藥水' },
    { id: 'f', name: '紅色藥水' },
    { id: 'g', name: '白色藥水' },
  ];
  const out = CAT.collapseMultiples(items);
  assert.deepEqual(out.map((x) => x.name), ['錢袋', '紅色藥水', '紅色藥水', '白色藥水'], '同名不同圖的道具不合併');
  assert.equal(out[0].nameEn, 'Meso Bag');
  assert.equal(out[0].id, 'a');
});

test('消耗品頁面對應到消耗分頁', () => {
  assert.equal(CAT.SECTION_TAB.useable, 'use');
  assert.equal(CAT.SECTION_TAB.equipment, 'equip');
  assert.equal(CAT.CATEGORY_TAB.scrolls, 'use');
});
