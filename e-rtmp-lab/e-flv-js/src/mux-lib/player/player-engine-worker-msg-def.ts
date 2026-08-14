/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Copyright (C) 2023 zheng qian
 * @author zheng qian <xqq@xqq.im>
 * 
 * Modified by Slavik Lozben.
 * Additional changes Copyright (C) 2026 Veovera Software Organization.
 *
 * See Git history for full details.
 */

import MSEEvent from '../core/mse-events';
import PlayerEvents from './player-events';
import TransmuxingEvent, { type DiscoveredTracks } from '../core/transmuxing-events';

export type WorkerMessageType =
    | 'destroyed'
    | 'mse_init'
    | 'mse_event'
    | 'player_event'
    | 'transmuxing_event'
    | 'buffered_position_changed'
    | 'logcat_callback';

export type WorkerMessagePacket = {
    msg: WorkerMessageType,
};

export type WorkerMessagePacketMSEInit = WorkerMessagePacket & {
    msg: 'mse_init',
    handle: any,
};

export type WorkerMessagePacketMSEEvent = WorkerMessagePacket & {
    msg: 'mse_event',
    event: MSEEvent,
    data?: any,
};

export type WorkerMessagePacketPlayerEvent = WorkerMessagePacket & {
    msg: 'player_event',
    event: PlayerEvents,
};

export type WorkerMessagePacketPlayerEventError = WorkerMessagePacketPlayerEvent & {
    msg: 'player_event',
    event: PlayerEvents.ERROR,
    error_type: string,
    error_detail: string,
    info: any,
};

export type WorkerMessagePacketPlayerEventExtraData = WorkerMessagePacketPlayerEvent & {
    msg: 'player_event',
    event:
        | PlayerEvents.METADATA_ARRIVED
        | PlayerEvents.SCRIPTDATA_ARRIVED
        | PlayerEvents.TIMED_ID3_METADATA_ARRIVED,
    extraData: any,
};

export type WorkerMessagePacketTransmuxingEvent = WorkerMessagePacket & {
    msg: 'transmuxing_event',
    event: TransmuxingEvent,
};

export type WorkerMessagePacketTransmuxingEventInfo = WorkerMessagePacketTransmuxingEvent & {
    msg: 'transmuxing_event',
    event: typeof TransmuxingEvent.MEDIA_INFO | typeof TransmuxingEvent.STATISTICS_INFO,
    info: any,
};

export type WorkerMessagePacketTransmuxingEventRecommendSeekpoint = WorkerMessagePacketTransmuxingEvent & {
    msg: 'transmuxing_event',
    event: typeof TransmuxingEvent.RECOMMEND_SEEKPOINT,
    milliseconds: number,
};

export type WorkerMessagePacketTransmuxingEventTracksDiscovered = WorkerMessagePacketTransmuxingEvent & {
    msg: 'transmuxing_event',
    event: typeof TransmuxingEvent.TRACKS_DISCOVERED,
    tracks: DiscoveredTracks,
};

export type WorkerMessagePacketBufferedPositionChanged = WorkerMessagePacket & {
    msg: 'buffered_position_changed',
    buffered_position_milliseconds: number,
};

export type WorkerMessagePacketLogcatCallback = WorkerMessagePacket & {
    msg: 'logcat_callback',
    type: string,
    logcat: string,
};
