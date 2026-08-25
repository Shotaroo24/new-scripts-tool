// src/core/* を直接importして回帰テストする。
//
// 実行方法: node tests/logic.test.js

import { segmentManuscript, buildCues } from '../src/core/segment.js';
import { formatSrtTime, formatTotalDuration, formatClock, MIN_DUR_MS, computeStartsMs, totalDurationMs, clipAt, ZOOM_LEVELS, msToPx, pxToMs, pickTickIntervalSec, clampZoomIndex } from '../src/core/time.js';
import { buildSrt, snapCuesToFrameGrid, applyOverlap, FRAME_FPS } from '../src/core/srt.js';
import {
  subsFromSegments, setClipDuration, trimClipAtHead, extendClipToHead, splitClipAtHead, mergeClipAt, deleteClipAt,
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
  isValidSessionData, serializeSession, deserializeSession, migrateV4ToV5
} from '../src/core/session.js';
import { isEditableTarget, resolveShortcutAction } from '../src/core/shortcuts.js';

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

// N: ヘッドが乗っているクリップをヘッド位置で2つに分割する
// #N1: 開始1000ms・尺2000ms(終端3000ms)のクリップをヘッド1800msで分割 -> 尺800ms/1200msの2クリップになる
(function () {
  var subs = makeSubs([1000, 2000, 1500]); // index1: 開始1000ms, 終端3000ms
  var result = splitClipAtHead(subs, 1, 1800);
  assert(result.ok, '#N1 分割が成功する');
  assert(result.subs.length === 4, '#N1 クリップ件数が1件増える -> ' + result.subs.length);
  assert(result.subs[1].durMs === 800, '#N1 前半の尺が800msになる -> ' + result.subs[1].durMs);
  assert(result.subs[2].durMs === 1200, '#N1 後半の尺が1200msになる -> ' + result.subs[2].durMs);
  assert(result.subs[1].text === subs[1].text && result.subs[2].text === subs[1].text, '#N1 テキストは両方に複製される(元クリップと同一)');
  assert(result.subs[1].edited === true && result.subs[2].edited === true, '#N1 分割後の両クリップはedited:trueになる');
  var starts = computeStartsMs(result.subs);
  assert(starts[3] === 3000, '#N1 後続クリップの開始時刻は変わらない(合計尺は不変) -> ' + starts[3]);
})();

// #N2: 分割後どちらかが最小尺(300ms)未満になる位置を指定した場合は拒否せず、
// 有効範囲(クリップ開始+300ms 〜 終了-300ms)内の最も近い位置へスナップする
(function () {
  var subs = makeSubs([1000, 2000, 1500]); // index1: 開始1000ms, 終端3000ms
  var result = splitClipAtHead(subs, 1, 1200); // 前半200ms < 300ms -> 300msへスナップ
  assert(result.ok, '#N2 前半が300ms未満になる位置でも拒否されずスナップして成功する');
  assert(result.subs[1].durMs === 300, '#N2 前半は最小尺300msにスナップされる -> ' + result.subs[1].durMs);
  assert(result.subs[2].durMs === 1700, '#N2 後半は残り1700msになる -> ' + result.subs[2].durMs);
  var result2 = splitClipAtHead(subs, 1, 2800); // 後半200ms < 300ms -> 300msへスナップ
  assert(result2.ok, '#N2 後半が300ms未満になる位置でも拒否されずスナップして成功する');
  assert(result2.subs[1].durMs === 1700, '#N2 前半は残り1700msになる -> ' + result2.subs[1].durMs);
  assert(result2.subs[2].durMs === 300, '#N2 後半は最小尺300msにスナップされる -> ' + result2.subs[2].durMs);
})();

// #N3: クリップ長が最小尺の2倍(600ms)未満の場合は理論上分割不可能なため拒否され状態不変
(function () {
  var subs = makeSubs([1000, 500, 1500]); // index1: 尺500ms(600ms未満)
  var result = splitClipAtHead(subs, 1, 1250); // ちょうど中間でも600ms未満なので不可能
  assert(result.ok === false, '#N3 600ms未満のクリップは分割できず拒否される');
  assert(result.subs === subs, '#N3 拒否時は元の配列そのままが返る(状態不変)');
})();

// D: 選択中のクリップの終端を再生ヘッドまで伸ばす(トリムのヘッド追従版・伸ばす方向のみ)
// #D1: 開始1000ms・尺2000ms(終端3000ms)のクリップをヘッド4200msまで伸ばす -> 尺3200ms、リップルで後続の開始が後ろへずれる
(function () {
  var subs = makeSubs([1000, 2000, 1500]); // index1: 開始1000ms, 終端3000ms
  var result = extendClipToHead(subs, 1, 4200);
  assert(result.ok, '#D1 伸ばす操作が成功する');
  assert(result.subs[1].durMs === 3200, '#D1 尺が3200msになる -> ' + result.subs[1].durMs);
  assert(result.subs[1].edited === true, '#D1 伸ばした後のクリップはedited:trueになる');
  var starts = computeStartsMs(result.subs);
  assert(starts[2] === 4200, '#D1 リップルで後続クリップの開始がヘッド位置(4200ms)まで後ろにずれる -> ' + starts[2]);
  assert(result.subs[1].text === subs[1].text, '#D1 テキストは変更されない');
})();

// #D2: ヘッドが選択クリップの終端と同じ(3000ms)場合は伸ばせない(拒否・状態不変)
(function () {
  var subs = makeSubs([1000, 2000, 1500]); // index1の終端は3000ms
  var result = extendClipToHead(subs, 1, 3000);
  assert(result.ok === false, '#D2 ヘッドが終端と同じ場合は拒否される(伸びない)');
  assert(result.subs === subs, '#D2 拒否時は元の配列そのままが返る(状態不変)');
})();

// #D3: ヘッドが選択クリップの終端より前(2400ms < 3000ms)の場合も伸ばせない(縮める方向には使えない)
(function () {
  var subs = makeSubs([1000, 2000, 1500]);
  var result = extendClipToHead(subs, 1, 2400);
  assert(result.ok === false, '#D3 ヘッドが終端より前の場合は拒否される(トリムとは違い縮められない)');
  assert(result.subs === subs, '#D3 拒否時は元の配列そのままが返る(状態不変)');
})();

// #D4: 最終クリップも伸ばせる(次のクリップが無いため単純に総尺が伸びるだけ)
(function () {
  var subs = makeSubs([1000, 2000, 1500]); // index2: 開始3000ms, 終端4500ms
  var result = extendClipToHead(subs, 2, 5000);
  assert(result.ok, '#D4 最終クリップも伸ばせる');
  assert(result.subs[2].durMs === 2000, '#D4 尺が2000msになる -> ' + result.subs[2].durMs);
  assert(totalDurationMs(result.subs) === 5000, '#D4 総尺がヘッド位置(5000ms)になる');
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

// --- 修正3: 2行分割のSRT反映の検証(修正依頼 §3) ---

// テスト1: 2行クリップ -> SRT文字列に改行が含まれる
(function () {
  var subs = [
    { text: 'السطر الأول\nالسطر الثاني', durMs: 2000, edited: false, delim: '', translation: '', translationStale: false }
  ];
  var srt = buildSrt(subsToCues(subs), false);
  assert(srt.indexOf('السطر الأول\nالسطر الثاني') !== -1, '#fix3-1 2行クリップはSRT内で改行を保持する -> ' + JSON.stringify(srt));
})();

// テスト2: 1行クリップ(「1行に戻す」後を想定) -> 改行が含まれない
(function () {
  var subs = [
    { text: 'السطر الأول السطر الثاني', durMs: 2000, edited: false, delim: '', translation: '', translationStale: false }
  ];
  var srt = buildSrt(subsToCues(subs), false);
  var cueBlock = srt.split('\n\n')[0];
  assert(cueBlock.split('\n').length === 3, '#fix3-2 1行クリップのcueブロックは番号行+タイムコード行+本文1行のみ -> ' + JSON.stringify(cueBlock));
})();

// テスト3: 1行/2行混在の複数クリップで、通し番号とタイムコードが崩れない
(function () {
  var subs = [
    { text: 'واحد', durMs: 1000, edited: false, delim: '', translation: '', translationStale: false },
    { text: 'اثنان\nثلاثة', durMs: 1500, edited: false, delim: '', translation: '', translationStale: false },
    { text: 'أربعة', durMs: 800, edited: false, delim: '', translation: '', translationStale: false }
  ];
  var cues = subsToCues(subs);
  assert(cues.map(function (c) { return c.index; }).join(',') === '1,2,3', '#fix3-3 混在時も通し番号が1,2,3のまま');
  assert(cues[0].startMs === 0 && cues[0].endMs === 1000, '#fix3-3 1番目のタイムコードが正しい');
  assert(cues[1].startMs === 1000 && cues[1].endMs === 2500, '#fix3-3 2行クリップを挟んでも2番目のタイムコードが正しい(ギャップなし)');
  assert(cues[2].startMs === 2500 && cues[2].endMs === 3300, '#fix3-3 3番目のタイムコードが正しい(ギャップなし)');
  var srt = buildSrt(cues, false);
  assert(srt.indexOf('اثنان\nثلاثة') !== -1, '#fix3-3 混在時も2行クリップの改行が保持される');
})();

// テスト4: BOM有り・無しの両方で改行・番号・タイムコードが壊れない
(function () {
  var subs = [
    { text: 'واحد', durMs: 1000, edited: false, delim: '', translation: '', translationStale: false },
    { text: 'اثنان\nثلاثة', durMs: 1500, edited: false, delim: '', translation: '', translationStale: false }
  ];
  var cues = subsToCues(subs);
  var srtNoBom = buildSrt(cues, false);
  var srtWithBom = buildSrt(cues, true);
  assert(srtWithBom.charCodeAt(0) === 0xfeff, '#fix3-4 BOM有りは先頭にU+FEFFが付く');
  assert(srtWithBom.slice(1) === srtNoBom, '#fix3-4 BOM有り無しでBOM以外(改行・番号・タイムコード)は完全一致する');
  assert(srtWithBom.indexOf('اثنان\nثلاثة') !== -1, '#fix3-4 BOM有りでも2行クリップの改行が保持される');
})();

// テスト5: localStorage(v5)の保存/復元を挟んでも2行状態(本文中の改行)が保持される
(function () {
  var state = {
    manuscript: 'مرحبا', cps: 12, bom: false, mode: 'edit',
    clips: [
      { text: 'السطر الأول\nالسطر الثاني', durMs: 2000, delim: '', edited: true, translation: '', translationStale: false }
    ],
    zoomIndex: 3, headTimeMs: 0, calibration: 1, fontSize: 55
  };
  var raw = serializeSession(state);
  var restored = deserializeSession(raw);
  assert(restored !== null, '#fix3-5 保存データが復元できる');
  assert(restored.clips[0].text === 'السطر الأول\nالسطر الثاني', '#fix3-5 復元後も本文中の改行(2行状態)が保持される');
  var srt = buildSrt(subsToCues(restored.clips), false);
  assert(srt.indexOf('السطر الأول\nالسطر الثاني') !== -1, '#fix3-5 復元後のクリップからSRTを生成しても2行のまま出力される');
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

// --- 修正: 「番号付きでコピー」「英訳を貼り付け」をタイムライン往復なしで使う ---
// (docs/srtgen-translation-roundtrip-spec.md §4.2)

// #copy1: subs未生成(タイムライン未生成)の状態でも、原稿をその場でsegmentManuscriptした
// 結果からformatNumberedClips相当のコピー用テキストが正しく生成できる(doCopyNumberedの
// フォールバック経路と同じ組み立て方: {lines,delim}[] -> {text: lines.join('\n')}[])
(function () {
  var text = 'مرحبا، كيف حالك؟ أنا بخير جدا';
  var segments = segmentManuscript(text);
  assert(segments.length === 3, '#copy1 前提: 3セグメントに分割される');

  var source = segments.map(function (s) { return { text: s.lines.join('\n') }; });
  var formatted = formatNumberedClips(source);
  var lines = formatted.split('\n');
  assert(lines.length === 3, '#copy1 subsが無くてもsegments由来で3行の番号付きテキストが生成される');

  var reparsed = parseNumberedTranslation(formatted, 3);
  assert(reparsed.entries.get(1) === 'مرحبا', '#copy1 #1がsegments[0]の本文と一致 -> "' + reparsed.entries.get(1) + '"');
  assert(reparsed.entries.get(2) === 'كيف حالك؟', '#copy1 #2がsegments[1]の本文と一致 -> "' + reparsed.entries.get(2) + '"');
  assert(reparsed.entries.get(3) === 'أنا بخير جدا', '#copy1 #3がsegments[2]の本文と一致 -> "' + reparsed.entries.get(3) + '"');
})();

// #copy2: subsFromSegments直後にreconstructManuscriptした結果を再度segmentManuscriptすると
// 元と同じ分割になる(正規化書き戻し後、UI側のsubsMatchesManuscript相当の判定
// [subs.length===segmentCount && textEquals(reconstructManuscript(subs), text)] がtrueになることの根拠)
(function () {
  var text = 'مرحبا، كيف حالك؟ أنا بخير جدا اليوم شكرا لك';
  var segments = segmentManuscript(text);
  var subs = subsFromSegments(segments, 12);

  var normalized = reconstructManuscript(subs); // openPasteModal/enterEditModeが書き戻す内容と同じ
  var reparsedSegments = segmentManuscript(normalized);
  var reparsedSubs = subsFromSegments(reparsedSegments, 12);

  assert(reparsedSubs.length === subs.length, '#copy2 正規化書き戻し後の再分割でもクリップ数が一致する');
  assert(textEquals(reconstructManuscript(subs), normalized) === true,
    '#copy2 書き戻し直後のtextareaと reconstructManuscript(subs) は完全一致する(subsMatchesManuscriptがtrueになる)');
  assert(subs.length === reparsedSegments.length,
    '#copy2 subs.length === segmentManuscript(normalized).length も成立する(件数一致条件)');
})();

// #copy3: stale状態(subsはあるが現原稿と不一致)からの再構築で、
// 新しいsubsのtranslation/translationStaleが初期状態にリセットされる
// (openPasteModalのc経路: 確認ダイアログ後にrebuildSubsFromManuscript相当の処理を行う想定)
(function () {
  var oldText = 'مرحبا، كيف حالك؟';
  var oldSegments = segmentManuscript(oldText);
  var staleSubs = subsFromSegments(oldSegments, 12).map(function (s, i) {
    return Object.assign({}, s, { translation: 'old translation ' + i, translationStale: false });
  });
  assert(staleSubs[0].translation === 'old translation 0', '#copy3 前提: 古いsubsには訳文が入っている');

  // 原稿が編集され、staleSubsとは一致しない新しい原稿になった
  var newText = 'مرحبا، كيف حالك؟ أنا بخير جدا اليوم';
  assert(textEquals(reconstructManuscript(staleSubs), newText) === false, '#copy3 前提: 古いsubsは新しい原稿と不一致(stale)');

  // 再構築(rebuildSubsFromManuscript相当): 新しい原稿から作り直す
  var newSegments = segmentManuscript(newText);
  var rebuiltSubs = subsFromSegments(newSegments, 12);

  rebuiltSubs.forEach(function (s, i) {
    assert(s.translation === '', '#copy3 再構築後のクリップ' + i + 'はtranslationが空文字にリセットされる');
    assert(s.translationStale === false, '#copy3 再構築後のクリップ' + i + 'はtranslationStaleがfalseにリセットされる');
  });
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

// --- SRT出力のフレームスナップ(30fps)・オーバーラップ+1fフォールバック ---

// #snap1: スナップ後、全隣接キューでend_ms === next.start_ms が成立する
(function () {
  var subs = makeSubs([137, 241, 89, 733, 412, 1006, 58]);
  var cues = subsToCues(subs);
  var snapped = snapCuesToFrameGrid(cues);

  var ok = true;
  for (var i = 1; i < snapped.length; i++) {
    if (snapped[i - 1].endMs !== snapped[i].startMs) { ok = false; break; }
  }
  assert(ok, '#snap1 スナップ後は全隣接キューでend_ms === next.start_ms が成立する -> ' + JSON.stringify(snapped.map(function (c) { return [c.startMs, c.endMs]; })));
})();

// #snap2: スナップ後の全時刻がround(ms*30/1000)*1000/30と1ms未満の誤差で一致する(フレームグリッド上にある)
(function () {
  var subs = makeSubs([137, 241, 89, 733, 412, 1006, 58]);
  var cues = subsToCues(subs);
  var snapped = snapCuesToFrameGrid(cues);

  var times = [];
  snapped.forEach(function (c) { times.push(c.startMs, c.endMs); });
  times.forEach(function (ms) {
    var onGrid = Math.round((ms / 1000) * FRAME_FPS) * 1000 / FRAME_FPS;
    assert(Math.abs(ms - onGrid) < 1, '#snap2 ' + ms + 'msはフレームグリッド上にある(理論値=' + onGrid + ')');
  });
})();

// #snap3: 極端に短いクリップが連続するエッジケースでも、単調性と最低1フレーム長が保たれる
// (元の境界を素直にround(ms*30/1000)すると同一フレームに潰れて長さ0以下のキューが生じうる区間)
(function () {
  var subs = makeSubs([10, 10, 10, 10, 10]);
  var cues = subsToCues(subs);
  var snapped = snapCuesToFrameGrid(cues);

  var minFrameMs = Math.floor(1000 / FRAME_FPS); // 33ms(30fpsの1フレームは33msか34ms)
  var ok = true;
  for (var i = 0; i < snapped.length; i++) {
    if (snapped[i].endMs <= snapped[i].startMs || (snapped[i].endMs - snapped[i].startMs) < minFrameMs) { ok = false; break; }
  }
  assert(ok, '#snap3 極端に短いクリップ連続でも各キューが最低1フレーム長を保つ -> ' + JSON.stringify(snapped.map(function (c) { return [c.startMs, c.endMs]; })));

  var monotonic = true;
  for (var j = 1; j < snapped.length; j++) {
    if (snapped[j].startMs <= snapped[j - 1].startMs) { monotonic = false; break; }
  }
  assert(monotonic, '#snap3 境界が単調増加を保つ(削除・結合はせず後続を押し出す) -> ' + JSON.stringify(snapped.map(function (c) { return c.startMs; })));
  assert(snapped.length === subs.length, '#snap3 キューの件数は変わらない(削除・結合はしない)');
})();

// #snap4: オーバーラップONの出力でend_ms === next.start_ms + 33 になる(最終キューは対象外)
(function () {
  var subs = makeSubs([1000, 2000, 1500]);
  var cues = subsToCues(subs);
  var snapped = snapCuesToFrameGrid(cues);
  var overlapped = applyOverlap(snapped);

  for (var i = 0; i < overlapped.length - 1; i++) {
    assert(
      overlapped[i].endMs === overlapped[i + 1].startMs + 33,
      '#snap4 最終キュー以外はend_msがnext.start_ms + 33になる -> cue' + i + ' end=' + overlapped[i].endMs + ', next.start=' + overlapped[i + 1].startMs
    );
  }
  var last = overlapped.length - 1;
  assert(overlapped[last].endMs === snapped[last].endMs, '#snap4 最終キューのend_msはオーバーラップの対象外(変更されない)');
})();

// --- タイムライン編集モードのキーボードショートカット(src/core/shortcuts.js) ---

// isEditableTarget: input/textarea/select/contentEditableにフォーカス中はショートカットを止める判定
(function () {
  assert(isEditableTarget({ tagName: 'INPUT' }) === true, '#kbd1 INPUTフォーカス中はtrue');
  assert(isEditableTarget({ tagName: 'TEXTAREA' }) === true, '#kbd1 TEXTAREAフォーカス中はtrue');
  assert(isEditableTarget({ tagName: 'SELECT' }) === true, '#kbd1 SELECTフォーカス中はtrue');
  assert(isEditableTarget({ tagName: 'DIV', isContentEditable: true }) === true, '#kbd1 contentEditable要素はtrue');
  assert(isEditableTarget({ tagName: 'DIV' }) === false, '#kbd1 通常のDIVはfalse(ショートカット有効)');
  assert(isEditableTarget({ tagName: 'BUTTON' }) === false, '#kbd1 BUTTONはfalse(ショートカット有効)');
  assert(isEditableTarget(null) === false, '#kbd1 targetがnullでもfalse(例外を投げない)');
})();

// resolveShortcutAction: Backspace/Deleteは'delete'に解決される(選択中クリップの削除)
(function () {
  assert(resolveShortcutAction('Backspace') === 'delete', '#kbd2 Backspaceは削除アクションに解決される');
  assert(resolveShortcutAction('Delete') === 'delete', '#kbd2 Deleteは削除アクションに解決される');
})();

// resolveShortcutAction: d/Dは'extendToHead'に解決される(選択中クリップの終端をヘッドまで伸ばす、旧E)
(function () {
  assert(resolveShortcutAction('d') === 'extendToHead', '#kbd3 dキーは延長アクションに解決される');
  assert(resolveShortcutAction('D') === 'extendToHead', '#kbd3 Dキー(大文字)も延長アクションに解決される');
  assert(resolveShortcutAction('e') === null, '#kbd3 廃止されたeキーは何にも解決されない');
  assert(resolveShortcutAction('E') === null, '#kbd3 廃止されたEキー(大文字)も何にも解決されない');
})();

// resolveShortcutAction: n/Nは'split'に解決される(ヘッドが乗っているクリップをヘッド位置で分割)
(function () {
  assert(resolveShortcutAction('n') === 'split', '#kbd5 nキーは分割アクションに解決される');
  assert(resolveShortcutAction('N') === 'split', '#kbd5 Nキー(大文字)も分割アクションに解決される');
})();

// resolveShortcutAction: 他の既存ショートカットの割り当ては変更されない(回帰確認)
(function () {
  assert(resolveShortcutAction('s') === 'trim', '#kbd4 sキーはトリムのまま');
  assert(resolveShortcutAction('m') === 'merge', '#kbd4 mキーは結合のまま');
  assert(resolveShortcutAction('l') === 'cyclePlaybackRate', '#kbd4 lキーは再生速度切替のまま');
  assert(resolveShortcutAction('x') === 'zoomIn', '#kbd4 xキーはズームインのまま');
  assert(resolveShortcutAction('z') === 'zoomOut', '#kbd4 zキーはズームアウトのまま(Ctrl+Zとの区別は呼び出し側の責務)');
  assert(resolveShortcutAction('a') === null, '#kbd4 未割り当てキーはnull');
})();

console.log('');
console.log(passCount + ' passed, ' + failCount + ' failed');
if (failCount > 0) process.exit(1);
