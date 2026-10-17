/** Deterministic PRNG for the lab: the content of operation i depends only on (seed, i). */
export function mulberry32(a) {
  let t = a >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export const rngFor = (seed, i) => mulberry32((Math.imul(seed >>> 0, 2654435761) ^ Math.imul(i + 1, 40503)) >>> 0);

/**
 * A client intent key from two 32-bit draws (64 bits). One draw scaled to 2^48 left the low 16 bits zero: 2^32
 * distinct keys, so a 4-hour soak reused a key for one payer (soak 9003, a lab artefact that also surfaced J15-L6).
 */
export const labKey = (rng) => `lab-${(rng() * 2 ** 32 >>> 0).toString(16).padStart(8, '0')}${(rng() * 2 ** 32 >>> 0).toString(16).padStart(8, '0')}`;
