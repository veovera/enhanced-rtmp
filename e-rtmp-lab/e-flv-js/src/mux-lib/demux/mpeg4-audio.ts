export enum MPEG4AudioObjectTypes {
    kNull = 0,
    kAAC_Main,          // 1
    kAAC_LC,            // 2  LC-AAC
    kAAC_SSR,           // 3  Scalable Sample Rate
    kAAC_LTP,           // 4  Long Term Prediction
    kAAC_SBR,           // 5  HE-AAC / Spectral Band Replication
    kAAC_Scalable,      // 6
    kTwinVQ,            // 7
    kCELP,              // 8
    kHVXC,              // 9
    // 10, 11: reserved
    kTTSI = 12,         // 12  Text-To-Speech Interface
    kMainSynthetic,     // 13
    kWavetableSynthesis,// 14
    kGeneralMIDI,       // 15
    kAlgorithmicSynthesis, // 16
    kER_AAC_LC,         // 17  Error Resilient AAC LC
    // 18: reserved
    kER_AAC_LTP = 19,   // 19
    kER_AAC_Scalable,   // 20
    kER_TwinVQ,         // 21
    kER_BSAC,           // 22
    kER_AAC_LD,         // 23  Error Resilient AAC Low Delay
    kER_CELP,           // 24
    kER_HVXC,           // 25
    kER_HILN,           // 26
    kER_Parametric,     // 27
    kSSC,               // 28  SinuSoidal Coding
    kAAC_PS,            // 29  HE-AACv2 / Parametric Stereo
    kMPEGSurround,      // 30
    // 31: escape value (signals audioObjectType extension to ≥32)
    kLayer1 = 32,       // 32  MPEG-1/2 Audio Layer I
    kLayer2,            // 33  MPEG-1/2 Audio Layer II
    kLayer3,            // 34  MPEG-1/2 Audio Layer III (MP3)
    kDST,               // 35  Direct Stream Transfer
    kALS,               // 36  Audio Lossless Coding
    kSLS,               // 37  Scalable Lossless Coding
    kSLS_NonCore,       // 38
    kER_AAC_ELD,        // 39  Enhanced Low Delay
    kSMR_Simple,        // 40
    kSMR_Main,          // 41
    kUSAC,              // 42  Unified Speech and Audio Coding
    kSAOC,              // 43
    kLD_MpegSurround,   // 44
    kSAOC_DE,           // 45
}

export enum MPEG4SamplingRateIndex {
    k96000Hz = 0,
    k88200Hz,
    k64000Hz,
    k48000Hz,
    k44100Hz,
    k32000Hz,
    k24000Hz,
    k22050Hz,
    k16000Hz,
    k12000Hz,
    k11025Hz,
    k8000Hz,
    k7350Hz,
}

export const MPEG4SamplingRates = [
    96000,
    88200,
    64000,
    48000,
    44100,
    32000,
    24000,
    22050,
    16000,
    12000,
    11025,
    8000,
    7350,
];
