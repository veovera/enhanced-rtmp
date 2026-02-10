import { open } from 'node:fs/promises';

export interface FlvHeader {
  signature: string;   // 'FLV'
  version: number;
  hasAudio: boolean;
  hasVideo: boolean;
  dataOffset: number;
}

export interface FlvTag {
  tagType: number;     // 8 = audio, 9 = video, 18 = script data
  dataSize: number;
  timestamp: number;
  streamId: number;
  data: Uint8Array;
}

export interface FlvFile {
  header: FlvHeader;
  tags: FlvTag[];
}

export interface ParseFlvFileOptions {
  includeData?: boolean;
}

function parseFlvHeader(buf: Uint8Array): FlvHeader {
  if (buf.length < 9) {
    throw new Error('Buffer too small for FLV header (need 9 bytes)');
  }

  const signature = String.fromCharCode(buf[0], buf[1], buf[2]);
  if (signature !== 'FLV') {
    throw new Error(`Invalid FLV signature: '${signature}'`);
  }

  const version = buf[3];
  const flags = buf[4];
  const hasAudio = (flags & 0x04) !== 0;
  const hasVideo = (flags & 0x01) !== 0;
  const dataOffset = (buf[5] << 24) | (buf[6] << 16) | (buf[7] << 8) | buf[8];

  return { signature, version, hasAudio, hasVideo, dataOffset };
}

function readUint24BE(buf: Uint8Array, offset: number): number {
  return (buf[offset] << 16) | (buf[offset + 1] << 8) | buf[offset + 2];
}

/**
 * Parse FLV from an in-memory buffer.
 */
export function parseFlv(buffer: Uint8Array): FlvFile {
  const header = parseFlvHeader(buffer);

  const tags: FlvTag[] = [];
  let offset = header.dataOffset;

  // Skip PreviousTagSize0
  offset += 4;

  while (offset + 11 <= buffer.length) {
    const tagType = buffer[offset];
    const dataSize = readUint24BE(buffer, offset + 1);
    const timestampLow = readUint24BE(buffer, offset + 4);
    const timestampExt = buffer[offset + 7];
    const timestamp = (timestampExt << 24) | timestampLow;
    const streamId = readUint24BE(buffer, offset + 8);

    offset += 11;

    if (offset + dataSize > buffer.length) {
      break; // Truncated tag
    }

    const data = buffer.slice(offset, offset + dataSize);
    tags.push({ tagType, dataSize, timestamp, streamId, data });

    offset += dataSize;

    // Skip PreviousTagSize
    offset += 4;
  }

  return { header, tags };
}

/**
 * Parse FLV from a file using sequential reads (constant memory for headers-only mode).
 */
export async function parseFlvFile(path: string, options?: ParseFlvFileOptions): Promise<FlvFile> {
  const includeData = options?.includeData ?? false;
  let fh;

  try {
    fh = await open(path, 'r');
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`File not found: '${path}'`);
    }
    throw new Error(`Could not open file '${path}'`);
  }

  try {
    // Read FLV header (9 bytes)
    const headerBuf = new Uint8Array(9);
    const { bytesRead: headerBytes } = await fh.read(headerBuf, 0, 9, null);
    if (headerBytes < 9) {
      throw new Error('File too small for FLV header');
    }
    const header = parseFlvHeader(headerBuf);

    // Skip to end of header (in case dataOffset > 9) + PreviousTagSize0 (4 bytes)
    const skipBytes = header.dataOffset - 9 + 4;
    if (skipBytes > 0) {
      const skipBuf = new Uint8Array(skipBytes);
      await fh.read(skipBuf, 0, skipBytes, null);
    }

    // Read tags
    const tags: FlvTag[] = [];
    const tagHeaderBuf = new Uint8Array(11);
    const prevTagSizeBuf = new Uint8Array(4);

    while (true) {
      const { bytesRead } = await fh.read(tagHeaderBuf, 0, 11, null);
      if (bytesRead === 0) break; // EOF
      if (bytesRead < 11) break;  // Truncated

      const tagType = tagHeaderBuf[0];
      const dataSize = readUint24BE(tagHeaderBuf, 1);
      const timestampLow = readUint24BE(tagHeaderBuf, 4);
      const timestampExt = tagHeaderBuf[7];
      const timestamp = (timestampExt << 24) | timestampLow;
      const streamId = readUint24BE(tagHeaderBuf, 8);

      let data: Uint8Array;
      if (includeData) {
        data = new Uint8Array(dataSize);
        await fh.read(data, 0, dataSize, null);
      } else {
        // Skip over tag body
        data = new Uint8Array(0);
        if (dataSize > 0) {
          const skipData = new Uint8Array(Math.min(dataSize, 65536));
          let remaining = dataSize;
          while (remaining > 0) {
            const chunk = Math.min(remaining, skipData.length);
            await fh.read(skipData, 0, chunk, null);
            remaining -= chunk;
          }
        }
      }

      tags.push({ tagType, dataSize, timestamp, streamId, data });

      // Read PreviousTagSize
      await fh.read(prevTagSizeBuf, 0, 4, null);
    }

    return { header, tags };
  } finally {
    await fh.close();
  }
}

export function mergeFlvFiles(
  _a: FlvFile,
  _b: FlvFile,
  _options?: { multitrack?: boolean }
): Uint8Array {
  // TODO: Implement FLV merge logic
  //   - If multitrack: interleave tracks using E-FLV multitrack extensions
  //   - Otherwise: concatenate tags, re-timestamp file B after file A
  //   - Write new FLV header + merged tags + PreviousTagSize entries

  return new Uint8Array(0);
}
