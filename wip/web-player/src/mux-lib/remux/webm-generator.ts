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

type WebMCodec = 'VP8' | 'VP9' | 'AV1' | 'Opus' | 'Vorbis';
enum EbmlId {
  Ebml                = 0x1A45DFA3,
  Segment             = 0x18538067,
  Info                = 0x1549A966,
  TimecodeScale       = 0x002AD7B1,
  MuxingApp           = 0x00004D80,
  WritingApp          = 0x00005741,
  Tracks              = 0x1654AE6B,
  TrackEntry          = 0x000000AE,
  TrackNumber         = 0x000000D7,
  TrackUid            = 0x000073C5,
  TrackType           = 0x00000083,
  CodecId             = 0x00000086,
  CodecPrivate        = 0x000063A2,
  DefaultDuration     = 0x0023E383,
  Video               = 0x000000E0,
  PixelWidth          = 0x000000B0,
  PixelHeight         = 0x000000BA,
  EbmlVersion         = 0x4286,
  EbmlReadVersion     = 0x42F7,
  EbmlMaxIdLength     = 0x42F2,
  EbmlMaxSizeLength   = 0x42F3,
  DocType             = 0x4282,
  DocTypeVersion      = 0x4287,
  DocTypeReadVersion  = 0x4285,
  Cluster             = 0x1F43B675,
  Timecode            = 0xE7,
  SimpleBlock         = 0xA3,
}

/**
 * Encodes a string into a UTF-8 Uint8Array.
 */
function writeString(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/**
 * Writes an unsigned integer in a fixed-size big-endian format.
 */
function writeUInt(value: number, size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = size - 1; i >= 0; i--) {
    bytes[i] = value & 0xff;
    value >>= 8;
  }
  return bytes;
}

/**
 * Writes a simple EBML variable-length integer (VINT).
 */
function writeVint(value: number): Uint8Array {
  if (value < 0x80) {
    return new Uint8Array([0x80 | value]);
  }
  if (value < 0x4000) {
    return new Uint8Array([0x40 | (value >> 8), value & 0xff]);
  }
  throw new Error('VINT too large for this implementation.');
}

/**
 * Encodes an EBML element with its ID and payload.
 */
function encodeElement(id: number, data: Uint8Array): Uint8Array {
  const idBytes = writeUInt(id, Math.ceil(Math.log2(id + 1) / 8));
  const sizeBytes = writeVint(data.length);
  return concatUint8Arrays([idBytes, sizeBytes, data]);
}

/**
 * Concatenates multiple Uint8Arrays into one.
 */
function concatUint8Arrays(buffers: Uint8Array[]): Uint8Array {
  const totalLength = buffers.reduce((sum, buf) => sum + buf.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const buf of buffers) {
    result.set(buf, offset);
    offset += buf.length;
  }
  return result;
}

/**
 * Generates a minimal WebM initialization segment containing AV1 codec config.
 */
export class WebMGenerator {
  static readonly TAG = 'WebMGenerator';

  static generateVideoInitSegment(codecPrivate: Uint8Array): Uint8Array {
    const ebmlHeader = encodeElement(EbmlId.Ebml, concatUint8Arrays([
      encodeElement(EbmlId.EbmlVersion, writeUInt(1, 1)),   
      encodeElement(EbmlId.EbmlReadVersion, writeUInt(1, 1)),
      encodeElement(EbmlId.EbmlMaxIdLength, writeUInt(4, 1)),
      encodeElement(EbmlId.EbmlMaxSizeLength, writeUInt(8, 1)),
      encodeElement(EbmlId.DocType, writeString('webm')),
      encodeElement(EbmlId.DocTypeVersion, writeUInt(2, 1)),
      encodeElement(EbmlId.DocTypeReadVersion, writeUInt(2, 1)),
    ]));

    const segmentInfo = encodeElement(EbmlId.Info, concatUint8Arrays([
      encodeElement(EbmlId.TimecodeScale, writeUInt(1000000, 3)),  // TimecodeScale in μs
      encodeElement(EbmlId.MuxingApp, writeString('e-remux')),
      encodeElement(EbmlId.WritingApp, writeString('e-remux')),
    ]));

    const videoTrack = encodeElement(EbmlId.TrackEntry, concatUint8Arrays([
      encodeElement(EbmlId.TrackNumber, writeUInt(1, 1)),
      encodeElement(EbmlId.TrackUid, writeUInt(1, 1)),
      encodeElement(EbmlId.TrackType, writeUInt(1, 1)), // 1 = video
      encodeElement(EbmlId.CodecId, writeString('V_AV1')),
      encodeElement(EbmlId.CodecPrivate, codecPrivate),
      encodeElement(EbmlId.DefaultDuration, writeUInt(33366666, 4)), // ~30 fps
      encodeElement(EbmlId.Video, concatUint8Arrays([
        encodeElement(EbmlId.PixelWidth, writeUInt(1280, 2)),
        encodeElement(EbmlId.PixelHeight, writeUInt(720, 2)),
      ])),
    ]));

    const tracks = encodeElement(EbmlId.Tracks, concatUint8Arrays([videoTrack]));
    const segment = encodeElement(EbmlId.Segment, concatUint8Arrays([segmentInfo, tracks]));

    return concatUint8Arrays([ebmlHeader, segment]);
  }

  static generateAudioInitSegment(codecPrivate: Uint8Array): Uint8Array {
    Log.a(WebMGenerator.TAG, 'generateAudioInitSegment not implemented');
    // !!@ Implement audio track init segment (e.g. OpusHead or Vorbis)
    return new Uint8Array();
  }

  static generateVideoSegment(rawData: Uint8Array): Uint8Array {
    // Minimal WebM Cluster with a single SimpleBlock
    const timecode = 0;     // In ms, relative to cluster
    const trackNumber = 1;  // Matches TrackNumber in init segment
    const keyframe = true;

    // Write SimpleBlock
    const simpleBlockHeader = new Uint8Array(4);
    simpleBlockHeader[0] = 0x80 | trackNumber;      // Track Number (VINT with 1-byte)
    simpleBlockHeader[1] = (timecode >> 8) & 0xff;  // Timecode high byte
    simpleBlockHeader[2] = timecode & 0xff;         // Timecode low byte
    simpleBlockHeader[3] = keyframe ? 0x80 : 0x00;  // Flags: keyframe

    const simpleBlock = concatUint8Arrays([simpleBlockHeader, rawData]);
    const blockElement = encodeElement(EbmlId.SimpleBlock, simpleBlock); // 0xA3 = SimpleBlock

    // Write Cluster
    const clusterTimecode = encodeElement(EbmlId.Timecode, writeUInt(timecode, 2)); // 0xE7 = Timecode
    const cluster = encodeElement(EbmlId.Cluster, concatUint8Arrays([clusterTimecode, blockElement])); // Cluster

    return cluster;
  }

  static generateAudioSegment(rawData: Uint8Array): Uint8Array {
    Log.a(WebMGenerator.TAG, 'generateAudioSegment not implemented');

    // !!@ Implement audio segment generation
    return new Uint8Array();
  }
}
