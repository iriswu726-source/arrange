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

  root.ArrExportScript = '(' + exporter.toString() + ')();';
})(typeof self !== 'undefined' ? self : this);
