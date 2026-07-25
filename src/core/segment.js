// 原稿分割(区切り文字規則)

import { charCountForText } from './subs.js';

var DELETE_CHARS = new Set(['.', '،', ',', '—']); // . 、 ،  、 , 、 —
var KEEP_CHARS = new Set(['؟', '?', '!']); // ؟ ? !

function isDelimiter(ch) {
  return DELETE_CHARS.has(ch) || KEEP_CHARS.has(ch);
}

// 原稿テキストを「字幕セグメント({lines, delim})」の配列に分割する。
// delim: この字幕の直後で除去された区切り文字(削除系のみ)。連続区切りに
// 「残す」系の文字が1つでも含まれる場合、本文側に既に存在するため delim は
// 空文字にする(二重出力防止)。末尾セグメント(区切りなしで終わる)は delim=''。
// 許可される加工は: 区切り文字(削除系)の削除 / 各行の前後トリム / 改行による2行字幕化 のみ。
export function segmentManuscript(text) {
  var chars = Array.from(text);
  var n = chars.length;
  var rawSegments = [];
  var currentLine = '';
  var currentLines = [];
  var i = 0;

  while (i < n) {
    var ch = chars[i];

    if (ch === '\r') {
      i++;
      continue;
    }

    if (ch === '\n') {
      currentLines.push(currentLine);
      currentLine = '';
      i++;
      continue;
    }

    if (isDelimiter(ch)) {
      var keepBuffer = '';
      var deleteBuffer = '';
      var hasKeep = false;
      while (i < n && isDelimiter(chars[i])) {
        if (KEEP_CHARS.has(chars[i])) {
          keepBuffer += chars[i];
          hasKeep = true;
        } else {
          deleteBuffer += chars[i];
        }
        i++;
      }
      currentLine += keepBuffer;
      currentLines.push(currentLine);
      rawSegments.push({ lines: currentLines, delim: hasKeep ? '' : deleteBuffer });
      currentLine = '';
      currentLines = [];
      continue;
    }

    currentLine += ch;
    i++;
  }

  currentLines.push(currentLine);
  rawSegments.push({ lines: currentLines, delim: '' });

  var segments = [];
  for (var s = 0; s < rawSegments.length; s++) {
    var trimmed = [];
    for (var l = 0; l < rawSegments[s].lines.length; l++) {
      var t = rawSegments[s].lines[l].trim();
      if (t.length > 0) trimmed.push(t);
    }
    if (trimmed.length > 0) segments.push({ lines: trimmed, delim: rawSegments[s].delim });
  }
  return segments;
}

// 累積丸め方式でキュー（連番・開始/終了ms・行・文字数）を構築する。入力モードの
// ライブプレビュー専用。cpsは連続値のため、ここは従来どおり秒(浮動小数)で
// 累積してからMath.roundでms化する(累積誤差を出さない既存方式を踏襲)。
export function buildCues(segments, cps) {
  var rate = (isFinite(cps) && cps > 0) ? cps : 12;
  var accSeconds = 0;
  var cues = [];
  for (var idx = 0; idx < segments.length; idx++) {
    var lines = segments[idx].lines;
    var charCount = charCountForText(lines.join('\n'));
    var duration = charCount / rate;

    var startMs = Math.round(accSeconds * 1000);
    accSeconds += duration;
    var endMs = Math.round(accSeconds * 1000);

    cues.push({ index: idx + 1, lines: lines, charCount: charCount, startMs: startMs, endMs: endMs });
  }
  return cues;
}
