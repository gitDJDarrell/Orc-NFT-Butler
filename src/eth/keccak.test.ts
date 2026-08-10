import assert from "node:assert/strict";
import test from "node:test";
import { keccak256Hex } from "./keccak.js";
import { namehashHex } from "./ens.js";

// Published Keccak-256 vectors. These are what distinguish a correct
// implementation from NIST SHA3-256, which shares the permutation but uses
// different padding and therefore produces entirely different digests.
test("keccak256: empty input matches the published vector", () => {
  assert.equal(keccak256Hex(""), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
});

test("keccak256: 'abc' matches the published vector", () => {
  assert.equal(keccak256Hex("abc"), "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
});

test("keccak256: is NOT NIST SHA3-256 (guards against a crypto-alias regression)", () => {
  // node:crypto's sha3-256 of "" — if keccak256 ever returned this, every
  // ENS namehash would silently resolve to the wrong address.
  assert.notEqual(keccak256Hex(""), "0xa7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a");
});

test("keccak256: input spanning more than one 136-byte rate block", () => {
  // 200 bytes of 'a' — forces two absorb blocks, exercising the padding path
  // on a non-final block.
  const digest = keccak256Hex("a".repeat(200));
  assert.match(digest, /^0x[0-9a-f]{64}$/);
  assert.notEqual(digest, keccak256Hex("a".repeat(199)));
});

test("namehash: empty name is the zero node (EIP-137)", () => {
  assert.equal(namehashHex(""), `0x${"0".repeat(64)}`);
});

test("namehash: 'eth' matches the well-known ENS constant", () => {
  assert.equal(namehashHex("eth"), "0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae");
});

test("namehash: 'vitalik.eth' matches the published EIP-137 example", () => {
  assert.equal(namehashHex("vitalik.eth"), "0xee6c4522aab0003e8d14cd40a6af439055fd2577951148c14b6cea9a53475835");
});

test("namehash: is case-insensitive", () => {
  assert.equal(namehashHex("NewOrc.ETH"), namehashHex("neworc.eth"));
});
