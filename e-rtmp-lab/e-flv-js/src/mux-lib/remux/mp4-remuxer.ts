/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Copyright (C) 2016 Bilibili.
 * @author zheng qian <xqq@xqq.im>
 *
 * Modified and migrated to TypeScript by Slavik Lozben.
 * Additional changes Copyright (C) 2025 Veovera Software Organization.
 *
 * See Git history for full details.
 */

import Log from '../utils/logger.js';
import MP4 from './mp4-generator.js';
import AAC from './aac-silent.js';
import Browser from '../utils/browser.js';
import { FrameInfo as FrameInfo, MediaSegmentInfo, MediaSegmentInfoList } from '../core/media-segment-info.js';
import { MSEInitSegment, MSEMediaSegment, Remuxer, SegmentKind, TrackType } from './remuxer.js';
import { Callback, assertCallback } from '../utils/common.js';
import { AudioMetadata, AudioTrack, AudioFrame, VideoMetadata, VideoTrack, VideoFrame, VideoCodecType } from '../demux/flv-demuxer.js';
import AV1OBUParser from '../demux/av1-parser.js';
import { ConfigOptions } from '../config.js';

function formatVp9CodecComponent(value: number): string {
    return `${Math.max(0, Math.trunc(value))}`.padStart(2, '0');
}

function isSpecifiedColorValue(value: number): boolean {
    // ISO/MPEG color value 2 == "unspecified".
    return Number.isFinite(value) && value !== 2;
}

function getMp4Vp9CodecString(metadata: VideoMetadata): string {
    // profile/level arrive as strings from the demuxer; bitDepth is already numeric.
    const profile = Number.parseInt(metadata.profile, 10);
    const level = Number.parseInt(metadata.level, 10);
    const bitDepth = metadata.bitDepth;

    if (
        !Number.isFinite(profile) ||
        !Number.isFinite(level) ||
        !Number.isFinite(bitDepth)
    ) {
        return metadata.codec;
    }

    const codecString = [
        'vp09',
        formatVp9CodecComponent(profile),
        formatVp9CodecComponent(level),
        formatVp9CodecComponent(bitDepth)
    ];

    if (
        !Number.isFinite(metadata.chromaFormat) ||
        !isSpecifiedColorValue(metadata.colourPrimaries) ||
        !isSpecifiedColorValue(metadata.transferCharacteristics) ||
        !isSpecifiedColorValue(metadata.matrixCoefficients) ||
        !Number.isFinite(metadata.colorRange)
    ) {
        return codecString.join('.');
    }

    return codecString.concat([
        formatVp9CodecComponent(metadata.chromaFormat),
        formatVp9CodecComponent(metadata.colourPrimaries),
        formatVp9CodecComponent(metadata.transferCharacteristics),
        formatVp9CodecComponent(metadata.matrixCoefficients),
        formatVp9CodecComponent(metadata.colorRange ? 1 : 0)
    ]).join('.');
}

function asUint8Array(data: ArrayBuffer | ArrayBufferView | ArrayLike<number> | null | undefined): Uint8Array | null {
    if (!data) {
        return null;
    }
    if (data instanceof Uint8Array) {
        return data;
    }
    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }
    if (typeof data.length === 'number') {
        return Uint8Array.from(data);
    }
    return null;
}

function formatBytesPrefix(data: ArrayBuffer | ArrayBufferView | ArrayLike<number> | null | undefined, length = 16): string {
    const bytes = asUint8Array(data);

    if (!bytes || bytes.byteLength === 0) {
        return 'empty';
    }

    return Array.from(bytes.subarray(0, Math.min(length, bytes.byteLength)))
        .map((value) => value.toString(16).padStart(2, '0'))
        .join(' ');
}

export class MP4Remuxer extends Remuxer {
        static readonly TAG = 'MP4Remuxer';

        private _dtsBase = Infinity;
        private _audioDtsBase = Infinity;
        private _videoDtsBase = Infinity;
        private _audioNextDts = Infinity;
        private _videoNextDts = Infinity;
        private _audioStashedLastFrame: AudioFrame | null = null;
        private _videoStashedLastFrame: VideoFrame | null = null;

        private _audioSegmentInfoList = new MediaSegmentInfoList(TrackType.Audio);
        private _videoSegmentInfoList = new MediaSegmentInfoList(TrackType.Video);

        private _onInitSegment: Callback = assertCallback;
        private _onMediaSegment: Callback = assertCallback;

        private _pendingAudioInitSegment: MSEInitSegment | null = null;
        private _pendingVideoInitSegment: MSEInitSegment | null = null;

        private _forceFirstIDR: boolean;
        private _fillSilentAfterSeek: boolean;
        private _mp3UseMpegAudio: boolean;
        private _fillAudioTimestampGap: boolean;

    constructor(config: ConfigOptions) {
        super(config);



        // Workaround for chrome < 50: Always force first sample as a Random Access Point in media segment
        // see https://bugs.chromium.org/p/chromium/issues/detail?id=229412
        this._forceFirstIDR = 
            Browser.chrome && 
            Browser.version && (
                Browser.version.major < 50 || (
                    Browser.version.major === 50 && 
                    Browser.version.build && 
                    Browser.version.build < 2661
                )
            ) ? true : false;

        // Workaround for IE11/Edge: Fill silent aac frame after keyframe-seeking
        // Make audio beginDts equals with video beginDts, in order to fix seek freeze
        this._fillSilentAfterSeek = Browser?.msedge || Browser?.msie || false;

        // While only FireFox supports 'audio/mp4, codecs="mp3"', use 'audio/mpeg' for chrome, safari, ...
        this._mp3UseMpegAudio = !Browser.firefox;

        this._fillAudioTimestampGap = this._config.fixAudioTimestampGap;
    }

    destroy() {
        this._dtsBase = Infinity;
        this._audioDtsBase = Infinity;
        this._videoDtsBase = Infinity;
        this._audioNextDts = Infinity;
        this._videoNextDts = Infinity;
        this._audioMeta = null;
        this._videoMeta = null;
        this._audioSegmentInfoList.clear();
        this._videoSegmentInfoList.clear();
        this._pendingAudioInitSegment = null;
        this._pendingVideoInitSegment = null;
        this._onInitSegment = assertCallback;
        this._onMediaSegment = assertCallback;
    }

    bindDataSource(producer: any) {
        producer.onTrackData = this._onTrackData.bind(this);
        producer.onTrackMetadata = this._onTrackMetadata.bind(this);
        return this;
    }

    get onInitSegment() {
        return this._onInitSegment;
    }

    set onInitSegment(callback: Callback) {
        this._onInitSegment = callback;
    }

    get onMediaSegment() {
        return this._onMediaSegment;
    }

    set onMediaSegment(callback: Callback) {
        this._onMediaSegment = callback;
    }

    insertDiscontinuity() {
        this._audioNextDts = this._videoNextDts = Infinity;
    }

    clear() {
        this._audioStashedLastFrame = null;
        this._videoStashedLastFrame = null;
        this._videoSegmentInfoList.clear();
        this._audioSegmentInfoList.clear();
        this._pendingAudioInitSegment = null;
        this._pendingVideoInitSegment = null;
    }

    _getMp4TrackId(type: TrackType, trackId: number) {
        if (Number.isFinite(trackId) && trackId > 0) {
            return trackId;
        }
        return type === TrackType.Video ? 1 : 2;
    }

    _getMp4Metadata(metadata: AudioMetadata | VideoMetadata) {
        return {
            ...metadata,
            trackId: this._getMp4TrackId(metadata.type, metadata.trackId)
        };
    }

    _describeMetadata(metadata: AudioMetadata | VideoMetadata): string {
        let details = `type=${metadata.type} codec=${metadata.codec} duration=${metadata.duration}`;
        if (metadata.type === TrackType.Audio) {
            details += ` channels=${metadata.channelCount} sampleRate=${metadata.audioSampleRate}`;
            details += ` config=${formatBytesPrefix(metadata.codecConfig)}`;
        }
        return details;
    }

    _describeInitSegment(initSegment: MSEInitSegment): string {
        return `type=${initSegment.type} codec=${initSegment.codec || 'none'} container=${initSegment.container} bytes=${initSegment.data.byteLength} head=${formatBytesPrefix(initSegment.data)}`;
    }

    _onTrackData(audioTrack: AudioTrack, videoTrack: VideoTrack) {
        if (this._dtsBase === Infinity) {
            this._calculateDtsBase(audioTrack, videoTrack);
        }
        // Flush all pending init segments before any data so both SourceBuffers
        // are created while updating=false, avoiding InvalidStateError on mediaSource.duration.
        if (this._pendingVideoInitSegment) {
            Log.v(MP4Remuxer.TAG, `_onTrackData(): flushing pending video init before data batch, videoFrames=${videoTrack.frames.length} audioFrames=${audioTrack.frames.length} ${this._describeInitSegment(this._pendingVideoInitSegment)}`);
            this._onInitSegment(TrackType.Video, this._pendingVideoInitSegment);
            this._pendingVideoInitSegment = null;
        }
        if (this._pendingAudioInitSegment) {
            Log.v(MP4Remuxer.TAG, `_onTrackData(): flushing pending audio init before data batch, videoFrames=${videoTrack.frames.length} audioFrames=${audioTrack.frames.length} ${this._describeInitSegment(this._pendingAudioInitSegment)}`);
            this._onInitSegment(TrackType.Audio, this._pendingAudioInitSegment);
            this._pendingAudioInitSegment = null;
        }
        this._remuxVideo(videoTrack, false);
        this._remuxAudio(audioTrack, false);
    }

    _onTrackMetadata(metadata: AudioMetadata | VideoMetadata) {
        let metabox = null;

        let container = 'mp4';
        let codec = metadata.codec;
        const type = metadata.type;

        if (metadata.type === TrackType.Audio) {
            this._isAudioMetadataDispatched = true;
            this._audioMeta = metadata as AudioMetadata;
            if (metadata.codec === 'mp3' && this._mp3UseMpegAudio) {
                // 'audio/mpeg' for MP3 audio track
                container = 'mpeg';
                codec = '';
                metabox = new Uint8Array();
            } else {
                // 'audio/mp4, codecs="codec"'
                metabox = MP4.generateInitSegment(this._getMp4Metadata(metadata));
            }
        } else {
            this._isVideoMetadataDispatched = true;
            this._videoMeta = metadata as VideoMetadata;
            if (metadata.codecType === VideoCodecType.Vp9) {
                codec = getMp4Vp9CodecString(metadata);
            }
            metabox = MP4.generateInitSegment(this._getMp4Metadata(metadata));
        }

        // Stash init segment; dispatched lazily in _remuxAudio/_remuxVideo so that
        // multiple metadata updates only result in one init segment per data batch.
        const initSegment: MSEInitSegment = {
            kind: SegmentKind.Init,
            type: type,
            data: new Uint8Array(metabox.buffer),
            codec: codec,
            container: `${type}/${container}`,
            mediaDuration: metadata.duration  // in timescale 1000 (milliseconds)
        };

        if (type === TrackType.Audio) {
            if (this._pendingAudioInitSegment) {
                Log.v(MP4Remuxer.TAG, `_onTrackMetadata(): replacing pending audio init ${this._describeInitSegment(this._pendingAudioInitSegment)} -> ${this._describeMetadata(metadata)}`);
            } else {
                Log.v(MP4Remuxer.TAG, `_onTrackMetadata(): stashing audio init from metadata ${this._describeMetadata(metadata)}`);
            }
            this._pendingAudioInitSegment = initSegment;
        } else {
            if (this._pendingVideoInitSegment) {
                Log.v(MP4Remuxer.TAG, `_onTrackMetadata(): replacing pending video init ${this._describeInitSegment(this._pendingVideoInitSegment)} -> ${this._describeMetadata(metadata)}`);
            } else {
                Log.v(MP4Remuxer.TAG, `_onTrackMetadata(): stashing video init from metadata ${this._describeMetadata(metadata)}`);
            }
            this._pendingVideoInitSegment = initSegment;
        }
    }

    _calculateDtsBase(audioTrack: AudioTrack, videoTrack: VideoTrack) {
        if (this._dtsBase !== Infinity) {
            return;
        }

        if (audioTrack && audioTrack.frames && audioTrack.frames.length) {
            this._audioDtsBase = audioTrack.frames[0].dts;
        }
        if (videoTrack && videoTrack.frames && videoTrack.frames.length) {
            this._videoDtsBase = videoTrack.frames[0].dts;
        }

        this._dtsBase = Math.min(this._audioDtsBase, this._videoDtsBase);
    }

    get timestampBase() {
        if (this._dtsBase === Infinity) {
            return undefined;
        }
        return this._dtsBase;
    }

    flushStashedFrames() {
        let videoFrame = this._videoStashedLastFrame;
        let audioFrame = this._audioStashedLastFrame;

        let videoTrack: VideoTrack = {
            type: TrackType.Video,
            id: 1,
            sequenceNumber: 0,
            frames: [],
            length: 0
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

    _remuxAudio(audioTrack: AudioTrack, force: boolean) {
        if (!this._audioMeta || audioTrack.frames.length === 0) {
            return;
        }

        if (this._pendingAudioInitSegment) {
            Log.v(MP4Remuxer.TAG, `_remuxAudio(): flushing pending audio init before audio remux, audioFrames=${audioTrack.frames.length} force=${force} ${this._describeInitSegment(this._pendingAudioInitSegment)}`);
            this._onInitSegment(TrackType.Audio, this._pendingAudioInitSegment);
            this._pendingAudioInitSegment = null;
        }

        let track = audioTrack;
        let frames: AudioFrame[] = track.frames;
        let dtsCorrection = undefined;
        let firstDts = -1, lastDts = -1, lastPts = -1;
        let refFrameDuration = this._audioMeta.refFrameDuration;

        let mpegRawTrack = this._audioMeta.codec === 'mp3' && this._mp3UseMpegAudio;
        let isFirstSegmentAfterSeek = this._dtsBase !== Infinity && this._audioNextDts === Infinity;

        let insertPrefixSilentFrame = false;

        if (frames.length === 1 && !force) {
            // If [sample count in current batch] === 1 && (force != true)
            // Ignore and keep in demuxer's queue
            return;
        }  // else if (force === true) do remux

        let offset = 0;
        let mdatbox = null;
        let mdatBytes = 0;

        // calculate initial mdat size
        if (mpegRawTrack) {
            // for raw mpeg buffer
            offset = 0;
            mdatBytes = track.length;
        } else {
            // for fmp4 mdat box
            offset = 8;  // size + type
            mdatBytes = 8 + track.length;
        }


        let lastFrame: AudioFrame | undefined;

        // Pop the lastFrame and waiting for stash
        if (frames.length > 1) {
            lastFrame = frames.pop();
            mdatBytes -= lastFrame?.length || 0;
        }

        // Insert [stashed lastFrame in the previous batch] to the front
        if (this._audioStashedLastFrame != null) {
            let frame = this._audioStashedLastFrame;
            this._audioStashedLastFrame = null;
            frames.unshift(frame);
            mdatBytes += frame?.length || 0;
        }

        // Stash the lastFrame of current batch, waiting for next batch
        if (lastFrame != null) {
            this._audioStashedLastFrame = lastFrame;
        }


        let firstFrameOriginalDts = frames[0].dts - this._dtsBase;

        // calculate dtsCorrection
        if (this._audioNextDts !== Infinity) {
            dtsCorrection = firstFrameOriginalDts - this._audioNextDts;
        } else {  // this._audioNextDts == Infinity
            if (this._audioSegmentInfoList.isEmpty()) {
                dtsCorrection = 0;
                if (this._fillSilentAfterSeek && !this._videoSegmentInfoList.isEmpty()) {
                    if (this._audioMeta.originalCodec !== 'mp3') {
                        insertPrefixSilentFrame = true;
                    }
                }
            } else {
                let lastFrame = this._audioSegmentInfoList.getLastFrameBefore(firstFrameOriginalDts);
                if (lastFrame != null) {
                    let distance = (firstFrameOriginalDts - (lastFrame.originalDts + lastFrame.duration));
                    if (distance <= 3) {
                        distance = 0;
                    }
                    let expectedDts = lastFrame.dts + lastFrame.duration + distance;
                    dtsCorrection = firstFrameOriginalDts - expectedDts;
                } else { // lastFrame == null, cannot found
                    dtsCorrection = 0;
                }
            }
        }

        if (insertPrefixSilentFrame) {
            // align audio segment beginDts to match with current video segment's beginDts
            let firstFrameDts = firstFrameOriginalDts - dtsCorrection;
            let videoSegment = this._videoSegmentInfoList.getLastSegmentBefore(firstFrameOriginalDts);
            if (videoSegment != null && videoSegment.beginDts < firstFrameDts) {
                let silentUnit = AAC.getSilentFrame(this._audioMeta.originalCodec, this._audioMeta.channelCount);
                if (silentUnit) {
                    let dts = videoSegment.beginDts;
                    let silentFrameDuration = firstFrameDts - videoSegment.beginDts;
                    Log.v(MP4Remuxer.TAG, `InsertPrefixSilentAudio: dts: ${dts}, duration: ${silentFrameDuration}`);
                    frames.unshift({ unit: silentUnit, length: silentUnit.byteLength, dts: dts, pts: dts });
                    mdatBytes += silentUnit.byteLength;
                }  // silentUnit == null: Cannot generate, skip
            } else {
                insertPrefixSilentFrame = false;
            }
        }

        let mp4Frames: any[] = [];  // !!@ change from any to a more specific type

        // Correct dts for each frame, and calculate frame duration. Then output to mp4Frames
        for (let i = 0; i < frames.length; i++) {
            let frame = frames[i];
            let unit = frame.unit;
            let originalDts = frame.dts - this._dtsBase;
            let dts = originalDts;
            let needFillSilentFrames = false;
            let silentFrames: any[] = [];  // !!@ change from any to a more specific type
            let frameDuration = 0;

            if (originalDts < -0.001) {
                continue; //pass the first sample with the invalid dts
            }

            if (this._audioMeta.codec !== 'mp3' && !Number.isNaN(refFrameDuration)) {
                // for AAC codec, we need to keep dts increase based on refFrameDuration
                let curRefDts = originalDts;
                const maxAudioFramesDrift = 3;
                if (this._audioNextDts !== Infinity) {
                    curRefDts = this._audioNextDts;
                }

                dtsCorrection = originalDts - curRefDts;
                if (dtsCorrection <= -maxAudioFramesDrift * refFrameDuration) {
                    // If we're overlapping by more than maxAudioFramesDrift number of frame, drop this sample
                    Log.w(MP4Remuxer.TAG, `Dropping 1 audio frame (originalDts: ${originalDts} ms ,curRefDts: ${curRefDts} ms)  due to dtsCorrection: ${dtsCorrection} ms overlap.`);
                    continue;
                }
                else if (dtsCorrection >= maxAudioFramesDrift * refFrameDuration && this._fillAudioTimestampGap && !Browser.safari) {
                    // Silent frame generation, if large timestamp gap detected && config.fixAudioTimestampGap
                    needFillSilentFrames = true;
                    // We need to insert silent frames to fill timestamp gap
                    let frameCount = Math.floor(dtsCorrection / refFrameDuration);
                    Log.w(MP4Remuxer.TAG, 'Large audio timestamp gap detected, may cause AV sync to drift. ' +
                        'Silent frames will be generated to avoid unsync.\n' +
                        `originalDts: ${originalDts} ms, curRefDts: ${curRefDts} ms, ` +
                        `dtsCorrection: ${Math.round(dtsCorrection)} ms, generate: ${frameCount} frames`);


                    dts = Math.floor(curRefDts);
                    frameDuration = Math.floor(curRefDts + refFrameDuration) - dts;

                    let silentUnit = AAC.getSilentFrame(this._audioMeta.originalCodec, this._audioMeta.channelCount);
                    if (silentUnit === null) {
                        Log.w(MP4Remuxer.TAG, 'Unable to generate silent frame for ' +
                            `${this._audioMeta.originalCodec} with ${this._audioMeta.channelCount} channels, repeat last frame`);
                        // Repeat last frame
                        silentUnit = unit;
                    }

                    for (let j = 0; j < frameCount; j++) {
                        curRefDts = curRefDts + refFrameDuration;
                        let intDts = Math.floor(curRefDts);  // change to integer
                        let intDuration = Math.floor(curRefDts + refFrameDuration) - intDts;
                        let frame = {
                            dts: intDts,
                            pts: intDts,
                            cts: 0,
                            unit: silentUnit,
                            size: silentUnit.byteLength,
                            duration: intDuration,  // wait for next sample
                            originalDts: originalDts,
                            flags: {
                                isLeading: 0,
                                dependsOn: 1,
                                isDependedOn: 0,
                                hasRedundancy: 0
                            }
                        };
                        silentFrames.push(frame);
                        mdatBytes += frame.size;

                    }

                    this._audioNextDts = curRefDts + refFrameDuration;

                } else {

                    dts = Math.floor(curRefDts);
                    frameDuration = Math.floor(curRefDts + refFrameDuration) - dts;
                    this._audioNextDts = curRefDts + refFrameDuration;

                }
            } else {
                // keep the original dts calculate algorithm for mp3
                dts = originalDts - dtsCorrection;


                if (i !== frames.length - 1) {
                    let nextDts = frames[i + 1].dts - this._dtsBase - dtsCorrection;
                    frameDuration = nextDts - dts;
                } else {  // the last sample
                    if (lastFrame != null) {  // use stashed frame's dts to calculate sample duration
                        let nextDts = lastFrame.dts - this._dtsBase - dtsCorrection;
                        frameDuration = nextDts - dts;
                    } else if (mp4Frames.length >= 1) {  // use second last sample duration
                        frameDuration = mp4Frames[mp4Frames.length - 1].duration;
                    } else {  // the only one sample, use reference sample duration
                        frameDuration = Math.floor(refFrameDuration);
                    }
                }
                this._audioNextDts = dts + frameDuration;
            }

            if (firstDts === -1) {
                firstDts = dts;
            }
            mp4Frames.push({
                dts: dts,
                pts: dts,
                cts: 0,
                unit: frame.unit,
                size: frame.unit.byteLength,
                duration: frameDuration,
                originalDts: originalDts,
                flags: {
                    isLeading: 0,
                    dependsOn: 1,
                    isDependedOn: 0,
                    hasRedundancy: 0
                }
            });

            if (needFillSilentFrames) {
                // Silent frames should be inserted after wrong-duration frame
                mp4Frames.push(...(silentFrames));
            }
        }

        if (mp4Frames.length === 0) {
            //no frames need to remux
            track.frames = [];
            track.length = 0;
            return;
        }

        // allocate mdatbox
        if (mpegRawTrack) {
            // allocate for raw mpeg buffer
            mdatbox = new Uint8Array(mdatBytes);
        } else {
            // allocate for fmp4 mdat box
            mdatbox = new Uint8Array(mdatBytes);
            // size field
            mdatbox[0] = (mdatBytes >>> 24) & 0xFF;
            mdatbox[1] = (mdatBytes >>> 16) & 0xFF;
            mdatbox[2] = (mdatBytes >>>  8) & 0xFF;
            mdatbox[3] = (mdatBytes) & 0xFF;
            // type field (fourCC)
            mdatbox.set(MP4.types.mdat, 4);
        }

        // Write frames into mdatbox
        for (let i = 0; i < mp4Frames.length; i++) {
            let unit = mp4Frames[i].unit;
            mdatbox.set(unit, offset);
            offset += unit.byteLength;
        }

        let latest = mp4Frames[mp4Frames.length - 1];
        lastDts = latest.dts + latest.duration;
        //this._audioNextDts = lastDts;

        // fill media segment info & add to info list
        let info = new MediaSegmentInfo();
        info.beginDts = firstDts;
        info.endDts = lastDts;
        info.beginPts = firstDts;
        info.endPts = lastDts;
        info.originalBeginDts = mp4Frames[0].originalDts;
        info.originalEndDts = latest.originalDts + latest.duration;
        info.firstFrame = new FrameInfo(mp4Frames[0].dts,
            mp4Frames[0].pts,
            mp4Frames[0].duration,
            mp4Frames[0].originalDts,
            false);
        info.lastFrame = new FrameInfo(latest.dts,
            latest.pts,
            latest.duration,
            latest.originalDts,
            false);
        if (!this._isLive) {
            this._audioSegmentInfoList.append(info);
        }

        track.frames = mp4Frames;
        track.sequenceNumber++;

        let moofbox = null;

        if (mpegRawTrack) {
            // Generate empty buffer, because useless for raw mpeg
            moofbox = new Uint8Array();
        } else {
            // Generate moof for fmp4 segment
            moofbox = MP4.moof({
                ...track,
                id: this._getMp4TrackId(TrackType.Audio, track.id)
            }, firstDts);
        }

        track.frames = [];
        track.length = 0;

        const mediaSegment: MSEMediaSegment = {
            kind: SegmentKind.Media,
            type: TrackType.Audio,
            data: new Uint8Array(this._mergeBoxes(moofbox, mdatbox).buffer),
            frameCount: mp4Frames.length,
            info: info
        };

        if (mpegRawTrack && isFirstSegmentAfterSeek) {
            // For MPEG audio stream in MSE, if seeking occurred, before appending new buffer
            // We need explicitly set timestampOffset to the desired point in timeline for mpeg SourceBuffer.
            mediaSegment.timestampOffset = firstDts;
        }

        this._onMediaSegment(TrackType.Audio, mediaSegment);
    }

    _remuxVideo(videoTrack: VideoTrack, force: boolean) {
        // A forced end-of-stream flush may receive an empty placeholder track.
        // There is nothing to remux and no codec metadata should be required.
        if (videoTrack.frames.length === 0) {
            return;
        }

        // Require at least 2 frames before remuxing (unless forced, e.g. flushStashedFrames).
        // MP4 computes each frame's duration as nextFrame.dts - currentFrame.dts, so the stash
        // mechanism always pops the last frame and holds it for the next batch as the "next frame"
        // reference. With only 1 frame there is nothing to pop/stash, breaking the DTS chain.
        if (videoTrack.frames.length === 1 && !force) {
            return;
        }
        if (!this._videoMeta) {
            Log.w(MP4Remuxer.TAG, '_remuxVideo: VideoData received before CodecConfigurationRecord');
            return;
        }

        if (this._pendingVideoInitSegment) {
            this._onInitSegment(TrackType.Video, this._pendingVideoInitSegment);
            this._pendingVideoInitSegment = null;
        }

        let track: VideoTrack = videoTrack;
        let frames: VideoFrame[] = track.frames;
        let dtsCorrection = undefined;
        let firstDts = -1, lastDts = -1;
        let firstPts = -1, lastPts = -1;

        let offset = 8;
        let mdatbox = null;
        let mdatBytes = 8 + videoTrack.length;


        let lastFrame: VideoFrame | undefined;

        // Pop the lastFrame and waiting for stash
        if (frames.length > 1) {
            lastFrame = frames.pop();
            mdatBytes -= lastFrame?.length || 0;
        }

        // Insert [stashed lastFrame in the previous batch] to the front
        if (this._videoStashedLastFrame != null) {
            let frame = this._videoStashedLastFrame;
            this._videoStashedLastFrame = null;
            frames.unshift(frame);
            mdatBytes += frame.length;
        }

        // Stash the lastFrame of current batch, waiting for next batch
        if (lastFrame != null) {
            this._videoStashedLastFrame = lastFrame;
        }

        const isAv1 = this._videoMeta.codecType === VideoCodecType.Av1;

        let firstFrameOriginalDts = frames[0].dts - this._dtsBase;

        // calculate dtsCorrection
        if (this._videoNextDts !== Infinity) {
            dtsCorrection = firstFrameOriginalDts - this._videoNextDts;
        } else {
            if (this._videoSegmentInfoList.isEmpty()) {
                dtsCorrection = 0;
            } else {
                let lastFrame = this._videoSegmentInfoList.getLastFrameBefore(firstFrameOriginalDts);
                if (lastFrame != null) {
                    let distance = (firstFrameOriginalDts - (lastFrame.originalDts + lastFrame.duration));
                    if (distance <= 3) {
                        distance = 0;
                    }
                    let expectedDts = lastFrame.dts + lastFrame.duration + distance;
                    dtsCorrection = firstFrameOriginalDts - expectedDts;
                } else { // lastFrame == null, cannot found
                    dtsCorrection = 0;
                }
            }
        }

        let info = new MediaSegmentInfo();
        let mp4Frames: any[] = [];  // !!@ change from any to a more specific type

        // For AV1, strip leading framing OBUs from each unit before muxing so the stored
        // frame size and mdat byte count match the bytes actually written.
        let actualMdatDataBytes = 0;

        // Correct dts for each frame, and calculate frame duration. Then output to mp4Frames
        for (let i = 0; i < frames.length; i++) {
            let frame = frames[i];
            let originalDts = frame.dts - this._dtsBase;
            let isKeyframe = frame.isKeyframe;
            let dts = originalDts - dtsCorrection;
            let cts = isAv1 ? 0 :frame.cts;
            let pts = dts + cts;

            if (firstDts === -1) {
                firstDts = dts;
                firstPts = pts;
            }

            let frameDuration = 0;

            if (i !== frames.length - 1) {
                let nextDts = frames[i + 1].dts - this._dtsBase - dtsCorrection;
                frameDuration = nextDts - dts;
            } else {  // the last frame
                if (lastFrame != null) {  // use stashed frame's dts to calculate frame duration
                    let nextDts = lastFrame.dts - this._dtsBase - dtsCorrection;
                    frameDuration = nextDts - dts;
                } else if (mp4Frames.length >= 1) {  // use second last frame duration
                    frameDuration = mp4Frames[mp4Frames.length - 1].duration;
                } else {  // the only one frame, use reference frame duration
                    frameDuration = Math.floor(this._videoMeta.refFrameDuration);
                }
            }

            if (isKeyframe) {
                let syncPoint = new FrameInfo(dts, pts, frameDuration, frame.dts, true);
                syncPoint.fileposition = frame.fileposition;    // frame is of type VideoFrame
                info.appendSyncPoint(syncPoint);
            }

            let frameUnits = frame.units;
            let frameSize = frame.length;
            if (isAv1) {
                let processedSize = 0;
                frameUnits = frame.units.map((unit) => {
                    const processedData = AV1OBUParser.stripLeadingObuFraming(unit.data);
                    processedSize += processedData.byteLength;
                    return { type: unit.type, data: processedData };
                });
                frameSize = processedSize;
                actualMdatDataBytes += processedSize;
            }

            mp4Frames.push({
                dts: dts,
                pts: pts,
                cts: cts,
                units: frameUnits,
                size: frameSize,
                isKeyframe: isKeyframe,
                duration: frameDuration,
                originalDts: originalDts,
                flags: {
                    isLeading: 0,
                    dependsOn: isKeyframe ? 2 : 1,
                    isDependedOn: isKeyframe ? 1 : 0,
                    hasRedundancy: 0,
                    isNonSync: isKeyframe ? 0 : 1
                }
            });
        }

        if (isAv1) {
            mdatBytes = 8 + actualMdatDataBytes;
        }

        // allocate mdatbox
        mdatbox = new Uint8Array(mdatBytes);
        mdatbox[0] = (mdatBytes >>> 24) & 0xFF;
        mdatbox[1] = (mdatBytes >>> 16) & 0xFF;
        mdatbox[2] = (mdatBytes >>>  8) & 0xFF;
        mdatbox[3] = (mdatBytes) & 0xFF;
        mdatbox.set(MP4.types.mdat, 4);

        // Write frames into mdatbox (unit.data is already AV1-normalized above)
        for (let i = 0; i < mp4Frames.length; i++) {
            let units = mp4Frames[i].units;
            while (units.length) {
                let unit = units.shift();
                let data = unit.data;
                mdatbox.set(data, offset);
                offset += data.byteLength;
            }
        }

        let latest = mp4Frames[mp4Frames.length - 1];
        lastDts = latest.dts + latest.duration;
        lastPts = latest.pts + latest.duration;
        this._videoNextDts = lastDts;

        // fill media segment info & add to info list
        info.beginDts = firstDts;
        info.endDts = lastDts;
        info.beginPts = firstPts;
        info.endPts = lastPts;
        info.originalBeginDts = mp4Frames[0].originalDts;
        info.originalEndDts = latest.originalDts + latest.duration;
        info.firstFrame = new FrameInfo(mp4Frames[0].dts,
            mp4Frames[0].pts,
            mp4Frames[0].duration,
            mp4Frames[0].originalDts,
            mp4Frames[0].isKeyframe);
        info.lastFrame = new FrameInfo(latest.dts,
            latest.pts,
            latest.duration,
            latest.originalDts,
            latest.isKeyframe);
        if (!this._isLive) {
            this._videoSegmentInfoList.append(info);
        }

        track.frames = mp4Frames;
        track.sequenceNumber++;

        // workaround for chrome < 50: force first sample as a random access point
        // see https://bugs.chromium.org/p/chromium/issues/detail?id=229412
        if (this._forceFirstIDR) {
            let flags = mp4Frames[0].flags;
            flags.dependsOn = 2;
            flags.isNonSync = 0;
        }

        //Log.v(MP4Remuxer.TAG, `_remuxVideo() - videoTrack.frames.length: ${videoTrack.frames.length} *************************************************`);

        let moofbox = MP4.moof({
            ...track,
            id: this._getMp4TrackId(TrackType.Video, track.id)
        }, firstDts);
        track.frames = [];
        track.length = 0;

        const mediaSegment: MSEMediaSegment = {
            kind: SegmentKind.Media,
            type: TrackType.Video,
            data: new Uint8Array(this._mergeBoxes(moofbox, mdatbox).buffer),
            frameCount: mp4Frames.length,
            info: info
        };
        this._onMediaSegment(TrackType.Video, mediaSegment);
    }

    _mergeBoxes(moof: Uint8Array, mdat: Uint8Array) {
        let result = new Uint8Array(moof.byteLength + mdat.byteLength);
        result.set(moof, 0);
        result.set(mdat, moof.byteLength);
        return result;
    }

}

export default MP4Remuxer;
