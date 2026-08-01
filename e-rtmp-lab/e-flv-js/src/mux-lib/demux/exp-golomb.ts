/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Copyright (C) 2016 Bilibili
 * @author zheng qian <xqq@xqq.im>
 *
 * Modified and migrated to TypeScript by Slavik Lozben.
 * Additional changes Copyright (C) 2026 Veovera Software Organization.
 *
 * See Git history for full details.
 */

import {IllegalStateException, InvalidArgumentException} from '../utils/exception.js';

// Exponential-Golomb buffer decoder
class ExpGolomb {
    private TAG: string;
    private _buffer: Uint8Array;
    private _buffer_index: number;
    private _total_bytes: number;
    private _current_word: number;
    private _current_word_bits_left: number;

    constructor(uint8array: Uint8Array) {
        this.TAG = 'ExpGolomb';

        this._buffer = uint8array;
        this._buffer_index = 0;
        this._total_bytes = uint8array.byteLength;
        this._current_word = 0;
        this._current_word_bits_left = 0;
    }

    destroy() {
        this._buffer = new Uint8Array(0);
    }

    get bitsConsumed(): number {
        return this._buffer_index * 8 - this._current_word_bits_left;
    }

    get bitsRemaining(): number {
        return (this._total_bytes - this._buffer_index) * 8 + this._current_word_bits_left;
    }

    _fillCurrentWord() {
        let buffer_bytes_left = this._total_bytes - this._buffer_index;
        if (buffer_bytes_left <= 0)
            throw new IllegalStateException('ExpGolomb: _fillCurrentWord() but no bytes available');

        let bytes_read = Math.min(4, buffer_bytes_left);
        let word = new Uint8Array(4);
        word.set(this._buffer.subarray(this._buffer_index, this._buffer_index + bytes_read));
        this._current_word = new DataView(word.buffer).getUint32(0, false);

        this._buffer_index += bytes_read;
        this._current_word_bits_left = bytes_read * 8;
    }

    readBits(bits: number): number {
        if (bits > 32)
            throw new InvalidArgumentException('ExpGolomb: readBits() bits exceeded max 32bits!');

        if (bits === 0) {
            return 0;
        }

        if (bits <= this._current_word_bits_left) {
            let result = this._current_word >>> (32 - bits);
            this._current_word <<= bits;
            this._current_word_bits_left -= bits;
            return result;
        }

        let result = this._current_word_bits_left ? this._current_word : 0;
        result = result >>> (32 - this._current_word_bits_left);
        let bits_need_left = bits - this._current_word_bits_left;

        this._fillCurrentWord();
        let bits_read_next = Math.min(bits_need_left, this._current_word_bits_left);

        let result2 = this._current_word >>> (32 - bits_read_next);
        this._current_word <<= bits_read_next;
        this._current_word_bits_left -= bits_read_next;

        result = (result << bits_read_next) | result2;
        return result;
    }

    readBool(): boolean {
        return this.readBits(1) === 1;
    }

    readByte(): number {
        return this.readBits(8);
    }

    _skipLeadingZero(): number {
        let zero_count;
        for (zero_count = 0; zero_count < this._current_word_bits_left; zero_count++) {
            if (0 !== (this._current_word & (0x80000000 >>> zero_count))) {
                this._current_word <<= zero_count;
                this._current_word_bits_left -= zero_count;
                return zero_count;
            }
        }
        this._fillCurrentWord();
        return zero_count + this._skipLeadingZero();
    }

    readUEG(): number {  // unsigned exponential golomb
        let leading_zeros = this._skipLeadingZero();
        return this.readBits(leading_zeros + 1) - 1;
    }

    readSEG(): number {  // signed exponential golomb
        let value = this.readUEG();
        if (value & 0x01) {
            return (value + 1) >>> 1;
        } else {
            return -1 * (value >>> 1);
        }
    }

}

export default ExpGolomb;