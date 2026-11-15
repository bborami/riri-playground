// 총무 오피스 ↔ Firebase 연결
// index.html 은 Claude 페이지용 window.claude.use('db' | 'user' | 'room') 인터페이스로 짜여 있어서,
// 같은 모양의 객체를 Firebase(익명 로그인 + Firestore)로 만들어 끼워 넣습니다.
// 리리(주인)는 비밀번호 로그인: Firebase Authentication 에 아래 이메일로 만든 계정 하나만 주인이 될 수 있어요.
import { firebaseConfig } from './firebase-config.js';
const RIRI_EMAIL = 'riri@riri-playground.app';

const V = '10.12.2';
const BASE = `https://www.gstatic.com/firebasejs/${V}`;

if (firebaseConfig && firebaseConfig.apiKey && firebaseConfig.projectId) {
  let ready = null;
  const boot = () => ready || (ready = (async () => {
    const [{ initializeApp }, auth, fs] = await Promise.all([
      import(`${BASE}/firebase-app.js`), import(`${BASE}/firebase-auth.js`), import(`${BASE}/firebase-firestore.js`)]);
    const app = initializeApp(firebaseConfig);
    const a = auth.getAuth(app);
    await auth.setPersistence(a, auth.browserLocalPersistence).catch(() => {});
    await a.authStateReady();
    if (!a.currentUser) await auth.signInAnonymously(a);
    const user = a.currentUser;
    const uid = user.uid;
    const isRiri = !user.isAnonymous && user.email === RIRI_EMAIL;
    const db = fs.getFirestore(app);

    // 주인 정하기: 리리 계정으로 처음 로그인하면 meta/config 에 주인으로 기록 (규칙에서 비번 로그인만 허용)
    const cfgRef = fs.doc(db, 'meta/config');
    let ownerUid = null;
    try {
      const s = await fs.getDoc(cfgRef);
      if (s.exists()) ownerUid = s.data().ownerUid;
      else if (isRiri) { await fs.setDoc(cfgRef, { ownerUid: uid, createdAt: Date.now() }); ownerUid = uid; }
    } catch (e) { try { const s = await fs.getDoc(cfgRef); if (s.exists()) ownerUid = s.data().ownerUid; } catch (_) {} }
    return { fs, db, uid, ownerUid, auth, a, isRiri };
  })());

  const mapErr = e => {
    const code = e && e.code;
        if (code === 'unavailable' || code === 'deadline-exceeded') return Object.assign(new Error(e.message), { code: 'unavailable' });
    return e;
  };
  const wrap = p => p.catch(e => { throw mapErr(e); });

  // 탭을 3분 넘게 안 보면 실시간 구독을 잠시 끊어서 읽기 횟수를 아껴요 (다시 보면 자동으로 다시 연결)
  const liveListen = start => {
    let unsub = start(), timer = null;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { clearTimeout(timer); timer = setTimeout(() => { if (unsub) { unsub(); unsub = null; } }, 3 * 60 * 1000); }
      else { clearTimeout(timer); if (!unsub) unsub = start(); }
    });
    return () => { clearTimeout(timer); if (unsub) unsub(); unsub = null; };
  };

  const makeDb = ({ fs, db }) => {
    const doc = path => {
      const ref = fs.doc(db, path);
      return {
        id: ref.id, path,
        get: () => wrap(fs.getDoc(ref)).then(s => ({ id: s.id, exists: s.exists(), data: () => s.data(), metadata: s.metadata })),
        set: data => wrap(fs.setDoc(ref, data)),
        update: data => wrap(fs.updateDoc(ref, data)),
        delete: () => wrap(fs.deleteDoc(ref)),
      };
    };
    return {
      doc,
      collection: name => ({
        doc: id => doc(`${name}/${id}`),
        onSnapshot: (cb, err) => liveListen(() => fs.onSnapshot(fs.collection(db, name), cb, e => err && err(mapErr(e)))),
      }),
    };
  };

  const makeUser = ({ uid, ownerUid }) => ({
    id: async () => uid,
    isOwner: async () => !!ownerUid && ownerUid === uid,
    canEdit: async () => !!ownerUid && ownerUid === uid,
    can: async () => true,
  });

  // room 대신: 담타/소리지르기 같은 순간 이벤트는 events 컬렉션, 접속자 수는 presence 컬렉션
  const makeRoom = ({ fs, db, uid }) => {
    const handlers = {};
    const evCol = fs.collection(db, 'events');
    liveListen(() => fs.onSnapshot(fs.query(evCol, fs.where('t', '>', Date.now() - 2000), fs.orderBy('t')), snap => {
      snap.docChanges().forEach(ch => {
        if (ch.type !== 'added') return;
        const v = ch.doc.data();
        (handlers[v.topic] || []).forEach(f => { try { f(v.data); } catch (_) {} });
      });
    }, () => {}));
    const emit = async (topic, data) => {
      // 실시간 동기화가 필요한 건 순간 동작(action)뿐. 나머지(hello/snapshot)는 db가 맡음
      if (!data || data.kind !== 'action') return;
      const ref = await fs.addDoc(evCol, { topic, data: JSON.parse(JSON.stringify(data)), t: Date.now(), uid });
      setTimeout(() => fs.deleteDoc(ref).catch(() => {}), 30000);
    };

    // 접속자 수: 5분마다 '나 있어요' 기록 + 최근 10분 안에 기록한 사람 수를 한 번 세기 (실시간 구독 없음)
    const peersCbs = [];
    const presRef = fs.doc(db, `presence/${uid}`);
    let name = '', lastBeat = 0, peers = 0;
    const beat = (force) => {
      if (document.visibilityState === 'hidden') return;
      if (!force && Date.now() - lastBeat < 4.5 * 60 * 1000) return;
      lastBeat = Date.now();
      fs.setDoc(presRef, { seen: Date.now(), name }).catch(() => {});
    };
    const count = async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        const r = await fs.getCountFromServer(fs.query(fs.collection(db, 'presence'), fs.where('seen', '>', Date.now() - 10 * 60 * 1000)));
        peers = r.data().count; peersCbs.forEach(f => f(peers));
      } catch (_) {}
    };
    beat(true); setTimeout(count, 1500);
    setInterval(() => { beat(); count(); }, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { beat(); } });
    return {
      on: (topic, f) => { (handlers[topic] || (handlers[topic] = [])).push(f); },
      emit,
      onPeers: f => { peersCbs.push(f); if (peers) f(peers); },
      presence: p => { name = (p && p.name) || ''; },
    };
  };

  window.claude = {
    // 리리 비밀번호 로그인 / 로그아웃 (성공하면 새로고침)
    ririLogin: async pw => {
      const { auth, a } = await boot();
      await auth.signInWithEmailAndPassword(a, RIRI_EMAIL, pw);
      location.reload();
    },
    ririLogout: async () => { const { auth, a } = await boot(); await auth.signOut(a); location.reload(); },
    isRiri: async () => (await boot()).isRiri,
    use: async kind => {
      const ctx = await boot();
      if (kind === 'db') return makeDb(ctx);
      if (kind === 'user') return makeUser(ctx);
      if (kind === 'room') return makeRoom(ctx);
      return null;
    },
  };
}
