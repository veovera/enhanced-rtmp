package flv

import (
	"encoding/binary"
	"fmt"
	"math"
)

// AMF0 type markers.
const (
	amf0Number     = 0x00
	amf0Boolean    = 0x01
	amf0String     = 0x02
	amf0Object     = 0x03
	amf0Null       = 0x05
	amf0Undefined  = 0x06
	amf0ECMAArray  = 0x08
	amf0StrictArr  = 0x0A
	amf0Date       = 0x0B
	amf0LongString = 0x0C
)

// AMF0Property is a named value from an AMF0 object or ECMA array.
type AMF0Property struct {
	Name  string
	Value interface{}
}

// parseAMF0Value reads one AMF0-encoded value from data[offset:] and returns
// the decoded value and the new offset. Returns an error on malformed input.
func parseAMF0Value(data []byte, offset int) (interface{}, int, error) {
	if offset >= len(data) {
		return nil, offset, fmt.Errorf("AMF0: unexpected end of data")
	}

	marker := data[offset]
	offset++

	switch marker {
	case amf0Number:
		if offset+8 > len(data) {
			return nil, offset, fmt.Errorf("AMF0: truncated number")
		}
		bits := binary.BigEndian.Uint64(data[offset : offset+8])
		offset += 8
		return math.Float64frombits(bits), offset, nil

	case amf0Boolean:
		if offset >= len(data) {
			return nil, offset, fmt.Errorf("AMF0: truncated boolean")
		}
		v := data[offset] != 0
		offset++
		return v, offset, nil

	case amf0String:
		s, newOff, err := readAMF0String(data, offset)
		if err != nil {
			return nil, offset, err
		}
		return s, newOff, nil

	case amf0Object:
		return readAMF0Object(data, offset)

	case amf0Null, amf0Undefined:
		return nil, offset, nil

	case amf0ECMAArray:
		if offset+4 > len(data) {
			return nil, offset, fmt.Errorf("AMF0: truncated ECMA array count")
		}
		// The count is approximate; we still read until the end marker.
		offset += 4
		return readAMF0Object(data, offset)

	case amf0StrictArr:
		if offset+4 > len(data) {
			return nil, offset, fmt.Errorf("AMF0: truncated strict array count")
		}
		count := binary.BigEndian.Uint32(data[offset : offset+4])
		offset += 4
		arr := make([]interface{}, 0, count)
		for i := uint32(0); i < count; i++ {
			v, newOff, err := parseAMF0Value(data, offset)
			if err != nil {
				return nil, offset, err
			}
			offset = newOff
			arr = append(arr, v)
		}
		return arr, offset, nil

	case amf0Date:
		if offset+10 > len(data) {
			return nil, offset, fmt.Errorf("AMF0: truncated date")
		}
		bits := binary.BigEndian.Uint64(data[offset : offset+8])
		offset += 10 // 8 bytes timestamp + 2 bytes timezone
		return math.Float64frombits(bits), offset, nil

	case amf0LongString:
		if offset+4 > len(data) {
			return nil, offset, fmt.Errorf("AMF0: truncated long string length")
		}
		length := int(binary.BigEndian.Uint32(data[offset : offset+4]))
		offset += 4
		if offset+length > len(data) {
			return nil, offset, fmt.Errorf("AMF0: truncated long string")
		}
		s := string(data[offset : offset+length])
		offset += length
		return s, offset, nil

	default:
		return nil, offset, fmt.Errorf("AMF0: unsupported type marker 0x%02X at offset %d", marker, offset-1)
	}
}

func readAMF0String(data []byte, offset int) (string, int, error) {
	if offset+2 > len(data) {
		return "", offset, fmt.Errorf("AMF0: truncated string length")
	}
	length := int(binary.BigEndian.Uint16(data[offset : offset+2]))
	offset += 2
	if offset+length > len(data) {
		return "", offset, fmt.Errorf("AMF0: truncated string")
	}
	s := string(data[offset : offset+length])
	offset += length
	return s, offset, nil
}

func readAMF0Object(data []byte, offset int) ([]AMF0Property, int, error) {
	var props []AMF0Property
	for {
		if offset+3 > len(data) {
			return props, offset, fmt.Errorf("AMF0: truncated object")
		}
		// Check for object end marker: 0x00 0x00 0x09
		if data[offset] == 0x00 && data[offset+1] == 0x00 && data[offset+2] == 0x09 {
			offset += 3
			return props, offset, nil
		}
		name, newOff, err := readAMF0String(data, offset)
		if err != nil {
			return props, offset, err
		}
		offset = newOff

		value, newOff, err := parseAMF0Value(data, offset)
		if err != nil {
			return props, offset, err
		}
		offset = newOff

		props = append(props, AMF0Property{Name: name, Value: value})
	}
}
