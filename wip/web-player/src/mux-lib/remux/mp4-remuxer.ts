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
import { FrameInfo as FrameInfo, MediaSegmentInfo, MediaSegmentInfoList, TrackType } from '../core/media-segment-info.js';
import { IllegalStateException } from '../utils/exception.js';
import { Remuxer } from './remuxer.js';
import { Callback, assertCallback } from '../utils/common.js';
import { AudioMetadata, AudioTrack, AudioFrame, VideoMetadata, VideoTrack, VideoFrame } from '../demux/flv-demuxer.js';

export class MP4Remuxer extends Remuxer {
        static TAG = 'MP4Remuxer';

        private _dtsBase = NaN;
        private _audioDtsBase = Infinity;
        private _videoDtsBase = Infinity;
        private _audioNextDts = NaN;
        private _videoNextDts = NaN;
        private _audioStashedLastFrame: AudioFrame | null = null;
        private _videoStashedLastFrame: VideoFrame | null = null;

        private _audioMeta: AudioMetadata | null = null;
        private _videoMeta: VideoMetadata | null = null;

        private _audioSegmentInfoList = new MediaSegmentInfoList(TrackType.Audio);
        private _videoSegmentInfoList = new MediaSegmentInfoList(TrackType.Video);

        private _onInitSegment: Callback = assertCallback;
        private _onMediaSegment: Callback = assertCallback;

        private _forceFirstIDR: boolean;
        private _fillSilentAfterSeek: boolean;
        private _mp3UseMpegAudio: boolean;
        private _fillAudioTimestampGap: boolean;

    constructor(config: any) {
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
        this._dtsBase = NaN;
        this._audioMeta = null;
        this._videoMeta = null;
        this._audioSegmentInfoList.clear();
        this._videoSegmentInfoList.clear();
        this._onInitSegment = assertCallback;
        this._onMediaSegment = assertCallback;
    }

    bindDataSource(producer: any) {
        producer.onTrackData = this._onTrackData.bind(this);
        producer.onTrackMetadata = this._onTrackMetadata.bind(this);
        return this;
    }

    /* prototype: function onInitSegment(type: string, initSegment: ArrayBuffer): void
       InitSegment: {
           type: string,
           data: ArrayBuffer,
           codec: string,
           container: string
       }
    */
    get onInitSegment() {
        return this._onInitSegment;
    }

    set onInitSegment(callback: Callback) {
        this._onInitSegment = callback;
    }

    /* prototype: function onMediaSegment(type: string, mediaSegment: MediaSegment): void
       MediaSegment: {
           type: string,
           data: ArrayBuffer,
           frameCount: int32
           info: MediaSegmentInfo
       }
    */
    get onMediaSegment() {
        return this._onMediaSegment;
    }

    set onMediaSegment(callback: Callback) {
        this._onMediaSegment = callback;
    }

    insertDiscontinuity() {
        this._audioNextDts = this._videoNextDts = NaN;
    }

    seek(originalDts: number) {
        this._audioStashedLastFrame = null;
        this._videoStashedLastFrame = null;
        this._videoSegmentInfoList.clear();
        this._audioSegmentInfoList.clear();
    }

    _onTrackData(audioTrack: AudioTrack, videoTrack: VideoTrack) {
        if (!this._onMediaSegment) {
            throw new IllegalStateException('MP4Remuxer: onMediaSegment callback must be specificed!');
        }
        if (Number.isNaN(this._dtsBase)) {
            this._calculateDtsBase(audioTrack, videoTrack);
        }
        if (videoTrack) {
            this._remuxVideo(videoTrack, false);
        }
        if (audioTrack) {
            this._remuxAudio(audioTrack, false);
        }
    }

    _onTrackMetadata(metadata: AudioMetadata | VideoMetadata) {
        let metabox = null;

        let container = 'mp4';
        let codec = metadata.codec;
        const type = metadata.type;

        if (metadata.type === TrackType.Audio) {
            this._isAudioMetadataDispatched = true;
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
        } else {
            this._isVideoMetadataDispatched = true;
            this._videoMeta = metadata;
            metabox = MP4.generateInitSegment(metadata);
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
    }

    _calculateDtsBase(audioTrack: AudioTrack, videoTrack: VideoTrack) {
        if (Number.isFinite(this._dtsBase)) {
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
        if (Number.isNaN(this._dtsBase)) {
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
        if (this._audioMeta == null) {
            return;
        }

        let track = audioTrack;
        let frames: AudioFrame[] = track.frames;
        let dtsCorrection = undefined;
        let firstDts = -1, lastDts = -1, lastPts = -1;
        let refFrameDuration = this._audioMeta.refFrameDuration;

        let mpegRawTrack = this._audioMeta.codec === 'mp3' && this._mp3UseMpegAudio;
        let isFirstSegmentAfterSeek = Number.isFinite(this._dtsBase) && Number.isNaN(this._audioNextDts);

        let insertPrefixSilentFrame = false;

        if (!frames || frames.length === 0) {
            return;
        }
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
        if (!Number.isNaN(this._audioNextDts)) {
            dtsCorrection = firstFrameOriginalDts - this._audioNextDts;
        } else {  // this._audioNextDts == NaN
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
                if (!Number.isNaN(this._audioNextDts)) {
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

                    let silentUnit = AAC.getSilentFrame(this._audioMeta.originalCodec, this._audioMeta.channelCount) as Uint8Array | null;
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
            moofbox = MP4.moof(track, firstDts);
        }

        track.frames = [];
        track.length = 0;

        // !!@ change from any to a more specific type
        let segment: any = {
            type: TrackType.Audio,
            data: this._mergeBoxes(moofbox, mdatbox).buffer,
            frameCount: mp4Frames.length,
            info: info
        };

        if (mpegRawTrack && isFirstSegmentAfterSeek) {
            // For MPEG audio stream in MSE, if seeking occurred, before appending new buffer
            // We need explicitly set timestampOffset to the desired point in timeline for mpeg SourceBuffer.
            segment.timestampOffset = firstDts;
        }

        this._onMediaSegment(TrackType.Audio, segment);
    }

    _remuxVideo(videoTrack: VideoTrack, force: boolean) {
        if (this._videoMeta == null) {
            return;
        }

        let track = videoTrack;
        let frames = track.frames;
        let dtsCorrection = undefined;
        let firstDts = -1, lastDts = -1;
        let firstPts = -1, lastPts = -1;

        if (!frames || frames.length === 0) {
            return;
        }                
        if (frames.length === 1 && !force) {
            // If [frame count in current batch] === 1 && (force != true)
            // Ignore and keep in demuxer's queue
            return;
        }  // else if (force === true) do remux

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


        let firstFrameOriginalDts = frames[0].dts - this._dtsBase;

        // calculate dtsCorrection
        if (!Number.isNaN(this._videoNextDts)) {
            dtsCorrection = firstFrameOriginalDts - this._videoNextDts;
        } else {  // this._videoNextDts == NaN
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

        // Correct dts for each frame, and calculate frame duration. Then output to mp4Frames
        for (let i = 0; i < frames.length; i++) {
            let frame = frames[i];
            let originalDts = frame.dts - this._dtsBase;
            let isKeyframe = frame.isKeyframe;
            let dts = originalDts - dtsCorrection;
            let cts = frame.cts;
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

            mp4Frames.push({
                dts: dts,
                pts: pts,
                cts: cts,
                units: frame.units,
                size: frame.length,
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

        // allocate mdatbox
        mdatbox = new Uint8Array(mdatBytes);
        mdatbox[0] = (mdatBytes >>> 24) & 0xFF;
        mdatbox[1] = (mdatBytes >>> 16) & 0xFF;
        mdatbox[2] = (mdatBytes >>>  8) & 0xFF;
        mdatbox[3] = (mdatBytes) & 0xFF;
        mdatbox.set(MP4.types.mdat, 4);

        // Write frames into mdatbox
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

        let moofbox = MP4.moof(track, firstDts);
        track.frames = [];
        track.length = 0;

        this._onMediaSegment(TrackType.Video, {
            type: TrackType.Video,
            data: this._mergeBoxes(moofbox, mdatbox).buffer,
            frameCount: mp4Frames.length,
            info: info
        });
    }

    _mergeBoxes(moof: Uint8Array, mdat: Uint8Array) {
        let result = new Uint8Array(moof.byteLength + mdat.byteLength);
        result.set(moof, 0);
        result.set(mdat, moof.byteLength);
        return result;
    }

}

export default MP4Remuxer;
