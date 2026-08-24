// タイムライン編集モードのキーボードショートカット判定(DOM非依存の純粋ロジック)。

// target: KeyboardEvent.target相当のオブジェクト({tagName, isContentEditable})。
// input/textarea/select/contentEditable要素にフォーカス中は、文字入力を
// 壊さないようショートカットを一切発火させない。
export function isEditableTarget(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  var tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

// key: KeyboardEvent.key。単体キー(修飾キーなし)のショートカットを
// アクション名に解決する。該当なしはnull。
// Space・矢印キー・Ctrl/Cmd+Zは呼び出し側で個別処理するためここには含めない。
export function resolveShortcutAction(key) {
  switch (key) {
    case 'Delete':
    case 'Backspace':
      return 'delete';
    case 's':
    case 'S':
      return 'trim';
    case 'n':
    case 'N':
      return 'split';
    case 'd':
    case 'D':
      return 'extendToHead';
    case 'm':
    case 'M':
      return 'merge';
    case 'l':
    case 'L':
      return 'cyclePlaybackRate';
    case 'x':
    case 'X':
      return 'zoomIn';
    case 'z':
    case 'Z':
      return 'zoomOut';
    default:
      return null;
  }
}
