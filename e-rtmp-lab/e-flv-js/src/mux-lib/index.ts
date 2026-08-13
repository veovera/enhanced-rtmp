/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Copyright (C) 2025 Veovera Software Organization
 * @author Slavik Lozben
 * 
 */

// Centralized entry point for mux-lib

// Re-export frequently used classes/types to avoid deep paths in consumers
export { default as NativePlayer } from './player/native-player.js';
export { default as MSEPlayer } from './player/mse-player.js';
export { default as TransmuxingEvent } from './core/transmuxing-events.js';
export type { DiscoveredTrackInfo, DiscoveredTracks } from './core/transmuxing-events.js';
export { Remuxer } from './remux/remuxer';
export { defaultConfig } from './config.js';
export type { PlayerConfig } from './config.js';
export type { AMFScriptData } from './demux/amf-parser.js';
export { default as eflv } from './e-flv.js';
export type { MediaDataSource, MediaDataSourceSegment } from './e-flv.js';
