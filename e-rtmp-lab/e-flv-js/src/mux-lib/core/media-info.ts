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

export interface KeyframeInfo {
    index: number;
    milliseconds: number;
    fileposition: number;
}

class MediaInfo {

    mimeType: string | null = null;
    duration: number | null = null;

    hasAudio: boolean | null = null;
    hasVideo: boolean | null = null;
    audioCodec: string | null = null;
    videoCodec: string | null = null;
    audioDataRate: number | null = null;
    videoDataRate: number | null = null;

    audioSampleRate: number | null = null;
    audioChannelCount: number | null = null;

    width: number | null = null;
    height: number | null = null;
    fps: number | null = null;
    profile: string | null = null;
    level: string | null = null;
    refFrames: number | null = null;
    chromaFormat: string | null = null;
    sarNum: number | null = null;
    sarDen: number | null = null;

    metadata: any = null;
    segments: MediaInfo[] | null = null;  // MediaInfo[]
    segmentCount: number | null = null;
    hasKeyframesIndex: boolean | null = null;
    keyframesIndex: any = null;

    isComplete() {
        let audioInfoComplete = (this.hasAudio === false) ||
                                (this.hasAudio === true &&
                                 this.audioCodec != null &&
                                 this.audioSampleRate != null &&
                                 this.audioChannelCount != null);

        let videoInfoComplete = (this.hasVideo === false) ||
                                (this.hasVideo === true &&
                                 this.videoCodec != null &&
                                 this.width != null &&
                                 this.height != null &&
                                 this.fps != null &&
                                 this.profile != null &&
                                 this.level != null &&
                                 this.refFrames != null &&
                                 this.chromaFormat != null &&
                                 this.sarNum != null &&
                                 this.sarDen != null);

        // keyframesIndex may not be present
        return this.mimeType != null &&
               audioInfoComplete &&
               videoInfoComplete;
    }

    isSeekable() {
        return this.hasKeyframesIndex === true;
    }

    getNearestKeyframe(milliseconds: number): KeyframeInfo | null {
        if (this.keyframesIndex == null) {
            return null;
        }

        let table = this.keyframesIndex;
        let keyframeIdx = this._search(table.times, milliseconds);

        return {
            index: keyframeIdx,
            milliseconds: table.times[keyframeIdx],
            fileposition: table.filepositions[keyframeIdx]
        };
    }

    _search(list: number[], value: number): number {
        let idx = 0;

        let last = list.length - 1;
        let mid = 0;
        let lbound = 0;
        let ubound = last;

        if (value < list[0]) {
            idx = 0;
            lbound = ubound + 1;  // skip search
        }

        while (lbound <= ubound) {
            mid = lbound + Math.floor((ubound - lbound) / 2);
            if (mid === last || (value >= list[mid] && value < list[mid + 1])) {
                idx = mid;
                break;
            } else if (list[mid] < value) {
                lbound = mid + 1;
            } else {
                ubound = mid - 1;
            }
        }

        return idx;
    }

}

export default MediaInfo;