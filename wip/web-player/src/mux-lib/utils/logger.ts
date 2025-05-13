/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Copyright (C) 2016 Bilibili
 * @author zheng qian <xqq@xqq.im>
 *
 * Modified and migrated to TypeScript by Slavik Lozben.
 * Additional changes Copyright (C) Veovera Software Organization.
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
    private static ENABLE_DEBUG = true;
    private static ENABLE_VERBOSE = true;
    private static emitter = new EventEmitter();

    static e(tag: string, msg: string) {
        if (!tag || Log.FORCE_GLOBAL_TAG)
            tag = Log.GLOBAL_TAG;

        let str = `[${tag}] > ${msg}`;

        if (Log.ENABLE_CALLBACK) {
            Log.emitter.emit('log', 'error', str);
        }

        if (!Log.ENABLE_ERROR) {
            return;
        }

        if (console.error) {
            console.error(str);
        } else if (console.warn) {
            console.warn(str);
        } else {
            console.log(str);
        }
    }

    static i(tag, msg) {
        if (!tag || Log.FORCE_GLOBAL_TAG)
            tag = Log.GLOBAL_TAG;

        let str = `[${tag}] > ${msg}`;

        if (Log.ENABLE_CALLBACK) {
            Log.emitter.emit('log', 'info', str);
        }

        if (!Log.ENABLE_INFO) {
            return;
        }

        if (console.info) {
            console.info(str);
        } else {
            console.log(str);
        }
    }

    static w(tag, msg) {
        if (!tag || Log.FORCE_GLOBAL_TAG)
            tag = Log.GLOBAL_TAG;

        let str = `[${tag}] > ${msg}`;

        if (Log.ENABLE_CALLBACK) {
            Log.emitter.emit('log', 'warn', str);
        }

        if (!Log.ENABLE_WARN) {
            return;
        }

        if (console.warn) {
            console.warn(str);
        } else {
            console.log(str);
        }
    }

    static d(tag, msg) {
        if (!tag || Log.FORCE_GLOBAL_TAG)
            tag = Log.GLOBAL_TAG;

        let str = `[${tag}] > ${msg}`;

        if (Log.ENABLE_CALLBACK) {
            Log.emitter.emit('log', 'debug', str);
        }

        if (!Log.ENABLE_DEBUG) {
            return;
        }

        if (console.debug) {
            console.debug(str);
        } else {
            console.log(str);
        }
    }

    static v(tag, msg) {
        if (!tag || Log.FORCE_GLOBAL_TAG)
            tag = Log.GLOBAL_TAG;

        let str = `[${tag}] > ${msg}`;

        if (Log.ENABLE_CALLBACK) {
            Log.emitter.emit('log', 'verbose', str);
        }

        if (!Log.ENABLE_VERBOSE) {
            return;
        }

        console.log(str);
    }

    static adfd(condition: unknown, tag: string, msg: string): asserts condition {
        if (!condition) {
            const str = `[${tag}] ASSERT FAILED: ${msg}`;

            if (Log.ENABLE_CALLBACK) {
                Log.emitter.emit('log', 'assert', str);
            }

            throw new Error(str);
        }
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