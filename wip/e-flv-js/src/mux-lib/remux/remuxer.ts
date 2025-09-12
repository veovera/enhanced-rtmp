/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Copyright (C) 2025 Veovera Software Organization.
 * @author Slavik Lozben
 */

import { Callback } from '../utils/common.js';
import { AudioMetadata, AudioTrack, FLVDemuxer, VideoMetadata, VideoTrack } from '../demux/flv-demuxer.js';
import { ConfigOptions } from '../config.js';
import { MediaSegmentInfo } from '../core/media-segment-info.js';

export type RemuxerType = 'mp4' | 'webm';

export enum TrackType {
  Audio = 'audio',
  Video = 'video'
};

export enum SegmentKind {
  Init,
  Media
}

export interface MSEInitSegment {
  kind: SegmentKind.Init;
  type: TrackType;
  data: Uint8Array;
  codec: string;
  container: string;
  mediaDuration: number;
}

export interface MSEMediaSegment {
  kind: SegmentKind.Media;
  type: TrackType;
  data: Uint8Array;
  frameCount: number;
  timestampOffset?: number;
  info: MediaSegmentInfo
}

export type MSESegment = MSEMediaSegment | MSEInitSegment;

export abstract class Remuxer {
  // Set to true to enable downloading of remuxed video data segment buffers for debugging
  static readonly DEBUG_BUFFER = false; 

  static dbgVideoBuffer = new Uint8Array();
  static dbgAudioBuffer = new Uint8Array();

  abstract destroy(): void;
  abstract bindDataSource(producer: FLVDemuxer): this;
  abstract insertDiscontinuity(): void;
  abstract seek(originalDts: number): void;
  abstract flushStashedFrames(): void;

  abstract get timestampBase(): number | undefined;

  // Callback properties
  abstract get onInitSegment(): Callback;
  abstract set onInitSegment(callback: Callback);   // !!@ define callback signature for type safety
  abstract get onMediaSegment(): Callback;
  abstract set onMediaSegment(callback: Callback);  // !!@ define callback signature for type safety

  protected abstract _onTrackData(audioTrack: AudioTrack, videoTrack: VideoTrack): void;
  protected abstract _onTrackMetadata(metadata: AudioMetadata | VideoMetadata): void;

  protected _config: ConfigOptions;
  protected _isLive: boolean;
  protected _isAudioMetadataDispatched = false;
  protected _isVideoMetadataDispatched = false;

  constructor(config: ConfigOptions) {
    this._config = config;
    this._isLive = config.isLive;
  }

  get isAudioMetadataDispatched(): boolean {
    return this._isAudioMetadataDispatched;
  }

  get isVideoMetadataDispatched(): boolean {
    return this._isVideoMetadataDispatched;
  }
} 