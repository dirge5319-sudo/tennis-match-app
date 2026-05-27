// ADR-001 Phase 3 (PWA化) 2026-05-26: Service Worker
// ----------------------------------------------------------------------
// 役割:
//   - tennis-offline.html とその依存資産を precache
//   - fetch ハンドラで戦略を分岐
//       * HTML navigation (mode==='navigate'): network-first
//         → 新版がデプロイされた時に旧キャッシュで詰まないよう、まずネットワークを試みる
//         → 失敗時のみ cache fallback（オフライン起動可能性は維持）
//       * 静的アセット (js/css/json/svg 等): cache-first
//         → 高速化と帯域節約のため
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
//   - 2026-05-26b: スマホ致命バグ修正に伴いバンプ。旧キャッシュ強制更新。
//   - 2026-05-27 v3: 3エージェント独立分析 (mobile-developer/frontend-developer/qa-engineer)
//     による真因4点修正 (pointer-events:none / .rc-pair padding+margin / hashchange close /
//     catch touchAction クリア) に伴いバンプ。旧キャッシュ強制更新。
//   - 2026-05-27 v4: swap モーダル候補2大バグ修正 (usedInRound 同名重複除外 +
//     dbGetRounds idx を r.matches 実 idx に修正 + 本人候補除外 + 候補ゼロUX) に伴いバンプ。

const CACHE_NAME = 'tennis-offline-v4-20260527';

// precache 対象（manifest と同じ相対パス・全て同一フォルダ配下）
const ASSETS = [
  './',
  './tennis-offline.html',
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

// fetch ハンドラ:
//   - GET 以外は素通し
//   - HTML navigation は network-first（新版を取りにいく / 失敗時のみ cache）
//   - それ以外は cache-first（高速化）
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // HTML navigation 判定:
  //   - req.mode === 'navigate'（最上位 navigation）
  //   - もしくは Accept ヘッダに text/html を含むリクエスト（保険）
  const acceptHeader = req.headers && req.headers.get ? req.headers.get('accept') : '';
  const isNavigation = req.mode === 'navigate' ||
    (typeof acceptHeader === 'string' && acceptHeader.indexOf('text/html') !== -1);

  if (isNavigation) {
    // network-first: ネットワーク成功時はキャッシュも更新、失敗時のみキャッシュにフォールバック
    event.respondWith(
      fetch(req).then((res) => {
        try {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        } catch (_) { /* cache 更新失敗は無視 */ }
        return res;
      }).catch(() => caches.match(req).then((cached) => cached || caches.match('./tennis-offline.html')))
    );
    return;
  }

  // 静的アセット: cache-first
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req))
  );
});
