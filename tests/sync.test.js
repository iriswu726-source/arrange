const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../js/store.js');
const Y = require('../js/sync.js');

/* 假的雲端：兩台裝置共用同一個 Map，寫入後通知其他裝置。 */
function fakeCloud() {
  const docs = new Map();
  const devices = [];
  function device() {
    const dev = { state: S.createState(), log: [] };
    dev.sync = Y.createSync({
      set: async (path, data) => { docs.set(path, JSON.parse(JSON.stringify(data))); dev.log.push('set ' + path); broadcast(dev, path); },
      remove: async (path) => { docs.delete(path); dev.log.push('rm ' + path); broadcast(dev, path); },
    });
    // 新裝置先載入全部現有文件
    for (const [path, data] of docs) dev.sync.applyRemote(dev.state, path, data);
    devices.push(dev);
    return dev;
  }
  function broadcast(from, path) {
    for (const d of devices) if (d !== from) d.sync.applyRemote(d.state, path, docs.has(path) ? docs.get(path) : null);
  }
  return { docs, device };
}

test('只上傳有變動的文件', () => {
  const cloud = fakeCloud();
  const a = cloud.device();
  const c1 = S.addCharacter(a.state, '劍士');
  S.addCharacter(a.state, '法師');
  let r = a.sync.push(a.state);
  assert.equal(r.writes, 3); // 兩個角色 + 數字模板
  r = a.sync.push(a.state);
  assert.equal(r.writes, 0);
  S.addItem(a.state, c1.id, 'use', { name: '紅色藥水', qty: 5 });
  r = a.sync.push(a.state);
  assert.equal(r.writes, 1);
  assert.deepEqual(a.log.slice(-1), ['set characters/' + c1.id]);
});

test('兩台裝置互相同步：新增、修改、刪除、排序', () => {
  const cloud = fakeCloud();
  const a = cloud.device();
  const c1 = S.addCharacter(a.state, '劍士');
  const c2 = S.addCharacter(a.state, '法師');
  S.addItem(a.state, c1.id, 'etc', { name: '綠水靈珠', qty: 30 });
  a.sync.push(a.state);

  const b = cloud.device(); // 朋友加入，拿到全部資料
  assert.deepEqual(b.state.characters.map((c) => c.name), ['劍士', '法師']);
  assert.equal(b.state.characters[0].inventory.etc[0].qty, 30);

  // 朋友把道具移到法師
  S.moveItem(b.state, c1.id, 'etc', b.state.characters[0].inventory.etc[0].id, c2.id, 10);
  b.sync.push(b.state);
  assert.equal(S.getCharacter(a.state, c1.id).inventory.etc[0].qty, 20);
  assert.equal(S.getCharacter(a.state, c2.id).inventory.etc[0].qty, 10);

  // 我調整角色順序
  S.moveCharacter(a.state, c2.id, -1);
  a.sync.push(a.state);
  assert.deepEqual(b.state.characters.map((c) => c.name), ['法師', '劍士']);

  // 朋友刪角色
  S.removeCharacter(b.state, c1.id);
  b.sync.push(b.state);
  assert.deepEqual(a.state.characters.map((c) => c.name), ['法師']);
  assert.equal(cloud.docs.has('characters/' + c1.id), false);
});

test('圖示與數字模板同步', () => {
  const cloud = fakeCloud();
  const a = cloud.device();
  const b = cloud.device();
  const ic = S.learnIcon(a.state, { name: '紅色藥水', tab: 'use', feat: [1, 2, 3], thumb: 'data:x' });
  a.state.digits = [{ d: '7', feat: [0.5, 1] }];
  a.sync.push(a.state);
  assert.equal(b.state.icons[0].name, '紅色藥水');
  assert.deepEqual(b.state.digits, [{ d: '7', feat: [0.5, 1] }]);
  S.removeIcon(b.state, ic.id);
  b.sync.push(b.state);
  assert.equal(a.state.icons.length, 0);
});

test('收到自己剛寫的回音不算變動', () => {
  const cloud = fakeCloud();
  const a = cloud.device();
  const c = S.addCharacter(a.state, '劍士');
  a.sync.push(a.state);
  assert.equal(a.sync.applyRemote(a.state, 'characters/' + c.id, cloud.docs.get('characters/' + c.id)), false);
  assert.equal(a.sync.applyRemote(a.state, 'characters/nope', null), false);
});

test('文件內容可以存進 Firestore（沒有巢狀陣列、沒有 undefined）', () => {
  const st = S.createState();
  const c = S.addCharacter(st, 'x');
  S.addItem(st, c.id, 'use', { name: 'a', qty: 2 });
  S.learnIcon(st, { name: 'b', feat: [1, 2] });
  const check = (v, inArray) => {
    assert.notEqual(v, undefined);
    if (Array.isArray(v)) { assert.ok(!inArray, 'nested array'); v.forEach((x) => check(x, true)); }
    else if (v && typeof v === 'object') Object.values(v).forEach((x) => check(x, false));
  };
  for (const d of Object.values(Y.docsFromState(st))) check(d, false);
});

test('裝備素質會同步', () => {
  const cloud = fakeCloud();
  const a = cloud.device();
  const b = cloud.device();
  const c = S.addCharacter(a.state, '劍士');
  const it = S.addItem(a.state, c.id, 'equip', { name: '手套', stats: { watk: 3 } });
  a.sync.push(a.state);
  assert.deepEqual(b.state.characters[0].inventory.equip[0].stats, { watk: 3 });
  S.updateItem(b.state, c.id, 'equip', it.id, { stats: { watk: 4, slots: 2 } });
  b.sync.push(b.state);
  assert.deepEqual(a.state.characters[0].inventory.equip[0].stats, { watk: 4, slots: 2 });
});
