/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Copyright (C) 2025 Veovera Software Organization.
 * @author Slavik Lozben
 */

import { Callback, assertCallback } from '../utils/common.js';
import { AudioFrame, AudioMetadata, AudioTrack, VideoFrame, VideoMetadata, VideoTrack } from '../demux/flv-demuxer.js';
import type { ResolvedPlayerConfig } from '../config.js';
import { MediaSegmentInfo, MediaSegmentInfoList } from '../core/media-segment-info.js';

export type RemuxerType = 'mp4' | 'webm';

export const TrackType = {
  Audio: 'audio',
  Video: 'video'
} as const;

export type TrackType = typeof TrackType[keyof typeof TrackType];

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

/** Public surface shared by a remuxer and the remuxer router. */
export interface RemuxingTarget {
  destroy(): void;
  clear(): void;
  flushStashedFrames(): void;
  flushPendingInitSegments(): void;
  remuxTrackData(audioTrack: AudioTrack, videoTrack: VideoTrack): void;
  remuxTrackMetadata(metadata: AudioMetadata | VideoMetadata): void;
  insertDiscontinuity(): void;
  setTimestampBase(timestampBase: number): void;
  onInitSegment: Callback;
  onMediaSegment: Callback;

  readonly isAudioMetadataDispatched: boolean;
  readonly isVideoMetadataDispatched: boolean;
  readonly timestampBase: number | undefined;
}

export abstract class Remuxer implements RemuxingTarget {
  abstract destroy(): void;
  abstract clear(): void;
  abstract flushStashedFrames(): void;
  /** Emit any initialization segment held for batched metadata processing. */
  abstract flushPendingInitSegments(): void;

  remuxTrackData(audioTrack: AudioTrack, videoTrack: VideoTrack): void {
    this._onTrackData(audioTrack, videoTrack);
  }

  remuxTrackMetadata(metadata: AudioMetadata | VideoMetadata): void {
    this._onTrackMetadata(metadata);
  }

  protected abstract _onTrackData(audioTrack: AudioTrack, videoTrack: VideoTrack): void;
  protected abstract _onTrackMetadata(metadata: AudioMetadata | VideoMetadata): void;

  protected _config: ResolvedPlayerConfig;
  protected _isLive: boolean;
  protected _isAudioMetadataDispatched = false;
  protected _isVideoMetadataDispatched = false;

  protected _audioMeta: AudioMetadata | null = null;
  protected _videoMeta: VideoMetadata | null = null;
  protected _dtsBase = Infinity;
  protected _audioDtsBase = Infinity;
  protected _videoDtsBase = Infinity;
  protected _audioNextDts = Infinity;
  protected _videoNextDts = Infinity;
  protected _audioStashedLastFrame: AudioFrame | null = null;
  protected _videoStashedLastFrame: VideoFrame | null = null;
  protected _audioSegmentInfoList = new MediaSegmentInfoList(TrackType.Audio);
  protected _videoSegmentInfoList = new MediaSegmentInfoList(TrackType.Video);
  protected _onInitSegment: Callback = assertCallback;
  protected _onMediaSegment: Callback = assertCallback;
  
  
  constructor(config: ResolvedPlayerConfig) {
    this._config = config;
    this._isLive = config.isLive;
  }

  get isAudioMetadataDispatched(): boolean {
    return this._isAudioMetadataDispatched;
  }

  get isVideoMetadataDispatched(): boolean {
    return this._isVideoMetadataDispatched;
  }

  insertDiscontinuity(): void {
    this._audioNextDts = Infinity;
    this._videoNextDts = Infinity;
  }

  setTimestampBase(timestampBase: number): void {
    this._dtsBase = timestampBase;
  }

  get timestampBase(): number | undefined {
    return this._dtsBase === Infinity ? undefined : this._dtsBase;
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

  protected _calculateDtsBase(audioTrack: AudioTrack, videoTrack: VideoTrack): void {
    if (this._dtsBase !== Infinity) {
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

  protected _takeStashedFrames(): { audioTrack: AudioTrack; videoTrack: VideoTrack } {
    const videoTrack: VideoTrack = {
      type: TrackType.Video,
      id: 1,
      sequenceNumber: 0,
      frames: [],
      length: 0
    };
    if (this._videoStashedLastFrame) {
      videoTrack.frames.push(this._videoStashedLastFrame);
      videoTrack.length = this._videoStashedLastFrame.length;
    }

    const audioTrack: AudioTrack = {
      type: TrackType.Audio,
      id: 2,
      sequenceNumber: 0,
      frames: [],
      length: 0
    };
    if (this._audioStashedLastFrame) {
      audioTrack.frames.push(this._audioStashedLastFrame);
      audioTrack.length = this._audioStashedLastFrame.length;
    }

    this._videoStashedLastFrame = null;
    this._audioStashedLastFrame = null;
    return { audioTrack, videoTrack };
  }

  protected _clearTrackState(): void {
    this._audioStashedLastFrame = null;
    this._videoStashedLastFrame = null;
    this._audioSegmentInfoList.clear();
    this._videoSegmentInfoList.clear();
  }

  protected _resetTimelineState(): void {
    this._dtsBase = Infinity;
    this._audioDtsBase = Infinity;
    this._videoDtsBase = Infinity;
    this._audioNextDts = Infinity;
    this._videoNextDts = Infinity;
    this._clearTrackState();
  }

  protected _clearMetadata(): void {
    this._audioMeta = null;
    this._videoMeta = null;
  }

  protected _resetCallbacks(): void {
    this._onInitSegment = assertCallback;
    this._onMediaSegment = assertCallback;
  }
}
