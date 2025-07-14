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
  BlockGroup          = 0xA0,
  Block               = 0xA1,
  BlockDuration       = 0x9B,
  BlockAdditions      = 0x75A1,
  BlockMore           = 0xA6,
  BlockAddID          = 0xEE,
  BlockAdditional     = 0xA5,
  ReferenceBlock      = 0xFB,
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

  /**
   * Generates a WebM video media segment (Cluster) from an array of video frames.
   *
   * Each frame is wrapped in a BlockGroup, which contains a Block and its duration.
   * This is suitable for streaming to Media Source Extensions (MSE).
   *
   * Cluster Format:
   *   - Timecode (absolute timestamp of the cluster)
   *   - BlockGroup[] (one for each frame)
   *
   * BlockGroup Format:
   *   - Block
   *   - BlockDuration
   *
   * Block Format:
   *   [Track Number (VINT)] [Timecode (int16)] [Frame Data...]
   *
   * - Track Number: 1 (as 1-byte VINT, 0x81)
   * - Timecode: Signed 16-bit relative to the cluster's timecode (in ms).
   * - Frame Data: The raw encoded video frame.
   *
   * Note: Unlike SimpleBlock, a Block element does not contain keyframe flags in its header.
   * For MSE, it is crucial that the first frame of any appended cluster is a keyframe.
   *
   * @param frames - An array of VideoFrame objects to be included in the cluster. The first frame MUST be a keyframe.
   * @param refFrameDuration - A reference duration to use for the last frame in the cluster.
   * @returns A Uint8Array containing the complete WebM Cluster.
   */
  static generateVideoClusterBlock(frames: VideoFrame[], refFrameDuration: number): Uint8Array {
    const clusterTimecodeValue = Math.floor(frames[0].dts / 1000) * 1000;

    const clusterTimecode = encodeElement(
      EbmlId.Timecode,
      writeUInt(clusterTimecodeValue, 4),
    );

    Log.v(WebMGenerator.TAG, `generateVideoCluster() ClusterTimeCodeValue: ${clusterTimecodeValue} ClusterFrames.length: ${frames.length} ++++++++++++++++++++++++++++++++++++++++++++++++++++++`);
    
    if (!frames[0].isKeyframe) {
      Log.e(WebMGenerator.TAG, 'Cluster must start with a keyframe');
    }

    const blocks: Uint8Array[] = [];
    for (let index = 0; index < frames.length; index++) {
      const { rawData, dts, isKeyframe } = frames[index];
      const blockTimecode = dts - clusterTimecodeValue;
      let duration = refFrameDuration;
      
      if (index < frames.length - 1) {
        // Calculate duration based on the next frame's DTS
        const nextDts = frames[index + 1].dts;
        duration = nextDts - dts;
      }

      // Create the Block header
      const header = new Uint8Array(3);
      header[0] = 0x80 | TrackNumber.Video; // Track number (1 for video)
      header[1] = (blockTimecode >> 8) & 0xff; // High byte of block timecode
      header[2] = blockTimecode & 0xff; // Low byte of block timecode

      // Log frame details (optional)
      // Log.v(WebMGenerator.TAG, `  Frame: key=${isKeyframe}, dts=${dts}, blockTimecode=${blockTimecode}, rawData.length=${rawData?.length}, fileposition=${fileposition}`);
      
      const block = encodeElement(EbmlId.Block, concatUint8Arrays([header, rawData!]));
      const blockDuration = encodeElement(EbmlId.BlockDuration, writeUInt(duration, 4));
      const blockGroupPayload: Uint8Array[] = [block, blockDuration];

      // 2. Add ReferenceBlock for non-keyframes
      if (!isKeyframe) {
        // This frame depends on a previous frame. We'll reference the first frame in the cluster.
        // The value is the timecode offset from this block to the referenced block.
        const referenceTimecode = -blockTimecode;
        const referenceBlock = encodeElement(EbmlId.ReferenceBlock, writeUInt(referenceTimecode, 2));
        blockGroupPayload.push(referenceBlock);
      }

      const blockGroup = encodeElement(
        EbmlId.BlockGroup,
        concatUint8Arrays(blockGroupPayload)
      );
      // Log.v(WebMGenerator.TAG, `  BlockGroup: blockTimecode=${blockTimecode}, duration=${duration}, rawData.length=${rawData?.length}`);
    
      blocks.push(blockGroup);
    }

    return encodeElement(
      EbmlId.Cluster,
      concatUint8Arrays([clusterTimecode, ...blocks]),
    );
  }

  /**
   * Generates a WebM video media segment (Cluster) from an array of video frames.
   *
   * Each frame is wrapped in a SimpleBlock element. This is the most common and
   * compatible method for streaming to Media Source Extensions (MSE).
   *
   * Cluster Format:
   *   - Timecode (absolute timestamp of the cluster)
   *   - SimpleBlock[] (one for each frame)
   *
   * SimpleBlock Format:
   *   [Track Number (VINT)] [Timecode (int16)] [Flags] [Frame Data...]
   *
   * - Track Number: 1 (as 1-byte VINT, 0x81)
   * - Timecode: Signed 16-bit relative to the cluster's timecode (in ms).
   * - Flags: 0x80 for a keyframe, 0x00 for a non-keyframe. Lacing is NOT used.
   * - Frame Data: The raw encoded video frame.
   *
   * @param frames - An array of VideoFrame objects to be included in the cluster. The first frame MUST be a keyframe.
   * @param refFrameDuration - A reference duration (not used with SimpleBlock but kept for API consistency).
   * @returns A Uint8Array containing the complete WebM Cluster.
   */
  static generateVideoClusterSimpleBlock(frames: VideoFrame[], refFrameDuration: number): Uint8Array {
    const clusterTimecodeValue = Math.floor(frames[0].dts / 1000) * 1000;

    const clusterTimecode = encodeElement(
      EbmlId.Timecode,
      writeUInt(clusterTimecodeValue, 4),
    );

    if (!frames[0].isKeyframe) {
      Log.e(WebMGenerator.TAG, 'Cluster must start with a keyframe');
    }

    const simpleBlocks: Uint8Array[] = [];
    for (let index = 0; index < frames.length; index++) {
      const { rawData, dts, isKeyframe } = frames[index];
      const blockTimecode = dts - clusterTimecodeValue;

      // Create the SimpleBlock header (4 bytes)
      const header = new Uint8Array(4);
      header[0] = 0x80 | TrackNumber.Video;      // Track number (VINT, 1 byte)
      header[1] = (blockTimecode >> 8) & 0xff;  // Timecode (signed int16)
      header[2] = blockTimecode & 0xff;
      header[3] = isKeyframe ? 0x80 : 0x00;      // Flags: bit 7 is keyframe, bits 1-2 are lacing (set to 0)

      // Create the SimpleBlock element
      const simpleBlock = encodeElement(
        EbmlId.SimpleBlock,
        concatUint8Arrays([header, rawData!])
      );

      simpleBlocks.push(simpleBlock);
    }

    return encodeElement(
      EbmlId.Cluster,
      concatUint8Arrays([clusterTimecode, ...simpleBlocks]),
    );
  }

  static generateAudioSegment(rawData: Uint8Array): Uint8Array {
    Log.a(WebMGenerator.TAG, "generateAudioSegment not implemented");

    // !!@ Implement audio segment generation
    return new Uint8Array();
  }
}
