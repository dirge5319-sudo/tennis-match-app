# テニス対戦管理アプリ

完全オフラインで動くテニス対戦管理 PWA。
ペア組み合わせ・対戦カード生成・スコア集計までスマホ1台で完結。

公開URL: https://dirge5319-sudo.github.io/tennis-match-app/

## 使い方

### スマホ
1. 公開URLを Safari / Chrome で開く
2. iOS: 共有メニュー → ホーム画面に追加
3. Android: メニュー → アプリをインストール

### PC
1. 公開URLを Chrome / Edge で開く
2. アドレスバー右端の「インストール」アイコンをクリック

インストール後はネット接続なしで起動可能 (Service Worker + IndexedDB)。

## 機能
- メンバー管理 (チームA / チームB)
- 個別ミックス希望 (多め / 少なめ / なし)
- ラウンド自動生成 (組み合わせ最適化)
- スコア入力 / 成績集計
- アルゴリズム調整 (優先順位の重みを変更可能)
- 完全オフライン (IndexedDB に永続化)
- JSON エクスポート / インポート (端末間データ移行)

## 技術構成
- Vanilla JS (フレームワーク不使用)
- IndexedDB (idb なしの素のAPI)
- Service Worker (cache-first)
- Web App Manifest

## ライセンス
All rights reserved.
