# e-flv-js

Hybrid TypeScript/JavaScript implementation, with most core modules ported to TypeScript, for playing enhanced FLV (E‑FLV) and legacy FLV files in the browser via [Media Source Extensions (MSE)](https://developer.mozilla.org/docs/Web/API/Media_Source_Extensions_API). Bundles a reusable mux/demux/remux library with a demo app. Currently supports main‑thread only; the worker pipeline is disabled.

Browse the live GitHub repository → [\<e-flv-js\>](https://github.com/veovera/enhanced-rtmp/tree/main/e-rtmp-lab/e-flv-js)

## Background and scope

- Goal: prototype and validate features within the E‑RTMP specification.
- Derived from mpegts.js and extensively refactored: many files ported to TypeScript, unused modules removed, and a focus on .flv (E‑FLV and FLV only).
- The codebase will continue to diverge to focus on E‑RTMP tranport and E‑FLV content playback.
- Added WebM support (MSE WebM transmux path) alongside MP4. WebM path for now only makes sence with AV1 and Opus codecs. In the future we will add VP8, VP9 and FLAC WebM support.
- Current testing: Chrome on macOS; other browsers/platforms are not validated to simplify and concentrate on E-RTMP prototyping and validation.
- Thinking about production use? This e-flv-js project is experimental and maintained on a best-effort basis. Feel free to open an issue to discuss your needs or report problems. Your feedback will help guide our efforts.

## Project layout

- `src/` – Sources for the demo app (`demo-app.ts`) and the mux/demux/remux/player library in `mux-lib/`
- `../assets/` (`e-rtmp-lab/assets/`) – shared test clips available to all lab projects; auto‑discovered by the demo picker
- `assets/` – local test clips specific to this project; also auto‑discovered by the demo picker
- `dist/` – build output for the demo app and the mux lib
- `demo-app.html` – static shell that bootstraps the demo UI
  
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
3. Open `http://localhost:8080/index.html`
4. Pick a source clip, adjust settings, and press **Create Player**

The demo ships with AV1 and Opus samples. Reload the page after adding new `.flv` files to `../assets/` (shared) or `assets/` (local).

## Production build

```bash
npm run build    # outputs bundles into dist/
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
