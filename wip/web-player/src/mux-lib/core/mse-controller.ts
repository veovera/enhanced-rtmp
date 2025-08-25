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
import MSEEvents from './mse-events';
import {IllegalStateException} from '../utils/exception';
import { MediaErrorName } from '../utils/exception';
import { MSESegment, MSEInitSegment, MSEMediaSegment, TrackType, SegmentKind } from '../remux/remuxer';
import { ConfigOptions } from '../config';

export interface MediaElementProxy {
    getCurrentTime(): number;
    getReadyState(): number;
    setOnMediaTimeUpdate(listener: ((ev: Event) => void) | null): void;
    // Add other methods you use on this object
}

interface TimeRange {
    start: number;
    end: number;
}

const TRACK_TYPES: readonly TrackType[] = [TrackType.Video, TrackType.Audio];
class MSEController {
    private readonly TAG = 'MSEController';
    private _config: ConfigOptions;
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
    private _lastInitSegments: {
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
    private _pendingSourceBufferInit: MSEInitSegment[] = []; // Array of pending init segments to be added to source buffers

    //!!@ fix any
    constructor(config: ConfigOptions, mediaElementProxy: MediaElementProxy) {
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
                this._lastInitSegments[type] = null;

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
        this._pendingSourceBufferInit = [];
        this._isBufferFull = false;
        this._hasPendingEos = false;
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

    revokeObjectURL() {
        if (this._mediaSourceObjectURL) {
            URL.revokeObjectURL(this._mediaSourceObjectURL);
            this._mediaSourceObjectURL = null;
        }
    }

    appendInitSegment(initSegment: MSEInitSegment, deferred: boolean = false) {
        if (!this._mediaSource || this._mediaSource.readyState !== 'open' || (this._useManagedMediaSource && (this._mediaSource as any).streaming === false)) {
            // sourcebuffer creation requires mediaSource.readyState === 'open'
            // so we defer the sourcebuffer creation, until sourceopen event triggered
            this._pendingSourceBufferInit.push(initSegment);
            // make sure that this InitSegment is in the front of pending segments queue
            this._pendingSegments[initSegment.type].push(initSegment);
            return;
        }

        let is = initSegment;
        let mimeType = `${is.container}`;
        if (is.codec && is.codec.length > 0) {
            if (is.codec === 'opus' && Browser.safari) {
                is.codec = 'Opus';
            }
            mimeType += `; codecs="${is.codec}"`;
        }

        let firstInitSegment = false;

        Log.v(this.TAG, 'Received Initialization Segment, mimeType: ' + mimeType);
        this._lastInitSegments[is.type] = is;

        if (mimeType !== this._mimeTypes[is.type]) {
            if (!this._mimeTypes[is.type]) {  // empty, first chance create sourcebuffer
                firstInitSegment = true;
                try {
                    let sb = this._sourceBuffers[is.type] = this._mediaSource.addSourceBuffer(mimeType);
                    Log.v(this.TAG, `Created SourceBuffer for ${is.type} track, mimeType: ${mimeType}`);
                    this._mediaSource.duration = is.mediaDuration / 1000;  // in seconds
                    sb.addEventListener('error', this.events.onSourceBufferError);
                    sb.addEventListener('updateend', this.events.onSourceBufferUpdateEnd);
                } catch (error: any) {
                    Log.e(this.TAG, error.message);
                    this._emitter.emit(MSEEvents.ERROR, {code: error.code, msg: error.message});
                    return;
                }
            } else {
                Log.v(this.TAG, `Notice: ${is.type} mimeType changed, origin: ${this._mimeTypes[is.type]}, target: ${mimeType}`);
            }
            this._mimeTypes[is.type] = mimeType;
        }

        if (!deferred) {
            // deferred means this InitSegment has been pushed to pendingSegments queue
            this._pendingSegments[is.type].push(is);
        }
        if (!firstInitSegment) {  // append immediately only if init segment in subsequence
            this._doAppendSegments();
        }
        if (((Browser.safari && is.container === 'audio/mpeg') || (is.container === "video/webm")) && is.mediaDuration > 0) {
            // 'audio/mpeg' track under Safari may cause MediaElement's duration to be NaN
            // Manually correct MediaSource.duration to make progress bar seekable, and report right duration
            this._requireSetMediaDuration = true;
            this._pendingMediaDuration = is.mediaDuration / 1000;  // in seconds
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
                let lastInitSegment = this._lastInitSegments[type];
                if (lastInitSegment) {
                    this._pendingSegments[type].push(lastInitSegment);
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
        if (sb.video && sb.video.updating || sb.audio && sb.audio.updating) {
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
            let sb = this._sourceBuffers[type];
            if (sb) {
                let buffered = sb.buffered;
                if (buffered.length >= 1) {
                    if (currentTime - buffered.start(0) >= this._config.autoCleanupMaxBackwardDuration) {
                        return true;
                    }
                }
            }
        }

        return false;
    }

    private _doCleanupSourceBuffer(force: boolean = false) {
        let currentTime = this._mediaElementProxy!.getCurrentTime();

        for (const type of TRACK_TYPES) {
            let sb = this._sourceBuffers[type];
            if (sb) {
                let buffered = sb.buffered;
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
        if (this._mediaElementProxy!.getReadyState() === 0 || this._mediaSource?.readyState !== 'open') {
            return;
        }
        if ((sb.video && sb.video.updating) || (sb.audio && sb.audio.updating)) {
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
        // Early return if MediaSource is not ready
        if (!this._mediaSource || this._mediaSource.readyState !== 'open') {
            return;
        }
        let pendingSegments = this._pendingSegments;

        for (const type of TRACK_TYPES) {
            if (!this._sourceBuffers[type] || this._sourceBuffers[type].updating || (this._useManagedMediaSource && (this._mediaSource as any).streaming === false)) {
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
                    if (info) {
                      //Log.v(this.TAG, `Appending segment to ${type} SourceBuffer - frameCount: ${frameCount} beginDts: ${info.beginDts} dstEnd: ${info.endDts}} size: ${segment.data.byteLength} `);
                      //Log.v(this.TAG, `\n${Log.dumpArrayBuffer(segment.data, 512)}`);
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
                    //Log.e(this.TAG, `\n${Log.dumpArrayBuffer(segment.data, 512)}`);

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
                                    this._emitter.emit(MSEEvents.BUFFER_FULL);
                                }
                            }
                        } else if (!this._isBufferFull) {
                            // If we are not at the end of the stream, emit BUFFER_FULL event.                            
                            this._isBufferFull = true;
                            this._emitter.emit(MSEEvents.BUFFER_FULL);
                        }
                    } else {
                        Log.e(this.TAG, error.message);
                        this._emitter.emit(MSEEvents.ERROR, {code: error.code, msg: error.message});
                    }
                }
            }
        }
    }

    private _onSourceOpen() {
        Log.v(this.TAG, 'MediaSource onSourceOpen');
        this._mediaSource?.removeEventListener('sourceopen', this.events.onSourceOpen);
        // deferred sourcebuffer creation / initialization
        if (this._pendingSourceBufferInit.length > 0) {
            let pendings = this._pendingSourceBufferInit;
            while (pendings.length) {
                let segment = pendings.shift()!;
                this.appendInitSegment(segment, true);
            }
        }
        // there may be some pending media segments, append them
        if (this._hasPendingSegments()) {
            this._doAppendSegments();
        }
        this._emitter.emit(MSEEvents.SOURCE_OPEN);
    }

    private _onStartStreaming() {
        Log.v(this.TAG, 'ManagedMediaSource onStartStreaming');
        this._emitter.emit(MSEEvents.START_STREAMING);
    }

    private _onEndStreaming() {
        Log.v(this.TAG, 'ManagedMediaSource onEndStreaming');
        this._emitter.emit(MSEEvents.END_STREAMING);
    }

    private _onQualityChange() {
        Log.v(this.TAG, 'ManagedMediaSource onQualityChange');
    }

    private _onSourceEnded() {
        // fired on endOfStream
        Log.v(this.TAG, 'MediaSource onSourceEnded');
    }

    private _onSourceClose() {
        // fired on detaching from media element
        Log.v(this.TAG, 'MediaSource onSourceClose');
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

    private _onSourceBufferUpdateEnd() {
        if (this._requireSetMediaDuration) {
            this._updateMediaSourceDuration();
        } 
        if (this._hasPendingRemoveRanges()) {
            this._doRemoveRanges();
        } else if (this._hasPendingSegments()) {
            this._doAppendSegments();
        } else if (this._hasPendingEos) {
            this.endOfStream();
        }
        this._emitter.emit(MSEEvents.UPDATE_END);
    }

    private _onSourceBufferError(e: any) {
        Log.e(this.TAG, `SourceBuffer Error: ${e}`);
        // this error might not always be fatal, just ignore it
    }

}

export default MSEController;