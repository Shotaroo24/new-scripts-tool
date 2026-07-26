// src/core/* を直接importして回帰テストする。
//
// 実行方法: node tests/logic.test.js

import { segmentManuscript, buildCues } from '../src/core/segment.js';
import { formatSrtTime, formatTotalDuration, formatClock, MIN_DUR_MS, computeStartsMs, totalDurationMs, clipAt, ZOOM_LEVELS, msToPx, pxToMs, pickTickIntervalSec, clampZoomIndex } from '../src/core/time.js';
import { buildSrt } from '../src/core/srt.js';
import {
  subsFromSegments, setClipDuration, trimClipAtHead, mergeClipAt, deleteClipAt,
  recalcUneditedDurations, subsToCues, reconstructManuscript,
  textEquals, pushHistory, popHistory, charCountForText
} from '../src/core/subs.js';
import { parseNumberedTranslation, formatNumberedClips, LRM } from '../src/core/translation.js';
import {
  findBestSplit, judgeLineCount, autoSplitToTwoLines, collapseToOneLine,
  measurementFontSize, previewFontSizePx, previewStrokeWidthPx, previewBaselineOffsetPx, previewSafeMargins,
  clampCalibration, SAFE_WIDTH_1080, CANVAS_BASE_WIDTH, STROKE_WIDTH_AT_1080, SUBTITLE_BASELINE_FROM_BOTTOM,
  FONT_SIZE_DEFAULT, CALIBRATION_DEFAULT, CALIBRATION_MIN, CALIBRATION_MAX
} from '../src/core/style.js';
import {
  isValidSessionData, serializeSession, deserializeSession, migrateV4ToV5,
  serializeTimelineJson, deserializeTimelineJson
} from '../src/core/session.js';

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

// --- タイムライン(ms整数ベース) ---

function makeSubs(dursMs) {
  return dursMs.map(function (d, i) {
    return { text: 'text' + i, durMs: d, edited: false, delim: '', translation: '', translationStale: false };
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

// 4: 結合。テキスト・訳文がスペース連結、尺が合算、配列長が1減る。delimは右側を引き継ぐ
(function () {
  var subs = makeSubs([1000, 2000, 1500]);
  subs[0].text = 'مرحبا';
  subs[0].delim = '.'; // 左のdelimは破棄されるはず
  subs[0].translation = 'Hello';
  subs[1].text = 'بك';
  subs[1].delim = '،'; // 右のdelimは引き継がれるはず
  subs[1].translation = 'there';
  var result = mergeClipAt(subs, 0);
  assert(result.ok, '#T4 結合が成功する');
  assert(result.subs.length === 2, '#T4 配列長が1減る');
  assert(result.subs[0].text === 'مرحبا بك', '#T4 テキストがスペース連結される -> "' + result.subs[0].text + '"');
  assert(result.subs[0].translation === 'Hello there', '#T4 訳文もスペース連結される -> "' + result.subs[0].translation + '"');
  assert(result.subs[0].durMs === 3000, '#T4 尺が合算される -> ' + result.subs[0].durMs);
  assert(result.subs[0].edited === true, '#T4 結合後のクリップはedited:trueになる');
  assert(result.subs[0].delim === '،', '#T4 delimは右クリップのものを引き継ぐ -> "' + result.subs[0].delim + '"');
  assert(result.subs[0].translationStale === true, '#T4 結合後はtranslationStaleがtrueになる(§7)');
})();

// 4c: 結合。片方の訳文が空文字列の場合は除外して連結する(§7)
(function () {
  var subs = makeSubs([1000, 2000]);
  subs[0].translation = 'Hello';
  subs[1].translation = '';
  var result = mergeClipAt(subs, 0);
  assert(result.subs[0].translation === 'Hello', '#T4c 空文字列側は除外して連結される(片方のみ) -> "' + result.subs[0].translation + '"');

  var subs2 = makeSubs([1000, 2000]);
  subs2[0].translation = '';
  subs2[1].translation = '';
  var result2 = mergeClipAt(subs2, 0);
  assert(result2.subs[0].translation === '', '#T4c 両方空文字列なら結果も空文字列 -> "' + result2.subs[0].translation + '"');
})();

// 4d: 結合操作をUndoすると、訳文とtranslationStaleを含めて完全に復元される(§9)
(function () {
  var subs = makeSubs([1000, 2000, 1500]);
  subs[0].translation = 'Hello';
  subs[1].translation = 'there';
  var history = [];
  var before = JSON.parse(JSON.stringify(subs));

  history = pushHistory(history, subs);
  var result = mergeClipAt(subs, 0);
  assert(result.subs[0].translationStale === true, '#T4d 前提: 結合直後はtranslationStale:true');

  var restored = popHistory(history);
  assert(JSON.stringify(restored.subs) === JSON.stringify(before), '#T4d Undoで結合前の訳文・translationStaleを含め完全復元する');
  assert(restored.subs[0].translation === 'Hello' && restored.subs[1].translation === 'there', '#T4d Undoで訳文の値そのものが戻る');
  assert(restored.subs[0].translationStale === false, '#T4d Undoでtranslation Staleもfalseに戻る');
})();

// 4b: 結合。最終クリップでは拒否される
(function () {
  var subs = makeSubs([1000, 2000, 1500]);
  var result = mergeClipAt(subs, 2);
  assert(result.ok === false, '#T4b 最終クリップの結合は拒否される');
})();

// 5: 削除。配列長が1減り、後続の開始時刻が繰り上がる(訳文も連動して消える)
(function () {
  var subs = makeSubs([1000, 2000, 1500]);
  subs[0].translation = 'first';
  var result = deleteClipAt(subs, 0);
  assert(result.ok, '#T5 削除が成功する');
  assert(result.subs.length === 2, '#T5 配列長が1減る');
  assert(result.subs.indexOf(subs[0]) === -1, '#T5 削除したクリップの訳文も連動して消える');
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

// --- edited フラグと cps 再計算 ---

// (a) cps変更で edited:false のみ再計算され、edited は不変。translationはそのまま保持される
(function () {
  var subs = [
    { text: 'أ'.repeat(12), durMs: 1000, edited: false, delim: '', translation: 'unedited-en', translationStale: false },
    { text: 'ب'.repeat(12), durMs: 5000, edited: true, delim: '', translation: 'edited-en', translationStale: true }
  ];
  var next = recalcUneditedDurations(subs, 12);
  assert(next[0].durMs === 1000, '#A1 unedited(cps=12,12文字)は再計算後も1000ms -> ' + next[0].durMs);
  assert(next[0].edited === false, '#A1 unedited のeditedはfalseのまま');
  assert(next[0].translation === 'unedited-en', '#A1 unedited のtranslationは保持される');
  assert(next[1].durMs === 5000, '#A1 edited:trueのクリップは尺が変更されない -> ' + next[1].durMs);
  assert(next[1].edited === true, '#A1 edited:trueのクリップのeditedは不変');
  assert(next[1].translation === 'edited-en', '#A1 edited:trueのtranslationも保持される');

  var next2 = recalcUneditedDurations(subs, 6);
  assert(next2[0].durMs === 2000, '#A1 cps=6に変更するとunedited(12文字)は2000msに再計算される -> ' + next2[0].durMs);
  assert(next2[1].durMs === 5000, '#A1 edited:trueは再計算対象外(cps=6でも変化なし)');
})();

// (b) cps変更 -> Undoで復元される
(function () {
  var subs = [
    { text: 'أ'.repeat(12), durMs: 1000, edited: false, delim: '', en: '' }
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
    { text: 'a', durMs: 1000, edited: true, delim: '', en: '' },
    { text: 'b', durMs: 1000, edited: false, delim: '', en: '' },
    { text: 'c', durMs: 1000, edited: true, delim: '', en: '' }
  ];
  var result = deleteClipAt(subs, 0);
  assert(result.subs[0].edited === false, '#A4 削除後も残存クリップのeditedは不変(1) -> ' + result.subs[0].edited);
  assert(result.subs[1].edited === true, '#A4 削除後も残存クリップのeditedは不変(2) -> ' + result.subs[1].edited);
})();

// subsFromSegments: 生成時は全クリップ edited:false、durMsはcpsからMath.round・最小300msクランプ。
// translationは生成時点では持たない(番号付きコピー&貼り付けで後から入力するため常に空・非stale)
(function () {
  var subs = subsFromSegments(
    [{ lines: ['أ'], delim: '' }, { lines: ['أأأأأأأأأأأأأأأأأأأأأأأأ'], delim: '.' }],
    12
  ); // 1文字 / 24文字
  assert(subs[0].edited === false && subs[1].edited === false, '#A5 生成時は全クリップedited:false');
  assert(subs[0].durMs === MIN_DUR_MS, '#A5 1文字/12cps=83.3..msは最小300msにクランプされる -> ' + subs[0].durMs);
  assert(subs[1].durMs === 2000, '#A5 24文字/12cps=2000msはそのまま -> ' + subs[1].durMs);
  assert(subs[1].delim === '.', '#A5 segmentsのdelimがsubsにも引き継がれる');
  assert(
    subs[0].translation === '' && subs[1].translation === '',
    '#A5 生成直後は全クリップtranslationが空文字'
  );
  assert(
    subs[0].translationStale === false && subs[1].translationStale === false,
    '#A5 生成直後は全クリップtranslationStaleがfalse'
  );
})();

// --- ①〜⑩: 今回の完了条件 ---

// ①: ms精度で累積が一致すること(大量クリップでも整数演算のみで誤差ゼロ)
(function () {
  var n = 137;
  var dursMs = [];
  for (var i = 0; i < n; i++) dursMs.push(333); // 0.1刻みでは表現できない値
  var subs = makeSubs(dursMs);
  var cues = subsToCues(subs);
  assert(totalDurationMs(subs) === 333 * n, '#1 合計msが正確 (' + (333 * n) + ')');
  assert(cues[cues.length - 1].endMs === 333 * n, '#1 最後のキューのendMsが理論値と完全一致(誤差ゼロ) -> ' + cues[cues.length - 1].endMs);
  var gapOk = true;
  for (var j = 1; j < cues.length; j++) {
    if (cues[j].startMs !== cues[j - 1].endMs) { gapOk = false; break; }
  }
  assert(gapOk, '#1 137枚全てでギャップ0');
})();

// ②: ズーム操作で尺・SRT出力が変化しないこと(pxPerSecはsubsToCues/buildSrtに一切渡らない)
(function () {
  var subs = makeSubs([1234, 5678, 999]);
  var cues = subsToCues(subs);
  var srt = buildSrt(cues, false);

  ZOOM_LEVELS.forEach(function (pxPerSec) {
    var px = msToPx(totalDurationMs(subs), pxPerSec);
    var backMs = pxToMs(px, pxPerSec);
    assert(Math.abs(backMs - totalDurationMs(subs)) < 1e-6, '#2 px<->ms相互変換の往復誤差が無視できる (pxPerSec=' + pxPerSec + ')');

    var cues2 = subsToCues(subs);
    var srt2 = buildSrt(cues2, false);
    assert(JSON.stringify(cues2) === JSON.stringify(cues), '#2 ズーム段(pxPerSec=' + pxPerSec + ')に関わらずcuesが不変');
    assert(srt2 === srt, '#2 ズーム段(pxPerSec=' + pxPerSec + ')に関わらずSRT出力が不変');
  });

  assert(clampZoomIndex(-5) === 0, '#2 ズーム段の範囲外(下)は0にクランプされる');
  assert(clampZoomIndex(999) === ZOOM_LEVELS.length - 1, '#2 ズーム段の範囲外(上)は最大にクランプされる');
  assert(pickTickIntervalSec(20) >= pickTickIntervalSec(400), '#2 高いpx/secほど目盛り間隔が細かくなる(小さくなる)');
})();

// ③: 原稿の書き戻しのラウンドトリップ一致(通常ケース) + 既知の例外
// (訳文はクリップ単位で管理されテキストからは書き戻さないため、この検証対象外)
(function () {
  var original = 'مرحبا، كيف حالك؟\nسطر ثاني بدون فاصلة. نص اخير!';
  var segments = segmentManuscript(original);
  var subs = subsFromSegments(segments, 12);

  var reconstructed = reconstructManuscript(subs);
  var reparsedSegments = segmentManuscript(reconstructed);
  var reparsedSubs = subsFromSegments(reparsedSegments, 12);

  assert(reparsedSubs.length === subs.length, '#3 通常ケース: 書き戻し再変換でクリップ数が一致');
  for (var i = 0; i < subs.length; i++) {
    assert(reparsedSubs[i].text === subs[i].text, '#3 通常ケース: クリップ' + i + 'のtextが一致 -> "' + reparsedSubs[i].text + '" vs "' + subs[i].text + '"');
    assert(reparsedSubs[i].delim === subs[i].delim, '#3 通常ケース: クリップ' + i + 'のdelimが一致');
  }

  // 既知の例外: 「残す」系文字(؟ ? ! —)で終わるクリップをMで結合すると、
  // 本文中に残ったその文字が再変換時に再び区切りとして扱われ分割される。
  var exceptionText = 'كيف حالك؟ نص ثالث هنا';
  var exceptionSegments = segmentManuscript(exceptionText);
  var exceptionSubs = subsFromSegments(exceptionSegments, 12);
  assert(exceptionSubs.length === 2, '#3 例外ケース準備: 2クリップに分割される');

  var mergedResult = mergeClipAt(exceptionSubs, 0);
  assert(mergedResult.ok, '#3 例外ケース準備: Mで結合できる');
  assert(mergedResult.subs.length === 1, '#3 例外ケース準備: 結合後は1クリップ');

  var mergedReconstructed = reconstructManuscript(mergedResult.subs);
  var mergedReparsedSegments = segmentManuscript(mergedReconstructed);
  assert(
    mergedReparsedSegments.length === 2,
    '#3 既知の例外: 「残す」文字で終わるクリップのM結合後は、書き戻し再変換で再び分割される(ラウンドトリップ不一致) -> ' +
    mergedReparsedSegments.length + '個に分割'
  );
})();

// ④: 原稿未編集で往復した際に edited 済みの尺が維持されること。cps/SRTはtranslationの内容に無関係
(function () {
  var original = 'مرحبا، كيف حالك؟ نص ثالث هنا.';
  var segments = segmentManuscript(original);
  var subs = subsFromSegments(segments, 12);

  // ユーザーがドラッグでクリップ0の尺を手動調整(edited:true)したと仮定
  subs = setClipDuration(subs, 0, 9999);
  assert(subs[0].edited === true, '#4 前提: クリップ0はedited:true');

  var reconstructed = reconstructManuscript(subs);

  // 原稿が書き戻しテキストと完全一致 -> 再パースせず、そのまま復元してよい
  assert(textEquals(reconstructed, reconstructManuscript(subs)) === true, '#4 未編集なら書き戻しテキストと完全一致する');

  // このとき再パースは行わないため、edited:trueの手動調整尺(9999ms)がそのまま維持される
  assert(subs[0].durMs === 9999, '#4 未編集判定時、再パースしなければeditedの尺(9999ms)が維持される');

  // 一方、原稿が編集されていれば一致しない -> 再パースが必要と判定される
  var textareaEdited = reconstructed + ' 追記';
  assert(textEquals(textareaEdited, reconstructManuscript(subs)) === false, '#4 原稿が編集されていれば不一致と判定され、再パースが必要とわかる');

  // cps算出・SRT出力はtranslationの内容・有無に一切影響されない
  // (subsFromSegmentsはtranslationを一切扱わないため、後からtranslationだけ異なる2系列を作って比較する)
  var subsNoEn = subsFromSegments(segments, 12);
  var subsWithEn = subsFromSegments(segments, 12).map(function (s) {
    return Object.assign({}, s, { translation: 'long english translation text here' });
  });
  assert(
    subsNoEn.map(function (s) { return s.durMs; }).join(',') === subsWithEn.map(function (s) { return s.durMs; }).join(','),
    '#4 cps算出(durMs)はtranslationの内容に影響されない'
  );
  var srtNoEn = buildSrt(subsToCues(subsNoEn), false);
  var srtWithEn = buildSrt(subsToCues(subsWithEn), false);
  assert(srtNoEn === srtWithEn, '#4 SRT出力はtranslationの内容に影響されない');
})();

// ⑤: SRT出力に英訳が含まれないこと
(function () {
  var segments = segmentManuscript('مرحبا، كيف حالك؟');
  var subs = subsFromSegments(segments, 12).map(function (s, i) {
    return Object.assign({}, s, { translation: i === 0 ? 'Hello there translation marker XYZ' : 'How are you translation marker XYZ' });
  });
  var srt = buildSrt(subsToCues(subs), false);
  assert(srt.indexOf('XYZ') === -1, '#5 SRT出力に英訳の文字列が一切含まれない');
  assert(srt.indexOf('مرحبا') !== -1, '#5 SRT出力にアラビア語本文は含まれる');
})();

// ⑥: 2行テキストがSRTの複数行キューとして正しく出力されること
(function () {
  var subs = [{ text: 'السطر الأول\nالسطر الثاني', durMs: 2000, edited: false, delim: '', en: '' }];
  var cues = subsToCues(subs);
  assert(cues[0].lines.length === 2, '#6 cueのlinesが2行になる');
  var srt = buildSrt(cues, false);
  assert(srt.indexOf('السطر الأول\nالسطر الثاني') !== -1, '#6 SRT内で改行を保持した複数行キューとして出力される -> ' + srt);
})();

// ⑦: 判定の3値分岐(境界値: 安全幅ちょうど、安全幅+1px)
(function () {
  // 1文字10pxの決定的な擬似計測関数(スペースは幅0として単語区切りのみに使う)
  function fakeMeasure(text) {
    var chars = Array.from(text);
    var w = 0;
    for (var i = 0; i < chars.length; i++) w += (chars[i] === ' ') ? 0 : 10;
    return w;
  }
  // 安全幅ちょうど(90文字*10px=900px) -> 1行
  var exact = judgeLineCount('a'.repeat(90), 900, fakeMeasure);
  assert(exact.level === 'one-line', '#7 安全幅ちょうどは1行判定 -> ' + exact.level + ' (maxWidth=' + exact.maxWidth + ')');

  // 安全幅+1px相当(91文字*10px=910px、スペースなしで分割不可) -> 溢れ
  var over = judgeLineCount('a'.repeat(91), 900, fakeMeasure);
  assert(over.level === 'overflow', '#7 安全幅+1px相当かつ分割不可は溢れ判定 -> ' + over.level);

  // スペースありで2分割すれば安全幅に収まるケース -> 2行推奨
  // 全体93文字(スペース込み)=930px(安全幅超過)だが、分割後は各46文字=460pxで収まる
  var twoLineText = 'a'.repeat(46) + ' ' + 'a'.repeat(46);
  var twoLine = judgeLineCount(twoLineText, 900, fakeMeasure);
  assert(twoLine.level === 'two-line', '#7 分割すれば安全幅に収まる場合は2行推奨 -> ' + twoLine.level + ' (maxWidth=' + twoLine.maxWidth + ')');

  // 2分割しても安全幅を超える場合 -> 溢れ
  var overflowText = 'a'.repeat(100) + ' ' + 'a'.repeat(100);
  var overflow2 = judgeLineCount(overflowText, 900, fakeMeasure);
  assert(overflow2.level === 'overflow', '#7 分割しても安全幅を超える場合は溢れ判定 -> ' + overflow2.level);

  // 既に手動2行(改行あり)の場合は行ごとに判定し、3行以上は常に溢れ
  var threeLines = judgeLineCount('a'.repeat(10) + '\n' + 'a'.repeat(10) + '\n' + 'a'.repeat(10), 900, fakeMeasure);
  assert(threeLines.level === 'overflow', '#7 3行以上は常に溢れ判定 -> ' + threeLines.level);
})();

// ⑧: calibration変更でプレビューのフォントサイズと判定(実測に使うフォントサイズ)が連動すること
(function () {
  var width = 320;
  var size1 = previewFontSizePx(FONT_SIZE_DEFAULT, 1.0, width);
  var size2 = previewFontSizePx(FONT_SIZE_DEFAULT, 1.2, width);
  assert(Math.abs(size2 / size1 - 1.2) < 1e-9, '#8 calibrationに比例してプレビューのフォントサイズが変化する');

  var measure1 = measurementFontSize(FONT_SIZE_DEFAULT, 1.0);
  var measure2 = measurementFontSize(FONT_SIZE_DEFAULT, 1.2);
  assert(Math.abs(measure2 / measure1 - 1.2) < 1e-9, '#8 calibrationに比例して実測用フォントサイズも同じ比率で変化する(判定と連動)');

  assert(clampCalibration(0.5) === CALIBRATION_MIN, '#8 calibrationは下限にクランプされる');
  assert(clampCalibration(2.0) === CALIBRATION_MAX, '#8 calibrationは上限にクランプされる');
  assert(clampCalibration(CALIBRATION_DEFAULT) === CALIBRATION_DEFAULT, '#8 既定値はそのまま');
})();

// ⑨: プレビューの安全領域・ベースライン位置がプレビュー幅に比例してスケールすること(実測はPlaywrightで別途確認)
(function () {
  var width = 320;
  var scale = width / CANVAS_BASE_WIDTH;
  var baseline = previewBaselineOffsetPx(width);
  assert(Math.abs(baseline - SUBTITLE_BASELINE_FROM_BOTTOM * scale) < 1e-9, '#9 ベースライン位置が1080px基準からプレビュー幅に比例して算出される -> ' + baseline);

  var margins = previewSafeMargins(width);
  assert(Math.abs(margins.left - 90 * scale) < 1e-9, '#9 安全領域(左)が比例してスケールする');
  assert(Math.abs(margins.bottom - 300 * scale) < 1e-9, '#9 安全領域(下)が比例してスケールする');
})();

// ⑩: 判定に使う描画幅にストローク幅が加算されていること
(function () {
  function measureWithoutStroke(text) {
    return Array.from(text).length * 10;
  }
  function measureWithStroke(text) {
    return measureWithoutStroke(text) + STROKE_WIDTH_AT_1080;
  }
  // ちょうどストローク加算分だけ超える幅になるテキストで、有無により判定が変わることを確認する
  var charCount = Math.floor(900 / 10); // ストロークなしでは安全幅ちょうど
  var text = 'a'.repeat(charCount);

  var withoutStroke = judgeLineCount(text, 900, measureWithoutStroke);
  var withStroke = judgeLineCount(text, 900, measureWithStroke);

  assert(withoutStroke.level === 'one-line', '#10 ストローク幅なしでは安全幅ちょうどで1行判定 -> ' + withoutStroke.level);
  assert(withStroke.maxWidth === withoutStroke.maxWidth + STROKE_WIDTH_AT_1080, '#10 ストローク幅が測定幅に加算されている -> ' + withStroke.maxWidth);
  assert(withStroke.level === 'overflow', '#10 ストローク幅を加算すると安全幅を超え溢れ判定に変わる -> ' + withStroke.level);
})();

// --- 番号付き英訳ラウンドトリップ: parseNumberedTranslation / formatNumberedClips ---

// 正常系: N件が過不足なく揃う
(function () {
  var r = parseNumberedTranslation('1. Hello\n2. How are you\n3. Thanks', 3);
  assert(r.entries.size === 3, '#tr1 3件のエントリが取得できる');
  assert(r.entries.get(1) === 'Hello' && r.entries.get(2) === 'How are you' && r.entries.get(3) === 'Thanks', '#tr1 番号と本文が正しく対応する');
  assert(r.issues.missing.length === 0 && r.issues.duplicate.length === 0 && r.issues.outOfRange.length === 0 && r.issues.emptyBody.length === 0 && r.issues.preamble === false, '#tr1 issuesが全て空');
})();

// 折り返し行が直前のエントリへ半角スペースで連結される
(function () {
  var r = parseNumberedTranslation('1. Hello\nworld\n2. Second', 2);
  assert(r.entries.get(1) === 'Hello world', '#tr2 折り返し行が直前のエントリへ連結される -> "' + r.entries.get(1) + '"');
  assert(r.entries.get(2) === 'Second', '#tr2 後続エントリの本文は影響を受けない');
})();

// 空行が無視される(エントリの連結を分断しない)
(function () {
  var r = parseNumberedTranslation('1. Hello\n\n2. World', 2);
  assert(r.entries.get(1) === 'Hello' && r.entries.get(2) === 'World', '#tr3 空行は無視される');
})();

// コードフェンスの除去
(function () {
  var r = parseNumberedTranslation('```\n1. Hello\n2. World\n```', 2);
  assert(r.entries.get(1) === 'Hello' && r.entries.get(2) === 'World', '#tr4 コードフェンス行が除去される');
  assert(r.issues.preamble === false, '#tr4 コードフェンス自体はpreambleと誤検出されない');
})();

// 全角数字・全角ピリオドの正規化
(function () {
  var r = parseNumberedTranslation('１．Hello\n２．World', 2);
  assert(r.entries.get(1) === 'Hello' && r.entries.get(2) === 'World', '#tr5 全角数字・全角ピリオドが正規化される');
})();

// 区切り文字のバリエーション(区切り自体は必須、直後の空白は任意)
(function () {
  assert(parseNumberedTranslation('1.Hello', 1).entries.get(1) === 'Hello', '#tr6 "1."(空白なし)を許容する');
  assert(parseNumberedTranslation('1) Hello', 1).entries.get(1) === 'Hello', '#tr6 "1)"を許容する');
  assert(parseNumberedTranslation('1: Hello', 1).entries.get(1) === 'Hello', '#tr6 "1:"を許容する');
  assert(parseNumberedTranslation('1 - Hello', 1).entries.get(1) === 'Hello', '#tr6 "1 -"を許容する');
})();

// 欠落番号の検出
(function () {
  var r = parseNumberedTranslation('1. a\n3. c', 3);
  assert(r.issues.missing.length === 1 && r.issues.missing[0] === 2, '#tr7 欠落番号(#2)が検出される');
})();

// 重複番号の検出と、最初の出現の採用
(function () {
  var r = parseNumberedTranslation('1. first\n1. second', 1);
  assert(r.entries.get(1) === 'first', '#tr8 重複時は最初の出現が採用される');
  assert(r.issues.duplicate.length === 1 && r.issues.duplicate[0] === 1, '#tr8 重複番号(#1)が検出される');
})();

// 範囲外番号の検出(0以下・N超過)
(function () {
  var r = parseNumberedTranslation('0. zero\n1. a\n5. over', 1);
  assert(r.issues.outOfRange.indexOf(0) !== -1, '#tr9 0以下の番号が範囲外として検出される');
  assert(r.issues.outOfRange.indexOf(5) !== -1, '#tr9 N超過の番号が範囲外として検出される');
})();

// 空本文の検出
(function () {
  var r = parseNumberedTranslation('1. \n2. b', 2);
  assert(r.issues.emptyBody.length === 1 && r.issues.emptyBody[0] === 1, '#tr10 空本文(#1)が検出される');
})();

// preambleの検出(最初のエントリより前に非空行がある場合)
(function () {
  var r = parseNumberedTranslation('Here is the translation:\n1. Hello\n2. World', 2);
  assert(r.issues.preamble === true, '#tr11 最初のエントリより前の非空行はpreambleとして検出される');
})();

// 空入力・空白のみの入力
(function () {
  var r1 = parseNumberedTranslation('', 2);
  assert(r1.entries.size === 0 && r1.issues.missing.length === 2 && r1.issues.preamble === false, '#tr12 空入力はエントリ0件・preambleなし');
  var r2 = parseNumberedTranslation('   \n  \n', 2);
  assert(r2.entries.size === 0 && r2.issues.preamble === false, '#tr12 空白のみの入力もエントリ0件・preambleなし');
})();

// 本文先頭の双方向制御文字(LRM/RLM/ALM)が除去される
(function () {
  var lrm = String.fromCharCode(0x200e);
  var r = parseNumberedTranslation('1.' + lrm + 'Hello', 1);
  assert(r.entries.get(1) === 'Hello', '#tr13 LRMが本文から除去される -> "' + r.entries.get(1) + '"');
})();

// formatNumberedClips: 番号+LRM+本文の形式で出力し、空クリップも欠番にしない
(function () {
  var subs = [{ text: 'مرحبا' }, { text: '' }, { text: 'شكرا' }];
  var formatted = formatNumberedClips(subs);
  var lines = formatted.split('\n');
  assert(lines.length === 3, '#tr14 行区切りが\\nで、クリップ数分の行が出力される');
  assert(lines[1] === '2.' + LRM, '#tr14 空クリップも欠番にせず番号を維持する -> "' + lines[1] + '"');
  assert(formatted.indexOf(LRM) !== -1, '#tr14 番号と本文の間にLRMが挿入される');
  var reparsed = parseNumberedTranslation(formatted, 3);
  assert(reparsed.entries.get(1) === 'مرحبا' && reparsed.entries.get(3) === 'شكرا', '#tr14 コピー直後の自分自身の出力を貼り戻しても正しくパースできる');
})();

// --- localStorage: 保存・復元・破損時フォールバック(スキーマv5、§2) ---
(function () {
  var validState = {
    manuscript: 'مرحبا',
    cps: 12,
    bom: false,
    mode: 'edit',
    clips: [{ text: 'مرحبا', durMs: 1000, delim: '.', edited: false, translation: 'Hello', translationStale: false }],
    zoomIndex: 3,
    headTimeMs: 500,
    calibration: 1.05,
    fontSize: 60
  };
  var raw = serializeSession(validState);
  var restored = deserializeSession(raw);
  assert(restored !== null, '#local1 正常なセッションはシリアライズ/デシリアライズを往復できる');
  assert(restored.manuscript === 'مرحبا', '#local1 復元データのmanuscriptが一致');
  assert(restored.clips[0].durMs === 1000, '#local1 復元データのclips[0].durMsが一致');
  assert(restored.clips[0].translation === 'Hello', '#local1 復元データのclips[0].translationが一致');
  assert(restored.calibration === 1.05, '#local1 復元データのcalibrationが一致');
  assert(restored.fontSize === 60, '#local1 復元データのfontSizeが一致');
  assert(restored.version === 5, '#local1 復元データにversion:5が含まれる');
  assert(!('translation' in JSON.parse(raw)), '#local1 保存データにトップレベルのtranslationフィールドが含まれない(v4の名残り廃止)');
  assert(!('master' in JSON.parse(raw)), '#local1 保存データにmasterフィールドが含まれない');
  assert(!('segments' in JSON.parse(raw)), '#local1 保存データにsegmentsフィールドが含まれない');
  assert(!('legacyTranslationText' in JSON.parse(raw)), '#local1 legacyTranslationText未指定時は保存データに含まれない');
})();

// v4(旧英訳textarea方式)からv5への移行: 件数一致時は順にtranslationへ割り当てられる
(function () {
  var v4raw = JSON.stringify({
    version: 4, manuscript: 'مرحبا', translation: 'Hello\nHow are you',
    cps: 12, bom: false, mode: 'edit',
    clips: [
      { text: 'مرحبا', durMs: 1000, delim: '.', edited: false, en: '' },
      { text: 'كيف حالك', durMs: 900, delim: '؟', edited: false, en: '' }
    ],
    zoomIndex: 3, headTimeMs: 500, calibration: 1.05, fontSize: 60
  });
  var restored = deserializeSession(v4raw);
  assert(restored !== null, '#migrate1 v4データが読み込める');
  assert(restored.version === 5, '#migrate1 移行後はversion:5になる');
  assert(restored.clips[0].translation === 'Hello' && restored.clips[1].translation === 'How are you', '#migrate1 件数一致時は順にtranslationへ割り当てられる');
  assert(restored.clips[0].translationStale === false && restored.clips[1].translationStale === false, '#migrate1 件数一致時はtranslationStaleがfalse');
  assert(!('legacyTranslationText' in restored), '#migrate1 件数一致時はlegacyTranslationTextを持たない');
})();

// v4→v5移行: 件数不一致時は割り当てず、全クリップtranslationStale:trueかつlegacyTranslationTextを保持する(破棄しない)
(function () {
  var v4raw = JSON.stringify({
    version: 4, manuscript: 'مرحبا', translation: 'Hello\nHow are you\nextra line',
    cps: 12, bom: false, mode: 'edit',
    clips: [
      { text: 'مرحبا', durMs: 1000, delim: '.', edited: false, en: '' },
      { text: 'كيف حالك', durMs: 900, delim: '؟', edited: false, en: '' }
    ],
    zoomIndex: 3, headTimeMs: 500, calibration: 1.05, fontSize: 60
  });
  var restored = deserializeSession(v4raw);
  assert(restored !== null, '#migrate2 v4データが読み込める');
  assert(restored.clips[0].translation === '' && restored.clips[1].translation === '', '#migrate2 件数不一致時はtranslationを割り当てない');
  assert(restored.clips[0].translationStale === true && restored.clips[1].translationStale === true, '#migrate2 件数不一致時は全クリップtranslationStale:trueになる');
  assert(restored.legacyTranslationText === 'Hello\nHow are you\nextra line', '#migrate2 旧テキストがlegacyTranslationTextとして保持される(破棄されない)');
})();

// 旧v3(動画トラック撤去前、master/segments付き)もv4と同じ経路でv5へ移行できる(master/segmentsは無視)
(function () {
  var v3raw = JSON.stringify({
    version: 3, manuscript: 'مرحبا', translation: 'Hello', cps: 12, bom: false, mode: 'edit',
    clips: [{ text: 'مرحبا', durMs: 1000, delim: '.', edited: false, en: 'Hello' }],
    zoomIndex: 3, headTimeMs: 500, calibration: 1.05, fontSize: 60,
    master: { fileName: 'master_capcut.mp4', durationMs: 20000 },
    segments: [{ srcInMs: 0, durMs: 20000 }]
  });
  var restoredV3 = deserializeSession(v3raw);
  assert(restoredV3 !== null, '#local1 旧v3(master/segments付き)のセッションも字幕部分は復元できる');
  assert(restoredV3.clips[0].text === 'مرحبا', '#local1 v3データのclipsが読み取れる');
  assert(restoredV3.clips[0].translation === 'Hello', '#local1 v3データの英訳もv5のtranslationへ移行される');
})();

// migrateV4ToV5を直接呼んだ場合の純粋関数としての挙動確認
(function () {
  var migrated = migrateV4ToV5({
    manuscript: 'a', translation: 'x\ny', cps: 12, bom: false, mode: 'input',
    clips: [
      { text: 'a', durMs: 1000, delim: '', edited: false, en: '' },
      { text: 'b', durMs: 1000, delim: '', edited: false, en: '' }
    ],
    zoomIndex: 0, headTimeMs: 0, calibration: 1, fontSize: 55
  });
  assert(migrated.version === 5, '#migrate3 migrateV4ToV5はversion:5を返す');
  assert(!('translation' in migrated), '#migrate3 トップレベルのtranslationフィールドは持たない');
})();

// 破損データのフォールバック
(function () {
  assert(deserializeSession('これはJSONではない') === null, '#local2 JSONパース失敗時はnullを返す(例外を投げない)');
  assert(deserializeSession('{"version":1,"manuscript":"a"}') === null, '#local2 旧バージョン(v1)は破棄されnullを返す');
  assert(
    deserializeSession(JSON.stringify({
      version: 2, manuscript: 'a', translation: '', cps: 12, bom: false, mode: 'input',
      clips: [], zoomIndex: 0, headTimeMs: 0, calibration: 1, fontSize: 55
    })) === null,
    '#local2 旧バージョン(v2)は破棄されnullを返す'
  );
  assert(deserializeSession('null') === null, '#local2 null の場合はnullを返す');
  assert(deserializeSession('42') === null, '#local2 オブジェクトでない場合はnullを返す');
  assert(
    deserializeSession(JSON.stringify({ version: 5, manuscript: 'a' })) === null,
    '#local2 必須フィールド欠落時はnullを返す'
  );
  assert(
    deserializeSession(JSON.stringify({
      version: 5, manuscript: 'a', cps: 12, bom: false, mode: 'input',
      clips: [{ text: 'x', durMs: 'not-a-number', delim: '', edited: false, translation: '', translationStale: false }],
      zoomIndex: 0, headTimeMs: 0, calibration: 1, fontSize: 55
    })) === null,
    '#local2 clips内の型不正はnullを返す'
  );
  assert(
    deserializeSession(JSON.stringify({
      version: 5, manuscript: 'a', cps: 12, bom: false, mode: 'input',
      clips: [{ text: 'x', durMs: 1000, delim: '', edited: false, translation: '' }], // translationStale欠落
      zoomIndex: 0, headTimeMs: 0, calibration: 1, fontSize: 55
    })) === null,
    '#local2 clips内のtranslationStale欠落はnullを返す'
  );
  assert(
    isValidSessionData({
      version: 5, manuscript: 'a', cps: 12, bom: false, mode: 'input',
      clips: [], zoomIndex: 0, headTimeMs: 0, calibration: 1, fontSize: 55
    }) === true,
    '#local2 クリップ0件でも有効なセッションとして扱われる'
  );
})();

// --- §7-6: timeline.json ラウンドトリップ・version不一致の拒否(v3) ---
(function () {
  var state = {
    subs: [
      { text: 'مرحبا', durMs: 1270, edited: true, delim: '', translation: 'Hello', translationStale: false },
      { text: 'كيف حالك', durMs: 900, edited: false, delim: '؟', translation: 'How are you', translationStale: true }
    ],
    cps: 12,
    style: { fontSize: 55, calibration: 1.0 }
  };
  var raw = serializeTimelineJson(state);
  var restored = deserializeTimelineJson(raw);

  assert(restored !== null, '#7-6 正常なtimeline.jsonはシリアライズ/デシリアライズを往復できる');
  assert(restored.version === 3, '#7-6 versionが3で保存される');
  assert(
    JSON.stringify(restored.subs) === JSON.stringify(state.subs),
    '#7-6 subsが完全一致する -> ' + JSON.stringify(restored.subs)
  );
  assert(restored.cps === state.cps, '#7-6 cpsが完全一致する');
  assert(
    restored.style.fontSize === state.style.fontSize && restored.style.calibration === state.style.calibration,
    '#7-6 styleが完全一致する'
  );
  assert(!('master' in JSON.parse(raw)), '#7-6 保存データにmasterフィールドが含まれない');
  assert(!('segments' in JSON.parse(raw)), '#7-6 保存データにsegmentsフィールドが含まれない');

  // 旧v2(en方式)のtimeline.jsonはv3へ無条件で移行される(1クリップ=1翻訳で件数ズレの余地がないため)
  var v2raw = JSON.stringify({
    version: 2,
    subs: [
      { text: 'مرحبا', durMs: 1270, edited: true, delim: '', en: 'Hello' },
      { text: 'كيف حالك', durMs: 900, edited: false, delim: '؟', en: 'How are you' }
    ],
    cps: 12, style: { fontSize: 55, calibration: 1 }
  });
  var restoredV2 = deserializeTimelineJson(v2raw);
  assert(restoredV2 !== null, '#7-6 旧v2(en方式)のtimeline.jsonも読み込める');
  assert(restoredV2.version === 3, '#7-6 v2は読み込み時にv3へ移行される');
  assert(
    restoredV2.subs[0].translation === 'Hello' && restoredV2.subs[1].translation === 'How are you',
    '#7-6 v2のenがそのままtranslationへ移行される'
  );
  assert(restoredV2.subs[0].translationStale === false, '#7-6 v2からの移行はtranslationStale:falseになる');

  // 旧v1(master/segments付き)のtimeline.jsonも同じ経路で字幕部分のみ読み取って受け入れる
  var v1raw = JSON.stringify({
    version: 1,
    master: { fileName: 'master_capcut.mp4', durationMs: 67000 },
    segments: [{ srcInMs: 0, durMs: 16000 }],
    subs: [
      { text: 'مرحبا', durMs: 1270, edited: true, delim: '', en: 'Hello' },
      { text: 'كيف حالك', durMs: 900, edited: false, delim: '؟', en: 'How are you' }
    ],
    cps: 12, style: { fontSize: 55, calibration: 1 }
  });
  var restoredV1 = deserializeTimelineJson(v1raw);
  assert(restoredV1 !== null, '#7-6 旧v1(master/segments付き)のtimeline.jsonも字幕部分は復元できる');
  assert(restoredV1.subs.length === 2, '#7-6 v1データのsubsが読み取れる');

  // 未知versionは読み込み拒否
  assert(
    deserializeTimelineJson(JSON.stringify(Object.assign({}, JSON.parse(raw), { version: 99 }))) === null,
    '#7-6 未知version(v99)のtimeline.jsonは読み込み拒否されnullを返す'
  );
  assert(deserializeTimelineJson('{"version":3}') === null, '#7-6 必須フィールド欠落時はnullを返す');
  assert(deserializeTimelineJson('これはJSONではない') === null, '#7-6 JSONパース失敗時はnullを返す(例外を投げない)');
  assert(deserializeTimelineJson('null') === null, '#7-6 nullの場合はnullを返す');

  // subs内の型不正は拒否(session.jsのisValidClipsを共有していることの確認)
  assert(
    deserializeTimelineJson(JSON.stringify({
      version: 3,
      subs: [{ text: 'x', durMs: 'not-a-number', edited: false, delim: '', translation: '', translationStale: false }],
      cps: 12, style: { fontSize: 55, calibration: 1 }
    })) === null,
    '#7-6 subs内の型不正はnullを返す'
  );
})();

console.log('');
console.log(passCount + ' passed, ' + failCount + ' failed');
if (failCount > 0) process.exit(1);
