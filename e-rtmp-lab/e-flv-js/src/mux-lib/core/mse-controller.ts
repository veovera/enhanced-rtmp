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

import EventEmitter from 'eventemitter3';
import Log from '../utils/logger';
import Browser from '../utils/browser';
import MSEEvent from './mse-events';
import {IllegalStateException} from '../utils/exception';
import { MediaErrorName } from '../utils/exception';
import { MSESegment, MSEInitSegment, MSEMediaSegment, TrackType, SegmentKind } from '../remux/remuxer';
import type { ResolvedPlayerConfig } from '../config';

export interface MediaElementProxy {
    getCurrentTime(): number;
    getReadyState(): number;
    getError(): MediaError | null;
    setOnMediaTimeUpdate(listener: ((ev: Event) => void) | null): void;
    // Add other methods you use on this object
}

interface TimeRange {
    start: number;
    end: number;
}

interface ManagedMediaSourceLike extends MediaSource {
    readonly streaming: boolean;
}

const TRACK_TYPES: readonly TrackType[] = [TrackType.Video, TrackType.Audio];
type VideoTypeChangeAppendStage = 'none' | 'init' | 'first-media';

function describeInitSegment(initSegment: MSEInitSegment): string {
    return `type=${initSegment.type} codec=${initSegment.codec || 'none'} container=${initSegment.container} size=${initSegment.data.byteLength}`;
}

function describeMediaError(error: MediaError | null): string {
    if (!error) {
        return 'none';
    }

    const details = [`code=${error.code}`];
    if ('message' in error && typeof error.message === 'string' && error.message.length > 0) {
        details.push(`message=${error.message}`);
    }
    return details.join(' ');
}

function describeBufferedRanges(ranges: TimeRanges | null): string {
    if (!ranges || ranges.length === 0) {
        return 'empty';
    }
    return Array.from({ length: ranges.length }, (_, index) =>
        `${ranges.start(index).toFixed(3)}-${ranges.end(index).toFixed(3)}`
    ).join(', ');
}

class MSEController {
    private static readonly TRACE = false;                  // Set to true to enable detailed trace logs for debugging
    private readonly TAG = 'MSEController';
    private _config: ResolvedPlayerConfig;
    private _emitter: EventEmitter = new EventEmitter();
    private events: any;
    private _mediaSource: MediaSource | null;
    private _mediaElementProxy: MediaElementProxy;
    private _mediaSourceObjectURL: string | null = null;
    private _useManagedMediaSource: boolean;
    private _isBufferFull: boolean = false;
    private _hasPendingEos: boolean = false;
    private _requireSetMediaDuration: boolean = false;
    private _pendingMediaDuration: number = 0;
    private _mimeTypes: {
        video: string | null;
        audio: string | null;
    } = { video: null, audio: null };
    private _sourceBuffers: {
        video: SourceBuffer | null;
        audio: SourceBuffer | null;
    } = { video: null, audio: null };
    private _latestInitSegments: {
        video: MSEInitSegment | null;
        audio: MSEInitSegment | null;
    } = { video: null, audio: null };
    private _pendingSegments: {
        video: MSESegment[];
        audio: MSESegment[];
    } = { video: [], audio: [] };
    private _pendingRemoveRanges: {
        video: TimeRange[];
        audio: TimeRange[];
    } = { video: [], audio: [] };
    private _traceAwaitingFirstMediaAfterTypeChange: {
        video: boolean;
        audio: boolean;
    } = { video: false, audio: false };
    private _videoTypeChangeAppendStage: VideoTypeChangeAppendStage = 'none';

    //!!@ fix any
    constructor(config: ResolvedPlayerConfig, mediaElementProxy: MediaElementProxy) {
        this._config = config;

        if (this._config.isLive && this._config.autoCleanupSourceBuffer == undefined) {
            // For live stream, do auto cleanup by default
            this._config = {
                ...config,                      // Override with provided config values
                autoCleanupSourceBuffer: true,  // Set default based on isLive
            };
        } else {
            this._config = config;
        }

        this.events = {
            onSourceOpen: this._onSourceOpen.bind(this),
            onSourceEnded: this._onSourceEnded.bind(this),
            onSourceClose: this._onSourceClose.bind(this),
            onStartStreaming: this._onStartStreaming.bind(this),
            onEndStreaming: this._onEndStreaming.bind(this),
            onQualityChange: this._onQualityChange.bind(this),
            onSourceBufferError: this._onSourceBufferError.bind(this),
            onSourceBufferUpdateEnd: this._onSourceBufferUpdateEnd.bind(this)
        };

        // Use ManagedMediaSource only if w3c MediaSource is not available (e.g. iOS Safari)
        this._useManagedMediaSource = ('ManagedMediaSource' in self) && !('MediaSource' in self);

        // Initialize MediaElementProxy
        if (this._useManagedMediaSource) {
            Log.v(this.TAG, 'Using ManagedMediaSource');
        }

        let ms = this._mediaSource = this._useManagedMediaSource ? new (self as any).ManagedMediaSource() : new self.MediaSource();
        ms.addEventListener('sourceopen', this.events.onSourceOpen);
        ms.addEventListener('sourceended', this.events.onSourceEnded);
        ms.addEventListener('sourceclose', this.events.onSourceClose);

        if (this._useManagedMediaSource) {
            ms.addEventListener('startstreaming', this.events.onStartStreaming);
            ms.addEventListener('endstreaming', this.events.onEndStreaming);
            ms.addEventListener('qualitychange', this.events.onQualityChange);
        }

        this._mediaElementProxy = mediaElementProxy;
    }

    destroy() {
        this._mediaElementProxy.setOnMediaTimeUpdate(null);

        if (this._mediaSource) {
            this.shutdown();
        }
        if (this._mediaSourceObjectURL) {
            this.revokeObjectURL();
        }
        this.events = null;
        this._emitter.removeAllListeners();
    }

    on(event: string, listener: (...args: any[]) => void): void {
        this._emitter.addListener(event, listener);
    }

    off(event: string, listener: (...args: any[]) => void): void {
        this._emitter.removeListener(event, listener);
    }

    shutdown() {
        if (this._mediaSource) {
            let ms = this._mediaSource;

            // Remove and clean up all sourcebuffers
            for (const type of TRACK_TYPES) {
                // Clear pending arrays in-place (safe for references)
                this._pendingSegments[type].splice(0);
                this._pendingRemoveRanges[type].splice(0);
                this._latestInitSegments[type] = null;

                // remove all sourcebuffers
                let sb = this._sourceBuffers[type];
                if (sb) {
                    if (ms.readyState !== 'closed') {
                        // ms edge can throw an error: Unexpected call to method or property access
                        try {
                            ms.removeSourceBuffer(sb);
                        } catch (error: any) {
                            Log.e(this.TAG, error.message);
                        }
                        sb.removeEventListener('error', this.events.onSourceBufferError);
                        sb.removeEventListener('updateend', this.events.onSourceBufferUpdateEnd);
                    }
                    this._mimeTypes[type] = null;
                    this._sourceBuffers[type] = null;
                }
            }

            // End stream if open
            if (ms.readyState === 'open') {
                try {
                    ms.endOfStream();
                } catch (error: any) {
                    Log.e(this.TAG, error.message);
                }
            }

            // Remove event listeners
            ms.removeEventListener('sourceopen', this.events.onSourceOpen);
            ms.removeEventListener('sourceended', this.events.onSourceEnded);
            ms.removeEventListener('sourceclose', this.events.onSourceClose);
            if (this._useManagedMediaSource) {
                ms.removeEventListener('startstreaming', this.events.onStartStreaming);
                ms.removeEventListener('endstreaming', this.events.onEndStreaming);
                ms.removeEventListener('qualitychange', this.events.onQualityChange);
            }
        }

        // Reset other state
        this._mediaSource = null;
        this._isBufferFull = false;
        this._hasPendingEos = false;
        this._traceAwaitingFirstMediaAfterTypeChange = { video: false, audio: false };
        this._videoTypeChangeAppendStage = 'none';
    }

    isManagedMediaSource() {
        return this._useManagedMediaSource;
    }

    getObject() {
        if (!this._mediaSource) {
            throw new IllegalStateException('MediaSource has not been initialized yet!');
        }
        return this._mediaSource;
    }

    getHandle(): any  {
        if (!this._mediaSource) {
            throw new IllegalStateException('MediaSource has not been initialized yet!');
        }
        // Only ManagedMediaSource has .handle property
        if (this._useManagedMediaSource) {
            return (this._mediaSource as any).handle;
        } else {
            // Standard MediaSource doesn't have handle property
            return undefined;
        }
    }

    getObjectURL() {
        if (!this._mediaSource) {
            throw new IllegalStateException('MediaSource has not been initialized yet!');
        }

        if (this._mediaSourceObjectURL == null) {
            this._mediaSourceObjectURL = URL.createObjectURL(this._mediaSource);
        }
        return this._mediaSourceObjectURL;
    }

    private _getMimeType(initSegment: MSEInitSegment): string {
        let codec = initSegment.codec;
        if (codec === 'opus' && Browser.safari) {
            codec = 'Opus';
        }
        return codec && codec.length > 0
            ? `${initSegment.container}; codecs="${codec}"`
            : initSegment.container;
    }

    revokeObjectURL() {
        if (this._mediaSourceObjectURL) {
            URL.revokeObjectURL(this._mediaSourceObjectURL);
            this._mediaSourceObjectURL = null;
        }
    }

    appendInitSegment(initSegment: MSEInitSegment) {
        const type = initSegment.type;
        const pendingSegments = this._pendingSegments[type];
        const previousSegment = pendingSegments[pendingSegments.length - 1];

        // An init segment is a boundary for the media that follows it. We may
        // coalesce only consecutive init segments; replacing an earlier init
        // would pair intervening media with the wrong track configuration.
        if (previousSegment?.kind === SegmentKind.Init) {
            pendingSegments[pendingSegments.length - 1] = initSegment;
        } else {
            pendingSegments.push(initSegment);
        }
        this._latestInitSegments[type] = initSegment;

        Log.v(this.TAG, `appendInitSegment: pendingSegments[${type}]=${this._pendingSegments[type].length} ${describeInitSegment(initSegment)}`);
        this._doAppendSegments();

        const safariMpegDurationBug = Browser.safari && initSegment.container === 'audio/mpeg';  // Safari may cause MediaElement's duration to be NaN
        const webmMissingDuration = initSegment.container.endsWith('/webm');                     // Manually correct MediaSource.duration to make progress bar seekable

        if ((safariMpegDurationBug || webmMissingDuration) && initSegment.mediaDuration > 0) {
            this._requireSetMediaDuration = true;
            this._pendingMediaDuration = initSegment.mediaDuration / 1000;  // in seconds
            this._updateMediaSourceDuration();
        }
    }

    appendMediaSegment(mediaSegment: MSEMediaSegment) {
        let ms = mediaSegment;
        this._pendingSegments[ms.type].push(ms);

        if (this._config.autoCleanupSourceBuffer && this._needCleanupSourceBuffer()) {
            this._doCleanupSourceBuffer();
        }

        if (!this._hasPendingRemoveRanges()) {
            this._doAppendSegments();
        }
    }

    flush() {
        // remove all appended buffers
        for (const type of TRACK_TYPES) {
            if (!this._sourceBuffers[type]) {
                continue;
            }

            // abort current buffer append algorithm
            let sb = this._sourceBuffers[type];
            if (this._mediaSource?.readyState === 'open') {
                try {
                    // If range removal algorithm is running, InvalidStateError will be throwed
                    // Ignore it.
                    sb.abort();
                } catch (error: any) {
                    Log.e(this.TAG, error.message);
                }
            }

            // pending segments should be discard
            let ps = this._pendingSegments[type];
            ps.splice(0, ps.length);

            if (this._mediaSource?.readyState === 'closed') {
                // Parent MediaSource object has been detached from HTMLMediaElement
                continue;
            }

            // record ranges to be remove from SourceBuffer
            for (let i = 0; i < sb.buffered.length; i++) {
                let start = sb.buffered.start(i);
                let end = sb.buffered.end(i);
                this._pendingRemoveRanges[type].push({start, end});
            }

            this._doRemoveRanges();

            // Safari 10 may get InvalidStateError in the later appendBuffer() after SourceBuffer.remove() call
            // Internal parser's state may be invalid at this time. Re-append last InitSegment to workaround.
            // Related issue: https://bugs.webkit.org/show_bug.cgi?id=159230
            if (Browser.safari) {
                let latestInitSegment = this._latestInitSegments[type];
                if (latestInitSegment) {
                    this._pendingSegments[type].push(latestInitSegment);
                    this._doAppendSegments();
                }
            }
        }
    }

    endOfStream() {
        let ms = this._mediaSource;
        let sb = this._sourceBuffers;
        if (!ms || ms.readyState !== 'open') {
            if (ms && ms.readyState === 'closed' && this._hasPendingSegments()) {
                // If MediaSource hasn't turned into open state, and there're pending segments
                // Mark pending endOfStream, defer call until all pending segments appended complete
                this._hasPendingEos = true;
            }
            return;
        }
        if (sb.video?.updating || sb.audio?.updating) {
            // If any sourcebuffer is updating, defer endOfStream operation
            // See _onSourceBufferUpdateEnd()
            this._hasPendingEos = true;
        } else {
            this._hasPendingEos = false;
            // Notify media data loading complete
            // This is helpful for correcting total duration to match last media segment
            // Otherwise MediaElement's ended event may not be triggered
            ms.endOfStream();
        }
    }

    private _needCleanupSourceBuffer() {
        if (!this._config.autoCleanupSourceBuffer || !this._mediaElementProxy) {
            return false;
        }

        let currentTime = this._mediaElementProxy.getCurrentTime();

        for (const type of TRACK_TYPES) {
            let buffered = this._getBufferedRanges(type);
            if (buffered && buffered.length >= 1) {
                if (currentTime - buffered.start(0) >= this._config.autoCleanupMaxBackwardDuration) {
                    return true;
                }
            }
        }

        return false;
    }

    private _doCleanupSourceBuffer(force: boolean = false) {
        let currentTime = this._mediaElementProxy!.getCurrentTime();

        for (const type of TRACK_TYPES) {
            let sb = this._sourceBuffers[type];
            let buffered = this._getBufferedRanges(type);
            if (sb && buffered) {
                let doRemove = false;

                for (let i = 0; i < buffered.length; i++) {
                    let start = buffered.start(i);
                    let end = buffered.end(i);

                    if (start <= currentTime && currentTime < end + 3) {  // padding 3 seconds
                        if (currentTime - start >= this._config.autoCleanupMaxBackwardDuration) {
                            const removeEnd = currentTime - this._config.autoCleanupMinBackwardDuration;
                            if (start < removeEnd) {
                                doRemove = true;
                                this._pendingRemoveRanges[type].push({ start: start, end: removeEnd });
                            }
                        } else if (force) {
                            let removeEnd = currentTime - 10; // force remove last 10 seconds
                            if (start < removeEnd) {
                                doRemove = true;
                                this._pendingRemoveRanges[type].push({ start: start, end: removeEnd });
                            }
                        }
                    } else if (end < currentTime) {
                        doRemove = true;
                        this._pendingRemoveRanges[type].push({start: start, end: end});
                    }
                }

                if (doRemove) {
                    Log.v(this.TAG, `Cleanup SourceBuffer ${type}, currentTime: ${currentTime}, pendingRemoveRanges: ${this._pendingRemoveRanges[type].length} ranges`);
                    this._doRemoveRanges();
                } else {
                    if (buffered.length > 0) {
                        Log.w(this.TAG, `Could not cleanup SourceBuffer ${type}, currentTime: ${currentTime} bufferedStart: ${buffered.start(0)} bufferedEnd: ${buffered.end(buffered.length - 1)}`);
                    } else {
                        Log.w(this.TAG, `Could not cleanup SourceBuffer ${type}, currentTime: ${currentTime} buffered: empty`);
                    }

                }
            }
        }
    }

    private _onMediaTimeUpdate = (e: Event) => {
        if (this._needCleanupSourceBuffer()) {
            this._doCleanupSourceBuffer();
        }

        // If we have pending EOS and pending segments, try to append them as playback progresses
        if (this._hasPendingEos && this._hasPendingSegments() && !this._hasPendingRemoveRanges()) {
            Log.v(this.TAG, 'Retrying append of final segment after playback progress');
            this._doAppendSegments();
        }
    }

    private _updateMediaSourceDuration() {
        let sb = this._sourceBuffers;
        if (this._mediaElementProxy.getReadyState() === 0 || this._mediaSource?.readyState !== 'open') {
            return;
        }
        if (sb.video?.updating || sb.audio?.updating) {
            return;
        }

        let current = this._mediaSource.duration;
        let target = this._pendingMediaDuration;

        if (target > 0 && (isNaN(current) || target > current)) {
            Log.v(this.TAG, `Update MediaSource duration from ${current} to ${target}`);
            this._mediaSource.duration = target;
        }

        this._requireSetMediaDuration = false;
        this._pendingMediaDuration = 0;
    }

    private _doRemoveRanges() {
        for (const type of TRACK_TYPES) {
            if (!this._sourceBuffers[type] || this._sourceBuffers[type].updating) {
                continue;
            }
            const sb = this._sourceBuffers[type];
            const ranges = this._pendingRemoveRanges[type];
            if (ranges.length && !sb.updating) {
                const range = ranges.shift()!;
                sb.remove(range.start, range.end);
            }
        }
    }

    private _doAppendSegments() {
        if (!this._isMediaSourceReadyForStreaming()) {
            return;
        }
        let pendingSegments = this._pendingSegments;

        // SourceBuffer creation is part of draining the same queue that carries
        // init and media data. Create every eligible buffer before appending so a
        // paired audio/video initialization is complete before either track starts
        // an append operation. Some implementations reject a second SourceBuffer
        // while the first one is initializing.
        let createdSourceBuffer = false;
        if (!this._sourceBuffers.video?.updating && !this._sourceBuffers.audio?.updating && !this._hasPendingRemoveRanges()) {
            for (const type of TRACK_TYPES) {
                if (this._sourceBuffers[type] || pendingSegments[type][0]?.kind !== SegmentKind.Init) {
                    continue;
                }
                if (!this._createSourceBuffer(pendingSegments[type][0] as MSEInitSegment)) {
                    return;
                }
                createdSourceBuffer = true;
            }
        }

        // SourceBuffer creation is a separate phase. Do not append an init to a
        // newly created buffer until another drain cycle: a paired track's init
        // may arrive immediately afterwards and must be able to create its own
        // SourceBuffer first.
        if (createdSourceBuffer) {
            return;
        }

        for (const type of TRACK_TYPES) {
            if (!this._sourceBuffers[type] || this._sourceBuffers[type].updating) {
                continue;
            }

            if (pendingSegments[type].length > 0) {
                const ms = pendingSegments[type][0].kind === SegmentKind.Media ? pendingSegments[type][0] as MSEMediaSegment : undefined;
                const is = pendingSegments[type][0].kind === SegmentKind.Init ? pendingSegments[type][0] as MSEInitSegment : undefined;
                const info = ms?.info;
                const frameCount = ms?.frameCount ?? 0;
                const segment: MSESegment = pendingSegments[type].shift()!;

                if (segment.kind === SegmentKind.Media && Number.isFinite(segment?.timestampOffset)) {
                    // For MPEG audio stream in MSE, if unbuffered-seeking occurred
                    // We need explicitly set timestampOffset to the desired point in timeline for mpeg SourceBuffer.
                    let currentOffset = this._sourceBuffers[type].timestampOffset;
                    let targetOffset = segment.timestampOffset! / 1000;  // in seconds

                    // Only update if the difference is meaningful (> 100 ms).  Setting
                    // timestampOffset resets the browser's decode pipeline and discards
                    // buffered data, so we skip it for routine floating-point drift.
                    let delta = Math.abs(currentOffset - targetOffset);
                    if (delta > 0.1) {  // If time delta > 100ms
                        Log.v(this.TAG, `Update MPEG audio timestampOffset from ${currentOffset} to ${targetOffset}`);
                        this._sourceBuffers[type].timestampOffset = targetOffset;
                    }
                    delete segment.timestampOffset;
                }

                if (!segment.data || segment.data.byteLength === 0) {
                    // Ignore empty buffer
                    continue;
                }

                try {
                    if (segment.kind === SegmentKind.Init) {
                        const mimeType = this._getMimeType(segment as MSEInitSegment);
                        if (mimeType !== this._mimeTypes[type]) {
                            const sourceBuffer = this._sourceBuffers[type]!;
                            this._dumpVideoTypeChangeState(`before-changeType old=${this._mimeTypes[type]} new=${mimeType}`);
                            Log.i(this.TAG, `Changing ${type} SourceBuffer type: ${this._mimeTypes[type]} -> ${mimeType}`);
                            sourceBuffer.changeType(mimeType);
                            this._mimeTypes[type] = mimeType;
                            this._traceAwaitingFirstMediaAfterTypeChange[type] = true;
                            this._dumpVideoTypeChangeState('after-changeType-before-init-append');
                            this._videoTypeChangeAppendStage = 'init';
                        }
                    }
                    if (segment.kind === SegmentKind.Media && this._traceAwaitingFirstMediaAfterTypeChange[type]) {
                        const firstFrame = info?.firstFrame;
                        Log.v(this.TAG, `[type-change] first-media type=${type} beginDts=${info?.beginDts ?? 'N/A'} endDts=${info?.endDts ?? 'N/A'} beginPts=${info?.beginPts ?? 'N/A'} endPts=${info?.endPts ?? 'N/A'} frameCount=${frameCount} firstFrameDts=${firstFrame?.dts ?? 'N/A'} firstFramePts=${firstFrame?.pts ?? 'N/A'} firstFrameIsSyncPoint=${firstFrame?.isSyncPoint ?? 'N/A'} syncPoints=${info?.syncPoints.length ?? 0} timestampOffset=${segment.timestampOffset ?? 'none'} currentTime=${this._mediaElementProxy.getCurrentTime().toFixed(3)}`);
                        this._traceAwaitingFirstMediaAfterTypeChange[type] = false;
                        this._videoTypeChangeAppendStage = 'first-media';
                    }
                    // Log buffer info for debugging
                    if (MSEController.TRACE) {
                        const audioUpdating = this._sourceBuffers['audio']?.updating;
                        const videoUpdating = this._sourceBuffers['video']?.updating;
                        if (info) {
                            Log.v(this.TAG, `_doAppendSegments: Now ${Date.now()} - Appending media segment for ${type} SourceBuffer - frameCount: ${frameCount} beginDts: ${info.beginDts} endDts: ${info.endDts} size: ${segment.data.byteLength} audioUpdating ${audioUpdating} videoUpdating ${videoUpdating}`);
                        } else {
                            Log.v(this.TAG, `_doAppendSegments: Now ${Date.now()} - Appending init segment for ${type} SourceBuffer - size: ${segment.data.byteLength} audioUpdating ${audioUpdating} videoUpdating ${videoUpdating}`);
                        }
                    }
                    if (typeof SharedArrayBuffer !== 'undefined' &&segment.data.buffer instanceof SharedArrayBuffer) {
                        // If it's a SharedArrayBuffer, create a copy which will be backed by a standard ArrayBuffer.
                        const bufferCopy = segment.data.slice();
                        this._sourceBuffers[type]!.appendBuffer(bufferCopy);
                    } else {
                        // The buffer is a standard ArrayBuffer, so we can append it directly.
                        this._sourceBuffers[type]!.appendBuffer(segment.data as BufferSource);
                    }
                    this._isBufferFull = false;

                } catch (error: any) {
                    this._pendingSegments[type].unshift(segment);
                    Log.e(this.TAG, `error.message = ${error.message}; error.name = ${error.name}; error.code = ${error.code}; pendingData.length = ${segment.data.length}; type = ${type}; beginDts = ${info ? info.beginDts : 'N/A'}; endDts = ${info ? info.endDts : 'N/A'}`);

                    if (error.name === MediaErrorName.QuotaExceededError) {
                        // If we have a pending end-of-stream, we must clear buffer space to append the final segment and finish the stream.
                        if (this._hasPendingEos && this._config.autoCleanupSourceBuffer) {
                            this._mediaElementProxy.setOnMediaTimeUpdate(this._onMediaTimeUpdate);
                            Log.v(this.TAG, 'QuotaExceededError with pending EOS, forcing cleanup to append final segment.');
                            this._doCleanupSourceBuffer(true);
                            // If cleanup process couldn't be started, defer until more content is played
                            if (!this._hasPendingRemoveRanges()) {
                                Log.w(this.TAG, 'Cannot cleanup buffer at current position - will retry as playback progresses');
                                // Keep the segment in pending queue - it will be retried during normal playback
                                // Don't emit error, just let the video continue playing buffered content
                                if (!this._isBufferFull) {
                                    this._isBufferFull = true;
                                    this._emitter.emit(MSEEvent.BUFFER_FULL);
                                }
                            }
                        } else if (!this._isBufferFull) {
                            // If we are not at the end of the stream, emit BUFFER_FULL event.                            
                            this._isBufferFull = true;
                            this._emitter.emit(MSEEvent.BUFFER_FULL);

                            // Signal that we need to reduce buffering due to quota limits
                            this._emitter.emit(MSEEvent.QUOTA_EXCEEDED_BUFFER_FULL, {
                                type: type,
                                currentBufferLength: this._sourceBuffers[type]?.buffered.length || 0,
                                segmentSize: segment.data.byteLength
                            });
                        }
                    } else {
                        Log.e(this.TAG, error.message);
                        this._emitter.emit(MSEEvent.ERROR, {code: error.code, msg: error.message});
                    }
                }
            }
        }
    }

    private _createSourceBuffer(initSegment: MSEInitSegment): boolean {
        const mediaSource = this._mediaSource;
        if (!mediaSource) {
            return false;
        }

        const mimeType = this._getMimeType(initSegment);
        try {
            const sourceBuffer = this._sourceBuffers[initSegment.type] = mediaSource.addSourceBuffer(mimeType);
            this._mimeTypes[initSegment.type] = mimeType;
            mediaSource.duration = initSegment.mediaDuration / 1000;
            sourceBuffer.addEventListener('error', this.events.onSourceBufferError);
            sourceBuffer.addEventListener('updateend', this.events.onSourceBufferUpdateEnd);
            Log.v(this.TAG, `Created SourceBuffer for ${initSegment.type} track, mimeType=${mimeType}`);
            return true;
        } catch (error: any) {
            Log.e(this.TAG, error.message);
            this._emitter.emit(MSEEvent.ERROR, {code: error.code, msg: error.message});
            return false;
        }
    }

    private _onSourceOpen() {
        Log.v(this.TAG, 'MediaSource onSourceOpen');
        this._mediaSource?.removeEventListener('sourceopen', this.events.onSourceOpen);
        this._doAppendSegments();
        this._emitter.emit(MSEEvent.SOURCE_OPEN);
    }

    private _onStartStreaming() {
        Log.v(this.TAG, 'ManagedMediaSource onStartStreaming');
        this._doAppendSegments();
        this._emitter.emit(MSEEvent.START_STREAMING);
    }

    private _onEndStreaming() {
        Log.v(this.TAG, 'ManagedMediaSource onEndStreaming');
        this._emitter.emit(MSEEvent.END_STREAMING);
    }

    private _onQualityChange() {
        Log.v(this.TAG, 'ManagedMediaSource onQualityChange');
    }

    private _onSourceEnded() {
        // fired on endOfStream
        Log.v(this.TAG, 'MediaSource onSourceEnded');
    }

    private _getBufferedRanges(type: TrackType): TimeRanges | null {
        const sb = this._sourceBuffers[type];
        if (!sb) {
            return null;
        }
        return sb.buffered;
    }

    private _onSourceClose() {
        // fired on detaching from media element
        Log.v(this.TAG, 'MediaSource onSourceClose');
        for (const type of TRACK_TYPES) {
            const sb = this._sourceBuffers[type];
            if (sb) {
                sb.removeEventListener('error', this.events.onSourceBufferError);
                sb.removeEventListener('updateend', this.events.onSourceBufferUpdateEnd);
            }
            this._sourceBuffers[type] = null;
            this._mimeTypes[type] = null;
            this._pendingRemoveRanges[type].splice(0);
            this._pendingSegments[type].splice(0);
            this._traceAwaitingFirstMediaAfterTypeChange[type] = false;
        }
        this._videoTypeChangeAppendStage = 'none';
        if (this._mediaSource && this.events != null) {
            this._mediaSource.removeEventListener('sourceopen', this.events.onSourceOpen);
            this._mediaSource.removeEventListener('sourceended', this.events.onSourceEnded);
            this._mediaSource.removeEventListener('sourceclose', this.events.onSourceClose);
            if (this._useManagedMediaSource) {
                this._mediaSource.removeEventListener('startstreaming', this.events.onStartStreaming);
                this._mediaSource.removeEventListener('endstreaming', this.events.onEndStreaming);
                this._mediaSource.removeEventListener('qualitychange', this.events.onQualityChange);
            }
        }
    }

    private _hasPendingSegments() {
        let ps = this._pendingSegments;
        return ps.video.length > 0 || ps.audio.length > 0;
    }

    private _hasPendingRemoveRanges() {
        let prr = this._pendingRemoveRanges;
        return prr.video.length > 0 || prr.audio.length > 0;
    }

    // Registered as the SourceBuffer 'updateend' listener when a SourceBuffer is created.
    // The browser dispatches this callback after an async SourceBuffer update cycle
    // completes, such as appendBuffer() or remove().
    private _onSourceBufferUpdateEnd(event: Event) {
        if (this._requireSetMediaDuration) {
            this._updateMediaSourceDuration();
        }

        if (event.target === this._sourceBuffers.video && this._videoTypeChangeAppendStage !== 'none') {
            const stage = this._videoTypeChangeAppendStage;
            this._dumpVideoTypeChangeState(`${stage}-updateend`);
            if (stage === 'first-media') {
                this._videoTypeChangeAppendStage = 'none';
            }
        }

        // Media appends must wait until any queued remove() sequences are complete.
        if (this._hasPendingRemoveRanges()) {
            this._doRemoveRanges();
        } else if (this._hasPendingSegments()) {
            this._doAppendSegments();
        } else if (this._hasPendingEos) {
            this.endOfStream();
        }

        this._emitter.emit(MSEEvent.UPDATE_END);
    }

    private _onSourceBufferError(e: any) {
        const target = e?.target as SourceBuffer | undefined;
        const mediaError = this._mediaElementProxy?.getError?.() ?? null;
        const targetState = target
            ? `updating=${target.updating}`
            : 'target=unknown';

        Log.e(this.TAG, `SourceBuffer Error: eventType=${e?.type ?? 'unknown'} ${targetState} mediaSourceReadyState=${this._mediaSource?.readyState ?? 'null'} mediaElementReadyState=${this._mediaElementProxy?.getReadyState?.() ?? 'unknown'} mediaError=${describeMediaError(mediaError)}`);

        const mediaErr = this._mediaElementProxy?.getError?.();
        if (mediaErr) {
            // A MediaError on the element means the browser considers the error fatal
            this._emitter.emit(MSEEvent.ERROR, { code: mediaErr.code, msg: mediaErr.message });
        }
        // If there is no MediaError the SourceBuffer error may be transient (e.g. a stale
        // updateend race); log it but do not surface it as a fatal player error.
    }

    private _dumpVideoTypeChangeState(stage: string): void {
        const sourceBuffer = this._sourceBuffers.video;
        const appendWindow = sourceBuffer
            ? `${sourceBuffer.appendWindowStart.toFixed(3)}-${sourceBuffer.appendWindowEnd.toFixed(3)}`
            : 'N/A';

        Log.v(this.TAG, `[type-change] ${stage} currentTime=${this._mediaElementProxy.getCurrentTime().toFixed(3)} mediaReadyState=${this._mediaElementProxy.getReadyState()} mediaSourceState=${this._mediaSource?.readyState ?? 'null'} mime=${this._mimeTypes.video ?? 'null'} sbExists=${sourceBuffer !== null} sbUpdating=${sourceBuffer?.updating ?? false} sbMode=${sourceBuffer?.mode ?? 'N/A'} timestampOffset=${sourceBuffer?.timestampOffset ?? 'N/A'} appendWindow=${appendWindow} videoBuffered=${describeBufferedRanges(this._getBufferedRanges(TrackType.Video))} audioBuffered=${describeBufferedRanges(this._getBufferedRanges(TrackType.Audio))} mediaError=${describeMediaError(this._mediaElementProxy.getError())}`);
    }

    private _isMediaSourceReadyForStreaming(): boolean {
        const mediaSource = this._mediaSource;
        return (
            mediaSource?.readyState === 'open' &&
            (!this._useManagedMediaSource || (mediaSource as ManagedMediaSourceLike).streaming !== false)
        );
    }

}

export default MSEController;
