/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Copyright (C) 2023 zheng qian
 * @author zheng qian <xqq@xqq.im>
 * 
 * Modified by Slavik Lozben.
 * Additional changes Copyright (C) 2025 Veovera Software Organization.
 *
 * See Git history for full details.
 */

import { ConfigOptions } from '../config';
import Log from '../utils/logger';

class LoadingController {
    /**
     * LoadingController is used to control the loading process of media segments.
     * It suspends and resumes the transmuxing task based on the buffered position
     * and the current playback time of the media element.
     */
    static readonly TAG: string = 'LoadingController';

    private _config: ConfigOptions;
    private _media_element: HTMLMediaElement;
    private _on_pause_transmuxer: () => void;
    private _on_resume_transmuxer: () => void;
    private _paused: boolean = false;
    private e?: any = null;
    private _lazyLoadMaxDuration: number;
    private _lazyLoadRecoverDuration: number;

    public constructor(
        config: ConfigOptions,
        media_element: HTMLMediaElement,
        on_pause_transmuxer: () => void,
        on_resume_transmuxer: () => void
    ) {
        this._config = config;
        this._lazyLoadMaxDuration = config.lazyLoadMaxDuration;
        this._lazyLoadRecoverDuration = config.lazyLoadRecoverDuration;
        this._media_element = media_element;
        this._on_pause_transmuxer = on_pause_transmuxer;
        this._on_resume_transmuxer = on_resume_transmuxer;

        this.e = {
            onMediaTimeUpdate: this._onMediaTimeUpdate.bind(this),
        };
    }

    public destroy(): void {
        this._media_element.removeEventListener('timeupdate', this.e.onMediaTimeUpdate);
        this.e = null;
    }

    public adjustLazyLoadDurations(factor: number): void {
        this._lazyLoadMaxDuration = Math.max(4, this._lazyLoadMaxDuration * factor);
        this._lazyLoadRecoverDuration = Math.max(2, this._lazyLoadRecoverDuration * factor);

        Log.v(LoadingController.TAG,
            `Adjusted lazy load durations (factor: ${factor}) to - ` +
            `Max: ${this._lazyLoadMaxDuration}, ` +
            `Recover: ${this._lazyLoadRecoverDuration}`
        );
    }

    // buffered_position: in seconds
    public notifyBufferedPositionChanged(buffered_position?: number): void {
        if (this._config.isLive || !this._config.lazyLoad) {
            return;
        }

        if (buffered_position == undefined) {
            this._suspendTransmuxerIfNeeded();
        } else {
            this._suspendTransmuxerIfBufferedPositionExceeded(buffered_position);
        }
    }

    private _onMediaTimeUpdate(e: Event): void {
        if (this._paused) {
            this._resumeTransmuxerIfNeeded();
        }
    }

    private _suspendTransmuxerIfNeeded() {
        const buffered: TimeRanges = this._media_element.buffered;
        const current_time: number = this._media_element.currentTime;
        let current_range_end = 0;

        for (let i = 0; i < buffered.length; i++) {
            const start = buffered.start(i);
            const end = buffered.end(i);
            if (start <= current_time && current_time < end) {
                current_range_end = end;
                break;
            }
        }
        if (current_range_end > 0) {
            this._suspendTransmuxerIfBufferedPositionExceeded(current_range_end);
        }
    }

    private _suspendTransmuxerIfBufferedPositionExceeded(buffered_end: number): void {
        //Log.v(LoadingController.TAG, `_suspendTransmuxerIfBufferedPositionExceeded(buffered_end: ${buffered_end})`);
        const current_time = this._media_element.currentTime;
        if (buffered_end >= current_time + this._lazyLoadMaxDuration && !this._paused) {
            Log.v(LoadingController.TAG, '.   Maximum buffering duration exceeded, suspend transmuxing task');
            this.suspendTransmuxer();
            this._media_element.addEventListener('timeupdate', this.e.onMediaTimeUpdate);
        }
    }

    public suspendTransmuxer(): void {
        this._paused = true;
        this._on_pause_transmuxer();
    }

    private _resumeTransmuxerIfNeeded(): void {
        const buffered: TimeRanges = this._media_element.buffered;
        const current_time: number = this._media_element.currentTime;

        const recover_duration = this._lazyLoadRecoverDuration;
        let should_resume = false;

        for (let i = 0; i < buffered.length; i++) {
            const from = buffered.start(i);
            const to = buffered.end(i);
            if (current_time >= from && current_time < to) {
                if (current_time >= to - recover_duration) {
                    should_resume = true;
                }
                break;
            }
        }

        if (should_resume) {
            Log.v(LoadingController.TAG,  'Continue loading from paused position');
            this.resumeTransmuxer();
            this._media_element.removeEventListener('timeupdate', this.e.onMediaTimeUpdate);
        }
    }

    public resumeTransmuxer(): void {
        this._paused = false;
        this._on_resume_transmuxer();
    }

}

export default LoadingController;
