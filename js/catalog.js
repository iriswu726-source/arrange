/* 道具圖鑑：從網站匯出的名稱與圖片，存在這台電腦瀏覽器的 IndexedDB（容量大、不佔雲端額度）。 */
(function (root) {
  'use strict';

  const DB_NAME = 'artale-arrange';
  const STORE = 'catalog';
  // 網站分類 → 背包分頁；沒對到的不限分頁
  // 網站歸在裝備、但遊戲裡放在消耗欄的分類
  const CATEGORY_TAB = { arrow: 'use', arrows: 'use', 'throwing-star': 'use', 'throwing-stars': 'use', bullet: 'use', bullets: 'use', scroll: 'use', scrolls: 'use' };
  const SECTION_TAB = { equipment: 'equip', useable: 'use', usable: 'use', useables: 'use', consumables: 'use', consumable: 'use', use: 'use', potions: 'use', potion: 'use', scroll: 'use', scrolls: 'use', setup: 'setup', 'set-up': 'setup', chairs: 'setup', etc: 'etc', materials: 'etc', cash: 'special' };

  function openDb() {
    return new Promise((resolve, reject) => {
      if (!root.indexedDB) { reject(new Error('這個瀏覽器不支援 IndexedDB')); return; }
      const req = root.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx(db, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('寫入中斷（空間不足？）'));
    });
  }

  async function load() {
    const db = await openDb();
    const items = await tx(db, 'readonly', (s) => s.getAll());
    db.close();
    return items || [];
  }

  function decode(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const cv = document.createElement('canvas');
        cv.width = img.naturalWidth;
        cv.height = img.naturalHeight;
        const g = cv.getContext('2d');
        g.drawImage(img, 0, 0);
        resolve(g.getImageData(0, 0, cv.width, cv.height));
      };
      img.onerror = () => reject(new Error('圖片無法解碼'));
      img.src = dataUrl;
    });
  }

  /* 同一道具的數量版本（例如「錢袋 x1」「錢袋 x2」…）只留第一個，名稱去掉 xN。 */
  const MULTI = /\s*[（(]?\s*[xX×＊*]\s*\d+\s*[)）]?\s*$/;
  function collapseMultiples(items) {
    const seen = new Set();
    const out = [];
    for (const it of items) {
      if (!it || !it.name) { out.push(it); continue; }
      const name = MULTI.test(it.name) ? String(it.name).replace(MULTI, '').trim() : it.name;
      if (!name) { out.push(it); continue; }
      if (name !== it.name) {
        if (seen.has(name)) continue;
        seen.add(name);
        out.push(Object.assign({}, it, { name, nameEn: String(it.nameEn || '').replace(MULTI, '').trim() }));
      } else {
        out.push(it); // 同名但圖不同的道具（例如好幾種楓葉披風）照樣保留
      }
    }
    return out;
  }

  /* 匯入匯出程式產生的 JSON；回傳 { added, skipped }。 */
  async function importData(json, onProgress) {
    if (!json || json.format !== 'artale-catalog' || !Array.isArray(json.items)) throw new Error('不是道具圖鑑檔案');
    const SC = root.ArrScanner;
    const rows = [];
    let skipped = 0;
    // 遊戲裡有 15%、65% 捲軸（有白色楓葉），圖鑑網站沒有：照 10%、60% 的捲軸各補一份
    const extra = [];
    const names = new Set(json.items.map((it) => it && it.name));
    if (root.ArrScrollIcons) {
      for (const it of json.items) {
        if (!it || !/卷軸|scroll/i.test(it.name + ' ' + (it.nameEn || '') + ' ' + (it.section || ''))) continue;
        const m = String(it.name).match(/^(.*?)\s*(10|60)\s*[%％]\s*$/);
        if (!m) continue;
        const pct = m[2] === '10' ? '15' : '65';
        const name = m[1] + pct + '%';
        if (names.has(name)) continue;
        names.add(name);
        extra.push(Object.assign({}, it, { id: it.id + '#' + pct + '%', name, nameEn: String(it.nameEn || '').replace(/\d{1,3}\s*%/, pct + '%'), img: root.ArrScrollIcons[pct], generated: true }));
      }
    }
    json = Object.assign({}, json, { items: collapseMultiples(json.items.concat(extra)) });
    for (let i = 0; i < json.items.length; i++) {
      const it = json.items[i];
      if (!it || !it.id || !it.name || typeof it.img !== 'string' || !it.img.startsWith('data:image/')) { skipped++; continue; }
      // 15%、65% 捲軸：網站沿用 10%、60% 的圖，換成遊戲裡有楓葉的圖示
      const pct = /卷軸|scroll/i.test(it.name + ' ' + it.nameEn + ' ' + it.section) && (String(it.name).match(/(\d{1,3})\s*[%％]/) || [])[1];
      if (pct && root.ArrScrollIcons && root.ArrScrollIcons[pct]) it.img = root.ArrScrollIcons[pct];
      try {
        const shape = SC.iconImageShape(await decode(it.img));
        if (!shape) { skipped++; continue; }
        rows.push({
          id: String(it.id), name: String(it.name).trim(), nameEn: String(it.nameEn || ''),
          section: String(it.section || ''), category: String(it.category || ''),
          tab: CATEGORY_TAB[it.category] || SECTION_TAB[it.section] || '', img: it.img, shape,
        });
      } catch (e) {
        skipped++;
      }
      if (onProgress && i % 50 === 0) onProgress(i / json.items.length);
    }
    const db = await openDb();
    await tx(db, 'readwrite', (s) => { for (const r of rows) s.put(r); });
    db.close();
    return { added: rows.length, skipped };
  }

  async function clear() {
    const db = await openDb();
    await tx(db, 'readwrite', (s) => s.clear());
    db.close();
  }

  const api = { load, importData, clear, collapseMultiples, SECTION_TAB, CATEGORY_TAB };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ArrCatalog = api;
})(typeof self !== 'undefined' ? self : this);
