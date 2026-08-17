/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Copyright (C) 2026 Veovera Software Organization.
 * @author Slavik Lozben
 */

import { AudioMetadata, AudioTrack, VideoMetadata, VideoTrack } from '../demux/flv-demuxer.js';
import { assertCallback, Callback } from '../utils/common.js';
import { MediaSegmentInfoList } from '../core/media-segment-info.js';
import MP4Remuxer from './mp4-remuxer.js';
import { MSEMediaSegment, Remuxer, RemuxingTarget, TrackType } from './remuxer.js';

function emptyAudioTrack(): AudioTrack {
  return { type: TrackType.Audio, id: 2, sequenceNumber: 0, frames: [], length: 0 };
}

function emptyVideoTrack(): VideoTrack {
  return { type: TrackType.Video, id: 1, sequenceNumber: 0, frames: [], length: 0 };
}

/**
 * Routes audio and video to separate remuxers while presenting one remuxing
 * target to the demuxer. It owns one presentation DTS base
 * and applies it to both remuxers, keeping their MSE SourceBuffer timelines
 * aligned.
 */
export class RemuxerRouter implements RemuxingTarget {
  private _audioRemuxer: Remuxer | null = null;
  private _videoRemuxer: Remuxer | null = null;
  private _dtsBase = Infinity;
  private _videoSegmentInfoList = new MediaSegmentInfoList(TrackType.Video);
  private _onInitSegment: Callback = assertCallback;
  private _onMediaSegment: Callback = assertCallback;

  get audioRemuxer(): Remuxer | null {
    return this._audioRemuxer;
  }

  get videoRemuxer(): Remuxer | null {
    return this._videoRemuxer;
  }

  configure(audioRemuxer: Remuxer, videoRemuxer: Remuxer): void {
    this._audioRemuxer?.destroy();
    this._videoRemuxer?.destroy();
    this._audioRemuxer = audioRemuxer;
    this._videoRemuxer = videoRemuxer;

    if (this._dtsBase !== Infinity) {
      audioRemuxer.setTimestampBase(this._dtsBase);
      videoRemuxer.setTimestampBase(this._dtsBase);
    }
    this._configureRemuxers();
  }

  configureVideo(videoRemuxer: Remuxer): void {
    const timestampBase = this._dtsBase !== Infinity
      ? this._dtsBase
      : this._videoRemuxer?.timestampBase;
    this._videoRemuxer?.destroy();
    this._videoRemuxer = videoRemuxer;

    if (timestampBase !== undefined) {
      this._dtsBase = timestampBase;
      videoRemuxer.setTimestampBase(timestampBase);
    }
    this._configureRemuxers();
  }

  get onInitSegment(): Callback {
    return this._onInitSegment;
  }

  set onInitSegment(callback: Callback) {
    this._onInitSegment = callback;
    this._configureRemuxers();
  }

  get onMediaSegment(): Callback {
    return this._onMediaSegment;
  }

  set onMediaSegment(callback: Callback) {
    this._onMediaSegment = callback;
    this._configureRemuxers();
  }

  get timestampBase(): number | undefined {
    return this._dtsBase === Infinity ? undefined : this._dtsBase;
  }

  get isAudioMetadataDispatched(): boolean {
    return this._audioRemuxer?.isAudioMetadataDispatched ?? false;
  }

  get isVideoMetadataDispatched(): boolean {
    return this._videoRemuxer?.isVideoMetadataDispatched ?? false;
  }

  setTimestampBase(timestampBase: number): void {
    this._dtsBase = timestampBase;
    this._audioRemuxer?.setTimestampBase(timestampBase);
    this._videoRemuxer?.setTimestampBase(timestampBase);
  }

  insertDiscontinuity(): void {
    this._audioRemuxer?.insertDiscontinuity();
    this._videoRemuxer?.insertDiscontinuity();
  }

  clear(): void {
    this._audioRemuxer?.clear();
    this._videoRemuxer?.clear();
    this._videoSegmentInfoList.clear();
  }

  flushStashedFrames(): void {
    this._videoRemuxer?.flushStashedFrames();
    this._audioRemuxer?.flushStashedFrames();
  }

  flushPendingInitSegments(): void {
    // Both SourceBuffers must be created before a remuxer emits media. Some
    // browser media engines reject a late-added track after playback begins.
    this._videoRemuxer?.flushPendingInitSegments();
    this._audioRemuxer?.flushPendingInitSegments();
  }

  destroy(): void {
    this._audioRemuxer?.destroy();
    this._videoRemuxer?.destroy();
    this._audioRemuxer = null;
    this._videoRemuxer = null;
    this._videoSegmentInfoList.clear();
    this._dtsBase = Infinity;
    this._onInitSegment = assertCallback;
    this._onMediaSegment = assertCallback;
  }

  remuxTrackMetadata(metadata: AudioMetadata | VideoMetadata): void {
    if (metadata.type === TrackType.Audio) {
      this._audioRemuxer?.remuxTrackMetadata(metadata);
    } else {
      this._videoRemuxer?.remuxTrackMetadata(metadata);
    }
  }

  remuxTrackData(audioTrack: AudioTrack, videoTrack: VideoTrack): void {
    this._setTimestampBaseFromTracks(audioTrack, videoTrack);

    if (videoTrack.frames.length > 0) {
      this._videoRemuxer?.remuxTrackData(emptyAudioTrack(), videoTrack);
    }
    if (audioTrack.frames.length > 0) {
      this._audioRemuxer?.remuxTrackData(audioTrack, emptyVideoTrack());
    }
  }

  private _setTimestampBaseFromTracks(audioTrack: AudioTrack, videoTrack: VideoTrack): void {
    if (this._dtsBase === Infinity) {
      const firstDts = [audioTrack.frames[0]?.dts, videoTrack.frames[0]?.dts]
        .filter((dts): dts is number => Number.isFinite(dts));
      if (firstDts.length > 0) {
        this._dtsBase = Math.min(...firstDts);
      }
    }

    // Apply the router-owned value before every batch so both remuxers remain
    // in the same epoch after configuration or lifecycle operations.
    if (this._dtsBase !== Infinity) {
      this._audioRemuxer?.setTimestampBase(this._dtsBase);
      this._videoRemuxer?.setTimestampBase(this._dtsBase);
    }
  }

  private _configureRemuxers(): void {
    if (!this._audioRemuxer || !this._videoRemuxer) {
      return;
    }

    const forwardInit = (type: TrackType, initSegment: unknown) => this._onInitSegment(type, initSegment);
    const forwardMedia = (type: TrackType, mediaSegment: MSEMediaSegment) => {
      if (type === TrackType.Video) {
        this._videoSegmentInfoList.append(mediaSegment.info);
      }
      this._onMediaSegment(type, mediaSegment);
    };

    this._audioRemuxer.onInitSegment = forwardInit;
    this._videoRemuxer.onInitSegment = forwardInit;
    this._audioRemuxer.onMediaSegment = forwardMedia;
    this._videoRemuxer.onMediaSegment = forwardMedia;

    if (this._audioRemuxer instanceof MP4Remuxer) {
      this._audioRemuxer.setExternalVideoSegmentInfoList(this._videoSegmentInfoList);
    }
  }
}

export default RemuxerRouter;
