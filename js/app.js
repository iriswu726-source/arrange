/* 介面：角色列表、背包分頁、搜尋 / 總覽、掃圖、圖示庫。 */
(function () {
  'use strict';

  const S = window.ArrStore;
  const Q = window.ArrSearch;
  const SC = window.ArrScanner;
  const Y = window.ArrSync;
  const C = window.ArrCloud;
  const CLOUD_KEY = 'artale-arrange-cloud';
  const CAT = window.ArrCatalog;
  const CAT_AUTO = 0.1; // 圖鑑比對：距離低於此值、且明顯勝過第二名就自動填名稱
  const CAT_MARGIN = 0.05;
  let catalog = []; // 道具圖鑑（存在本機 IndexedDB）
  const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

  let state = S.loadState(safeStorage());
  const ui = {
    view: 'bag',
    charId: state.characters[0] ? state.characters[0].id : null,
    tab: 'equip',
    filter: '',
    query: '',
    searchTabs: [],
    searchChars: [],
    flashItem: null,
  };
  const scanDefaults = { rect: null, cols: 4, rows: 6, emptyThreshold: 10, maxDist: 0.08, ocr: true, digitThreshold: 175, zoom: 'fit' };
  const scan = Object.assign({}, scanDefaults, state.settings.scan || {}, {
    image: null, imgData: null, rows_: [], charId: null, tab: null, runId: 0, drag: null,
  });

  const $ = (sel, el) => (el || document).querySelector(sel);
  const main = $('#main');

  /* 雲端共用狀態 */
  const cloud = {
    status: C && C.configured() ? 'loading' : 'off', // off | loading | signedout | ready | error
    error: '',
    user: null,
    teamId: readCloudPref().teamId || null,
    team: null,
    teams: null,
    sync: null,
    loading: false,
    localState: null,
    unsubs: [],
    pendingJoin: new URLSearchParams(location.search).get('join'),
    uploadLocal: false,
  };

  function safeStorage() {
    try {
      const k = '__t';
      localStorage.setItem(k, k);
      localStorage.removeItem(k);
      return localStorage;
    } catch (e) {
      const mem = {};
      return { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
    }
  }

  function save() {
    const scanSettings = {
      rect: scan.rect, cols: scan.cols, rows: scan.rows, emptyThreshold: scan.emptyThreshold,
      maxDist: scan.maxDist, ocr: scan.ocr, digitThreshold: scan.digitThreshold, zoom: scan.zoom,
    };
    // 雲端模式：資料推到隊伍，本機只存掃圖設定（本機資料原封不動保留）
    const local = cloud.sync ? cloud.localState : state;
    local.settings.scan = scanSettings;
    try {
      S.saveState(localStorage, local);
    } catch (e) {
      toast('儲存失敗（瀏覽器空間不足？）請先匯出備份');
    }
    if (cloud.sync && !cloud.loading) {
      cloud.sync.push(state).done.catch((err) => toast('雲端同步失敗：' + cloudError(err)));
    }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  function currentChar() {
    return S.getCharacter(state, ui.charId) || state.characters[0] || null;
  }

  function thumbHtml(name, tab, iconId) {
    const ic = S.iconById(state, iconId) || S.iconForName(state, name, tab);
    return ic && ic.thumb
      ? `<img class="thumb-img" src="${esc(ic.thumb)}" alt="">`
      : '<span class="thumb-ph"></span>';
  }

  function tabBadge(tab) {
    return `<span class="badge tab-${tab}">${esc(S.tabName(tab))}</span>`;
  }

  function highlight(text, query) {
    let html = esc(text);
    const toks = String(query || '').split(/[\s,，、]+/).filter(Boolean);
    for (const t of toks) {
      const re = new RegExp(esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      html = html.replace(re, (m) => `<mark>${m}</mark>`);
    }
    return html;
  }

  /* ================= 共用 render ================= */

  function render() {
    renderNav();
    renderSidebar();
    renderNames();
    renderCloudChip();
    if (cloud.loading && ui.view !== 'cloud') {
      main.innerHTML = '<div class="empty">正在載入隊伍資料…</div>';
      return;
    }
    if (ui.view === 'cloud') renderCloud();
    else if (ui.view === 'bag') renderBag();
    else if (ui.view === 'search') renderSearch();
    else if (ui.view === 'scan') renderScan();
    else if (ui.view === 'icons') renderIcons();
  }

  function setView(view) {
    ui.view = view;
    render();
    window.scrollTo(0, 0);
  }

  function renderNav() {
    for (const b of document.querySelectorAll('#nav button[data-view]')) b.classList.toggle('active', b.dataset.view === ui.view);
  }

  function renderNames() {
    const names = new Set(S.knownNames(state));
    for (const it of catalog) names.add(it.name);
    $('#nameList').innerHTML = Array.from(names).map((n) => `<option value="${esc(n)}">`).join('');
  }

  function renderSidebar() {
    const cur = currentChar();
    const list = $('#charList');
    if (!state.characters.length) {
      list.innerHTML = '<li class="muted" style="cursor:default">還沒有角色，先新增一個吧</li>';
    } else {
      list.innerHTML = state.characters.map((c) => {
        const n = S.TAB_IDS.reduce((s, t) => s + c.inventory[t].length, 0);
        const meta = [c.level ? 'Lv.' + c.level : '', c.job].filter(Boolean).join(' ');
        return `<li data-char="${esc(c.id)}" class="${cur && cur.id === c.id ? 'active' : ''}">
          <span class="cname">${esc(c.name)}<br><span class="cmeta">${esc(meta || '—')} · ${n} 格</span></span>
          <span class="order"><button data-move="-1" title="上移">▲</button><button data-move="1" title="下移">▼</button></span>
        </li>`;
      }).join('');
    }
    let total = 0, cells = 0;
    for (const c of state.characters) for (const t of S.TAB_IDS) for (const it of c.inventory[t]) { total += it.qty; cells++; }
    $('#sidebarStats').textContent = state.characters.length
      ? `共 ${state.characters.length} 個角色、${cells} 格、${total} 個道具`
      : '';
  }

  /* ================= 背包 ================= */

  function renderBag() {
    const ch = currentChar();
    if (!ch) {
      main.innerHTML = `<div class="empty">
        <p>還沒有任何角色。</p>
        <p><button class="btn primary" data-act="add-char">＋ 新增第一個角色</button></p>
        <p class="small">每個角色都有 裝備／消耗／裝飾／其他／特殊 五個背包分頁，<br>可以手動輸入，也可以用「掃圖」從遊戲截圖辨識。</p>
      </div>`;
      return;
    }
    ui.charId = ch.id;
    main.innerHTML = `
      <div class="char-header">
        <input class="name-input" data-field="name" value="${esc(ch.name)}" title="角色名稱（點擊修改）">
        <input class="job" data-field="job" value="${esc(ch.job)}" placeholder="職業">
        <input class="level" data-field="level" type="number" min="1" value="${esc(ch.level)}" placeholder="等級">
        <span style="flex:1"></span>
        <button class="btn" data-act="scan-here">📷 掃描此分頁</button>
        <button class="btn danger" data-act="del-char">刪除角色</button>
      </div>
      <div class="tabs">
        ${S.TABS.map((t) => `<button data-act="tab" data-tab="${t.id}" class="${t.id === ui.tab ? 'active' : ''}">${t.name}<span class="count">${ch.inventory[t.id].length}</span></button>`).join('')}
      </div>
      <form class="panel add-form row" id="addForm" autocomplete="off">
        <input name="name" class="name" list="nameList" placeholder="道具名稱" required>
        <input name="qty" type="number" min="1" value="1" title="數量">
        <input name="note" class="note" placeholder="備註（選填，如：+7、10% 卷）">
        <button class="btn primary">加入${esc(S.tabName(ui.tab))}</button>
      </form>
      <div class="row spread" style="margin-bottom:8px">
        <input id="tabFilter" type="search" placeholder="篩選此分頁…" value="${esc(ui.filter)}" style="width:220px">
        <div class="row">
          <button class="btn small" data-act="sort" data-by="name">依名稱排序</button>
          <button class="btn small" data-act="sort" data-by="qty">依數量排序</button>
          <button class="btn small danger" data-act="clear-tab">清空此分頁</button>
        </div>
      </div>
      <div id="itemsBox"></div>`;
    renderItems();
  }

  function renderItems() {
    const box = $('#itemsBox');
    const ch = currentChar();
    if (!box || !ch) return;
    const list = ch.inventory[ui.tab];
    const toks = Q.tokens(ui.filter);
    const shown = list.filter((it) => toks.every((t) => Q.normalize(it.name + ' ' + it.note).includes(t)));
    if (!list.length) {
      box.innerHTML = `<div class="empty">${esc(S.tabName(ui.tab))}分頁是空的。<br>用上方表單加入，或按「📷 掃描此分頁」。</div>`;
      return;
    }
    if (!shown.length) {
      box.innerHTML = '<div class="empty">沒有符合篩選的道具</div>';
      return;
    }
    const others = state.characters.length > 1;
    box.innerHTML = `<table class="items">
      <thead><tr><th></th><th>名稱</th><th>數量</th><th>備註</th><th></th></tr></thead>
      <tbody>${shown.map((it) => `
        <tr data-item="${esc(it.id)}" ${ui.flashItem === it.id ? 'style="outline:2px solid var(--accent)"' : ''}>
          <td class="thumb">${thumbHtml(it.name, ui.tab, it.iconId)}</td>
          <td><input class="inline" data-ifield="name" value="${esc(it.name)}" list="nameList"></td>
          <td><input class="inline qty" data-ifield="qty" type="number" min="1" value="${it.qty}"></td>
          <td><input class="inline" data-ifield="note" value="${esc(it.note)}" placeholder="—"></td>
          <td class="actions">
            ${others ? '<button class="icon-btn" data-act="move-item" title="移到其他角色">⇄ 移動</button>' : ''}
            <button class="icon-btn danger" data-act="del-item" title="刪除">✕</button>
          </td>
        </tr>`).join('')}
      </tbody></table>
      <p class="muted small">此分頁 ${list.length} 格，合計 ${list.reduce((s, x) => s + x.qty, 0)} 個</p>`;
    if (ui.flashItem) {
      const row = box.querySelector(`tr[data-item="${CSS.escape(ui.flashItem)}"]`);
      if (row) row.scrollIntoView({ block: 'center' });
      ui.flashItem = null;
    }
  }

  function openMoveDialog(itemId) {
    const ch = currentChar();
    const it = S.findItem(state, ch.id, ui.tab, itemId);
    if (!it) return;
    const dlg = $('#moveDialog');
    $('#moveInfo').textContent = `${ch.name} 的「${it.name}」（目前 ${it.qty} 個）`;
    $('#moveTarget').innerHTML = state.characters.filter((c) => c.id !== ch.id).map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    $('#moveQty').max = it.qty;
    $('#moveQty').value = it.qty;
    dlg.onclose = () => {
      if (dlg.returnValue !== 'ok') return;
      const to = $('#moveTarget').value;
      if (S.moveItem(state, ch.id, ui.tab, itemId, to, $('#moveQty').value)) {
        save();
        render();
        toast(`已移到 ${S.getCharacter(state, to).name}`);
      }
    };
    dlg.returnValue = '';
    dlg.showModal();
  }

  /* ================= 搜尋 / 總覽 ================= */

  function renderSearch() {
    main.innerHTML = `
      <div class="panel filters">
        <div class="row" style="margin-bottom:6px"><b>分頁：</b>
          ${S.TABS.map((t) => `<label><input type="checkbox" data-stab="${t.id}" ${ui.searchTabs.includes(t.id) ? 'checked' : ''}>${t.name}</label>`).join('')}
        </div>
        <div class="row"><b>角色：</b>
          ${state.characters.map((c) => `<label><input type="checkbox" data-schar="${esc(c.id)}" ${ui.searchChars.includes(c.id) ? 'checked' : ''}>${esc(c.name)}</label>`).join('') || '<span class="muted">（尚無角色）</span>'}
          <span class="muted small">（都不勾 = 全部）</span>
        </div>
      </div>
      <div id="results"></div>`;
    renderResults();
  }

  function renderResults() {
    const box = $('#results');
    if (!box) return;
    const opts = { tabs: ui.searchTabs, charIds: ui.searchChars };
    const q = ui.query.trim();
    const groups = Q.search(state, q, opts);
    let html = '';
    if (q) {
      html += `<h3 style="margin-bottom:8px">「${esc(q)}」找到 ${groups.length} 種道具</h3>`;
    } else {
      html += renderStats();
      html += '<h3 style="margin:18px 0 8px">全部道具總覽</h3>';
    }
    if (!groups.length) {
      html += `<div class="empty">${q ? '找不到符合的道具' : '目前沒有任何道具'}</div>`;
    } else {
      html += '<div class="panel">' + groups.map((g) => `
        <div class="result">
          ${thumbHtml(g.name, g.tab)}
          <div style="flex:1;min-width:0">
            <div class="row"><span class="rname">${highlight(g.name, q)}</span>${tabBadge(g.tab)}<span class="total">共 ${g.total}</span>
              ${new Set(g.entries.map((e) => e.charId)).size > 1 ? `<span class="badge">分散 ${new Set(g.entries.map((e) => e.charId)).size} 個角色</span>` : ''}</div>
            <div class="entries">${g.entries.map((e) => `
              <span class="chip" data-jump="${esc(e.charId)}" data-tab="${e.tab}" data-item="${esc(e.itemId)}" title="跳到該角色背包">
                ${esc(e.charName)} <b>×${e.qty}</b>${e.note ? ` <span class="muted">(${highlight(e.note, q)})</span>` : ''}
              </span>`).join('')}
            </div>
          </div>
        </div>`).join('') + '</div>';
    }
    box.innerHTML = html;
  }

  function renderStats() {
    const rows = Q.stats(state);
    if (!rows.length) return '';
    const dups = Q.duplicates(state).filter((g) => g.tab !== 'equip');
    return `<h3 style="margin-bottom:8px">各角色背包使用格數</h3>
      <div class="panel" style="overflow-x:auto"><table class="stats">
        <thead><tr><th>角色</th>${S.TABS.map((t) => `<th>${t.name}</th>`).join('')}<th>合計</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td><a href="#" data-jump="${esc(r.charId)}" data-tab="equip">${esc(r.charName)}</a></td>${S.TAB_IDS.map((t) => `<td>${r.per[t] || '<span class="muted">0</span>'}</td>`).join('')}<td><b>${r.items}</b></td></tr>`).join('')}</tbody>
      </table></div>
      ${dups.length ? `<h3 style="margin:18px 0 8px">整理建議：同一道具分散在多個角色（${dups.length}）</h3>
        <div class="panel small">${dups.map((g) => `<div style="padding:3px 0">${tabBadge(g.tab)} <b>${esc(g.name)}</b> 共 ${g.total}：${g.entries.map((e) => `${esc(e.charName)}×${e.qty}`).join('、')}</div>`).join('')}
        <p class="muted" style="margin-bottom:0">可在背包頁用「⇄ 移動」集中到同一個角色。</p></div>` : ''}`;
  }

  /* ================= 掃圖 ================= */

  function renderScan() {
    if (!scan.charId || !S.getCharacter(state, scan.charId)) scan.charId = (currentChar() || {}).id || null;
    if (!scan.tab) scan.tab = ui.tab;
    if (!state.characters.length) {
      main.innerHTML = '<div class="empty"><p>請先新增角色再掃圖。</p><p><button class="btn primary" data-act="add-char">＋ 新增角色</button></p></div>';
      return;
    }
    main.innerHTML = `
      <div class="panel row">
        <label>角色 <select id="scanChar">${state.characters.map((c) => `<option value="${esc(c.id)}" ${c.id === scan.charId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
        <label>分頁 <select id="scanTab">${S.TABS.map((t) => `<option value="${t.id}" ${t.id === scan.tab ? 'selected' : ''}>${t.name}</option>`).join('')}</select></label>
        <span style="flex:1"></span>
        <button class="btn" data-act="scan-pick">選擇截圖…</button>
        <button class="btn" data-act="scan-demo" title="產生一張示範用的背包圖，試玩辨識流程">示範圖片</button>
        <input id="scanFile" type="file" accept="image/*" hidden>
      </div>
      <div class="scan-grid">
        <div>
          <div id="scanStage"></div>
          <div id="scanResults"></div>
        </div>
        <div class="panel scan-side">
          <h3>1. 框選背包格子</h3>
          <p class="help">在圖上按住滑鼠拖曳，框住「所有道具格」的範圍（從左上第一格的左上角，到右下最後一格的右下角），再設定欄數與列數。設定會記住，下次同尺寸截圖可直接辨識。</p>
          <label>欄數（橫） <input id="scanCols" type="number" min="1" max="20" value="${scan.cols}"></label>
          <label>列數（直） <input id="scanRows" type="number" min="1" max="40" value="${scan.rows}"></label>
          <div class="rect-inputs">
            ${['x', 'y', 'w', 'h'].map((k) => `<label>${k.toUpperCase()} <input data-rect="${k}" type="number" min="0" value="${scan.rect ? Math.round(scan.rect[k]) : ''}"></label>`).join('')}
          </div>
          <label>顯示縮放 <select id="scanZoom">${[['fit', '符合寬度'], ['1', '1x'], ['2', '2x'], ['3', '3x']].map(([v, n]) => `<option value="${v}" ${String(scan.zoom) === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          <h3>2. 辨識設定</h3>
          <label title="格子內顏色變化低於此值視為空格">空格判定 <input id="scanEmpty" type="range" min="2" max="40" value="${scan.emptyThreshold}"><span id="scanEmptyV">${scan.emptyThreshold}</span></label>
          <label title="越大越寬鬆，可能認錯；越小越嚴格">圖示比對容許 <input id="scanDist" type="range" min="1" max="25" value="${Math.round(scan.maxDist * 100)}"><span id="scanDistV">${Math.round(scan.maxDist * 100)}%</span></label>
          <label><span>讀取數量（OCR）</span><input id="scanOcr" type="checkbox" ${scan.ocr ? 'checked' : ''}></label>
          <label title="數字亮度門檻，數量讀錯時可調整">數字亮度門檻 <input id="scanDigit" type="number" min="60" max="250" value="${scan.digitThreshold}"></label>
          <p class="help">第一次掃到的圖示需要手動填名稱；勾選「記住」後就會存進圖示庫，之後自動辨識。數量由 OCR 讀取（首次需下載辨識資料，請保持連線），請檢查後再寫入。</p>
          <button class="btn primary" style="width:100%" data-act="scan-run">開始辨識</button>
          <div class="progress" id="scanProgress" hidden><div></div></div>
          <div class="muted small" id="scanMsg"></div>
        </div>
      </div>`;
    renderStage();
    renderScanResults();
  }

  function renderStage() {
    const stage = $('#scanStage');
    if (!stage) return;
    if (!scan.image) {
      stage.innerHTML = `<div class="dropzone" id="dropzone">
        <p style="font-size:16px;margin:0 0 6px">把背包截圖拖曳到這裡、按 <b>Ctrl+V</b> 貼上，或點此選擇檔案</p>
        <p class="small" style="margin:0">建議用遊戲內截圖或 Win+Shift+S 擷取背包視窗，不要縮放，辨識最準。</p>
      </div>`;
      return;
    }
    stage.innerHTML = '<div class="canvas-wrap" id="canvasWrap"><canvas id="scanCanvas"></canvas></div><p class="muted small">拖曳框選格子範圍；綠框＝已辨識、黃框＝新圖示。可拖曳新圖片或 Ctrl+V 換圖。</p>';
    drawCanvas();
  }

  function displayScale() {
    if (!scan.image) return 1;
    if (scan.zoom !== 'fit') return Number(scan.zoom) || 1;
    const stage = $('#scanStage');
    const avail = stage ? stage.clientWidth - 2 : 800;
    return Math.min(3, Math.max(0.2, avail / scan.image.width));
  }

  function drawCanvas() {
    const cv = $('#scanCanvas');
    if (!cv || !scan.image) return;
    const k = displayScale();
    scan.scale = k;
    cv.width = Math.round(scan.image.width * k);
    cv.height = Math.round(scan.image.height * k);
    const g = cv.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(scan.image, 0, 0, cv.width, cv.height);
    const r = scan.rect;
    if (!r || r.w < 2 || r.h < 2) return;
    g.save();
    g.fillStyle = 'rgba(0,0,0,.35)';
    g.fillRect(0, 0, cv.width, r.y * k);
    g.fillRect(0, (r.y + r.h) * k, cv.width, cv.height);
    g.fillRect(0, r.y * k, r.x * k, r.h * k);
    g.fillRect((r.x + r.w) * k, r.y * k, cv.width, r.h * k);
    g.strokeStyle = 'rgba(240,162,59,.9)';
    g.lineWidth = 1;
    const cells = SC.gridCells(r, scan.cols, scan.rows);
    for (const c of cells) g.strokeRect(c.x * k + 0.5, c.y * k + 0.5, c.w * k - 1, c.h * k - 1);
    g.lineWidth = 2;
    for (const row of scan.rows_) {
      g.strokeStyle = row.iconId && row.name ? '#5cc98a' : row.name ? '#ffcf7a' : '#e8c14f';
      const c = row.cell;
      g.strokeRect(c.x * k + 2, c.y * k + 2, c.w * k - 4, c.h * k - 4);
    }
    g.restore();
  }

  function loadImageFile(file) {
    if (!file || !/^image\//.test(file.type)) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setScanImage(img);
      URL.revokeObjectURL(url);
    };
    img.onerror = () => toast('無法讀取圖片');
    img.src = url;
  }

  function setScanImage(img) {
    const cv = document.createElement('canvas');
    cv.width = img.width;
    cv.height = img.height;
    const g = cv.getContext('2d');
    g.drawImage(img, 0, 0);
    scan.image = cv;
    scan.imgData = g.getImageData(0, 0, cv.width, cv.height);
    scan.rows_ = [];
    if (scan.rect && (scan.rect.x + scan.rect.w > cv.width || scan.rect.y + scan.rect.h > cv.height)) scan.rect = null;
    if (!scan.rect) scan.rect = { x: 0, y: 0, w: cv.width, h: cv.height };
    if (ui.view !== 'scan') setView('scan');
    else { renderStage(); syncRectInputs(); renderScanResults(); }
  }

  function syncRectInputs() {
    for (const inp of document.querySelectorAll('[data-rect]')) inp.value = scan.rect ? Math.round(scan.rect[inp.dataset.rect]) : '';
  }

  // 3x5 點陣數字（模擬遊戲裡白字黑框的數量字型）
  const PIXEL_DIGITS = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001',
    '111100111001111', '111100111101111', '111001010010010', '111101111101111', '111101111001111'];
  function drawPixelNumber(g, text, x0, y0) {
    const px = 2;
    for (const pass of ['#000', '#fff']) {
      g.fillStyle = pass;
      for (let i = 0; i < text.length; i++) {
        const bits = PIXEL_DIGITS[Number(text[i])];
        for (let k = 0; k < 15; k++) {
          if (bits[k] !== '1') continue;
          const x = x0 + i * (3 * px + 2) + (k % 3) * px, y = y0 + Math.floor(k / 3) * px;
          if (pass === '#000') g.fillRect(x - 1, y - 1, px + 2, px + 2);
          else g.fillRect(x, y, px, px);
        }
      }
    }
  }

  /* 產生示範背包圖：4x6 格、幾種彩色圖示與數量。 */
  function demoImage() {
    const cols = 4, rows = 6, cell = 36, pad = 10;
    const cv = document.createElement('canvas');
    cv.width = cols * cell + pad * 2;
    cv.height = rows * cell + pad * 2 + 20;
    const g = cv.getContext('2d');
    g.fillStyle = '#5b6b84';
    g.fillRect(0, 0, cv.width, cv.height);
    g.fillStyle = '#fff';
    g.font = 'bold 12px sans-serif';
    g.fillText('ITEM INVENTORY', pad, 14);
    const icons = [
      { color: '#e04848', shape: 'potion', qty: 120 }, { color: '#3b74e0', shape: 'potion', qty: 87 },
      { color: '#e04848', shape: 'potion', qty: 15 }, { color: '#f2c94c', shape: 'scroll', qty: 3 },
      null, { color: '#7a4ee0', shape: 'gem', qty: 42 }, { color: '#3b74e0', shape: 'potion', qty: 200 },
      { color: '#2fae66', shape: 'leaf', qty: 9 }, { color: '#f2c94c', shape: 'scroll', qty: 1 }, null, null,
      { color: '#7a4ee0', shape: 'gem', qty: 5 },
    ];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = pad + c * cell, y = pad + 20 + r * cell;
        g.fillStyle = '#d9dde6';
        g.fillRect(x + 1, y + 1, cell - 2, cell - 2);
        const it = icons[r * cols + c];
        if (!it) continue;
        g.fillStyle = it.color;
        g.strokeStyle = '#222';
        g.lineWidth = 2;
        g.beginPath();
        if (it.shape === 'potion') { g.arc(x + 18, y + 15, 9, 0, Math.PI * 2); g.rect(x + 15, y + 2, 6, 5); }
        else if (it.shape === 'scroll') g.rect(x + 7, y + 6, 22, 16);
        else if (it.shape === 'gem') { g.moveTo(x + 18, y + 3); g.lineTo(x + 29, y + 13); g.lineTo(x + 18, y + 24); g.lineTo(x + 7, y + 13); g.closePath(); }
        else { g.ellipse(x + 18, y + 13, 11, 7, -0.6, 0, Math.PI * 2); }
        g.fill();
        g.stroke();
        if (it.qty > 1) drawPixelNumber(g, String(it.qty), x + 3, y + cell - 13);
      }
    }
    scan.cols = cols;
    scan.rows = rows;
    scan.rect = { x: pad, y: pad + 20, w: cols * cell, h: rows * cell };
    return cv;
  }

  let ocrWorker = null;
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('無法載入 ' + src));
      document.head.appendChild(s);
    });
  }
  function getOcr() {
    if (!ocrWorker) {
      ocrWorker = (async () => {
        if (!window.Tesseract) await loadScript(TESSERACT_URL);
        const w = await window.Tesseract.createWorker('eng');
        await w.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: '7' });
        return w;
      })();
      ocrWorker.catch(() => { ocrWorker = null; });
    }
    return ocrWorker;
  }

  function cellThumb(cell) {
    const cv = document.createElement('canvas');
    cv.width = 32;
    cv.height = 32;
    const g = cv.getContext('2d');
    g.imageSmoothingEnabled = cell.w < 32;
    const ix = cell.w * 0.04, iy = cell.h * 0.04;
    g.drawImage(scan.image, cell.x + ix, cell.y + iy, cell.w - ix * 2, cell.h - iy * 2, 0, 0, 32, 32);
    return cv.toDataURL('image/png');
  }

  function scanMsg(text) {
    const m = $('#scanMsg');
    if (m) m.textContent = text;
  }
  function scanProgress(frac) {
    const p = $('#scanProgress');
    if (!p) return;
    p.hidden = frac == null;
    p.firstElementChild.style.width = Math.round((frac || 0) * 100) + '%';
  }

  async function runScan() {
    if (!scan.imgData) { toast('請先放入截圖'); return; }
    if (!scan.rect || scan.rect.w < 4 || scan.rect.h < 4) { toast('請先框選背包格子範圍'); return; }
    const runId = ++scan.runId;
    const results = SC.analyze(scan.imgData, scan.rect, scan.cols, scan.rows, {
      icons: state.icons, tab: scan.tab, emptyThreshold: scan.emptyThreshold, maxDist: scan.maxDist,
    });
    scan.rows_ = results.map((r) => {
      const row = {
        cell: r.cell,
        feat: r.feat,
        thumb: cellThumb(r.cell),
        iconId: r.icon ? r.icon.id : '',
        name: r.icon ? r.icon.name : '',
        guess: !r.icon && r.nearest && r.dist <= scan.maxDist * 2 ? r.nearest.name : '',
        dist: r.dist,
        cands: [],
        catAuto: false,
        qty: 1,
        qtySrc: '',
        include: true,
        remember: true,
      };
      // 圖示庫沒學過的，拿去跟道具圖鑑比
      if (!r.icon && catalog.length) {
        const ranked = SC.rankCatalog(SC.cellShape(scan.imgData, r.cell, scan.digitThreshold), catalog, scan.tab, 5);
        row.cands = ranked.map((c) => ({ name: c.item.name, img: c.item.img, dist: c.dist }));
        const [best, second] = ranked;
        if (best && best.dist <= CAT_AUTO && (!second || second.dist - best.dist >= CAT_MARGIN)) {
          row.name = best.item.name;
          row.catAuto = true;
          row.dist = best.dist;
        }
      }
      return row;
    });
    save();
    drawCanvas();
    renderScanResults();
    const known = scan.rows_.filter((r) => r.iconId).length;
    const fromCat = scan.rows_.filter((r) => r.catAuto).length;
    const unknown = scan.rows_.length - known - fromCat;
    scanMsg(`找到 ${scan.rows_.length} 個道具格：已辨識 ${known} 個` + (fromCat ? `、圖鑑比對 ${fromCat} 個（請確認）` : '') + (unknown ? `、待確認 ${unknown} 個` : ''));
    if (scan.tab === 'equip') return; // 裝備沒有數量

    // 先用學過的數字模板讀數量；讀不出來的才交給 OCR
    const needOcr = [];
    for (const row of scan.rows_) {
      const m = SC.digitMask(scan.imgData, row.cell, scan.digitThreshold);
      if (m.ink < 3) { row.qtySrc = 'none'; continue; }
      const n = SC.readDigits(scan.imgData, row.cell, state.digits, scan.digitThreshold);
      if (n) { row.qty = n; row.qtySrc = 'tmpl'; } else { row.qtySrc = 'unread'; needOcr.push(row); }
    }
    renderScanResults();
    if (!scan.ocr || !needOcr.length) {
      if (needOcr.length) scanMsg(`有 ${needOcr.length} 格的數量需要手動輸入（寫入後會學起來）`);
      return;
    }

    scanMsg('載入數量辨識（OCR）…');
    scanProgress(0);
    let worker;
    try {
      worker = await getOcr();
    } catch (e) {
      scanProgress(null);
      scanMsg('OCR 載入失敗（需要網路），請手動輸入數量。');
      return;
    }
    let done = 0;
    for (const row of needOcr) {
      if (runId !== scan.runId) return;
      const d = SC.digitImage(scan.imgData, row.cell, 4, scan.digitThreshold);
      const cv = document.createElement('canvas');
      cv.width = d.width;
      cv.height = d.height;
      cv.getContext('2d').putImageData(new ImageData(d.data, d.width, d.height), 0, 0);
      try {
        const res = await worker.recognize(cv);
        const n = SC.parseQty(res.data.text);
        if (n) { row.qty = n; row.qtySrc = 'ocr'; }
      } catch (e) { /* 單格失敗就保留 1 */ }
      done++;
      scanProgress(done / needOcr.length);
      updateRowQty(row);
    }
    if (runId !== scan.runId) return;
    scanProgress(null);
    renderScanResults();
    scanMsg(`辨識完成：${scan.rows_.length} 格。請檢查名稱與數量後寫入（修正過的數字會被學起來）。`);
  }

  function updateRowQty(row) {
    const i = scan.rows_.indexOf(row);
    const inp = document.querySelector(`#scanResults tr[data-row="${i}"] input[data-rfield="qty"]`);
    if (inp && document.activeElement !== inp) inp.value = row.qty;
  }

  function renderScanResults() {
    const box = $('#scanResults');
    if (!box) return;
    if (!scan.rows_.length) { box.innerHTML = ''; return; }
    const unnamed = scan.rows_.filter((r) => r.include && !r.name.trim()).length;
    box.innerHTML = `<div class="panel" style="margin-top:16px">
      <div class="row spread" style="margin-bottom:8px">
        <h3>辨識結果（${scan.rows_.length} 格${unnamed ? `，<span class="status-new">${unnamed} 格待命名</span>` : ''}）</h3>
        <div class="row">
          <button class="btn" data-act="scan-write" data-mode="merge" title="加到現有道具上">加入${esc(S.tabName(scan.tab))}</button>
          <button class="btn primary" data-act="scan-write" data-mode="replace" title="清空此分頁後寫入">取代${esc(S.tabName(scan.tab))}分頁</button>
        </div>
      </div>
      <p class="muted small" style="margin-top:0">填好一格的名稱後，其他長得一樣的格子會自動帶入。取代模式會把「${esc((S.getCharacter(state, scan.charId) || {}).name || '')}」的${esc(S.tabName(scan.tab))}分頁整個換成下面的內容。</p>
      <table class="items">
        <thead><tr><th>寫入</th><th>圖示</th><th>名稱</th><th>數量</th><th>狀態</th><th title="把這個圖示存進圖示庫，下次自動辨識">記住</th></tr></thead>
        <tbody>${scan.rows_.map((r, i) => `
          <tr data-row="${i}">
            <td><input type="checkbox" data-rfield="include" ${r.include ? 'checked' : ''}></td>
            <td class="thumb"><img class="thumb-img" src="${r.thumb}" alt=""></td>
            <td><input class="inline" data-rfield="name" list="nameList" value="${esc(r.name)}" placeholder="${esc(r.guess ? '可能是：' + r.guess : '輸入道具名稱')}"></td>
            <td><input class="inline qty" data-rfield="qty" type="number" min="1" value="${r.qty}">${QTY_SRC[r.qtySrc] ? `<div class="small muted">${QTY_SRC[r.qtySrc]}</div>` : ''}</td>
            <td class="small">${statusHtml(r)}</td>
            <td><input type="checkbox" data-rfield="remember" ${r.remember ? 'checked' : ''}></td>
          </tr>`).join('')}
        </tbody>
      </table></div>`;
  }

  function statusHtml(r) {
    if (r.iconId && r.name) return `<span class="status-ok">✓ 已辨識 ${Math.round((1 - r.dist) * 100)}%</span>`;
    let html = '';
    if (r.catAuto && r.name) html = `<span class="status-guess">圖鑑比對 ${Math.round((1 - r.dist) * 100)}%</span>`;
    else if (r.guess) html = `<span class="status-guess">相似：${esc(r.guess)} <button class="btn small" data-act="use-guess">套用</button></span>`;
    else if (!r.name) html = '<span class="status-new">新圖示</span>';
    if (r.cands && r.cands.length) {
      html += `<div class="cands">${r.cands.map((c, i) => `<button class="cand ${c.name === r.name ? 'on' : ''}" data-act="use-cand" data-c="${i}" title="${esc(c.name)}（${Math.round((1 - c.dist) * 100)}%）"><img src="${esc(c.img)}" alt=""></button>`).join('')}</div>`;
    }
    return html;
  }

  const QTY_SRC = { tmpl: '數字模板', ocr: 'OCR，請確認', unread: '<span class="status-new">未讀到</span>', edited: '手動' };

  /* 填入名稱後，自動帶給其他相同圖示且尚未命名的格子。 */
  function propagateName(src) {
    let n = 0;
    for (const r of scan.rows_) {
      if (r === src || r.name.trim()) continue;
      if (SC.featureDistance(r.feat, src.feat) <= scan.maxDist) { r.name = src.name; n++; }
    }
    return n;
  }

  function writeScan(mode) {
    const ch = S.getCharacter(state, scan.charId);
    if (!ch) return;
    const rows = scan.rows_.filter((r) => r.include && r.name.trim());
    const skipped = scan.rows_.filter((r) => r.include && !r.name.trim()).length;
    if (!rows.length) { toast('沒有可寫入的道具（請先填名稱）'); return; }
    if (mode === 'replace' && ch.inventory[scan.tab].length &&
        !confirm(`確定要把「${ch.name}」的${S.tabName(scan.tab)}分頁（${ch.inventory[scan.tab].length} 格）換成這次掃描的 ${rows.length} 格？`)) return;
    let learned = 0;
    const items = rows.map((r) => {
      const name = r.name.trim();
      let iconId = '';
      const matched = S.iconById(state, r.iconId);
      if (matched && matched.name === name) iconId = matched.id;
      else if (r.remember) {
        // 同一次掃描中重複的新圖示只學一次
        const m = SC.matchIcon(r.feat, state.icons.filter((x) => x.name === name), scan.tab, scan.maxDist);
        if (m.icon) iconId = m.icon.id;
        else {
          iconId = S.learnIcon(state, { name, tab: scan.tab, feat: r.feat, thumb: r.thumb }).id;
          learned++;
        }
      }
      if (r.qty > 1 && scan.tab !== 'equip') {
        state.digits = SC.mergeDigitTemplates(state.digits, SC.learnDigits(scan.imgData, r.cell, r.qty, scan.digitThreshold));
      }
      return { name, qty: r.qty, iconId };
    });
    S.applyItems(state, ch.id, scan.tab, items, mode);
    save();
    scan.rows_ = [];
    ui.charId = ch.id;
    ui.tab = scan.tab;
    toast(`已寫入 ${ch.name} 的${S.tabName(scan.tab)}分頁：${items.length} 格` + (learned ? `，學會 ${learned} 個新圖示` : '') + (skipped ? `（${skipped} 格未命名已略過）` : ''));
    setView('bag');
  }

  /* ================= 道具圖鑑 ================= */

  function loadCatalog() {
    if (!CAT) return;
    CAT.load().then((items) => {
      catalog = items;
      renderNames();
      if (ui.view === 'icons') renderIcons();
    }).catch(() => { /* 不支援 IndexedDB 就不用圖鑑 */ });
  }

  async function importCatalog(file) {
    if (!file) return;
    const bar = $('#catalogProgress');
    try {
      const json = JSON.parse(await file.text());
      if (bar) bar.hidden = false;
      const res = await CAT.importData(json, (f) => { if (bar) bar.firstElementChild.style.width = Math.round(f * 100) + '%'; });
      catalog = await CAT.load();
      renderNames();
      renderIcons();
      toast(`圖鑑匯入完成：${res.added} 個道具` + (res.skipped ? `（略過 ${res.skipped} 個）` : ''));
    } catch (err) {
      if (bar) bar.hidden = true;
      toast('匯入失敗：' + (err.message || err));
    }
  }

  /* ================= 圖示庫 ================= */

  function catalogHtml() {
    if (!CAT) return '';
    const bySec = {};
    for (const it of catalog) bySec[it.section || '其他'] = (bySec[it.section || '其他'] || 0) + 1;
    return `<div class="panel small">
      <div class="row spread"><b>道具圖鑑：${catalog.length} 個</b>
        <span class="row"><button class="btn small" data-act="copy-exporter">複製匯出程式</button>
        <button class="btn small primary" data-act="import-catalog">匯入道具圖鑑</button>
        ${catalog.length ? '<button class="btn small danger" data-act="clear-catalog">清除</button>' : ''}</span></div>
      ${catalog.length ? `<p class="muted">${Object.entries(bySec).map(([k, n]) => `${esc(k)} ${n}`).join('、')}</p>` : ''}
      <p class="muted" style="margin-bottom:0">掃圖時，圖示庫沒學過的格子會跟圖鑑比對：很像的自動填名稱，不確定的列出候選圖讓你點。
      取得圖鑑：按「複製匯出程式」→ 打開 <a href="https://www.artalemaplestory.com/zh/equipment" target="_blank" rel="noopener">artalemaplestory.com</a> 的道具列表 → F12 → Console 貼上執行 → 匯入下載的檔案。
      圖鑑只存在這台電腦的瀏覽器裡。</p>
      <div class="progress" id="catalogProgress" hidden><div></div></div>
      <input id="catalogFile" type="file" accept="application/json,.json" hidden>
    </div>`;
  }

  function digitInfoHtml() {
    const have = Array.from(new Set(state.digits.map((t) => t.d))).sort();
    return `<div class="panel row spread small">
      <span>數字模板：已學會 ${have.length}/10 個數字${have.length ? `（${have.join(' ')}）` : ''}。掃圖寫入時會從確認過的數量自動學習。</span>
      ${state.digits.length ? '<button class="btn small danger" data-act="reset-digits">重設數字模板</button>' : ''}
    </div>`;
  }

  function renderIcons() {
    if (!state.icons.length) {
      main.innerHTML = catalogHtml() + digitInfoHtml() + '<div class="empty">圖示庫是空的。<br>在「掃圖」中替新圖示填名稱並勾選「記住」，就會出現在這裡。</div>';
      return;
    }
    const sorted = state.icons.slice().sort((a, b) => (a.tab || '').localeCompare(b.tab || '') || a.name.localeCompare(b.name, 'zh-Hant'));
    main.innerHTML = `
      <div class="row spread" style="margin-bottom:12px">
        <h3>圖示庫（${state.icons.length}）</h3>
        <input id="iconFilter" type="search" placeholder="篩選…" style="width:200px">
      </div>
      <p class="muted small">改名後，之後掃圖會用新名稱；刪除後該圖示需重新學習。認錯時可以刪掉錯的圖示重新掃描。</p>
      ${catalogHtml()}
      ${digitInfoHtml()}
      <div class="icon-grid">${sorted.map((ic) => `
        <div class="icon-card" data-icon="${esc(ic.id)}" data-search="${esc(Q.normalize(ic.name))}">
          ${ic.thumb ? `<img class="thumb-img" src="${esc(ic.thumb)}" alt="">` : '<span class="thumb-ph"></span>'}
          <div class="fields">
            <input data-icfield="name" value="${esc(ic.name)}">
            <select data-icfield="tab"><option value="">（任何分頁）</option>${S.TABS.map((t) => `<option value="${t.id}" ${ic.tab === t.id ? 'selected' : ''}>${t.name}</option>`).join('')}</select>
          </div>
          <button class="icon-btn danger" data-act="del-icon" title="刪除">✕</button>
        </div>`).join('')}
      </div>`;
  }

  /* ================= 雲端共用 ================= */

  function readCloudPref() {
    try { return JSON.parse(localStorage.getItem(CLOUD_KEY)) || {}; } catch (e) { return {}; }
  }
  function writeCloudPref() {
    try { localStorage.setItem(CLOUD_KEY, JSON.stringify({ teamId: cloud.teamId })); } catch (e) { /* 無法保存就算了 */ }
  }

  function cloudError(err) {
    const code = err && err.code ? String(err.code) : '';
    if (code.includes('permission-denied')) return '沒有權限（可能不是隊伍成員）';
    if (code.includes('not-found')) return '找不到隊伍，請確認邀請碼';
    if (code.includes('popup-closed') || code.includes('cancelled-popup')) return '登入視窗被關閉';
    if (code.includes('unauthorized-domain')) return '這個網址尚未加入 Firebase 的授權網域';
    if (code.includes('unavailable') || code.includes('network')) return '網路連線問題';
    return (err && err.message) || String(err);
  }

  function initCloud() {
    // 直接開啟檔案（file://）時無法 Google 登入，維持本機模式，共用頁會說明要用網址開啟
    if (!C || !C.configured() || location.protocol === 'file:') return;
    C.init(onUser).catch((err) => {
      cloud.status = 'error';
      cloud.error = cloudError(err);
      renderCloudChip();
      if (ui.view === 'cloud') renderCloud();
    });
  }

  async function onUser(user) {
    cloud.user = user;
    cloud.status = user ? 'ready' : 'signedout';
    cloud.teams = null;
    if (!user) {
      disconnectTeam();
    } else {
      if (cloud.pendingJoin) {
        const id = cloud.pendingJoin;
        cloud.pendingJoin = null;
        history.replaceState(null, '', location.pathname);
        await joinFlow(id);
      } else if (cloud.teamId && !cloud.sync) {
        connectTeam(cloud.teamId);
      }
      if (!cloud.sync) loadTeams();
    }
    render();
  }

  async function loadTeams() {
    try {
      cloud.teams = await C.myTeams();
    } catch (err) {
      cloud.teams = [];
      toast('讀取隊伍失敗：' + cloudError(err));
    }
    if (ui.view === 'cloud') renderCloud();
  }

  function connectTeam(teamId) {
    disconnectTeam();
    cloud.teamId = teamId;
    writeCloudPref();
    cloud.localState = state;
    state = S.createState();
    state.settings = cloud.localState.settings;
    cloud.sync = Y.createSync(C.backend(teamId));
    cloud.loading = true;
    const failed = (err) => {
      toast('無法連到隊伍：' + cloudError(err) + '，已切回本機模式');
      cloud.teamId = null;
      writeCloudPref();
      disconnectTeam();
      loadTeams();
      render();
    };
    cloud.unsubs.push(C.watchTeam(teamId, (t) => {
      cloud.team = t;
      renderCloudChip();
      if (ui.view === 'cloud') renderCloud();
    }, failed));
    cloud.unsubs.push(C.watchData(teamId, (path, data) => cloud.sync.applyRemote(state, path, data), ({ ready, changed }) => {
      if (!ready) return;
      if (cloud.loading) {
        cloud.loading = false;
        if (cloud.uploadLocal) {
          cloud.uploadLocal = false;
          copyLocalIntoTeam();
        }
        ui.charId = state.characters[0] ? state.characters[0].id : null;
        render();
      } else if (changed) {
        scheduleRender();
      }
    }, failed));
    render();
  }

  function disconnectTeam() {
    for (const u of cloud.unsubs) u();
    cloud.unsubs = [];
    cloud.sync = null;
    cloud.team = null;
    cloud.loading = false;
    if (cloud.localState) {
      state = cloud.localState;
      cloud.localState = null;
      ui.charId = state.characters[0] ? state.characters[0].id : null;
    }
  }

  /* 建立隊伍時把本機資料搬上去（保留原 id，本機資料不刪除）。 */
  function copyLocalIntoTeam() {
    const local = JSON.parse(JSON.stringify(cloud.localState));
    state.characters = state.characters.concat(local.characters.filter((c) => !S.getCharacter(state, c.id)));
    state.icons = state.icons.concat(local.icons.filter((ic) => !S.iconById(state, ic.id)));
    state.digits = SC.mergeDigitTemplates(state.digits, local.digits || []);
    save();
    toast(`已把本機的 ${local.characters.length} 個角色上傳到隊伍`);
  }

  async function joinFlow(teamId) {
    teamId = parseInvite(teamId);
    if (!teamId) { toast('邀請碼格式不正確'); return; }
    if (!confirm('要加入這個隊伍嗎？加入後可以和隊友一起編輯所有角色的背包。')) return;
    try {
      await C.joinTeam(teamId);
      connectTeam(teamId);
      toast('已加入隊伍');
    } catch (err) {
      toast('加入失敗：' + cloudError(err));
    }
  }

  function parseInvite(text) {
    const t = String(text || '').trim();
    const m = t.match(/[?&]join=([A-Za-z0-9_-]+)/);
    const id = m ? m[1] : t;
    return /^[A-Za-z0-9_-]{6,64}$/.test(id) ? id : '';
  }

  function inviteLink() {
    return location.origin + location.pathname + '?join=' + encodeURIComponent(cloud.teamId);
  }

  /* 遠端有變動時重畫。欄位裡有還沒送出的輸入時，等使用者離開欄位再畫，避免打字被打斷；
   * 否則直接重畫並把游標放回原本的欄位。 */
  let renderDeferred = false;
  function scheduleRender() {
    const a = document.activeElement;
    const editing = a && main.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName);
    if (editing && a.type !== 'checkbox' && a.value !== a.defaultValue) {
      if (!renderDeferred) {
        renderDeferred = true;
        a.addEventListener('blur', () => { renderDeferred = false; setTimeout(scheduleRender, 0); }, { once: true });
      }
      return;
    }
    const refocus = editing ? (a.id ? '#' + a.id : a.form && a.form.id && a.name ? `#${a.form.id} [name="${a.name}"]` : null) : null;
    if (ui.view === 'scan') { renderSidebar(); renderNames(); renderCloudChip(); return; }
    render();
    const el = refocus && $(refocus);
    if (el) el.focus();
  }

  function renderCloudChip() {
    const chip = $('#cloudChip');
    if (!chip) return;
    let text = '本機模式', cls = '';
    if (cloud.sync) {
      text = '☁ ' + (cloud.team ? cloud.team.name : '隊伍') + (cloud.loading ? '（載入中）' : '');
      cls = 'on';
    } else if (cloud.status === 'error') { text = '雲端錯誤'; cls = 'err'; }
    chip.textContent = text;
    chip.className = 'cloud-chip ' + cls;
    chip.hidden = cloud.status === 'off' || location.protocol === 'file:';
  }

  function renderCloud() {
    // 重畫時保留使用者已輸入的內容（例如隊伍清單載入完成時）
    const keep = {};
    for (const id of ['newTeamName', 'joinCode']) { const el = $('#' + id); if (el) keep[id] = el.value; }
    const up = $('#uploadLocal');
    const box = (inner) => {
      main.innerHTML = `<div class="cloud-view">${inner}</div>`;
      for (const [id, v] of Object.entries(keep)) { const el = $('#' + id); if (el) el.value = v; }
      if (up && $('#uploadLocal')) $('#uploadLocal').checked = up.checked;
    };
    if (cloud.status === 'off') {
      box(`<div class="panel"><h3>和朋友共用背包資料</h3>
        <p>目前是<b>本機模式</b>：資料只存在這個瀏覽器。</p>
        <p>要和朋友一起管理角色，需要先設定免費的 Firebase 雲端資料庫，並把網頁放到網路上（例如 GitHub Pages）。
        設定步驟請看專案 README 的「雲端共用設定」，完成後把設定貼到 <code>js/firebase-config.js</code>。</p></div>`);
      return;
    }
    if (location.protocol === 'file:') {
      box(`<div class="panel"><h3>需要用網址開啟</h3>
        <p>Google 登入不能在「直接開啟檔案」（file://）的情況下使用。請改用 GitHub Pages 的網址，或在專案資料夾執行 <code>npm start</code> 後開啟 <code>http://localhost:8080</code>。</p></div>`);
      return;
    }
    if (cloud.status === 'loading') { box('<div class="empty">連線中…</div>'); return; }
    if (cloud.status === 'error') {
      box(`<div class="panel"><h3>無法連線到雲端</h3><p class="status-new">${esc(cloud.error)}</p>
        <button class="btn" data-act="cloud-retry">重試</button></div>`);
      return;
    }
    if (cloud.status === 'signedout' || !cloud.user) {
      box(`<div class="panel"><h3>登入以使用雲端共用</h3>
        <p>用 Google 帳號登入後，可以建立隊伍或用朋友給的邀請連結加入，一起編輯所有角色的背包。</p>
        ${cloud.pendingJoin ? '<p class="status-guess">你開啟了邀請連結，登入後就會詢問是否加入。</p>' : ''}
        <button class="btn primary" data-act="cloud-signin">用 Google 登入</button></div>`);
      return;
    }
    const u = cloud.user;
    const account = `<div class="panel row spread"><span>已登入：<b>${esc(u.displayName || u.email)}</b> <span class="muted small">${esc(u.email || '')}</span></span>
      <button class="btn small" data-act="cloud-signout">登出</button></div>`;
    if (cloud.sync) {
      const t = cloud.team;
      const isOwner = t && t.owner === u.uid;
      const members = t ? t.members.map((id) => {
        const info = (t.memberInfo && t.memberInfo[id]) || {};
        return `<li class="row spread"><span>${esc(info.name || info.email || '成員')} <span class="muted small">${esc(info.email || '')}</span>
          ${id === t.owner ? '<span class="badge">隊長</span>' : ''}${id === u.uid ? '<span class="badge">你</span>' : ''}</span>
          ${isOwner && id !== u.uid ? `<button class="btn small danger" data-act="cloud-kick" data-uid="${esc(id)}">移出</button>` : ''}</li>`;
      }).join('') : '';
      box(`${account}
        <div class="panel">
          <div class="row spread"><h3>目前隊伍：<input id="teamName" value="${esc(t ? t.name : '')}" maxlength="40" style="font-weight:600"></h3>
            <span class="status-ok small">● 即時同步中</span></div>
          <p class="muted small">所有角色、道具、圖示庫、數字模板都和隊友共用；任何人修改，其他人畫面會自動更新。</p>
          <h3 style="margin:14px 0 6px">邀請朋友</h3>
          <div class="row"><input id="inviteLink" readonly value="${esc(inviteLink())}" style="flex:1;min-width:200px">
            <button class="btn primary" data-act="cloud-copy">複製連結</button></div>
          <p class="muted small">把連結傳給朋友，朋友用 Google 登入後就能加入。<b>拿到連結的人都能加入</b>，請只傳給信任的人；隊長可以把成員移出。</p>
          <h3 style="margin:14px 0 6px">成員（${t ? t.members.length : 0}）</h3>
          <ul class="member-list">${members}</ul>
          <div class="row" style="margin-top:14px">
            <button class="btn" data-act="cloud-local">切回本機模式</button>
            ${isOwner ? '' : '<button class="btn danger" data-act="cloud-leave">退出隊伍</button>'}
          </div>
        </div>`);
      return;
    }
    const teams = cloud.teams;
    box(`${account}
      ${teams && teams.length ? `<div class="panel"><h3>我的隊伍</h3><ul class="member-list">${teams.map((t) => `
        <li class="row spread"><span><b>${esc(t.name)}</b> <span class="muted small">${t.members.length} 位成員</span></span>
        <button class="btn small primary" data-act="cloud-open" data-team="${esc(t.id)}">進入</button></li>`).join('')}</ul></div>` : ''}
      ${teams === null ? '<div class="panel muted">讀取隊伍中…</div>' : ''}
      <div class="panel"><h3>建立新隊伍</h3>
        <div class="row" style="margin-top:8px"><input id="newTeamName" placeholder="隊伍名稱" maxlength="40" style="flex:1;min-width:160px">
          <button class="btn primary" data-act="cloud-create">建立</button></div>
        <label class="row small" style="margin-top:8px"><input type="checkbox" id="uploadLocal" ${state.characters.length ? 'checked' : ''}>
          把目前本機的資料（${state.characters.length} 個角色、${state.icons.length} 個圖示）一起上傳到新隊伍</label></div>
      <div class="panel"><h3>加入朋友的隊伍</h3>
        <div class="row" style="margin-top:8px"><input id="joinCode" placeholder="貼上邀請連結或邀請碼" style="flex:1;min-width:200px">
          <button class="btn" data-act="cloud-join">加入</button></div></div>`);
  }

  async function cloudAction(act, b) {
    try {
      if (act === 'cloud-signin') await C.signIn();
      else if (act === 'cloud-signout') { await C.signOut(); setView('cloud'); }
      else if (act === 'cloud-retry') { cloud.status = 'loading'; renderCloud(); initCloud(); }
      else if (act === 'cloud-create') {
        const name = $('#newTeamName').value.trim() || '我的隊伍';
        cloud.uploadLocal = $('#uploadLocal').checked;
        const id = await C.createTeam(name);
        connectTeam(id);
        toast('隊伍已建立，複製邀請連結給朋友吧');
      } else if (act === 'cloud-join') await joinFlow($('#joinCode').value);
      else if (act === 'cloud-open') connectTeam(b.dataset.team);
      else if (act === 'cloud-local') {
        cloud.teamId = null;
        writeCloudPref();
        disconnectTeam();
        loadTeams();
        render();
        toast('已切回本機模式（隊伍資料仍保留在雲端）');
      } else if (act === 'cloud-leave') {
        if (!confirm('確定退出隊伍？退出後就看不到隊伍資料，需要重新邀請才能加入。')) return;
        const id = cloud.teamId;
        cloud.teamId = null;
        writeCloudPref();
        disconnectTeam();
        await C.leaveTeam(id);
        loadTeams();
        render();
      } else if (act === 'cloud-kick') {
        const info = (cloud.team.memberInfo || {})[b.dataset.uid] || {};
        if (confirm(`把 ${info.name || info.email || '這位成員'} 移出隊伍？`)) await C.leaveTeam(cloud.teamId, b.dataset.uid);
      } else if (act === 'cloud-copy') {
        const inp = $('#inviteLink');
        try { await navigator.clipboard.writeText(inp.value); } catch (e) { inp.select(); document.execCommand('copy'); }
        toast('邀請連結已複製');
      }
    } catch (err) {
      toast(cloudError(err));
    }
  }

  /* ================= 事件 ================= */

  function addCharacterFlow() {
    const name = prompt('角色名稱：', '角色' + (state.characters.length + 1));
    if (name == null) return;
    const ch = S.addCharacter(state, name);
    save();
    ui.charId = ch.id;
    setView('bag');
  }

  $('#addCharBtn').addEventListener('click', addCharacterFlow);
  $('#cloudChip').addEventListener('click', () => setView('cloud'));

  $('#charList').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-char]');
    if (!li) return;
    const mv = e.target.closest('button[data-move]');
    if (mv) {
      S.moveCharacter(state, li.dataset.char, Number(mv.dataset.move));
      save();
      renderSidebar();
      return;
    }
    ui.charId = li.dataset.char;
    ui.filter = '';
    setView('bag');
  });

  $('#nav').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.view) setView(b.dataset.view);
    else if (b.dataset.action === 'export') exportData();
    else if (b.dataset.action === 'import') $('#importFile').click();
  });

  $('#globalSearch').addEventListener('input', (e) => {
    ui.query = e.target.value;
    if (ui.view !== 'search') setView('search');
    else renderResults();
  });
  $('#globalSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.target.value = ''; ui.query = ''; renderResults(); }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && !e.shiftKey) {
      e.preventDefault();
      $('#globalSearch').focus();
      $('#globalSearch').select();
    }
  });

  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    a.href = URL.createObjectURL(blob);
    a.download = `artale-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  $('#importFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const data = S.normalizeState(JSON.parse(await f.text()));
      const where = cloud.sync ? `隊伍「${cloud.team ? cloud.team.name : ''}」的資料（所有成員都會受影響）` : '目前的資料';
      if (!confirm(`匯入 ${data.characters.length} 個角色、${data.icons.length} 個圖示？${where}會被取代（建議先匯出備份）。`)) return;
      if (cloud.sync) data.settings = state.settings;
      state = data;
      ui.charId = state.characters[0] ? state.characters[0].id : null;
      Object.assign(scan, scanDefaults, state.settings.scan || {});
      save();
      render();
      toast('匯入完成');
    } catch (err) {
      toast('匯入失敗：檔案格式不正確');
    }
  });

  main.addEventListener('click', async (e) => {
    const jump = e.target.closest('[data-jump]');
    if (jump) {
      e.preventDefault();
      ui.charId = jump.dataset.jump;
      ui.tab = jump.dataset.tab || 'equip';
      ui.flashItem = jump.dataset.item || null;
      ui.filter = '';
      setView('bag');
      return;
    }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act.startsWith('cloud-')) { cloudAction(act, b); return; }
    const ch = currentChar();
    const tr = b.closest('tr');
    if (act === 'add-char') addCharacterFlow();
    else if (act === 'tab') { ui.tab = b.dataset.tab; ui.filter = ''; renderBag(); }
    else if (act === 'sort') { S.sortTab(state, ch.id, ui.tab, b.dataset.by); save(); renderItems(); }
    else if (act === 'clear-tab') {
      if (ch.inventory[ui.tab].length && confirm(`清空「${ch.name}」的${S.tabName(ui.tab)}分頁？`)) {
        ch.inventory[ui.tab].length = 0; save(); render();
      }
    } else if (act === 'del-char') {
      if (confirm(`確定刪除角色「${ch.name}」與其所有背包資料？`)) {
        S.removeCharacter(state, ch.id); save();
        ui.charId = state.characters[0] ? state.characters[0].id : null;
        render();
      }
    } else if (act === 'scan-here') { scan.charId = ch.id; scan.tab = ui.tab; scan.rows_ = []; setView('scan'); }
    else if (act === 'del-item') { S.removeItem(state, ch.id, ui.tab, tr.dataset.item); save(); render(); }
    else if (act === 'move-item') openMoveDialog(tr.dataset.item);
    else if (act === 'scan-pick') $('#scanFile').click();
    else if (act === 'scan-demo') { const cv = demoImage(); setScanImage(cv); renderScan(); }
    else if (act === 'scan-run') runScan();
    else if (act === 'scan-write') writeScan(b.dataset.mode);
    else if (act === 'use-cand') {
      const row = scan.rows_[Number(tr.dataset.row)];
      const c = row.cands[Number(b.dataset.c)];
      row.name = c.name;
      row.catAuto = false;
      propagateName(row);
      renderScanResults();
      drawCanvas();
    } else if (act === 'copy-exporter') {
      try { await navigator.clipboard.writeText(window.ArrExportScript); toast('匯出程式已複製，到網站的 F12 Console 貼上執行'); }
      catch (e) { prompt('複製下面這段程式：', window.ArrExportScript); }
    } else if (act === 'import-catalog') $('#catalogFile').click();
    else if (act === 'clear-catalog') {
      if (confirm(`清除道具圖鑑（${catalog.length} 個）？之後可以再匯入。`)) { await CAT.clear(); catalog = []; renderNames(); renderIcons(); }
    } else if (act === 'use-guess') {
      const row = scan.rows_[Number(tr.dataset.row)];
      row.name = row.guess;
      propagateName(row);
      renderScanResults();
      drawCanvas();
    } else if (act === 'reset-digits') {
      if (confirm('清除所有學過的數字模板？')) { state.digits = []; save(); renderIcons(); }
    } else if (act === 'del-icon') {
      const id = b.closest('[data-icon]').dataset.icon;
      const ic = S.iconById(state, id);
      if (ic && confirm(`刪除圖示「${ic.name}」？`)) { S.removeIcon(state, id); save(); renderIcons(); }
    }
  });

  main.addEventListener('click', (e) => {
    if (e.target.closest('#dropzone')) $('#scanFile').click();
  });

  main.addEventListener('submit', (e) => {
    if (e.target.id !== 'addForm') return;
    e.preventDefault();
    const f = e.target;
    const ch = currentChar();
    const it = S.addItem(state, ch.id, ui.tab, { name: f.name.value, qty: f.qty.value, note: f.note.value });
    if (!it) return;
    const ic = S.iconForName(state, it.name, ui.tab);
    if (ic && !it.iconId) it.iconId = ic.id;
    save();
    renderSidebar();
    renderNames();
    const counts = main.querySelector(`.tabs button[data-tab="${ui.tab}"] .count`);
    if (counts) counts.textContent = ch.inventory[ui.tab].length;
    renderItems();
    f.name.value = '';
    f.qty.value = 1;
    f.note.value = '';
    f.name.focus();
  });

  main.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'tabFilter') { ui.filter = t.value; renderItems(); }
    else if (t.id === 'iconFilter') {
      const q = Q.normalize(t.value);
      for (const card of main.querySelectorAll('.icon-card')) card.hidden = q && !card.dataset.search.includes(q);
    } else if (t.id === 'scanEmpty') { scan.emptyThreshold = Number(t.value); $('#scanEmptyV').textContent = t.value; }
    else if (t.id === 'scanDist') { scan.maxDist = Number(t.value) / 100; $('#scanDistV').textContent = t.value + '%'; }
    else if (t.dataset.rect) {
      const v = Number(t.value);
      if (!Number.isFinite(v)) return;
      scan.rect = scan.rect || { x: 0, y: 0, w: 0, h: 0 };
      scan.rect[t.dataset.rect] = Math.max(0, v);
      drawCanvas();
    } else if (t.id === 'scanCols' || t.id === 'scanRows') {
      const v = Math.max(1, Math.floor(Number(t.value)) || 1);
      if (t.id === 'scanCols') scan.cols = v; else scan.rows = v;
      scan.rows_ = [];
      drawCanvas();
      renderScanResults();
    }
  });

  main.addEventListener('change', (e) => {
    const t = e.target;
    const ch = currentChar();
    if (t.dataset.field && ch) {
      S.updateCharacter(state, ch.id, { [t.dataset.field]: t.value });
      save();
      renderSidebar();
      return;
    }
    if (t.dataset.ifield && ch) {
      const id = t.closest('tr').dataset.item;
      const it = S.updateItem(state, ch.id, ui.tab, id, { [t.dataset.ifield]: t.value });
      if (it) {
        if (t.dataset.ifield === 'name') { const ic = S.iconForName(state, it.name, ui.tab); it.iconId = ic ? ic.id : ''; }
        t.value = it[t.dataset.ifield];
        save();
        renderSidebar();
        renderNames();
        if (t.dataset.ifield === 'name') renderItems();
      }
      return;
    }
    if (t.dataset.rfield) {
      const row = scan.rows_[Number(t.closest('tr').dataset.row)];
      if (!row) return;
      if (t.dataset.rfield === 'include' || t.dataset.rfield === 'remember') row[t.dataset.rfield] = t.checked;
      else if (t.dataset.rfield === 'qty') { row.qty = Math.max(1, Math.floor(Number(t.value)) || 1); if (row.qtySrc && row.qtySrc !== 'none') row.qtySrc = 'edited'; }
      else if (t.dataset.rfield === 'name') {
        row.name = t.value.trim();
        row.catAuto = false;
        if (row.iconId && S.iconById(state, row.iconId) && S.iconById(state, row.iconId).name !== row.name) row.iconId = '';
        if (row.name && propagateName(row)) renderScanResults();
        drawCanvas();
      }
      return;
    }
    if (t.dataset.icfield) {
      const ic = S.iconById(state, t.closest('[data-icon]').dataset.icon);
      if (!ic) return;
      if (t.dataset.icfield === 'name') { if (t.value.trim()) ic.name = t.value.trim(); else t.value = ic.name; }
      else ic.tab = t.value;
      save();
      return;
    }
    if (t.dataset.stab || t.dataset.schar) {
      ui.searchTabs = Array.from(main.querySelectorAll('[data-stab]:checked')).map((x) => x.dataset.stab);
      ui.searchChars = Array.from(main.querySelectorAll('[data-schar]:checked')).map((x) => x.dataset.schar);
      renderResults();
      return;
    }
    if (t.id === 'teamName' && cloud.teamId) {
      C.renameTeam(cloud.teamId, t.value).catch((err) => toast(cloudError(err)));
      return;
    }
    if (t.id === 'scanChar') { scan.charId = t.value; renderScanResults(); }
    else if (t.id === 'scanTab') { scan.tab = t.value; scan.rows_ = []; renderScanResults(); drawCanvas(); }
    else if (t.id === 'scanOcr') scan.ocr = t.checked;
    else if (t.id === 'scanDigit') scan.digitThreshold = Number(t.value) || 175;
    else if (t.id === 'scanZoom') { scan.zoom = t.value; drawCanvas(); }
    else if (t.id === 'scanFile') { loadImageFile(t.files[0]); t.value = ''; }
    else if (t.id === 'catalogFile') { importCatalog(t.files[0]); t.value = ''; }
    else if (t.dataset.rect || t.id === 'scanCols' || t.id === 'scanRows' || t.id === 'scanEmpty' || t.id === 'scanDist') save();
  });

  // 框選：在 canvas 上拖曳
  main.addEventListener('mousedown', (e) => {
    if (e.target.id !== 'scanCanvas' || e.button !== 0) return;
    e.preventDefault();
    const k = scan.scale || 1;
    const rect = e.target.getBoundingClientRect();
    scan.drag = { x: (e.clientX - rect.left) / k, y: (e.clientY - rect.top) / k, canvasRect: rect };
  });
  window.addEventListener('mousemove', (e) => {
    if (!scan.drag) return;
    const k = scan.scale || 1;
    const r = scan.drag.canvasRect;
    const W = scan.image.width, H = scan.image.height;
    const x = Math.min(W, Math.max(0, (e.clientX - r.left) / k));
    const y = Math.min(H, Math.max(0, (e.clientY - r.top) / k));
    scan.rect = {
      x: Math.round(Math.min(x, scan.drag.x)), y: Math.round(Math.min(y, scan.drag.y)),
      w: Math.round(Math.abs(x - scan.drag.x)), h: Math.round(Math.abs(y - scan.drag.y)),
    };
    scan.rows_ = [];
    drawCanvas();
    syncRectInputs();
  });
  window.addEventListener('mouseup', () => {
    if (!scan.drag) return;
    scan.drag = null;
    save();
    renderScanResults();
  });

  // 拖放與貼上截圖
  main.addEventListener('dragover', (e) => {
    if (ui.view !== 'scan') return;
    e.preventDefault();
    const dz = $('#dropzone');
    if (dz) dz.classList.add('over');
  });
  main.addEventListener('dragleave', () => { const dz = $('#dropzone'); if (dz) dz.classList.remove('over'); });
  main.addEventListener('drop', (e) => {
    if (ui.view !== 'scan') return;
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) loadImageFile(f);
  });
  document.addEventListener('paste', (e) => {
    const items = e.clipboardData ? Array.from(e.clipboardData.items) : [];
    const img = items.find((x) => x.kind === 'file' && /^image\//.test(x.type));
    if (!img) return;
    e.preventDefault();
    if (!state.characters.length) { toast('請先新增角色'); return; }
    loadImageFile(img.getAsFile());
  });

  window.addEventListener('resize', () => { if (ui.view === 'scan' && scan.zoom === 'fit') drawCanvas(); });

  if (cloud.pendingJoin) ui.view = 'cloud';
  render();
  initCloud();
  loadCatalog();
})();
