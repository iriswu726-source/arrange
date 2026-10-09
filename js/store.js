/* 資料模型：多角色、五個背包分頁、道具增刪改與移動。
 * 純函式（不碰 DOM），瀏覽器以全域 ArrStore 使用，Node 以 require 使用（測試）。 */
(function (root) {
  'use strict';

  const TABS = [
    { id: 'equip', name: '裝備' },
    { id: 'use', name: '消耗' },
    { id: 'setup', name: '裝飾' },
    { id: 'etc', name: '其他' },
    { id: 'special', name: '特殊' },
  ];
  const TAB_IDS = TABS.map((t) => t.id);
  const STORAGE_KEY = 'artale-arrange-v1';

  // 裝備素質欄位
  const STAT_FIELDS = [
    { key: 'str', label: '力量', short: 'STR' },
    { key: 'dex', label: '敏捷', short: 'DEX' },
    { key: 'int', label: '智力', short: 'INT' },
    { key: 'luk', label: '幸運', short: 'LUK' },
    { key: 'hp', label: 'MaxHP', short: 'HP' },
    { key: 'mp', label: 'MaxMP', short: 'MP' },
    { key: 'watk', label: '攻擊力', short: '攻擊' },
    { key: 'matk', label: '魔法攻擊力', short: '魔攻' },
    { key: 'wdef', label: '物理防禦力', short: '物防' },
    { key: 'mdef', label: '魔法防禦力', short: '魔防' },
    { key: 'acc', label: '命中率', short: '命中' },
    { key: 'avoid', label: '迴避率', short: '迴避' },
    { key: 'speed', label: '移動速度', short: '移速' },
    { key: 'jump', label: '跳躍力', short: '跳躍' },
    { key: 'slots', label: '可升級次數', short: '可升級' },
  ];

  /* 只保留有效、非 0 的整數素質。 */
  function cleanStats(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const f of STAT_FIELDS) {
      const n = Math.trunc(Number(raw[f.key]));
      if (Number.isFinite(n) && n !== 0 && Math.abs(n) < 100000) out[f.key] = n;
    }
    return out;
  }

  /* 捲軸成功率：「頭盔防禦卷軸 60%」→ pct '60%'、base '頭盔防禦卷軸' */
  function pctOf(name) {
    const m = String(name || '').match(/(\d{1,3})\s*[%％]/);
    return m ? m[1] + '%' : '';
  }
  function baseOf(name) {
    return String(name || '').replace(/[\s(（]*\d{1,3}\s*[%％][)）]?/, '').replace(/\s+/g, ' ').trim();
  }

  function hasStats(stats) {
    return !!stats && Object.keys(stats).length > 0;
  }

  /* 素質摘要，例如「STR+3 攻擊+5 可升級7」。 */
  function statsSummary(stats) {
    if (!hasStats(stats)) return '';
    return STAT_FIELDS.filter((f) => stats[f.key]).map((f) => {
      const v = stats[f.key];
      return f.key === 'slots' ? f.short + v : f.short + (v > 0 ? '+' : '') + v;
    }).join(' ');
  }
  const VERSION = 1;

  let seq = 0;
  function uid(prefix) {
    seq = (seq + 1) % 1e6;
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7) + seq.toString(36);
  }

  function tabName(tabId) {
    const t = TABS.find((x) => x.id === tabId);
    return t ? t.name : tabId;
  }

  function emptyInventory() {
    const inv = {};
    for (const id of TAB_IDS) inv[id] = [];
    return inv;
  }

  function createState() {
    return { version: VERSION, characters: [], icons: [], digits: [], settings: {} };
  }

  function toQty(v, fallback) {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  function cleanName(name) {
    return String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
  }

  /* 把任意（可能是舊版或手改過的）JSON 整理成合法 state。 */
  function normalizeState(raw) {
    const state = createState();
    if (!raw || typeof raw !== 'object') return state;
    const chars = Array.isArray(raw.characters) ? raw.characters : [];
    for (const c of chars) {
      if (!c || typeof c !== 'object') continue;
      const ch = {
        id: typeof c.id === 'string' && c.id ? c.id : uid('c'),
        name: cleanName(c.name) || '未命名角色',
        job: cleanName(c.job),
        level: toQty(c.level, ''),
        inventory: emptyInventory(),
      };
      const inv = c.inventory && typeof c.inventory === 'object' ? c.inventory : {};
      for (const tab of TAB_IDS) {
        const list = Array.isArray(inv[tab]) ? inv[tab] : [];
        for (const it of list) {
          if (!it || typeof it !== 'object') continue;
          const name = cleanName(it.name);
          if (!name) continue;
          ch.inventory[tab].push({
            id: typeof it.id === 'string' && it.id ? it.id : uid('i'),
            name,
            qty: toQty(it.qty, 1),
            note: cleanName(it.note),
            iconId: typeof it.iconId === 'string' ? it.iconId : '',
            stats: cleanStats(it.stats),
          });
        }
      }
      state.characters.push(ch);
    }
    const icons = Array.isArray(raw.icons) ? raw.icons : [];
    for (const ic of icons) {
      if (!ic || typeof ic !== 'object' || !Array.isArray(ic.feat)) continue;
      const name = cleanName(ic.name);
      if (!name) continue;
      state.icons.push({
        id: typeof ic.id === 'string' && ic.id ? ic.id : uid('ic'),
        name,
        tab: TAB_IDS.includes(ic.tab) ? ic.tab : '',
        feat: ic.feat.map(Number),
        thumb: typeof ic.thumb === 'string' ? ic.thumb : '',
      });
    }
    const digits = Array.isArray(raw.digits) ? raw.digits : [];
    for (const t of digits) {
      if (t && /^[0-9]$/.test(t.d) && Array.isArray(t.feat)) state.digits.push({ d: t.d, feat: t.feat.map(Number) });
    }
    if (raw.settings && typeof raw.settings === 'object') state.settings = Object.assign({}, raw.settings);
    return state;
  }

  function loadState(storage) {
    try {
      const text = storage && storage.getItem(STORAGE_KEY);
      return text ? normalizeState(JSON.parse(text)) : createState();
    } catch (e) {
      return createState();
    }
  }

  function saveState(storage, state) {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function getCharacter(state, charId) {
    return state.characters.find((c) => c.id === charId) || null;
  }

  function addCharacter(state, name, extra) {
    const ch = {
      id: uid('c'),
      name: cleanName(name) || '角色' + (state.characters.length + 1),
      job: cleanName(extra && extra.job),
      level: toQty(extra && extra.level, ''),
      inventory: emptyInventory(),
    };
    state.characters.push(ch);
    return ch;
  }

  function updateCharacter(state, charId, patch) {
    const ch = getCharacter(state, charId);
    if (!ch) return null;
    if (patch.name !== undefined) ch.name = cleanName(patch.name) || ch.name;
    if (patch.job !== undefined) ch.job = cleanName(patch.job);
    if (patch.level !== undefined) ch.level = toQty(patch.level, '');
    return ch;
  }

  function removeCharacter(state, charId) {
    const i = state.characters.findIndex((c) => c.id === charId);
    if (i < 0) return false;
    state.characters.splice(i, 1);
    return true;
  }

  function moveCharacter(state, charId, delta) {
    const i = state.characters.findIndex((c) => c.id === charId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= state.characters.length) return false;
    const [ch] = state.characters.splice(i, 1);
    state.characters.splice(j, 0, ch);
    return true;
  }

  function getTab(state, charId, tab) {
    const ch = getCharacter(state, charId);
    if (!ch || !TAB_IDS.includes(tab)) return null;
    return ch.inventory[tab];
  }

  /* 新增道具；同名同備註預設合併數量。裝備每件素質可能不同，所以不合併。回傳該筆道具。 */
  function addItem(state, charId, tab, item, opts) {
    const list = getTab(state, charId, tab);
    if (!list) return null;
    const name = cleanName(item.name);
    if (!name) return null;
    const qty = toQty(item.qty, 1);
    const note = cleanName(item.note);
    const stats = cleanStats(item.stats);
    const merge = (!opts || opts.merge !== false) && tab !== 'equip' && !hasStats(stats);
    if (merge) {
      const same = list.find((x) => x.name === name && x.note === note && !hasStats(x.stats));
      if (same) {
        same.qty += qty;
        if (item.iconId && !same.iconId) same.iconId = item.iconId;
        return same;
      }
    }
    const it = { id: uid('i'), name, qty, note, iconId: item.iconId || '', stats };
    list.push(it);
    return it;
  }

  function findItem(state, charId, tab, itemId) {
    const list = getTab(state, charId, tab);
    return list ? list.find((x) => x.id === itemId) || null : null;
  }

  function updateItem(state, charId, tab, itemId, patch) {
    const it = findItem(state, charId, tab, itemId);
    if (!it) return null;
    if (patch.name !== undefined) it.name = cleanName(patch.name) || it.name;
    if (patch.qty !== undefined) it.qty = toQty(patch.qty, it.qty);
    if (patch.note !== undefined) it.note = cleanName(patch.note);
    if (patch.iconId !== undefined) it.iconId = patch.iconId;
    if (patch.stats !== undefined) it.stats = cleanStats(patch.stats);
    return it;
  }

  function removeItem(state, charId, tab, itemId) {
    const list = getTab(state, charId, tab);
    if (!list) return false;
    const i = list.findIndex((x) => x.id === itemId);
    if (i < 0) return false;
    list.splice(i, 1);
    return true;
  }

  /* 把道具（部分或全部數量）移到另一個角色的同一分頁。 */
  function moveItem(state, fromCharId, tab, itemId, toCharId, qty) {
    if (fromCharId === toCharId) return false;
    const it = findItem(state, fromCharId, tab, itemId);
    if (!it || !getCharacter(state, toCharId)) return false;
    const n = Math.min(toQty(qty, it.qty), it.qty);
    addItem(state, toCharId, tab, { name: it.name, qty: n, note: it.note, iconId: it.iconId, stats: it.stats });
    if (n >= it.qty) removeItem(state, fromCharId, tab, itemId);
    else it.qty -= n;
    return true;
  }

  /* 掃圖結果寫入：mode = 'replace'（整個分頁換掉）或 'merge'（加總）。
   * 取代時，同名道具沿用原本輸入的素質與備註（重新掃描裝備欄不會弄丟素質）。 */
  function applyItems(state, charId, tab, items, mode) {
    const list = getTab(state, charId, tab);
    if (!list) return 0;
    const old = mode === 'replace' ? list.splice(0) : [];
    let n = 0;
    for (const item of items) {
      const i = old.findIndex((o) => o.name === cleanName(item.name));
      const prev = i >= 0 ? old.splice(i, 1)[0] : null;
      const merged = prev && !hasStats(item.stats) && !item.note ? Object.assign({}, item, { stats: prev.stats, note: prev.note }) : item;
      const it = addItem(state, charId, tab, merged);
      if (it && prev && tab === 'equip') it.id = prev.id; // 裝備沿用原本的 id
      if (it) n++;
    }
    return n;
  }

  function sortTab(state, charId, tab, by) {
    const list = getTab(state, charId, tab);
    if (!list) return;
    if (by === 'qty') list.sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name, 'zh-Hant'));
    else list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant') || a.note.localeCompare(b.note, 'zh-Hant'));
  }

  /* 圖示庫：同名同分頁的特徵會更新而不是重複新增。 */
  function learnIcon(state, entry) {
    const name = cleanName(entry.name);
    if (!name || !Array.isArray(entry.feat)) return null;
    const tab = TAB_IDS.includes(entry.tab) ? entry.tab : '';
    const existing = entry.id && state.icons.find((x) => x.id === entry.id);
    if (existing) {
      existing.name = name;
      existing.tab = tab;
      existing.feat = entry.feat.slice();
      if (entry.thumb) existing.thumb = entry.thumb;
      return existing;
    }
    const ic = { id: uid('ic'), name, tab, feat: entry.feat.slice(), thumb: entry.thumb || '' };
    state.icons.push(ic);
    return ic;
  }

  function removeIcon(state, iconId) {
    const i = state.icons.findIndex((x) => x.id === iconId);
    if (i < 0) return false;
    state.icons.splice(i, 1);
    for (const ch of state.characters)
      for (const tab of TAB_IDS) for (const it of ch.inventory[tab]) if (it.iconId === iconId) it.iconId = '';
    return true;
  }

  function iconById(state, iconId) {
    return (iconId && state.icons.find((x) => x.id === iconId)) || null;
  }

  /* 依名稱找圖示（顯示縮圖用）。 */
  function iconForName(state, name, tab) {
    return (
      state.icons.find((x) => x.name === name && (!tab || !x.tab || x.tab === tab)) ||
      null
    );
  }

  /* 所有出現過的道具名稱（給輸入自動完成）。 */
  function knownNames(state, tab) {
    const set = new Set();
    for (const ic of state.icons) if (!tab || !ic.tab || ic.tab === tab) set.add(ic.name);
    for (const ch of state.characters)
      for (const t of TAB_IDS) if (!tab || t === tab) for (const it of ch.inventory[t]) set.add(it.name);
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  }

  const api = {
    TABS, TAB_IDS, STORAGE_KEY, VERSION,
    STAT_FIELDS, cleanStats, hasStats, statsSummary, pctOf, baseOf,
    uid, tabName, createState, normalizeState, loadState, saveState,
    getCharacter, addCharacter, updateCharacter, removeCharacter, moveCharacter,
    getTab, addItem, findItem, updateItem, removeItem, moveItem, applyItems, sortTab,
    learnIcon, removeIcon, iconById, iconForName, knownNames,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ArrStore = api;
})(typeof self !== 'undefined' ? self : this);
