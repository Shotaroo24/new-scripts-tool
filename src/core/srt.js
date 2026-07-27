// SRT生成

import { formatSrtTime } from './time.js';

// SRT改行コード。CapCut実機テストでCRLFが必要な場合はここを '\r\n' に変更する。
export var LINE_BREAK = '\n';

// CapCut側のインポート(30fpsプロジェクト)がフレームグリッドに乗らない境界を
// 丸める際、隣接クリップの終了/開始を別方向に丸めて1〜2フレームの隙間を
// 生むため、出力直前に境界をこのフレームグリッドへスナップする。
export var FRAME_FPS = 30;

function frameForMs(ms, fps) {
  return Math.round((ms / 1000) * fps);
}
function msForFrame(frame, fps) {
  return Math.round((frame * 1000) / fps);
}

// SRT出力直前に、全キューの境界時刻を30fpsフレームグリッドへスナップする。
// 境界(前キューのend = 次キューのstart)は共有値のため境界ごとに1回だけ
// フレーム番号を求め、両側に同じms値を割り当てる(endとstartを別々に丸めない)。
// スナップにより長さ0以下になるキューが出た場合は、後続の境界を1フレームずつ
// 押し出して単調性・最低1フレーム長を保証する(キューの削除・結合はしない)。
// 入力cuesは変更せず新しい配列を返す(エディタ内部stateには影響しない)。
export function snapCuesToFrameGrid(cues, fps) {
  fps = fps || FRAME_FPS;
  var n = cues.length;
  if (n === 0) return [];

  var frames = [frameForMs(cues[0].startMs, fps)];
  for (var i = 0; i < n; i++) frames.push(frameForMs(cues[i].endMs, fps));
  for (var i = 1; i < frames.length; i++) {
    if (frames[i] <= frames[i - 1]) frames[i] = frames[i - 1] + 1;
  }

  var out = [];
  for (var i = 0; i < n; i++) {
    out.push({
      index: cues[i].index,
      lines: cues[i].lines,
      startMs: msForFrame(frames[i], fps),
      endMs: msForFrame(frames[i + 1], fps)
    });
  }
  return out;
}

// フォールバック(実験用): 最終キュー以外の終了時刻を「次キューの開始 + 1フレーム」に
// して出力する。CapCut側の丸め仕様でスナップ後も隙間が残る場合の検証用。
// snapCuesToFrameGridの後に適用する想定(cuesは既にフレームグリッド上にある前提)。
export function applyOverlap(cues, fps) {
  fps = fps || FRAME_FPS;
  var overlapMs = msForFrame(1, fps);
  var n = cues.length;
  var out = [];
  for (var i = 0; i < n; i++) {
    var cue = cues[i];
    var endMs = (i < n - 1) ? (cues[i + 1].startMs + overlapMs) : cue.endMs;
    out.push({ index: cue.index, lines: cue.lines, startMs: cue.startMs, endMs: endMs });
  }
  return out;
}

export function buildSrt(cues, useBom) {
  var parts = [];
  for (var i = 0; i < cues.length; i++) {
    var cue = cues[i];
    var text = cue.lines.join(LINE_BREAK);
    parts.push(
      cue.index + LINE_BREAK +
      formatSrtTime(cue.startMs) + ' --> ' + formatSrtTime(cue.endMs) + LINE_BREAK +
      text
    );
  }
  var content = parts.join(LINE_BREAK + LINE_BREAK) + LINE_BREAK + LINE_BREAK;
  if (useBom) content = '﻿' + content;
  return content;
}
