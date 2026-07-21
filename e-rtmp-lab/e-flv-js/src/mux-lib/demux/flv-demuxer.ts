/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Copyright (C) 2016 Bilibili
 * @author zheng qian <xqq@xqq.im>
 *
 * Modified and migrated to TypeScript by Slavik Lozben.
 * Additional changes Copyright (C) 2025 Veovera Software Organization.
 *
 * See Git history for full details.
 */

import Log from '../utils/logger.js';
import AMF, { AMFObjectValue, AMFScriptData } from './amf-parser.js';
import SPSParser from './sps-parser.js';
import DemuxErrors from './demux-errors.js';
import MediaInfo, { KeyframesIndex } from '../core/media-info.js';
import H265Parser from './h265-parser.js';
import buffersAreEqual from '../utils/typedarray-equality.js';
import AV1OBUParser from './av1-parser.js';
import ExpGolomb from './exp-golomb.js';
import { assertCallback, Callback, noopCallback } from '../utils/common';
import { Av1ObuType, AV1Metadata } from './av1-parser.js';
import { Remuxer, TrackType } from '../remux/remuxer.js';
import { H264NaluType } from './h264.js';
import { H265NaluType } from './h265.js';
import { ConfigOptions } from '../config.js';
import IOController from '../io/io-controller.js';
import { VpxParser, Vp9HeaderInfo } from './vpx-parser.js';
import { AudioSpecificConfig, AACFrame } from './aac.js';
import { MPEG4AudioObjectTypes, MPEG4SamplingRates, MPEG4SamplingRateIndex } from './mpeg4-audio.js';

//
// you can find enhanced flv specification here: https://veovera.org/docs/enhanced/enhanced-rtmp-v2
//

export interface FlvProbeSuccess {
    match: true;
    consumed: number;
    dataOffset: number;
    hasAudioTrack: boolean;
    hasVideoTrack: boolean;
}

type ProbeResult = { needMoreData: true } | { match: false } | FlvProbeSuccess;

export interface AACConfig {
    config: Uint8Array;
    samplingRate: number;
    channelCount: number;
    codec: string;
    originalCodec: string;
    channelConfigWasInBand: boolean;
    channelConfigHasPce: boolean;
}

type AACPacketData =
    | { packetType: AudioPacketType.SequenceStart; data: AACConfig }                                      // sequence header
    | { packetType: Exclude<AudioPacketType, AudioPacketType.SequenceStart>; data: Uint8Array };          // coded frames or other packet types (e.g., CodedFrames, SequenceEnd, Multitrack, ModEx, etc.)

interface Mp3FrameHeader {
    bitRate: number;
    samplingRate: number;
    channelCount: number;
    codec: string;
    originalCodec: string;
}

function formatHexBytes(data: Uint8Array): string {
    return Array.from(data)
        .map((value) => value.toString(16).padStart(2, '0'))
        .join(' ');
}

/**
 * AudioPacketType defines the types of audio packets
 * used within our streaming and remuxing pipeline.
 */
enum AudioPacketType {
    /** Start of a new sequence of audio packets */
    SequenceStart = 0,

    /** Standard audio packet carrying encoded frames */
    CodedFrames = 1,

    /**
     * SequenceEnd signals the end of an audio sequence.
     * While redundant, it ensures downstream consumers
     * know that no more packets follow for the current sequence.
     */
    SequenceEnd = 2,

    /** Reserved for future use */
    Reserved3 = 3,

    /** Configuration packet for multi-channel audio */
    MultichannelConfig = 4,

    /** Enables multi-track audio streams */
    Multitrack = 5,

    /** Reserved for future use */
    Reserved6 = 6,

    /**
     * ModeX: Extends or augments the behavior of a base packet.
     * Used for advanced capabilities like high-precision timestamps,
     * additional metadata, or other experimental features.
     */
    ModEx = 7,

    /** Reserved for future use */
    Reserved8 = 8,
    Reserved9 = 9,
    Reserved10 = 10,
    Reserved11 = 11,
    Reserved12 = 12,
    Reserved13 = 13,
    Reserved14 = 14,
    Reserved15 = 15,
}

enum SoundFormat {
    LPcmPlatformEndian  = 0,
    AdPcm               = 1,
    Mp3                 = 2,
    LPcmLittleEndian    = 3,
    Nellymoser16KMono   = 4,
    Nellymoser8KMono    = 5,
    Nellymoser          = 6,
    G711ALaw            = 7,
    G711MuLaw           = 8,
    ExHeader            = 9,   // New: used to signal FOURCC mode
    Aac                 = 10,
    Speex               = 11,
    // 12 and 13 are reserved
    Mp3_8K              = 14,
    Native              = 15   // Device-specific sound
}

/** AudioChannelOrder describes how the channels in a MultichannelConfig packet are ordered. */
enum AudioChannelOrder {
    /** Only channel count is specified; no further ordering info provided. */
    Unspecified = 0,
    /** Channels follow the native order defined by the AudioChannel enum. */
    Native      = 1,
    /** Channel order is arbitrary; an explicit per-channel speaker map is present. */
    Custom      = 2,
}

/** Bitmask flags indicating which speaker positions are present (Native order). */
enum AudioChannelMask {
    FrontLeft         = 0x000001,
    FrontRight        = 0x000002,
    FrontCenter       = 0x000004,
    LowFrequency1     = 0x000008,
    BackLeft          = 0x000010,
    BackRight         = 0x000020,
    FrontLeftCenter   = 0x000040,
    FrontRightCenter  = 0x000080,
    BackCenter        = 0x000100,
    SideLeft          = 0x000200,
    SideRight         = 0x000400,
    TopCenter         = 0x000800,
    TopFrontLeft      = 0x001000,
    TopFrontCenter    = 0x002000,
    TopFrontRight     = 0x004000,
    TopBackLeft       = 0x008000,
    TopBackCenter     = 0x010000,
    TopBackRight      = 0x020000,
    LowFrequency2     = 0x040000,
    TopSideLeft       = 0x080000,
    TopSideRight      = 0x100000,
    BottomFrontCenter = 0x200000,
    BottomFrontLeft   = 0x400000,
    BottomFrontRight  = 0x800000,
}

/** Speaker position indices used in Custom channel mappings. */
enum AudioChannel {
    FrontLeft         = 0,
    FrontRight        = 1,
    FrontCenter       = 2,
    LowFrequency1     = 3,
    BackLeft          = 4,
    BackRight         = 5,
    FrontLeftCenter   = 6,
    FrontRightCenter  = 7,
    BackCenter        = 8,
    SideLeft          = 9,
    SideRight         = 10,
    TopCenter         = 11,
    TopFrontLeft      = 12,
    TopFrontCenter    = 13,
    TopFrontRight     = 14,
    TopBackLeft       = 15,
    TopBackCenter     = 16,
    TopBackRight      = 17,
    LowFrequency2     = 18,
    TopSideLeft       = 19,
    TopSideRight      = 20,
    BottomFrontCenter = 21,
    BottomFrontLeft   = 22,
    BottomFrontRight  = 23,
    Unused            = 0xfe,
    Unknown           = 0xff,
}

// AAC raw_data_block element IDs (ISO 14496-3, 3-bit field):
//   0  SCE  Single Channel Element    — 1 audio channel
//   1  CPE  Channel Pair Element      — 2 channels (stereo pair)
//   2  CCE  Coupling Channel Element  — auxiliary coupling (no primary audio)
//   3  LFE  Low Frequency Effects     — subwoofer channel
//   4  DSE  Data Stream Element       — metadata, no audio samples
//   5  PCE  Program Config Element    — channel layout declaration, no audio samples
//   6  FIL  Fill Element              — padding / backward-compatible SBR extension data
//   7  END  End of raw_data_block     — no instance tag follows; terminates the frame
// Elements 0–6 are followed by a 4-bit instance tag, so the full element header is 7 bits.
function describeAacSyntaxElement(elementId: number): string {
    switch (elementId) {
        case 0: return 'SCE';
        case 1: return 'CPE';
        case 2: return 'CCE';
        case 3: return 'LFE';
        case 4: return 'DSE';
        case 5: return 'PCE';
        case 6: return 'FIL';
        case 7: return 'END';
        default: return `unknown(${elementId})`;
    }
}

function aacProbeBitsConsumed(gb: ExpGolomb): number {
    const state = gb as any;
    return state._buffer_index * 8 - state._current_word_bits_left;
}

function aacProbeBitsRemaining(gb: ExpGolomb): number {
    const state = gb as any;
    return state._total_bits - aacProbeBitsConsumed(gb);
}

function readAacProbeBits(gb: ExpGolomb, bits: number): number | null {
    if (bits < 0 || bits > 32) {
        return null;
    }

    if (aacProbeBitsRemaining(gb) < bits) {
        return null;
    }

    return gb.readBits(bits);
}

function readAacProbeBool(gb: ExpGolomb): boolean | null {
    const value = readAacProbeBits(gb, 1);
    return value === null ? null : value === 1;
}

function describeAacProgramConfigElement(gb: ExpGolomb): string {
    const instanceTag = gb.readBits(4);
    const objectType = gb.readBits(2);
    const samplingIndex = gb.readBits(4);
    const numFront = gb.readBits(4);
    const numSide = gb.readBits(4);
    const numBack = gb.readBits(4);
    const numLfe = gb.readBits(2);
    const numAssoc = gb.readBits(3);
    const numCc = gb.readBits(4);

    return `PCE instanceTag=${instanceTag} objectType=${objectType} samplingIndex=${samplingIndex} front=${numFront} side=${numSide} back=${numBack} lfe=${numLfe} assoc=${numAssoc} cc=${numCc}`;
}

type AacPceChannelLayout = {
    front: boolean[];
    side: boolean[];
    back: boolean[];
    lfeCount: number;
};

function standardAacChannelConfigForPceLayout(layout: AacPceChannelLayout): number | null {
    // A PCE is allowed to describe arbitrary layouts.  These are the layouts
    // represented by the standard 1..7 channelConfiguration values; `true`
    // denotes a CPE (a stereo pair) and `false` an SCE (one channel).
    const standardLayouts: Array<[number, AacPceChannelLayout]> = [
        [1, { front: [false], side: [], back: [], lfeCount: 0 }],
        [2, { front: [true], side: [], back: [], lfeCount: 0 }],
        [3, { front: [false, true], side: [], back: [], lfeCount: 0 }],
        [4, { front: [false, true], side: [], back: [false], lfeCount: 0 }],
        [5, { front: [false, true], side: [], back: [true], lfeCount: 0 }],
        [6, { front: [false, true], side: [true], back: [], lfeCount: 1 }],
        [7, { front: [false, true, true], side: [true], back: [], lfeCount: 1 }]
    ];
    const sameElements = (a: boolean[], b: boolean[]) => a.length === b.length && a.every((element, index) => element === b[index]);

    for (const [channelConfig, standard] of standardLayouts) {
        if (
            sameElements(layout.front, standard.front) &&
            sameElements(layout.side, standard.side) &&
            sameElements(layout.back, standard.back) &&
            layout.lfeCount === standard.lfeCount
        ) {
            return channelConfig;
        }
    }
    return null;
}

function parseAacProgramConfigElementChannelCount(
    gb: ExpGolomb,
    expectedSamplingIndex: MPEG4SamplingRateIndex
): { channelCount: number; description: string; layout: AacPceChannelLayout } | null {
    // parse based on ISO/IEC 14496-3 program_config_element() field order
    const instanceTag = readAacProbeBits(gb, 4);    // element_instance_tag
    const objectType = readAacProbeBits(gb, 2);     // object_type
    const samplingIndex = readAacProbeBits(gb, 4);  // sampling_frequency_index
    const numFront = readAacProbeBits(gb, 4);       // num_front_channel_elements
    const numSide = readAacProbeBits(gb, 4);        // num_side_channel_elements
    const numBack = readAacProbeBits(gb, 4);        // num_back_channel_elements
    const numLfe = readAacProbeBits(gb, 2);         // num_lfe_channel_elements
    const numAssoc = readAacProbeBits(gb, 3);       // num_assoc_data_elements
    const numCc = readAacProbeBits(gb, 4);          // num_valid_cc_elements

    if (
        instanceTag === null ||
        objectType === null ||
        samplingIndex === null ||
        numFront === null ||
        numSide === null ||
        numBack === null ||
        numLfe === null ||
        numAssoc === null ||
        numCc === null
    ) {
        return null;
    }

    // If this does not match the enclosing AudioSpecificConfig sampling index,
    // we are most likely looking at trailing extradata rather than a real PCE.
    if (samplingIndex !== expectedSamplingIndex) {
        return null;
    }

    // Optional mixdown fields are layout hints, not additional decoded channels.
    const monoMixdownPresent = readAacProbeBool(gb);
    if (monoMixdownPresent === null) return null;
    if (monoMixdownPresent && !skipAacProbeBits(gb, 4)) return null;

    const stereoMixdownPresent = readAacProbeBool(gb);
    if (stereoMixdownPresent === null) return null;
    if (stereoMixdownPresent && !skipAacProbeBits(gb, 4)) return null;

    const matrixMixdownPresent = readAacProbeBool(gb);
    if (matrixMixdownPresent === null) return null;
    if (matrixMixdownPresent && !skipAacProbeBits(gb, 3)) return null;

    let channelCount = 0;
    const frontElements: string[] = [];
    const sideElements: string[] = [];
    const backElements: string[] = [];
    const lfeElements: string[] = [];

    const countTaggedChannels = (count: number, elements: string[]): boolean => {
        for (let i = 0; i < count; i++) {
            // Each front/side/back entry is tagged as either SCE (1 channel)
            // or CPE (2 channels), followed by a 4-bit element instance tag.
            const isCpe = readAacProbeBool(gb);
            const tag = readAacProbeBits(gb, 4);
            if (isCpe === null || tag === null) {
                return false;
            }
            elements.push(`${isCpe ? 'CPE' : 'SCE'}:${tag}`);
            channelCount += isCpe ? 2 : 1;
        }
        return true;
    };

    if (!countTaggedChannels(numFront, frontElements)) return null;
    if (!countTaggedChannels(numSide, sideElements)) return null;
    if (!countTaggedChannels(numBack, backElements)) return null;

    // LFE entries are always single low-frequency channels.
    for (let i = 0; i < numLfe; i++) {
        const tag = readAacProbeBits(gb, 4);
        if (tag === null) return null;
        lfeElements.push(`LFE:${tag}`);
        channelCount++;
    }
    // Associated data and coupling channel entries are present in the PCE, but
    // they are not playback output channels for this channelCount value.
    for (let i = 0; i < numAssoc; i++) {
        if (!skipAacProbeBits(gb, 4)) return null;
    }
    for (let i = 0; i < numCc; i++) {
        if (!skipAacProbeBits(gb, 5)) return null;
    }

    const paddingBits = (8 - (aacProbeBitsConsumed(gb) % 8)) % 8;
    if (paddingBits > 0) {
        if (!skipAacProbeBits(gb, paddingBits)) return null;
    }

    // PCE ends with a byte-aligned comment field.
    const commentFieldBytes = readAacProbeBits(gb, 8);
    if (commentFieldBytes === null) {
        return null;
    }
    const commentBytes: number[] = [];
    for (let i = 0; i < commentFieldBytes; i++) {
        const commentByte = readAacProbeBits(gb, 8);
        if (commentByte === null) return null;
        commentBytes.push(commentByte);
    }
    const commentAscii = commentBytes
        .map(b => (b >= 0x20 && b <= 0x7e) ? String.fromCharCode(b) : '.')
        .join('');

    return {
        channelCount,
        layout: {
            front: frontElements.map(element => element.startsWith('CPE:')),
            side: sideElements.map(element => element.startsWith('CPE:')),
            back: backElements.map(element => element.startsWith('CPE:')),
            lfeCount: lfeElements.length
        },
        description: `PCE instanceTag=${instanceTag} objectType=${objectType} samplingIndex=${samplingIndex} front=${numFront}[${frontElements.join(',')}] side=${numSide}[${sideElements.join(',')}] back=${numBack}[${backElements.join(',')}] lfe=${numLfe}[${lfeElements.join(',')}] assoc=${numAssoc} cc=${numCc} commentBytes=${commentFieldBytes} comment="${commentAscii}"`
    };
}

function parseAacConfigProgramConfigElement(
    data: Uint8Array,
    expectedSamplingIndex: MPEG4SamplingRateIndex
): { channelCount: number; description: string; layout: AacPceChannelLayout } | null {
    const gb = new ExpGolomb(data);
    const finish = <T>(result: T): T => {
        gb.destroy();
        return result;
    };

    if (!skipAacProbeBits(gb, 13)) return finish(null);

    const frameLengthFlag = readAacProbeBool(gb);
    if (frameLengthFlag === null) return finish(null);
    const dependsOnCoreCoder = readAacProbeBool(gb);
    if (dependsOnCoreCoder === null) return finish(null);
    if (dependsOnCoreCoder) {
        if (!skipAacProbeBits(gb, 14)) return finish(null);
    }
    const extensionFlag = readAacProbeBool(gb);
    if (extensionFlag === null) return finish(null);

    const pce = parseAacProgramConfigElementChannelCount(gb, expectedSamplingIndex);
    if (!pce) {
        return finish(null);
    }

    return finish({
        ...pce,
        description: `${pce.description} frameLengthFlag=${Number(frameLengthFlag)} dependsOnCoreCoder=${Number(dependsOnCoreCoder)} extensionFlag=${Number(extensionFlag)}`
    });
}

function skipAacProbeBits(gb: ExpGolomb, bits: number): boolean {
    let bitsRemaining = bits;

    while (bitsRemaining > 0) {
        const chunkSize = Math.min(bitsRemaining, 32);
        if (readAacProbeBits(gb, chunkSize) === null) {
            return false;
        }
        bitsRemaining -= chunkSize;
    }

    return true;
}

function describeFirstAacPayload(data: Uint8Array): string {
    if (!data || data.byteLength === 0) {
        return 'empty-payload';
    }

    const gb = new ExpGolomb(data);
    try {
        const elementId = gb.readBits(3);
        const elementName = describeAacSyntaxElement(elementId);

        if (elementId === 5) {
            return `firstElement=${describeAacProgramConfigElement(gb)}`;
        }

        if (elementId !== 6) {
            return `firstElement=${elementName}`;
        }

        let fillCount = gb.readBits(4);
        if (fillCount === 15) {
            fillCount += gb.readBits(8) - 1;
        }

        // Peek at the 4-bit extension_type at the start of the fill payload.
        // EXT_SBR_DATA=0x0D and EXT_SBR_DATA_CRC=0x0E signal backward-compatible SBR (HE-AAC).
        let sbrTag = '';
        let fillNote = '';
        if (fillCount > 0) {
            const extType = gb.readBits(4);
            // bits remaining after the 4-bit extType we just consumed
            const remainingFillBits = fillCount * 8 - 4;
            if (extType === 0x0D) {
                sbrTag = ' SBR=EXT_SBR_DATA';
                skipAacProbeBits(gb, remainingFillBits);
            } else if (extType === 0x0E) {
                sbrTag = ' SBR=EXT_SBR_DATA_CRC';
                skipAacProbeBits(gb, remainingFillBits);
            } else {
                // Read remaining fill bytes through the bitstream reader so the bit position
                // is correct.  Indexing `data` directly would be wrong because the FIL header
                // is 7 bits (3-bit eid + 4-bit count), leaving the fill payload unaligned to
                // any byte boundary in `data`.
                const fillByteBuf: number[] = [];
                let bitsLeft = remainingFillBits;
                while (bitsLeft >= 8) {
                    fillByteBuf.push(gb.readBits(8));
                    bitsLeft -= 8;
                }
                if (bitsLeft > 0) skipAacProbeBits(gb, bitsLeft);

                // Check if the fill bytes look like an ASCII encoder signature
                // (e.g. FFmpeg embeds "LavcXX.YY.ZZ" as trailing padding in the fill element)
                const ascii = fillByteBuf
                    .map(b => (b >= 0x20 && b <= 0x7e) ? String.fromCharCode(b) : '.')
                    .join('');
                if (/[A-Za-z]{3}/.test(ascii)) {
                    fillNote = ` fillAscii="${ascii.trim()}"(encoder-padding)`;
                }
            }
        }

        const nextElementId = gb.readBits(3);
        const nextElementName = describeAacSyntaxElement(nextElementId);
        const nextDesc = nextElementId === 1 ? `${nextElementName}(stereo-pair)` :
                         nextElementId === 0 ? `${nextElementName}(mono)` :
                         nextElementId === 3 ? `${nextElementName}(low-freq)` : nextElementName;
        if (nextElementId === 5) {
            return `firstElement=FIL fillBytes=${fillCount}${sbrTag}${fillNote} nextElement=${describeAacProgramConfigElement(gb)}`;
        }

        return `firstElement=FIL fillBytes=${fillCount}${sbrTag}${fillNote} nextElement=${nextDesc}`;
    } catch (error: any) {
        return `probeError=${error?.message || String(error)}`;
    } finally {
        gb.destroy();
    }
}

function describeAacRawDataBlockElements(data: Uint8Array): string {
    if (!data || data.byteLength === 0) {
        return 'elements=0 complete=true empty-payload';
    }

    const gb = new ExpGolomb(data);
    const elements: string[] = [];
    let knownChannels = 0;
    let complete = false;
    let stopReason = '';

    try {
        while (aacProbeBitsRemaining(gb) >= 3) {
            const elementId = readAacProbeBits(gb, 3);
            if (elementId === null) {
                stopReason = 'truncated-element-id';
                break;
            }

            const elementName = describeAacSyntaxElement(elementId);
            if (elementId === 7) {
                elements.push('END(7)');
                complete = true;
                break;
            }

            if (elementId === 6) {
                let fillCount = readAacProbeBits(gb, 4);
                if (fillCount === null) {
                    elements.push('FIL(6,truncated-count)');
                    stopReason = 'truncated-fill-count';
                    break;
                }
                if (fillCount === 15) {
                    const fillExt = readAacProbeBits(gb, 8);
                    if (fillExt === null) {
                        elements.push('FIL(6,truncated-escape)');
                        stopReason = 'truncated-fill-escape';
                        break;
                    }
                    fillCount += fillExt - 1;
                }

                let fillDetail = `fillBytes=${fillCount}`;
                if (fillCount > 0) {
                    const extType = readAacProbeBits(gb, 4);
                    if (extType === null) {
                        elements.push(`FIL(6,${fillDetail},truncated-extType)`);
                        stopReason = 'truncated-fill-extType';
                        break;
                    }
                    fillDetail += ` extType=0x${extType.toString(16)}`;
                    const remainingFillBits = fillCount * 8 - 4;
                    if (!skipAacProbeBits(gb, remainingFillBits)) {
                        elements.push(`FIL(6,${fillDetail},truncated-payload)`);
                        stopReason = 'truncated-fill-payload';
                        break;
                    }
                }

                elements.push(`FIL(6,${fillDetail})`);
                continue;
            }

            if (elementId === 0 || elementId === 1 || elementId === 3) {
                const tag = readAacProbeBits(gb, 4);
                if (tag === null) {
                    elements.push(`${elementName}(${elementId},truncated-tag)`);
                    stopReason = 'truncated-audio-element-tag';
                    break;
                }

                knownChannels += elementId === 1 ? 2 : 1;
                elements.push(`${elementName}(${elementId},tag=${tag})`);

                // SCE/CPE/LFE payloads are individual_channel_stream data with
                // entropy-coded spectral payloads. There is no element-local
                // byte length to skip without a fuller AAC raw_data_block parser.
                stopReason = `${elementName}-payload-not-skipped`;
                break;
            }

            if (elementId === 5) {
                elements.push(`PCE(5,${describeAacProgramConfigElement(gb)})`);
                stopReason = 'pce-payload-not-skipped';
                break;
            }

            elements.push(`${elementName}(${elementId})`);
            stopReason = `${elementName}-payload-not-skipped`;
            break;
        }

        if (!complete && !stopReason) {
            stopReason = 'no-end-element-before-eof';
        }

        return `elements=${elements.length} complete=${complete} knownChannels=${knownChannels} sequence=[${elements.join(' ')}] stopReason=${stopReason}`;
    } catch (error: any) {
        return `elements=${elements.length} complete=false knownChannels=${knownChannels} sequence=[${elements.join(' ')}] probeError=${error?.message || String(error)}`;
    } finally {
        gb.destroy();
    }
}

enum AudioFourCc {
    //
    // Valid FOURCC values for signaling support of audio codecs
    // in the enhanced FourCC pipeline.
    //

    // AC-3/E-AC-3 - <https://en.wikipedia.org/wiki/Dolby_Digital>  
    Ac3     = "ac-3",
    Eac3    = "ec-3",

    // Opus audio - <https://opus-codec.org/> 
    Opus    = "Opus",

    // Mp3 audio - <https://en.wikipedia.org/wiki/MP3>
    Mp3     = ".mp3",

    // Free Lossless Audio Codec - <https://xiph.org/flac/format.html> 
    Flac    = "fLaC",

    // Advanced Audio Coding - <https://en.wikipedia.org/wiki/Advanced_Audio_Coding> 
    // The following AAC profiles, denoted by their object types, are supported
    //  1 = main profile
    //  2 = low complexity, a.k.a., LC
    //  5 = high efficiency / spectral band replication, a.k.a., HE-AAC v1 / SBR
    // 29 = parametric stereo, a.k.a., HE-AAC v2 / PS (implies SBR + stereo downmix)
    Aac     = "mp4a",
}

enum VideoFourCc {
    //
    // Valid FOURCC values for signaling support of video codecs
    // in the enhanced FourCC pipeline.
    //

    Vp8     = "vp08",
    Vp9     = "vp09",
    Av1     = "av01",
    Avc     = "avc1",
    Hevc    = "hvc1",
    Vvc     = "vvc1",
}

enum VideoCodecId {
    //  0 - Reserved
    Jpeg            = 1,    // Rarely used, in practice almost never seen in the wild
    SorensonH263    = 2,    // Legacy Flash codec
    ScreenVideo     = 3,    // Screen sharing
    On2VP6          = 4,    // Common in mid-era Flash
    On2VP6WithAlpha = 5,    // VP6 + alpha channel
    ScreenVideoV2   = 6,    // Improved screen sharing
    AVC             = 7,    // H.264 / MPEG-4 Part 10 (most common now)
    //  8 - Reserved
    //  9 - Reserved
    // 10 - Reserved
    // 11 - Reserved
    Hevc            = 12,   // H.265 / MPEG-H Part 2 (not part of FLV spec, but we support because some devices use it)
    // 13 - Reserved
    // 14 - Reserved
    // 15 - Reserved
}

enum VideoFrameType {
    // 0 - Reserved
    KeyFrame                = 1,    // Seekable frame
    InterFrame              = 2,    // Non-seekable frame
    DisposableInterFrame    = 3,    // H.263 only
    GeneratedKeyFrame       = 4,    // Reserved for server use
    Command                 = 5     // Non-video data (e.g., start/end of seeking)
    // 6 - Reserved
    // 7 - Reserved
} 

enum VideoPacketType {
    SequenceStart           = 0,
    CodedFrames             = 1,
    SequenceEnd             = 2,
    CodedFramesX            = 3,
    Metadata                = 4,
    MPEG2TSSequenceStart    = 5,
    Multitrack              = 6,
    ModEx                   = 7,
    //  8 - Reserved
    //  9 - Reserved
    // 10 - Reserved
    // 11 - Reserved
    // 12 - Reserved
    // 13 - Reserved
    // 14 - Reserved
    // 15 - Reserved
}

enum AvMultitrackType {
    OneTrack             = 0,
    ManyTracks           = 1,
    ManyTracksManyCodecs = 2,
}

enum Vp8FrameType {
    KEY_FRAME   = 0,
    INTER_FRAME = 1
}

enum Vp9FrameType {
    KEY_FRAME           = 0,
    INTER_FRAME         = 1,
    INTRA_ONLY_FRAME    = 2,
    SWITCH_FRAME        = 3
}

export interface AudioFrame {
    unit: Uint8Array,    // The actual audio data
    length: number,      // Size of the frame in bytes
    dts: number,         // Decoding timestamp
    pts: number,         // Presentation timestamp
}

export interface AudioTrack {
    type: TrackType.Audio;
    id: number;
    sequenceNumber: number;
    frames: AudioFrame[];
    length: number;
}

enum AudioCodecType {
    Unknown = 0,
    Mp3 = 1,
    Aac = 2,
    Opus = 3,
    Flac = 4,
    Lpcm = 5,
}

export interface AudioMetadata {
    type: TrackType.Audio;
    codecType: AudioCodecType;
    codec: string;
    codecConfig?: Uint8Array;  // Audio specific config / codec private data
    aacChannelConfigWasInBand: boolean;

    trackId: number;
    timescale: number;
    preSkipSamples: number;
    duration: number;
    audioSampleRate: number;
    inputSampleRate: number;
    outputGain: number;
    channelCount: number;
    originalCodec: string;
    bitsPerSample: number;
    littleEndian: boolean;
    refFrameDuration: number;
}

const audioMetadataDefault: AudioMetadata = {
    type: TrackType.Audio,
    codecType: AudioCodecType.Unknown,
    codec: '',                          // unknown 
    originalCodec: '',                  // unknown
    aacChannelConfigWasInBand: false,

    trackId: NaN,
    timescale: NaN,
    preSkipSamples: 0,
    duration: NaN,
    audioSampleRate: NaN,
    inputSampleRate: NaN,
    outputGain: 0,
    channelCount: NaN,
    bitsPerSample: NaN,
    littleEndian: false,
    refFrameDuration: NaN,
}

export enum VideoCodecType {
    Unknown     = 0,
    Avc         = 1,
    Hevc        = 2,
    Vp8         = 3,
    Vp9         = 4,
    Av1         = 5,
}

export interface VideoMetadata {
    type: TrackType.Video;
    codecType: VideoCodecType;
    codec: string;
    av1Extra?: AV1Metadata;
    codecConfig?: Uint8Array;  // Holds avcc, hvcc, av1c, or vp9c data

    trackId: number;
    timescale: number;
    duration: number;
    codecWidth: number;
    codecHeight: number;
    presentWidth: number;
    presentHeight: number;
    profile: string;
    level: string;
    bitDepth: number;
    chromaFormat: number;
    colorRange: number;
    colourPrimaries: number;
    transferCharacteristics: number;
    matrixCoefficients: number;
    sarRatio: { width: number, height: number };
    frameRate: { fixed: boolean, fps: number, fps_num: number, fps_den: number };
    refFrameDuration: number;
}

const videoMetadataDefault: VideoMetadata = {
    type: TrackType.Video,
    codecType: VideoCodecType.Unknown,
    codec: '',                          // unknown

    trackId: NaN,
    timescale: NaN,
    duration: NaN,
    codecWidth: NaN,
    codecHeight: NaN,
    presentWidth: NaN,
    presentHeight: NaN,
    profile: '',
    level: '',
    bitDepth: NaN,
    chromaFormat: NaN,
    colorRange: NaN,
    colourPrimaries: NaN,
    transferCharacteristics: NaN,
    matrixCoefficients: NaN,
    sarRatio: { width: NaN, height: NaN },
    frameRate: { fixed: false, fps: NaN, fps_num: NaN, fps_den: NaN },
    refFrameDuration: NaN,
}

export interface VideoFrame {
    units: VideoUnit[],                 // The actual video data units (e.g., NAL units for H.264)
    length: number,                     // Size of the frame in bytes
    isKeyframe: boolean,                // Whether this is a keyframe (I-frame)
    fileposition: number,               // Position in the file
    dts: number,                        // Decoding timestamp (DTS)
    cts: number,                        // Composition timestamp (CTS)
    pts: number,                        // Presentation timestamp (PTS)
    rawData?: Uint8Array;
}

export interface VideoTrack {
    type: TrackType.Video;
    id: number;
    sequenceNumber: number;
    frames: VideoFrame[];
    length: number;
}

interface VideoUnit {
    type: Av1ObuType | H264NaluType | H265NaluType | Vp8FrameType | Vp9FrameType | number,
    data: Uint8Array,
}

interface AudioSample {
    unit: Uint8Array,
    length: number,
    dts: number,
    pts: number,
}

function swap16(src: number) {
    return (((src >>> 8) & 0xFF) |
            ((src & 0xFF) << 8));
}

function swap32(src: number) {
    return (((src & 0xFF000000) >>> 24) |
            ((src & 0x00FF0000) >>> 8)  |
            ((src & 0x0000FF00) << 8)   |
            ((src & 0x000000FF) << 24));
}

function readBig32(array: Uint8Array, index: number) {
    return ((array[index] << 24)     |
            (array[index + 1] << 16) |
            (array[index + 2] << 8)  |
            (array[index + 3]));
}

function readSignedInt24(v: DataView, offset: number) {
    return (v.getInt8(offset) << 16)
        | (v.getUint8(offset + 1) << 8)
        | v.getUint8(offset + 2);
}

export class FLVDemuxer {
    private static readonly TAG = 'FLVDemuxer';

    private _config: ConfigOptions;
    private _remuxer: Remuxer;

    private _onError = assertCallback;
    private _onMediaInfo = assertCallback;               // Called when complete media information (like codecs, duration, resolution) is available.
    private _onScriptMetadata = assertCallback;          // Called when FLV script data (metaData) is parsed and available.
    private _onScriptData = assertCallback;              // Called when any script data (not just metaData) is parsed.
    private _onTrackMetadata = assertCallback;           // Called when track metadata (like codecs, duration, resolution) is available.
    private _onTrackData = assertCallback;               // Called when parsed audio and video frames are ready to be consumed (e.g., by a remuxer or player).
    private _onVideoTracksDiscovered = noopCallback;     // Called when video track list changes (new trackId seen with full metadata).

    private _dataOffset: number;
    private _firstParse = true;

    private _hasAudio: boolean;
    private _hasVideo: boolean;

    private _hasAudioFlagOverrided = false; //!!@ cleanup usage of this
    private _hasVideoFlagOverrided = false; //!!@ cleanup usage of this

    private _mediaInfo: MediaInfo;

    private _scriptData: any;
    private _audioMetadata!: AudioMetadata;
    private _videoMetadataByTrackId: Map<number, VideoMetadata> = new Map();

    private _naluLengthSize = 4;
    private _timestampBase = 0;                     // int32, in milliseconds
    private _timescale = 1000;
    private _duration = 0;                          // int32, in milliseconds
    private _durationOverrided = false;
    // TODO: define reference frame rate types
    private _referenceFrameRate = {
        fixed: true,
        fps: 23.976,
        fps_num: 23976,
        fps_den: 1000
    };

    private static readonly _flvSoundRateTable = [5500, 11025, 22050, 44100, 48000] as const;

    private static readonly _mpegAudioV10SampleRateTable = [44100, 48000, 32000, 0] as const;
    private static readonly _mpegAudioV20SampleRateTable = [22050, 24000, 16000, 0] as const;
    private static readonly _mpegAudioV25SampleRateTable = [11025, 12000, 8000, 0] as const;

    private static readonly _mpegAudioL1BitRateTable = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, -1] as const;
    private static readonly _mpegAudioL2BitRateTable = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, -1] as const;
    private static readonly _mpegAudioL3BitRateTable = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, -1] as const;

    private _videoTracksById: Map<number, VideoTrack> = new Map();
    private _currentVideoTrackId: number | undefined = undefined;
    private _audioTrack: AudioTrack = { type: TrackType.Audio, id: 2, sequenceNumber: 0, frames: [], length: 0 };
    private _hasLoggedFirstAacPayloadProbe = false;
    private _hasLoggedAacPceDetection = false;
    private _hasLoggedAacSbrDetection = false;
    private _hasObservedAacPce = false;
    private _pendingAacMultichannelChannelCount: number | undefined = undefined;
    private _hasIgnoredAacMultichannelConfig = false;
    private _aacPayloadProbeFrameIndex = 0;

    constructor(probeData: FlvProbeSuccess, config: ConfigOptions, remuxer: Remuxer) {
        this._config = config;
        this._remuxer = remuxer;

        this._dataOffset = probeData.dataOffset;

        this._hasAudio = probeData.hasAudioTrack;
        this._hasVideo = probeData.hasVideoTrack;

        this._mediaInfo = new MediaInfo();
        this._mediaInfo.hasAudio = probeData.hasAudioTrack;
        this._mediaInfo.hasVideo = probeData.hasVideoTrack;
    }

    destroy() {
        this._onError = noopCallback;
        this._onMediaInfo = noopCallback;
        this._onScriptMetadata = noopCallback;
        this._onScriptData = noopCallback;
        this._onTrackMetadata = noopCallback;
        this._onTrackData = noopCallback;
        this._onVideoTracksDiscovered = noopCallback;
        this._hasLoggedFirstAacPayloadProbe = false;
        this._hasLoggedAacPceDetection = false;
        this._hasLoggedAacSbrDetection = false;
        this._hasObservedAacPce = false;
        this._pendingAacMultichannelChannelCount = undefined;
        this._hasIgnoredAacMultichannelConfig = false;
        this._aacPayloadProbeFrameIndex = 0;
    }

    private _probeAacPayload(data: Uint8Array): void {
        if (!data || data.byteLength === 0) {
            return;
        }

        this._aacPayloadProbeFrameIndex++;
        const payloadDescription = describeFirstAacPayload(data);
        const rawDataBlockDescription = describeAacRawDataBlockElements(data);
        const hex = Array.from(data.subarray(0, Math.min(8, data.byteLength)))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(' ');

        if (!this._hasLoggedFirstAacPayloadProbe) {
            Log.v(FLVDemuxer.TAG, `First AAC CodedFrame: size=${data.byteLength} bytes[0..7]=${hex} ${payloadDescription}`);
            this._hasLoggedFirstAacPayloadProbe = true;
        }
        if (this._aacPayloadProbeFrameIndex <= 5) {
            Log.v(FLVDemuxer.TAG, `AAC CodedFrame[${this._aacPayloadProbeFrameIndex}] rawDataBlock ${rawDataBlockDescription}`);
        }

        const hasPce = payloadDescription.includes('PCE');
        const hasStereoCpe = payloadDescription.includes('CPE(stereo-pair)');
        if (hasPce) {
            this._hasObservedAacPce = true;
        }

        if (!this._hasLoggedAacPceDetection && hasPce) {
            Log.v(FLVDemuxer.TAG, `AAC CodedFrame[${this._aacPayloadProbeFrameIndex}] contains visible ${payloadDescription}`);
            this._hasLoggedAacPceDetection = true;
        }

        if (!this._hasLoggedAacSbrDetection && payloadDescription.includes('SBR=')) {
            Log.v(FLVDemuxer.TAG, `AAC CodedFrame[${this._aacPayloadProbeFrameIndex}] backward-compatible SBR detected: ${payloadDescription}`);
            this._hasLoggedAacSbrDetection = true;
        }

        if (hasPce) {
            this._applyPendingAacMultichannelConfig();
        } else if (hasStereoCpe) {
            this._ignorePendingAacMultichannelConfig(payloadDescription);
        }
    }

    static probe(buffer: ArrayBuffer): ProbeResult | FlvProbeSuccess {
        let data = new Uint8Array(buffer);
        if (data.byteLength < 9) {
            return {needMoreData: true};
        }

        let mismatch: ProbeResult = {match: false};

        if (data[0] !== 0x46 || data[1] !== 0x4C || data[2] !== 0x56 || data[3] !== 0x01) {
            return mismatch;
        }

        let hasAudio = ((data[4] & 4) >>> 2) !== 0;
        let hasVideo = (data[4] & 1) !== 0;

        let offset = readBig32(data, 5);

        if (offset < 9) {
            return mismatch;
        }

        return {
            match: true,
            consumed: offset,
            dataOffset: offset,
            hasAudioTrack: hasAudio,
            hasVideoTrack: hasVideo
        } as FlvProbeSuccess;
    }

    bindDataSource(loader: IOController) {
        loader.onDataArrival = this.parseChunks.bind(this);
        return this;
    }

    get onTrackMetadata() {
        return this._onTrackMetadata;
    }

    set onTrackMetadata(callback: (metadata: AudioMetadata | VideoMetadata) => void) {
        this._onTrackMetadata = callback;
    }

    get onMediaInfo() {
        return this._onMediaInfo;
    }

    set onMediaInfo(callback: (mediaInfo: MediaInfo) => void) {
        this._onMediaInfo = callback;
    }

    get onScriptMetadata() {
        return this._onScriptMetadata;
    }

    set onScriptMetadata(callback: (metadata: any) => void) {
        this._onScriptMetadata = callback;
    }

    get onScriptData() {
        return this._onScriptData;
    }

    set onScriptData(callback: (scriptData: any) => void) {
        this._onScriptData = callback;
    }

    get onError() {
        return this._onError;
    }

    set onError(callback: (type: string, info: string) => void) {
        this._onError = callback;
    }

    get onTrackData() {
        return this._onTrackData;
    }

    set onTrackData(callback: (audioTrack: AudioTrack, videoTrack: VideoTrack) => void) {
        this._onTrackData = callback;
    }

    get onVideoTracksDiscovered() {
        return this._onVideoTracksDiscovered;
    }

    set onVideoTracksDiscovered(callback: (tracks: VideoMetadata[]) => void) {
        this._onVideoTracksDiscovered = callback;
    }

    // timestamp base for output frames, must be in milliseconds
    get timestampBase() {
        return this._timestampBase;
    }

    set timestampBase(base) {
        this._timestampBase = base;
    }

    get overridedDuration() {
        return this._duration;
    }

    // Force-override media duration. Must be in milliseconds, int32
    set overridedDuration(duration) {
        this._durationOverrided = true;
        this._duration = duration;
        this._mediaInfo.duration = duration;
    }

    // Force-override audio track present flag, boolean
    set overridedHasAudio(hasAudio: boolean) {
        this._hasAudioFlagOverrided = true;
        this._hasAudio = hasAudio;
        this._mediaInfo.hasAudio = hasAudio;
    }

    // Force-override video track present flag, boolean
    set overridedHasVideo(hasVideo: boolean) {
        this._hasVideoFlagOverrided = true;
        this._hasVideo = hasVideo;
        this._mediaInfo.hasVideo = hasVideo;
    }

    resetMediaInfo() {
        this._mediaInfo = new MediaInfo();
    }

    private _getOrCreateVideoTrack(trackId: number): VideoTrack {
        if (!this._videoTracksById.has(trackId)) {
            this._videoTracksById.set(trackId, { type: TrackType.Video, id: trackId, sequenceNumber: 0, frames: [], length: 0 });
        }
        return this._videoTracksById.get(trackId)!;
    }

    private _getDefaultVideoTrack(): VideoTrack {
        // Per spec, trackId 0 is the default primary track.
        // For non-spec-compliant encoders that omit trackId 0, fall back to the
        // lowest trackId present — closest proxy to spec intent.
        if (this._videoTracksById.has(0)) {
            return this._videoTracksById.get(0)!;
        }
        if (this._videoTracksById.size > 0) {
            const lowestId = Math.min(...this._videoTracksById.keys());
            return this._videoTracksById.get(lowestId)!;
        }
        return this._getOrCreateVideoTrack(0);
    }

    private _getCurrentVideoTrack(): VideoTrack {
        if (this._currentVideoTrackId !== undefined) {
            return this._getOrCreateVideoTrack(this._currentVideoTrackId);
        }
        return { type: TrackType.Video, id: -1, sequenceNumber: 0, frames: [], length: 0 };
    }

    private _flushPendingTrackDataBeforeMetadataRefresh(): void {
        const currentVideoTrack = this._getCurrentVideoTrack();

        if (this._audioTrack.frames.length === 0 && currentVideoTrack.frames.length === 0) {
            return;
        }

        this._onTrackData(this._audioTrack, currentVideoTrack);
    }

    private _dispatchVideoTrackMetadata(meta: VideoMetadata): void {
        if (this._currentVideoTrackId === undefined) {
            this._currentVideoTrackId = meta.trackId;
        }
        if (meta.trackId === this._currentVideoTrackId) {
            if (this._remuxer.isVideoMetadataDispatched) {
                // Non-initial metadata, force dispatch (or flush) parsed frames to remuxer
                this._flushPendingTrackDataBeforeMetadataRefresh();
            }
            // notify new metadata
            this._onTrackMetadata(meta);
        }
        this._onVideoTracksDiscovered([...this._videoMetadataByTrackId.values()]);
    }

    // function parseChunks(chunk: ArrayBuffer, byteStart: number): number;
    parseChunks(chunk: ArrayBuffer, byteStart: number) : number {
        let offset = 0;

        if (byteStart === 0) {  // buffer with FLV header
            if (chunk.byteLength > 13) {
                let probeData = FLVDemuxer.probe(chunk);
                if ('match' in probeData && probeData.match === true) {
                    offset = probeData.dataOffset;
                    this._hasAudio = probeData.hasAudioTrack && this._hasAudio;
                    this._hasVideo = probeData.hasVideoTrack && this._hasVideo;
                } else {
                    return 0;
                }            
            } else {
                return 0;
            }
        }

        if (this._firstParse) {  // handle PreviousTagSize0 before Tag1
            this._firstParse = false;
            if (byteStart + offset !== this._dataOffset) {
                Log.w(FLVDemuxer.TAG, 'First time parsing but chunk byteStart invalid!');
            }

            let v = new DataView(chunk, offset);
            let prevTagSize0 = v.getUint32(0, false);
            if (prevTagSize0 !== 0) {
                Log.w(FLVDemuxer.TAG, 'PrevTagSize0 !== 0 !!!');
            }
            offset += 4;
        }

        while (offset < chunk.byteLength) {
            let v = new DataView(chunk, offset);

            if (offset + 11 + 4 > chunk.byteLength) {
                // data not enough for parsing an flv tag
                break;
            }

            let tagType = v.getUint8(0);
            let dataSize = v.getUint32(0, false) & 0x00FFFFFF;

            if (offset + 11 + dataSize + 4 > chunk.byteLength) {
                // data not enough for parsing actual data body
                break;
            }

            if (tagType !== 8 && tagType !== 9 && tagType !== 18) {
                Log.w(FLVDemuxer.TAG, `Unsupported tag type ${tagType}, skipped`);
                // consume the whole tag (skip it)
                offset += 11 + dataSize + 4;
                continue;
            }

            let ts2 = v.getUint8(4);
            let ts1 = v.getUint8(5);
            let ts0 = v.getUint8(6);
            let ts3 = v.getUint8(7);

            let timestamp = ts0 | (ts1 << 8) | (ts2 << 16) | (ts3 << 24);

            let streamId = v.getUint32(7, false) & 0x00FFFFFF;
            if (streamId !== 0) {
                Log.w(FLVDemuxer.TAG, 'Meet tag which has StreamID != 0!');
            }

            let dataOffset = offset + 11;

            switch (tagType) {
                case 8:  // Audio
                    if (this._hasAudio) {
                        this._parseAudioTagData(chunk, dataOffset, dataSize, timestamp);
                    }
                    break;
                case 9:  // Video
                    if (this._hasVideo) {
                        this._parseVideoTagData(chunk, dataOffset, dataSize, timestamp, byteStart + offset);
                    }
                    break;
                case 18:  // ScriptDataObject
                    this._parseScriptTagData(chunk, dataOffset, dataSize);
                    break;
            }

            let prevTagSize = v.getUint32(11 + dataSize, false);
            if (prevTagSize !== 11 + dataSize) {
                Log.w(FLVDemuxer.TAG, `Invalid PrevTagSize ${prevTagSize}`);
            }

            offset += 11 + dataSize + 4;  // tagBody + dataSize + prevTagSize
        }

        // dispatch parsed frames to consumer (typically, the remuxer)
        this._onTrackData(this._audioTrack, this._getCurrentVideoTrack());

        return offset;  // consumed bytes, just equals latest offset index
    }

    private _parseScriptTagData(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number) {
        let scriptData: AMFScriptData = AMF.parseScriptData(arrayBuffer, dataOffset, dataSize);

        if (scriptData.hasOwnProperty('onMetaData')) {
            if (scriptData.onMetaData == null || typeof scriptData.onMetaData !== 'object' || Array.isArray(scriptData.onMetaData)) {
                Log.w(FLVDemuxer.TAG, 'Invalid onMetaData structure!');
                return;
            }
            if (this._scriptData) {
                Log.w(FLVDemuxer.TAG, 'Found another onMetaData tag!');
            }
            this._scriptData = scriptData;
            let onMetaData = this._scriptData.onMetaData as AMFObjectValue;

            if (this._onScriptMetadata) {
                this._onScriptMetadata(Object.assign({}, onMetaData));
            }

            if (typeof onMetaData.hasAudio === 'boolean') {  // hasAudio
                if (this._hasAudioFlagOverrided === false) {
                    this._hasAudio = onMetaData.hasAudio;
                    this._mediaInfo.hasAudio = this._hasAudio;
                }
            }
            if (typeof onMetaData.hasVideo === 'boolean') {  // hasVideo
                if (this._hasVideoFlagOverrided === false) {
                    this._hasVideo = onMetaData.hasVideo;
                    this._mediaInfo.hasVideo = this._hasVideo;
                }
            }
            if (typeof onMetaData.audiodatarate === 'number') {  // audiodatarate
                this._mediaInfo.audioDataRate = onMetaData.audiodatarate;
            }
            if (typeof onMetaData.videodatarate === 'number') {  // videodatarate
                this._mediaInfo.videoDataRate = onMetaData.videodatarate;
            }
            if (typeof onMetaData.width === 'number') {  // width
                this._mediaInfo.width = onMetaData.width;
            }
            if (typeof onMetaData.height === 'number') {  // height
                this._mediaInfo.height = onMetaData.height;
            }
            if (typeof onMetaData.duration === 'number') {  // duration
                if (!this._durationOverrided) {
                    let duration = Math.floor(onMetaData.duration * this._timescale);
                    this._duration = duration;
                    this._mediaInfo.duration = duration;
                }
            } else {
                this._mediaInfo.duration = 0;
            }
            if (typeof onMetaData.framerate === 'number') {  // framerate
                let fps_num = Math.floor(onMetaData.framerate * 1000);
                if (fps_num > 0) {
                    let fps = fps_num / 1000;
                    this._referenceFrameRate.fixed = true;
                    this._referenceFrameRate.fps = fps;
                    this._referenceFrameRate.fps_num = fps_num;
                    this._referenceFrameRate.fps_den = 1000;
                    this._mediaInfo.fps = fps;
                }
            }
            if (typeof onMetaData.keyframes === 'object') {  // keyframes
                this._mediaInfo.hasKeyframesIndex = true;
                let keyframes = onMetaData.keyframes as unknown as KeyframesIndex;
                this._mediaInfo.keyframesIndex = this._parseKeyframesIndex(keyframes);
                onMetaData.keyframes = null;  // keyframes has been extracted, remove it
            } else {
                this._mediaInfo.hasKeyframesIndex = false;
            }

            this._mediaInfo.metadata = onMetaData;
            Log.v(FLVDemuxer.TAG, 'Parsed flv.onMetaData');
            if (this._mediaInfo.isComplete()) {
                this._onMediaInfo(this._mediaInfo);
            }
        }

        if (Object.keys(scriptData).length > 0) {
            if (this._onScriptData) {
                this._onScriptData(Object.assign({}, scriptData));
            }
        }
    }

    private _parseKeyframesIndex(keyframes: KeyframesIndex): KeyframesIndex {
        let times = [];
        let filepositions = [];

        // ignore first keyframe which is actually AVC/HEVC Sequence Header (AVCDecoderConfigurationRecord or HEVCDecoderConfigurationRecord)
        for (let i = 1; i < keyframes.times.length; i++) {
            let time = this._timestampBase + Math.floor(keyframes.times[i] * 1000);
            times.push(time);
            filepositions.push(keyframes.filepositions[i]);
        }

        return {
            times: times,
            filepositions: filepositions
        };
    }

    private _parseAudioTagData(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number, tagTimestamp: number) {
        if (dataSize <= 1) {
            Log.w(FLVDemuxer.TAG, 'Flv: Invalid audio packet, missing SoundData payload!');
            return;
        }

        if (this._hasAudioFlagOverrided === true && this._hasAudio === false) {
            // If hasAudio: false indicated explicitly in MediaDataSource,
            // Ignore all the audio packets
            return;
        }

        let v = new DataView(arrayBuffer, dataOffset, dataSize);

        let soundSpec = v.getUint8(0);

        let soundFormat = (soundSpec >>> 4) as SoundFormat;
        if (soundFormat === SoundFormat.ExHeader) { // Enhanced FLV
            if (dataSize <= 5) {
                Log.w(FLVDemuxer.TAG, 'Flv: Invalid audio packet, missing AudioFourCC in Ehnanced FLV payload!');
                return;
            }
            let packetType: AudioPacketType = soundSpec & 0x0F;
            let fourcc = String.fromCharCode(... (new Uint8Array(arrayBuffer, dataOffset, dataSize)).slice(1, 5));

            // !!@TODO: where is support for mp3?
            switch(fourcc){
            case AudioFourCc.Opus:
                this._parseEnhancedOpusAudioPacket(arrayBuffer, dataOffset + 5, dataSize - 5, tagTimestamp, packetType);
                break;
            case AudioFourCc.Flac:
                this._parseEnhancedFlacAudioPacket(arrayBuffer, dataOffset + 5, dataSize - 5, tagTimestamp, packetType);
                break;
            case AudioFourCc.Aac:
                this._parseEnhancedAacAudioPacket(arrayBuffer, dataOffset + 5, dataSize - 5, tagTimestamp, packetType);
                break;
            default:
                this._onError(DemuxErrors.CODEC_UNSUPPORTED, `${FLVDemuxer.TAG}._parseAudioTagData() - Unsupported FOURCC ${fourcc}`);
            }

            return;
        }

        if (soundFormat !== SoundFormat.Mp3 && soundFormat !== SoundFormat.LPcmLittleEndian && soundFormat !== SoundFormat.Aac) {
            this._onError(DemuxErrors.CODEC_UNSUPPORTED, 'Flv: Unsupported audio codec idx: ' + soundFormat);
            return;
        }

        let soundRate = 0;
        let soundRateIndex = (soundSpec & 12) >>> 2;
        if (soundRateIndex >= 0 && soundRateIndex <= 4) {
            soundRate = FLVDemuxer._flvSoundRateTable[soundRateIndex];
        } else {
            this._onError(DemuxErrors.FORMAT_ERROR, 'Flv: Invalid audio sample rate idx: ' + soundRateIndex);
            return;
        }

        let soundSize = (soundSpec & 2) >>> 1;  // unused
        let soundType = (soundSpec & 1);

        let meta = this._audioMetadata;
        let track = this._audioTrack;

        if (!meta) {
            if (this._hasAudio === false && this._hasAudioFlagOverrided === false) {
                this._hasAudio = true;
                this._mediaInfo.hasAudio = true;
            }

            // initial metadata
            meta = this._audioMetadata = {
                ...audioMetadataDefault,
                type: TrackType.Audio,
                trackId: track.id,
                timescale: this._timescale,
                duration: this._duration,
                audioSampleRate: soundRate,
                channelCount: (soundType === 0 ? 1 : 2),
            };
        }

        if (soundFormat === SoundFormat.Aac) {
            meta.codecType = AudioCodecType.Aac;
            let aacData = this._parseLegacyAacAudioPacket(arrayBuffer, dataOffset + 1, dataSize - 1);
            if (aacData == undefined) {
                return;
            }

            if (aacData.packetType === AudioPacketType.SequenceStart) {  // AAC sequence header (AudioSpecificConfig)
                const misc = aacData.data;
                if (meta.codecConfig) {
                    if (buffersAreEqual(misc.config, meta.codecConfig)) {
                        // If AudioSpecificConfig is not changed, ignore it to avoid generating initialization segment repeatedly
                        return;
                    } else {
                        Log.w(FLVDemuxer.TAG, 'AudioSpecificConfig has been changed, re-generate initialization segment');
                    }
                }
                meta.audioSampleRate = misc.samplingRate;
                meta.channelCount = misc.channelCount;
                meta.codec = misc.codec;
                meta.originalCodec = misc.originalCodec;
                meta.codecConfig = misc.config;
                meta.aacChannelConfigWasInBand = misc.channelConfigWasInBand;
                this._hasLoggedFirstAacPayloadProbe = false;
                this._hasLoggedAacPceDetection = false;
                this._hasLoggedAacSbrDetection = false;
                this._hasObservedAacPce = misc.channelConfigHasPce;
                this._pendingAacMultichannelChannelCount = undefined;
                this._hasIgnoredAacMultichannelConfig = false;
                this._aacPayloadProbeFrameIndex = 0;
                // The decode result of an aac sample is 1024 PCM samples
                meta.refFrameDuration = 1024 / meta.audioSampleRate * meta.timescale;
                Log.v(FLVDemuxer.TAG, 'Parsed AudioSpecificConfig');

                if (this._remuxer.isAudioMetadataDispatched) {
                    // Non-initial metadata, force dispatch (or flush) parsed frames to remuxer
                    Log.v(FLVDemuxer.TAG, 'Dispatching regular AAC track data before metadata refresh');
                    this._flushPendingTrackDataBeforeMetadataRefresh();
                } 
                // notify new metadata
                Log.v(FLVDemuxer.TAG, `Dispatching regular AAC track metadata codec=${meta.codec} channels=${meta.channelCount} sampleRate=${meta.audioSampleRate}`);
                this._onTrackMetadata(meta);

                let mi = this._mediaInfo;
                mi.audioCodec = meta.originalCodec;
                mi.audioSampleRate = meta.audioSampleRate;
                mi.audioChannelCount = meta.channelCount;
                if (mi.hasVideo) {
                    if (mi.videoCodec != null) {
                        mi.mimeType = 'video/x-flv; codecs="' + mi.videoCodec + ',' + mi.audioCodec + '"';
                    }
                } else {
                    mi.mimeType = 'video/x-flv; codecs="' + mi.audioCodec + '"';
                }
                if (mi.isComplete()) {
                    Log.v(FLVDemuxer.TAG, `Dispatching regular AAC media info codec=${mi.audioCodec} channels=${mi.audioChannelCount} mimeType=${mi.mimeType}`);
                    this._onMediaInfo(mi);
                }
            } else if (aacData.packetType === AudioPacketType.CodedFrames) {  // AAC raw frame data
                const frameData = aacData.data;
                this._probeAacPayload(frameData);
                let dts = this._timestampBase + tagTimestamp;
                let aacSample = {unit: frameData, length: frameData.byteLength, dts: dts, pts: dts};
                track.frames.push(aacSample);
                track.length += frameData.length;
            } else {
                Log.e(FLVDemuxer.TAG, `Flv: Unsupported AAC data type ${aacData.packetType}`);
            }
        } else if (soundFormat === SoundFormat.Mp3) {
            meta.codecType = AudioCodecType.Mp3;
            if (!meta.codec) {
                // We need metadata for mp3 audio track, extract info from frame header
                let misc = this._parseLegacyMp3FrameData(arrayBuffer, dataOffset + 1, dataSize - 1, true);
                if (misc == undefined) {
                    return;
                }
                meta.audioSampleRate = misc.samplingRate;
                meta.channelCount = misc.channelCount;
                meta.codec = misc.codec;
                meta.originalCodec = misc.originalCodec;
                // The decode result of an mp3 sample is 1152 PCM samples
                meta.refFrameDuration = 1152 / meta.audioSampleRate * meta.timescale;
                Log.v(FLVDemuxer.TAG, 'Parsed MPEG Audio Frame Header');

                this._onTrackMetadata(meta);

                let mi = this._mediaInfo;
                mi.audioCodec = meta.codec;
                mi.audioSampleRate = meta.audioSampleRate;
                mi.audioChannelCount = meta.channelCount;
                mi.audioDataRate = misc.bitRate;
                if (mi.hasVideo) {
                    if (mi.videoCodec != null) {
                        mi.mimeType = 'video/x-flv; codecs="' + mi.videoCodec + ',' + mi.audioCodec + '"';
                    }
                } else {
                    mi.mimeType = 'video/x-flv; codecs="' + mi.audioCodec + '"';
                }
                if (mi.isComplete()) {
                    this._onMediaInfo(mi);
                }
            }

            // This packet is always a valid audio packet, extract it
            let data = this._parseLegacyMp3FrameData(arrayBuffer, dataOffset + 1, dataSize - 1, false);
            if (data == undefined) {
                return;
            }
            let dts = this._timestampBase + tagTimestamp;
            let mp3Sample = {unit: data, length: data.byteLength, dts: dts, pts: dts};
            track.frames.push(mp3Sample);
            track.length += data.length;
        } else if (soundFormat === SoundFormat.LPcmLittleEndian) {
            meta.codecType = AudioCodecType.Lpcm;
            if (!meta.codec) {
                meta.audioSampleRate = soundRate;
                meta.bitsPerSample = (soundSize + 1) * 8;
                meta.littleEndian = true;
                meta.codec = 'ipcm';
                meta.originalCodec = 'ipcm';

                this._onTrackMetadata(meta);

                let mi = this._mediaInfo;
                mi.audioCodec = meta.codec;
                mi.audioSampleRate = meta.audioSampleRate;
                mi.audioChannelCount = meta.channelCount;
                mi.audioDataRate = meta.bitsPerSample * meta.audioSampleRate;
                if (mi.hasVideo) {
                    if (mi.videoCodec != null) {
                        mi.mimeType = 'video/x-flv; codecs="' + mi.videoCodec + ',' + mi.audioCodec + '"';
                    }
                } else {
                    mi.mimeType = 'video/x-flv; codecs="' + mi.audioCodec + '"';
                }
                if (mi.isComplete()) {
                    this._onMediaInfo(mi);
                }
            }

            let data = new Uint8Array(arrayBuffer, dataOffset + 1, dataSize - 1);
            let dts = this._timestampBase + tagTimestamp;
            let pcmSample = {unit: data, length: data.byteLength, dts: dts, pts: dts};
            track.frames.push(pcmSample);
            track.length += data.length;
        }
    }

    private _parseLegacyAacAudioPacket(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number): AACPacketData | undefined {
        if (dataSize <= 1) {
            Log.w(FLVDemuxer.TAG, 'Flv: Invalid AAC packet, missing AACPacketType or/and Data!');
            return undefined;
        }

        const array = new Uint8Array(arrayBuffer, dataOffset, dataSize);
        const packetType = array[0] as AudioPacketType;

        if (packetType === AudioPacketType.SequenceStart) {
            const config = this._parseAacAudioSpecificConfig(arrayBuffer, dataOffset + 1, dataSize - 1);
            if (config === undefined) return undefined;  // propagate failure up
            return { packetType: AudioPacketType.SequenceStart, data: config };
        } else {
            return { packetType, data: array.subarray(1) };
        }
    }

    private _parseAacAudioSpecificConfig(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number): AACConfig | undefined {
        const asc = new Uint8Array(arrayBuffer, dataOffset, dataSize);
        const audioObjectType = asc[0] >>> 3 as MPEG4AudioObjectTypes;
        const samplingRateIndex = ((asc[0] & 0x07) << 1) | (asc[1] >>> 7) as MPEG4SamplingRateIndex;

        if (samplingRateIndex >= MPEG4SamplingRates.length) {
            this._onError(DemuxErrors.FORMAT_ERROR, 'Flv: AAC invalid sampling frequency index!');
            return undefined;
        }

        const samplingRate = MPEG4SamplingRates[samplingRateIndex];

        // ISO 14496-3 Table 1.19 — channel_configuration (4-bit field in AudioSpecificConfig byte 1 bits 6:3):
        //   0  in-band   channel layout declared by PCE in bitstream or E-RTMP MultichannelConfig
        //   1  1ch       C                           (mono)
        //   2  2ch       L + R                       (stereo)
        //   3  3ch       C + L + R                   (3.0)
        //   4  4ch       C + L + R + Cs              (4.0, quad)
        //   5  5ch       C + L + R + Ls + Rs         (5.0 surround)
        //   6  6ch       C + L + R + Ls + Rs + LFE   (5.1 surround)
        //   7  8ch       C + Lc + Rc + L + R + Ls + Rs + LFE  (7.1 surround)
        // index maps directly to channel count, except 0 (in-band) and 7 (8ch, not 7ch)
        const aacChannelCountTable = [0, 1, 2, 3, 4, 5, 6, 8] as const;
        const channelConfig = (asc[1] & 0x78) >>> 3;
        if (channelConfig < 0 || channelConfig >= aacChannelCountTable.length) {
            this._onError(DemuxErrors.FORMAT_ERROR, 'Flv: AAC invalid channel configuration');
            return undefined;
        }

        if (channelConfig === 0) {
            const pce = parseAacConfigProgramConfigElement(asc, samplingRateIndex);
            if (pce && pce.channelCount > 0) {
                Log.v(FLVDemuxer.TAG, `PCE_CONFIRMED: AAC sequence header contains Program Config Element; ${pce.description}; channelCount=${pce.channelCount}; ascBytes=${asc.length}; asc=${formatHexBytes(asc)}`);
                const standardChannelConfig = standardAacChannelConfigForPceLayout(pce.layout);
                if (standardChannelConfig === null) {
                    this._onError(
                        DemuxErrors.FORMAT_UNSUPPORTED,
                        `Flv: AAC PCE describes a custom ${pce.channelCount}-channel layout that cannot be represented by a standard channelConfiguration; MSE playback requires transcoding`
                    );
                    return undefined;
                }

                // Chrome MSE does not accept a PCE-bearing ASC in esds.  When the PCE
                // exactly matches a standard layout, replace it with the equivalent
                // two-byte AudioSpecificConfig without changing the AAC frame semantics.
                const cleanConfig = new Uint8Array([
                    (audioObjectType << 3) | ((samplingRateIndex & 0x0E) >>> 1),
                    ((samplingRateIndex & 0x01) << 7) | (standardChannelConfig << 3)  // GASpecificConfig flags=0
                ]);
                Log.v(FLVDemuxer.TAG, `AAC_PCE_NORMALIZED: replaced standard-equivalent PCE with channelConfig=${standardChannelConfig}; asc=${formatHexBytes(cleanConfig)}`);
                return {
                    config: cleanConfig,
                    samplingRate: samplingRate,
                    channelCount: pce.channelCount,
                    codec: 'mp4a.40.' + audioObjectType,
                    originalCodec: 'mp4a.40.' + audioObjectType,
                    channelConfigWasInBand: true,
                    channelConfigHasPce: true
                };
            }

            // channelConfig=0 means the channel layout is signalled either by a PCE inside
            // the bitstream or via an E-RTMP MultichannelConfig packet.  The raw buffer may
            // contain garbage beyond the first two meaningful bytes (e.g. FFmpeg embeds its
            // version string "Lavc62" as trailing extradata), which Chrome's MSE parser
            // rejects inside the esds DecoderSpecificInfo box.  Synthesise a clean 2-byte
            // AudioSpecificConfig preserving audioObjectType and samplingIndex.
            //
            // Default channelCount=2 (stereo): we cannot determine the final layout from the
            // AudioSpecificConfig alone at this point.  Stereo is the safest initial default,
            // and Chrome requires the esds DecoderSpecificInfo to say stereo unless a PCE is present.
            Log.w(FLVDemuxer.TAG, 'Flv: AAC channel config 0 (in-band) detected, synthesising clean stereo AudioSpecificConfig');
            const cleanConfig = new Uint8Array([
                (audioObjectType << 3) | ((samplingRateIndex & 0x0E) >>> 1),
                ((samplingRateIndex & 0x01) << 7) | (2 << 3)  // channelConfig=2 (stereo), GASpecificConfig flags=0
            ]);
            return {
                config: cleanConfig,
                samplingRate: samplingRate,
                channelCount: 2,  // initial default; may be updated by a subsequent MultichannelConfig packet
                codec: 'mp4a.40.' + audioObjectType,
                originalCodec: 'mp4a.40.' + audioObjectType,
                channelConfigWasInBand: true,
                channelConfigHasPce: false
            };
        }

        const aacConfig = new AudioSpecificConfig(new AACFrame(new Uint8Array(arrayBuffer, dataOffset, dataSize)));
        return {
            config: Uint8Array.from(aacConfig.config),
            samplingRate: aacConfig.sampling_rate,
            channelCount: aacConfig.channel_count,
            codec: aacConfig.codec_mimetype,
            originalCodec: aacConfig.original_codec_mimetype,
            channelConfigWasInBand: false,
            channelConfigHasPce: false
        };
    }

    private _parseLegacyMp3FrameData(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number, requestHeader: true): Mp3FrameHeader | undefined;
    private _parseLegacyMp3FrameData(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number, requestHeader: false): Uint8Array | undefined;
    private _parseLegacyMp3FrameData(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number, requestHeader: boolean): Mp3FrameHeader | Uint8Array | undefined {
        if (dataSize < 4) {
            Log.w(FLVDemuxer.TAG, 'Flv: Invalid MP3 packet, header missing!');
            return;
        }

        let array = new Uint8Array(arrayBuffer, dataOffset, dataSize);
        let result: Mp3FrameHeader | Uint8Array;

        if (requestHeader) {
            if (array[0] !== 0xFF) {
                return;
            }
            let ver = (array[1] >>> 3) & 0x03;
            let layer = (array[1] & 0x06) >> 1;

            let bitrate_index = (array[2] & 0xF0) >>> 4;
            let sampling_freq_index = (array[2] & 0x0C) >>> 2;

            let channel_mode = (array[3] >>> 6) & 0x03;
            let channel_count = channel_mode !== 3 ? 2 : 1;

            let sample_rate = 0;
            let bit_rate = 0;
            let object_type = 34;  // Layer-3, listed in MPEG-4 Audio Object Types

            let codec = 'mp3';

            switch (ver) {
                case 0:  // MPEG 2.5
                    sample_rate = FLVDemuxer._mpegAudioV25SampleRateTable[sampling_freq_index];
                    break;
                case 2:  // MPEG 2
                    sample_rate = FLVDemuxer._mpegAudioV20SampleRateTable[sampling_freq_index];
                    break;
                case 3:  // MPEG 1
                    sample_rate = FLVDemuxer._mpegAudioV10SampleRateTable[sampling_freq_index];
                    break;
            }

            switch (layer) {
                case 1:  // Layer 3
                    object_type = 34;
                    if (bitrate_index < FLVDemuxer._mpegAudioL3BitRateTable.length) {
                        bit_rate = FLVDemuxer._mpegAudioL3BitRateTable[bitrate_index];
                    }
                    break;
                case 2:  // Layer 2
                    object_type = 33;
                    if (bitrate_index < FLVDemuxer._mpegAudioL2BitRateTable.length) {
                        bit_rate = FLVDemuxer._mpegAudioL2BitRateTable[bitrate_index];
                    }
                    break;
                case 3:  // Layer 1
                    object_type = 32;
                    if (bitrate_index < FLVDemuxer._mpegAudioL1BitRateTable.length) {
                        bit_rate = FLVDemuxer._mpegAudioL1BitRateTable[bitrate_index];
                    }
                    break;
            }

            result = {
                bitRate: bit_rate,
                samplingRate: sample_rate,
                channelCount: channel_count,
                codec: codec,
                originalCodec: codec
            };
        } else {
            result = array;
        }

        return result;
    }

    /**
     * Parse an AudioPacketType.MultichannelConfig payload (E-RTMP v2 §Enhanced Audio).
     *
     * Payload layout (all big-endian):
     *   audioChannelOrder  UI8   — AudioChannelOrder enum value
     *   channelCount       UI8   — total number of channels
     *   [if Native]  audioChannelFlags  UI32  — AudioChannelMask bitmask
     *   [if Custom]  audioChannelMapping UI8[channelCount] — AudioChannel values
     *
     * If audio metadata already exists, channelCount is updated immediately and
     * metadata is re-dispatched so that the downstream remuxer can reinitialize
     * the init segment with the correct value.
     */
    private _parseAudioMultichannelConfig(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number): void {
        const log = Log.scope(FLVDemuxer.TAG, '_parseAudioMultichannelConfig()');

        if (dataSize < 2) {
            log.w(`payload too short (${dataSize} bytes), ignoring`);
            return;
        }
        const view = new DataView(arrayBuffer, dataOffset, dataSize);
        const audioChannelOrder: AudioChannelOrder = view.getUint8(0);
        const channelCount = view.getUint8(1);

        // Validate that enough bytes are present for the optional fields
        if (audioChannelOrder === AudioChannelOrder.Native && dataSize < 6) {
            log.w(`Native order requires 6 bytes, got ${dataSize}, ignoring`);
            return;
        }
        if (audioChannelOrder === AudioChannelOrder.Custom && dataSize < 2 + channelCount) {
            log.w(`Custom mapping requires ${2 + channelCount} bytes, got ${dataSize}, ignoring`);
            return;
        }

        const orderName = AudioChannelOrder[audioChannelOrder] ?? String(audioChannelOrder);
        log.v(`audioChannelOrder=${orderName} channelCount=${channelCount}`);

        if (audioChannelOrder === AudioChannelOrder.Native) {
            const audioChannelFlags = view.getUint32(2, false);
            const presentChannels: string[] = [];
            for (const [name, mask] of Object.entries(AudioChannelMask) as [string, number][]) {
                if (typeof mask === 'number' && (audioChannelFlags & mask) !== 0) {
                    presentChannels.push(name);
                }
            }
            log.v(`Native audioChannelFlags=0x${audioChannelFlags.toString(16).padStart(6, '0')} channels=[${presentChannels.join(', ')}]`);
        } else if (audioChannelOrder === AudioChannelOrder.Custom) {
            const mapping: string[] = [];
            for (let i = 0; i < channelCount; i++) {
                const ch = view.getUint8(2 + i);
                mapping.push(`ch${i}=${AudioChannel[ch] ?? `0x${ch.toString(16)}`}`);
            }
            log.v(`Custom mapping=[${mapping.join(', ')}]`);
        }

        this._handleAacMultichannelConfig(channelCount, log);
    }

    private _handleAacMultichannelConfig(channelCount: number, log: ReturnType<typeof Log.scope>): void {
        const meta = this._audioMetadata;
        if (!meta || channelCount <= 0) {
            log.v(`ignoring MultichannelConfig channelCount=${channelCount}, current channelCount=${meta?.channelCount ?? 'undefined'}`);
            return;
        }

        if (meta.codecType !== AudioCodecType.Aac || !meta.codecConfig || meta.codecConfig.length < 2) {
            log.v(`ignoring MultichannelConfig channelCount=${channelCount}, codecType=${AudioCodecType[meta.codecType] ?? meta.codecType} codecConfigLength=${meta.codecConfig?.length ?? 0}`);
            return;
        }

        const channelConfig = (meta.codecConfig[1] & 0x78) >>> 3;
        const channelConfigWasInBand = meta.aacChannelConfigWasInBand;
        if (meta.channelCount === channelCount) {
            log.v(`ignoring MultichannelConfig channelCount=${channelCount}, current channelCount=${meta.channelCount} channelConfig=${channelConfig} channelConfigWasInBand=${channelConfigWasInBand}`);
            return;
        }

        if (channelConfigWasInBand && channelCount > 2) {
            const audioObjectType = meta.codecConfig[0] >>> 3 as MPEG4AudioObjectTypes;
            if (audioObjectType === MPEG4AudioObjectTypes.kAAC_PS) {
                log.v(`channelConfig=0 + audioObjectType=${MPEG4AudioObjectTypes[audioObjectType]}(${audioObjectType}) = HE-AAC v2 PS, ignoring MultichannelConfig channelCount=${channelCount}, keeping channelCount=${meta.channelCount}`);
                return;
            }

            if (!this._hasObservedAacPce) {
                if (this._hasIgnoredAacMultichannelConfig) {
                    log.v(`channelConfig=0 + stereo AAC evidence without PCE, treating MultichannelConfig channelCount=${channelCount} as advisory, keeping channelCount=${meta.channelCount}`);
                    return;
                }

                this._pendingAacMultichannelChannelCount = channelCount;
                log.v(`channelConfig=0 + audioObjectType=${MPEG4AudioObjectTypes[audioObjectType]}(${audioObjectType}), deferring MultichannelConfig channelCount=${channelCount} until AAC PCE is observed`);
                return;
            }

            log.v(`original channelConfig=0 + observed AAC PCE, honouring MultichannelConfig channelCount=${channelCount}`);
        }

        this._rewriteAacChannelConfig(channelCount, channelConfig, log);

        this._pendingAacMultichannelChannelCount = undefined;
        meta.channelCount = channelCount;
        this._mediaInfo.audioChannelCount = channelCount;

        log.v(`updated audioMetadata.channelCount → ${channelCount}, re-dispatching metadata`);
        if (this._remuxer.isAudioMetadataDispatched) {
            this._flushPendingTrackDataBeforeMetadataRefresh();
        }
        this._onTrackMetadata(meta);
    }

    private _rewriteAacChannelConfig(channelCount: number, channelConfig: number, log: ReturnType<typeof Log.scope>): void {
        const meta = this._audioMetadata;
        if (!meta?.codecConfig) {
            return;
        }

        const aacChannelCountTable = [0, 1, 2, 3, 4, 5, 6, 8];
        const newChannelConfig = aacChannelCountTable.indexOf(channelCount);
        if (newChannelConfig > 0) {
            const rewritten = Uint8Array.from(meta.codecConfig);
            rewritten[1] = (rewritten[1] & 0x87) | ((newChannelConfig & 0x0F) << 3);
            meta.codecConfig = rewritten;
            log.v(`updated AAC AudioSpecificConfig channelConfig ${channelConfig}→${newChannelConfig} for channelCount=${channelCount}`);
        } else {
            log.w(`channelCount=${channelCount} has no standard AAC channelConfig mapping, AudioSpecificConfig unchanged`);
        }
    }

    private _ignorePendingAacMultichannelConfig(payloadDescription: string): void {
        if (this._pendingAacMultichannelChannelCount === undefined || this._hasObservedAacPce || this._hasIgnoredAacMultichannelConfig) {
            return;
        }

        const meta = this._audioMetadata;
        if (!meta?.codecConfig || meta.codecType !== AudioCodecType.Aac) {
            return;
        }

        if (!meta.aacChannelConfigWasInBand) {
            return;
        }

        const channelCount = this._pendingAacMultichannelChannelCount;
        this._hasIgnoredAacMultichannelConfig = true;

        const log = Log.scope(FLVDemuxer.TAG, '_parseAudioMultichannelConfig()');
        log.v(`stereo AAC payload without PCE (${payloadDescription}), treating pending MultichannelConfig channelCount=${channelCount} as advisory, keeping channelCount=${meta.channelCount}`);
    }

    private _applyPendingAacMultichannelConfig(): void {
        if (!this._hasObservedAacPce || this._pendingAacMultichannelChannelCount === undefined) {
            return;
        }

        const channelCount = this._pendingAacMultichannelChannelCount;
        this._pendingAacMultichannelChannelCount = undefined;
        this._hasIgnoredAacMultichannelConfig = false;
        const log = Log.scope(FLVDemuxer.TAG, '_parseAudioMultichannelConfig()');
        log.v(`observed AAC PCE, applying pending MultichannelConfig channelCount=${channelCount}`);
        this._handleAacMultichannelConfig(channelCount, log);
    }

    private _parseEnhancedAacAudioPacket(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number, tagTimestamp: number, packetType: AudioPacketType) {
        let meta = this._audioMetadata;
        let track = this._audioTrack;

        if (!meta) {
            if (this._hasAudio === false && this._hasAudioFlagOverrided === false) {
                this._hasAudio = true;
                this._mediaInfo.hasAudio = true;
            }
            meta = this._audioMetadata = {
                ...audioMetadataDefault,
                type: TrackType.Audio,
                trackId: track.id,
                timescale: this._timescale,
                duration: this._duration,
            };
        }
        meta.codecType = AudioCodecType.Aac;

        if (packetType === AudioPacketType.SequenceStart) {
            // Enhanced FLV: payload is directly AudioSpecificConfig (no leading AACPacketType byte)
            const misc = this._parseAacAudioSpecificConfig(arrayBuffer, dataOffset, dataSize);
            if (misc == undefined) {
                return;
            }
            const configBytes = new Uint8Array(misc.config);
            if (meta.codecConfig) {
                if (buffersAreEqual(configBytes, meta.codecConfig)) {
                    return;
                } else {
                    Log.w(FLVDemuxer.TAG, 'AudioSpecificConfig has been changed, re-generate initialization segment');
                }
            }
            meta.audioSampleRate = misc.samplingRate;
            meta.channelCount = misc.channelCount;
            meta.codec = misc.codec;
            meta.originalCodec = misc.originalCodec;
            meta.codecConfig = configBytes;
            meta.aacChannelConfigWasInBand = misc.channelConfigWasInBand;
            this._hasLoggedFirstAacPayloadProbe = false;
            this._hasLoggedAacPceDetection = false;
            this._hasLoggedAacSbrDetection = false;
            this._hasObservedAacPce = misc.channelConfigHasPce;
            this._pendingAacMultichannelChannelCount = undefined;
            this._hasIgnoredAacMultichannelConfig = false;
            this._aacPayloadProbeFrameIndex = 0;
            meta.refFrameDuration = 1024 / meta.audioSampleRate * meta.timescale;
            Log.v(FLVDemuxer.TAG, 'Parsed Enhanced FLV AAC AudioSpecificConfig');

            if (this._remuxer.isAudioMetadataDispatched) {
                Log.v(FLVDemuxer.TAG, 'Dispatching enhanced AAC track data before metadata refresh');
                this._flushPendingTrackDataBeforeMetadataRefresh();
            }
            Log.v(FLVDemuxer.TAG, `Dispatching enhanced AAC track metadata codec=${meta.codec} channels=${meta.channelCount} sampleRate=${meta.audioSampleRate}`);
            this._onTrackMetadata(meta);

            let mi = this._mediaInfo;
            mi.audioCodec = meta.originalCodec;
            mi.audioSampleRate = meta.audioSampleRate;
            mi.audioChannelCount = meta.channelCount;
            if (mi.hasVideo) {
                if (mi.videoCodec != null) {
                    mi.mimeType = 'video/x-flv; codecs="' + mi.videoCodec + ',' + mi.audioCodec + '"';
                }
            } else {
                mi.mimeType = 'video/x-flv; codecs="' + mi.audioCodec + '"';
            }
            if (mi.isComplete()) {
                Log.v(FLVDemuxer.TAG, `Dispatching enhanced AAC media info codec=${mi.audioCodec} channels=${mi.audioChannelCount} mimeType=${mi.mimeType}`);
                this._onMediaInfo(mi);
            }
        } else if (packetType === AudioPacketType.CodedFrames) {
            // Enhanced FLV: payload is raw AAC frame data (no leading AACPacketType byte)
            let data = new Uint8Array(arrayBuffer, dataOffset, dataSize);
            this._probeAacPayload(data);
            let dts = this._timestampBase + tagTimestamp;
            let aacSample: AudioFrame = {unit: data, length: data.byteLength, dts: dts, pts: dts};
            track.frames.push(aacSample);
            track.length += data.length;
        } else if (packetType === AudioPacketType.SequenceEnd) {
            // empty, AAC end of sequence
        } else if (packetType === AudioPacketType.MultichannelConfig) {
            this._parseAudioMultichannelConfig(arrayBuffer, dataOffset, dataSize);
        } else {
            const typeName = AudioPacketType[packetType] ?? String(packetType);
            Log.w(FLVDemuxer.TAG, `_parseEnhancedAacAudioPacket(): unsupported FlvAudioPacketType=${typeName} ts=${tagTimestamp} offset=${dataOffset} size=${dataSize} action=drop`);
        }
    }

    private _parseEnhancedOpusAudioPacket(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number, tagTimestamp: number, packetType: AudioPacketType) {
       if (packetType === AudioPacketType.SequenceStart) {
            this._parseOpusSequenceHeader(arrayBuffer, dataOffset, dataSize);
        } else if (packetType === AudioPacketType.CodedFrames) {
            if (!this._hasUsableOpusMetadata()) {
                this._injectFallbackOpusSequenceHeader(tagTimestamp);
            }
            this._parseOpusFrameData(arrayBuffer, dataOffset, dataSize, tagTimestamp);
        } else if (packetType === AudioPacketType.SequenceEnd) {
            // empty, Opus end of sequence
        } else if (packetType === AudioPacketType.MultichannelConfig) {
            this._parseAudioMultichannelConfig(arrayBuffer, dataOffset, dataSize);
        } else {
           const typeName = AudioPacketType[packetType] ?? String(packetType);
           Log.w(FLVDemuxer.TAG, `_parseEnhancedOpusAudioPacket(): unsupported FlvAudioPacketType=${typeName} ts=${tagTimestamp} offset=${dataOffset} size=${dataSize} action=drop`);
        }
    }

    private _hasUsableOpusMetadata(): boolean {
        return this._audioMetadata?.codecType === AudioCodecType.Opus && !!this._audioMetadata.codecConfig;
    }

    /**
     * Injects a synthetic OpusHead sequence header when Opus CodedFrames arrive
     * without a prior SequenceStart packet. This can happen when a viewer joins a
     * live stream mid-stream and the server does not replay cached initialization
     * packets.
     *
     * E-RTMP-compliant servers MUST cache and replay codec initialization packets
     * to late joiners, including SequenceStart and MultichannelConfig packets for
     * every audio codec in the stream. This method is a best-effort fallback for 
     * Opus streams from non-compliant servers; it does not recover missing 
     * initialization metadata for other codecs and is not a substitute for correct 
     * server behavior.
     *
     * Limitations:
     * - Assumes stereo, mapping family 0.
     * - Mono streams may be exposed as stereo.
     * - Multichannel Opus requires the real SequenceStart/MultichannelConfig
     *   metadata and may be represented incorrectly by this fallback.
     */
    private _injectFallbackOpusSequenceHeader(tagTimestamp: number): void {
         const header = new Uint8Array([
             0x4F, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, // "OpusHead"
             0x01,                                           // version
             0x02,                                           // stereo
             0x00, 0x00,                                     // pre-skip
             0x80, 0xBB, 0x00, 0x00,                         // input sample rate: 48000 Hz, little-endian
             0x00, 0x00,                                     // output gain
             0x00                                            // mapping family 0: mono/stereo
         ]);

        Log.w(FLVDemuxer.TAG, `_parseEnhancedOpusAudioPacket(): Opus CodedFrames received before SequenceStart ts=${tagTimestamp}; injecting fallback stereo OpusHead`);
        this._parseOpusSequenceHeader(header.buffer, header.byteOffset, header.byteLength);
    }

    private _parseOpusSequenceHeader(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number) {
        // Validate minimal OpusHead identification header length (RFC 7845)
        if (dataSize < 19) {
            Log.e(FLVDemuxer.TAG, '_parseOpusSequenceHeader(): Invalid OpusSequenceHeader, lack of data!');
            return;
        }

        const header = new Uint8Array(arrayBuffer, dataOffset, dataSize);
        const magic = String.fromCharCode(...header.subarray(0, 8));
        if (magic !== 'OpusHead') {
            Log.e(FLVDemuxer.TAG, `_parseOpusSequenceHeader(): Invalid OpusSequenceHeader, missing OpusHead (got "${magic}")`);
            return;
        }

        const config = new Uint8Array(arrayBuffer, dataOffset + 8, dataSize - 8).slice();
        const dv = new DataView(config.buffer);
        const channelCount = dv.getUint8(1);
        const preskipSamples = dv.getUint16(2, true);          // little-endian (RFC 7845)
        const inputSampleRate = dv.getUint32(4, true);
        const outputGain = dv.getInt16(8, true);
        const mappingFamily = dv.getUint8(10);

        if (outputGain > 0) {
            Log.w(FLVDemuxer.TAG, `_parseOpusSequenceHeader(): outputGain within OpusSequenceHeader action=drop`);
        }
        if (mappingFamily !== 0) {
            Log.w(FLVDemuxer.TAG, `_parseOpusSequenceHeader(): channel mapping within OpusSequenceHeader action=drop`);
        }
    
        let meta = this._audioMetadata;
        let track = this._audioTrack;

        if (!meta) {
            if (this._hasAudio === false && this._hasAudioFlagOverrided === false) {
                this._hasAudio = true;
                this._mediaInfo.hasAudio = true;
            }

            // initial metadata
            meta = this._audioMetadata = {
                ...audioMetadataDefault,
                type: TrackType.Audio,
                trackId: track.id,
                timescale: this._timescale,
                duration: this._duration, 
            }
        }
        meta.codecType = AudioCodecType.Opus;

        if (meta.codecConfig) {
            if (buffersAreEqual(config, meta.codecConfig)) {
                // If OpusSequenceHeader is not changed, ignore it to avoid generating initialization segment repeatedly
                return;
            } else {
                Log.v(FLVDemuxer.TAG, '_parseOpusSequenceHeader(): OpusSequenceHeader has been changed, re-generate initialization segment');
            }
        }
        meta.audioSampleRate = 48000;                           // RFC 7845: Opus decoding output is always 48 kHz
        meta.channelCount = channelCount;
        meta.codec = 'opus';
        meta.originalCodec = 'opus';
        meta.codecConfig = config;
        meta.preSkipSamples = preskipSamples;
        meta.inputSampleRate = inputSampleRate;
        meta.outputGain = outputGain;
        meta.refFrameDuration = 960 * meta.timescale / 48000;   // The default Opus packet is 20ms = 960 samples at 48 kHz
        Log.v(FLVDemuxer.TAG, 'Parsed OpusSequenceHeader');

        if (this._remuxer.isAudioMetadataDispatched) {
            // Non-initial metadata, force dispatch (or flush) parsed frames to remuxer
            this._flushPendingTrackDataBeforeMetadataRefresh();
        }

        // notify new metadata
        this._onTrackMetadata(meta);        

        let mi = this._mediaInfo;
        mi.audioCodec = meta.originalCodec;
        mi.audioSampleRate = meta.audioSampleRate;
        mi.audioChannelCount = meta.channelCount;
        if (mi.hasVideo) {
            if (mi.videoCodec != null) {
                mi.mimeType = 'video/x-flv; codecs="' + mi.videoCodec + ',' + mi.audioCodec + '"';
            }
        } else {
            mi.mimeType = 'video/x-flv; codecs="' + mi.audioCodec + '"';
        }
        if (mi.isComplete()) {
            this._onMediaInfo(mi);
        }
    }

    private _parseOpusFrameData(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number, tagTimestamp: number) {
        let track = this._audioTrack;

        let data = new Uint8Array(arrayBuffer, dataOffset, dataSize);
        let dts = this._timestampBase + tagTimestamp;
        let opusSample: AudioFrame = {unit: data, length: data.byteLength, dts: dts, pts: dts};

        track.frames.push(opusSample);
        track.length += data.length;
    }

    private _parseEnhancedFlacAudioPacket(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number, tagTimestamp: number, packetType: AudioPacketType) {
        if (packetType === AudioPacketType.SequenceStart) {
            this._parseFlacSequenceHeader(arrayBuffer, dataOffset, dataSize);
        } else if (packetType === AudioPacketType.CodedFrames) {
            this._parseFlacFrameData(arrayBuffer, dataOffset, dataSize, tagTimestamp);
        } else if (packetType === AudioPacketType.SequenceEnd) {
            // empty, Flac end of sequence
        } else if (packetType === AudioPacketType.MultichannelConfig) {
            this._parseAudioMultichannelConfig(arrayBuffer, dataOffset, dataSize);
        } else {
            this._onError(DemuxErrors.FORMAT_ERROR, `${FLVDemuxer.TAG}._parseEnhancedFlacAudioPacket() - Unsupported FlvAudioPacketType ${packetType}`);
            return;
        }
    }

    private _parseFlacSequenceHeader(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number) {
        let meta = this._audioMetadata;
        const track = this._audioTrack;

        if (!meta) {
            if (this._hasAudio === false && this._hasAudioFlagOverrided === false) {
                this._hasAudio = true;
                this._mediaInfo.hasAudio = true;
            }

            // initial metadata
            meta = this._audioMetadata = {
                ...audioMetadataDefault,
                type: TrackType.Audio,
                trackId: track.id,
                timescale: this._timescale,
                duration: this._duration,
            }
        }
        meta.codecType = AudioCodecType.Flac;

        // METADATA_BLOCK_HEADER
        const payload = new Uint8Array(arrayBuffer, dataOffset, dataSize);
        const codecConfig = new Uint8Array(dataSize + 4);
        codecConfig[0] = 0x80;                          // last-metadata-block flag + STREAMINFO (type 0)
        codecConfig[1] = 0x00;
        codecConfig[2] = 0x00;
        codecConfig[3] = dataSize;                      // 34 bytes expected
        codecConfig.set(payload, 4);

        const gb = new ExpGolomb(payload);
        const minimum_block_size = gb.readBits(16);     // minimum_block_size
        const maximum_block_size = gb.readBits(16);     // maximum_block_size
        const block_size = maximum_block_size === minimum_block_size ? maximum_block_size : 4096; // use maximum block size if variable
        const _minimum_frame_size = gb.readBits(24);    // minimum_frame_size
        const _maximum_frame_size = gb.readBits(24);    // maximum_frame_size
        const samplingFrequence = gb.readBits(20);
        const channelCount = gb.readBits(3) + 1;
        const bitsPerSample = gb.readBits(5) + 1;
        gb.destroy();

        let misc = {
            config: codecConfig,
            channelCount,
            samplingFrequence,
            bitsPerSample: bitsPerSample,
            codec: 'flac',
            originalCodec: 'flac',
        };
        if (meta.codecConfig) {
            if (buffersAreEqual(misc.config, meta.codecConfig)) {
                // If FlacSequenceHeader is not changed, ignore it to avoid generating initialization segment repeatedly
                return;
            } else {
                Log.w(FLVDemuxer.TAG, 'FlacSequenceHeader has been changed, re-generate initialization segment');
            }
        }
        meta.audioSampleRate = misc.samplingFrequence;
        meta.channelCount = misc.channelCount;
        meta.bitsPerSample = misc.bitsPerSample;
        meta.codec = misc.codec;
        meta.originalCodec = misc.originalCodec;
        meta.codecConfig = misc.config;
        meta.refFrameDuration = block_size * 1000 / misc.samplingFrequence; // practical encoder sends 4608 blobksize (lower bound limitation)

        Log.v(FLVDemuxer.TAG, 'Parsed FlacSequenceHeader');

        if (this._remuxer.isAudioMetadataDispatched) {
            // Non-initial metadata, force dispatch (or flush) parsed frames to remuxer
            this._flushPendingTrackDataBeforeMetadataRefresh();
        }
        // notify new metadata
        this._onTrackMetadata(meta);

        let mi = this._mediaInfo;
        mi.audioCodec = meta.originalCodec;
        mi.audioSampleRate = meta.audioSampleRate;
        mi.audioChannelCount = meta.channelCount;
        if (mi.hasVideo) {
            if (mi.videoCodec != null) {
                mi.mimeType = 'video/x-flv; codecs="' + mi.videoCodec + ',' + mi.audioCodec + '"';
            }
        } else {
            mi.mimeType = 'video/x-flv; codecs="' + mi.audioCodec + '"';
        }
        if (mi.isComplete()) {
            this._onMediaInfo(mi);
        }
    }

    private _parseFlacFrameData(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number, tagTimestamp: number) {
        let track = this._audioTrack;

        let data = new Uint8Array(arrayBuffer, dataOffset, dataSize);
        let dts = this._timestampBase + tagTimestamp;
        let flacSample = {unit: data, length: data.byteLength, dts: dts, pts: dts};

        track.frames.push(flacSample);
        track.length += data.length;
    }

    private _parseVideoTagData(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number, tagTimestamp: number, tagPosition: number) {
        if (dataSize <= 1) {
            Log.w(FLVDemuxer.TAG, 'Flv: Invalid video packet, missing VideoData payload!');
            return;
        }

        if (this._hasVideoFlagOverrided === true && this._hasVideo === false) {
            // If hasVideo: false indicated explicitly in MediaDataSource,
            // Ignore all the video packets
            return;
        }

        let spec = (new Uint8Array(arrayBuffer, dataOffset, dataSize))[0];

        let isExHeader = (spec & 0b10000000) !== 0;
        let frameType = ((spec & 0b01110000) >>> 4) as VideoFrameType;

        if (!isExHeader) {
            let codecId = spec & 0b00001111 as VideoCodecId;
            if (codecId === VideoCodecId.AVC) {
                this._parseLegacyAvcVideoPacket(arrayBuffer, dataOffset + 1, dataSize - 1, tagTimestamp, tagPosition, frameType, this._getOrCreateVideoTrack(0));
            } else if (codecId === VideoCodecId.Hevc) {
                this._parseLegacyHevcVideoPacket(arrayBuffer, dataOffset + 1, dataSize - 1, tagTimestamp, tagPosition, frameType, this._getOrCreateVideoTrack(0));
            } else {
                this._onError(DemuxErrors.CODEC_UNSUPPORTED, `Flv: Unsupported codec in video frame: ${codecId}`);
                return;
            }
        } else {
            let packetType = (spec & 0b00001111) as VideoPacketType;

            if (packetType === VideoPacketType.Multitrack) {
                this._parseEnhancedMultitrackVideoPacket(arrayBuffer, dataOffset + 1, dataSize - 1, tagTimestamp, tagPosition, frameType);
            } else {
                let fourcc = String.fromCharCode(... (new Uint8Array(arrayBuffer, dataOffset, dataSize)).slice(1, 5));

                if (fourcc === 'avc1') { // AVC
                    this._parseEnhancedAvcVideoPacket(arrayBuffer, dataOffset + 5, dataSize - 5, tagTimestamp, tagPosition, frameType, packetType, this._getOrCreateVideoTrack(0));
                } else if (fourcc === 'hvc1') { // HEVC
                    this._parseEnhancedHevcVideoPacket(arrayBuffer, dataOffset + 5, dataSize - 5, tagTimestamp, tagPosition, frameType, packetType, this._getOrCreateVideoTrack(0));
                } else if (fourcc === 'av01') { // AV1
                    this._parseEnhancedAv1VideoPacket(arrayBuffer, dataOffset + 5, dataSize - 5, tagTimestamp, tagPosition, frameType, packetType, this._getOrCreateVideoTrack(0));
                } else if (fourcc === 'vp09') { // VP9
                    this._parseEnhancedVp9VideoPacket(arrayBuffer, dataOffset + 5, dataSize - 5, tagTimestamp, tagPosition, frameType, packetType, this._getOrCreateVideoTrack(0));
                } else {
                    this._onError(DemuxErrors.CODEC_UNSUPPORTED, `Flv: Unsupported codec in video frame: ${fourcc}`);
                    return;
                }
            }
        }
    }

    private _parseEnhancedMultitrackVideoPacket(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number, tagTimestamp: number, tagPosition: number, frameType: number) {
        if (dataSize < 2) {
            Log.w(FLVDemuxer.TAG, 'Flv: Invalid multitrack video packet, too short');
            return;
        }

        const v = new DataView(arrayBuffer, dataOffset, dataSize);
        const multitrackByte = v.getUint8(0);
        const multitrackType: AvMultitrackType = (multitrackByte >> 4) & 0x0F;
        const innerPacketType: VideoPacketType = multitrackByte & 0x0F;

        if (innerPacketType === VideoPacketType.Multitrack) {
            this._onError(DemuxErrors.FORMAT_ERROR, 'Flv: Multitrack innerPacketType must not be Multitrack');
            return;
        }

        let offset = 1;

        // Shared FOURCC for OneTrack and ManyTracks
        let sharedFourcc: string | null = null;
        if (multitrackType !== AvMultitrackType.ManyTracksManyCodecs) {
            if (dataSize - offset < 4) {
                Log.w(FLVDemuxer.TAG, 'Flv: Invalid multitrack video packet, missing shared FOURCC');
                return;
            }
            sharedFourcc = String.fromCharCode(...(new Uint8Array(arrayBuffer, dataOffset + offset, 4)));
            offset += 4;
        }

        while (offset < dataSize) {
            // Per-track FOURCC for ManyTracksManyCodecs
            let fourcc: string;
            if (multitrackType === AvMultitrackType.ManyTracksManyCodecs) {
                if (dataSize - offset < 4) break;
                fourcc = String.fromCharCode(...(new Uint8Array(arrayBuffer, dataOffset + offset, 4)));
                offset += 4;
            } else {
                fourcc = sharedFourcc!;
            }

            if (dataSize - offset < 1) break;
            const videoTrackId = v.getUint8(offset);
            offset += 1;

            let trackPayloadSize: number;
            if (multitrackType === AvMultitrackType.OneTrack) {
                trackPayloadSize = dataSize - offset;
            } else {
                if (dataSize - offset < 3) break;
                trackPayloadSize = (v.getUint8(offset) << 16) | (v.getUint8(offset + 1) << 8) | v.getUint8(offset + 2);
                offset += 3;
            }

            if (offset + trackPayloadSize > dataSize) {
                Log.w(FLVDemuxer.TAG, `Flv: Multitrack track payload overflows packet, trackId=${videoTrackId}`);
                break;
            }

            Log.v(FLVDemuxer.TAG, `Multitrack packet: trackId=${videoTrackId}, fourcc=${fourcc}, innerPacketType=${innerPacketType}, payloadSize=${trackPayloadSize}`);

            const track = this._getOrCreateVideoTrack(videoTrackId);
            const trackDataOffset = dataOffset + offset;
            const trackDataSize = trackPayloadSize;

            if (fourcc === 'avc1') {
                this._parseEnhancedAvcVideoPacket(arrayBuffer, trackDataOffset, trackDataSize, tagTimestamp, tagPosition, frameType, innerPacketType, track);
            } else if (fourcc === 'hvc1') {
                this._parseEnhancedHevcVideoPacket(arrayBuffer, trackDataOffset, trackDataSize, tagTimestamp, tagPosition, frameType, innerPacketType, track);
            } else if (fourcc === 'av01') {
                this._parseEnhancedAv1VideoPacket(arrayBuffer, trackDataOffset, trackDataSize, tagTimestamp, tagPosition, frameType, innerPacketType, track);
            } else if (fourcc === 'vp09') {
                this._parseEnhancedVp9VideoPacket(arrayBuffer, trackDataOffset, trackDataSize, tagTimestamp, tagPosition, frameType, innerPacketType, track);
            } else {
                Log.w(FLVDemuxer.TAG, `Flv: Unsupported codec in multitrack video packet: ${fourcc}, trackId=${videoTrackId}, action=skip`);
            }

            offset += trackPayloadSize;

            if (multitrackType === AvMultitrackType.OneTrack) {
                break;
            }
        }
    }

    private _parseLegacyAvcVideoPacket(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number, tagTimestamp: number, tagPosition: number, frameType: number, track: VideoTrack) {
        if (dataSize < 4) {
            Log.w(FLVDemuxer.TAG, 'Flv: Invalid AVC packet, missing AVCPacketType or/and CompositionTime');
            return;
        }

        const v = new DataView(arrayBuffer, dataOffset, dataSize);
        const packetType = v.getUint8(0);
        const cts = readSignedInt24(v, 1);
        dataOffset += 4;
        dataSize -= 4;

        if (packetType === VideoPacketType.SequenceStart) {  // AVCDecoderConfigurationRecord
            this._parseAvcDecoderConfig(arrayBuffer, dataOffset, dataSize, track);
        } else if (packetType === VideoPacketType.CodedFrames) {  // One or more Nalus
            this._parseAvcFrameData(arrayBuffer, dataOffset, dataSize, tagTimestamp, tagPosition, frameType, cts, track);
        } else if (packetType === VideoPacketType.SequenceEnd) {
            // empty, AVC end of sequence
        } else {
            this._onError(DemuxErrors.FORMAT_ERROR, `Flv: Invalid video packet type ${packetType}`);
            return;
        }
    }

    private _parseLegacyHevcVideoPacket(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number, tagTimestamp: number, tagPosition: number, frameType: number, track: VideoTrack) {
        if (dataSize < 4) {
            Log.w(FLVDemuxer.TAG, 'Flv: Invalid HEVC packet, missing HEVCPacketType or/and CompositionTime');
            return;
        }

        const v = new DataView(arrayBuffer, dataOffset, dataSize);
        const packetType = v.getUint8(0);
        const cts = readSignedInt24(v, 1);
        dataOffset += 4;
        dataSize -= 4;

        if (packetType === VideoPacketType.SequenceStart) {  // HEVCDecoderConfigurationRecord
            this._parseHevcDecoderConfig(arrayBuffer, dataOffset, dataSize, track);
        } else if (packetType === VideoPacketType.CodedFrames) {  // One or more Nalus
            this._parseHevcFrameData(arrayBuffer, dataOffset, dataSize, tagTimestamp, tagPosition, frameType, cts, track);
        } else if (packetType === VideoPacketType.SequenceEnd) {
            // empty, HEVC end of sequence
        } else {
            this._onError(DemuxErrors.FORMAT_ERROR, `Flv: Invalid video packet type ${packetType}`);
            return;
        }
    }

    private _parseEnhancedHevcVideoPacket(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number, tagTimestamp: number, tagPosition: number, frameType: number, packetType: VideoPacketType, track: VideoTrack) {
        const v = new DataView(arrayBuffer, dataOffset, dataSize);

        if (packetType === VideoPacketType.SequenceStart) {  // HEVCDecoderConfigurationRecord
            this._parseHevcDecoderConfig(arrayBuffer, dataOffset, dataSize, track);
        } else if (packetType === VideoPacketType.CodedFrames) {  // One or more Nalus
            if (dataSize < 3) {
                Log.w(FLVDemuxer.TAG, '_parseEnhancedHevcVideoPacket(): Invalid HEVC packet, missing CompositionTime');
                return;
            }
            
            const cts = readSignedInt24(v, 0);
            dataOffset += 3;
            dataSize -= 3;

            this._parseHevcFrameData(arrayBuffer, dataOffset, dataSize, tagTimestamp, tagPosition, frameType, cts, track);
        } else if (packetType === VideoPacketType.CodedFramesX) {
            this._parseHevcFrameData(arrayBuffer, dataOffset, dataSize, tagTimestamp, tagPosition, frameType, 0, track);
        } else if (packetType === VideoPacketType.SequenceEnd) {
            // empty, HEVC end of sequence
        } else {
            this._onError(DemuxErrors.FORMAT_ERROR, `Flv: Invalid video packet type ${packetType}`);
            return;
        }
    }

    private _parseEnhancedAvcVideoPacket(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number, tagTimestamp: number, tagPosition: number, frameType: number, packetType: VideoPacketType, track: VideoTrack) {
        let v = new DataView(arrayBuffer, dataOffset, dataSize);

        if (packetType === VideoPacketType.SequenceStart) {  // AVCDecoderConfigurationRecord
            this._parseAvcDecoderConfig(arrayBuffer, dataOffset, dataSize, track);
        } else if (packetType === VideoPacketType.CodedFrames) {  // One or more Nalus
            if (dataSize < 3) {
                Log.w(FLVDemuxer.TAG, '_parseEnhancedAvcVideoPacket(): Invalid AVC packet, missing CompositionTime');
                return;
            }

            const cts = readSignedInt24(v, 0);
            dataOffset += 3;
            dataSize -= 3;

            this._parseAvcFrameData(arrayBuffer, dataOffset, dataSize, tagTimestamp, tagPosition, frameType as VideoFrameType, cts, track);
        } else if (packetType === VideoPacketType.CodedFramesX) {
            this._parseAvcFrameData(arrayBuffer, dataOffset, dataSize, tagTimestamp, tagPosition, frameType as VideoFrameType, 0, track);
        } else if (packetType === VideoPacketType.SequenceEnd) {
            // empty, AVC end of sequence
        } else {
            this._onError(DemuxErrors.FORMAT_ERROR, `Flv: Invalid AVC video packet type ${packetType}`);
            return;
        }
    }

    private _parseEnhancedAv1VideoPacket(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number, tagTimestamp: number, tagPosition: number, frameType: number, packetType: VideoPacketType, track: VideoTrack) {
        let v = new DataView(arrayBuffer, dataOffset, dataSize);

        switch (packetType) {
            case VideoPacketType.SequenceStart:
                this._parseAv1DecoderConfig(arrayBuffer, dataOffset, dataSize, track);
                break;
            case VideoPacketType.CodedFrames:
                this._parseAv1FrameData(arrayBuffer, dataOffset, dataSize, tagTimestamp, tagPosition, frameType, 0, track);
                break;
            case VideoPacketType.SequenceEnd:
                // empty, AV1 end of sequence
                break;
            case VideoPacketType.Metadata: {
                Log.w(FLVDemuxer.TAG, `_parseEnhancedAv1VideoPacket(): unsupported AV1 video packet type ${packetType} (FlvVideoPacketType.Metadata) ts=${tagTimestamp} offset=${dataOffset} size=${dataSize} action=drop`);
                break;
            }

            default:
                this._onError(DemuxErrors.FORMAT_ERROR, `Flv: invalid AV1 video packet type ${packetType}`);
                return;
        }
    }

    // AVCDecoderConfigurationRecord must precede AVC coded frames.
    // A changed record replaces the previous configuration and causes
    // regeneration of the initialization segment.
    private _parseAvcDecoderConfig(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number, track: VideoTrack) {
        if (dataSize < 7) {
            Log.w(FLVDemuxer.TAG, 'Flv: Invalid AVCDecoderConfigurationRecord, lack of data!');
            return;
        }

        let meta = this._videoMetadataByTrackId.get(track.id);
        let v = new DataView(arrayBuffer, dataOffset, dataSize);

        if (!meta) {
            if (this._hasVideo === false && this._hasVideoFlagOverrided === false) {
                this._hasVideo = true;
                this._mediaInfo.hasVideo = true;
            }

            meta = {
                ...videoMetadataDefault,
                type: TrackType.Video,
                trackId: track.id,
                timescale: this._timescale,
                duration: this._duration
            };
            this._videoMetadataByTrackId.set(track.id, meta);
        } else {
            if (typeof meta.codecConfig !== 'undefined') {
                let new_avcc = new Uint8Array(arrayBuffer, dataOffset, dataSize);
                if (buffersAreEqual(new_avcc, meta.codecConfig)) {
                    // AVCDecoderConfigurationRecord is not changed, ignore it to avoid initialization segment re-generating
                    return;
                } else {
                    Log.w(FLVDemuxer.TAG, 'AVCDecoderConfigurationRecord has been changed, re-generate initialization segment');
                }
            }
        }
        meta.codecType = VideoCodecType.Avc;

        let version = v.getUint8(0);  // configurationVersion
        let avcProfile = v.getUint8(1);  // avcProfileIndication
        let profileCompatibility = v.getUint8(2);  // profile_compatibility
        let avcLevel = v.getUint8(3);  // AVCLevelIndication

        if (version !== 1 || avcProfile === 0) {
            this._onError(DemuxErrors.FORMAT_ERROR, 'Flv: Invalid AVCDecoderConfigurationRecord');
            return;
        }

        this._naluLengthSize = (v.getUint8(4) & 3) + 1;  // lengthSizeMinusOne
        if (this._naluLengthSize !== 3 && this._naluLengthSize !== 4) {  // holy shit!!!
            this._onError(DemuxErrors.FORMAT_ERROR, `Flv: Strange NaluLengthSizeMinusOne: ${this._naluLengthSize - 1}`);
            return;
        }

        let spsCount = v.getUint8(5) & 31;  // numOfSequenceParameterSets
        if (spsCount === 0) {
            this._onError(DemuxErrors.FORMAT_ERROR, 'Flv: Invalid AVCDecoderConfigurationRecord: No SPS');
            return;
        } else if (spsCount > 1) {
            Log.w(FLVDemuxer.TAG, `Flv: Strange AVCDecoderConfigurationRecord: SPS Count = ${spsCount}`);
        }

        let offset = 6;

        for (let i = 0; i < spsCount; i++) {
            let len = v.getUint16(offset, false);  // sequenceParameterSetLength
            offset += 2;

            if (len === 0) {
                continue;
            }

            // Notice: Nalu without startcode header (00 00 00 01)
            let sps = new Uint8Array(arrayBuffer, dataOffset + offset, len);
            offset += len;

            let config = SPSParser.parseSPS(sps);
            if (i !== 0) {
                // ignore other sps's config
                continue;
            }

            meta.codecWidth = config.codec_size.width;
            meta.codecHeight = config.codec_size.height;
            meta.presentWidth = config.present_size.width;
            meta.presentHeight = config.present_size.height;

            meta.profile = config.profile_string;
            meta.level = config.level_string;
            meta.bitDepth = config.bit_depth;
            meta.chromaFormat = config.chroma_format;
            meta.sarRatio = config.sar_ratio;
            meta.frameRate = config.frame_rate;

            if (config.frame_rate.fixed === false ||
                config.frame_rate.fps_num === 0 ||
                config.frame_rate.fps_den === 0) {
                meta.frameRate = this._referenceFrameRate;
            }

            let fps_den = meta.frameRate.fps_den;
            let fps_num = meta.frameRate.fps_num;
            meta.refFrameDuration = meta.timescale * (fps_den / fps_num);

            let codecArray = sps.subarray(1, 4);
            let codecString = 'avc1.';
            for (let j = 0; j < 3; j++) {
                let h = codecArray[j].toString(16);
                if (h.length < 2) {
                    h = '0' + h;
                }
                codecString += h;
            }
            meta.codec = codecString;

            let mi = this._mediaInfo;
            mi.width = meta.codecWidth;
            mi.height = meta.codecHeight;
            mi.fps = meta.frameRate.fps;
            mi.profile = meta.profile;
            mi.level = meta.level;
            mi.refFrames = config.ref_frames;
            mi.chromaFormat = config.chroma_format_string;
            mi.sarNum = meta.sarRatio.width;
            mi.sarDen = meta.sarRatio.height;
            mi.videoCodec = codecString;

            if (mi.hasAudio) {
                if (mi.audioCodec != null) {
                    mi.mimeType = 'video/x-flv; codecs="' + mi.videoCodec + ',' + mi.audioCodec + '"';
                }
            } else {
                mi.mimeType = 'video/x-flv; codecs="' + mi.videoCodec + '"';
            }
            if (mi.isComplete()) {
                this._onMediaInfo(mi);
            }
        }

        let ppsCount = v.getUint8(offset);  // numOfPictureParameterSets
        if (ppsCount === 0) {
            this._onError(DemuxErrors.FORMAT_ERROR, 'Flv: Invalid AVCDecoderConfigurationRecord: No PPS');
            return;
        } else if (ppsCount > 1) {
            Log.w(FLVDemuxer.TAG, `Flv: Strange AVCDecoderConfigurationRecord: PPS Count = ${ppsCount}`);
        }

        offset++;

        for (let i = 0; i < ppsCount; i++) {
            let len = v.getUint16(offset, false);  // pictureParameterSetLength
            offset += 2;

            if (len === 0) {
                continue;
            }

            // pps is useless for extracting video information
            offset += len;
        }

        meta.codecConfig = new Uint8Array(dataSize);
        meta.codecConfig.set(new Uint8Array(arrayBuffer, dataOffset, dataSize), 0);
        Log.v(FLVDemuxer.TAG, 'Parsed AVCDecoderConfigurationRecord');

        this._dispatchVideoTrackMetadata(meta);
    }

    // HEVCDecoderConfigurationRecord must precede HEVC coded frames.
    // A changed record replaces the previous configuration and causes
    // regeneration of the initialization segment.
    private _parseHevcDecoderConfig(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number, track: VideoTrack) {
        if (dataSize < 22) {
            Log.w(FLVDemuxer.TAG, 'Flv: Invalid HEVCDecoderConfigurationRecord, lack of data!');
            return;
        }

        let meta = this._videoMetadataByTrackId.get(track.id);
        let v = new DataView(arrayBuffer, dataOffset, dataSize);

        if (!meta) {
            if (this._hasVideo === false && this._hasVideoFlagOverrided === false) {
                this._hasVideo = true;
                this._mediaInfo.hasVideo = true;
            }

            meta = {
                ...videoMetadataDefault,
                type: TrackType.Video,
                trackId: track.id,
                timescale: this._timescale,
                duration: this._duration
            };
            this._videoMetadataByTrackId.set(track.id, meta);
        } else if (meta.codecConfig) {
            let new_hvcc = new Uint8Array(arrayBuffer, dataOffset, dataSize);
            if (buffersAreEqual(new_hvcc, meta.codecConfig)) {
                // HEVCDecoderConfigurationRecord not changed, ignore it to avoid initialization segment re-generating
                return;
            } else {
                Log.w(FLVDemuxer.TAG, 'HEVCDecoderConfigurationRecord has been changed, re-generate initialization segment');
            }
        }
        meta.codecType = VideoCodecType.Hevc;

        let version = v.getUint8(0);  // configurationVersion
        let hevcProfile = v.getUint8(1) & 0x1F;  // hevcProfileIndication

        if ((version !== 0 && version !== 1) || hevcProfile === 0) {
            this._onError(DemuxErrors.FORMAT_ERROR, 'Flv: Invalid HEVCDecoderConfigurationRecord');
            return;
        }

        this._naluLengthSize = (v.getUint8(21) & 3) + 1;  // lengthSizeMinusOne
        if (this._naluLengthSize !== 3 && this._naluLengthSize !== 4) {  // holy shit!!!
            this._onError(DemuxErrors.FORMAT_ERROR, `Flv: Strange NaluLengthSizeMinusOne: ${this._naluLengthSize - 1}`);
            return;
        }

        let numOfArrays = v.getUint8(22);
        for (let i = 0, offset = 23; i < numOfArrays; i++) {
            let nalUnitType = v.getUint8(offset + 0) & 0x3F;
            let numNalus = v.getUint16(offset + 1, false);

            offset += 3;
            for (let j = 0; j < numNalus; j++) {
                let len = v.getUint16(offset + 0, false);
                if (j !== 0) {
                    offset += 2 + len;
                    continue;
                }

                if (nalUnitType === 33) {
                    offset += 2;
                    let sps = new Uint8Array(arrayBuffer, dataOffset + offset, len);

                    let config = H265Parser.parseSPS(sps);
                    meta.codecWidth = config.codec_size.width;
                    meta.codecHeight = config.codec_size.height;
                    meta.presentWidth = config.present_size.width;
                    meta.presentHeight = config.present_size.height;

                    meta.profile = config.profile_string;
                    meta.level = config.level_string;
                    meta.bitDepth = config.bit_depth;
                    meta.chromaFormat = config.chroma_format;
                    meta.sarRatio = config.sar_ratio;
                    meta.frameRate = config.frame_rate;

                    if (config.frame_rate.fixed === false ||
                        config.frame_rate.fps_num === 0 ||
                        config.frame_rate.fps_den === 0) {
                        meta.frameRate = this._referenceFrameRate;
                    }

                    let fps_den = meta.frameRate.fps_den;
                    let fps_num = meta.frameRate.fps_num;
                    meta.refFrameDuration = meta.timescale * (fps_den / fps_num);
                    meta.codec = config.codec_mimetype;

                    let mi = this._mediaInfo;
                    mi.width = meta.codecWidth;
                    mi.height = meta.codecHeight;
                    mi.fps = meta.frameRate.fps;
                    mi.profile = meta.profile;
                    mi.level = meta.level;
                    mi.refFrames = config.ref_frames;
                    mi.chromaFormat = config.chroma_format_string;
                    mi.sarNum = meta.sarRatio.width;
                    mi.sarDen = meta.sarRatio.height;
                    mi.videoCodec = config.codec_mimetype;

                    if (mi.hasAudio) {
                        if (mi.audioCodec != null) {
                            mi.mimeType = 'video/x-flv; codecs="' + mi.videoCodec + ',' + mi.audioCodec + '"';
                        }
                    } else {
                        mi.mimeType = 'video/x-flv; codecs="' + mi.videoCodec + '"';
                    }
                    if (mi.isComplete()) {
                        this._onMediaInfo(mi);
                    }

                    offset += len;
                } else {
                    offset += 2 + len;
                }
            }
        }

        meta.codecConfig = new Uint8Array(dataSize);
        meta.codecConfig.set(new Uint8Array(arrayBuffer, dataOffset, dataSize), 0);
        Log.v(FLVDemuxer.TAG, 'Parsed HEVCDecoderConfigurationRecord');

        this._dispatchVideoTrackMetadata(meta);
    }

    // AV1CodecConfigurationRecord must precede AV1 coded frames.
    // A changed record replaces the previous configuration and causes
    // regeneration of the initialization segment.
    private _parseAv1DecoderConfig(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number, track: VideoTrack) {
        if (dataSize < 4) {
            Log.w(FLVDemuxer.TAG, 'Flv: Invalid AV1CodecConfigurationRecord, lack of data!');
            return;
        }

        let meta: VideoMetadata;
        const existingMeta = this._videoMetadataByTrackId.get(track.id);
        let v = new DataView(arrayBuffer, dataOffset, dataSize);

        if (!existingMeta) {
            if (this._hasVideo === false && this._hasVideoFlagOverrided === false) {
                this._hasVideo = true;
                this._mediaInfo.hasVideo = true;
            }

            meta = {
                ...videoMetadataDefault,
                type: TrackType.Video,
                trackId: track.id,
                timescale: this._timescale,
                duration: this._duration
            };
            this._videoMetadataByTrackId.set(track.id, meta);
        } else {
            if (existingMeta.codecConfig) {
                let new_av1c = new Uint8Array(arrayBuffer, dataOffset, dataSize);
                if (buffersAreEqual(new_av1c, existingMeta.codecConfig)) {
                    // AV1CodecConfigurationRecord not changed, ignore it
                    return;
                } else {
                    Log.w(FLVDemuxer.TAG, 'AV1CodecConfigurationRecord has been changed, re-generate initialization segment');
                }
            }
            meta = existingMeta;
        }
        meta.codecType = VideoCodecType.Av1;

        const version = v.getUint8(0) & 0x7F;

        // Read but currently unused; kept for advancing the parser in the future
        const _seq_profile = (v.getUint8(1) & 0xE0) >> 5;
        const _seq_level_idx = (v.getUint8(1) & 0x8F) >> 0;
        const _seq_tier = (v.getUint8(2) & 0x80) >> 7;

        if (version !== 1) {
            this._onError(DemuxErrors.FORMAT_ERROR, 'Flv: Invalid AV1CodecConfigurationRecord');
            return;
        }

        const config = AV1OBUParser.parseOBUs(new Uint8Array(arrayBuffer, dataOffset + 4, dataSize - 4));
        if (!config) {
            this._onError(DemuxErrors.FORMAT_ERROR, 'Flv: Invalid AV1CodecConfigurationRecord');
            return;
        }

        meta.profile = config.profile_string;
        meta.level = config.level_string;
        meta.bitDepth = config.bit_depth;
        meta.chromaFormat = config.chroma_format;
        meta.frameRate = config.frame_rate;
        if (config.frame_rate.fixed === false ||
            config.frame_rate.fps_num === 0 ||
            config.frame_rate.fps_den === 0) {
            meta.frameRate = this._referenceFrameRate;
        }
        let fps_den = meta.frameRate.fps_den;
        let fps_num = meta.frameRate.fps_num;
        meta.refFrameDuration = meta.timescale * (fps_den / fps_num);
        meta.codec = config.codec_mimetype;
        meta.av1Extra = config;

        let mi = this._mediaInfo;
        mi.fps = meta.frameRate.fps;
        mi.profile = meta.profile;
        mi.level = meta.level;
        mi.refFrames = config.ref_frames;
        mi.chromaFormat = config.chroma_format_string;
        mi.videoCodec = config.codec_mimetype;

        meta.codecWidth = mi.width ?? 0;
        meta.codecHeight = mi.height ?? 0;

        if (mi.hasAudio) {
            if (mi.audioCodec != null) {
                mi.mimeType = 'video/x-flv; codecs="' + mi.videoCodec + ',' + mi.audioCodec + '"';
            }
        } else {
            mi.mimeType = 'video/x-flv; codecs="' + mi.videoCodec + '"';
        }
        if (mi.isComplete()) {
            this._onMediaInfo(mi);
        }
        meta.codecConfig = new Uint8Array(arrayBuffer, dataOffset, dataSize).slice();

        this._dispatchVideoTrackMetadata(meta);
        Log.v(FLVDemuxer.TAG, `Parsed AV1 metadata: ${JSON.stringify(config)}`);
    }

    private _parseAvcFrameData(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number, tagTimestamp: number, tagPosition: number, frameType: VideoFrameType, cts: number, track: VideoTrack) {
        if (this._currentVideoTrackId !== undefined && track.id !== this._currentVideoTrackId) {
            return;
        }
        let v = new DataView(arrayBuffer, dataOffset, dataSize);

        let units: VideoUnit[] = [], length = 0;

        let offset = 0;
        const lengthSize = this._naluLengthSize;
        let dts = this._timestampBase + tagTimestamp;
        let keyframe = (frameType === VideoFrameType.KeyFrame);

        while (offset < dataSize) {
            if (offset + 4 >= dataSize) {
                Log.w(FLVDemuxer.TAG, `Malformed Nalu near timestamp ${dts}, offset = ${offset}, dataSize = ${dataSize}`);
                break;  // data not enough for next Nalu
            }
            // Nalu with length-header (AVC1)
            let naluSize = v.getUint32(offset, false);  // Big-Endian read
            if (lengthSize === 3) {
                naluSize >>>= 8;
            }
            if (naluSize > dataSize - lengthSize) {
                Log.w(FLVDemuxer.TAG, `Malformed Nalus near timestamp ${dts}, NaluSize > DataSize!`);
                return;
            }

            let unitType: H264NaluType = v.getUint8(offset + lengthSize) & 0x1F;

            if (unitType === H264NaluType.kSliceIDR) {
                keyframe = true;
            }

            let data = new Uint8Array(arrayBuffer, dataOffset + offset, lengthSize + naluSize);
            let unit: VideoUnit = {type: unitType, data: data};
            units.push(unit);
            length += data.byteLength;

            offset += lengthSize + naluSize;
        }

        if (units.length) {
            let avcSample: VideoFrame = {
                units: units,
                length: length,
                isKeyframe: keyframe,
                fileposition: tagPosition,
                dts: dts,
                cts: cts,
                pts: (dts + cts)
            };
            track.frames.push(avcSample);
            track.length += length;
        }
    }

    private _parseHevcFrameData(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number, tagTimestamp: number, tagPosition: number, frameType: number, cts: number, track: VideoTrack) {
        if (this._currentVideoTrackId !== undefined && track.id !== this._currentVideoTrackId) {
            return;
        }
        let v = new DataView(arrayBuffer, dataOffset, dataSize);

        let units: VideoUnit[] = [], length = 0;

        let offset = 0;
        const lengthSize = this._naluLengthSize;
        let dts = this._timestampBase + tagTimestamp;
        let keyframe = (frameType === 1);  // from FLV Frame Type constants

        while (offset < dataSize) {
            if (offset + 4 >= dataSize) {
                Log.w(FLVDemuxer.TAG, `Malformed Nalu near timestamp ${dts}, offset = ${offset}, dataSize = ${dataSize}`);
                break;  // data not enough for next Nalu
            }
            // Nalu with length-header (HVC1)
            let naluSize = v.getUint32(offset, false);  // Big-Endian read
            if (lengthSize === 3) {
                naluSize >>>= 8;
            }
            if (naluSize > dataSize - lengthSize) {
                Log.w(FLVDemuxer.TAG, `Malformed Nalus near timestamp ${dts}, NaluSize > DataSize!`);
                return;
            }

            let unitType: H265NaluType = (v.getUint8(offset + lengthSize) >> 1) & 0x3F;

            if (unitType === H265NaluType.kSliceIDR_W_RADL || unitType === H265NaluType.kSliceIDR_N_LP || unitType === H265NaluType.kSliceCRA_NUT) {
                keyframe = true;
            }

            const data = new Uint8Array(arrayBuffer, dataOffset + offset, lengthSize + naluSize);
            const unit: VideoUnit = {type: unitType, data: data};
            units.push(unit);
            length += data.byteLength;

            offset += lengthSize + naluSize;
        }

        if (units.length) {
            let hevcSample: VideoFrame = {
                units: units,
                length: length,
                isKeyframe: keyframe,
                fileposition: tagPosition,
                dts: dts,
                cts: cts,
                pts: (dts + cts)
            };

            track.frames.push(hevcSample);
            track.length += length;
        }
    }

    private _parseAv1FrameData(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number, tagTimestamp: number, tagPosition: number, frameType: VideoFrameType, cts: number, track: VideoTrack) {
        if (this._currentVideoTrackId !== undefined && track.id !== this._currentVideoTrackId) {
            return;
        }
        let units: VideoUnit[] = [];
        let length = 0;
        let dts = this._timestampBase + tagTimestamp;
        let keyframe = (frameType === VideoFrameType.KeyFrame);
        const rawData = new Uint8Array(arrayBuffer, dataOffset, dataSize);

        if (keyframe) {
            const meta = this._videoMetadataByTrackId.get(track.id);
            if (!meta) {
                this._onError(DemuxErrors.FORMAT_ERROR, 'Flv: AV1 VideoData received before SequenceStart');
                return;
            }

            const av1Metadata: AV1Metadata | undefined = AV1OBUParser.parseOBUs(rawData, meta.av1Extra);
            if (!av1Metadata) {
                this._onError(DemuxErrors.FORMAT_ERROR, 'Flv: Invalid AV1 VideoData');
                return;
            }
            meta.codecWidth = av1Metadata.codec_size!.width;
            meta.codecHeight = av1Metadata.codec_size!.height;
            meta.presentWidth = av1Metadata.present_size!.width;
            meta.presentHeight = av1Metadata.present_size!.height;
            meta.sarRatio = av1Metadata.sar_ratio!;

            let mi = this._mediaInfo;
            mi.width = meta.codecWidth;
            mi.height = meta.codecHeight;
            mi.sarNum = meta.sarRatio.width;
            mi.sarDen = meta.sarRatio.height;
        }

        // !!@FIXME: NEEDS Inspect Per OBUs
        // !!@ why are we pushing frame raw data into units? 
        length = dataSize;
        units.push({
            type: Av1ObuType.OBU_RESERVED_0,
            data: rawData
        });

        const av1Frame: VideoFrame = {
            units: units,
            length: length,
            isKeyframe: keyframe,
            fileposition: tagPosition,
            dts: dts,
            cts: cts,
            pts: (dts + cts),
            rawData: rawData
        };
          
        track.frames.push(av1Frame);
        track.length += length;
    }

    private _parseEnhancedVp9VideoPacket(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number, tagTimestamp: number, tagPosition: number, frameType: number, packetType: VideoPacketType, track: VideoTrack) {
        switch (packetType) {
            case VideoPacketType.SequenceStart:
                this._parseVp9DecoderConfig(arrayBuffer, dataOffset, dataSize, track);
                break;
            case VideoPacketType.CodedFrames:
                this._parseVp9FrameData(arrayBuffer, dataOffset, dataSize, tagTimestamp, tagPosition, frameType, 0, track);
                break;
            case VideoPacketType.SequenceEnd:
                // empty, VP9 end of sequence
                break;
            case VideoPacketType.Metadata:
                Log.w(FLVDemuxer.TAG, `_parseEnhancedVp9VideoPacket(): unsupported VP9 video packet type ${packetType} (FlvVideoPacketType.Metadata) ts=${tagTimestamp} offset=${dataOffset} size=${dataSize} action=drop`);
                break;

            default:
                this._onError(DemuxErrors.FORMAT_ERROR, `Flv: invalid VP9 video packet type ${packetType}`);
                return;
        }
    }

    // VP9CodecConfigurationRecord must precede VP9 coded frames.
    // A changed record replaces the previous configuration and causes
    // regeneration of the initialization segment.
    private _parseVp9DecoderConfig(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number, track: VideoTrack) {
        /*
            From ISO/IEC 14496-15:2020(E) -

            VPCodecConfigurationRecord {
                unsigned int(8)  version;                       // = 1
                unsigned int(24) flags;                         // = 0
                unsigned int(8)  profile;                       // VP9 profile (0-3)
                unsigned int(8)  level;                         // VP9 level
                unsigned int(4)  bitDepth;                      // 8, 10, or 12
                unsigned int(3)  chromaSubsampling;             // 0=4:2:0 vertical, 1=4:2:0 colocated, 2=4:2:2, 3=4:4:4
                unsigned int(1)  videoFullRangeFlag;            // 0=limited, 1=full
                unsigned int(8)  colorPrimaries;                // ISO color primaries
                unsigned int(8)  transferCharacteristics;       // ISO transfer characteristics
                unsigned int(8)  matrixCoefficients;            // ISO matrix coefficients
                unsigned int(16) codecInitializationDataSize;   // = 0 (VP9 has no init data!)
            }
            VP8CodecConfigurationRecord is similar, but without profile/level/bitDepth/chromaSubsampling fields
        */

        if (dataSize < 9) {
            Log.w(FLVDemuxer.TAG, '_parseVp9DecoderConfig(): Invalid VP9CodecConfigurationRecord, lack of data!');
            return;
        }

        const v = new DataView(arrayBuffer, dataOffset, dataSize);
        let meta: VideoMetadata;
        const existingMeta = this._videoMetadataByTrackId.get(track.id);

        if (!existingMeta) {
            if (this._hasVideo === false && this._hasVideoFlagOverrided === false) {
                this._hasVideo = true;
                this._mediaInfo.hasVideo = true;
            }
            meta = {
                ...videoMetadataDefault,
                type: TrackType.Video,
                trackId: track.id,
                timescale: this._timescale,
                duration: this._duration
            };
            this._videoMetadataByTrackId.set(track.id, meta);
        } else {
            if (existingMeta.codecConfig) {
                const new_vp9c = new Uint8Array(arrayBuffer, dataOffset, dataSize);
                if (buffersAreEqual(new_vp9c, existingMeta.codecConfig)) {
                    // VP9CodecConfigurationRecord not changed, ignore it
                    return;
                } else {
                    Log.w(FLVDemuxer.TAG, '_parseVp9DecoderConfig(): VP9CodecConfigurationRecord has been changed, re-generate initialization segment');
                }
            }
            meta = existingMeta;
        }
        meta.codecType = VideoCodecType.Vp9;

        // Detect format:
        //   12-byte FullBox format: version(1) + flags(3) + profile(1) + level(1) + ...
        //   9-byte ISO format:      configurationVersion(1) + profile(1) + level(1) + ...
        // If bytes 1-3 are zero it's FullBox (fields start at byte 4), otherwise ISO (fields start at byte 1).
        const fullboxFlags = (v.getUint8(1) << 16) | (v.getUint8(2) << 8) | v.getUint8(3);
        const isFullBox = fullboxFlags === 0 && dataSize >= 12;
        const o = isFullBox ? 4 : 1;  // offset to profile field

        if (!isFullBox && dataSize < 9) {
            Log.w(FLVDemuxer.TAG, '_parseVp9DecoderConfig(): record too short');
            return;
        }

        const profile = v.getUint8(o);
        const level = v.getUint8(o + 1);
        const bitDepth = (v.getUint8(o + 2) & 0xF0) >> 4;
        const chromaSubsampling = (v.getUint8(o + 2) & 0x0E) >> 1;
        const videoFullRangeFlag = v.getUint8(o + 2) & 0x01;
        const colourPrimaries = v.getUint8(o + 3);
        const transferCharacteristics = v.getUint8(o + 4);
        let matrixCoefficients = 2;  // 2 = Unspecified (safe default)

        if (dataSize >= o + 6) {
            matrixCoefficients = v.getUint8(o + 5);
            if (dataSize >= o + 8) {
                const codecInitDataSize = v.getUint16(o + 6, false);
                if (codecInitDataSize !== 0) {
                    Log.w(FLVDemuxer.TAG, `_parseVp9DecoderConfig(): Strange VP9CodecConfigurationRecord, codecInitializationDataSize = ${codecInitDataSize}`);
                }
            }
        }

        meta.profile = `${profile}`;
        meta.level = `${level}`;
        meta.bitDepth = bitDepth;
        meta.chromaFormat = chromaSubsampling;
        meta.colorRange = videoFullRangeFlag;
        meta.colourPrimaries = colourPrimaries;
        meta.transferCharacteristics = transferCharacteristics;
        meta.matrixCoefficients = matrixCoefficients;
        meta.codec = `vp09.${`${profile}`.padStart(2, '0')}.${`${level}`.padStart(2, '0')}.${`${bitDepth}`.padStart(2, '0')}`;

        const mi = this._mediaInfo;
        mi.fps = meta.frameRate.fps;
        mi.profile = meta.profile;
        mi.level = meta.level;
        mi.refFrames = 3;  // VP9 uses 3 reference slots (LAST_FRAME, GOLDEN_FRAME, ALTREF_FRAME)
        mi.chromaFormat = chromaSubsampling === 1 ? '4:2:0' : (meta.chromaFormat === 2 ? '4:2:2' : (meta.chromaFormat === 3 ? '4:4:4' : '4:2:0'));
        mi.videoCodec = meta.codec;

        const frameRate = meta.frameRate;
        if (
            frameRate.fixed === false || 
            Number.isNaN(frameRate.fps_num) || 
            Number.isNaN(frameRate.fps_den) || 
            Number.isNaN(frameRate.fps)
        ) {
            meta.frameRate = this._referenceFrameRate;
        }

        const fps_den = meta.frameRate.fps_den;
        const fps_num = meta.frameRate.fps_num;
        meta.refFrameDuration = meta.timescale * (fps_den / fps_num);

        meta.codecWidth = mi.width ?? 0;
        meta.codecHeight = mi.height ?? 0;

        if (mi.hasAudio) {
            if (mi.audioCodec != null) {
                mi.mimeType = 'video/x-flv; codecs="' + mi.videoCodec + ',' + mi.audioCodec + '"';
            }
        } else {
            mi.mimeType = 'video/x-flv; codecs="' + mi.videoCodec + '"';
        }
        if (mi.isComplete()) {
            this._onMediaInfo(mi);
        }
        meta.codecConfig = new Uint8Array(arrayBuffer, dataOffset, dataSize).slice();
        Log.v(FLVDemuxer.TAG, `VP9 codecConfig: ${Array.from(meta.codecConfig).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);

        this._dispatchVideoTrackMetadata(meta);
        Log.v(FLVDemuxer.TAG, `Parsed VP9 codec configuration record: profile=${meta.profile} level=${meta.level}`);
    }

    private _parseVp9FrameData(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number, tagTimestamp: number, tagPosition: number, frameType: VideoFrameType, cts: number, track: VideoTrack) {
        if (this._currentVideoTrackId !== undefined && track.id !== this._currentVideoTrackId) {
            return;
        }
        let length = 0;
        let units: VideoUnit[] = [];
        let dts = this._timestampBase + tagTimestamp;
        const isKeyFrame = (frameType === VideoFrameType.KeyFrame);
        const vp9HeaderInfo: Vp9HeaderInfo = VpxParser.parseVp9Header(new Uint8Array(arrayBuffer, dataOffset, dataSize));

        if (isKeyFrame && vp9HeaderInfo.isValid) {
            const meta = this._videoMetadataByTrackId.get(track.id);
            if (meta) {
                meta.codecWidth = vp9HeaderInfo.width;
                meta.codecHeight = vp9HeaderInfo.height;
                meta.presentWidth = vp9HeaderInfo.renderWidth;
                meta.presentHeight = vp9HeaderInfo.renderHeight;

                // Update SAR ratio (assume 1:1 for now)
                meta.sarRatio = { width: 1, height: 1 };

                const mi = this._mediaInfo;
                mi.width = meta.codecWidth;
                mi.height = meta.codecHeight;
                mi.sarNum = meta.sarRatio.width;
                mi.sarDen = meta.sarRatio.height;

                Log.v(FLVDemuxer.TAG, `VP9 keyframe dimensions: ${meta.codecWidth}x${meta.codecHeight}, render: ${meta.presentWidth}x${meta.presentHeight}`);
            }
        }

        // !!@FIXME: NEEDS Inspect Per OBUs
        // !!@ why are we pushing frame raw data into units? 
        length = dataSize;
        units.push({
            type: isKeyFrame ? Vp9FrameType.KEY_FRAME : Vp9FrameType.INTER_FRAME,
            data: new Uint8Array(arrayBuffer, dataOffset, dataSize)
        });

        const vp9Frame: VideoFrame = {
            units: units,
            length: length,
            isKeyframe: isKeyFrame,
            fileposition: tagPosition,
            dts: dts,
            cts: cts,
            pts: (dts + cts),
            rawData: new Uint8Array(arrayBuffer, dataOffset, dataSize)
        };

        track.frames.push(vp9Frame);
        track.length += length;
    }
}

export default FLVDemuxer;
