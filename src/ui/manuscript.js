// 原稿モード: DOM wiring

import { pad, formatTotalDuration } from '../core/time.js';
import { segmentManuscript, buildCues } from '../core/segment.js';
import { charCountForText } from '../core/subs.js';
import { buildSrt } from '../core/srt.js';

export var textarea = document.getElementById('manuscript');
export var cpsInput = document.getElementById('cps');
export var bomCheckbox = document.getElementById('bom');
export var downloadBtn = document.getElementById('downloadBtn');
export var toTimelineBtn = document.getElementById('toTimelineBtn');
var previewList = document.getElementById('previewList');
var emptyState = document.getElementById('emptyState');
var statCount = document.getElementById('statCount');
var statDuration = document.getElementById('statDuration');

var currentCues = [];
var onChangeCallback = function () {};
var translationsProvider = null;

export function setOnChange(fn) {
  onChangeCallback = fn;
}

// タイムライン側のsubsから、現在の分割状態に対応する英訳一覧を取得するための
// プロバイダを登録する(src/app.jsが配線する)。text/segmentCountに対して
// 対応が取れない場合はnullを返してよい(その場合は英訳を表示しない)。
export function setTranslationsProvider(fn) {
  translationsProvider = fn;
}

// プレビューリストの1行を構築する(アラビア語本文+文字数+英訳サブテキスト)。
function buildPreviewRow(index, arabicText, translationInfo) {
  var row = document.createElement('div');
  row.className = 'mapping-row';

  var idxDiv = document.createElement('div');
  idxDiv.className = 'mapping-index';
  idxDiv.textContent = '#' + (index + 1);

  var arDiv = document.createElement('div');
  arDiv.className = 'mapping-arabic';
  arDiv.dir = 'rtl';
  arDiv.textContent = arabicText;

  var countDiv = document.createElement('div');
  countDiv.className = 'mapping-charcount';
  countDiv.textContent = charCountForText(arabicText) + '文字';

  row.appendChild(idxDiv);
  row.appendChild(arDiv);
  row.appendChild(countDiv);

  if (translationInfo) {
    var enDiv = document.createElement('div');
    enDiv.className = 'mapping-en' + (translationInfo.translation ? '' : ' mapping-en-empty') +
      (translationInfo.translationStale ? ' mapping-en-stale' : '');
    enDiv.textContent = translationInfo.translation || '英訳なし';
    row.appendChild(enDiv);
  }

  return row;
}

export function render() {
  var text = textarea.value;
  var cps = parseFloat(cpsInput.value);
  var segments = segmentManuscript(text);
  currentCues = buildCues(segments, cps);

  previewList.innerHTML = '';
  if (segments.length === 0) {
    emptyState.style.display = '';
    previewList.style.display = 'none';
  } else {
    emptyState.style.display = 'none';
    previewList.style.display = '';
    var translations = translationsProvider ? translationsProvider(text, segments.length) : null;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < segments.length; i++) {
      frag.appendChild(buildPreviewRow(i, segments[i].lines.join('\n'), translations ? translations[i] : null));
    }
    previewList.appendChild(frag);
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
cpsInput.addEventListener('input', function () {
  render();
  onChangeCallback();
});
bomCheckbox.addEventListener('change', function () {
  onChangeCallback();
});
downloadBtn.addEventListener('click', download);
