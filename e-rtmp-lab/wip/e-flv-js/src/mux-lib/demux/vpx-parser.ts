import ExpGolomb from './exp-golomb.js';

const vp9HeaderInfo = {
  width: 0,
  height: 0,
  renderWidth: 0,
  renderHeight: 0,
  profile: 0,
  isValid: false
};

export type Vp9HeaderInfo = typeof vp9HeaderInfo;

export class VpxParser {

  // Parse uncompressed VP9 header info
  // Reference: VP9 Bitstream & Decoding Process Specification
  // https://storage.googleapis.com/downloads.webmproject.org/docs/vp9/vp9-bitstream-specification-v0.6-20160331-draft.pdf
  static parseVp9Header(data: Uint8Array): Vp9HeaderInfo {
    const result: Vp9HeaderInfo = { ...vp9HeaderInfo };

    if (data.length < 10) {
      return result;
    }

    const reader = new ExpGolomb(data);

    // Frame marker (2 bits)
    const frameMarker = reader.readBits(2);
    if (frameMarker !== 0x2) {
      return result;
    }

    // Profile (2 bits)
    result.profile = reader.readBits(2);
    if (result.profile === 3) {
      reader.readBits(1); // reserved_zero
    }

    // Show existing frame flag (1 bit)
    if (reader.readBool()) {
      return result;
    }

    // Frame type (1 bit)
    if (reader.readBool()) { 
      // inter frame
      return result;
    }

    // Show frame, error resilient
    const _showFrame = reader.readBool();
    const _errorResilientMode = reader.readBool();
    const _syncCode = reader.readBits(24);

    // Color space
    let _bitDepth = 8;
    if (result.profile >= 2) {
      _bitDepth = reader.readBool() ? 12 : 10;
    }
    const _colorSpace = reader.readBits(3);

    enum ColorSpace {
      CS_UNKNOWN    = 0,
      CS_BT_601     = 1,
      CS_BT_709     = 2,
      CS_SMPTE_170  = 3,
      CS_SMPTE_240  = 4,
      CS_BT_2020    = 5,
      CS_RESERVED   = 6,
      CS_RGB        = 7
    }

    if (_colorSpace !== ColorSpace.CS_RGB) {
      reader.readBool(); // color_range
      if (result.profile === 1 || result.profile === 3) {
        reader.readBool(); // subsampling_x
        reader.readBool(); // subsampling_y
        reader.readBool(); // reserved
      }
    } else {
      if (result.profile === 1 || result.profile === 3) {
        reader.readBool(); // reserved zero
      }
    }

    // Width and height (16 bits each)
    const frameWidth = reader.readBits(16) + 1;
    const frameHeight = reader.readBits(16) + 1;

    // Render size
    const renderAndFrameSizeDifferent = reader.readBool();
    let renderWidth = frameWidth;
    let renderHeight = frameHeight;

    if (renderAndFrameSizeDifferent) {
      renderWidth = reader.readBits(16) + 1;
      renderHeight = reader.readBits(16) + 1;
    }

    result.width = frameWidth;
    result.height = frameHeight;
    result.renderWidth = renderWidth;
    result.renderHeight = renderHeight;
    result.isValid = true;

    reader.destroy(); // Clean up

    return result;
  }
}
