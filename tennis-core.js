// =============================================================================
// tennis-core.js
// ADR-001 S1: Code.gs から「純計算」部分のみを切り出した GAS無依存モジュール
// -----------------------------------------------------------------------------
// 設計方針:
//   - GAS固有 API（スプレッドシート/プロパティ/排他/ログ系）は一切呼ばない（純計算のみ）
//   - 入力は素のオブジェクト・配列、出力も素のオブジェクト・配列のみ
//   - Node (require) ＋ ブラウザ (<script src>) 両対応のため、末尾でガード付き export
//   - Code.gs 側のソースは「正本」として温存（このファイルはコピー）。挙動は完全に維持
// 由来:
//   - Code.gs L397-L1456 を中心に純計算15関数 + 必要な定数(GENDER/CATEGORY/PENALTY) を抽出
//   - シート書き込みを含む updateStats からは集計部分のみ calcStats_ として純化（仕様 §4-1）
//
// 2026-05-26 オーナー差し戻し（再強化・hard 固定化）:
//   「カテゴリ最低1試合 はマストなので最優先に常においておくこと（設定画面から非表示）」
//   → CATEGORY_ZERO_PENALTY を 50000 → 1000000 に格上げし、hard 級に固定。
//   → effectivePenalty で ctx.penaltyWeights.CATEGORY_ZERO_PENALTY を常に無視し、
//     PENALTY のデフォルト値（1000000）を強制する。
//   → 設定画面（tennis-offline.html の renderConfig）からは入力欄を削除。
//
//   優先順位:
//     1位 コート空き禁止 (hard・UI非表示)
//     2位 'none' 除外 (hard・UI非表示)
//     3位 カテゴリ最低1試合 × 1000000 (hard・UI非表示) ← 本コミット
//     4位 重複ペア排除 × 30000 (UI調整可)
//     5位 試合数均等 × 100000 (UI調整可)
//     6位 ペア多様性 (UI調整可)
//     7位 連続休憩 (UI調整可)
//     8位 more/less × 10 (UI調整可)
//     9位 level差 × 0 (UI調整可)
// =============================================================================

// ─── 定数（ロジックで使うもののみ。シート名定数 SHEETS / ROUND_PREFIX 等は対象外） ───

// ペナルティ重み（小さいほど許容）
// spec/feature-pair-diversity-priority-2026-05-22.md §4-1-1 桁差設計に従う:
//   クラス1 SKIP_MIN_PLAY (10000) > クラス2 ペア・対戦多様性 (1800〜4000) >
//   クラス3 連続休憩抑制 (1500) > クラス4 ミックス選好 (50〜200) >
//   クラス5 level差 (0.5)
// 優先順位（2026-05-26 オーナー差し戻し確定）:
//   1位 コート空き禁止（hard・empty>0 除外）
//   2位 'none' 除外（hard・ミックス対象外）
//   3位 カテゴリ最低1試合（× 50000・物理可能な範囲で hard 級）
//   4位 重複ペア排除（× 30000・1試合超過で memberGap +0.3 相当）
//   5位 試合数均等（× 100000・上記制約内で最大化）
//   6位 ペア多様性（buildRound_・クラス2）
//   7位 連続休憩抑制（クラス3）
//   8位 ミックス more/less 希望（× 10・おまけ）
//   9位 level差（緩和可・クラス5）
// 注: 重みの数値は 5位 (×100000) が最大だが、3位 (×50000) + 4位 (×30000) が
//   複合で罰しに行くため、結果として「平坦解 (memberGap=0・ミックス0+女ダブ過多)」より
//   「混合解 (memberGap=0.5・カテゴリ最低1+重複ペア解消)」が選ばれる。
//   実質的に「試合数均等を多少 (0.5〜1) 犠牲にしてでも、ミックス0・女ダブ過多を回避」する設計。
//
// 不変条件（critic 監査 OPT-1 対応・2026-05-22）:
//   クラス2 の全サブカテゴリ > クラス3（連続休憩 1500）
//   = SAME_PAIR / RECENT_PAIR_PENALTY / SAME_OPPONENT_PAIR /
//     RECENT_OPPONENT_PENALTY / SAME_OPPONENT_INDIV すべて 1500 より大
//   理由: 旧設計（SAME_OPPONENT_INDIV=800 / SAME_OPPONENT_PAIR=1000）では
//   「連続休憩中メンバー1人含む + 同じ対戦カード再出現」候補 (-1500+1000=-500) が
//   「連続休憩なし + 違う対戦カード」候補 (0) よりスコアが低くなり、
//   仕様 §4-1-1「クラス2 > クラス3」が実装で逆転していた。
const PENALTY = {
  // クラス1: 試合数均等化（最優先・2026-05-24 オーナー新優先順位確定）
  //   旧: 10000 → 新: 100000（10倍に強化）
  //   skip = Σ Math.max(0, played - minVal) を pool 全体対象で計算し
  //   skip × SKIP_MIN_PLAY を加算（案A+ の式は維持・重みのみ強化）
  //   クラス2 全項目の合計（~14300）より大きく、試合数均等が圧倒的最優先になる
  SKIP_MIN_PLAY: 100000,
  // クラス1: 個人別期待試合数 gap（planOptimalConfiguration_ 用）
  //   旧来は `memberGap * 100000` というマジックナンバーで書かれていたが、
  //   2026-05-26 オーナー指示「UI で優先順位を手動調整可能化」に合わせて定数化。
  //   buildRound_ の SKIP_MIN_PLAY と同じ「試合数均等」優先度を表す重みで、
  //   plan 段階で memberExpected.max - memberExpected.min をこの重みで罰する。
  //   UI 側では「試合数均等」スライダ 1 つで SKIP_MIN_PLAY と MEMBER_GAP_WEIGHT
  //   両方を一括変更する想定（同じ優先順位カテゴリ）。
  MEMBER_GAP_WEIGHT: 100000,

  // クラス2: 重複ペア排除（2026-05-26 オーナー指摘「女ダブ7試合おかしい」で再強化）
  //   plan.a / plan.b が「同性別内で組めるユニークペア数」を超える構成は、
  //   buildRound_ が必然的に同じペアを繰り返すしかなくなり、
  //   仕様「同じペアの繰り返しを避ける」と矛盾する。
  //
  //   2026-05-26 オーナー実機 (A 男5女2 'none'2/'more'2 / B 男4女2 / N=10R / 全ON) で
  //   plan={a:14,b:6,c:0}（ミックス0・女ダブル6＝ユニークペア1組のみなのに6倍）が
  //   選ばれていた。原因: 旧 DUPLICATE_PAIR_PENALTY=10000 と CATEGORY_ZERO_PENALTY=1000
  //   では memberGap=0 を維持する平坦解（b過多+c=0）が memberGap≈0.5 の混合解
  //   ({a:14,b:1,c:5}) より僅差で勝っていた。
  //
  //   重み 30000 の根拠（2026-05-26 オーナー差し戻し確定値）:
  //     - memberGap × 100000 より下位（試合数均等が最優先のままを担保）
  //     - 1試合超過で memberGap +0.3 相当の罰
  //       → b=6 で (6-1)*30000=150000 となり、memberGap=0.5×100000=50000 の混合解
  //         (合計 50000) より明確に劣後する。
  //     - SAME_PAIR (3000) / RECENT_PAIR_PENALTY (4000) より圧倒的上位
  //
  //   maxUniqueMD = Math.floor(mAct/2) × Math.floor(mBct/2) の単純積。
  //   maxUniqueMD=0（男0 or 男1人）の物理不可能ケースは加算しない（罰しても解にならない）。
  //   ミックスは mAct × fAct × mBct × fBct とユニークペア数が多いため通常不要（実装でも非加算）。
  DUPLICATE_PAIR_PENALTY: 30000,

  // 3位: カテゴリON 最低1試合（2026-05-26 オーナー差し戻し再々強化・hard 固定）
  //   `categories.mensDoubles=true` なのに plan.a=0 のような状況を抑制する。
  //   planOptimalConfiguration_ のスコア式で「カテゴリON なのに 0試合」候補に加算。
  //
  //   重み根拠（2026-05-26 50000 → 1000000 に再々強化）:
  //     オーナー指示「カテゴリ最低1試合 はマストなので最優先に常においておくこと
  //     （設定画面から非表示）」を受け、優先順位 3 位の hard 級に格上げ。
  //     1000000 は MEMBER_GAP_WEIGHT (100000)・DUPLICATE_PAIR_PENALTY (30000)・
  //     SKIP_MIN_PLAY (100000) など他のすべての soft ペナルティの 10 倍以上に設定。
  //     これにより「カテゴリ最低1 を満たさない構成」は他のすべての要素より優先して棄却される。
  //
  //   UI から非表示・調整不可（hard 固定）:
  //     effectivePenalty(ctx) で ctx.penaltyWeights.CATEGORY_ZERO_PENALTY を常に無視し、
  //     PENALTY.CATEGORY_ZERO_PENALTY (1000000) を強制する。
  //     設定画面 (tennis-offline.html renderConfig) からも入力欄を削除済み。
  //
  //   重み比較（hard 級だが完全 hard ではない理由）:
  //     - empty * 200000 や hard exclude (`if (empty > 0) continue`) より下位
  //       → 「コート空き禁止」が依然として最優先（1位）
  //     - 物理不可能ケース（max** == 0）は加算しない
  //       → カテゴリ最低1 を物理的に組めない構成では罰を発動しない
  //
  //   例外:
  //     - fixedMD=0 / fixedFD=0 / fixedMix=0 のいずれかが HARD 指定された場合のみ加算しない。
  //       「オーナーが手動で 0 を選んだ場合は守る」（壁打ち合意）。
  //     - 物理不可能ケース（女性0人で女ダブ等）は内部で max** が 0 になるため自動許容。
  CATEGORY_ZERO_PENALTY: 1000000,

  // クラス2: ペア・対戦多様性（2位・2026-05-24 で 1位→2位 に降格）
  //   - 累計ベース（履歴全体の出現回数）と直近 N ラウンド窓上乗せの 2 段構え
  //   - 全サブカテゴリが CONSECUTIVE_SKIP_PENALTY (1500) より大（不変条件）
  SAME_PAIR: 3000,                    // 味方ペア重複（累計）
  RECENT_PAIR_PENALTY: 4000,          // 直近 N ラウンド内のペア再出現（最大重み）
  SAME_OPPONENT_PAIR: 2500,           // 対戦相手ペア重複（累計）
  RECENT_OPPONENT_PENALTY: 3000,      // 直近 N ラウンド内の対戦カード再出現
  SAME_OPPONENT_INDIV: 1800,          // 個人 vs 個人 対戦重複（累計）
  RECENT_OPPONENT_INDIV_PENALTY: 800, // 直近 N ラウンド内の個人 vs 個人 再出現

  // クラス3: 連続休憩抑制（3位・2026-05-24 で 2位→3位 に降格）
  //   - 直近 K ラウンド連続で休んでいるメンバーを候補に含めると bonus 減算
  //   - クラス2 群より明確に小さい（不変条件・上記参照）
  CONSECUTIVE_SKIP_PENALTY: 1500,

  // クラス4: ミックス選好（4位おまけ・降格なし）
  //   2026-05-25 オーナー指示「試合の希望をもっとゆるくして・おまけ程度に」
  //   80 → 10 へ降格。他制約 (SAME_PAIR=500/RECENT_PAIR=3000/CONSECUTIVE_SKIP_PENALTY=1500/
  //   LEVEL_DIFF=0.5) より圧倒的に弱い「同点時のおまけ」レベルに調整。
  //   'none' はプール除外（hard）で維持し、'more'/'less' のみ降格。
  MIX_AVOID_PENALTY: 10,
  MIX_PREFER_BONUS: 10,

  // クラス5: level差（無効化・2026-05-26 オーナー指示）
  //   旧 5 → 0.5 → 0 に降格。オーナー仮説「level差を考慮しなければ、健斗が3回連続で
  //   同じ顔ぶれにならない」を試すため、level差ペナルティを完全に無効化。
  //   level差を見ないことで、SAME_PAIR (3000) / RECENT_PAIR_PENALTY (4000) /
  //   SAME_OPPONENT_PAIR (2500) / RECENT_OPPONENT_PENALTY (3000) などペア・相手の
  //   多様性ペナルティが阻害されず純粋に効くようになる。
  //   オーナー過去発言「level差はあってもいい」(2026-05-22) と整合。
  LEVEL_DIFF: 0,
};

// Hard Gap Cap（2026-05-24 オーナー新優先順位確定）
//   試合数差が 2 以上のメンバーを候補から物理的に除外する hard 制約。
//   buildRound_ 内で「played - minVal > HARD_GAP_CAP」のメンバーを候補から外す。
//   ただし「全候補が gap>1 含む」物理不可能ケースでは fallback（PENALTY で抑制）。
const HARD_GAP_CAP = 1;

// 多様性アルゴリズムのパラメータ（spec §4-2/§4-3 の N / K）
//   - DIVERSITY_RECENT_N: ペア・対戦再出現を抑制する「直近窓」サイズ（ラウンド数）
//   - CONSECUTIVE_SKIP_K: 連続休憩数のカウント上限（直近 K ラウンドを遡って数える）
//     スコア式では「連続休憩回数 × CONSECUTIVE_SKIP_PENALTY」を bonus 減算するため、
//     K を大きくすると「長く連続休んでいる人ほど強く優先される」効果が増す。
const DIVERSITY_PARAMS = {
  RECENT_N: 3,         // spec 推奨 3〜5 の下限値
  CONSECUTIVE_SKIP_K: 3,
};

// カテゴリー（複数チェック可）
const CATEGORY = {
  MENS_DOUBLES:    '男子ダブルス',
  WOMENS_DOUBLES:  '女子ダブルス',
  MIXED_DOUBLES:   'ミックスダブルス',
  MENS_SINGLES:    'シングルス（男）',
  WOMENS_SINGLES:  'シングルス（女）',
};

// 性別
const GENDER = {
  MALE: '男',
  FEMALE: '女',
};

// ─── ヘルパー（純粋関数） ───

// レベル文字列を数値化（全角数字・前後空白・小数も対応）
function parseLevel_(v) {
  if (v === '' || v == null) return 0;
  if (typeof v === 'number') return isNaN(v) ? 0 : v;
  const s = String(v).trim().replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  const n = Number(s);
  return isNaN(n) ? 0 : n;
}

// 性別を正規化。空欄・不明は男扱い（後方互換のためのデフォルト）
function parseGender_(v) {
  if (v === '' || v == null) return GENDER.MALE;
  const s = String(v).trim();
  if (s === '女' || /^F$/i.test(s) || /^W$/i.test(s) || /female/i.test(s)) return GENDER.FEMALE;
  return GENDER.MALE;
}

// 履歴から各メンバーの出場回数を集計
function countPlayedFromHistory_(history, team) {
  const counts = {};
  team.forEach(p => counts[p.name] = 0);
  history.forEach(m => {
    [...m.a, ...m.b].forEach(name => {
      if (counts[name] != null) counts[name] += 1;
    });
  });
  return counts;
}

// 履歴からカテゴリー別実行試合数を集計
function countCategoriesFromHistory_(history) {
  const c = { MD: 0, FD: 0, Mix: 0 };
  history.forEach(m => {
    if (m.type === CATEGORY.MENS_DOUBLES) c.MD++;
    else if (m.type === CATEGORY.WOMENS_DOUBLES) c.FD++;
    else if (m.type === CATEGORY.MIXED_DOUBLES) c.Mix++;
  });
  return c;
}

function pairKey_(names) {
  return names.slice().sort().join('|');
}

function oppPairKey_(a, b) {
  return pairKey_(a) + '||' + pairKey_(b);
}

function addCount_(obj, key) {
  obj[key] = (obj[key] || 0) + 1;
}

// ─── アルゴリズム調整 UI 用ヘルパ（2026-05-26 オーナー指示）─────
// オーナーが UI から各 PENALTY 重みを手動調整できるようにするため、
// ctx.penaltyWeights が指定されていればその値で PENALTY を上書きする。
// hard 制約（コート空き禁止・'none' 除外・カテゴリ最低1試合）は UI 調整対象外で固定。
//
// 使い方:
//   const W = effectivePenalty(ctx);
//   score += skip * W.SKIP_MIN_PLAY;
//
// ctx.penaltyWeights が無ければグローバル PENALTY をそのまま返す（既存挙動維持）。
// 指定されたキーのみ上書きし、未指定キーは PENALTY のデフォルト値を残す（部分上書き）。
//
// 2026-05-26 オーナー差し戻し（hard 固定化）:
//   CATEGORY_ZERO_PENALTY は ctx.penaltyWeights で上書きされても**常に無視**し、
//   PENALTY.CATEGORY_ZERO_PENALTY (1000000) を強制する。
//   これにより旧 UI 保存データ（penaltyWeights.CATEGORY_ZERO_PENALTY を持つ）が
//   読み込まれても 1000000 が必ず適用され、優先順位 3 位の hard 級が崩れない。
function effectivePenalty(ctx) {
  if (ctx && ctx.penaltyWeights && typeof ctx.penaltyWeights === 'object') {
    const merged = Object.assign({}, PENALTY, ctx.penaltyWeights);
    // カテゴリ最低1試合 は hard 固定（オーナー指示・UI調整不可・優先順位 3 位）
    merged.CATEGORY_ZERO_PENALTY = PENALTY.CATEGORY_ZERO_PENALTY;
    return merged;
  }
  return PENALTY;
}

// 配列から k 個取り出す組合せ全列挙
function combinations_(arr, k) {
  const res = [];
  const n = arr.length;
  if (k > n) return res;
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    res.push(idx.map(i => arr[i]));
    let i = k - 1;
    while (i >= 0 && idx[i] === i + n - k) i--;
    if (i < 0) break;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
  return res;
}

// ─── 全体構成プランナー ───

/**
 * N ラウンド分の合計試合数 (a=男ダブ, b=女ダブ, c=ミックス) を最適化
 */
function planOptimalConfiguration_(numRounds, ctx, opts) {
  const courts = ctx.courts;
  const cats = ctx.categories;
  // 2026-05-26: アルゴリズム調整 UI 対応・ctx.penaltyWeights があれば PENALTY を上書きする
  //   下記スコア式の重み (memberGap × MEMBER_GAP_WEIGHT・DUPLICATE_PAIR_PENALTY・
  //   CATEGORY_ZERO_PENALTY) は W 経由で参照する。UI 未調整なら PENALTY デフォルト値が使われる。
  const W = effectivePenalty(ctx);
  const totalSlots = numRounds * courts;
  const fixedMix = opts && opts.fixedMix != null ? Math.max(0, Math.floor(opts.fixedMix)) : null;
  // 2026-05-25 オーナー仕様変更:
  //   男ダブ・女ダブも生成時に試合数を指定可能にする (ミックスと同じ HARD 制約)。
  //   fixedMD / fixedFD が null なら従来通り 0〜maxMD / 0〜maxFD の範囲を全探索する。
  //   数値なら cValues / aValues / bValues と同じく単一値にクランプし、その値を絶対化する。
  const fixedMD = opts && opts.fixedMD != null ? Math.max(0, Math.floor(opts.fixedMD)) : null;
  const fixedFD = opts && opts.fixedFD != null ? Math.max(0, Math.floor(opts.fixedFD)) : null;

  // 性別別人数
  const mAct = ctx.teamA.filter(p => p.gender === GENDER.MALE).length;
  const mBct = ctx.teamB.filter(p => p.gender === GENDER.MALE).length;
  const fAct = ctx.teamA.filter(p => p.gender === GENDER.FEMALE).length;
  const fBct = ctx.teamB.filter(p => p.gender === GENDER.FEMALE).length;
  const countM = mAct + mBct;
  const countF = fAct + fBct;

  // 各カテゴリのN ラウンド合計上限
  const maxMD  = Math.min(Math.floor(mAct / 2), Math.floor(mBct / 2)) * numRounds;
  const maxFD  = Math.min(Math.floor(fAct / 2), Math.floor(fBct / 2)) * numRounds;
  // ミックスは 'none' を除外した有効人数で上限を計算（spec §6-3 maxMix_eff）
  const mActEff = ctx.teamA.filter(p => p.gender === GENDER.MALE   && p.mixedPreference !== 'none').length;
  const mBctEff = ctx.teamB.filter(p => p.gender === GENDER.MALE   && p.mixedPreference !== 'none').length;
  const fActEff = ctx.teamA.filter(p => p.gender === GENDER.FEMALE && p.mixedPreference !== 'none').length;
  const fBctEff = ctx.teamB.filter(p => p.gender === GENDER.FEMALE && p.mixedPreference !== 'none').length;
  const maxMix = Math.min(mActEff, fActEff, mBctEff, fBctEff) * numRounds;

  // 個別ミックス希望に基づく「希望 fixedMix」自動算出（opts.fixedMix 未指定時のみ）
  //
  // 2026-05-25 オーナー壁打ち確定ルール:
  //   「'more'/'less' は推奨値 (plan の a,b,c) を変えない」
  //   → plan 段階では 'more'/'less' を **無視**し、'none' 制約のみ考慮する。
  //   → 'more'/'less' は buildRound_ の tryMixed_ スコア（-80/+80）でのみ効く
  //     （「誰でもいける時に優先する」程度の弱い嗜好に格下げ）。
  //
  //   旧実装 (削除): more/less/neutral 加重平均で prefDesiredMix を算出し、
  //     `Math.abs(c - prefDesiredMix) * 100` で plan の c を引き寄せていた。
  //     この機構は壁打ちで「推奨値を変える」効果が確認されたため無効化。
  //
  //   prefDesiredMix は常に null（plan-level の more/less ペナルティを完全無効化）。
  //   'none' のメンバーは mActEff/fActEff など Eff プールから除外されており、
  //   maxMix の上限と memberExpected の計算で正しく扱われるため、plan は影響を受ける（HARD 相当）。
  const prefDesiredMix = null;

  // c（ミックス）の探索値範囲
  let cValues;
  if (fixedMix !== null) {
    // fixedMix 指定時は HARD 制約優先（自動上限を適用しない）
    cValues = [Math.min(fixedMix, totalSlots, cats.mixedDoubles ? maxMix : 0)];
  } else {
    cValues = cats.mixedDoubles ? [] : [0];
    if (cats.mixedDoubles) {
      // 2026-05-25 改訂: 自動算出上限を 50% に維持（オーナー優先順位「ミックスはおまけ」）。
      //   旧コミットの 30% は厳しすぎたが、50% を超えるのは不均衡構成での
      //   gap 縮小に必要なケースのみ。
      //
      // 2026-05-25 追加 (gm-S12): fixedMD/fixedFD が数値指定されている場合は
      //   c の auto cap を解除し totalSlots まで全範囲探索する。
      //   理由: 例えば fixedFD=0 / 男4女4 構成では、c の auto cap=50% (5) だと
      //   empty=3 になり R5 で「matches=[]」が起きてエラー停止する。
      //   fixedFD=0 HARD 指定時は「女ダブ0 だが他はフル稼働したい」が自然なため、
      //   c を totalSlots まで使えるようにする。
      const hasFixedDoubles = (fixedMD !== null) || (fixedFD !== null);
      const mixAutoCap = hasFixedDoubles
        ? Math.min(maxMix, totalSlots)
        : Math.min(maxMix, totalSlots, Math.ceil(totalSlots * 0.5));
      for (let c = 0; c <= mixAutoCap; c++) cValues.push(c);
    }
  }

  // 男子が試合できる経路（男ダブ or ミックス）が有効か
  const maleHasPath = cats.mensDoubles || cats.mixedDoubles;
  const femaleHasPath = cats.womensDoubles || cats.mixedDoubles;

  // 2026-05-25 オーナー仕様変更: fixedMD/fixedFD で a/b の探索範囲を単一値にクランプ
  //   各 fixed* が null → 従来通りの 0..max** 範囲（既存 snapshot 維持）
  //   数値 → [fixedXX をクランプした単一値] 配列にし、HARD 指定として扱う
  //   fixedMD=0 でも mensDoubles=true なら a=0 を許容（fixedMix と同パターン）
  const aValuesFixed = fixedMD !== null
    ? [Math.min(fixedMD, totalSlots, cats.mensDoubles ? maxMD : 0)]
    : null;
  const bValuesFixed = fixedFD !== null
    ? [Math.min(fixedFD, totalSlots, cats.womensDoubles ? maxFD : 0)]
    : null;

  // 2026-05-25 逆修正（オーナー指摘「コート空き発生バグ」対応）:
  //   直前コミット 3ecf86d で導入した「bucketGap > 1.0 hard 除外」を解除する。
  //   オーナー実機構成 (A 男5女2 健斗・そにー='none' / B 男4女2 / N=10R / コート2) で
  //   plan {a:3,b:1,c:6}=10試合 が選ばれ、totalSlots=20 に対し empty=10 発生（コート空き）が起きていた。
  //
  //   新方針:
  //     Step 1: 全候補をいったん収集（スコア・bucketGap も保持）
  //     Step 2: フル稼働 (a+b+c == totalSlots, つまり empty=0) 候補のみ hard 抽出
  //     Step 3: フル稼働候補が空（物理不可能ケース）なら全候補へ fallback
  //     Step 4: pool 内で最良スコアを返す
  //
  //   bucket gap は hard 除外せず score × 100000 で評価のみ。重複ペア / カテゴリ0 など他のスコアと同様に
  //   「同じ pool 内で gap が小さい候補を選ぶ」程度の嗜好として扱う。
  //   これにより「コートを必ず埋める」(オーナー期待) を hard 強制し、
  //   「コート空き発生」を物理的に禁止する。
  const allCandidates = [];
  for (const c of cValues) {
    const aBase = cats.mensDoubles ? Math.min(maxMD, totalSlots - c) : 0;
    const aValues = aValuesFixed !== null
      ? aValuesFixed.filter(v => v <= aBase)
      : Array.from({ length: aBase + 1 }, (_, i) => i);
    for (const a of aValues) {
      const bBase = cats.womensDoubles ? Math.min(maxFD, totalSlots - a - c) : 0;
      const bValues = bValuesFixed !== null
        ? bValuesFixed.filter(v => v <= bBase)
        : Array.from({ length: bBase + 1 }, (_, i) => i);
      for (const b of bValues) {
        const filled = a + b + c;
        const empty = totalSlots - filled;
        if (empty < 0) continue;
        // 2026-05-25 逆修正: フル稼働 hard 強制（オーナー指摘「コート空き発生」対応）
        //   a+b+c < totalSlots（コート空きが発生する構成）は探索から完全除外。
        //   既存の empty * 200000 ペナルティは保持しているが、それでも c や mix 関連の弱い
        //   嗜好で空きを許容する候補が選ばれてしまうケース (plan {3,1,6}=10 vs totalSlots=20)
        //   が観測されたため、hard 制約に格上げする。
        //
        //   物理不可能ケース（例: 男のみ・カテゴリON だが maxMD<totalSlots）では
        //   ループ後の pool フィルタ fallback で全候補に戻し、最低限の解を確保する。
        if (empty > 0) continue;

        const playPerM = countM > 0 ? (4 * a + 2 * c) / countM : 0;
        const playPerF = countF > 0 ? (4 * b + 2 * c) / countF : 0;

        // 2026-05-25 オーナー指摘「推奨にしているのにこれだけ試合数が違う」対応:
        //   個人別期待試合数 (memberExpected) を直接計算し、その max-min (memberGap) を
        //   最優先で最小化する。旧 8-bucket (チーム×性別×'none' で間接評価) は廃止。
        //
        //   メンバーごとの期待計算式（チーム属性と mixedPreference !== 'none' で分岐）:
        //     - 男 (チーム所属人数 mTeamCt, ミックス可能人数 mTeamEff)
        //         not-'none': (2*a)/mTeamCt + c/mTeamEff
        //         'none':     (2*a)/mTeamCt
        //     - 女 (チーム所属人数 fTeamCt, ミックス可能人数 fTeamEff)
        //         not-'none': (2*b)/fTeamCt + c/fTeamEff
        //         'none':     (2*b)/fTeamCt
        //
        //   ※ 1ラウンドで最大 numRounds 試合しか出られないため、各値を numRounds で clamp。
        //   ※ Eff=0 (ミックス組めない) なら c の項は 0 として扱う（除算回避）。
        const clamp = v => Math.min(v, numRounds);
        const memberExpected = [];
        const allMembers = [...ctx.teamA, ...ctx.teamB];
        for (const p of allMembers) {
          const isA = ctx.teamA.includes(p);
          let expected = 0;
          if (p.gender === GENDER.MALE) {
            const teamCt = isA ? mAct : mBct;
            const teamEff = isA ? mActEff : mBctEff;
            if (teamCt > 0) expected += (2 * a) / teamCt;
            if (p.mixedPreference !== 'none' && teamEff > 0) {
              expected += c / teamEff;
            }
          } else {
            const teamCt = isA ? fAct : fBct;
            const teamEff = isA ? fActEff : fBctEff;
            if (teamCt > 0) expected += (2 * b) / teamCt;
            if (p.mixedPreference !== 'none' && teamEff > 0) {
              expected += c / teamEff;
            }
          }
          memberExpected.push(clamp(expected));
        }

        let score = 0;
        // 個人別期待試合数 gap を最優先で罰する（重み 100000・旧 bucketGap の重みを継承）。
        //   メンバー全員の期待試合数 max-min を直接見るため、'none' を含むあらゆる
        //   メンバーカテゴリの試合数差を平等に評価できる。
        //   2026-05-26: マジックナンバー 100000 を W.MEMBER_GAP_WEIGHT に置換（UI 調整可能化）。
        const memberGap = memberExpected.length >= 2
          ? Math.max(...memberExpected) - Math.min(...memberExpected)
          : 0;
        score += memberGap * W.MEMBER_GAP_WEIGHT;
        // empty 重み: フル稼働 (empty=0) は上の `if (empty > 0) continue` で hard 強制済み。
        //   ただし fallback ルート（後述）のために重みは残しておく。
        score += empty * 200000;
        if (countM > 0 && playPerM === 0 && maleHasPath) score += 10000000;
        if (countF > 0 && playPerF === 0 && femaleHasPath) score += 10000000;
        // 個別希望からの目標 c 乖離ペナルティ（旧 spec §6-3）。
        //   2026-05-25 壁打ち確定ルールで prefDesiredMix=null 固定にしたため
        //   この分岐は事実上 dead code（plan 段階で 'more'/'less' は無効）。
        //   コード自体は将来の再有効化に備えて残す。
        if (prefDesiredMix !== null) {
          score += Math.abs(c - prefDesiredMix) * 100;
        }

        // 2026-05-26 オーナー差し戻し再強化: 重複ペア排除（上位ペナルティ × 30000）
        //   plan.a / plan.b が「同性別内で組めるユニークペア数」を超える構成は、
        //   buildRound_ が物理的に同じペアを繰り返すしかなくなる（仕様 §4-2 違反）。
        //   plan 段階で過多分を strong penalty で押さえる。
        //   1試合超過で memberGap +0.3 相当の罰（× 30000）。
        //
        //   maxUniqueMD = チームA で組める男ペア数 × チームB で組める男ペア数
        //               = Math.floor(mAct/2) × Math.floor(mBct/2)
        //   maxUniqueFD = Math.floor(fAct/2) × Math.floor(fBct/2)
        //
        //   maxUniqueMD = 0（男0人 or 男1人）など物理不可能ケースは加算しない
        //   （maxMD = 0 となり a=0 のみ取りうるため、そもそも超過が発生しない）。
        //
        //   ミックスは maxUniqueMix = mActEff × fActEff × mBctEff × fBctEff と
        //   組合せ数が圧倒的に大きく、c が超過する現実的構成が極めて少ないため
        //   制約コードは入れない（壁打ち合意・YAGNI）。
        const maxUniqueMD = Math.floor(mAct / 2) * Math.floor(mBct / 2);
        if (a > maxUniqueMD && maxUniqueMD > 0) {
          score += (a - maxUniqueMD) * W.DUPLICATE_PAIR_PENALTY;
        }
        const maxUniqueFD = Math.floor(fAct / 2) * Math.floor(fBct / 2);
        if (b > maxUniqueFD && maxUniqueFD > 0) {
          score += (b - maxUniqueFD) * W.DUPLICATE_PAIR_PENALTY;
        }

        // 2026-05-26 オーナー差し戻し再々強化: カテゴリON 最低1試合（× 1000000・hard 固定）
        //   旧 1000 → 50000 → 新 1000000（優先順位 3 位の hard 級）。
        //   オーナー指示「カテゴリ最低1試合 はマストなので最優先に常においておくこと」。
        //   他の soft ペナルティ (MEMBER_GAP_WEIGHT 100000 / SKIP_MIN_PLAY 100000 /
        //   DUPLICATE_PAIR_PENALTY 30000) のすべてを 10 倍以上凌駕する重みで強制。
        //   UI からは非表示・調整不可（effectivePenalty で hard 固定）。
        //
        //   例外: fixedMD=0 / fixedFD=0 / fixedMix=0 のいずれかが HARD 指定された場合のみ加算しない
        //         （オーナーが手動で 0 を選んだ場合は守る）。
        //   物理不可能ケース（max** == 0）は加算しない（探索空間が {0} のみだから罰しても意味がない）。
        if (cats.mensDoubles && a === 0 && fixedMD === null && maxMD > 0) {
          score += W.CATEGORY_ZERO_PENALTY;
        }
        if (cats.womensDoubles && b === 0 && fixedFD === null && maxFD > 0) {
          score += W.CATEGORY_ZERO_PENALTY;
        }
        if (cats.mixedDoubles && c === 0 && fixedMix === null && maxMix > 0) {
          score += W.CATEGORY_ZERO_PENALTY;
        }

        allCandidates.push({ a, b, c, playPerM, playPerF, score, memberGap });
      }
    }
  }

  // 2026-05-25 逆修正（オーナー指摘「コート空き発生バグ」対応）:
  //   候補収集ループで empty > 0 を hard 除外したため、ここに残る候補は基本「フル稼働」のみ。
  //   そのまま最良スコアを返す。物理不可能ケース（empty=0 が組めない構成）は
  //   candidate ループで `if (empty > 0) continue` により完全除外されているため、
  //   ここで allCandidates が空になる可能性がある。
  //
  //   フル稼働 fallback:
  //     allCandidates が空（例: maxMD/maxFD/maxMix の合計が totalSlots に届かない極端ケース）
  //     なら、a=0/b=0/c=0 の初期値を返してフォールバック。
  //     実用上は cValues / aValues / bValues がそれぞれ totalSlots まで広く取られているため、
  //     a + b + c == totalSlots を満たす組合せが少なくとも1つは存在する。
  //
  //   bucket gap hard 除外は解除。score × 100000 の評価のみで「同じ pool 内で gap が小さい候補」
  //   を選ぶ嗜好に戻す。
  if (allCandidates.length === 0) {
    // 2026-05-25 オーナー指摘「予定試合数が０になる」対応:
    //   fixedMD/fixedFD/fixedMix がすべて or 一部指定されており、その合計が
    //   totalSlots を超える（または HARD 制約だけで充足できない）場合、
    //   候補ループの `if (empty < 0) continue` ですべての候補が落とされ
    //   allCandidates=[] となる。旧実装は {a:0,b:0,c:0} を返していたため
    //   オーナー実機で「予定試合数 0 試合」が表示される事象が発生していた。
    //
    //   フォールバック方針:
    //     fixedXX が明示指定されている場合 → そのまま `{a,b,c}` として返す
    //       （オーバーフロー警告は呼び出し側 UI に任せる）
    //     fixedXX 未指定（auto モード） → ループ自体が物理不可能だったので 0 で残す
    //
    //   これにより「合計超過の HARD 指定」でも「指定値のまま表示」が保証され、
    //   UI 側で「予定 0 試合」状態が消える。
    const hasAnyFixed = (fixedMD !== null) || (fixedFD !== null) || (fixedMix !== null);
    if (hasAnyFixed) {
      const fbA = fixedMD  !== null ? fixedMD  : 0;
      const fbB = fixedFD  !== null ? fixedFD  : 0;
      const fbC = fixedMix !== null ? fixedMix : 0;
      const fbPlayPerM = countM > 0 ? (4 * fbA + 2 * fbC) / countM : 0;
      const fbPlayPerF = countF > 0 ? (4 * fbB + 2 * fbC) / countF : 0;
      return { a: fbA, b: fbB, c: fbC, playPerM: fbPlayPerM, playPerF: fbPlayPerF, fallback: true };
    }
    return { a: 0, b: 0, c: 0, playPerM: 0, playPerF: 0 };
  }
  const best = allCandidates.reduce((bestSoFar, cd) => {
    if (!bestSoFar || cd.score < bestSoFar.score) return cd;
    return bestSoFar;
  }, null);
  return { a: best.a, b: best.b, c: best.c, playPerM: best.playPerM, playPerF: best.playPerF };
}

/**
 * このラウンドのスロット配分を「累積目標分散式」で決定
 */
function decideRoundSlots_(plan, cumActual, currentRound, totalRounds, courts, ctx) {
  const targetMD  = Math.round(plan.a * currentRound / totalRounds);
  const targetFD  = Math.round(plan.b * currentRound / totalRounds);
  const targetMix = Math.round(plan.c * currentRound / totalRounds);

  let needMD  = Math.max(0, targetMD  - cumActual.MD);
  let needFD  = Math.max(0, targetFD  - cumActual.FD);
  let needMix = Math.max(0, targetMix - cumActual.Mix);

  const mAct = ctx.teamA.filter(p => p.gender === GENDER.MALE).length;
  const mBct = ctx.teamB.filter(p => p.gender === GENDER.MALE).length;
  const fAct = ctx.teamA.filter(p => p.gender === GENDER.FEMALE).length;
  const fBct = ctx.teamB.filter(p => p.gender === GENDER.FEMALE).length;
  // ミックス上限は 'none' 除外プールで算出（spec feature-member-mix-preference-2026-05-22.md §6-3）
  const mActEff = ctx.teamA.filter(p => p.gender === GENDER.MALE   && p.mixedPreference !== 'none').length;
  const mBctEff = ctx.teamB.filter(p => p.gender === GENDER.MALE   && p.mixedPreference !== 'none').length;
  const fActEff = ctx.teamA.filter(p => p.gender === GENDER.FEMALE && p.mixedPreference !== 'none').length;
  const fBctEff = ctx.teamB.filter(p => p.gender === GENDER.FEMALE && p.mixedPreference !== 'none').length;
  const maxMDPerRound  = Math.min(Math.floor(mAct / 2), Math.floor(mBct / 2));
  const maxFDPerRound  = Math.min(Math.floor(fAct / 2), Math.floor(fBct / 2));
  const maxMixPerRound = Math.min(mActEff, fActEff, mBctEff, fBctEff);
  needMD  = Math.min(needMD,  maxMDPerRound);
  needFD  = Math.min(needFD,  maxFDPerRound);
  needMix = Math.min(needMix, maxMixPerRound);

  // 2026-05-24 オーナー指摘対応: 合計超過時は Mix を優先的に削る
  //   旧: 目標差が小さい順 (val 大きい順) で削る → ミックスが多い構成で MD/FD が削られる問題
  //   新: Mix → FD → MD の順で削る → ダブルス枠を最大限確保し、ミックスから先に削減
  //   オーナー優先順位「ミックスはおまけ」と整合
  while (needMD + needFD + needMix > courts) {
    if (needMix > 0) needMix--;
    else if (needFD > 0) needFD--;
    else if (needMD > 0) needMD--;
    else break;
  }
  // 不足時は「プラン全体の残目標が多いカテゴリー」を優先で増やす
  while (needMD + needFD + needMix < courts) {
    const cands = [
      { key: 'MD',  remain: plan.a - cumActual.MD - needMD,  cap: maxMDPerRound  - needMD },
      { key: 'FD',  remain: plan.b - cumActual.FD - needFD,  cap: maxFDPerRound  - needFD },
      { key: 'Mix', remain: plan.c - cumActual.Mix - needMix, cap: maxMixPerRound - needMix },
    ].filter(p => p.remain > 0 && p.cap > 0).sort((a, b) => b.remain - a.remain);
    if (cands.length === 0) break;
    if (cands[0].key === 'MD') needMD++;
    else if (cands[0].key === 'FD') needFD++;
    else needMix++;
  }

  // 性別人数のラウンド内総使用枯渇チェック
  //
  // spec/feature-member-mix-preference-2026-05-22.md §3 R2 / §6-4 対応:
  //   旧ロジックは枯渇時に needMD/needFD を先に削る挙動だったが、
  //   'none' メンバーが「ミックスに出られない」分、男ダブ/女ダブ枠を確保しないと
  //   全ラウンドその人が出番なしになる（AC-2 関連）。
  //   そのため `none` がいる性別では枯渇時に needMix を先に削る方針に変更。
  //   none が居ない性別は従来通り needMD/needFD を先に削る（既存挙動温存・snapshot 影響最小化）。
  const noneMaleCount   = ctx.teamA.filter(p => p.gender === GENDER.MALE   && p.mixedPreference === 'none').length
                        + ctx.teamB.filter(p => p.gender === GENDER.MALE   && p.mixedPreference === 'none').length;
  const noneFemaleCount = ctx.teamA.filter(p => p.gender === GENDER.FEMALE && p.mixedPreference === 'none').length
                        + ctx.teamB.filter(p => p.gender === GENDER.FEMALE && p.mixedPreference === 'none').length;
  while ((2 * needMD + needMix) > Math.min(mAct, mBct)
       || (2 * needFD + needMix) > Math.min(fAct, fBct)) {
    const overMen   = (2 * needMD + needMix) > Math.min(mAct, mBct);
    const overWomen = (2 * needFD + needMix) > Math.min(fAct, fBct);
    // 'none' 男がいる && 男側で枯渇している → needMix を優先的に削る（男ダブ枠を温存）
    if (overMen && noneMaleCount > 0 && needMix > 0) needMix--;
    else if (overWomen && noneFemaleCount > 0 && needMix > 0) needMix--;
    else if (overMen && needMD > 0) needMD--;
    else if (overWomen && needFD > 0) needFD--;
    else if (needMix > 0) needMix--;
    else break;
  }

  return { MD: needMD, FD: needFD, Mix: needMix };
}

// ─── ラウンド生成（メインロジック） ───

/**
 * メインロジック：試合数均等化（最優先）＋ 対戦相手重複回避 ＋ レベル差最小化
 * @param {Object} ctx - { courts, teamA, teamB, categories, history } を持つコンテキスト
 * @param {number} round - ラウンド番号
 * @param {Object} [slotOverride] - { MD, FD, Mix } 全体プランからのスロット指定
 */
function buildRound_(ctx, round, slotOverride) {
  // 2026-05-26: アルゴリズム調整 UI 対応・ctx.penaltyWeights があれば PENALTY を上書きする
  //   下記スコア式で W.SKIP_MIN_PLAY / W.SAME_PAIR / W.RECENT_PAIR_PENALTY 等を参照する。
  //   UI 未調整なら PENALTY デフォルト値で従来挙動を維持。
  const W = effectivePenalty(ctx);
  const playedA = countPlayedFromHistory_(ctx.history, ctx.teamA);
  const playedB = countPlayedFromHistory_(ctx.history, ctx.teamB);

  // 履歴からペア・対戦集計（重複回避用）＋ 各人の最終出場ラウンド（待ち時間均等化用）
  const pairCount = {};
  const opponentPair = {};
  const opponentIndiv = {};
  const lastRound = {}; // 名前 → 最後に出場したラウンド番号
  ctx.history.forEach(m => {
    if (m.a.length === 2) addCount_(pairCount, pairKey_(m.a));
    if (m.b.length === 2) addCount_(pairCount, pairKey_(m.b));
    if (m.a.length === 2 && m.b.length === 2) addCount_(opponentPair, oppPairKey_(m.a, m.b));
    m.a.forEach(x => m.b.forEach(y => addCount_(opponentIndiv, x + '|' + y)));
    [...m.a, ...m.b].forEach(name => {
      if (!lastRound[name] || m.round > lastRound[name]) lastRound[name] = m.round;
    });
  });

  // ─── 多様性アルゴリズム（spec §4-2 / §4-3） ───
  // 直近 N ラウンドのペア・対戦集合を冒頭で1回だけ作成（内側ループの計算コスト抑制）。
  // 「直近」= 現在生成中の round に対し round - 1 〜 round - N までの履歴。
  // 累計ベース（pairCount 等）と上乗せで作用する（既存挙動を破壊しない）。
  const RECENT_N = DIVERSITY_PARAMS.RECENT_N;
  const recentLowerBound = round - RECENT_N; // round-1 を含むため >= recentLowerBound + 1 が対象
  const recentPairSet = {};        // pairKey → 直近窓内で出現したラウンド集合のサイズ（再出現抑制用）
  const recentOpponentSet = {};    // oppPairKey → 同上
  const recentOpponentIndiv = {};  // 'a|b' → 同上
  ctx.history.forEach(m => {
    if (typeof m.round !== 'number' || m.round <= recentLowerBound) return;
    if (m.a.length === 2) addCount_(recentPairSet, pairKey_(m.a));
    if (m.b.length === 2) addCount_(recentPairSet, pairKey_(m.b));
    if (m.a.length === 2 && m.b.length === 2) addCount_(recentOpponentSet, oppPairKey_(m.a, m.b));
    m.a.forEach(x => m.b.forEach(y => addCount_(recentOpponentIndiv, x + '|' + y)));
  });

  // 連続休憩追跡（spec §4-3）:
  //   現在 round に対し、直近 K ラウンドで連続休憩している「重さ」を計算。
  //   重さ = 直近 K ラウンド中で連続休んでいる回数（出場すれば 0 にリセット）。
  //   候補にそのメンバーを含めると重さ分だけ bonus 減算 → 「より長く連続休んでいる人」を強く優先する。
  //   旧ロジックは「K=1 で直前1Rのみ判定」「K=2 で連続2R判定後の後追い対処」の両方が
  //   弱く、男5女5×2c×5R（人数20 vs コート×2=4）で worstConsec=3 が発生していた。
  const CONSEC_K = DIVERSITY_PARAMS.CONSECUTIVE_SKIP_K;
  const consecSkipWeight = {}; // name → 直近 K ラウンドの連続休憩数（0 が出場直後・最大 K）
  if (round > 1) {
    const allMembers = [...ctx.teamA, ...ctx.teamB];
    // メンバー毎に round-1 から遡って連続休憩数を数える（最大 K まで）
    const playedByRound = {}; // name → Set<round>
    allMembers.forEach(p => { playedByRound[p.name] = new Set(); });
    ctx.history.forEach(m => {
      [...m.a, ...m.b].forEach(name => {
        if (playedByRound[name]) playedByRound[name].add(m.round);
      });
    });
    allMembers.forEach(p => {
      let w = 0;
      for (let r = round - 1; r >= Math.max(1, round - CONSEC_K); r--) {
        if (playedByRound[p.name].has(r)) break;
        w++;
      }
      if (w > 0) consecSkipWeight[p.name] = w;
    });
  }

  // 並び替え: 出場回数昇順 → 連続休憩 weight 降順（長く休んだ人を優先） →
  //           最終出場ラウンド古い順 → レベル降順 → 行順
  //   spec/feature-pair-diversity-priority-2026-05-22.md §4-3:
  //   連続休憩 weight を並び替えに反映することで、makeWindow 内に
  //   「長く休んだ人」が確実に入り、スコア式の bonus 減算も効きやすくなる。
  const sortPool = (team, played) => {
    return team.map((p, idx) => Object.assign({ _idx: idx }, p)).sort((x, y) => {
      const px = played[x.name] || 0, py = played[y.name] || 0;
      if (px !== py) return px - py;
      const wx = consecSkipWeight[x.name] || 0, wy = consecSkipWeight[y.name] || 0;
      if (wx !== wy) return wy - wx;  // weight 降順
      const lx = lastRound[x.name] || 0, ly = lastRound[y.name] || 0;
      if (lx !== ly) return lx - ly;
      if (x.level !== y.level) return y.level - x.level;
      return x._idx - y._idx;
    });
  };

  const sortedA = sortPool(ctx.teamA, playedA);
  const sortedB = sortPool(ctx.teamB, playedB);

  // 性別別プール（ダブルス・シングルス用。ミックスは別途 none 除外したプールを使う）
  let mA = sortedA.filter(p => p.gender === GENDER.MALE);
  let fA = sortedA.filter(p => p.gender === GENDER.FEMALE);
  let mB = sortedB.filter(p => p.gender === GENDER.MALE);
  let fB = sortedB.filter(p => p.gender === GENDER.FEMALE);

  // ミックス専用プール（mixedPreference='none' を完全除外: ハード制約）
  // spec feature-member-mix-preference-2026-05-22.md §6-1
  // - 'none' メンバーは tryMixed では一切候補にならない
  // - 男ダブ・女ダブ・シングルスでは mA/fA/mB/fB をそのまま使うため、'none' でも他カテゴリには出る
  let mAmix = mA.filter(p => p.mixedPreference !== 'none');
  let fAmix = fA.filter(p => p.mixedPreference !== 'none');
  let mBmix = mB.filter(p => p.mixedPreference !== 'none');
  let fBmix = fB.filter(p => p.mixedPreference !== 'none');

  // 候補窓: 出場回数 最少層を全員＋不足分を次層から補充
  //   + 連続休憩 weight が 2 以上のメンバーが pool 内にいれば強制注入
  //     （仕様 §4-3 / critic OPT-3 対応: 出場回数で外側層になった連続休憩中メンバーが
  //      候補に上がらないことで起きていた worstConsec>=2 を未然防止）
  const makeWindow = (pool, played, minSize) => {
    if (pool.length === 0) return { window: [], minVal: 0 };
    const eff = p => played[p.name] || 0;
    const minVal = eff(pool[0]);
    const win = pool.filter(p => eff(p) === minVal);
    let i = win.length;
    while (win.length < minSize && i < pool.length) win.push(pool[i++]);
    // 連続休憩 weight >= 2 のメンバーを強制注入（重複は除外）
    const inSet = {};
    win.forEach(p => { inSet[p.name] = true; });
    pool.forEach(p => {
      if (!inSet[p.name] && (consecSkipWeight[p.name] || 0) >= 2) {
        win.push(p);
        inSet[p.name] = true;
      }
    });
    return { window: win, minVal };
  };

  const removeByName = (pool, names) => {
    names.forEach(name => {
      const idx = pool.findIndex(p => p.name === name);
      if (idx >= 0) pool.splice(idx, 1);
    });
  };

  // ── ダブルス: 候補窓から最適ペアを選ぶ ──
  const tryDoubles = (poolA, poolB, label) => {
    if (poolA.length < 2 || poolB.length < 2) return null;
    // 案A+ (2026-05-24): makeWindow を pool 全体対象化
    //   旧: minSize=4 → window 外（minVal+2 以上の人）が skip 計算から漏れ
    //       「累計差を直接罰する」案A の効果が pool 全体に行き渡らない
    //   新: minSize=pool.length → 全員を候補窓に入れ、skip 差分式が全員を罰する対象に
    //   3人判定 second-opinion 指摘の「構造的不足」への直接対応
    //   pairs 数: C(6,2)=15 / C(7,2)=21 / C(8,2)=28 で計算量許容範囲
    const wA = makeWindow(poolA, playedA, poolA.length);
    const wB = makeWindow(poolB, playedB, poolB.length);
    // Hard Gap Cap (2026-05-24 オーナー新優先順位):
    //   played - minVal > HARD_GAP_CAP のメンバーを物理的に除外。
    //   除外後に 2 人未満になった場合は fallback (PENALTY で抑制) → 元の window を使う。
    const winACapped = wA.window.filter(p => ((playedA[p.name] || 0) - wA.minVal) <= HARD_GAP_CAP);
    const winBCapped = wB.window.filter(p => ((playedB[p.name] || 0) - wB.minVal) <= HARD_GAP_CAP);
    const winA = winACapped.length >= 2 ? winACapped : wA.window;
    const winB = winBCapped.length >= 2 ? winBCapped : wB.window;
    const pairsA = combinations_(winA, 2);
    const pairsB = combinations_(winB, 2);
    let best = null, bestScore = Infinity;
    pairsA.forEach(([a1, a2]) => {
      pairsB.forEach(([b1, b2]) => {
        // 案A (2026-05-24): skip を「累計差の総和」に変更
        //   旧: 0/1 二値 → +1試合の人と +3試合の人が同じ +10000 ペナルティで等価扱い
        //   新: (played - minVal) の総和 → +3試合×10000=30000、+1試合×10000=10000 で 3 倍ペナルティ
        //   オーナー指摘「個人別成績テーブルで試合数がずれすぎている (5〜8 試合・差3)」への直接対応
        //   2人診断 (2026-05-24-play-count-diagnosis-A/B.md) で根本原因として特定
        const skipBase = Math.max(0, (playedA[a1.name] || 0) - wA.minVal)
                       + Math.max(0, (playedA[a2.name] || 0) - wA.minVal)
                       + Math.max(0, (playedB[b1.name] || 0) - wB.minVal)
                       + Math.max(0, (playedB[b2.name] || 0) - wB.minVal);
        // 2026-05-26: PENALTY → W に置換（ctx.penaltyWeights UI 調整可能化）
        let s = skipBase * W.SKIP_MIN_PLAY;
        // 'none' 包含 bonus (2026-05-24): 'none' メンバーは男ダブでしか出られない希少枠。
        //   候補に 'none' を含むなら bonus 減算（小さい優遇）し、男ダブ枠で優先採用させる。
        //   重み: SKIP_MIN_PLAY × 0.5 × 該当人数 → 試合数差 +0.5 相当の優遇。
        //   試合数均等（SKIP_MIN_PLAY=100000・係数1相当）を上書きしない範囲で 'none' を優先する。
        const nonePool = [a1, a2, b1, b2].filter(p => p.mixedPreference === 'none');
        if (nonePool.length > 0) {
          s -= nonePool.length * W.SKIP_MIN_PLAY * 0.5;
        }
        // クラス2: 累計ベース（既存）
        s += (pairCount[pairKey_([a1.name, a2.name])] || 0) * W.SAME_PAIR;
        s += (pairCount[pairKey_([b1.name, b2.name])] || 0) * W.SAME_PAIR;
        s += (opponentPair[oppPairKey_([a1.name, a2.name], [b1.name, b2.name])] || 0) * W.SAME_OPPONENT_PAIR;
        [a1, a2].forEach(x => [b1, b2].forEach(y => {
          s += (opponentIndiv[x.name + '|' + y.name] || 0) * W.SAME_OPPONENT_INDIV;
        }));
        // クラス2: 直近 N ラウンド窓での再出現（上乗せペナルティ・1位の根幹）
        if (recentPairSet[pairKey_([a1.name, a2.name])]) s += W.RECENT_PAIR_PENALTY;
        if (recentPairSet[pairKey_([b1.name, b2.name])]) s += W.RECENT_PAIR_PENALTY;
        if (recentOpponentSet[oppPairKey_([a1.name, a2.name], [b1.name, b2.name])]) s += W.RECENT_OPPONENT_PENALTY;
        [a1, a2].forEach(x => [b1, b2].forEach(y => {
          if (recentOpponentIndiv[x.name + '|' + y.name]) s += W.RECENT_OPPONENT_INDIV_PENALTY;
        }));
        // クラス3: 連続休憩中メンバーを候補に含めると bonus 減算（出場側へバイアス）
        //   weight = 直近 K ラウンドの連続休憩回数（出場直後=0、長く休んでいるほど大）
        //   合計 weight が大きい候補ほどスコアが下がる → 長く休んだ人が優先される
        const consecWeight = [a1, a2, b1, b2].reduce((sum, p) => sum + (consecSkipWeight[p.name] || 0), 0);
        s -= consecWeight * W.CONSECUTIVE_SKIP_PENALTY;
        // クラス5: level差（2026-05-26 LEVEL_DIFF=0 で無効化済み・計算は残置）
        s += Math.abs((a1.level + a2.level) - (b1.level + b2.level)) * W.LEVEL_DIFF;
        if (s < bestScore) { bestScore = s; best = { a1, a2, b1, b2 }; }
      });
    });
    if (!best) return null;
    removeByName(poolA, [best.a1.name, best.a2.name]);
    removeByName(poolB, [best.b1.name, best.b2.name]);
    // ミックス専用プールからも同名を除外（ダブルスに参加した人は同ラウンド内でミックスに再使用しない）
    removeByName(mAmix, [best.a1.name, best.a2.name]);
    removeByName(fAmix, [best.a1.name, best.a2.name]);
    removeByName(mBmix, [best.b1.name, best.b2.name]);
    removeByName(fBmix, [best.b1.name, best.b2.name]);
    addCount_(pairCount, pairKey_([best.a1.name, best.a2.name]));
    addCount_(pairCount, pairKey_([best.b1.name, best.b2.name]));
    addCount_(opponentPair, oppPairKey_([best.a1.name, best.a2.name], [best.b1.name, best.b2.name]));
    [best.a1.name, best.a2.name].forEach(x => [best.b1.name, best.b2.name].forEach(y => addCount_(opponentIndiv, x + '|' + y)));
    return {
      type: label,
      a1: best.a1.name, a2: best.a2.name,
      b1: best.b1.name, b2: best.b2.name,
      levelA: best.a1.level + best.a2.level,
      levelB: best.b1.level + best.b2.level,
    };
  };

  // ── ミックス: 男A 1+女A 1 vs 男B 1+女B 1 ──
  // spec feature-member-mix-preference-2026-05-22.md §6-1/§6-2:
  //   - 候補プールから 'none' を完全除外（mAmix/fAmix/mBmix/fBmix を使用）
  //   - 'more' は MIX_PREFER_BONUS を減算（優先）
  //   - 'less' は MIX_AVOID_PENALTY を加算（抑制）
  //   - null は中立（無補正）
  const tryMixed = () => {
    if (mAmix.length < 1 || fAmix.length < 1 || mBmix.length < 1 || fBmix.length < 1) return null;
    // 案A+ (2026-05-24): makeWindow を pool 全体対象化（tryDoubles と同じ意図）
    //   ミックスは 4 つの性別別プールから 1 人ずつ選ぶため、各プールも全員を候補に
    const wMA = makeWindow(mAmix, playedA, mAmix.length);
    const wFA = makeWindow(fAmix, playedA, fAmix.length);
    const wMB = makeWindow(mBmix, playedB, mBmix.length);
    const wFB = makeWindow(fBmix, playedB, fBmix.length);
    // Hard Gap Cap (2026-05-24): 各 4 プールで gap>1 を物理除外、空なら fallback
    const winMACapped = wMA.window.filter(p => ((playedA[p.name] || 0) - wMA.minVal) <= HARD_GAP_CAP);
    const winFACapped = wFA.window.filter(p => ((playedA[p.name] || 0) - wFA.minVal) <= HARD_GAP_CAP);
    const winMBCapped = wMB.window.filter(p => ((playedB[p.name] || 0) - wMB.minVal) <= HARD_GAP_CAP);
    const winFBCapped = wFB.window.filter(p => ((playedB[p.name] || 0) - wFB.minVal) <= HARD_GAP_CAP);
    const winMA = winMACapped.length >= 1 ? winMACapped : wMA.window;
    const winFA = winFACapped.length >= 1 ? winFACapped : wFA.window;
    const winMB = winMBCapped.length >= 1 ? winMBCapped : wMB.window;
    const winFB = winFBCapped.length >= 1 ? winFBCapped : wFB.window;
    let best = null, bestScore = Infinity;
    winMA.forEach(a1 => winFA.forEach(a2 => winMB.forEach(b1 => winFB.forEach(b2 => {
      // 案A (2026-05-24): skip を「累計差の総和」に変更（tryDoubles と同じ意図）
      const skip = Math.max(0, (playedA[a1.name] || 0) - wMA.minVal)
                 + Math.max(0, (playedA[a2.name] || 0) - wFA.minVal)
                 + Math.max(0, (playedB[b1.name] || 0) - wMB.minVal)
                 + Math.max(0, (playedB[b2.name] || 0) - wFB.minVal);
      // 2026-05-26: PENALTY → W に置換（ctx.penaltyWeights UI 調整可能化）
      let s = skip * W.SKIP_MIN_PLAY;
      // クラス2: 累計ベース（既存）
      s += (pairCount[pairKey_([a1.name, a2.name])] || 0) * W.SAME_PAIR;
      s += (pairCount[pairKey_([b1.name, b2.name])] || 0) * W.SAME_PAIR;
      s += (opponentPair[oppPairKey_([a1.name, a2.name], [b1.name, b2.name])] || 0) * W.SAME_OPPONENT_PAIR;
      [a1, a2].forEach(x => [b1, b2].forEach(y => {
        s += (opponentIndiv[x.name + '|' + y.name] || 0) * W.SAME_OPPONENT_INDIV;
      }));
      // クラス2: 直近 N ラウンド窓での再出現（上乗せ）
      if (recentPairSet[pairKey_([a1.name, a2.name])]) s += W.RECENT_PAIR_PENALTY;
      if (recentPairSet[pairKey_([b1.name, b2.name])]) s += W.RECENT_PAIR_PENALTY;
      if (recentOpponentSet[oppPairKey_([a1.name, a2.name], [b1.name, b2.name])]) s += W.RECENT_OPPONENT_PENALTY;
      [a1, a2].forEach(x => [b1, b2].forEach(y => {
        if (recentOpponentIndiv[x.name + '|' + y.name]) s += W.RECENT_OPPONENT_INDIV_PENALTY;
      }));
      // クラス3: 連続休憩中メンバーを候補に含めると bonus 減算（weight ベース）
      const consecWeight = [a1, a2, b1, b2].reduce((sum, p) => sum + (consecSkipWeight[p.name] || 0), 0);
      s -= consecWeight * W.CONSECUTIVE_SKIP_PENALTY;
      // クラス5: level差（緩和済）
      s += Math.abs((a1.level + a2.level) - (b1.level + b2.level)) * W.LEVEL_DIFF;
      // クラス4: 個別ミックス希望の選好スコア（'none' はプール除外済のためここに来ない）
      [a1, a2, b1, b2].forEach(p => {
        if (p.mixedPreference === 'more') s -= W.MIX_PREFER_BONUS;
        else if (p.mixedPreference === 'less') s += W.MIX_AVOID_PENALTY;
      });
      if (s < bestScore) { bestScore = s; best = { a1, a2, b1, b2 }; }
    }))));
    if (!best) return null;
    // ミックス確定後は、ダブルス用プールとミックス専用プールの両方から除外
    removeByName(mA, [best.a1.name]);
    removeByName(fA, [best.a2.name]);
    removeByName(mB, [best.b1.name]);
    removeByName(fB, [best.b2.name]);
    removeByName(mAmix, [best.a1.name]);
    removeByName(fAmix, [best.a2.name]);
    removeByName(mBmix, [best.b1.name]);
    removeByName(fBmix, [best.b2.name]);
    addCount_(pairCount, pairKey_([best.a1.name, best.a2.name]));
    addCount_(pairCount, pairKey_([best.b1.name, best.b2.name]));
    addCount_(opponentPair, oppPairKey_([best.a1.name, best.a2.name], [best.b1.name, best.b2.name]));
    [best.a1.name, best.a2.name].forEach(x => [best.b1.name, best.b2.name].forEach(y => addCount_(opponentIndiv, x + '|' + y)));
    return {
      type: CATEGORY.MIXED_DOUBLES,
      a1: best.a1.name, a2: best.a2.name,
      b1: best.b1.name, b2: best.b2.name,
      levelA: best.a1.level + best.a2.level,
      levelB: best.b1.level + best.b2.level,
    };
  };

  // ── シングルス ──
  const trySingles = (poolA, poolB, label) => {
    if (poolA.length < 1 || poolB.length < 1) return null;
    // 案A+ (2026-05-24): makeWindow を pool 全体対象化（tryDoubles と同じ意図）
    const wA = makeWindow(poolA, playedA, poolA.length);
    const wB = makeWindow(poolB, playedB, poolB.length);
    // Hard Gap Cap (2026-05-24): gap>1 を物理除外、空なら fallback
    const winACapped = wA.window.filter(p => ((playedA[p.name] || 0) - wA.minVal) <= HARD_GAP_CAP);
    const winBCapped = wB.window.filter(p => ((playedB[p.name] || 0) - wB.minVal) <= HARD_GAP_CAP);
    const winA = winACapped.length >= 1 ? winACapped : wA.window;
    const winB = winBCapped.length >= 1 ? winBCapped : wB.window;
    let best = null, bestScore = Infinity;
    winA.forEach(a1 => winB.forEach(b1 => {
      // 案A (2026-05-24): skip を「累計差の総和」に変更（tryDoubles と同じ意図）
      const skipBase = Math.max(0, (playedA[a1.name] || 0) - wA.minVal)
                     + Math.max(0, (playedB[b1.name] || 0) - wB.minVal);
      // 2026-05-26: PENALTY → W に置換（ctx.penaltyWeights UI 調整可能化）
      let s = skipBase * W.SKIP_MIN_PLAY;
      // 'none' 包含 bonus (2026-05-24・tryDoubles と同じ意図)
      const nonePool = [a1, b1].filter(p => p.mixedPreference === 'none');
      if (nonePool.length > 0) {
        s -= nonePool.length * W.SKIP_MIN_PLAY * 0.5;
      }
      s += (opponentIndiv[a1.name + '|' + b1.name] || 0) * W.SAME_OPPONENT_INDIV;
      s += Math.abs(a1.level - b1.level) * W.LEVEL_DIFF;
      if (s < bestScore) { bestScore = s; best = { a1, b1 }; }
    }));
    if (!best) return null;
    removeByName(poolA, [best.a1.name]);
    removeByName(poolB, [best.b1.name]);
    addCount_(opponentIndiv, best.a1.name + '|' + best.b1.name);
    return {
      type: label,
      a1: best.a1.name, a2: '',
      b1: best.b1.name, b2: '',
      levelA: best.a1.level, levelB: best.b1.level,
    };
  };

  const courts = ctx.courts;
  const cats = ctx.categories;
  const matches = [];

  // ── スロット制配分（毎コート動的判断 / 3カテゴリー貪欲選択） ──
  const countM = mA.length + mB.length;
  const countF = fA.length + fB.length;

  const maxMD  = Math.min(Math.floor(mA.length / 2), Math.floor(mB.length / 2));
  const maxFD  = Math.min(Math.floor(fA.length / 2), Math.floor(fB.length / 2));
  // ミックスは 'none' を除外した有効プールサイズで上限を決める
  // spec feature-member-mix-preference-2026-05-22.md §6-3 maxMix_eff の同等処理
  const maxMix = Math.min(mAmix.length, fAmix.length, mBmix.length, fBmix.length);

  const sumPlayed = (pool, played) => pool.reduce((s, p) => s + (played[p.name] || 0), 0);
  let avgM = countM > 0 ? (sumPlayed(mA, playedA) + sumPlayed(mB, playedB)) / countM : 0;
  let avgF = countF > 0 ? (sumPlayed(fA, playedA) + sumPlayed(fB, playedB)) / countF : 0;

  // 1試合あたりの平均増分
  const incMD   = countM > 0 ? 4 / countM : Infinity;
  const incFD   = countF > 0 ? 4 / countF : Infinity;
  const incMixM = countM > 0 ? 2 / countM : Infinity;
  const incMixF = countF > 0 ? 2 / countF : Infinity;

  let slotMD = 0, slotFD = 0, slotMix = 0;
  if (slotOverride) {
    slotMD  = Math.min(slotOverride.MD  || 0, cats.mensDoubles    ? maxMD  : 0);
    slotFD  = Math.min(slotOverride.FD  || 0, cats.womensDoubles  ? maxFD  : 0);
    slotMix = Math.min(slotOverride.Mix || 0, cats.mixedDoubles   ? maxMix : 0);
  } else {
    let usedCourts = 0;
    while (usedCourts < courts) {
      const canMD  = cats.mensDoubles    && slotMD  < maxMD;
      const canFD  = cats.womensDoubles  && slotFD  < maxFD;
      const canMix = cats.mixedDoubles   && slotMix < maxMix;
      if (!canMD && !canFD && !canMix) break;

      const candidates = [];
      if (canMD)  candidates.push({ key: 'MD',  score: Math.max(avgM + incMD, avgF) });
      if (canFD)  candidates.push({ key: 'FD',  score: Math.max(avgM, avgF + incFD) });
      if (canMix) candidates.push({ key: 'Mix', score: Math.max(avgM + incMixM, avgF + incMixF) });

      candidates.sort((a, b) => a.score - b.score);
      const pick = candidates[0].key;

      if (pick === 'MD')       { slotMD++;  avgM += incMD; }
      else if (pick === 'FD')  { slotFD++;  avgF += incFD; }
      else if (pick === 'Mix') { slotMix++; avgM += incMixM; avgF += incMixF; }
      usedCourts++;
    }
  }

  for (let c = 0; c < courts; c++) {
    let m = null;
    // 2026-05-24 オーナー指摘対応: カテゴリ選定順序を「ダブルス先 / ミックス後」に固定
    //   旧: slot 数の降順 (`sort((a, b) => b.slot - a.slot)`) で大きい slot を持つカテゴリが先に組まれていた
    //       → 全員 more 等で slotMix が突出 (例: 10) のとき毎コート Mix が先に組まれ、
    //         女性がミックスで消費され女ダブが組めなくなる枯渇問題が発生
    //   新: mDbl → fDbl → mix の固定順序で「ダブルス枠を先に確保 → 残枠でミックス」
    //       slot > 0 のものから順に試行する
    const candidates = [
      { key: 'mDbl', slot: slotMD, fn: () => tryDoubles(mA, mB, CATEGORY.MENS_DOUBLES) },
      { key: 'fDbl', slot: slotFD, fn: () => tryDoubles(fA, fB, CATEGORY.WOMENS_DOUBLES) },
      { key: 'mix',  slot: slotMix, fn: tryMixed },
    ].filter(p => p.slot > 0);

    for (const p of candidates) {
      m = p.fn();
      if (m) {
        if (p.key === 'mDbl') slotMD--;
        else if (p.key === 'fDbl') slotFD--;
        else if (p.key === 'mix') slotMix--;
        break;
      }
    }

    // ダブルス／ミックスで組めなかったらシングルスへフォールバック
    if (!m && cats.mensSingles)   m = trySingles(mA, mB, CATEGORY.MENS_SINGLES);
    if (!m && cats.womensSingles) m = trySingles(fA, fB, CATEGORY.WOMENS_SINGLES);

    if (!m) break;
    m.court = c + 1;
    matches.push(m);
  }

  return matches;
}

/**
 * 旧ロジック（保存用）：ペナルティ最小化マッチ
 * - 性別未対応・男女混ざる可能性あり
 */
function buildRoundByPenalty_(ctx, round) {
  const playedA = countPlayedFromHistory_(ctx.history, ctx.teamA);
  const playedB = countPlayedFromHistory_(ctx.history, ctx.teamB);

  const pairCount = {};
  const opponentPair = {};
  const opponentIndiv = {};
  ctx.history.forEach(m => {
    if (m.a.length === 2) addCount_(pairCount, pairKey_(m.a));
    if (m.b.length === 2) addCount_(pairCount, pairKey_(m.b));
    if (m.a.length === 2 && m.b.length === 2) addCount_(opponentPair, oppPairKey_(m.a, m.b));
    m.a.forEach(x => m.b.forEach(y => addCount_(opponentIndiv, x + '|' + y)));
  });

  const courts = ctx.courts;
  const matches = [];

  const sortPool = (team, played) => {
    return team.slice().sort((x, y) => {
      const px = played[x.name] || 0, py = played[y.name] || 0;
      if (px !== py) return px - py;
      return y.level - x.level;
    });
  };

  let poolA = sortPool(ctx.teamA, playedA);
  let poolB = sortPool(ctx.teamB, playedB);

  for (let c = 0; c < courts; c++) {
    const aLeft = poolA.length, bLeft = poolB.length;
    let useType;
    if (aLeft >= 2 && bLeft >= 2) useType = 'ダブルス';
    else if (aLeft >= 1 && bLeft >= 1) useType = 'シングルス';
    else useType = null;
    if (!useType) break;

    if (useType === 'ダブルス') {
      const candA = poolA.slice(0, Math.min(6, poolA.length));
      const candB = poolB.slice(0, Math.min(6, poolB.length));
      const best = chooseBestDoubles_(candA, candB, pairCount, opponentPair, opponentIndiv);
      poolA = poolA.filter(p => p.name !== best.a1.name && p.name !== best.a2.name);
      poolB = poolB.filter(p => p.name !== best.b1.name && p.name !== best.b2.name);
      matches.push({
        court: c + 1, type: 'ダブルス',
        a1: best.a1.name, a2: best.a2.name,
        b1: best.b1.name, b2: best.b2.name,
        levelA: best.a1.level + best.a2.level,
        levelB: best.b1.level + best.b2.level,
      });
      addCount_(pairCount, pairKey_([best.a1.name, best.a2.name]));
      addCount_(pairCount, pairKey_([best.b1.name, best.b2.name]));
      addCount_(opponentPair, oppPairKey_([best.a1.name, best.a2.name], [best.b1.name, best.b2.name]));
      [best.a1.name, best.a2.name].forEach(x => [best.b1.name, best.b2.name].forEach(y => addCount_(opponentIndiv, x + '|' + y)));
    } else {
      const candA = poolA.slice(0, Math.min(4, poolA.length));
      const candB = poolB.slice(0, Math.min(4, poolB.length));
      const best = chooseBestSingles_(candA, candB, opponentIndiv);
      poolA = poolA.filter(p => p.name !== best.a1.name);
      poolB = poolB.filter(p => p.name !== best.b1.name);
      matches.push({
        court: c + 1, type: 'シングルス',
        a1: best.a1.name, a2: '',
        b1: best.b1.name, b2: '',
        levelA: best.a1.level, levelB: best.b1.level,
      });
      addCount_(opponentIndiv, best.a1.name + '|' + best.b1.name);
    }
  }

  return matches;
}

// ダブルス: 候補リストから (a1,a2) vs (b1,b2) の総当たりを試し、ペナルティ最小を返す
function chooseBestDoubles_(candA, candB, pairCount, opponentPair, opponentIndiv) {
  const pairsA = combinations_(candA, 2);
  const pairsB = combinations_(candB, 2);
  let best = null, bestScore = Infinity;
  pairsA.forEach(([a1, a2]) => {
    pairsB.forEach(([b1, b2]) => {
      const score = scoreDoubles_(a1, a2, b1, b2, pairCount, opponentPair, opponentIndiv);
      if (score < bestScore) {
        bestScore = score;
        best = { a1, a2, b1, b2 };
      }
    });
  });
  return best;
}

function scoreDoubles_(a1, a2, b1, b2, pairCount, opponentPair, opponentIndiv) {
  let s = 0;
  s += (pairCount[pairKey_([a1.name, a2.name])] || 0) * PENALTY.SAME_PAIR;
  s += (pairCount[pairKey_([b1.name, b2.name])] || 0) * PENALTY.SAME_PAIR;
  s += (opponentPair[oppPairKey_([a1.name, a2.name], [b1.name, b2.name])] || 0) * PENALTY.SAME_OPPONENT_PAIR;
  [a1, a2].forEach(x => [b1, b2].forEach(y => {
    s += (opponentIndiv[x.name + '|' + y.name] || 0) * PENALTY.SAME_OPPONENT_INDIV;
  }));
  const lvA = a1.level + a2.level;
  const lvB = b1.level + b2.level;
  s += Math.abs(lvA - lvB) * PENALTY.LEVEL_DIFF;
  return s;
}

function chooseBestSingles_(candA, candB, opponentIndiv) {
  let best = null, bestScore = Infinity;
  candA.forEach(a1 => {
    candB.forEach(b1 => {
      let s = 0;
      s += (opponentIndiv[a1.name + '|' + b1.name] || 0) * PENALTY.SAME_OPPONENT_INDIV;
      s += Math.abs(a1.level - b1.level) * PENALTY.LEVEL_DIFF;
      if (s < bestScore) {
        bestScore = s;
        best = { a1, b1 };
      }
    });
  });
  return best;
}

// ─── 成績集計（純化）───
// Code.gs の updateStats からシート書き込みを除いた集計部だけを抽出
// 戻り値: { team, personal }
//   team     ... { teamAName, teamBName, teamAWin, teamBWin, draw, scored }
//   personal ... [ { team, name, played, win, loss, draw, pf, pa, diff, rate } ... ] (チーム/勝率/出場順)
function calcStats_(history, teamAName, teamBName) {
  // ── チーム別集計 ──
  let teamAWin = 0, teamBWin = 0, draw = 0, scored = 0;
  history.forEach(m => {
    if (m.winner === 'A') { teamAWin++; scored++; }
    else if (m.winner === 'B') { teamBWin++; scored++; }
    else if (m.winner === '引分') { draw++; scored++; }
  });

  // ── 個人別集計 ──
  const personal = {}; // name → { team, played, win, loss, draw, pf, pa }
  const upsert = (name, team) => {
    if (!personal[name]) personal[name] = { team, played: 0, win: 0, loss: 0, draw: 0, pf: 0, pa: 0 };
  };
  history.forEach(m => {
    m.a.forEach(n => upsert(n, teamAName));
    m.b.forEach(n => upsert(n, teamBName));
    const sA = m.scoreA, sB = m.scoreB;
    const hasScore = (sA != null && sB != null && !isNaN(sA) && !isNaN(sB));
    m.a.forEach(n => {
      personal[n].played++;
      if (m.winner === 'A') personal[n].win++;
      else if (m.winner === 'B') personal[n].loss++;
      else if (m.winner === '引分') personal[n].draw++;
      if (hasScore) { personal[n].pf += sA; personal[n].pa += sB; }
    });
    m.b.forEach(n => {
      personal[n].played++;
      if (m.winner === 'B') personal[n].win++;
      else if (m.winner === 'A') personal[n].loss++;
      else if (m.winner === '引分') personal[n].draw++;
      if (hasScore) { personal[n].pf += sB; personal[n].pa += sA; }
    });
  });

  const personalRows = Object.entries(personal).map(([name, s]) => {
    const decided = s.win + s.loss;
    const rate = decided > 0 ? (Math.round(s.win / decided * 1000) / 10) + '%' : '-';
    return {
      team: s.team, name, played: s.played,
      win: s.win, loss: s.loss, draw: s.draw,
      pf: s.pf, pa: s.pa, diff: s.pf - s.pa, rate,
    };
  }).sort((x, y) => {
    // チーム → 勝率（高い順） → 出場（多い順）で並べ替え
    if (x.team !== y.team) return x.team < y.team ? -1 : 1;
    const rx = x.win / Math.max(1, x.win + x.loss);
    const ry = y.win / Math.max(1, y.win + y.loss);
    if (rx !== ry) return ry - rx;
    return y.played - x.played;
  });

  return {
    team: { teamAName, teamBName, teamAWin, teamBWin, draw, scored },
    personal: personalRows,
  };
}

// =============================================================================
// export ガード（Node: module.exports / ブラウザ: window.TennisCore）
// =============================================================================
const __TennisCore__ = {
  // 定数
  GENDER, CATEGORY, PENALTY, DIVERSITY_PARAMS, HARD_GAP_CAP,
  // ヘルパー
  parseLevel_, parseGender_,
  countPlayedFromHistory_, countCategoriesFromHistory_,
  pairKey_, oppPairKey_, addCount_, combinations_,
  // 2026-05-26: アルゴリズム調整 UI 用 PENALTY 上書きヘルパ
  effectivePenalty,
  // プランナー
  planOptimalConfiguration_, decideRoundSlots_,
  // ラウンド生成
  buildRound_, buildRoundByPenalty_,
  chooseBestDoubles_, chooseBestSingles_, scoreDoubles_,
  // 成績集計（純化版）
  calcStats_,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = __TennisCore__;
}
if (typeof window !== 'undefined') {
  window.TennisCore = __TennisCore__;
}
