const DATABASE_NAME = 'super-pdf-studio';
const STORE_NAME = 'recent-pdfs';
const DATABASE_VERSION = 1;
const MAX_RECENT_FILES = 12;

function openDatabase() {
  if (!('indexedDB' in globalThis)) {
    return Promise.reject(new Error('Local PDF history is not available in this browser.'));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('openedAt', 'openedAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open local PDF history.'));
    request.onblocked = () => reject(new Error('Local PDF history is blocked by another app window.'));
  });
}

export async function getRecentPdfs() {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result.sort((a, b) => b.openedAt - a.openedAt));
      request.onerror = () => reject(request.error || new Error('Could not read local PDF history.'));
      transaction.onabort = () => reject(transaction.error || new Error('Could not read local PDF history.'));
    });
  } finally {
    database.close();
  }
}

export async function saveRecentPdf(record) {
  const database = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      store.put({
        id: record.id,
        name: record.name,
        bytes: record.bytes.slice(),
        size: record.bytes.byteLength,
        openedAt: record.openedAt
      });
      const request = store.getAll();
      request.onsuccess = () => {
        const records = request.result.sort((a, b) => b.openedAt - a.openedAt);
        for (const expired of records.slice(MAX_RECENT_FILES)) store.delete(expired.id);
      };
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Could not save PDF in local history.'));
      transaction.onabort = () => reject(transaction.error || new Error('Could not save PDF in local history.'));
    });
  } finally {
    database.close();
  }
}

export async function removeRecentPdf(id) {
  const database = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).delete(id);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Could not remove PDF from local history.'));
      transaction.onabort = () => reject(transaction.error || new Error('Could not remove PDF from local history.'));
    });
  } finally {
    database.close();
  }
}

export async function clearRecentPdfs() {
  const database = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).clear();
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Could not clear local PDF history.'));
      transaction.onabort = () => reject(transaction.error || new Error('Could not clear local PDF history.'));
    });
  } finally {
    database.close();
  }
}
