// IndexedDB: пари, шматки аудіо (з розпізнаним текстом), частини запису диктофона, налаштування.

const DB_NAME = 'konspekt';
const VERSION = 1;
let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('lectures', { keyPath: 'id' });
      db.createObjectStore('chunks', { keyPath: 'key' }).createIndex('lectureId', 'lectureId');
      db.createObjectStore('parts', { keyPath: 'key' }).createIndex('lectureId', 'lectureId');
      db.createObjectStore('settings', { keyPath: 'k' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const done = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function store(name, mode = 'readonly') {
  return (await open()).transaction(name, mode).objectStore(name);
}

// ── Пари ──
export async function listLectures() {
  const all = await done((await store('lectures')).getAll());
  return all.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.createdAt - a.createdAt);
}
export async function getLecture(id) { return done((await store('lectures')).get(id)); }
export async function putLecture(l) { l.updatedAt = Date.now(); return done((await store('lectures', 'readwrite')).put(l)); }

/** Атомарне читання-зміна-запис, щоб обробка у фоні й дії в інтерфейсі не затирали одне одного. */
export async function updateLecture(id, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('lectures', 'readwrite');
    const st = tx.objectStore('lectures');
    let result;
    st.get(id).onsuccess = (e) => {
      const l = e.target.result;
      if (!l) return;
      fn(l);
      l.updatedAt = Date.now();
      st.put(l);
      result = l;
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteLecture(id) {
  await deleteChunks(id);
  await deleteParts(id);
  return done((await store('lectures', 'readwrite')).delete(id));
}

// ── Шматки аудіо: key = "<id>:<000>" ──
const ck = (id, i) => `${id}:${String(i).padStart(3, '0')}`;
export async function getChunk(id, i) { return done((await store('chunks')).get(ck(id, i))); }
export async function putChunk(c) { c.key = ck(c.lectureId, c.index); return done((await store('chunks', 'readwrite')).put(c)); }
export async function getChunks(id) {
  const st = await store('chunks');
  const all = await done(st.index('lectureId').getAll(id));
  return all.sort((a, b) => a.index - b.index);
}
/** Лише метадані (без blob) — для плеєра й прогресу */
export async function getChunkMeta(id) {
  return (await getChunks(id)).map(({ index, start, duration, done: d, mime }) => ({ index, start, duration, done: d, mime, hasAudio: true }));
}
async function deleteBy(storeName, id) {
  const st = await store(storeName, 'readwrite');
  const keys = await done(st.index('lectureId').getAllKeys(id));
  await Promise.all(keys.map((k) => done(st.delete(k))));
}
export const deleteChunks = (id) => deleteBy('chunks', id);

// ── Частини диктофонного запису (кожні 15 с), щоб не втратити запис при збої ──
export async function putPart(p) {
  p.key = `${p.lectureId}:${String(p.seg).padStart(3, '0')}:${String(p.part).padStart(5, '0')}`;
  return done((await store('parts', 'readwrite')).put(p));
}
export async function getParts(id) {
  const all = await done((await store('parts')).index('lectureId').getAll(id));
  return all.sort((a, b) => a.key.localeCompare(b.key));
}
export const deleteParts = (id) => deleteBy('parts', id);
export async function deletePartsByKey(keys) {
  const st = await store('parts', 'readwrite');
  await Promise.all(keys.map((k) => done(st.delete(k))));
}

// ── Налаштування ──
const DEFAULTS = {
  openaiKey: '',
  anthropicKey: '',
  myName: '',
  sttModel: 'whisper-1',
  summaryProvider: 'anthropic',
  anthropicModel: 'claude-opus-5-5',
  openaiModel: 'gpt-4.1-mini',
  theme: 'auto',
  onboarded: false,
};
export async function getSettings() {
  const rows = await done((await store('settings')).getAll());
  const s = { ...DEFAULTS };
  rows.forEach((r) => { s[r.k] = r.v; });
  return s;
}
export async function setSetting(k, v) { return done((await store('settings', 'readwrite')).put({ k, v })); }

// ── Резервна копія (без аудіо) ──
export async function exportBackup() {
  const lectures = await listLectures();
  return { app: 'konspekt-pary', version: 1, exportedAt: new Date().toISOString(), lectures };
}
export async function importBackup(data) {
  if (data?.app !== 'konspekt-pary' || !Array.isArray(data.lectures)) throw new Error('Це не резервна копія «Конспекту пари».');
  for (const l of data.lectures) {
    // Аудіо в копію не входить, тож незавершену обробку продовжити не вийде
    if (l.status !== 'ready') { l.status = l.paragraphs?.length ? 'ready' : 'error'; l.error = l.error || 'Обробку не завершено до створення копії.'; }
    l.hasAudio = false;
    await putLecture(l);
  }
  return data.lectures.length;
}

export async function clearAll() {
  const db = await open();
  const tx = db.transaction(['lectures', 'chunks', 'parts'], 'readwrite');
  ['lectures', 'chunks', 'parts'].forEach((n) => tx.objectStore(n).clear());
  return new Promise((r, j) => { tx.oncomplete = r; tx.onerror = () => j(tx.error); });
}
