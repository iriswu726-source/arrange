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

test('裝備素質：整理、摘要、不合併', () => {
  const { st, a } = setup();
  assert.deepEqual(S.cleanStats({ str: '3', watk: 5.7, dex: 0, bogus: 9, slots: '7' }), { str: 3, watk: 5, slots: 7 });
  assert.equal(S.statsSummary({ str: 3, watk: 5, speed: -2, slots: 7 }), 'STR+3 攻擊+5 移速-2 可升級7');
  assert.equal(S.statsSummary({}), '');
  S.addItem(st, a.id, 'equip', { name: '褐色工地手套', stats: { watk: 2 } });
  S.addItem(st, a.id, 'equip', { name: '褐色工地手套' });
  assert.equal(a.inventory.equip.length, 2, '裝備每件分開');
  const it = S.updateItem(st, a.id, 'equip', a.inventory.equip[1].id, { stats: { dex: 4, slots: 5 } });
  assert.deepEqual(it.stats, { dex: 4, slots: 5 });
  // 消耗類照舊合併
  S.addItem(st, a.id, 'use', { name: '紅色藥水', qty: 1 });
  S.addItem(st, a.id, 'use', { name: '紅色藥水', qty: 2 });
  assert.equal(a.inventory.use.length, 1);
});

test('重新掃描（取代）裝備欄時保留素質與備註', () => {
  const { st, a, b } = setup();
  const g1 = S.addItem(st, a.id, 'equip', { name: '手套', stats: { watk: 3 }, note: '+3' });
  S.addItem(st, a.id, 'equip', { name: '手套', stats: { watk: 1 } });
  S.addItem(st, a.id, 'equip', { name: '帽子', stats: { wdef: 10 } });
  S.applyItems(st, a.id, 'equip', [{ name: '手套' }, { name: '手套' }, { name: '新鞋子' }], 'replace');
  assert.deepEqual(a.inventory.equip.map((x) => [x.name, x.stats.watk || x.stats.wdef || 0, x.note]), [['手套', 3, '+3'], ['手套', 1, ''], ['新鞋子', 0, '']]);
  assert.equal(a.inventory.equip[0].id, g1.id, '沿用原本 id');
  // 移動到別的角色時素質跟著走
  assert.ok(S.moveItem(st, a.id, 'equip', g1.id, b.id, 1));
  assert.deepEqual(b.inventory.equip[0].stats, { watk: 3 });
  // 舊資料沒有 stats 也能讀
  const back = S.normalizeState(JSON.parse(JSON.stringify({ characters: [{ name: 'x', inventory: { equip: [{ name: '舊裝備' }] } }] })));
  assert.deepEqual(back.characters[0].inventory.equip[0].stats, {});
});
