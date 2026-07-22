/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Copyright (C) 2016 Bilibili.
 * @author zheng qian <xqq@xqq.im>
 * 
 * Modified and migrated to TypeScript by Slavik Lozben.
 * Additional changes Copyright (C) 2025 Veovera Software Organization.
 *
 * See Git history for full details.
 */

//  MP4 boxes generator for ISO BMFF (ISO Base Media File Format, defined in ISO/IEC 14496-12)
type MP4Metadata = Record<string, any>;
type MP4Track = Record<string, any>;

class MP4 {
    static types: Record<string, number[]>;
    static constants: Record<string, Uint8Array>;

    static init() {
        // NOTE: FourCC codes are exactly 4 chars; MP3 is '.mp3' (leading dot) per ISOBMFF spec, not 'mp3 ' (trailing space)
        MP4.types = {
            avc1: [], avcC: [], btrt: [], dinf: [],
            dref: [], esds: [], ftyp: [], hdlr: [],
            hvc1: [], hvcC: [], av01: [], av1C: [],
            mdat: [], mdhd: [], mdia: [], mfhd: [],
            minf: [], moof: [], moov: [], mp4a: [],
            mvex: [], mvhd: [], sdtp: [], stbl: [],
            stco: [], stsc: [], stsd: [], stsz: [],
            stts: [], tfdt: [], tfhd: [], traf: [],
            trak: [], trun: [], trex: [], tkhd: [],
            vmhd: [], smhd: [], chnl: [],
            '.mp3': [],
            Opus: [], dOps: [], fLaC: [], dfLa: [],
            ipcm: [], pcmC: [],
            'ac-3': [], dac3: [], 'ec-3': [], dec3: [],
            vp08: [], vp09: [], vpcC: [], colr: [],
        };

        for (let name in MP4.types) {
            if (MP4.types.hasOwnProperty(name)) {
                MP4.types[name] = [
                    name.charCodeAt(0),
                    name.charCodeAt(1),
                    name.charCodeAt(2),
                    name.charCodeAt(3)
                ];
            }
        }

        const constants: Record<string, Uint8Array> = MP4.constants = {};

        constants.FTYP = new Uint8Array([
            0x69, 0x73, 0x6F, 0x6D,  // major_brand: isom
            0x00, 0x00, 0x00, 0x01,  // minor_version: 0x01
            0x69, 0x73, 0x6F, 0x6D,  // 'isom'
            0x69, 0x73, 0x6F, 0x36,  // 'iso6'
            0x6D, 0x70, 0x34, 0x31   // 'mp41'
        ]);

        constants.FTYP_AV1 = new Uint8Array([
            0x69, 0x73, 0x6F, 0x6D,  // major_brand: isom
            0x00, 0x00, 0x00, 0x01,  // minor_version: 0x01
            0x69, 0x73, 0x6F, 0x6D,  // 'isom'
            0x69, 0x73, 0x6F, 0x36,  // 'iso6'
            0x61, 0x76, 0x30, 0x31,  // 'av01'
            0x6D, 0x70, 0x34, 0x31   // 'mp41'
        ]);

        constants.FTYP_VP9 = new Uint8Array([
            0x76, 0x70, 0x30, 0x39,  // major_brand: 'vp09'
            0x00, 0x00, 0x00, 0x00,  // minor_version: 0
            0x76, 0x70, 0x30, 0x39,  // 'vp09'
            0x69, 0x73, 0x6F, 0x6D,  // 'isom'
            0x69, 0x73, 0x6F, 0x36,  // 'iso6'
        ]);

        constants.STSD_PREFIX = new Uint8Array([
            0x00, 0x00, 0x00, 0x00,  // version(0) + flags
            0x00, 0x00, 0x00, 0x01   // entry_count
        ]);

        constants.STTS = new Uint8Array([
            0x00, 0x00, 0x00, 0x00,  // version(0) + flags
            0x00, 0x00, 0x00, 0x00   // entry_count
        ]);

        constants.STSC = constants.STCO = constants.STTS;

        constants.STSZ = new Uint8Array([
            0x00, 0x00, 0x00, 0x00,  // version(0) + flags
            0x00, 0x00, 0x00, 0x00,  // sample_size
            0x00, 0x00, 0x00, 0x00   // sample_count
        ]);

        constants.HDLR_VIDEO = new Uint8Array([
            0x00, 0x00, 0x00, 0x00,  // version(0) + flags
            0x00, 0x00, 0x00, 0x00,  // pre_defined
            0x76, 0x69, 0x64, 0x65,  // handler_type: 'vide'
            0x00, 0x00, 0x00, 0x00,  // reserved: 3 * 4 bytes
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x56, 0x69, 0x64, 0x65,
            0x6F, 0x48, 0x61, 0x6E,
            0x64, 0x6C, 0x65, 0x72, 0x00  // name: VideoHandler
        ]);

        constants.HDLR_AUDIO = new Uint8Array([
            0x00, 0x00, 0x00, 0x00,  // version(0) + flags
            0x00, 0x00, 0x00, 0x00,  // pre_defined
            0x73, 0x6F, 0x75, 0x6E,  // handler_type: 'soun'
            0x00, 0x00, 0x00, 0x00,  // reserved: 3 * 4 bytes
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x53, 0x6F, 0x75, 0x6E,
            0x64, 0x48, 0x61, 0x6E,
            0x64, 0x6C, 0x65, 0x72, 0x00  // name: SoundHandler
        ]);

        constants.DREF = new Uint8Array([
            0x00, 0x00, 0x00, 0x00,  // version(0) + flags
            0x00, 0x00, 0x00, 0x01,  // entry_count
            0x00, 0x00, 0x00, 0x0C,  // entry_size
            0x75, 0x72, 0x6C, 0x20,  // type 'url '
            0x00, 0x00, 0x00, 0x01   // version(0) + flags
        ]);

        // Sound media header
        constants.SMHD = new Uint8Array([
            0x00, 0x00, 0x00, 0x00,  // version(0) + flags
            0x00, 0x00, 0x00, 0x00   // balance(2) + reserved(2)
        ]);

        // video media header
        constants.VMHD = new Uint8Array([
            0x00, 0x00, 0x00, 0x01,  // version(0) + flags
            0x00, 0x00,              // graphicsmode: 2 bytes
            0x00, 0x00, 0x00, 0x00,  // opcolor: 3 * 2 bytes
            0x00, 0x00
        ]);
    }

    // Generate a box
    static box(type: ArrayLike<number>, ...datas: Uint8Array[]): Uint8Array {
        let size = 8;
        let result: Uint8Array;
        let arrayCount = datas.length;

        for (let i = 0; i < arrayCount; i++) {
            size += datas[i].byteLength;
        }

        result = new Uint8Array(size);
        result[0] = (size >>> 24) & 0xFF;  // size
        result[1] = (size >>> 16) & 0xFF;
        result[2] = (size >>>  8) & 0xFF;
        result[3] = (size) & 0xFF;

        result.set(type, 4);  // type

        let offset = 8;
        for (let i = 0; i < arrayCount; i++) {  // data body
            result.set(datas[i], offset);
            offset += datas[i].byteLength;
        }

        return result;
    }

    // emit ftyp & moov
    static generateInitSegment(meta: MP4Metadata): Uint8Array {
        let ftypBody = MP4.constants.FTYP;
        if (meta.type === 'video' && meta.codec) {
            if (meta.codec.startsWith('av01')) {
                ftypBody = MP4.constants.FTYP_AV1;
            } else if (meta.codec.startsWith('vp09')) {
                ftypBody = MP4.constants.FTYP_VP9;
            }
        }

        let ftyp = MP4.box(MP4.types.ftyp, ftypBody);
        let moov = MP4.moov(meta);

        let result = new Uint8Array(ftyp.byteLength + moov.byteLength);
        result.set(ftyp, 0);
        result.set(moov, ftyp.byteLength);
        return result;
    }

    // Movie metadata box
    static moov(meta: MP4Metadata): Uint8Array {
        let mvhd = MP4.mvhd(meta.timescale, meta.duration);
        let trak = MP4.trak(meta);
        let mvex = MP4.mvex(meta);
        return MP4.box(MP4.types.moov, mvhd, trak, mvex);
    }

    // Movie header box
    static mvhd(timescale: number, duration: number): Uint8Array {
        return MP4.box(MP4.types.mvhd, new Uint8Array([
            0x00, 0x00, 0x00, 0x00,  // version(0) + flags
            0x00, 0x00, 0x00, 0x00,  // creation_time
            0x00, 0x00, 0x00, 0x00,  // modification_time
            (timescale >>> 24) & 0xFF,  // timescale: 4 bytes
            (timescale >>> 16) & 0xFF,
            (timescale >>>  8) & 0xFF,
            (timescale) & 0xFF,
            (duration >>> 24) & 0xFF,   // duration: 4 bytes
            (duration >>> 16) & 0xFF,
            (duration >>>  8) & 0xFF,
            (duration) & 0xFF,
            0x00, 0x01, 0x00, 0x00,  // Preferred rate: 1.0
            0x01, 0x00, 0x00, 0x00,  // PreferredVolume(1.0, 2bytes) + reserved(2bytes)
            0x00, 0x00, 0x00, 0x00,  // reserved: 4 + 4 bytes
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x01, 0x00, 0x00,  // ----begin composition matrix----
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x01, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x40, 0x00, 0x00, 0x00,  // ----end composition matrix----
            0x00, 0x00, 0x00, 0x00,  // ----begin pre_defined 6 * 4 bytes----
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,  // ----end pre_defined 6 * 4 bytes----
            0xFF, 0xFF, 0xFF, 0xFF   // next_track_ID
        ]));
    }

    // Track box
    static trak(meta: MP4Metadata): Uint8Array {
        return MP4.box(MP4.types.trak, MP4.tkhd(meta), MP4.mdia(meta));
    }

    // Track header box
    static tkhd(meta: MP4Metadata): Uint8Array {
        let trackId = meta.trackId, duration = meta.duration;
        let width = (meta.presentWidth || meta.codecWidth || 0) >>> 0;
        let height = (meta.presentHeight || meta.codecHeight || 0) >>> 0;

        return MP4.box(MP4.types.tkhd, new Uint8Array([
            0x00, 0x00, 0x00, 0x07,  // version(0) + flags
            0x00, 0x00, 0x00, 0x00,  // creation_time
            0x00, 0x00, 0x00, 0x00,  // modification_time
            (trackId >>> 24) & 0xFF,  // track_ID: 4 bytes
            (trackId >>> 16) & 0xFF,
            (trackId >>>  8) & 0xFF,
            (trackId) & 0xFF,
            0x00, 0x00, 0x00, 0x00,  // reserved: 4 bytes
            (duration >>> 24) & 0xFF, // duration: 4 bytes
            (duration >>> 16) & 0xFF,
            (duration >>>  8) & 0xFF,
            (duration) & 0xFF,
            0x00, 0x00, 0x00, 0x00,  // reserved: 2 * 4 bytes
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,  // layer(2bytes) + alternate_group(2bytes)
            0x00, 0x00, 0x00, 0x00,  // volume(2bytes) + reserved(2bytes)
            0x00, 0x01, 0x00, 0x00,  // ----begin composition matrix----
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x01, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x40, 0x00, 0x00, 0x00,  // ----end composition matrix----
            (width >>> 8) & 0xFF,    // width and height
            (width) & 0xFF,
            0x00, 0x00,
            (height >>> 8) & 0xFF,
            (height) & 0xFF,
            0x00, 0x00
        ]));
    }

    // Media Box
    static mdia(meta: MP4Metadata): Uint8Array {
        return MP4.box(MP4.types.mdia, MP4.mdhd(meta), MP4.hdlr(meta), MP4.minf(meta));
    }

    // Media header box
    static mdhd(meta: MP4Metadata): Uint8Array {
        let timescale = meta.timescale;
        let duration = meta.duration;
        return MP4.box(MP4.types.mdhd, new Uint8Array([
            0x00, 0x00, 0x00, 0x00,  // version(0) + flags
            0x00, 0x00, 0x00, 0x00,  // creation_time
            0x00, 0x00, 0x00, 0x00,  // modification_time
            (timescale >>> 24) & 0xFF,  // timescale: 4 bytes
            (timescale >>> 16) & 0xFF,
            (timescale >>>  8) & 0xFF,
            (timescale) & 0xFF,
            (duration >>> 24) & 0xFF,   // duration: 4 bytes
            (duration >>> 16) & 0xFF,
            (duration >>>  8) & 0xFF,
            (duration) & 0xFF,
            0x55, 0xC4,             // language: und (undetermined)
            0x00, 0x00              // pre_defined = 0
        ]));
    }

    // Media handler reference box
    static hdlr(meta: MP4Metadata): Uint8Array {
        let data = null;
        if (meta.type === 'audio') {
            data = MP4.constants.HDLR_AUDIO;
        } else {
            data = MP4.constants.HDLR_VIDEO;
        }
        return MP4.box(MP4.types.hdlr, data);
    }

    // Media infomation box
    static minf(meta: MP4Metadata): Uint8Array {
        let xmhd = null;
        if (meta.type === 'audio') {
            xmhd = MP4.box(MP4.types.smhd, MP4.constants.SMHD);
        } else {
            xmhd = MP4.box(MP4.types.vmhd, MP4.constants.VMHD);
        }
        return MP4.box(MP4.types.minf, xmhd, MP4.dinf(), MP4.stbl(meta));
    }

    // Data infomation box
    static dinf() {
        let result = MP4.box(MP4.types.dinf,
            MP4.box(MP4.types.dref, MP4.constants.DREF)
        );
        return result;
    }

    // Sample table box
    static stbl(meta: MP4Metadata): Uint8Array {
        let result = MP4.box(MP4.types.stbl,  // type: stbl
            MP4.stsd(meta),  // Sample Description Table
            MP4.box(MP4.types.stts, MP4.constants.STTS),  // Time-To-Sample
            MP4.box(MP4.types.stsc, MP4.constants.STSC),  // Sample-To-Chunk
            MP4.box(MP4.types.stsz, MP4.constants.STSZ),  // Sample size
            MP4.box(MP4.types.stco, MP4.constants.STCO)   // Chunk offset
        );
        return result;
    }

    // Sample description box
    static stsd(meta: MP4Metadata): Uint8Array {
        if (meta.type === 'audio') {
            if (meta.codec === 'mp3') {
                return MP4.box(MP4.types.stsd, MP4.constants.STSD_PREFIX, MP4.mp3(meta));
            } else if (meta.codec === 'ac-3') {
                return MP4.box(MP4.types.stsd, MP4.constants.STSD_PREFIX, MP4.ac3(meta));
            } else if (meta.codec === 'ec-3') {
                return MP4.box(MP4.types.stsd, MP4.constants.STSD_PREFIX, MP4.ec3(meta));
            } else if(meta.codec === 'opus') {
                return MP4.box(MP4.types.stsd, MP4.constants.STSD_PREFIX, MP4.Opus(meta));
            } else if (meta.codec == 'flac') {
                return MP4.box(MP4.types.stsd, MP4.constants.STSD_PREFIX, MP4.fLaC(meta));
            } else if (meta.codec == 'ipcm') {
                return MP4.box(MP4.types.stsd, MP4.constants.STSD_PREFIX, MP4.ipcm(meta));
            }
            // else: aac -> mp4a
            return MP4.box(MP4.types.stsd, MP4.constants.STSD_PREFIX, MP4.mp4a(meta));
        } else if (meta.type === 'video' && meta.codec.startsWith('hvc1')) {
            return MP4.box(MP4.types.stsd, MP4.constants.STSD_PREFIX, MP4.hvc1(meta));
        } else if (meta.type === 'video' && meta.codec.startsWith('av01')) {
            return MP4.box(MP4.types.stsd, MP4.constants.STSD_PREFIX, MP4.av01(meta));
        } else if (meta.type === 'video' && meta.codec.startsWith('vp09')) {
            return MP4.box(MP4.types.stsd, MP4.constants.STSD_PREFIX, MP4.vp09(meta));
        } else {
            return MP4.box(MP4.types.stsd, MP4.constants.STSD_PREFIX, MP4.avc1(meta));
        }
    }

    static mp3(meta: MP4Metadata): Uint8Array {
        let channelCount = meta.channelCount;
        let sampleRate = meta.audioSampleRate;

        let data = new Uint8Array([
            0x00, 0x00, 0x00, 0x00,  // reserved(4)
            0x00, 0x00, 0x00, 0x01,  // reserved(2) + data_reference_index(2)
            0x00, 0x00, 0x00, 0x00,  // reserved: 2 * 4 bytes
            0x00, 0x00, 0x00, 0x00,
            0x00, channelCount,      // channelCount(2)
            0x00, 0x10,              // 16 bitsPerSample (2-byte field)
            0x00, 0x00, 0x00, 0x00,  // reserved(4)
            (sampleRate >>> 8) & 0xFF,  // Audio sample rate
            (sampleRate) & 0xFF,
            0x00, 0x00
        ]);

        return MP4.box(MP4.types['.mp3'], data);
    }

    static mp4a(meta: MP4Metadata): Uint8Array {
        // Number of decoded channels written into the MP4 AudioSampleEntry
        // (for example, 2 for stereo, 5 for 5.0, or 6 for 5.1).
        let channelCount = meta.channelCount;

        // Output sampling frequency in Hz, such as 44100 or 48000.
        let sampleRate = meta.audioSampleRate;

        // ISO BMFF AudioSampleEntry payload (28 bytes), excluding the box
        // header and the AAC-specific esds child box added below.
        let data = new Uint8Array([
            0x00, 0x00, 0x00, 0x00,     // reserved: first 4 of 6 bytes
            0x00, 0x00,                 // reserved: final 2 of 6 bytes
            0x00, 0x01,                 // data_reference_index = 1 (unsigned 16-bit, big-endian)

            0x00, 0x00, 0x00, 0x00,     // legacy version/revision fields, unused
            0x00, 0x00, 0x00, 0x00,     // legacy vendor field, unused

            0x00, channelCount,         // channelcount (unsigned 16-bit, big-endian)
            0x00, 0x10,                 // samplesize = 16 decoded bits per sample
            0x00, 0x00,                 // pre_defined = 0
            0x00, 0x00,                 // reserved = 0

            (sampleRate >>> 8) & 0xFF,  // samplerate integer high byte
            sampleRate & 0xFF,          // samplerate integer low byte
            0x00, 0x00                  // 16.16 fixed-point fractional part = 0
        ]);

        // The mp4a payload above describes the decoded audio shape.  esds
        // carries the AAC AudioSpecificConfig (object type, frequency index,
        // and channelConfig/PCE), which must agree with the encoded frames.
        return MP4.box(MP4.types.mp4a, data, MP4.esds(meta));
    }

    static ac3(meta: MP4Metadata): Uint8Array {
        let channelCount = meta.channelCount;
        let sampleRate = meta.audioSampleRate;

        let data = new Uint8Array([
            0x00, 0x00, 0x00, 0x00,  // reserved(4)
            0x00, 0x00, 0x00, 0x01,  // reserved(2) + data_reference_index(2)
            0x00, 0x00, 0x00, 0x00,  // reserved: 2 * 4 bytes
            0x00, 0x00, 0x00, 0x00,
            0x00, channelCount,      // channelCount(2)
            0x00, 0x10,              // 16 bitsPerSample (2-byte field)
            0x00, 0x00, 0x00, 0x00,  // reserved(4)
            (sampleRate >>> 8) & 0xFF,  // Audio sample rate
            (sampleRate) & 0xFF,
            0x00, 0x00
        ]);

        return MP4.box(MP4.types['ac-3'], data, MP4.box(MP4.types.dac3, new Uint8Array(meta.codecConfig)));
    }

    static ec3(meta: MP4Metadata): Uint8Array {
        let channelCount = meta.channelCount;
        let sampleRate = meta.audioSampleRate;

        let data = new Uint8Array([
            0x00, 0x00, 0x00, 0x00,  // reserved(4)
            0x00, 0x00, 0x00, 0x01,  // reserved(2) + data_reference_index(2)
            0x00, 0x00, 0x00, 0x00,  // reserved: 2 * 4 bytes
            0x00, 0x00, 0x00, 0x00,
            0x00, channelCount,      // channelCount(2)
            0x00, 0x10,              // 16 bitsPerSample (2-byte field)
            0x00, 0x00, 0x00, 0x00,  // reserved(4)
            (sampleRate >>> 8) & 0xFF,  // Audio sample rate
            (sampleRate) & 0xFF,
            0x00, 0x00
        ]);

        return MP4.box(MP4.types['ec-3'], data, MP4.box(MP4.types.dec3, new Uint8Array(meta.codecConfig)));
    }

    static esds(meta: MP4Metadata): Uint8Array {
        const config: number[] = Array.from(meta.codecConfig || []);
        let configSize = config.length;
        const descriptorLength = (length: number): number[] => [
            0x80 | ((length >>> 21) & 0x7F),
            0x80 | ((length >>> 14) & 0x7F),
            0x80 | ((length >>> 7) & 0x7F),
            length & 0x7F
        ];
        const decoderSpecificInfoSize = 1 + 4 + configSize;
        const slConfigDescriptorSize = 1 + 4 + 1;
        const decoderConfigDescriptorSize = 13 + decoderSpecificInfoSize;
        const esDescriptorSize = 3 + 1 + 4 + decoderConfigDescriptorSize + slConfigDescriptorSize;
        const bitRate = Math.max(0, Math.trunc(meta.bitRate ?? 0));

        let data = new Uint8Array([
            0x00, 0x00, 0x00, 0x00,  // version 0 + flags

            0x03,                    // descriptor_type
            ... descriptorLength(esDescriptorSize),
            (meta.trackId >>> 8) & 0xFF, // es_id
            meta.trackId & 0xFF,
            0x00,                    // stream_priority

            0x04,                    // descriptor_type
            ... descriptorLength(decoderConfigDescriptorSize),
            0x40,                    // codec: mpeg4_audio
            0x15,                    // stream_type: Audio
            0x00, 0x00, 0x00,        // buffer_size
            (bitRate >>> 24) & 0xFF, // maxBitrate
            (bitRate >>> 16) & 0xFF,
            (bitRate >>> 8) & 0xFF,
            (bitRate) & 0xFF,
            (bitRate >>> 24) & 0xFF, // avgBitrate
            (bitRate >>> 16) & 0xFF,
            (bitRate >>> 8) & 0xFF,
            (bitRate) & 0xFF,

            0x05                     // descriptor_type
        ].concat([
            ... descriptorLength(configSize)
        ]).concat(
            config
        ).concat([
            0x06, ... descriptorLength(0x01), 0x02  // SLConfigDescriptor
        ]));
        return MP4.box(MP4.types.esds, data);
    }

    static Opus(meta: MP4Metadata): Uint8Array {
        let channelCount = meta.channelCount;
        let sampleRate = meta.audioSampleRate;

        let data = new Uint8Array([
            0x00, 0x00, 0x00, 0x00,  // reserved(4)
            0x00, 0x00, 0x00, 0x01,  // reserved(2) + data_reference_index(2)
            0x00, 0x00, 0x00, 0x00,  // reserved: 2 * 4 bytes
            0x00, 0x00, 0x00, 0x00,
            0x00, channelCount, // channelCount(2)
            0x00, 0x10,              // 16 bitsPerSample (2-byte field)
            0x00, 0x00, 0x00, 0x00,  // reserved(4)
            (sampleRate >>> 8) & 0xFF,  // Audio sample rate
            (sampleRate) & 0xFF,
            0x00, 0x00
        ]);

        return MP4.box(MP4.types.Opus, data, MP4.dOps(meta));
    }

    static dOps(meta: MP4Metadata): Uint8Array {
        let channelCount = meta.channelCount;
        let channelConfigCode = meta.channelConfigCode;
        let sampleRate = meta.audioSampleRate;

        if (meta.codecConfig) {
            // Convert from little-endian (Opus native) to big-endian (MP4 required)
            const config = new Uint8Array(meta.codecConfig).slice();
            const dv = new DataView(config.buffer);

            dv.setUint8(0, 0);                              // Version (byte 0) - also required
            dv.setUint16(2, meta.preSkipSamples, false);    // Write big-endian
            dv.setUint32(4, meta.inputSampleRate, false);   // Write big-endian
            dv.setUint16(8, meta.outputGain, false);        // Write big-endian

            return MP4.box(MP4.types.dOps, config);
        }

        let mapping: number[] = [];
        switch (channelConfigCode) {
            case 0x01:
            case 0x02:
                mapping = [0x0];
                break;
            case 0x00: // dualmono
                mapping = [0xFF, 1, 1, 0, 1];
                break;
            case 0x80: // dualmono
                mapping = [0xFF, 2, 0, 0, 1];
                break;
            case 0x03:
                mapping = [0x01, 2, 1, 0, 2, 1];
                break;
            case 0x04:
                mapping = [0x01, 2, 2, 0, 1, 2, 3];
                break;
            case 0x05:
                mapping = [0x01, 3, 2, 0, 4, 1, 2, 3];
                break;
            case 0x06:
                mapping = [0x01, 4, 2, 0, 4, 1, 2, 3, 5];
                break;
            case 0x07:
                mapping = [0x01, 4, 2, 0, 4, 1, 2, 3, 5, 6];
                break;
            case 0x08:
                mapping = [0x01, 5, 3, 0, 6, 1, 2, 3, 4, 5, 7];
                break;
            case 0x82:
                mapping = [0x01, 1, 2, 0, 1];
                break;
            case 0x83:
                mapping = [0x01, 1, 3, 0, 1, 2];
                break;
            case 0x84:
                mapping = [0x01, 1, 4, 0, 1, 2, 3];
                break;
            case 0x85:
                mapping = [0x01, 1, 5, 0, 1, 2, 3, 4];
                break;
            case 0x86:
                mapping = [0x01, 1, 6, 0, 1, 2, 3, 4, 5];
                break;
            case 0x87:
                mapping = [0x01, 1, 7, 0, 1, 2, 3, 4, 5, 6];
                break;
            case 0x88:
                mapping = [0x01, 1, 8, 0, 1, 2, 3, 4, 5, 6, 7];
                break;
        }

        let data = new Uint8Array([
            0x00,         // Version (1)
            channelCount, // OutputChannelCount: 2
            0x00, 0x00,   // PreSkip: 2
            (sampleRate >>> 24) & 0xFF,  // Audio sample rate: 4
            (sampleRate >>> 17) & 0xFF,
            (sampleRate >>>  8) & 0xFF,
            (sampleRate >>>  0) & 0xFF,
            0x00, 0x00,  // Global Gain : 2
            ... mapping
        ]);
        return MP4.box(MP4.types.dOps, data);
    }

    static fLaC(meta: MP4Metadata): Uint8Array {
        let channelCount = meta.channelCount;
        let sampleRate = Math.min(meta.audioSampleRate, 65535);
        let bitsPerSample = meta.bitsPerSample;

        let data = new Uint8Array([
            0x00, 0x00, 0x00, 0x00,     // reserved(4)
            0x00, 0x00, 0x00, 0x01,     // reserved(2) + data_reference_index(2)
            0x00, 0x00, 0x00, 0x00,     // reserved: 2 * 4 bytes
            0x00, 0x00, 0x00, 0x00,     // reserved: 2 * 4 bytes
            0x00, channelCount,         // channelCount(2)
            0x00, (bitsPerSample),      // bitsPerSample (2-byte field)
            0x00, 0x00, 0x00, 0x00,     // reserved(4)
            (sampleRate >>> 8) & 0xFF,  // Audio sample rate
            (sampleRate) & 0xFF,
            0x00, 0x00
        ]);

        return MP4.box(MP4.types.fLaC, data, MP4.dfLa(meta));
    }

    static dfLa(meta: MP4Metadata): Uint8Array {
        let data = new Uint8Array([
            0x00, 0x00, 0x00, 0x00, // version, flag
            ... meta.codecConfig
        ]);
        return MP4.box(MP4.types.dfLa, data);
    }

    static ipcm(meta: MP4Metadata): Uint8Array {
        let channelCount = meta.channelCount;
        let sampleRate = Math.min(meta.audioSampleRate, 65535);
        let bitsPerSample = meta.bitsPerSample;

        let data = new Uint8Array([
            0x00, 0x00, 0x00, 0x00,     // reserved(4)
            0x00, 0x00, 0x00, 0x01,     // reserved(2) + data_reference_index(2)
            0x00, 0x00, 0x00, 0x00,     // reserved: 2 * 4 bytes
            0x00, 0x00, 0x00, 0x00,     // reserved: 2 * 4 bytes
            0x00, channelCount,         // channelCount(2)
            0x00, (bitsPerSample),      // bitsPerSample (2-byte field)
            0x00, 0x00, 0x00, 0x00,     // reserved(4)
            (sampleRate >>> 8) & 0xFF,  // Audio sample rate
            (sampleRate) & 0xFF,
            0x00, 0x00
        ]);

        if (meta.channelCount === 1) {
            return MP4.box(MP4.types.ipcm, data, MP4.pcmC(meta));
        } else {
            return MP4.box(MP4.types.ipcm, data, MP4.chnl(meta), MP4.pcmC(meta));
        }
    }

    static chnl(meta: MP4Metadata): Uint8Array {
        let data = new Uint8Array([
            0x00, 0x00, 0x00, 0x00, // version, flag
            0x01, // Channel Based Layout
            meta.channelCount, // AudioConfiguration
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // omittedChannelsMap
        ]);
        return MP4.box(MP4.types.chnl, data);
    }

    static pcmC(meta: MP4Metadata): Uint8Array {
        let littleEndian = meta.littleEndian ? 0x01 : 0x00
        let bitsPerSample = meta.bitsPerSample;
        let data = new Uint8Array([
            0x00, 0x00, 0x00, 0x00, // version, flag
            littleEndian, bitsPerSample
        ]);
        return MP4.box(MP4.types.pcmC, data);
    }

    static avc1(meta: MP4Metadata): Uint8Array {
        let avcc = meta.codecConfig;
        let width = meta.codecWidth, height = meta.codecHeight;

        let data = new Uint8Array([
            0x00, 0x00, 0x00, 0x00,  // reserved(4)
            0x00, 0x00, 0x00, 0x01,  // reserved(2) + data_reference_index(2)
            0x00, 0x00, 0x00, 0x00,  // pre_defined(2) + reserved(2)
            0x00, 0x00, 0x00, 0x00,  // pre_defined: 3 * 4 bytes
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            (width >>> 8) & 0xFF,    // width: 2 bytes
            (width) & 0xFF,
            (height >>> 8) & 0xFF,   // height: 2 bytes
            (height) & 0xFF,
            0x00, 0x48, 0x00, 0x00,  // horizresolution: 4 bytes
            0x00, 0x48, 0x00, 0x00,  // vertresolution: 4 bytes
            0x00, 0x00, 0x00, 0x00,  // reserved: 4 bytes
            0x00, 0x01,              // frame_count
            0x0A,                    // strlen
            0x78, 0x71, 0x71, 0x2F,  // compressorname: 32 bytes
            0x66, 0x6C, 0x76, 0x2E,
            0x6A, 0x73, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00,
            0x00, 0x18,              // depth
            0xFF, 0xFF               // pre_defined = -1
        ]);
        return MP4.box(MP4.types.avc1, data, MP4.box(MP4.types.avcC, avcc));
    }

    static hvc1(meta: MP4Metadata): Uint8Array {
        let hvcc = meta.codecConfig;
        let width = meta.codecWidth, height = meta.codecHeight;

        let data = new Uint8Array([
            0x00, 0x00, 0x00, 0x00,  // reserved(4)
            0x00, 0x00, 0x00, 0x01,  // reserved(2) + data_reference_index(2)
            0x00, 0x00, 0x00, 0x00,  // pre_defined(2) + reserved(2)
            0x00, 0x00, 0x00, 0x00,  // pre_defined: 3 * 4 bytes
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            (width >>> 8) & 0xFF,    // width: 2 bytes
            (width) & 0xFF,
            (height >>> 8) & 0xFF,   // height: 2 bytes
            (height) & 0xFF,
            0x00, 0x48, 0x00, 0x00,  // horizresolution: 4 bytes
            0x00, 0x48, 0x00, 0x00,  // vertresolution: 4 bytes
            0x00, 0x00, 0x00, 0x00,  // reserved: 4 bytes
            0x00, 0x01,              // frame_count
            0x0A,                    // strlen
            0x78, 0x71, 0x71, 0x2F,  // compressorname: 32 bytes
            0x66, 0x6C, 0x76, 0x2E,
            0x6A, 0x73, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00,
            0x00, 0x18,              // depth
            0xFF, 0xFF               // pre_defined = -1
        ]);
        return MP4.box(MP4.types.hvc1, data, MP4.box(MP4.types.hvcC, hvcc));
    }

    static buildVp9CodecConfig(meta: MP4Metadata): Uint8Array {
        const profile = Number.isFinite(Number(meta.profile)) ? Number(meta.profile) : 0;                                   // 0..3
        const level = Number.isFinite(Number(meta.level)) ? Number(meta.level) : 10;                                        // e.g., 10, 11, 20...
        const bitDepth = Number.isFinite(meta.bitDepth) ? meta.bitDepth : 8;                                                // 8/10/12
        const chromaSubsampling = Number.isFinite(meta.chromaFormat) ? meta.chromaFormat : 1;                               // 0=420 vertical,1=420 colocated,2=422,3=444
        const colorRange = meta.colorRange ? 1 : 0;                                                                         // 0=limited,1=full
        const colourPrimaries = Number.isFinite(meta.colourPrimaries) ? meta.colourPrimaries : 1;                           // 1=BT.709
        const transferCharacteristics = Number.isFinite(meta.transferCharacteristics) ? meta.transferCharacteristics : 1;   // 1=BT.709
        const matrixCoefficients = Number.isFinite(meta.matrixCoefficients) ? meta.matrixCoefficients : 1;                  // 1=BT.709

        return new Uint8Array([
            0x01, 0x00, 0x00, 0x00,             // FullBox: version=1, flags=0
            profile & 0xFF,                     // profile
            level & 0xFF,                       // level
            ((bitDepth & 0x0F) << 4) |
            ((chromaSubsampling & 0x07) << 1) |
            (colorRange & 0x01),                // bitDepth/chromaSubsampling/colorRange packed
            colourPrimaries & 0xFF,             // colourPrimaries
            transferCharacteristics & 0xFF,     // transferCharacteristics
            matrixCoefficients & 0xFF,          // matrixCoefficients
            0x00, 0x00                          // codecInitializationDataSize = 0
        ]);
    }

    // Normalize an incoming VP9 codec config into the 12-byte vpcC FullBox layout:
    //   [0]=version, [1..3]=flags(0), [4]=profile, [5]=level, [6]=packed,
    //   [7]=colourPrimaries, [8]=transferCharacteristics, [9]=matrixCoefficients,
    //   [10..11]=codecInitializationDataSize.
    static normalizeVp9CodecConfig(codecConfig: Uint8Array): Uint8Array | null {
        const VPCC_RECORD_LENGTH = 12; // 4-byte FullBox header + 8-byte record (no init data)
        const vpcc = new Uint8Array(codecConfig);

        // Already a full 12-byte FullBox record.
        if (vpcc.length === VPCC_RECORD_LENGTH) {
            return vpcc;
        }

        // 9-byte ISO form: [version, profile, level, packed, cp, tc, mc, initHi, initLo].
        if (vpcc.length === 9) {
            const expanded = new Uint8Array(VPCC_RECORD_LENGTH);
            expanded[0] = vpcc[0] || 0x01;
            expanded.set(vpcc.subarray(1, 9), 4);
            return expanded;
        }

        // Defensive only: the demuxer rejects records shorter than 9 bytes, so the
        // 8- and 7-byte forms below should never be produced by this pipeline.
        if (vpcc.length === 8) {
            const expanded = new Uint8Array(VPCC_RECORD_LENGTH);
            expanded[0] = 0x01;
            expanded.set(vpcc, 4);
            return expanded;
        }

        if (vpcc.length === 7) {
            const expanded = new Uint8Array(VPCC_RECORD_LENGTH);
            expanded[0] = vpcc[0] || 0x01;
            expanded.set(vpcc.subarray(1, 7), 4);
            return expanded;
        }

        return null;
    }

    static vp09(meta: MP4Metadata): Uint8Array {
        let vpcc = meta.codecConfig
            ? MP4.normalizeVp9CodecConfig(meta.codecConfig)
            : null;
        let width = meta.codecWidth || meta.presentWidth || 192;
        let height = meta.codecHeight || meta.presentHeight || 108;

        if (!vpcc) {
            vpcc = MP4.buildVp9CodecConfig(meta);
        }

        // VisualSampleEntry (same layout as avc1/av01/hvc1)
        let data = new Uint8Array([
            0x00, 0x00, 0x00, 0x00,  // reserved(4)
            0x00, 0x00, 0x00, 0x01,  // reserved(2) + data_reference_index(2)
            0x00, 0x00, 0x00, 0x00,  // pre_defined(2) + reserved(2)
            0x00, 0x00, 0x00, 0x00,  // pre_defined: 3 * 4 bytes
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            (width >>> 8) & 0xFF,    // width: 2 bytes
            (width) & 0xFF,
            (height >>> 8) & 0xFF,   // height: 2 bytes
            (height) & 0xFF,
            0x00, 0x48, 0x00, 0x00,  // horizresolution: 4 bytes
            0x00, 0x48, 0x00, 0x00,  // vertresolution: 4 bytes
            0x00, 0x00, 0x00, 0x00,  // reserved: 4 bytes
            0x00, 0x01,              // frame_count
            0x0A,                    // strlen
            0x78, 0x71, 0x71, 0x2F,  // compressorname: 32 bytes ("xqq/flv.js")
            0x66, 0x6C, 0x76, 0x2E,
            0x6A, 0x73, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00,
            0x00, 0x18,              // depth
            0xFF, 0xFF               // pre_defined = -1
        ]);

        const children = [MP4.box(MP4.types.vpcC, vpcc)];
        const colrBox = MP4.colr(meta);
        if (colrBox) {
            children.push(colrBox);
        }
        return MP4.box(MP4.types.vp09, data, ...children);
    }

    static colr(meta: MP4Metadata): Uint8Array | null {
        const colourPrimaries = meta.colourPrimaries;
        const transferCharacteristics = meta.transferCharacteristics;
        const matrixCoefficients = meta.matrixCoefficients;

        // ISO/MPEG color value 2 means "unspecified". Emitting an nclx colr box
        // with unspecified (or non-finite) values forces a wrong YUV->RGB matrix
        // in some renderers (green shadows / magenta highlights). Omit the box so
        // the decoder applies its own default, matching the WebM path and the
        // prior MP4 behavior.
        const isSpecified = (v: number) => Number.isFinite(v) && v !== 2;
        if (
            !isSpecified(colourPrimaries) ||
            !isSpecified(transferCharacteristics) ||
            !isSpecified(matrixCoefficients)
        ) {
            return null;
        }

        const fullRangeFlag = meta.colorRange ? 0x80 : 0x00;
        const data = new Uint8Array([
            0x6E, 0x63, 0x6C, 0x78,  // colour_type: 'nclx'
            (colourPrimaries >>> 8) & 0xFF,
            (colourPrimaries) & 0xFF,
            (transferCharacteristics >>> 8) & 0xFF,
            (transferCharacteristics) & 0xFF,
            (matrixCoefficients >>> 8) & 0xFF,
            (matrixCoefficients) & 0xFF,
            fullRangeFlag
        ]);

        return MP4.box(MP4.types.colr, data);
    }

    static av01(meta: MP4Metadata): Uint8Array {
        let av1c = meta.codecConfig;
        let width = meta.codecWidth || 192, height = meta.codecHeight || 108;

        let data = new Uint8Array([
            0x00, 0x00, 0x00, 0x00,  // reserved(4)
            0x00, 0x00, 0x00, 0x01,  // reserved(2) + data_reference_index(2)
            0x00, 0x00, 0x00, 0x00,  // pre_defined(2) + reserved(2)
            0x00, 0x00, 0x00, 0x00,  // pre_defined: 3 * 4 bytes
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            (width >>> 8) & 0xFF,    // width: 2 bytes
            (width) & 0xFF,
            (height >>> 8) & 0xFF,   // height: 2 bytes
            (height) & 0xFF,
            0x00, 0x48, 0x00, 0x00,  // horizresolution: 4 bytes
            0x00, 0x48, 0x00, 0x00,  // vertresolution: 4 bytes
            0x00, 0x00, 0x00, 0x00,  // reserved: 4 bytes
            0x00, 0x01,              // frame_count
            0x0A,                    // strlen
            0x78, 0x71, 0x71, 0x2F,  // compressorname: 32 bytes
            0x66, 0x6C, 0x76, 0x2E,
            0x6A, 0x73, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00,
            0x00, 0x18,              // depth
            0xFF, 0xFF               // pre_defined = -1
        ]);
        return MP4.box(MP4.types.av01, data, MP4.box(MP4.types.av1C, av1c));
    }

    // Movie Extends box
    static mvex(meta: MP4Metadata): Uint8Array {
        return MP4.box(MP4.types.mvex, MP4.trex(meta));
    }

    // Track Extends box
    static trex(meta: MP4Metadata): Uint8Array {
        let trackId = meta.trackId;
        let data = new Uint8Array([
            0x00, 0x00, 0x00, 0x00,  // version(0) + flags
            (trackId >>> 24) & 0xFF, // track_ID
            (trackId >>> 16) & 0xFF,
            (trackId >>>  8) & 0xFF,
            (trackId) & 0xFF,
            0x00, 0x00, 0x00, 0x01,  // default_sample_description_index
            0x00, 0x00, 0x00, 0x00,  // default_sample_duration
            0x00, 0x00, 0x00, 0x00,  // default_sample_size
            0x00, 0x01, 0x00, 0x01   // default_sample_flags
        ]);
        return MP4.box(MP4.types.trex, data);
    }

    // Movie fragment box
    static moof(track: MP4Track, baseMediaDecodeTime: number): Uint8Array {
        return MP4.box(MP4.types.moof, MP4.mfhd(track.sequenceNumber), MP4.traf(track, baseMediaDecodeTime));
    }

    static mfhd(sequenceNumber: number): Uint8Array {
        let data = new Uint8Array([
            0x00, 0x00, 0x00, 0x00,
            (sequenceNumber >>> 24) & 0xFF,  // sequence_number: int32
            (sequenceNumber >>> 16) & 0xFF,
            (sequenceNumber >>>  8) & 0xFF,
            (sequenceNumber) & 0xFF
        ]);
        return MP4.box(MP4.types.mfhd, data);
    }

    // Track fragment box
    static traf(track: MP4Track, baseMediaDecodeTime: number): Uint8Array {
        let trackId = track.id;

        // Track fragment header box
        let tfhd = MP4.box(MP4.types.tfhd, new Uint8Array([
            0x00, 0x00, 0x00, 0x00,  // version(0) & flags
            (trackId >>> 24) & 0xFF, // track_ID
            (trackId >>> 16) & 0xFF,
            (trackId >>>  8) & 0xFF,
            (trackId) & 0xFF
        ]));
        // Track Fragment Decode Time
        let tfdt = MP4.box(MP4.types.tfdt, new Uint8Array([
            0x00, 0x00, 0x00, 0x00,  // version(0) & flags
            (baseMediaDecodeTime >>> 24) & 0xFF,  // baseMediaDecodeTime: int32
            (baseMediaDecodeTime >>> 16) & 0xFF,
            (baseMediaDecodeTime >>>  8) & 0xFF,
            (baseMediaDecodeTime) & 0xFF
        ]));
        let sdtp = MP4.sdtp(track);
        let trun = MP4.trun(track, sdtp.byteLength + 16 + 16 + 8 + 16 + 8 + 8);

        return MP4.box(MP4.types.traf, tfhd, tfdt, trun, sdtp);
    }

    // Sample Dependency Type box
    static sdtp(track: MP4Track): Uint8Array {
        let frames = track.frames || [];
        let frameCount = frames.length;
        let data = new Uint8Array(4 + frameCount);
        // 0~4 bytes: version(0) & flags
        for (let i = 0; i < frameCount; i++) {
            let flags = frames[i].flags;
            data[i + 4] = (flags.isLeading << 6)    // is_leading: 2 (bit)
                        | (flags.dependsOn << 4)    // sample_depends_on
                        | (flags.isDependedOn << 2) // sample_is_depended_on
                        | (flags.hasRedundancy);    // sample_has_redundancy
        }
        return MP4.box(MP4.types.sdtp, data);
    }

    // Track fragment run box
    static trun(track: MP4Track, offset: number): Uint8Array {
        let frames = track.frames || [];
        let frameCount = frames.length;
        let hasCompositionOffsets = false;
        for (let i = 0; i < frameCount; i++) {
            if (frames[i].cts !== 0) {
                hasCompositionOffsets = true;
                break;
            }
        }

        let sampleFieldBytes = hasCompositionOffsets ? 16 : 12;
        let dataSize = 12 + sampleFieldBytes * frameCount;
        let data = new Uint8Array(dataSize);
        offset += 8 + dataSize;

        let trunFlags = hasCompositionOffsets ? 0x00000F01 : 0x00000701;

        data.set([
            (trunFlags >>> 24) & 0xFF,   // version(0) & flags
            (trunFlags >>> 16) & 0xFF,
            (trunFlags >>>  8) & 0xFF,
            (trunFlags) & 0xFF,
            (frameCount >>> 24) & 0xFF,
            (frameCount >>> 16) & 0xFF,
            (frameCount >>>  8) & 0xFF,
            (frameCount) & 0xFF,
            (offset >>> 24) & 0xFF,      // data_offset
            (offset >>> 16) & 0xFF,
            (offset >>>  8) & 0xFF,
            (offset) & 0xFF
        ], 0);

        for (let i = 0; i < frameCount; i++) {
            let duration = frames[i].duration;
            let size = frames[i].size;
            let flags = frames[i].flags;
            let cts = frames[i].cts;
            let sampleData = [
                (duration >>> 24) & 0xFF,  // sample_duration
                (duration >>> 16) & 0xFF,
                (duration >>>  8) & 0xFF,
                (duration) & 0xFF,
                (size >>> 24) & 0xFF,      // sample_size
                (size >>> 16) & 0xFF,
                (size >>>  8) & 0xFF,
                (size) & 0xFF,
                (flags.isLeading << 2) | flags.dependsOn,  // sample_flags
                (flags.isDependedOn << 6) | (flags.hasRedundancy << 4) | flags.isNonSync,
                0x00, 0x00                 // sample_degradation_priority
            ];

            if (hasCompositionOffsets) {
                sampleData.push(
                    (cts >>> 24) & 0xFF,   // sample_composition_time_offset
                    (cts >>> 16) & 0xFF,
                    (cts >>>  8) & 0xFF,
                    (cts) & 0xFF
                );
            }

            data.set(sampleData, 12 + sampleFieldBytes * i);
        }
        return MP4.box(MP4.types.trun, data);
    }

    static mdat(data: Uint8Array): Uint8Array {
        return MP4.box(MP4.types.mdat, data);
    }

}

MP4.init();

export default MP4;
