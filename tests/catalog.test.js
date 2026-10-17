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
  assert.equal(CAT.SECTION_TAB.misc, 'etc', '其他欄（/images/misc/）');
});

test('楓幣袋：本身已有時 x2～x5 不重複', () => {
  const out = CAT.collapseMultiples([{ id: '1', name: '銅色楓幣袋' }, { id: '2', name: '銅色楓幣袋x2' }, { id: '3', name: '銅色楓幣袋x5' }, { id: '4', name: '金色楓幣袋x2' }]);
  assert.deepEqual(out.map((x) => x.id + ':' + x.name), ['1:銅色楓幣袋', '4:金色楓幣袋']);
});

test('技能書／母書判斷', () => {
  assert.equal(CAT.bookKind('[技能書]楓葉祝福20'), 'skill');
  assert.equal(CAT.bookKind('[母書]屬性強化'), 'mastery');
  assert.equal(CAT.bookKind('【母書】三飛閃'), 'mastery');
  assert.equal(CAT.bookKind('技能書 進階鬥氣30'), 'skill');
  assert.equal(CAT.bookKind('紅色藥水'), '');
  assert.equal(CAT.bookKind('冒險家的技能書'), '', '不是開頭的不算');
});

test('名稱是分類標籤時改用英文名稱', () => {
  assert.equal(CAT.fixName({ name: '任務道具', nameEn: 'Red Marble' }).name, 'Red Marble');
  assert.equal(CAT.fixName({ name: '掉落物', nameEn: 'Wooden Hammer' }).name, 'Wooden Hammer');
  assert.equal(CAT.fixName({ name: '蛇皮', nameEn: 'Snake Skin' }).name, '蛇皮');
  assert.equal(CAT.fixName({ name: '任務道具', nameEn: '' }).name, '任務道具');
});

test('裝備名稱後面的 (LV. 100) 會拿掉', () => {
  const C = require('../js/catalog.js');
  assert.equal(C.fixName({ name: '藍色龍盔甲 (LV. 110)', nameEn: 'Blue Dragon Armor' }).name, '藍色龍盔甲');
  assert.equal(C.fixName({ name: '致命劍盾 (LV. 120)', nameEn: 'Dragon Khanjar (Lv. 120)' }).nameEn, 'Dragon Khanjar');
  assert.equal(C.fixName({ name: '火之眼戒指（第2階段） (LV. 10)' }).name, '火之眼戒指（第2階段）');
});

test('名稱只抓到分類字（藥水）時改用英文名稱', () => {
  const C = require('../js/catalog.js');
  assert.equal(C.fixName({ name: '藥水', nameEn: 'Cheesecake' }).name, 'Cheesecake');
  assert.equal(C.fixName({ name: '紅色藥水', nameEn: 'Red Potion' }).name, '紅色藥水');
});
