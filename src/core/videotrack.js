// segments モデル・分割/削除/トリム・outputToSrc・字幕連動リップル(§3.4)
//
// segments = [{ srcInMs, durMs }] は subs と同じ {durMs} 契約を持つため、
// 出力開始時刻の累積導出(computeStartsMs/totalDurationMs)・クリップ判定(clipAt)は
// time.js の既存実装をそのまま再利用する(重複実装しない)。

import { MIN_DUR_MS, computeStartsMs, totalDurationMs, clipAt } from './time.js';

// マスター読み込み直後の初期状態(§2.1-1)。
export function initialSegments(masterDurationMs) {
  return [{ srcInMs: 0, durMs: Math.round(masterDurationMs) }];
}

// 出力時刻 -> ソース時刻の写像(§4.1)。整数msの比較のみで一意に決まる。
// 総尺ちょうど・総尺超えの場合は最終区間の終端(srcInMs+durMs)にクランプする。
export function outputToSrc(segments, tMs) {
  if (segments.length === 0) return 0;
  var starts = computeStartsMs(segments);
  var total = totalDurationMs(segments);
  var t = Math.round(tMs);
  if (t <= 0) return segments[0].srcInMs;
  if (t >= total) {
    var last = segments[segments.length - 1];
    return last.srcInMs + last.durMs;
  }
  var idx = clipAt(segments, t);
  return segments[idx].srcInMs + (t - starts[idx]);
}

// 出力範囲 [a, b) が動画トラックの編集で消えるとき、字幕トラックを同じ範囲だけ詰める(§3.4)。
// 1. 削除範囲より完全に前/後ろに位置する字幕: そのまま(累積導出で自動的にずれる)。
// 2. 削除範囲と重なる字幕: 重なった長さをdurMsから減算し、edited:trueにする。
//    (減算結果がMIN_DUR_MSを下回ってもよい。1ms未満になる場合のみ3を適用)
// 3. 削除範囲に完全に含まれる字幕: 削除する。
export function rippleSubsForRange(subs, a, b) {
  if (b <= a) return subs;
  var starts = computeStartsMs(subs);
  var next = [];
  for (var i = 0; i < subs.length; i++) {
    var subStart = starts[i];
    var subEnd = subStart + subs[i].durMs;
    var overlapStart = Math.max(subStart, a);
    var overlapEnd = Math.min(subEnd, b);
    var overlap = Math.max(0, overlapEnd - overlapStart);

    if (overlap <= 0) {
      next.push(subs[i]);
      continue;
    }

    var newDur = subs[i].durMs - overlap;
    if (newDur <= 0) {
      continue; // 完全包含 -> 削除
    }

    next.push({
      text: subs[i].text,
      durMs: newDur,
      edited: true,
      delim: subs[i].delim,
      en: subs[i].en
    });
  }
  return next;
}

// S: 再生ヘッド位置(headMs)で区間indexを2分割する。srcInが連続する2区間になるため
// 映像は無変化(切れ目が入るだけ)。分割後どちらかがMIN_DUR_MS未満になる場合は拒否する。
export function splitSegmentAt(segments, index, headMs) {
  if (index < 0 || index >= segments.length) {
    return { ok: false, segments: segments };
  }
  var starts = computeStartsMs(segments);
  var seg = segments[index];
  var localMs = Math.round(headMs) - starts[index];
  var leftDur = localMs;
  var rightDur = seg.durMs - localMs;
  if (leftDur < MIN_DUR_MS || rightDur < MIN_DUR_MS) {
    return { ok: false, segments: segments };
  }
  var next = segments.slice();
  next.splice(index, 1,
    { srcInMs: seg.srcInMs, durMs: leftDur },
    { srcInMs: seg.srcInMs + leftDur, durMs: rightDur }
  );
  return { ok: true, segments: next };
}

// Delete: index番目の区間をリップル削除する。総尺が縮み、後続区間は自動的に前へ詰まる
// (累積導出のため)。字幕トラックは削除された出力範囲ぶんrippleSubsForRangeで連動する。
// segmentsは常に1個以上を維持するため、最後の1個は削除できない(§2.1-1)。
export function deleteSegmentRipple(segments, subs, index) {
  if (index < 0 || index >= segments.length || segments.length <= 1) {
    return { ok: false, segments: segments, subs: subs };
  }
  var starts = computeStartsMs(segments);
  var a = starts[index];
  var b = a + segments[index].durMs;
  var nextSegments = segments.slice();
  nextSegments.splice(index, 1);
  var nextSubs = rippleSubsForRange(subs, a, b);
  return { ok: true, segments: nextSegments, subs: nextSubs };
}

// 区間右端ドラッグ: out点トリム(durMs変更)。縮める場合は末尾の消えた出力範囲ぶん
// 字幕を連動させる。伸ばす場合は何も消えないため字幕には触れない(masterDurationMsまで)。
export function resizeSegmentOut(segments, subs, masterDurationMs, index, rawDurMs) {
  if (index < 0 || index >= segments.length) {
    return { ok: false, segments: segments, subs: subs };
  }
  var seg = segments[index];
  var maxDur = Math.round(masterDurationMs) - seg.srcInMs;
  var newDur = Math.max(MIN_DUR_MS, Math.min(Math.round(rawDurMs), maxDur));
  var starts = computeStartsMs(segments);
  var oldDur = seg.durMs;

  var nextSegments = segments.slice();
  nextSegments[index] = { srcInMs: seg.srcInMs, durMs: newDur };

  var nextSubs = subs;
  if (newDur < oldDur) {
    var a = starts[index] + newDur;
    var b = starts[index] + oldDur;
    nextSubs = rippleSubsForRange(subs, a, b);
  }
  return { ok: true, segments: nextSegments, subs: nextSubs };
}

// 区間左端ドラッグ: in点トリム(srcInMsとdurMsを同時に変更、out点=srcInMs+durMsは固定)。
// 縮める場合(srcInMsを後ろへ)は先頭の消えた出力範囲ぶん字幕を連動させる。
// 伸ばす場合(srcInMsを前へ、0まで)は何も消えないため字幕には触れない。
export function resizeSegmentIn(segments, subs, index, rawSrcInMs) {
  if (index < 0 || index >= segments.length) {
    return { ok: false, segments: segments, subs: subs };
  }
  var seg = segments[index];
  var oldSrcIn = seg.srcInMs;
  var oldDur = seg.durMs;
  var outPoint = oldSrcIn + oldDur;
  var newSrcIn = Math.max(0, Math.min(Math.round(rawSrcInMs), outPoint - MIN_DUR_MS));
  var newDur = outPoint - newSrcIn;
  var starts = computeStartsMs(segments);

  var nextSegments = segments.slice();
  nextSegments[index] = { srcInMs: newSrcIn, durMs: newDur };

  var nextSubs = subs;
  if (newSrcIn > oldSrcIn) {
    var delta = newSrcIn - oldSrcIn;
    var a = starts[index];
    var b = starts[index] + delta;
    nextSubs = rippleSubsForRange(subs, a, b);
  }
  return { ok: true, segments: nextSegments, subs: nextSubs };
}

// フレーム境界を累積msから導出する(§5.2-1)。フレームnの出力時刻はn*1000/fps(実数)。
// 区間ごとの個別丸めをしないことで、隣接フレームの隙間・重複を構造的に排除する。
export function frameTimestampsMs(totalMs, fps) {
  var frameCount = Math.round(totalMs * fps / 1000);
  var timestamps = [];
  for (var n = 0; n < frameCount; n++) {
    timestamps.push(n * 1000 / fps);
  }
  return timestamps;
}
