// localStorageスキーマ・timeline.jsonの直列化/検証

import { ZOOM_LEVELS } from './time.js';

export var STORAGE_KEY = 'srtgen:session:v1';
// v4: 動画トラック機能の撤去に伴いmaster/segmentsを廃止。
// v3(master/segments付き)のデータは字幕部分のみ読み取り、動画関連フィールドは無視して移行する。
export var SCHEMA_VERSION = 4;
// v2: master/segmentsを廃止(§5.4)。v1は字幕部分のみ読み取って移行する。
export var TIMELINE_JSON_VERSION = 2;

function isValidClip(c) {
  if (!c || typeof c !== 'object') return false;
  if (typeof c.text !== 'string') return false;
  if (typeof c.durMs !== 'number' || !isFinite(c.durMs)) return false;
  if (typeof c.delim !== 'string') return false;
  if (typeof c.edited !== 'boolean') return false;
  if (typeof c.en !== 'string') return false;
  return true;
}

function isValidClips(clips) {
  if (!Array.isArray(clips)) return false;
  for (var i = 0; i < clips.length; i++) {
    if (!isValidClip(clips[i])) return false;
  }
  return true;
}

// ---- localStorage 永続化: スキーマ検証とシリアライズ(DOMに依存しない純粋部分) ----
// version 3(動画トラック撤去前)も字幕フィールドは同一構造のため有効として受け入れる
// (master/segmentsは検証せず単に無視する)。
export function isValidSessionData(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.version !== SCHEMA_VERSION && data.version !== 3) return false;
  if (typeof data.manuscript !== 'string') return false;
  if (typeof data.translation !== 'string') return false;
  if (typeof data.cps !== 'number' || !isFinite(data.cps)) return false;
  if (typeof data.bom !== 'boolean') return false;
  if (data.mode !== 'input' && data.mode !== 'edit') return false;
  if (!isValidClips(data.clips)) return false;
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

// ---- timeline.json(セーブ/ロード形式、§5.4) ----
// 作業状態(subs/cps/style)の保存・復元が主目的。
// localStorageセッション(manuscript/translation/mode/zoom/headTimeMs等)とは別スキーマ・別バージョン管理。
// version 1(master/segments付き)も字幕フィールドは同一構造のため有効として受け入れる
// (master/segmentsは検証せず単に無視する)。
export function isValidTimelineJson(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.version !== TIMELINE_JSON_VERSION && data.version !== 1) return false;
  if (!isValidClips(data.subs)) return false;
  if (typeof data.cps !== 'number' || !isFinite(data.cps)) return false;
  if (!data.style || typeof data.style !== 'object') return false;
  if (typeof data.style.fontSize !== 'number' || !isFinite(data.style.fontSize) || data.style.fontSize <= 0) return false;
  if (typeof data.style.calibration !== 'number' || !isFinite(data.style.calibration)) return false;
  return true;
}

export function serializeTimelineJson(state) {
  return JSON.stringify({
    version: TIMELINE_JSON_VERSION,
    subs: state.subs.map(function (c) {
      return { text: c.text, durMs: c.durMs, edited: c.edited, delim: c.delim, en: c.en };
    }),
    cps: state.cps,
    style: { fontSize: state.style.fontSize, calibration: state.style.calibration }
  }, null, 2);
}

// version不一致・スキーマ不正は読み込み拒否する(原稿テキストと同じく黙って改変・補正しない)。
export function deserializeTimelineJson(raw) {
  var data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return null;
  }
  if (!isValidTimelineJson(data)) return null;
  return data;
}
