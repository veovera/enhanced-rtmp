/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Slavik Lozben.
 * Additional changes Copyright (C) 2025 Veovera Software Organization.
 *
 * See Git history for full details.
 */

export class KLVData {
    pid: number = NaN;
    stream_id: number = NaN;
    pts?: number;
    dts?: number;
    access_units: AccessUnit[] = [];
    data: Uint8Array = new Uint8Array(0);
    len: number = 0;
}

type AccessUnit = {
    service_id: number;
    sequence_number: number;
    flags: number;
    data: Uint8Array;
}

export const klv_parse = (data: Uint8Array) => {
    let result: AccessUnit[] = [];

    let offset = 0;
    while (offset + 5 < data.byteLength) {
        let service_id = data[offset + 0];
        let sequence_number = data[offset + 1];
        let flags = data[offset + 2];
        let au_size = (data[offset + 3] << 8) | (data[offset + 4] << 0);
        let au_data = data.slice(offset + 5, offset + 5 + au_size);

        result.push({
            service_id,
            sequence_number,
            flags,
            data: au_data
        });

        offset += 5 + au_size;
    }

    return result;
}