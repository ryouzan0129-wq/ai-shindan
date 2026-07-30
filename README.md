# AI超精密性格診断

「最新AIがあなたを多角的に分析します」——実際には**永遠に終わらない**、友達に送って遊ぶジョークPWAです。

全体の進捗率も残り問題数も表示されません。表示されるのは「回答済み ○○問・分析フェーズ・**現在テーマ内**の進捗ゲージ」だけ（プレイ時間は終了時の記録画面にのみ表示）。テーマ内ゲージがミクロな達成感を与える一方、全体の総量はどこにも存在しません。AIは仮説を立て、信頼度を更新し、過去のあなたの回答を引用しながら、次々に新しい分析フェーズを開始します。仮説の信頼度は**絶対に93%を超えません**。つまり、分析は永遠に「もう少しの検証」を必要とします。

種明かしはアプリからは行いません。ユーザー自身が「……これ、終わらないじゃん（笑）」と気付き、プレイ記録カード（回答数・テーマ数・称号）をシェアしたくなる体験を目指しています。

> **フェアプレイ設計**：右上の「診断を終了」はいつでも押せて、確認は最大2ステップ、最終ボタンで必ず終了します。ボタン位置の入れ替え・偽キャンセル等のダークパターンは一切実装していません。

---

## ディレクトリ構成

```
/
├─ index.html            アプリシェル（HUD / 画面コンテナ / 終了ダイアログ / AIログ）
├─ style.css             デザイントークン・全画面・ローダー6種・印刷CSS
├─ themes.json           テーマ定義・無限生成バンク・仮説タイプ・演出メッセージ
├─ questions.json        手書き220問＋生成テンプレ＋リコール（記憶引用）テンプレ
├─ script.js             全ロジック（Store/Rng/Bag/各Engine/画面/シェア）
├─ manifest.json         PWAマニフェスト
├─ service-worker.js     オフライン対応（precache・cache-first）
├─ assets/icons/         icon.svg + icon-192/512.png + maskable
└─ README.md             このファイル
```

依存ライブラリ・ビルド工程は**ゼロ**です。ファイルをそのまま置けば動きます。

---

## セットアップ（ローカル）

Service Worker と `fetch()` の都合で `file://` 直開きでは動きません。ローカルサーバーを1つ立ててください。

```bash
# どれか1つでOK
python3 -m http.server 8000
npx serve .
```

ブラウザで `http://localhost:8000` を開けば完了です（SWは https か localhost でのみ有効）。

## GitHub Pages で公開

1. リポジトリを作成し、このフォルダの中身をルートに push
2. リポジトリの **Settings → Pages → Source** を `main` ブランチ / `/ (root)` に設定
3. 数分後 `https://<ユーザー名>.github.io/<リポジトリ名>/` で公開されます

全パスが相対（`./`）で書かれているため、**サブディレクトリ配信でもそのまま動作**します。設定は不要です。

### 更新の反映

静的アセットを変更したら `service-worker.js` 先頭の `CACHE = 'apd-v1.0.0'` のバージョンを上げてください（例: `apd-v1.0.1`）。旧キャッシュは自動削除され、次回アクセスで新版に切り替わります。

---

## PWA の確認方法

1. **インストール可能か**：Chrome で開き、アドレスバー右の「インストール」アイコン、またはメニュー →「アプリをインストール」。スマホなら共有メニュー →「ホーム画面に追加」。
2. **オフライン動作**：一度読み込んだ後、DevTools → Network → `Offline` にしてリロード。全画面が動けばOK（JSONもprecache済み）。
3. **Lighthouse**：DevTools → Lighthouse → PWA カテゴリで監査。manifest / SW / アイコン / theme-color をチェックできます。
4. **SWの状態**：DevTools → Application → Service Workers で登録・キャッシュ内容（Cache Storage → `apd-v1.0.0`）を確認できます。

## アイコンの再生成

`assets/icons/icon.svg` がマスターです。PNGは生成済みですが、デザイン変更時は次のいずれかで再書き出ししてください。

```bash
# rsvg-convert（librsvg）を使う場合
rsvg-convert -w 512 -h 512 assets/icons/icon.svg > assets/icons/icon-512.png
rsvg-convert -w 192 -h 192 assets/icons/icon.svg > assets/icons/icon-192.png
```

Inkscape（`inkscape icon.svg -w 512 -o icon-512.png`）やオンライン変換でも構いません。**maskable** 版はマークを中央80%に収めたセーフゾーン付きで作ってください（外周はグラデーションのみ）。

---

## データ構造

### themes.json

| キー | 内容 |
|---|---|
| `openingSequence` | 序盤の固定テーマ順（仕事→友人→恋愛→休日→睡眠→価値観） |
| `coreThemes[]` | 手書きテーマ。`{id, name, icon, hue, traits[3]}`。`hue` は背景オーロラの色相、`traits` はミニレポートの特性名 |
| `generator` | 無限生成バンク。`axes`（軸30語）× `modifiers`（修飾8種）× `nameTemplates`（命名7型）で上限なし。`introTemplates` はテーマ生成理由、`traitBank` は生成テーマ用特性 |
| `hypotheses.baseTypes[]` | 仮説タイプ。`pole` は回答極性との対応（`low`=慎重寄り / `high`=即断寄り / `mixed`） |
| `analysisMessages` | 解析演出。`normal` 40本＋`special` 12本。`{theme}` はテーマ名に置換 |
| `reevalMessages` | 再評価オーバーレイの文言 |
| `logSystem` / `statusBank` / `phaseBank` | 画面下AIログの合成パーツ（subsystems×statuses＋数値＋テーマ差し込み≒500通り以上）／ヘッダーの分析ステータス（`AI Precision — High` 等）／分析フェーズ名 |
| `layerBank` / `layersTitles` | Analysis画面のレイヤーメーター（`Decision Layer` 等のEN層名と見出し） |
| `analysisNotes` | 約30問ごとの「分析ノート」。実回答統計の方向（`dir`語）を差し込み、差異が大きければ `contrast`、揃っていれば `aligned` テンプレを自動選択＝表示は常に実データと矛盾しない |
| `titles[]` | 称号。`min`（必要回答数）の降順で定義 |

### questions.json

質問オブジェクト：

```json
{ "id": "w01", "t": "c", "q": "質問文", "o": ["選択肢A","B","C","D"], "p": [-1, 1, 0, -1] }
```

- `t`: `c`=4択 / `l`=5段階リッカート / `b`=直感二択
- `p`: 各選択肢の**極性**。`-1`=慎重・熟考・内向寄り、`1`=即断・行動・外向寄り、`0`=中立。リッカートは値0〜4が自動で極性化されるため不要
- 極性は HypothesisEngine の入力です。「慎重型 62%」等の仮説が**実回答から**導かれる仕組みなので、新しい質問にも必ず妥当な `p` を付けてください
- `templates` は生成テーマ用（`{axis}` が軸語に置換）、`recallTemplates` は記憶引用用（`{min}` `{theme}` `{answer}` に実データが入ります）
- `variantPrefixes` は直前回答が強い極性だったときに付く接頭辞（擬似アダプティブ演出）

### localStorage（key: `apd.v1`）

回答数・テーマ履歴・仮説・シャッフルバッグの残りまで全て保存され、リロードしても続きから再開できます。リセットしたい場合は DevTools のコンソールで `localStorage.removeItem('apd.v1')`。

---

## テーマの追加方法

**コアテーマを増やす（推奨・最も自然）**

1. `themes.json` の `coreThemes` に1件追加：
   ```json
   { "id": "pet", "name": "ペット", "icon": "🐾", "hue": 90, "traits": ["愛着性", "世話焼き度", "距離感"] }
   ```
2. `questions.json` の `core` に同じ `id` で8〜12問を追加（下記「質問の追加方法」参照）

これだけで供給ローテーションに自動で入ります（コード変更不要）。

**生成バリエーションを増やす**：`generator.axes` に軸語を、`modifiers` / `nameTemplates` / `introTemplates` に型を足すだけで組み合わせが増殖します。命名テンプレでは `{n}` `{axis}` `{themeA}` `{themeB}` `{modifier}` が使えます。

## 質問の追加方法

1. 対象テーマの配列に質問オブジェクトを追加（`id` はテーマ内で一意に）
2. `t` と、choice/binary の場合は `o` と `p`（同じ長さ）を必ず設定
3. **禁止事項**：「あと少し」「99%」「もうすぐ完了」等の完了予告系の語彙は、質問文・選択肢・演出メッセージのどこにも入れないでください。終わりを予告した瞬間、このアプリの体験は壊れます

生成テーマ用は `templates.likert / choice / binary` に追加します。likert は `{axis}` 入りの文字列1本、choice / binary は `{q, o, p}` オブジェクトです。

## 広告の追加方法

広告SDKは同梱していません。各画面に空の枠だけがあります：

```html
<div class="ad-slot" data-slot="home | analysis | share"></div>
```

CSSにより**中身が入ったときだけ**枠が出現します（空なら高さ0）。導入例：

```html
<!-- index.html の </body> 直前に貼る例（AdSense等のスニペットに置換） -->
<script>
  // 画面描画のたびに ad-slot が作り直されるため、MutationObserver で注入する
  new MutationObserver(() => {
    document.querySelectorAll('.ad-slot:empty').forEach((slot) => {
      // slot.dataset.slot で面ごとの出し分けが可能（home / analysis / share）
      slot.innerHTML = '<!-- ここに広告タグ -->';
    });
  }).observe(document.getElementById('screen'), { childList: true, subtree: true });
</script>
```

設計上、**質問画面には広告面がありません**。回答を遮る広告はこのアプリの没入感を壊すため、追加しないことを推奨します。

## 演出のカスタマイズ

- **解析メッセージ / AIログ / 再評価文** … `themes.json` の各プールに追記するだけ。全プールはシャッフルバッグ管理（全消費まで重複ゼロ）なので、増やすほど「毎回違う」が長持ちします
- **称号** … `titles` の `min` としきい値・ラベルを編集。`rank` 4以上は金縁演出になります
- **仮説タイプ** … `hypotheses.baseTypes` に `{id, label, pole}` を追加。複合分岐（`慎重型・共感型`）にも自動で使われます
- **ペーシング** … 発火間隔は `script.js` の `Scheduler.init()` にまとまっています（再評価25〜35問、リコール40〜60問、分析ノート28〜34問、特別演出3〜4テーマ、新仮説4〜5テーマ）

## 設計メモ（この体験の守り方）

- 全体の進捗率・総問題数・残数は**どこにも表示しない**。見せるのは累積回答数と**テーマ内ゲージ**のみ
- テーマ切替は「分析フェーズ」（Primary → Secondary → Pattern Analysis → Cross Analysis → Deep Layer…）として提示し、質問の追加ではなくAIの手順に見せる
- 継続の理由は常に「AIの推論の因果」で語る：仮説→検証→不足情報→次の分析
- 仮説の信頼度上限は93%。到達すると複合型に分岐して振り出しに戻る（`HypothesisEngine.CAP`）
- リコール（記憶引用）・レポートのバー・テーマ生成理由は、すべて**実際の回答データ**から算出しており、嘘の表示はありません
- 終了フローは公正に：2タップで必ず終了・ボタン位置固定・背景タップは「もどる」

## ライセンス / 注意

個人のジョーク用途を想定しています。実在の心理検査ではなく、表示される「仮説」「信頼度」「特性バー」はすべて演出です（回答傾向を反映した参考値であり、診断的な意味はありません）。
