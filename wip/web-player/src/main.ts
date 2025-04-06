import Mpegts from "@/mux-lib"
//import Mpegts from "./mux-lib/";

// main.ts
console.log("Hello, world!");

function initializePlayer() {
  if (!Mpegts.isSupported()) {
    console.error("Your browser doesn't support mpegts.js");
    return;
  }

  const videoElement = document.getElementById('videoElement') as HTMLVideoElement;
  if (!videoElement) {
    console.error('Video element not found!');
    return;
  }

  // Simpler configuration focusing on essential parameters
  const player = Mpegts.createPlayer({
    type: 'flv',
    url: './public/sample-2ch.flv',
    isLive: false,
    hasAudio: true,
    hasVideo: true,
    enableStashBuffer: false,
    stashInitialSize: 128,
    cors: true,
    withCredentials: false,
    seekType: 'range',
    fixAudioTimestampGap: false,
    rangeLoadZeroStart: true
  });

  if (!player) {
    console.error('Failed to create player!');
    return;
  }

  let mediaSourceOpened = false;

  player.on('error', (err: {
    type: (typeof Mpegts.ErrorTypes)[keyof typeof Mpegts.ErrorTypes];
    details?: (typeof Mpegts.ErrorDetails)[keyof typeof Mpegts.ErrorDetails];
  }) => {
    console.error('Player error:', err.type);

    if (err.details) {
      console.error('Error details:', err.details);
    }
  });

  player.on('sourceopen', () => {
    console.log('MediaSource opened');
    mediaSourceOpened = true;
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

  // Simple initialization sequence
  try {
    player.attachMediaElement(videoElement);
    player.load();

    // Add a manual play button for user interaction
    const playButton = document.createElement('button');
    playButton.textContent = 'Play Video';
    playButton.style.cssText = 'position: absolute; top: 10px; left: 10px; z-index: 1000;';
    playButton.onclick = () => {
      if (videoElement.paused) {
        player.play().catch((err: Error) => console.error('Play failed:', err));
      }
    };
    document.body.appendChild(playButton);

  } catch (e) {
    console.error('Error during player initialization:', e);
  }
}
// Initialize only after window load
window.addEventListener('load', initializePlayer);