/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Copyright (C) 2025 Veovera Software Organization.
 * @author Slavik Lozben
 *
 */

// web
import { AudioMetadata, VideoFrame, VideoMetadata } from "../demux/flv-demuxer";
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
  TrackNumber         = 0x000000D7,     // 1-based index of the track in the stream 
  TrackUid            = 0x000073C5,     // unique identifier, not used for MSE playback
  TrackType           = 0x00000083,     // 1 = video, 2 = audio
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

enum TrackNumber {
  Video = 1,
  Audio = 2,
}

/**
 * Enum representing MSE track types with their EBML VINT Track Number values.
 */
enum TrackType {
  Video = 1, // EBML VINT = 0x81 (used in SimpleBlock for video)
  Audio = 2, // EBML VINT = 0x82 (used in SimpleBlock for audio)
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
function writeUIntN(value: number): Uint8Array {
  if (value <= 0xFF) return writeUInt(value, 1);
  if (value <= 0xFFFF) return writeUInt(value, 2);
  if (value <= 0xFFFFFF) return writeUInt(value, 3);
  return writeUInt(value, 4);
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
 * Encodes an unsigned integer into EBML Variable-Length Integer (VINT) format.
 *
 * EBML VINTs are used to encode both value and length in a self-delimiting form,
 * where the position of the first set bit in the first byte indicates how many bytes
 * are used in total. This implementation supports values up to Number.MAX_SAFE_INTEGER
 * and produces outputs between 1 and 8 bytes long.
 *
 * VINT format:
 * - The number of leading zero bits in the first byte indicates the total length (1–8 bytes).
 * - The first '1' bit is a marker; the remaining bits represent the payload.
 * - The value is encoded in big-endian order.
 *
 * Examples:
 * - 0x01 to 0x7F → 1 byte: [1vvvvvvv]
 * - 0x80 to 0x3FFF → 2 bytes: [01vvvvvv, vvvvvvvv]
 *
 * @param value - A positive integer ≤ Number.MAX_SAFE_INTEGER to encode.
 * @returns A Uint8Array containing the EBML VINT encoding of the input value.
 */
function writeVint(value: number): Uint8Array {
  Log.a(WebMGenerator.TAG, "writeVint assert failed: value > Number.MAX_SAFE_INTEGER", value <= Number.MAX_SAFE_INTEGER);

  if (value < 0x80) {
    return new Uint8Array([0x80 | value]);
  } else {
    const byteCount = Math.ceil(Math.log2(value + 1) / 7);
    const bytes = new Uint8Array(byteCount);

    if (byteCount === 2) {
      bytes[0] = (value >>> 8) | 0x40;
      bytes[1] = value & 0xff;
    } else if (byteCount === 3) {
      bytes[0] = (value >>> 16) | 0x20;
      bytes[1] = (value >>>  8) & 0xff;
      bytes[2] = value & 0xff;
    } else if (byteCount === 4) {
      bytes[0] = (value >>> 24) | 0x10;
      bytes[1] = (value >>> 16) & 0xff;
      bytes[2] = (value >>>  8) & 0xff;
      bytes[3] = value & 0xff;
    } else {
      bytes[0] = (value >>> ((byteCount - 1) * 8)) & 0xff;
      bytes[0] |= 1 << (8 - byteCount);
      for (let i = 1; i < byteCount; i++) {
        bytes[i] = (value >>> ((byteCount - i - 1) * 8)) & 0xff;
      }
    }
    return bytes;
  }
}

/**
 * Encodes an EBML element with its ID and payload.
 */
function encodeElement(id: number, data: Uint8Array): Uint8Array {
  const idBytes = writeUInt(id, id <= 0xFF ? 1 : id <= 0xFFFF ? 2 : id <= 0xFFFFFF ? 3 : 4);
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
  static readonly TAG = "WebMGenerator";

  static generateVideoInitSegment(codecPrivate: Uint8Array, width: number, height: number): Uint8Array {
    const ebmlHeader = encodeElement(
      EbmlId.Ebml,
      concatUint8Arrays([
        encodeElement(EbmlId.EbmlVersion, writeUInt(1, 1)),
        encodeElement(EbmlId.EbmlReadVersion, writeUInt(1, 1)),
        encodeElement(EbmlId.EbmlMaxIdLength, writeUInt(4, 1)),
        encodeElement(EbmlId.EbmlMaxSizeLength, writeUInt(8, 1)),
        encodeElement(EbmlId.DocType, writeString("webm")),
        encodeElement(EbmlId.DocTypeVersion, writeUInt(2, 1)),
        encodeElement(EbmlId.DocTypeReadVersion, writeUInt(2, 1)),
      ]),
    );

    const segmentInfo = encodeElement(
      EbmlId.Info,
      concatUint8Arrays([
        encodeElement(EbmlId.TimecodeScale, writeUInt(1000000, 3)), // TimecodeScale in μs
        encodeElement(EbmlId.MuxingApp, writeString("e-remux")),
        encodeElement(EbmlId.WritingApp, writeString("e-remux")),
      ]),
    );

    const videoTrack = encodeElement(
      EbmlId.TrackEntry,
      concatUint8Arrays([
        encodeElement(EbmlId.TrackNumber, writeUInt(TrackNumber.Video, 1)),
        encodeElement(EbmlId.TrackUid, writeUInt(1, 1)),
        encodeElement(EbmlId.TrackType, writeUInt(TrackType.Video, 1)),
        encodeElement(EbmlId.CodecId, writeString("V_AV1")),
        encodeElement(EbmlId.CodecPrivate, codecPrivate),
        encodeElement(
          EbmlId.Video,
          concatUint8Arrays([
            encodeElement(EbmlId.PixelWidth, writeUInt(width, 2)),
            encodeElement(EbmlId.PixelHeight, writeUInt(height, 2)),
          ]),
        ),
      ]),
    );

    const tracks = encodeElement(
      EbmlId.Tracks,
      concatUint8Arrays([videoTrack]),
    );

    const segment = encodeElement(
      EbmlId.Segment,
      concatUint8Arrays([segmentInfo, tracks]),
    );

    return concatUint8Arrays([ebmlHeader, segment]);
  }

  static generateAudioInitSegment(codecPrivate: Uint8Array): Uint8Array {
    Log.a(WebMGenerator.TAG, "generateAudioInitSegment not implemented");
    // !!@ Implement audio track init segment (e.g. OpusHead or Vorbis)
    return new Uint8Array();
  }

  /**
   * Generates a WebM video media segment (Cluster) containing a single frame as a SimpleBlock.
   *
   * SimpleBlock Format:
   *   [Track Number (VINT)] [Timecode (int16)] [Flags] [Frame Data...]
   *
   * - Track Number: 1 (as 1-byte VINT, 0x81)
   * - Timecode: Signed 16-bit relative to cluster timecode (in ms)
   * - Flags: 0x80 for keyframe, 0x00 for non-keyframe
   * - Frame Data: Encoded video frame bytes
   *
   * The function wraps the SimpleBlock in a Cluster element, with the cluster timecode
   * set to the nearest second (rounded down) of the provided DTS.
   *
   * @param rawData - Encoded video frame data
   * @param dts - Decode timestamp in milliseconds
   * @param isKeyframe - Whether the frame is a keyframe
   * @returns Uint8Array containing the WebM Cluster with a single SimpleBlock
   */
  static generateVideoSegment(rawData: Uint8Array, dts: number, isKeyframe: boolean): Uint8Array {
    // Use DTS as the absolute timestamp for the cluster
    const clusterTimecodeValue = Math.floor(dts / 1000) * 1000; // cluster starts at nearest 1s
    const blockTimecode = dts - clusterTimecodeValue;
    
    const simpleBlockHeader = new Uint8Array(4);
    simpleBlockHeader[0] = 0x80 | TrackNumber.Video;
    simpleBlockHeader[1] = (blockTimecode >> 8) & 0xff;
    simpleBlockHeader[2] = blockTimecode & 0xff;
    simpleBlockHeader[3] = isKeyframe ? 0x80 : 0x00;        // Flags = keyframe bit

    const simpleBlock = encodeElement(
      EbmlId.SimpleBlock,
      concatUint8Arrays([simpleBlockHeader, rawData])
    );
    
    // Write Cluster
    const clusterTimecode = encodeElement(
      EbmlId.Timecode,
      writeUInt(clusterTimecodeValue, 4),
    );

    const cluster = encodeElement(
      EbmlId.Cluster,
      concatUint8Arrays([clusterTimecode, simpleBlock]),
    );

    return cluster;
  }

  static generateVideoCluster(frames: VideoFrame[]): Uint8Array {
    const clusterTimecodeValue = Math.floor(frames[0].dts / 1000) * 1000;

    const clusterTimecode = encodeElement(
      EbmlId.Timecode,
      writeUInt(clusterTimecodeValue, 4),
    );

    Log.v(WebMGenerator.TAG, `generateVideoCluster() ClusterTimeCodeValue: ${clusterTimecodeValue} ClusterFrames.length: ${frames.length} ++++++++++++++++++++++++++++++++++++++++++++++++++++++`);
    if (!frames[0].isKeyframe) {
      Log.e(WebMGenerator.TAG, 'cluster must start with a keyframe');
      //Log.a(WebMGenerator.TAG, 'cluster must start with a keyframe', frames[0].isKeyframe);
    }

    const blocks = frames.map(({ rawData, dts, isKeyframe, fileposition }, index) => {
      const blockTimecode = dts - clusterTimecodeValue;
      const header = new Uint8Array(4);
      header[0] = 0x80 | TrackNumber.Video;
      header[1] = (blockTimecode >> 8) & 0xff;
      header[2] = blockTimecode & 0xff;
      header[3] = isKeyframe ? 0x80 : 0x00;

      Log.v(WebMGenerator.TAG, `  Frame: key=${isKeyframe}, dts=${dts}, blockTimecode=${blockTimecode}, rawData.length=${rawData?.length}, fileposition=${fileposition}`);
      //Log.a(WebMGenerator.TAG, 'cluster can only have one key frame', index === 0 ? true : !isKeyframe);

      return encodeElement(
        EbmlId.SimpleBlock,
        concatUint8Arrays([header, rawData!])
      );
    });

    return encodeElement(
      EbmlId.Cluster,
      concatUint8Arrays([clusterTimecode, ...blocks]),
    );
  }

  static generateAudioSegment(rawData: Uint8Array): Uint8Array {
    Log.a(WebMGenerator.TAG, "generateAudioSegment not implemented");

    // !!@ Implement audio segment generation
    return new Uint8Array();
  }
}
