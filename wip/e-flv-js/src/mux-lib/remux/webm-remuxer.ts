/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Copyright (C) 2025 Veovera Software Organization.
 * @author Slavik Lozben
 */

/**
 * =============================================================================
 * WebMRemuxer: WebM Container Remuxing
 * =============================================================================
 *
 * This class receives parsed audio/video frames (e.g., VP8, VP9, AV1, Opus)
 * and organizes them into a valid WebM container structure for browser playback.
 * It is designed to be used in a modular media pipeline, typically within a
 * Web Worker, and works in conjunction with demuxers, the WebMGenerator, and
 * the main thread's Media Source Extensions (MSE) controller.
 *
 * -----------------------------------------------------------------------------
 * High-Level Flow:
 *
 *   [ Demuxer ]
 *      |
 *      v
 *   [ WebMRemuxer ]
 *      |
 *      |  (organizes frames, manages timing/segmenting)
 *      v
 *   [ WebMGenerator ]
 *      |
 *      |  (builds WebM init and media segments, returns Uint8Array segment)
 *      v
 *   [ WebMRemuxer ]
 *      |
 *      |  emits segment to the next pipeline stage
 *      v  
 * [ Controller / Worker ]
 *      |
 *      |  (sends segments to main thread via postMessage)
 *      v
 * [ TransmuxingController._onRemuxerInitSegmentArrival ]
 *      |
 *      |  (emits INIT_SEGMENT event)
 *      v
 * [ Player / Main Thread / Other Controller ]
 *      |
 *      |  (listens for INIT_SEGMENT event)
 *      v
 *   [ MSE Controller (Main Thread) ]
 *      |
 *      |  (appends segments to SourceBuffer)
 *      v
 *   [ <video> Element ]
 *
 * -----------------------------------------------------------------------------
 * Responsibilities:
 * - Accepts raw frames and metadata from demuxers.
 * - Organizes frames into WebM clusters and blocks.
 * - Uses WebMGenerator to build initialization and media segments for MSE playback.
 * - Emits or passes the generated segments to the next pipeline stage (e.g., controller/worker).
 * - Exposes a consistent interface for use in a polymorphic remuxing pipeline.
 *
 * This class enables browser-based playback of WebM streams using the Media
 * Source Extensions API, supporting modern codecs and adaptive streaming.
 * =============================================================================
 */

import { Remuxer, MSEInitSegment, MSEMediaSegment, TrackType, SegmentKind } from './remuxer.js';
import { WebMGenerator } from './webm-generator.js';
import { Callback, assertCallback } from '../utils/common.js';
import { FLVDemuxer, AudioTrack, VideoTrack, VideoFrame, AudioFrame, AudioMetadata, VideoMetadata } from '../demux/flv-demuxer.js';
import Log from '../utils/logger.js';
import { MediaSegmentInfoList } from '../core/media-segment-info.js';
import { MediaSegmentInfo, FrameInfo } from '../core/media-segment-info.js';

export class WebMRemuxer extends Remuxer {
  static readonly TAG = 'WebMRemuxer';

  private _dtsBase = NaN;
  private _audioDtsBase = Infinity;
  private _videoDtsBase = Infinity;
  private _audioNextDts = NaN;                                // !!@ do we need this?
  private _videoNextDts = NaN;                                // !!@ do we need this?
  private _audioStashedLastFrame: AudioFrame | null = null;
  private _videoStashedLastFrame: VideoFrame | null = null;
  private _refVideoFrameDuration = 33.333333333333336;        // Default to 30fps
  private _refAudioFrameDuration = 20;                        // 20ms for Opus (standard frame duration)
  private _audioSegmentInfoList = new MediaSegmentInfoList(TrackType.Audio);
  private _videoSegmentInfoList = new MediaSegmentInfoList(TrackType.Video);
  private _pendingVideoFrames: VideoFrame[] = [];

  private _onInitSegment = assertCallback;
  private _onMediaSegment = assertCallback;

  destroy(): void {
    this.clear();
  }

  get onInitSegment(): Callback {
    return this._onInitSegment;
  }
  
  set onInitSegment(callback: Callback) {
    this._onInitSegment = callback;
  }

  get onMediaSegment(): Callback {
    return this._onMediaSegment;
  }

  set onMediaSegment(callback: Callback) {
    this._onMediaSegment = callback;
  }
  
  /**
   * Binds this remuxer to a data producer (e.g. FLVDemuxer)
   * Sets up callbacks to handle incoming media data and track metadata
   * @param producer The data producer to bind to
   * @returns this instance for chaining
   */
  bindDataSource(producer: FLVDemuxer): this {
    producer.onTrackData = this._onTrackData;
    producer.onTrackMetadata = this._onTrackMetadata;
    return this;
  }
  
  insertDiscontinuity(): void {
    this._audioNextDts = this._videoNextDts = NaN;
  } 
  
  clear(): void {
    this._audioStashedLastFrame = null;
    this._videoStashedLastFrame = null;
    this._videoSegmentInfoList.clear();
    this._audioSegmentInfoList.clear();
    this._pendingVideoFrames = [];
  }
  
  // !!@ TODO: try to move away from undefined when dealing with numbers?
  get timestampBase(): number | undefined {
    return Number.isFinite(this._dtsBase) ? this._dtsBase : undefined;
  }
  
  flushStashedFrames(): void {
    let videoFrame = this._videoStashedLastFrame;
    let audioFrame = this._audioStashedLastFrame;

    let videoTrack: VideoTrack = {
      type: TrackType.Video,
      id: 1,
      sequenceNumber: 0,
      frames: [],
      length: 0,
    };

    if (videoFrame != null) {
      videoTrack.frames.push(videoFrame);
      videoTrack.length = videoFrame.length;
    }

    let audioTrack: AudioTrack = {
      type: TrackType.Audio,
      id: 2,
      sequenceNumber: 0,
      frames: [],
      length: 0
    };

    if (audioFrame != null) {
      audioTrack.frames.push(audioFrame);
      audioTrack.length = audioFrame.length;
    }

    this._videoStashedLastFrame = null;
    this._audioStashedLastFrame = null;

    this._remuxVideo(videoTrack, true);
    this._remuxAudio(audioTrack, true);
  }
  
  _onTrackData = (audioTrack: AudioTrack, videoTrack: VideoTrack): void => {
    Log.a(WebMRemuxer.TAG, 'onMediaSegment callback must be specificed!', this._onMediaSegment);
    
    if (Number.isNaN(this._dtsBase)) {
      this._calculateDtsBase(audioTrack, videoTrack);
    }

    this._remuxVideo(videoTrack);
    this._remuxAudio(audioTrack);
  }

  _onTrackMetadata = (metadata: AudioMetadata | VideoMetadata): void => {
    Log.a(WebMRemuxer.TAG, 'onTrackMetadata: onInitSegment callback must be specified!', this._onInitSegment);

    let segmentRawData: Uint8Array;

    if (metadata.type === TrackType.Audio) {
      const audioMetadata = metadata as AudioMetadata;
      this._refAudioFrameDuration = Number.isFinite(audioMetadata.refFrameDuration) ? audioMetadata.refFrameDuration : this._refAudioFrameDuration;
      segmentRawData = WebMGenerator.generateAudioInitSegment(audioMetadata);
      this._isAudioMetadataDispatched = true;
    } else {
      const videoMetadata = metadata as VideoMetadata;
      this._refVideoFrameDuration = Number.isFinite(videoMetadata.refFrameDuration) ? videoMetadata.refFrameDuration : this._refVideoFrameDuration;
      segmentRawData = WebMGenerator.generateVideoInitSegment(videoMetadata);
      this._isVideoMetadataDispatched = true;
    }

    if (__DEBUG__ && WebMRemuxer.DEBUG_BUFFER) {
      Remuxer.dbgVideoBuffer = segmentRawData.slice();
    }

    const initSegment: MSEInitSegment = {
      kind: SegmentKind.Init,
      type: metadata.type,
      data: segmentRawData,
      codec: `${metadata.codec}`,
      container: (metadata.type === TrackType.Audio) ? 'audio/webm' : 'video/webm',
      mediaDuration: metadata.duration
    };

    this._onInitSegment(metadata.type, initSegment);
  }

  private _calculateDtsBase (audioTrack: AudioTrack, videoTrack: VideoTrack): void {
    if (!Number.isNaN(this._dtsBase)) {
      return;
    }

    if (audioTrack.frames.length > 0) {
      this._audioDtsBase = audioTrack.frames[0].dts;
    }
    if (videoTrack.frames.length > 0) {
      this._videoDtsBase = videoTrack.frames[0].dts;
    }

    this._dtsBase = Math.min(this._audioDtsBase, this._videoDtsBase);
  }

  private _flushPendingVideoFrames() {
    if (this._pendingVideoFrames.length === 0) {
      return;
    }

    const info = new MediaSegmentInfo();
    const firstFrame = this._pendingVideoFrames[0];
    const lastFrame = this._pendingVideoFrames[this._pendingVideoFrames.length - 1];

    if (!firstFrame.isKeyframe) {
      Log.e(WebMRemuxer.TAG, 'Pending video frames must start with a keyframe');
    }

    // Add all keyframes to syncPoints
    if (firstFrame.isKeyframe) {
      const syncPoint = new FrameInfo(
        firstFrame.dts,
        firstFrame.pts,
        0, // duration will be calculated by seeking handler
        firstFrame.dts,
        true
      );
      info.appendSyncPoint(syncPoint);
    }
  
    // Set segment info
    info.beginDts = firstFrame.dts;
    info.endDts = lastFrame.dts;
    info.beginPts = firstFrame.pts;
    info.endPts = lastFrame.pts;
    info.originalBeginDts = firstFrame.dts;
    info.originalEndDts = lastFrame.dts;
    info.firstFrame = new FrameInfo(
      firstFrame.dts,
      firstFrame.pts,
      0,
      firstFrame.dts,
      firstFrame.isKeyframe
    );
    info.lastFrame = new FrameInfo(
      lastFrame.dts,
      lastFrame.pts,
      0,
      lastFrame.dts,
      lastFrame.isKeyframe
    );

    //Log.v(WebMRemuxer.TAG, `_remuxVideo() - videoTrack.frames.length: ${videoTrack.frames.length} *************************************************`);
    //for (const frame of videoTrack.frames) {
    //  Log.v(WebMRemuxer.TAG, `    Input Frame: dts=${frame.dts}, pts=${frame.pts}, isKeyframe=${frame.isKeyframe}, dataSize=${frame.rawData?.length ?? 0} fileposition=${frame.fileposition}`);
    //}

    const segmentRawData = WebMGenerator.generateVideoCluster(this._pendingVideoFrames, 0, this._refVideoFrameDuration);
    // Log.v(WebMRemuxer.TAG, `Generated video segment, length: ${segment.byteLength} \n${Log.dumpArrayBuffer(segment, 100)}`);

    if (__DEBUG__ && Remuxer.DEBUG_BUFFER) {
      //Log.d(WebMRemuxer.TAG, `Generating segment - frameCount: ${videoTrack.frames.length} beginDts: ${info.beginDts} dstEnd: ${info.endDts} size: ${segmentRawData.length} `);
      //Log.d(WebMRemuxer.TAG, `\n${Log.dumpArrayBuffer(segmentRawData, 512)}`);

      const combined = new Uint8Array(Remuxer.dbgVideoBuffer.length + segmentRawData.length);
      combined.set(Remuxer.dbgVideoBuffer, 0);
      combined.set(segmentRawData, Remuxer.dbgVideoBuffer.length);
      Remuxer.dbgVideoBuffer = combined;
    }

    const mediaSegment: MSEMediaSegment = {
      kind: SegmentKind.Media,
      type: TrackType.Video,
      data: segmentRawData,
      frameCount: this._pendingVideoFrames.length,
      info: info
    };
    this._onMediaSegment(TrackType.Video, mediaSegment);
    this._pendingVideoFrames = [];
  }

  private _remuxVideo(videoTrack: VideoTrack, force: boolean = false): void {
    if (videoTrack.frames.length === 0 && !force) {
      return;
    }

    if (!this.isVideoMetadataDispatched) {
      Log.w(WebMRemuxer.TAG, '_remuxVideo: VideoData received before CodecConfigurationRecord');
      return;
    }

    for (const frame of videoTrack.frames) {
      if (frame.isKeyframe) {
        this._flushPendingVideoFrames();
        videoTrack.sequenceNumber++;
      }
      this._pendingVideoFrames.push(frame);
    }

    // Force flush if requested (e.g., at end of stream or discontinuity)
    if (force) {
      this._flushPendingVideoFrames();
    }

    videoTrack.frames = [];
    videoTrack.length = 0;
  }

  private _remuxAudio(audioTrack: AudioTrack, force: boolean = false): void {
    if (audioTrack.frames.length === 0) {
      return;
    }

    if (!this._isAudioMetadataDispatched) {
      Log.w(WebMRemuxer.TAG, '_remuxAudio: AudioData received before CodecConfigurationRecord');
      return;
    }

    let track = audioTrack;
    let frames: AudioFrame[] = track.frames;
    let firstDts = -1, lastDts = -1;

    if (frames.length === 1 && !force) {
      return;
    }

    let lastFrame: AudioFrame | undefined;

    if (frames.length > 1) {
      lastFrame = frames.pop();
    }

    if (this._audioStashedLastFrame != null) {
      let frame = this._audioStashedLastFrame;
      this._audioStashedLastFrame = null;
      frames.unshift(frame);
    }

    if (lastFrame != null) {
      this._audioStashedLastFrame = lastFrame;
    }

    if (frames.length === 0) {
      return;
    }

    let firstFrameOriginalDts = frames[0].dts - this._dtsBase;

    if (!Number.isNaN(this._audioNextDts)) {
      let dtsCorrection = firstFrameOriginalDts - this._audioNextDts;
      for (let i = 0; i < frames.length; i++) {
        frames[i].dts = frames[i].dts - dtsCorrection;
      }
    } else {
      this._audioNextDts = firstFrameOriginalDts;
    }

    firstDts = frames[0].dts;
    lastDts = frames[frames.length - 1].dts;

    this._audioNextDts = lastDts + this._refAudioFrameDuration;

    let segmentRawData = WebMGenerator.generateAudioCluster(frames, 0, this._refAudioFrameDuration);

    if (__DEBUG__ && WebMRemuxer.DEBUG_BUFFER) {
      Remuxer.dbgAudioBuffer = segmentRawData.slice();
    }

    let info = new MediaSegmentInfo();
    info.beginDts = firstDts;
    info.endDts = lastDts;
    info.beginPts = firstDts;
    info.endPts = lastDts;
    info.originalBeginDts = firstFrameOriginalDts;
    info.originalEndDts = frames[frames.length - 1].dts - this._dtsBase;
    info.firstFrame = new FrameInfo(firstDts, firstDts, this._refAudioFrameDuration, frames[0].length, false);
    info.lastFrame = new FrameInfo(lastDts, lastDts, this._refAudioFrameDuration, frames[frames.length - 1].length, false);
    this._audioSegmentInfoList.append(info);

    let segment: MSEMediaSegment = {
      kind: SegmentKind.Media,
      type: TrackType.Audio,
      data: segmentRawData,
      frameCount: frames.length,
      info: info
    };

    if (this._onMediaSegment) {
      this._onMediaSegment(TrackType.Audio, segment);
    }

    track.frames = [];
    track.length = 0;
  }
}