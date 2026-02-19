# e-rtmp-lab

A lab workspace maintained by the Veovera Software Organization for prototyping E‑RTMP features and validating the specification. Within the lab, individual experiments are tracked, each with its own documentation and tooling to support rapid iteration. Experiments include their own documentation and tooling to support fast iteration.

## Repository layout

- [e-flv-js/](e-flv-js/) — Hybrid TypeScript/JavaScript implementation, with most core modules ported to TypeScript, for playing enhanced FLV (E‑FLV) and legacy FLV files in the browser via [Media Source Extensions (MSE)](https://developer.mozilla.org/docs/Web/API/Media_Source_Extensions_API). Supports video codecs (AV1, HEVC, AVC, VP8/VP9) and audio codecs (AAC, Opus, FLAC, AC3, MP3). Includes a demo app and sample video assets. See its [README](e-flv-js/README.md) for details.

- [e-flv-tool/](e-flv-tool/) — Go CLI tool for inspecting and manipulating FLV/E‑FLV files. Parses FLV headers, tags, onMetaData script data (AMF0), and codec configuration records. See its [README](e-flv-tool/README.md) for details.

- [assets/](assets/) — Shared test video clips (FLV and WebM) used across experiments.

Additional experiments will appear under this lab directory as needed. Each project documents its own description and build steps, keeping this top-level README focused and simple.

Browse the live GitHub repository → [\<e-rtmp-lab\>](https://github.com/veovera/enhanced-rtmp/tree/main/e-rtmp-lab)

## License

Unless noted otherwise, files are provided under the Apache License 2.0.
