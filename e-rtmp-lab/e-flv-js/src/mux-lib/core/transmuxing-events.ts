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

const TransmuxingEvents = {
    IO_ERROR: 'io_error',
    DEMUX_ERROR: 'demux_error',
    INIT_SEGMENT: 'init_segment',
    MEDIA_SEGMENT: 'media_segment',
    LOADING_COMPLETE: 'loading_complete',
    RECOVERED_EARLY_EOF: 'recovered_early_eof',
    MEDIA_INFO: 'media_info',
    METADATA_ARRIVED: 'metadata_arrived',
    SCRIPTDATA_ARRIVED: 'scriptdata_arrived',
    TIMED_ID3_METADATA_ARRIVED: 'timed_id3_metadata_arrived',
    STATISTICS_INFO: 'statistics_info',
    TRACKS_DISCOVERED: 'tracks_discovered',
    RECOMMEND_SEEKPOINT: 'recommend_seekpoint'
} as const;

export type TransmuxingEvent = typeof TransmuxingEvents[keyof typeof TransmuxingEvents];

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
    [TransmuxingEvents.IO_ERROR]: [type: string, info: unknown];
    [TransmuxingEvents.DEMUX_ERROR]: [type: string, info: string];
    [TransmuxingEvents.INIT_SEGMENT]: [type: TrackType, initSegment: MSEInitSegment];
    [TransmuxingEvents.MEDIA_SEGMENT]: [type: TrackType, mediaSegment: MSEMediaSegment];
    [TransmuxingEvents.LOADING_COMPLETE]: [];
    [TransmuxingEvents.RECOVERED_EARLY_EOF]: [];
    [TransmuxingEvents.MEDIA_INFO]: [mediaInfo: MediaInfo];
    [TransmuxingEvents.METADATA_ARRIVED]: [metadata: unknown];
    [TransmuxingEvents.SCRIPTDATA_ARRIVED]: [data: unknown];
    [TransmuxingEvents.TIMED_ID3_METADATA_ARRIVED]: [metadata: unknown];
    [TransmuxingEvents.STATISTICS_INFO]: [statisticsInfo: TransmuxingStatisticsInfo];
    [TransmuxingEvents.TRACKS_DISCOVERED]: [tracks: DiscoveredTracks];
    [TransmuxingEvents.RECOMMEND_SEEKPOINT]: [milliseconds: number];
}

export default TransmuxingEvents;
