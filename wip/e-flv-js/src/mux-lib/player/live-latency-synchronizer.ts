/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Copyright (C) 2023
 * @author zheng qian <xqq@xqq.im>
 * 
 * Modified by Slavik Lozben.
 * Additional changes Copyright (C) 2025 Veovera Software Organization.
 *
 * See Git history for full details.
 */

// Live buffer latency synchronizer by increasing HTMLMediaElement.playbackRate
class LiveLatencySynchronizer {

    private _config: any = null;
    private _media_element: HTMLMediaElement;

    private e?: any = null;

    public constructor(config: any, media_element: HTMLMediaElement) {
        this._config = config;
        this._media_element = media_element;

        this.e = {
            onMediaTimeUpdate: this._onMediaTimeUpdate.bind(this),
        };

        this._media_element.addEventListener('timeupdate', this.e.onMediaTimeUpdate);
    }

    public destroy(): void {
        this._media_element.removeEventListener('timeupdate', this.e.onMediaTimeUpdate);
        this._media_element = null as any;
        this._config = null;
    }

    private _onMediaTimeUpdate(e: Event): void {
        if (!this._config.isLive || !this._config.liveSync) {
            return;
        }

        const latency = this._getCurrentLatency();

        if (latency > this._config.liveSyncMaxLatency) {
            const playback_rate = Math.min(2, Math.max(1, this._config.liveSyncPlaybackRate));
            this._media_element.playbackRate = playback_rate;
        } else if (latency > this._config.liveSyncTargetLatency) {
            // do nothing, keep playbackRate
        } else if (this._media_element.playbackRate !== 1 && this._media_element.playbackRate !== 0) {
            this._media_element.playbackRate = 1;
        }
    }

    private _getCurrentLatency(): number {
        if (!this._media_element) {
            return 0;
        }

        const buffered = this._media_element.buffered;
        const current_time = this._media_element.currentTime;

        if (buffered.length == 0) {
            return 0;
        }

        const buffered_end = buffered.end(buffered.length - 1);
        return buffered_end - current_time;
    }

}

export default LiveLatencySynchronizer;
