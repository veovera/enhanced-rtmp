/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Slavik Lozben.
 * Additional changes Copyright (C) 2025 Veovera Software Organization.
 *
 * See Git history for full details.
 */

// ISO/IEC 13818-1 PES packets containing private data (stream_type=0x06)
export class PGSData {
    pid: number = NaN;
    stream_id: number = NaN;
    pts?: number;
    dts?: number;
    lang: string = '';
    data: Uint8Array = new Uint8Array(0);
    len: number = 0;
}

