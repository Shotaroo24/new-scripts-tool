// クリップボードへのコピー: 3段階フォールバック(指示書3節3)。
// 1) navigator.clipboard.writeText (https本番の主経路)
// 2) 失敗時、document.execCommand('copy')(file://等writeText不可時)
// 3) それも失敗時、テキストを選択済みの状態でモーダル表示し手動コピーを促す

var manualCopyModal = document.getElementById('manualCopyModal');
var manualCopyTextarea = document.getElementById('manualCopyTextarea');
var manualCopyCloseBtn = document.getElementById('manualCopyCloseBtn');

function execCommandCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  var ok = false;
  try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
  document.body.removeChild(ta);
  return ok;
}

function showManualCopyModal(text) {
  manualCopyTextarea.value = text;
  manualCopyModal.style.display = 'flex';
  manualCopyTextarea.focus();
  manualCopyTextarea.select();
}

manualCopyCloseBtn.addEventListener('click', function () {
  manualCopyModal.style.display = 'none';
});

// 戻り値: 自動コピー(clipboard API または execCommand)が成功したか(boolean)。
// falseの場合は手動コピー用モーダルを表示済み。
export function copyTextWithFallback(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(function () {
      return true;
    }).catch(function () {
      if (execCommandCopy(text)) return true;
      showManualCopyModal(text);
      return false;
    });
  }
  return Promise.resolve().then(function () {
    if (execCommandCopy(text)) return true;
    showManualCopyModal(text);
    return false;
  });
}
