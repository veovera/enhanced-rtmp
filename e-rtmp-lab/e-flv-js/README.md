# e-flv-js

A TypeScript implementation for playing enhanced FLV (E‑FLV) and legacy FLV files in the browser via [Media Source Extensions (MSE)](https://developer.mozilla.org/docs/Web/API/Media_Source_Extensions_API). Bundles a reusable mux/demux/remux library with a demo app. Currently supports main‑thread only; the worker pipeline is disabled for now.

Browse the live GitHub repository → [\<e-flv-js\>](https://github.com/veovera/enhanced-rtmp/tree/main/e-rtmp-lab/e-flv-js)

## Background and scope

- Goal: prototype and validate features within the E‑RTMP specification.
- Derived from mpegts.js and extensively refactored: many modules have been rewritten, and almost all have been ported to TypeScript. Unused modules were removed, with the project focused on `.flv` (E‑FLV and FLV only).
- The codebase will continue to diverge to focus on E‑RTMP tranport and E‑FLV content playback.
- Added WebM support (MSE WebM transmux path) alongside MP4. WebM output currently supports AV1 and VP9 video plus Opus audio; VP8 WebM support is planned.
- Current testing: Chrome on macOS; other browsers/platforms are not validated to simplify and concentrate on E-RTMP prototyping and validation.
- Thinking about production use? This e-flv-js project is experimental and maintained on a best-effort basis. Feel free to open an issue to discuss your needs or report problems. Your feedback will help guide our efforts.

## Project layout

```text
e-flv-js/
├── src/
│   ├── demo-app.ts       Demo UI
│   └── mux-lib/          Mux, demux, remux, and player library
├── assets/               Test clips specific to this project
├── dist/                 Build output (`e-flv-demo.js`, `player-engine-worker.js`, and source maps)
└── demo-app.html         Static shell that loads the demo UI

../assets/                Shared test clips for all lab projects
```

Asset directories are automatically discovered by the demo picker.

## Worker and main-thread boundary

The worker pipeline is currently not supported. The inactive `enableWorker` and
`enableWorkerForMSE` configuration flags describe experimental paths. `enableWorker`
offloads transmuxing, while `enableWorkerForMSE` additionally runs MSE in a worker. In the
future, the intended boundary will keep MSE and all media-element coordination on the main
thread, and move only the CPU- and I/O-intensive transmuxing pipeline to a worker. Keeping
[`HTMLMediaElement`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement),
[`MediaSource`](https://developer.mozilla.org/en-US/docs/Web/API/MediaSource), and
[`SourceBuffer`](https://developer.mozilla.org/en-US/docs/Web/API/SourceBuffer) state
together avoids worker-side MSE support requirements, removes cross-thread synchronization
for playback and buffer state, and makes the lifecycle easier to reason about and debug.

All paths below are relative to `src/mux-lib/`.

```text
MAIN THREAD
  core/mse-controller.ts
  core/transmuxer.ts
  player/mse-player.ts
  player/player-engine-main-thread.ts
  player/player-engine-dedicated-thread.ts
  player/seeking-handler.ts
  player/loading-controller.ts
  player/startup-stall-jumper.ts
  player/live-latency-chaser.ts
  player/live-latency-synchronizer.ts
  player/native-player.ts

WORKER ENTRY POINT
  core/transmuxing-worker.ts

WORKER WHEN ENABLED, MAIN THREAD OTHERWISE
  core/transmuxing-controller.ts
  io/
  demux/
  remux/

SHARED
  config.ts
  core/media-info.ts
  Event/type definitions
  Environment-safe utilities
```

- The `MAIN THREAD` modules own MSE, `SourceBuffer` lifecycle, seeking, buffer cleanup,
  playback controls, and the worker-facing player/transmuxer facade.
- `core/transmuxing-worker.ts` is worker-only. The pipeline modules can also run on the
  main thread when workers are disabled; when workers are enabled, the related pipeline loads,
  parses, demuxes, remuxes, and generates media segments off the main thread without
  accessing the DOM.
- The thread boundary is the message exchange between the main thread and worker:
  the main thread sends lifecycle, seek, and configuration commands; the worker returns
  initialization/media segments, events, and stream metadata.

```text
TARGET: MAIN-THREAD MSE WITH WORKER TRANSMUXING

Main thread
  MSEPlayer / player engine
    +-- MSEController --> MediaSource / SourceBuffers --> HTMLMediaElement
    +-- Transmuxer facade

Worker
  transmuxing-worker.ts
    +-- IO -> FLV demux -> MP4/WebM remux

Cross-thread messages
  Main thread -- lifecycle and seek commands --> Worker
  Worker      -- init/media segments, events, metadata --> Main thread MSEController
```

`player-engine-worker.ts` currently combines worker-side MSE and transmuxing. Under the
target architecture, it will be retired in favor of `transmuxing-worker.ts`, which will
load, demux, and remux media before sending segments back to the main-thread
`MSEController`.
  
## Prerequisites

- Node.js 20.x (ships with npm 10+)
- macOS (other environments may work but are untested)

## Install dependencies

```bash
npm install
```

## Run the demo app

1. Build in watch mode: `npm run dev`
2. In another terminal, start the static server: `npm run serve`
3. Open `http://localhost:8080/e-flv-js/demo-app.html`
4. Pick a source clip, adjust settings, and press **Create Player**

The demo ships with AV1 and Opus samples. Reload the page after adding new `.flv` files to `../assets/` (shared) or `assets/` (local).

## Production build

```bash
npm run build         # outputs bundles into dist/
```

## Quality gates

```bash
npm run type-check
npm run lint          # temporary relaxed lint rules, will tighten later
npm run check         # runs both commands above
```

## Using the library directly

The mux/remux player lives under `src/mux-lib` and is exported via the path alias `@/mux-lib`.

```ts
import { eflv, defaultConfig } from '@/mux-lib';
...
const player = eflv.createPlayer(mediaDataSource, config);
player.attachMediaElement(document.querySelector('video')!);
player.load();
player.play();
```

Review `src/demo-app.ts` for a wiring example that includes UI controls, telemetry hooks, and toggles between MP4 and WebM transmuxing paths.

## License

Apache License 2.0. Portions derived from the original [mpegts.js](https://github.com/xqq/mpegts.js), project retain their upstream notices.
