// subs生成・cps・リップル・結合/分割

import { MIN_DUR_MS, clampDurMs, computeStartsMs } from './time.js';

// 改行を除き、スペース込み・コードポイント単位で文字数を数える(既存の cps 計算方式と同一)。
export function charCountForText(text) {
  var lines = text.split('\n');
  var count = 0;
  for (var i = 0; i < lines.length; i++) count += Array.from(lines[i]).length;
  return count;
}

export function durMsFromCps(charCount, cps) {
  var rate = (isFinite(cps) && cps > 0) ? cps : 12;
  return clampDurMs((charCount / rate) * 1000);
}

// 生成: セグメント({lines,delim})から編集モード用の subs を組み立てる。
// durMs は cps から算出しMath.roundでms整数化・最小300msでクランプ。全クリップ edited:false。
// translationは生成時点では持たない(番号付きコピー&貼り付けで後から入力する。§5)ため常に空文字・非stale。
export function subsFromSegments(segments, cps) {
  var subs = [];
  for (var i = 0; i < segments.length; i++) {
    var text = segments[i].lines.join('\n');
    var charCount = charCountForText(text);
    subs.push({
      text: text,
      durMs: durMsFromCps(charCount, cps),
      edited: false,
      delim: segments[i].delim,
      translation: '',
      translationStale: false
    });
  }
  return subs;
}

export function cloneSubs(subs) {
  var out = [];
  for (var i = 0; i < subs.length; i++) {
    out.push({
      text: subs[i].text,
      durMs: subs[i].durMs,
      edited: subs[i].edited,
      delim: subs[i].delim,
      translation: subs[i].translation,
      translationStale: subs[i].translationStale
    });
  }
  return out;
}

// ドラッグ等による尺の直接指定。px→msから算出した値を1ms単位に丸めるのみで、
// 人為的なスナップ(0.1秒刻み等)は入れない。常に成功し、最小300msでクランプする。
export function setClipDuration(subs, index, rawMs) {
  var next = cloneSubs(subs);
  next[index].durMs = clampDurMs(rawMs);
  next[index].edited = true;
  return next;
}

// S: ヘッドが乗っているクリップの尺を (ヘッドms − クリップ開始ms) に変更する。
// 結果が最小尺(300ms)未満なら拒否して元の配列を返す。テキストは変更しない。
export function trimClipAtHead(subs, index, headMs) {
  var starts = computeStartsMs(subs);
  var newDur = Math.round(headMs) - starts[index];
  if (newDur < MIN_DUR_MS) {
    return { ok: false, subs: subs };
  }
  var next = cloneSubs(subs);
  next[index].durMs = newDur;
  next[index].edited = true;
  return { ok: true, subs: next };
}

// N: ヘッドが乗っているクリップを、ヘッド位置で2つに分割する。
// 前半の尺は (ヘッドms − クリップ開始ms)、後半の尺は残りとなる。テキスト・英訳は
// 分割せず両方に元クリップの複製を持たせる(どちらに何を残すかは呼び出し側での編集に委ねる)。
// 分割後どちらかの尺が最小尺(300ms)未満になる場合は拒否して元の配列を返す。
export function splitClipAtHead(subs, index, headMs) {
  var starts = computeStartsMs(subs);
  var firstDur = Math.round(headMs) - starts[index];
  var secondDur = subs[index].durMs - firstDur;
  if (firstDur < MIN_DUR_MS || secondDur < MIN_DUR_MS) {
    return { ok: false, subs: subs };
  }
  var next = cloneSubs(subs);
  var clip = next[index];
  var half = {
    text: clip.text,
    durMs: firstDur,
    edited: true,
    delim: clip.delim,
    translation: clip.translation,
    translationStale: clip.translationStale
  };
  next.splice(index, 1, half, {
    text: clip.text,
    durMs: secondDur,
    edited: true,
    delim: clip.delim,
    translation: clip.translation,
    translationStale: clip.translationStale
  });
  return { ok: true, subs: next };
}

// D: 選択中のクリップの終端を再生ヘッドまで伸ばす(ヘッドms − クリップ開始ms を新しい尺にする)。
// 伸ばす操作のため、結果が現在の尺以下(ヘッドが終端以前、またはちょうど終端)なら拒否する。
// リップルにより後続クリップの開始時刻は自動的に後ろへずれる。テキストは変更しない。
export function extendClipToHead(subs, index, headMs) {
  var starts = computeStartsMs(subs);
  var newDur = Math.round(headMs) - starts[index];
  if (newDur <= subs[index].durMs) {
    return { ok: false, subs: subs };
  }
  var next = cloneSubs(subs);
  next[index].durMs = newDur;
  next[index].edited = true;
  return { ok: true, subs: next };
}

// M: index番目と右隣(index+1)を結合する。テキストは半角スペース連結、尺は合算。
// delimは左クリップのものを破棄し、右クリップのものを引き継ぐ。
// 最終クリップ(右隣が存在しない)なら拒否。
// 訳文は空文字列を除外して半角スペース連結し、translationStale = true にする(§7 M行)。
export function mergeClipAt(subs, index) {
  if (index < 0 || index >= subs.length - 1) {
    return { ok: false, subs: subs };
  }
  var next = cloneSubs(subs);
  var a = next[index];
  var b = next[index + 1];
  var merged = {
    text: a.text + ' ' + b.text,
    durMs: a.durMs + b.durMs,
    edited: true,
    delim: b.delim,
    translation: [a.translation, b.translation].filter(function (t) { return t !== ''; }).join(' '),
    translationStale: true
  };
  next.splice(index, 2, merged);
  return { ok: true, subs: next };
}

// Delete: index番目のクリップを削除する。残存クリップの edited フラグには影響しない。
export function deleteClipAt(subs, index) {
  if (index < 0 || index >= subs.length) {
    return { ok: false, subs: subs };
  }
  var next = cloneSubs(subs);
  next.splice(index, 1);
  return { ok: true, subs: next };
}

// cps変更: edited:false のクリップのみ、自身のテキストの文字数から尺(ms)を再計算する。
// edited:true のクリップは一切変更しない。
export function recalcUneditedDurations(subs, cps) {
  return subs.map(function (sub) {
    if (sub.edited) return sub;
    var charCount = charCountForText(sub.text);
    return {
      text: sub.text, durMs: durMsFromCps(charCount, cps), edited: false, delim: sub.delim,
      translation: sub.translation, translationStale: sub.translationStale
    };
  });
}

// SRT出力用のcues生成。durMsは既に整数msのため、累積は常に厳密(丸め不要)。
export function subsToCues(subs) {
  var cues = [];
  var acc = 0;
  for (var i = 0; i < subs.length; i++) {
    var startMs = acc;
    acc += subs[i].durMs;
    var endMs = acc;
    cues.push({ index: i + 1, lines: subs[i].text.split('\n'), startMs: startMs, endMs: endMs });
  }
  return cues;
}

// 原稿への書き戻し: 各クリップの本文+delimを結合し、改行区切りで連結する。
// 区切りなしで削除された部分の後にも \n を挿入するが、再パース時に
// 空行として除去されるため分割結果には影響しない。
export function reconstructManuscript(subs) {
  return subs.map(function (s) { return s.text + s.delim; }).join('\n');
}

// 文字列の完全一致判定(コードポイント単位。正規化はしない)。
export function textEquals(a, b) {
  return Array.from(a).join('') === Array.from(b).join('');
}

// Undo: 操作前の subs のディープコピーをスタックにpushする。上限50件(古いものから破棄)。
var HISTORY_LIMIT = 50;
export function pushHistory(stack, subs) {
  var next = stack.slice();
  next.push(JSON.parse(JSON.stringify(subs)));
  if (next.length > HISTORY_LIMIT) next.shift();
  return next;
}
export function popHistory(stack) {
  if (stack.length === 0) return null;
  var next = stack.slice();
  var subs = next.pop();
  return { stack: next, subs: subs };
}
