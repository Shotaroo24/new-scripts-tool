// localStorageスキーマ・timeline.jsonの直列化/検証

import { ZOOM_LEVELS } from './time.js';

export var STORAGE_KEY = 'srtgen:session:v1';
// v5: 英訳ラウンドトリップ機能により、英訳をクリップ単位のtranslation/translationStale
// で管理する方式に変更(左ペインの英訳textareaを廃止)。トップレベルのtranslation
// フィールドも廃止。v4(en textarea方式)は移行対象として扱う(migrateV4ToV5参照)。
export var SCHEMA_VERSION = 5;
// v3: 動画トラック機能の撤去に伴いmaster/segmentsを廃止。v3(master/segments付き)の
// データは字幕部分のみ読み取り、動画関連フィールドは無視して移行する(v4からの継承)。
var LEGACY_SCHEMA_VERSION = 4;

function isValidClip(c) {
  if (!c || typeof c !== 'object') return false;
  if (typeof c.text !== 'string') return false;
  if (typeof c.durMs !== 'number' || !isFinite(c.durMs)) return false;
  if (typeof c.delim !== 'string') return false;
  if (typeof c.edited !== 'boolean') return false;
  if (typeof c.translation !== 'string') return false;
  if (typeof c.translationStale !== 'boolean') return false;
  return true;
}

function isValidClips(clips) {
  if (!Array.isArray(clips)) return false;
  for (var i = 0; i < clips.length; i++) {
    if (!isValidClip(clips[i])) return false;
  }
  return true;
}

// ---- v4(旧英訳textarea方式)の検証・v5への移行 ----
function isValidLegacyClip(c) {
  if (!c || typeof c !== 'object') return false;
  if (typeof c.text !== 'string') return false;
  if (typeof c.durMs !== 'number' || !isFinite(c.durMs)) return false;
  if (typeof c.delim !== 'string') return false;
  if (typeof c.edited !== 'boolean') return false;
  if (typeof c.en !== 'string') return false;
  return true;
}
function isValidLegacyClips(clips) {
  if (!Array.isArray(clips)) return false;
  for (var i = 0; i < clips.length; i++) {
    if (!isValidLegacyClip(clips[i])) return false;
  }
  return true;
}

// version 3(動画トラック撤去前)も字幕フィールドは同一構造のため有効として受け入れる
// (master/segmentsは検証せず単に無視する)。
function isValidLegacySessionData(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.version !== LEGACY_SCHEMA_VERSION && data.version !== 3) return false;
  if (typeof data.manuscript !== 'string') return false;
  if (typeof data.translation !== 'string') return false;
  if (typeof data.cps !== 'number' || !isFinite(data.cps)) return false;
  if (typeof data.bom !== 'boolean') return false;
  if (data.mode !== 'input' && data.mode !== 'edit') return false;
  if (!isValidLegacyClips(data.clips)) return false;
  if (typeof data.zoomIndex !== 'number' || data.zoomIndex < 0 || data.zoomIndex >= ZOOM_LEVELS.length) return false;
  if (typeof data.headTimeMs !== 'number' || !isFinite(data.headTimeMs)) return false;
  if (typeof data.calibration !== 'number' || !isFinite(data.calibration)) return false;
  if (typeof data.fontSize !== 'number' || !isFinite(data.fontSize) || data.fontSize <= 0) return false;
  return true;
}

// 改行のみで分割し、空行もスキップせず1件として数える(旧英訳textareaの分割規則を踏襲)。
// 完全な空文字列は0行として扱う。
function splitLegacyTranslationLines(text) {
  if (text === '') return [];
  return text.replace(/\r/g, '').split('\n').map(function (l) { return l.trim(); });
}

// v4(または旧v3)のセッションデータをv5形式へ移行する(docs/srtgen-translation-roundtrip-spec.md §2)。
// 英訳textareaの内容をクリップ件数と突き合わせ、件数が一致する場合のみ順に
// translationへ割り当てる。一致しない場合は割り当てず、全クリップtranslationStale:true
// とし、旧テキストをlegacyTranslationTextとして保持する(破棄しない)。
export function migrateV4ToV5(data) {
  var lines = splitLegacyTranslationLines(data.translation);
  var matched = lines.length === data.clips.length;
  var clips = data.clips.map(function (c, i) {
    return {
      text: c.text,
      durMs: c.durMs,
      delim: c.delim,
      edited: c.edited,
      translation: matched ? lines[i] : '',
      translationStale: !matched
    };
  });
  var out = {
    version: SCHEMA_VERSION,
    manuscript: data.manuscript,
    cps: data.cps,
    bom: data.bom,
    mode: data.mode,
    clips: clips,
    zoomIndex: data.zoomIndex,
    headTimeMs: data.headTimeMs,
    calibration: data.calibration,
    fontSize: data.fontSize
  };
  if (!matched && data.translation !== '') out.legacyTranslationText = data.translation;
  return out;
}

// ---- localStorage 永続化: スキーマ検証とシリアライズ(DOMに依存しない純粋部分) ----
export function isValidSessionData(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.version !== SCHEMA_VERSION) return false;
  if (typeof data.manuscript !== 'string') return false;
  if (typeof data.cps !== 'number' || !isFinite(data.cps)) return false;
  if (typeof data.bom !== 'boolean') return false;
  if (data.mode !== 'input' && data.mode !== 'edit') return false;
  if (!isValidClips(data.clips)) return false;
  if (typeof data.zoomIndex !== 'number' || data.zoomIndex < 0 || data.zoomIndex >= ZOOM_LEVELS.length) return false;
  if (typeof data.headTimeMs !== 'number' || !isFinite(data.headTimeMs)) return false;
  if (typeof data.calibration !== 'number' || !isFinite(data.calibration)) return false;
  if (typeof data.fontSize !== 'number' || !isFinite(data.fontSize) || data.fontSize <= 0) return false;
  if ('legacyTranslationText' in data && typeof data.legacyTranslationText !== 'string') return false;
  return true;
}

export function serializeSession(state) {
  var out = {
    version: SCHEMA_VERSION,
    manuscript: state.manuscript,
    cps: state.cps,
    bom: state.bom,
    mode: state.mode,
    clips: state.clips.map(function (c) {
      return { text: c.text, durMs: c.durMs, delim: c.delim, edited: c.edited, translation: c.translation, translationStale: c.translationStale };
    }),
    zoomIndex: state.zoomIndex,
    headTimeMs: Math.round(state.headTimeMs),
    calibration: state.calibration,
    fontSize: state.fontSize
  };
  if (state.legacyTranslationText !== undefined && state.legacyTranslationText !== null) {
    out.legacyTranslationText = state.legacyTranslationText;
  }
  return JSON.stringify(out);
}

// JSON.parse失敗・バージョン不一致・想定外の構造の場合は例外を投げず null を返す。
// v4(または旧v3)は破損データではなく正当な旧世代データのため、破棄せずv5へ移行する。
export function deserializeSession(raw) {
  var data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return null;
  }
  if (isValidSessionData(data)) return data;
  if (isValidLegacySessionData(data)) return migrateV4ToV5(data);
  return null;
}
