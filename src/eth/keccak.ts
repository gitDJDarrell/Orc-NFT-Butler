/**
 * Keccak-256 — the hash Ethereum/ENS uses.
 *
 * Why this exists instead of `node:crypto`: Node's `createHash("sha3-256")`
 * is NIST SHA3-256, which is NOT the same function. The permutation is
 * identical but the domain-separation padding differs (SHA3 appends 0x06,
 * original Keccak appends 0x01), so the two produce completely different
 * digests. Ethereum standardized on the original Keccak padding, so ENS
 * namehashes computed with SHA3-256 would silently resolve to the wrong
 * address — hence a real implementation rather than a crypto alias.
 *
 * Implemented over BigInt lanes for clarity over speed: this is used a
 * handful of times per ENS resolution (which is itself cached for the
 * process lifetime), never in a hot path. Verified against published test
 * vectors in keccak.test.ts, including the ENS `namehash("eth")` constant.
 *
 * This is a HASH function only — it does no signing, holds no key material,
 * and is not capable of producing a transaction signature.
 */

const MASK64 = (1n << 64n) - 1n;

const ROUND_CONSTANTS: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

/** Rotation offsets, indexed [x][y] — the standard Keccak rho table. */
const ROTATION: number[][] = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

function rotl64(value: bigint, shift: number): bigint {
  if (shift === 0) return value & MASK64;
  const s = BigInt(shift);
  return ((value << s) | ((value & MASK64) >> (64n - s))) & MASK64;
}

/** In-place Keccak-f[1600] permutation over 25 64-bit lanes, A[x + 5y]. */
function keccakF1600(state: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    // theta
    const C = new Array<bigint>(5);
    for (let x = 0; x < 5; x++) {
      C[x] = state[x]! ^ state[x + 5]! ^ state[x + 10]! ^ state[x + 15]! ^ state[x + 20]!;
    }
    for (let x = 0; x < 5; x++) {
      const D = C[(x + 4) % 5]! ^ rotl64(C[(x + 1) % 5]!, 1);
      for (let y = 0; y < 5; y++) state[x + 5 * y] = state[x + 5 * y]! ^ D;
    }

    // rho + pi
    const B = new Array<bigint>(25).fill(0n);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(state[x + 5 * y]!, ROTATION[x]![y]!);
      }
    }

    // chi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        state[x + 5 * y] = B[x + 5 * y]! ^ (~B[((x + 1) % 5) + 5 * y]! & B[((x + 2) % 5) + 5 * y]!) & MASK64;
      }
    }

    // iota
    state[0] = state[0]! ^ ROUND_CONSTANTS[round]!;
  }
}

/** Keccak-256 digest of arbitrary bytes. Rate = 136 bytes, original-Keccak 0x01 padding. */
export function keccak256(input: Uint8Array): Uint8Array {
  const RATE = 136;
  const padded = new Uint8Array(Math.ceil((input.length + 1) / RATE) * RATE);
  padded.set(input);
  padded[input.length] = 0x01; // original Keccak domain padding (SHA3 would use 0x06)
  padded[padded.length - 1] = (padded[padded.length - 1]! | 0x80) & 0xff;

  const state = new Array<bigint>(25).fill(0n);

  for (let offset = 0; offset < padded.length; offset += RATE) {
    // Absorb one rate-sized block, little-endian lanes.
    for (let lane = 0; lane < RATE / 8; lane++) {
      let value = 0n;
      for (let byte = 7; byte >= 0; byte--) {
        value = (value << 8n) | BigInt(padded[offset + lane * 8 + byte]!);
      }
      state[lane] = state[lane]! ^ value;
    }
    keccakF1600(state);
  }

  // Squeeze 32 bytes — well under the 136-byte rate, so one squeeze suffices.
  const out = new Uint8Array(32);
  for (let lane = 0; lane < 4; lane++) {
    let value = state[lane]!;
    for (let byte = 0; byte < 8; byte++) {
      out[lane * 8 + byte] = Number(value & 0xffn);
      value >>= 8n;
    }
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function keccak256Hex(input: Uint8Array | string): string {
  return toHex(keccak256(typeof input === "string" ? new TextEncoder().encode(input) : input));
}
