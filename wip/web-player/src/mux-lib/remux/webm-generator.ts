/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Copyright (C) 2025 Veovera Software Organization.
 * @author Slavik Lozben
 * 
 */

// web
import { AudioMetadata, VideoMetadata } from "../demux/flv-demuxer";
import Log from "../utils/logger";

/**
 * WebM MSE Bitstream Format Overview
 *
 * When remuxing into WebM for Media Source Extensions (MSE), the format differs from a traditional WebM file.
 * You must generate a streamable WebM structure, consisting of an Initialization Segment followed by Media Segments.
 *
 * == Initialization Segment ==
 *   - EBML Header
 *   - Segment
 *     - Info
 *     - Tracks
 *       - TrackEntry for each stream (e.g. VP9, AV1, Opus)
 *       - CodecPrivate containing codec config (e.g. AV1CodecConfigurationRecord or OpusHead)
 *
 *   Notes:
 *   - Only required once at the start.
 *   - Contains metadata needed to decode future clusters.
 *
 * == Media Segments (aka Chunks) ==
 *   - Cluster
 *     - Timecode (relative to Segment timecode scale)
 *     - One or more SimpleBlock or BlockGroup entries
 *       - Each represents a single audio or video frame
 *
 *   Notes:
 *   - No Cues, Chapters, SeekHead, or Tags should be included.
 *   - Timestamps must be monotonically increasing.
 *   - Clusters should be short (e.g. 500ms–2s) and independently decodable.
 *
 * == MSE Requirements ==
 *   - WebM stream must be well-formed but not seekable.
 *   - Append an init segment once via `SourceBuffer.appendBuffer()`, then stream clusters.
 *   - TimecodeScale typically set to 1,000,000 (1ms units), but nanosecond precision is supported.
 *
 * For more details:
 *   - https://www.webmproject.org/docs/container/
 *   - https://datatracker.ietf.org/doc/html/draft-lhomme-cellar-ebml
 */

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

  private _tracks: WebMTrackInfo[] = [];
  private _frames: WebMFrame[][] = [];

  
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

  /**
   * Add a frame to a specific track.
   * @param trackIndex Index of the track (0 = first track)
   * @param frame Frame data and timestamp
   */
  addFrame(trackIndex: number, frame: WebMFrame): void {
    // TODO: Store frame for muxing
    //this.frames[trackIndex].push(frame);
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
    //this.frames = this.tracks.map(() => []);
    // TODO: Reset internal state if needed
  }

  generateInitSegment(): Uint8Array {
    // Stub for now; replace with proper EBML + Tracks for WebM
    const ebmlHeader = this.encodeEbmlHeader();
    const segmentInfo = this.encodeSegmentInfo();
    const tracks = this.encodeTracks();

    //return this.concatUint8Arrays([ebmlHeader, segmentInfo, tracks]);
    return new Uint8Array();
  }

  /*
  private encodeSimpleBlock(tag: FLVTag): Uint8Array | null {
    // You'd need to encode WebM blocks here
    // Stubbed — implement using actual SimpleBlock format
    return tag.data;
  }
  */

  private writeCluster(timecode: number, blocks: Uint8Array[]): Uint8Array[] {
    // Wrap blocks in a Cluster element (with timecode)
    // Stub — replace with real EBML-encoded Cluster
    return blocks;
  }

  private encodeEbmlHeader(): Uint8Array {
    // Stub — EBML header encoding
    return new Uint8Array();
  }

  private encodeSegmentInfo(): Uint8Array {
    // Stub — encode Segment Info with timecodeScale etc.
    return new Uint8Array();
  }

  private encodeTracks(): Uint8Array {
    // Stub — encode TrackEntry for VP9 and/or Opus
    return new Uint8Array();
  }

  private concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
    const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
} 