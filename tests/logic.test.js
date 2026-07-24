'use strict';

// index.html 本体のロジックをそのまま実行して回帰テストする。
// (ロジックをここに複製すると index.html との乖離が起きるため、
//  index.html 内の <script> から純粋ロジック部分だけを抽出して実行する)
//
// 実行方法: node tests/logic.test.js

var fs = require('fs');
var path = require('path');

var htmlPath = path.join(__dirname, '..', 'index.html');
var html = fs.readFileSync(htmlPath, 'utf8');

var scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) {
  throw new Error('index.html 内に <script> ブロックが見つかりません');
}
var scriptBody = scriptMatch[1];

var START_MARKER = "'use strict';";
var END_MARKER = '// ---- DOM wiring ----';
var startIdx = scriptBody.indexOf(START_MARKER);
var endIdx = scriptBody.indexOf(END_MARKER);
if (startIdx === -1 || endIdx === -1) {
  throw new Error(
    'index.html 内のマーカー(\'use strict\'; / // ---- DOM wiring ----)が見つかりません。' +
    'index.html の構造が変わった場合は、このテストの抽出ロジックも見直してください。'
  );
}
var pureLogicSource = scriptBody.slice(startIdx + START_MARKER.length, endIdx);

var lib = new Function(
  pureLogicSource +
  '\nreturn { segmentManuscript: segmentManuscript, buildCues: buildCues, ' +
  'formatSrtTime: formatSrtTime, formatTotalDuration: formatTotalDuration, ' +
  'buildSrt: buildSrt };'
)();

var segmentManuscript = lib.segmentManuscript;
var buildCues = lib.buildCues;
var formatSrtTime = lib.formatSrtTime;
var formatTotalDuration = lib.formatTotalDuration;
var buildSrt = lib.buildSrt;

var passCount = 0;
var failCount = 0;

function assert(cond, msg) {
  if (cond) {
    passCount++;
    console.log('PASS: ' + msg);
  } else {
    failCount++;
    console.error('FAIL: ' + msg);
  }
}

// --- 仕様書 第8節 受け入れテスト ---

// 1,2,3: 区切り文字での分割 / 削除系が消える / 残す系が残る
(function () {
  var subs = segmentManuscript('مرحبا، كيف حالك؟ أنا بخير!');
  assert(subs.length === 3, '#1 区切り文字で3セグメントに分割される');
  assert(subs[0][0] === 'مرحبا', '#2 アラビア語コンマが削除される -> "' + subs[0][0] + '"');
  assert(subs[1][0] === 'كيف حالك؟', '#3 ؟ が残る -> "' + subs[1][0] + '"');
  assert(subs[2][0] === 'أنا بخير!', '#3 ! が残る -> "' + subs[2][0] + '"');
})();

// . , — も区切り文字として機能することの確認（— は「削除」系の分割点）
(function () {
  var subs = segmentManuscript('جملة واحدة. جملة اخرى, وثالثة — رابعة');
  assert(subs.length === 4, '. , — がそれぞれ分割点になる (4セグメント)');
  assert(subs[0][0] === 'جملة واحدة', 'ピリオドが削除される');
  assert(subs[1][0] === 'جملة اخرى', 'ラテンコンマが削除される');
  assert(subs[2][0] === 'وثالثة', 'emダッシュが削除される');
  assert(subs[3][0] === 'رابعة', 'emダッシュ以降は新しいセグメントになる');
})();

// 4: 区切り文字の連続は1つの区切りとして扱われ、空字幕を生成しない
(function () {
  var subs = segmentManuscript('ماذا حدث؟! لا اعرف... انتظر');
  assert(subs.length === 3, '#4 連続区切り文字でも空字幕が生成されない (3セグメント)');
  assert(subs[0][0] === 'ماذا حدث؟!', '#4 連続する残す系文字が両方付加される -> "' + subs[0][0] + '"');
  assert(subs[1][0] === 'لا اعرف', '#4 連続する削除系文字(...)は完全に消える');
})();

// 5: 区切りなし改行 -> 2行字幕
(function () {
  var subs = segmentManuscript('السطر الأول\nالسطر الثاني. جملة جديدة');
  assert(subs.length === 2, '#5 2つの字幕に分割される');
  assert(subs[0].length === 2, '#5 1つ目の字幕が2行になる');
  assert(
    subs[0][0] === 'السطر الأول' && subs[0][1] === 'السطر الثاني',
    '#5 各行の内容が正しい -> ' + JSON.stringify(subs[0])
  );
})();

// 6,9: ギャップ0での連続 / 多数字幕での累積丸め誤差なし
(function () {
  var text = '';
  for (var i = 0; i < 60; i++) text += 'كلماتنا.'; // 7文字+削除される句点 x60
  var subs = segmentManuscript(text);
  var cues = buildCues(subs, 12);

  var gapOk = true;
  for (var j = 1; j < cues.length; j++) {
    if (cues[j].startMs !== cues[j - 1].endMs) { gapOk = false; break; }
  }
  assert(gapOk, '#6 ' + cues.length + '枚全てでギャップ0 (前の終了=次の開始)');

  var charCount = Array.from('كلماتنا').length;
  var exactTotalMs = Math.round((charCount / 12) * cues.length * 1000);
  var lastMs = cues[cues.length - 1].endMs;
  assert(
    Math.abs(lastMs - exactTotalMs) <= 1,
    '#9 60枚の累積後も理論値との誤差が1ms以内 (実測=' + lastMs + ', 理論=' + exactTotalMs + ')'
  );
})();

// 7: cps=12, 24文字はちょうど2.000秒
(function () {
  var subs = segmentManuscript('أ'.repeat(24) + '.');
  var cues = buildCues(subs, 12);
  assert(cues[0].charCount === 24, '#7 文字数が24とカウントされる');
  assert(cues[0].endMs - cues[0].startMs === 2000, '#7 duration がちょうど2000ms');
  assert(formatSrtTime(cues[0].endMs) === '00:00:02,000', '#7 タイムコード表記が00:00:02,000');
})();

// 8: タシュキール付きテキストが無改変(区切り削除とトリム以外)で出力される
(function () {
  var text = '  بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ. ';
  var expected = 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ';
  var subs = segmentManuscript(text);
  assert(subs.length === 1, '#8 1つの字幕になる');
  assert(subs[0][0] === expected, '#8 タシュキールが完全に保持される');
  assert(
    Array.from(subs[0][0]).length === Array.from(expected).length,
    '#8 コードポイント数が一致(正規化されていない)'
  );
})();

// 10: 空入力 / 空白のみの入力 -> 字幕0枚
(function () {
  assert(segmentManuscript('').length === 0, '#10 空文字列 -> 0字幕');
  assert(segmentManuscript('   \n\n  ').length === 0, '#10 空白のみ -> 0字幕');
})();

// 数字表記が統一されない(アラビア数字・インド数字とも無改変)ことの確認
(function () {
  var subs = segmentManuscript('رقم واحد هو ١٢٣. رقم اثنين هو 456.');
  assert(subs[0][0].indexOf('١٢٣') !== -1, 'インド数字がそのまま保持される');
  assert(subs[1][0].indexOf('456') !== -1, '西暦数字がそのまま保持される(統一されない)');
})();

// SRT出力フォーマット(第7節)の確認: 連番/タイムコード/空行区切り/2行字幕
(function () {
  var text = 'مرحبا، كيف حالك؟\nسطر ثاني بدون فاصلة\nنص اخير!';
  var subs = segmentManuscript(text);
  var cues = buildCues(subs, 12);
  var srt = buildSrt(cues, false);

  assert(srt.indexOf('﻿') === -1, 'BOM未指定時は先頭にBOMが付かない');
  assert(/^1\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}\n/.test(srt), '1番目のブロックが仕様の形式に一致する');
  assert(srt.indexOf('سطر ثاني بدون فاصلة\nنص اخير!') !== -1, '2行字幕がSRT内でも改行付きで出力される');
  assert(srt.split('\n\n').length - 1 === cues.length, '各字幕ブロックの後に空行が1つある');

  var srtWithBom = buildSrt(cues, true);
  assert(srtWithBom.charCodeAt(0) === 0xfeff, 'BOM指定時は先頭にU+FEFFが付く');
})();

console.log('');
console.log(passCount + ' passed, ' + failCount + ' failed');
if (failCount > 0) process.exit(1);
