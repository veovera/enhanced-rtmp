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

export enum TrackType {
    Audio = 'audio',
    Video = 'video',
}

// Represents an media frame (audio / video)
export class FrameInfo {
    dts: number;
    pts: number;
    duration: number;
    originalDts: number;
    isSyncPoint: boolean;
    fileposition: number | null = null;

    constructor(dts: number, pts: number, duration: number, originalDts: number, isSync: boolean) {
        this.dts = dts;
        this.pts = pts;
        this.duration = duration;
        this.originalDts = originalDts;
        this.isSyncPoint = isSync;
    }
}

// Media Segment concept is defined in Media Source Extensions spec.
// Particularly in ISO BMFF format, an Media Segment contains a moof box followed by a mdat box.
export class MediaSegmentInfo {
    beginDts = 0
    endDts = 0
    beginPts = 0
    endPts = 0
    originalBeginDts = 0
    originalEndDts = 0
    syncPoints: FrameInfo[] = []
    firstFrame: FrameInfo | null = null
    lastFrame: FrameInfo | null = null

    appendSyncPoint(frameInfo: FrameInfo) {  // also called Random Access Point
        frameInfo.isSyncPoint = true;
        this.syncPoints.push(frameInfo);
    }

}

// Ordered list for recording video IDR frames, sorted by originalDts
export class IDRFrameList {
    private _list: FrameInfo[] = [];

    clear() {
        this._list = [];
    }

    appendArray(syncPoints: FrameInfo[]) {
        let list = this._list;

        if (syncPoints.length === 0) {
            return;
        }

        if (list.length > 0 && syncPoints[0].originalDts < list[list.length - 1].originalDts) {
            this.clear();
        }

        Array.prototype.push.apply(list, syncPoints);
    }

    getLastSyncPointBeforeDts(dts: number) {
        if (this._list.length == 0) {
            return null;
        }

        let list = this._list;
        let idx = 0;
        let last = list.length - 1;
        let mid = 0;
        let lbound = 0;
        let ubound = last;

        if (dts < list[0].dts) {
            idx = 0;
            lbound = ubound + 1;
        }

        while (lbound <= ubound) {
            mid = lbound + Math.floor((ubound - lbound) / 2);
            if (mid === last || (dts >= list[mid].dts && dts < list[mid + 1].dts)) {
                idx = mid;
                break;
            } else if (list[mid].dts < dts) {
                lbound = mid + 1;
            } else {
                ubound = mid - 1;
            }
        }
        return this._list[idx];
    }

}

// Data structure for recording information of media segments in single track.
export class MediaSegmentInfoList {
    private _type: TrackType;
    private _list: MediaSegmentInfo[] = [];
    private _lastAppendLocation: number = -1;

    constructor(type: TrackType) {
        this._type = type;
    }

    get type(): TrackType {
        return this._type;
    }

    get length(): number {
        return this._list.length;
    }

    isEmpty(): boolean {
        return this._list.length === 0;
    }

    clear() {
        this._list = [];
        this._lastAppendLocation = -1;
    }

    _searchNearestSegmentBefore(originalBeginDts: number): number {
        let list = this._list;
        if (list.length === 0) {
            return -2;
        }
        let last = list.length - 1;
        let mid = 0;
        let lbound = 0;
        let ubound = last;

        let idx = 0;

        if (originalBeginDts < list[0].originalBeginDts) {
            idx = -1;
            return idx;
        }

        while (lbound <= ubound) {
            const frame = list[mid].lastFrame;
            mid = lbound + Math.floor((ubound - lbound) / 2);

            if (mid === last || (frame && originalBeginDts > frame.originalDts) && 
                (originalBeginDts < list[mid + 1].originalBeginDts)) {
                idx = mid;
                break;
            } else if (list[mid].originalBeginDts < originalBeginDts) {
                lbound = mid + 1;
            } else {
                ubound = mid - 1;
            }
        }
        return idx;
    }

    _searchNearestSegmentAfter(originalBeginDts: number) {
        return this._searchNearestSegmentBefore(originalBeginDts) + 1;
    }

    append(mediaSegmentInfo: MediaSegmentInfo) {
        let list = this._list;
        let msi = mediaSegmentInfo;
        let lastAppendIdx = this._lastAppendLocation;
        let insertIdx = 0;

        if (lastAppendIdx !== -1 && 
            lastAppendIdx < list.length &&
            (list[lastAppendIdx].lastFrame && msi.originalBeginDts >= list[lastAppendIdx].lastFrame.originalDts) &&
            ((lastAppendIdx === list.length - 1) || (lastAppendIdx < list.length - 1 &&
            msi.originalBeginDts < list[lastAppendIdx + 1].originalBeginDts))) {
            insertIdx = lastAppendIdx + 1;  // use cached location idx
        } else {
            if (list.length > 0) {
                insertIdx = this._searchNearestSegmentBefore(msi.originalBeginDts) + 1;
            }
        }

        this._lastAppendLocation = insertIdx;
        this._list.splice(insertIdx, 0, msi);
    }

    getLastSegmentBefore(originalBeginDts: number): MediaSegmentInfo | null {
        let idx = this._searchNearestSegmentBefore(originalBeginDts);
        if (idx >= 0) {
            return this._list[idx];
        } else {  // -1
            return null;
        }
    }

    getLastFrameBefore(originalBeginDts: number): FrameInfo | null {
        let segment = this.getLastSegmentBefore(originalBeginDts);
        if (segment != null) {
            return segment.lastFrame;
        } else {
            return null;
        }
    }

    getLastSyncPointBefore(originalBeginDts: number): FrameInfo | null {
        let segmentIdx = this._searchNearestSegmentBefore(originalBeginDts);
        let syncPoints = this._list[segmentIdx].syncPoints;
        while (syncPoints.length === 0 && segmentIdx > 0) {
            segmentIdx--;
            syncPoints = this._list[segmentIdx].syncPoints;
        }
        if (syncPoints.length > 0) {
            return syncPoints[syncPoints.length - 1];
        } else {
            return null;
        }
    }

}