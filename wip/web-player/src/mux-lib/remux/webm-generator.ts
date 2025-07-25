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
import AV1OBUParser from "../demux/av1-parser";

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

enum ClusterBlockMode {
  SimpleBlock,        // Use SimpleBlock for all frames
  BlockGroupAll,      // Use BlockGroup for all frames
  BlockGroupLast,     // Use SimpleBlock for all except last frame, which is BlockGroup
}
const clusterBlockMode: ClusterBlockMode = ClusterBlockMode.SimpleBlock;

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
function writeUIntAuto(value: number): Uint8Array {
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
 * Writes a variable-length integer (VINT) in EBML format.
 * The value must be between 0 and 0xFFFFFFFF (inclusive) because of JS limitations.
 *
 * Note: A VINT with all bits set to 1 (e.g. 0xFF, 0x7FFF) is RESERVED in EBML and NOT valid for values or sizes,
 * except when used to indicate "unknown size" in element size fields. Never emit 0xFF as a value.
 */
function writeVint(value: number): Uint8Array {
  Log.a(WebMGenerator.TAG, `writeVint assert failed: value of ${value} > 0xFFFFFFF`, value >= 0 && value <= 0xFFFFFFFF);

  // Calculate how many bytes are needed to represent a number as EBML variable length integer.
  let bytes = 0;
  let tmpValue = value + 1;
  do {
    bytes++;
  } while ((tmpValue >>>= 7) > 0 && bytes < 8);
  const result = new Uint8Array(bytes);

  // Set the first byte with the leading bits indicating the length
  tmpValue = value | (1 << (bytes * 7)); // ensure the first byte has a leading 1 bit
  for (let i = bytes - 1, index = 0; i >= 0; i--, index++) {
    result[index] = (tmpValue >> (i * 8)) & 0xFF;
  }

  return result;
}

/**
 * Encodes an EBML element with its ID and payload.
 */
function encodeElement(ebmlId: EbmlId, data: Uint8Array): Uint8Array {
  const idBytes = writeUIntAuto(ebmlId);
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

  /**
   * Generates a minimal WebM initialization segment for MSE consumption.
   *
   * WebM Layout:
   *
   * [EBML]
   *   └─ Versioning, DocType, etc.
   *
   * [Segment] (ID + unknown size)
   *   ├─ [Info]
   *   │   ├─ TimecodeScale
   *   │   ├─ MuxingApp, WritingApp
   *   └─ [Tracks]
   *       └─ [TrackEntry] (video)
   *           ├─ TrackNumber, TrackUID, TrackType
   *           ├─ CodecID = "V_AV1"
   *           ├─ CodecPrivate (AV1 OBUs)
   *           └─ [Video]
   *               ├─ PixelWidth
   *               └─ PixelHeight
   *
   * @param codecPrivate - Codec configuration OBUs for AV1
   * @param width - Video width in pixels
   * @param height - Video height in pixels
   * @returns Uint8Array representing the init segment
   */
  static generateVideoInitSegment(codecPrivate: Uint8Array, width: number, height: number): Uint8Array {
    // EBML Header (required at the beginning of any WebM stream)
    const ebmlHeader = encodeElement(EbmlId.Ebml,                   // EBML header element
      concatUint8Arrays([
        encodeElement(EbmlId.EbmlVersion, writeUInt(1, 1)),         // EBMLVersion: 1
        encodeElement(EbmlId.EbmlReadVersion, writeUInt(1, 1)),     // EBMLReadVersion: 1
        encodeElement(EbmlId.EbmlMaxIdLength, writeUInt(4, 1)),     // EBMLMaxIDLength: 4 bytes
        encodeElement(EbmlId.EbmlMaxSizeLength, writeUInt(8, 1)),   // EBMLMaxSizeLength: 8 bytes
        encodeElement(EbmlId.DocType, writeString("webm")),         // DocType: "webm"
        encodeElement(EbmlId.DocTypeVersion, writeUInt(2, 1)),      // DocTypeVersion: 2
        encodeElement(EbmlId.DocTypeReadVersion, writeUInt(2, 1)),  // DocTypeReadVersion: 2
      ])
    );

    // Segment Info (defines timing + origin info for the segment)
    const segmentInfo = encodeElement(EbmlId.Info,
      concatUint8Arrays([
        encodeElement(EbmlId.TimecodeScale, writeUInt(1000000, 3)), // Timecode units = 1ms
        encodeElement(EbmlId.MuxingApp, writeString("e-remux")),    // App creating the segment
        encodeElement(EbmlId.WritingApp, writeString("e-remux")),   // App writing the file
      ])
    );

    // TrackEntry for a single AV1 video stream
    const videoTrack = encodeElement(EbmlId.TrackEntry,
      concatUint8Arrays([
        encodeElement(EbmlId.TrackNumber, writeUInt(1, 1)),         // Track ID (index)
        encodeElement(EbmlId.TrackUid, writeUInt(1, 1)),            // Globally unique ID
        encodeElement(EbmlId.TrackType, writeUInt(1, 1)),           // 1 = video track
        encodeElement(EbmlId.CodecId, writeString("V_AV1")),        // Codec string
        encodeElement(EbmlId.CodecPrivate, codecPrivate),           // Codec config OBUs (seq_header)
        encodeElement(EbmlId.Video,
          concatUint8Arrays([
            encodeElement(EbmlId.PixelWidth, writeUInt(width, 2)),  // e.g., 1920
            encodeElement(EbmlId.PixelHeight, writeUInt(height, 2)),// e.g., 1080
          ])
        ),
      ])
    );

    // Wrap video track in a Tracks element
    const tracks = encodeElement(EbmlId.Tracks, concatUint8Arrays([videoTrack]));

    // Combine Info and Tracks into Segment payload
    const segmentContent = concatUint8Arrays([segmentInfo, tracks]);

    // Segment header with unknown size (suitable for live/streaming MSE)
    const segmentHeader = new Uint8Array([
      0x18, 0x53, 0x80, 0x67, // Segment ID
      0xFF                    // Size = unknown (1-byte VINT)
    ]);

    // Combine Segment header and content
    const segment = concatUint8Arrays([segmentHeader, segmentContent]);
    const result = concatUint8Arrays([ebmlHeader, segment]);

    Log.d(WebMGenerator.TAG, `generateVideoInitSegment() width=${width}, height=${height}, codecPrivate.length=${codecPrivate.length}\n${Log.dumpArrayBuffer(result, 512)}`);
    // Final init segment = EBML header + Segment
    return result
  }

  static generateAudioInitSegment(codecPrivate: Uint8Array): Uint8Array {
    Log.a(WebMGenerator.TAG, "generateAudioInitSegment not implemented");
    // !!@ Implement audio track init segment (e.g. OpusHead or Vorbis)
    return new Uint8Array();
  }

  /**
   * Generates a WebM video media segment (Cluster) from an array of video frames.
   *
   * The block type for each frame is determined by the current ClusterBlockMode:
   *   - SimpleBlock: All frames use SimpleBlock (most compatible with MSE).
   *   - BlockGroupAll: All frames use BlockGroup (with Block and BlockDuration).
   *   - BlockGroupLast: All frames use SimpleBlock except the last, which uses BlockGroup.
   *
   * Cluster Format:
   *   - Timecode (absolute timestamp of the cluster)
   *   - [SimpleBlock | BlockGroup][] (one for each frame, depending on mode)
   *
   * SimpleBlock Format:
   *   [Track Number (VINT)] [Timecode (int16)] [Flags] [Frame Data...]
   *   - Track Number: 1 (as 1-byte VINT, 0x81)
   *   - Timecode: Signed 16-bit relative to the cluster's timecode (in ms)
   *   - Flags: 0x80 for a keyframe, 0x00 for a non-keyframe. Lacing is NOT used.
   *   - Frame Data: The raw encoded video frame.
   *
   * BlockGroup Format:
   *   [BlockGroup]
   *     [Block]
   *       [Track Number (VINT)] [Timecode (int16)] [Frame Data...]
   *     [BlockDuration]
   *       [Duration (uint, typically 4 bytes)]
   *
   * @param frames - An array of VideoFrame objects to be included in the cluster. The first frame MUST be a keyframe.
   * @param refFrameDuration - Reference duration for BlockDuration (used with BlockGroup).
   * @returns A Uint8Array containing the complete WebM Cluster.
   */
  static generateVideoCluster(frames: VideoFrame[], refFrameDuration: number): Uint8Array {
    const clusterTimecodeValue = frames[0].dts;
    const clusterTimecode = encodeElement(EbmlId.Timecode, writeUIntAuto(clusterTimecodeValue));

    const dtsDelta = frames[frames.length - 1].dts - frames[0].dts;
    if (dtsDelta < 0 || dtsDelta > 32767) {
      Log.e(WebMGenerator.TAG, `generateVideoCluster() dtsDelta is out of range: ${dtsDelta}`);
    }
    
    Log.d(WebMGenerator.TAG, `generateVideoClusterSimpleBlock() ClusterTimeCodeValue: ${clusterTimecodeValue} ClusterFrames.length: ${frames.length} dtsDelta: ${frames[frames.length - 1].dts - frames[0].dts} ++++++++++++++++++++++++++++++++++++++++++++++++++++++`);
    if (!frames[0].isKeyframe) {
      Log.e(WebMGenerator.TAG, 'Cluster must start with a keyframe');
    }

    const elements: Uint8Array[] = [];
    for (let index = 0; index < frames.length; index++) {
      const { rawData, dts, isKeyframe } = frames[index];
      const blockTimecode = dts - clusterTimecodeValue;

      if (blockTimecode < 0 || blockTimecode > 32767) {
        Log.e(WebMGenerator.TAG, `blockTimecode out of range: ${blockTimecode} for frame at index ${index}`);
      }

      if (index > 0 && isKeyframe) {
        Log.e(WebMGenerator.TAG, `generateVideoCluster() - Frame at index ${index} is a keyframe but not the first frame in the cluster.`);
      }

      const isSimpleBlock = (clusterBlockMode === ClusterBlockMode.SimpleBlock) || (clusterBlockMode === ClusterBlockMode.BlockGroupLast && index < frames.length - 1);
      //Log.d(WebMGenerator.TAG, `generateVideoCluster() - Frame at index ${index}, blockTimecode=${blockTimecode}, clusterTimeCode=${clusterTimecodeValue}, isKeyframe=${isKeyframe}, rawData.length=${rawData?.length}`);
      if (isSimpleBlock) {
        const header = new Uint8Array(4);
        header[0] = 0x80 | TrackNumber.Video;      // Track number (VINT, 1 byte)
        header[1] = (blockTimecode >> 8) & 0xff;   // Timecode (signed int16)
        header[2] = blockTimecode & 0xff;
        header[3] = isKeyframe ? 0x80 : 0x00;      // Flags: bit 7 is keyframe, bits 1-2 are lacing (set to 0 
        
        const framePayload = AV1OBUParser.extractOBUPayload(rawData!);
        const simpleBlock = encodeElement(EbmlId.SimpleBlock, concatUint8Arrays([header, framePayload]));
        elements.push(simpleBlock);
        //Log.d(WebMGenerator.TAG, `generateVideoCluster() - simpleBlock: key=${isKeyframe}, dts=${dts}, blockTimecode=${blockTimecode}, framePayload.length=${framePayload.length}, simpleBlock.length=${simpleBlock.length}`);
        //Log.d(WebMGenerator.TAG, `generateVideoCluster() - simpleBlock hex dump\n${Log.dumpArrayBuffer(simpleBlock, 512)}`);
      } else {
        const header = new Uint8Array(3);
        header[0] = 0x80 | TrackNumber.Video;
        header[1] = (blockTimecode >> 8) & 0xff;
        header[2] = blockTimecode & 0xff;

        const framePayload = AV1OBUParser.extractOBUPayload(rawData!);
        const block = encodeElement(EbmlId.Block, concatUint8Arrays([header, framePayload]));
        const blockDuration = encodeElement(EbmlId.BlockDuration, writeUInt(refFrameDuration, 4));
        const blockGroup = encodeElement(EbmlId.BlockGroup, concatUint8Arrays([block, blockDuration]));
        elements.push(blockGroup);
      }
    }
    const result = encodeElement(EbmlId.Cluster, concatUint8Arrays([clusterTimecode, ...elements]));

    //Log.d(WebMGenerator.TAG, `generateVideoCluster() clusterTimecodeValue=${clusterTimecodeValue} clusterSize=${result.byteLength}\n${Log.dumpArrayBuffer(result, 512)}`);

    return result;
  }

  static generateAudioSegment(rawData: Uint8Array): Uint8Array {
    Log.a(WebMGenerator.TAG, "generateAudioSegment not implemented");

    // !!@ Implement audio segment generation
    return new Uint8Array();
  }
}
