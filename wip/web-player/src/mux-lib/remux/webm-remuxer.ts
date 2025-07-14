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

import { Remuxer, InitSegment } from './remuxer.js';
import { WebMGenerator } from './webm-generator.js';
import { Callback, assertCallback } from '../utils/common.js';
import { FLVDemuxer, AudioTrack, VideoTrack, VideoFrame, AudioFrame, AudioMetadata, VideoMetadata } from '../demux/flv-demuxer.js';
import Log from '../utils/logger.js';
import { MediaSegmentInfoList, TrackType } from '../core/media-segment-info.js';
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
  private _refFrameDuration = 33.333333333333336;             // Default to 30fps

  private _audioSegmentInfoList = new MediaSegmentInfoList(TrackType.Audio);
  private _videoSegmentInfoList = new MediaSegmentInfoList(TrackType.Video);

  private _onInitSegment = assertCallback;
  private _onMediaSegment = assertCallback;

  destroy(): void {
    Log.v(WebMRemuxer.TAG, 'nothing to destroy');
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
  
  seek(originalDts: number): void {
    this._audioStashedLastFrame = null;
    this._videoStashedLastFrame = null;
    this._videoSegmentInfoList.clear();
    this._audioSegmentInfoList.clear();
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

    if (videoTrack) {
      this._remuxVideo(videoTrack);
    }
    if (audioTrack && false) {
      this._remuxAudio(audioTrack);
    }
  }

  _onTrackMetadata = (metadata: AudioMetadata | VideoMetadata): void => {
    Log.a(WebMRemuxer.TAG, 'onTrackMetadata: onInitSegment callback must be specified!', this._onInitSegment);

    let segmentData: Uint8Array;

    if (metadata.type === TrackType.Audio) {
      return; // we will fix this later
      const audioMetadata = metadata as AudioMetadata;
      segmentData = WebMGenerator.generateAudioInitSegment(new Uint8Array()); // !!@ fix this
      this._isAudioMetadataDispatched = true;
    } else {
      const videoMetadata = metadata as VideoMetadata;
      this._refFrameDuration = Number.isFinite(videoMetadata.refFrameDuration) ? videoMetadata.refFrameDuration : this._refFrameDuration;
      segmentData = WebMGenerator.generateVideoInitSegment(videoMetadata.av1c!, videoMetadata.codecWidth, videoMetadata.codecHeight);
      this._isVideoMetadataDispatched = true;
    }

    const initSegment: InitSegment = {
      type: metadata.type,
      data: segmentData.buffer,
      codec: `${metadata.codec}`,
      container: 'video/webm',
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

  private _remuxVideo(videoTrack: VideoTrack, force: boolean = false): void {
    if (this._isVideoMetadataDispatched != true || videoTrack.frames.length === 0) {
      return;
    }

    // Ensure WebM clusters start with keyframes for proper MSE playback
    // If first frame is not a keyframe and we're not forcing, wait for next keyframe
    if (!force && videoTrack.frames.length > 0 && !videoTrack.frames[0].isKeyframe) {
      // Keep frames in demuxer's queue until we get a keyframe
      return;
    }

    if (videoTrack.frames.length === 1 && !force) {
      // !!@ is this a needed case? check audio track for this logic as well
      // Ignore and keep in demuxer's queue
      return;
    }

    const info = new MediaSegmentInfo();
    const firstFrame = videoTrack.frames[0];
    const lastFrame = videoTrack.frames[videoTrack.frames.length - 1];

    // Add all keyframes to syncPoints
    for (const frame of videoTrack.frames) {
      if (frame.isKeyframe) {
        const syncPoint = new FrameInfo(
          frame.dts,
          frame.pts,
          0, // duration will be calculated by seeking handler
          frame.dts,
          true
        );
        info.appendSyncPoint(syncPoint);
      }
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

    const segment = WebMGenerator.generateVideoClusterBlock(videoTrack.frames, this._refFrameDuration);
    // Log.v(WebMRemuxer.TAG, `Generated video segment, length: ${segment.byteLength} \n${Log.dumpArrayBuffer(segment, 100)}`);

    this._onMediaSegment(TrackType.Video, {
      type: TrackType.Video,
      data: segment.buffer,
      frameCount: videoTrack.frames.length,
      info: info
    });

    videoTrack.frames = [];
    videoTrack.length = 0;
  }

  private _remuxAudio(audioTrack: AudioTrack, force: boolean = false): void {
    //Log.a(WebMRemuxer.TAG, '_remuxAudio method not implemented.');
    //!!@this.generator.remuxAudio(audioTrack);
  }
}