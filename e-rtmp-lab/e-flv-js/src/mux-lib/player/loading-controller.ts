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

import type { ResolvedPlayerConfig } from '../config';
import Log from '../utils/logger';

class LoadingController {
    /**
     * LoadingController is used to control the loading process of media segments.
     * It suspends and resumes the transmuxing task based on the buffered position
     * and the current playback time of the media element.
     */
    static readonly TAG: string = 'LoadingController';

    private _config: ResolvedPlayerConfig;
    private _media_element: HTMLMediaElement;
    private _on_pause_transmuxer: () => void;
    private _on_resume_transmuxer: () => void;
    private _paused: boolean = false;
    private e?: any = null;
    private _lazyLoadMaxDuration: number;
    private _lazyLoadRecoverDuration: number;

    public constructor(
        config: ResolvedPlayerConfig,
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

    // Call after the media element's buffered ranges change. The decision uses
    // HTMLMediaElement.buffered, which only covers time where every active track
    // (audio and video) is buffered; a single track's segment end must not be used,
    // since one track can run ahead while the other has nothing to play.
    public notifyBufferedPositionChanged(): void {
        if (this._config.isLive || !this._config.lazyLoad) {
            return;
        }

        this._suspendTransmuxerIfNeeded();
    }

    private _onMediaTimeUpdate(e: Event): void {
        if (this._paused) {
            this._resumeTransmuxerIfNeeded();
        }
    }

    // Seconds of media buffered ahead of the playhead, added up across buffered
    // ranges. Gaps between ranges are not counted, but media after a gap is: it has
    // been downloaded, so counting only the range under the playhead would let
    // loading run on unbounded once a gap appears ahead. A range that starts after
    // the playhead (as at startup) counts in full.
    private _getForwardBufferedDuration(): number {
        const buffered: TimeRanges = this._media_element.buffered;
        const current_time: number = this._media_element.currentTime;
        let duration = 0;

        for (let i = 0; i < buffered.length; i++) {
            const end = buffered.end(i);
            if (end > current_time) {
                duration += end - Math.max(buffered.start(i), current_time);
            }
        }
        return duration;
    }

    private _suspendTransmuxerIfNeeded() {
        const forward_duration = this._getForwardBufferedDuration();
        if (forward_duration >= this._lazyLoadMaxDuration && !this._paused) {
            //Log.v(LoadingController.TAG, `[lazy-load] suspend currentTime=${this._media_element.currentTime.toFixed(3)} bufferedAhead=${forward_duration.toFixed(3)} maxDuration=${this._lazyLoadMaxDuration}`);
            this.suspendTransmuxer();
            this._media_element.addEventListener('timeupdate', this.e.onMediaTimeUpdate);
        }
    }

    public suspendTransmuxer(): void {
        this._paused = true;
        this._on_pause_transmuxer();
    }

    private _resumeTransmuxerIfNeeded(): void {
        // Zero buffered ahead also resumes, so a playhead that ran off the end of
        // the buffer cannot leave loading suspended.
        const forward_duration = this._getForwardBufferedDuration();

        if (forward_duration <= this._lazyLoadRecoverDuration) {
            //Log.v(LoadingController.TAG, `[lazy-load] resume currentTime=${this._media_element.currentTime.toFixed(3)} bufferedAhead=${forward_duration.toFixed(3)} recoverDuration=${this._lazyLoadRecoverDuration}`);
            this.resumeTransmuxer();
            this._media_element.removeEventListener('timeupdate', this.e.onMediaTimeUpdate);
        }
    }

    public resumeTransmuxer(): void {
        //Log.v(LoadingController.TAG, '[lazy-load] requesting transmuxer resume');
        this._paused = false;
        this._on_resume_transmuxer();
    }

}

export default LoadingController;
