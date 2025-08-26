/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Copyright (C) 2016 zheng qian
 * @author zheng qian <xqq@xqq.im>
 * 
 * Modified by Slavik Lozben.
 * Additional changes Copyright (C) 2025 Veovera Software Organization.
 *
 * See Git history for full details.
 */

enum MSEEvents {
    ERROR = 'error',
    SOURCE_OPEN = 'source_open',
    UPDATE_END = 'update_end',
    BUFFER_FULL = 'buffer_full',
    QUOTA_EXCEEDED_BUFFER_FULL = 'quota_exceeded_buffer_full',
    START_STREAMING = 'start_streaming',
    END_STREAMING = 'end_streaming',
};

export default MSEEvents;
