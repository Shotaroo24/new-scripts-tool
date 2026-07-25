// Canvas合成プレビュー(§4.1-4.2)。マスター読み込み時のみ使用する。
//
// 字幕の描画パラメータは既存関数(previewFontSizePx/previewStrokeWidthPx/
// previewBaselineOffsetPx)をそのまま使う。キャンバスの内部解像度を
// CANVAS_BASE_WIDTH(1080)幅に固定しているため、previewWidthPxに1080を渡すと
// 縮尺1倍(measurementFontSize相当)の値が得られる。書き出し(Phase2)でも
// 同じ関数・同じ1080x1920空間を使う想定で、描画関数を共有できるようにしている。

import {
  CANVAS_BASE_WIDTH,
  previewFontSizePx, previewStrokeWidthPx, previewBaselineOffsetPx
} from '../core/style.js';

export var CANVAS_HEIGHT = Math.round(CANVAS_BASE_WIDTH / 9 * 16); // 1920 (9:16)
var LINE_HEIGHT_FACTOR = 1.3; // 既存CSSのline-height:1.3を踏襲

var previewCanvas = document.getElementById('previewCanvas');
var ctx = previewCanvas.getContext('2d');

function ensureCanvasSize() {
  if (previewCanvas.width !== CANVAS_BASE_WIDTH || previewCanvas.height !== CANVAS_HEIGHT) {
    previewCanvas.width = CANVAS_BASE_WIDTH;
    previewCanvas.height = CANVAS_HEIGHT;
  }
}

// cover fit: 短辺をキャンバスに合わせ、はみ出す部分は中央クロップする。
function drawVideoCover(videoEl) {
  var vw = videoEl.videoWidth;
  var vh = videoEl.videoHeight;
  if (!vw || !vh) {
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, CANVAS_BASE_WIDTH, CANVAS_HEIGHT);
    return;
  }
  var scale = Math.max(CANVAS_BASE_WIDTH / vw, CANVAS_HEIGHT / vh);
  var dw = vw * scale;
  var dh = vh * scale;
  var dx = (CANVAS_BASE_WIDTH - dw) / 2;
  var dy = (CANVAS_HEIGHT - dh) / 2;
  ctx.drawImage(videoEl, dx, dy, dw, dh);
}

// strokeText -> fillTextの順(paint-order: stroke fill相当)で、下の行から積み上げて描画する。
// ctx・canvasWidth・canvasHeightを引数で受け取ることで、プレビュー(previewCanvas)と
// 書き出し(src/export/mp4.js が持つオフスクリーンcanvas)の両方から同一実装を共有できる(§5.3)。
export function drawSubtitleText(ctx, text, fontSize, calibration, canvasWidth, canvasHeight) {
  if (!text) return;
  var lines = text.split('\n');
  var fontPx = previewFontSizePx(fontSize, calibration, canvasWidth);
  var strokePx = previewStrokeWidthPx(canvasWidth);
  var baselinePx = previewBaselineOffsetPx(canvasWidth);
  var lineHeight = fontPx * LINE_HEIGHT_FACTOR;

  ctx.font = 'bold ' + fontPx + 'px "Times New Roman"';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.lineWidth = strokePx;
  ctx.strokeStyle = '#000';
  ctx.fillStyle = '#fff';

  var x = canvasWidth / 2;
  for (var i = lines.length - 1; i >= 0; i--) {
    var y = canvasHeight - baselinePx - (lines.length - 1 - i) * lineHeight;
    ctx.strokeText(lines[i], x, y);
    ctx.fillText(lines[i], x, y);
  }
}

// 現在フレームの映像 + 字幕を合成してpreviewCanvasへ描画する(§4.2)。
export function drawCompositeFrame(videoEl, text, fontSize, calibration) {
  ensureCanvasSize();
  drawVideoCover(videoEl);
  drawSubtitleText(ctx, text, fontSize, calibration, CANVAS_BASE_WIDTH, CANVAS_HEIGHT);
}

// 再生が最後まで到達した直後に表示する黒画面(最終フレームの静止を防ぐ)。
export function drawBlackFrame() {
  ensureCanvasSize();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, CANVAS_BASE_WIDTH, CANVAS_HEIGHT);
}
