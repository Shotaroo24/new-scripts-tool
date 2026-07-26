// エントリポイント。状態の保持と各モジュールの配線のみ。

import { STORAGE_KEY, serializeSession, deserializeSession } from './core/session.js';
import * as manuscript from './ui/manuscript.js';
import * as timeline from './ui/timeline.js';
import { copyTextWithFallback } from './ui/clipboard.js';

var restoreBanner = document.getElementById('restoreBanner');
var newSessionBtn = document.getElementById('newSessionBtn');
var legacyTranslationBanner = document.getElementById('legacyTranslationBanner');
var legacyTranslationCopyBtn = document.getElementById('legacyTranslationCopyBtn');
var legacyTranslationDismissBtn = document.getElementById('legacyTranslationDismissBtn');

// v4→v5移行時、旧英訳textareaの内容がクリップ件数と一致せず割り当てられなかった場合に
// 1回だけ保持する(§2.3)。番号付き貼り付けの適用が1回成功するか、ユーザーが「破棄」を
// 押すまでバナーで表示し続ける(指示書3節2)。
var legacyTranslationText = null;

function updateLegacyTranslationBanner() {
  legacyTranslationBanner.style.display = legacyTranslationText !== null ? '' : 'none';
}

function clearLegacyTranslationText() {
  legacyTranslationText = null;
  updateLegacyTranslationBanner();
  scheduleSave();
}

legacyTranslationCopyBtn.addEventListener('click', function () {
  if (legacyTranslationText === null) return;
  copyTextWithFallback(legacyTranslationText).then(function (ok) {
    if (!ok) return;
    var original = legacyTranslationCopyBtn.textContent;
    legacyTranslationCopyBtn.textContent = 'コピーしました';
    setTimeout(function () { legacyTranslationCopyBtn.textContent = original; }, 1500);
  });
});

legacyTranslationDismissBtn.addEventListener('click', function () {
  clearLegacyTranslationText();
});

// 番号付き貼り付けの適用が1回成功した時点で、旧テキストの保持は役目を終える。
timeline.setOnTranslationApplied(function () {
  if (legacyTranslationText !== null) clearLegacyTranslationText();
});

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
    var snap = timeline.getSessionSnapshot();
    var state = {
      manuscript: manuscript.textarea.value,
      cps: snap.cps,
      bom: manuscript.bomCheckbox.checked,
      mode: snap.mode,
      clips: snap.clips,
      zoomIndex: snap.zoomIndex,
      headTimeMs: snap.headTimeMs,
      calibration: snap.calibration,
      fontSize: snap.fontSize
    };
    if (legacyTranslationText !== null) state.legacyTranslationText = legacyTranslationText;
    localStorage.setItem(STORAGE_KEY, serializeSession(state));
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

  manuscript.textarea.value = data.manuscript;
  manuscript.cpsInput.value = String(data.cps);
  manuscript.bomCheckbox.checked = data.bom;
  legacyTranslationText = data.legacyTranslationText || null;
  updateLegacyTranslationBanner();

  timeline.setStateFromSession(data);
  manuscript.render();
  timeline.restoreEditorViewIfNeeded(data.mode);

  return true;
}

manuscript.setOnChange(scheduleSave);
timeline.setOnChange(scheduleSave);

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
  manuscript.render();
}
