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
 * Remuxes parsed VP9/AV1 video and Opus audio into WebM initialization and
 * media segments using WebMGenerator. VP8 demuxing support is planned.
 * The currently enabled application pipeline demuxes and remuxes on the browser's
 * main thread, which also handles UI and video-element coordination, rather than
 * offloading that work to a Web Worker. This is an application configuration,
 * not a requirement of WebMRemuxer: the class can also run in a worker and
 * does not access the DOM or Media Source Extensions directly.
 *
 * -----------------------------------------------------------------------------
 * High-Level Flow:
 *
 *   Demuxer
 *      -> RemuxerRouter
 *      -> WebMRemuxer (uses WebMGenerator to build segment bytes)
 *      -> RemuxerRouter callbacks
 *      -> TransmuxingController (INIT_SEGMENT / MEDIA_SEGMENT events)
 *      -> Player (optional worker messaging follows the controller events)
 *      -> MSEController -> SourceBuffer -> <video>
 *
 * -----------------------------------------------------------------------------
 * Responsibilities:
 * - Emits initialization segments when track metadata arrives.
 * - Buffers video per GOP; the next keyframe flushes the previous GOP before
 *   starting a new one. A forced drain emits the trailing GOP immediately.
 * - Emits each audio batch immediately, without holding a lookahead frame.
 * - Normalizes frame timestamps to the shared presentation origin.
 * - Carries frame track IDs and codec kinds into emitted media segments.
 * - Exposes the shared remuxer API; flushBufferedFrames() emits the pending
 *   video GOP but does not drain frames still queued in the demuxer.
 *
 * Initial video playback and track switches need a keyframe suitable for
 * starting decoding without earlier frames from that track.
 * Remuxing non-keyframes does not make them independently decodable;
 * this remuxer does not discard leading non-keyframes automatically.
 * At a track switch, old media must be drained under the old metadata before
 * the new initialization segment is emitted.
 * =============================================================================
 */

import { Remuxer, MSEInitSegment, MSEMediaSegment, TrackType, SegmentKind, type DrainTarget } from './remuxer.js';
import { WebMGenerator } from './webm-generator.js';
import { AudioTrack, VideoTrack, VideoFrame, AudioFrame, AudioMetadata, VideoMetadata } from '../demux/flv-demuxer.js';
import Log from '../utils/logger.js';
import { MediaSegmentInfo, FrameInfo } from '../core/media-segment-info.js';

export class WebMRemuxer extends Remuxer {
  static readonly TAG = 'WebMRemuxer';

  private _refVideoFrameDuration = 33.333333333333336;        // Default to 30fps
  private _refAudioFrameDuration = 20;                        // 20ms for Opus (standard frame duration)
  private _pendingVideoFrames: VideoFrame[] = [];

  destroy(): void {
    this._resetTimelineState();
    this._clearMetadata();
    this._pendingVideoFrames = [];
    this._resetCallbacks();
  }
  
  clear(): void {
    this._clearTrackState();
    this._pendingVideoFrames = [];
  }
  
  flushBufferedFrames(): void {
    // Audio is never stashed in the WebM path: _remuxAudio() emits every
    // batch it's given immediately, so there's no held-back audio frame to
    // flush here (unlike MP4Remuxer). Video buffers frames per-GOP and only
    // flushes on the next keyframe, so a forced flush is still needed to
    // emit a trailing, keyframe-less GOP.
    this._flushPendingVideoFrames();
  }

  // WebM emits its initialization segment as soon as metadata arrives.
  flushPendingInitSegments(): void {}
  
  protected _onTrackData(audioTrack: AudioTrack, videoTrack: VideoTrack, drainTarget?: DrainTarget): void {
    Log.a(WebMRemuxer.TAG, 'onMediaSegment callback must be specificed!', this._onMediaSegment);
    
    if (this._dtsBase === Infinity) {
      this._calculateDtsBase(audioTrack, videoTrack);
    }


    this._remuxVideo(videoTrack, drainTarget === TrackType.Video || drainTarget === 'both');
    // WebM audio emits the entire batch without stashing a duration lookahead
    // or buffering a GOP, so normal remuxing already drains it.
    this._remuxAudio(audioTrack);
  }

  protected _onTrackMetadata(metadata: AudioMetadata | VideoMetadata): void {
    Log.a(WebMRemuxer.TAG, 'onTrackMetadata: onInitSegment callback must be specified!', this._onInitSegment);

    const flvTagTimestamp = metadata.flvTagTimestamp;
    if (flvTagTimestamp < 0) {
      Log.w(WebMRemuxer.TAG, `_onTrackMetadata(): invalid FLV tag timestamp for ${metadata.type} codec configuration`);
    }

    let segmentRawData: Uint8Array;

    if (metadata.type === TrackType.Audio) {
      const audioMetadata = this._audioMeta = metadata as AudioMetadata;
      this._refAudioFrameDuration = Number.isFinite(audioMetadata.refFrameDuration) ? audioMetadata.refFrameDuration : this._refAudioFrameDuration;
      segmentRawData = WebMGenerator.generateAudioInitSegment(audioMetadata);
    } else {
      const videoMetadata = this._videoMeta = metadata as VideoMetadata;
      this._refVideoFrameDuration = Number.isFinite(videoMetadata.refFrameDuration) ? videoMetadata.refFrameDuration : this._refVideoFrameDuration;
      segmentRawData = WebMGenerator.generateVideoInitSegment(videoMetadata);
    }

    const initSegment: MSEInitSegment = {
      trackId: metadata.trackId,
      kind: SegmentKind.Init,
      type: metadata.type,
      data: segmentRawData,
      flvTagTimestamp,
      codec: `${metadata.codec}`,
      container: (metadata.type === TrackType.Audio) ? 'audio/webm' : 'video/webm',
      mediaDuration: metadata.duration
    };

    this._onInitSegment(metadata.type, initSegment);
  }

  private _flushPendingVideoFrames() {
    if (this._pendingVideoFrames.length === 0) {
      return;
    }

    const info = new MediaSegmentInfo();
    const firstFrame = this._pendingVideoFrames[0];
    const lastFrame = this._pendingVideoFrames[this._pendingVideoFrames.length - 1];
    const originalDts = (frame: VideoFrame): number => (frame as VideoFrame & { originalDts?: number }).originalDts ?? frame.dts;

    if (!firstFrame.isKeyframe) {
      Log.e(WebMRemuxer.TAG, 'Pending video frames must start with a keyframe');
    }

    // Add all keyframes to syncPoints
    if (firstFrame.isKeyframe) {
      const syncPoint = new FrameInfo(
        firstFrame.dts,
        firstFrame.pts,
        0, // duration will be calculated by seeking handler
        originalDts(firstFrame),
        true
      );
      info.appendSyncPoint(syncPoint);
    }
  
    // Set segment info
    info.beginDts = firstFrame.dts;
    info.endDts = lastFrame.dts;
    info.beginPts = firstFrame.pts;
    info.endPts = lastFrame.pts;
    // Keep segment-history coordinates relative to the shared base, matching
    // MP4Remuxer. Sync points retain the source DTS above for seek resolution.
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

    Log.debugAssert(WebMRemuxer.TAG, 'Video segment trackId is inconsistent', () => this._pendingVideoFrames.every((frame) => frame.trackId === firstFrame.trackId));
    Log.debugAssert(WebMRemuxer.TAG, 'Video segment codec is inconsistent', () => this._pendingVideoFrames.every((frame) => frame.codecKind === firstFrame.codecKind));
    const segmentRawData = WebMGenerator.generateVideoCluster(this._pendingVideoFrames, 0, this._refVideoFrameDuration, firstFrame.codecKind);

    const mediaSegment: MSEMediaSegment = {
      trackId: firstFrame.trackId,
      codecKind: firstFrame.codecKind,
      kind: SegmentKind.Media,
      type: TrackType.Video,
      data: segmentRawData,
      frameCount: this._pendingVideoFrames.length,
      firstFlvTagTimestamp: firstFrame.flvTagTimestamp,
      lastFlvTagTimestamp: lastFrame.flvTagTimestamp,
      info: info
    };
    this._onMediaSegment(TrackType.Video, mediaSegment);
    this._pendingVideoFrames = [];
  }

  private _remuxVideo(videoTrack: VideoTrack, force: boolean = false): void {
    // If video metadata is not available, we cannot remux video frames yet.
    if (!this._videoMeta) {
      if (videoTrack.frames.length > 0) {
        Log.w(WebMRemuxer.TAG, '_remuxVideo: VideoData received before CodecConfigurationRecord');
      }
      return;
    }

    if (videoTrack.frames.length === 0) {
      if (force) {
        this._flushPendingVideoFrames();
      }
      return;
    }

    // WebM clusters use their frame DTS values directly. Normalize them to the
    // shared presentation origin before generating clusters, matching MP4's
    // dts - base behavior.
    const normalizedFrames = videoTrack.frames.map((frame) => Object.assign({}, frame, {
      dts: frame.dts - this._dtsBase,
      pts: frame.pts - this._dtsBase,
      originalDts: frame.dts
    })) as VideoFrame[];
    const normalizedTrack: VideoTrack = {
      ...videoTrack,
      frames: normalizedFrames
    };

    for (const frame of normalizedTrack.frames) {
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

  private _remuxAudio(audioTrack: AudioTrack): void {
    if (!this._audioMeta) {
      if (audioTrack.frames.length > 0) {
        Log.w(WebMRemuxer.TAG, '_remuxAudio: AudioData received before CodecConfigurationRecord');
      }
      return;
    }

    if (audioTrack.frames.length === 0) {
      return;
    }

    const sourceTrack = audioTrack;
    let track: AudioTrack = {
      ...audioTrack,
      frames: audioTrack.frames.map((frame) => ({
        ...frame,
        dts: frame.dts - this._dtsBase,
        pts: frame.pts - this._dtsBase
      }))
    };
    let frames: AudioFrame[] = track.frames;
    let firstDts = -1, lastDts = -1;
    let firstFrame = frames[0];

    Log.debugAssert(WebMRemuxer.TAG, 'Audio segment trackId is inconsistent', () => frames.every((frame) => frame.trackId === firstFrame.trackId));
    Log.debugAssert(WebMRemuxer.TAG, 'Audio segment codec is inconsistent', () => frames.every((frame) => frame.codecKind === firstFrame.codecKind));

    let firstFrameOriginalDts = frames[0].dts;

    if (this._audioNextDts !== Infinity) {
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

    let info = new MediaSegmentInfo();
    info.beginDts = firstDts;
    info.endDts = lastDts;
    info.beginPts = firstDts;
    info.endPts = lastDts;
    info.originalBeginDts = firstFrameOriginalDts;
    info.originalEndDts = frames[frames.length - 1].dts;
    info.firstFrame = new FrameInfo(firstDts, firstDts, this._refAudioFrameDuration, frames[0].length, false);
    info.lastFrame = new FrameInfo(lastDts, lastDts, this._refAudioFrameDuration, frames[frames.length - 1].length, false);
    this._audioSegmentInfoList.append(info);

    let segment: MSEMediaSegment = {
      trackId: firstFrame.trackId,
      codecKind: firstFrame.codecKind,
      kind: SegmentKind.Media,
      type: TrackType.Audio,
      data: segmentRawData,
      frameCount: frames.length,
      firstFlvTagTimestamp: frames[0].flvTagTimestamp,
      lastFlvTagTimestamp: frames[frames.length - 1].flvTagTimestamp,
      info: info
    };

    this._onMediaSegment(TrackType.Audio, segment);

    sourceTrack.frames = [];
    sourceTrack.length = 0;
  }
}
