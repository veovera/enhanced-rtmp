/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Slavik Lozben.
 * Additional changes Copyright (C) 2025 Veovera Software Organization.
 *
 * See Git history for full details.
 */

import Log from "../utils/logger";
import ExpGolomb from "./exp-golomb";
import { MPEG4AudioObjectTypes, MPEG4SamplingRates, MPEG4SamplingRateIndex } from "./mpeg4-audio";

/**
 * Decoded representation of a single AAC audio frame, produced by
 * AACADTSParser or AACLOASParser.  Carries the codec parameters extracted
 * from the transport header alongside the raw AAC payload bytes.
 */
export class AACFrame {
    // chose sane defaults
    audio_object_type: MPEG4AudioObjectTypes = MPEG4AudioObjectTypes.kAAC_LC;
    sampling_freq_index: MPEG4SamplingRateIndex = MPEG4SamplingRateIndex.k44100Hz;
    sampling_frequency: number = MPEG4SamplingRates[MPEG4SamplingRateIndex.k44100Hz];
    channel_config: number = 2;

    data: Uint8Array = new Uint8Array();

    /**
     * Optionally accepts a raw ISO 14496-3 AudioSpecificConfig blob.
     * When provided the first two bytes are parsed to populate all fields:
     *
     *   bits [15:11] — audioObjectType       (5 bits)
     *   bits [10:7]  — samplingFrequencyIndex (4 bits)
     *   bits  [6:3]  — channelConfiguration  (4 bits)
     *
     * When called with no arguments the fields keep their sane defaults
     * (AAC-LC, 44100 Hz, stereo) so ADTS/LOAS parsers can fill them in
     * incrementally.
     */
    constructor(data?: Uint8Array) {
        if (data === undefined || data.byteLength < 2) {
            if (data !== undefined) this.data = data;
            return;
        }
        this.data = data;
        this.audio_object_type = (data[0] >>> 3) as MPEG4AudioObjectTypes;
        this.sampling_freq_index = (((data[0] & 0x07) << 1) | (data[1] >>> 7)) as MPEG4SamplingRateIndex;
        this.sampling_frequency = MPEG4SamplingRates[this.sampling_freq_index] ?? 0;
        this.channel_config = (data[1] & 0x78) >>> 3;
    }
}

/**
 * AACFrame extended with the `other_data_present` flag decoded from a LOAS
 * StreamMuxConfig.  When true the stream carries auxiliary data (e.g. SBR/PS
 * backward-compatible extension) after the primary payload.
 */
export class LOASAACFrame extends AACFrame {
    other_data_present: boolean = false;
}

/**
 * Parses a buffer of raw ADTS-framed AAC audio data, yielding one AACFrame
 * per call to readNextAACFrame().
 *
 * ADTS (Audio Data Transport Stream) frame layout (ISO 13818-7 §6.2):
 *
 *   Byte  Bits  Field
 *   ----  ----  -----
 *   0     [7:0]  syncword[11:4]           — always 0xFFF
 *   1     [7]    syncword[3:0] (cont)     — always 1
 *   1     [3]    ID                       — 0=MPEG-4, 1=MPEG-2
 *   1     [2:1]  layer                    — always 00
 *   1     [0]    protection_absent        — 1=no CRC, 0=CRC present
 *   2     [7:6]  profile_ObjectType       — audio object type − 1
 *   2     [5:2]  sampling_frequency_index — index into MPEG-4 freq table
 *   2     [1]    private_bit
 *   2     [0]    channel_configuration[2] — MSB of 3-bit channel config
 *   3     [7:6]  channel_configuration[1:0]
 *   3     [5]    originality/copy
 *   3     [4]    home
 *   3     [3]    copyright_id_bit
 *   3     [2]    copyright_id_start
 *   3     [1:0]  aac_frame_length[12:11]  — total frame size incl. header
 *   4     [7:0]  aac_frame_length[10:3]
 *   5     [7:5]  aac_frame_length[2:0]
 *   5     [4:0]  adts_buffer_fullness (ignored)
 *   6     [1:0]  number_of_raw_data_blocks_in_frame
 *   [7-8]        CRC16 (only when protection_absent === 0)
 */
export class AACADTSParser {

    private readonly TAG: string = "AACADTSParser";

    private data_: Uint8Array;
    private current_syncword_offset_: number;
    private eof_flag_: boolean = false;
    private has_last_incomplete_data: boolean = false;

    public constructor(data: Uint8Array) {
        this.data_ = data;
        this.current_syncword_offset_ = this.findNextSyncwordOffset(0);
    }

    /**
     * Scans forward from syncword_offset to find the next valid ADTS syncword
     * (12-bit 0xFFF).  Sets eof_flag_ and returns data.byteLength when fewer
     * than 7 bytes remain (minimum ADTS header size).
     */
    private findNextSyncwordOffset(syncword_offset: number): number {
        let i = syncword_offset;
        let data = this.data_;

        while (true) {
            if (i + 7 >= data.byteLength) {
                this.eof_flag_ = true;
                return data.byteLength;
            }

            // search 12-bit 0xFFF syncword
            let syncword = ((data[i + 0] << 8) | data[i + 1]) >>> 4;
            if (syncword === 0xFFF) {
                return i;
            } else {
                i++;
            }
        }
    }

    /**
     * Decodes and returns the next ADTS frame as an AACFrame, advancing the
     * internal read position.  Returns null at end-of-buffer or on truncated
     * input (check hasIncompleteData() in that case).
     */
    public readNextAACFrame(): AACFrame | null {
        let data = this.data_;
        let aac_frame: AACFrame | null = null;

        while (aac_frame == null) {
            if (this.eof_flag_) {
                break;
            }

            let syncword_offset = this.current_syncword_offset_;
            let offset = syncword_offset;

            // adts_fixed_header() — byte 1 fields (syncword already verified)
            let ID = (data[offset + 1] & 0x08) >>> 3;               // 0=MPEG-4, 1=MPEG-2
            let layer = (data[offset + 1] & 0x06) >>> 1;            // must be 0
            let protection_absent = data[offset + 1] & 0x01;        // 1=no CRC
            let profile = (data[offset + 2] & 0xC0) >>> 6;          // audio object type − 1
            let sampling_frequency_index = (data[offset + 2] & 0x3C) >>> 2;
            // channel_configuration spans bytes 2–3 (1 bit + 2 bits)
            let channel_configuration = ((data[offset + 2] & 0x01) << 2)
                                        | ((data[offset + 3] & 0xC0) >>> 6);

            // adts_variable_header() — aac_frame_length spans bytes 3–5 (13 bits total)
            let aac_frame_length = ((data[offset + 3] & 0x03) << 11)
                                    | (data[offset + 4] << 3)
                                    | ((data[offset + 5] & 0xE0) >>> 5);
            let number_of_raw_data_blocks_in_frame = data[offset + 6] & 0x03;

            if (offset + aac_frame_length > this.data_.byteLength) {
                // data not enough for extracting last sample
                this.eof_flag_ = true;
                this.has_last_incomplete_data = true;
                break;
            }

            // Header is 7 bytes without CRC, 9 bytes with CRC
            let adts_header_length = (protection_absent === 1) ? 7 : 9;
            let adts_frame_payload_length = aac_frame_length - adts_header_length;

            offset += adts_header_length;

            let next_syncword_offset = this.findNextSyncwordOffset(offset + adts_frame_payload_length);
            this.current_syncword_offset_ = next_syncword_offset;

            if ((ID !== 0 && ID !== 1) || layer !== 0) {
                // invalid adts frame ?
                continue;
            }

            let frame_data = data.subarray(offset, offset + adts_frame_payload_length);

            aac_frame = new AACFrame();
            aac_frame.audio_object_type = (profile + 1) as MPEG4AudioObjectTypes;
            aac_frame.sampling_freq_index = sampling_frequency_index as MPEG4SamplingRateIndex;
            aac_frame.sampling_frequency = MPEG4SamplingRates[sampling_frequency_index];
            aac_frame.channel_config = channel_configuration;
            aac_frame.data = frame_data;
        }

        return aac_frame;
    }

    public hasIncompleteData(): boolean {
        return this.has_last_incomplete_data;
    }

    public getIncompleteData(): Uint8Array | null {
        if (!this.has_last_incomplete_data) {
            return null;
        }

        return this.data_.subarray(this.current_syncword_offset_);
    }
}


/**
 * Parses a buffer of LOAS (Low Overhead Audio Stream) / LATM-framed AAC audio,
 * yielding one LOASAACFrame per call to readNextAACFrame().
 *
 * LOAS wraps LATM (Low-overhead MPEG-4 Audio Transport Multiplex) inside a
 * simple 3-byte envelope (ISO 14496-3 §1.7.3 / §1.7.4):
 *
 *   Byte  Bits   Field
 *   ----  -----  -----
 *   0     [7:0]  syncword[10:3]        — always 0x2B7 (11-bit value 0x2B7)
 *   1     [7:5]  syncword[2:0] (cont)
 *   1     [4:0]  audioMuxLengthBytes[12:8]  — payload length in bytes (13-bit)
 *   2     [7:0]  audioMuxLengthBytes[7:0]
 *
 * Immediately following the 3-byte header is AudioMuxElement(1) of exactly
 * audioMuxLengthBytes bytes:
 *
 *   useSameStreamMux  (1 bit)
 *     0 → StreamMuxConfig() follows:
 *           audioMuxVersion         (1 bit)  — 0 in practice
 *           audioMuxVersionA        (1 bit, if audioMuxVersion) — unsupported
 *           [if audioMuxVersion] taraBufferFullness (getLATMValue)
 *           allStreamsSameTimeFraming (1 bit) — must be 1
 *           numSubFrames            (6 bits) — must be 0
 *           numProgram              (4 bits) — must be 0
 *           numLayer                (3 bits) — must be 0
 *           AudioSpecificConfig (simplified, for program 0 layer 0):
 *             [if audioMuxVersion] ascLen = getLATMValue; fillBits = ascLen
 *             audio_object_type     (5 bits)
 *             sampling_freq_index   (4 bits)
 *             channel_config        (4 bits)
 *             GASpecificConfig      (3 bits, partial read)
 *             [if fillBits > 0]     skip remaining fill bits
 *           frameLengthType         (3 bits) — must be 0
 *           [if 0] latmBufferFullness (1 byte, ignored)
 *           otherDataPresent        (1 bit)
 *           [if otherDataPresent && !audioMuxVersion] escaped length bytes
 *           crcCheckPresent         (1 bit)
 *           [if crcCheckPresent] crcCheckSum (1 byte, ignored)
 *     1 → reuse previous StreamMuxConfig (caller passes it via `previous`)
 *
 *   PayloadLengthInfo()  — escaped-length encoding:
 *     length = 0
 *     do { tmp = readByte(); length += tmp; } while (tmp === 0xFF)
 *
 *   PayloadMux()  — length bytes of raw AAC payload
 */
export class AACLOASParser {

    private readonly TAG: string = "AACLOASParser";

    private data_: Uint8Array;
    private current_syncword_offset_: number;
    private eof_flag_: boolean = false;
    private has_last_incomplete_data: boolean = false;

    public constructor(data: Uint8Array) {
        this.data_ = data;
        this.current_syncword_offset_ = this.findNextSyncwordOffset(0);
        if (this.eof_flag_) {
            Log.e(this.TAG, `Could not found LOAS syncword until payload end`);
        }
    }

    /**
     * Scans forward from syncword_offset to find the next 11-bit LOAS syncword
     * (0x2B7, occupying bits [15:5] of a 2-byte word).  Sets eof_flag_ and
     * returns data.byteLength when fewer than 2 bytes remain.
     */
    private findNextSyncwordOffset(syncword_offset: number): number {
        let i = syncword_offset;
        let data = this.data_;

        while (true) {
            if (i + 1 >= data.byteLength) {
                this.eof_flag_ = true;
                return data.byteLength;
            }

            // search 12-bit 0xFFF syncword
            let syncword = (data[i + 0] << 3) | (data[i + 1] >>> 5);
            if (syncword === 0x2B7) {
                return i;
            } else {
                i++;
            }
        }
    }

    /**
     * Reads a LATM value: a (bytesForValue+1)-byte big-endian integer, where
     * bytesForValue is a 2-bit prefix field (ISO 14496-3 §1.7.3 Table 1.42).
     * Used to read taraBufferFullness and ascLen when audioMuxVersion === 1.
     */
    private getLATMValue(gb: ExpGolomb) {
        let bytesForValue = gb.readBits(2);
        let value = 0;
        for (let i = 0; i <= bytesForValue; i++) {
            value = value << 8;
            value = value | gb.readByte();
        }
        return value;
    }

    /**
     * Decodes and returns the next LOAS frame as a LOASAACFrame, advancing the
     * internal read position.  Pass the previously returned frame as `privious`
     * so that useSameStreamMux=1 frames can reuse the last StreamMuxConfig.
     * Returns null at end-of-buffer, on truncated input, or on unsupported
     * stream configurations (check hasIncompleteData() for truncation).
     */
    public readNextAACFrame(privious?: LOASAACFrame): LOASAACFrame | null {
        let data = this.data_;
        let aac_frame: LOASAACFrame | null = null;

        while (aac_frame == null) {
            if (this.eof_flag_) {
                break;
            }

            let syncword_offset = this.current_syncword_offset_;
            let offset = syncword_offset;

            let audioMuxLengthBytes = ((data[offset + 1] & 0x1F) << 8) | data[offset + 2];
            if (offset + 3 + audioMuxLengthBytes >= this.data_.byteLength) {
                // data not enough for extracting last sample
                this.eof_flag_ = true;
                this.has_last_incomplete_data = true;
                break;
            }

            // AudioMuxElement(1) — 3-byte LOAS header already consumed above
            let gb = new ExpGolomb(data.subarray(offset + 3, offset + 3 + audioMuxLengthBytes));
            let useSameStreamMux = gb.readBool(); // 1 = reuse previous StreamMuxConfig
            let streamMuxConfig: LOASAACFrame | null = null;
            if (!useSameStreamMux) {
                let audioMuxVersion = gb.readBool();
                let audioMuxVersionA = audioMuxVersion && gb.readBool();
                if (audioMuxVersionA) {
                    Log.e(this.TAG, 'audioMuxVersionA is Not Supported');
                    gb.destroy();
                    break;
                }
                if (audioMuxVersion) {
                    this.getLATMValue(gb);
                }
                let allStreamsSameTimeFraming = gb.readBool();
                if (!allStreamsSameTimeFraming) {
                    Log.e(this.TAG, 'allStreamsSameTimeFraming zero is Not Supported');
                    gb.destroy();
                    break;
                }
                let numSubFrames = gb.readBits(6);
                if (numSubFrames !== 0) {
                    Log.e(this.TAG, 'more than 2 numSubFrames Not Supported');
                    gb.destroy();
                    break;
                }
                let numProgram = gb.readBits(4);
                if (numProgram !== 0) {
                    Log.e(this.TAG, 'more than 2 numProgram Not Supported');
                    gb.destroy();
                    break;
                }
                let numLayer = gb.readBits(3);
                if (numLayer !== 0) {
                    Log.e(this.TAG, 'more than 2 numLayer Not Supported');
                    gb.destroy();
                    break;
                }

                let fillBits = audioMuxVersion ? this.getLATMValue(gb) : 0;
                let audio_object_type = gb.readBits(5); fillBits -= 5;
                let sampling_freq_index = gb.readBits(4);fillBits -= 4;
                let channel_config = gb.readBits(4); fillBits -= 4;
                gb.readBits(3); fillBits -= 3; // GA Specfic Config
                if (fillBits > 0) { gb.readBits(fillBits); }

                let frameLengthType = gb.readBits(3);
                if (frameLengthType === 0) {
                    gb.readByte();
                } else {
                    Log.e(this.TAG, `frameLengthType = ${frameLengthType}. Only frameLengthType = 0 Supported`);
                    gb.destroy();
                    break;
                }

                let otherDataPresent = gb.readBool();
                if (otherDataPresent) {
                    if (audioMuxVersion) {
                        this.getLATMValue(gb);
                    } else {
                        let otherDataLenBits = 0;
                        while (true) {
                            otherDataLenBits = otherDataLenBits << 8;
                            let otherDataLenEsc = gb.readBool();
                            let otherDataLenTmp = gb.readByte();
                            otherDataLenBits += otherDataLenTmp
                            if (!otherDataLenEsc) { break; }
                        }
                        console.log(otherDataLenBits)
                    }
                }

                let crcCheckPresent = gb.readBool();
                if (crcCheckPresent) {
                    gb.readByte();
                }

                streamMuxConfig = new LOASAACFrame();
                streamMuxConfig.audio_object_type = audio_object_type;
                streamMuxConfig.sampling_freq_index = sampling_freq_index;
                streamMuxConfig.sampling_frequency = MPEG4SamplingRates[streamMuxConfig.sampling_freq_index];
                streamMuxConfig.channel_config = channel_config;
                streamMuxConfig.other_data_present = otherDataPresent;
            } else if (privious == null) {
                Log.w(this.TAG, 'StreamMuxConfig Missing')
                this.current_syncword_offset_ = this.findNextSyncwordOffset(offset + 3 + audioMuxLengthBytes);
                gb.destroy();
                continue;
            } else {
                streamMuxConfig = privious;
            }

            let length = 0;
            while (true) {
                let tmp = gb.readByte();
                length += tmp;
                if (tmp !== 0xFF) { break; }
            }

            let aac_data = new Uint8Array(length);
            for (let i = 0; i < length; i++) {
                aac_data[i] = gb.readByte();
            }

            aac_frame = new LOASAACFrame();
            aac_frame.audio_object_type = (streamMuxConfig.audio_object_type) as MPEG4AudioObjectTypes;
            aac_frame.sampling_freq_index = (streamMuxConfig.sampling_freq_index) as MPEG4SamplingRateIndex;
            aac_frame.sampling_frequency = MPEG4SamplingRates[streamMuxConfig.sampling_freq_index];
            aac_frame.channel_config = streamMuxConfig.channel_config;
            aac_frame.other_data_present = streamMuxConfig.other_data_present;
            aac_frame.data = aac_data;

            this.current_syncword_offset_ = this.findNextSyncwordOffset(offset + 3 + audioMuxLengthBytes);
        }

        return aac_frame;
    }

    public hasIncompleteData(): boolean {
        return this.has_last_incomplete_data;
    }

    public getIncompleteData(): Uint8Array | null {
        if (!this.has_last_incomplete_data) {
            return null;
        }

        return this.data_.subarray(this.current_syncword_offset_);
    }
}


/**
 * Synthesises a 2- or 4-byte ISO 14496-3 AudioSpecificConfig from a decoded
 * AACFrame, applying browser-specific codec profile workarounds:
 *
 *   Firefox  — uses HE-AAC (SBR, object type 5) for low sample rates
 *              (samplingIndex >= 6), LC-AAC otherwise.
 *   Android  — always uses LC-AAC (object type 2).
 *   Others   — prefers HE-AAC for stereo+; falls back to LC-AAC for mono.
 *
 * AudioSpecificConfig bit layout (ISO 14496-3 §1.6.5.1):
 *
 *   Bits  Field
 *   ----  -----
 *   5     audioObjectType
 *   4     samplingFrequencyIndex
 *   4     channelConfiguration
 *   [HE-AAC only, 6 more bits]
 *   4     extensionSamplingFrequencyIndex
 *   5     extensionAudioObjectType  (forced to 2 = LC)
 *   1     (padding)
 *
 * The resulting `config` array is suitable for use directly in an MPEG-4
 * esds DecoderSpecificInfo box.
 */
export class AudioSpecificConfig {

    public config: Array<number>;
    public sampling_rate: number;
    public channel_count: number;
    public codec_mimetype: string;
    public original_codec_mimetype: string;

    public constructor(frame: AACFrame) {
        let config: Array<number>;

        let original_audio_object_type = frame.audio_object_type;
        let audio_object_type = frame.audio_object_type;
        let sampling_index = frame.sampling_freq_index;
        let channel_config = frame.channel_config;
        let extension_sampling_index = 0;

        let userAgent = navigator.userAgent.toLowerCase();

        if (userAgent.indexOf('firefox') !== -1) {
            // firefox: use SBR (HE-AAC) if freq less than 24kHz
            if (sampling_index >= 6) {
                audio_object_type = MPEG4AudioObjectTypes.kAAC_SBR;
                config = new Array(4);
                extension_sampling_index = sampling_index - 3;
            } else {  // use LC-AAC
                audio_object_type = MPEG4AudioObjectTypes.kAAC_LC;
                config = new Array(2);
                extension_sampling_index = sampling_index;
            }
        } else if (userAgent.indexOf('android') !== -1) {
            // android: always use LC-AAC
            audio_object_type = MPEG4AudioObjectTypes.kAAC_LC;
            config = new Array(2);
            extension_sampling_index = sampling_index;
        } else {
            // for other browsers, e.g. chrome...
            // Always use HE-AAC to make it easier to switch aac codec profile
            audio_object_type = MPEG4AudioObjectTypes.kAAC_SBR;
            extension_sampling_index = sampling_index;
            config = new Array(4);

            if (sampling_index >= 6) {
                extension_sampling_index = sampling_index - 3;
            }
        }

        config[0]  = audio_object_type << 3;
        config[0] |= (sampling_index & 0x0F) >>> 1;
        config[1]  = (sampling_index & 0x0F) << 7;
        config[1] |= (channel_config & 0x0F) << 3;
        if (audio_object_type === MPEG4AudioObjectTypes.kAAC_SBR) {
            config[1] |= ((extension_sampling_index & 0x0F) >>> 1);
            config[2]  = (extension_sampling_index & 0x01) << 7;
            // extended audio object type: force to 2 (LC-AAC)
            config[2] |= (2 << 2);
            config[3]  = 0;
        }

        this.config = config;
        this.sampling_rate = MPEG4SamplingRates[sampling_index];
        this.channel_count = channel_config;
        this.codec_mimetype = 'mp4a.40.' + audio_object_type;
        this.original_codec_mimetype = 'mp4a.40.' + original_audio_object_type;
    }
}
