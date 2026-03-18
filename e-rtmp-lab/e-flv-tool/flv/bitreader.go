package flv

// bitReader reads bits MSB-first from a byte slice.
type bitReader struct {
	data   []byte
	bitPos int // global bit index
}

func newBitReader(data []byte) *bitReader {
	return &bitReader{data: data}
}

func (r *bitReader) readBit() (uint64, bool) {
	if r.bitPos >= len(r.data)*8 {
		return 0, false
	}
	b := uint64((r.data[r.bitPos/8] >> (7 - uint(r.bitPos%8))) & 1)
	r.bitPos++
	return b, true
}

func (r *bitReader) readBits(n int) (uint64, bool) {
	if n < 0 || n > 64 {
		return 0, false
	}
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

// readUE reads an Exp-Golomb unsigned integer (H.264/H.265 RBSP).
func (r *bitReader) readUE() (uint64, bool) {
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

// readSE reads an Exp-Golomb signed integer (H.264/H.265 RBSP).
func (r *bitReader) readSE() (int64, bool) {
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

func (r *bitReader) skipUE() bool { _, ok := r.readUE(); return ok }
func (r *bitReader) skipSE() bool { _, ok := r.readSE(); return ok }

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
