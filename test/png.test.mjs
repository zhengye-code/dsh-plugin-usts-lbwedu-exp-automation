import assert from "node:assert/strict";
import {
  compareFramebuffers,
  cropFramebuffer,
  cropRgb,
  diffRgb,
  downscaleRgb,
  encodePng,
  framebufferToRgb,
} from "../lib/png.js";

const WIDTH = 4;
const HEIGHT = 3;

function pixel(index) {
  // Distinct B,G,R values per pixel so byte-order mistakes are visible.
  return [index + 1, 200 - index, 100 + index, 0];
}

const frame = Buffer.alloc(WIDTH * HEIGHT * 4);
for (let index = 0; index < WIDTH * HEIGHT; index += 1) {
  Buffer.from(pixel(index)).copy(frame, index * 4);
}

const rgb = framebufferToRgb(frame, WIDTH, HEIGHT);
assert.equal(rgb[0], 100, "R comes from byte 2");
assert.equal(rgb[1], 200, "G comes from byte 1");
assert.equal(rgb[2], 1, "B comes from byte 0");

const crop = cropFramebuffer(frame, WIDTH, HEIGHT, { x: 1, y: 1, width: 2, height: 2 });
assert.deepEqual({ x: crop.x, y: crop.y, width: crop.width, height: crop.height }, { x: 1, y: 1, width: 2, height: 2 });
assert.equal(crop.bgra.length, 2 * 2 * 4);
assert.deepEqual([...crop.bgra.subarray(0, 4)], pixel(5));

const clamped = cropFramebuffer(frame, WIDTH, HEIGHT, { x: -5, y: 2, width: 100, height: 100 });
assert.deepEqual({ x: clamped.x, y: clamped.y, width: clamped.width, height: clamped.height }, { x: 0, y: 2, width: WIDTH, height: 1 });

const croppedRgb = cropRgb(rgb, WIDTH, { x: 1, y: 1, width: 2, height: 2 });
assert.equal(croppedRgb.length, 2 * 2 * 3);
assert.equal(croppedRgb[0], rgb[(1 * WIDTH + 1) * 3]);

const scaled = downscaleRgb(rgb, WIDTH, HEIGHT, 2);
assert.equal(scaled.scaled, true);
assert.equal(scaled.width, 2);
assert.equal(scaled.height, 2);
assert.equal(downscaleRgb(rgb, WIDTH, HEIGHT, 100).scaled, false);

const changed = Buffer.from(frame);
changed[0] ^= 0xff;
let offset = (2 * WIDTH + 3) * 4;
changed[offset] ^= 0xff;
const diff = compareFramebuffers(frame, changed, WIDTH, HEIGHT);
assert.equal(diff.changedPixels, 2);
assert.deepEqual(diff.box, { x: 0, y: 0, width: 4, height: 3 });
assert.equal(compareFramebuffers(frame, Buffer.from(frame), WIDTH, HEIGHT).changedPixels, 0);
assert.equal(compareFramebuffers(null, frame, WIDTH, HEIGHT).firstFrame, true);

const highlighted = diffRgb(changed, frame, WIDTH, HEIGHT);
assert.deepEqual([...highlighted.subarray(0, 3)], [255, 40, 40], "changed pixel is red");
const unchangedOffset = (1 * WIDTH + 1) * 3;
assert.equal(highlighted[unchangedOffset], highlighted[unchangedOffset + 1]);

const png = encodePng(rgb, WIDTH, HEIGHT);
assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR");
assert.deepEqual([...png.subarray(16, 24)], [0, 0, 0, WIDTH, 0, 0, 0, HEIGHT]);
assert.equal(png.subarray(png.length - 12).toString("hex"), "0000000049454e44ae426082");

assert.throws(() => encodePng(Buffer.alloc(2), 2, 2), /does not match/);

console.log("png: framebuffer conversion, crop, scale, diff and PNG structure OK");
