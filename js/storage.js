/* storage.js — IndexedDB cache for the last-opened PDF's bytes, so a reload can
 * resume without the user re-picking the file, plus a lightweight "library" of
 * recent PDFs (metadata + an optional FileSystemFileHandle — never bytes, so
 * the library links back to the file on disk instead of storing a copy).
 * Every call is wrapped so a missing/blocked/broken IndexedDB degrades to a
 * no-op, same spirit as the try/catch-wrapped localStorage access elsewhere
 * in the app. */

const DB_NAME = "gesturebook";
const DB_VERSION = 2;
const STORE = "pdf";
const KEY = "current";
const LIBRARY_STORE = "library";
const LIBRARY_CAP = 6;

function openDB() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error("no indexedDB"));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      if (!req.result.objectStoreNames.contains(LIBRARY_STORE)) req.result.createObjectStore(LIBRARY_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function savePdf(name, bytes) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ name, size: bytes.byteLength, bytes, savedAt: Date.now() }, KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (_) { /* storage unavailable — non-fatal */ }
}

export async function loadPdf() {
  try {
    const db = await openDB();
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return record;
  } catch (_) {
    return null;
  }
}

export async function clearPdf() {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (_) { /* storage unavailable — non-fatal */ }
}

/* ---------- library: recent PDFs, linked (not copied) ---------- */

export async function saveLibraryEntry(entry) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(LIBRARY_STORE, "readwrite");
      const store = tx.objectStore(LIBRARY_STORE);
      const getReq = store.get(entry.name);
      getReq.onsuccess = () => {
        const merged = { ...(getReq.result || {}), ...entry };
        store.put(merged, entry.name);
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    await trimLibrary(db);
    db.close();
  } catch (_) { /* storage unavailable — non-fatal */ }
}

async function trimLibrary(db) {
  const all = await new Promise((resolve, reject) => {
    const tx = db.transaction(LIBRARY_STORE, "readonly");
    const req = tx.objectStore(LIBRARY_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  if (all.length <= LIBRARY_CAP) return;
  const excess = all.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)).slice(LIBRARY_CAP);
  await new Promise((resolve, reject) => {
    const tx = db.transaction(LIBRARY_STORE, "readwrite");
    const store = tx.objectStore(LIBRARY_STORE);
    for (const e of excess) store.delete(e.name);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function listLibrary() {
  try {
    const db = await openDB();
    const all = await new Promise((resolve, reject) => {
      const tx = db.transaction(LIBRARY_STORE, "readonly");
      const req = tx.objectStore(LIBRARY_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return all.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  } catch (_) {
    return [];
  }
}

export async function touchLibraryPosition(name, { spread, page, mode }) {
  if (!name) return;
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(LIBRARY_STORE, "readwrite");
      const store = tx.objectStore(LIBRARY_STORE);
      const getReq = store.get(name);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (!existing) return;   // no-op — nothing to update yet
        store.put({ ...existing, spread, page, mode, savedAt: Date.now() }, name);
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (_) { /* storage unavailable — non-fatal */ }
}

export async function deleteLibraryEntry(name) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(LIBRARY_STORE, "readwrite");
      tx.objectStore(LIBRARY_STORE).delete(name);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (_) { /* storage unavailable — non-fatal */ }
}
