package flv

import (
	"encoding/binary"
	"fmt"
	"io"
)

// videoResolution carries parsed frame dimensions for a video codec.
type videoResolution struct {
	codec  string
	width  int
	height int
}

// codecConfig holds the parsed fields from a codec configuration record.
type codecConfig struct {
	trackType string        // "video" or "audio"
	codec     string        // FourCC string, e.g. "hvc1", "mp4a", "avc1"
	fields    []configField // parsed key/value pairs
}

// configField is a single named value from a config record.
type configField struct {
	name  string
	value any
}

// Packet type for sequence start (same value for both video and audio in E-RTMP).
const packetTypeSequenceStart = 0

// VideoPacketType values.
const videoPacketTypeMultitrack = 6

// AvMultitrackType values.
const (
	avMultitrackOneTrack             = 0
	avMultitrackManyTracks           = 1
	avMultitrackManyTracksManyCodecs = 2
)

// Legacy codec identifiers.
const (
	videoCodecIDAVC    = 7
	soundFormatAAC     = 10
	soundFormatExAudio = 9
)

// AAC sampling frequency table (ISO 14496-3).
var aacSamplingFrequencies = [...]int{
	96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
}

// parseVideoConfig reads a video tag payload from r. If the tag contains
// sequence header(s), it parses the codec configuration record(s) and returns
// them. Otherwise it skips the payload. The full dataSize bytes are always
// consumed from r.
//
// Extended video tag header layout (E-RTMP v2):
//
//	Non-multitrack: [IsEx(1)|FrameType(3)|PacketType(4)] [FourCC(4)] [payload...]
//	Multitrack:     [IsEx(1)|FrameType(3)|PacketType=6(4)] [AvMultitrackType(4)|innerPacketType(4)] [...]
func parseVideoConfig(r io.Reader, dataSize int) ([]codecConfig, *videoResolution, error) {
	if dataSize < 1 {
		return nil, nil, nil
	}

	var first [1]byte
	if _, err := io.ReadFull(r, first[:]); err != nil {
		return nil, nil, err
	}
	remaining := dataSize - 1

	isExHeader := first[0]&0x80 != 0

	if isExHeader {
		packetType := first[0] & 0x0F

		if packetType == videoPacketTypeMultitrack {
			// Multitrack: no FourCC in outer header.
			// Next byte: [AvMultitrackType(4)][innerVideoPacketType(4)]
			cfgs, res, err := parseVideoMultitrackConfigs(r, remaining)
			return cfgs, res, err
		}

		// Non-multitrack extended: next 4 bytes are the FourCC.
		if remaining < 4 {
			_, err := io.CopyN(io.Discard, r, int64(remaining))
			return nil, nil, err
		}
		var fourCCBytes [4]byte
		if _, err := io.ReadFull(r, fourCCBytes[:]); err != nil {
			return nil, nil, err
		}
		remaining -= 4
		fourCC := string(fourCCBytes[:])

		if packetType == packetTypeSequenceStart {
			configData, err := readRemaining(r, remaining)
			if err != nil {
				return nil, nil, err
			}
			fields := parseVideoConfigByFourCC(fourCC, configData)
			return []codecConfig{{trackType: "video", codec: fourCC, fields: fields}}, nil, nil
		}

		if fourCC == "vp09" {
			frameData, err := readRemaining(r, remaining)
			if err != nil {
				return nil, nil, err
			}
			if w, h, ok := parseVP9KeyframeResolution(frameData); ok {
				res := &videoResolution{codec: "vp09", width: w, height: h}
				return nil, res, nil
			}
			return nil, nil, nil
		}

		_, err := io.CopyN(io.Discard, r, int64(remaining))
		return nil, nil, err
	}

	// Legacy video: [FrameType(4)|CodecID(4)] [AvcPacketType(1)] [CTO(3)] [payload...]
	codecID := first[0] & 0x0F
	if codecID == videoCodecIDAVC {
		// Need AvcPacketType + CompositionTimeOffset (4 bytes total).
		if remaining < 4 {
			_, err := io.CopyN(io.Discard, r, int64(remaining))
			return nil, nil, err
		}
		var avcHeader [4]byte
		if _, err := io.ReadFull(r, avcHeader[:]); err != nil {
			return nil, nil, err
		}
		remaining -= 4
		if avcHeader[0] == 0 { // AvcPacketType == 0 → sequence header
			configData, err := readRemaining(r, remaining)
			if err != nil {
				return nil, nil, err
			}
			fields := parseAVCConfig(configData)
			return []codecConfig{{trackType: "video", codec: "avc1", fields: fields}}, nil, nil
		}
	}

	_, err := io.CopyN(io.Discard, r, int64(remaining))
	return nil, nil, err
}

// parseVideoMultitrackConfigs parses a VideoPacketTypeMultitrack payload and
// returns any sequence-start codec configs found within it.
//
// Per E-RTMP v2 spec, after the outer 1-byte header the multitrack payload is:
//
//	[AvMultitrackType(4)|innerVideoPacketType(4)]  — 1 byte
//	if avType != ManyTracksManyCodecs: [shared FourCC (4)]
//	then per-track: see inline comments below.
func parseVideoMultitrackConfigs(r io.Reader, remaining int) ([]codecConfig, *videoResolution, error) {
	if remaining < 1 {
		return nil, nil, nil
	}
	var typeByte [1]byte
	if _, err := io.ReadFull(r, typeByte[:]); err != nil {
		return nil, nil, err
	}
	remaining--
	avType := int(typeByte[0] >> 4)
	innerPacketType := byte(typeByte[0] & 0x0F)

	discard := func(n int) error {
		_, err := io.CopyN(io.Discard, r, int64(n))
		return err
	}

	switch avType {
	case avMultitrackOneTrack, avMultitrackManyTracks:
		// Shared codec: read FourCC once.
		if remaining < 4 {
			return nil, nil, discard(remaining)
		}
		var fourCCBytes [4]byte
		if _, err := io.ReadFull(r, fourCCBytes[:]); err != nil {
			return nil, nil, err
		}
		remaining -= 4
		fourCC := string(fourCCBytes[:])

		if avType == avMultitrackOneTrack {
			// OneTrack: [TrackID (1)] [payload (rest)]
			if remaining < 1 {
				return nil, nil, nil
			}
			var trackID [1]byte
			if _, err := io.ReadFull(r, trackID[:]); err != nil {
				return nil, nil, err
			}
			remaining--
			if innerPacketType != packetTypeSequenceStart {
				if fourCC == "vp09" {
					frameData, err := readRemaining(r, remaining)
					if err != nil {
						return nil, nil, err
					}
					if w, h, ok := parseVP9KeyframeResolution(frameData); ok {
						return nil, &videoResolution{codec: "vp09", width: w, height: h}, nil
					}
					return nil, nil, nil
				}
				return nil, nil, discard(remaining)
			}
			configData, err := readRemaining(r, remaining)
			if err != nil {
				return nil, nil, err
			}
			fields := parseVideoConfigByFourCC(fourCC, configData)
			return []codecConfig{{trackType: "video", codec: fourCC, fields: fields}}, nil, nil
		}

		// ManyTracks: repeated [TrackID (1)] [SizeOfVideoData (3)] [payload]
		var configs []codecConfig
		var resolution *videoResolution
		for remaining >= 4 {
			var chunk [4]byte
			if _, err := io.ReadFull(r, chunk[:]); err != nil {
				return nil, nil, err
			}
			remaining -= 4
			chunkSize := int(chunk[1])<<16 | int(chunk[2])<<8 | int(chunk[3])
			if chunkSize > remaining {
				return configs, resolution, discard(remaining)
			}
			if innerPacketType == packetTypeSequenceStart {
				configData, err := readRemaining(r, chunkSize)
				if err != nil {
					return nil, nil, err
				}
				fields := parseVideoConfigByFourCC(fourCC, configData)
				configs = append(configs, codecConfig{trackType: "video", codec: fourCC, fields: fields})
			} else if fourCC == "vp09" {
				frameData, err := readRemaining(r, chunkSize)
				if err != nil {
					return nil, nil, err
				}
				if resolution == nil {
					if w, h, ok := parseVP9KeyframeResolution(frameData); ok {
						resolution = &videoResolution{codec: "vp09", width: w, height: h}
					}
				}
			} else {
				if err := discard(chunkSize); err != nil {
					return nil, nil, err
				}
			}
			remaining -= chunkSize
		}
		return configs, resolution, discard(remaining)

	case avMultitrackManyTracksManyCodecs:
		// Each track has its own FourCC: repeated [FourCC (4)] [TrackID (1)] [SizeOfVideoData (3)] [payload]
		var configs []codecConfig
		var resolution *videoResolution
		for remaining >= 8 {
			var chunk [8]byte
			if _, err := io.ReadFull(r, chunk[:]); err != nil {
				return nil, nil, err
			}
			remaining -= 8
			fourCC := string(chunk[0:4])
			chunkSize := int(chunk[5])<<16 | int(chunk[6])<<8 | int(chunk[7])
			if chunkSize > remaining {
				return configs, resolution, discard(remaining)
			}
			if innerPacketType == packetTypeSequenceStart {
				configData, err := readRemaining(r, chunkSize)
				if err != nil {
					return nil, nil, err
				}
				fields := parseVideoConfigByFourCC(fourCC, configData)
				configs = append(configs, codecConfig{trackType: "video", codec: fourCC, fields: fields})
			} else if fourCC == "vp09" {
				frameData, err := readRemaining(r, chunkSize)
				if err != nil {
					return nil, nil, err
				}
				if resolution == nil {
					if w, h, ok := parseVP9KeyframeResolution(frameData); ok {
						resolution = &videoResolution{codec: "vp09", width: w, height: h}
					}
				}
			} else {
				if err := discard(chunkSize); err != nil {
					return nil, nil, err
				}
			}
			remaining -= chunkSize
		}
		return configs, resolution, discard(remaining)

	default:
		return nil, nil, discard(remaining)
	}
}

// parseAudioConfig reads an audio tag payload from r. If the tag is a
// sequence header, it parses the codec configuration record and returns it.
// Otherwise it skips the payload. The full dataSize bytes are always consumed.
func parseAudioConfig(r io.Reader, dataSize int) ([]codecConfig, error) {
	if dataSize < 2 {
		return discardAndReturn(r, dataSize)
	}

	var header [5]byte
	headerSize := 5
	if dataSize < 5 {
		headerSize = dataSize
	}
	if _, err := io.ReadFull(r, header[:headerSize]); err != nil {
		return nil, err
	}
	remaining := dataSize - headerSize

	soundFormat := header[0] >> 4

	if soundFormat == soundFormatExAudio {
		if headerSize < 5 {
			return discardAndReturn(r, remaining)
		}
		audioPacketType := header[0] & 0x0F
		fourCC := string(header[1:5])

		if audioPacketType != packetTypeSequenceStart {
			return discardAndReturn(r, remaining)
		}

		configData, err := readRemaining(r, remaining)
		if err != nil {
			return nil, err
		}

		fields := parseAudioConfigByFourCC(fourCC, configData)
		return []codecConfig{{trackType: "audio", codec: fourCC, fields: fields}}, nil
	}

	if soundFormat == soundFormatAAC {
		aacPacketType := header[1]
		// For legacy AAC we read 5 bytes but only need 2 for detection.
		// Adjust remaining: the config data starts at byte 2 of the original payload.
		leftover := dataSize - 2
		if aacPacketType == 0 {
			// We already consumed headerSize bytes; re-assemble what we have.
			extraData, err := readRemaining(r, remaining)
			if err != nil {
				return nil, err
			}
			configData := make([]byte, 0, leftover)
			configData = append(configData, header[2:headerSize]...)
			configData = append(configData, extraData...)
			fields := parseAACConfig(configData)
			return []codecConfig{{trackType: "audio", codec: "mp4a", fields: fields}}, nil
		}
	}

	return discardAndReturn(r, remaining)
}

func parseVideoConfigByFourCC(fourCC string, data []byte) []configField {
	switch fourCC {
	case "avc1":
		return parseAVCConfig(data)
	case "hvc1":
		return parseHEVCConfig(data)
	case "av01":
		return parseAV1Config(data)
	case "vp09":
		return parseVP9Config(data)
	default:
		return []configField{{name: "size", value: len(data)}}
	}
}

func parseAudioConfigByFourCC(fourCC string, data []byte) []configField {
	switch fourCC {
	case "mp4a":
		return parseAACConfig(data)
	case "Opus":
		return parseOpusConfig(data)
	case "fLaC":
		return parseFLACConfig(data)
	default:
		return []configField{{name: "size", value: len(data)}}
	}
}

// removeEmulationPreventionBytes strips RBSP emulation prevention bytes
// (0x00 0x00 0x03 → 0x00 0x00) per ISO 14496-10 / ISO 23008-2.
func removeEmulationPreventionBytes(data []byte) []byte {
	result := make([]byte, 0, len(data))
	for i := 0; i < len(data); i++ {
		if i+2 < len(data) && data[i] == 0x00 && data[i+1] == 0x00 && data[i+2] == 0x03 {
			result = append(result, 0x00, 0x00)
			i += 2
			continue
		}
		result = append(result, data[i])
	}
	return result
}

// parseAVCSPSResolution extracts picture width and height from an AVC SPS NAL unit
// (ISO 14496-10). nalUnit includes the 1-byte NAL header.
func parseAVCSPSResolution(nalUnit []byte) (width, height int, ok bool) {
	if len(nalUnit) < 4 {
		return 0, 0, false
	}
	rbsp := removeEmulationPreventionBytes(nalUnit[1:]) // skip NAL header
	if len(rbsp) < 3 {
		return 0, 0, false
	}
	profileIDC := int(rbsp[0])
	// rbsp[1] = constraint flags, rbsp[2] = level_idc
	br := newBitReader(rbsp[3:])

	if !br.skipUE() { // seq_parameter_set_id
		return 0, 0, false
	}
	chromaFormatIDC := uint64(1)
	if profileIDC == 100 || profileIDC == 110 || profileIDC == 122 || profileIDC == 244 ||
		profileIDC == 44 || profileIDC == 83 || profileIDC == 86 || profileIDC == 118 ||
		profileIDC == 128 || profileIDC == 138 || profileIDC == 139 || profileIDC == 144 {
		var ok2 bool
		chromaFormatIDC, ok2 = br.readUE()
		if !ok2 {
			return 0, 0, false
		}
		if chromaFormatIDC == 3 {
			if _, ok2 = br.readBit(); !ok2 { // separate_colour_plane_flag
				return 0, 0, false
			}
		}
		if !br.skipUE() { // bit_depth_luma_minus8
			return 0, 0, false
		}
		if !br.skipUE() { // bit_depth_chroma_minus8
			return 0, 0, false
		}
		if _, ok2 = br.readBit(); !ok2 { // qpprime_y_zero_transform_bypass_flag
			return 0, 0, false
		}
		scalingMatrixPresent, ok2 := br.readBit()
		if !ok2 {
			return 0, 0, false
		}
		if scalingMatrixPresent == 1 {
			numLists := 8
			if chromaFormatIDC == 3 {
				numLists = 12
			}
			for i := 0; i < numLists; i++ {
				listPresent, ok3 := br.readBit()
				if !ok3 {
					return 0, 0, false
				}
				if listPresent == 1 {
					size := 16
					if i >= 6 {
						size = 64
					}
					last, next := int64(8), int64(8)
					for j := 0; j < size; j++ {
						if next != 0 {
							delta, ok4 := br.readSE()
							if !ok4 {
								return 0, 0, false
							}
							next = (last + delta + 256) % 256
						}
						if next != 0 {
							last = next
						}
					}
				}
			}
		}
	}

	if !br.skipUE() { // log2_max_frame_num_minus4
		return 0, 0, false
	}
	picOrderCntType, ok2 := br.readUE()
	if !ok2 {
		return 0, 0, false
	}
	switch picOrderCntType {
	case 0:
		if !br.skipUE() { // log2_max_pic_order_cnt_lsb_minus4
			return 0, 0, false
		}
	case 1:
		if _, ok3 := br.readBit(); !ok3 { // delta_pic_order_always_zero_flag
			return 0, 0, false
		}
		if !br.skipSE() { // offset_for_non_ref_pic
			return 0, 0, false
		}
		if !br.skipSE() { // offset_for_top_to_bottom_field
			return 0, 0, false
		}
		n, ok3 := br.readUE() // num_ref_frames_in_pic_order_cnt_cycle
		if !ok3 {
			return 0, 0, false
		}
		for i := uint64(0); i < n; i++ {
			if !br.skipSE() {
				return 0, 0, false
			}
		}
	}
	if !br.skipUE() { // max_num_ref_frames
		return 0, 0, false
	}
	if _, ok2 = br.readBit(); !ok2 { // gaps_in_frame_num_value_allowed_flag
		return 0, 0, false
	}

	picWidthInMbsMinus1, ok2 := br.readUE()
	if !ok2 {
		return 0, 0, false
	}
	picHeightInMapUnitsMinus1, ok2 := br.readUE()
	if !ok2 {
		return 0, 0, false
	}
	frameMBSOnlyFlag, ok2 := br.readBit()
	if !ok2 {
		return 0, 0, false
	}
	if frameMBSOnlyFlag == 0 {
		if _, ok3 := br.readBit(); !ok3 { // mb_adaptive_frame_field_flag
			return 0, 0, false
		}
	}
	if _, ok2 = br.readBit(); !ok2 { // direct_8x8_inference_flag
		return 0, 0, false
	}

	var cropLeft, cropRight, cropTop, cropBottom uint64
	frameCroppingFlag, ok2 := br.readBit()
	if !ok2 {
		return 0, 0, false
	}
	if frameCroppingFlag == 1 {
		var ok3 bool
		if cropLeft, ok3 = br.readUE(); !ok3 {
			return 0, 0, false
		}
		if cropRight, ok3 = br.readUE(); !ok3 {
			return 0, 0, false
		}
		if cropTop, ok3 = br.readUE(); !ok3 {
			return 0, 0, false
		}
		if cropBottom, ok3 = br.readUE(); !ok3 {
			return 0, 0, false
		}
	}

	w := int(picWidthInMbsMinus1+1) * 16
	h := int(2-frameMBSOnlyFlag) * int(picHeightInMapUnitsMinus1+1) * 16
	cropUnitX, cropUnitY := 1, int(2-frameMBSOnlyFlag)
	if chromaFormatIDC != 0 {
		cropUnitX = 2
		cropUnitY = 2 * int(2-frameMBSOnlyFlag)
	}
	w -= (int(cropLeft) + int(cropRight)) * cropUnitX
	h -= (int(cropTop) + int(cropBottom)) * cropUnitY
	return w, h, true
}

// skipHEVCProfileTierLevel skips the profile_tier_level() structure (H.265 / ISO 23008-2).
func skipHEVCProfileTierLevel(br *bitReader, profilePresentFlag bool, maxNumSubLayersMinus1 int) bool {
	if profilePresentFlag {
		// profile_space(2) + tier(1) + profile_idc(5) + compat_flags(32) +
		// progressive/interlaced/non_packed/frame_only flags(4) + reserved(44) = 88 bits
		if _, ok := br.readBits(88); !ok {
			return false
		}
	}
	if _, ok := br.readBits(8); !ok { // general_level_idc
		return false
	}
	subLayerProfilePresent := make([]bool, maxNumSubLayersMinus1)
	subLayerLevelPresent := make([]bool, maxNumSubLayersMinus1)
	for i := 0; i < maxNumSubLayersMinus1; i++ {
		pp, ok := br.readBit()
		if !ok {
			return false
		}
		lp, ok := br.readBit()
		if !ok {
			return false
		}
		subLayerProfilePresent[i] = pp == 1
		subLayerLevelPresent[i] = lp == 1
	}
	if maxNumSubLayersMinus1 > 0 {
		for i := maxNumSubLayersMinus1; i < 8; i++ {
			if _, ok := br.readBits(2); !ok { // reserved_zero_2bits padding
				return false
			}
		}
	}
	for i := 0; i < maxNumSubLayersMinus1; i++ {
		if subLayerProfilePresent[i] {
			if _, ok := br.readBits(88); !ok {
				return false
			}
		}
		if subLayerLevelPresent[i] {
			if _, ok := br.readBits(8); !ok {
				return false
			}
		}
	}
	return true
}

// parseHEVCSPSResolution extracts picture width and height from an HEVC SPS NAL unit
// (ISO 23008-2). nalUnit includes the 2-byte NAL header.
func parseHEVCSPSResolution(nalUnit []byte) (width, height int, ok bool) {
	if len(nalUnit) < 3 {
		return 0, 0, false
	}
	rbsp := removeEmulationPreventionBytes(nalUnit[2:]) // skip 2-byte NAL header
	br := newBitReader(rbsp)

	if _, ok2 := br.readBits(4); !ok2 { // sps_video_parameter_set_id
		return 0, 0, false
	}
	maxSubLayersMinus1, ok2 := br.readBits(3) // sps_max_sub_layers_minus1
	if !ok2 {
		return 0, 0, false
	}
	if _, ok2 = br.readBit(); !ok2 { // sps_temporal_id_nesting_flag
		return 0, 0, false
	}
	if !skipHEVCProfileTierLevel(br, true, int(maxSubLayersMinus1)) {
		return 0, 0, false
	}
	if !br.skipUE() { // sps_seq_parameter_set_id
		return 0, 0, false
	}
	chromaFormatIDC, ok2 := br.readUE()
	if !ok2 {
		return 0, 0, false
	}
	if chromaFormatIDC == 3 {
		if _, ok3 := br.readBit(); !ok3 { // separate_colour_plane_flag
			return 0, 0, false
		}
	}
	picWidth, ok2 := br.readUE() // pic_width_in_luma_samples
	if !ok2 {
		return 0, 0, false
	}
	picHeight, ok2 := br.readUE() // pic_height_in_luma_samples
	if !ok2 {
		return 0, 0, false
	}

	var confWinLeft, confWinRight, confWinTop, confWinBottom uint64
	confWinFlag, ok2 := br.readBit()
	if !ok2 {
		return 0, 0, false
	}
	if confWinFlag == 1 {
		var ok3 bool
		if confWinLeft, ok3 = br.readUE(); !ok3 {
			return 0, 0, false
		}
		if confWinRight, ok3 = br.readUE(); !ok3 {
			return 0, 0, false
		}
		if confWinTop, ok3 = br.readUE(); !ok3 {
			return 0, 0, false
		}
		if confWinBottom, ok3 = br.readUE(); !ok3 {
			return 0, 0, false
		}
	}

	// Sub-sampling factors for conformance window offset scaling.
	subWidthC, subHeightC := uint64(1), uint64(1)
	switch chromaFormatIDC {
	case 1: // 4:2:0
		subWidthC, subHeightC = 2, 2
	case 2: // 4:2:2
		subWidthC = 2
	}
	w := int(picWidth - (confWinLeft+confWinRight)*subWidthC)
	h := int(picHeight - (confWinTop+confWinBottom)*subHeightC)
	return w, h, true
}

// --- AVC (H.264) ---

func parseAVCConfig(data []byte) []configField {
	if len(data) < 6 {
		return []configField{{name: "error", value: "truncated"}}
	}
	fields := []configField{
		{name: "configurationVersion", value: int(data[0])},
		{name: "AVCProfileIndication", value: int(data[1])},
		{name: "profile_compatibility", value: fmt.Sprintf("0x%02X", data[2])},
		{name: "AVCLevelIndication", value: int(data[3])},
		{name: "lengthSizeMinusOne", value: int(data[4] & 0x03)},
		{name: "numOfSPS", value: int(data[5] & 0x1F)},
	}
	// Extract resolution from the first SPS NAL unit.
	numSPS := int(data[5] & 0x1F)
	pos := 6
	if numSPS > 0 && pos+2 <= len(data) {
		spsLen := int(binary.BigEndian.Uint16(data[pos:]))
		pos += 2
		if pos+spsLen <= len(data) {
			if w, h, ok := parseAVCSPSResolution(data[pos : pos+spsLen]); ok {
				fields = append(fields,
					configField{name: "width", value: w},
					configField{name: "height", value: h},
				)
			}
		}
	}
	return fields
}

// --- HEVC (H.265) ---

func parseHEVCConfig(data []byte) []configField {
	if len(data) < 23 {
		return []configField{{name: "error", value: "truncated"}}
	}
	fields := []configField{
		{name: "configurationVersion", value: int(data[0])},
		{name: "general_profile_space", value: int(data[1] >> 6)},
		{name: "general_tier_flag", value: int((data[1] >> 5) & 0x01)},
		{name: "general_profile_idc", value: int(data[1] & 0x1F)},
		{name: "general_level_idc", value: int(data[12])},
		{name: "chroma_format_idc", value: int(data[16] & 0x03)},
		{name: "bit_depth_luma", value: int(data[17]&0x07) + 8},
		{name: "bit_depth_chroma", value: int(data[18]&0x07) + 8},
		{name: "avgFrameRate", value: int(binary.BigEndian.Uint16(data[19:21]))},
		{name: "numTemporalLayers", value: int((data[21] >> 3) & 0x07)},
		{name: "lengthSizeMinusOne", value: int(data[21] & 0x03)},
		{name: "numOfArrays", value: int(data[22])},
	}
	// Walk NAL unit arrays to find the SPS (NAL unit type 33 = SPS_NUT).
	numArrays := int(data[22])
	pos := 23
	for i := 0; i < numArrays && pos+3 <= len(data); i++ {
		nalUnitType := data[pos] & 0x3F
		numNALUs := int(binary.BigEndian.Uint16(data[pos+1:]))
		pos += 3
		for j := 0; j < numNALUs && pos+2 <= len(data); j++ {
			naluLen := int(binary.BigEndian.Uint16(data[pos:]))
			pos += 2
			if pos+naluLen > len(data) {
				break
			}
			nalu := data[pos : pos+naluLen]
			pos += naluLen
			if nalUnitType == 33 {
				if w, h, ok := parseHEVCSPSResolution(nalu); ok {
					fields = append(fields,
						configField{name: "width", value: w},
						configField{name: "height", value: h},
					)
					return fields
				}
			}
		}
	}
	return fields
}

// --- AV1 ---

func parseAV1Config(data []byte) []configField {
	if len(data) < 4 {
		return []configField{{name: "size", value: len(data)}}
	}
	marker := int((data[0] >> 7) & 0x01)
	version := int(data[0] & 0x7F)
	seqProfile := int((data[1] >> 5) & 0x07)
	seqLevelIdx0 := int(data[1] & 0x1F)
	seqTier0 := int((data[2] >> 7) & 0x01)
	highBitDepth := (data[2]>>6)&0x01 != 0
	twelveBit := (data[2]>>5)&0x01 != 0
	monochrome := (data[2]>>4)&0x01 != 0
	chromaSubsamplingX := int((data[2] >> 3) & 0x01)
	chromaSubsamplingY := int((data[2] >> 2) & 0x01)
	chromaSamplePosition := int(data[2] & 0x03)
	initialPresentationDelayPresent := int((data[3] >> 4) & 0x01)
	initialPresentationDelayMinusOne := int(data[3] & 0x0F)

	bitDepth := 8
	if highBitDepth && twelveBit {
		bitDepth = 12
	} else if highBitDepth {
		bitDepth = 10
	}

	fields := []configField{
		{name: "marker", value: marker},
		{name: "version", value: version},
		{name: "seq_profile", value: seqProfile},
		{name: "seq_level_idx_0", value: seqLevelIdx0},
		{name: "seq_tier_0", value: seqTier0},
		{name: "bit_depth", value: bitDepth},
		{name: "monochrome", value: monochrome},
		{name: "chroma_subsampling_x", value: chromaSubsamplingX},
		{name: "chroma_subsampling_y", value: chromaSubsamplingY},
		{name: "chroma_sample_position", value: chromaSamplePosition},
		{name: "initial_presentation_delay_present", value: initialPresentationDelayPresent},
	}
	if initialPresentationDelayPresent != 0 {
		fields = append(fields, configField{name: "initial_presentation_delay_minus_one", value: initialPresentationDelayMinusOne})
	}

	configOBUs := data[4:]
	fields = append(fields, configField{name: "config_obus_size", value: len(configOBUs)})
	if w, h, ok := parseAV1MaxFrameSizeFromConfigOBUs(configOBUs); ok {
		fields = append(fields,
			configField{name: "max_frame_width", value: w},
			configField{name: "max_frame_height", value: h},
		)
	}

	return fields
}

func parseAV1MaxFrameSizeFromConfigOBUs(configOBUs []byte) (width int, height int, ok bool) {
	// Walk concatenated OBUs until we find a Sequence Header OBU (obu_type=1).
	for i := 0; i < len(configOBUs); {
		header := configOBUs[i]
		i++
		if i > len(configOBUs) {
			break
		}

		obuType := (header >> 3) & 0x0F
		extensionFlag := (header>>2)&0x01 != 0
		hasSizeField := (header>>1)&0x01 != 0

		if extensionFlag {
			if i >= len(configOBUs) {
				return 0, 0, false
			}
			// Skip obu_extension_header.
			i++
		}

		payloadSize := len(configOBUs) - i
		if hasSizeField {
			sz, n, ok2 := readULEB128(configOBUs[i:])
			if !ok2 {
				return 0, 0, false
			}
			i += n
			if i+int(sz) > len(configOBUs) {
				return 0, 0, false
			}
			payloadSize = int(sz)
		}

		payload := configOBUs[i : i+payloadSize]
		i += payloadSize

		// 1 = OBU_SEQUENCE_HEADER
		if obuType == 1 {
			w, h, ok2 := parseAV1SequenceHeaderMaxFrameSize(payload)
			if ok2 {
				return w, h, true
			}
		}

		// If there is no size field, we cannot know boundaries reliably.
		if !hasSizeField {
			break
		}
	}
	return 0, 0, false
}

func parseAV1SequenceHeaderMaxFrameSize(payload []byte) (width int, height int, ok bool) {
	br := newBitReader(payload)

	// seq_profile (3), still_picture (1), reduced_still_picture_header (1)
	_, ok = br.readBits(3)
	if !ok {
		return 0, 0, false
	}
	stillPictureBit, ok := br.readBits(1)
	if !ok {
		return 0, 0, false
	}
	_ = stillPictureBit
	reducedStillHeader, ok := br.readBits(1)
	if !ok {
		return 0, 0, false
	}

	if reducedStillHeader == 0 {
		// timing_info_present_flag (1)
		timingInfoPresent, ok := br.readBits(1)
		if !ok {
			return 0, 0, false
		}
		if timingInfoPresent != 0 {
			// timing_info: num_units_in_display_tick (32), time_scale (32), equal_picture_interval (1)
			if _, ok := br.readBits(32); !ok {
				return 0, 0, false
			}
			if _, ok := br.readBits(32); !ok {
				return 0, 0, false
			}
			equalPicInterval, ok := br.readBits(1)
			if !ok {
				return 0, 0, false
			}
			if equalPicInterval != 0 {
				// num_ticks_per_picture_minus_1 (uvlc) - skip (not needed for size).
				// uvlc is variable-length; parsing it fully is out of scope here.
				// Bail out gracefully.
				return 0, 0, false
			}
			// decoder_model_info_present_flag (1)
			decoderModelInfoPresent, ok := br.readBits(1)
			if !ok {
				return 0, 0, false
			}
			if decoderModelInfoPresent != 0 {
				// decoder_model_info() contains several fixed-width fields.
				// buffer_delay_length_minus_1 (5)
				if _, ok := br.readBits(5); !ok {
					return 0, 0, false
				}
				// num_units_in_decoding_tick (32)
				if _, ok := br.readBits(32); !ok {
					return 0, 0, false
				}
				// buffer_removal_time_length_minus_1 (5)
				if _, ok := br.readBits(5); !ok {
					return 0, 0, false
				}
				// frame_presentation_time_length_minus_1 (5)
				if _, ok := br.readBits(5); !ok {
					return 0, 0, false
				}
			}
		}

		// initial_display_delay_present_flag (1)
		initialDisplayDelayPresent, ok := br.readBits(1)
		if !ok {
			return 0, 0, false
		}

		// operating_points_cnt_minus_1 (5)
		operatingPointsCntMinus1, ok := br.readBits(5)
		if !ok {
			return 0, 0, false
		}

		for op := 0; op <= int(operatingPointsCntMinus1); op++ {
			// operating_point_idc (12)
			if _, ok := br.readBits(12); !ok {
				return 0, 0, false
			}
			// seq_level_idx (5)
			seqLevelIdx, ok := br.readBits(5)
			if !ok {
				return 0, 0, false
			}
			if seqLevelIdx > 7 {
				// seq_tier (1)
				if _, ok := br.readBits(1); !ok {
					return 0, 0, false
				}
			}
			// decoder_model_present_for_this_op (1) if decoder_model_info_present_flag was set.
			// We don't track decoder_model_info_present_flag above reliably if timing_info_present=0;
			// For now, assume it's absent unless timing_info_present had it.
			// This keeps parsing simple; if present, we may fail and return false.
			_ = op
			if initialDisplayDelayPresent != 0 {
				// initial_display_delay_present_for_this_op (1)
				present, ok := br.readBits(1)
				if !ok {
					return 0, 0, false
				}
				if present != 0 {
					// initial_display_delay_minus_1 (4)
					if _, ok := br.readBits(4); !ok {
						return 0, 0, false
					}
				}
			}
		}
	}

	// frame_width_bits_minus_1 (4)
	fwBitsMinus1, ok := br.readBits(4)
	if !ok {
		return 0, 0, false
	}
	// frame_height_bits_minus_1 (4)
	fhBitsMinus1, ok := br.readBits(4)
	if !ok {
		return 0, 0, false
	}

	// max_frame_width_minus_1 (fwBitsMinus1+1)
	maxWMinus1, ok := br.readBits(int(fwBitsMinus1) + 1)
	if !ok {
		return 0, 0, false
	}
	// max_frame_height_minus_1 (fhBitsMinus1+1)
	maxHMinus1, ok := br.readBits(int(fhBitsMinus1) + 1)
	if !ok {
		return 0, 0, false
	}

	return int(maxWMinus1) + 1, int(maxHMinus1) + 1, true
}

// --- VP9 ---

func parseVP9Config(data []byte) []configField {
	// VPcodecConfigurationRecord is carried in a FullBox payload:
	// [fullbox_version(1)][fullbox_flags(3)]
	// [profile(1)][level(1)][bitDepth/chroma/fullRange(1)]
	// [colourPrimaries(1)][transferCharacteristics(1)][matrixCoefficients(1)]
	// [codecInitializationDataSize(2)][codecInitializationData(N)]
	if len(data) < 12 {
		return []configField{{name: "error", value: "truncated"}}
	}
	fullboxVersion := int(data[0])
	vpcc := data[4:]

	profile := int(vpcc[0])
	level := int(vpcc[1])
	bitDepth := int(vpcc[2] >> 4)
	chromaSubsampling := int((vpcc[2] >> 1) & 0x07)
	videoFullRangeFlag := int(vpcc[2] & 0x01)
	colourPrimaries := int(vpcc[3])
	transferCharacteristics := int(vpcc[4])
	matrixCoefficients := int(vpcc[5])
	codecInitializationDataSize := int(binary.BigEndian.Uint16(vpcc[6:8]))

	return []configField{
		{name: "fullbox_version", value: fullboxVersion},
		{name: "profile", value: profile},
		{name: "level", value: level},
		{name: "bit_depth", value: bitDepth},
		{name: "chroma_subsampling", value: chromaSubsampling},
		{name: "videoFullRangeFlag", value: videoFullRangeFlag},
		{name: "colour_primaries", value: colourPrimaries},
		{name: "transfer_characteristics", value: transferCharacteristics},
		{name: "matrix_coefficients", value: matrixCoefficients},
		{name: "codec_initialization_data_size", value: codecInitializationDataSize},
	}
}

func parseVP9KeyframeResolution(data []byte) (width int, height int, ok bool) {
	br := newBitReader(data)

	frameMarker, ok := br.readBits(2)
	if !ok || frameMarker != 0x2 {
		return 0, 0, false
	}

	profileLow, ok := br.readBit()
	if !ok {
		return 0, 0, false
	}
	profileHigh, ok := br.readBit()
	if !ok {
		return 0, 0, false
	}
	profile := int(profileLow | (profileHigh << 1))
	if profile == 3 {
		if _, ok = br.readBit(); !ok { // reserved_zero
			return 0, 0, false
		}
	}

	showExistingFrame, ok := br.readBit()
	if !ok {
		return 0, 0, false
	}
	if showExistingFrame == 1 {
		return 0, 0, false
	}

	frameType, ok := br.readBit()
	if !ok {
		return 0, 0, false
	}
	if frameType != 0 {
		return 0, 0, false // not a keyframe
	}

	if _, ok = br.readBit(); !ok { // show_frame
		return 0, 0, false
	}
	if _, ok = br.readBit(); !ok { // error_resilient_mode
		return 0, 0, false
	}

	syncCode, ok := br.readBits(24)
	if !ok || syncCode != 0x498342 {
		return 0, 0, false
	}

	// color_config() - we only need to consume bits before frame size fields.
	if profile >= 2 {
		if _, ok = br.readBit(); !ok { // ten_or_twelve_bit
			return 0, 0, false
		}
	}
	colorSpace, ok := br.readBits(3)
	if !ok {
		return 0, 0, false
	}
	if colorSpace != 7 {
		if _, ok = br.readBit(); !ok { // color_range
			return 0, 0, false
		}
		if profile == 1 || profile == 3 {
			if _, ok = br.readBit(); !ok { // subsampling_x
				return 0, 0, false
			}
			if _, ok = br.readBit(); !ok { // subsampling_y
				return 0, 0, false
			}
			if _, ok = br.readBit(); !ok { // reserved_zero
				return 0, 0, false
			}
		}
	} else if profile == 1 || profile == 3 {
		if _, ok = br.readBit(); !ok { // reserved_zero in RGB mode
			return 0, 0, false
		}
	}

	wMinus1, ok := br.readBits(16)
	if !ok {
		return 0, 0, false
	}
	hMinus1, ok := br.readBits(16)
	if !ok {
		return 0, 0, false
	}

	return int(wMinus1) + 1, int(hMinus1) + 1, true
}

// --- AAC ---

func parseAACConfig(data []byte) []configField {
	if len(data) < 2 {
		return []configField{{name: "error", value: "truncated"}}
	}
	audioObjectType := int(data[0] >> 3)
	samplingIndex := int((data[0]&0x07)<<1) | int(data[1]>>7)
	channelConfig := int((data[1] >> 3) & 0x0F)

	samplingFreq := 0
	if samplingIndex < len(aacSamplingFrequencies) {
		samplingFreq = aacSamplingFrequencies[samplingIndex]
	}

	return []configField{
		{name: "audioObjectType", value: audioObjectType},
		{name: "samplingFrequency", value: samplingFreq},
		{name: "channelConfiguration", value: channelConfig},
	}
}

// --- Opus (RFC 7845 OpusHead) ---

func parseOpusConfig(data []byte) []configField {
	// OpusHead: "OpusHead"(8) + version(1) + channels(1) + preSkip(2) + sampleRate(4) + outputGain(2) + mappingFamily(1) = 19 bytes min
	if len(data) < 19 {
		return []configField{{name: "size", value: len(data)}}
	}
	magic := string(data[0:8])
	if magic != "OpusHead" {
		return []configField{{name: "size", value: len(data)}}
	}
	version := int(data[8])
	channels := int(data[9])
	preSkip := int(binary.LittleEndian.Uint16(data[10:12]))
	inputSampleRate := int(binary.LittleEndian.Uint32(data[12:16]))
	outputGain := int(int16(binary.LittleEndian.Uint16(data[16:18])))
	mappingFamily := int(data[18])

	return []configField{
		{name: "version", value: version},
		{name: "channels", value: channels},
		{name: "preSkip", value: preSkip},
		{name: "inputSampleRate", value: inputSampleRate},
		{name: "outputGain", value: outputGain},
		{name: "mappingFamily", value: mappingFamily},
	}
}

// --- FLAC ---

func parseFLACConfig(data []byte) []configField {
	// FLAC STREAMINFO block: marker(1) + type/length(4) + STREAMINFO(34) = min ~39 bytes
	// But the enhanced audio payload may just be the raw STREAMINFO.
	// STREAMINFO: minBlockSize(2) + maxBlockSize(2) + minFrameSize(3) + maxFrameSize(3) +
	//   sampleRate(20bits) + channels(3bits) + bitsPerSample(5bits) + totalSamples(36bits) + md5(16) = 34 bytes
	if len(data) < 34 {
		return []configField{{name: "size", value: len(data)}}
	}
	// Try to detect if there's a fLaC marker or metadata block header before STREAMINFO.
	offset := 0
	if len(data) >= 38 && string(data[0:4]) == "fLaC" {
		offset = 4 // skip the fLaC marker
	}
	if offset+34 > len(data) {
		return []configField{{name: "size", value: len(data)}}
	}
	// If next byte looks like a metadata block header (type in upper 7 bits), skip 4 bytes.
	if offset+4+34 <= len(data) && (data[offset]&0x7F) == 0 {
		offset += 4 // skip block header (type=0 STREAMINFO + 3 byte length)
	}
	if offset+34 > len(data) {
		return []configField{{name: "size", value: len(data)}}
	}
	d := data[offset:]
	minBlockSize := int(binary.BigEndian.Uint16(d[0:2]))
	maxBlockSize := int(binary.BigEndian.Uint16(d[2:4]))
	sampleRate := int(d[10])<<12 | int(d[11])<<4 | int(d[12]>>4)
	channels := int((d[12]>>1)&0x07) + 1
	bitsPerSample := int(d[12]&0x01)<<4 | int(d[13]>>4) + 1

	return []configField{
		{name: "minBlockSize", value: minBlockSize},
		{name: "maxBlockSize", value: maxBlockSize},
		{name: "sampleRate", value: sampleRate},
		{name: "channels", value: channels},
		{name: "bitsPerSample", value: bitsPerSample},
	}
}

// --- Printing ---

func printCodecConfig(cfg codecConfig) {
	fmt.Printf("codecConfigurationRecord (%s: %s)\n", cfg.trackType, cfg.codec)
	for _, f := range cfg.fields {
		fmt.Printf("  %s: %v\n", f.name, f.value)
	}
}

// --- Helpers ---

func discardAndReturn(r io.Reader, n int) ([]codecConfig, error) {
	if n > 0 {
		if _, err := io.CopyN(io.Discard, r, int64(n)); err != nil {
			return nil, err
		}
	}
	return nil, nil
}

func readRemaining(r io.Reader, n int) ([]byte, error) {
	if n <= 0 {
		return nil, nil
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}
