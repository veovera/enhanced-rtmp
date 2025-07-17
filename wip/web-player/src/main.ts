/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Copyright (C) 2025 Veovera Software Organization
 * @author Slavik Lozben
 * 
 */

import Mpegts from "@/mux-lib"
import NativePlayer from "./mux-lib/player/native-player";
import MSEPplayer from "./mux-lib/player/mse-player";
import TransmuxingEvents from './mux-lib/core/transmuxing-events';

const hasAudioLabel: HTMLLabelElement = document.createElement('label');
const hasAudioCheckbox: HTMLInputElement = document.createElement('input');
const hasVideoLabel: HTMLLabelElement = document.createElement('label');
const hasVideoCheckbox: HTMLInputElement = document.createElement('input');
const useWebMLabel: HTMLLabelElement = document.createElement('label');
const useWebMCheckbox: HTMLInputElement = document.createElement('input');

let videoElement: HTMLVideoElement;
let player: MSEPplayer | NativePlayer | null = null;

// Static list of files to choose from
const fileList = [
  { label: "chopped.flv", value: "./assets/chopped.flv" },
  { label: "bbb-av1-aac-60thframe-iskey.flv", value: "./assets/bbb-av1-aac-60thframe-iskey.flv" },
  { label: "bbb-av1-aac-10s-4thframe-iskey.flv", value: "./assets/bbb-av1-aac-10s-4thframe-iskey.flv" },
  { label: "bbb-av1-aac-10s-4thframe-isnotkey.flv", value: "./assets/bbb-av1-aac-10s-4thframe-isnotkey.flv" },
  { label: "bbb-av1-aac-10s-nokey.flv", value: "./assets/bbb-av1-aac-10s-nokey.flv" },
  { label: "bbb-av1-aac.flv", value: "./assets/bbb-av1-aac.flv" },
  { label: "bbb-av1-aac-allkey.flv", value: "./assets/bbb-av1-aac-allkey.flv" },
  { label: "bbb-av1-aac-10s-4thframe-iskey.flv", value: "./assets/bbb-av1-aac-10s-4thframe-iskey.flv" },
  { label: "bbb-vp9-aac.flv", value: "./assets/bbb-vp9-aac.flv" },
  { label: "bbb-avc-aac.flv", value: "./assets/bbb-avc-aac.flv" },
  { label: "test-av1-aac.flv", value: "./assets/test-av1-aac.flv" },
];
let selectedFile = fileList[0].value; // Default selection

function initLayout() {
  //!!@ remove mpegts mentiones since this is only for e-flv
  if (!Mpegts.isSupported()) {
    console.error("Your browser doesn't support mpegts.js");
    return;
  }

  const style = document.createElement('style');
  style.textContent = `
  .controls-row {
    display: flex;
    align-items: center;
    gap: 24px; /* horizontal space between all children */
    margin-top: 10px;
    margin-bottom: 10px;
  }`;
  document.head.appendChild(style);

  // Create a flex container for video and trace output
  const mainRow = document.createElement('div');
  mainRow.style.display = 'flex';
  mainRow.style.alignItems = 'flex-start';
  mainRow.style.gap = '32px';

  videoElement = document.getElementById('videoElement') as HTMLVideoElement;
  if (!videoElement) {
    console.error('Video element not found!');
    return;
  }
  mainRow.appendChild(videoElement);

  // After mainRow.appendChild(videoElement);
  const infoTraceBox = document.createElement('textarea');
  infoTraceBox.id = 'infoTraceBox';
  infoTraceBox.readOnly = true;
  infoTraceBox.style.width = '640px';
  infoTraceBox.style.height = '480px';
  infoTraceBox.style.fontFamily = 'monospace';
  infoTraceBox.style.fontSize = '12px';
  infoTraceBox.style.background = '#f8f8f8';
  infoTraceBox.style.border = '1px solid #ccc';
  infoTraceBox.style.padding = '8px';
  infoTraceBox.style.resize = 'vertical';
  mainRow.appendChild(infoTraceBox);

  // Create and insert the title and horizontal rule
  const titleDiv = document.createElement('div');
  titleDiv.style.fontWeight = 'bold';
  titleDiv.style.fontSize = '1.3em';
  titleDiv.style.marginBottom = '8px';
  titleDiv.textContent = 'E-FLV Web Player';

  const hr = document.createElement('hr');

  // Insert at the top of the body
  document.body.insertBefore(titleDiv, document.body.firstChild);
  document.body.insertBefore(hr, titleDiv.nextSibling);

  // Insert at the top of the body
  document.body.insertBefore(titleDiv, document.body.firstChild);
  document.body.insertBefore(hr, titleDiv.nextSibling);

  // Now insert mainRow after the title and hr
  document.body.insertBefore(mainRow, hr.nextSibling);

  document.body.appendChild(document.createElement('hr'));

  // Add dropdown for file selection
  const fileSelect = document.createElement('select');
  fileSelect.id = 'fileSelect';
  fileList.forEach(file => {
    const option = document.createElement('option');
    option.value = file.value;
    option.textContent = file.label;
    fileSelect.appendChild(option);
  });
  fileSelect.value = selectedFile;
  fileSelect.onchange = () => {
    selectedFile = fileSelect.value;
  };

  // Add a manual play button for user interaction
  const createPlayerButton = document.createElement('button');
  createPlayerButton.textContent = 'Create Player';
  createPlayerButton.onclick = () => {
    player = createPlayer();
  };

  // Add a button to open chrome://media-internals
  const mediaInternalsButton = document.createElement('button');
  mediaInternalsButton.textContent = 'Open Media Internals';
  mediaInternalsButton.onclick = () => {
    navigator.clipboard.writeText('chrome://media-internals').then(() => {
      alert('URL copied to clipboard! Please paste it into your browser\'s address bar.');
    }).catch((err) => {
      console.error('Failed to copy URL:', err);
    });
  };

  // Add checkboxes below the video element
  const controlsDiv: HTMLDivElement = document.createElement('div');
  controlsDiv.className = 'controls-row'; // Use the flex row class

  hasAudioCheckbox.type = 'checkbox';
  hasAudioCheckbox.id = 'hasAudio';
  hasAudioCheckbox.checked = true;

  hasAudioLabel.textContent = '';
  hasAudioLabel.appendChild(hasAudioCheckbox);
  hasAudioLabel.append('hasAudio');

  hasVideoCheckbox.type = 'checkbox';
  hasVideoCheckbox.id = 'hasVideo';
  hasVideoCheckbox.checked = true;

  hasVideoLabel.textContent = '';
  hasVideoLabel.appendChild(hasVideoCheckbox);
  hasVideoLabel.append('hasVideo');

  useWebMCheckbox.type = 'checkbox';
  useWebMCheckbox.id = 'useWebM';
  useWebMCheckbox.checked = true;
  useWebMLabel.textContent = '';
  useWebMLabel.appendChild(useWebMCheckbox);
  useWebMLabel.append('Use WebM');

  // Append the button to the controlsDiv
  controlsDiv.appendChild(fileSelect);
  controlsDiv.appendChild(createPlayerButton);
  controlsDiv.appendChild(hasAudioLabel);
  controlsDiv.appendChild(hasVideoLabel);
  controlsDiv.appendChild(useWebMLabel);
  controlsDiv.appendChild(mediaInternalsButton);

  document.body.appendChild(controlsDiv)

  // Add a second trace box at the bottom of the page
  const dbgTraceBox = document.createElement('textarea');
  dbgTraceBox.id = 'dbgTraceBox';
  dbgTraceBox.readOnly = true;
  dbgTraceBox.style.width = '640px';
  dbgTraceBox.style.height = '240px';
  dbgTraceBox.style.fontFamily = 'monospace';
  dbgTraceBox.style.fontSize = '12px';
  dbgTraceBox.style.background = '#f8f8f8';
  dbgTraceBox.style.border = '1px solid #ccc';
  dbgTraceBox.style.padding = '8px';
  dbgTraceBox.style.resize = 'vertical';
  dbgTraceBox.style.marginTop = '32px';
  document.body.appendChild(dbgTraceBox);

  if (__DEBUG__) {
    setInterval(() => {
      const traceBox = document.getElementById('dbgTraceBox') as HTMLTextAreaElement;

      traceBox.value = "*** Video Element State ***\n";
      traceBox.value += "===========================\n";
      traceBox.value += `Ended: ${videoElement.ended}\n`;
      traceBox.value += `Volume: ${videoElement.volume}\n`;
      traceBox.value += `Muted: ${videoElement.muted}\n`;
      traceBox.value += `Playback Rate: ${videoElement.playbackRate}\n`;
      traceBox.value += `Ready State: ${videoElement.readyState}\n`;
      traceBox.value += `Network State: ${videoElement.networkState}\n`;
      traceBox.value += `Video Width: ${videoElement.videoWidth}\n`;
      traceBox.value += `Video Height: ${videoElement.videoHeight}\n\n`;

      traceBox.value += `Paused: ${videoElement.paused}\n`;
      traceBox.value += `Duration: ${videoElement.duration}\n`;
      traceBox.value += `Current Time: ${videoElement.currentTime}\n`;
      const buffered = videoElement.buffered;
      traceBox.value += "Buffered ranges:\n";
      for (let i = 0; i < buffered.length; i++) {
        traceBox.value += `${buffered.start(i)} - ${buffered.end(i)}\n`;
      }
    }, 1000);
  }

  // Add event listeners for error handling
  videoElement.addEventListener('error', (event) => {
    const error = videoElement.error;

    if (error) {
      switch (error.code) {
        case error.MEDIA_ERR_ABORTED:
          console.error('Video playback was aborted.');
          break;
        case error.MEDIA_ERR_NETWORK:
          console.error('A network error caused the video download to fail.');
          break;
        case error.MEDIA_ERR_DECODE:
          console.error('The video playback was aborted due to a corruption problem or because the video used features your browser did not support.');
          break;
        case error.MEDIA_ERR_SRC_NOT_SUPPORTED:
          console.error('The video could not be loaded, either because the server or network failed or because the format is not supported.');
          break;
        default:
          console.error('An unknown video error occurred.');
          break;
      }
    }
  });
}

function createPlayer(): MSEPplayer | NativePlayer | null {
  // Simpler configuration focusing on essential parameters
  // !!@TODO: add a config object
  // !!@TODO: take a look at flags below, logic to handle them is scattered around the code    console.warn('Player already exists, detaching previous media element.');
 
 if (player) {
    player.detachMediaElement();
    player.destroy();
    player = null;
  }
  
  if (!videoElement) {
    console.error('Video element not found!');
    return null;
  }

  const _player = Mpegts.createPlayer({
    type: 'flv',
    url: selectedFile,  // Use the selected file from the dropdown
    isLive: false,
    hasAudio: hasAudioCheckbox.checked,
    hasVideo: hasVideoCheckbox.checked,
    enableStashBuffer: false,
    stashInitialSize: 128,
    cors: true,
    withCredentials: false,
    seekType: 'range',
    fixAudioTimestampGap: false,
    rangeLoadZeroStart: true,
    useWebM: useWebMCheckbox.checked
  });

  if (!_player) {
    console.error('Failed to create player!');
    return null;
  }

  _player.on('error', (...args) => {
    console.error('Player error event args:', args);
  });

  _player.on('sourceopen', () => {
    console.log('MediaSource opened');
    if (videoElement.paused) {
      _player.play().catch((e: Error) => console.error('Play failed:', e));
    }
  });

  _player.on('sourceended', () => {
    console.log('MediaSource ended');
  });

  _player.on('statistics_info', (stats) => {
    console.log('Player statistics:', stats);
  });


  _player.on(TransmuxingEvents.SCRIPTDATA_ARRIVED, (scriptData) => {
    const traceBox = document.getElementById('infoTraceBox') as HTMLTextAreaElement;

    traceBox.value = '[METADATA_ARRIVED]\n' + JSON.stringify(scriptData, null, 2) + '\n\n';
    traceBox.value += '\nnote:\n';
    if (scriptData?.onMetaData.videocodecid) {
      const code = scriptData.onMetaData.videocodecid;
      let fourcc: string;
      if (code < 16) {
        // Legacy FLV codec IDs (not fourcc)
        switch (code) {
          case 2: fourcc = 'Sorenson H.263'; break;
          case 3: fourcc = 'Screen video'; break;
          case 4: fourcc = 'On2 VP6'; break;
          case 5: fourcc = 'On2 VP6 Alpha'; break;
          case 6: fourcc = 'Screen video v2'; break;
          case 7: fourcc = 'AVC (H.264)'; break;
          case 12: fourcc = 'HEVC (H.265)'; break;
          default: fourcc = 'Unknown legacy FLV codec'; break;
        }
      } else {
        // Standard fourcc for codecs
        fourcc = String.fromCharCode(
          (code >> 24) & 0xFF,
          (code >> 16) & 0xFF,
          (code >> 8) & 0xFF,
          code & 0xFF
        );
      }
      traceBox.value += `Video codec: ${fourcc} (${code})\n`;
    }

    if (scriptData?.onMetaData.audiocodecid) {
      const code = scriptData.onMetaData.audiocodecid;
      let fourcc: string;
      if (code < 16) {
        // Legacy FLV codec IDs (not fourcc)
        switch (code) {
          case 0: fourcc = 'Linear PCM, platform endian'; break;
          case 1: fourcc = 'ADPCM'; break;
          case 2: fourcc = 'MP3'; break;
          case 3: fourcc = 'Linear PCM, little endian'; break;
          case 4: fourcc = 'Nellymoser 16 kHz mono'; break;
          case 5: fourcc = 'Nellymoser 8 kHz mono'; break;
          case 6: fourcc = 'Nellymoser'; break;
          case 7: fourcc = 'G.711 A-law logarithmic PCM'; break;
          case 8: fourcc = 'G.711 mu-law logarithmic PCM'; break;
          case 9: fourcc = 'reserved'; break;
          case 10: fourcc = 'AAC'; break;
          case 11: fourcc = 'Speex'; break;
          case 14: fourcc = 'MP3 8 kHz'; break;
          case 15: fourcc = 'Device-specific sound'; break;
          default: fourcc = 'Unknown legacy FLV audio codec'; break;
        }
      } else {
        // Standard fourcc for codecs
        fourcc = String.fromCharCode(
          (code >> 24) & 0xFF,
          (code >> 16) & 0xFF,
          (code >> 8) & 0xFF,
          code & 0xFF
        );
      }
      traceBox.value += `Audio codec: ${fourcc} (${code})\n`;
    }
    traceBox.scrollTop = 0;  
  });


  // Simple initialization sequence
  try {
    _player.attachMediaElement(videoElement);
    _player.load();
  } catch (e) {
    console.error('Error during player initialization:', e);
  }

  return _player;
}
// Initialize only after window load
window.addEventListener('load', () => {
  initLayout();
});
