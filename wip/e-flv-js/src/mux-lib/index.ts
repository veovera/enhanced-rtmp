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
export { default as MSEPlayer } from './player/mse-player';
export { default as TransmuxingEvents } from './core/transmuxing-events';
export { Remuxer } from './remux/remuxer';
export { defaultConfig } from './config';
export { default as eflv } from './e-flv.js';

