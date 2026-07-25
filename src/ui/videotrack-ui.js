// 動画トラックの描画・ドラッグ・スナップ・マスター読み込み(§3, §4.3)

import { computeStartsMs, totalDurationMs, clipAt, msToPx, pxToMs } from '../core/time.js';
import {
  initialSegments, outputToSrc, splitSegmentAt, deleteSegmentRipple,
  resizeSegmentIn, resizeSegmentOut, moveSegment
} from '../core/videotrack.js';
import { checkMasterDecodability } from '../export/mp4.js';

var videoTrackRow = document.getElementById('videoTrackRow');
var videoTrack = document.getElementById('videoTrack');
var masterLoadBtn = document.getElementById('masterLoadBtn');
var masterFileInput = document.getElementById('masterFileInput');
var masterStatus = document.getElementById('masterStatus');
var masterWarning = document.getElementById('masterWarning');
var masterVideoEl = document.getElementById('masterVideoEl');

var segments = [];
var master = null; // { fileName, durationMs, width, height } | null
var masterFile = null; // 選択された生のFile(書き出しでmediabunnyに渡すために保持する)
var masterVideoUrl = null;
var focused = false;
var dragState = null;
var reorderState = null;
var pendingRestoreMaster = null; // 復元待ち(§2.2): { fileName, durationMs } | null

// 選択中の区間(字幕トラックの選択とは独立に管理する)。Deleteや矢印キー移動の対象になる。
// S(分割)は仕様上「再生ヘッド位置」で行うため、選択とは別にcurrentSegmentIndex()を使う。
var selectedSegmentIndex = -1;

function clampSelection() {
  if (segments.length === 0) {
    selectedSegmentIndex = -1;
  } else if (selectedSegmentIndex < 0 || selectedSegmentIndex >= segments.length) {
    selectedSegmentIndex = 0;
  }
}

var deps = {
  getSubs: function () { return []; },
  setSubs: function () {},
  onSubsChanged: function () {},
  pushHistorySnapshot: function () {},
  getHeadTimeMs: function () { return 0; },
  seekTo: function () {},
  currentPxPerSec: function () { return 80; },
  onChange: function () {},
  onFocusRequest: function () {},
  onMasterLoaded: function () {}
};

export function configure(newDeps) {
  Object.assign(deps, newDeps);
}

export function hasMaster() {
  return master !== null;
}
export function getMaster() {
  return master;
}
export function getSegments() {
  return segments;
}
export function getVideoElement() {
  return masterVideoEl;
}
export function getMasterFile() {
  return masterFile;
}
export function isFocused() {
  return focused;
}

// 出力時刻 -> ソース時刻(§4.1)。マスター未読み込み時は常に0を返す。
export function outputToSrcMs(tMs) {
  if (!master) return 0;
  return outputToSrc(segments, tMs);
}

// 再生ヘッド位置の区間(S=分割はこの位置で行う仕様のため)。選択状態とは別概念。
export function currentSegmentIndex() {
  if (segments.length === 0) return -1;
  return clipAt(segments, deps.getHeadTimeMs());
}

// 選択中の区間(Delete・矢印キー移動・並べ替えの対象)。字幕側の選択とは独立。
export function getSelectedSegmentIndex() {
  return selectedSegmentIndex;
}
export function setSelectedSegmentIndex(index) {
  selectedSegmentIndex = index;
  clampSelection();
}

// Undo復元専用: segmentsをそのまま置き換える(履歴には既にディープコピーが積まれている)。
export function restoreSegments(nextSegments) {
  segments = nextSegments;
  clampSelection();
}

// 再生ヘッド移動のたびに呼ばれる軽量な現在区間ハイライト更新(DOM再構築はしない)。
export function updateCurrentHighlight() {
  if (!master) return;
  var els = videoTrack.children;
  for (var i = 0; i < els.length; i++) {
    els[i].classList.toggle('current', i === selectedSegmentIndex);
  }
}

// 選択中の区間を隣(prev/next)へ移動し、その区間の頭へシークする(字幕側の↑↓と同等の操作感)。
export function stepSelection(direction) {
  if (segments.length === 0) return;
  var next = selectedSegmentIndex + direction;
  if (next < 0 || next >= segments.length) return;
  selectedSegmentIndex = next;
  var starts = computeStartsMs(segments);
  deps.seekTo(starts[next]);
  renderVideoTrack();
  deps.onChange();
}

export function setFocused(value) {
  focused = value;
  videoTrackRow.classList.toggle('focused', focused);
}

// 書き出し中は動画トラックの操作(マスター読み込み・区間ドラッグ)をロックする(§5.2-4)。
export function setLocked(locked) {
  masterLoadBtn.disabled = locked;
  videoTrack.style.pointerEvents = locked ? 'none' : '';
}

function formatDurationForWarning(ms) {
  var totalSec = Math.round(ms / 1000);
  var m = Math.floor(totalSec / 60);
  var s = totalSec % 60;
  return m + '分' + s + '秒';
}

function showMasterWarnings(list) {
  if (!list || list.length === 0) {
    masterWarning.style.display = 'none';
    masterWarning.textContent = '';
    return;
  }
  masterWarning.textContent = list.join(' ');
  masterWarning.style.display = '';
}

function updateMasterStatusUI() {
  if (!master) {
    masterStatus.textContent = pendingRestoreMaster
      ? 'マスター: ' + pendingRestoreMaster.fileName + ' を再選択してください'
      : '';
    masterLoadBtn.textContent = pendingRestoreMaster ? 'マスターを再選択' : 'マスター読み込み';
    return;
  }
  masterStatus.textContent = 'マスター: ' + master.fileName + ' (' + formatDurationForWarning(master.durationMs) + ')';
  masterLoadBtn.textContent = 'マスターを読み込み直す';
}

// §4.3: 再生可能かどうかをcanplayイベントで判定する(タイムアウトはエラー扱い)。
function waitForCanPlay(videoEl) {
  return new Promise(function (resolve) {
    var settled = false;
    function finish(ok) {
      if (settled) return;
      settled = true;
      videoEl.removeEventListener('canplay', onCanPlay);
      videoEl.removeEventListener('error', onError);
      resolve(ok);
    }
    function onCanPlay() { finish(true); }
    function onError() { finish(false); }
    videoEl.addEventListener('canplay', onCanPlay);
    videoEl.addEventListener('error', onError);
    setTimeout(function () { finish(false); }, 8000);
  });
}

async function loadMasterFile(file) {
  showMasterWarnings(null);
  var url = URL.createObjectURL(file);
  var probe = document.createElement('video');
  probe.muted = true;
  probe.playsInline = true;
  probe.src = url;

  var canPlay = await waitForCanPlay(probe);
  if (!canPlay) {
    URL.revokeObjectURL(url);
    showMasterWarnings(['この動画ファイルは再生できません。別のファイルを選択してください。']);
    return;
  }

  var durationMs = Math.round(probe.duration * 1000);
  var width = probe.videoWidth;
  var height = probe.videoHeight;
  var warnings = [];

  // §4.3: mediabunnyのデマルチプレクサで実ファイルのトラック/コーデックを読み取り、
  // WebCodecsでのデコード可否・音声トラックの有無を判定する(推測でのコーデック
  // 文字列チェックではなく、実ファイルベースの判定)。
  try {
    var decodability = await checkMasterDecodability(file);
    if (!decodability.videoDecodable) {
      warnings.push('この環境は映像コーデックのデコードに対応していない可能性があります。プレビューは動作しますが、書き出し時に問題が起きる場合があります。');
    }
    if (!decodability.hasAudioTrack) {
      warnings.push('音声トラックが検出されませんでした。音声なしで書き出されます。');
    } else if (decodability.audioDecodable === false) {
      warnings.push('この環境は音声コーデックのデコードに対応していない可能性があります。書き出し時に問題が起きる場合があります。');
    }
  } catch (err) {
    warnings.push('マスターのコーデック情報を読み取れませんでした。書き出し時に問題が起きる可能性があります。');
  }

  if (masterVideoUrl) URL.revokeObjectURL(masterVideoUrl);
  masterVideoUrl = url;
  masterVideoEl.src = url;
  masterFile = file;

  if (pendingRestoreMaster) {
    if (pendingRestoreMaster.durationMs !== durationMs) {
      warnings.unshift(
        '保存されていたマスター(' + pendingRestoreMaster.fileName + ', ' +
        formatDurationForWarning(pendingRestoreMaster.durationMs) + ')と尺が一致しないため、カット編集内容を初期化しました。'
      );
      segments = initialSegments(durationMs);
    }
    // 尺が一致する場合はsetStateFromSessionで復元済みのsegmentsをそのまま使う
    pendingRestoreMaster = null;
  } else {
    segments = initialSegments(durationMs);
  }

  master = { fileName: file.name, durationMs: durationMs, width: width, height: height };
  if (selectedSegmentIndex === -1) selectedSegmentIndex = 0;
  clampSelection();
  videoTrackRow.style.display = '';
  updateMasterStatusUI();
  renderVideoTrack();
  showMasterWarnings(warnings);
  deps.onChange();
  deps.onMasterLoaded();
}

masterLoadBtn.addEventListener('click', function () {
  masterFileInput.click();
});
masterFileInput.addEventListener('change', function () {
  var file = masterFileInput.files[0];
  masterFileInput.value = '';
  if (!file) return;
  loadMasterFile(file);
});
videoTrackRow.addEventListener('click', function () {
  if (!master) return;
  deps.onFocusRequest('video');
});

// ---- スナップ(§3.3): 字幕境界／再生ヘッド／0.1秒グリッドに、画面上6px相当で吸着する ----
var SNAP_PX = 6;
var GRID_MS = 100;
function snapMs(rawMs, altKey) {
  if (altKey) return Math.round(rawMs);
  var pxPerSec = deps.currentPxPerSec();
  var toleranceMs = pxToMs(SNAP_PX, pxPerSec);
  var subs = deps.getSubs();
  var candidates = computeStartsMs(subs).concat([totalDurationMs(subs), deps.getHeadTimeMs()]);
  candidates.push(Math.round(rawMs / GRID_MS) * GRID_MS);

  var best = Math.round(rawMs);
  var bestDist = toleranceMs;
  for (var i = 0; i < candidates.length; i++) {
    var d = Math.abs(candidates[i] - rawMs);
    if (d <= bestDist) {
      bestDist = d;
      best = candidates[i];
    }
  }
  return best;
}

// ---- 区間の並べ替え(ドラッグ) ----
var REORDER_DRAG_THRESHOLD_PX = 4; // これ未満の移動はクリック(選択+頭出し)として扱う

// ドラッグ後の中心位置から、並べ替え先のインデックス(fromIndexを除いた配列における
// 挿入位置)を求める。moveSegmentのtoIndexにそのまま渡せる。
function computeReorderTargetIndex(fromIndex, deltaPx) {
  var pxPerSec = deps.currentPxPerSec();
  var starts = computeStartsMs(segments);
  var fromWidthPx = msToPx(segments[fromIndex].durMs, pxPerSec);
  var fromCenterPx = msToPx(starts[fromIndex], pxPerSec) + fromWidthPx / 2;
  var newCenterPx = fromCenterPx + deltaPx;

  var acc = 0;
  for (var j = 0; j < segments.length; j++) {
    if (j === fromIndex) continue;
    var widthPx = msToPx(segments[j].durMs, pxPerSec);
    if (newCenterPx < acc + widthPx / 2) {
      return j < fromIndex ? j : j - 1;
    }
    acc += widthPx;
  }
  return segments.length - 1;
}

// S: 再生ヘッド位置で区間を分割する(§3.2)。分割後は先頭側(headMs以前)を選択状態にする。
export function doSplit() {
  var idx = currentSegmentIndex();
  if (idx === -1) return { ok: false };
  var result = splitSegmentAt(segments, idx, deps.getHeadTimeMs());
  if (!result.ok) return { ok: false };
  segments = result.segments;
  selectedSegmentIndex = idx;
  return { ok: true };
}

// Delete: 選択中の区間をリップル削除し、字幕トラックを連動させる(§3.2「選択区間を削除」)。
export function doDelete() {
  var idx = selectedSegmentIndex;
  if (idx === -1) return { ok: false, subs: deps.getSubs() };
  var result = deleteSegmentRipple(segments, deps.getSubs(), idx);
  if (!result.ok) return { ok: false, subs: deps.getSubs() };
  segments = result.segments;
  clampSelection();
  return { ok: true, subs: result.subs };
}

// 区間の並べ替え(ドラッグ)。ギャップ0不変条件・累積導出は変更しない(配列の順序のみ)。
export function doMoveSegment(fromIndex, toIndex) {
  var result = moveSegment(segments, fromIndex, toIndex);
  if (!result.ok) return { ok: false };
  segments = result.segments;
  selectedSegmentIndex = toIndex;
  return { ok: true };
}

export function renderVideoTrack() {
  if (!master) {
    videoTrackRow.style.display = 'none';
    return;
  }
  videoTrackRow.style.display = '';

  var pxPerSec = deps.currentPxPerSec();
  var starts = computeStartsMs(segments);
  clampSelection();

  videoTrack.innerHTML = '';
  var frag = document.createDocumentFragment();

  segments.forEach(function (seg, index) {
    var box = document.createElement('div');
    box.className = 'segment' + (index === selectedSegmentIndex ? ' current' : '');
    box.style.width = msToPx(seg.durMs, pxPerSec) + 'px';

    var durDiv = document.createElement('div');
    durDiv.className = 'segment-dur';
    durDiv.textContent = (seg.durMs / 1000).toFixed(1) + 's';

    var srcDiv = document.createElement('div');
    srcDiv.className = 'segment-src';
    srcDiv.textContent = 'src ' + (seg.srcInMs / 1000).toFixed(1) + 's';

    var leftHandle = document.createElement('div');
    leftHandle.className = 'segment-handle segment-handle-left';
    var rightHandle = document.createElement('div');
    rightHandle.className = 'segment-handle segment-handle-right';

    box.appendChild(durDiv);
    box.appendChild(srcDiv);
    box.appendChild(leftHandle);
    box.appendChild(rightHandle);
    frag.appendChild(box);

    // 区間本体(端のトリムハンドルを除く)のドラッグ: 微小な移動ならクリック(選択+頭出し)、
    // 一定以上動かせば並べ替えとして扱う。
    box.addEventListener('pointerdown', function (e) {
      if (e.target === leftHandle || e.target === rightHandle) return;
      e.stopPropagation();
      try { box.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      reorderState = { index: index, startX: e.clientX, deltaPx: 0, moved: false };
    });
    box.addEventListener('pointermove', function (e) {
      if (!reorderState || reorderState.index !== index) return;
      var deltaPx = e.clientX - reorderState.startX;
      reorderState.deltaPx = deltaPx;
      if (Math.abs(deltaPx) > REORDER_DRAG_THRESHOLD_PX && !reorderState.moved) {
        reorderState.moved = true;
        deps.pushHistorySnapshot();
        box.classList.add('dragging');
      }
      if (reorderState.moved) {
        box.style.transform = 'translateX(' + deltaPx + 'px)';
      }
    });
    box.addEventListener('pointerup', function (e) {
      if (!reorderState || reorderState.index !== index) return;
      try { box.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      var state = reorderState;
      reorderState = null;
      box.style.transform = '';
      box.classList.remove('dragging');

      if (state.moved) {
        deps.onFocusRequest('video');
        var targetIndex = computeReorderTargetIndex(index, state.deltaPx);
        if (targetIndex !== index) {
          var result = doMoveSegment(index, targetIndex);
          if (result.ok) {
            renderVideoTrack();
            deps.onSubsChanged();
          }
        }
        deps.onChange();
      } else {
        selectedSegmentIndex = index;
        deps.onFocusRequest('video');
        deps.seekTo(starts[index]);
        renderVideoTrack();
      }
    });

    rightHandle.addEventListener('pointerdown', function (e) {
      e.stopPropagation();
      e.preventDefault();
      try { rightHandle.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      deps.pushHistorySnapshot();
      dragState = {
        edge: 'out', index: index, startX: e.clientX,
        origSegments: segments, origSubs: deps.getSubs(),
        startBoundary: starts[index] + seg.durMs
      };
    });
    leftHandle.addEventListener('pointerdown', function (e) {
      e.stopPropagation();
      e.preventDefault();
      try { leftHandle.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      deps.pushHistorySnapshot();
      dragState = {
        edge: 'in', index: index, startX: e.clientX,
        origSegments: segments, origSubs: deps.getSubs(),
        origOutPoint: seg.srcInMs + seg.durMs,
        startBoundary: starts[index] + seg.durMs
      };
    });
    [leftHandle, rightHandle].forEach(function (handle) {
      handle.addEventListener('pointermove', function (e) {
        if (!dragState || dragState.index !== index) return;
        var deltaMs = pxToMs(e.clientX - dragState.startX, deps.currentPxPerSec());

        if (dragState.edge === 'out') {
          var rawBoundary = dragState.startBoundary + deltaMs;
          var snappedBoundary = snapMs(rawBoundary, e.altKey);
          var newDur = snappedBoundary - starts[index];
          var result = resizeSegmentOut(dragState.origSegments, dragState.origSubs, master.durationMs, index, newDur);
          segments = result.segments;
          deps.setSubs(result.subs);
        } else {
          var rawBoundaryIn = dragState.startBoundary - deltaMs;
          var snappedBoundaryIn = snapMs(rawBoundaryIn, e.altKey);
          var newDurIn = snappedBoundaryIn - starts[index];
          var newSrcIn = dragState.origOutPoint - newDurIn;
          var resultIn = resizeSegmentIn(dragState.origSegments, dragState.origSubs, index, newSrcIn);
          segments = resultIn.segments;
          deps.setSubs(resultIn.subs);
        }
        renderVideoTrack();
        deps.onSubsChanged();
      });
      handle.addEventListener('pointerup', function (e) {
        if (!dragState || dragState.index !== index) return;
        try { handle.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        dragState = null;
        deps.onChange();
      });
    });
  });

  videoTrack.appendChild(frag);
}

// ---- 永続化: session snapshot(§2.2) ----
export function getSessionSnapshot() {
  return {
    master: master ? { fileName: master.fileName, durationMs: master.durationMs } : null,
    segments: segments.map(function (s) { return { srcInMs: s.srcInMs, durMs: s.durMs }; })
  };
}

// localStorageから復元したセッションのmaster/segmentsを反映する。動画ファイル本体は
// 保存できないため、masterが存在する場合は再選択待ちの状態にし、実際のsegments適用は
// ファイル再選択時(loadMasterFile内の尺一致チェック)まで保留する。
export function setStateFromSession(data) {
  if (data.master) {
    pendingRestoreMaster = { fileName: data.master.fileName, durationMs: data.master.durationMs };
    segments = data.segments.map(function (s) { return { srcInMs: s.srcInMs, durMs: s.durMs }; });
  } else {
    pendingRestoreMaster = null;
    segments = [];
  }
  master = null;
  masterFile = null;
  videoTrackRow.style.display = 'none';
  updateMasterStatusUI();
}

// timeline.json読み込み(§5.4)。localStorage復元と同じく、動画ファイル本体は
// timeline.jsonに含まれないため再選択待ちの状態にする(尺一致チェックはファイル
// 再選択時、loadMasterFile内で行う)。
export function applyTimelineJson(masterData, segmentsData) {
  if (masterData) {
    pendingRestoreMaster = { fileName: masterData.fileName, durationMs: masterData.durationMs };
    segments = segmentsData.map(function (s) { return { srcInMs: s.srcInMs, durMs: s.durMs }; });
  } else {
    pendingRestoreMaster = null;
    segments = [];
  }
  master = null;
  masterFile = null;
  videoTrackRow.style.display = 'none';
  updateMasterStatusUI();
}
