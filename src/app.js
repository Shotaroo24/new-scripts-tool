// エントリポイント。状態の保持と各モジュールの配線のみ。

import { STORAGE_KEY, serializeSession, deserializeSession } from './core/session.js';
import * as manuscript from './ui/manuscript.js';
import * as timeline from './ui/timeline.js';

var restoreBanner = document.getElementById('restoreBanner');
var newSessionBtn = document.getElementById('newSessionBtn');

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
    var raw = serializeSession({
      manuscript: manuscript.textarea.value,
      translation: manuscript.translationTextarea.value,
      cps: snap.cps,
      bom: manuscript.bomCheckbox.checked,
      mode: snap.mode,
      clips: snap.clips,
      zoomIndex: snap.zoomIndex,
      headTimeMs: snap.headTimeMs,
      calibration: snap.calibration,
      fontSize: snap.fontSize,
      master: snap.master,
      segments: snap.segments
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

  manuscript.textarea.value = data.manuscript;
  manuscript.translationTextarea.value = data.translation;
  manuscript.cpsInput.value = String(data.cps);
  manuscript.bomCheckbox.checked = data.bom;

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
