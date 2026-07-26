// 番号付き英訳のコピー出力・貼り付けパース(docs/srtgen-translation-roundtrip-spec.md §3-6)。
// 入力元(クリップボード/将来のfetchレスポンス等)に依存しない純粋関数のみを置く。

// LEFT-TO-RIGHT MARK。目に見えない制御文字のため、コード上は文字コードで明示する。
export var LRM = String.fromCharCode(0x200e);

// 本文抽出後に混入し得る双方向制御文字(LRM U+200E / RLM U+200F / ALM U+061C)。
// コピー時に挿入したLRMや応答生成物に紛れ込んだ制御文字を、貼り付け側で必ず取り除く。
var BIDI_CONTROL_RE = new RegExp('[' + String.fromCharCode(0x200e, 0x200f, 0x061c) + ']', 'g');

// 行全体がコードフェンスで始まる行はまるごと除去する。
var CODE_FENCE_LINE_RE = /^\s*```/;

// 番号行の判定。区切り文字自体は必須のまま、直後の空白は任意にする("1.text"も許容)。
// 区切り文字を任意にすると本文中の数字始まりの行を誤ってエントリと解釈するため、そこは緩めない。
// 全角数字にも直接マッチさせ、後段で半角へ正規化する。
var NUMBER_LINE_RE = /^\s*([0-9０-９]+)\s*[.．)）:：\-]\s*/;

function toHalfWidthDigits(s) {
  return s.replace(/[０-９]/g, function (ch) {
    return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
  });
}

function stripBidiControls(s) {
  return s.replace(BIDI_CONTROL_RE, '');
}

// クリップ配列を「番号.LRM本文」形式のテキストへ整形する(番号付きでコピー用)。
// 空クリップも欠番にせず番号を維持する。行区切りは\n。
export function formatNumberedClips(subs) {
  return subs.map(function (s, i) {
    return (i + 1) + '.' + LRM + s.text;
  }).join('\n');
}

// 番号付きテキストをパースする。
// text: 貼り付けられた番号付きテキスト(入力元非依存)
// clipCount: 現在のクリップ数(1..Nの範囲判定・欠落判定に使う)
// 戻り値: { entries: Map<number, string>, issues: {
//   missing: number[], duplicate: number[], outOfRange: number[], emptyBody: number[], preamble: boolean
// } }
export function parseNumberedTranslation(text, clipCount) {
  var stripped = (text.charCodeAt(0) === 0xfeff) ? text.slice(1) : text;
  var lines = stripped.replace(/\r/g, '').split('\n').filter(function (l) {
    return !CODE_FENCE_LINE_RE.test(l);
  });

  var entryOrder = [];
  var entryByNumber = {};
  var duplicateSeen = {};
  var preamble = false;
  var current = null; // 現在追記中のエントリ(重複エントリの場合は破棄用ダミーを指す)

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.trim() === '') continue;

    var m = NUMBER_LINE_RE.exec(line);
    if (m) {
      var number = parseInt(toHalfWidthDigits(m[1]), 10);
      var body = line.slice(m[0].length).trim();

      if (Object.prototype.hasOwnProperty.call(entryByNumber, number)) {
        duplicateSeen[number] = true;
        current = { number: number, bodyParts: [body] }; // entryOrderには追加しない(破棄用)
      } else {
        var entry = { number: number, bodyParts: [body] };
        entryByNumber[number] = entry;
        entryOrder.push(entry);
        current = entry;
      }
    } else if (current) {
      current.bodyParts.push(line.trim());
    } else {
      preamble = true;
    }
  }

  var entries = new Map();
  var emptyBody = [];
  entryOrder.forEach(function (entry) {
    var joined = stripBidiControls(entry.bodyParts.join(' ')).trim();
    entries.set(entry.number, joined);
    if (joined === '') emptyBody.push(entry.number);
  });

  var missing = [];
  for (var n = 1; n <= clipCount; n++) {
    if (!entries.has(n)) missing.push(n);
  }

  var outOfRange = [];
  entries.forEach(function (_, num) {
    if (num <= 0 || num > clipCount) outOfRange.push(num);
  });
  outOfRange.sort(function (a, b) { return a - b; });

  var duplicate = Object.keys(duplicateSeen).map(function (k) { return parseInt(k, 10); })
    .sort(function (a, b) { return a - b; });

  return {
    entries: entries,
    issues: {
      missing: missing,
      duplicate: duplicate,
      outOfRange: outOfRange,
      emptyBody: emptyBody,
      preamble: preamble
    }
  };
}
