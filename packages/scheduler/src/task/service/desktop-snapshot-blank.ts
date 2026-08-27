import { inflateSync } from "node:zlib";

/** Sample decoded PNG pixels; blank frames are bright with low variance. */
export function isLikelyBlankScreenshot(buffer: Buffer): boolean {
  if (buffer.length < 128) {
    return true;
  }
  if (
    buffer[0] !== 0x89 ||
    buffer[1] !== 0x50 ||
    buffer[2] !== 0x4e ||
    buffer[3] !== 0x47
  ) {
    return false;
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Buffer[] = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  if (width === 0 || height === 0 || idatChunks.length === 0) {
    return true;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    return false;
  }

  const bytesPerPixel = colorType === 6 ? 4 : 3;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idatChunks));
  } catch {
    return false;
  }

  const stride = width * bytesPerPixel;
  let previous = Buffer.alloc(stride);
  let pos = 0;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  const pixelStep = Math.max(1, Math.floor((width * height) / 2048));

  for (let y = 0; y < height && pos < raw.length; y++) {
    const filterType = raw[pos++] ?? 0;
    const row = raw.subarray(pos, pos + stride);
    pos += stride;
    if (row.length < stride) {
      break;
    }
    const decoded = unfilterScanline(filterType, row, previous, bytesPerPixel);
    previous = decoded;

    for (let x = 0; x < width; x += pixelStep) {
      const i = x * bytesPerPixel;
      const r = decoded[i] ?? 0;
      const g = decoded[i + 1] ?? 0;
      const b = decoded[i + 2] ?? 0;
      const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
      sum += luminance;
      sumSq += luminance * luminance;
      count++;
    }
  }

  if (count === 0) {
    return true;
  }

  const mean = sum / count;
  const variance = sumSq / count - mean * mean;
  // Near-white frames with almost no structure (mux "404 page not found",
  // about:blank, empty Chromium chrome) must never be dumped as Desktop.
  if (mean > 245 && variance < 40) {
    return true;
  }
  return mean > 235 && variance < 120;
}

function unfilterScanline(
  filterType: number,
  current: Buffer,
  previous: Buffer,
  bpp: number,
): Buffer {
  const result = Buffer.from(current);
  switch (filterType) {
    case 0:
      return result;
    case 1:
      for (let i = bpp; i < result.length; i++) {
        result[i] = (result[i]! + result[i - bpp]!) & 0xff;
      }
      return result;
    case 2:
      for (let i = 0; i < result.length; i++) {
        result[i] = (result[i]! + previous[i]!) & 0xff;
      }
      return result;
    case 3:
      for (let i = 0; i < result.length; i++) {
        const left = i >= bpp ? result[i - bpp]! : 0;
        const up = previous[i]!;
        result[i] = (result[i]! + Math.floor((left + up) / 2)) & 0xff;
      }
      return result;
    case 4:
      for (let i = 0; i < result.length; i++) {
        const left = i >= bpp ? result[i - bpp]! : 0;
        const up = previous[i]!;
        const upLeft = i >= bpp ? previous[i - bpp]! : 0;
        result[i] = (result[i]! + paethPredictor(left, up, upLeft)) & 0xff;
      }
      return result;
    default:
      return result;
  }
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  if (pb <= pc) {
    return b;
  }
  return c;
}
