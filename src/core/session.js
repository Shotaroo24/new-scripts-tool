// localStorageスキーマ・timeline.jsonの直列化/検証

import { ZOOM_LEVELS } from './time.js';

export var STORAGE_KEY = 'srtgen:session:v1';
export var SCHEMA_VERSION = 2; // 英訳(en)・calibration・fontSizeの追加に伴い旧v1データは破棄する

// ---- localStorage 永続化: スキーマ検証とシリアライズ(DOMに依存しない純粋部分) ----
export function isValidSessionData(data) {
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

export function serializeSession(state) {
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
export function deserializeSession(raw) {
  var data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return null;
  }
  if (!isValidSessionData(data)) return null;
  return data;
}
