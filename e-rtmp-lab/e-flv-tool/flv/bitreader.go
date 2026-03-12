package flv

// --- SPS bit reader (H.264 / H.265 RBSP parsing) ---

type h26xBitReader struct {
	data   []byte
	bitPos int // global bit index, MSB-first
}

func newH26xBitReader(data []byte) *h26xBitReader {
	return &h26xBitReader{data: data}
}

func (r *h26xBitReader) readBit() (uint64, bool) {
	if r.bitPos >= len(r.data)*8 {
		return 0, false
	}
	b := uint64((r.data[r.bitPos/8] >> (7 - uint(r.bitPos%8))) & 1)
	r.bitPos++
	return b, true
}

func (r *h26xBitReader) readBits(n int) (uint64, bool) {
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

func (r *h26xBitReader) readUE() (uint64, bool) {
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

func (r *h26xBitReader) readSE() (int64, bool) {
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

func (r *h26xBitReader) skipUE() bool { _, ok := r.readUE(); return ok }
func (r *h26xBitReader) skipSE() bool { _, ok := r.readSE(); return ok }

// --- AV1 bit reader ---

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

// --- VP9 bit reader ---

// vp9BitReader reads bits MSB-first in each byte for VP9 uncompressed header parsing.
type vp9BitReader struct {
	data   []byte
	bitPos int
}

func newVP9BitReader(data []byte) *vp9BitReader {
	return &vp9BitReader{data: data}
}

func (r *vp9BitReader) readBit() (uint64, bool) {
	if r.bitPos >= len(r.data)*8 {
		return 0, false
	}
	b := (r.data[r.bitPos/8] >> (7 - uint(r.bitPos%8))) & 0x01
	r.bitPos++
	return uint64(b), true
}

func (r *vp9BitReader) readBits(n int) (uint64, bool) {
	if n < 0 || n > 64 {
		return 0, false
	}
	var v uint64
	for i := 0; i < n; i++ {
		bit, ok := r.readBit()
		if !ok {
			return 0, false
		}
		v = (v << 1) | bit
	}
	return v, true
}
