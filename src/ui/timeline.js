// タイムライン編集モード: DOM wiring・字幕トラック操作・Undo

import {
  ZOOM_LEVELS, DEFAULT_ZOOM_INDEX, clipAt, computeStartsMs, totalDurationMs,
  formatClock, clampZoomIndex, msToPx, pxToMs, pickTickIntervalSec
} from '../core/time.js';
import { segmentManuscript } from '../core/segment.js';
import {
  subsFromSegments, cloneSubs, setClipDuration, trimClipAtHead, extendClipToHead, splitClipAtHead, mergeClipAt, deleteClipAt,
  recalcUneditedDurations, subsToCues, reconstructManuscript, textEquals,
  pushHistory, popHistory
} from '../core/subs.js';
import { isEditableTarget, resolveShortcutAction } from '../core/shortcuts.js';
import { formatNumberedClips, parseNumberedTranslation } from '../core/translation.js';
import { copyTextWithFallback } from './clipboard.js';
import {
  SAFE_WIDTH_1080, STROKE_WIDTH_AT_1080, FONT_SIZE_DEFAULT,
  CALIBRATION_DEFAULT, CALIBRATION_MIN, CALIBRATION_MAX, CALIBRATION_STEP,
  clampCalibration, measurementFontSize, previewFontSizePx, previewStrokeWidthPx,
  previewBaselineOffsetPx, previewSafeMargins, judgeLineCount, autoSplitToTwoLines, collapseToOneLine
} from '../core/style.js';
import {
  textarea, cpsInput, toTimelineBtn, render, downloadSrtContent, setTranslationsProvider,
  buildSrtForDownload
} from './manuscript.js';

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
var clipsTrack = document.getElementById('clipsTrack');
var playhead = document.getElementById('playhead');
var playbackRateBtn = document.getElementById('playbackRateBtn');
var copyNumberedBtn = document.getElementById('copyNumberedBtn');
var pasteTranslationBtn = document.getElementById('pasteTranslationBtn');
var previewHint = document.getElementById('previewHint');

var pasteModal = document.getElementById('pasteModal');
var pasteTextarea = document.getElementById('pasteTextarea');
var pasteApplyBtn = document.getElementById('pasteApplyBtn');
var pasteCancelBtn = document.getElementById('pasteCancelBtn');
var pasteResult = document.getElementById('pasteResult');

var editModal = document.getElementById('editModal');
var modalArabicText = document.getElementById('modalArabicText');
var modalEnglishText = document.getElementById('modalEnglishText');
var modalStaleBadge = document.getElementById('modalStaleBadge');
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
var selectedClipIndex = -1; // 選択中の字幕クリップ
var playbackRate = 1; // 1x/2x/3x(Lキーでサイクル)
var playbackJustEnded = false; // 再生が最後まで到達した直後は黒画面を表示する

var onChangeCallback = function () {};
var onTranslationAppliedCallback = function () {};

export function setOnChange(fn) {
  onChangeCallback = fn;
}

// 番号付き貼り付けが1件以上のクリップへ正常に適用された直後に1回だけ呼ばれる。
// legacyTranslationTextバナーの破棄判定(app.js)に使う。
export function setOnTranslationApplied(fn) {
  onTranslationAppliedCallback = fn;
}

// 保存用スナップショット(app.jsのpersistSessionから読み出される)。
export function getSessionSnapshot() {
  return {
    cps: currentCps,
    mode: mode,
    clips: subs,
    zoomIndex: zoomIndex,
    headTimeMs: headTimeMs,
    calibration: calibration,
    fontSize: fontSize
  };
}

// localStorageから復元したセッションのタイムライン部分を反映する(表示切り替えは含まない)。
export function setStateFromSession(data) {
  subs = data.clips.map(function (c) {
    return { text: c.text, durMs: c.durMs, delim: c.delim, edited: c.edited, translation: c.translation, translationStale: c.translationStale };
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
  updateDownloadEditorState();
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
var HANDLE_CLICK_THRESHOLD_PX = 3;

function currentPxPerSec() {
  return ZOOM_LEVELS[zoomIndex];
}

function setHint(msg) {
  editorHint.textContent = msg || '';
  if (previewHint) previewHint.textContent = msg || '';
}

function currentClipIndex() {
  return clipAt(subs, headTimeMs);
}

// 選択中の字幕クリップ(Delete・ダブルクリック編集等の対象)。
function clampSelectedClip() {
  if (subs.length === 0) {
    selectedClipIndex = -1;
  } else if (selectedClipIndex < 0 || selectedClipIndex >= subs.length) {
    selectedClipIndex = 0;
  }
}

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
  var clipEls = clipsTrack.children;
  for (var i = 0; i < clipEls.length; i++) {
    clipEls[i].classList.toggle('current', i === selectedClipIndex);
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

// renderPreviewの直近の描画内容(再生中は毎フレーム呼ばれるため、内容が変わって
// いなければDOM更新をスキップして再描画によるちらつきを防ぐ)。
var lastPreviewSubs = null;
var lastPreviewIdx = null;
var lastPreviewEnded = null;

// 9:16実寸プレビューを更新する(再生ヘッド位置のクリップに追随)。
function renderPreview() {
  var idx = currentClipIndex();

  if (subs === lastPreviewSubs && idx === lastPreviewIdx && playbackJustEnded === lastPreviewEnded) {
    return;
  }
  lastPreviewSubs = subs;
  lastPreviewIdx = idx;
  lastPreviewEnded = playbackJustEnded;

  var sub = idx === -1 ? null : subs[idx];

  if (playbackJustEnded) {
    previewSafeGuide.style.display = 'none';
    previewJudgeBadge.innerHTML = '';
    previewTranslationText.textContent = '';
    previewSubtitleText.style.display = 'none';
    previewFrame.style.background = '#000';
    return;
  }
  previewSafeGuide.style.display = '';
  previewFrame.style.background = '';
  previewSubtitleText.style.display = '';
  applySubtitleStyle(previewFrame, previewSafeGuide, previewSubtitleText, previewJudgeBadge, sub ? sub.text : null, 320);
  previewTranslationText.textContent = sub ? sub.translation : '';
}

// 再生ヘッド関連(位置・時刻表示・現在クリップ強調・プレビュー)をまとめて更新する。
function refreshPlayheadUI() {
  updatePlayheadPosition();
  updateCurrentHighlight();
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
  clampSelectedClip();
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
    enDiv.className = 'clip-en' + (sub.translation ? '' : ' clip-en-empty') + (sub.translationStale ? ' clip-en-stale' : '');
    enDiv.textContent = sub.translation || '英訳なし';

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
      dragState = { index: index, startX: e.clientX, startDurMs: subs[index].durMs, historyPushed: false };
    });
    handle.addEventListener('pointermove', function (e) {
      if (!dragState || dragState.index !== index) return;
      if (Math.abs(e.clientX - dragState.startX) < HANDLE_CLICK_THRESHOLD_PX) return;
      if (!dragState.historyPushed) {
        history = pushHistory(history, subs);
        dragState.historyPushed = true;
      }
      var deltaMs = pxToMs(e.clientX - dragState.startX, currentPxPerSec());
      subs = setClipDuration(subs, index, dragState.startDurMs + deltaMs);
      relayout();
    });
    handle.addEventListener('pointerup', function (e) {
      if (!dragState || dragState.index !== index) return;
      try { handle.releasePointerCapture(e.pointerId); } catch (err) { /* 未キャプチャの場合は何もしない */ }
      // ハンドル上でのpointerdown/upはclickイベントを発生させない(preventDefault済みのため)。
      // ほぼ動いていない場合はドラッグではなくクリックとみなし、その位置へシークする。
      // これがないと各クリップ右端10px(特に最後のクリップ)をクリックしてもプレイヘッドが動かせない。
      if (Math.abs(e.clientX - dragState.startX) < HANDLE_CLICK_THRESHOLD_PX) {
        var rect = clip.getBoundingClientRect();
        var offsetX = e.clientX - rect.left;
        selectedClipIndex = index;
        seekTo(starts[index] + pxToMs(offsetX, currentPxPerSec())); // seekTo内でonChangeCallbackが呼ばれる
        updateCurrentHighlight();
      } else {
        onChangeCallback();
      }
      dragState = null;
    });
    clip.addEventListener('click', function (e) {
      var rect = clip.getBoundingClientRect();
      var offsetX = e.clientX - rect.left;
      selectedClipIndex = index;
      seekTo(starts[index] + pxToMs(offsetX, currentPxPerSec()));
      updateCurrentHighlight();
    });
    clip.addEventListener('dblclick', function (e) {
      e.stopPropagation();
      if (modalOpen) return;
      if (playing) stopPlayback();
      selectedClipIndex = index;
      openEditModal(index);
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
  playbackJustEnded = false;
  // 再生中のシークは再生の基準点を打ち直す。これをしないと、次のrAFフレームで
  // playTickが古いplayStartHeadMs/playStartPerfからheadTimeMsを再計算し、
  // シークをなかったことにして巻き戻してしまう。
  if (playing) {
    playStartPerf = performance.now();
    playStartHeadMs = headTimeMs;
  }
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
  if (wasPlaying) onChangeCallback();
}

function playTick(now) {
  // startPlaybackの再入等で孤児化したチェーンが残っていても、playingがfalseに
  // なっていれば自ら終了する(rafIdの上書きによるゾンビループ化を防ぐ)。
  if (!playing) {
    rafId = null;
    return;
  }
  // rAFのコールバック引数(now)は、同じタスク内で直前にperformance.now()を呼んで
  // 記録したplayStartPerfより過去の値になることがある(startPlayback/シーク直後の
  // 最初のフレームで実測、ブラウザのタイムスタンプ計測タイミングに起因)。
  // 負のelapsedMsを許すとheadTimeMsがシーク先より前(直前のクリップ側)へ一瞬
  // 巻き戻り、プレビューに1つ前のクリップの本文が一瞬だけ表示されてしまう。
  // 再生位置はシーク基準点より後退しないため0未満をクランプする。
  var elapsedMs = Math.max(0, (now - playStartPerf) * playbackRate);
  var total = totalDurationMs(subs);
  var t = playStartHeadMs + elapsedMs;
  if (t >= total) {
    headTimeMs = total;
    playbackJustEnded = true;
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
  if (playing) return; // 再入ガード: 二重に呼ばれてもrafIdを上書きしてチェーンを孤児化させない
  if (subs.length === 0) return;
  var total = totalDurationMs(subs);
  if (headTimeMs >= total) headTimeMs = 0;
  playbackJustEnded = false;
  playing = true;
  playStartPerf = performance.now();
  playStartHeadMs = headTimeMs;
  updatePlayPauseIcon();
  rafId = requestAnimationFrame(playTick);
}

// L: 再生速度を1x→2x→3x→1xでサイクルする。
function cyclePlaybackRate() {
  playbackRate = playbackRate >= 3 ? 1 : playbackRate + 1;
  playbackRateBtn.textContent = playbackRate + 'x';
}

function togglePlay() {
  if (playing) stopPlayback(); else startPlayback();
}

function stepUp() {
  var idx = currentClipIndex();
  if (idx === -1) return;
  var starts = computeStartsMs(subs);
  if (headTimeMs - starts[idx] > HEAD_BACK_THRESHOLD_MS) {
    selectedClipIndex = idx;
    seekTo(starts[idx]);
  } else if (idx > 0) {
    selectedClipIndex = idx - 1;
    seekTo(starts[idx - 1]);
  } else {
    selectedClipIndex = 0;
    seekTo(0);
  }
}

function stepDown() {
  var idx = currentClipIndex();
  if (idx === -1) return;
  // 最後のクリップにいる場合、次のクリップ開始位置が存在しないため終端(最後のクリップの右端)へ進める。
  if (idx >= subs.length - 1) {
    selectedClipIndex = idx;
    seekTo(totalDurationMs(subs));
    return;
  }
  var starts = computeStartsMs(subs);
  selectedClipIndex = idx + 1;
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
  selectedClipIndex = idx;
  setHint('クリップをトリムしました');
  renderTimeline();
  onChangeCallback();
}

// N: ヘッドが乗っているクリップをヘッド位置で2つに分割する。テキスト・英訳は
// 分割せず両方に複製する(振り分けはこの後ユーザーが編集する想定)。
function doSplit() {
  var idx = currentClipIndex();
  if (idx === -1) return;
  history = pushHistory(history, subs);
  var result = splitClipAtHead(subs, idx, headTimeMs);
  if (!result.ok) {
    history = history.slice(0, -1);
    setHint('これ以上分割できません（最小0.3秒）');
    return;
  }
  subs = result.subs;
  selectedClipIndex = idx;
  setHint('クリップを分割しました');
  renderTimeline();
  onChangeCallback();
}

// D: 選択中のクリップ(ヘッドが乗っているクリップとは限らない)の終端を
// 再生ヘッドまで伸ばす。ヘッドが選択クリップの終端以前にある場合は拒否する。
function doExtendToHead() {
  var idx = selectedClipIndex;
  if (idx === -1 || idx >= subs.length) return;
  history = pushHistory(history, subs);
  var result = extendClipToHead(subs, idx, headTimeMs);
  if (!result.ok) {
    history = history.slice(0, -1);
    setHint('ヘッドが選択クリップの終端より前です（伸ばせません）');
    return;
  }
  subs = result.subs;
  setHint('クリップの終端をヘッドまで伸ばしました');
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
  selectedClipIndex = idx;
  setHint('クリップを結合しました');
  renderTimeline();
  onChangeCallback();
}

// 「番号付きでコピー」(§3): アラビア語本文を番号付きテキストとしてクリップボードへ出力する。
// 読み取り専用のため、原稿が空でない限り常に実行できる(タイムライン往復は不要)。
// subsが現在の原稿と一致していればsubsから(タイムラインでの分割/結合を尊重)、
// 一致していなければ現在の原稿をその場でsegmentManuscriptした結果から生成する。
function doCopyNumbered() {
  var text = textarea.value;
  var segments = segmentManuscript(text);
  if (segments.length === 0) return;

  var source = subsMatchesManuscript(text, segments.length)
    ? subs
    : segments.map(function (s) { return { text: s.lines.join('\n') }; });
  var numbered = formatNumberedClips(source);
  copyTextWithFallback(numbered).then(function (ok) {
    if (ok) setHint(source.length + '行をコピーしました');
  });
}

// 現在のsubsが、現在の原稿テキスト(text)・現在のセグメント分割(segmentCount)と
// 一致しているか。原稿を編集した後にタイムラインを再構築せずにいると、subsは
// 古い分割のまま残る(番号や件数が現在の画面表示とズレる)。
function subsMatchesManuscript(text, segmentCount) {
  return hasTimelineState && subs.length > 0 &&
    subs.length === segmentCount && textEquals(reconstructManuscript(subs), text);
}

// 入力画面(mainView)の右側クリップ一覧は、現在のsubsが現在の原稿テキストと
// 一致している場合に限り英訳を表示する(一致しない場合は再構築されておらず
// 対応が取れないため、表示しない)。
// 「番号付きでコピー」「英訳を貼り付け」ボタンの有効・無効はこれとは別判定にする
// (原稿が空でない限り常に有効。subsが未生成/staleな場合の扱いはdoCopyNumbered/
// openPasteModal側で分岐する。§1,2)。
// src/app.jsからmanuscript.setTranslationsProviderへ配線される。
function provideTranslationsForPreview(text, segmentCount) {
  copyNumberedBtn.disabled = segmentCount === 0;
  pasteTranslationBtn.disabled = segmentCount === 0;
  if (!subsMatchesManuscript(text, segmentCount)) return null;
  return subs.map(function (s) { return { translation: s.translation, translationStale: s.translationStale }; });
}
setTranslationsProvider(provideTranslationsForPreview);

// 英訳貼り付けモーダル(§4-6)。「照合」ボタンは廃止し、検証は「適用」の中で行う。
// 「空欄のみ埋める/すべて上書き」の2モードも廃止済み: 貼り付けに含まれる番号は常に上書き、
// 含まれない番号は現状維持する。

function formatNumberList(nums) {
  var shown = nums.slice(0, 10).map(function (n) { return '#' + n; }).join(' / ');
  return nums.length > 10 ? (shown + ' 他 ' + (nums.length - 10) + '件') : shown;
}

// 「英訳を貼り付け」(§2): subsの状態に応じてモーダルを開く前に分岐する。
// a. subsが現在の原稿と一致 -> そのまま開く
// b. subsが未生成(hasTimelineState===false) -> 確認なしでその場でsubsを生成
// c. subsはあるが現原稿と不一致(stale) -> enterEditModeと同じ確認ダイアログ。
//    キャンセルなら何もしない(モーダルを開かない)
// b/cでsubsを生成した直後は、textEqualsが偽のままだとボタンが再度無効化され
// 英訳プレビューも出ない罠になるため、原稿を正規化版へ書き戻してから開く(§3)。
function openPasteModal() {
  var text = textarea.value;
  var segments = segmentManuscript(text);
  if (segments.length === 0) return;

  if (!subsMatchesManuscript(text, segments.length)) {
    if (hasTimelineState) {
      var ok = window.confirm('原稿が変更されています。タイムラインを再構築すると、手動調整した尺・訳文はリセットされます。よろしいですか？');
      if (!ok) return;
    }
    if (!rebuildSubsFromManuscript(text, parseFloat(cpsInput.value))) return;
    textarea.value = reconstructManuscript(subs); // 正規化書き戻し(§3)
    render();
    onChangeCallback();
  }

  pasteTextarea.value = '';
  pasteResult.style.display = 'none';
  pasteResult.className = 'paste-result';
  modalOpen = true;
  pasteModal.style.display = 'flex';
  pasteTextarea.focus();
}

function closePasteModal() {
  pasteModal.style.display = 'none';
  modalOpen = false;
}

// 適用結果メッセージ(欠落・重複等は番号を名指しする。指示書: 「26件を適用しました。
// #12が欠落、#19が重複しています」)。
function buildApplyResultMessage(appliedCount, issues) {
  var subIssues = [];
  if (issues.missing.length > 0) subIssues.push(formatNumberList(issues.missing) + 'が欠落');
  if (issues.duplicate.length > 0) subIssues.push(formatNumberList(issues.duplicate) + 'が重複');
  if (issues.outOfRange.length > 0) subIssues.push(formatNumberList(issues.outOfRange) + 'が範囲外');
  if (issues.emptyBody.length > 0) subIssues.push(formatNumberList(issues.emptyBody) + 'が空本文');
  if (issues.preamble) subIssues.push('訳文以外のテキストが含まれています');

  if (appliedCount === 0) {
    return '適用できる訳文がありませんでした' + (subIssues.length > 0 ? '（' + subIssues.join('、') + '）' : '') + '。';
  }
  if (subIssues.length === 0) {
    return appliedCount + '件の訳文を適用しました。';
  }
  return appliedCount + '件を適用しました。' + subIssues.join('、') + 'しています。';
}

// 「適用」: 押下時点のtextareaの内容を再パースしてから適用する(プレビュー結果の
// キャッシュは使わない)。以下の順序で必ず実行する:
// 1. 再パース 2. クリップのtranslation/translationStaleを更新 3. 永続化
// 4. クリップ一覧・タイムラインを正本のstateから全再描画 5. モーダルを閉じる
// (欠落・重複・空本文があっても、正常にパースできた番号は適用し、全体を中断しない)
function doPasteApply() {
  var parsed = parseNumberedTranslation(pasteTextarea.value, subs.length);
  var issues = parsed.issues;
  var entries = parsed.entries;
  var outOfRangeSet = {};
  issues.outOfRange.forEach(function (n) { outOfRangeSet[n] = true; });

  history = pushHistory(history, subs);
  var next = cloneSubs(subs);
  var appliedCount = 0;
  for (var i = 0; i < next.length; i++) {
    var num = i + 1;
    if (outOfRangeSet[num] || !entries.has(num)) continue;
    next[i].translation = entries.get(num);
    next[i].translationStale = false;
    appliedCount++;
  }

  var message = buildApplyResultMessage(appliedCount, issues);

  if (appliedCount === 0) {
    history = history.slice(0, -1);
    pasteResult.textContent = message;
    pasteResult.className = 'paste-result danger';
    pasteResult.style.display = '';
    setHint(message);
    return; // 何も適用できなかった場合はモーダルを開いたまま、textareaを修正できるようにする
  }

  subs = next; // 2. クリップへ反映(正本のstateを更新)
  onChangeCallback(); // 3. 永続化(既存の状態変更保存経路。300msデバウンス)
  if (mode === 'edit') renderTimeline(); else render(); // 4. 正本のstateから全再描画
  onTranslationAppliedCallback();
  setHint(message);
  closePasteModal(); // 5. モーダルを閉じる
}

// Delete: 選択中の字幕クリップを削除する。
function doDelete() {
  var idx = selectedClipIndex;
  if (idx === -1 || idx >= subs.length) return;
  history = pushHistory(history, subs);
  var result = deleteClipAt(subs, idx);
  subs = result.subs;
  clampSelectedClip();
  var total = totalDurationMs(subs);
  if (headTimeMs > total) headTimeMs = total;
  setHint('クリップを削除しました');
  renderTimeline();
  onChangeCallback();
}

// Undo: 字幕トラックのスナップショット(配列)を1段階戻す。
function doUndo() {
  var restored = popHistory(history);
  if (!restored) {
    setHint('これ以上戻せません');
    return;
  }
  history = restored.stack;
  subs = restored.subs;
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
  modalEnglishText.value = sub.translation;
  modalStaleBadge.style.display = sub.translationStale ? '' : 'none';
  editModal.style.display = 'flex';
  updateModalPreview();
  modalArabicText.focus();
}

function closeEditModal() {
  editModal.style.display = 'none';
  modalOpen = false;
  modalIndex = -1;
}

// translationStale(要再訳)の追従(指示書3節5): アラビア語のみ変更 -> stale化、
// 英訳のみ変更 -> stale解除、両方変更 -> stale解除(英訳が更新されたとみなす)。
function saveEditModal() {
  if (modalIndex === -1) return;
  var newText = modalArabicText.value;
  var newTranslation = modalEnglishText.value;
  var sub = subs[modalIndex];
  var textChanged = newText !== sub.text;
  var translationChanged = newTranslation !== sub.translation;
  if (textChanged || translationChanged) {
    history = pushHistory(history, subs);
    var next = cloneSubs(subs);
    next[modalIndex].text = newText;
    next[modalIndex].translation = newTranslation;
    next[modalIndex].edited = true;
    if (translationChanged) {
      next[modalIndex].translationStale = false;
    } else if (textChanged) {
      next[modalIndex].translationStale = true;
    }
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

// 原稿からsubsを新規生成する(タイムライン生成/再構築の共通処理)。
// 呼び出し側で「未生成」「原稿が変更された(要確認)」の判定・確認ダイアログを
// 済ませてから呼ぶこと。生成できた場合はtrueを返す(原稿が空ならfalse)。
function rebuildSubsFromManuscript(text, cps) {
  var segments = segmentManuscript(text);
  if (segments.length === 0) return false;

  subs = subsFromSegments(segments, cps);
  currentCps = (isFinite(cps) && cps > 0) ? cps : 12;
  history = [];
  headTimeMs = 0;
  hasTimelineState = true;
  return true;
}

function enterEditMode() {
  var text = textarea.value;
  var cps = parseFloat(cpsInput.value);

  if (hasTimelineState) {
    var unchanged = textEquals(text, reconstructManuscript(subs));
    if (unchanged) {
      showEditor();
      return;
    }
    var ok = window.confirm('原稿が変更されています。タイムラインを再構築すると、手動調整した尺・訳文はリセットされます。よろしいですか？');
    if (!ok) return;
  }

  if (!rebuildSubsFromManuscript(text, cps)) return;
  showEditor();
}

function exitEditMode() {
  stopPlayback();
  textarea.value = reconstructManuscript(subs);
  mode = 'input';
  editorView.style.display = 'none';
  mainView.style.display = '';
  render();
  onChangeCallback();
}

function downloadFromSubs() {
  if (subs.length === 0) return;
  downloadSrtContent(buildSrtForDownload(subsToCues(subs)));
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

  var newAnchorX = msToPx(anchorMs, currentPxPerSec());
  timelineWrap.scrollLeft = Math.max(0, newAnchorX - anchorScreenX);
  setHint('ズーム: ' + currentPxPerSec() + 'px/秒');
  onChangeCallback();
}
function zoomIn() { setZoom(zoomIndex + 1); }
function zoomOut() { setZoom(zoomIndex - 1); }

toTimelineBtn.addEventListener('click', enterEditMode);
backBtn.addEventListener('click', exitEditMode);
playPauseBtn.addEventListener('click', togglePlay);
playbackRateBtn.addEventListener('click', cyclePlaybackRate);
upBtn.addEventListener('click', stepUp);
downBtn.addEventListener('click', stepDown);
sBtn.addEventListener('click', doTrim);
mBtn.addEventListener('click', doMerge);
undoBtn.addEventListener('click', doUndo);
copyNumberedBtn.addEventListener('click', doCopyNumbered);
pasteTranslationBtn.addEventListener('click', openPasteModal);
pasteApplyBtn.addEventListener('click', doPasteApply);
pasteCancelBtn.addEventListener('click', closePasteModal);
pasteTextarea.addEventListener('input', function () {
  pasteResult.style.display = 'none';
});
downloadEditorBtn.addEventListener('click', downloadFromSubs);

ruler.addEventListener('click', function (e) {
  var rect = ruler.getBoundingClientRect();
  var offsetX = e.clientX - rect.left;
  seekTo(pxToMs(offsetX, currentPxPerSec()));
});

previewFrame.addEventListener('dblclick', function () {
  if (mode !== 'edit' || modalOpen) return;
  if (playing) stopPlayback();
  var idx = currentClipIndex();
  selectedClipIndex = idx;
  openEditModal(idx);
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
  if (mode !== 'edit' || modalOpen) return;
  if (isEditableTarget(e.target)) return;

  if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    doUndo();
    return;
  }
  if (e.key === ' ' || e.code === 'Space') {
    e.preventDefault();
    togglePlay();
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    stepUp();
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    stepDown();
    return;
  }
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    seekTo(headTimeMs - 100);
    return;
  }
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    seekTo(headTimeMs + 100);
    return;
  }

  var action = resolveShortcutAction(e.key);
  if (action === 'delete') {
    e.preventDefault();
    doDelete();
  } else if (action === 'trim') {
    doTrim();
  } else if (action === 'split') {
    doSplit();
  } else if (action === 'extendToHead') {
    doExtendToHead();
  } else if (action === 'merge') {
    doMerge();
  } else if (action === 'cyclePlaybackRate') {
    cyclePlaybackRate();
  } else if (action === 'zoomIn') {
    zoomIn();
  } else if (action === 'zoomOut') {
    zoomOut();
  }
});
