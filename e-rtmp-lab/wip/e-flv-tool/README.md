# eflv

A command-line tool for inspecting and manipulating FLV and E-FLV (Enhanced FLV) files.

## Build

```bash
go build -o eflv .
```

## Usage

```txt
eflv [command] [flags]
```

### Commands

#### dump

Dump structural information about an FLV / E-FLV file.

```bash
eflv dump <input.flv> [--json] [--verbose]
```

| Flag        | Description                                                   |
|-------------|---------------------------------------------------------------|
| `--json`    | Output machine-readable JSON instead of text                  |
| `--verbose` | Include lower-level details (offsets, timestamps, tag counts) |

#### merge

Merge two E-FLV inputs into a single output FLV.

```bash
eflv merge <a.flv> <b.flv> -o <out.flv> [--multitrack]
```

| Flag           | Description                                        |
|----------------|----------------------------------------------------|
| `-o, --output` | Output file path (required)                        |
| `--multitrack` | Preserve each input as a separate track group      |

## Project Structure

```txt
├── main.go          # Entry point
├── cmd/
│   ├── root.go      # Root CLI command (Cobra)
│   ├── dump.go      # dump subcommand
│   └── merge.go     # merge subcommand
├── flv/
│   ├── parser.go    # FLV file parsing
│   ├── amf0.go      # AMF0 decoder
│   └── merge.go     # FLV merge logic
└── local/
    └── eflv_cli_spec.txt  # CLI specification
```

## Status

**Work in progress.** The tool is under active development. Current state:

- FLV header and tag counting are functional
- onMetaData script tag parsing with AMF0 decoding is implemented
- FourCC codec identification for E-RTMP is supported
- JSON output, verbose mode, and merge logic are not yet implemented

## Dependencies

- [cobra](https://github.com/spf13/cobra) — CLI framework
