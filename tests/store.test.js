const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../js/store.js');

function setup() {
  const st = S.createState();
  const a = S.addCharacter(st, '主角');
  const b = S.addCharacter(st, '倉庫');
  return { st, a, b };
}

test('新角色有五個空分頁', () => {
  const { a } = setup();
  assert.deepEqual(Object.keys(a.inventory), ['equip', 'use', 'setup', 'etc', 'special']);
  for (const t of S.TAB_IDS) assert.equal(a.inventory[t].length, 0);
});

test('同名同備註會合併數量，不同備註分開', () => {
  const { st, a } = setup();
  S.addItem(st, a.id, 'use', { name: '紅色藥水', qty: 10 });
  S.addItem(st, a.id, 'use', { name: ' 紅色藥水 ', qty: '5' });
  S.addItem(st, a.id, 'use', { name: '紅色藥水', qty: 1, note: '活動' });
  assert.equal(a.inventory.use.length, 2);
  assert.equal(a.inventory.use[0].qty, 15);
});

test('數量不合法時以 1 計，空名稱不新增', () => {
  const { st, a } = setup();
  assert.equal(S.addItem(st, a.id, 'etc', { name: '', qty: 3 }), null);
  assert.equal(S.addItem(st, a.id, 'etc', { name: '藍菇菇', qty: -2 }).qty, 1);
  assert.equal(S.addItem(st, a.id, 'nope', { name: 'x' }), null);
});

test('移動部分數量與全部數量', () => {
  const { st, a, b } = setup();
  const it = S.addItem(st, a.id, 'etc', { name: '綠水靈珠', qty: 30 });
  assert.ok(S.moveItem(st, a.id, 'etc', it.id, b.id, 10));
  assert.equal(a.inventory.etc[0].qty, 20);
  assert.equal(b.inventory.etc[0].qty, 10);
  assert.ok(S.moveItem(st, a.id, 'etc', it.id, b.id, 999));
  assert.equal(a.inventory.etc.length, 0);
  assert.equal(b.inventory.etc[0].qty, 30);
  assert.equal(S.moveItem(st, b.id, 'etc', b.inventory.etc[0].id, b.id, 1), false);
});

test('applyItems 取代與合併', () => {
  const { st, a } = setup();
  S.addItem(st, a.id, 'use', { name: '舊的', qty: 1 });
  S.applyItems(st, a.id, 'use', [{ name: '白色藥水', qty: 3 }, { name: '白色藥水', qty: 2 }], 'merge');
  assert.equal(a.inventory.use.length, 2);
  S.applyItems(st, a.id, 'use', [{ name: '藍色藥水', qty: 7 }], 'replace');
  assert.deepEqual(a.inventory.use.map((x) => [x.name, x.qty]), [['藍色藥水', 7]]);
});

test('normalizeState 修正壞資料並保留有效內容', () => {
  const st = S.normalizeState({
    characters: [null, { name: '', inventory: { use: [{ name: '橘子', qty: '4' }, { qty: 2 }], bogus: [{ name: 'x' }] } }],
    icons: [{ name: 'a', feat: [1, 2], tab: 'zzz' }, { name: '', feat: [] }, { name: 'b' }],
  });
  assert.equal(st.characters.length, 1);
  assert.equal(st.characters[0].name, '未命名角色');
  assert.deepEqual(st.characters[0].inventory.use.map((x) => [x.name, x.qty]), [['橘子', 4]]);
  assert.equal(st.icons.length, 1);
  assert.equal(st.icons[0].tab, '');
  assert.deepEqual(S.normalizeState('garbage'), S.createState());
});

test('localStorage 存取往返', () => {
  const mem = {};
  const storage = { getItem: (k) => mem[k] ?? null, setItem: (k, v) => { mem[k] = v; } };
  const { st, a } = setup();
  S.addItem(st, a.id, 'special', { name: '寵物食品', qty: 2 });
  S.saveState(storage, st);
  const back = S.loadState(storage);
  assert.equal(back.characters[1].name, '倉庫');
  assert.equal(back.characters[0].inventory.special[0].name, '寵物食品');
  mem[S.STORAGE_KEY] = '{broken';
  assert.equal(S.loadState(storage).characters.length, 0);
});

test('刪除圖示會清掉道具上的參照', () => {
  const { st, a } = setup();
  const ic = S.learnIcon(st, { name: '紅色藥水', tab: 'use', feat: [1, 2, 3] });
  S.addItem(st, a.id, 'use', { name: '紅色藥水', iconId: ic.id });
  assert.equal(S.iconForName(st, '紅色藥水', 'use'), ic);
  S.removeIcon(st, ic.id);
  assert.equal(a.inventory.use[0].iconId, '');
});

test('角色排序與刪除', () => {
  const { st, a, b } = setup();
  assert.ok(S.moveCharacter(st, b.id, -1));
  assert.deepEqual(st.characters.map((c) => c.id), [b.id, a.id]);
  assert.equal(S.moveCharacter(st, b.id, -1), false);
  assert.ok(S.removeCharacter(st, a.id));
  assert.equal(st.characters.length, 1);
});
