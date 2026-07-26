# srtgen — 英訳ラウンドトリップ機能 実装指示

## 0. 背景と目的

現状、英訳は左ペイン下部の単一 textarea に貼り付け、改行区切りでクリップへ割り当てている。この方式には次の問題がある。

- 外部で作った英訳（散文）を後から N 行に割り直す作業が発生し、行数が一致しない
- 折り返しや空行が混入すると即座に崩れる
- 不一致時のエラーが「13行超過」としか出ず、どこを直すべきか分からない
- S（トリム）/ M（結合）でクリップ構成が変わると、以降の対応が全てズレる

これを、**番号付きのラウンドトリップ**方式に変更する。アラビア語は既にクリップへ分割済みなので、その分割済みの行を入力として訳を作れば、1対1対応はアルゴリズムなしで構造的に成立する。

## 1. スコープ

### やること

- クリップのアラビア語を番号付きテキストとしてクリップボードへ出力する
- 番号付きの英訳テキストを貼り付け、番号で照合してクリップへ割り当てる
- 訳文をクリップ自身のプロパティとして保持する
- S / M / Undo に対する訳文の追従
- 照合結果を番号を名指しして表示する

### やらないこと（今回のスコープ外）

- 翻訳APIの呼び出し（LLM連携）。将来 `/api/translate` に差し替える前提で設計するが、実装は今回行わない
- SRT出力への英訳の混入。**SRT出力は従来どおりアラビア語のみ**とする
- 英語字幕トラックの生成

> 設計上の要求：**「番号付きテキスト文字列 → 訳文配列」の変換関数を、入力元から完全に独立させること。** 今回はクリップボードから来るが、将来 fetch のレスポンスから来る。この関数がUIやクリップボードAPIに依存していてはいけない。

## 2. データモデル変更

各クリップに以下を持たせる。**訳文を行番号や配列インデックスで別管理してはいけない。**

| プロパティ | 型 | 説明 |
|---|---|---|
| `translation` | `string` | 英訳。未設定は空文字列 |
| `translationStale` | `boolean` | 訳文の再確認が必要な状態（要再訳） |

番号は永続的な識別子ではなく、**貼り戻し時の照合キーとしてのみ**使用する。表示上の `#1, #2, …` は常にクリップ配列の現在の並び順から算出する。

### localStorage スキーマ

現行 v4 → **v5** に上げる。マイグレーション処理：

1. v4 の英訳 textarea の内容を改行で分割する
2. 分割後の件数がクリップ件数と一致する場合のみ、順に `translation` へ割り当てる
3. 一致しない場合は割り当てを行わず、`translationStale = true` を全クリップに立てたうえで、旧テキストを破棄せず `legacyTranslationText` として1回だけ保持し、UI上に「旧形式の英訳が移行できませんでした」と表示する

## 3. コピー出力（番号付きでコピー）

エディタヘッダ（`editor-group`）に「番号付きでコピー」ボタンを追加する。

出力形式：

```
1.\u200Eكنت متواعد مع صديق سعودي
2.\u200Eوجا متأخر تقريباً ربع ساعة
3.\u200Eما ضايقني كثير
```

- 番号は半角数字、区切りは `. `（半角ピリオド＋半角スペース）
- 番号とアラビア語本文の間に **U+200E (LEFT-TO-RIGHT MARK)** を挿入する。これがないと RTL の双方向アルゴリズムにより番号が行の右端へ回り込み、貼り付け先での見た目が崩れる
- 行区切りは `\n`
- 空クリップ（本文が空）も番号を維持したまま出力する（欠番を作らない）
- コピー完了時はトーストで「28行をコピーしました」と表示する

画面上にプレビュー領域を出すかどうかは任意。出す場合は等幅・折り返しなし・最大高さ 200px 程度に留める。

## 4. 貼り付けダイアログ（英訳を貼り付け）

「英訳を貼り付け」ボタンでモーダルを開く。

構成：

- 貼り付け用 textarea（この内容は永続化しない。ダイアログを閉じたら破棄する）
- 適用モードの選択（ラジオ）
  - **空欄のみ埋める**（既定）
  - **すべて上書き**
- 「照合」ボタン → パース・検証を実行し、結果を表示
- 検証結果が致命的でなければ「適用」ボタンを有効化

## 5. パーサ仕様

**この関数は純粋関数として `tests/logic.test.js` からテスト可能な形で実装すること。**

入力：番号付きテキスト（文字列）
出力：`{ entries: Map<number, string>, issues: {...} }`

処理手順：

1. 入力全体から、行全体が ``` で始まる行（コードフェンス）を除去する
2. 先頭の BOM を除去する
3. 各行について、行頭の番号パターンにマッチするか判定する
   - 正規表現：`/^\s*(\d+)\s*[.．)）:：\-]\s+?/`
   - 全角数字は事前に半角へ正規化する
4. マッチした行 → 新しいエントリの開始。番号を取得し、残りを本文とする
5. マッチしない**非空行** → **直前のエントリの本文に半角スペースで連結する**（折り返し対策。改行区切り方式との決定的な違いなので必ず実装すること）
6. 空行 → 無視する
7. 最初のエントリが始まる前の非空行 → `preamble` として記録し、issue に含める（LLMが前置きを出した場合の検出）
8. 各本文の前後の空白をトリムする

検証：

- **欠落** — 1..N のうちエントリが存在しない番号
- **重複** — 同じ番号が2回以上出現。**最初の出現を採用し、警告に含める**
- **範囲外** — N を超える番号、または 0 以下の番号
- **空本文** — 番号はあるが本文が空

## 6. 照合結果の表示

モーダル内および適用後のバナーに表示する。**必ず番号を名指しすること。**

```
28件中 26件を照合しました
#12 が欠落 / #19 が重複
```

- 欠落・重複が0件 → 成功表示。既存の `.badge-one-line` と同じ配色規約（背景 `#e6f4ea` 直書き + `var(--success)`）を踏襲する
- 欠落・重複・範囲外あり → 警告表示（背景 `#fff4e5` 直書き + `var(--warning)`）。**範囲外の番号を除いた「正当な番号」が1件でも存在すれば適用可能とする**（範囲外の番号は警告に列挙するのみで、適用対象からは除外する）
- 正当な番号(1..N)のエントリが1件も取れなかった → エラー表示（背景 `#fde8e7` 直書き + `var(--danger)`）。適用ボタンは無効
- `preamble` を検出した場合 → 「訳文以外のテキストが含まれています」と追記

新規のCSS変数（`--bg-warning` 等）は追加しない。このリポジトリでは単色トークン（`--success` / `--warning` / `--danger`）+ 直書きの淡色背景という組み合わせが既存の慣習（`.badge-one-line` 等）であり、それに合わせる。

番号は最大10件まで列挙し、超過分は `他 n 件` とまとめる。

## 7. 編集操作に対する訳文の追従

| 操作 | 訳文の扱い |
|---|---|
| M（結合） | 2つの `translation` を半角スペースで連結（空文字列は除外）。`translationStale = true` |
| S（トリム） | **保留中。下記「Sの実際の挙動について」を参照。確定するまで訳文追従は実装しない** |
| クリップ編集モーダル | アラビア語本文のみ変更 → `translationStale = true`。英訳のみ、または両方変更 → `translationStale = false` |
| Undo | 訳文と `translationStale` を含めて完全に復元する |

`translationStale` が立っているクリップは、UI上「要再訳」バッジ（単色トークン `var(--warning)` + 直書きの淡色背景、新規CSS変数は追加しない）と補足文を表示する。訳文を手動で編集した場合は `translationStale = false` に戻す。

### Sの実際の挙動について(未確定・調査中)

本節執筆時点のコードでは、S は `trimClipAtHead` のみを呼び出しており、該当クリップの `durMs` を変更するだけでテキスト・訳文・クリップ数には一切影響しない（`splice` が呼ばれるのは結合・削除のみ）。`docs/srtgen-timeline-spec.md` の記述もこれと一致している。

一方、実機では「Sを押すとクリップが分割される（クリップ数が増える）」という報告があり、上記のコード上の挙動と食い違っている。原因（キャッシュ、別操作との混同、等）を含めて事実確認中のため、本節の上表は**Sの訳文追従仕様を未確定のまま保留**している。分割が事実だと確定した場合は、前半に既存の `translation` を残し `translationStale = true`、後半は `translation = ""` かつ `translationStale = true` とする案が有力。

## 8. クリップ表示

現行のクリップカードに英訳を表示する。左ペイン下部の英訳 textarea は**削除する**。

- アラビア語本文の下に、英訳を `--text-secondary` / 13px で表示
- 英訳部分はクリックでインライン編集可能にする（手直し前提のため必須）
- 未設定のクリップは「英訳なし」を `--text-muted` で表示
- 既存の文字数表示・操作ボタンの配置は変更しない

## 9. テスト（tests/logic.test.js に追加）

パーサ：

- 正常系（N件が過不足なく揃う）
- 折り返し行が直前のエントリへ連結される
- 空行が無視される
- コードフェンスが除去される
- 全角数字・全角ピリオドが正規化される
- 区切り文字のバリエーション（`1.` `1)` `1:` `1 -`）
- 欠落番号の検出
- 重複番号の検出と、最初の出現の採用
- 範囲外番号の検出
- preamble の検出
- 空入力・空白のみの入力

編集操作：

- 結合で訳文が連結され stale が立つ（空文字列側を除外して連結することも含む）
- S（保留・§7参照）: 実際の挙動が確定してから対応するテストを追加する
- Undo で訳文と stale が復元される

マイグレーション：

- v4 の英訳が件数一致時に正しく割り当てられる
- 件数不一致時に割り当てが行われず、旧テキストが保持される

既存テストは件数一致ではなく振る舞いの維持を基準とする。役目を終えた行番号管理方式のテスト（`splitEnglishLines` / `buildAlignmentWarning` / `rowMismatchMessage` / `shiftEnglishDown` / `compactEnglish` および `subsFromSegments` の `enLines` 引数）は削除・置き換えてよい。それ以外は原則としてフィールド名の参照修正に留め、アサーションの中身は書き換えない。

## 10. 受け入れ条件

- [ ] 「番号付きでコピー」でクリップ件数と同数の行がクリップボードへ入る
- [ ] コピーした内容をChatGPTへ貼り、返ってきた番号付き英訳をそのまま貼り戻して全件が正しく対応する
- [ ] 途中で折り返された英訳を貼っても崩れない
- [ ] 1行削って貼ると「#n が欠落」と番号が名指しされる
- [ ] 訳を入れた後に M で結合すると訳が連結され、要再訳が立つ
- [ ] （保留・§7参照）Sの実際の挙動が確定し次第、それに応じた訳文追従を実装・確認する
- [ ] Undo で訳文が元に戻る
- [ ] リロード後も訳文が復元される
- [ ] SRT出力の内容が従来と一致する（英訳が混入しない）
- [ ] 420px / 640px / 1600px でレイアウトが崩れない
- [ ] `tests/logic.test.js` が全件PASS

## 11. 実装後にやること

- `docs/srtgen-timeline-spec.md` を更新する（データモデル、localStorage v5、パーサ仕様、編集操作時の訳文追従）
- 変更を意味単位でコミットに分ける
- main へ push し、Vercel本番でハードリロード（Ctrl+Shift+R）のうえ実機確認する

---

## 付録：ChatGPT側で使うプロンプト

ツールが出力する番号形式と対応させること。カスタムGPTまたはプロジェクト指示に登録し、毎回は番号付きリストのみを貼る運用とする。

```
You translate Saudi/Gulf colloquial Arabic video scripts into English.

The input is a numbered list of subtitle lines. Each line is one clip in a
video, already split by the editor. Your job is to produce an English line
for each numbered line.

RULES — these override everything else:
1. Output exactly the same number of lines as the input.
2. Format every line as "n. translation" using the same numbers as the input.
3. Never merge, split, reorder, skip, or add lines.
4. A line may end mid-sentence. Translate only what is inside that line.
   You may read surrounding lines for context, but the translation must not
   borrow content from them or complete the sentence.
5. Preserve fragment punctuation. If a line ends with a comma or is
   incomplete, do not close it with a period.
6. The source is spoken Gulf/Hijazi dialect, not MSA. Translate it as natural
   casual speech — how a person actually talks in a vlog. Do not formalize it,
   do not add literary polish.
7. Keep discourse fillers (يعني، والله، طيب) natural in English or drop them
   only if English has no equivalent. Do not expand them into explanations.
8. Transliterate proper nouns consistently across all lines.
9. Output plain text only. No preamble, no notes, no markdown, no code fences.

Input:
```
