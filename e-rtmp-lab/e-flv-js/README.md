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
  
## Switching tracks

A video track switch replaces the track being played with another one. In this document,
`_a` is the track being played and `_b` is the track being switched to.

The handoff:

1. After a switch request, the demuxer keeps pushing `_a` until `_b`'s next keyframe
   arrives.
2. At that keyframe it makes one final `_a` push to the remuxer, carrying the `_a` frames
   it still has, plus the keyframe's two timestamps.
3. The remuxer finishes `_a` in that same push: it drops the `_a` frames that `_b`
   replaces, writes out the rest, and keeps nothing. No `_b` frames are in this push.
4. The demuxer then sends `_b`'s metadata, and only after that `_b`'s frames, starting
   with the keyframe it has been holding since step 1.

The Demux Rules cover steps 1, 2 and 4. The Remux Rules cover step 3.

### The switch point, T

T is when `_b` takes over from `_a`. It is marked by a `_b` keyframe: the first one that
arrives after the switch request and has a known codec config.

That keyframe has two timestamps:

- `T_dts` when the keyframe is decoded.
- `T_pts` when the keyframe is shown.

Usually `T_dts` and `T_pts` are the same time. With B-frames (frames sent out of display
order), `T_pts` can be later than `T_dts`. Both timestamps are passed to the remuxer in
the final `_a` push, and each has one job:

- `T_dts` is where `_a`'s decoding ends and `_b`'s begins.
- `T_pts` is where `_a` stops being shown and `_b` starts being shown.

### Demux rules

**Assumption.** Frames from different tracks are interleaved in decode-timestamp (DTS)
order: a frame never arrives after a frame from another track that decodes later. The
Demux and Remux Rules both rely on this.

The rules:

1. **Demuxer looks at every track.** It steps through all tracks in file order, but only
   queues frames from the current video track. A push never mixes tracks.
2. **A request changes nothing yet.** After a switch request, `_a` stays current. `_b`'s
   frames are only checked for a keyframe and otherwise passed over.
3. **Switch only at T.** `_b` becomes current at T: its first keyframe whose codec config
   is known.
4. **The demuxer drops nothing.** It pushes every queued `_a` frame along with `T_dts` and
   `T_pts`. Discarding the `_a` frames that `_b` replaces is the remuxer's job.
5. **Finish `_a`, then introduce `_b`.** The demuxer pushes the `_a` frames left in its
   queue to the remuxer. On that push it passes three extra arguments:
   `drainTarget = video`, meaning no more `_a` video will follow;
   `videoDrainEndDts = T_dts`; and `videoDrainEndPts = T_pts`. Only after that push does
   it send `_b`'s metadata.
6. **`_b` starts on its keyframe.** The keyframe at T is the first frame queued for `_b`;
   `_a` frames after that are passed over.
7. **Audio is untouched.** A video switch pushes audio as usual, with no drain.
8. **Latest request wins.** A new request replaces a pending one. A request for the track
   that is already current cancels any pending switch.
9. **No keyframe, no switch.** If `_b` never produces another keyframe, `_a` stays
   current.

### Remux rules

**In short:** between pushes the remuxer holds some video back (see the end of this
section). When it receives the final `_a` push, it stops holding back: it throws away any
`_a` frame that would be shown at `T_pts` or later, writes out the rest with the last `_a`
frame shown lasting until `T_pts`, and is then empty and ready for `_b`.

**Assumption.** Same as the Demux Rules.

The rules:

1. **Normal pushes may hold video back.** On an ordinary push the remuxer writes out what
   it can and may keep some frames for the next push. How much depends on the container.
2. **The final `_a` push collects everything.** When `drainTarget = video`, the remuxer
   takes all the `_a` video it has: the frames just pushed plus any it was holding. Either
   part may be empty.
3. **Discard what `_b` replaces.** The remuxer checks the `_a` frames from the end, last
   one first. A frame shown at or after `T_pts` is dropped. At the first frame shown
   before `T_pts` it stops, and that frame and everything before it are kept. Dropping
   only from the end means no kept frame depends on a dropped one.
4. **Write the rest of `_a`, ending at T.** The remaining `_a` frames are written out
   immediately. The last `_a` frame shown stays on screen until `T_pts`. How that frame's
   duration is set depends on the container (see below).
5. **Nothing is left behind.** After the final push the remuxer holds no `_a` video. If
   the discard removed everything, it writes nothing.
6. **`_b` starts at T.** `_b`'s metadata arrives next, then its keyframe, which is written
   at its own timestamps: decoded at `T_dts`, shown at `T_pts`. `_a`'s video always comes
   out before `_b`'s initialization segment.
7. **One track per segment.** A segment never mixes frames from two tracks or two codecs.
8. **Audio is untouched.** A video drain does not make the audio remuxer give up what
   it's holding.
9. **One call does it all.** The final `_a` push is a single call. The remuxer must act on
   it even if it carries no frames, and if there is nothing pushed and nothing held, it
   writes nothing.

What "holding back" means for each container:

- **MP4** keeps one frame, the last frame of every push, whether or not it's a keyframe,
  because it needs the next frame's decode time to know how long that frame lasts. On the
  final push, `T_dts` plays the role of that next decode time. If that last frame is also
  the last one shown, it is stretched to `T_pts` when `T_pts` is later.
- **WebM** keeps everything from the most recent keyframe onward, the current group of
  frames, until the next keyframe arrives. On the final push it writes that group out
  without waiting, and if the last frame is also the last one shown, gives it an explicit
  duration that runs to `T_pts`. WebM does not use `T_dts`.

**Known limitation.** The rules above describe the intended result: `_a` ends exactly at
`T_pts`. When `_a` has B-frames this is not always achieved. A frame shown at or after
`T_pts` can sit earlier in decode order than frames shown before it. Rule 3 stops before
reaching that frame, so it is kept. When `_b` is appended, the browser may remove it
together with the frames that depend on it, which can leave a short gap just before
`T_pts`. This has been observed once and is not yet confirmed as the cause. The wording
of the rules will be revisited when this is fixed.

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

### Video track switching

A video track selection takes effect at the requested track's next keyframe.
Until that boundary, the current track continues through the demux/remux pipeline.
Before activating the new track, the pipeline drains the old demux queue, MP4
stashed frames, and WebM pending GOPs using their original track IDs and codec
metadata. MSE receives the old media before the new initialization segment and
new-track media; requesting a switch does not clear already queued MSE segments.

## License

Apache License 2.0. Portions derived from the original [mpegts.js](https://github.com/xqq/mpegts.js), project retain their upstream notices.
