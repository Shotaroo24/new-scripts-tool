// 動画トラックの描画・ドラッグ・スナップ・マスター読み込み(§3, §4.3)

import { computeStartsMs, totalDurationMs, clipAt, msToPx, pxToMs } from '../core/time.js';
import {
  initialSegments, outputToSrc, splitSegmentAt, deleteSegmentRipple,
  resizeSegmentIn, resizeSegmentOut
} from '../core/videotrack.js';

var videoTrackRow = document.getElementById('videoTrackRow');
var videoTrack = document.getElementById('videoTrack');
var masterLoadBtn = document.getElementById('masterLoadBtn');
var masterFileInput = document.getElementById('masterFileInput');
var masterStatus = document.getElementById('masterStatus');
var masterWarning = document.getElementById('masterWarning');
var masterVideoEl = document.getElementById('masterVideoEl');

var segments = [];
var master = null; // { fileName, durationMs, width, height } | null
var masterVideoUrl = null;
var focused = false;
var dragState = null;
var pendingRestoreMaster = null; // 復元待ち(§2.2): { fileName, durationMs } | null

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
export function isFocused() {
  return focused;
}

// 出力時刻 -> ソース時刻(§4.1)。マスター未読み込み時は常に0を返す。
export function outputToSrcMs(tMs) {
  if (!master) return 0;
  return outputToSrc(segments, tMs);
}

export function currentSegmentIndex() {
  if (segments.length === 0) return -1;
  return clipAt(segments, deps.getHeadTimeMs());
}

// Undo復元専用: segmentsをそのまま置き換える(履歴には既にディープコピーが積まれている)。
export function restoreSegments(nextSegments) {
  segments = nextSegments;
}

// 再生ヘッド移動のたびに呼ばれる軽量な現在区間ハイライト更新(DOM再構築はしない)。
export function updateCurrentHighlight() {
  if (!master) return;
  var idx = currentSegmentIndex();
  var els = videoTrack.children;
  for (var i = 0; i < els.length; i++) {
    els[i].classList.toggle('current', i === idx);
  }
}

export function setFocused(value) {
  focused = value;
  videoTrackRow.classList.toggle('focused', focused);
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

// §4.3: 音声トラックの有無。判定できない場合はnull(警告は出さない)。
function detectAudioTrack(videoEl) {
  if (videoEl.audioTracks) return videoEl.audioTracks.length > 0;
  if (typeof videoEl.mozHasAudio === 'boolean') return videoEl.mozHasAudio;
  return null;
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

  // §4.3: WebCodecsでのデコード可否(簡易チェック)。
  // 既知の制約: コンテナ/コーデック文字列を実ファイルから解析するデマルチプレクサを
  // 導入していない(mediabunny導入はPhase2)ため、一般的なH.264構成が対応しているかの
  // 目安チェックに留める。個々のファイルの実コーデックとは異なる場合がある。
  if (!window.VideoDecoder) {
    warnings.push('このブラウザはWebCodecsに対応していないため、将来の書き出し機能が使用できません。');
  } else {
    try {
      var support = await VideoDecoder.isConfigSupported({ codec: 'avc1.42E01E' });
      if (!support.supported) {
        warnings.push('この環境はハードウェアデコードに対応していない可能性があります。プレビューは動作しますが、書き出し時に問題が起きる場合があります。');
      }
    } catch (err) {
      // 判定不能な場合は警告しない
    }
  }

  var hasAudio = detectAudioTrack(probe);
  if (hasAudio === false) {
    warnings.push('音声トラックが検出されませんでした。音声なしで書き出されます。');
  }

  if (masterVideoUrl) URL.revokeObjectURL(masterVideoUrl);
  masterVideoUrl = url;
  masterVideoEl.src = url;

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

// S: 再生ヘッド位置で focus 中の区間を分割する。
export function doSplit() {
  var idx = currentSegmentIndex();
  if (idx === -1) return { ok: false };
  var result = splitSegmentAt(segments, idx, deps.getHeadTimeMs());
  if (!result.ok) return { ok: false };
  segments = result.segments;
  return { ok: true };
}

// Delete: 再生ヘッド位置の区間をリップル削除し、字幕トラックを連動させる。
export function doDelete() {
  var idx = currentSegmentIndex();
  if (idx === -1) return { ok: false, subs: deps.getSubs() };
  var result = deleteSegmentRipple(segments, deps.getSubs(), idx);
  if (!result.ok) return { ok: false, subs: deps.getSubs() };
  segments = result.segments;
  return { ok: true, subs: result.subs };
}

export function renderVideoTrack() {
  if (!master) {
    videoTrackRow.style.display = 'none';
    return;
  }
  videoTrackRow.style.display = '';

  var pxPerSec = deps.currentPxPerSec();
  var starts = computeStartsMs(segments);
  var curIdx = currentSegmentIndex();

  videoTrack.innerHTML = '';
  var frag = document.createDocumentFragment();

  segments.forEach(function (seg, index) {
    var box = document.createElement('div');
    box.className = 'segment' + (index === curIdx ? ' current' : '');
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

    box.addEventListener('click', function () {
      deps.onFocusRequest('video');
      deps.seekTo(starts[index]);
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
  videoTrackRow.style.display = 'none';
  updateMasterStatusUI();
}
