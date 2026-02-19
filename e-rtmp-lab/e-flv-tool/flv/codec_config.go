package flv

import (
	"encoding/binary"
	"fmt"
	"io"
)

// CodecConfig holds the parsed fields from a codec configuration record.
type CodecConfig struct {
	TrackType string        // "video" or "audio"
	Codec     string        // FourCC string, e.g. "hvc1", "mp4a", "avc1"
	Fields    []ConfigField // parsed key/value pairs
}

// ConfigField is a single named value from a config record.
type ConfigField struct {
	Name  string
	Value interface{}
}

// Packet type for sequence start (same value for both video and audio in E-RTMP).
const packetTypeSequenceStart = 0

// Legacy codec identifiers.
const (
	videoCodecIDAVC    = 7
	soundFormatAAC     = 10
	soundFormatExAudio = 9
)

// AAC sampling frequency table (ISO 14496-3).
var aacSamplingFrequencies = [...]int{
	96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
	16000, 12000, 11025, 8000, 7350,
}

// tryParseVideoConfig reads a video tag payload from r. If the tag is a
// sequence header, it parses the codec configuration record and returns it.
// Otherwise it skips the payload. Returns nil config for non-sequence tags.
// The full dataSize bytes are always consumed from r.
func tryParseVideoConfig(r io.Reader, dataSize int) (*CodecConfig, error) {
	if dataSize < 5 {
		return discardAndReturn(r, dataSize)
	}

	var header [5]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return nil, err
	}
	remaining := dataSize - 5

	isExHeader := header[0]&0x80 != 0

	if isExHeader {
		packetType := header[0] & 0x0F
		fourCC := string(header[1:5])

		if packetType != packetTypeSequenceStart {
			return discardAndReturn(r, remaining)
		}

		configData, err := readRemaining(r, remaining)
		if err != nil {
			return nil, err
		}

		fields := parseVideoConfigByFourCC(fourCC, configData)
		return &CodecConfig{TrackType: "video", Codec: fourCC, Fields: fields}, nil
	}

	// Legacy video.
	codecID := header[0] & 0x0F
	if codecID == videoCodecIDAVC {
		avcPacketType := header[1]
		// header[2..4] = CompositionTimeOffset (skip)
		if avcPacketType == 0 {
			configData, err := readRemaining(r, remaining)
			if err != nil {
				return nil, err
			}
			fields := parseAVCConfig(configData)
			return &CodecConfig{TrackType: "video", Codec: "avc1", Fields: fields}, nil
		}
	}

	return discardAndReturn(r, remaining)
}

// tryParseAudioConfig reads an audio tag payload from r. If the tag is a
// sequence header, it parses the codec configuration record and returns it.
// Otherwise it skips the payload. The full dataSize bytes are always consumed.
func tryParseAudioConfig(r io.Reader, dataSize int) (*CodecConfig, error) {
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
		return &CodecConfig{TrackType: "audio", Codec: fourCC, Fields: fields}, nil
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
			return &CodecConfig{TrackType: "audio", Codec: "mp4a", Fields: fields}, nil
		}
	}

	return discardAndReturn(r, remaining)
}

func parseVideoConfigByFourCC(fourCC string, data []byte) []ConfigField {
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
		return []ConfigField{{Name: "size", Value: len(data)}}
	}
}

func parseAudioConfigByFourCC(fourCC string, data []byte) []ConfigField {
	switch fourCC {
	case "mp4a":
		return parseAACConfig(data)
	case "Opus":
		return parseOpusConfig(data)
	case "fLaC":
		return parseFLACConfig(data)
	default:
		return []ConfigField{{Name: "size", Value: len(data)}}
	}
}

// --- SPS bit reader (H.264 / H.265 RBSP parsing) ---

type spsBitReader struct {
	data   []byte
	bitPos int // global bit index, MSB-first
}

func newSPSBitReader(data []byte) *spsBitReader {
	return &spsBitReader{data: data}
}

func (r *spsBitReader) readBit() (uint64, bool) {
	if r.bitPos >= len(r.data)*8 {
		return 0, false
	}
	b := uint64((r.data[r.bitPos/8] >> (7 - uint(r.bitPos%8))) & 1)
	r.bitPos++
	return b, true
}

func (r *spsBitReader) readBits(n int) (uint64, bool) {
	var v uint64
	for i := 0; i < n; i++ {
		b, ok := r.readBit()
		if !ok {
			return 0, false
		}
		v = (v << 1) | b
	}
	return v, true
}

func (r *spsBitReader) readUE() (uint64, bool) {
	leadingZeros := 0
	for {
		b, ok := r.readBit()
		if !ok {
			return 0, false
		}
		if b == 1 {
			break
		}
		leadingZeros++
		if leadingZeros > 31 {
			return 0, false
		}
	}
	if leadingZeros == 0 {
		return 0, true
	}
	suffix, ok := r.readBits(leadingZeros)
	if !ok {
		return 0, false
	}
	return (1<<uint(leadingZeros) - 1) + suffix, true
}

func (r *spsBitReader) readSE() (int64, bool) {
	v, ok := r.readUE()
	if !ok {
		return 0, false
	}
	if v == 0 {
		return 0, true
	}
	if v%2 == 1 {
		return int64((v + 1) / 2), true
	}
	return -int64(v / 2), true
}

func (r *spsBitReader) skipUE() bool { _, ok := r.readUE(); return ok }
func (r *spsBitReader) skipSE() bool { _, ok := r.readSE(); return ok }

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
	br := newSPSBitReader(rbsp[3:])

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
func skipHEVCProfileTierLevel(br *spsBitReader, profilePresentFlag bool, maxNumSubLayersMinus1 int) bool {
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
	br := newSPSBitReader(rbsp)

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

func parseAVCConfig(data []byte) []ConfigField {
	if len(data) < 6 {
		return []ConfigField{{Name: "error", Value: "truncated"}}
	}
	fields := []ConfigField{
		{Name: "configurationVersion", Value: int(data[0])},
		{Name: "AVCProfileIndication", Value: int(data[1])},
		{Name: "profile_compatibility", Value: fmt.Sprintf("0x%02X", data[2])},
		{Name: "AVCLevelIndication", Value: int(data[3])},
		{Name: "lengthSizeMinusOne", Value: int(data[4] & 0x03)},
		{Name: "numOfSPS", Value: int(data[5] & 0x1F)},
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
					ConfigField{Name: "width", Value: w},
					ConfigField{Name: "height", Value: h},
				)
			}
		}
	}
	return fields
}

// --- HEVC (H.265) ---

func parseHEVCConfig(data []byte) []ConfigField {
	if len(data) < 23 {
		return []ConfigField{{Name: "error", Value: "truncated"}}
	}
	fields := []ConfigField{
		{Name: "configurationVersion", Value: int(data[0])},
		{Name: "general_profile_space", Value: int(data[1] >> 6)},
		{Name: "general_tier_flag", Value: int((data[1] >> 5) & 0x01)},
		{Name: "general_profile_idc", Value: int(data[1] & 0x1F)},
		{Name: "general_level_idc", Value: int(data[12])},
		{Name: "chroma_format_idc", Value: int(data[16] & 0x03)},
		{Name: "bit_depth_luma", Value: int(data[17]&0x07) + 8},
		{Name: "bit_depth_chroma", Value: int(data[18]&0x07) + 8},
		{Name: "avgFrameRate", Value: int(binary.BigEndian.Uint16(data[19:21]))},
		{Name: "numTemporalLayers", Value: int((data[21] >> 3) & 0x07)},
		{Name: "lengthSizeMinusOne", Value: int(data[21] & 0x03)},
		{Name: "numOfArrays", Value: int(data[22])},
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
						ConfigField{Name: "width", Value: w},
						ConfigField{Name: "height", Value: h},
					)
					return fields
				}
			}
		}
	}
	return fields
}

// --- AV1 ---

func parseAV1Config(data []byte) []ConfigField {
	if len(data) < 4 {
		return []ConfigField{{Name: "size", Value: len(data)}}
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

	fields := []ConfigField{
		{Name: "marker", Value: marker},
		{Name: "version", Value: version},
		{Name: "seq_profile", Value: seqProfile},
		{Name: "seq_level_idx_0", Value: seqLevelIdx0},
		{Name: "seq_tier_0", Value: seqTier0},
		{Name: "bit_depth", Value: bitDepth},
		{Name: "monochrome", Value: monochrome},
		{Name: "chroma_subsampling_x", Value: chromaSubsamplingX},
		{Name: "chroma_subsampling_y", Value: chromaSubsamplingY},
		{Name: "chroma_sample_position", Value: chromaSamplePosition},
		{Name: "initial_presentation_delay_present", Value: initialPresentationDelayPresent},
	}
	if initialPresentationDelayPresent != 0 {
		fields = append(fields, ConfigField{Name: "initial_presentation_delay_minus_one", Value: initialPresentationDelayMinusOne})
	}

	configOBUs := data[4:]
	fields = append(fields, ConfigField{Name: "config_obus_size", Value: len(configOBUs)})
	if w, h, ok := parseAV1MaxFrameSizeFromConfigOBUs(configOBUs); ok {
		fields = append(fields,
			ConfigField{Name: "max_frame_width", Value: w},
			ConfigField{Name: "max_frame_height", Value: h},
		)
	}

	return fields
}

type av1BitReader struct {
	data    []byte
	bytePos int
	bitPos  uint8 // 0..7, MSB-first
}

func newAV1BitReader(data []byte) *av1BitReader {
	return &av1BitReader{data: data, bitPos: 0}
}

func (br *av1BitReader) readBit() (uint8, bool) {
	if br.bytePos >= len(br.data) {
		return 0, false
	}
	b := br.data[br.bytePos]
	bit := (b >> (7 - br.bitPos)) & 0x01
	br.bitPos++
	if br.bitPos == 8 {
		br.bitPos = 0
		br.bytePos++
	}
	return bit, true
}

func (br *av1BitReader) readBits(n int) (uint64, bool) {
	if n < 0 || n > 64 {
		return 0, false
	}
	var v uint64
	for i := 0; i < n; i++ {
		bit, ok := br.readBit()
		if !ok {
			return 0, false
		}
		v = (v << 1) | uint64(bit)
	}
	return v, true
}

func readULEB128(data []byte) (value uint64, bytesRead int, ok bool) {
	var shift uint
	for i := 0; i < len(data) && i < 10; i++ {
		b := data[i]
		value |= uint64(b&0x7F) << shift
		bytesRead++
		if (b & 0x80) == 0 {
			return value, bytesRead, true
		}
		shift += 7
	}
	return 0, 0, false
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
	br := newAV1BitReader(payload)

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

func parseVP9Config(data []byte) []ConfigField {
	if len(data) < 8 {
		return []ConfigField{{Name: "error", Value: "truncated"}}
	}
	profile := int(data[0])
	level := int(data[1])
	bitDepth := int(data[2] >> 4)
	chromaSubsampling := int((data[2] >> 1) & 0x07)
	videoFullRangeFlag := int(data[2] & 0x01)

	return []ConfigField{
		{Name: "profile", Value: profile},
		{Name: "level", Value: level},
		{Name: "bit_depth", Value: bitDepth},
		{Name: "chroma_subsampling", Value: chromaSubsampling},
		{Name: "videoFullRangeFlag", Value: videoFullRangeFlag},
	}
}

// --- AAC ---

func parseAACConfig(data []byte) []ConfigField {
	if len(data) < 2 {
		return []ConfigField{{Name: "error", Value: "truncated"}}
	}
	audioObjectType := int(data[0] >> 3)
	samplingIndex := int((data[0]&0x07)<<1) | int(data[1]>>7)
	channelConfig := int((data[1] >> 3) & 0x0F)

	samplingFreq := 0
	if samplingIndex < len(aacSamplingFrequencies) {
		samplingFreq = aacSamplingFrequencies[samplingIndex]
	}

	return []ConfigField{
		{Name: "audioObjectType", Value: audioObjectType},
		{Name: "samplingFrequency", Value: samplingFreq},
		{Name: "channelConfiguration", Value: channelConfig},
	}
}

// --- Opus (RFC 7845 OpusHead) ---

func parseOpusConfig(data []byte) []ConfigField {
	// OpusHead: "OpusHead"(8) + version(1) + channels(1) + preSkip(2) + sampleRate(4) + outputGain(2) + mappingFamily(1) = 19 bytes min
	if len(data) < 19 {
		return []ConfigField{{Name: "size", Value: len(data)}}
	}
	magic := string(data[0:8])
	if magic != "OpusHead" {
		return []ConfigField{{Name: "size", Value: len(data)}}
	}
	version := int(data[8])
	channels := int(data[9])
	preSkip := int(binary.LittleEndian.Uint16(data[10:12]))
	inputSampleRate := int(binary.LittleEndian.Uint32(data[12:16]))
	outputGain := int(int16(binary.LittleEndian.Uint16(data[16:18])))
	mappingFamily := int(data[18])

	return []ConfigField{
		{Name: "version", Value: version},
		{Name: "channels", Value: channels},
		{Name: "preSkip", Value: preSkip},
		{Name: "inputSampleRate", Value: inputSampleRate},
		{Name: "outputGain", Value: outputGain},
		{Name: "mappingFamily", Value: mappingFamily},
	}
}

// --- FLAC ---

func parseFLACConfig(data []byte) []ConfigField {
	// FLAC STREAMINFO block: marker(1) + type/length(4) + STREAMINFO(34) = min ~39 bytes
	// But the enhanced audio payload may just be the raw STREAMINFO.
	// STREAMINFO: minBlockSize(2) + maxBlockSize(2) + minFrameSize(3) + maxFrameSize(3) +
	//   sampleRate(20bits) + channels(3bits) + bitsPerSample(5bits) + totalSamples(36bits) + md5(16) = 34 bytes
	if len(data) < 34 {
		return []ConfigField{{Name: "size", Value: len(data)}}
	}
	// Try to detect if there's a fLaC marker or metadata block header before STREAMINFO.
	offset := 0
	if len(data) >= 38 && string(data[0:4]) == "fLaC" {
		offset = 4 // skip the fLaC marker
	}
	if offset+34 > len(data) {
		return []ConfigField{{Name: "size", Value: len(data)}}
	}
	// If next byte looks like a metadata block header (type in upper 7 bits), skip 4 bytes.
	if offset+4+34 <= len(data) && (data[offset]&0x7F) == 0 {
		offset += 4 // skip block header (type=0 STREAMINFO + 3 byte length)
	}
	if offset+34 > len(data) {
		return []ConfigField{{Name: "size", Value: len(data)}}
	}
	d := data[offset:]
	minBlockSize := int(binary.BigEndian.Uint16(d[0:2]))
	maxBlockSize := int(binary.BigEndian.Uint16(d[2:4]))
	sampleRate := int(d[10])<<12 | int(d[11])<<4 | int(d[12]>>4)
	channels := int((d[12]>>1)&0x07) + 1
	bitsPerSample := int(d[12]&0x01)<<4 | int(d[13]>>4) + 1

	return []ConfigField{
		{Name: "minBlockSize", Value: minBlockSize},
		{Name: "maxBlockSize", Value: maxBlockSize},
		{Name: "sampleRate", Value: sampleRate},
		{Name: "channels", Value: channels},
		{Name: "bitsPerSample", Value: bitsPerSample},
	}
}

// --- Printing ---

func printCodecConfig(cfg CodecConfig) {
	fmt.Printf("CodecConfigurationRecord (%s: %s)\n", cfg.TrackType, cfg.Codec)
	for _, f := range cfg.Fields {
		fmt.Printf("  %s: %v\n", f.Name, f.Value)
	}
}

// --- Helpers ---

func discardAndReturn(r io.Reader, n int) (*CodecConfig, error) {
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
