import assert from "node:assert/strict";
import { desEcbEncrypt, vncAuthResponse } from "../lib/des.js";

/**
 * Vectors produced with pyDes (the implementation the original Python tool
 * used), plus the canonical FIPS example. They pin key schedule, S-boxes,
 * permutation and the RFB bit-reversal step.
 */
const ECB_VECTORS = [
  ["dbf2b9e5deab0444", "9a6beaba3e2949dc9bdae395b3240adf", "18bc81af824480bc2c33038f7bd2b773"],
  ["5fa91726146ad486", "03302f349bd56b1db1c2772cf7bfbc9c", "bfd54c0653724d19e76aeb8f551fad57"],
  ["8fe15e4bc7bca462", "0bc105691b2b8fe63b21bf3e31f4c887", "43bd3d84ad711a62d1baa9b4aac5c0cb"],
  ["bf41d45f70b18f91", "93e48b30e7a84026b9027897701a6c5d", "8660100e7622a0f18e6e7a16e4c90244"],
  ["411b2641234f01a7", "f11e77d0ac73f36117a079085f862c42", "3defe1f24b41576f6edca09d072cca9b"],
  ["c1e15002733996ac", "ce5c7c02d5b2c489fd7aa64fb15b6551", "d279a1c61480f468421c20aa731e5156"],
  ["133457799bbcdff1", "0123456789abcdef", "85e813540f0ab405"],
];

for (const [key, plain, cipher] of ECB_VECTORS) {
  const actual = desEcbEncrypt(Buffer.from(plain, "hex"), Buffer.from(key, "hex"));
  assert.equal(actual.toString("hex"), cipher, `DES ${key}/${plain}`);
}

const VNC_VECTORS = [
  ["testpass", "bf0618a6601105e5cc061ccbe1af6183", "1646791c7f4aa35fad8de3682bab5071"],
  ["abc", "e9f5ed1a918edf73639ab8047b72f728", "162aab5df7cf2990f063f9a27959d09e"],
  ["12345678", "94e999d401a9f7b0541823f1bb5e7505", "6700be0b226f951eeddc91f28f976c9b"],
];

for (const [password, challenge, response] of VNC_VECTORS) {
  const actual = vncAuthResponse(Buffer.from(challenge, "hex"), password);
  assert.equal(actual.toString("hex"), response, `VNC auth ${password}`);
}

assert.throws(() => desEcbEncrypt(Buffer.alloc(7), Buffer.alloc(8)), /multiple of 8/);
assert.throws(() => vncAuthResponse(Buffer.alloc(15), "testpass"), /16 bytes/);

console.log(`des: ${ECB_VECTORS.length} ECB vectors, ${VNC_VECTORS.length} VNC vectors OK`);
