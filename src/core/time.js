// ms整数計算・累積導出・clipAt・フォーマッタ

export var MIN_DUR_MS = 300;
export var ZOOM_LEVELS = [20, 35, 50, 75, 100, 150, 200, 300, 400];
export var DEFAULT_ZOOM_INDEX = ZOOM_LEVELS.indexOf(75); // 現行(80px/sec)に最も近い段

export function pad(num, len) {
  return String(num).padStart(len, '0');
}

export function formatSrtTime(ms) {
  ms = Math.max(0, Math.round(ms));
  var h = Math.floor(ms / 3600000); ms -= h * 3600000;
  var m = Math.floor(ms / 60000); ms -= m * 60000;
  var s = Math.floor(ms / 1000); ms -= s * 1000;
  return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2) + ',' + pad(ms, 3);
}

export function formatTotalDuration(ms) {
  ms = Math.max(0, Math.round(ms));
  var minutes = Math.floor(ms / 60000);
  var secs = (ms % 60000) / 1000;
  var secsStr = secs.toFixed(1);
  if (secsStr.indexOf('.') === 1) secsStr = '0' + secsStr;
  return pad(minutes, 2) + ':' + secsStr;
}

// M:SS.d 形式(0.1秒単位)。表示専用でmsを保持したまま整数演算で丸める。
export function formatClock(ms) {
  ms = Math.max(0, Math.round(ms));
  var totalTenths = Math.round(ms / 100);
  var m = Math.floor(totalTenths / 600);
  var rem = totalTenths - m * 600;
  var s = Math.floor(rem / 10);
  var d = rem % 10;
  return m + ':' + pad(s, 2) + '.' + d;
}

export function clampDurMs(ms) {
  return Math.max(MIN_DUR_MS, Math.round(ms));
}

// 各クリップの開始時刻をミリ秒の整数配列で返す(累積誤差なし)。
export function computeStartsMs(subs) {
  var starts = [];
  var acc = 0;
  for (var i = 0; i < subs.length; i++) {
    starts.push(acc);
    acc += subs[i].durMs;
  }
  return starts;
}
export function totalDurationMs(subs) {
  var acc = 0;
  for (var i = 0; i < subs.length; i++) acc += subs[i].durMs;
  return acc;
}

// 時刻 tMs(連続値でも可)が属するクリップのindexを返す。整数msに丸めてから
// 整数のみで比較するため、境界判定に浮動小数の誤差が入らない。
export function clipAt(subs, tMs) {
  var n = subs.length;
  if (n === 0) return -1;
  var starts = computeStartsMs(subs);
  var total = totalDurationMs(subs);
  var t = Math.round(tMs);
  if (t <= 0) return 0;
  if (t >= total) return n - 1;
  for (var i = 0; i < n; i++) {
    var end = (i < n - 1) ? starts[i + 1] : total;
    if (t < end) return i;
  }
  return n - 1;
}

// ---- ズーム(表示倍率)。尺・時刻・SRT出力には一切影響しない、純粋に表示用の変換 ----
export function clampZoomIndex(index) {
  return Math.max(0, Math.min(ZOOM_LEVELS.length - 1, index));
}
export function msToPx(ms, pxPerSec) {
  return (ms / 1000) * pxPerSec;
}
export function pxToMs(px, pxPerSec) {
  return (px / pxPerSec) * 1000;
}
// ルーラーの目盛り間隔(秒)を、ラベルが重ならない最小間隔から選ぶ。
var TICK_CANDIDATES_SEC = [0.1, 0.5, 1, 2, 5];
var MIN_TICK_LABEL_SPACING_PX = 40;
export function pickTickIntervalSec(pxPerSec) {
  for (var i = 0; i < TICK_CANDIDATES_SEC.length; i++) {
    if (TICK_CANDIDATES_SEC[i] * pxPerSec >= MIN_TICK_LABEL_SPACING_PX) return TICK_CANDIDATES_SEC[i];
  }
  return TICK_CANDIDATES_SEC[TICK_CANDIDATES_SEC.length - 1];
}
