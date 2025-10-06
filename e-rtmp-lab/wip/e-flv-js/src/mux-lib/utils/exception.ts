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

export enum MediaErrorName {
    QuotaExceededError = 'QuotaExceededError',
    NotSupportedError = 'NotSupportedError',
    InvalidStateError = 'InvalidStateError',
    NetworkError = 'NetworkError',
    AbortError = 'AbortError',
}
export class RuntimeException {
    private _message: string;

    constructor(message: string) {
        this._message = message;
    }

    get name(): string {
        return 'RuntimeException';
    }

    get message(): string {
        return this._message;
    }

    toString() {
        return this.name + ': ' + this.message;
    }

}

export class IllegalStateException extends RuntimeException {

    constructor(message: string) {
        super(message);
    }

    get name(): string {
        return 'IllegalStateException';
    }

}

export class InvalidArgumentException extends RuntimeException {

    constructor(message: string) {
        super(message);
    }

    get name(): string {
        return 'InvalidArgumentException';
    }

}

export class NotImplementedException extends RuntimeException {

    constructor(message: string) {
        super(message);
    }

    get name(): string {
        return 'NotImplementedException';
    }

}
