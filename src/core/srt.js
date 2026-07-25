// SRT生成

import { formatSrtTime } from './time.js';

// SRT改行コード。Filmora実機テストでCRLFが必要な場合はここを '\r\n' に変更する。
export var LINE_BREAK = '\n';

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
