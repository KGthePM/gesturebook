/* storage.js — IndexedDB cache for the last-opened PDF's bytes, so a reload can
 * resume without the user re-picking the file. Every call is wrapped so a
 * missing/blocked/broken IndexedDB degrades to a no-op, same spirit as the
 * try/catch-wrapped localStorage access elsewhere in the app. */

const DB_NAME = "gesturebook";
const DB_VERSION = 1;
const STORE = "pdf";
const KEY = "current";

function openDB() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error("no indexedDB"));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
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
