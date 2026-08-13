/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Copyright (C) 2016 Bilibili
 * @author zheng qian <xqq@xqq.im>
 * 
 * Modified and migrated to TypeScript by Slavik Lozben.
 * Additional changes Copyright (C) 2025 Veovera Software Organization.
 *
 * See Git history for full details.
 */

import EventEmitter from 'eventemitter3';
import Log, { LoggingControl } from '../utils/logger.js';
import TransmuxingController from './transmuxing-controller.js';
import TransmuxingEvents, { type DiscoveredTracks, type TransmuxingEvent, type TransmuxingEventMap, type TransmuxingStatisticsInfo } from './transmuxing-events.js';
import MediaInfo from './media-info.js';
import type { ResolvedPlayerConfig } from '../config.js';
import type { MediaDataSource } from '../e-flv.js';
import type { MSEInitSegment, MSEMediaSegment, TrackType } from '../remux/remuxer.js';

type LoggingConfig = ReturnType<typeof LoggingControl.getConfig>;

type WorkerMessage =
    | { msg: 'destroyed' }
    | { msg: 'logcat_callback'; data: { type: string; logcat: string } }
    | { msg: typeof TransmuxingEvents.INIT_SEGMENT; data: { type: TrackType; data: MSEInitSegment } }
    | { msg: typeof TransmuxingEvents.MEDIA_SEGMENT; data: { type: TrackType; data: MSEMediaSegment } }
    | { msg: typeof TransmuxingEvents.LOADING_COMPLETE }
    | { msg: typeof TransmuxingEvents.RECOVERED_EARLY_EOF }
    | { msg: typeof TransmuxingEvents.MEDIA_INFO; data: MediaInfo }
    | { msg: typeof TransmuxingEvents.METADATA_ARRIVED; data: unknown }
    | { msg: typeof TransmuxingEvents.SCRIPTDATA_ARRIVED; data: unknown }
    | { msg: typeof TransmuxingEvents.TIMED_ID3_METADATA_ARRIVED; data: unknown }
    | { msg: typeof TransmuxingEvents.STATISTICS_INFO; data: TransmuxingStatisticsInfo }
    | { msg: typeof TransmuxingEvents.TRACKS_DISCOVERED; data: DiscoveredTracks }
    | { msg: typeof TransmuxingEvents.IO_ERROR; data: { type: string; info: unknown } }
    | { msg: typeof TransmuxingEvents.DEMUX_ERROR; data: { type: string; info: string } }
    | { msg: typeof TransmuxingEvents.RECOMMEND_SEEKPOINT; data: number };

class Transmuxer {
    private readonly TAG = 'Transmuxer';
    private _emitter: EventEmitter;
    private _worker: Worker | null = null;
    private _workerDestroying = false;
    private _controller: TransmuxingController | null = null;
    private e: { onLoggingConfigChanged: (config: LoggingConfig) => void } | null = null;

    constructor(mediaDataSource: MediaDataSource, config: ResolvedPlayerConfig) {
        this._emitter = new EventEmitter();

        if (config.enableWorker && typeof (Worker) !== 'undefined') {
            try {
                this._worker = new Worker(new URL('./transmuxing-worker.js', import.meta.url));
                this._workerDestroying = false;
                this._worker.addEventListener('message', this._onWorkerMessage.bind(this));
                this._worker.postMessage({cmd: 'init', param: [mediaDataSource, config]});
                this.e = {
                    onLoggingConfigChanged: this._onLoggingConfigChanged.bind(this)
                };
                LoggingControl.registerListener(this.e.onLoggingConfigChanged);
                this._worker.postMessage({cmd: 'logging_config', param: LoggingControl.getConfig()});
            } catch (error) {
                Log.e(this.TAG, 'Error while initialize transmuxing worker, fallback to inline transmuxing');
                this._worker = null;
                this._controller = new TransmuxingController(mediaDataSource, config);
            }
        } else {
            this._controller = new TransmuxingController(mediaDataSource, config);
        }

        if (this._controller) {
            let ctl = this._controller;
            ctl.on(TransmuxingEvents.IO_ERROR, this._onIOError.bind(this));
            ctl.on(TransmuxingEvents.DEMUX_ERROR, this._onDemuxError.bind(this));
            ctl.on(TransmuxingEvents.INIT_SEGMENT, this._onInitSegment.bind(this));
            ctl.on(TransmuxingEvents.MEDIA_SEGMENT, this._onMediaSegment.bind(this));
            ctl.on(TransmuxingEvents.LOADING_COMPLETE, this._onLoadingComplete.bind(this));
            ctl.on(TransmuxingEvents.RECOVERED_EARLY_EOF, this._onRecoveredEarlyEof.bind(this));
            ctl.on(TransmuxingEvents.MEDIA_INFO, this._onMediaInfo.bind(this));
            ctl.on(TransmuxingEvents.METADATA_ARRIVED, this._onScriptMetadata.bind(this));
            ctl.on(TransmuxingEvents.SCRIPTDATA_ARRIVED, this._onScriptData.bind(this));
            ctl.on(TransmuxingEvents.TIMED_ID3_METADATA_ARRIVED, this._onTimedID3MetadataArrived.bind(this));
            ctl.on(TransmuxingEvents.STATISTICS_INFO, this._onStatisticsInfo.bind(this));
            ctl.on(TransmuxingEvents.TRACKS_DISCOVERED, this._onTracksDiscovered.bind(this));
            ctl.on(TransmuxingEvents.RECOMMEND_SEEKPOINT, this._onRecommendSeekpoint.bind(this));
        }
    }

    destroy(): void {
        if (this._worker) {
            if (!this._workerDestroying) {
                this._workerDestroying = true;
                this._worker.postMessage({cmd: 'destroy'});
                if (this.e) {
                    LoggingControl.removeListener(this.e.onLoggingConfigChanged);
                }
                this.e = null;
            }
        } else if (this._controller) {
            this._controller.destroy();
            this._controller = null;
        }
        this._emitter.removeAllListeners();
    }

    on<K extends TransmuxingEvent>(event: K, listener: (...args: TransmuxingEventMap[K]) => void): void {
        this._emitter.addListener(event, listener);
    }

    off<K extends TransmuxingEvent>(event: K, listener: (...args: TransmuxingEventMap[K]) => void): void {
        this._emitter.removeListener(event, listener);
    }

    hasWorker(): boolean {
        return this._worker != null;
    }

    open(): void {
        if (this._worker) {
            this._worker.postMessage({cmd: 'start'});
        } else {
            this._controller?.start();
        }
    }

    close(): void {
        if (this._worker) {
            this._worker.postMessage({cmd: 'stop'});
        } else {
            this._controller?.stop();
        }
    }

    seek(milliseconds: number): void {
        if (this._worker) {
            this._worker.postMessage({cmd: 'seek', param: milliseconds});
        } else {
            this._controller?.seek(milliseconds);
        }
    }

    pause(): void {
        if (this._worker) {
            this._worker.postMessage({cmd: 'pause'});
        } else {
            this._controller?.pause();
        }
    }

    resume(): void {
        if (this._worker) {
            this._worker.postMessage({cmd: 'resume'});
        } else {
            this._controller?.resume();
        }
    }

    _onInitSegment(type: TrackType, initSegment: MSEInitSegment): void {
        // do async invoke
        Promise.resolve().then(() => {
            this._emitter.emit(TransmuxingEvents.INIT_SEGMENT, type, initSegment);
        });
    }

    _onMediaSegment(type: TrackType, mediaSegment: MSEMediaSegment): void {
        Promise.resolve().then(() => {
            this._emitter.emit(TransmuxingEvents.MEDIA_SEGMENT, type, mediaSegment);
        });
    }

    _onLoadingComplete(): void {
        Promise.resolve().then(() => {
            this._emitter.emit(TransmuxingEvents.LOADING_COMPLETE);
        });
    }

    _onRecoveredEarlyEof(): void {
        Promise.resolve().then(() => {
            this._emitter.emit(TransmuxingEvents.RECOVERED_EARLY_EOF);
        });
    }

    _onMediaInfo(mediaInfo: MediaInfo): void {
        Promise.resolve().then(() => {
            this._emitter.emit(TransmuxingEvents.MEDIA_INFO, mediaInfo);
        });
    }

    _onScriptMetadata(metadata: unknown): void {
        Promise.resolve().then(() => {
            this._emitter.emit(TransmuxingEvents.METADATA_ARRIVED, metadata);
        });
    }

    _onScriptData(data: unknown): void {
        Promise.resolve().then(() => {
            this._emitter.emit(TransmuxingEvents.SCRIPTDATA_ARRIVED, data);
        });
    }

    _onTimedID3MetadataArrived(data: unknown): void {
        Promise.resolve().then(() => {
            this._emitter.emit(TransmuxingEvents.TIMED_ID3_METADATA_ARRIVED, data);
        });
    }

    _onStatisticsInfo(statisticsInfo: TransmuxingStatisticsInfo): void {
        Promise.resolve().then(() => {
            this._emitter.emit(TransmuxingEvents.STATISTICS_INFO, statisticsInfo);
        });
    }

    _onTracksDiscovered(tracks: DiscoveredTracks): void {
        Promise.resolve().then(() => {
            this._emitter.emit(TransmuxingEvents.TRACKS_DISCOVERED, tracks);
        });
    }

    _onIOError(type: string, info: unknown): void {
        Promise.resolve().then(() => {
            this._emitter.emit(TransmuxingEvents.IO_ERROR, type, info);
        });
    }

    _onDemuxError(type: string, info: string): void {
        Promise.resolve().then(() => {
            this._emitter.emit(TransmuxingEvents.DEMUX_ERROR, type, info);
        });
    }

    _onRecommendSeekpoint(milliseconds: number): void {
        Promise.resolve().then(() => {
            this._emitter.emit(TransmuxingEvents.RECOMMEND_SEEKPOINT, milliseconds);
        });
    }

    _onLoggingConfigChanged(config: LoggingConfig): void {
        if (this._worker) {
            this._worker.postMessage({cmd: 'logging_config', param: config});
        }
    }

    _onWorkerMessage(event: MessageEvent<WorkerMessage>): void {
        const message = event.data;

        if (message.msg === 'destroyed' || this._workerDestroying) {
            this._workerDestroying = false;
            this._worker?.terminate();
            this._worker = null;
            return;
        }

        switch (message.msg) {
            case TransmuxingEvents.INIT_SEGMENT:
            case TransmuxingEvents.MEDIA_SEGMENT:
                this._emitter.emit(message.msg, message.data.type, message.data.data);
                break;
            case TransmuxingEvents.LOADING_COMPLETE:
            case TransmuxingEvents.RECOVERED_EARLY_EOF:
                this._emitter.emit(message.msg);
                break;
            case TransmuxingEvents.MEDIA_INFO:
                Object.setPrototypeOf(message.data, MediaInfo.prototype);
                this._emitter.emit(message.msg, message.data);
                break;
            case TransmuxingEvents.METADATA_ARRIVED:
            case TransmuxingEvents.SCRIPTDATA_ARRIVED:
            case TransmuxingEvents.TIMED_ID3_METADATA_ARRIVED:
            case TransmuxingEvents.STATISTICS_INFO:
            case TransmuxingEvents.TRACKS_DISCOVERED:
                this._emitter.emit(message.msg, message.data);
                break;
            case TransmuxingEvents.IO_ERROR:
            case TransmuxingEvents.DEMUX_ERROR:
                this._emitter.emit(message.msg, message.data.type, message.data.info);
                break;
            case TransmuxingEvents.RECOMMEND_SEEKPOINT:
                this._emitter.emit(message.msg, message.data);
                break;
            case 'logcat_callback':
                Log.emitLog(message.data.type, message.data.logcat);
                break;
            default:
                break;
        }
    }

}

export default Transmuxer;
