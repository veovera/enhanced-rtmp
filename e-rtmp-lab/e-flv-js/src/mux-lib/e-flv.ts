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

import Features from './core/features.js';
import {BaseLoader, LoaderStatus, LoaderErrors} from './io/loader.js';
import MSEPlayer from './player/mse-player.js';
import NativePlayer from './player/native-player.js';
import PlayerEvents from './player/player-events.js';
import {ErrorTypes, ErrorDetails} from './player/player-errors.js';
import { LoggingControl } from './utils/logger.js';
import {InvalidArgumentException} from './utils/exception.js';
import type {PlayerConfig} from './config.js';

// here are all the interfaces

interface MediaDataSourceBase {
    type: string;
    duration?: number;
    filesize?: number;
    hasAudio?: boolean;
    hasVideo?: boolean;
    cors?: boolean;
    withCredentials?: boolean;
    isLive?: boolean;
    [key: string]: unknown;
}

/** A single media file, or one part of a multipart media source. */
export interface MediaDataSourceSegment {
    url: string;
    duration?: number;
    filesize?: number;
}

/**
 * The media input accepted by {@link createPlayer}.
 *
 * Provide a URL for a single stream, or `segments` for multipart playback.
 */
export type MediaDataSource = MediaDataSourceBase & ({ url: string } | { segments: MediaDataSourceSegment[] });

function createPlayer(mediaDataSource: MediaDataSource, optionalConfig?: PlayerConfig): MSEPlayer | NativePlayer {
    // TypeScript callers get the MediaDataSource shape at compile time, but
    // keep this guard for JavaScript callers and TypeScript `any` boundaries.
    if (mediaDataSource == null || typeof mediaDataSource !== 'object') {
        throw new InvalidArgumentException('MediaDataSource must be a javascript object!');
    }

    if (typeof mediaDataSource.type !== 'string' || mediaDataSource.type === '') {
        throw new InvalidArgumentException('MediaDataSource must include a non-empty string type field!');
    }

    switch (mediaDataSource.type) {
        case 'mse':
        case 'flv':
            return new MSEPlayer(mediaDataSource, optionalConfig);
        default:
            return new NativePlayer(mediaDataSource, optionalConfig);
    }
}


// feature detection
//!!@ isSupported mathoed needs to be expanded to all features used
function isSupported() {
    return Features.supportMSEH264Playback();
}

function getFeatureList() {
    return Features.getFeatureList();
}


// interfaces
const eflv = {
    createPlayer,
    isSupported,
    getFeatureList,

    BaseLoader,
    LoaderStatus,
    LoaderErrors,

    Events: PlayerEvents,
    ErrorTypes,
    ErrorDetails,

    MSEPlayer,
    NativePlayer,
    LoggingControl,

    get version() {
        // replaced by bundler DefinePlugin (see build.js)
        return __VERSION__;
    }
} as const;

export default eflv;
