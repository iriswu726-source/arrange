/* 「道具圖鑑」匯出程式：在 artalemaplestory.com 的列表頁（例如 /zh/equipment）打開 F12 → Console 執行。
 * 會自動翻完所有頁面，收集道具名稱、分類與圖片，下載成 artale-catalog-*.json，
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
      const base = location.origin + location.pathname;
      const pageNums = [...document.querySelectorAll('button, a')].map((b) => Number(b.textContent.trim())).filter((n) => Number.isInteger(n) && n > 0 && n < 500);
      const last = Math.max(1, ...pageNums);
      console.log(`開始匯出「${section}」，共 ${last} 頁…`);

      // 圖片附近第一段中文就是道具名稱；找不到就用英文名稱
      const nameNear = (img, doc) => {
        let el = img;
        for (let d = 0; d < 6 && el.parentElement; d++) {
          el = el.parentElement;
          const t = el.textContent || '';
          if (t.length > 400) break;
          if (!CJK.test(t)) continue;
          const w = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let n;
          while ((n = w.nextNode())) {
            const s = n.nodeValue.replace(/\s+/g, ' ').trim();
            if (CJK.test(s)) return s;
          }
        }
        return '';
      };

      const items = new Map();
      for (let p = 1; p <= last; p++) {
        const url = new URL(base);
        new URLSearchParams(location.search).forEach((v, k) => url.searchParams.set(k, v));
        url.searchParams.set('viewMode', 'list');
        url.searchParams.set('pageSize', '100');
        url.searchParams.set('page', String(p));
        const html = await (await fetch(url)).text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        for (const img of doc.querySelectorAll('img')) {
          const src = new URL(img.getAttribute('src') || '', location.origin).href;
          const m = src.match(/\/images\/([^/]+)\/(?:([^/]+)\/)?([^/]+)\.(webp|png|gif|jpe?g)$/i);
          if (!m || m[1] !== section || items.has(src)) continue;
          items.set(src, {
            id: m[1] + '/' + (m[2] || '') + '/' + m[3],
            section: m[1],
            category: m[2] || '',
            nameEn: img.getAttribute('alt') || '',
            name: nameNear(img, doc) || img.getAttribute('alt') || m[3],
            src,
          });
        }
        console.log(`第 ${p}/${last} 頁完成，累計 ${items.size} 個`);
        await new Promise((r) => setTimeout(r, 300));
      }

      const list = [...items.values()];
      console.log('下載圖片中…');
      const toDataUrl = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
      let done = 0, failed = 0;
      const queue = list.slice();
      await Promise.all([0, 1, 2, 3].map(async () => {
        while (queue.length) {
          const it = queue.shift();
          try {
            it.img = await toDataUrl(await (await fetch(it.src)).blob());
          } catch (e) {
            failed++;
          }
          if (++done % 100 === 0) console.log(`圖片 ${done}/${list.length}`);
        }
      }));

      const out = { format: 'artale-catalog', version: 1, source: base, exportedAt: new Date().toISOString(), items: list.filter((x) => x.img) };
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: 'application/json' }));
      a.download = `artale-catalog-${section}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      console.log(`完成！共 ${out.items.length} 個道具${failed ? `（${failed} 張圖片下載失敗）` : ''}，檔案已下載：${a.download}`);
      console.log('前 10 個（請確認名稱是中文且正確）：\n' + out.items.slice(0, 10).map((x) => `${x.name} | ${x.nameEn} | ${x.category}`).join('\n'));
    })();
  }

  root.ArrExportScript = '(' + exporter.toString() + ')();';
})(typeof self !== 'undefined' ? self : this);
