/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Copyright (C) 2016 Bilibili
 * @author zheng qian <xqq@xqq.im>
 *
 * Modified and migrated to TypeScript by Slavik Lozben.
 * Additional changes Copyright (C) 2026 Veovera Software Organization.
 *
 * See Git history for full details.
 */

import type MediaInfo from './media-info.js';
import type { MSEInitSegment, MSEMediaSegment, TrackType } from '../remux/remuxer.js';

export enum TransmuxingEvent {
    IO_ERROR =                      'io_error',
    DEMUX_ERROR =                   'demux_error',
    INIT_SEGMENT =                  'init_segment',
    MEDIA_SEGMENT =                 'media_segment',
    LOADING_COMPLETE =              'loading_complete',
    RECOVERED_EARLY_EOF =           'recovered_early_eof',
    MEDIA_INFO =                    'media_info',
    METADATA_ARRIVED =              'metadata_arrived',
    SCRIPTDATA_ARRIVED =            'scriptdata_arrived',
    TIMED_ID3_METADATA_ARRIVED =    'timed_id3_metadata_arrived',
    STATISTICS_INFO =               'statistics_info',
    TRACKS_DISCOVERED =             'tracks_discovered',
    RECOMMEND_SEEKPOINT =           'recommend_seekpoint'
}

/** Loading statistics reported by the transmuxing controller. */
export interface TransmuxingStatisticsInfo {
    url: string;
    hasRedirect: boolean;
    redirectedURL?: string;
    speed: number;
    loaderType: string;
    currentSegmentIndex: number;
    totalSegmentCount: number;
}

export interface DiscoveredTrackInfo {
    type: TrackType;
    trackId: number;
    codec: string;
}

export interface DiscoveredTracks {
    audio: DiscoveredTrackInfo[];
    video: DiscoveredTrackInfo[];
}

/** Listener argument tuple for each transmuxing event. */
export interface TransmuxingEventMap {
    [TransmuxingEvent.IO_ERROR]: [type: string, info: unknown];
    [TransmuxingEvent.DEMUX_ERROR]: [type: string, info: string];
    [TransmuxingEvent.INIT_SEGMENT]: [type: TrackType, initSegment: MSEInitSegment];
    [TransmuxingEvent.MEDIA_SEGMENT]: [type: TrackType, mediaSegment: MSEMediaSegment];
    [TransmuxingEvent.LOADING_COMPLETE]: [];
    [TransmuxingEvent.RECOVERED_EARLY_EOF]: [];
    [TransmuxingEvent.MEDIA_INFO]: [mediaInfo: MediaInfo];
    [TransmuxingEvent.METADATA_ARRIVED]: [metadata: unknown];
    [TransmuxingEvent.SCRIPTDATA_ARRIVED]: [data: unknown];
    [TransmuxingEvent.TIMED_ID3_METADATA_ARRIVED]: [metadata: unknown];
    [TransmuxingEvent.STATISTICS_INFO]: [statisticsInfo: TransmuxingStatisticsInfo];
    [TransmuxingEvent.TRACKS_DISCOVERED]: [tracks: DiscoveredTracks];
    [TransmuxingEvent.RECOMMEND_SEEKPOINT]: [milliseconds: number];
}

export default TransmuxingEvent;
