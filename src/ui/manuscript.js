// 原稿モード: DOM wiring

import { pad, formatTotalDuration } from '../core/time.js';
import { segmentManuscript, buildCues } from '../core/segment.js';
import {
  charCountForText, splitEnglishLines, buildAlignmentWarning, rowMismatchMessage,
  shiftEnglishDown, compactEnglish
} from '../core/subs.js';
import { buildSrt } from '../core/srt.js';

export var textarea = document.getElementById('manuscript');
export var translationTextarea = document.getElementById('translation');
export var cpsInput = document.getElementById('cps');
export var bomCheckbox = document.getElementById('bom');
export var downloadBtn = document.getElementById('downloadBtn');
export var toTimelineBtn = document.getElementById('toTimelineBtn');
var previewList = document.getElementById('previewList');
var emptyState = document.getElementById('emptyState');
var alignmentWarningEl = document.getElementById('alignmentWarning');
var statCount = document.getElementById('statCount');
var statDuration = document.getElementById('statDuration');

var currentCues = [];
var onChangeCallback = function () {};

export function setOnChange(fn) {
  onChangeCallback = fn;
}

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
    onChangeCallback();
  });

  var compactBtn = document.createElement('button');
  compactBtn.type = 'button';
  compactBtn.textContent = 'ここを詰める';
  compactBtn.addEventListener('click', function () {
    var lines = splitEnglishLines(translationTextarea.value);
    translationTextarea.value = compactEnglish(lines, index).join('\n');
    render();
    onChangeCallback();
  });

  actions.appendChild(shiftBtn);
  actions.appendChild(compactBtn);
  row.appendChild(actions);

  return row;
}

export function render() {
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
export function downloadSrtContent(content) {
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

textarea.addEventListener('input', function () {
  render();
  onChangeCallback();
});
translationTextarea.addEventListener('input', function () {
  render();
  onChangeCallback();
});
cpsInput.addEventListener('input', function () {
  render();
  onChangeCallback();
});
bomCheckbox.addEventListener('change', function () {
  onChangeCallback();
});
downloadBtn.addEventListener('click', download);
