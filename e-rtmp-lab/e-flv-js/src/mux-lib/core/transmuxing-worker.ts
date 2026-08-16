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

import { LoggingControl } from '../utils/logger.js';
import TransmuxingController from './transmuxing-controller.js';
import TransmuxingEvent, { type DiscoveredTracks, type TransmuxingStatisticsInfo } from './transmuxing-events.js';
import type MediaInfo from './media-info.js';
import type { ResolvedPlayerConfig } from '../config.js';
import type { MediaDataSource } from '../e-flv.js';
import type { MSEInitSegment, MSEMediaSegment, TrackType } from '../remux/remuxer.js';

type LoggingConfig = ReturnType<typeof LoggingControl.getConfig>;

type WorkerCommand =
    | { cmd: 'init'; param: [MediaDataSource, ResolvedPlayerConfig] }
    | { cmd: 'destroy' }
    | { cmd: 'start' }
    | { cmd: 'stop' }
    | { cmd: 'seek'; param: number }
    | { cmd: 'pause' }
    | { cmd: 'resume' }
    | { cmd: 'select_video_track'; param: number }
    | { cmd: 'logging_config'; param: LoggingConfig };

/* post message to worker:
   data: {
       cmd: string
       param: any
   }

   receive message from worker:
   data: {
       msg: string,
       data: any
   }
 */

function TransmuxingWorker(self: DedicatedWorkerGlobalScope): void {
    let controller: TransmuxingController | null = null;
    const logcatListener = onLogcatCallback;

    self.addEventListener('message', (event: MessageEvent<WorkerCommand>) => {
        const command = event.data;
        switch (command.cmd) {
            case 'init':
                controller = new TransmuxingController(command.param[0], command.param[1]);
                controller.on(TransmuxingEvent.IO_ERROR, onIOError);
                controller.on(TransmuxingEvent.DEMUX_ERROR, onDemuxError);
                controller.on(TransmuxingEvent.INIT_SEGMENT, onInitSegment);
                controller.on(TransmuxingEvent.MEDIA_SEGMENT, onMediaSegment);
                controller.on(TransmuxingEvent.LOADING_COMPLETE, onLoadingComplete);
                controller.on(TransmuxingEvent.RECOVERED_EARLY_EOF, onRecoveredEarlyEof);
                controller.on(TransmuxingEvent.MEDIA_INFO, onMediaInfo);
                controller.on(TransmuxingEvent.METADATA_ARRIVED, onScriptMetadata);
                controller.on(TransmuxingEvent.SCRIPTDATA_ARRIVED, onScriptData);
                controller.on(TransmuxingEvent.TIMED_ID3_METADATA_ARRIVED, onTimedID3MetadataArrived);
                controller.on(TransmuxingEvent.STATISTICS_INFO, onStatisticsInfo);
                controller.on(TransmuxingEvent.TRACKS_DISCOVERED, onTracksDiscovered);
                controller.on(TransmuxingEvent.RECOMMEND_SEEKPOINT, onRecommendSeekpoint);
                break;
            case 'destroy':
                if (controller) {
                    controller.destroy();
                    controller = null;
                }
                self.postMessage({msg: 'destroyed'});
                break;
            case 'start':
                controller?.start();
                break;
            case 'stop':
                controller?.stop();
                break;
            case 'seek':
                controller?.seek(command.param);
                break;
            case 'pause':
                controller?.pause();
                break;
            case 'resume':
                controller?.resume();
                break;
            case 'select_video_track':
                controller?.selectVideoTrack(command.param);
                break;
            case 'logging_config': {
                const config = command.param;
                LoggingControl.applyConfig(config);

                if (config.enableCallback === true) {
                    LoggingControl.addLogListener(logcatListener);
                } else {
                    LoggingControl.removeLogListener(logcatListener);
                }
                break;
            }
        }
    });

    function onInitSegment(type: TrackType, initSegment: MSEInitSegment): void {
        const obj = {
            msg: TransmuxingEvent.INIT_SEGMENT,
            data: {
                type: type,
                data: initSegment
            }
        };
        self.postMessage(obj, [initSegment.data.buffer as ArrayBuffer]);
    }

    function onMediaSegment(type: TrackType, mediaSegment: MSEMediaSegment): void {
        const obj = {
            msg: TransmuxingEvent.MEDIA_SEGMENT,
            data: {
                type: type,
                data: mediaSegment
            }
        };
        self.postMessage(obj, [mediaSegment.data.buffer as ArrayBuffer]);
    }

    function onLoadingComplete(): void {
        const obj = {
            msg: TransmuxingEvent.LOADING_COMPLETE
        };
        self.postMessage(obj);
    }

    function onRecoveredEarlyEof(): void {
        const obj = {
            msg: TransmuxingEvent.RECOVERED_EARLY_EOF
        };
        self.postMessage(obj);
    }

    function onMediaInfo(mediaInfo: MediaInfo): void {
        const obj = {
            msg: TransmuxingEvent.MEDIA_INFO,
            data: mediaInfo
        };
        self.postMessage(obj);
    }

    function onScriptMetadata(metadata: unknown): void {
        const obj = {
            msg: TransmuxingEvent.METADATA_ARRIVED,
            data: metadata
        };
        self.postMessage(obj);
    }

    function onScriptData(data: unknown): void {
        const obj = {
            msg: TransmuxingEvent.SCRIPTDATA_ARRIVED,
            data: data
        };
        self.postMessage(obj);
    }

    function onTimedID3MetadataArrived(data: unknown): void {
        const obj = {
            msg: TransmuxingEvent.TIMED_ID3_METADATA_ARRIVED,
            data: data
        };
        self.postMessage(obj);
    }

    function onStatisticsInfo(statInfo: TransmuxingStatisticsInfo): void {
        const obj = {
            msg: TransmuxingEvent.STATISTICS_INFO,
            data: statInfo
        };
        self.postMessage(obj);
    }

    function onTracksDiscovered(tracks: DiscoveredTracks): void {
        const obj = {
            msg: TransmuxingEvent.TRACKS_DISCOVERED,
            data: tracks
        };
        self.postMessage(obj);
    }

    function onIOError(type: string, info: unknown): void {
        self.postMessage({
            msg: TransmuxingEvent.IO_ERROR,
            data: {
                type: type,
                info: info
            }
        });
    }

    function onDemuxError(type: string, info: string): void {
        self.postMessage({
            msg: TransmuxingEvent.DEMUX_ERROR,
            data: {
                type: type,
                info: info
            }
        });
    }

    function onRecommendSeekpoint(milliseconds: number): void {
        self.postMessage({
            msg: TransmuxingEvent.RECOMMEND_SEEKPOINT,
            data: milliseconds
        });
    }

    function onLogcatCallback(type: string, str: string): void {
        self.postMessage({
            msg: 'logcat_callback',
            data: {
                type: type,
                logcat: str
            }
        });
    }

}

export default TransmuxingWorker;
