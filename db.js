// DocBot IndexedDB helper.
// Loaded by the service worker (importScripts) and by the popup and report pages (<script>).
// Stores:
//   screenshots : { id, sessionId, blob | dataUrl, timestamp }   (index: sessionId)
//   sessions    : { sessionId, startTime, endTime, url, title, settings, actions[], screenshots[] }

const DocBotDB = (() => {
  const DB_NAME = 'DocBotScreenshots';
  const DB_VERSION = 2;
  let db = null;

  function open() {
    if (db) return Promise.resolve(db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const d = event.target.result;
        let shots;
        if (d.objectStoreNames.contains('screenshots')) {
          shots = event.target.transaction.objectStore('screenshots');
        } else {
          shots = d.createObjectStore('screenshots', { keyPath: 'id' });
        }
        if (!shots.indexNames.contains('sessionId')) {
          shots.createIndex('sessionId', 'sessionId', { unique: false });
        }
        if (!d.objectStoreNames.contains('sessions')) {
          d.createObjectStore('sessions', { keyPath: 'sessionId' });
        }
      };
      req.onsuccess = () => {
        db = req.result;
        db.onclose = () => { db = null; };
        db.onversionchange = () => { db.close(); db = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    });
  }

  // Run one request inside a transaction and resolve with its result.
  async function run(storeName, mode, fn) {
    const d = await open();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(storeName, mode);
      const req = fn(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  return {
    putScreenshot: (record) => run('screenshots', 'readwrite', (s) => s.put(record)),
    getScreenshot: (id) => run('screenshots', 'readonly', (s) => s.get(id)),
    deleteScreenshot: (id) => run('screenshots', 'readwrite', (s) => s.delete(id)),

    async deleteScreenshotsForSession(sessionId) {
      const d = await open();
      return new Promise((resolve, reject) => {
        const tx = d.transaction('screenshots', 'readwrite');
        const index = tx.objectStore('screenshots').index('sessionId');
        const req = index.openKeyCursor(IDBKeyRange.only(sessionId));
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return;
          tx.objectStore('screenshots').delete(cursor.primaryKey);
          cursor.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },

    // Screenshots that predate v2 have no sessionId; remove them.
    async deleteOrphanScreenshots() {
      const d = await open();
      return new Promise((resolve, reject) => {
        const tx = d.transaction('screenshots', 'readwrite');
        const store = tx.objectStore('screenshots');
        const req = store.openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return;
          if (!cursor.value.sessionId) store.delete(cursor.primaryKey);
          cursor.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },

    putSession: (session) => run('sessions', 'readwrite', (s) => s.put(session)),
    getSession: (sessionId) => run('sessions', 'readonly', (s) => s.get(sessionId)),
    deleteSession: (sessionId) => run('sessions', 'readwrite', (s) => s.delete(sessionId)),

    // Newest first.
    async listSessions() {
      const all = (await run('sessions', 'readonly', (s) => s.getAll())) || [];
      return all.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
    },

    // Keep the newest `keep` sessions, delete the rest with their screenshots.
    async pruneSessions(keep) {
      const sessions = await this.listSessions();
      for (const old of sessions.slice(keep)) {
        await this.deleteScreenshotsForSession(old.sessionId);
        await this.deleteSession(old.sessionId);
      }
      return sessions.slice(0, keep);
    }
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = DocBotDB;
}
