/* 雲端同步：把 state 拆成一份份文件（每個角色、每個圖示、數字模板各一份），
 * 只上傳有變動的文件；收到別人的變動時合併回 state。
 * 不依賴 Firebase，backend 只要提供 set(path, data) / remove(path)，方便測試。 */
(function (root) {
  'use strict';

  const TAB_IDS = ['equip', 'use', 'setup', 'etc', 'special'];
  const DIGITS_PATH = 'meta/digits';

  function cleanStats(raw) {
    const out = {};
    if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) if (Number.isFinite(Number(v)) && Number(v) !== 0) out[k] = Math.trunc(Number(v));
    return out;
  }

  /* state → { path: data } */
  function docsFromState(state) {
    const docs = {};
    state.characters.forEach((c, i) => {
      const inventory = {};
      for (const t of TAB_IDS) {
        inventory[t] = (c.inventory[t] || []).map((it) => ({
          id: it.id, name: it.name, qty: it.qty, note: it.note || '', iconId: it.iconId || '', stats: it.stats || {},
        }));
      }
      docs['characters/' + c.id] = { name: c.name, job: c.job || '', level: c.level || '', order: i, inventory };
    });
    for (const ic of state.icons) {
      docs['icons/' + ic.id] = { name: ic.name, tab: ic.tab || '', feat: ic.feat, thumb: ic.thumb || '' };
    }
    docs[DIGITS_PATH] = { list: (state.digits || []).map((t) => ({ d: t.d, feat: t.feat })) };
    return docs;
  }

  function charFromDoc(id, data) {
    const inventory = {};
    const inv = (data && data.inventory) || {};
    for (const t of TAB_IDS) {
      inventory[t] = (Array.isArray(inv[t]) ? inv[t] : []).map((it) => ({
        id: String(it.id || ''), name: String(it.name || ''), qty: Number(it.qty) || 1,
        note: String(it.note || ''), iconId: String(it.iconId || ''), stats: cleanStats(it.stats),
      })).filter((it) => it.id && it.name);
    }
    return { id, name: String(data.name || '未命名角色'), job: String(data.job || ''), level: data.level || '', inventory, order: Number(data.order) || 0 };
  }

  function createSync(backend) {
    const synced = new Map(); // path → 最後一次同步的 JSON
    const orders = new Map(); // 角色 id → order（排序用）

    /* 把本機變動推上去。回傳本次寫入 / 刪除的文件數。 */
    function push(state) {
      const docs = docsFromState(state);
      const jobs = [];
      let writes = 0, removes = 0;
      for (const [path, data] of Object.entries(docs)) {
        const json = JSON.stringify(data);
        if (synced.get(path) === json) continue;
        synced.set(path, json);
        jobs.push(backend.set(path, data));
        writes++;
      }
      for (const path of Array.from(synced.keys())) {
        if (path in docs) continue;
        synced.delete(path);
        jobs.push(backend.remove(path));
        removes++;
      }
      state.characters.forEach((c, i) => orders.set(c.id, i));
      return { writes, removes, done: Promise.all(jobs) };
    }

    /* 收到遠端文件（data 為 null 表示被刪除），合併進 state。
     * 回傳 true 表示 state 有變。 */
    function applyRemote(state, path, data) {
      const json = data == null ? null : JSON.stringify(data);
      if (json === null ? !synced.has(path) : synced.get(path) === json) return false;
      if (json === null) synced.delete(path);
      else synced.set(path, json);
      const slash = path.indexOf('/');
      const coll = path.slice(0, slash), id = path.slice(slash + 1);
      if (coll === 'characters') {
        const i = state.characters.findIndex((c) => c.id === id);
        if (data == null) {
          if (i >= 0) state.characters.splice(i, 1);
          orders.delete(id);
        } else {
          const ch = charFromDoc(id, data);
          orders.set(id, ch.order);
          delete ch.order;
          if (i >= 0) state.characters[i] = ch;
          else state.characters.push(ch);
          state.characters.sort((a, b) => (orders.get(a.id) || 0) - (orders.get(b.id) || 0) || a.id.localeCompare(b.id));
        }
      } else if (coll === 'icons') {
        const i = state.icons.findIndex((x) => x.id === id);
        if (data == null) {
          if (i >= 0) state.icons.splice(i, 1);
        } else {
          const ic = { id, name: String(data.name || ''), tab: String(data.tab || ''), feat: (data.feat || []).map(Number), thumb: String(data.thumb || '') };
          if (i >= 0) state.icons[i] = ic;
          else state.icons.push(ic);
        }
      } else if (path === DIGITS_PATH) {
        state.digits = data && Array.isArray(data.list) ? data.list.map((t) => ({ d: String(t.d), feat: (t.feat || []).map(Number) })) : [];
      } else {
        return false;
      }
      return true;
    }

    function reset() {
      synced.clear();
      orders.clear();
    }

    return { push, applyRemote, reset, _synced: synced };
  }

  const api = { docsFromState, createSync, DIGITS_PATH };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ArrSync = api;
})(typeof self !== 'undefined' ? self : this);
