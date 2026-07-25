// タイムライン編集モード: DOM wiring・トラック共通操作・Undo

import {
  ZOOM_LEVELS, DEFAULT_ZOOM_INDEX, clipAt, computeStartsMs, totalDurationMs,
  formatClock, clampZoomIndex, msToPx, pxToMs, pickTickIntervalSec, pad
} from '../core/time.js';
import { segmentManuscript } from '../core/segment.js';
import {
  subsFromSegments, cloneSubs, setClipDuration, trimClipAtHead, mergeClipAt, deleteClipAt,
  recalcUneditedDurations, subsToCues, reconstructManuscript, reconstructTranslation, textEquals,
  pushHistory, popHistory, splitEnglishLines
} from '../core/subs.js';
import { buildSrt } from '../core/srt.js';
import { serializeTimelineJson, deserializeTimelineJson } from '../core/session.js';
import { exportMp4 } from '../export/mp4.js';
import {
  CANVAS_BASE_WIDTH, SAFE_WIDTH_1080, STROKE_WIDTH_AT_1080, FONT_SIZE_DEFAULT,
  CALIBRATION_DEFAULT, CALIBRATION_MIN, CALIBRATION_MAX, CALIBRATION_STEP,
  clampCalibration, measurementFontSize, previewFontSizePx, previewStrokeWidthPx,
  previewBaselineOffsetPx, previewSafeMargins, judgeLineCount, autoSplitToTwoLines, collapseToOneLine
} from '../core/style.js';
import { textarea, translationTextarea, cpsInput, bomCheckbox, toTimelineBtn, render, downloadSrtContent } from './manuscript.js';
import * as videotrackUI from './videotrack-ui.js';
import { drawCompositeFrame } from './preview.js';

var mainView = document.getElementById('mainView');
var editorView = document.getElementById('editorView');
var playPauseBtn = document.getElementById('playPauseBtn');
var upBtn = document.getElementById('upBtn');
var downBtn = document.getElementById('downBtn');
var timeDisplay = document.getElementById('timeDisplay');
var sBtn = document.getElementById('sBtn');
var mBtn = document.getElementById('mBtn');
var undoBtn = document.getElementById('undoBtn');
var backBtn = document.getElementById('backBtn');
var downloadEditorBtn = document.getElementById('downloadEditorBtn');
var editorHint = document.getElementById('editorHint');
var editorCps = document.getElementById('editorCps');
var editorCpsValue = document.getElementById('editorCpsValue');
var previewFrame = document.getElementById('previewFrame');
var previewSafeGuide = document.getElementById('previewSafeGuide');
var previewSubtitleText = document.getElementById('previewSubtitleText');
var previewTranslationText = document.getElementById('previewTranslationText');
var previewJudgeBadge = document.getElementById('previewJudgeBadge');
var calibrationInput = document.getElementById('calibrationInput');
calibrationInput.min = CALIBRATION_MIN;
calibrationInput.max = CALIBRATION_MAX;
calibrationInput.step = CALIBRATION_STEP;
var calibrationValue = document.getElementById('calibrationValue');
var fontSizeInput = document.getElementById('fontSizeInput');
var timelineWrap = document.getElementById('timelineWrap');
var timelineInner = document.getElementById('timelineInner');
var ruler = document.getElementById('ruler');
var subtitleTrackRow = document.getElementById('subtitleTrackRow');
var clipsTrack = document.getElementById('clipsTrack');
var playhead = document.getElementById('playhead');
var previewCanvas = document.getElementById('previewCanvas');
var exportMp4Btn = document.getElementById('exportMp4Btn');
var exportProgressRow = document.getElementById('exportProgressRow');
var exportProgressBar = document.getElementById('exportProgressBar');
var exportProgressText = document.getElementById('exportProgressText');
var exportCancelBtn = document.getElementById('exportCancelBtn');
var saveTimelineJsonBtn = document.getElementById('saveTimelineJsonBtn');
var loadTimelineJsonBtn = document.getElementById('loadTimelineJsonBtn');
var timelineJsonFileInput = document.getElementById('timelineJsonFileInput');

var editModal = document.getElementById('editModal');
var modalArabicText = document.getElementById('modalArabicText');
var modalEnglishText = document.getElementById('modalEnglishText');
var modalAutoSplitBtn = document.getElementById('modalAutoSplitBtn');
var modalCollapseBtn = document.getElementById('modalCollapseBtn');
var modalPreviewFrame = document.getElementById('modalPreviewFrame');
var modalSafeGuide = document.getElementById('modalSafeGuide');
var modalPreviewSubtitleText = document.getElementById('modalPreviewSubtitleText');
var modalJudgeBadge = document.getElementById('modalJudgeBadge');
var modalCancelBtn = document.getElementById('modalCancelBtn');
var modalSaveBtn = document.getElementById('modalSaveBtn');

var mode = 'input'; // 'input' | 'edit'
var subs = [];
var hasTimelineState = false; // 一度でもタイムラインを生成/復元したか
var history = [];
var headTimeMs = 0;
var playing = false;
var rafId = null;
var playStartPerf = 0;
var playStartHeadMs = 0;
var currentCps = 12;
var modalOpen = false; // 編集モーダルが開いている間はショートカット無効
var modalIndex = -1;
var dragState = null;
var cpsAdjusting = false;
var zoomIndex = DEFAULT_ZOOM_INDEX;
var calibration = CALIBRATION_DEFAULT;
var fontSize = FONT_SIZE_DEFAULT;
var focusedTrack = 'subtitle'; // 'subtitle' | 'video'(§3.1、マスター未読み込み時は常にsubtitle)
var VIDEO_SYNC_TOLERANCE_MS = 150;
var editingLocked = false; // 書き出し中は編集操作をロックする(§5.2-4)
var exportAbortController = null;

var onChangeCallback = function () {};

export function setOnChange(fn) {
  onChangeCallback = fn;
}

// 保存用スナップショット(app.jsのpersistSessionから読み出される)。
export function getSessionSnapshot() {
  var videoSnap = videotrackUI.getSessionSnapshot();
  return {
    cps: currentCps,
    mode: mode,
    clips: subs,
    zoomIndex: zoomIndex,
    headTimeMs: headTimeMs,
    calibration: calibration,
    fontSize: fontSize,
    master: videoSnap.master,
    segments: videoSnap.segments
  };
}

// localStorageから復元したセッションのタイムライン部分を反映する(表示切り替えは含まない)。
export function setStateFromSession(data) {
  subs = data.clips.map(function (c) {
    return { text: c.text, durMs: c.durMs, delim: c.delim, edited: c.edited, en: c.en };
  });
  hasTimelineState = subs.length > 0;
  currentCps = data.cps;
  zoomIndex = clampZoomIndex(data.zoomIndex);
  headTimeMs = data.headTimeMs;
  calibration = clampCalibration(data.calibration);
  fontSize = data.fontSize;
  history = [];

  calibrationInput.value = String(calibration);
  calibrationValue.textContent = calibration.toFixed(2);
  fontSizeInput.value = String(fontSize);

  videotrackUI.setStateFromSession(data);
}

// 復元データのmodeが'edit'だった場合のみ、エディタ表示へ切り替える。
export function restoreEditorViewIfNeeded(dataMode) {
  if (dataMode === 'edit' && subs.length > 0) {
    mode = 'edit';
    mainView.style.display = 'none';
    editorView.style.display = '';
    editorCps.value = String(currentCps);
    editorCpsValue.textContent = String(currentCps);
    renderTimeline();
  }
}

var HEAD_BACK_THRESHOLD_MS = 150;
var AUTOSCROLL_MARGIN = 60;

function currentPxPerSec() {
  return ZOOM_LEVELS[zoomIndex];
}

function setHint(msg) {
  editorHint.textContent = msg || '';
}

function currentClipIndex() {
  return clipAt(subs, headTimeMs);
}

// トラックフォーカス(§3.1)。マスター未読み込み時は常に字幕トラック固定(videotrackUI側でガード)。
function setFocusedTrack(track) {
  focusedTrack = track;
  subtitleTrackRow.classList.toggle('focused', track === 'subtitle');
  videotrackUI.setFocused(track === 'video');
}
subtitleTrackRow.addEventListener('click', function () {
  setFocusedTrack('subtitle');
});

// ---- 9:16実寸プレビュー用のCanvas幅測定(1080px空間、strokeWidth込み) ----
var measureCanvas = document.createElement('canvas');
var measureCtx = measureCanvas.getContext('2d');
function measureTextWidth1080(text) {
  measureCtx.font = 'bold ' + measurementFontSize(fontSize, calibration) + 'px "Times New Roman"';
  return measureCtx.measureText(text).width + STROKE_WIDTH_AT_1080;
}
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(function () {
    renderPreview(); // フォント読み込み完了後に測定・再描画
  });
}

var JUDGE_LABELS = { 'one-line': '1行', 'two-line': '2行推奨', 'overflow': '溢れ' };
var JUDGE_BADGE_CLASSES = { 'one-line': 'badge-one-line', 'two-line': 'badge-two-line', 'overflow': 'badge-overflow' };

function renderJudgeBadge(el, judge) {
  el.innerHTML = '';
  var badge = document.createElement('span');
  badge.className = 'badge ' + JUDGE_BADGE_CLASSES[judge.level];
  badge.textContent = JUDGE_LABELS[judge.level];
  el.appendChild(badge);
  var detail = document.createElement('span');
  detail.textContent = '描画幅 ' + Math.round(judge.maxWidth) + 'px ／ 安全幅 ' + SAFE_WIDTH_1080 + 'px';
  el.appendChild(detail);
}

function renderRuler(widthPx, totalMs) {
  ruler.innerHTML = '';
  ruler.style.width = widthPx + 'px';
  var pxPerSec = currentPxPerSec();
  var tickIntervalSec = pickTickIntervalSec(pxPerSec);
  var totalSec = totalMs / 1000;
  var frag = document.createDocumentFragment();
  var epsilon = 1e-6;
  for (var k = 0; k * tickIntervalSec <= totalSec + epsilon; k++) {
    var t = k * tickIntervalSec;
    var tick = document.createElement('div');
    tick.className = 'ruler-tick';
    tick.style.left = (t * pxPerSec) + 'px';
    tick.textContent = (tickIntervalSec < 1 ? t.toFixed(1) : String(Math.round(t))) + 's';
    frag.appendChild(tick);
  }
  ruler.appendChild(frag);
}

function updateCurrentHighlight() {
  var idx = currentClipIndex();
  var clipEls = clipsTrack.children;
  for (var i = 0; i < clipEls.length; i++) {
    clipEls[i].classList.toggle('current', i === idx);
  }
}

function updatePlayheadPosition() {
  playhead.style.transform = 'translateX(' + msToPx(headTimeMs, currentPxPerSec()) + 'px)';
  timeDisplay.textContent = formatClock(headTimeMs) + ' / ' + formatClock(totalDurationMs(subs));
}

// 9:16プレビュー枠(本体・モーダル共通)の安全領域・縁取り・ベースライン位置・
// 行数判定バッジを更新する。text が null の場合はクリップなし扱いでバッジを空にする。
function applySubtitleStyle(frameEl, safeGuideEl, subtitleTextEl, judgeBadgeEl, text, fallbackWidth) {
  var widthPx = frameEl.getBoundingClientRect().width || fallbackWidth;
  var fontPx = previewFontSizePx(fontSize, calibration, widthPx);
  var strokePx = previewStrokeWidthPx(widthPx);
  var baselinePx = previewBaselineOffsetPx(widthPx);
  var margins = previewSafeMargins(widthPx);

  safeGuideEl.style.left = margins.left + 'px';
  safeGuideEl.style.right = margins.right + 'px';
  safeGuideEl.style.top = margins.top + 'px';
  safeGuideEl.style.bottom = margins.bottom + 'px';

  subtitleTextEl.style.fontSize = fontPx + 'px';
  subtitleTextEl.style.lineHeight = '1.3';
  subtitleTextEl.style.webkitTextStroke = strokePx + 'px #000';
  subtitleTextEl.style.paintOrder = 'stroke fill';
  subtitleTextEl.style.bottom = baselinePx + 'px';
  subtitleTextEl.textContent = text === null ? '' : text;

  if (text === null) {
    judgeBadgeEl.innerHTML = '';
  } else {
    renderJudgeBadge(judgeBadgeEl, judgeLineCount(text, SAFE_WIDTH_1080, measureTextWidth1080));
  }
}

// マスター読み込み時、<video>のcurrentTimeをoutputToSrcの写像先へ同期する(§4.1)。
// 許容誤差内なら再シークしない(区間境界を跨いだ場合や大きなジャンプのみ補正)。
function syncVideoToSrc(srcMs) {
  var videoEl = videotrackUI.getVideoElement();
  if (!videoEl || !isFinite(videoEl.duration)) return;
  var currentMs = videoEl.currentTime * 1000;
  if (Math.abs(currentMs - srcMs) > VIDEO_SYNC_TOLERANCE_MS) {
    videoEl.currentTime = srcMs / 1000;
  }
}

// 9:16実寸プレビューを更新する(再生ヘッド位置のクリップに追随)。マスター読み込み時は
// Canvas合成(映像+字幕)、未読み込み時は既存のDOM描画(見た目・動作を完全に維持)。
function renderPreview() {
  var idx = currentClipIndex();
  var sub = idx === -1 ? null : subs[idx];

  if (videotrackUI.hasMaster()) {
    previewSubtitleText.style.display = 'none';
    previewCanvas.style.display = '';

    var srcMs = videotrackUI.outputToSrcMs(headTimeMs);
    syncVideoToSrc(srcMs);
    drawCompositeFrame(videotrackUI.getVideoElement(), sub ? sub.text : null, fontSize, calibration);

    var widthPx = previewFrame.getBoundingClientRect().width || 320;
    var margins = previewSafeMargins(widthPx);
    previewSafeGuide.style.left = margins.left + 'px';
    previewSafeGuide.style.right = margins.right + 'px';
    previewSafeGuide.style.top = margins.top + 'px';
    previewSafeGuide.style.bottom = margins.bottom + 'px';
    if (sub) {
      renderJudgeBadge(previewJudgeBadge, judgeLineCount(sub.text, SAFE_WIDTH_1080, measureTextWidth1080));
    } else {
      previewJudgeBadge.innerHTML = '';
    }
  } else {
    previewCanvas.style.display = 'none';
    previewSubtitleText.style.display = '';
    applySubtitleStyle(previewFrame, previewSafeGuide, previewSubtitleText, previewJudgeBadge, sub ? sub.text : null, 320);
  }
  previewTranslationText.textContent = sub ? sub.en : '';
}

// 再生ヘッド関連(位置・時刻表示・現在クリップ強調・プレビュー)をまとめて更新する。
function refreshPlayheadUI() {
  updatePlayheadPosition();
  updateCurrentHighlight();
  videotrackUI.updateCurrentHighlight();
  renderPreview();
}

// 尺のみが変わった場合(ドラッグ中)の軽量更新。クリップDOM要素は再生成しない
// (pointer capture がハンドル要素に紐づいているため、破棄すると以後のドラッグが効かなくなる)。
function relayout() {
  var total = totalDurationMs(subs);
  var pxPerSec = currentPxPerSec();
  var widthPx = Math.max(msToPx(total, pxPerSec), 1);
  timelineInner.style.width = widthPx + 'px';
  clipsTrack.style.width = widthPx + 'px';
  renderRuler(widthPx, total);
  var clipEls = clipsTrack.children;
  for (var i = 0; i < subs.length; i++) {
    clipEls[i].style.width = msToPx(subs[i].durMs, pxPerSec) + 'px';
    clipEls[i].querySelector('.clip-dur').textContent = (subs[i].durMs / 1000).toFixed(1) + 's';
    clipEls[i].classList.toggle('edited', subs[i].edited);
  }
  refreshPlayheadUI();
}

// 構造(枚数・テキスト)が変わった場合のフル再構築。
function renderTimeline() {
  var total = totalDurationMs(subs);
  var pxPerSec = currentPxPerSec();
  var widthPx = Math.max(msToPx(total, pxPerSec), 1);
  timelineInner.style.width = widthPx + 'px';
  clipsTrack.style.width = widthPx + 'px';
  renderRuler(widthPx, total);

  clipsTrack.innerHTML = '';
  var starts = computeStartsMs(subs);
  var frag = document.createDocumentFragment();

  subs.forEach(function (sub, index) {
    var clip = document.createElement('div');
    clip.className = 'clip' + (sub.edited ? ' edited' : '');
    clip.style.width = msToPx(sub.durMs, pxPerSec) + 'px';

    var textDiv = document.createElement('div');
    textDiv.className = 'clip-text';
    textDiv.dir = 'rtl';
    textDiv.textContent = sub.text.replace(/\n/g, ' ');

    var enDiv = document.createElement('div');
    enDiv.className = 'clip-en';
    enDiv.textContent = sub.en;

    var durDiv = document.createElement('div');
    durDiv.className = 'clip-dur';
    durDiv.textContent = (sub.durMs / 1000).toFixed(1) + 's';

    var handle = document.createElement('div');
    handle.className = 'clip-handle';

    clip.appendChild(textDiv);
    clip.appendChild(enDiv);
    clip.appendChild(durDiv);
    clip.appendChild(handle);
    frag.appendChild(clip);

    handle.addEventListener('pointerdown', function (e) {
      e.stopPropagation();
      e.preventDefault();
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* キャプチャ失敗時もハンドル上でのドラッグ自体は継続できる */ }
      history = pushHistory(history, subs);
      dragState = { index: index, startX: e.clientX, startDurMs: subs[index].durMs };
    });
    handle.addEventListener('pointermove', function (e) {
      if (!dragState || dragState.index !== index) return;
      var deltaMs = pxToMs(e.clientX - dragState.startX, currentPxPerSec());
      subs = setClipDuration(subs, index, dragState.startDurMs + deltaMs);
      relayout();
    });
    handle.addEventListener('pointerup', function (e) {
      if (!dragState || dragState.index !== index) return;
      try { handle.releasePointerCapture(e.pointerId); } catch (err) { /* 未キャプチャの場合は何もしない */ }
      dragState = null;
      onChangeCallback();
    });
    clip.addEventListener('click', function (e) {
      var rect = clip.getBoundingClientRect();
      var offsetX = e.clientX - rect.left;
      seekTo(starts[index] + pxToMs(offsetX, currentPxPerSec()));
    });
  });

  clipsTrack.appendChild(frag);
  updateDownloadEditorState();
  refreshPlayheadUI();
}

function updateDownloadEditorState() {
  downloadEditorBtn.disabled = subs.length === 0;
}

function autoScrollToPlayhead() {
  var x = msToPx(headTimeMs, currentPxPerSec());
  var viewLeft = timelineWrap.scrollLeft;
  var viewWidth = timelineWrap.clientWidth;
  if (x > viewLeft + viewWidth - AUTOSCROLL_MARGIN) {
    timelineWrap.scrollLeft = x - viewWidth + AUTOSCROLL_MARGIN;
  } else if (x < viewLeft + AUTOSCROLL_MARGIN) {
    timelineWrap.scrollLeft = Math.max(0, x - AUTOSCROLL_MARGIN);
  }
}

function seekTo(tMs) {
  var total = totalDurationMs(subs);
  headTimeMs = Math.max(0, Math.min(total, tMs));
  refreshPlayheadUI();
  autoScrollToPlayhead();
  onChangeCallback();
}

function updatePlayPauseIcon() {
  playPauseBtn.textContent = playing ? '⏸' : '▶';
}

function stopPlayback() {
  var wasPlaying = playing;
  playing = false;
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;
  updatePlayPauseIcon();
  if (videotrackUI.hasMaster()) videotrackUI.getVideoElement().pause();
  if (wasPlaying) onChangeCallback();
}

function playTick(now) {
  var elapsedMs = now - playStartPerf;
  var total = totalDurationMs(subs);
  var t = playStartHeadMs + elapsedMs;
  if (t >= total) {
    headTimeMs = total;
    refreshPlayheadUI();
    autoScrollToPlayhead();
    stopPlayback();
    return;
  }
  headTimeMs = t;
  refreshPlayheadUI();
  autoScrollToPlayhead();
  rafId = requestAnimationFrame(playTick);
}

function startPlayback() {
  if (subs.length === 0) return;
  var total = totalDurationMs(subs);
  if (headTimeMs >= total) headTimeMs = 0;
  playing = true;
  playStartPerf = performance.now();
  playStartHeadMs = headTimeMs;
  updatePlayPauseIcon();
  if (videotrackUI.hasMaster()) {
    var videoEl = videotrackUI.getVideoElement();
    videoEl.currentTime = videotrackUI.outputToSrcMs(headTimeMs) / 1000;
    videoEl.play().catch(function () { /* 自動再生ポリシー等で失敗しても字幕タイムラインの再生は継続する */ });
  }
  rafId = requestAnimationFrame(playTick);
}

function togglePlay() {
  if (playing) stopPlayback(); else startPlayback();
}

function stepUp() {
  var idx = currentClipIndex();
  if (idx === -1) return;
  var starts = computeStartsMs(subs);
  if (headTimeMs - starts[idx] > HEAD_BACK_THRESHOLD_MS) {
    seekTo(starts[idx]);
  } else if (idx > 0) {
    seekTo(starts[idx - 1]);
  } else {
    seekTo(0);
  }
}

function stepDown() {
  var idx = currentClipIndex();
  if (idx === -1 || idx >= subs.length - 1) return;
  var starts = computeStartsMs(subs);
  seekTo(starts[idx + 1]);
}

function doTrim() {
  var idx = currentClipIndex();
  if (idx === -1) return;
  history = pushHistory(history, subs);
  var result = trimClipAtHead(subs, idx, headTimeMs);
  if (!result.ok) {
    history = history.slice(0, -1);
    setHint('これ以上短くできません（最小0.3秒）');
    return;
  }
  subs = result.subs;
  setHint('クリップをトリムしました');
  renderTimeline();
  onChangeCallback();
}

function doMerge() {
  var idx = currentClipIndex();
  if (idx === -1) return;
  history = pushHistory(history, subs);
  var result = mergeClipAt(subs, idx);
  if (!result.ok) {
    history = history.slice(0, -1);
    setHint('最後のクリップは結合できません');
    return;
  }
  subs = result.subs;
  setHint('クリップを結合しました');
  renderTimeline();
  onChangeCallback();
}

function doDelete() {
  var idx = currentClipIndex();
  if (idx === -1) return;
  history = pushHistory(history, subs);
  var result = deleteClipAt(subs, idx);
  subs = result.subs;
  var total = totalDurationMs(subs);
  if (headTimeMs > total) headTimeMs = total;
  setHint('クリップを削除しました');
  renderTimeline();
  onChangeCallback();
}

// S: フォーカス中のトラックに応じてS操作を振り分ける(§3.1)。
function handleSKey() {
  if (focusedTrack === 'video' && videotrackUI.hasMaster()) doVideoSplit(); else doTrim();
}

// Delete: フォーカス中のトラックに応じてDelete操作を振り分ける(§3.1)。
function handleDeleteKey() {
  if (focusedTrack === 'video' && videotrackUI.hasMaster()) doVideoDelete(); else doDelete();
}

// S(動画トラック): 再生ヘッド位置で区間を分割する。字幕・映像とも変化しない(§3.2)。
function doVideoSplit() {
  history = pushHistory(history, { subs: subs, segments: videotrackUI.getSegments() });
  var result = videotrackUI.doSplit();
  if (!result.ok) {
    history = history.slice(0, -1);
    setHint('これ以上分割できません');
    return;
  }
  setHint('区間を分割しました');
  videotrackUI.renderVideoTrack();
  onChangeCallback();
}

// Delete(動画トラック): 区間をリップル削除し、字幕トラックを§3.4の規則で連動させる。
// subsとsegmentsの両方をUndo 1エントリとして一体で記録する(§3.4-4, §3.5)。
function doVideoDelete() {
  history = pushHistory(history, { subs: subs, segments: videotrackUI.getSegments() });
  var result = videotrackUI.doDelete();
  if (!result.ok) {
    history = history.slice(0, -1);
    setHint('最後の区間は削除できません');
    return;
  }
  subs = result.subs;
  var total = totalDurationMs(subs);
  if (headTimeMs > total) headTimeMs = total;
  setHint('区間を削除しました(字幕を連動して詰めました)');
  renderTimeline();
  videotrackUI.renderVideoTrack();
  onChangeCallback();
}

// Undo: 履歴には字幕トラックのみのスナップショット(配列)と、動画トラックを含む
// 操作のスナップショット({subs, segments})の2種類が混在しうるため、形で判別する。
function doUndo() {
  var restored = popHistory(history);
  if (!restored) {
    setHint('これ以上戻せません');
    return;
  }
  history = restored.stack;
  var popped = restored.subs;
  if (Array.isArray(popped)) {
    subs = popped;
  } else {
    subs = popped.subs;
    videotrackUI.restoreSegments(popped.segments);
    videotrackUI.renderVideoTrack();
  }
  var total = totalDurationMs(subs);
  if (headTimeMs > total) headTimeMs = total;
  setHint('元に戻しました');
  renderTimeline();
  onChangeCallback();
}

// 編集モーダル内のプレビュー(アラビア語本文の生入力に追随してリアルタイム更新)。
function updateModalPreview() {
  applySubtitleStyle(modalPreviewFrame, modalSafeGuide, modalPreviewSubtitleText, modalJudgeBadge, modalArabicText.value, 200);
}

function openEditModal(idx) {
  if (idx === -1) return;
  modalIndex = idx;
  modalOpen = true;
  var sub = subs[idx];
  modalArabicText.value = sub.text;
  modalEnglishText.value = sub.en;
  editModal.style.display = 'flex';
  updateModalPreview();
  modalArabicText.focus();
}

function closeEditModal() {
  editModal.style.display = 'none';
  modalOpen = false;
  modalIndex = -1;
}

function saveEditModal() {
  if (modalIndex === -1) return;
  var newText = modalArabicText.value;
  var newEn = modalEnglishText.value;
  var sub = subs[modalIndex];
  if (newText !== sub.text || newEn !== sub.en) {
    history = pushHistory(history, subs);
    var next = cloneSubs(subs);
    next[modalIndex].text = newText;
    next[modalIndex].en = newEn;
    next[modalIndex].edited = true;
    subs = next;
    setHint('テキストを編集しました');
    renderTimeline();
    onChangeCallback();
  }
  closeEditModal();
}

function showEditor() {
  stopPlayback();
  mode = 'edit';
  mainView.style.display = 'none';
  editorView.style.display = '';
  editorCps.value = String(currentCps);
  editorCpsValue.textContent = String(currentCps);
  setHint('');
  renderTimeline();
  onChangeCallback();
}

function enterEditMode() {
  var text = textarea.value;
  var translation = translationTextarea.value;
  var cps = parseFloat(cpsInput.value);

  if (hasTimelineState) {
    var unchanged = textEquals(text, reconstructManuscript(subs)) &&
      textEquals(translation, reconstructTranslation(subs));
    if (unchanged) {
      showEditor();
      return;
    }
    var ok = window.confirm('原稿または英訳が変更されています。タイムラインを再構築すると、手動調整した尺はリセットされます。よろしいですか？');
    if (!ok) return;
  }

  var segments = segmentManuscript(text);
  if (segments.length === 0) return;

  var enLines = splitEnglishLines(translation);
  subs = subsFromSegments(segments, cps, enLines);
  currentCps = (isFinite(cps) && cps > 0) ? cps : 12;
  history = [];
  headTimeMs = 0;
  hasTimelineState = true;
  showEditor();
}

function exitEditMode() {
  stopPlayback();
  textarea.value = reconstructManuscript(subs);
  translationTextarea.value = reconstructTranslation(subs);
  mode = 'input';
  editorView.style.display = 'none';
  mainView.style.display = '';
  render();
  onChangeCallback();
}

function downloadFromSubs() {
  if (subs.length === 0) return;
  downloadSrtContent(buildSrt(subsToCues(subs), bomCheckbox.checked));
}

function setZoom(newIndex) {
  newIndex = clampZoomIndex(newIndex);
  if (newIndex === zoomIndex) return;
  var oldPxPerSec = currentPxPerSec();
  var rect = timelineWrap.getBoundingClientRect();
  var scrollLeft = timelineWrap.scrollLeft;
  var viewWidth = rect.width;
  var headX = msToPx(headTimeMs, oldPxPerSec);

  var anchorMs, anchorScreenX;
  if (headX >= scrollLeft && headX <= scrollLeft + viewWidth) {
    anchorMs = headTimeMs;
    anchorScreenX = headX - scrollLeft;
  } else {
    var centerX = scrollLeft + viewWidth / 2;
    anchorMs = pxToMs(centerX, oldPxPerSec);
    anchorScreenX = viewWidth / 2;
  }

  zoomIndex = newIndex;
  renderTimeline();
  videotrackUI.renderVideoTrack();

  var newAnchorX = msToPx(anchorMs, currentPxPerSec());
  timelineWrap.scrollLeft = Math.max(0, newAnchorX - anchorScreenX);
  setHint('ズーム: ' + currentPxPerSec() + 'px/秒');
  onChangeCallback();
}
function zoomIn() { setZoom(zoomIndex + 1); }
function zoomOut() { setZoom(zoomIndex - 1); }

function refreshExportButtonState() {
  exportMp4Btn.disabled = editingLocked || !videotrackUI.hasMaster();
}

// 書き出し中は編集操作をロックする(§5.2-4)。タイムライン全体のポインタ操作も無効化する。
function lockEditing(locked) {
  editingLocked = locked;
  sBtn.disabled = locked;
  mBtn.disabled = locked;
  undoBtn.disabled = locked;
  backBtn.disabled = locked;
  downloadEditorBtn.disabled = locked || subs.length === 0;
  saveTimelineJsonBtn.disabled = locked;
  loadTimelineJsonBtn.disabled = locked;
  timelineWrap.style.pointerEvents = locked ? 'none' : '';
  videotrackUI.setLocked(locked);
  refreshExportButtonState();
}

function downloadBlob(blob, fileNamePrefix, ext) {
  var url = URL.createObjectURL(blob);
  var now = new Date();
  var fname = fileNamePrefix + '_' +
    now.getFullYear() + pad(now.getMonth() + 1, 2) + pad(now.getDate(), 2) + '_' +
    pad(now.getHours(), 2) + pad(now.getMinutes(), 2) + '.' + ext;
  var a = document.createElement('a');
  a.href = url;
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

// MP4書き出し(§5.1-5.2)。進捗はフレーム数ベースで更新し、キャンセル可能にする。
async function handleExportClick() {
  if (editingLocked || !videotrackUI.hasMaster()) return;
  var masterFile = videotrackUI.getMasterFile();
  if (!masterFile) {
    setHint('マスターファイルが利用できません。読み込み直してください。');
    return;
  }

  lockEditing(true);
  exportProgressRow.style.display = '';
  exportProgressBar.value = 0;
  exportProgressText.textContent = '音声を処理中...';
  var controller = new AbortController();
  exportAbortController = controller;

  try {
    var blob = await exportMp4({
      masterFile: masterFile,
      segments: videotrackUI.getSegments(),
      subs: subs,
      fontSize: fontSize,
      calibration: calibration,
      signal: controller.signal,
      onProgress: function (p) {
        if (p.phase === 'audio') {
          exportProgressText.textContent = '音声を処理中... ' + Math.round(p.ratio * 100) + '%';
        } else {
          exportProgressBar.value = p.ratio;
          exportProgressText.textContent = '映像を書き出し中... ' + Math.round(p.ratio * 100) + '%';
        }
      }
    });
    downloadBlob(blob, 'video', 'mp4');
    setHint('MP4書き出しが完了しました');
  } catch (err) {
    if (err && err.name === 'AbortError') {
      setHint('書き出しをキャンセルしました');
    } else {
      setHint('書き出しに失敗しました: ' + (err && err.message ? err.message : String(err)));
    }
  } finally {
    exportAbortController = null;
    exportProgressRow.style.display = 'none';
    lockEditing(false);
  }
}

// timeline.json保存(§5.4)。master/segments/subs/cps/styleのみを対象とする
// (原稿テキスト・翻訳・モード・ズーム等はlocalStorageセッションの管轄で、timeline.jsonには含めない)。
function saveTimelineJson() {
  var raw = serializeTimelineJson({
    master: videotrackUI.getMaster(),
    segments: videotrackUI.getSegments(),
    subs: subs,
    cps: currentCps,
    style: { fontSize: fontSize, calibration: calibration }
  });
  downloadBlob(new Blob([raw], { type: 'application/json' }), 'timeline', 'json');
}

// timeline.json読み込み(§5.4)。version不一致・スキーマ不正は読み込み拒否する。
// マスター本体はJSONに含まれないため、videotrackUI側で再選択待ちの状態にする。
function loadTimelineJsonFile(file) {
  var reader = new FileReader();
  reader.onload = function () {
    var data = deserializeTimelineJson(String(reader.result));
    if (!data) {
      setHint('timeline.jsonの読み込みに失敗しました(バージョン不一致または形式不正)');
      return;
    }

    history = [];
    subs = data.subs.map(function (c) {
      return { text: c.text, durMs: c.durMs, delim: c.delim, edited: c.edited, en: c.en };
    });
    hasTimelineState = subs.length > 0;
    currentCps = data.cps;
    editorCps.value = String(currentCps);
    editorCpsValue.textContent = String(currentCps);
    cpsInput.value = String(currentCps);
    calibration = clampCalibration(data.style.calibration);
    fontSize = data.style.fontSize;
    calibrationInput.value = String(calibration);
    calibrationValue.textContent = calibration.toFixed(2);
    fontSizeInput.value = String(fontSize);

    var total = totalDurationMs(subs);
    if (headTimeMs > total) headTimeMs = total;

    videotrackUI.applyTimelineJson(data.master, data.segments);

    renderTimeline();
    videotrackUI.renderVideoTrack();
    refreshExportButtonState();
    setHint('timeline.jsonを読み込みました' + (data.master ? '(マスターを再選択してください)' : ''));
    onChangeCallback();
  };
  reader.readAsText(file);
}

toTimelineBtn.addEventListener('click', enterEditMode);
backBtn.addEventListener('click', exitEditMode);
playPauseBtn.addEventListener('click', togglePlay);
upBtn.addEventListener('click', stepUp);
downBtn.addEventListener('click', stepDown);
sBtn.addEventListener('click', handleSKey);
mBtn.addEventListener('click', doMerge);
undoBtn.addEventListener('click', doUndo);
downloadEditorBtn.addEventListener('click', downloadFromSubs);
exportMp4Btn.addEventListener('click', handleExportClick);
exportCancelBtn.addEventListener('click', function () {
  if (exportAbortController) exportAbortController.abort();
});
saveTimelineJsonBtn.addEventListener('click', saveTimelineJson);
loadTimelineJsonBtn.addEventListener('click', function () {
  timelineJsonFileInput.click();
});
timelineJsonFileInput.addEventListener('change', function () {
  var file = timelineJsonFileInput.files[0];
  timelineJsonFileInput.value = '';
  if (!file) return;
  loadTimelineJsonFile(file);
});

ruler.addEventListener('click', function (e) {
  var rect = ruler.getBoundingClientRect();
  var offsetX = e.clientX - rect.left;
  seekTo(pxToMs(offsetX, currentPxPerSec()));
});

previewFrame.addEventListener('dblclick', function () {
  if (mode !== 'edit' || modalOpen) return;
  if (playing) stopPlayback();
  openEditModal(currentClipIndex());
});

modalCancelBtn.addEventListener('click', closeEditModal);
modalSaveBtn.addEventListener('click', saveEditModal);
modalArabicText.addEventListener('input', updateModalPreview);
modalAutoSplitBtn.addEventListener('click', function () {
  modalArabicText.value = autoSplitToTwoLines(modalArabicText.value, measureTextWidth1080);
  updateModalPreview();
});
modalCollapseBtn.addEventListener('click', function () {
  modalArabicText.value = collapseToOneLine(modalArabicText.value);
  updateModalPreview();
});
editModal.addEventListener('click', function (e) {
  if (e.target === editModal) closeEditModal();
});
editModal.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeEditModal();
  }
});

calibrationInput.addEventListener('input', function () {
  calibration = clampCalibration(parseFloat(calibrationInput.value));
  calibrationValue.textContent = calibration.toFixed(2);
  renderPreview();
  onChangeCallback();
});
fontSizeInput.addEventListener('input', function () {
  var v = parseFloat(fontSizeInput.value);
  if (isFinite(v) && v > 0) fontSize = v;
  renderPreview();
  onChangeCallback();
});

editorCps.addEventListener('input', function () {
  if (!cpsAdjusting) {
    cpsAdjusting = true;
    history = pushHistory(history, subs);
  }
  currentCps = parseFloat(editorCps.value);
  editorCpsValue.textContent = String(currentCps);
  cpsInput.value = String(currentCps);
  subs = recalcUneditedDurations(subs, currentCps);
  var total = totalDurationMs(subs);
  if (headTimeMs > total) headTimeMs = total;
  renderTimeline();
});
editorCps.addEventListener('change', function () {
  cpsAdjusting = false;
  setHint('読み速度を変更しました（編集済みクリップは変更されません）');
  onChangeCallback();
});

document.addEventListener('keydown', function (e) {
  if (mode !== 'edit' || modalOpen || editingLocked) return;

  if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    doUndo();
    return;
  }
  if (e.key === ' ' || e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    stepUp();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    stepDown();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    seekTo(headTimeMs - 100);
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    seekTo(headTimeMs + 100);
  } else if (e.key === 's' || e.key === 'S') {
    handleSKey();
  } else if (e.key === 'm' || e.key === 'M') {
    doMerge();
  } else if (e.key === 'x' || e.key === 'X') {
    zoomIn();
  } else if (e.key === 'z' || e.key === 'Z') {
    zoomOut();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    handleDeleteKey();
  }
});

videotrackUI.configure({
  getSubs: function () { return subs; },
  setSubs: function (next) { subs = next; },
  onSubsChanged: function () { relayout(); },
  pushHistorySnapshot: function () {
    history = pushHistory(history, { subs: subs, segments: videotrackUI.getSegments() });
  },
  getHeadTimeMs: function () { return headTimeMs; },
  seekTo: function (tMs) { seekTo(tMs); },
  currentPxPerSec: currentPxPerSec,
  onChange: function () { onChangeCallback(); },
  onFocusRequest: function (track) { setFocusedTrack(track); },
  onMasterLoaded: function () { refreshPlayheadUI(); refreshExportButtonState(); }
});
videotrackUI.getVideoElement().addEventListener('seeked', function () {
  if (mode === 'edit') renderPreview();
});
// マスター読み込み直後、初回フレームが実際にデコードされたタイミングで再描画する
// (loadMasterFile直後は同期的に読み込み中のため、drawImageが空振りすることがある)。
videotrackUI.getVideoElement().addEventListener('loadeddata', function () {
  if (mode === 'edit') renderPreview();
});
