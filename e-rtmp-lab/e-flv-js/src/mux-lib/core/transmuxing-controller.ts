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
import Log from '../utils/logger.js';
import Browser from '../utils/browser.js';
import MediaInfo from './media-info.js';
import FLVDemuxer from '../demux/flv-demuxer.js';
import { VideoCodecKind } from '../demux/flv-demuxer.js';
import type { AudioMetadata, AudioTrack, FlvProbeSuccess, VideoMetadata, VideoTrack } from '../demux/flv-demuxer.js';
import MP4Remuxer from '../remux/mp4-remuxer.js';
import { WebMRemuxer } from '../remux/webm-remuxer.js';
import RemuxerRouter from '../remux/remuxer-router.js';
import DemuxErrors from '../demux/demux-errors.js';
import IOController from '../io/io-controller.js';
import TransmuxingEvent, { type DiscoveredTrackInfo, type DiscoveredTracks, type TransmuxingEventMap } from './transmuxing-events';
import type { ResolvedPlayerConfig } from '../config.js';
import { RemuxerType, TrackType } from '../remux/remuxer.js';
import type { MSEInitSegment } from '../remux/remuxer.js';

// Coordinates loading FLV media, demuxing its tracks, routing them to the appropriate
// remuxer, and emitting playback-ready output; also manages multipart streams and seeks.
class TransmuxingController {
    private TAG: string = 'TransmuxingController';
    private _emitter: EventEmitter = new EventEmitter();
    private _config: ResolvedPlayerConfig;
    private _mediaDataSource: any;
    private _currentSegmentIndex: number = 0;
    private _remuxerRouter: RemuxerRouter;
    private _demuxer: FLVDemuxer | null = null;
    private _mediaInfo: MediaInfo | null = null;
    private _ioctl: IOController | null = null;
    private _hasAudioTrack: boolean = false;
    private _hasVideoTrack: boolean = false;
    // Locked after initial metadata has selected a remuxer for each track.
    private _hasSelectedRemuxerForCodecs: boolean = false;
    private _videoRemuxerType: RemuxerType | undefined = undefined;
    private _pendingTrackMetadata: Array<AudioMetadata | VideoMetadata> = [];
    private _selectedAudioTrackId: number | undefined = undefined;
    private _selectedVideoTrackId: number | undefined = undefined;
    private _discoveredAudioTracks: Map<number, DiscoveredTrackInfo> = new Map();
    private _discoveredVideoTracks: Map<number, DiscoveredTrackInfo> = new Map();
    private _lastDiscoveredTracksSignature = '';
    private _pendingSeekTime: number | null = null;
    private _pendingResolveSeekPoint: number | null = null;
    private _statisticsReporter: number | null = null;

    constructor(mediaDataSource: any, config: ResolvedPlayerConfig) {
        this._config = config;

        // treat single part media as multipart media, which has only one segment
        if (!mediaDataSource.segments) {
            mediaDataSource.segments = [{
                duration: mediaDataSource.duration,
                filesize: mediaDataSource.filesize,
                url: mediaDataSource.url
            }];
        }

        // fill in default IO params if not exists
        if (typeof mediaDataSource.cors !== 'boolean') {
            mediaDataSource.cors = true;
        }
        if (typeof mediaDataSource.withCredentials !== 'boolean') {
            mediaDataSource.withCredentials = false;
        }

        this._mediaDataSource = mediaDataSource;
        // Codec metadata configures the router's audio and video remuxers.
        // Until then, the router accepts demuxer callbacks without emitting.
        this._remuxerRouter = new RemuxerRouter();

        let totalDuration = 0;

        this._mediaDataSource.segments.forEach((segment: any) => {
            // timestampBase for each segment, and calculate total duration
            segment.timestampBase = totalDuration;
            totalDuration += segment.duration;
            // params needed by IOController
            segment.cors = mediaDataSource.cors;
            segment.withCredentials = mediaDataSource.withCredentials;
            // referrer policy control, if exist
            if (config.referrerPolicy) {
                segment.referrerPolicy = config.referrerPolicy;
            }
        });

        if (!isNaN(totalDuration) && this._mediaDataSource.duration !== totalDuration) {
            this._mediaDataSource.duration = totalDuration;
        }
    }

    /**
     * Remuxer selection strategy (Chrome scope)
     *
     * Audio and video use independent remuxer instances and may select
     * different output containers. For example, VP9 video may be WebM while
     * Opus audio is MP4.
     *
     * Select a track's remuxer when its first codec-bearing FLV packet is
     * encountered.  That packet may be either a codec sequence header /
     * configuration record or a media frame.  If a media frame arrives before
     * the configuration record required to initialize the selected container,
     * buffer it; configuration ordering and validity are demuxer concerns.
     *
     * | Track             | `preferWebM` | no `preferWebM` |
     * |-------------------|--------------|-----------------|
     * | AVC / HEVC video  | MP4          | MP4             |
     * | AV1 video         | WebM         | MP4             |
     * | VP9 video         | WebM         | WebM            |
     * | AAC audio         | MP4          | MP4             |
     * | Opus audio        | WebM         | MP4             |
     *
     * The MSE layer is responsible for creating the corresponding independent
     * SourceBuffers when the browser supports their combination.
     *
     * VP8 will follow the VP9 policy after VP8 E-FLV parsing and WebM remuxing
     * support are implemented.
     *
     * A selected video-track change may select a different remuxer container.
     * The controller replaces only the video remuxer when the demuxer reaches
     * the selected track's keyframe and redispatches its metadata. The MSE
     * controller then changes the video SourceBuffer type before appending the
     * corresponding initialization segment.
     *
     * The router owns one DTS base and applies it to both remuxers, keeping
     * their output timelines aligned in their MSE SourceBuffers.
     */
    private _getPreferredRemuxerType(): RemuxerType {
        return this._config.preferWebM ? 'webm' : 'mp4';
    }

    private _createRemuxer(type: RemuxerType): MP4Remuxer | WebMRemuxer {
        return type === 'webm' ? new WebMRemuxer(this._config) : new MP4Remuxer(this._config);
    }

    private _configureRemuxerRouter(audioType: RemuxerType, videoType: RemuxerType): void {
        this._remuxerRouter.configure(
            this._createRemuxer(audioType),
            this._createRemuxer(videoType)
        );
    }

    private _selectAudioRemuxerType(metadata: AudioMetadata): RemuxerType {
        return this._getPreferredRemuxerType() === 'webm' && metadata.codec === 'opus' ? 'webm' : 'mp4';
    }

    private _selectVideoRemuxerType(codecKind: VideoCodecKind): RemuxerType {
        switch (codecKind) {
            case VideoCodecKind.Vp9:
                return 'webm';
            case VideoCodecKind.Av1:
                return this._getPreferredRemuxerType();
            case VideoCodecKind.Avc:
            case VideoCodecKind.Hevc:
            case VideoCodecKind.Vp8:
            default:
                return 'mp4';
        }
    }

    private _bindRemuxerRouterToDemuxer() {
        if (!this._demuxer) {
            return;
        }

        this._demuxer.remuxerRouter = this._remuxerRouter;
        this._demuxer.onTrackData = this._onTrackData.bind(this);
        this._demuxer.onTrackMetadata = this._onTrackMetadata.bind(this);
        this._remuxerRouter.onInitSegment = this._onRemuxerInitSegmentArrival.bind(this);
        this._remuxerRouter.onMediaSegment = this._onRemuxerMediaSegmentArrival.bind(this);
    }

    private _switchRemuxersIfNeeded(metadata: Array<AudioMetadata | VideoMetadata>) {
        const audioMetadata = metadata.find((track) => track.type === TrackType.Audio) as AudioMetadata | undefined;
        const videoMetadata = metadata.find((track) => track.type === TrackType.Video) as VideoMetadata | undefined;
        const audioType = audioMetadata ? this._selectAudioRemuxerType(audioMetadata) : 'mp4';
        const videoType = videoMetadata ? this._selectVideoRemuxerType(videoMetadata.codecKind) : 'mp4';

        Log.v(this.TAG, `Selected remuxers: audio=${audioType}${audioMetadata ? ` (${audioMetadata.codec})` : ''}, video=${videoType}${videoMetadata ? ` (${videoMetadata.codec})` : ''}`);
        this._configureRemuxerRouter(audioType, videoType);
        this._videoRemuxerType = videoType;
        this._bindRemuxerRouterToDemuxer();
    }

    private _switchVideoRemuxerIfNeeded(metadata: VideoMetadata): void {
        const videoType = this._selectVideoRemuxerType(metadata.codecKind);
        if (videoType === this._videoRemuxerType) {
            return;
        }

        Log.i(this.TAG, `Switching video remuxer: ${this._videoRemuxerType ?? 'none'} -> ${videoType} (${metadata.codec})`);
        this._remuxerRouter.configureVideo(this._createRemuxer(videoType));
        this._videoRemuxerType = videoType;
        this._bindRemuxerRouterToDemuxer();
    }

    private _hasMetadataForAllTracks(): boolean {
        return (!this._hasAudioTrack || this._pendingTrackMetadata.some((track) => track.type === TrackType.Audio)) &&
            (!this._hasVideoTrack || this._pendingTrackMetadata.some((track) => track.type === TrackType.Video));
    }

    private _rememberDiscoveredTrack(metadata: AudioMetadata | VideoMetadata): void {
        const trackInfo: DiscoveredTrackInfo = {
            type: metadata.type,
            trackId: metadata.trackId,
            codecKind: metadata.codecKind,
            codec: metadata.codec
        };

        if (metadata.type === TrackType.Audio) {
            if (this._selectedAudioTrackId === undefined) {
                this._selectedAudioTrackId = metadata.trackId;
            }
            this._discoveredAudioTracks.set(metadata.trackId, trackInfo);
        } else {
            if (this._selectedVideoTrackId === undefined) {
                this._selectedVideoTrackId = metadata.trackId;
            }
            this._discoveredVideoTracks.set(metadata.trackId, trackInfo);
        }
    }

    private _getDiscoveredTracks(): DiscoveredTracks {
        const sortByTrackId = (left: DiscoveredTrackInfo, right: DiscoveredTrackInfo) => left.trackId - right.trackId;
        return {
            audio: [...this._discoveredAudioTracks.values()].sort(sortByTrackId),
            video: [...this._discoveredVideoTracks.values()].sort(sortByTrackId)
        };
    }

    private _emitTracksDiscoveredIfChanged(): void {
        const tracks = this._getDiscoveredTracks();
        const signature = JSON.stringify(tracks);
        if (signature === this._lastDiscoveredTracksSignature) {
            return;
        }
        this._lastDiscoveredTracksSignature = signature;
        this._emitter.emit(TransmuxingEvent.TRACKS_DISCOVERED, tracks);
    }

    private _isSelectedTrackMetadata(metadata: AudioMetadata | VideoMetadata): boolean {
        if (metadata.type === TrackType.Audio) {
            return metadata.trackId === this._selectedAudioTrackId;
        }
        return metadata.trackId === this._selectedVideoTrackId;
    }

    selectVideoTrack(trackId: number): void {
        this._selectedVideoTrackId = trackId;
        this._demuxer?.selectVideoTrack(trackId);
    }

    destroy() {
        this._mediaInfo = null;
        this._mediaDataSource = null;

        if (this._statisticsReporter) {
            this._disableStatisticsReporter();
        }
        if (this._ioctl) {
            this._ioctl.destroy();
            this._ioctl = null;
        }
        if (this._demuxer) {
            this._demuxer.destroy();
            this._demuxer = null;
        }
        if (this._remuxerRouter) {
            this._remuxerRouter.destroy();
        }

        this._emitter.removeAllListeners();
    }

    on<K extends TransmuxingEvent>(event: K, listener: (...args: TransmuxingEventMap[K]) => void) {
        this._emitter.addListener(event, listener);
    }

    off<K extends TransmuxingEvent>(event: K, listener: (...args: TransmuxingEventMap[K]) => void) {
        this._emitter.removeListener(event, listener);
    }

    start() {
        this._loadSegment(0);
        this._enableStatisticsReporter();
    }

    _loadSegment(segmentIndex: number, optionalFrom?: number) {
        this._currentSegmentIndex = segmentIndex;
        let dataSource = this._mediaDataSource.segments[segmentIndex];

        let ioctl = this._ioctl = new IOController(dataSource, this._config, segmentIndex);
        ioctl.onError = this._onIOException.bind(this);
        ioctl.onSeeked = this._onIOSeeked.bind(this);
        ioctl.onComplete = this._onIOComplete.bind(this);
        ioctl.onRedirect = this._onIORedirect.bind(this);
        ioctl.onRecoveredEarlyEof = this._onIORecoveredEarlyEof.bind(this);

        if (optionalFrom) {
            this._demuxer!.bindDataSource(this._ioctl);
        } else {
            ioctl.onDataArrival = this._onInitChunkArrival.bind(this);
        }

        ioctl.open(optionalFrom);
    }

    stop() {
        this._internalAbort();
        this._disableStatisticsReporter();
    }

    _internalAbort() {
        if (this._ioctl) {
            this._ioctl.destroy();
            this._ioctl = null;
        }
    }

    pause() {  // take a rest
        if (this._ioctl && this._ioctl.isWorking()) {
            this._ioctl.pause();
            this._disableStatisticsReporter();
        }
    }

    resume() {
        if (this._ioctl && this._ioctl.isPaused()) {
            this._ioctl.resume();
            this._enableStatisticsReporter();
        }
    }

    seek(milliseconds: number) {
        if (this._mediaInfo == null || !this._mediaInfo.isSeekable()) {
            return;
        }

        let targetSegmentIndex = this._searchSegmentIndexContains(milliseconds);

        if (targetSegmentIndex === this._currentSegmentIndex) {
            // intra-segment seeking
            let segmentInfo = this._mediaInfo.segments![targetSegmentIndex];

            if (segmentInfo == undefined) {
                // current segment loading started, but mediainfo hasn't received yet
                // wait for the metadata loaded, then seek to expected position
                this._pendingSeekTime = milliseconds;
            } else {
                let keyframe = segmentInfo.getNearestKeyframe(milliseconds);
                this._remuxerRouter.clear();
                this._ioctl!.seek(keyframe!.fileposition);
                // Will be resolved in _onRemuxerMediaSegmentArrival()
                this._pendingResolveSeekPoint = keyframe!.milliseconds;
            }
        } else {
            // cross-segment seeking
            let targetSegmentInfo = this._mediaInfo.segments![targetSegmentIndex];

            if (targetSegmentInfo == undefined) {
                // target segment hasn't been loaded. We need metadata then seek to expected time
                this._pendingSeekTime = milliseconds;
                this._internalAbort();
                this._remuxerRouter.clear();
                this._remuxerRouter.insertDiscontinuity();
                this._loadSegment(targetSegmentIndex);
                // Here we wait for the metadata loaded, then seek to expected position
            } else {
                // We have target segment's metadata, direct seek to target position
                let keyframe = targetSegmentInfo.getNearestKeyframe(milliseconds);
                this._internalAbort();
                this._remuxerRouter.clear();
                this._remuxerRouter.insertDiscontinuity();
                this._demuxer!.resetMediaInfo();
                this._demuxer!.timestampBase = this._mediaDataSource.segments[targetSegmentIndex].timestampBase;
                this._loadSegment(targetSegmentIndex, keyframe!.fileposition);
                this._pendingResolveSeekPoint = keyframe!.milliseconds;
                this._reportSegmentMediaInfo(targetSegmentIndex);
            }
        }

        this._enableStatisticsReporter();
    }

    _searchSegmentIndexContains(milliseconds: number) {
        let segments = this._mediaDataSource.segments;
        let idx = segments.length - 1;

        for (let i = 0; i < segments.length; i++) {
            if (milliseconds < segments[i].timestampBase) {
                idx = i - 1;
                break;
            }
        }
        return idx;
    }

    _onInitChunkArrival(data: ArrayBuffer, byteStart: number) {
        let consumed = 0;

        if (byteStart > 0) {
            // IOController seeked immediately after opened, byteStart > 0 callback may received
            this._demuxer!.bindDataSource(this._ioctl!);
            this._demuxer!.timestampBase = this._mediaDataSource.segments[this._currentSegmentIndex].timestampBase;

            consumed = this._demuxer!.parseChunks(data, byteStart);
        } else {
            // byteStart == 0, Initial data, probe it first
            // Try probing input data as FLV first
            const probeData = FLVDemuxer.probe(data);
            if ('match' in probeData && probeData.match) {
                // Hit as FLV
                this._setupFLVDemuxerRemuxer(probeData);
                consumed = this._demuxer!.parseChunks(data, byteStart);
            } else if ('needMoreData' in probeData && probeData.needMoreData) {
                // keep consumed as 0, wait for more data
            } else {
                // Both probing as FLV / MPEG-TS failed, report error
                Log.e(this.TAG, 'Non MPEG-TS/FLV, Unsupported media type!');
                Promise.resolve().then(() => {
                    this._internalAbort();
                });
                this._emitter.emit(TransmuxingEvent.DEMUX_ERROR, DemuxErrors.FORMAT_UNSUPPORTED, 'Non MPEG-TS/FLV, Unsupported media type!');
                // Leave consumed as 0
            }
        }

        return consumed;
    }

    _setupFLVDemuxerRemuxer(probeData: FlvProbeSuccess) {
        this._demuxer = new FLVDemuxer(probeData, this._config, this._remuxerRouter);

        let mds = this._mediaDataSource;
        this._hasAudioTrack = probeData.hasAudioTrack;
        this._hasVideoTrack = probeData.hasVideoTrack;
        this._hasSelectedRemuxerForCodecs = false;
        this._pendingTrackMetadata = [];
        if (mds.duration != undefined && !isNaN(mds.duration)) {
            this._demuxer.overridedDuration = mds.duration;
        }
        if (typeof mds.hasAudio === 'boolean') {
            this._demuxer.overridedHasAudio = mds.hasAudio;
            this._hasAudioTrack = mds.hasAudio && probeData.hasAudioTrack;
        }
        if (typeof mds.hasVideo === 'boolean') {
            this._demuxer.overridedHasVideo = mds.hasVideo;
            this._hasVideoTrack = mds.hasVideo && probeData.hasVideoTrack;
        }

        this._demuxer.timestampBase = mds.segments[this._currentSegmentIndex].timestampBase;

        this._demuxer.onError = this._onDemuxException.bind(this);
        this._demuxer.onMediaInfo = this._onMediaInfo.bind(this);
        this._demuxer.onScriptMetadata = this._onScriptMetadata.bind(this);
        this._demuxer.onScriptData = this._onScriptData.bind(this);

        this._demuxer.bindDataSource(this._ioctl!);
        this._bindRemuxerRouterToDemuxer();
    }

    _onTrackData(audioTrack: AudioTrack, videoTrack: VideoTrack) {
        // Do not pass frames through the provisional remuxers until each
        // expected track has selected its output container.
        if (!this._hasSelectedRemuxerForCodecs) {
            return;
        }

        this._remuxerRouter.remuxTrackData(audioTrack, videoTrack);
    }

    _onTrackMetadata(metadata: AudioMetadata | VideoMetadata) {
        this._rememberDiscoveredTrack(metadata);
        this._emitTracksDiscoveredIfChanged();

        if (!this._isSelectedTrackMetadata(metadata)) {
            return;
        }

        if (metadata.type === TrackType.Video && this._hasSelectedRemuxerForCodecs) {
            this._switchVideoRemuxerIfNeeded(metadata);
        }

        if (!this._hasSelectedRemuxerForCodecs) {
            // Wait for all expected track metadata before creating the two
            // per-track remuxers, so frame queues cannot reach provisional ones.
            this._pendingTrackMetadata.push(metadata);

            if (!this._hasMetadataForAllTracks()) {
                return;
            }

            this._switchRemuxersIfNeeded(this._pendingTrackMetadata);
            this._hasSelectedRemuxerForCodecs = true;

            // remuxTrackMetadata() may emit init segments, so the remuxer must
            // already be selected before flushing the buffered metadata.
            while (this._pendingTrackMetadata.length > 0) {
                this._remuxerRouter.remuxTrackMetadata(this._pendingTrackMetadata.shift()!);
            }
            // MP4 batches initialization segments until data arrives. With
            // separate remuxers, emit both track inits now so MSE creates all
            // SourceBuffers before either audio or video media is appended.
            this._remuxerRouter.flushPendingInitSegments();
            return;
        }

        this._remuxerRouter.remuxTrackMetadata(metadata);
    }

    //!!@ is this ever called?
    _onMediaInfo(mediaInfo: MediaInfo) {
        if (this._mediaInfo == null) {
            // Store first segment's mediainfo as global mediaInfo
            this._mediaInfo = Object.assign({}, mediaInfo);
            this._mediaInfo.keyframesIndex = null;
            this._mediaInfo.segments = [];
            this._mediaInfo.segmentCount = this._mediaDataSource.segments.length;
            Object.setPrototypeOf(this._mediaInfo, MediaInfo.prototype);
        }

        let segmentInfo = Object.assign({}, mediaInfo);
        Object.setPrototypeOf(segmentInfo, MediaInfo.prototype);
        this._mediaInfo.segments![this._currentSegmentIndex] = segmentInfo;

        // notify mediaInfo update
        this._reportSegmentMediaInfo(this._currentSegmentIndex);

        if (this._pendingSeekTime != null) {
            Promise.resolve().then(() => {
                let target = this._pendingSeekTime!;
                this._pendingSeekTime = null;
                this.seek(target);
            });
        }
    }

    _onScriptMetadata(metadata: any) {
        this._emitter.emit(TransmuxingEvent.METADATA_ARRIVED, metadata);
    }

    _onScriptData(data: any) {
        this._emitter.emit(TransmuxingEvent.SCRIPTDATA_ARRIVED, data);
    }

    _onTimedID3Metadata(timed_id3_metadata: any) {
        let timestamp_base = this._remuxerRouter.timestampBase;
        if (timestamp_base == undefined) { return; }

        if (timed_id3_metadata.pts != undefined) {
            timed_id3_metadata.pts -= timestamp_base;
        }

        if (timed_id3_metadata.dts != undefined) {
            timed_id3_metadata.dts -= timestamp_base;
        }

        this._emitter.emit(TransmuxingEvent.TIMED_ID3_METADATA_ARRIVED, timed_id3_metadata);
    }

    _onIOSeeked() {
        this._remuxerRouter.insertDiscontinuity();
    }

    _onIOComplete(extraData: number) {
        let segmentIndex = extraData;
        let nextSegmentIndex = segmentIndex + 1;

        if (nextSegmentIndex < this._mediaDataSource.segments.length) {
            this._internalAbort();
            if (this._remuxerRouter) {
                this._remuxerRouter.flushStashedFrames();
            }
            this._loadSegment(nextSegmentIndex);
        } else {
            if (this._remuxerRouter) {
                this._remuxerRouter.flushStashedFrames();
            }
            this._emitter.emit(TransmuxingEvent.LOADING_COMPLETE);
            this._disableStatisticsReporter();
        }
    }

    _onIORedirect(redirectedURL: string) {
        let segmentIndex = this._ioctl!.extraData;
        this._mediaDataSource.segments[segmentIndex].redirectedURL = redirectedURL;
    }

    _onIORecoveredEarlyEof() {
        this._emitter.emit(TransmuxingEvent.RECOVERED_EARLY_EOF);
    }

    _onIOException(type: string, info: any) {
        Log.e(this.TAG, `IOException: type = ${type}, code = ${info.code}, msg = ${info.msg}`);
        this._emitter.emit(TransmuxingEvent.IO_ERROR, type, info);
        this._disableStatisticsReporter();
    }

    _onDemuxException(type: string, info: string) {
        Log.e(this.TAG, `DemuxException: type = ${type}, info = ${info}`);
        this._emitter.emit(TransmuxingEvent.DEMUX_ERROR, type, info);

        // An unsupported format cannot become playable by reading more input.
        // Abort after notifying listeners so no additional packets are parsed and
        // no end-of-stream stash flush runs against incomplete track metadata.
        if (type === DemuxErrors.FORMAT_UNSUPPORTED) {
            this.stop();
        }
    }

    _onRemuxerInitSegmentArrival(type: TrackType, initSegment: MSEInitSegment) {
        this._emitter.emit(TransmuxingEvent.INIT_SEGMENT, type, initSegment);
    }

    _onRemuxerMediaSegmentArrival(type: string, mediaSegment: any) {
        if (this._pendingSeekTime != null) {
            // Media segments after new-segment cross-seeking should be dropped.
            return;
        }
        this._emitter.emit(TransmuxingEvent.MEDIA_SEGMENT, type, mediaSegment);

        // Resolve pending seekPoint
        if (this._pendingResolveSeekPoint != null && type === 'video') {
            let syncPoints = mediaSegment.info.syncPoints;
            let seekpoint = this._pendingResolveSeekPoint;
            this._pendingResolveSeekPoint = null;

            // Safari: Pass PTS for recommend_seekpoint
            if (Browser.safari && syncPoints.length > 0 && syncPoints[0].originalDts === seekpoint) {
                seekpoint = syncPoints[0].pts;
            }
            // else: use original DTS (keyframe.milliseconds)

            this._emitter.emit(TransmuxingEvent.RECOMMEND_SEEKPOINT, seekpoint);
        }
    }

    _enableStatisticsReporter() {
        if (this._statisticsReporter == null) {
            this._statisticsReporter = self.setInterval(
                this._reportStatisticsInfo.bind(this),
            this._config.statisticsInfoReportInterval);
        }
    }

    _disableStatisticsReporter() {
        if (this._statisticsReporter) {
            self.clearInterval(this._statisticsReporter);
            this._statisticsReporter = null;
        }
    }

    _reportSegmentMediaInfo(segmentIndex: number) {
        // Get current segment's MediaInfo. `segments` is set when first mediaInfo arrives.
        const mediaInfo = this._mediaInfo;
        const segmentInfo = mediaInfo?.segments?.[segmentIndex];
        if (!segmentInfo) {
            return;
        }

        // Omit heavyweight fields before emitting
        const { keyframesIndex, segments, ...rest } = segmentInfo as any;
        const exportInfo: any = {
            ...rest,
            duration: mediaInfo.duration,
            segmentCount: mediaInfo.segmentCount,
        };

        this._emitter.emit(TransmuxingEvent.MEDIA_INFO, exportInfo);
    }

    _reportStatisticsInfo() {
        let info: any = {};

        info.url = this._ioctl!.currentURL;
        info.hasRedirect = this._ioctl!.hasRedirect;
        if (info.hasRedirect) {
            info.redirectedURL = this._ioctl!.currentRedirectedURL;
        }

        info.speed = this._ioctl!.currentSpeed;
        info.loaderType = this._ioctl!.loaderType;
        info.currentSegmentIndex = this._currentSegmentIndex;
        info.totalSegmentCount = this._mediaDataSource.segments.length;

        this._emitter.emit(TransmuxingEvent.STATISTICS_INFO, info);
    }

}

export default TransmuxingController;
