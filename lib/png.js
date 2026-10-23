/**
 * Minimal PNG encoder and framebuffer helpers (no image dependency).
 *
 * RFB `Raw` rects arrive as 32-bit little-endian pixels in B,G,R,X byte order.
 * Everything here works directly on that layout so a screenshot costs one copy
 * and one zlib deflate.
 */
import zlib from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const name = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}

/**
 * Encode 8-bit RGB pixels as a PNG.
 * @param {Buffer|Uint8Array} rgb row-major RGB triples
 * @param {number} width
 * @param {number} height
 * @returns {Buffer} PNG bytes
 */
export function encodePng(rgb, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`invalid PNG dimensions ${width}x${height}`);
  }
  if (rgb.length !== width * height * 3) {
    throw new Error(`RGB length ${rgb.length} does not match ${width}x${height}`);
  }
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const target = row * (stride + 1);
    raw[target] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + row * stride, stride).copy(raw, target + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function clampRegion(x, y, width, height, frameWidth, frameHeight) {
  const left = Math.max(0, Math.min(frameWidth - 1, Math.trunc(x)));
  const top = Math.max(0, Math.min(frameHeight - 1, Math.trunc(y)));
  const right = Math.max(left + 1, Math.min(frameWidth, Math.trunc(x) + Math.trunc(width)));
  const bottom = Math.max(top + 1, Math.min(frameHeight, Math.trunc(y) + Math.trunc(height)));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Copy one BGRA framebuffer region out of a full frame.
 * @returns {{bgra: Buffer, width: number, height: number, x: number, y: number}}
 */
export function cropFramebuffer(framebuffer, frameWidth, frameHeight, crop) {
  if (crop === undefined) {
    return { bgra: Buffer.from(framebuffer), width: frameWidth, height: frameHeight, x: 0, y: 0 };
  }
  const region = clampRegion(crop.x, crop.y, crop.width, crop.height, frameWidth, frameHeight);
  const rowBytes = region.width * 4;
  const out = Buffer.alloc(rowBytes * region.height);
  for (let row = 0; row < region.height; row += 1) {
    const source = ((region.y + row) * frameWidth + region.x) * 4;
    framebuffer.copy(out, row * rowBytes, source, source + rowBytes);
  }
  return { ...region, bgra: out };
}

/** Convert a BGRA frame (or crop) to row-major RGB triples for PNG encoding. */
export function framebufferToRgb(bgra, width, height) {
  const pixels = width * height;
  const rgb = Buffer.alloc(pixels * 3);
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const source = pixel * 4;
    const target = pixel * 3;
    rgb[target] = bgra[source + 2];
    rgb[target + 1] = bgra[source + 1];
    rgb[target + 2] = bgra[source];
  }
  return rgb;
}

/** Copy one rectangular region out of an RGB image. */
export function cropRgb(rgb, frameWidth, region) {
  const rowBytes = region.width * 3;
  const out = Buffer.alloc(rowBytes * region.height);
  for (let row = 0; row < region.height; row += 1) {
    const source = ((region.y + row) * frameWidth + region.x) * 3;
    rgb.copy(out, row * rowBytes, source, source + rowBytes);
  }
  return out;
}

/** Nearest-neighbour downscale that preserves aspect ratio; `maxSide` <= 0 disables it. */export function downscaleRgb(rgb, width, height, maxSide) {
  if (!Number.isFinite(maxSide) || maxSide <= 0 || (width <= maxSide && height <= maxSide)) {
    return { rgb, width, height, scaled: false };
  }
  const factor = maxSide / Math.max(width, height);
  const targetWidth = Math.max(1, Math.round(width * factor));
  const targetHeight = Math.max(1, Math.round(height * factor));
  const out = Buffer.alloc(targetWidth * targetHeight * 3);
  for (let row = 0; row < targetHeight; row += 1) {
    const sourceRow = Math.min(height - 1, Math.floor((row * height) / targetHeight));
    for (let column = 0; column < targetWidth; column += 1) {
      const sourceColumn = Math.min(width - 1, Math.floor((column * width) / targetWidth));
      const source = (sourceRow * width + sourceColumn) * 3;
      const target = (row * targetWidth + column) * 3;
      out[target] = rgb[source];
      out[target + 1] = rgb[source + 1];
      out[target + 2] = rgb[source + 2];
    }
  }
  return { rgb: out, width: targetWidth, height: targetHeight, scaled: true };
}

/**
 * Compare two full BGRA frames (same dimensions).
 * @returns {{changedPixels: number, totalPixels: number, ratio: number, box: null|{x:number,y:number,width:number,height:number}}}
 */
export function compareFramebuffers(previous, current, width, height) {
  if (previous === null || previous === undefined) {
    return { changedPixels: 0, totalPixels: width * height, ratio: 0, box: null, firstFrame: true };
  }
  if (previous.length !== current.length) {
    return { changedPixels: width * height, totalPixels: width * height, ratio: 1, box: { x: 0, y: 0, width, height }, firstFrame: true };
  }
  let changed = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  const pixels = width * height;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const offset = pixel * 4;
    if (
      previous[offset] !== current[offset] ||
      previous[offset + 1] !== current[offset + 1] ||
      previous[offset + 2] !== current[offset + 2]
    ) {
      changed += 1;
      const x = pixel % width;
      const y = (pixel - x) / width;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return {
    changedPixels: changed,
    totalPixels: pixels,
    ratio: pixels === 0 ? 0 : changed / pixels,
    box: changed === 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    firstFrame: false,
  };
}

/**
 * Render a visual diff: the current frame desaturated, changed pixels in red.
 * @returns {Buffer} RGB triples of the same frame size
 */
export function diffRgb(current, previous, width, height) {
  const pixels = width * height;
  const rgb = Buffer.alloc(pixels * 3);
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const source = pixel * 4;
    const target = pixel * 3;
    const blue = current[source];
    const green = current[source + 1];
    const red = current[source + 2];
    const changed = previous === null || previous === undefined || previous.length !== current.length ||
      previous[source] !== blue || previous[source + 1] !== green || previous[source + 2] !== red;
    if (changed) {
      rgb[target] = 255;
      rgb[target + 1] = 40;
      rgb[target + 2] = 40;
    } else {
      const gray = Math.round((red * 0.299 + green * 0.587 + blue * 0.114) * 0.55);
      rgb[target] = gray;
      rgb[target + 1] = gray;
      rgb[target + 2] = gray;
    }
  }
  return rgb;
}
