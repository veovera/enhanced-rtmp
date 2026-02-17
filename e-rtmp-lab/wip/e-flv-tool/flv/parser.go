package flv

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"io"
	"os"
)

// TagType represents the type of an FLV tag.
type TagType byte

const (
	TagTypeAudio  TagType = 8
	TagTypeVideo  TagType = 9
	TagTypeScript TagType = 18
)

// FLVHeader represents the 9-byte FLV file header.
type FLVHeader struct {
	Signature  [3]byte
	Version    uint8
	HasAudio   bool
	HasVideo   bool
	DataOffset uint32
}

func parseHeader(f *os.File) (FLVHeader, error) {
	var buf [9]byte
	if _, err := f.Read(buf[:]); err != nil {
		return FLVHeader{}, fmt.Errorf("reading header: %w", err)
	}

	sig := [3]byte{buf[0], buf[1], buf[2]}
	if sig != [3]byte{'F', 'L', 'V'} {
		return FLVHeader{}, fmt.Errorf("invalid FLV signature: %q", sig)
	}

	return FLVHeader{
		Signature:  sig,
		Version:    buf[3],
		HasAudio:   buf[4]&0x04 != 0,
		HasVideo:   buf[4]&0x01 != 0,
		DataOffset: binary.BigEndian.Uint32(buf[5:9]),
	}, nil
}

// DumpFLV reads an FLV/E-FLV file and prints structural information.
func DumpFLV(inputPath string, jsonOutput bool, verbose bool) error {
	f, err := os.Open(inputPath)
	if err != nil {
		return fmt.Errorf("opening file: %w", err)
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return fmt.Errorf("stat file: %w", err)
	}

	header, err := parseHeader(f)
	if err != nil {
		return err
	}

	fmt.Printf("File: %s\n", inputPath)
	fmt.Printf("Size: %d bytes\n", info.Size())
	fmt.Printf("Format: FLV/E-FLV\n")
	fmt.Println()
	fmt.Printf("Header\n")
	fmt.Printf("  Version:     %d\n", header.Version)
	fmt.Printf("  Has Audio:   %t\n", header.HasAudio)
	fmt.Printf("  Has Video:   %t\n", header.HasVideo)
	fmt.Printf("  Data Offset: %d\n", header.DataOffset)

	if _, err := f.Seek(int64(header.DataOffset), io.SeekStart); err != nil {
		return fmt.Errorf("seek to data offset: %w", err)
	}

	r := bufio.NewReaderSize(f, 1<<20)

	var previousTagSize [4]byte
	if _, err := io.ReadFull(r, previousTagSize[:]); err != nil {
		if err == io.EOF {
			fmt.Println()
			fmt.Printf("Tags\n")
			fmt.Printf("  Total:  0\n")
			fmt.Printf("  Audio:  0\n")
			fmt.Printf("  Video:  0\n")
			fmt.Printf("  Script: 0\n")
			fmt.Printf("  Other:  0\n")
			return nil
		}
		return fmt.Errorf("reading first previous tag size: %w", err)
	}

	var totalTags uint64
	var audioTags uint64
	var videoTags uint64
	var scriptTags uint64
	var otherTags uint64
	var metadataBlocks [][]AMF0Property
	var codecConfigs []CodecConfig
	var tagHeader [11]byte
	for {
		_, err := io.ReadFull(r, tagHeader[:])
		if err == io.EOF {
			break
		}
		if err != nil {
			if err == io.ErrUnexpectedEOF {
				return fmt.Errorf("reading tag header: truncated file")
			}
			return fmt.Errorf("reading tag header: %w", err)
		}

		totalTags++
		tagType := TagType(tagHeader[0] & 0x1f)
		dataSize := int64(tagHeader[1])<<16 | int64(tagHeader[2])<<8 | int64(tagHeader[3])

		switch tagType {
		case TagTypeVideo:
			videoTags++
			cfg, err := tryParseVideoConfig(r, int(dataSize))
			if err != nil {
				return fmt.Errorf("reading video tag payload: %w", err)
			}
			if cfg != nil {
				codecConfigs = append(codecConfigs, *cfg)
			}
			goto readPrevTagSize
		case TagTypeAudio:
			audioTags++
			cfg, err := tryParseAudioConfig(r, int(dataSize))
			if err != nil {
				return fmt.Errorf("reading audio tag payload: %w", err)
			}
			if cfg != nil {
				codecConfigs = append(codecConfigs, *cfg)
			}
			goto readPrevTagSize
		case TagTypeScript:
			scriptTags++
			props, err := parseScriptTag(r, int(dataSize))
			if err != nil {
				return fmt.Errorf("reading script tag payload: %w", err)
			}
			if props != nil {
				metadataBlocks = append(metadataBlocks, props)
			}
			goto readPrevTagSize
		default:
			otherTags++
		}

		if _, err := io.CopyN(io.Discard, r, dataSize); err != nil {
			if err == io.EOF || err == io.ErrUnexpectedEOF {
				return fmt.Errorf("reading tag payload: truncated file")
			}
			return fmt.Errorf("reading tag payload: %w", err)
		}

	readPrevTagSize:
		if _, err := io.ReadFull(r, previousTagSize[:]); err != nil {
			if err == io.EOF || err == io.ErrUnexpectedEOF {
				return fmt.Errorf("reading previous tag size: truncated file")
			}
			return fmt.Errorf("reading previous tag size: %w", err)
		}
	}

	fmt.Println()
	fmt.Printf("Tags\n")
	fmt.Printf("  Total:  %d\n", totalTags)
	fmt.Printf("  Audio:  %d\n", audioTags)
	fmt.Printf("  Video:  %d\n", videoTags)
	fmt.Printf("  Script: %d\n", scriptTags)
	fmt.Printf("  Other:  %d\n", otherTags)

	for i, props := range metadataBlocks {
		fmt.Println()
		if len(metadataBlocks) == 1 {
			fmt.Printf("onMetaData\n")
		} else {
			fmt.Printf("onMetaData #%d\n", i+1)
		}
		for _, p := range props {
			printAMF0Property(p, 1)
		}
	}

	for _, cfg := range codecConfigs {
		fmt.Println()
		printCodecConfig(cfg)
	}

	// TODO: Parse tag headers for timestamps, stream IDs, data sizes
	// TODO: Detect and report E-FLV track information
	// TODO: Output as text or JSON based on jsonOutput flag
	// TODO: Include offsets, timestamps, tag counts when verbose is true

	return nil
}

// parseScriptTag reads dataSize bytes from r and, if the first AMF0 value is
// the string "onMetaData", returns the properties of the second AMF0 value.
// Returns nil properties (no error) if this is not an onMetaData tag.
func parseScriptTag(r io.Reader, dataSize int) ([]AMF0Property, error) {
	payload := make([]byte, dataSize)
	if _, err := io.ReadFull(r, payload); err != nil {
		return nil, err
	}

	// First AMF0 value should be a string.
	name, offset, err := parseAMF0Value(payload, 0)
	if err != nil {
		return nil, nil // not parseable, skip
	}

	nameStr, ok := name.(string)
	if !ok || nameStr != "onMetaData" {
		return nil, nil
	}

	// Second AMF0 value should be an object or ECMA array.
	value, _, err := parseAMF0Value(payload, offset)
	if err != nil {
		return nil, nil
	}

	props, ok := value.([]AMF0Property)
	if !ok {
		return nil, nil
	}
	return props, nil
}

func printAMF0Property(p AMF0Property, indent int) {
	prefix := ""
	for i := 0; i < indent; i++ {
		prefix += "  "
	}
	switch v := p.Value.(type) {
	case []AMF0Property:
		fmt.Printf("%s%s:\n", prefix, p.Name)
		for _, sub := range v {
			printAMF0Property(sub, indent+1)
		}
	case float64:
		n := int64(v)
		if v == float64(n) {
			if (p.Name == "videocodecid" || p.Name == "audiocodecid") && n > 15 {
				// Values 0–15 are legacy CodecId's. Values > 15 are a FourCC from E-RTMP.
				fourCC := [4]byte{byte(n >> 24), byte(n >> 16), byte(n >> 8), byte(n)}
				fmt.Printf("%s%s: %d (%s)\n", prefix, p.Name, n, string(fourCC[:]))
			} else {
				fmt.Printf("%s%s: %d\n", prefix, p.Name, n)
			}
		} else {
			fmt.Printf("%s%s: %g\n", prefix, p.Name, v)
		}
	case bool:
		fmt.Printf("%s%s: %t\n", prefix, p.Name, v)
	case string:
		fmt.Printf("%s%s: %s\n", prefix, p.Name, v)
	case nil:
		fmt.Printf("%s%s: null\n", prefix, p.Name)
	default:
		fmt.Printf("%s%s: %v\n", prefix, p.Name, v)
	}
}
