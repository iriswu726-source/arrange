/* 雲端共用設定。
 * 到 Firebase 主控台「專案設定 → 一般 → 你的應用程式 → SDK 設定和配置」，
 * 把 firebaseConfig 的內容貼在下面（取代 null）。這些值不是密碼，可以公開放在網站上，
 * 資料安全由 firestore.rules 保護。保持 null 就只用本機模式。
 *
 * 範例：
 * window.ARR_FIREBASE_CONFIG = {
 *   apiKey: 'AIza...',
 *   authDomain: 'your-project.firebaseapp.com',
 *   projectId: 'your-project',
 *   appId: '1:123:web:abc',
 * };
 */
window.ARR_FIREBASE_CONFIG = null;
