// IndexedDB-backed store for the SSTV QSO Card composer — persists composed
// card images (as PNG blobs) across page loads. localStorage tops out around
// 5-10MB and can't hold binary image data at any useful gallery size; IndexedDB
// has no such practical ceiling and stores Blobs natively.
import type { TextLayer, ReplyBox } from './composerSettings';

const DB_NAME = 'sstv-qso-cards';
const DB_VERSION = 1;
const STORE = 'cards';

export interface QSOCard {
  id: string;
  blob: Blob; // flat PNG render — used for the gallery thumbnail/preview/download
  width: number;
  height: number;
  mode: string;
  createdAt: number;
  name: string; // user-editable label so cards stay distinguishable at a glance
  /** Editable state needed to reload this card back into the composer for
   *  further editing — omitted for cards saved before this field existed
   *  (loadAllCards backfills sensible defaults, see there). */
  sourceImageDataUrl: string | null; // the main (non-inset) image, if any was set
  insetImageDataUrl: string | null; // the reply-received-image inset, if any
  layers: TextLayer[];
  replyBoxes: ReplyBox[];
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB not supported'));
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

export async function saveCard(card: QSOCard): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(card);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteCard(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Backfills for records saved before name/sourceImageDataUrl/insetImageDataUrl/
// layers/replyBoxes existed — IndexedDB has no schema, so an older record
// legitimately just lacks these keys rather than having them as undefined.
function withDefaults(card: QSOCard): QSOCard {
  return {
    ...card,
    name: card.name ?? `${card.mode} ${new Date(card.createdAt).toLocaleString()}`,
    sourceImageDataUrl: card.sourceImageDataUrl ?? null,
    insetImageDataUrl: card.insetImageDataUrl ?? null,
    layers: card.layers ?? [],
    replyBoxes: card.replyBoxes ?? [],
  };
}

export async function loadAllCards(): Promise<QSOCard[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve((req.result as QSOCard[]).map(withDefaults).sort((a, b) => b.createdAt - a.createdAt));
    req.onerror = () => reject(req.error);
  });
}

export async function renameCard(id: string, name: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const card = getReq.result as QSOCard | undefined;
      if (card) store.put({ ...card, name });
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearAllCards(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
