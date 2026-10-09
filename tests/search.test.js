const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../js/store.js');
const Q = require('../js/search.js');

function world() {
  const st = S.createState();
  const a = S.addCharacter(st, '劍士');
  const b = S.addCharacter(st, '法師');
  S.addItem(st, a.id, 'use', { name: '紅色藥水', qty: 100 });
  S.addItem(st, b.id, 'use', { name: '紅色藥水', qty: 50 });
  S.addItem(st, b.id, 'use', { name: '藍色藥水', qty: 30 });
  S.addItem(st, a.id, 'equip', { name: '褐色工地手套', qty: 1, note: '攻擊+3' });
  S.addItem(st, b.id, 'etc', { name: '藥水瓶', qty: 4 });
  return { st, a, b };
}

test('跨角色搜尋並依名稱分組加總', () => {
  const { st } = world();
  const r = Q.search(st, '紅色藥水');
  assert.equal(r.length, 1);
  assert.equal(r[0].total, 150);
  assert.deepEqual(r[0].entries.map((e) => e.charName), ['劍士', '法師']);
});

test('多關鍵字 AND、搜備註、簡體字與全形', () => {
  const { st } = world();
  assert.deepEqual(Q.search(st, '藥水 藍').map((g) => g.name), ['藍色藥水']);
  assert.deepEqual(Q.search(st, '攻擊').map((g) => g.name), ['褐色工地手套']);
  assert.equal(Q.search(st, '红色药水')[0].total, 150);
  assert.equal(Q.normalize('ＡＢ ｃ1'), 'abc1');
});

test('完全相符與開頭相符排前面', () => {
  const { st } = world();
  const names = Q.search(st, '藥水').map((g) => g.name);
  assert.equal(names[0], '藥水瓶');
});

test('限定分頁與角色', () => {
  const { st, b } = world();
  assert.deepEqual(Q.search(st, '藥水', { tabs: ['etc'] }).map((g) => g.name), ['藥水瓶']);
  const r = Q.search(st, '紅色', { charIds: [b.id] });
  assert.equal(r[0].total, 50);
});

test('統計與分散道具', () => {
  const { st } = world();
  const s = Q.stats(st);
  assert.equal(s[0].per.use, 1);
  assert.equal(s[1].items, 3);
  assert.deepEqual(Q.duplicates(st).map((g) => g.name), ['紅色藥水']);
});
