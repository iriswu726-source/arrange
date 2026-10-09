/* 跨角色搜尋與彙總。純函式，瀏覽器以全域 ArrSearch 使用。 */
(function (root) {
  'use strict';

  const TAB_IDS = ['equip', 'use', 'setup', 'etc', 'special'];

  // 常見異體／簡繁字，讓「药水」也能找到「藥水」。
  const SIMP = '药剑轴书头装备饰项链鏈环风枪红蓝绿黄银铁钢矿宝灵龙凤兽鱼鸟猫猪蜗叶树电圣强击运气万疗伤复镖飞裤镜脸门传华块张个级册纸体质经验么后发双单长轻时';
  const TRAD = '藥劍軸書頭裝備飾項鍊鍊環風槍紅藍綠黃銀鐵鋼礦寶靈龍鳳獸魚鳥貓豬蝸葉樹電聖強擊運氣萬療傷復鏢飛褲鏡臉門傳華塊張個級冊紙體質經驗麼後髮雙單長輕時';
  const VARIANTS = {};
  for (let i = 0; i < SIMP.length; i++) VARIANTS[SIMP[i]] = TRAD[i];

  function normalize(s) {
    let out = '';
    for (const ch of String(s == null ? '' : s).toLowerCase()) {
      if (/\s/.test(ch)) continue;
      // 全形英數轉半形
      const code = ch.charCodeAt(0);
      const half = code >= 0xff01 && code <= 0xff5e ? String.fromCharCode(code - 0xfee0) : ch;
      out += VARIANTS[half] || half;
    }
    return out;
  }

  // 素質也能搜尋（例如「攻擊」「STR」）
  const Store = typeof module !== 'undefined' && module.exports ? require('./store.js') : root.ArrStore;
  function statsText(stats) {
    return Store && Store.statsSummary ? Store.statsSummary(stats) : '';
  }

  function tokens(query) {
    return String(query == null ? '' : query)
      .split(/[\s,，、]+/)
      .map(normalize)
      .filter(Boolean);
  }

  /* 依關鍵字搜尋所有角色。
   * opts: { tabs: [...] 限定分頁, charIds: [...] 限定角色 }
   * 回傳依道具名稱分組：[{ name, total, entries: [{charId, charName, tab, itemId, qty, note}] }] */
  function search(state, query, opts) {
    const toks = tokens(query);
    const tabs = opts && opts.tabs && opts.tabs.length ? opts.tabs : TAB_IDS;
    const charIds = opts && opts.charIds && opts.charIds.length ? new Set(opts.charIds) : null;
    const groups = new Map();
    for (const ch of state.characters) {
      if (charIds && !charIds.has(ch.id)) continue;
      for (const tab of tabs) {
        for (const it of ch.inventory[tab] || []) {
          const hay = normalize(it.name + ' ' + it.note + ' ' + statsText(it.stats));
          if (!toks.every((t) => hay.includes(t))) continue;
          const key = tab + '\u0000' + it.name;
          let g = groups.get(key);
          if (!g) {
            g = { name: it.name, tab, total: 0, entries: [] };
            groups.set(key, g);
          }
          g.total += it.qty;
          g.entries.push({ charId: ch.id, charName: ch.name, tab, itemId: it.id, qty: it.qty, note: it.note, stats: it.stats || {} });
        }
      }
    }
    const list = Array.from(groups.values());
    const first = toks[0] || '';
    // 名稱完全相符、開頭相符的排前面，其次依總數
    const rank = (g) => {
      const n = normalize(g.name);
      if (first && n === first) return 0;
      if (first && n.startsWith(first)) return 1;
      return 2;
    };
    list.sort((a, b) => rank(a) - rank(b) || b.total - a.total || a.name.localeCompare(b.name, 'zh-Hant'));
    return list;
  }

  /* 各角色各分頁的格數統計。 */
  function stats(state) {
    return state.characters.map((ch) => {
      const per = {};
      let items = 0;
      for (const tab of TAB_IDS) {
        per[tab] = (ch.inventory[tab] || []).length;
        items += per[tab];
      }
      return { charId: ch.id, charName: ch.name, per, items };
    });
  }

  /* 找出分散在多個角色的同名道具（整理建議）。 */
  function duplicates(state) {
    return search(state, '').filter((g) => new Set(g.entries.map((e) => e.charId)).size > 1);
  }

  const api = { normalize, tokens, search, stats, duplicates };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ArrSearch = api;
})(typeof self !== 'undefined' ? self : this);
