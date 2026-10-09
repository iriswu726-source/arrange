/* 雲端同步：把 state 拆成一份份文件（每個角色一份、圖示庫打包成幾份、數字模板一份），
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

  /* 依欄位名稱排序後轉 JSON：Firebase 傳回的欄位順序和本機不同，用這個比對才不會誤判成有變動 */
  function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }

  /* ---------- 圖示庫打包 ----------
   * 每個圖示依 id 固定分到某一包（icons/pack-<包數>-<編號>），學新圖示只會改到一包。
   * 每包約 200 個；圖示變多時包數加倍（1、2、4、8…）。比對特徵（0～255 的整數）壓成 base64 字串。 */
  const PACK_SIZE = 200;
  function packCount(n) {
    let b = 1;
    while (b * PACK_SIZE < n) b *= 2;
    return b;
  }
  function hashId(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function toBase64(bin) {
    return typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
  }
  function fromBase64(b64) {
    return typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  }
  function encodeFeat(feat) {
    let bin = '';
    for (const v of feat || []) bin += String.fromCharCode(Math.max(0, Math.min(255, Math.round(Number(v) || 0))));
    return toBase64(bin);
  }
  function decodeFeat(str) {
    const bin = fromBase64(String(str || ''));
    const out = new Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function iconFromPacked(ic) {
    return { id: String(ic.id), name: String(ic.name || ''), tab: String(ic.tab || ''), feat: decodeFeat(ic.f), thumb: String(ic.thumb || '') };
  }
  function iconFromLegacy(id, d) {
    return { id, name: String(d.name || ''), tab: String(d.tab || ''), feat: (d.feat || []).map(Number), thumb: String(d.thumb || '') };
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
    const B = packCount(state.icons.length);
    const packs = {};
    for (const ic of state.icons.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      const k = hashId(ic.id) % B;
      (packs[k] = packs[k] || []).push({ id: ic.id, name: ic.name, tab: ic.tab || '', f: encodeFeat(ic.feat), thumb: ic.thumb || '' });
    }
    for (const k of Object.keys(packs)) docs[`icons/pack-${B}-${k}`] = { b: B, k: Number(k), list: packs[k] };
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
    const iconDocs = new Map(); // 雲端上 icons/ 底下的文件（包或舊格式單一圖示），用來重建圖示庫

    function rebuildIcons(state) {
      const map = new Map();
      for (const [id, d] of iconDocs) {
        if (id.startsWith('pack-')) for (const ic of d.list || []) map.set(String(ic.id), iconFromPacked(ic));
        else map.set(id, iconFromLegacy(id, d)); // 舊格式：一個圖示一份文件
      }
      state.icons = Array.from(map.values());
    }

    /* 把本機變動推上去。回傳本次寫入 / 刪除的文件數。 */
    function push(state) {
      const docs = docsFromState(state);
      const jobs = [];
      let writes = 0, removes = 0;
      for (const [path, data] of Object.entries(docs)) {
        const json = stable(data);
        if (synced.get(path) === json) continue;
        synced.set(path, json);
        if (path.startsWith('icons/')) iconDocs.set(path.slice(6), data);
        jobs.push(backend.set(path, data));
        writes++;
      }
      for (const path of Array.from(synced.keys())) {
        if (path in docs) continue;
        synced.delete(path);
        if (path.startsWith('icons/')) iconDocs.delete(path.slice(6)); // 包數改變或舊格式文件：刪掉
        jobs.push(backend.remove(path));
        removes++;
      }
      state.characters.forEach((c, i) => orders.set(c.id, i));
      return { writes, removes, done: Promise.all(jobs) };
    }

    /* 收到遠端文件（data 為 null 表示被刪除），合併進 state。
     * 回傳 true 表示 state 有變。 */
    function applyRemote(state, path, data) {
      const json = data == null ? null : stable(data);
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
        if (data == null) iconDocs.delete(id);
        else iconDocs.set(id, data);
        rebuildIcons(state);
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
      iconDocs.clear();
    }

    /* 雲端上還有舊格式（一個圖示一份）的文件 → 需要推一次來搬進包裡 */
    function hasLegacyIcons() {
      for (const id of iconDocs.keys()) if (!id.startsWith('pack-')) return true;
      return false;
    }

    return { push, applyRemote, reset, hasLegacyIcons, _synced: synced };
  }

  const api = { docsFromState, createSync, DIGITS_PATH, PACK_SIZE, packCount, encodeFeat, decodeFeat, stable };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ArrSync = api;
})(typeof self !== 'undefined' ? self : this);
