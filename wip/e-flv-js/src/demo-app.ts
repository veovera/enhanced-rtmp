/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Copyright (C) 2025 Veovera Software Organization
 * @author Slavik Lozben
 * 
 */

import { eflv, NativePlayer,  MSEPlayer, TransmuxingEvents, Remuxer, defaultConfig } from "@/mux-lib";

const hasAudioLabel: HTMLLabelElement = document.createElement('label');
const hasAudioCheckbox: HTMLInputElement = document.createElement('input');
const hasVideoLabel: HTMLLabelElement = document.createElement('label');
const hasVideoCheckbox: HTMLInputElement = document.createElement('input');
const useWebMLabel: HTMLLabelElement = document.createElement('label');
const useWebMCheckbox: HTMLInputElement = document.createElement('input');

let videoElement: HTMLVideoElement;
let player: MSEPlayer | NativePlayer | null = null;
let fileSelect: HTMLSelectElement;

// Static list of files to choose from, note: these files must be present in the assets folder
// farther down we overrite this list and dynamically populate the dropdown with folder contents
// this list is for reference/debugging
let fileList = [
  { label: "bbb-avc-aac.flv", value: "./assets/bbb-avc-aac.flv" },
  { label: "bbb-hevc-aac.flv", value: "./assets/bbb-hevc-aac.flv" },
  { label: "bbb-av1-aac.flv", value: "./assets/bbb-av1-aac.flv" },
  { label: "bbb-av1-opus.flv", value: "./assets/bbb-av1-opus.flv" },
  { label: "bbb-vp9-aac.flv", value: "./assets/bbb-vp9-aac.flv" },
  { label: "test-av1-aac.flv", value: "./assets/test-av1-aac.flv" },
  { label: "bbb-av1-aac-10s-4thframe-iskey.flv", value: "./assets/bbb-av1-aac-10s-4thframe-iskey.flv" },
  { label: "bbb-av1-aac-60thframe-iskey.flv", value: "./assets/bbb-av1-aac-60thframe-iskey.flv" },
  { label: "bbb-av1-aac-allkey.flv", value: "./assets/bbb-av1-aac-allkey.flv" },
];
let selectedFile = fileList[0].value; // Default selection

function populateFileList() {
  // Clear existing options
  fileSelect.innerHTML = '';

  // Populate with new options
  fileList.forEach(file => {
    const option = document.createElement('option');
    option.value = file.value;
    option.textContent = file.label;
    fileSelect.appendChild(option);
  });

  fileSelect.value = selectedFile = fileList[0].value; // Select the first file by default
}

function initLayout() {
  if (!eflv.isSupported()) {
    console.error("Your browser doesn't support e-flv!");
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
  }
  .trace-textarea {
    width: 640px;
    height: 520px;
    font-family: monospace;
    font-size: 11px;
    background: #f8f8f8;
    border: 1px solid #ccc;
    padding: 8px;
    resize: vertical;
    margin-top: 32px;
  }`;

  document.head.appendChild(style);

  // Create a flex container for video and trace output
  const mainRow = document.createElement('div');
  mainRow.style.display = 'flex';
  mainRow.style.alignItems = 'flex-start';
  mainRow.style.gap = '32px';
  
  videoElement.style.marginTop = '0px';
  mainRow.appendChild(videoElement);

  // After mainRow.appendChild(videoElement);
  const videoMetadataBox = document.createElement('textarea');
  videoMetadataBox.id = 'videoMetadataBox';
  videoMetadataBox.readOnly = true;
  videoMetadataBox.style.height = '400px';
  videoMetadataBox.style.marginTop = '0px';
  videoMetadataBox.className = 'trace-textarea';

  mainRow.appendChild(videoMetadataBox);

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

  // Now insert mainRow after the title and hr
  document.body.insertBefore(mainRow, hr.nextSibling);

  document.body.appendChild(document.createElement('hr'));

  // Add dropdown for file selection
  fileSelect = document.createElement('select');
  fileSelect.id = 'fileSelect';
  populateFileList();
  fileSelect.onchange = () => {
    selectedFile = fileSelect.value;
  };

  // Add a manual create player button
  const createPlayerButton = document.createElement('button');
  createPlayerButton.textContent = 'Create Player';
  createPlayerButton.onclick = () => {
    player = createPlayer();
  };

  const mseBuffersButton = document.createElement('button');
  mseBuffersButton.textContent = 'Download Appended MSE Buffers';
  mseBuffersButton.disabled = true; // Initially disabled
  mseBuffersButton.onclick = () => {
    if (Remuxer.dbgVideoBuffer.length === 0) {
      console.error('No appended MSE buffers available for download.');
      return;
    }

    const blob = new Blob([Remuxer.dbgVideoBuffer as BlobPart], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = 'dbgBuffer.bin'; // Name of the downloaded file  
    a.click();  
    
    URL.revokeObjectURL(url);
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
  useWebMLabel.append('Use WebM (valid for AV1/Opus codecs)');

  // Append the button to the controlsDiv
  controlsDiv.appendChild(fileSelect);
  controlsDiv.appendChild(createPlayerButton);
  controlsDiv.appendChild(hasAudioLabel);
  controlsDiv.appendChild(hasVideoLabel);
  controlsDiv.appendChild(useWebMLabel);
  controlsDiv.appendChild(mseBuffersButton);

  document.body.appendChild(controlsDiv)

  // Create a flex container for the debug trace boxes
  const dbgRow = document.createElement('div');
  dbgRow.style.display = 'flex';
  dbgRow.style.alignItems = 'flex-start';
  dbgRow.style.gap = '32px';

  // Create the first debug trace box
  const videoInfoBox = document.createElement('textarea');
  videoInfoBox.id = 'videoInfoBox';
  videoInfoBox.readOnly = true;
  videoInfoBox.className = 'trace-textarea';

  // Create the second debug trace box
  const videoFrameInfoBox = document.createElement('textarea');
  videoFrameInfoBox.id = 'videoFrameInfoBox';
  videoFrameInfoBox.readOnly = true;
  videoFrameInfoBox.className = 'trace-textarea';

  // Create the config info box (to the right of videoFrameInfoBox)
  const configInfoBox = document.createElement('textarea');
  configInfoBox.id = 'configInfoBox';
  configInfoBox.readOnly = true;
  configInfoBox.className = 'trace-textarea';

  // Add both boxes to the flex row
  dbgRow.appendChild(videoInfoBox);
  dbgRow.appendChild(videoFrameInfoBox);
  dbgRow.appendChild(configInfoBox);

  // Append the flex row to the document body
  document.body.appendChild(dbgRow);

  // Create the tip paragraph
  const tip = document.createElement('p');
  tip.innerHTML = `<strong>Tip:</strong> To debug media playback, open <code>chrome://media-internals</code> in a new Chrome tab.`;
  document.body.appendChild(tip);

  if (__DEBUG__) {
    const videoInfoCallback = () => {
      function getReadyStateString(readyState: number): string {
        switch (readyState) {
          case 0: return "HAVE_NOTHING";
          case 1: return "HAVE_METADATA";
          case 2: return "HAVE_CURRENT_DATA";
          case 3: return "HAVE_FUTURE_DATA";
          case 4: return "HAVE_ENOUGH_DATA";
          default: return "UNKNOWN";
        }
      }
      function getNetworkStateString(networkState: number): string {
        switch (networkState) {
          case 0: return "NETWORK_EMPTY";
          case 1: return "NETWORK_IDLE";
          case 2: return "NETWORK_LOADING";
          case 3: return "NETWORK_NO_SOURCE";
          default: return "UNKNOWN";
        }
      }
      const traceBox = document.getElementById('videoInfoBox') as HTMLTextAreaElement;
      videoElement.controls = true; // Ensure controls are enabled for the video element

      if (Remuxer.dbgVideoBuffer.length > 0) {
        mseBuffersButton.disabled = false;
      } else {
        mseBuffersButton.disabled = true;
      }

      traceBox.value = "*** Video Element Properties ***\n";
      traceBox.value += "================================\n";
      traceBox.value += `Ended: ${videoElement.ended}\n`;
      traceBox.value += `Volume: ${videoElement.volume}\n`;
      traceBox.value += `Muted: ${videoElement.muted}\n`;
      traceBox.value += `Playback Rate: ${videoElement.playbackRate}\n`;
      traceBox.value += `Ready State: ${videoElement.readyState} (${getReadyStateString(videoElement.readyState)})\n`;
      traceBox.value += `Network State: ${videoElement.networkState} (${getNetworkStateString(videoElement.networkState)})\n`;
      traceBox.value += `Width: ${videoElement.videoWidth}\n`;
      traceBox.value += `Height: ${videoElement.videoHeight}\n`;

      traceBox.value += `Paused: ${videoElement.paused}\n`;
      traceBox.value += `Duration: ${videoElement.duration}\n`;
      traceBox.value += `Current Playback Time: ${videoElement.currentTime}\n`;
      traceBox.value += "Buffered ranges:\n";
      const buffered = videoElement.buffered;
      for (let i = 0; i < buffered.length; i++) {
        traceBox.value += `${buffered.start(i)} - ${buffered.end(i)}\n`;
      }
    }

    const videoFrameCallback = (now: DOMHighResTimeStamp, frame: VideoFrameCallbackMetadata) => {
      const traceBox = document.getElementById('videoFrameInfoBox') as HTMLTextAreaElement;
      const playbackQuality = videoElement.getVideoPlaybackQuality();

      traceBox.value =  `***     Video Frame Info     ***\n`;
      traceBox.value += "================================\n";

      traceBox.value += `High res time since page load: ${now}\n\n`;

      traceBox.value += `QOS\n---\n`;
      traceBox.value += `Dropped Frames: ${playbackQuality.droppedVideoFrames}\n`;
      traceBox.value += `Total Frames: ${playbackQuality.totalVideoFrames}\n`;
      traceBox.value += `Corrupted Frames: ${playbackQuality?.corruptedVideoFrames}\n\n`;

      traceBox.value += `Video Frame Metadata\n---------------------\n`;
      traceBox.value += `json: ${JSON.stringify(frame, null, 2)}\n`;
      videoInfoCallback();
      videoElement.requestVideoFrameCallback(videoFrameCallback);
    }
    setInterval(videoInfoCallback, 1000);
    videoElement.requestVideoFrameCallback(videoFrameCallback);
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

function updateConfigInfoBox(options: {}) {
  const mergedOptions = { ...defaultConfig, ...options };
  const traceBox = document.getElementById('configInfoBox') as HTMLTextAreaElement;
  traceBox.value = "*** Player Configuration ***\n";
  traceBox.value += "================================\n";
  traceBox.value += `json: ${JSON.stringify({configOptions: mergedOptions}, null, 2)}\n\n`;
};

function createPlayer(): MSEPlayer | NativePlayer | null {
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


  const mediaDataSource = {
    type: 'flv',
    url: selectedFile,  // Use the selected file from the dropdown
    hasAudio: hasAudioCheckbox.checked,
    hasVideo: hasVideoCheckbox.checked,
    cors: true,
    withCredentials: false,
    useWebM: useWebMCheckbox.checked,
  };

  const config = {
    enableStashBuffer: false,     // when true improves performance for network jitter
    fixAudioTimestampGap: false,  // when true fixes gaps in audio timestamps to improve sync
    rangeLoadZeroStart: true,     // Always start range requests from 0
  };

  const _player = eflv.createPlayer(mediaDataSource, config);
  updateConfigInfoBox({mediaDataSource, ...config});

  if (!_player) {
    console.error('Failed to create player!');
    return null;
  }

  _player.on('error', (...args) => {
    console.error('Player error event args:', args);
  });

  _player.on('statistics_info', (stats) => {
    console.log('Player statistics:', stats);
  });

  // Auto-play when metadata is ready on the media element
  videoElement.addEventListener('loadedmetadata', () => {
    if (videoElement.paused) {
      _player.play().catch((e: Error) => console.error('Play failed:', e));
    }
  }, { once: true });

  _player.on(TransmuxingEvents.SCRIPTDATA_ARRIVED, (scriptData) => {
    const traceBox = document.getElementById('videoMetadataBox') as HTMLTextAreaElement;

    traceBox.value  = "*** Metadata (onMetaData) arrived ***\n";
    traceBox.value += "=====================================\n";

    traceBox.value += `json: ${JSON.stringify(scriptData, null, 2)}\n`;
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
  videoElement = document.getElementById('videoElement') as HTMLVideoElement;
  if (!videoElement) {
    console.error('Video element not found!');
    return;
  }
  videoElement.controls = true;
  videoElement.src = "./assets/bbb-av1.webm"; // Default video source
  initLayout();
});

interface FlvListing {
  path: string;
  list: string[];
}

interface FlvFileLists {
  assets: FlvListing;
  demoAssets: FlvListing;
}

const DEMO_ASSETS_DIR = './demo-assets';
const ASSETS_DIR = './assets';

async function fetchAndExtractList(path: string): Promise<FlvListing> {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);

  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const items = Array.from(doc.querySelectorAll('a[href]'))
    .map(a => (a as HTMLAnchorElement).getAttribute('href') || '')
    .filter(href => href && !href.startsWith('?'))
    .map(href => new URL(href, res.url))
    .filter(u => u.pathname.toLowerCase().endsWith('.flv'))
    .map(u => decodeURIComponent(u.pathname.split('/').pop() || ''));

  const list = Array.from(new Set(items)).sort((a, b) => a.localeCompare(b));
  return { path, list };
}

async function getFlvFileList(): Promise<FlvFileLists> {
  const [demoAssets, assets]: [FlvListing, FlvListing] = await Promise.all([
    fetchAndExtractList(DEMO_ASSETS_DIR),
    fetchAndExtractList(ASSETS_DIR),
  ]);

  if (demoAssets.list.length === 0 && assets.list.length === 0) {
    throw new Error('No FLV files found in demo-assets or assets');
  }

  return { assets, demoAssets };
}

getFlvFileList()
  .then(({ assets, demoAssets }) => {
    if (demoAssets.list.length > 0) {
      fileList = demoAssets.list.map(filename => ({
        label: filename,
        value: `${DEMO_ASSETS_DIR}/${filename}`
      }));
    }

    if (assets.list.length > 0) {
      fileList = fileList.concat(assets.list.map(filename => ({
        label: filename,
        value: `${ASSETS_DIR}/${filename}`
      })));
    }

    populateFileList();
  })
  .catch(err => console.error('Failed to get FLV files:', err));