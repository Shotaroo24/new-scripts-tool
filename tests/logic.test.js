'use strict';

// app.js 本体のロジックをそのまま実行して回帰テストする。
// (ロジックをここに複製すると app.js との乖離が起きるため、
//  app.js から純粋ロジック部分だけを抽出して実行する)
//
// 実行方法: node tests/logic.test.js

var fs = require('fs');
var path = require('path');

var appJsPath = path.join(__dirname, '..', 'app.js');
var scriptBody = fs.readFileSync(appJsPath, 'utf8');

var START_MARKER = "'use strict';";
var END_MARKER = '// ---- DOM wiring ----';
var startIdx = scriptBody.indexOf(START_MARKER);
var endIdx = scriptBody.indexOf(END_MARKER);
if (startIdx === -1 || endIdx === -1) {
  throw new Error(
    'app.js 内のマーカー(\'use strict\'; / // ---- DOM wiring ----)が見つかりません。' +
    'app.js の構造が変わった場合は、このテストの抽出ロジックも見直してください。'
  );
}
var pureLogicSource = scriptBody.slice(startIdx + START_MARKER.length, endIdx);

var lib = new Function(
  pureLogicSource +
  '\nreturn { segmentManuscript: segmentManuscript, buildCues: buildCues, ' +
  'formatSrtTime: formatSrtTime, formatTotalDuration: formatTotalDuration, ' +
  'buildSrt: buildSrt, subsFromSegments: subsFromSegments, ' +
  'computeStartsMs: computeStartsMs, totalDurationMs: totalDurationMs, clipAt: clipAt, ' +
  'setClipDuration: setClipDuration, trimClipAtHead: trimClipAtHead, ' +
  'mergeClipAt: mergeClipAt, deleteClipAt: deleteClipAt, ' +
  'recalcUneditedDurations: recalcUneditedDurations, subsToCues: subsToCues, ' +
  'reconstructManuscript: reconstructManuscript, textEquals: textEquals, ' +
  'pushHistory: pushHistory, popHistory: popHistory, charCountForText: charCountForText, ' +
  'formatClock: formatClock, ZOOM_LEVELS: ZOOM_LEVELS, msToPx: msToPx, pxToMs: pxToMs, ' +
  'pickTickIntervalSec: pickTickIntervalSec, clampZoomIndex: clampZoomIndex, ' +
  'isValidSessionData: isValidSessionData, serializeSession: serializeSession, ' +
  'deserializeSession: deserializeSession, MIN_DUR_MS: MIN_DUR_MS };'
)();

var segmentManuscript = lib.segmentManuscript;
var buildCues = lib.buildCues;
var formatSrtTime = lib.formatSrtTime;
var formatTotalDuration = lib.formatTotalDuration;
var buildSrt = lib.buildSrt;
var subsFromSegments = lib.subsFromSegments;
var computeStartsMs = lib.computeStartsMs;
var totalDurationMs = lib.totalDurationMs;
var clipAt = lib.clipAt;
var setClipDuration = lib.setClipDuration;
var trimClipAtHead = lib.trimClipAtHead;
var mergeClipAt = lib.mergeClipAt;
var deleteClipAt = lib.deleteClipAt;
var recalcUneditedDurations = lib.recalcUneditedDurations;
var subsToCues = lib.subsToCues;
var reconstructManuscript = lib.reconstructManuscript;
var textEquals = lib.textEquals;
var pushHistory = lib.pushHistory;
var popHistory = lib.popHistory;
var charCountForText = lib.charCountForText;
var formatClock = lib.formatClock;
var ZOOM_LEVELS = lib.ZOOM_LEVELS;
var msToPx = lib.msToPx;
var pxToMs = lib.pxToMs;
var pickTickIntervalSec = lib.pickTickIntervalSec;
var clampZoomIndex = lib.clampZoomIndex;
var isValidSessionData = lib.isValidSessionData;
var serializeSession = lib.serializeSession;
var deserializeSession = lib.deserializeSession;
var MIN_DUR_MS = lib.MIN_DUR_MS;

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

// --- 仕様書 第8節 受け入れテスト (segmentManuscriptは{lines,delim}[]を返す) ---

// 1,2,3: 区切り文字での分割 / 削除系が消える / 残す系が残る
(function () {
  var subs = segmentManuscript('مرحبا، كيف حالك؟ أنا بخير!');
  assert(subs.length === 3, '#1 区切り文字で3セグメントに分割される');
  assert(subs[0].lines[0] === 'مرحبا', '#2 アラビア語コンマが削除される -> "' + subs[0].lines[0] + '"');
  assert(subs[1].lines[0] === 'كيف حالك؟', '#3 ؟ が残る -> "' + subs[1].lines[0] + '"');
  assert(subs[2].lines[0] === 'أنا بخير!', '#3 ! が残る -> "' + subs[2].lines[0] + '"');
  assert(subs[0].delim === '،', '#delim アラビア語コンマがdelimに記録される -> "' + subs[0].delim + '"');
  assert(subs[1].delim === '', '#delim 残す文字(؟)で終わるクリップのdelimは空文字 -> "' + subs[1].delim + '"');
  assert(subs[2].delim === '', '#delim 末尾セグメントのdelimは空文字');
})();

// . , — も区切り文字として機能することの確認（— は「削除」系の分割点）
(function () {
  var subs = segmentManuscript('جملة واحدة. جملة اخرى, وثالثة — رابعة');
  assert(subs.length === 4, '. , — がそれぞれ分割点になる (4セグメント)');
  assert(subs[0].lines[0] === 'جملة واحدة', 'ピリオドが削除される');
  assert(subs[0].delim === '.', 'ピリオドがdelimに記録される -> "' + subs[0].delim + '"');
  assert(subs[1].lines[0] === 'جملة اخرى', 'ラテンコンマが削除される');
  assert(subs[1].delim === ',', 'ラテンコンマがdelimに記録される -> "' + subs[1].delim + '"');
  assert(subs[2].lines[0] === 'وثالثة', 'emダッシュが削除される');
  assert(subs[2].delim === '—', 'emダッシュがdelimに記録される -> "' + subs[2].delim + '"');
  assert(subs[3].lines[0] === 'رابعة', 'emダッシュ以降は新しいセグメントになる');
})();

// 4: 区切り文字の連続は1つの区切りとして扱われ、空字幕を生成しない
(function () {
  var subs = segmentManuscript('ماذا حدث؟! لا اعرف... انتظر');
  assert(subs.length === 3, '#4 連続区切り文字でも空字幕が生成されない (3セグメント)');
  assert(subs[0].lines[0] === 'ماذا حدث؟!', '#4 連続する残す系文字が両方付加される -> "' + subs[0].lines[0] + '"');
  assert(subs[0].delim === '', '#4 残す系文字を含む連続区切りのdelimは空文字');
  assert(subs[1].lines[0] === 'لا اعرف', '#4 連続する削除系文字(...)は完全に消える');
  assert(subs[1].delim === '...', '#4 連続する削除系文字(...)がdelimにまとめて記録される -> "' + subs[1].delim + '"');
})();

// 5: 区切りなし改行 -> 2行字幕
(function () {
  var subs = segmentManuscript('السطر الأول\nالسطر الثاني. جملة جديدة');
  assert(subs.length === 2, '#5 2つの字幕に分割される');
  assert(subs[0].lines.length === 2, '#5 1つ目の字幕が2行になる');
  assert(
    subs[0].lines[0] === 'السطر الأول' && subs[0].lines[1] === 'السطر الثاني',
    '#5 各行の内容が正しい -> ' + JSON.stringify(subs[0].lines)
  );
  assert(subs[0].delim === '.', '#5 2行字幕のdelimも正しく記録される');
})();

// 6,9: ギャップ0での連続 / 多数字幕での累積丸め誤差なし (入力モード=buildCuesは従来どおり継続丸め方式)
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
  assert(subs[0].lines[0] === expected, '#8 タシュキールが完全に保持される');
  assert(
    Array.from(subs[0].lines[0]).length === Array.from(expected).length,
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
  assert(subs[0].lines[0].indexOf('١٢٣') !== -1, 'インド数字がそのまま保持される');
  assert(subs[1].lines[0].indexOf('456') !== -1, '西暦数字がそのまま保持される(統一されない)');
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

// --- srtgen-timeline-spec.md 第7節 受け入れテスト (ms整数ベース) ---

function makeSubs(dursMs) {
  return dursMs.map(function (d, i) {
    return { text: 'text' + i, durMs: d, edited: false, delim: '' };
  });
}

// 1: リップル。2番目を3000msに変更 -> 開始時刻が [0, 1000, 4000]
(function () {
  var subs = makeSubs([1000, 2000, 1500]);
  subs = setClipDuration(subs, 1, 3000);
  var starts = computeStartsMs(subs);
  assert(
    starts[0] === 0 && starts[1] === 1000 && starts[2] === 4000,
    '#T1 リップルで開始時刻が [0, 1000, 4000] になる -> ' + JSON.stringify(starts)
  );
})();

// 2: トリム。開始1000ms・尺2000msのクリップにヘッド2400msでS -> 尺1400ms
(function () {
  var subs = makeSubs([1000, 2000, 1500]); // index1の開始は1000ms
  var result = trimClipAtHead(subs, 1, 2400);
  assert(result.ok, '#T2 トリムが成功する');
  assert(result.subs[1].durMs === 1400, '#T2 尺が1400msになる -> ' + result.subs[1].durMs);
})();

// 3: トリム下限。結果が300ms未満になるSは拒否され状態不変
(function () {
  var subs = makeSubs([1000, 2000, 1500]);
  var result = trimClipAtHead(subs, 1, 1100); // 1100-1000=100ms < 300ms
  assert(result.ok === false, '#T3 300ms未満のトリムは拒否される');
  assert(result.subs === subs, '#T3 拒否時は元の配列そのままが返る(状態不変)');
})();

// 4: 結合。テキストがスペース連結、尺が合算、配列長が1減る。delimは右側を引き継ぐ
(function () {
  var subs = makeSubs([1000, 2000, 1500]);
  subs[0].text = 'مرحبا';
  subs[0].delim = '.'; // 左のdelimは破棄されるはず
  subs[1].text = 'بك';
  subs[1].delim = '،'; // 右のdelimは引き継がれるはず
  var result = mergeClipAt(subs, 0);
  assert(result.ok, '#T4 結合が成功する');
  assert(result.subs.length === 2, '#T4 配列長が1減る');
  assert(result.subs[0].text === 'مرحبا بك', '#T4 テキストがスペース連結される -> "' + result.subs[0].text + '"');
  assert(result.subs[0].durMs === 3000, '#T4 尺が合算される -> ' + result.subs[0].durMs);
  assert(result.subs[0].edited === true, '#T4 結合後のクリップはedited:trueになる');
  assert(result.subs[0].delim === '،', '#T4 delimは右クリップのものを引き継ぐ -> "' + result.subs[0].delim + '"');
})();

// 4b: 結合。最終クリップでは拒否される
(function () {
  var subs = makeSubs([1000, 2000, 1500]);
  var result = mergeClipAt(subs, 2);
  assert(result.ok === false, '#T4b 最終クリップの結合は拒否される');
})();

// 5: 削除。配列長が1減り、後続の開始時刻が繰り上がる
(function () {
  var subs = makeSubs([1000, 2000, 1500]);
  var result = deleteClipAt(subs, 0);
  assert(result.ok, '#T5 削除が成功する');
  assert(result.subs.length === 2, '#T5 配列長が1減る');
  var starts = computeStartsMs(result.subs);
  assert(starts[0] === 0 && starts[1] === 2000, '#T5 後続の開始時刻が繰り上がる -> ' + JSON.stringify(starts));
})();

// 6: SRT出力の累積が整数msで厳密に一致する
(function () {
  var subs = makeSubs([100, 200, 300]);
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
  var subs = makeSubs([1000, 2000, 1500]);
  var history = [];
  var before = JSON.parse(JSON.stringify(subs));

  history = pushHistory(history, subs);
  subs = setClipDuration(subs, 1, 3000);
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
  assert(history[0][0].durMs === 6, '#T7b 古い履歴(6件目未満)は破棄されている -> ' + history[0][0].durMs);
})();

// --- 追加要件: edited フラグと cps 再計算 ---

// (a) cps変更で edited:false のみ再計算され、edited は不変
(function () {
  var subs = [
    { text: 'أ'.repeat(12), durMs: 1000, edited: false, delim: '' },
    { text: 'ب'.repeat(12), durMs: 5000, edited: true, delim: '' }
  ];
  var next = recalcUneditedDurations(subs, 12);
  assert(next[0].durMs === 1000, '#A1 unedited(cps=12,12文字)は再計算後も1000ms -> ' + next[0].durMs);
  assert(next[0].edited === false, '#A1 unedited のeditedはfalseのまま');
  assert(next[1].durMs === 5000, '#A1 edited:trueのクリップは尺が変更されない -> ' + next[1].durMs);
  assert(next[1].edited === true, '#A1 edited:trueのクリップのeditedは不変');

  var next2 = recalcUneditedDurations(subs, 6);
  assert(next2[0].durMs === 2000, '#A1 cps=6に変更するとunedited(12文字)は2000msに再計算される -> ' + next2[0].durMs);
  assert(next2[1].durMs === 5000, '#A1 edited:trueは再計算対象外(cps=6でも変化なし)');
})();

// (b) cps変更 -> Undoで復元される
(function () {
  var subs = [
    { text: 'أ'.repeat(12), durMs: 1000, edited: false, delim: '' }
  ];
  var history = [];
  var before = JSON.parse(JSON.stringify(subs));

  history = pushHistory(history, subs);
  subs = recalcUneditedDurations(subs, 6);
  assert(subs[0].durMs === 2000, '#A2 cps変更で再計算される');

  var restored = popHistory(history);
  assert(JSON.stringify(restored.subs) === JSON.stringify(before), '#A2 Undoでcps変更前の状態に復元される');
})();

// setClipDuration / trimClipAtHead は対象クリップの edited を true にする
(function () {
  var subs = makeSubs([1000, 2000, 1500]);
  var afterDrag = setClipDuration(subs, 0, 1200);
  assert(afterDrag[0].edited === true, '#A3 ドラッグ(setClipDuration)後はedited:trueになる');

  var afterTrim = trimClipAtHead(subs, 1, 2400);
  assert(afterTrim.subs[1].edited === true, '#A3 S(トリム)後はedited:trueになる');
})();

// deleteClipAt は残存クリップの edited フラグに影響しない
(function () {
  var subs = [
    { text: 'a', durMs: 1000, edited: true, delim: '' },
    { text: 'b', durMs: 1000, edited: false, delim: '' },
    { text: 'c', durMs: 1000, edited: true, delim: '' }
  ];
  var result = deleteClipAt(subs, 0);
  assert(result.subs[0].edited === false, '#A4 削除後も残存クリップのeditedは不変(1) -> ' + result.subs[0].edited);
  assert(result.subs[1].edited === true, '#A4 削除後も残存クリップのeditedは不変(2) -> ' + result.subs[1].edited);
})();

// subsFromSegments: 生成時は全クリップ edited:false、durMsはcpsからMath.round・最小300msクランプ
(function () {
  var subs = subsFromSegments(
    [{ lines: ['أ'], delim: '' }, { lines: ['أأأأأأأأأأأأأأأأأأأأأأأأ'], delim: '.' }],
    12
  ); // 1文字 / 24文字
  assert(subs[0].edited === false && subs[1].edited === false, '#A5 生成時は全クリップedited:false');
  assert(subs[0].durMs === MIN_DUR_MS, '#A5 1文字/12cps=83.3..msは最小300msにクランプされる -> ' + subs[0].durMs);
  assert(subs[1].durMs === 2000, '#A5 24文字/12cps=2000msはそのまま -> ' + subs[1].durMs);
  assert(subs[1].delim === '.', '#A5 segmentsのdelimがsubsにも引き継がれる');
})();

// --- 今回の完了条件 ---

// ①: ms精度で累積が一致すること(大量クリップでも整数演算のみで誤差ゼロ)
(function () {
  var n = 137;
  var dursMs = [];
  for (var i = 0; i < n; i++) dursMs.push(333); // 0.1刻みでは表現できない値
  var subs = makeSubs(dursMs);
  var cues = subsToCues(subs);
  assert(totalDurationMs(subs) === 333 * n, '#C1 合計msが正確 (' + (333 * n) + ')');
  assert(cues[cues.length - 1].endMs === 333 * n, '#C1 最後のキューのendMsが理論値と完全一致(誤差ゼロ) -> ' + cues[cues.length - 1].endMs);
  var gapOk = true;
  for (var j = 1; j < cues.length; j++) {
    if (cues[j].startMs !== cues[j - 1].endMs) { gapOk = false; break; }
  }
  assert(gapOk, '#C1 137枚全てでギャップ0');
})();

// ②: ズーム操作で尺・SRT出力が変化しないこと(pxPerSecはsubsToCues/buildSrtに一切渡らない)
(function () {
  var subs = makeSubs([1234, 5678, 999]);
  var cues = subsToCues(subs);
  var srt = buildSrt(cues, false);

  ZOOM_LEVELS.forEach(function (pxPerSec) {
    // ズーム段を変えてpx変換をしても、subs自体・cues・SRT出力は不変
    var px = msToPx(totalDurationMs(subs), pxPerSec);
    var backMs = pxToMs(px, pxPerSec);
    assert(Math.abs(backMs - totalDurationMs(subs)) < 1e-6, '#C2 px<->ms相互変換の往復誤差が無視できる (pxPerSec=' + pxPerSec + ')');

    var cues2 = subsToCues(subs);
    var srt2 = buildSrt(cues2, false);
    assert(JSON.stringify(cues2) === JSON.stringify(cues), '#C2 ズーム段(pxPerSec=' + pxPerSec + ')に関わらずcuesが不変');
    assert(srt2 === srt, '#C2 ズーム段(pxPerSec=' + pxPerSec + ')に関わらずSRT出力が不変');
  });

  assert(clampZoomIndex(-5) === 0, '#C2 ズーム段の範囲外(下)は0にクランプされる');
  assert(clampZoomIndex(999) === ZOOM_LEVELS.length - 1, '#C2 ズーム段の範囲外(上)は最大にクランプされる');

  assert(pickTickIntervalSec(20) >= pickTickIntervalSec(400), '#C2 高いpx/secほど目盛り間隔が細かくなる(小さくなる)');
})();

// ③: 書き戻しのラウンドトリップ一致(通常ケース) + 既知の例外(残す文字終わりのMで一致しない)
(function () {
  var original = 'مرحبا، كيف حالك؟\nسطر ثاني بدون فاصلة. نص اخير!';
  var segments = segmentManuscript(original);
  var subs = subsFromSegments(segments, 12);

  var reconstructed = reconstructManuscript(subs);
  var reparsedSegments = segmentManuscript(reconstructed);
  var reparsedSubs = subsFromSegments(reparsedSegments, 12);

  assert(reparsedSubs.length === subs.length, '#C3 通常ケース: 書き戻し再変換でクリップ数が一致');
  for (var i = 0; i < subs.length; i++) {
    assert(reparsedSubs[i].text === subs[i].text, '#C3 通常ケース: クリップ' + i + 'のtextが一致 -> "' + reparsedSubs[i].text + '" vs "' + subs[i].text + '"');
    assert(reparsedSubs[i].delim === subs[i].delim, '#C3 通常ケース: クリップ' + i + 'のdelimが一致');
  }

  // 既知の例外: 「残す」系文字(؟ ? ! —)で終わるクリップをMで結合すると、
  // 本文中に残ったその文字が再変換時に再び区切りとして扱われ分割される。
  var exceptionText = 'كيف حالك؟ نص ثالث هنا';
  var exceptionSegments = segmentManuscript(exceptionText);
  var exceptionSubs = subsFromSegments(exceptionSegments, 12);
  assert(exceptionSubs.length === 2, '#C3 例外ケース準備: 2クリップに分割される');

  var mergedResult = mergeClipAt(exceptionSubs, 0);
  assert(mergedResult.ok, '#C3 例外ケース準備: Mで結合できる');
  assert(mergedResult.subs.length === 1, '#C3 例外ケース準備: 結合後は1クリップ');

  var mergedReconstructed = reconstructManuscript(mergedResult.subs);
  var mergedReparsedSegments = segmentManuscript(mergedReconstructed);
  assert(
    mergedReparsedSegments.length === 2,
    '#C3 既知の例外: 「残す」文字で終わるクリップのM結合後は、書き戻し再変換で再び分割される(ラウンドトリップ不一致) -> ' +
    mergedReparsedSegments.length + '個に分割'
  );
})();

// ④: 原稿未編集で往復した際に edited 済みの尺が維持されること
(function () {
  var original = 'مرحبا، كيف حالك؟ نص ثالث هنا.';
  var segments = segmentManuscript(original);
  var subs = subsFromSegments(segments, 12);

  // ユーザーがドラッグでクリップ0の尺を手動調整(edited:true)したと仮定
  subs = setClipDuration(subs, 0, 9999);
  assert(subs[0].edited === true, '#C4 前提: クリップ0はedited:true');

  var reconstructed = reconstructManuscript(subs);

  // 原稿(textarea)が書き戻しテキストと完全一致 -> 再パースせず、そのまま復元してよい
  var textareaUnchanged = reconstructed;
  assert(textEquals(textareaUnchanged, reconstructManuscript(subs)) === true, '#C4 未編集なら書き戻しテキストと完全一致する');

  // このとき再パースは行わないため、edited:trueの手動調整尺(9999ms)がそのまま維持される
  assert(subs[0].durMs === 9999, '#C4 未編集判定時、再パースしなければeditedの尺(9999ms)が維持される');

  // 一方、原稿が編集されていれば一致しない -> 再パースが必要と判定される
  var textareaEdited = reconstructed + ' 追記';
  assert(textEquals(textareaEdited, reconstructManuscript(subs)) === false, '#C4 原稿が編集されていれば不一致と判定され、再パースが必要とわかる');
})();

// ⑤: localStorageの保存・復元・破損時フォールバック(スキーマ検証)
(function () {
  var validState = {
    manuscript: 'مرحبا',
    cps: 12,
    bom: false,
    mode: 'edit',
    clips: [{ text: 'مرحبا', durMs: 1000, delim: '.', edited: false }],
    zoomIndex: 3,
    headTimeMs: 500
  };
  var raw = serializeSession(validState);
  var restored = deserializeSession(raw);
  assert(restored !== null, '#C5 正常なセッションはシリアライズ/デシリアライズを往復できる');
  assert(restored.manuscript === 'مرحبا', '#C5 復元データのmanuscriptが一致');
  assert(restored.clips[0].durMs === 1000, '#C5 復元データのclips[0].durMsが一致');
  assert(restored.version === 1, '#C5 復元データにversionが含まれる');

  assert(deserializeSession('これはJSONではない') === null, '#C5 JSONパース失敗時はnullを返す(例外を投げない)');
  assert(deserializeSession('{"version":2,"manuscript":"a"}') === null, '#C5 バージョン不一致はnullを返す');
  assert(deserializeSession('null') === null, '#C5 null の場合はnullを返す');
  assert(deserializeSession('42') === null, '#C5 オブジェクトでない場合はnullを返す');
  assert(
    deserializeSession(JSON.stringify({ version: 1, manuscript: 'a' })) === null,
    '#C5 必須フィールド欠落時はnullを返す'
  );
  assert(
    deserializeSession(JSON.stringify({
      version: 1, manuscript: 'a', cps: 12, bom: false, mode: 'input',
      clips: [{ text: 'x', durMs: 'not-a-number', delim: '', edited: false }],
      zoomIndex: 0, headTimeMs: 0
    })) === null,
    '#C5 clips内の型不正はnullを返す'
  );
  assert(
    isValidSessionData({
      version: 1, manuscript: 'a', cps: 12, bom: false, mode: 'input',
      clips: [], zoomIndex: 0, headTimeMs: 0
    }) === true,
    '#C5 クリップ0件でも有効なセッションとして扱われる'
  );
})();

console.log('');
console.log(passCount + ' passed, ' + failCount + ' failed');
if (failCount > 0) process.exit(1);
