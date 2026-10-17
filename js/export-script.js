/* 「道具圖鑑」匯出程式：在 artalemaplestory.com 的列表頁（例如 /zh/equipment）打開 F12 → Console 執行。
 * 會讀取畫面上的道具並自動點「下一頁」翻完所有頁面，收集道具名稱、分類與圖片，下載成 artale-catalog-*.json，
 * 再到本工具「圖示庫 → 匯入道具圖鑑」匯入。
 * 這個函式不會在本工具裡執行，只會被轉成文字讓使用者複製（window.ArrExportScript）。 */
(function (root) {
  'use strict';

  function exporter() {
    (async () => {
      const CJK = /[㐀-鿿]/;
      const m0 = location.pathname.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?([^/]+)/i);
      const section = m0 ? m0[1] : '';
      if (!section) { console.log('請先打開道具列表頁，例如 https://www.artalemaplestory.com/zh/equipment'); return; }
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const pattern = /\/images\/([^/]+)\/(?:([^/]+)\/)?([^/?#]+)\.(webp|png|gif|jpe?g)(?:[?#]|$)/i;
      // 圖片的分類（/images/<分類>/...）通常和網址一樣；對不上時用頁面上最多的那個
      const imgSection = (() => {
        const count = {};
        for (const i of document.querySelectorAll('img')) { const m = (i.currentSrc || i.src).match(pattern); if (m) count[m[1]] = (count[m[1]] || 0) + 1; }
        if (count[section]) return section;
        return Object.keys(count).sort((a, b) => count[b] - count[a])[0] || section;
      })();
      const itemImgs = () => [...document.querySelectorAll('img')].filter((i) => { const m = (i.currentSrc || i.src).match(pattern); return m && m[1] === imgSection; });
      const pageButtons = () => [...document.querySelectorAll('button, a')].filter((b) => /^\d+$/.test(b.textContent.trim()));
      const last = Math.max(1, ...pageButtons().map((b) => Number(b.textContent.trim())).filter((n) => n < 500));

      // 道具名稱：圖片附近第一段中文；找不到就用英文名稱。
      // 捲軸的成功率（10%、60%…）如果不在名稱裡，從英文名稱或同一列文字補上。
      const PCT = /(\d{1,3})\s*[%％]/;
      const LABELS = /^(任務道具|掉落物|材料|礦石|寶石|其他|未分類|消耗|裝備|裝飾|特殊|道具)$/;
      const nameNear = (img) => {
        let el = img;
        for (let d = 0; d < 6 && el.parentElement; d++) {
          el = el.parentElement;
          const t = el.textContent || '';
          if (t.length > 400) break;
          if (!CJK.test(t)) continue;
          const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let n;
          while ((n = w.nextNode())) {
            let s = n.nodeValue.replace(/\s+/g, ' ').trim();
            if (!CJK.test(s) || LABELS.test(s)) continue; // 跳過「任務道具」「掉落物」這類分類標籤
            const pct = (img.getAttribute('alt') || '').match(PCT) || t.match(PCT);
            if (pct && !PCT.test(s)) s += ' ' + pct[1] + '%';
            return s;
          }
        }
        return '';
      };

      const items = new Map();
      // 同一張圖可能是好幾個道具（例如所有 60% 捲軸都用 60.webp），所以用「圖片＋名稱」區分
      const collect = () => {
        for (const img of itemImgs()) {
          const src = img.src;
          const m = src.match(pattern);
          const nameEn = img.getAttribute('alt') || '';
          const name = nameNear(img) || nameEn || m[3];
          const key = src + '|' + name;
          if (items.has(key)) continue;
          items.set(key, {
            id: m[1] + '/' + (m[2] || '') + '/' + m[3] + '#' + (nameEn || name), section: m[1], category: m[2] || '',
            nameEn, name, src,
          });
        }
      };
      const signature = () => itemImgs().map((i) => i.src + '|' + nameNear(i)).join('\n');
      const findNext = (p) =>
        pageButtons().find((b) => b.textContent.trim() === String(p) && !b.disabled) ||
        [...document.querySelectorAll('button, a')].find((b) => !b.disabled && /next|下一/i.test((b.getAttribute('aria-label') || '') + ' ' + b.textContent));

      console.log(`開始匯出「${imgSection}」，共 ${last} 頁（會自動點換頁，請不要操作這個網頁）…`);
      collect();
      console.log(`第 1/${last} 頁完成，累計 ${items.size} 個`);
      for (let p = 2; p <= last; p++) {
        const btn = findNext(p);
        if (!btn) { console.log(`找不到第 ${p} 頁的按鈕，停在這裡`); break; }
        const before = signature();
        btn.click();
        const t0 = Date.now();
        while (signature() === before && Date.now() - t0 < 20000) await sleep(200);
        if (signature() === before) { console.log(`第 ${p} 頁沒有載入，停在這裡`); break; }
        await sleep(600); // 等畫面完整更新
        collect();
        console.log(`第 ${p}/${last} 頁完成，累計 ${items.size} 個`);
      }

      const list = [...items.values()];
      // 同一張圖只下載一次
      const srcs = [...new Set(list.map((x) => x.src))];
      console.log(`收集到 ${list.length} 個道具（${srcs.length} 張不同圖片），下載圖片中…`);
      const toDataUrl = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
      const imgOf = new Map();
      let done = 0, failed = 0;
      const queue = srcs.slice();
      await Promise.all([0, 1, 2, 3].map(async () => {
        while (queue.length) {
          const src = queue.shift();
          try {
            imgOf.set(src, await toDataUrl(await (await fetch(src)).blob()));
          } catch (e) {
            failed++;
          }
          if (++done % 100 === 0) console.log(`圖片 ${done}/${srcs.length}`);
        }
      }));
      for (const it of list) it.img = imgOf.get(it.src);

      const out = { format: 'artale-catalog', version: 1, source: location.origin + location.pathname, exportedAt: new Date().toISOString(), items: list.filter((x) => x.img) };
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: 'application/json' }));
      a.download = `artale-catalog-${imgSection}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      console.log(`完成！共 ${out.items.length} 個道具${failed ? `（${failed} 張圖片下載失敗）` : ''}，檔案已下載：${a.download}`);
      console.log('前 10 個（請確認名稱是中文且正確）：\n' + out.items.slice(0, 10).map((x) => `${x.name} | ${x.nameEn} | ${x.category}`).join('\n'));
    })();
  }

  /* 「補漏」程式：網站的列表頁沒有列出所有道具（例如 /zh/equipment/overall/blue-dragon-armor）。
   * 在網站任何一頁的 Console 執行：從 sitemap、列表頁、分類頁和每個道具頁上的連結，
   * 找出裝備 / 消耗 / 捲軸 / 其他的所有道具頁，把圖鑑裡還沒有的存成圖鑑檔；
   * 裝備另外讀需求等級，列出等級 ≥ MIN 的裝備（存成 CSV）。
   * KNOWN = 圖鑑裡已有的 id（<分類>/<子分類>/<代號>），NAMES = 圖鑑裡已有的名稱（捲軸共用圖片，只能用名稱比對）。 */
  function itemScan(KNOWN, NAMES, MIN) {
    (async () => {
      const ORIGIN = location.origin;
      if (!/artalemaplestory/.test(location.host)) { console.log('請在 https://www.artalemaplestory.com 的網頁上執行'); return; }
      const SECTIONS = ['equipment', 'useable', 'scrolls', 'misc'];
      const SEC = SECTIONS.join('|');
      const known = new Set(KNOWN);
      const norm = (t) => String(t || '').replace(/\s+/g, '').replace(/[xX×]\d+$/, '');
      const knownNames = new Set(NAMES.map(norm));
      const CJK = /[㐀-鿿]/;
      const LVSUF = /\s*[（(]\s*LV\.?\s*\d+\s*[)）]\s*$/i;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const DETAIL = new RegExp('^/(?:[a-z]{2}(?:-[a-z]{2})?/)?(' + SEC + ')/([a-z0-9-]+)(?:/([^/?#]+))?/?$', 'i');
      const IMG = new RegExp('/images/(' + SEC + ')/(?:([a-z0-9-]+)/)?([^/?#."\'\\\\]+)\\.(?:webp|png|gif|jpe?g)', 'gi');
      const pages = new Map(); // key 'sec/cat/slug' → { sec, cat, slug }
      const cats = {}; // sec → Set(子分類)
      SECTIONS.forEach((x) => { cats[x] = new Set(); });
      const keyOf = (sec, cat, slug) => sec + '/' + (cat || '') + '/' + slug;
      const add = (sec, cat, slug) => {
        sec = sec.toLowerCase();
        if (!slug || /^\d+$/.test(slug) || /^(page|list|grid)$/i.test(slug)) return false;
        try { slug = decodeURIComponent(slug); } catch (e) { /* 原樣 */ }
        if (cat) cats[sec].add(cat);
        const k = keyOf(sec, cat, slug);
        if (pages.has(k)) return false;
        pages.set(k, { sec, cat: cat || '', slug });
        return true;
      };
      // /zh/misc/xxx 可能是分類頁也可能是道具頁：xxx 是已知的分類就當分類頁
      const fromPath = (path) => {
        const d = path.match(DETAIL);
        if (!d) return false;
        if (d[3]) return add(d[1], d[2], d[3]);
        if (cats[d[1].toLowerCase()].has(d[2])) return false;
        return add(d[1], '', d[2]);
      };
      const linksIn = (html, listed) => {
        let n = 0;
        for (const m of html.matchAll(/href=\\?["']([^"'\\]+)\\?["']/g)) {
          try {
            const u = new URL(m[1], ORIGIN);
            if (u.host !== location.host) continue;
            const d = u.pathname.match(DETAIL);
            if (d && listed) listed.add(d[3] ? keyOf(d[1].toLowerCase(), d[2], d[3]) : keyOf(d[1].toLowerCase(), '', d[2]));
            if (fromPath(u.pathname)) n++;
          } catch (e) { /* 略過 */ }
        }
        for (const m of html.matchAll(IMG)) {
          if (listed && !/^\d+$/.test(m[3])) listed.add(keyOf(m[1].toLowerCase(), m[2], m[3]));
          if (add(m[1], m[2], m[3])) n++;
        }
        return n;
      };
      async function get(url, tries = 3) {
        for (let t = 0; t < tries; t++) {
          try {
            const r = await fetch(url, { credentials: 'same-origin' });
            if (r.status === 429 || r.status >= 500) { await sleep(1500 * (t + 1)); continue; }
            if (!r.ok) return null;
            return await r.text();
          } catch (e) { await sleep(1000 * (t + 1)); }
        }
        return null;
      }
      const pathOf = (pg) => `/zh/${pg.sec}/${pg.cat ? pg.cat + '/' : ''}${pg.slug}`;

      for (const id of known) { const p = id.split('/'); if (SECTIONS.includes(p[0]) && p.length >= 3 && p[2]) add(p[0], p[1], p.slice(2).join('/')); }

      // 1) sitemap
      console.log('尋找道具頁（sitemap）…');
      const maps = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/zh/sitemap.xml', '/sitemap-0.xml'];
      const robots = await get('/robots.txt', 1);
      if (robots) for (const m of robots.matchAll(/sitemap:\s*(\S+)/gi)) maps.unshift(m[1]);
      const seenMap = new Set();
      const sitemapPaths = [];
      while (maps.length && seenMap.size < 60) {
        const u = maps.shift();
        if (seenMap.has(u)) continue;
        seenMap.add(u);
        const xml = await get(u, 1);
        if (!xml || !/<(urlset|sitemapindex)/i.test(xml)) continue;
        for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
          const loc = m[1].replace(/&amp;/g, '&');
          if (/\.xml(\?|$)/i.test(loc)) { maps.push(loc); continue; }
          try { sitemapPaths.push(new URL(loc).pathname); } catch (e) { /* 略過 */ }
        }
      }

      // 2) 各分類的列表頁（每頁 100 個）與子分類頁
      const listed = new Set();
      for (const sec of SECTIONS) {
        console.log(`讀取「${sec}」列表頁…`);
        for (let p = 1; p <= 60; p++) {
          const html = await get(`/zh/${sec}?viewMode=list&pageSize=100&page=${p}`, 2);
          if (!html || (linksIn(html, listed) === 0 && p > 1)) break;
        }
      }
      // 子分類要先知道，sitemap 裡 /zh/misc/xxx 才分得出是分類頁還是道具頁
      for (const path of sitemapPaths) { const d = path.match(DETAIL); if (d && d[3]) cats[d[1].toLowerCase()].add(d[2]); }
      for (const path of sitemapPaths) fromPath(path);
      for (const sec of SECTIONS) {
        for (const c of [...cats[sec]]) {
          for (let p = 1; p <= 20; p++) {
            const html = await get(`/zh/${sec}/${c}?viewMode=list&pageSize=100&page=${p}`, 2);
            if (!html || linksIn(html) === 0) break;
          }
        }
      }
      // 列表頁 / 分類頁的網址被當成道具頁的拿掉
      for (const [k, pg] of [...pages]) if (!pg.cat && cats[pg.sec].has(pg.slug)) pages.delete(k);
      if (!known.size) for (const k of listed) known.add(k); // 沒給圖鑑清單時：列表上看得到的就算「圖鑑裡有」
      const count = (sec) => [...pages.values()].filter((pg) => pg.sec === sec).length;
      console.log('目前找到的道具頁：' + SECTIONS.map((x) => `${x} ${count(x)}`).join('、'));

      // 3) 讀每個道具頁（裝備要讀等級）；頁面上的其他道具連結也加進來
      const LABEL = /(?:需求等級|等級需求|要求等級|需要等級|所需等級|裝備等級|REQ\.?\s*LEV(?:EL)?|Required\s*Level|Req\.?\s*Level)\s*[:：]?\s*(?:Lv\.?\s*)?(\d{1,3})/i;
      const KEY = /\\?"(?:reqLevel|requiredLevel|req_level|levelRequirement|levelReq|reqLev|requireLevel|minLevel)\\?"\s*:\s*\\?"?(\d{1,3})/i;
      const KEY2 = /\\?"(?:level|lv)\\?"\s*:\s*\\?"?(\d{1,3})/i;
      const LOOSE = /(?:等級|Lv\.?|LV)\s*[:：]?\s*(\d{1,3})/;
      const parse = (html, pg) => {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        doc.querySelectorAll('script, style, noscript').forEach((e) => e.remove());
        const text = (doc.body ? doc.body.textContent : '').replace(/\s+/g, ' ');
        let level = null;
        if (pg.sec === 'equipment') {
          for (const [re, src] of [[LABEL, text], [KEY, html], [KEY2, html], [LOOSE, text]]) {
            const m = src.match(re);
            if (m) { level = Number(m[1]); break; }
          }
        }
        const og = ((doc.querySelector('meta[property="og:title"]') || {}).content || doc.title || '').split(/\s[|｜–-]\s/)[0].trim();
        const h1 = [...doc.querySelectorAll('h1, h2')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()).find((t) => CJK.test(t) && t.length <= 40 && !/ARTALE|楓之谷|圖鑑/i.test(t));
        const name = (h1 || og || pg.slug).replace(LVSUF, '');
        const imgs = [...doc.querySelectorAll('img')];
        const own = imgs.find((i) => (i.getAttribute('src') || '').includes(`/${pg.slug}.`) && (i.getAttribute('src') || '').includes(`/images/${pg.sec}/`)) ||
          imgs.find((i) => (i.getAttribute('src') || '').includes(`/images/${pg.sec}/`));
        const src = own ? new URL(own.getAttribute('src'), ORIGIN).href : `${ORIGIN}/images/${pg.sec}/${pg.cat ? pg.cat + '/' : ''}${pg.slug}.webp`;
        const nameEn = ((own && own.getAttribute('alt')) || pg.slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())).replace(LVSUF, '');
        return { level, name, nameEn, img: src };
      };

      const results = [];
      const queue = [...pages.keys()];
      const done = new Set();
      let n = 0;
      const failed = [];
      console.log(`開始讀取 ${queue.length} 個道具頁（約需 10～20 分鐘，請不要關閉這個分頁）…`);
      await Promise.all([0, 1, 2, 3, 4, 5].map(async () => {
        while (queue.length) {
          const k = queue.shift();
          if (done.has(k) || !pages.has(k)) continue;
          done.add(k);
          const pg = pages.get(k);
          if (!pg.cat && cats[pg.sec].has(pg.slug)) continue; // 其實是分類頁
          const html = await get(pathOf(pg));
          if (!html) { failed.push(ORIGIN + pathOf(pg)); continue; }
          const before = new Set(pages.keys());
          linksIn(html);
          for (const kk of pages.keys()) if (!before.has(kk)) queue.push(kk);
          if (!pg.cat && cats[pg.sec].has(pg.slug)) continue; // 讀了才知道是分類頁（裡面有道具連結）
          const r = parse(html, pg);
          results.push(Object.assign({ key: k, sec: pg.sec, cat: pg.cat, slug: pg.slug, url: ORIGIN + pathOf(pg) }, r));
          if (++n % 100 === 0) console.log(`已讀 ${n} 頁，還有 ${queue.length} 頁`);
        }
      }));
      const inCat = (r) => known.has(r.key) || knownNames.has(norm(r.name));
      const missing = results.filter((r) => !inCat(r));
      const equip = results.filter((r) => r.sec === 'equipment');
      const noLevel = equip.filter((r) => r.level == null);
      const high = equip.filter((r) => r.level != null && r.level >= MIN).sort((a, b) => a.level - b.level || a.cat.localeCompare(b.cat) || a.name.localeCompare(b.name));
      console.log(`讀完 ${results.length} 頁${failed.length ? `（${failed.length} 頁讀取失敗）` : ''}；圖鑑裡沒有的：` + SECTIONS.map((x) => `${x} ${missing.filter((r) => r.sec === x).length}`).join('、'));

      const download = (data, name, type) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([data], { type }));
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
      };
      if (high.length) {
        console.log(`裝備等級 ${MIN} 以上：${high.length} 個`);
        console.table(high.map((r) => ({ 等級: r.level, 名稱: r.name, 英文: r.nameEn, 分類: r.cat, 圖鑑: inCat(r) ? '有' : '★沒有' })));
        const cell = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
        const csv = [['等級', '名稱', '英文名稱', '分類', '圖鑑裡有沒有', '網址']]
          .concat(high.map((r) => [r.level, r.name, r.nameEn, r.cat, inCat(r) ? '有' : '沒有', r.url]))
          .map((row) => row.map(cell).join(',')).join('\r\n');
        download('﻿' + csv, `artale-equipment-lv${MIN}.csv`, 'text/csv');
      }

      if (missing.length) {
        console.log(`下載 ${missing.length} 個漏掉的道具圖片…`);
        const toDataUrl = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
        const imgOf = new Map();
        const q = [...new Set(missing.map((r) => r.img))];
        await Promise.all([0, 1, 2, 3].map(async () => {
          while (q.length) {
            const src = q.shift();
            try { const res = await fetch(src); if (res.ok) imgOf.set(src, await toDataUrl(await res.blob())); } catch (e) { /* 略過 */ }
          }
        }));
        const items = missing.filter((r) => /^data:image\//.test(imgOf.get(r.img) || ''))
          .map((r) => ({ id: r.key + '#' + r.nameEn, section: r.sec, category: r.cat, nameEn: r.nameEn, name: r.name, src: r.img, img: imgOf.get(r.img), level: r.level }));
        download(JSON.stringify({ format: 'artale-catalog', version: 1, source: ORIGIN, exportedAt: new Date().toISOString(), items }), 'artale-catalog-missing.json', 'application/json');
        console.log('漏掉的道具：\n' + missing.map((r) => `[${r.sec}] ${r.name} | ${r.nameEn}${r.level != null ? ' | Lv' + r.level : ''}`).join('\n'));
        console.log(`漏掉的道具已存成 artale-catalog-missing.json（${items.length} 個），到本工具「圖示庫 → 匯入道具圖鑑」匯入即可`);
      } else {
        console.log('圖鑑沒有漏掉的道具');
      }
      if (noLevel.length) console.log('讀不到等級的裝備（前 20 個）：\n' + noLevel.slice(0, 20).map((r) => `${r.name} | ${r.url}`).join('\n'));
      if (failed.length) console.log('讀取失敗的網址（前 20 個）：\n' + failed.slice(0, 20).join('\n'));
      console.log('完成！');
    })();
  }

  root.ArrExportScript = '(' + exporter.toString() + ')();';
  root.ArrItemScanScript = (knownIds, knownNames, min) =>
    '(' + itemScan.toString() + ')(' + JSON.stringify(knownIds || []) + ', ' + JSON.stringify(knownNames || []) + ', ' + (Number(min) || 100) + ');';
})(typeof self !== 'undefined' ? self : this);
