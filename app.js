(function () {
  'use strict';

  // SRT改行コード。Filmora実機テストでCRLFが必要な場合はここを '\r\n' に変更する。
  var LINE_BREAK = '\n';

  var DELETE_CHARS = new Set(['.', '،', ',', '—']); // . 、 ،  、 , 、 —
  var KEEP_CHARS = new Set(['؟', '?', '!']); // ؟ ? !

  function isDelimiter(ch) {
    return DELETE_CHARS.has(ch) || KEEP_CHARS.has(ch);
  }

  // 原稿テキストを「字幕ごとの行配列」の配列に分割する。
  // 許可される加工は: 区切り文字(削除系)の削除 / 各行の前後トリム / 改行による2行字幕化 のみ。
  function segmentManuscript(text) {
    var chars = Array.from(text);
    var n = chars.length;
    var rawSubtitles = [];
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
        while (i < n && isDelimiter(chars[i])) {
          if (KEEP_CHARS.has(chars[i])) keepBuffer += chars[i];
          i++;
        }
        currentLine += keepBuffer;
        currentLines.push(currentLine);
        rawSubtitles.push(currentLines);
        currentLine = '';
        currentLines = [];
        continue;
      }

      currentLine += ch;
      i++;
    }

    currentLines.push(currentLine);
    rawSubtitles.push(currentLines);

    var subtitles = [];
    for (var s = 0; s < rawSubtitles.length; s++) {
      var trimmed = [];
      for (var l = 0; l < rawSubtitles[s].length; l++) {
        var t = rawSubtitles[s][l].trim();
        if (t.length > 0) trimmed.push(t);
      }
      if (trimmed.length > 0) subtitles.push(trimmed);
    }
    return subtitles;
  }

  // 累積丸め方式でキュー（連番・開始/終了ms・行・文字数）を構築する。
  function buildCues(lineGroups, cps) {
    var rate = (isFinite(cps) && cps > 0) ? cps : 12;
    var accSeconds = 0;
    var cues = [];
    for (var idx = 0; idx < lineGroups.length; idx++) {
      var lines = lineGroups[idx];
      var charCount = 0;
      for (var l = 0; l < lines.length; l++) charCount += Array.from(lines[l]).length;
      var duration = charCount / rate;

      var startMs = Math.round(accSeconds * 1000);
      accSeconds += duration;
      var endMs = Math.round(accSeconds * 1000);

      cues.push({ index: idx + 1, lines: lines, charCount: charCount, startMs: startMs, endMs: endMs });
    }
    return cues;
  }

  function pad(num, len) {
    return String(num).padStart(len, '0');
  }

  function formatSrtTime(ms) {
    ms = Math.max(0, Math.round(ms));
    var h = Math.floor(ms / 3600000); ms -= h * 3600000;
    var m = Math.floor(ms / 60000); ms -= m * 60000;
    var s = Math.floor(ms / 1000); ms -= s * 1000;
    return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2) + ',' + pad(ms, 3);
  }

  function formatTotalDuration(ms) {
    ms = Math.max(0, Math.round(ms));
    var minutes = Math.floor(ms / 60000);
    var secs = (ms % 60000) / 1000;
    var secsStr = secs.toFixed(1);
    if (secsStr.indexOf('.') === 1) secsStr = '0' + secsStr;
    return pad(minutes, 2) + ':' + secsStr;
  }

  function buildSrt(cues, useBom) {
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

  // ================= タイムライン編集モード: 純粋ロジック =================
  //
  // 内部の時間計算はすべて「デシ秒（0.1秒単位の整数）」で行う。
  // sub.dur 自体は秒(浮動小数)で保持するが、累積・比較・SRTのms変換は
  // 必ず toDs() で整数化してから行うため、0.1+0.2!==0.3 のような
  // 浮動小数の誤差が積み上がることがない。

  var MIN_DUR = 0.3; // 秒
  var PX_PER_SEC = 80;

  function toDs(seconds) {
    return Math.round(seconds * 10);
  }
  function dsToSeconds(ds) {
    return ds / 10;
  }
  function round1(seconds) {
    return dsToSeconds(toDs(seconds));
  }
  function clampDur(seconds) {
    return Math.max(MIN_DUR, round1(seconds));
  }

  // 改行を除き、スペース込み・コードポイント単位で文字数を数える(既存の cps 計算方式と同一)。
  function charCountForText(text) {
    var lines = text.split('\n');
    var count = 0;
    for (var i = 0; i < lines.length; i++) count += Array.from(lines[i]).length;
    return count;
  }

  // 生成: 既存の分割ロジック(lineGroups)から編集モード用の subs を組み立てる。
  // dur は 0.1丸め・最小0.3秒クランプ。全クリップ edited:false。
  function subsFromLineGroups(lineGroups, cps) {
    var rate = (isFinite(cps) && cps > 0) ? cps : 12;
    var subs = [];
    for (var i = 0; i < lineGroups.length; i++) {
      var text = lineGroups[i].join('\n');
      var charCount = charCountForText(text);
      subs.push({ text: text, dur: clampDur(charCount / rate), edited: false });
    }
    return subs;
  }

  // 各クリップの開始時刻をデシ秒の整数配列で返す(累積誤差なし)。
  function computeStartsDs(subs) {
    var starts = [];
    var acc = 0;
    for (var i = 0; i < subs.length; i++) {
      starts.push(acc);
      acc += toDs(subs[i].dur);
    }
    return starts;
  }
  function computeStarts(subs) {
    return computeStartsDs(subs).map(dsToSeconds);
  }
  function totalDurationDs(subs) {
    var acc = 0;
    for (var i = 0; i < subs.length; i++) acc += toDs(subs[i].dur);
    return acc;
  }
  function totalDuration(subs) {
    return dsToSeconds(totalDurationDs(subs));
  }

  // 時刻 t(秒, 連続値)が属するクリップのindexを返す。tはデシ秒に丸めてから
  // 整数のみで比較するため、境界判定に浮動小数の誤差が入らない。
  function clipAt(subs, t) {
    var n = subs.length;
    if (n === 0) return -1;
    var startsDs = computeStartsDs(subs);
    var totalDs = totalDurationDs(subs);
    var tDs = Math.round(t * 10);
    if (tDs <= 0) return 0;
    if (tDs >= totalDs) return n - 1;
    for (var i = 0; i < n; i++) {
      var endDs = (i < n - 1) ? startsDs[i + 1] : totalDs;
      if (tDs < endDs) return i;
    }
    return n - 1;
  }

  function cloneSubs(subs) {
    var out = [];
    for (var i = 0; i < subs.length; i++) {
      out.push({ text: subs[i].text, dur: subs[i].dur, edited: subs[i].edited });
    }
    return out;
  }

  // ドラッグ等による尺の直接指定。常に成功し、0.1丸め・最小0.3秒でクランプする。
  function setClipDuration(subs, index, rawDurSeconds) {
    var next = cloneSubs(subs);
    next[index].dur = clampDur(rawDurSeconds);
    next[index].edited = true;
    return next;
  }

  // S: ヘッドが乗っているクリップの尺を (headTime - クリップ開始時刻) に変更する。
  // 結果が最小尺(0.3秒)未満なら拒否して元の配列を返す。
  function trimClipAtHead(subs, index, headTime) {
    var startsDs = computeStartsDs(subs);
    var newDurDs = Math.round(headTime * 10) - startsDs[index];
    if (newDurDs < toDs(MIN_DUR)) {
      return { ok: false, subs: subs };
    }
    var next = cloneSubs(subs);
    next[index].dur = dsToSeconds(newDurDs);
    next[index].edited = true;
    return { ok: true, subs: next };
  }

  // M: index番目と右隣(index+1)を結合する。テキストは半角スペース連結、尺は合算。
  // 最終クリップ(右隣が存在しない)なら拒否。
  function mergeClipAt(subs, index) {
    if (index < 0 || index >= subs.length - 1) {
      return { ok: false, subs: subs };
    }
    var next = cloneSubs(subs);
    var a = next[index];
    var b = next[index + 1];
    var mergedDurDs = toDs(a.dur) + toDs(b.dur);
    var merged = { text: a.text + ' ' + b.text, dur: dsToSeconds(mergedDurDs), edited: true };
    next.splice(index, 2, merged);
    return { ok: true, subs: next };
  }

  // Delete: index番目のクリップを削除する。残存クリップの edited フラグには影響しない。
  function deleteClipAt(subs, index) {
    if (index < 0 || index >= subs.length) {
      return { ok: false, subs: subs };
    }
    var next = cloneSubs(subs);
    next.splice(index, 1);
    return { ok: true, subs: next };
  }

  // cps変更: edited:false のクリップのみ、自身のテキストの文字数から尺を再計算する。
  // edited:true のクリップは一切変更しない。
  function recalcUneditedDurations(subs, cps) {
    var rate = (isFinite(cps) && cps > 0) ? cps : 12;
    return subs.map(function (sub) {
      if (sub.edited) return sub;
      var charCount = charCountForText(sub.text);
      return { text: sub.text, dur: clampDur(charCount / rate), edited: false };
    });
  }

  // SRT出力用のcues生成。dur は必ず0.1刻みのため、デシ秒の整数累積は
  // Math.round(累積秒×1000) と数学的に完全に一致し、かつ浮動小数誤差が一切入らない。
  function subsToCues(subs) {
    var cues = [];
    var accDs = 0;
    for (var i = 0; i < subs.length; i++) {
      var startMs = accDs * 100;
      accDs += toDs(subs[i].dur);
      var endMs = accDs * 100;
      cues.push({ index: i + 1, lines: subs[i].text.split('\n'), startMs: startMs, endMs: endMs });
    }
    return cues;
  }

  // Undo: 操作前の subs のディープコピーをスタックにpushする。上限50件(古いものから破棄)。
  var HISTORY_LIMIT = 50;
  function pushHistory(stack, subs) {
    var next = stack.slice();
    next.push(JSON.parse(JSON.stringify(subs)));
    if (next.length > HISTORY_LIMIT) next.shift();
    return next;
  }
  function popHistory(stack) {
    if (stack.length === 0) return null;
    var next = stack.slice();
    var subs = next.pop();
    return { stack: next, subs: subs };
  }

  function formatClock(seconds) {
    seconds = Math.max(0, seconds);
    var totalDs = Math.round(seconds * 10);
    var m = Math.floor(totalDs / 600);
    var rem = totalDs - m * 600;
    var s = Math.floor(rem / 10);
    var d = rem % 10;
    return m + ':' + pad(s, 2) + '.' + d;
  }

  // ---- DOM wiring ----
  var textarea = document.getElementById('manuscript');
  var cpsInput = document.getElementById('cps');
  var bomCheckbox = document.getElementById('bom');
  var downloadBtn = document.getElementById('downloadBtn');
  var toTimelineBtn = document.getElementById('toTimelineBtn');
  var previewList = document.getElementById('previewList');
  var emptyState = document.getElementById('emptyState');
  var statCount = document.getElementById('statCount');
  var statDuration = document.getElementById('statDuration');

  var currentCues = [];

  function buildCard(cue) {
    var card = document.createElement('div');
    card.className = 'cue-card';

    var meta = document.createElement('div');
    meta.className = 'cue-meta';

    var idxSpan = document.createElement('span');
    idxSpan.className = 'cue-index';
    idxSpan.textContent = '#' + cue.index;

    var timeSpan = document.createElement('span');
    timeSpan.className = 'cue-time';
    timeSpan.textContent = formatSrtTime(cue.startMs) + ' → ' + formatSrtTime(cue.endMs);

    var charSpan = document.createElement('span');
    charSpan.className = 'cue-chars';
    charSpan.textContent = cue.charCount + '文字';

    meta.appendChild(idxSpan);
    meta.appendChild(timeSpan);
    meta.appendChild(charSpan);

    var body = document.createElement('div');
    body.className = 'cue-text';
    body.dir = 'rtl';
    body.textContent = cue.lines.join('\n');

    card.appendChild(meta);
    card.appendChild(body);
    return card;
  }

  function render() {
    var text = textarea.value;
    var cps = parseFloat(cpsInput.value);
    var lineGroups = segmentManuscript(text);
    currentCues = buildCues(lineGroups, cps);

    previewList.innerHTML = '';
    if (currentCues.length === 0) {
      emptyState.style.display = '';
      previewList.style.display = 'none';
    } else {
      emptyState.style.display = 'none';
      previewList.style.display = '';
      var frag = document.createDocumentFragment();
      for (var i = 0; i < currentCues.length; i++) {
        frag.appendChild(buildCard(currentCues[i]));
      }
      previewList.appendChild(frag);
    }

    statCount.textContent = String(currentCues.length);
    var totalMs = currentCues.length ? currentCues[currentCues.length - 1].endMs : 0;
    statDuration.textContent = formatTotalDuration(totalMs);

    downloadBtn.disabled = currentCues.length === 0;
    toTimelineBtn.disabled = currentCues.length === 0;
  }

  function download() {
    if (currentCues.length === 0) return;
    var content = buildSrt(currentCues, bomCheckbox.checked);
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

  textarea.addEventListener('input', render);
  cpsInput.addEventListener('input', render);
  downloadBtn.addEventListener('click', download);

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
  var previewBox = document.getElementById('previewBox');
  var timelineWrap = document.getElementById('timelineWrap');
  var timelineInner = document.getElementById('timelineInner');
  var ruler = document.getElementById('ruler');
  var clipsTrack = document.getElementById('clipsTrack');
  var playhead = document.getElementById('playhead');

  var mode = 'input'; // 'input' | 'edit'
  var subs = [];
  var history = [];
  var headTime = 0;
  var playing = false;
  var rafId = null;
  var playStartPerf = 0;
  var playStartHead = 0;
  var currentCps = 12;
  var editingText = false;
  var dragState = null;
  var cpsAdjusting = false;

  var HEAD_BACK_THRESHOLD = 0.15;
  var AUTOSCROLL_MARGIN = 60;

  function setHint(msg) {
    editorHint.textContent = msg || '';
  }

  function currentClipIndex() {
    return clipAt(subs, headTime);
  }

  function renderRuler(widthPx, total) {
    ruler.innerHTML = '';
    ruler.style.width = widthPx + 'px';
    var secs = Math.ceil(total);
    var frag = document.createDocumentFragment();
    for (var s = 0; s <= secs; s++) {
      var tick = document.createElement('div');
      tick.className = 'ruler-tick';
      tick.style.left = (s * PX_PER_SEC) + 'px';
      tick.textContent = s + 's';
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
    playhead.style.transform = 'translateX(' + (headTime * PX_PER_SEC) + 'px)';
    timeDisplay.textContent = formatClock(headTime) + ' / ' + formatClock(totalDuration(subs));
  }

  function renderPreview() {
    if (editingText) return;
    var idx = currentClipIndex();
    previewBox.innerHTML = '';
    var div = document.createElement('div');
    div.className = 'preview-text';
    div.dir = 'rtl';
    div.textContent = idx === -1 ? '' : subs[idx].text;
    previewBox.appendChild(div);
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
    var total = totalDuration(subs);
    var widthPx = Math.max(total * PX_PER_SEC, 1);
    timelineInner.style.width = widthPx + 'px';
    clipsTrack.style.width = widthPx + 'px';
    renderRuler(widthPx, total);
    var clipEls = clipsTrack.children;
    for (var i = 0; i < subs.length; i++) {
      clipEls[i].style.width = (subs[i].dur * PX_PER_SEC) + 'px';
      clipEls[i].querySelector('.clip-dur').textContent = subs[i].dur.toFixed(1) + 's';
      clipEls[i].classList.toggle('edited', subs[i].edited);
    }
    refreshPlayheadUI();
  }

  // 構造(枚数・テキスト)が変わった場合のフル再構築。
  function renderTimeline() {
    var total = totalDuration(subs);
    var widthPx = Math.max(total * PX_PER_SEC, 1);
    timelineInner.style.width = widthPx + 'px';
    clipsTrack.style.width = widthPx + 'px';
    renderRuler(widthPx, total);

    clipsTrack.innerHTML = '';
    var starts = computeStarts(subs);
    var frag = document.createDocumentFragment();

    subs.forEach(function (sub, index) {
      var clip = document.createElement('div');
      clip.className = 'clip' + (sub.edited ? ' edited' : '');
      clip.style.width = (sub.dur * PX_PER_SEC) + 'px';

      var textDiv = document.createElement('div');
      textDiv.className = 'clip-text';
      textDiv.dir = 'rtl';
      textDiv.textContent = sub.text.replace(/\n/g, ' ');

      var durDiv = document.createElement('div');
      durDiv.className = 'clip-dur';
      durDiv.textContent = sub.dur.toFixed(1) + 's';

      var handle = document.createElement('div');
      handle.className = 'clip-handle';

      clip.appendChild(textDiv);
      clip.appendChild(durDiv);
      clip.appendChild(handle);
      frag.appendChild(clip);

      handle.addEventListener('pointerdown', function (e) {
        e.stopPropagation();
        e.preventDefault();
        try { handle.setPointerCapture(e.pointerId); } catch (err) { /* キャプチャ失敗時もハンドル上でのドラッグ自体は継続できる */ }
        history = pushHistory(history, subs);
        dragState = { index: index, startX: e.clientX, startDur: subs[index].dur };
      });
      handle.addEventListener('pointermove', function (e) {
        if (!dragState || dragState.index !== index) return;
        var deltaSec = (e.clientX - dragState.startX) / PX_PER_SEC;
        subs = setClipDuration(subs, index, dragState.startDur + deltaSec);
        relayout();
      });
      handle.addEventListener('pointerup', function (e) {
        if (!dragState || dragState.index !== index) return;
        try { handle.releasePointerCapture(e.pointerId); } catch (err) { /* 未キャプチャの場合は何もしない */ }
        dragState = null;
      });
      clip.addEventListener('click', function (e) {
        var rect = clip.getBoundingClientRect();
        var offsetX = e.clientX - rect.left;
        seekTo(starts[index] + offsetX / PX_PER_SEC);
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
    var x = headTime * PX_PER_SEC;
    var viewLeft = timelineWrap.scrollLeft;
    var viewWidth = timelineWrap.clientWidth;
    if (x > viewLeft + viewWidth - AUTOSCROLL_MARGIN) {
      timelineWrap.scrollLeft = x - viewWidth + AUTOSCROLL_MARGIN;
    } else if (x < viewLeft + AUTOSCROLL_MARGIN) {
      timelineWrap.scrollLeft = Math.max(0, x - AUTOSCROLL_MARGIN);
    }
  }

  function seekTo(t) {
    var total = totalDuration(subs);
    headTime = Math.max(0, Math.min(total, t));
    refreshPlayheadUI();
    autoScrollToPlayhead();
  }

  function updatePlayPauseIcon() {
    playPauseBtn.textContent = playing ? '⏸' : '▶';
  }

  function stopPlayback() {
    playing = false;
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
    updatePlayPauseIcon();
  }

  function playTick(now) {
    var elapsed = (now - playStartPerf) / 1000;
    var total = totalDuration(subs);
    var t = playStartHead + elapsed;
    if (t >= total) {
      headTime = total;
      refreshPlayheadUI();
      autoScrollToPlayhead();
      stopPlayback();
      return;
    }
    headTime = t;
    refreshPlayheadUI();
    autoScrollToPlayhead();
    rafId = requestAnimationFrame(playTick);
  }

  function startPlayback() {
    if (subs.length === 0) return;
    var total = totalDuration(subs);
    if (headTime >= total) headTime = 0;
    playing = true;
    playStartPerf = performance.now();
    playStartHead = headTime;
    updatePlayPauseIcon();
    rafId = requestAnimationFrame(playTick);
  }

  function togglePlay() {
    if (playing) stopPlayback(); else startPlayback();
  }

  function stepUp() {
    var idx = currentClipIndex();
    if (idx === -1) return;
    var starts = computeStarts(subs);
    if (headTime - starts[idx] > HEAD_BACK_THRESHOLD) {
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
    var starts = computeStarts(subs);
    seekTo(starts[idx + 1]);
  }

  function doTrim() {
    var idx = currentClipIndex();
    if (idx === -1) return;
    history = pushHistory(history, subs);
    var result = trimClipAtHead(subs, idx, headTime);
    if (!result.ok) {
      history = history.slice(0, -1);
      setHint('これ以上短くできません（最小0.3秒）');
      return;
    }
    subs = result.subs;
    setHint('クリップをトリムしました');
    renderTimeline();
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
  }

  function doDelete() {
    var idx = currentClipIndex();
    if (idx === -1) return;
    history = pushHistory(history, subs);
    var result = deleteClipAt(subs, idx);
    subs = result.subs;
    var total = totalDuration(subs);
    if (headTime > total) headTime = total;
    setHint('クリップを削除しました');
    renderTimeline();
  }

  function doUndo() {
    var restored = popHistory(history);
    if (!restored) {
      setHint('これ以上戻せません');
      return;
    }
    history = restored.stack;
    subs = restored.subs;
    var total = totalDuration(subs);
    if (headTime > total) headTime = total;
    setHint('元に戻しました');
    renderTimeline();
  }

  function startTextEdit(idx) {
    if (idx === -1) return;
    editingText = true;
    var sub = subs[idx];
    var multiline = sub.text.indexOf('\n') !== -1;
    previewBox.innerHTML = '';
    var el = document.createElement(multiline ? 'textarea' : 'input');
    el.className = 'preview-input';
    el.dir = 'rtl';
    if (multiline) {
      el.rows = 2;
      el.value = sub.text;
    } else {
      el.type = 'text';
      el.value = sub.text;
    }
    previewBox.appendChild(el);
    el.focus();
    el.select();

    function commit() {
      if (!editingText) return;
      editingText = false;
      var newText = el.value;
      if (newText !== sub.text) {
        history = pushHistory(history, subs);
        var next = cloneSubs(subs);
        next[idx].text = newText;
        next[idx].edited = true;
        subs = next;
        setHint('テキストを編集しました');
        renderTimeline();
      } else {
        renderPreview();
      }
    }
    function cancel() {
      editingText = false;
      renderPreview();
    }

    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    });
    el.addEventListener('blur', commit);
  }

  function enterEditMode() {
    var text = textarea.value;
    var cps = parseFloat(cpsInput.value);
    var lineGroups = segmentManuscript(text);
    if (lineGroups.length === 0) return;

    subs = subsFromLineGroups(lineGroups, cps);
    currentCps = (isFinite(cps) && cps > 0) ? cps : 12;
    history = [];
    headTime = 0;
    editingText = false;
    stopPlayback();
    mode = 'edit';

    mainView.style.display = 'none';
    editorView.style.display = '';
    editorCps.value = String(currentCps);
    editorCpsValue.textContent = String(currentCps);
    setHint('');
    renderTimeline();
  }

  function exitEditMode() {
    var ok = window.confirm('タイムラインでの編集内容は破棄されます。よろしいですか？');
    if (!ok) return;
    stopPlayback();
    mode = 'input';
    subs = [];
    history = [];
    editorView.style.display = 'none';
    mainView.style.display = '';
  }

  function downloadFromSubs() {
    if (subs.length === 0) return;
    var cues = subsToCues(subs);
    var content = buildSrt(cues, bomCheckbox.checked);
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
    seekTo(offsetX / PX_PER_SEC);
  });

  previewBox.addEventListener('dblclick', function () {
    if (mode !== 'edit' || editingText) return;
    if (playing) stopPlayback();
    startTextEdit(currentClipIndex());
  });

  editorCps.addEventListener('input', function () {
    if (!cpsAdjusting) {
      cpsAdjusting = true;
      history = pushHistory(history, subs);
    }
    currentCps = parseFloat(editorCps.value);
    editorCpsValue.textContent = String(currentCps);
    subs = recalcUneditedDurations(subs, currentCps);
    var total = totalDuration(subs);
    if (headTime > total) headTime = total;
    renderTimeline();
  });
  editorCps.addEventListener('change', function () {
    cpsAdjusting = false;
    setHint('読み速度を変更しました（編集済みクリップは変更されません）');
  });

  document.addEventListener('keydown', function (e) {
    if (mode !== 'edit' || editingText) return;
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
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      doDelete();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      doUndo();
    }
  });

  render();
})();
