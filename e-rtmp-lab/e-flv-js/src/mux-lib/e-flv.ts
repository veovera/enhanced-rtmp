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
import LoggingControl from './utils/logging-control.js';
import {InvalidArgumentException} from './utils/exception.js';
import type {PlayerConfig} from './config.js';

// here are all the interfaces

// Minimal shape required by createPlayer(); the rest of the object is passed
// through untouched to MSEPlayer/NativePlayer (and ultimately TransmuxingController).
interface MediaDataSource {
    type: string;
    [key: string]: unknown;
}

// `unknown` keeps this JavaScript-facing API boundary honest: callers can pass
// any value at runtime, so validate it before treating it as a MediaDataSource.
// factory method
function createPlayer(mediaDataSource: unknown, optionalConfig?: PlayerConfig): MSEPlayer | NativePlayer {
    if (mediaDataSource == null || typeof mediaDataSource !== 'object') {
        throw new InvalidArgumentException('MediaDataSource must be a javascript object!');
    }

    const mds = mediaDataSource as MediaDataSource;

    if (typeof mds.type !== 'string' || mds.type === '') {
        throw new InvalidArgumentException('MediaDataSource must include a non-empty string type field!');
    }

    switch (mds.type) {
        case 'mse':
        case 'flv':
            return new MSEPlayer(mds, optionalConfig);
        default:
            return new NativePlayer(mds, optionalConfig);
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
