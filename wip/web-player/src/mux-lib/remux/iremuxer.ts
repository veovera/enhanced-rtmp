/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Copyright (C) 2025 Veovera Software Organization
 * @author Slavik Lozben
 * 
 */

import { Callback } from '../utils/common';
import { FLVDemuxer } from '../demux/flv-demuxer';

export interface IRemuxer {
  /**
   * Add a frame to a specific track.
   * Handles timestamp logic, segmenting, etc. if needed.
   * @param trackIndex Index of the track (0 = first track)
   * @param frame Frame data and timestamp
   */
  addFrame?(trackIndex: number, frame: any): void;

  /**
   * Finalize and return the complete container file as a Uint8Array.
   */
  finalize?(): Uint8Array;
  
  destroy(): void;
  bindDataSource(producer: FLVDemuxer): this;
  insertDiscontinuity(): void;
  seek(originalDts: number): void;
  getTimestampBase(): number | undefined;
  flushStashedSamples(): void;

  // Callback properties
  onInitSegment: Callback;
  onMediaSegment: Callback;

  // Optionally, you can add:
  // getInitSegment?(): Uint8Array;
  // getMimeType?(): string;
} 