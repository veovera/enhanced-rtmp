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

/**
 * Logging-level guide:
 *
 * - `v`: normal operational tracing, such as parsed packets, segments, and
 *        timestamps. This is the default diagnostic level in this codebase.
 * - `i`: important but expected lifecycle or configuration facts. Use sparingly
 *        when a message should remain visible without the detail of verbose logs.
 * - `w`: recoverable anomalies, unsupported optional input, or fallbacks.
 * - `e`: failures that prevent an operation from completing normally.
 * - `d`: debug-only diagnostics that are normally disabled in production.
 */
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

    /** Emits a preformatted log record to registered log listeners. */
    static emitLog(type: string, logcat: any) {
        Log.emitter.emit('log', type, logcat);
    }
    
    /**
     * Logging level: `e` — failures that prevent an operation from completing
     * normally. Writes an error-level message and forwards it to listeners
     * when enabled.
     */
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

    /**
     * Logging level: `i` — important expected lifecycle or configuration facts;
     * use sparingly. Writes an info-level message and forwards it to listeners
     * when enabled.
     */
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

    /**
     * Logging level: `w` — recoverable anomalies, unsupported optional input,
     * or fallbacks. Writes a warning-level message and forwards it to listeners
     * when enabled.
     */
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

    /**
     * Logging level: `d` — debug-only diagnostics that are normally disabled in
     * production. Writes a debug-level message when debug logging is enabled.
     */
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

    /** Formats an ArrayBuffer or typed-array view as a bounded hex/ASCII dump. */
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

    /**
     * Logging level: `v` — normal operational tracing, including packets,
     * segments, and timestamps. Writes a verbose message while preserving
     * structured arguments for the console.
     */
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

    /** Creates scoped verbose, warning, and error log helpers with aligned prefixes. */
    static scope(tag: string, scope: string) {
        let firstLine = true;
        const nextPrefix = () => {
            const prefix = firstLine ? scope : ' '.repeat(scope.length);
            firstLine = false;
            return `${prefix}:`;
        };

        return {
            v: (...args: any[]) => Log.v(tag, nextPrefix(), ...args),
            w: (msg: string) => Log.w(tag, `${nextPrefix()} ${msg}`),
            e: (msg: string) => Log.e(tag, `${nextPrefix()} ${msg}`),
        };
    }

    /** Throws an error with the logger tag when the provided condition is falsy. */
    static a(tag: string, msg: string, condition?: unknown): asserts condition {
        if (!condition) {
            const str = `[${tag}] ASSERT FAILED: ${msg}`;
            throw new Error(str);
        }
    }

    // Nested so it can reach Log's private static members (TS privacy is lexical, not nominal).
    static LoggingControl = class LoggingControl {

        private static emitter = new EventEmitter();

        static get forceGlobalTag() {
            return Log.FORCE_GLOBAL_TAG;
        }

        static set forceGlobalTag(enable: boolean) {
            Log.FORCE_GLOBAL_TAG = enable;
            LoggingControl._notifyChange();
        }

        static get globalTag() {
            return Log.GLOBAL_TAG;
        }

        static set globalTag(tag: string) {
            Log.GLOBAL_TAG = tag;
            LoggingControl._notifyChange();
        }

        static get enableAll() {
            return Log.ENABLE_VERBOSE
                && Log.ENABLE_DEBUG
                && Log.ENABLE_INFO
                && Log.ENABLE_WARN
                && Log.ENABLE_ERROR;
        }

        static set enableAll(enable: boolean) {
            Log.ENABLE_VERBOSE = enable;
            Log.ENABLE_DEBUG = enable;
            Log.ENABLE_INFO = enable;
            Log.ENABLE_WARN = enable;
            Log.ENABLE_ERROR = enable;
            LoggingControl._notifyChange();
        }

        static get enableDebug() {
            return Log.ENABLE_DEBUG;
        }

        static set enableDebug(enable: boolean) {
            Log.ENABLE_DEBUG = enable;
            LoggingControl._notifyChange();
        }

        static get enableVerbose() {
            return Log.ENABLE_VERBOSE;
        }

        static set enableVerbose(enable: boolean) {
            Log.ENABLE_VERBOSE = enable;
            LoggingControl._notifyChange();
        }

        static get enableInfo() {
            return Log.ENABLE_INFO;
        }

        static set enableInfo(enable: boolean) {
            Log.ENABLE_INFO = enable;
            LoggingControl._notifyChange();
        }

        static get enableWarn() {
            return Log.ENABLE_WARN;
        }

        static set enableWarn(enable: boolean) {
            Log.ENABLE_WARN = enable;
            LoggingControl._notifyChange();
        }

        static get enableError() {
            return Log.ENABLE_ERROR;
        }

        static set enableError(enable: boolean) {
            Log.ENABLE_ERROR = enable;
            LoggingControl._notifyChange();
        }

        static getConfig() {
            return {
                globalTag: Log.GLOBAL_TAG,
                forceGlobalTag: Log.FORCE_GLOBAL_TAG,
                enableVerbose: Log.ENABLE_VERBOSE,
                enableDebug: Log.ENABLE_DEBUG,
                enableInfo: Log.ENABLE_INFO,
                enableWarn: Log.ENABLE_WARN,
                enableError: Log.ENABLE_ERROR,
                enableCallback: Log.ENABLE_CALLBACK
            };
        }

        static applyConfig(config: ReturnType<typeof LoggingControl.getConfig>) {
            Log.GLOBAL_TAG = config.globalTag;
            Log.FORCE_GLOBAL_TAG = config.forceGlobalTag;
            Log.ENABLE_VERBOSE = config.enableVerbose;
            Log.ENABLE_DEBUG = config.enableDebug;
            Log.ENABLE_INFO = config.enableInfo;
            Log.ENABLE_WARN = config.enableWarn;
            Log.ENABLE_ERROR = config.enableError;
            Log.ENABLE_CALLBACK = config.enableCallback;
        }

        static _notifyChange() {
            let emitter = LoggingControl.emitter;

            if (emitter.listenerCount('change') > 0) {
                let config = LoggingControl.getConfig();
                emitter.emit('change', config);
            }
        }

        static registerListener(listener: (...args: any[]) => void) {
            LoggingControl.emitter.addListener('change', listener);
        }

        static removeListener(listener: (...args: any[]) => void) {
            LoggingControl.emitter.removeListener('change', listener);
        }

        static addLogListener(listener: (...args: any[]) => void) {
            Log.emitter.addListener('log', listener);
            if (Log.emitter.listenerCount('log') > 0) {
                Log.ENABLE_CALLBACK = true;
                LoggingControl._notifyChange();
            }
        }

        static removeLogListener(listener: (...args: any[]) => void) {
            Log.emitter.removeListener('log', listener);
            if (Log.emitter.listenerCount('log') === 0) {
                Log.ENABLE_CALLBACK = false;
                LoggingControl._notifyChange();
            }
        }

    };
}

export default Log;
export const LoggingControl = Log.LoggingControl;
