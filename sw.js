// ADR-001 Phase 3 (PWA化) 2026-05-26: Service Worker
// ----------------------------------------------------------------------
// 役割:
//   - tennis-offline.html とその依存資産を precache
//   - fetch ハンドラで cache-first 戦略（オフライン起動可能化）
//   - install / activate で旧 cache を掃除
//
// 仕様メモ:
//   - file:// では Service Worker は動作しない（仕様）
//   - http(s):// 配信時のみ tennis-offline.html から ./sw.js として登録される
//   - 既存 file:// ダブルクリック起動を壊さないため、本ファイルが存在しても
//     file:// 経由ではブラウザが Service Worker を有効化しない（無害）
//
// キャッシュ更新運用:
//   - CACHE_NAME のバージョン文字列を上げると、activate イベントで旧 cache を削除し
//     新 cache に切り替わる（明示的更新トリガー）

// GitHub Pages 公開版 (index.html リネーム + cache 更新)
const CACHE_NAME = 'tennis-offline-v2-20260526-ghpages';

// precache 対象（manifest と同じ相対パス・全て同一フォルダ配下）
const ASSETS = [
  './',
  './index.html',
  './tennis-core.js',
  './tennis-store.js',
  './tennis-offline-io.js',
  './manifest.webmanifest',
  './icon.svg',
];

// install: 全アセットを cache に取り込む
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  // 新しい SW を即座に有効化（次回リロード時から動く）
  self.skipWaiting();
});

// activate: バージョン違いの旧 cache を削除
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  // 全クライアントに即適用（タブを閉じずに有効化）
  self.clients.claim();
});

// fetch: cache-first → 無ければ network → どちらも失敗時はそのまま fetch エラー
self.addEventListener('fetch', (event) => {
  // GET 以外（POST/PUT 等）はそのまま素通し（IndexedDB は別レイヤなのでここでは対象外）
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request);
    })
  );
});
