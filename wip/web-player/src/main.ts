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
  { label: "AVC + AAC", value: "./assets/sample-avc-1920x1080-aac-2ch-48000.flv" },
  { label: "AV1 + AAC", value: "./assets/output_allkey_av1_aac.flv" },
  { label: "Test File", value: "./assets/test-output_allkey_av1_aac.flv" }
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

  videoElement = document.getElementById('videoElement') as HTMLVideoElement;
  if (!videoElement) {
    console.error('Video element not found!');
    return;
  }

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

  controlsDiv.appendChild(fileSelect);
  controlsDiv.appendChild(createPlayerButton);
  controlsDiv.appendChild(hasAudioLabel);
  controlsDiv.appendChild(hasVideoLabel);
  controlsDiv.appendChild(useWebMLabel);

  document.body.appendChild(controlsDiv)

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
  // !!@TODO: take a look at flags below, logic to handle them is scattered around the code
  const player = Mpegts.createPlayer({
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

  if (!player) {
    console.error('Failed to create player!');
    return null;
  }

  player.on('error', (...args) => {
    console.error('Player error event args:', args);
  });

  player.on('sourceopen', () => {
    console.log('MediaSource opened');
    if (videoElement.paused) {
      player.play().catch((e: Error) => console.error('Play failed:', e));
    }
  });

  player.on('sourceended', () => {
    console.log('MediaSource ended');
  });

  player.on('statistics_info', (stats) => {
    console.log('Player statistics:', stats);
  });

  // Simple initialization sequence
  try {
    player.attachMediaElement(videoElement);
    player.load();
  } catch (e) {
    console.error('Error during player initialization:', e);
  }

  return player;
}
// Initialize only after window load
window.addEventListener('load', () => {
  initLayout();
});
