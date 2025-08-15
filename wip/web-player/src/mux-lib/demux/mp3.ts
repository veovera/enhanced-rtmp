/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Slavik Lozben.
 * Additional changes Copyright (C) 2025 Veovera Software Organization.
 *
 * See Git history for full details.
 */

export enum MPEGAudioObjectType {
    Layer1 = 32,   // MPEG-4 Audio Object Type for MPEG Layer 1
    Layer2 = 33,   // MPEG-4 Audio Object Type for MPEG Layer 2
    Layer3 = 34    // MPEG-4 Audio Object Type for MPEG Layer 3 (MP3)
}

export class MP3Data {
    object_type: number = MPEGAudioObjectType.Layer3;   // MPEG audio version
    sample_rate: number = 44100;                        // Sampling frequency
    channel_count: number = 2;                          // Number of audio channels
    data: Uint8Array = new Uint8Array();                // Audio data
}
