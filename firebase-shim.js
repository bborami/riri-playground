// 총무 오피스 ↔ Firebase 연결
// index.html 은 Claude 페이지용 window.claude.use('db' | 'user' | 'room') 인터페이스로 짜여 있어서,
// 같은 모양의 객체를 Firebase(익명 로그인 + Firestore)로 만들어 끼워 넣습니다.
import { firebaseConfig } from './firebase-config.js';

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
    const cred = a.currentUser ? { user: a.currentUser } : await new Promise((res, rej) => {
      const off = auth.onAuthStateChanged(a, u => { if (u) { off(); res({ user: u }); } });
      auth.signInAnonymously(a).catch(e => { off(); rej(e); });
    });
    const uid = cred.user.uid;
    const db = fs.getFirestore(app);

    // 주인 정하기: meta/config 문서가 없으면 처음 연 사람이 주인
    const cfgRef = fs.doc(db, 'meta/config');
    let ownerUid = null;
    try {
      const s = await fs.getDoc(cfgRef);
      if (s.exists()) ownerUid = s.data().ownerUid;
      else { await fs.setDoc(cfgRef, { ownerUid: uid, createdAt: Date.now() }); ownerUid = uid; }
    } catch (e) { try { const s = await fs.getDoc(cfgRef); if (s.exists()) ownerUid = s.data().ownerUid; } catch (_) {} }
    return { fs, db, uid, ownerUid };
  })());

  const mapErr = e => {
    const code = e && e.code;
        if (code === 'unavailable' || code === 'deadline-exceeded') return Object.assign(new Error(e.message), { code: 'unavailable' });
    return e;
  };
  const wrap = p => p.catch(e => { throw mapErr(e); });

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
        onSnapshot: (cb, err) => fs.onSnapshot(fs.collection(db, name), { includeMetadataChanges: false }, cb, e => err && err(mapErr(e))),
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
    const since = Date.now() - 2000;
    const evCol = fs.collection(db, 'events');
    fs.onSnapshot(fs.query(evCol, fs.where('t', '>', since), fs.orderBy('t')), snap => {
      snap.docChanges().forEach(ch => {
        if (ch.type !== 'added') return;
        const v = ch.doc.data();
        (handlers[v.topic] || []).forEach(f => { try { f(v.data); } catch (_) {} });
      });
    }, () => {});
    const emit = async (topic, data) => {
      // 실시간 동기화가 필요한 건 순간 동작(action)뿐. 나머지(hello/snapshot)는 db가 맡음
      if (!data || data.kind !== 'action') return;
      const ref = await fs.addDoc(evCol, { topic, data: JSON.parse(JSON.stringify(data)), t: Date.now(), uid });
      setTimeout(() => fs.deleteDoc(ref).catch(() => {}), 30000);
    };

    // 접속자: 4분마다 하트비트, 10분 안에 본 사람 수
    const peersCbs = [];
    const presRef = fs.doc(db, `presence/${uid}`);
    let name = '';
    const beat = () => { if (document.visibilityState !== 'hidden') fs.setDoc(presRef, { seen: Date.now(), name }).catch(() => {}); };
    beat(); setInterval(beat, 4 * 60 * 1000);
    document.addEventListener('visibilitychange', beat);
    let peers = [];
    fs.onSnapshot(fs.collection(db, 'presence'), snap => {
      const now = Date.now();
      peers = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(p => now - (p.seen || 0) < 10 * 60 * 1000);
      peersCbs.forEach(f => f(peers));
    }, () => {});
    addEventListener('pagehide', () => { fs.deleteDoc(presRef).catch(() => {}); });

    return {
      on: (topic, f) => { (handlers[topic] || (handlers[topic] = [])).push(f); },
      emit,
      onPeers: f => { peersCbs.push(f); f(peers); },
      presence: p => { name = (p && p.name) || ''; beat(); },
    };
  };

  window.claude = {
    use: async kind => {
      const ctx = await boot();
      if (kind === 'db') return makeDb(ctx);
      if (kind === 'user') return makeUser(ctx);
      if (kind === 'room') return makeRoom(ctx);
      return null;
    },
  };
}
