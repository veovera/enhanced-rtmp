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

import IOController from '../io/io-controller.js';
import {createDefaultConfig} from '../config.js';

type ManagedMediaSourceConstructor = {
    isTypeSupported(type: string): boolean;
};

function getManagedMediaSource(): ManagedMediaSourceConstructor | undefined {
    return (self as typeof self & {ManagedMediaSource?: ManagedMediaSourceConstructor}).ManagedMediaSource;
}

export interface FeatureList {
    msePlayback: boolean;
    mseLivePlayback: boolean;
    mseH265Playback: boolean;
    networkStreamIO: boolean;
    networkLoaderName: string;
    nativeMP4H264Playback: boolean;
    nativeMP4H265Playback: boolean;
    nativeWebmVP8Playback: boolean;
    nativeWebmVP9Playback: boolean;
}

class Features {

    private static videoElement?: HTMLVideoElement;

    static supportMSEH264Playback(): boolean {
        const avc_aac_mime_type = 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"';
        const support_w3c_mse = !!self.MediaSource && self.MediaSource.isTypeSupported(avc_aac_mime_type);
        const managedMediaSource = getManagedMediaSource();
        const support_apple_mme = !!managedMediaSource && managedMediaSource.isTypeSupported(avc_aac_mime_type);
        return support_w3c_mse || support_apple_mme;
    }

    static supportMSEH265Playback(): boolean {
        const hevc_mime_type = 'video/mp4; codecs="hvc1.1.6.L93.B0"';
        const support_w3c_mse = !!self.MediaSource && self.MediaSource.isTypeSupported(hevc_mime_type);
        const managedMediaSource = getManagedMediaSource();
        const support_apple_mme = !!managedMediaSource && managedMediaSource.isTypeSupported(hevc_mime_type);
        return support_w3c_mse || support_apple_mme;
    }

    static supportNetworkStreamIO(): boolean {
        let ioctl = new IOController({}, createDefaultConfig());
        let loaderType = ioctl.loaderType;
        ioctl.destroy();
        return loaderType == 'fetch-stream-loader' || loaderType == 'xhr-moz-chunked-loader';
    }

    static getNetworkLoaderTypeName(): string {
        let ioctl = new IOController({}, createDefaultConfig());
        let loaderType = ioctl.loaderType;
        ioctl.destroy();
        return loaderType;
    }

    static supportNativeMediaPlayback(mimeType: string): boolean {
        if (Features.videoElement === undefined) {
            Features.videoElement = window.document.createElement('video');
        }
        let canPlay = Features.videoElement.canPlayType(mimeType);
        return canPlay === 'probably' || canPlay == 'maybe';
    }

    static getFeatureList(): FeatureList {
        let features: FeatureList = {
            msePlayback: false,
            mseLivePlayback: false,
            mseH265Playback: false,
            networkStreamIO: false,
            networkLoaderName: '',
            nativeMP4H264Playback: false,
            nativeMP4H265Playback: false,
            nativeWebmVP8Playback: false,
            nativeWebmVP9Playback: false
        };

        features.msePlayback = Features.supportMSEH264Playback();
        features.networkStreamIO = Features.supportNetworkStreamIO();
        features.networkLoaderName = Features.getNetworkLoaderTypeName();
        features.mseLivePlayback = features.msePlayback && features.networkStreamIO;
        features.mseH265Playback = Features.supportMSEH265Playback();
        features.nativeMP4H264Playback = Features.supportNativeMediaPlayback('video/mp4; codecs="avc1.42001E, mp4a.40.2"');
        features.nativeMP4H265Playback = Features.supportNativeMediaPlayback('video/mp4; codecs="hvc1.1.6.L93.B0"');
        features.nativeWebmVP8Playback = Features.supportNativeMediaPlayback('video/webm; codecs="vp8.0, vorbis"');
        features.nativeWebmVP9Playback = Features.supportNativeMediaPlayback('video/webm; codecs="vp9"');

        return features;
    }

}

export default Features;
