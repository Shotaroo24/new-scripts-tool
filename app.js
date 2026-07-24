(function () {
  'use strict';

  // ---- DOM wiring ----
  var textarea = document.getElementById('manuscript');
  var translationTextarea = document.getElementById('translation');
  var cpsInput = document.getElementById('cps');
  var bomCheckbox = document.getElementById('bom');
  var downloadBtn = document.getElementById('downloadBtn');
  var toTimelineBtn = document.getElementById('toTimelineBtn');
  var previewList = document.getElementById('previewList');
  var emptyState = document.getElementById('emptyState');
  var alignmentWarningEl = document.getElementById('alignmentWarning');
  var statCount = document.getElementById('statCount');
  var statDuration = document.getElementById('statDuration');
  var restoreBanner = document.getElementById('restoreBanner');
  var newSessionBtn = document.getElementById('newSessionBtn');

  var currentCues = [];

  // 対応付け確認ビューの1行を構築する。シフト/詰めるは英訳側のみを操作する。
  function buildMappingRow(index, arabicText, enText, mismatchMsg) {
    var row = document.createElement('div');
    row.className = 'mapping-row' + (mismatchMsg ? ' mismatch' : '');

    var idxDiv = document.createElement('div');
    idxDiv.className = 'mapping-index';
    idxDiv.textContent = '#' + (index + 1);

    var arDiv = document.createElement('div');
    arDiv.className = 'mapping-arabic';
    arDiv.dir = 'rtl';
    arDiv.textContent = arabicText === null ? '(アラビア語なし)' : arabicText;

    var enDiv = document.createElement('div');
    if (enText) {
      enDiv.className = 'mapping-english';
      enDiv.textContent = enText;
    } else {
      enDiv.className = 'mapping-english mapping-english-empty';
      enDiv.textContent = '(空)';
    }

    var countDiv = document.createElement('div');
    countDiv.className = 'mapping-charcount';
    countDiv.textContent = arabicText === null ? '' : (charCountForText(arabicText) + '文字');

    row.appendChild(idxDiv);
    row.appendChild(arDiv);
    row.appendChild(enDiv);
    row.appendChild(countDiv);

    if (mismatchMsg) {
      var note = document.createElement('div');
      note.className = 'mapping-mismatch-note';
      note.textContent = mismatchMsg;
      row.appendChild(note);
    }

    var actions = document.createElement('div');
    actions.className = 'mapping-actions';

    var shiftBtn = document.createElement('button');
    shiftBtn.type = 'button';
    shiftBtn.textContent = 'ここから1つ下にずらす';
    shiftBtn.addEventListener('click', function () {
      var lines = splitEnglishLines(translationTextarea.value);
      translationTextarea.value = shiftEnglishDown(lines, index).join('\n');
      render();
      scheduleSave();
    });

    var compactBtn = document.createElement('button');
    compactBtn.type = 'button';
    compactBtn.textContent = 'ここを詰める';
    compactBtn.addEventListener('click', function () {
      var lines = splitEnglishLines(translationTextarea.value);
      translationTextarea.value = compactEnglish(lines, index).join('\n');
      render();
      scheduleSave();
    });

    actions.appendChild(shiftBtn);
    actions.appendChild(compactBtn);
    row.appendChild(actions);

    return row;
  }

  function render() {
    var text = textarea.value;
    var cps = parseFloat(cpsInput.value);
    var segments = segmentManuscript(text);
    currentCues = buildCues(segments, cps);

    var enLines = splitEnglishLines(translationTextarea.value);
    var arabicCount = segments.length;
    var enCount = enLines.length;
    var maxRows = Math.max(arabicCount, enCount);

    previewList.innerHTML = '';
    if (maxRows === 0) {
      emptyState.style.display = '';
      previewList.style.display = 'none';
      alignmentWarningEl.style.display = 'none';
    } else {
      emptyState.style.display = 'none';
      previewList.style.display = '';
      var frag = document.createDocumentFragment();
      for (var i = 0; i < maxRows; i++) {
        var arabicText = i < arabicCount ? segments[i].lines.join('\n') : null;
        var enText = i < enCount ? enLines[i] : '';
        var mismatchMsg = rowMismatchMessage(i, arabicCount, enCount);
        frag.appendChild(buildMappingRow(i, arabicText, enText, mismatchMsg));
      }
      previewList.appendChild(frag);

      var warning = buildAlignmentWarning(arabicCount, enCount);
      if (warning) {
        alignmentWarningEl.textContent = warning;
        alignmentWarningEl.style.display = '';
      } else {
        alignmentWarningEl.style.display = 'none';
      }
    }

    statCount.textContent = String(currentCues.length);
    var totalMs = currentCues.length ? currentCues[currentCues.length - 1].endMs : 0;
    statDuration.textContent = formatTotalDuration(totalMs);

    downloadBtn.disabled = currentCues.length === 0;
    toTimelineBtn.disabled = currentCues.length === 0;
  }

  // SRTファイルをBlobとしてダウンロードする(入力モード・編集モード共通)。
  function downloadSrtContent(content) {
    var blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);

    var now = new Date();
    var fname = 'subtitles_' +
      now.getFullYear() + pad(now.getMonth() + 1, 2) + pad(now.getDate(), 2) + '_' +
      pad(now.getHours(), 2) + pad(now.getMinutes(), 2) + '.srt';

    var a = document.createElement('a');
    a.href = url;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function download() {
    if (currentCues.length === 0) return;
    downloadSrtContent(buildSrt(currentCues, bomCheckbox.checked));
  }

  // ================= タイムライン編集モード: DOM wiring =================

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

  // ---- 永続化: 保存(300msデバウンス)・復元 ----
  var saveTimer = null;
  function scheduleSave() {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      persistSession();
    }, 300);
  }
  function persistSession() {
    try {
      var raw = serializeSession({
        manuscript: textarea.value,
        translation: translationTextarea.value,
        cps: currentCps,
        bom: bomCheckbox.checked,
        mode: mode,
        clips: subs,
        zoomIndex: zoomIndex,
        headTimeMs: headTimeMs,
        calibration: calibration,
        fontSize: fontSize
      });
      localStorage.setItem(STORAGE_KEY, raw);
    } catch (err) {
      // QuotaExceededError等は握りつぶす。保存に失敗してもアプリは継続動作する。
    }
  }

  function tryRestoreFromStorage() {
    var raw;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      return false;
    }
    if (!raw) return false;

    var data = deserializeSession(raw);
    if (!data) {
      try { localStorage.removeItem(STORAGE_KEY); } catch (err) { /* ignore */ }
      return false;
    }

    textarea.value = data.manuscript;
    translationTextarea.value = data.translation;
    cpsInput.value = String(data.cps);
    bomCheckbox.checked = data.bom;

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

    render();

    if (data.mode === 'edit' && subs.length > 0) {
      mode = 'edit';
      mainView.style.display = 'none';
      editorView.style.display = '';
      editorCps.value = String(currentCps);
      editorCpsValue.textContent = String(currentCps);
      renderTimeline();
    }

    return true;
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

  // 9:16実寸プレビューを更新する(再生ヘッド位置のクリップに追随)。
  function renderPreview() {
    var idx = currentClipIndex();
    var sub = idx === -1 ? null : subs[idx];
    applySubtitleStyle(previewFrame, previewSafeGuide, previewSubtitleText, previewJudgeBadge, sub ? sub.text : null, 320);
    previewTranslationText.textContent = sub ? sub.en : '';
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
        scheduleSave();
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
    scheduleSave();
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
    if (wasPlaying) scheduleSave();
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
    scheduleSave();
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
    scheduleSave();
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
    scheduleSave();
  }

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
    scheduleSave();
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
      scheduleSave();
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
    scheduleSave();
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
    scheduleSave();
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

    var newAnchorX = msToPx(anchorMs, currentPxPerSec());
    timelineWrap.scrollLeft = Math.max(0, newAnchorX - anchorScreenX);
    setHint('ズーム: ' + currentPxPerSec() + 'px/秒');
    scheduleSave();
  }
  function zoomIn() { setZoom(zoomIndex + 1); }
  function zoomOut() { setZoom(zoomIndex - 1); }

  toTimelineBtn.addEventListener('click', enterEditMode);
  backBtn.addEventListener('click', exitEditMode);
  playPauseBtn.addEventListener('click', togglePlay);
  upBtn.addEventListener('click', stepUp);
  downBtn.addEventListener('click', stepDown);
  sBtn.addEventListener('click', doTrim);
  mBtn.addEventListener('click', doMerge);
  undoBtn.addEventListener('click', doUndo);
  downloadEditorBtn.addEventListener('click', downloadFromSubs);

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
    scheduleSave();
  });
  fontSizeInput.addEventListener('input', function () {
    var v = parseFloat(fontSizeInput.value);
    if (isFinite(v) && v > 0) fontSize = v;
    renderPreview();
    scheduleSave();
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
    scheduleSave();
  });

  document.addEventListener('keydown', function (e) {
    if (mode !== 'edit' || modalOpen) return;

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
    } else if (e.key === 's' || e.key === 'S') {
      doTrim();
    } else if (e.key === 'm' || e.key === 'M') {
      doMerge();
    } else if (e.key === 'x' || e.key === 'X') {
      zoomIn();
    } else if (e.key === 'z' || e.key === 'Z') {
      zoomOut();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      doDelete();
    }
  });

  // ---- 入力モードの状態変更 -> 自動保存(300msデバウンス) ----
  textarea.addEventListener('input', function () {
    render();
    scheduleSave();
  });
  translationTextarea.addEventListener('input', function () {
    render();
    scheduleSave();
  });
  cpsInput.addEventListener('input', function () {
    render();
    scheduleSave();
  });
  bomCheckbox.addEventListener('change', function () {
    scheduleSave();
  });
  downloadBtn.addEventListener('click', download);

  // ---- 新規作成: localStorageを破棄して初期状態に戻す ----
  if (newSessionBtn) {
    newSessionBtn.addEventListener('click', function () {
      var ok = window.confirm('新規作成すると、保存されている内容(原稿・タイムライン調整内容)がすべて削除されます。よろしいですか？');
      if (!ok) return;
      try { localStorage.removeItem(STORAGE_KEY); } catch (err) { /* ignore */ }
      location.reload();
    });
  }

  // ---- 初期化: localStorageからの復元を試みる ----
  var restored = tryRestoreFromStorage();
  if (restored) {
    if (restoreBanner) restoreBanner.style.display = '';
  } else {
    render();
  }
})();
