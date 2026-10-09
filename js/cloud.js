/* Firebase 連線：Google 登入、隊伍建立 / 加入 / 退出、隊伍資料即時同步。
 * Firebase SDK 只有在 js/firebase-config.js 有設定時才會從 CDN 載入。 */
(function (root) {
  'use strict';

  const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
  const SDK_FILES = ['firebase-app-compat.js', 'firebase-auth-compat.js', 'firebase-firestore-compat.js'];

  let fb = null; // { auth, db }
  let initPromise = null;

  function config() {
    return root.ARR_FIREBASE_CONFIG || null;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('無法載入 ' + src));
      document.head.appendChild(s);
    });
  }

  /* 載入 SDK 並初始化；onUser(user|null) 會在登入狀態改變時呼叫。 */
  function init(onUser) {
    if (!initPromise) {
      initPromise = (async () => {
        const cfg = config();
        if (!cfg) throw new Error('尚未設定 Firebase');
        for (const f of SDK_FILES) if (!root.firebase || !hasPart(f)) await loadScript(SDK + f);
        const app = root.firebase.apps.length ? root.firebase.app() : root.firebase.initializeApp(cfg);
        const auth = app.auth();
        const db = app.firestore();
        if (cfg.emulator) {
          // 開發測試用：連到本機模擬器
          auth.useEmulator(cfg.emulator.auth || 'http://127.0.0.1:9099');
          const [host, port] = (cfg.emulator.firestore || '127.0.0.1:8080').split(':');
          db.useEmulator(host, Number(port));
        }
        fb = { auth, db };
        return fb;
      })();
      initPromise.catch(() => { initPromise = null; });
    }
    return initPromise.then((f) => {
      if (onUser) f.auth.onAuthStateChanged(onUser);
      return f;
    });
  }

  function hasPart(file) {
    const fbns = root.firebase;
    if (file.includes('auth')) return typeof fbns.auth === 'function';
    if (file.includes('firestore')) return typeof fbns.firestore === 'function';
    return true;
  }

  function currentUser() {
    return fb && fb.auth.currentUser;
  }

  function signIn() {
    const provider = new root.firebase.auth.GoogleAuthProvider();
    return fb.auth.signInWithPopup(provider);
  }

  function signOut() {
    return fb.auth.signOut();
  }

  function memberInfo(user) {
    return { name: user.displayName || '', email: user.email || '' };
  }

  async function createTeam(name) {
    const u = currentUser();
    const ref = await fb.db.collection('teams').add({
      name: String(name || '').trim().slice(0, 40) || '我的隊伍',
      owner: u.uid,
      members: [u.uid],
      memberInfo: { [u.uid]: memberInfo(u) },
      createdAt: Date.now(),
    });
    return ref.id;
  }

  /* 用邀請碼加入：只把自己加進成員名單（規則不允許改別的東西）。 */
  async function joinTeam(teamId) {
    const u = currentUser();
    const FieldValue = root.firebase.firestore.FieldValue;
    await fb.db.collection('teams').doc(teamId).update({
      members: FieldValue.arrayUnion(u.uid),
      ['memberInfo.' + u.uid]: memberInfo(u),
    });
  }

  async function leaveTeam(teamId, uid) {
    const FieldValue = root.firebase.firestore.FieldValue;
    const id = uid || currentUser().uid;
    await fb.db.collection('teams').doc(teamId).update({
      members: FieldValue.arrayRemove(id),
      ['memberInfo.' + id]: FieldValue.delete(),
    });
  }

  function renameTeam(teamId, name) {
    return fb.db.collection('teams').doc(teamId).update({ name: String(name || '').trim().slice(0, 40) || '我的隊伍' });
  }

  async function myTeams() {
    const u = currentUser();
    const snap = await fb.db.collection('teams').where('members', 'array-contains', u.uid).get();
    return snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
  }

  /* 監看隊伍文件本身（名稱、成員）。被移出隊伍時 onError 會收到 permission-denied。 */
  function watchTeam(teamId, onData, onError) {
    return fb.db.collection('teams').doc(teamId).onSnapshot(
      (snap) => (snap.exists ? onData(Object.assign({ id: snap.id }, snap.data())) : onError(new Error('隊伍不存在'))),
      onError
    );
  }

  /* 給 ArrSync 用的 backend。 */
  function backend(teamId) {
    const base = 'teams/' + teamId + '/';
    // 刪除集中成批次（每批最多 400 筆）一次送出：舊版圖示搬家時可能要刪幾百份文件
    let queue = null;
    return {
      set: (path, data) => fb.db.doc(base + path).set(data),
      remove: (path) => {
        if (!queue) {
          const q = { paths: [] };
          q.done = Promise.resolve().then(async () => {
            queue = null;
            for (let i = 0; i < q.paths.length; i += 400) {
              const batch = fb.db.batch();
              for (const p of q.paths.slice(i, i + 400)) batch.delete(fb.db.doc(base + p));
              await batch.commit();
            }
          });
          queue = q;
        }
        queue.paths.push(path);
        return queue.done;
      },
    };
  }

  /* 監看隊伍內所有資料。每份文件變動呼叫 onChange(path, data|null)（回傳 true 表示有改到 state），
   * 每批變動後呼叫 onBatch({ ready, changed })；ready = 三個集合的第一批資料都到了。
   * 自己尚未送達伺服器的寫入（hasPendingWrites）不回報，避免回音。 */
  function watchData(teamId, onChange, onBatch, onError) {
    const loaded = new Set();
    const total = 3;
    const team = fb.db.collection('teams').doc(teamId);
    const unsubs = ['characters', 'icons'].map((coll) =>
      team.collection(coll).onSnapshot((snap) => {
        let changed = false;
        for (const ch of snap.docChanges()) {
          if (ch.doc.metadata.hasPendingWrites) continue;
          if (onChange(coll + '/' + ch.doc.id, ch.type === 'removed' ? null : ch.doc.data())) changed = true;
        }
        loaded.add(coll);
        onBatch({ ready: loaded.size === total, changed });
      }, onError)
    );
    // meta 只監看數字模板；圖鑑（meta/catalog-*）很大，只在有新版本時另外下載
    unsubs.push(team.collection('meta').doc('digits').onSnapshot((snap) => {
      let changed = false;
      if (!snap.metadata.hasPendingWrites) changed = onChange('meta/digits', snap.exists ? snap.data() : null);
      loaded.add('meta');
      onBatch({ ready: loaded.size === total, changed });
    }, onError));
    return () => unsubs.forEach((u) => u());
  }

  /* ---------- 隊伍共用的道具圖鑑 ----------
   * 圖鑑打包成幾份大文件（meta/catalog-0、catalog-1…，每份 < 1MB），版本資訊在 meta/catalogInfo。
   * 同一份文件內相同的圖片只存一次（例如所有 60% 捲軸）。 */
  const CHUNK_LIMIT = 700000;

  function packCatalog(items) {
    const chunks = [];
    let cur = null, size = 0, idx = null;
    const start = () => { cur = { items: [], imgs: [] }; size = 0; idx = new Map(); };
    start();
    for (const it of items) {
      const need = (idx.has(it.img) ? 0 : it.img.length) + 200 + (it.name.length + (it.nameEn || '').length) * 3;
      if (cur.items.length && size + need > CHUNK_LIMIT) { chunks.push(cur); start(); }
      let k = idx.get(it.img);
      if (k === undefined) { k = cur.imgs.length; cur.imgs.push(it.img); idx.set(it.img, k); }
      cur.items.push({ id: it.id, name: it.name, nameEn: it.nameEn || '', section: it.section || '', category: it.category || '', img: k });
      size += need;
    }
    if (cur.items.length) chunks.push(cur);
    return chunks;
  }

  async function uploadCatalog(teamId, items, onProgress) {
    const meta = fb.db.collection('teams').doc(teamId).collection('meta');
    const prev = await meta.doc('catalogInfo').get();
    const prevChunks = prev.exists ? Number(prev.data().chunks) || 0 : 0;
    const chunks = packCatalog(items);
    for (let i = 0; i < chunks.length; i++) {
      await meta.doc('catalog-' + i).set(chunks[i]);
      if (onProgress) onProgress((i + 1) / (chunks.length + 1));
    }
    for (let i = chunks.length; i < prevChunks; i++) await meta.doc('catalog-' + i).delete();
    const u = currentUser();
    const info = { version: Date.now(), chunks: chunks.length, count: items.length, by: u.uid, byName: u.displayName || u.email || '' };
    await meta.doc('catalogInfo').set(info);
    return info;
  }

  async function downloadCatalog(teamId, info, onProgress) {
    const meta = fb.db.collection('teams').doc(teamId).collection('meta');
    const items = [];
    for (let i = 0; i < info.chunks; i++) {
      const snap = await meta.doc('catalog-' + i).get();
      if (!snap.exists) continue;
      const d = snap.data();
      for (const it of d.items || []) items.push(Object.assign({}, it, { img: (d.imgs || [])[it.img] || '' }));
      if (onProgress) onProgress((i + 1) / info.chunks);
    }
    return items;
  }

  /* 監看隊伍圖鑑的版本資訊；自己剛寫入、還沒送達的不回報。 */
  function watchCatalogInfo(teamId, onInfo) {
    return fb.db.collection('teams').doc(teamId).collection('meta').doc('catalogInfo').onSnapshot((snap) => {
      if (snap.metadata.hasPendingWrites) return;
      onInfo(snap.exists ? snap.data() : null);
    }, () => onInfo(null));
  }

  root.ArrCloud = {
    configured: () => !!config(),
    init, currentUser, signIn, signOut,
    createTeam, joinTeam, leaveTeam, renameTeam, myTeams, watchTeam, backend, watchData,
    uploadCatalog, downloadCatalog, watchCatalogInfo, packCatalog,
  };
})(typeof self !== 'undefined' ? self : this);
