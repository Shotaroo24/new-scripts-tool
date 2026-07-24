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
  'buildSrt: buildSrt, subsFromLineGroups: subsFromLineGroups, ' +
  'computeStarts: computeStarts, totalDuration: totalDuration, clipAt: clipAt, ' +
  'setClipDuration: setClipDuration, trimClipAtHead: trimClipAtHead, ' +
  'mergeClipAt: mergeClipAt, deleteClipAt: deleteClipAt, ' +
  'recalcUneditedDurations: recalcUneditedDurations, subsToCues: subsToCues, ' +
  'pushHistory: pushHistory, popHistory: popHistory, charCountForText: charCountForText, ' +
  'formatClock: formatClock };'
)();

var segmentManuscript = lib.segmentManuscript;
var buildCues = lib.buildCues;
var formatSrtTime = lib.formatSrtTime;
var formatTotalDuration = lib.formatTotalDuration;
var buildSrt = lib.buildSrt;
var subsFromLineGroups = lib.subsFromLineGroups;
var computeStarts = lib.computeStarts;
var totalDuration = lib.totalDuration;
var clipAt = lib.clipAt;
var setClipDuration = lib.setClipDuration;
var trimClipAtHead = lib.trimClipAtHead;
var mergeClipAt = lib.mergeClipAt;
var deleteClipAt = lib.deleteClipAt;
var recalcUneditedDurations = lib.recalcUneditedDurations;
var subsToCues = lib.subsToCues;
var pushHistory = lib.pushHistory;
var popHistory = lib.popHistory;
var charCountForText = lib.charCountForText;
var formatClock = lib.formatClock;

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

// --- srtgen-timeline-spec.md 第7節 受け入れテスト ---

function makeSubs(durs) {
  return durs.map(function (d, i) {
    return { text: 'text' + i, dur: d, edited: false };
  });
}

// 1: リップル。2番目を3.0に変更 -> 開始時刻が [0, 1.0, 4.0]
(function () {
  var subs = makeSubs([1.0, 2.0, 1.5]);
  subs = setClipDuration(subs, 1, 3.0);
  var starts = computeStarts(subs);
  assert(
    starts[0] === 0 && starts[1] === 1.0 && starts[2] === 4.0,
    '#T1 リップルで開始時刻が [0, 1.0, 4.0] になる -> ' + JSON.stringify(starts)
  );
})();

// 2: トリム。開始1.0秒・尺2.0秒のクリップにヘッド2.4秒でS -> 尺1.4秒
(function () {
  var subs = makeSubs([1.0, 2.0, 1.5]); // index1の開始は1.0秒
  var result = trimClipAtHead(subs, 1, 2.4);
  assert(result.ok, '#T2 トリムが成功する');
  assert(result.subs[1].dur === 1.4, '#T2 尺が1.4秒になる -> ' + result.subs[1].dur);
})();

// 3: トリム下限。結果が0.3未満になるSは拒否され状態不変
(function () {
  var subs = makeSubs([1.0, 2.0, 1.5]);
  var result = trimClipAtHead(subs, 1, 1.1); // 1.1-1.0=0.1秒 < 0.3
  assert(result.ok === false, '#T3 0.3秒未満のトリムは拒否される');
  assert(result.subs === subs, '#T3 拒否時は元の配列そのままが返る(状態不変)');
})();

// 4: 結合。テキストがスペース連結、尺が合算、配列長が1減る
(function () {
  var subs = makeSubs([1.0, 2.0, 1.5]);
  subs[0].text = 'مرحبا';
  subs[1].text = 'بك';
  var result = mergeClipAt(subs, 0);
  assert(result.ok, '#T4 結合が成功する');
  assert(result.subs.length === 2, '#T4 配列長が1減る');
  assert(result.subs[0].text === 'مرحبا بك', '#T4 テキストがスペース連結される -> "' + result.subs[0].text + '"');
  assert(result.subs[0].dur === 3.0, '#T4 尺が合算される -> ' + result.subs[0].dur);
  assert(result.subs[0].edited === true, '#T4 結合後のクリップはedited:trueになる');
})();

// 4b: 結合。最終クリップでは拒否される
(function () {
  var subs = makeSubs([1.0, 2.0, 1.5]);
  var result = mergeClipAt(subs, 2);
  assert(result.ok === false, '#T4b 最終クリップの結合は拒否される');
})();

// 5: 削除。配列長が1減り、後続の開始時刻が繰り上がる
(function () {
  var subs = makeSubs([1.0, 2.0, 1.5]);
  var result = deleteClipAt(subs, 0);
  assert(result.ok, '#T5 削除が成功する');
  assert(result.subs.length === 2, '#T5 配列長が1減る');
  var starts = computeStarts(result.subs);
  assert(starts[0] === 0 && starts[1] === 2.0, '#T5 後続の開始時刻が繰り上がる -> ' + JSON.stringify(starts));
})();

// 6: SRT出力の累積丸め。誤差が出やすいdur列でも完全一致・ギャップ0
(function () {
  var subs = makeSubs([0.1, 0.2, 0.3]);
  var cues = subsToCues(subs);
  assert(cues[0].startMs === 0 && cues[0].endMs === 100, '#T6 1枚目 0->100ms -> ' + JSON.stringify(cues[0]));
  assert(cues[1].startMs === 100 && cues[1].endMs === 300, '#T6 2枚目 100->300ms -> ' + JSON.stringify(cues[1]));
  assert(cues[2].startMs === 300 && cues[2].endMs === 600, '#T6 3枚目 300->600ms -> ' + JSON.stringify(cues[2]));

  var gapOk = true;
  for (var i = 1; i < cues.length; i++) {
    if (cues[i].startMs !== cues[i - 1].endMs) { gapOk = false; break; }
  }
  assert(gapOk, '#T6 全区間でギャップ0');

  var srt = buildSrt(cues, false);
  assert(srt.indexOf('00:00:00,100 --> 00:00:00,300') !== -1, '#T6 タイムコードがms単位で正確 -> ' + srt);
})();

// 7: Undo。任意の操作後にUndoで直前の状態へ完全復元
(function () {
  var subs = makeSubs([1.0, 2.0, 1.5]);
  var history = [];
  var before = JSON.parse(JSON.stringify(subs));

  history = pushHistory(history, subs);
  subs = setClipDuration(subs, 1, 3.0);
  assert(JSON.stringify(subs) !== JSON.stringify(before), '#T7 操作後は状態が変化している');

  var restored = popHistory(history);
  assert(restored !== null, '#T7 popHistoryが履歴を返す');
  assert(JSON.stringify(restored.subs) === JSON.stringify(before), '#T7 Undoで直前の状態に完全復元する');
  assert(restored.stack.length === 0, '#T7 復元後は履歴が1件消費される');
})();

// 7b: Undo履歴は上限50件(古いものから破棄される)
(function () {
  var history = [];
  for (var i = 0; i < 55; i++) {
    history = pushHistory(history, makeSubs([i + 1]));
  }
  assert(history.length === 50, '#T7b 履歴は50件が上限 -> ' + history.length);
  assert(history[0][0].dur === 6, '#T7b 古い履歴(6件目未満)は破棄されている -> ' + history[0][0].dur);
})();

// --- 追加要件: edited フラグと cps 再計算 ---

// (a) cps変更で edited:false のみ再計算され、edited は不変
(function () {
  var subs = [
    { text: 'أ'.repeat(12), dur: 1.0, edited: false },
    { text: 'ب'.repeat(12), dur: 5.0, edited: true }
  ];
  var next = recalcUneditedDurations(subs, 12);
  assert(next[0].dur === 1.0, '#A1 unedited(cps=12,12文字)は再計算後も1.0秒 -> ' + next[0].dur);
  assert(next[0].edited === false, '#A1 unedited のeditedはfalseのまま');
  assert(next[1].dur === 5.0, '#A1 edited:trueのクリップは尺が変更されない -> ' + next[1].dur);
  assert(next[1].edited === true, '#A1 edited:trueのクリップのeditedは不変');

  var next2 = recalcUneditedDurations(subs, 6);
  assert(next2[0].dur === 2.0, '#A1 cps=6に変更するとunedited(12文字)は2.0秒に再計算される -> ' + next2[0].dur);
  assert(next2[1].dur === 5.0, '#A1 edited:trueは再計算対象外(cps=6でも変化なし)');
})();

// (b) cps変更 -> Undoで復元される
(function () {
  var subs = [
    { text: 'أ'.repeat(12), dur: 1.0, edited: false }
  ];
  var history = [];
  var before = JSON.parse(JSON.stringify(subs));

  history = pushHistory(history, subs);
  subs = recalcUneditedDurations(subs, 6);
  assert(subs[0].dur === 2.0, '#A2 cps変更で再計算される');

  var restored = popHistory(history);
  assert(JSON.stringify(restored.subs) === JSON.stringify(before), '#A2 Undoでcps変更前の状態に復元される');
})();

// setClipDuration / trimClipAtHead は対象クリップの edited を true にする
(function () {
  var subs = makeSubs([1.0, 2.0, 1.5]);
  var afterDrag = setClipDuration(subs, 0, 1.2);
  assert(afterDrag[0].edited === true, '#A3 ドラッグ(setClipDuration)後はedited:trueになる');

  var afterTrim = trimClipAtHead(subs, 1, 2.4);
  assert(afterTrim.subs[1].edited === true, '#A3 S(トリム)後はedited:trueになる');
})();

// deleteClipAt は残存クリップの edited フラグに影響しない
(function () {
  var subs = [
    { text: 'a', dur: 1.0, edited: true },
    { text: 'b', dur: 1.0, edited: false },
    { text: 'c', dur: 1.0, edited: true }
  ];
  var result = deleteClipAt(subs, 0);
  assert(result.subs[0].edited === false, '#A4 削除後も残存クリップのeditedは不変(1) -> ' + result.subs[0].edited);
  assert(result.subs[1].edited === true, '#A4 削除後も残存クリップのeditedは不変(2) -> ' + result.subs[1].edited);
})();

// subsFromLineGroups: 生成時は全クリップ edited:false、dur は0.1丸め・最小0.3クランプ
(function () {
  var subs = subsFromLineGroups([['أ'], ['أأأأأأأأأأأأأأأأأأأأأأأأ']], 12); // 1文字 / 24文字
  assert(subs[0].edited === false && subs[1].edited === false, '#A5 生成時は全クリップedited:false');
  assert(subs[0].dur === MIN_DUR_FOR_TEST(), '#A5 1文字/12cps=0.083..秒は最小0.3秒にクランプされる -> ' + subs[0].dur);
  assert(subs[1].dur === 2.0, '#A5 24文字/12cps=2.0秒はそのまま(0.1刻み) -> ' + subs[1].dur);

  function MIN_DUR_FOR_TEST() { return 0.3; }
})();

console.log('');
console.log(passCount + ' passed, ' + failCount + ' failed');
if (failCount > 0) process.exit(1);
