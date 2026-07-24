(function () {
  'use strict';

  // SRT改行コード。Filmora実機テストでCRLFが必要な場合はここを '\r\n' に変更する。
  var LINE_BREAK = '\n';

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
  function segmentManuscript(text) {
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
  function buildCues(segments, cps) {
    var rate = (isFinite(cps) && cps > 0) ? cps : 12;
    var accSeconds = 0;
    var cues = [];
    for (var idx = 0; idx < segments.length; idx++) {
      var lines = segments[idx].lines;
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
  // 内部の時間計算はすべて「ミリ秒の整数」で行う。dur自体もdurMsという
  // 整数msフィールドとして保持し、浮動小数は一切経由しない(累積誤差ゼロ)。

  var MIN_DUR_MS = 300;
  var ZOOM_LEVELS = [20, 35, 50, 75, 100, 150, 200, 300, 400];
  var DEFAULT_ZOOM_INDEX = ZOOM_LEVELS.indexOf(75); // 現行(80px/sec)に最も近い段
  var STORAGE_KEY = 'srtgen:session:v1';
  var SCHEMA_VERSION = 2; // 英訳(en)・calibration・fontSizeの追加に伴い旧v1データは破棄する

  // ---- 9:16実寸プレビュー用の定数(1080x1920キャンバス基準) ----
  var CANVAS_BASE_WIDTH = 1080;
  var SAFE_MARGIN_LEFT_1080 = 90;
  var SAFE_MARGIN_RIGHT_1080 = 90;
  var SAFE_MARGIN_TOP_1080 = 100;
  var SAFE_MARGIN_BOTTOM_1080 = 300;
  var SAFE_WIDTH_1080 = CANVAS_BASE_WIDTH - SAFE_MARGIN_LEFT_1080 - SAFE_MARGIN_RIGHT_1080; // 900
  var SUBTITLE_BASELINE_FROM_BOTTOM = 390; // 実機の実測値。映像下端からのオフセット(1080px空間)
  var STROKE_WIDTH_AT_1080 = 6; // 縁取り幅(1080px空間)。paint-order:stroke fill前提
  var FONT_SIZE_DEFAULT = 55;
  var CALIBRATION_DEFAULT = 1.0;
  var CALIBRATION_MIN = 0.80;
  var CALIBRATION_MAX = 1.30;
  var CALIBRATION_STEP = 0.01;

  function clampCalibration(v) {
    return Math.max(CALIBRATION_MIN, Math.min(CALIBRATION_MAX, v));
  }
  // 実測(canvas measureText)に使うフォントサイズ。1080px空間のまま、プレビューの縮尺は掛けない。
  function measurementFontSize(fontSize, calibration) {
    return fontSize * calibration;
  }
  // プレビュー枠(縮小表示)用のCSSフォントサイズ。
  function previewFontSizePx(fontSize, calibration, previewWidthPx) {
    return fontSize * calibration * (previewWidthPx / CANVAS_BASE_WIDTH);
  }
  function previewStrokeWidthPx(previewWidthPx) {
    return STROKE_WIDTH_AT_1080 * (previewWidthPx / CANVAS_BASE_WIDTH);
  }
  function previewBaselineOffsetPx(previewWidthPx) {
    return SUBTITLE_BASELINE_FROM_BOTTOM * (previewWidthPx / CANVAS_BASE_WIDTH);
  }
  function previewSafeMargins(previewWidthPx) {
    var scale = previewWidthPx / CANVAS_BASE_WIDTH;
    return {
      left: SAFE_MARGIN_LEFT_1080 * scale,
      right: SAFE_MARGIN_RIGHT_1080 * scale,
      top: SAFE_MARGIN_TOP_1080 * scale,
      bottom: SAFE_MARGIN_BOTTOM_1080 * scale
    };
  }

  // ---- 行数判定(3値): 1行 / 2行推奨 / 溢れ ----
  // measureFn(text)=>px は呼び出し側から注入する(DOM/canvasに依存させずNodeでテスト可能にするため)。
  // 実アプリでは canvas measureText の結果に STROKE_WIDTH_AT_1080 を加算したものを渡す。
  function findBestSplit(text, measureFn) {
    var chars = Array.from(text);
    var spaceIndices = [];
    for (var i = 0; i < chars.length; i++) {
      if (chars[i] === ' ') spaceIndices.push(i);
    }
    if (spaceIndices.length === 0) return null;
    var mid = chars.length / 2;
    var best = null;
    for (var k = 0; k < spaceIndices.length; k++) {
      var idx = spaceIndices[k];
      var left = chars.slice(0, idx).join('');
      var right = chars.slice(idx + 1).join('');
      var lw = measureFn(left);
      var rw = measureFn(right);
      var diff = Math.abs(lw - rw);
      var distFromMid = Math.abs(idx - mid);
      if (best === null || diff < best.diff || (diff === best.diff && distFromMid < best.distFromMid)) {
        best = { left: left, right: right, leftWidth: lw, rightWidth: rw, diff: diff, distFromMid: distFromMid };
      }
    }
    return best;
  }

  // 既に改行を含む(手動2行)場合は行ごとにそのまま測る。含まない場合は
  // 単語境界での自動分割を試み、最長行が安全幅に収まるかで判定する。
  function judgeLineCount(text, safeWidthPx, measureFn) {
    var lines = text.split('\n');
    if (lines.length === 1) {
      var w = measureFn(lines[0]);
      if (w <= safeWidthPx) return { level: 'one-line', maxWidth: w };
      var split = findBestSplit(lines[0], measureFn);
      if (!split) return { level: 'overflow', maxWidth: w };
      var maxW = Math.max(split.leftWidth, split.rightWidth);
      return { level: maxW <= safeWidthPx ? 'two-line' : 'overflow', maxWidth: maxW, split: split };
    }
    var widths = lines.map(measureFn);
    var maxWidth = Math.max.apply(null, widths);
    if (lines.length > 2 || maxWidth > safeWidthPx) return { level: 'overflow', maxWidth: maxWidth };
    return { level: 'two-line', maxWidth: maxWidth };
  }

  // 編集モーダルの「自動で2行に分割」「1行に戻す」。どちらも尺(durMs)には影響しない。
  function autoSplitToTwoLines(text, measureFn) {
    if (text.indexOf('\n') !== -1) return text;
    var split = findBestSplit(text, measureFn);
    if (!split) return text;
    return split.left + '\n' + split.right;
  }
  function collapseToOneLine(text) {
    return text.replace(/\n/g, ' ');
  }

  // ---- 英訳併記 ----
  // 英訳は改行のみで分割する(区切り文字によるパースはしない)。空行もスキップせず1件として数える。
  // ただし完全な空文字列(textarea未入力)は0行として扱う(1行の空行とは区別する)。
  function splitEnglishLines(text) {
    if (text === '') return [];
    return text.replace(/\r/g, '').split('\n').map(function (l) { return l.trim(); });
  }

  function buildAlignmentWarning(arabicCount, enCount) {
    if (arabicCount === enCount) return null;
    var diff = arabicCount - enCount;
    if (diff > 0) {
      return 'アラビア語 ' + arabicCount + '件 / 英訳 ' + enCount + '行 — ' + diff + '行不足しています';
    }
    return 'アラビア語 ' + arabicCount + '件 / 英訳 ' + enCount + '行 — ' + (-diff) + '行超過しています';
  }

  // 行indexに対応する相手が存在しない場合のメッセージ。件数比較のみで、
  // 内容の類似度等によるズレ位置の推定は一切行わない。
  function rowMismatchMessage(index, arabicCount, enCount) {
    if (index < arabicCount && index >= enCount) return '対応する英訳がありません';
    if (index >= arabicCount && index < enCount) return '対応するアラビア語がありません';
    return null;
  }

  // 「ここから1つ下にずらす」: index位置に空行を挿入し、以降を1つ後ろへ(英訳のみ操作)。
  function shiftEnglishDown(lines, index) {
    var next = lines.slice();
    next.splice(index, 0, '');
    return next;
  }
  // 「ここを詰める」: index行を削除し、以降を1つ前へ(英訳のみ操作)。
  function compactEnglish(lines, index) {
    if (index < 0 || index >= lines.length) return lines;
    var next = lines.slice();
    next.splice(index, 1);
    return next;
  }

  function clampDurMs(ms) {
    return Math.max(MIN_DUR_MS, Math.round(ms));
  }

  // 改行を除き、スペース込み・コードポイント単位で文字数を数える(既存の cps 計算方式と同一)。
  function charCountForText(text) {
    var lines = text.split('\n');
    var count = 0;
    for (var i = 0; i < lines.length; i++) count += Array.from(lines[i]).length;
    return count;
  }

  function durMsFromCps(charCount, cps) {
    var rate = (isFinite(cps) && cps > 0) ? cps : 12;
    return clampDurMs((charCount / rate) * 1000);
  }

  // 生成: セグメント({lines,delim})から編集モード用の subs を組み立てる。
  // durMs は cps から算出しMath.roundでms整数化・最小300msでクランプ。全クリップ edited:false。
  // enLines(英訳の行配列)はインデックス順にマッピングする。cps算出には一切使わない。
  function subsFromSegments(segments, cps, enLines) {
    var subs = [];
    for (var i = 0; i < segments.length; i++) {
      var text = segments[i].lines.join('\n');
      var charCount = charCountForText(text);
      subs.push({
        text: text,
        durMs: durMsFromCps(charCount, cps),
        edited: false,
        delim: segments[i].delim,
        en: (enLines && enLines[i] !== undefined) ? enLines[i] : ''
      });
    }
    return subs;
  }

  // 各クリップの開始時刻をミリ秒の整数配列で返す(累積誤差なし)。
  function computeStartsMs(subs) {
    var starts = [];
    var acc = 0;
    for (var i = 0; i < subs.length; i++) {
      starts.push(acc);
      acc += subs[i].durMs;
    }
    return starts;
  }
  function totalDurationMs(subs) {
    var acc = 0;
    for (var i = 0; i < subs.length; i++) acc += subs[i].durMs;
    return acc;
  }

  // 時刻 tMs(連続値でも可)が属するクリップのindexを返す。整数msに丸めてから
  // 整数のみで比較するため、境界判定に浮動小数の誤差が入らない。
  function clipAt(subs, tMs) {
    var n = subs.length;
    if (n === 0) return -1;
    var starts = computeStartsMs(subs);
    var total = totalDurationMs(subs);
    var t = Math.round(tMs);
    if (t <= 0) return 0;
    if (t >= total) return n - 1;
    for (var i = 0; i < n; i++) {
      var end = (i < n - 1) ? starts[i + 1] : total;
      if (t < end) return i;
    }
    return n - 1;
  }

  function cloneSubs(subs) {
    var out = [];
    for (var i = 0; i < subs.length; i++) {
      out.push({
        text: subs[i].text,
        durMs: subs[i].durMs,
        edited: subs[i].edited,
        delim: subs[i].delim,
        en: subs[i].en
      });
    }
    return out;
  }

  // ドラッグ等による尺の直接指定。px→msから算出した値を1ms単位に丸めるのみで、
  // 人為的なスナップ(0.1秒刻み等)は入れない。常に成功し、最小300msでクランプする。
  function setClipDuration(subs, index, rawMs) {
    var next = cloneSubs(subs);
    next[index].durMs = clampDurMs(rawMs);
    next[index].edited = true;
    return next;
  }

  // S: ヘッドが乗っているクリップの尺を (ヘッドms − クリップ開始ms) に変更する。
  // 結果が最小尺(300ms)未満なら拒否して元の配列を返す。テキストは変更しない。
  function trimClipAtHead(subs, index, headMs) {
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

  // M: index番目と右隣(index+1)を結合する。テキスト・英訳とも半角スペース連結、尺は合算。
  // delimは左クリップのものを破棄し、右クリップのものを引き継ぐ。
  // 最終クリップ(右隣が存在しない)なら拒否。
  function mergeClipAt(subs, index) {
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
      en: a.en + ' ' + b.en
    };
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

  // cps変更: edited:false のクリップのみ、自身のテキストの文字数から尺(ms)を再計算する。
  // edited:true のクリップは一切変更しない。
  function recalcUneditedDurations(subs, cps) {
    return subs.map(function (sub) {
      if (sub.edited) return sub;
      var charCount = charCountForText(sub.text);
      return { text: sub.text, durMs: durMsFromCps(charCount, cps), edited: false, delim: sub.delim, en: sub.en };
    });
  }

  // SRT出力用のcues生成。durMsは既に整数msのため、累積は常に厳密(丸め不要)。
  function subsToCues(subs) {
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
  function reconstructManuscript(subs) {
    return subs.map(function (s) { return s.text + s.delim; }).join('\n');
  }

  // 英訳の書き戻し: 各クリップのenを改行区切りで連結する(1クリップ=1行)。
  function reconstructTranslation(subs) {
    return subs.map(function (s) { return s.en; }).join('\n');
  }

  // 文字列の完全一致判定(コードポイント単位。正規化はしない)。
  function textEquals(a, b) {
    return Array.from(a).join('') === Array.from(b).join('');
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

  // M:SS.d 形式(0.1秒単位)。表示専用でmsを保持したまま整数演算で丸める。
  function formatClock(ms) {
    ms = Math.max(0, Math.round(ms));
    var totalTenths = Math.round(ms / 100);
    var m = Math.floor(totalTenths / 600);
    var rem = totalTenths - m * 600;
    var s = Math.floor(rem / 10);
    var d = rem % 10;
    return m + ':' + pad(s, 2) + '.' + d;
  }

  // ---- ズーム(表示倍率)。尺・時刻・SRT出力には一切影響しない、純粋に表示用の変換 ----
  function clampZoomIndex(index) {
    return Math.max(0, Math.min(ZOOM_LEVELS.length - 1, index));
  }
  function msToPx(ms, pxPerSec) {
    return (ms / 1000) * pxPerSec;
  }
  function pxToMs(px, pxPerSec) {
    return (px / pxPerSec) * 1000;
  }
  // ルーラーの目盛り間隔(秒)を、ラベルが重ならない最小間隔から選ぶ。
  var TICK_CANDIDATES_SEC = [0.1, 0.5, 1, 2, 5];
  var MIN_TICK_LABEL_SPACING_PX = 40;
  function pickTickIntervalSec(pxPerSec) {
    for (var i = 0; i < TICK_CANDIDATES_SEC.length; i++) {
      if (TICK_CANDIDATES_SEC[i] * pxPerSec >= MIN_TICK_LABEL_SPACING_PX) return TICK_CANDIDATES_SEC[i];
    }
    return TICK_CANDIDATES_SEC[TICK_CANDIDATES_SEC.length - 1];
  }

  // ---- localStorage 永続化: スキーマ検証とシリアライズ(DOMに依存しない純粋部分) ----
  function isValidSessionData(data) {
    if (!data || typeof data !== 'object') return false;
    if (data.version !== SCHEMA_VERSION) return false;
    if (typeof data.manuscript !== 'string') return false;
    if (typeof data.translation !== 'string') return false;
    if (typeof data.cps !== 'number' || !isFinite(data.cps)) return false;
    if (typeof data.bom !== 'boolean') return false;
    if (data.mode !== 'input' && data.mode !== 'edit') return false;
    if (!Array.isArray(data.clips)) return false;
    for (var i = 0; i < data.clips.length; i++) {
      var c = data.clips[i];
      if (!c || typeof c !== 'object') return false;
      if (typeof c.text !== 'string') return false;
      if (typeof c.durMs !== 'number' || !isFinite(c.durMs)) return false;
      if (typeof c.delim !== 'string') return false;
      if (typeof c.edited !== 'boolean') return false;
      if (typeof c.en !== 'string') return false;
    }
    if (typeof data.zoomIndex !== 'number' || data.zoomIndex < 0 || data.zoomIndex >= ZOOM_LEVELS.length) return false;
    if (typeof data.headTimeMs !== 'number' || !isFinite(data.headTimeMs)) return false;
    if (typeof data.calibration !== 'number' || !isFinite(data.calibration)) return false;
    if (typeof data.fontSize !== 'number' || !isFinite(data.fontSize) || data.fontSize <= 0) return false;
    return true;
  }

  function serializeSession(state) {
    return JSON.stringify({
      version: SCHEMA_VERSION,
      manuscript: state.manuscript,
      translation: state.translation,
      cps: state.cps,
      bom: state.bom,
      mode: state.mode,
      clips: state.clips.map(function (c) {
        return { text: c.text, durMs: c.durMs, delim: c.delim, edited: c.edited, en: c.en };
      }),
      zoomIndex: state.zoomIndex,
      headTimeMs: Math.round(state.headTimeMs),
      calibration: state.calibration,
      fontSize: state.fontSize
    });
  }

  // JSON.parse失敗・バージョン不一致・想定外の構造の場合は例外を投げず null を返す。
  function deserializeSession(raw) {
    var data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      return null;
    }
    if (!isValidSessionData(data)) return null;
    return data;
  }

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

  function renderJudgeBadge(el, judge) {
    var labelMap = { 'one-line': '1行', 'two-line': '2行推奨', 'overflow': '溢れ' };
    var classMap = { 'one-line': 'badge-one-line', 'two-line': 'badge-two-line', 'overflow': 'badge-overflow' };
    el.innerHTML = '';
    var badge = document.createElement('span');
    badge.className = 'badge ' + classMap[judge.level];
    badge.textContent = labelMap[judge.level];
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

  // 9:16実寸プレビューを更新する(安全領域・縁取り・ベースライン位置・行数判定バッジ込み)。
  function renderPreview() {
    var idx = currentClipIndex();
    var sub = idx === -1 ? null : subs[idx];
    var widthPx = previewFrame.getBoundingClientRect().width || 320;

    var fontPx = previewFontSizePx(fontSize, calibration, widthPx);
    var strokePx = previewStrokeWidthPx(widthPx);
    var baselinePx = previewBaselineOffsetPx(widthPx);
    var margins = previewSafeMargins(widthPx);

    previewSafeGuide.style.left = margins.left + 'px';
    previewSafeGuide.style.right = margins.right + 'px';
    previewSafeGuide.style.top = margins.top + 'px';
    previewSafeGuide.style.bottom = margins.bottom + 'px';

    previewSubtitleText.style.fontSize = fontPx + 'px';
    previewSubtitleText.style.lineHeight = '1.3';
    previewSubtitleText.style.webkitTextStroke = strokePx + 'px #000';
    previewSubtitleText.style.paintOrder = 'stroke fill';
    previewSubtitleText.style.bottom = baselinePx + 'px';
    previewSubtitleText.textContent = sub ? sub.text : '';

    previewTranslationText.textContent = sub ? sub.en : '';

    if (sub) {
      var judge = judgeLineCount(sub.text, SAFE_WIDTH_1080, measureTextWidth1080);
      renderJudgeBadge(previewJudgeBadge, judge);
    } else {
      previewJudgeBadge.innerHTML = '';
    }
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
    var arabicText = modalArabicText.value;
    var widthPx = modalPreviewFrame.getBoundingClientRect().width || 200;

    var fontPx = previewFontSizePx(fontSize, calibration, widthPx);
    var strokePx = previewStrokeWidthPx(widthPx);
    var baselinePx = previewBaselineOffsetPx(widthPx);
    var margins = previewSafeMargins(widthPx);

    modalSafeGuide.style.left = margins.left + 'px';
    modalSafeGuide.style.right = margins.right + 'px';
    modalSafeGuide.style.top = margins.top + 'px';
    modalSafeGuide.style.bottom = margins.bottom + 'px';

    modalPreviewSubtitleText.style.fontSize = fontPx + 'px';
    modalPreviewSubtitleText.style.lineHeight = '1.3';
    modalPreviewSubtitleText.style.webkitTextStroke = strokePx + 'px #000';
    modalPreviewSubtitleText.style.paintOrder = 'stroke fill';
    modalPreviewSubtitleText.style.bottom = baselinePx + 'px';
    modalPreviewSubtitleText.textContent = arabicText;

    var judge = judgeLineCount(arabicText, SAFE_WIDTH_1080, measureTextWidth1080);
    renderJudgeBadge(modalJudgeBadge, judge);
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
  modalEnglishText.addEventListener('input', updateModalPreview);
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
