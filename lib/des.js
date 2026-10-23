/**
 * Pure-JavaScript DES (ECB, no padding) for RFB VNC authentication.
 *
 * Node 24 on OpenSSL 3 rejects `crypto.createCipheriv('des-ecb', ...)` with
 * "digital envelope routines::unsupported", so the RFB handshake cannot use the
 * built-in crypto module. This module implements the classic DES tables and key
 * schedule directly; it is slow compared with native code but a VNC handshake
 * only encrypts 16 bytes.
 *
 * Reference: FIPS PUB 46-3. The test vectors in `test/des.test.mjs` pin the
 * implementation against pyDes (the Python implementation the original tool
 * used) and the canonical DES example.
 */

const PC1 = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2,
  59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36, 63, 55, 47, 39,
  31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37,
  29, 21, 13, 5, 28, 20, 12, 4,
];

const PC2 = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4,
  26, 8, 16, 7, 27, 20, 13, 2, 41, 52, 31, 37, 47, 55, 30, 40,
  51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32,
];

const IP = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4,
  62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
  57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
  61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
];

const FP = [
  40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31,
  38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
  36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27,
  34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25,
];

const E = [
  32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11,
  12, 13, 12, 13, 14, 15, 16, 17, 16, 17, 18, 19, 20, 21, 20, 21,
  22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1,
];

const P = [
  16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10,
  2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25,
];

const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];

const SBOX = [
  [
    14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7,
    0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
    4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0,
    15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13,
  ],
  [
    15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10,
    3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5,
    0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15,
    13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9,
  ],
  [
    10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8,
    13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
    13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7,
    1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12,
  ],
  [
    7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15,
    13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
    10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4,
    3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14,
  ],
  [
    2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9,
    14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
    4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14,
    11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3,
  ],
  [
    12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11,
    10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
    9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6,
    4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13,
  ],
  [
    4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1,
    13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
    1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2,
    6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12,
  ],
  [
    13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7,
    1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
    7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8,
    2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11,
  ],
];

function bytesToBigInt(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function bigIntToBytes(value, length) {
  const out = Buffer.alloc(length);
  let rest = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    out[index] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

/** Apply a 1-based MSB-first permutation table to an integer of `inBits` bits. */
function permute(input, table, inBits) {
  let output = 0n;
  for (const position of table) {
    output = (output << 1n) | ((input >> BigInt(inBits - position)) & 1n);
  }
  return output;
}

/** Derive the sixteen 48-bit round subkeys from an eight-byte DES key. */
export function subkeysFor(key) {
  if (key.length !== 8) throw new Error("DES key must be 8 bytes");
  const permuted = permute(bytesToBigInt(key), PC1, 64);
  let c = Number((permuted >> 28n) & 0x0fffffffn);
  let d = Number(permuted & 0x0fffffffn);
  const keys = [];
  for (const shift of SHIFTS) {
    c = ((c << shift) | (c >>> (28 - shift))) & 0x0fffffff;
    d = ((d << shift) | (d >>> (28 - shift))) & 0x0fffffff;
    keys.push(permute((BigInt(c) << 28n) | BigInt(d), PC2, 56));
  }
  return keys;
}

/** Encrypt exactly one eight-byte block with a prepared key schedule. */
export function encryptBlock(block, keys) {
  if (block.length !== 8) throw new Error("DES block must be 8 bytes");
  const initial = permute(bytesToBigInt(block), IP, 64);
  let left = Number((initial >> 32n) & 0xffffffffn) >>> 0;
  let right = Number(initial & 0xffffffffn) >>> 0;
  for (let round = 0; round < 16; round += 1) {
    const expanded = permute(BigInt(right), E, 32);
    const mixed = expanded ^ keys[round];
    let substituted = 0n;
    for (let group = 0; group < 8; group += 1) {
      const six = Number((mixed >> BigInt(42 - 6 * group)) & 0x3fn);
      const row = ((six & 0x20) >> 4) | (six & 0x01);
      const column = (six >> 1) & 0x0f;
      substituted = (substituted << 4n) | BigInt(SBOX[group][row * 16 + column]);
    }
    const f = permute(substituted, P, 32);
    const next = (left ^ Number(f & 0xffffffffn)) >>> 0;
    left = right;
    right = next;
  }
  const preOutput = (BigInt(right) << 32n) | BigInt(left);
  return bigIntToBytes(permute(preOutput, FP, 64), 8);
}

/** Encrypt a buffer whose length is a multiple of eight bytes in ECB mode. */
export function desEcbEncrypt(plain, key) {
  if (plain.length % 8 !== 0) throw new Error("DES ECB input length must be a multiple of 8 bytes");
  const keys = subkeysFor(key);
  const output = Buffer.alloc(plain.length);
  for (let offset = 0; offset < plain.length; offset += 8) {
    encryptBlock(plain.subarray(offset, offset + 8), keys).copy(output, offset);
  }
  return output;
}

/** Reverse the bit order inside one byte, as RFB's VNC authentication requires. */
export function reverseBits(byte) {
  let reversed = 0;
  for (let index = 0; index < 8; index += 1) {
    reversed = (reversed << 1) | ((byte >> index) & 1);
  }
  return reversed;
}

/**
 * Encrypt a VNC authentication challenge the same way pyDes did in the
 * original tool: bit-reverse every password byte, zero-pad/truncate to eight
 * bytes, then encrypt the sixteen-byte challenge in ECB mode.
 *
 * @param {Buffer|Uint8Array} challenge exactly 16 challenge bytes from the server
 * @param {string} password VNC password (ASCII)
 * @returns {Buffer} 16 encrypted response bytes
 */
export function vncAuthResponse(challenge, password) {
  if (challenge.length !== 16) throw new Error("VNC challenge must be 16 bytes");
  const raw = Buffer.from(password, "latin1").subarray(0, 8);
  const key = Buffer.alloc(8);
  for (let index = 0; index < raw.length; index += 1) key[index] = reverseBits(raw[index]);
  return desEcbEncrypt(Buffer.from(challenge), key);
}
