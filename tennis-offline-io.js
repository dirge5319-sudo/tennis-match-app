// tennis-offline-io.js
// ADR-001 S5: IndexedDB ⇄ JSON 変換ロジック層
//
// 役割: tennis-store.js が公開する IndexedDB 薄ラッパーを使って、
//       4ストア（config/members/rounds/history）を JSON 文字列に
//       シリアライズ／既存 DB を完全置換する I/O 層を提供する。
//
// 依存:
//   - ブラウザ環境: window.store (tennis-store.js を <script src> で先に読込済)
//   - Node 環境: 直接 require して使うケースはない（テスト都合のみ）
//
// 公開:
//   - ブラウザ: window.io = { exportAll, importAll }
//   - Node: module.exports = { exportAll, importAll, createIO }
//
// JSON 形式（ADR-001 spec §S5 / §4-4 確定形式）:
//   {
//     "version": "1.0",
//     "exportedAt": "ISO8601",
//     "config":  { ... }         // store.get('config','main') の値（無ければ {}）
//     "members": { "teamA":[...], "teamB":[...] },
//     "rounds":  [ {round, matches} ... ],
//     "history": [ {round, court, type, a, b, scoreA, scoreB, winner} ... ]
//   }
//
// importAll の方針:
//   1. config / members / rounds / history を順に clear()
//   2. 同じ順に put() で投入
//   3. members は teamA / teamB を一旦フラットに合流して全件 put（id は再採番）
//   4. 失敗時は途中で reject（既存DB部分破壊の可能性ありの旨は呼出側で告知する想定）
//
// 注意: store の API は Promise ベース。tennis-store.js が「1ラッパー=1DB」のため、
//       呼出元で先に store.open() しておくこと（io.exportAll は内部で open しない）。

(function (global) {
  'use strict';

  // ストア名（tennis-store.js の SCHEMA と一致させる）
  const STORE_CONFIG = 'config';
  const STORE_MEMBERS = 'members';
  const STORE_ROUNDS = 'rounds';
  const STORE_HISTORY = 'history';

  // JSON フォーマット バージョン（将来拡張時に bump）
  const JSON_FORMAT_VERSION = '1.0';

  // store 依存を差し替え可能にするためのファクトリ
  // 既定はグローバルの window.store / globalThis.store を使う
  function createIO(storeRef) {
    const s = storeRef || (typeof global !== 'undefined' ? global.store : null);
    if (!s) {
      throw new Error('tennis-offline-io: store が見つかりません (tennis-store.js を先に読み込んでください)');
    }

    // exportAll: 4ストア全件を読み出して spec §S5 形式の JSON 文字列を返す
    async function exportAll() {
      // config は単一レコード（id='main' 固定）。無ければ空オブジェクト
      const configRow = await s.get(STORE_CONFIG, 'main');
      const config = configRow ? stripIdField(configRow) : {};

      // members は team フィールドで teamA / teamB に振り分け
      // id は autoIncrement の内部キーなので JSON からは落とす（import 時に再採番される）
      const allMembers = await s.getAll(STORE_MEMBERS);
      const teamA = allMembers.filter((m) => m && m.team === 'A').map(stripIdField);
      const teamB = allMembers.filter((m) => m && m.team === 'B').map(stripIdField);

      // rounds は keyPath='round' のため、そのまま配列として返す（round 昇順にソート）
      const rounds = (await s.getAll(STORE_ROUNDS)).slice().sort(byRoundAsc);

      // history は keyPath='id' (auto)。round 昇順を維持しつつ、JSON 表現からは id を落とす
      const historyRaw = await s.getAll(STORE_HISTORY);
      const history = historyRaw
        .slice()
        .sort(byRoundAscThenIdAsc)
        .map(stripIdField);

      const payload = {
        version: JSON_FORMAT_VERSION,
        exportedAt: new Date().toISOString(),
        config: config,
        members: { teamA: teamA, teamB: teamB },
        rounds: rounds,
        history: history,
      };
      return JSON.stringify(payload, null, 2);
    }

    // importAll: 引数 JSON 文字列を解釈し、既存 DB を完全置換
    async function importAll(jsonString) {
      if (typeof jsonString !== 'string' || jsonString.length === 0) {
        throw new Error('importAll: 引数は非空の JSON 文字列を指定してください');
      }
      let parsed;
      try {
        parsed = JSON.parse(jsonString);
      } catch (e) {
        throw new Error('importAll: JSON parse 失敗: ' + (e && e.message ? e.message : e));
      }
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('importAll: JSON ルートはオブジェクトでなければなりません');
      }

      // 念のためデフォルト値で埋める（部分的な JSON も受け入れる）
      const config = parsed.config && typeof parsed.config === 'object' ? parsed.config : {};
      const members = parsed.members && typeof parsed.members === 'object' ? parsed.members : { teamA: [], teamB: [] };
      const teamA = Array.isArray(members.teamA) ? members.teamA : [];
      const teamB = Array.isArray(members.teamB) ? members.teamB : [];
      const rounds = Array.isArray(parsed.rounds) ? parsed.rounds : [];
      const history = Array.isArray(parsed.history) ? parsed.history : [];

      // 完全置換: 4ストアを順に clear
      await s.clear(STORE_CONFIG);
      await s.clear(STORE_MEMBERS);
      await s.clear(STORE_ROUNDS);
      await s.clear(STORE_HISTORY);

      // config: id='main' を強制セット（put の keyPath は 'id'）
      const configToPut = Object.assign({}, config, { id: 'main' });
      await s.put(STORE_CONFIG, configToPut);

      // members: teamA / teamB をそれぞれ team フィールドを補強しつつ全件 put
      // id は autoIncrement で再採番される（古い id は捨てる）
      for (const m of teamA) {
        if (!m || typeof m !== 'object') continue;
        const row = Object.assign({}, m, { team: 'A' });
        delete row.id; // 再採番のため明示削除
        await s.put(STORE_MEMBERS, row);
      }
      for (const m of teamB) {
        if (!m || typeof m !== 'object') continue;
        const row = Object.assign({}, m, { team: 'B' });
        delete row.id;
        await s.put(STORE_MEMBERS, row);
      }

      // rounds: keyPath='round' なので round フィールドが必須
      for (const r of rounds) {
        if (!r || typeof r !== 'object' || typeof r.round !== 'number') continue;
        await s.put(STORE_ROUNDS, r);
      }

      // history: keyPath='id' (auto)。古い id は捨てて再採番
      for (const h of history) {
        if (!h || typeof h !== 'object') continue;
        const row = Object.assign({}, h);
        delete row.id;
        await s.put(STORE_HISTORY, row);
      }
    }

    return {
      exportAll: exportAll,
      importAll: importAll,
    };
  }

  // ───────── ヘルパー ─────────

  // id プロパティを除いた浅いコピーを返す（JSON 出力時の見やすさのため）
  function stripIdField(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const copy = Object.assign({}, obj);
    delete copy.id;
    return copy;
  }

  // rounds 用ソート関数（round 昇順）
  function byRoundAsc(a, b) {
    const ra = a && typeof a.round === 'number' ? a.round : 0;
    const rb = b && typeof b.round === 'number' ? b.round : 0;
    return ra - rb;
  }

  // history 用ソート関数（round 昇順 → id 昇順）
  function byRoundAscThenIdAsc(a, b) {
    const ra = a && typeof a.round === 'number' ? a.round : 0;
    const rb = b && typeof b.round === 'number' ? b.round : 0;
    if (ra !== rb) return ra - rb;
    const ia = a && typeof a.id === 'number' ? a.id : 0;
    const ib = b && typeof b.id === 'number' ? b.id : 0;
    return ia - ib;
  }

  // ───────── 公開 ─────────

  // ブラウザ: window.io にデフォルトインスタンスを露出（S4 で <script> 読込時に即使える）
  // ただし tennis-store.js より後に読み込む必要がある。store 未定義時は遅延束縛のため
  // プロキシ的にゲッターで都度生成する形にする。
  if (typeof global !== 'undefined') {
    Object.defineProperty(global, 'io', {
      configurable: true,
      enumerable: true,
      get: function () {
        // global.store が未定義の段階で window.io を参照されたらエラー
        if (!global.store) {
          throw new Error('tennis-offline-io: window.store が未定義です (tennis-store.js を先に読み込んでください)');
        }
        // 都度生成（store 差し替えに追従する。コスト無視できる程度）
        return createIO(global.store);
      },
    });
  }

  // Node: module.exports（テスト都合）
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      createIO: createIO,
      JSON_FORMAT_VERSION: JSON_FORMAT_VERSION,
    };
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
