/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Copyright (C) 2016 Bilibili.
 * @author zheng qian <xqq@xqq.im>
 * 
 * Modified by Slavik Lozben.
 * Additional changes Copyright (C) 2025 Veovera Software Organization.
 *
 * See Git history for full details.
 */

import EventEmitter from 'eventemitter3';
import PlayerEvents from './player-events';
import {createDefaultConfig, type PlayerConfig, type ResolvedPlayerConfig} from '../config.js';
import type {MediaDataSource} from '../e-flv.js';
import {InvalidArgumentException, IllegalStateException} from '../utils/exception.js';

// Player wrapper for browser's native player (HTMLVideoElement) without MediaSource src.
type SingleFileMediaDataSource = MediaDataSource & {url: string};

function isSingleFileMediaDataSource(mediaDataSource: MediaDataSource): mediaDataSource is SingleFileMediaDataSource {
    return typeof mediaDataSource.url === 'string';
}

class NativePlayer {
    private readonly TAG = 'NativePlayer';
    private _type = 'NativePlayer';
    private _emitter = new EventEmitter();
    private _config: ResolvedPlayerConfig;
    private e: {onvLoadedMetadata: (event: Event) => void} | null;
    private _pendingSeekTime: number | null;
    private _statisticsReporter: number | null;
    private _mediaDataSource: SingleFileMediaDataSource;
    private _mediaElement: HTMLMediaElement | null;

    constructor(mediaDataSource: MediaDataSource, config?: PlayerConfig) {
        this._config = createDefaultConfig();
        if (typeof config === 'object') {
            Object.assign(this._config, config);
        }

        let typeLowerCase = mediaDataSource.type.toLowerCase();

        if (typeLowerCase === 'mse' || typeLowerCase === 'flv') {
            throw new InvalidArgumentException('NativePlayer does\'t support mse/flv MediaDataSource input!');
        }
        if (!isSingleFileMediaDataSource(mediaDataSource)) {
            throw new InvalidArgumentException(`NativePlayer(${mediaDataSource.type}) doesn't support multipart playback!`);
        }

        this.e = {
            onvLoadedMetadata: this._onvLoadedMetadata.bind(this)
        };

        this._pendingSeekTime = null;
        this._statisticsReporter = null;

        this._mediaDataSource = mediaDataSource;
        this._mediaElement = null;
    }

    destroy() {
        this._emitter.emit(PlayerEvents.DESTROYING);
        if (this._mediaElement) {
            this.unload();
            this.detachMediaElement();
        }
        this.e = null;
        this._emitter.removeAllListeners();
    }

    on(event: string, listener: (...args: unknown[]) => void) {
        if (event === PlayerEvents.MEDIA_INFO) {
            if (this._mediaElement != null && this._mediaElement.readyState !== 0) {  // HAVE_NOTHING
                Promise.resolve().then(() => {
                    this._emitter.emit(PlayerEvents.MEDIA_INFO, this.mediaInfo);
                });
            }
        } else if (event === PlayerEvents.STATISTICS_INFO) {
            if (this._mediaElement != null && this._mediaElement.readyState !== 0) {
                Promise.resolve().then(() => {
                    this._emitter.emit(PlayerEvents.STATISTICS_INFO, this.statisticsInfo);
                });
            }
        }
        this._emitter.addListener(event, listener);
    }

    off(event: string, listener: (...args: unknown[]) => void) {
        this._emitter.removeListener(event, listener);
    }

    attachMediaElement(mediaElement: HTMLMediaElement) {
        this._mediaElement = mediaElement;
        mediaElement.addEventListener('loadedmetadata', this.e!.onvLoadedMetadata);

        if (this._pendingSeekTime != null) {
            try {
                mediaElement.currentTime = this._pendingSeekTime;
                this._pendingSeekTime = null;
            } catch (e) {
                // IE11 may throw InvalidStateError if readyState === 0
                // Defer set currentTime operation after loadedmetadata
            }
        }
    }

    detachMediaElement() {
        if (this._mediaElement) {
            this._mediaElement.src = '';
            this._mediaElement.removeAttribute('src');
            this._mediaElement.removeEventListener('loadedmetadata', this.e!.onvLoadedMetadata);
            this._mediaElement = null;
        }
        if (this._statisticsReporter != null) {
            window.clearInterval(this._statisticsReporter);
            this._statisticsReporter = null;
        }
    }

    load() {
        if (!this._mediaElement) {
            throw new IllegalStateException('HTMLMediaElement must be attached before load()!');
        }
        this._mediaElement.src = this._mediaDataSource.url;

        if (this._mediaElement.readyState > 0) {
            this._mediaElement.currentTime = 0;
        }

        this._mediaElement.preload = 'auto';
        this._mediaElement.load();
        this._statisticsReporter = window.setInterval(
            this._reportStatisticsInfo.bind(this),
        this._config.statisticsInfoReportInterval);
    }

    unload() {
        if (this._mediaElement) {
            this._mediaElement.src = '';
            this._mediaElement.removeAttribute('src');
        }
        if (this._statisticsReporter != null) {
            window.clearInterval(this._statisticsReporter);
            this._statisticsReporter = null;
        }
    }

    play() {
        return this._mediaElement!.play();
    }

    pause() {
        this._mediaElement!.pause();
    }

    get type() {
        return this._type;
    }

    get buffered() {
        return this._mediaElement!.buffered;
    }

    get duration() {
        return this._mediaElement!.duration;
    }

    get volume() {
        return this._mediaElement!.volume;
    }

    set volume(value: number) {
        this._mediaElement!.volume = value;
    }

    get muted() {
        return this._mediaElement!.muted;
    }

    set muted(muted: boolean) {
        this._mediaElement!.muted = muted;
    }

    get currentTime() {
        if (this._mediaElement) {
            return this._mediaElement.currentTime;
        }
        return 0;
    }

    set currentTime(seconds: number) {
        if (this._mediaElement) {
            this._mediaElement.currentTime = seconds;
        } else {
            this._pendingSeekTime = seconds;
        }
    }

    get mediaInfo() {
        let mediaPrefix = (this._mediaElement instanceof HTMLAudioElement) ? 'audio/' : 'video/';
        let info: {mimeType: string; duration?: number; width?: number; height?: number} = {
            mimeType: mediaPrefix + this._mediaDataSource.type
        };
        if (this._mediaElement) {
            info.duration = Math.floor(this._mediaElement.duration * 1000);
            if (this._mediaElement instanceof HTMLVideoElement) {
                info.width = this._mediaElement.videoWidth;
                info.height = this._mediaElement.videoHeight;
            }
        }
        return info;
    }

    get statisticsInfo() {
        let info: {playerType: string; url: string; decodedFrames?: number; droppedFrames?: number} = {
            playerType: this._type,
            url: this._mediaDataSource.url
        };

        if (!(this._mediaElement instanceof HTMLVideoElement)) {
            return info;
        }

        let hasQualityInfo = true;
        let decoded = 0;
        let dropped = 0;

        if (this._mediaElement.getVideoPlaybackQuality) {
            let quality = this._mediaElement.getVideoPlaybackQuality();
            decoded = quality.totalVideoFrames;
            dropped = quality.droppedVideoFrames;
        } else if ((this._mediaElement as HTMLVideoElement & {webkitDecodedFrameCount?: number}).webkitDecodedFrameCount != undefined) {
            const webkitMediaElement = this._mediaElement as HTMLVideoElement & {
                webkitDecodedFrameCount: number;
                webkitDroppedFrameCount: number;
            };
            decoded = webkitMediaElement.webkitDecodedFrameCount;
            dropped = webkitMediaElement.webkitDroppedFrameCount;
        } else {
            hasQualityInfo = false;
        }

        if (hasQualityInfo) {
            info.decodedFrames = decoded;
            info.droppedFrames = dropped;
        }

        return info;
    }

    _onvLoadedMetadata(_event: Event) {
        if (this._pendingSeekTime != null) {
            this._mediaElement!.currentTime = this._pendingSeekTime;
            this._pendingSeekTime = null;
        }
        this._emitter.emit(PlayerEvents.MEDIA_INFO, this.mediaInfo);
    }

    _reportStatisticsInfo() {
        this._emitter.emit(PlayerEvents.STATISTICS_INFO, this.statisticsInfo);
    }

}

export default NativePlayer;
