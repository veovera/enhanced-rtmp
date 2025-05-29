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
import { FLVDemuxer, AudioTrackInfo, VideoTrackInfo, VideoSample, AudioSample, AudioMetadata, VideoMetadata } from '../demux/flv-demuxer.js';
import Log from '../utils/logger.js';
import { MediaSegmentInfoList, TrackType } from '../core/media-segment-info.js';

export class WebMRemuxer extends Remuxer {
  static readonly TAG = 'WebMRemuxer';

  private _dtsBase = Infinity;
  private _audioDtsBase = Infinity;
  private _videoDtsBase = Infinity;
  private _audioNextDts = NaN; // !!@ do we need this?
  private _videoNextDts = NaN; // !!@ do we need this?
  private _audioStashedLastSample: AudioSample | null = null;
  private _videoStashedLastSample: VideoSample | null = null;

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
    this._audioStashedLastSample = null;
    this._videoStashedLastSample = null;
    this._videoSegmentInfoList.clear();
    this._audioSegmentInfoList.clear();
  }
  
  get timestampBase(): number | undefined {
    return this._dtsBase < Infinity ? this._dtsBase : undefined;
  }
  
  flushStashedSamples(): void {
    let videoSample = this._videoStashedLastSample;
    let audioSample = this._audioStashedLastSample;

    let videoTrack: VideoTrackInfo = {
      type: TrackType.Video,
      id: 1,
      sequenceNumber: 0,
      samples: [],
      length: 0,
      rawData: new Uint8Array()
    };

    if (videoSample) {
      videoTrack.samples.push(videoSample);
      videoTrack.length = videoSample.length;
    }

    let audioTrack: AudioTrackInfo = {
      type: TrackType.Audio,
      id: 2,
      sequenceNumber: 0,
      samples: [],
      length: 0
    };

    if (audioSample != null) {
      audioTrack.samples.push(audioSample);
      audioTrack.length = audioSample.length;
    }

    this._videoStashedLastSample = null;
    this._audioStashedLastSample = null;

    this._remuxVideo(videoTrack, true);
    this._remuxAudio(audioTrack, true);
  }
  
  _onTrackData = (audioTrack: AudioTrackInfo, videoTrack: VideoTrackInfo): void => {
    Log.a(WebMRemuxer.TAG, 'onMediaSegment callback must be specificed!', this._onMediaSegment);
    
    if (this._dtsBase === Infinity) {
      this._calculateDtsBase(audioTrack, videoTrack);
    }

    if (videoTrack) {
      this._remuxVideo(videoTrack);
    }
    if (audioTrack) {
      this._remuxAudio(audioTrack);
    }
  }

  _onTrackMetadata = (metadata: AudioMetadata | VideoMetadata): void => {
    Log.a(WebMRemuxer.TAG, 'onTrackMetadata: onInitSegment callback must be specified!', this._onInitSegment);

    let segmentData: Uint8Array;

    if (metadata.type === TrackType.Audio) {
      const audioMetadata = metadata as AudioMetadata;
      segmentData = WebMGenerator.generateAudioInitSegment(new Uint8Array()); // !!@ fix this
      this._isAudioMetadataDisplatched = true;
    } else {
      const videoMetadata = metadata as VideoMetadata;
      segmentData = WebMGenerator.generateVideoInitSegment(videoMetadata.av1c!);
      this._isVideoMetadataDisplatched = true;
    }

    const initSegment: InitSegment = {
      type: metadata.type,
      data: segmentData.buffer,
      codec: `${metadata.codec},${metadata.codec}`,
      container: 'video/webm',
      mediaDuration: metadata.duration
    };

    this._onInitSegment(metadata.type, initSegment);
  }

  private _calculateDtsBase (audioTrack: AudioTrackInfo, videoTrack: VideoTrackInfo): void {
    if (this._dtsBase < Infinity) {
      return;
    }

    if (audioTrack.samples.length > 0) {
      this._audioDtsBase = audioTrack.samples[0].dts;
    }
    if (videoTrack.samples.length > 0) {
      this._videoDtsBase = videoTrack.samples[0].dts;
    }

    this._dtsBase = Math.min(this._audioDtsBase, this._videoDtsBase);
  }

  private _remuxVideo(videoTrack: VideoTrackInfo, force: boolean = false): void {
    if (this._isVideoMetadataDisplatched != true ||videoTrack.rawData.length === 0) {
      return;
    }

    const segment = WebMGenerator.generateVideoSegment(videoTrack.rawData);
    this._onMediaSegment(TrackType.Video, {
      type: TrackType.Video,
      data: segment.buffer,
      sampleCount: videoTrack.samples.length,
      info: videoTrack.samples[0]
    });
  }

  private _remuxAudio(audioTrack: AudioTrackInfo, force: boolean = false): void {
    Log.a(WebMRemuxer.TAG, '_remuxAudio method not implemented.');
    //!!@this.generator.remuxAudio(audioTrack);
  }
} 