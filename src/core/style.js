// 描画定数とスケール関数(9:16実寸プレビュー・行数判定)

// ---- 9:16実寸プレビュー用の定数(1080x1920キャンバス基準) ----
export var CANVAS_BASE_WIDTH = 1080;
export var SAFE_MARGIN_LEFT_1080 = 90;
export var SAFE_MARGIN_RIGHT_1080 = 90;
export var SAFE_MARGIN_TOP_1080 = 100;
export var SAFE_MARGIN_BOTTOM_1080 = 300;
export var SAFE_WIDTH_1080 = CANVAS_BASE_WIDTH - SAFE_MARGIN_LEFT_1080 - SAFE_MARGIN_RIGHT_1080; // 900
export var SUBTITLE_BASELINE_FROM_BOTTOM = 390; // 実機の実測値。映像下端からのオフセット(1080px空間)
export var STROKE_WIDTH_AT_1080 = 6; // 縁取り幅(1080px空間)。paint-order:stroke fill前提
export var FONT_SIZE_DEFAULT = 55;
export var CALIBRATION_DEFAULT = 1.0;
export var CALIBRATION_MIN = 0.80;
export var CALIBRATION_MAX = 1.30;
export var CALIBRATION_STEP = 0.01;

export function clampCalibration(v) {
  return Math.max(CALIBRATION_MIN, Math.min(CALIBRATION_MAX, v));
}
// 実測(canvas measureText)に使うフォントサイズ。1080px空間のまま、プレビューの縮尺は掛けない。
export function measurementFontSize(fontSize, calibration) {
  return fontSize * calibration;
}
// プレビュー枠(縮小表示)用のCSSフォントサイズ。
export function previewFontSizePx(fontSize, calibration, previewWidthPx) {
  return fontSize * calibration * (previewWidthPx / CANVAS_BASE_WIDTH);
}
export function previewStrokeWidthPx(previewWidthPx) {
  return STROKE_WIDTH_AT_1080 * (previewWidthPx / CANVAS_BASE_WIDTH);
}
export function previewBaselineOffsetPx(previewWidthPx) {
  return SUBTITLE_BASELINE_FROM_BOTTOM * (previewWidthPx / CANVAS_BASE_WIDTH);
}
export function previewSafeMargins(previewWidthPx) {
  var scale = previewWidthPx / CANVAS_BASE_WIDTH;
  return {
    left: SAFE_MARGIN_LEFT_1080 * scale,
    right: SAFE_MARGIN_RIGHT_1080 * scale,
    top: SAFE_MARGIN_TOP_1080 * scale,
    bottom: SAFE_MARGIN_BOTTOM_1080 * scale
  };
}

// ---- 行数判定(3値): 1行 / 2行推奨 / 溢れ ----
// measureFn(text)=>px は呼び出し側から注入する(DOM/canvasに依存させずNodeでテスト可能にするため)。
// 実アプリでは canvas measureText の結果に STROKE_WIDTH_AT_1080 を加算したものを渡す。
export function findBestSplit(text, measureFn) {
  var chars = Array.from(text);
  var spaceIndices = [];
  for (var i = 0; i < chars.length; i++) {
    if (chars[i] === ' ') spaceIndices.push(i);
  }
  if (spaceIndices.length === 0) return null;
  var mid = chars.length / 2;
  var best = null;
  for (var k = 0; k < spaceIndices.length; k++) {
    var idx = spaceIndices[k];
    var left = chars.slice(0, idx).join('');
    var right = chars.slice(idx + 1).join('');
    var lw = measureFn(left);
    var rw = measureFn(right);
    var diff = Math.abs(lw - rw);
    var distFromMid = Math.abs(idx - mid);
    if (best === null || diff < best.diff || (diff === best.diff && distFromMid < best.distFromMid)) {
      best = { left: left, right: right, leftWidth: lw, rightWidth: rw, diff: diff, distFromMid: distFromMid };
    }
  }
  return best;
}

// 既に改行を含む(手動2行)場合は行ごとにそのまま測る。含まない場合は
// 単語境界での自動分割を試み、最長行が安全幅に収まるかで判定する。
export function judgeLineCount(text, safeWidthPx, measureFn) {
  var lines = text.split('\n');
  if (lines.length === 1) {
    var w = measureFn(lines[0]);
    if (w <= safeWidthPx) return { level: 'one-line', maxWidth: w };
    var split = findBestSplit(lines[0], measureFn);
    if (!split) return { level: 'overflow', maxWidth: w };
    var maxW = Math.max(split.leftWidth, split.rightWidth);
    return { level: maxW <= safeWidthPx ? 'two-line' : 'overflow', maxWidth: maxW, split: split };
  }
  var widths = lines.map(measureFn);
  var maxWidth = Math.max.apply(null, widths);
  if (lines.length > 2 || maxWidth > safeWidthPx) return { level: 'overflow', maxWidth: maxWidth };
  return { level: 'two-line', maxWidth: maxWidth };
}

// 編集モーダルの「自動で2行に分割」「1行に戻す」。どちらも尺(durMs)には影響しない。
export function autoSplitToTwoLines(text, measureFn) {
  if (text.indexOf('\n') !== -1) return text;
  var split = findBestSplit(text, measureFn);
  if (!split) return text;
  return split.left + '\n' + split.right;
}
export function collapseToOneLine(text) {
  return text.replace(/\n/g, ' ');
}
