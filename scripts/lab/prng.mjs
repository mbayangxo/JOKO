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
