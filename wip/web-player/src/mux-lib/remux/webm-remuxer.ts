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

import { IRemuxer } from './iremuxer';
import { WebMGenerator, WebMTrackInfo, WebMFrame } from './webm-generator';
import { Callback, assertCallback } from '../utils/common';
import { FLVDemuxer } from '../demux/flv-demuxer';
import { AudioTrackInfo, VideoTrackInfo, VideoSample, AudioSample } from '../demux/flv-demuxer';
import { ConfigOptions } from '../config';
import Log from '../utils/logger';
import { MediaSegmentInfoList } from '../core/media-segment-info';

export class WebMRemuxer implements IRemuxer {
  private _tag = 'WebMRemuxer';

  private _config: ConfigOptions;
  private _isLive: boolean;

  private _dtsBase: number;
  private _audioDtsBase: number;
  private _videoDtsBase: number;
  private _audioNextDts: number | undefined;
  private _videoNextDts: number | undefined;
  private _audioStashedLastSample: AudioSample | null;
  private _videoStashedLastSample: VideoSample | null;

  private _audioMeta: object;
  private _videoMeta: object;

  private _audioSegmentInfoList: MediaSegmentInfoList;
  private _videoSegmentInfoList: MediaSegmentInfoList;

  private _onInitSegment: Callback;
  private _onMediaSegment: Callback;

  constructor(config: ConfigOptions) {
    this._config = config;

    this._isLive = config.isLive;

    this._dtsBase = Infinity;
    this._audioDtsBase = Infinity;
    this._videoDtsBase = Infinity;
    this._audioNextDts = undefined;
    this._videoNextDts = undefined;
    this._audioStashedLastSample = null;
    this._videoStashedLastSample = null;

    this._audioMeta = {};
    this._videoMeta = {};

    this._audioSegmentInfoList = new MediaSegmentInfoList('audio');
    this._videoSegmentInfoList = new MediaSegmentInfoList('video');

    this._onInitSegment = assertCallback;
    this._onMediaSegment = assertCallback;
  }

  destroy(): void {
    Log.v(this._tag, 'nothing to destroy');
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
    producer.onDataAvailable = this._remux;
    producer.onTrackMetadata = this._onTrackMetadataReceived;
    return this;
  }
  
  insertDiscontinuity(): void {
    this._audioNextDts = this._videoNextDts = undefined;
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
      type: 'video',
      id: 1,
      sequenceNumber: 0,
      samples: [],
      length: 0
    };

    if (videoSample != null) {
      videoTrack.samples.push(videoSample);
      videoTrack.length = videoSample.length;
    }

    let audioTrack: AudioTrackInfo = {
      type: 'audio',
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
  
  private _remux = (audioTrack: AudioTrackInfo, videoTrack: VideoTrackInfo): void => {
    Log.a(this._tag, 'onMediaSegment callback must be specificed!', this._onMediaSegment);
    
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

  private _onTrackMetadataReceived = (type: string, metadata: object): void => {
    /*
    let metabox = null;

    let container = 'mp4';
    let codec = metadata.codec;

    if (type === 'audio') {
      this._audioMeta = metadata;
      if (metadata.codec === 'mp3' && this._mp3UseMpegAudio) {
        // 'audio/mpeg' for MP3 audio track
        container = 'mpeg';
        codec = '';
        metabox = new Uint8Array();
      } else {
        // 'audio/mp4, codecs="codec"'
        metabox = MP4.generateInitSegment(metadata);
      }
    } else if (type === 'video') {
      this._videoMeta = metadata;
      metabox = MP4.generateInitSegment(metadata);
    } else {
      return;
    }

    // dispatch metabox (Initialization Segment)
    if (!this._onInitSegment) {
      throw new IllegalStateException('MP4Remuxer: onInitSegment callback must be specified!');
    }
    this._onInitSegment(type, {
      type: type,
      data: metabox.buffer,
      codec: codec,
      container: `${type}/${container}`,
      mediaDuration: metadata.duration  // in timescale 1000 (milliseconds)
    });
    */
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
    throw new Error('Method not implemented.');
    //!!@this.generator.remuxVideo(videoTrack);
  }

  private _remuxAudio(audioTrack: AudioTrackInfo, force: boolean = false): void {
    throw new Error('Method not implemented.');
    //!!@this.generator.remuxAudio(audioTrack);
  }
} 