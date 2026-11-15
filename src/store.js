// Local persistence: everything lives in this browser's IndexedDB.
// "docs" holds JSON (profile, items, last outfit, last trip); "photos" holds image Blobs.
const DB_NAME = "closet-stylist";
let dbPromise;

function open() {
  return (dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("docs");
      req.result.createObjectStore("photos");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function getAllDocs() {
  const db = await open();
  return new Promise((resolve, reject) => {
    const out = {};
    const t = db.transaction("docs");
    const cur = t.objectStore("docs").openCursor();
    cur.onsuccess = () => { const c = cur.result; if (c) { out[c.key] = c.value; c.continue(); } };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
  });
}

export const putDoc = (key, value) => run("docs", "readwrite", s => s.put(value, key));
export const delDoc = key => run("docs", "readwrite", s => s.delete(key));

const urls = new Map();

export async function putPhoto(blob) {
  const id = crypto.randomUUID();
  await run("photos", "readwrite", s => s.put(blob, id));
  urls.set(id, URL.createObjectURL(blob));
  return id;
}

export const getPhoto = id => run("photos", "readonly", s => s.get(id));

export async function delPhoto(id) {
  if (urls.has(id)) { URL.revokeObjectURL(urls.get(id)); urls.delete(id); }
  await run("photos", "readwrite", s => s.delete(id));
}

// Object URLs are created once per photo so templates can use photoUrl() synchronously.
export async function loadPhotoUrls(ids) {
  for (const id of ids) {
    if (urls.has(id)) continue;
    const blob = await getPhoto(id);
    if (blob) urls.set(id, URL.createObjectURL(blob));
  }
}

export const photoUrl = id => urls.get(id) || "";

// Ask the browser not to evict the wardrobe under storage pressure (best effort).
export const persist = () => navigator.storage?.persist?.().catch(() => false);
