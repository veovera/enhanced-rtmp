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

import EventEmitter from 'eventemitter3';

class Log {
    private static GLOBAL_TAG = 'e-rtmp-lab.js';
    private static FORCE_GLOBAL_TAG = false;
    private static ENABLE_CALLBACK = false;
    private static ENABLE_ERROR = true;
    private static ENABLE_INFO = true;
    private static ENABLE_WARN = true;
    private static ENABLE_DEBUG = __DEBUG__ === true;
    private static ENABLE_VERBOSE = true;
    private static emitter = new EventEmitter();

    static e(tag: string, msg: string) {
        if (!Log.ENABLE_ERROR) {
            return;
        }

        if (!tag || Log.FORCE_GLOBAL_TAG) {
            tag = Log.GLOBAL_TAG;
        }

        let str = `[${tag}] > ${msg}`;

        if (Log.ENABLE_CALLBACK) {
            Log.emitter.emit('log', 'error', str);
        }

        if (console.error) {
            console.error(str);
        } else if (console.warn) {
            console.warn(str);
        } else {
            console.log(str);
        }
    }

    static i(tag: string, msg: string) {
        if (!Log.ENABLE_INFO) {
            return;
        }

        if (!tag || Log.FORCE_GLOBAL_TAG) {
            tag = Log.GLOBAL_TAG;
        }

        let str = `[${tag}] > ${msg}`;

        if (Log.ENABLE_CALLBACK) {
            Log.emitter.emit('log', 'info', str);
        }

        if (console.info) {
            console.info(str);
        } else {
            console.log(str);
        }
    }

    static w(tag: string, msg: string) {
        if (!Log.ENABLE_WARN) {
            return;
        }

        if (!tag || Log.FORCE_GLOBAL_TAG) {
            tag = Log.GLOBAL_TAG;
        }

        let str = `[${tag}] > ${msg}`;

        if (Log.ENABLE_CALLBACK) {
            Log.emitter.emit('log', 'warn', str);
        }

        if (console.warn) {
            console.warn(str);
        } else {
            console.log(str);
        }
    }

    static d(tag: string, msg: string) {
        if (!Log.ENABLE_DEBUG) {
            return;
        }

        if (!tag || Log.FORCE_GLOBAL_TAG) {
            tag = Log.GLOBAL_TAG;
        }

        let str = `[${tag}] > ${msg}`;

        if (Log.ENABLE_CALLBACK) {
            Log.emitter.emit('log', 'debug', str);
        }

        if (console.debug) {
            console.debug(str);
        } else {
            console.log(str);
        }
    }

    static dumpArrayBuffer(
       input: ArrayBuffer | ArrayBufferView,
       length: number,
       bytesPerLine = 32
    ): string {
       let bytes: Uint8Array;

      if (input instanceof Uint8Array) {
        // Direct use for Uint8Array - most efficient
        bytes = input;
      } else if (input instanceof ArrayBuffer) {
           bytes = new Uint8Array(input);
       } else if (ArrayBuffer.isView(input)) {
           bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
       } else {
           throw new TypeError("Expected ArrayBuffer, TypedArray, or DataView");
       }

       const actualLength = Math.min(bytes.byteLength, length);
       const result: string[] = [];

       for (let i = 0; i < actualLength; i += bytesPerLine) {
           const rowBytes = [];
           const ascii = [];

           const rowLength = Math.min(bytesPerLine, actualLength - i);
           for (let j = 0; j < rowLength; j++) {
               const b = bytes[i + j];
               rowBytes.push(b.toString(16).padStart(2, '0'));
               ascii.push(b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.');
           }

           // Pad the rest of the line if needed (cosmetic only)
           while (rowBytes.length < bytesPerLine) rowBytes.push('  ');
           while (ascii.length < bytesPerLine) ascii.push(' ');

           result.push(
               `${i.toString(16).padStart(4, '0')}: ${rowBytes.join(' ')}  |${ascii.join('')}|`
           );
       }

       return result.join('\n');
    }

    static v(tag: string, ...args: any[]) {
        if (!Log.ENABLE_VERBOSE) {
            return;
        }

        if (!tag || Log.FORCE_GLOBAL_TAG) {
            tag = Log.GLOBAL_TAG;
        }

        const str = `[${tag}] >`;

        if (Log.ENABLE_CALLBACK) {
            Log.emitter.emit('log', 'verbose', str, ...args);
        }

        console.log(str, ...args);
    }

    static a(tag: string, msg: string): never;
    static a(tag: string, msg: string, condition: unknown): asserts condition;
    static a(tag: string, msg: string, condition?: unknown): asserts condition {
        if (arguments.length === 2 || !condition) {
            const str = `[${tag}] ASSERT FAILED: ${msg}`;
            if (Log.ENABLE_CALLBACK) {
                Log.emitter.emit('log', 'assert', str);
            }
            throw new Error(str);
        }
    }
}

export default Log;