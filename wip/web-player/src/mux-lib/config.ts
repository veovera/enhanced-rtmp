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

export type ReferrerPolicy = 
    'no-referrer' | 
    'no-referrer-when-downgrade' | 
    'origin' | 
    'origin-when-cross-origin' | 
    'same-origin' | 
    'strict-origin' | 
    'strict-origin-when-cross-origin' | 
    'unsafe-url' | 
    undefined;

export const defaultConfig = {
    // Enable demuxing and decoding in a Web Worker thread
    enableWorker: false,

    // Enable using a Worker for Media Source Extensions (MSE) operations
    //!!@ this path is not enabled value does not signal intent
    enableWorkerForMSE: false,

    // Enable stash buffer for input stream (improves performance for network jitter)
    enableStashBuffer: true,

    // Initial size of the stash buffer (bytes); undefined uses default
    stashInitialSize: undefined,

    // Indicates if the stream is live (not VOD)
    isLive: false,

    // Enable latency chasing for live streams (adjust playback to reduce latency)
    liveBufferLatencyChasing: false,

    // Enable latency chasing even when playback is paused
    liveBufferLatencyChasingOnPaused: false,

    // Maximum allowed live latency (seconds) before chasing is triggered
    liveBufferLatencyMaxLatency: 1.5,

    // Minimum buffer remaining (seconds) to maintain during latency chasing
    liveBufferLatencyMinRemain: 0.5,

    // Enable live sync mode (keep playback close to live edge)
    liveSync: false,

    // Maximum allowed latency for live sync (seconds)
    liveSyncMaxLatency: 1.2,

    // Target latency for live sync (seconds)
    liveSyncTargetLatency: 0.8,

    // Playback rate to use during live sync (speed up to catch up)
    liveSyncPlaybackRate: 1.2,

    // Enable lazy loading of segments (load only when needed)
    lazyLoad: true,

    // Maximum duration (seconds) to buffer during lazy loading
    lazyLoadMaxDuration: 3 * 60,

    // Duration (seconds) to recover after lazy loading resumes
    lazyLoadRecoverDuration: 1 * 60,

    // Defer loading until MediaSource is open
    deferLoadAfterSourceOpen: true,

    // Maximum backward buffer duration (seconds) for automatic cleanup
    autoCleanupMaxBackwardDuration: 3 * 60,

    // Minimum backward buffer duration (seconds) to keep before cleanup
    autoCleanupMinBackwardDuration: 2 * 60,

    // Enable automatic cleanup of SourceBuffer to free up memory and avoid QuotaExceededError.
    autoCleanupSourceBuffer: true,

    // Interval (ms) for reporting playback statistics
    statisticsInfoReportInterval: 600,

    // Fix gaps in audio timestamps (improves sync)
    fixAudioTimestampGap: true,

    // Enable accurate seeking (frame-accurate, may be slower)
    accurateSeek: false,

    // Seek type: 'range' (HTTP range), 'param' (URL params), or 'custom'
    seekType: 'range',

    // Query parameter name for seek start (used with 'param' seekType)
    seekParamStart: 'bstart',

    // Query parameter name for seek end (used with 'param' seekType)
    seekParamEnd: 'bend',

    // Always start range loads from zero (for some server configs)
    rangeLoadZeroStart: false,

    // Custom seek handler function (if needed)
    customSeekHandler: undefined,

    // Reuse redirected URL for subsequent requests
    reuseRedirectedURL: false,

    // Custom HTTP headers for requests
    headers: undefined,

    // Custom loader implementation (for advanced use cases)
    customLoader: undefined,

    // Referrer policy for fetch requests
    referrerPolicy: undefined
} as const;

export type ConfigOptions = typeof defaultConfig;

export function createDefaultConfig(): ConfigOptions {
    return { ...defaultConfig };
}