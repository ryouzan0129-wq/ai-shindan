/* =====================================================================
 * AI超精密性格診断 — script.js
 * 設計書 v1.1 準拠 / Vanilla ES2022 / 依存ライブラリゼロ
 *
 * モジュール構成（このファイル内でセクション分割）
 *   core   : Rng（シード付き乱数） / Bag（シャッフルバッグ） / Store（状態＋永続化）
 *   engine : ThemeEngine / QuestionEngine / HypothesisEngine / Scheduler / AnalysisEngine
 *   ui     : HUD / LogTicker / Toast / QuitDialog / Screens(Router)
 *   share  : Share（Web Share API / クリップボード）
 *
 * コンセプト：約10〜15分で必ず終わる。回答速度により到達質問数が自動調整され、
 * 最後は「何もわかりませんでした。」→ 暗転（画面＝鏡）→ 無駄な◯分、で締める。
 *
 * 設計原則：
 *  - 完了予告（あと少し/99%等）の語彙は一切使わない
 *  - 同じ演出を繰り返さない（全プールをバッグ管理）
 *  - 演出の根拠はすべて実回答データ（嘘のない推定）
 *  - 終了は必ず2タップで可能（ダークパターン禁止）
 * ===================================================================== */

'use strict';

/* =====================================================================
 * 0. ユーティリティ
 * =================================================================== */

/** @type {(id: string) => HTMLElement} */
const $ = (id) => document.getElementById(id);

/** ミリ秒待機 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 範囲制限 */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** HTMLエスケープ（動的ラベル挿入用） */
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 経過分（表示用） */
const fmtMin = (ms) => Math.floor(ms / 60000);

/** 「12分34秒」形式 */
const fmtMinSec = (ms) =>
  `${Math.floor(ms / 60000)}分${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}秒`;

/**
 * 実行時設定。診断は「約10〜15分で必ず終わる」——終了目標時刻をセッションごとに
 * 抽選し、テーマ境界で判定する。回答が速い人ほど多くの質問に到達する（自動調整）。
 * window.__APD_CONFIG__ で上書き可能（README参照）。
 */
const CFG = Object.assign({
  targetMinMs: 10.5 * 60000,   // 終了目標時間の下限
  targetMaxMs: 13.5 * 60000,   // 同上の上限（テーマ境界判定のため実測は約10〜15分に収まる）
  maxAnswers: 220,             // 高速回答時の質問数上限
  realTestUrl: null,           // 「本当に診断したい方はこちら」の遷移先（null = この診断をもう一度）
}, (typeof window !== 'undefined' && window.__APD_CONFIG__) || {});

/* =====================================================================
 * 1. core/Rng — シード付き乱数（mulberry32）
 *    セッション内で再現性を持たせ「一貫した分析」に見せる
 * =================================================================== */
class Rng {
  /** @param {number} seed */
  constructor(seed) {
    this.s = seed >>> 0;
  }
  /** 0以上1未満 */
  next() {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** 0..n-1 の整数 */
  int(n) { return Math.floor(this.next() * n); }
  /** a..b の整数（両端含む） */
  range(a, b) { return a + this.int(b - a + 1); }
  /** 配列から1つ */
  pick(arr) { return arr[this.int(arr.length)]; }
  /** 配列をその場でシャッフル */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

/* =====================================================================
 * 2. core/Bag — 非復元抽選（シャッフルバッグ）
 *    全消費まで重複ゼロ。残りは Store に永続化されリロード後も継続。
 * =================================================================== */
class Bag {
  /**
   * @param {string} name  Store.state.bags 内のキー
   * @param {number} size  プールの要素数
   */
  constructor(name, size) {
    this.name = name;
    this.size = size;
  }
  /** 次のインデックスを取り出す */
  next() {
    const bags = Store.state.bags;
    let arr = bags[this.name];
    if (!Array.isArray(arr) || arr.length === 0 || arr.some((i) => i >= this.size)) {
      arr = rng.shuffle([...Array(this.size).keys()]);
      // リフィル直後に直前と同じものが出ないよう入れ替え
      const last = bags['_last_' + this.name];
      if (arr.length > 1 && arr[arr.length - 1] === last) {
        [arr[arr.length - 1], arr[0]] = [arr[0], arr[arr.length - 1]];
      }
      bags[this.name] = arr;
    }
    const v = arr.pop();
    bags['_last_' + this.name] = v;
    return v;
  }
}

/* =====================================================================
 * 3. core/Store — 状態管理と localStorage 永続化
 * =================================================================== */
const STORAGE_KEY = 'apd.v1';

const Store = {
  /** @type {any} */
  state: null,

  /** 新規セッションの初期状態 */
  fresh() {
    const seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
    return {
      version: 1,
      seed,
      startedAt: Date.now(),
      elapsedMs: 0,          // アクティブ時間のみ加算
      answered: 0,
      themesDone: [],        // [{id, name}]
      openingIndex: 0,
      genCount: 0,
      currentTheme: null,    // 進行中テーマ（生成テーマは質問プランごと保存）
      answers: [],           // [{themeId, themeName, qId, type, value, label, pol, at}]
      hypotheses: [],        // [{key,label,typeIds,conf,delta,note}]
      sched: null,           // Scheduler.init() が設定
      bags: {},
      titleRank: 0,
    };
  },

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      return s && s.version === 1 ? s : null;
    } catch { return null; }
  },

  _saveTimer: 0,
  /** スロットル付き保存（immediate=true で即時） */
  save(immediate = false) {
    const doSave = () => {
      try {
        // 容量対策：回答ログは直近400件のみ保持（リコール引用には十分）
        if (Store.state.answers.length > 400) {
          Store.state.answers = Store.state.answers.slice(-400);
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(Store.state));
      } catch (e) {
        // QuotaExceeded 等：古い回答を間引いて再試行
        try {
          Store.state.answers = Store.state.answers.slice(-120);
          localStorage.setItem(STORAGE_KEY, JSON.stringify(Store.state));
        } catch { /* 保存不能でも診断は続行できる */ }
      }
    };
    if (immediate) { clearTimeout(Store._saveTimer); doSave(); return; }
    clearTimeout(Store._saveTimer);
    Store._saveTimer = setTimeout(doSave, 800);
  },

  reset() {
    Store.state = Store.fresh();
    Store.save(true);
  },
};

/* =====================================================================
 * 4. アクティブ時間トラッカー
 *    タブが見えている間だけ elapsedMs を加算（放置で称号は稼げない）
 * =================================================================== */
const Clock = {
  activeSince: 0,
  start() { if (!Clock.activeSince) Clock.activeSince = Date.now(); },
  pause() {
    if (Clock.activeSince) {
      Store.state.elapsedMs += Date.now() - Clock.activeSince;
      Clock.activeSince = 0;
      Store.save();
    }
  },
  /** 現在の累計アクティブ時間(ms) */
  elapsed() {
    return Store.state.elapsedMs + (Clock.activeSince ? Date.now() - Clock.activeSince : 0);
  },
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden) Clock.pause();
  else if (UI.inSession) Clock.start();
});
window.addEventListener('pagehide', () => { Clock.pause(); Store.save(true); });

/* =====================================================================
 * グローバル（init() で設定）
 * =================================================================== */
/** @type {Rng} */ let rng;
/** @type {any} */ let TH;   // themes.json
/** @type {any} */ let QS;   // questions.json
/** @type {Record<string, Bag>} */ const bags = {};

/* =====================================================================
 * 5. engine/ThemeEngine — テーマ供給（序盤固定 → コア20 → 無限生成）
 * =================================================================== */
const ThemeEngine = {
  /** id からコアテーマ定義を引く */
  core(id) { return TH.coreThemes.find((t) => t.id === id); },

  /** 次のテーマを決定して currentTheme にセット */
  begin() {
    const s = Store.state;
    let theme;

    if (s.openingIndex < TH.openingSequence.length) {
      // ① 序盤固定シーケンス（信頼構築区間）
      const def = ThemeEngine.core(TH.openingSequence[s.openingIndex]);
      s.openingIndex++;
      theme = { kind: 'core', id: def.id, name: def.name, icon: def.icon,
                hue: def.hue, traits: def.traits, qIndex: 0 };
    } else if (s.themesDone.length < TH.coreThemes.length) {
      // ② コアテーマ層（バッグから非復元）
      const pool = TH.coreThemes.filter((t) => !TH.openingSequence.includes(t.id));
      if (!bags.coreTheme) bags.coreTheme = new Bag('coreTheme', pool.length);
      const doneIds = new Set(s.themesDone.map((t) => t.id));
      let def = null;
      for (let i = 0; i < pool.length + 1 && !def; i++) {
        const cand = pool[bags.coreTheme.next()];
        if (!doneIds.has(cand.id)) def = cand;
      }
      if (def) {
        theme = { kind: 'core', id: def.id, name: def.name, icon: def.icon,
                  hue: def.hue, traits: def.traits, qIndex: 0 };
      } else {
        theme = ThemeEngine.generate(); // コア消化済み → 生成層へ
      }
    } else {
      // ③ 生成テーマ層（無限）
      theme = ThemeEngine.generate();
    }

    ThemeEngine.decorate(theme);
    theme.intro = ThemeEngine.pickIntro(theme);
    s.currentTheme = theme;
    Store.save();
    return theme;
  },

  /**
   * 分析フェーズの付与（HUD表示用）。
   * 序盤: Primary → Secondary → 以降フェーズバンク。
   * 生成テーマ: 名前の「Cross Analysis — 仕事 × 恋愛」等から接頭辞をフェーズに、
   * 残りをテーマ名として分離（表示の重複を防ぐ）。
   */
  decorate(theme) {
    const done = Store.state.themesDone.length;
    if (theme.kind === 'gen') {
      const m = theme.name.match(
        /^(Phase \d+|Deep Layer|Cross Analysis|Extended Scan|Behavior Trace)\s*—\s*(.+)$/);
      if (m) { theme.phase = m[1]; theme.shortName = m[2]; }
      else { theme.phase = TH.phaseBank[bags.phase.next()]; theme.shortName = theme.name; }
    } else if (done === 0) {
      theme.phase = 'Primary Analysis';
    } else if (done === 1) {
      theme.phase = 'Secondary Analysis';
    } else {
      theme.phase = TH.phaseBank[bags.phase.next()];
    }
    theme.shortName ??= theme.name;
  },

  /** 生成テーマ：命名テンプレ × 軸 × 修飾。質問プランも同時に確定して永続化 */
  generate() {
    const s = Store.state;
    const g = TH.generator;
    s.genCount++;

    const axisIdx = bags.axis.next();
    const axis = g.axes[axisIdx];
    const tpl = g.nameTemplates[bags.name.next()];
    // {themeA}/{themeB} はコアテーマ名に限定（生成名の入れ子を防ぐ）
    const done = s.themesDone.filter((t) => !String(t.id).startsWith('gen:'));
    const a = done.length ? rng.pick(done).name : axis;
    let b = a;
    if (done.length > 1) {
      for (let i = 0; i < 6 && b === a; i++) b = rng.pick(done).name;
    }
    const name = tpl
      .replaceAll('{n}', String(done.length + 1))
      .replaceAll('{axis}', axis)
      .replaceAll('{themeA}', a)
      .replaceAll('{themeB}', b)
      .replaceAll('{modifier}', g.modifiers[bags.modifier.next()].label);

    // 特性3種（汎用バンクから重複なし）
    const traits = [];
    while (traits.length < 3) {
      const t = g.traitBank[bags.trait.next()];
      if (!traits.includes(t)) traits.push(t);
    }

    return {
      kind: 'gen',
      id: `gen:${s.genCount}:${axisIdx}`,
      name, axis, icon: '◈',
      hue: (200 + axisIdx * 37) % 360,
      traits,
      qIndex: 0,
      plan: QuestionEngine.buildPlan(axis),   // 復元可能なようプランごと保存
    };
  },

  /**
   * テーマ導入文：完了テーマ間の実回答統計から選択（データ駆動＝嘘がない）
   * 差異最大ペアの実名を {themeA}/{themeB} に流し込む。
   */
  pickIntro(theme) {
    const s = Store.state;
    if (s.themesDone.length === 0) return null; // 最初のテーマは導入なし
    const g = TH.generator;
    const stats = HypothesisEngine.perThemeScores();
    let a = s.themesDone[0].name, b = a, maxDiff = 0;
    const names = Object.keys(stats);
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const d = Math.abs(stats[names[i]] - stats[names[j]]);
        if (d >= maxDiff) { maxDiff = d; a = names[i]; b = names[j]; }
      }
    }
    // {themeB} を要求するテンプレは完了2テーマ以上が条件 → 満たすまで引き直し
    let tpl = '';
    for (let i = 0; i < 8; i++) {
      tpl = g.introTemplates[bags.intro.next()];
      if (!tpl.includes('{themeB}') || names.length >= 2) break;
    }
    return tpl
      .replaceAll('{themeA}', a)
      .replaceAll('{themeB}', b)
      .replaceAll('{axis}', theme.axis ?? theme.name);
  },
};

/* =====================================================================
 * 6. engine/QuestionEngine — 質問の組み立て（擬似アダプティブ）
 * =================================================================== */
const QuestionEngine = {
  /** 現テーマの質問リスト（コア＝手書き / 生成＝保存済みプラン） */
  list(theme) {
    return theme.kind === 'core' ? QS.core[theme.id] : theme.plan;
  },

  /** 生成テーマの質問プラン：8〜12問、タイプ混在、テンプレはバッグで重複なし */
  buildPlan(axis) {
    const n = rng.range(8, 12);
    const typeCycle = rng.shuffle(['l', 'c', 'b', 'l', 'c', 'l', 'b', 'c', 'l', 'c', 'b', 'l']);
    const plan = [];
    for (let i = 0; i < n; i++) {
      const t = typeCycle[i % typeCycle.length];
      if (t === 'l') {
        const q = QS.templates.likert[bags.tplL.next()];
        plan.push({ id: `g${i}`, t: 'l', q: q.replaceAll('{axis}', axis) });
      } else if (t === 'c') {
        const src = QS.templates.choice[bags.tplC.next()];
        plan.push({ id: `g${i}`, t: 'c',
          q: src.q.replaceAll('{axis}', axis), o: src.o, p: src.p });
      } else {
        const src = QS.templates.binary[bags.tplB.next()];
        plan.push({ id: `g${i}`, t: 'b',
          q: src.q.replaceAll('{axis}', axis), o: src.o, p: src.p });
      }
    }
    return plan;
  },

  /**
   * 表示用に質問を確定する。
   * - Scheduler がリコール予定なら「過去回答引用」質問を差し込む（実データ）
   * - 直前回答の極性が強ければ接頭辞バリアントを付与（クールダウン付き）
   * @returns {{q: object, recall: boolean, prefix: string|null}}
   */
  resolve(theme) {
    const s = Store.state;
    const base = QuestionEngine.list(theme)[theme.qIndex];

    // --- リコール（約40〜60問に1回・4分以上前の実回答を引用） ---
    if (Scheduler.recallDue()) {
      const past = QuestionEngine.pickRecallSource();
      if (past) {
        Scheduler.recallDone();
        const tpl = QS.recallTemplates.items[bags.recall.next()];
        const min = Math.max(1, fmtMin(Date.now() - past.at));
        return {
          q: {
            id: 'recall', t: 'b',
            q: tpl.replaceAll('{min}', String(min))
                  .replaceAll('{theme}', past.themeName)
                  .replaceAll('{answer}', past.label),
            o: tpl.o, p: tpl.p,
          },
          recall: true, prefix: null,
        };
      }
    }

    // --- 接頭辞バリアント（直前回答が strong のとき） ---
    let prefix = null;
    const prev = s.answers[s.answers.length - 1];
    if (prev && theme.qIndex > 0 && Scheduler.prefixReady()) {
      if (prev.pol >= 0.9) prefix = QS.variantPrefixes.hi[bags.prefixHi.next()];
      else if (prev.pol <= -0.9) prefix = QS.variantPrefixes.lo[bags.prefixLo.next()];
      if (prefix) Scheduler.prefixUsed();
    }
    return { q: base, recall: false, prefix };
  },

  /** リコール引用元：4分以上前・別テーマ・ラベル付き（choice/binary）の実回答 */
  pickRecallSource() {
    const s = Store.state;
    const cutoff = Date.now() - 4 * 60000;
    const cands = s.answers.filter((a) =>
      a.at < cutoff && a.label && a.themeId !== s.currentTheme.id);
    return cands.length ? rng.pick(cands) : null;
  },

  /** 回答を記録して極性を返す */
  record(theme, q, value, label) {
    const s = Store.state;
    let pol = 0;
    if (q.t === 'l') pol = (value - 2) / 2;          // 0..4 → -1..1
    else pol = q.p ? q.p[value] : 0;                  // 選択肢の極性
    s.answers.push({
      themeId: theme.id, themeName: theme.name,
      qId: q.id, type: q.t, value, label: label ?? null, pol, at: Date.now(),
    });
    s.answered++;
    Store.save();
    Titles.check();
    return pol;
  },
};

/* =====================================================================
 * 7. engine/HypothesisEngine — 仮説の生成・更新・分岐
 *    信頼度は 55〜70% で開始 → 揺らぎながら上昇 → 上限93%で複合型に分岐。
 *    「確定しない」ことがプレイ中の診断継続の因果になる。
 * =================================================================== */
const HypothesisEngine = {
  CAP: 93,

  /** テーマごとの平均極性（-1..1）。導入文・レポートの根拠 */
  perThemeScores() {
    const acc = {};
    for (const a of Store.state.answers) {
      (acc[a.themeName] ??= []).push(a.pol);
    }
    const out = {};
    for (const [k, v] of Object.entries(acc)) {
      out[k] = v.reduce((x, y) => x + y, 0) / v.length;
    }
    return out;
  },

  /** 全回答の平均極性 */
  overall() {
    const a = Store.state.answers;
    if (!a.length) return 0;
    return a.reduce((x, y) => x + y.pol, 0) / a.length;
  },

  /** 極性 → 仮説タイプ候補（実データに整合するタイプだけを選ぶ） */
  matchType(excludeIds) {
    const score = HypothesisEngine.overall();
    const pole = score > 0.15 ? 'high' : score < -0.15 ? 'low' : 'mixed';
    const pool = TH.hypotheses.baseTypes.filter(
      (t) => (t.pole === pole || t.pole === 'mixed') && !excludeIds.includes(t.id));
    return pool.length ? rng.pick(pool)
                       : rng.pick(TH.hypotheses.baseTypes.filter((t) => !excludeIds.includes(t.id))
                                  .concat([TH.hypotheses.baseTypes[0]]));
  },

  /**
   * テーマ終了ごとに呼ぶ。インタースティシャル表示用の仮説カード情報を返す。
   * @returns {null | {key,label,conf,delta,note}}
   */
  onThemeComplete() {
    const s = Store.state;
    const N = TH.hypotheses.notes;
    const hs = s.hypotheses;
    const themesDone = s.themesDone.length;

    // 初出：2テーマ完了後に仮説A
    if (hs.length === 0) {
      if (themesDone < 2) return null;
      const t = HypothesisEngine.matchType([]);
      hs.push({ key: 'A', label: t.label, typeIds: [t.id],
                conf: rng.range(55, 70), delta: 0 });
      Store.save();
      return { ...hs[0], note: N.added };
    }

    // 新仮説の追加（4〜5テーマごと・最大3本）
    if (hs.length < 3 && themesDone >= Store.state.sched.hypoAddAtTheme) {
      Store.state.sched.hypoAddAtTheme = themesDone + rng.range(4, 5);
      const used = hs.flatMap((h) => h.typeIds);
      const t = HypothesisEngine.matchType(used);
      const h = { key: String.fromCharCode(65 + hs.length), label: t.label,
                  typeIds: [t.id], conf: rng.range(55, 66), delta: 0 };
      hs.push(h);
      Store.save();
      return { ...h, note: N.added };
    }

    // 既存仮説をローテーションで更新
    const i = Store.state.sched.hypoCursor % hs.length;
    Store.state.sched.hypoCursor++;
    const h = hs[i];
    const d = rng.range(3, 9);
    if (h.conf + d >= HypothesisEngine.CAP) {
      // 上限到達 → 複合型へ分岐（確定はさせない）
      const used = hs.flatMap((x) => x.typeIds);
      const t = HypothesisEngine.matchType(used);
      const joiner = TH.hypotheses.compositeJoiner;
      const baseLabel = h.label.split(joiner)[0];
      h.label = baseLabel + joiner + t.label;
      h.typeIds = [h.typeIds[0], t.id];
      h.conf = rng.range(58, 66);
      h.delta = 0;
      Store.save();
      return { ...h, note: N.forked };
    }
    h.conf += d;
    h.delta = d;
    Store.save();
    return { ...h, note: rng.next() < 0.5 ? N.updated : N.verifying };
  },
};

/* =====================================================================
 * 8. engine/Scheduler — リコール / 再評価 / 特別演出 / 接頭辞の間隔管理
 *    すべて answered / themesDone を基準にジッター付きで発火。
 * =================================================================== */
const Scheduler = {
  init() {
    Store.state.sched = {
      reevalAt: rng.range(25, 35),      // 再評価オーバーレイ
      recallAt: rng.range(40, 60),      // 長期記憶リコール
      specialAtTheme: rng.range(3, 4),  // 特別演出インタースティシャル
      hypoAddAtTheme: rng.range(5, 6),  // 新仮説追加
      noteAt: rng.range(28, 34),        // 分析ノート（約30問ごと）
      targetMs: rng.range(CFG.targetMinMs, CFG.targetMaxMs), // このセッションの終了目標
      hypoCursor: 0,
      prefixLastAt: -10,                // 接頭辞クールダウン
    };
  },
  reevalDue() {
    return Store.state.answered >= Store.state.sched.reevalAt;
  },
  reevalDone() {
    Store.state.sched.reevalAt = Store.state.answered + rng.range(25, 35);
    Store.save();
  },
  recallDue() {
    return Store.state.answered >= Store.state.sched.recallAt;
  },
  recallDone() {
    Store.state.sched.recallAt = Store.state.answered + rng.range(40, 60);
    Store.save();
  },
  specialDue() {
    return Store.state.themesDone.length >= Store.state.sched.specialAtTheme;
  },
  specialDone() {
    Store.state.sched.specialAtTheme =
      Store.state.themesDone.length + rng.range(3, 4);
    Store.save();
  },
  noteDue() {
    return Store.state.answered >= (Store.state.sched.noteAt ?? Infinity);
  },
  noteDone() {
    Store.state.sched.noteAt = Store.state.answered + rng.range(28, 34);
    Store.save();
  },
  /** 診断終了の判定（テーマ境界で呼ぶ）：目標時間到達 or 質問数上限 */
  finaleDue() {
    return Clock.elapsed() >= (Store.state.sched.targetMs ?? Infinity)
        || Store.state.answered >= CFG.maxAnswers;
  },
  prefixReady() {
    return Store.state.answered - Store.state.sched.prefixLastAt >= 4;
  },
  prefixUsed() {
    Store.state.sched.prefixLastAt = Store.state.answered;
    Store.save();
  },
};

/* =====================================================================
 * 9. engine/AnalysisEngine — 解析メッセージ / ローダー / ミニレポート
 * =================================================================== */
const AnalysisEngine = {
  /** ローダー6種のマークアップ（CSSの契約どおり） */
  loaderHTML() {
    const kinds = [
      '<div class="ldr ldr-radar"><i></i></div>',
      '<div class="ldr ldr-wave"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>',
      '<div class="ldr ldr-dots"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>',
      '<div class="ldr ldr-hex"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>',
      '<div class="ldr ldr-bars"><i></i><i></i><i></i><i></i><i></i><i></i></div>',
      '<div class="ldr ldr-ring"></div>',
    ];
    return kinds[bags.loader.next()];
  },

  /** 通常メッセージ（{theme}置換・バッグ管理） */
  normalMsg(themeName) {
    return TH.analysisMessages.normal[bags.msg.next()]
      .replaceAll('{theme}', themeName);
  },
  specialMsg() {
    return TH.analysisMessages.special[bags.special.next()];
  },

  /**
   * ミニレポート：特性3種 × 6セルバー。
   * 値は「テーマの実回答統計 + 特性ごとのジッター」→ 毎回違うが完全デタラメではない。
   */
  report(theme) {
    const scores = HypothesisEngine.perThemeScores();
    const base = scores[theme.name] ?? 0;               // -1..1
    return theme.traits.map((label) => ({
      label,
      value: clamp(Math.round(3.5 + base * 1.5 + (rng.next() * 2 - 1)), 1, 6),
    }));
  },

  /** レイヤーメーター：EN層名3本×充填率%。実回答統計＋ジッターで算出 */
  layers(theme) {
    const scores = HypothesisEngine.perThemeScores();
    const base = scores[theme.name] ?? 0;
    const out = [];
    while (out.length < 3) {
      const label = TH.layerBank[bags.layer.next()];
      if (!out.some((x) => x.label === label)) {
        out.push({
          label,
          value: clamp(Math.round(72 + base * 14 + (rng.next() * 2 - 1) * 16), 46, 98),
        });
      }
    }
    return out;
  },

  /**
   * 分析ノート（約30問ごと）：完了テーマ間の実回答統計を比較し、
   * 差異が大きければ contrast、揃っていれば aligned のテンプレを使う。
   * → 表示される「読み」は常に実データと矛盾しない。
   */
  note() {
    const N = TH.analysisNotes;
    const scores = HypothesisEngine.perThemeScores();
    const names = Object.keys(scores);
    if (names.length < 2) return null;
    // 差異最大のペアを特定
    let a = names[0], b = names[1], maxDiff = -1;
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const d = Math.abs(scores[names[i]] - scores[names[j]]);
        if (d > maxDiff) { maxDiff = d; a = names[i]; b = names[j]; }
      }
    }
    const dir = (v) => v > 0.12 ? rng.pick(N.dir.high)
      : v < -0.12 ? rng.pick(N.dir.low) : rng.pick(N.dir.mixed);
    const contrast = maxDiff > 0.35;
    const tpl = contrast
      ? N.contrast[bags.noteC.next()]
      : N.aligned[bags.noteA.next()];
    return tpl
      .replaceAll('{themeA}', a)
      .replaceAll('{themeB}', b)
      .replaceAll('{dirA}', dir(scores[a]))
      .replaceAll('{dirB}', dir(scores[b]));
  },
};

/* =====================================================================
 * 10. 称号
 * =================================================================== */
const Titles = {
  current(answered = Store.state.answered) {
    return TH.titles.find((t) => answered >= t.min) ?? TH.titles[TH.titles.length - 1];
  },
  /** 回答のたびに閾値超えをチェックしてトースト通知 */
  check() {
    const t = Titles.current();
    if (t.rank > Store.state.titleRank) {
      Store.state.titleRank = t.rank;
      Store.save();
      UI.toast(`称号を取得 <span class="gold">${esc(t.label)}</span>`);
    }
  },
};

/* =====================================================================
 * 11. ui — HUD / ログティッカー / トースト
 * =================================================================== */
const UI = {
  inSession: false,
  _tick: 0,
  _log: 0,
  _status: 0,
  _lastCount: -1,

  hud(show) {
    $('hud').hidden = !show;
    if (show) { UI._lastCount = -1; UI.hudUpdate(); }
  },
  hudUpdate() {
    // 回答数：増えた瞬間だけ数字が下からぬるっと入れ替わる
    const c = Store.state.answered;
    if (c !== UI._lastCount) {
      const el = $('hud-count');
      el.textContent = String(c);
      if (UI._lastCount >= 0) {
        el.classList.remove('roll');
        void el.offsetWidth;            // reflowでアニメーション再トリガ
        el.classList.add('roll');
      }
      UI._lastCount = c;
    }
    // 分析フェーズ ＋ テーマ名（プレイ時間はHUDに出さない＝記録画面のみ）
    const t = Store.state.currentTheme;
    $('hud-phase').textContent = t?.phase ?? '';
    $('hud-theme').textContent = t?.shortName ?? t?.name ?? '—';
  },
  /** テーマ内進捗ゲージ（0〜1）。全体進捗はどこにも存在しない */
  setGauge(ratio) {
    $('hud-gauge-fill').style.width = `${clamp(ratio, 0, 1) * 100}%`;
  },

  /** AIログ1行を合成（subsystems × statuses ＋ 数値 ＋ テーマ差し込み ≒ 500通り以上） */
  makeLog() {
    const L = TH.logSystem;
    const r = rng.next();
    const t = Store.state.currentTheme;
    if (r < 0.15 && t) {
      return `「${t.shortName ?? t.name}」 Layer — ${L.statuses[bags.logStat.next()]}`;
    }
    const sub = L.subsystems[bags.logSub.next()];
    if (r < 0.42) {
      const kind = rng.int(4);
      const num = kind === 0 ? `${rng.range(84, 99)}%`
        : kind === 1 ? `${Store.state.answered} samples`
        : kind === 2 ? `Δ0.${rng.range(1, 9)}`
        : `L${rng.range(2, 6)}`;
      return `${sub} — ${num}`;
    }
    return `${sub} — ${L.statuses[bags.logStat.next()]}`;
  },

  startTicker() {
    clearInterval(UI._tick);
    UI._tick = setInterval(UI.hudUpdate, 1000);

    // 画面下：AIログ（4.2秒ごとにフェード差し替え）
    clearInterval(UI._log);
    const swap = () => {
      const el = $('ai-log-text');
      el.classList.add('swap');
      setTimeout(() => {
        el.textContent = UI.makeLog();
        el.classList.remove('swap');
      }, 400);
    };
    swap();
    UI._log = setInterval(swap, 4200);

    // ヘッダー下：分析ステータス（AI Precision — High 等を7秒ごとに回転）
    clearInterval(UI._status);
    const status = () => {
      const [k, v] = TH.statusBank[bags.status.next()];
      $('hud-status').textContent = `${k} — ${v}`;
    };
    status();
    UI._status = setInterval(status, 7000);
  },
  stopTicker() {
    clearInterval(UI._tick);
    clearInterval(UI._log);
    clearInterval(UI._status);
    $('ai-log-text').textContent = '';
  },

  /** テーマの色相で「分析オーロラ」を回す */
  aurora(hue) {
    document.documentElement.style.setProperty('--hue', String(hue));
  },

  _toastTimer: 0,
  toast(html) {
    const t = $('toast');
    t.innerHTML = html;
    t.hidden = false;
    clearTimeout(UI._toastTimer);
    UI._toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  },
};

/* =====================================================================
 * 12. ui/QuitDialog — 終了確認（段階表示・最終ボタンは必ず終了）
 * =================================================================== */
const QuitDialog = {
  step: 1,
  open() {
    QuitDialog.step = 1;
    QuitDialog.render();
    QuitDialog.show(true);
    $('quit-back').focus();
  },
  /** showModal 未対応環境（ごく旧いブラウザ）向けフォールバック付き表示制御 */
  show(on) {
    const dlg = /** @type {HTMLDialogElement} */ ($('quit-dialog'));
    if (on) {
      if (typeof dlg.showModal === 'function') dlg.showModal();
      else dlg.setAttribute('open', '');
    } else {
      if (typeof dlg.close === 'function') dlg.close();
      else dlg.removeAttribute('open');
    }
  },
  render() {
    const n = Store.state.answered;
    if (QuitDialog.step === 1) {
      $('quit-body').innerHTML = `
        <p>ここまでの分析結果は保存されません。</p>
        <p>現在までに <b class="num">${n}</b> 問回答しています。</p>`;
      $('quit-back').textContent = '分析にもどる';
      $('quit-confirm').textContent = '終了する';
    } else {
      $('quit-body').innerHTML = `
        <p>ここまで分析した内容は破棄されます。</p>
        <p>本当に終了しますか？</p>
        <p style="font-size:12px; opacity:.7;">※AIは引き止めません。少し残念そうにしていますが。</p>`;
      $('quit-back').textContent = 'もう少しだけ続ける';
      $('quit-confirm').textContent = '終了する';
    }
  },
  wire() {
    const dlg = /** @type {HTMLDialogElement} */ ($('quit-dialog'));
    $('btn-quit').addEventListener('click', QuitDialog.open);
    $('quit-back').addEventListener('click', () => QuitDialog.show(false));
    $('quit-confirm').addEventListener('click', () => {
      if (QuitDialog.step === 1) {
        QuitDialog.step = 2;      // 段階は2つまで。3回目の確認はしない
        QuitDialog.render();
      } else {
        QuitDialog.show(false);
        Screens.abort();          // 必ず終了できる
      }
    });
    // 背景タップ＝もどる（誤タップで終了させない）
    dlg.addEventListener('click', (e) => { if (e.target === dlg) QuitDialog.show(false); });
  },
};

/* =====================================================================
 * 13. ui/Screens — 画面レンダラ（Router）
 * =================================================================== */
const Screens = {
  /* ---------- ホーム ---------- */
  home() {
    UI.inSession = false;
    Clock.pause();
    UI.stopTicker();
    UI.hud(false);
    UI.aurora(226);
    const s = Store.load();
    const resumable = s && s.answered > 0 && s.currentTheme;
    $('screen').innerHTML = `
      <div class="screen home">
        <div class="home-core" aria-hidden="true">
          <svg class="core-svg" viewBox="0 0 120 120">
            <defs>
              <radialGradient id="coreG" cx="50%" cy="42%" r="62%">
                <stop offset="0%" stop-color="#B9C4FF"/>
                <stop offset="55%" stop-color="#7C8CFF"/>
                <stop offset="100%" stop-color="#4FD8C8"/>
              </radialGradient>
            </defs>
            <circle class="core-ring r1" cx="60" cy="60" r="52" fill="none"
                    stroke="currentColor" stroke-width="1" stroke-dasharray="2 6" opacity=".5"/>
            <circle class="core-ring r2" cx="60" cy="60" r="41" fill="none"
                    stroke="currentColor" stroke-width="1" stroke-dasharray="1 4" opacity=".35"/>
            <circle class="core-dot d1" cx="60" cy="8"  r="2.6" fill="currentColor"/>
            <circle class="core-dot d2" cx="101" cy="60" r="2"  fill="currentColor" opacity=".8"/>
            <circle class="core-dot d3" cx="60" cy="112" r="2"  fill="currentColor" opacity=".6"/>
            <circle class="core-halo" cx="60" cy="60" r="23" fill="none"
                    stroke="url(#coreG)" stroke-width="1.5"/>
            <circle class="core-orb" cx="60" cy="60" r="23" fill="url(#coreG)"/>
          </svg>
        </div>
        <h1>AI超精密性格診断</h1>
        <p class="sub">最新AIがあなたを多角的に分析します</p>
        <div class="home-actions">
          <button id="btn-start" class="btn btn-primary btn-block" type="button">診断をはじめる</button>
          ${resumable ? `<button id="btn-resume" class="btn btn-ghost resume" type="button">
              前回の続きから — ${s.answered}問回答済み</button>` : ''}
        </div>
        <div class="ad-slot" data-slot="home"></div>
      </div>`;
    $('btn-start').addEventListener('click', () => {
      Store.reset();
      Screens.bootSession(true);
    });
    if (resumable) {
      $('btn-resume').addEventListener('click', () => {
        Store.state = s;
        Screens.bootSession(false);
      });
    }
  },

  /** セッション開始/再開の共通処理 */
  bootSession(freshStart) {
    rng = new Rng(Store.state.seed);
    if (!Store.state.sched) Scheduler.init();
    if (Store.state.sched.targetMs == null) {   // 旧バージョンからの復元
      Store.state.sched.targetMs = rng.range(CFG.targetMinMs, CFG.targetMaxMs);
    }
    UI.inSession = true;
    Clock.start();
    UI.hud(true);
    UI.startTicker();
    const ct = Store.state.currentTheme;
    if (freshStart || !ct) {
      ThemeEngine.begin();
    } else if (ct.qIndex >= QuestionEngine.list(ct).length) {
      // インタースティシャル中に離脱した場合の復元：テーマを完了扱いにして次へ
      if (!Store.state.themesDone.some((t) => t.id === ct.id)) {
        Store.state.themesDone.push({ id: ct.id, name: ct.name });
      }
      ThemeEngine.begin();
    }
    UI.aurora(Store.state.currentTheme.hue);
    UI.hudUpdate();
    Screens.question();
  },

  /* ---------- 質問 ---------- */
  question() {
    const theme = Store.state.currentTheme;
    const { q, recall, prefix } = QuestionEngine.resolve(theme);

    const qText = (prefix ? esc(prefix) : '') + esc(q.q);
    let body = '';
    if (q.t === 'c') {
      body = `<div class="opt-list">${q.o.map((o, i) =>
        `<button class="opt" type="button" data-i="${i}">${esc(o)}</button>`).join('')}</div>`;
    } else if (q.t === 'b') {
      body = `<div class="binary-grid">${q.o.map((o, i) =>
        `<button class="opt" type="button" data-i="${i}">${esc(o)}</button>`).join('')}</div>`;
    } else {
      const [lo, hi] = QS.likertAnchors;
      body = `
        <div class="likert">
          <div class="likert-row">
            ${[0, 1, 2, 3, 4].map((i) =>
              `<button class="likert-opt" type="button" data-i="${i}"
                aria-label="${i === 0 ? lo : i === 4 ? hi : `段階${i + 1}`}"></button>`).join('')}
          </div>
          <div class="likert-labels"><span>${esc(lo)}</span><span>${esc(hi)}</span></div>
        </div>`;
    }

    $('screen').innerHTML = `
      <div class="screen question">
        <div class="q-eyebrow">
          <span class="chip">${esc(theme.icon ?? '◈')} ${esc(theme.name)}</span>
        </div>
        <div class="q-card card glass entering">
          ${recall ? '<p class="q-recall">回答履歴を参照しています</p>' : ''}
          <p class="q-text">${qText}</p>
          ${body}
        </div>
      </div>`;

    // テーマ内進捗ゲージ（このテーマの何問目か。総量は見せない）
    UI.setGauge(theme.qIndex / QuestionEngine.list(theme).length);

    // 回答ハンドラ（1回だけ・視覚フィードバック後に遷移）
    const card = document.querySelector('.q-card');
    let answered = false;
    card.querySelectorAll('[data-i]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (answered) return;
        answered = true;
        btn.classList.add('picked');
        const i = Number(btn.dataset.i);
        const label = q.t === 'l' ? null : q.o[i];
        QuestionEngine.record(theme, q, i, label);
        UI.hudUpdate();
        await sleep(230);
        await Screens.afterAnswer(theme, recall);
      });
    });
  },

  /** 回答後の分岐：再評価イベント → 次の質問 or テーマ終了 */
  async afterAnswer(theme, wasRecall) {
    // ランダム再評価イベント（質問を1秒だけ遮る演出）
    if (Scheduler.reevalDue()) {
      Scheduler.reevalDone();
      const ov = document.createElement('div');
      ov.id = 'reeval';
      ov.textContent = TH.reevalMessages[bags.reeval.next()];
      document.body.appendChild(ov);
      await sleep(rng.range(800, 1200));
      ov.remove();
    }
    if (!wasRecall) theme.qIndex++;   // リコールは割り込みなので進行に数えない
    Store.save();

    if (theme.qIndex >= QuestionEngine.list(theme).length) {
      if (Scheduler.finaleDue()) await Screens.finale(theme);
      else await Screens.interstitial(theme);
    } else {
      Screens.question();
    }
  },

  /* ---------- 分析インタースティシャル ---------- */
  async interstitial(theme) {
    const s = Store.state;
    s.themesDone.push({ id: theme.id, name: theme.name });
    const hypo = HypothesisEngine.onThemeComplete();
    const special = Scheduler.specialDue();
    if (special) Scheduler.specialDone();
    Store.save(true);

    // メッセージ構成：特別1本＋通常1〜2本 or 通常2〜3本
    const msgs = [];
    if (special) msgs.push({ text: AnalysisEngine.specialMsg(), special: true });
    const nNormal = special ? rng.range(1, 2) : rng.range(2, 3);
    for (let i = 0; i < nNormal; i++) msgs.push({ text: AnalysisEngine.normalMsg(theme.name) });

    // 表示ブロックはテーマごとに交互（特性バー ⇄ レイヤーメーター）＋ 約30問ごとの分析ノート
    const useLayers = s.themesDone.length % 2 === 1;
    const layers = useLayers ? AnalysisEngine.layers(theme) : null;
    const report = useLayers ? null : AnalysisEngine.report(theme);
    const note = Scheduler.noteDue() ? AnalysisEngine.note() : null;
    if (note) Scheduler.noteDone();
    UI.setGauge(1);   // テーマ内ゲージを満了表示

    $('screen').innerHTML = `
      <div class="screen interstitial${special ? ' special' : ''}">
        <div class="inter-card card glass">
          <div class="ldr-stage">${AnalysisEngine.loaderHTML()}</div>
          <div class="msg-list" aria-live="polite">
            ${msgs.map((m, i) => `<p class="msg" data-m="${i}">${esc(m.text)}</p>`).join('')}
          </div>
          ${report ? `
          <div class="report" hidden>
            ${report.map((r) => `
              <div class="report-row">
                <span>${esc(r.label)}</span>
                <span class="bar">${[0, 1, 2, 3, 4, 5].map((i) =>
                  `<i style="--i:${i}" class="${i < r.value ? 'on' : ''}"></i>`).join('')}</span>
              </div>`).join('')}
          </div>` : ''}
          ${layers ? `
          <div class="layers" hidden>
            <div class="layers-title">${esc(TH.layersTitles[bags.layersTitle.next()])}</div>
            ${layers.map((l) => `
              <div class="layer-row">
                <span>${esc(l.label)}</span>
                <span class="meter"><i data-w="${l.value}"></i></span>
                <span class="layer-val num">${l.value}%</span>
              </div>`).join('')}
          </div>` : ''}
          ${note ? `
          <div class="note" hidden>
            <div class="note-head">Analysis Note</div>
            <p>${esc(note)}</p>
          </div>` : ''}
          ${hypo ? `
          <div class="hypo" hidden>
            <div class="hypo-head"><span>仮説${esc(hypo.key)}</span><span>${esc(hypo.note)}</span></div>
            <div class="hypo-label">${esc(hypo.label)}</div>
            <div class="hypo-conf">信頼度 <b class="num">${hypo.conf}</b>%
              ${hypo.delta ? `<span class="hypo-delta">▲+${hypo.delta}</span>` : ''}</div>
            <div class="hypo-note">${esc(TH.hypotheses.notes.verifying)}</div>
          </div>` : ''}
          <p class="msg" data-m="intro" hidden></p>
        </div>
        <div class="ad-slot" data-slot="analysis"></div>
      </div>`;

    // 演出シーケンス（所要 約1.2〜3秒＋要素分。毎回長さを揺らす）
    await sleep(rng.range(200, 420));
    for (let i = 0; i < msgs.length; i++) {
      const el = document.querySelector(`[data-m="${i}"]`);
      el.classList.add('show');
      await sleep(rng.range(600, 900));
      el.classList.add('done');
    }
    const rep = document.querySelector('.report');
    if (rep) {
      rep.hidden = false;
      rep.querySelectorAll('.bar').forEach((b) => b.classList.add('animate'));
      await sleep(rng.range(900, 1200));
    }
    const lay = document.querySelector('.layers');
    if (lay) {
      lay.hidden = false;
      await sleep(60);   // hidden解除後にwidth遷移を発火させる
      lay.querySelectorAll('.meter i').forEach((i) => { i.style.width = i.dataset.w + '%'; });
      await sleep(rng.range(1150, 1400));
    }
    const noteEl = document.querySelector('.note');
    if (noteEl) {
      noteEl.hidden = false;
      await sleep(rng.range(1400, 1800));  // 読み物なので少し長め
    }
    const hy = document.querySelector('.hypo');
    if (hy) { hy.hidden = false; await sleep(rng.range(900, 1200)); }
    // 次テーマはここで確定（HUDの「分析中」表示がシーケンス途中で切り替わらないように）
    const next = ThemeEngine.begin();
    const intro = document.querySelector('[data-m="intro"]');
    if (next.intro) {
      intro.hidden = false;
      intro.textContent = next.intro;
      intro.classList.add('show');
      await sleep(rng.range(900, 1300));
    }

    UI.aurora(next.hue);
    UI.hudUpdate();
    await sleep(300);
    Screens.question();
  },

  /* ---------- フィナーレ（最終解析 → 暗転 → 記録） ---------- */

  /** 記録スナップショット（リセット前に採取） */
  snapshot() {
    Clock.pause();
    const s = Store.state;
    const elapsedMs = Clock.elapsed();
    return {
      answered: s.answered,
      themes: s.themesDone.length,
      elapsedMs,
      minutes: Math.max(1, fmtMin(elapsedMs)),
    };
  },

  /**
   * 最終解析シーケンス。最後までAIは真面目に振る舞う：
   *   通常の解析メッセージ → 「解析結果」…「何もわかりませんでした。」（間）
   *   → 「あなたの今の顔です。」 → 400msで暗転（#030303）を約3秒維持
   *   → フェードインで「人生で一番無駄な◯分を過ごしました。」
   * カメラは使わない。権限も要求しない。画面を暗くするだけ。
   */
  async finale(theme) {
    const s = Store.state;
    s.themesDone.push({ id: theme.id, name: theme.name });
    Store.save(true);
    UI.setGauge(1);

    const routine = [
      AnalysisEngine.normalMsg(theme.name),
      AnalysisEngine.normalMsg(theme.name),
    ];
    const lines = ['解析結果', '…', 'あなたについて…', '…', '何もわかりませんでした。'];

    $('screen').innerHTML = `
      <div class="screen interstitial finale">
        <div class="inter-card card glass">
          <div class="ldr-stage">${AnalysisEngine.loaderHTML()}</div>
          <div class="msg-list" aria-live="polite">
            ${routine.map((t, i) => `<p class="msg" data-m="r${i}">${esc(t)}</p>`).join('')}
            ${lines.map((t, i) => `<p class="msg f-line" data-m="f${i}">${esc(t)}</p>`).join('')}
            <p class="msg f-line" data-m="face">あなたの今の顔です。</p>
          </div>
        </div>
      </div>`;

    // 通常の解析に見せる導入
    await sleep(rng.range(300, 500));
    for (let i = 0; i < routine.length; i++) {
      const el = document.querySelector(`[data-m="r${i}"]`);
      el.classList.add('show');
      await sleep(rng.range(650, 900));
      el.classList.add('done');
    }
    await sleep(600);

    // 本編：笑いはセリフではなく「間」で作る
    const waits = [1000, 1100, 1100, 1200, 0];
    for (let i = 0; i < lines.length; i++) {
      document.querySelector(`[data-m="f${i}"]`).classList.add('show');
      await sleep(waits[i]);
    }
    await sleep(2400);                        // 「何もわかりませんでした。」の間
    document.querySelector('[data-m="face"]').classList.add('show');
    await sleep(1600);

    // 暗転：黒い画面＝鏡。約3秒、本人の顔が映る
    const bo = document.createElement('div');
    bo.id = 'blackout';
    document.body.appendChild(bo);
    void bo.offsetWidth;
    bo.classList.add('on');                   // 400msで暗転
    await sleep(450);
    UI.stopTicker();
    UI.hud(false);
    const snap = Screens.snapshot();
    Store.reset();                            // セッションはここで役目を終える
    UI.inSession = false;
    Screens.finalPanel(snap, false);          // 暗転の下で最終画面に差し替え
    await sleep(3000);                        // 暗転を約3秒維持
    bo.classList.remove('on');                // ゆっくり明ける
    await sleep(750);
    bo.remove();
  },

  /** 早期終了（終了ボタン経由）：演出は行わず記録だけを見せる */
  abort() {
    const snap = Screens.snapshot();
    Store.reset();
    UI.inSession = false;
    UI.stopTicker();
    UI.hud(false);
    Screens.finalPanel(snap, true);
  },

  /** 最終画面：淡々と。煽らない・謝らない・説明しない */
  finalPanel(snap, aborted) {
    UI.aurora(226);
    $('screen').innerHTML = `
      <div class="screen finale-panel">
        <div class="fade-seq">
          <p class="punch" style="--d:0ms">${aborted
            ? '診断を中断しました。'
            : `人生で一番無駄な${snap.minutes}分を過ごしました。`}</p>
          <div class="fstat-list" style="--d:650ms">
            <div class="fstat"><span>回答数</span><b class="num">${snap.answered}問</b></div>
            <div class="fstat"><span>プレイ時間</span><b class="num">${fmtMinSec(snap.elapsedMs)}</b></div>
            <div class="fstat"><span>分析テーマ</span><b class="num">${snap.themes}</b></div>
          </div>
          <div class="final-actions" style="--d:1150ms">
            <button id="btn-share" class="btn btn-primary" type="button">SNSでシェア</button>
            <button id="btn-real" class="btn btn-secondary" type="button">本当に診断したい方はこちら</button>
          </div>
          <div class="ad-slot" data-slot="share"></div>
        </div>
      </div>`;
    $('btn-share').addEventListener('click', () => Share.record(snap, aborted));
    $('btn-real').addEventListener('click', () => {
      if (CFG.realTestUrl) { window.open(CFG.realTestUrl, '_blank', 'noopener'); return; }
      Store.reset();                          // 「本当の診断」＝この診断（真顔）
      Screens.bootSession(true);
    });
  },
};

/* =====================================================================
 * 14. share — SNSシェア（Web Share API / クリップボードfallback）
 * =================================================================== */
const Share = {
  text(snap, aborted) {
    if (aborted) return `AI超精密性格診断、${snap.answered}問で離脱しました。`;
    return `AI超精密性格診断を${snap.minutes}分やった結果\n` +
           `「何もわかりませんでした。」\n` +
           `人生で一番無駄な${snap.minutes}分でした。`;
  },
  url() { return location.href.split('#')[0]; },
  async record(snap, aborted) {
    const text = Share.text(snap, aborted);
    try {
      if (navigator.share) { await navigator.share({ text, url: Share.url() }); return; }
    } catch { return; /* ユーザーによるキャンセル */ }
    try {
      await navigator.clipboard.writeText(`${text}\n${Share.url()}`);
      UI.toast('コピーしました');
    } catch { UI.toast('コピーできませんでした'); }
  },
};

/* =====================================================================
 * 16. 初期化 — データ読込 / バッグ構築 / SW登録 / 復元
 * =================================================================== */
async function init() {
  // 保存済み状態があれば読み込み（rngのシードに使用）
  Store.state = Store.load() ?? Store.fresh();
  rng = new Rng(Store.state.seed);

  // データ読込（SWがprecacheするためオフラインでも動作）
  try {
    const [th, qs] = await Promise.all([
      fetch('./themes.json').then((r) => r.json()),
      fetch('./questions.json').then((r) => r.json()),
    ]);
    TH = th; QS = qs;
  } catch {
    $('screen').innerHTML = `
      <div class="screen"><section class="card glass" style="margin:auto;text-align:center;">
        <h1>読み込みに失敗しました</h1>
        <p>通信環境を確認して、再読み込みしてください。</p>
      </section></div>`;
    return;
  }

  // バッグ構築（サイズはデータ長に追従。プール追加時も自動対応）
  bags.msg      = new Bag('msg', TH.analysisMessages.normal.length);
  bags.special  = new Bag('special', TH.analysisMessages.special.length);
  bags.loader   = new Bag('loader', 6);
  bags.intro    = new Bag('intro', TH.generator.introTemplates.length);
  bags.name     = new Bag('name', TH.generator.nameTemplates.length);
  bags.axis     = new Bag('axis', TH.generator.axes.length);
  bags.modifier = new Bag('modifier', TH.generator.modifiers.length);
  bags.trait    = new Bag('trait', TH.generator.traitBank.length);
  bags.logSub      = new Bag('logSub', TH.logSystem.subsystems.length);
  bags.logStat     = new Bag('logStat', TH.logSystem.statuses.length);
  bags.status      = new Bag('status', TH.statusBank.length);
  bags.phase       = new Bag('phase', TH.phaseBank.length);
  bags.layer       = new Bag('layer', TH.layerBank.length);
  bags.layersTitle = new Bag('layersTitle', TH.layersTitles.length);
  bags.noteC       = new Bag('noteC', TH.analysisNotes.contrast.length);
  bags.noteA       = new Bag('noteA', TH.analysisNotes.aligned.length);
  bags.reeval   = new Bag('reeval', TH.reevalMessages.length);
  bags.recall   = new Bag('recall', QS.recallTemplates.items.length);
  bags.prefixHi = new Bag('prefixHi', QS.variantPrefixes.hi.length);
  bags.prefixLo = new Bag('prefixLo', QS.variantPrefixes.lo.length);
  bags.tplL     = new Bag('tplL', QS.templates.likert.length);
  bags.tplC     = new Bag('tplC', QS.templates.choice.length);
  bags.tplB     = new Bag('tplB', QS.templates.binary.length);

  QuitDialog.wire();
  Screens.home();

  // PWA: Service Worker 登録（GitHub Pages のサブパスでも相対で動作）
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./service-worker.js').catch(() => {});
    });
  }
}

document.addEventListener('DOMContentLoaded', init);
