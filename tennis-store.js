// tennis-store.js
// ADR-001 S3: IndexedDB 薄ラッパー（Promise API）
//
// 役割: window.indexedDB を Promise でラップした最小限の薄層
// 依存: なし（ブラウザの window.indexedDB のみ。Node 環境では動かない）
// 公開: window.store グローバルに API を露出
//
// schema (DB名: tennis-offline-v1, version: 1)
//   config  : keyPath='id'   (固定値 'main')           1件想定
//   members : keyPath='id'   (autoIncrement) + index[team], index[name]   〜50件
//   rounds  : keyPath='round' (整数)                    〜100件
//   history : keyPath='id'   (autoIncrement) + index[round], index[winner] 〜500件
//
// API
//   store.open(dbName?)         → Promise<void>     既定 'tennis-offline-v1'
//   store.put(storeName, value) → Promise<key>      put 後の key を返す
//   store.get(storeName, key)   → Promise<value|undefined>
//   store.getAll(storeName)     → Promise<value[]>
//   store.count(storeName)      → Promise<number>
//   store.delete(storeName, k)  → Promise<void>
//   store.clear(storeName)      → Promise<void>
//
// 注意: 1ラッパー = 1DB のみ保持。open() を別 DB 名で再呼出すると差し替わる。

(function (global) {
  'use strict';

  // 既定 DB 名・バージョン
  const DEFAULT_DB_NAME = 'tennis-offline-v1';
  const DB_VERSION = 1;

  // 4 ストアのスキーマ定義（onupgradeneeded で利用）
  const SCHEMA = [
    {
      name: 'config',
      options: { keyPath: 'id' },
      indexes: [],
    },
    {
      name: 'members',
      options: { keyPath: 'id', autoIncrement: true },
      indexes: [
        { name: 'team', keyPath: 'team', options: { unique: false } },
        { name: 'name', keyPath: 'name', options: { unique: false } },
      ],
    },
    {
      name: 'rounds',
      options: { keyPath: 'round' },
      indexes: [],
    },
    {
      name: 'history',
      options: { keyPath: 'id', autoIncrement: true },
      indexes: [
        { name: 'round', keyPath: 'round', options: { unique: false } },
        { name: 'winner', keyPath: 'winner', options: { unique: false } },
      ],
    },
  ];

  // 現在開いている IDBDatabase インスタンス（open 後にセット）
  let _db = null;
  // 観測用: onupgradeneeded が走ったかどうか（テストで参照する）
  let _upgradeCalled = false;
  // 観測用: 直前 open で作成された store 名の一覧
  let _createdStores = [];

  // IDBRequest を Promise に変換するヘルパー
  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IDBRequest failed'));
    });
  }

  // IDBTransaction を Promise に変換（complete を待つ）
  function txToPromise(tx, resultGetter) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(resultGetter ? resultGetter() : undefined);
      tx.onerror = () => reject(tx.error || new Error('IDBTransaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IDBTransaction aborted'));
    });
  }

  // open: DB を開く（必要なら作成・マイグレーション）
  function open(dbName) {
    const name = dbName || DEFAULT_DB_NAME;
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('indexedDB is not available in this environment'));
        return;
      }
      // 既存接続を閉じてから開く（DB 名差し替え対応）
      if (_db) {
        try { _db.close(); } catch (_) { /* ignore */ }
        _db = null;
      }
      _upgradeCalled = false;
      _createdStores = [];

      const req = indexedDB.open(name, DB_VERSION);

      req.onupgradeneeded = (event) => {
        // 初回作成・version up 時に走る
        _upgradeCalled = true;
        const db = req.result;
        // SCHEMA を順次適用（既存ストアは作らない・新規のみ）
        SCHEMA.forEach((def) => {
          if (!db.objectStoreNames.contains(def.name)) {
            const os = db.createObjectStore(def.name, def.options);
            (def.indexes || []).forEach((ix) => {
              os.createIndex(ix.name, ix.keyPath, ix.options || {});
            });
            _createdStores.push(def.name);
          }
        });
        // 将来の v2 マイグレーションはここに event.oldVersion を見て分岐追加
      };

      req.onsuccess = () => {
        _db = req.result;
        // 接続中に他タブ等で version up があった場合のフォロー
        _db.onversionchange = () => {
          try { _db.close(); } catch (_) { /* ignore */ }
          _db = null;
        };
        resolve();
      };

      req.onerror = () => reject(req.error || new Error('indexedDB.open failed'));
      req.onblocked = () => reject(new Error('indexedDB.open blocked'));
    });
  }

  // _ensureOpen: 各 API 呼出前のガード
  function _ensureOpen() {
    if (!_db) {
      throw new Error('store.open() must be called before any operation');
    }
  }

  // put: 値を書き込み、書き込み後の key を返す
  function put(storeName, value) {
    return new Promise((resolve, reject) => {
      try {
        _ensureOpen();
        const tx = _db.transaction(storeName, 'readwrite');
        const os = tx.objectStore(storeName);
        const req = os.put(value);
        let key;
        req.onsuccess = () => { key = req.result; };
        req.onerror = () => reject(req.error || new Error('put failed'));
        tx.oncomplete = () => resolve(key);
        tx.onerror = () => reject(tx.error || new Error('put tx failed'));
        tx.onabort = () => reject(tx.error || new Error('put tx aborted'));
      } catch (e) {
        reject(e);
      }
    });
  }

  // get: 単一値取得（無ければ undefined）
  function get(storeName, key) {
    return new Promise((resolve, reject) => {
      try {
        _ensureOpen();
        const tx = _db.transaction(storeName, 'readonly');
        const os = tx.objectStore(storeName);
        const req = os.get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('get failed'));
      } catch (e) {
        reject(e);
      }
    });
  }

  // getAll: 全件取得
  function getAll(storeName) {
    return new Promise((resolve, reject) => {
      try {
        _ensureOpen();
        const tx = _db.transaction(storeName, 'readonly');
        const os = tx.objectStore(storeName);
        const req = os.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error || new Error('getAll failed'));
      } catch (e) {
        reject(e);
      }
    });
  }

  // count: 件数取得
  function count(storeName) {
    return new Promise((resolve, reject) => {
      try {
        _ensureOpen();
        const tx = _db.transaction(storeName, 'readonly');
        const os = tx.objectStore(storeName);
        const req = os.count();
        req.onsuccess = () => resolve(req.result || 0);
        req.onerror = () => reject(req.error || new Error('count failed'));
      } catch (e) {
        reject(e);
      }
    });
  }

  // delete: 単一キー削除
  function _delete(storeName, key) {
    return new Promise((resolve, reject) => {
      try {
        _ensureOpen();
        const tx = _db.transaction(storeName, 'readwrite');
        const os = tx.objectStore(storeName);
        const req = os.delete(key);
        req.onerror = () => reject(req.error || new Error('delete failed'));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('delete tx failed'));
      } catch (e) {
        reject(e);
      }
    });
  }

  // clear: ストア全消去
  function clear(storeName) {
    return new Promise((resolve, reject) => {
      try {
        _ensureOpen();
        const tx = _db.transaction(storeName, 'readwrite');
        const os = tx.objectStore(storeName);
        const req = os.clear();
        req.onerror = () => reject(req.error || new Error('clear failed'));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('clear tx failed'));
      } catch (e) {
        reject(e);
      }
    });
  }

  // テスト用観測 API（プロダクションコードからは使わない想定）
  function _debug() {
    return {
      dbName: _db ? _db.name : null,
      dbVersion: _db ? _db.version : null,
      upgradeCalled: _upgradeCalled,
      createdStores: _createdStores.slice(),
      storeNames: _db ? Array.from(_db.objectStoreNames) : [],
    };
  }

  // 公開 API
  const api = {
    open,
    put,
    get,
    getAll,
    count,
    delete: _delete,
    clear,
    _debug, // 検証用（外部仕様ではないが残す）
  };

  // ブラウザ: window.store / Node: module.exports（テスト都合・実害ゼロ）
  if (typeof global !== 'undefined') {
    global.store = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
