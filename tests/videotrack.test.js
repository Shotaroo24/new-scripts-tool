// src/core/videotrack.js の回帰テスト(仕様書 docs/srtgen-video-spec.md §7-1〜4)。
//
// 実行方法: node tests/videotrack.test.js

import { MIN_DUR_MS, computeStartsMs, totalDurationMs } from '../src/core/time.js';
import {
  initialSegments, outputToSrc, rippleSubsForRange,
  splitSegmentAt, deleteSegmentRipple, resizeSegmentOut, resizeSegmentIn
} from '../src/core/videotrack.js';
import { pushHistory, popHistory } from '../src/core/subs.js';

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

function makeSubs(dursMs) {
  return dursMs.map(function (d, i) {
    return { text: 'text' + i, durMs: d, edited: false, delim: '', en: '' };
  });
}

function isIntegerMs(v) {
  return typeof v === 'number' && isFinite(v) && Math.round(v) === v;
}

// --- §7-1: 保存則 ---
// 任意の分割・削除・トリム列の後もΣdurMsと各区間のソース範囲が整合し、全値がms整数であること。
(function () {
  var masterDurationMs = 10000;
  var segments = initialSegments(masterDurationMs);
  assert(segments.length === 1 && segments[0].srcInMs === 0 && segments[0].durMs === 10000, '#1 マスター読み込み直後は単一区間[{srcInMs:0,durMs:master.durationMs}]');

  // 分割 -> トリム(右端) -> 分割 -> トリム(左端) という操作列
  var r1 = splitSegmentAt(segments, 0, 4000);
  assert(r1.ok, '#1 分割が成功する');
  segments = r1.segments;

  var r2 = resizeSegmentOut(segments, [], masterDurationMs, 0, 3000);
  assert(r2.ok, '#1 右端トリムが成功する');
  segments = r2.segments;

  var r3 = splitSegmentAt(segments, 1, 4000 + 2000);
  assert(r3.ok, '#1 2回目の分割が成功する');
  segments = r3.segments;

  var r4 = resizeSegmentIn(segments, [], 2, 4500);
  assert(r4.ok, '#1 左端トリムが成功する');
  segments = r4.segments;

  // 全区間が整数msであること
  var allIntegers = segments.every(function (s) { return isIntegerMs(s.srcInMs) && isIntegerMs(s.durMs); });
  assert(allIntegers, '#1 操作列の後も全区間のsrcInMs/durMsが整数ms -> ' + JSON.stringify(segments));

  // 各区間がソース範囲内(§2.1-2)
  var withinRange = segments.every(function (s) { return s.srcInMs >= 0 && s.srcInMs + s.durMs <= masterDurationMs; });
  assert(withinRange, '#1 各区間が0<=srcInMsかつsrcInMs+durMs<=master.durationMsを満たす -> ' + JSON.stringify(segments));

  // 各区間が最小尺MIN_DUR_MS以上(§2.1-4)
  var minDurOk = segments.every(function (s) { return s.durMs >= MIN_DUR_MS; });
  assert(minDurOk, '#1 各区間がMIN_DUR_MS以上 -> ' + JSON.stringify(segments));

  // 総尺Tは常にΣdurMsとして導出可能(別変数として保持しない、という設計の検証として合計を再計算)
  var total = totalDurationMs(segments);
  assert(isIntegerMs(total), '#1 総尺(Σ durMs)が整数ms -> ' + total);
})();

// ランダム風の操作列(決定的な固定シード相当)でも不変条件が壊れないことを追加確認する
(function () {
  var masterDurationMs = 20000;
  var segments = initialSegments(masterDurationMs);
  var ops = [
    function (s) { return splitSegmentAt(s, 0, 5000).segments; },
    function (s) { return splitSegmentAt(s, 1, 12000).segments; },
    function (s) { return resizeSegmentOut(s, [], masterDurationMs, 0, 4000).segments; },
    function (s) { return resizeSegmentIn(s, [], 1, 5500).segments; },
    function (s) { return deleteSegmentRipple(s, [], 2).segments; }
  ];
  ops.forEach(function (op) {
    segments = op(segments);
  });
  var allIntegers = segments.every(function (s) { return isIntegerMs(s.srcInMs) && isIntegerMs(s.durMs); });
  var withinRange = segments.every(function (s) { return s.srcInMs >= 0 && s.srcInMs + s.durMs <= masterDurationMs; });
  var minDurOk = segments.every(function (s) { return s.durMs >= MIN_DUR_MS; });
  assert(allIntegers, '#1b 複合操作列の後も全区間が整数ms -> ' + JSON.stringify(segments));
  assert(withinRange, '#1b 複合操作列の後も各区間がソース範囲内 -> ' + JSON.stringify(segments));
  assert(minDurOk, '#1b 複合操作列の後も各区間がMIN_DUR_MS以上 -> ' + JSON.stringify(segments));
  assert(segments.length >= 1, '#1b segmentsは常に1個以上');
})();

// --- §7-2: 分割の無害性 ---
// S直後のsegmentsが写像outputToSrcとして分割前と完全一致すること。
(function () {
  var segments = [{ srcInMs: 1000, durMs: 6000 }, { srcInMs: 9000, durMs: 3000 }];
  var total = totalDurationMs(segments);

  // 分割前の写像をサンプリング(境界含む)
  var sampleTs = [];
  for (var t = 0; t <= total; t += 137) sampleTs.push(t);
  var before = sampleTs.map(function (t) { return outputToSrc(segments, t); });

  var result = splitSegmentAt(segments, 0, 3500); // segment0(出力0-6000)の中間で分割
  assert(result.ok, '#2 分割が成功する');
  var after = sampleTs.map(function (t) { return outputToSrc(result.segments, t); });

  assert(JSON.stringify(after) === JSON.stringify(before), '#2 分割直後のoutputToSrc写像が分割前と完全一致する');

  // 分割後は2区間になり、srcInが連続する(映像が無変化であることの確認)
  assert(result.segments.length === 3, '#2 分割後は区間が1つ増える');
  assert(
    result.segments[0].srcInMs + result.segments[0].durMs === result.segments[1].srcInMs,
    '#2 分割で生じた2区間のsrcInが連続する(境目だけが入る)'
  );
})();

// --- §7-4: outputToSrc ---
// 区間境界の前後1ms・総尺ちょうど・総尺超えの各点で整数比較のみで正しい値/クランプを返すこと。
(function () {
  var segments = [{ srcInMs: 100, durMs: 1000 }, { srcInMs: 5000, durMs: 2000 }]; // 出力[0,1000) -> src[100,1100), 出力[1000,3000) -> src[5000,7000)
  var total = totalDurationMs(segments); // 3000

  assert(outputToSrc(segments, 999) === 1099, '#4 境界の1ms手前(999)はsegment0内 -> ' + outputToSrc(segments, 999));
  assert(outputToSrc(segments, 1000) === 5000, '#4 境界ちょうど(1000)はsegment1の先頭 -> ' + outputToSrc(segments, 1000));
  assert(outputToSrc(segments, 1001) === 5001, '#4 境界の1ms後(1001)はsegment1内 -> ' + outputToSrc(segments, 1001));

  assert(outputToSrc(segments, total) === 5000 + 2000, '#4 総尺ちょうどは最終区間の終端にクランプ -> ' + outputToSrc(segments, total));
  assert(outputToSrc(segments, total + 500) === 5000 + 2000, '#4 総尺超えは最終区間の終端にクランプ -> ' + outputToSrc(segments, total + 500));
  assert(outputToSrc(segments, -100) === 100, '#4 負の値はsegment0の先頭にクランプ -> ' + outputToSrc(segments, -100));
  assert(outputToSrc(segments, 0) === 100, '#4 ちょうど0はsegment0の先頭 -> ' + outputToSrc(segments, 0));
})();

// --- §7-3: 字幕連動リップル(§3.4の4規則) ---

// 規則1: 削除範囲より完全に前/後ろに位置する字幕はそのまま(累積導出で自動的にずれる)
(function () {
  var subs = makeSubs([1000, 1000, 1000, 1000]); // starts: 0,1000,2000,3000
  // 出力範囲[1000,2000)(=subs[1]と完全一致)を削除
  var result = rippleSubsForRange(subs, 1000, 2000);
  assert(result.length === 3, '#R1 完全一致した字幕1件が削除され3件になる');
  assert(result[0].text === 'text0' && result[0].durMs === 1000 && result[0].edited === false, '#R1 削除範囲より前の字幕はそのまま(text0)');
  assert(result[1].text === 'text2' && result[1].durMs === 1000 && result[1].edited === false, '#R1 削除範囲より後ろの字幕はそのまま(text2, editedもfalseのまま)');
  var starts = computeStartsMs(result);
  assert(starts[1] === 1000, '#R1 後ろの字幕は累積導出で自動的に1000msだけ前へずれる -> ' + starts[1]);
})();

// 規則2: 削除範囲と部分的に重なる字幕は、重なった長さをdurMsから減算しedited:trueになる
(function () {
  var subs = makeSubs([1000, 1000, 1000]); // starts: 0,1000,2000 / ends: 1000,2000,3000
  // 出力範囲[1500,2500)を削除 -> subs[1](1000-2000)は500ms(1500-2000)が重なる、subs[2](2000-3000)は500ms(2000-2500)が重なる
  var result = rippleSubsForRange(subs, 1500, 2500);
  assert(result.length === 3, '#R2 部分重なりでは字幕は削除されない(3件のまま)');
  assert(result[1].durMs === 500 && result[1].edited === true, '#R2 前半に重なった字幕はdurMsが500msに減算されedited:trueになる -> ' + JSON.stringify(result[1]));
  assert(result[2].durMs === 500 && result[2].edited === true, '#R2 後半に重なった字幕はdurMsが500msに減算されedited:trueになる -> ' + JSON.stringify(result[2]));
  assert(result[0].edited === false, '#R2 重ならない字幕はedited不変');
})();

// 規則2の境界一致ケース: aが字幕境界と一致
(function () {
  var subs = makeSubs([1000, 1000]); // starts: 0,1000 / ends: 1000,2000
  // a=1000(subs[1]の開始と一致)、b=1500 -> subs[1]の前半500msが重なる
  var result = rippleSubsForRange(subs, 1000, 1500);
  assert(result.length === 2, '#R2b 境界一致(a)でも字幕数は変化しない');
  assert(result[0].durMs === 1000 && result[0].edited === false, '#R2b aと境界一致する字幕(subs[0])は削除範囲の外なので不変');
  assert(result[1].durMs === 500 && result[1].edited === true, '#R2b aから始まる重なりが正しく減算される -> ' + result[1].durMs);
})();

// 規則2の境界一致ケース: bが字幕境界と一致
(function () {
  var subs = makeSubs([1000, 1000]); // starts: 0,1000 / ends: 1000,2000
  // a=500, b=1000(subs[0]の終端と一致) -> subs[0]の後半500msが重なる、subs[1]は重ならない(タッチのみ)
  var result = rippleSubsForRange(subs, 500, 1000);
  assert(result.length === 2, '#R2c 境界一致(b)でも字幕数は変化しない');
  assert(result[0].durMs === 500 && result[0].edited === true, '#R2c bで終わる重なりが正しく減算される -> ' + result[0].durMs);
  assert(result[1].durMs === 1000 && result[1].edited === false, '#R2c bと境界一致するだけの字幕(subs[1])は重ならない扱い(タッチのみ)');
})();

// 規則3: 削除範囲に完全に含まれる字幕は削除される(重なりがdurMs以上、1ms未満になるケース)
(function () {
  var subs = makeSubs([1000, 500, 1000]); // starts: 0,1000,1500 / ends: 1000,1500,2500
  // 出力範囲[800,1700)を削除 -> subs[1](1000-1500)は完全に含まれる、subs[0]/subs[2]は部分重なり
  var result = rippleSubsForRange(subs, 800, 1700);
  assert(result.length === 2, '#R3 完全に含まれた字幕(subs[1])が削除され2件になる');
  assert(result[0].durMs === 800 && result[0].edited === true, '#R3 前方部分重なりの字幕は減算される -> ' + result[0].durMs);
  assert(result[1].durMs === 800 && result[1].edited === true, '#R3 後方部分重なりの字幕は減算される -> ' + result[1].durMs);
})();

// 規則3の境界一致ケース: 削除範囲[a,b)が字幕の[start,end)と完全一致(ちょうど含まれる)
(function () {
  var subs = makeSubs([1000, 800, 1000]); // starts: 0,1000,1800
  var result = rippleSubsForRange(subs, 1000, 1800); // subs[1]の[1000,1800)とちょうど一致
  assert(result.length === 2, '#R3b 削除範囲と完全一致する字幕は削除される');
  assert(result[0].text === 'text0' && result[1].text === 'text2', '#R3b 前後の字幕は残る');
})();

// 規則4: 動画側の変更と字幕側の変更はUndo 1エントリとして一体で復元できる(両トラックのスナップショット)
(function () {
  // 前提: segmentsが1個のときはDeleteが拒否される(§2.1-1「segmentsは常に1個以上」の維持)
  var singleSegment = [{ srcInMs: 0, durMs: 3000 }];
  var rejected = deleteSegmentRipple(singleSegment, makeSubs([1000, 1000, 1000]), 0);
  assert(rejected.ok === false, '#R4前提 区間が1個しかない場合のDeleteは拒否される(segments>=1を維持)');

  var subs = makeSubs([1000, 1000, 1000]);
  var segments = [{ srcInMs: 0, durMs: 1500 }, { srcInMs: 5000, durMs: 1500 }]; // 出力[0,1500) / [1500,3000)
  var history = [];

  // 操作前の状態をひとつのスナップショットとして積む(pushHistory/popHistoryは任意のJSON化可能な値を扱える)
  history = pushHistory(history, { subs: subs, segments: segments });

  var result = deleteSegmentRipple(segments, subs, 1); // 出力[1500,3000)の区間を削除 -> 字幕[1000,2000)と[2000,3000)の一部が連動
  assert(result.ok, '#R4 複数区間があるDeleteは成功する');

  var restored = popHistory(history);
  assert(restored !== null, '#R4 popHistoryが直前のスナップショットを返す');
  assert(
    JSON.stringify(restored.subs.subs) === JSON.stringify(subs) && JSON.stringify(restored.subs.segments) === JSON.stringify(segments),
    '#R4 Undoでsubsとsegmentsの両方が操作前の状態に一体で復元される'
  );
  // 操作後の状態(復元前)がoperation前と異なることも確認(意味のある変化が起きていたことの確認)
  assert(
    JSON.stringify(result.subs) !== JSON.stringify(subs) || JSON.stringify(result.segments) !== JSON.stringify(segments),
    '#R4 操作後は状態が変化している(復元対象があることの確認)'
  );
})();

console.log('');
console.log(passCount + ' passed, ' + failCount + ' failed');
if (failCount > 0) process.exit(1);
