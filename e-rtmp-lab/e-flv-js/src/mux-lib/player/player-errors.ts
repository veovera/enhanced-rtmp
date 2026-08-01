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

import {LoaderErrors} from '../io/loader.js';
import DemuxErrors from '../demux/demux-errors.js';

export const ErrorTypes = {
    NETWORK_ERROR: 'NetworkError',
    MEDIA_ERROR: 'MediaError',
    OTHER_ERROR: 'OtherError'
} as const;

export const ErrorDetails = {
    NETWORK_EXCEPTION: LoaderErrors.EXCEPTION,
    NETWORK_STATUS_CODE_INVALID: LoaderErrors.HTTP_STATUS_CODE_INVALID,
    NETWORK_TIMEOUT: LoaderErrors.CONNECTING_TIMEOUT,
    NETWORK_UNRECOVERABLE_EARLY_EOF: LoaderErrors.UNRECOVERABLE_EARLY_EOF,

    MEDIA_MSE_ERROR: 'MediaMSEError',

    MEDIA_FORMAT_ERROR: DemuxErrors.FORMAT_ERROR,
    MEDIA_FORMAT_UNSUPPORTED: DemuxErrors.FORMAT_UNSUPPORTED,
    MEDIA_CODEC_UNSUPPORTED: DemuxErrors.CODEC_UNSUPPORTED
} as const;