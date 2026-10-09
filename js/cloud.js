/* Firebase 連線：Google 登入、隊伍建立 / 加入 / 退出、隊伍資料即時同步。
 * Firebase SDK 只有在 js/firebase-config.js 有設定時才會從 CDN 載入。 */
(function (root) {
  'use strict';

  const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
  const SDK_FILES = ['firebase-app-compat.js', 'firebase-auth-compat.js', 'firebase-firestore-compat.js'];
  const COLLECTIONS = ['characters', 'icons', 'meta'];

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
    return {
      set: (path, data) => fb.db.doc(base + path).set(data),
      remove: (path) => fb.db.doc(base + path).delete(),
    };
  }

  /* 監看隊伍內所有資料。每份文件變動呼叫 onChange(path, data|null)（回傳 true 表示有改到 state），
   * 每批變動後呼叫 onBatch({ ready, changed })；ready = 三個集合的第一批資料都到了。
   * 自己尚未送達伺服器的寫入（hasPendingWrites）不回報，避免回音。 */
  function watchData(teamId, onChange, onBatch, onError) {
    const loaded = new Set();
    const unsubs = COLLECTIONS.map((coll) =>
      fb.db.collection('teams').doc(teamId).collection(coll).onSnapshot((snap) => {
        let changed = false;
        for (const ch of snap.docChanges()) {
          if (ch.doc.metadata.hasPendingWrites) continue;
          if (onChange(coll + '/' + ch.doc.id, ch.type === 'removed' ? null : ch.doc.data())) changed = true;
        }
        loaded.add(coll);
        onBatch({ ready: loaded.size === COLLECTIONS.length, changed });
      }, onError)
    );
    return () => unsubs.forEach((u) => u());
  }

  root.ArrCloud = {
    configured: () => !!config(),
    init, currentUser, signIn, signOut,
    createTeam, joinTeam, leaveTeam, renameTeam, myTeams, watchTeam, backend, watchData,
  };
})(typeof self !== 'undefined' ? self : this);
