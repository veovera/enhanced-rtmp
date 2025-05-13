/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Copyright (C) 2016 Bilibili
 * @author zheng qian <xqq@xqq.im>
 *
 * Modified and migrated to TypeScript by Slavik Lozben.
 * Additional changes Copyright (C) Veovera Software Organization.
 *
 * See Git history for full details.
 */

export const defaultConfig = {
    enableWorker: false,
    enableWorkerForMSE: false,
    enableStashBuffer: true,
    stashInitialSize: undefined,

    isLive: false,

    liveBufferLatencyChasing: false,
    liveBufferLatencyChasingOnPaused: false,
    liveBufferLatencyMaxLatency: 1.5,
    liveBufferLatencyMinRemain: 0.5,

    liveSync: false,
    liveSyncMaxLatency: 1.2,
    liveSyncTargetLatency: 0.8,
    liveSyncPlaybackRate: 1.2,

    lazyLoad: true,
    lazyLoadMaxDuration: 3 * 60,
    lazyLoadRecoverDuration: 30,
    deferLoadAfterSourceOpen: true,

    // autoCleanupSourceBuffer: default as false, leave unspecified
    autoCleanupMaxBackwardDuration: 3 * 60,
    autoCleanupMinBackwardDuration: 2 * 60,

    statisticsInfoReportInterval: 600,

    fixAudioTimestampGap: true,

    accurateSeek: false,
    seekType: 'range',  // [range, param, custom]
    seekParamStart: 'bstart',
    seekParamEnd: 'bend',
    rangeLoadZeroStart: false,
    customSeekHandler: undefined,
    reuseRedirectedURL: false,
    // referrerPolicy: leave as unspecified

    headers: undefined,
    customLoader: undefined
} as const;

export type ConfigOptions = typeof defaultConfig;

export function createDefaultConfig(): ConfigOptions {
    return Object.assign({}, defaultConfig);
}