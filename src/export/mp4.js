// mediabunny書き出しパイプライン(§5.1-5.2)。mediabunnyへの依存はこのファイル
// (と§4.3の判定を担うcheckMasterDecodability)に閉じ込め、src/core/* には持ち込まない。

import {
  Input, BlobSource, ALL_FORMATS, Output, Mp4OutputFormat, BufferTarget,
  CanvasSource, CanvasSink, AudioBufferSink, AudioBufferSource, QUALITY_HIGH
} from '../../vendor/mediabunny.js';
import { totalDurationMs, clipAt } from '../core/time.js';
import { outputToSrc, frameTimestampsMs } from '../core/videotrack.js';
import { CANVAS_BASE_WIDTH } from '../core/style.js';
import { drawSubtitleText, CANVAS_HEIGHT } from '../ui/preview.js';

var FPS = 30; // §5.1
var AUDIO_BITRATE = 128e3; // AAC 128kbps(§5.1)

// §4.3: マスター選択時のデコード可否判定(mediabunnyのデマルチプレクサで実ファイルの
// トラック/コーデックを読み取って判定する。VideoDecoder.isConfigSupportedへの
// コーデック文字列の推測は不要になる)。
export async function checkMasterDecodability(file) {
  var input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  var videoTrack = await input.getPrimaryVideoTrack();
  var audioTrack = await input.getPrimaryAudioTrack();
  var videoDecodable = videoTrack ? await videoTrack.canDecode() : false;
  var audioDecodable = audioTrack ? await audioTrack.canDecode() : null; // トラックが無い場合はnull(判定対象外)
  return {
    hasVideoTrack: videoTrack !== null,
    videoDecodable: videoDecodable,
    hasAudioTrack: audioTrack !== null,
    audioDecodable: audioDecodable
  };
}

// 区間[srcInMs, srcInMs+durMs)の音声をAudioBufferSinkから切り出し、1本のAudioBufferに
// まとめる。sinkが返す各チャンクは区間境界とぴったり一致するとは限らないため、
// タイムスタンプから算出したサンプルオフセットで正確な位置に書き込む(はみ出す部分は破棄)。
async function buildSegmentAudioBuffer(audioSink, srcInMs, durMs, sampleRate, numberOfChannels) {
  var startSec = srcInMs / 1000;
  var endSec = (srcInMs + durMs) / 1000;
  var numberOfSamples = Math.max(1, Math.round((durMs / 1000) * sampleRate));
  var out = new AudioBuffer({ length: numberOfSamples, numberOfChannels: numberOfChannels, sampleRate: sampleRate });

  for await (var wrapped of audioSink.buffers(startSec, endSec)) {
    var buffer = wrapped.buffer;
    var offsetSamples = Math.round((wrapped.timestamp - startSec) * sampleRate);
    for (var ch = 0; ch < numberOfChannels; ch++) {
      var srcData = buffer.getChannelData(Math.min(ch, buffer.numberOfChannels - 1));
      var dstData = out.getChannelData(ch);
      for (var i = 0; i < srcData.length; i++) {
        var dstIndex = offsetSamples + i;
        if (dstIndex >= 0 && dstIndex < numberOfSamples) dstData[dstIndex] = srcData[i];
      }
    }
  }
  return out;
}

// MP4書き出し本体(§5.1-5.2)。
// - 解像度1080x1920固定・cover fit、H.264(WebCodecsハードウェアエンコード)、30fps固定
// - 音声はマスターから区間ごとに切り出して連結し、AAC 128kbpsで再エンコード
// - フレーム境界は累積msから導出(frameTimestampsMs、区間ごとの個別丸めなし)
// - 字幕描画はsrc/ui/preview.jsのdrawSubtitleTextをそのまま共有する(§5.3、書き出し専用の
//   描画実装は新設しない)
export async function exportMp4(options) {
  var masterFile = options.masterFile;
  var segments = options.segments;
  var subs = options.subs;
  var fontSize = options.fontSize;
  var calibration = options.calibration;
  var onProgress = options.onProgress || function () {};
  var signal = options.signal;

  function checkAborted() {
    if (signal && signal.aborted) {
      throw new DOMException('書き出しがキャンセルされました', 'AbortError');
    }
  }

  var input = new Input({ source: new BlobSource(masterFile), formats: ALL_FORMATS });
  var videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) {
    throw new Error('マスターに映像トラックが見つかりません');
  }
  var audioTrack = await input.getPrimaryAudioTrack();

  var output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });

  var canvas = document.createElement('canvas');
  canvas.width = CANVAS_BASE_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  var ctx = canvas.getContext('2d');

  var videoSource = new CanvasSource(canvas, {
    codec: 'avc',
    bitrate: QUALITY_HIGH,
    hardwareAcceleration: 'prefer-hardware'
  });
  output.addVideoTrack(videoSource, { frameRate: FPS });

  var audioSource = null;
  if (audioTrack) {
    audioSource = new AudioBufferSource({ codec: 'aac', bitrate: AUDIO_BITRATE });
    output.addAudioTrack(audioSource);
  }

  await output.start();

  try {
    // ---- 音声: 区間ごとに切り出して連結・再エンコード ----
    if (audioTrack && audioSource) {
      var sampleRate = await audioTrack.getSampleRate();
      var numberOfChannels = await audioTrack.getNumberOfChannels();
      var audioSink = new AudioBufferSink(audioTrack);
      for (var si = 0; si < segments.length; si++) {
        checkAborted();
        var seg = segments[si];
        var segBuffer = await buildSegmentAudioBuffer(audioSink, seg.srcInMs, seg.durMs, sampleRate, numberOfChannels);
        await audioSource.add(segBuffer);
        onProgress({ phase: 'audio', ratio: (si + 1) / segments.length });
      }
    }

    // ---- 映像: フレーム境界を累積msから導出し、cover fit + 字幕合成 ----
    var totalMs = totalDurationMs(segments);
    var frameTimes = frameTimestampsMs(totalMs, FPS);
    var canvasSink = new CanvasSink(videoTrack, {
      width: CANVAS_BASE_WIDTH,
      height: CANVAS_HEIGHT,
      fit: 'cover',
      poolSize: 1
    });
    var frameDurationSec = (1000 / FPS) / 1000;

    for (var i = 0; i < frameTimes.length; i++) {
      checkAborted();
      var outputMs = frameTimes[i];
      var srcMs = outputToSrc(segments, outputMs);
      var wrapped = await canvasSink.getCanvas(srcMs / 1000);

      if (wrapped) {
        ctx.drawImage(wrapped.canvas, 0, 0, CANVAS_BASE_WIDTH, CANVAS_HEIGHT);
      } else {
        ctx.fillStyle = '#808080';
        ctx.fillRect(0, 0, CANVAS_BASE_WIDTH, CANVAS_HEIGHT);
      }

      var subIdx = clipAt(subs, outputMs);
      var text = subIdx === -1 ? null : subs[subIdx].text;
      drawSubtitleText(ctx, text, fontSize, calibration, CANVAS_BASE_WIDTH, CANVAS_HEIGHT);

      await videoSource.add(outputMs / 1000, frameDurationSec);
      onProgress({ phase: 'video', ratio: (i + 1) / frameTimes.length });
    }

    await output.finalize();
  } catch (err) {
    if (output.state !== 'finalized' && output.state !== 'canceled') {
      await output.cancel();
    }
    throw err;
  }

  return new Blob([output.target.buffer], { type: 'video/mp4' });
}
