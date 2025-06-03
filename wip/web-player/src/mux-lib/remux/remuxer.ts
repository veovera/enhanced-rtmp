/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Copyright (C) 2025 Veovera Software Organization.
 * @author Slavik Lozben
 */

import { Callback } from '../utils/common.js';
import { AudioMetadata, AudioTrack, FLVDemuxer, VideoMetadata, VideoTrack } from '../demux/flv-demuxer.js';
import { TrackType } from '../core/media-segment-info.js';
import { ConfigOptions } from '../config.js';

export type RemuxerType = 'mp4' | 'webm';

export interface InitSegment {
  type: TrackType;
  data: ArrayBuffer;
  codec: string;
  container: string;
  mediaDuration: number;
}

export abstract class Remuxer {
  abstract destroy(): void;
  abstract bindDataSource(producer: FLVDemuxer): this;
  abstract insertDiscontinuity(): void;
  abstract seek(originalDts: number): void;
  abstract flushStashedFrames(): void;

  abstract get timestampBase(): number | undefined;

  // Callback properties
  abstract get onInitSegment(): Callback;
  abstract set onInitSegment(callback: Callback);
  abstract get onMediaSegment(): Callback;
  abstract set onMediaSegment(callback: Callback);

  protected abstract _onTrackData(audioTrack: AudioTrack, videoTrack: VideoTrack): void;
  protected abstract _onTrackMetadata(metadata: AudioMetadata | VideoMetadata): void;

  protected _config: ConfigOptions;
  protected _isLive: boolean;
  protected _isAudioMetadataDisplatched = false;
  protected _isVideoMetadataDisplatched = false;

  constructor(config: ConfigOptions) {
    this._config = config;
    this._isLive = config.isLive;
  }

  get isAudioMetadataDispatched(): boolean {
    return this._isAudioMetadataDisplatched;
  }

  get isVideoMetadataDispatched(): boolean {
    return this._isVideoMetadataDisplatched;
  }
} 