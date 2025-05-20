/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Copyright (C) 2025 Veovera Software Organization.
 * @author Slavik Lozben
 * 
 */

import Log from "../utils/logger";

// This file defines the data structure and interfaces for a WebM muxer.

export type WebMCodec = 'VP8' | 'VP9' | 'AV1' | 'Opus' | 'Vorbis';

export interface WebMTrackInfo {
  codec: WebMCodec;
  width?: number;
  height?: number;
  sampleRate?: number;
  channels?: number;
}

export interface WebMFrame {
  data: Uint8Array;
  timestamp: number; // in milliseconds
  keyframe?: boolean;
}

export class WebMGenerator {
  static readonly TAG = 'WebMGenerator';

  private tracks: WebMTrackInfo[];
  private frames: WebMFrame[][];

  
  static createMimeType(options: {
    type: 'video' | 'audio',
    codecs: string[] // e.g. ['vp9', 'opus'] or ['av01.0.08M.08']
  }): string {
  
    const { type, codecs } = options;

    if (!type || !Array.isArray(codecs) || codecs.length === 0) {
      Log.a(this.TAG, 'type and at least one codec are required');
    }

    const base = `${type}/webm`;
    const codecStr = codecs.join(', ');
    return `${base}; codecs="${codecStr}"`;
  }

  constructor(tracks: WebMTrackInfo[]) {
    this.tracks = tracks;
    this.frames = tracks.map(() => []);
    // TODO: Initialize WebM header/structure
  }

  /**
   * Add a frame to a specific track.
   * @param trackIndex Index of the track (0 = first track)
   * @param frame Frame data and timestamp
   */
  addFrame(trackIndex: number, frame: WebMFrame): void {
    // TODO: Store frame for muxing
    this.frames[trackIndex].push(frame);
  }

  /**
   * Finalize and return the complete WebM file as a Uint8Array.
   */
  finalize(): Uint8Array {
    // TODO: Mux all frames and return the WebM file
    return new Uint8Array();
  }

  /**
   * Reset the generator to start a new file.
   */
  reset(): void {
    this.frames = this.tracks.map(() => []);
    // TODO: Reset internal state if needed
  }
} 