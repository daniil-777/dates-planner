/**
 * CRC-32 that is bit-for-bit Python's `zlib.crc32`.
 *
 * The hashing trick in CONTRACTS §2.3 ships no vocabulary: the bucket of an
 * n-gram is `crc32(utf8(ngram)) % nBuckets`, computed independently by the
 * Python trainer and by this runtime. If the two checksums ever disagree on a
 * single n-gram, that gram lands in a different column and the model quietly
 * scores a different thing — no crash, just a wrong answer. So this is the
 * standard IEEE 802.3 polynomial in its reflected form, with the exact
 * conventions `zlib.crc32` uses:
 *
 * - reflected polynomial `0xEDB88320` (i.e. `0x04C11DB7` bit-reversed),
 * - initial register `0xFFFFFFFF`,
 * - final complement (xor with `0xFFFFFFFF`),
 * - result returned **unsigned**, matching Python 3, which never returns the
 *   negative values Python 2 used to.
 *
 * Input is bytes, never a string: the checksum is defined over the UTF-8
 * encoding, and a `charCodeAt` loop would silently hash UTF-16 code units.
 * Merchant strings reach `normaliseMerchant` with umlauts and accents still in
 * them, so that difference is reachable in practice, not theoretical.
 */

/** Reflected form of the IEEE 802.3 polynomial `0x04C11DB7`. */
const REVERSED_POLYNOMIAL = 0xedb88320

/**
 * The 256-entry lookup table, built once when the module is first required.
 *
 * Byte-at-a-time table lookup rather than the bit-by-bit loop: the classifier
 * hashes a few hundred n-grams per transaction, and the table costs one
 * kilobyte and a few microseconds at startup.
 */
const TABLE: Uint32Array = buildTable()

function buildTable(): Uint32Array {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let register = index
    for (let bit = 0; bit < 8; bit += 1) {
      // `>>> 1` (not `>> 1`) keeps the register unsigned; the xor below would
      // otherwise sign-extend once bit 31 is set.
      register = (register & 1) === 1 ? REVERSED_POLYNOMIAL ^ (register >>> 1) : register >>> 1
    }
    table[index] = register >>> 0
  }
  return table
}

/**
 * CRC-32 of a byte sequence, as an unsigned 32-bit integer (`0`…`4294967295`).
 *
 * Accepts a `Uint8Array`, which a Node `Buffer` already is.
 */
export function crc32(bytes: Uint8Array): number {
  let register = 0xffffffff
  for (let index = 0; index < bytes.length; index += 1) {
    // `& 0xff` both masks the incoming byte into the table's domain and drops
    // the high 24 bits of the register, which is what makes this the
    // byte-at-a-time form of the bit loop in `buildTable`.
    register = TABLE[(register ^ bytes[index]) & 0xff] ^ (register >>> 8)
  }
  return (register ^ 0xffffffff) >>> 0
}

/**
 * CRC-32 of a string's UTF-8 encoding — the form the feature pipeline uses.
 *
 * `Buffer.from(text, 'utf8')` is the encoder because it is what makes this
 * agree with Python's `ngram.encode('utf-8')`; surrogate pairs become the same
 * four bytes on both sides.
 */
export function crc32Utf8(text: string): number {
  return crc32(Buffer.from(text, 'utf8'))
}
