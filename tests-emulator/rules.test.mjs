// Firestore 安全規則測試。需要模擬器：npm run test:rules
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, updateDoc, deleteDoc, collection, query, where, getDocs, arrayUnion, arrayRemove, deleteField } from 'firebase/firestore';

let env;
const TEAM = 'team123456';
const info = (n) => ({ name: n, email: n + '@x.com' });

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-arrange',
    firestore: { rules: fs.readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8080 },
  });
});
after(() => env.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  await admin(async (f) => {
    await setDoc(doc(f, 'teams', TEAM), { name: '隊伍', owner: 'alice', members: ['alice', 'bob'], memberInfo: { alice: info('alice'), bob: info('bob') }, createdAt: 1 });
    await setDoc(doc(f, `teams/${TEAM}/characters/c1`), { name: '劍士', order: 0, inventory: {} });
  });
});
// 每個使用者只建立一次 Firestore 實例（重複呼叫 ctx.firestore() 會出錯）
const cache = new Map();
const db = (uid) => {
  const key = uid || '(anon)';
  if (!cache.has(key)) cache.set(key, (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore());
  return cache.get(key);
};
// 略過規則的管理者寫入（每次都是新的 context，用完即關閉）
const admin = (fn) => env.withSecurityRulesDisabled((ctx) => fn(ctx.firestore()));

test('成員可以讀寫隊伍資料，非成員和未登入不行', async () => {
  await assertSucceeds(getDoc(doc(db('bob'), `teams/${TEAM}/characters/c1`)));
  await assertSucceeds(setDoc(doc(db('bob'), `teams/${TEAM}/characters/c2`), { name: '法師' }));
  await assertSucceeds(setDoc(doc(db('alice'), `teams/${TEAM}/icons/i1`), { name: 'x', feat: [1] }));
  await assertSucceeds(setDoc(doc(db('alice'), `teams/${TEAM}/meta/digits`), { list: [] }));
  await assertSucceeds(deleteDoc(doc(db('bob'), `teams/${TEAM}/characters/c1`)));
  await assertFails(getDoc(doc(db('eve'), `teams/${TEAM}/characters/c1`)));
  await assertFails(setDoc(doc(db('eve'), `teams/${TEAM}/characters/c3`), { name: 'hack' }));
  await assertFails(getDoc(doc(db(null), `teams/${TEAM}/characters/c1`)));
  await assertFails(getDoc(doc(db('eve'), 'teams', TEAM)));
  await assertFails(setDoc(doc(db('bob'), `teams/${TEAM}/other/x`), { a: 1 }));
});

test('建立隊伍：只能把自己設成隊長和唯一成員', async () => {
  await assertSucceeds(setDoc(doc(db('carol'), 'teams', 't2xxxxxx'), { name: 'c', owner: 'carol', members: ['carol'], memberInfo: { carol: info('carol') } }));
  await assertFails(setDoc(doc(db('carol'), 'teams', 't3xxxxxx'), { name: 'c', owner: 'alice', members: ['carol'], memberInfo: {} }));
  await assertFails(setDoc(doc(db('carol'), 'teams', 't4xxxxxx'), { name: 'c', owner: 'carol', members: ['carol', 'alice'], memberInfo: {} }));
  await assertFails(setDoc(doc(db(null), 'teams', 't5xxxxxx'), { name: 'c', owner: 'x', members: ['x'], memberInfo: {} }));
});

test('用邀請碼加入：只能加自己', async () => {
  await assertFails(updateDoc(doc(db('eve'), 'teams', TEAM), { members: arrayUnion('eve', 'mallory'), 'memberInfo.eve': info('eve') }));
  await assertFails(updateDoc(doc(db('eve'), 'teams', TEAM), { members: arrayUnion('eve'), 'memberInfo.eve': info('eve'), name: '被改名' }));
  await assertFails(updateDoc(doc(db('eve'), 'teams', TEAM), { members: arrayUnion('eve'), 'memberInfo.eve': info('eve'), 'memberInfo.alice': info('fake') }));
  await assertSucceeds(updateDoc(doc(db('eve'), 'teams', TEAM), { members: arrayUnion('eve'), 'memberInfo.eve': info('eve') }));
  await assertSucceeds(getDoc(doc(db('eve'), `teams/${TEAM}/characters/c1`)));
});

test('查詢自己的隊伍', async () => {
  const snap = await assertSucceeds(getDocs(query(collection(db('bob'), 'teams'), where('members', 'array-contains', 'bob'))));
  assert.equal(snap.size, 1);
  await assertFails(getDocs(collection(db('bob'), 'teams')));
});

test('成員可改隊名，不能改成員名單或隊長', async () => {
  await assertSucceeds(updateDoc(doc(db('bob'), 'teams', TEAM), { name: '新名字' }));
  await assertFails(updateDoc(doc(db('bob'), 'teams', TEAM), { owner: 'bob' }));
  await assertFails(updateDoc(doc(db('bob'), 'teams', TEAM), { members: arrayRemove('alice') }));
  await assertFails(updateDoc(doc(db('bob'), 'teams', TEAM), { members: arrayUnion('mallory') }));
});

test('退出與移除成員', async () => {
  await assertFails(updateDoc(doc(db('alice'), 'teams', TEAM), { members: arrayRemove('alice'), 'memberInfo.alice': deleteField() }), '隊長不能退出');
  await assertSucceeds(updateDoc(doc(db('bob'), 'teams', TEAM), { members: arrayRemove('bob'), 'memberInfo.bob': deleteField() }));
  await assertFails(getDoc(doc(db('bob'), `teams/${TEAM}/characters/c1`)), '退出後讀不到');
  await admin((f) => updateDoc(doc(f, 'teams', TEAM), { members: arrayUnion('bob') }));
  await assertSucceeds(updateDoc(doc(db('alice'), 'teams', TEAM), { members: arrayRemove('bob'), 'memberInfo.bob': deleteField() }));
  await assertFails(deleteDoc(doc(db('bob'), 'teams', TEAM)));
  await assertSucceeds(deleteDoc(doc(db('alice'), 'teams', TEAM)));
});
