/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Copyright (C) 2025 Veovera Software Organization.
 * @author Slavik Lozben
 */

import { Callback } from '../utils/common';
import { FLVDemuxer } from '../demux/flv-demuxer';

export interface IRemuxer {
  destroy(): void;
  bindDataSource(producer: FLVDemuxer): this;
  insertDiscontinuity(): void;
  seek(originalDts: number): void;
  flushStashedSamples(): void;

  get timestampBase(): number | undefined;

  // Callback properties
  get onInitSegment(): Callback;
  set onInitSegment(callback: Callback);
  get onMediaSegment(): Callback;
  set onMediaSegment(callback: Callback);
} 