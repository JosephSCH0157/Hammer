type AssetRecord = {
  assetId: string;
  blob: Blob;
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
};

const DB_NAME = "hammer-db";
const STORE_NAME = "assets";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

const openDb = (): Promise<IDBDatabase> => {
  if (dbPromise) {
    return dbPromise;
  }
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB not available"));
  }
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "assetId" });
      }
    };
    request.onerror = () => {
      const errorName = request.error?.name ?? "UnknownError";
      dbPromise = null;
      reject(new Error(`IndexedDB open failed (${errorName})`));
    };
    request.onblocked = () => {
      dbPromise = null;
      reject(
        new Error(
          "IndexedDB open blocked (another tab may be using an old connection). Close other tabs and retry.",
        ),
      );
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
  });
  return dbPromise;
};

const requestToPromise = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed"));
  });

const transactionToPromise = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () =>
      reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });

export const putAssetRecord = async (record: AssetRecord): Promise<void> => {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  await requestToPromise(store.put(record));
  await transactionToPromise(tx);
};

export const getAssetRecord = async (
  assetId: string,
): Promise<AssetRecord | null> => {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, "readonly");
  const store = tx.objectStore(STORE_NAME);
  const record = await requestToPromise(store.get(assetId));
  await transactionToPromise(tx);
  return record ?? null;
};
