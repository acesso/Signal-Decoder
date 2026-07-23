// FT8's CRC-14 check — mirrors ft8_crc() (lib/ft8mon/libldpc.c:299-332) and
// check_crc() (lib/ft8mon/ft8.cc:186-217) exactly. Needed to validate an
// LDPC "success" (syndrome=83) isn't a false-positive parity match — WSJT-X/
// ft8mon both require ldpc_ok===83 AND a valid CRC before accepting a decode.

const DIV = [1, 1, 0, 0, 1, 1, 1, 0, 1, 0, 1, 0, 1, 1, 1]; // 14-bit CRC poly 0x2757, leading 1 bit

/** ft8_crc(): polynomial division of `msg1[0..msglen)` (0/1 ints) by DIV,
 *  padded with 14 trailing zeros, returning the 14-bit remainder. */
export function ft8Crc(msg1: number[] | Uint8Array, msglen: number): number[] {
  const msg = new Array(msglen + 14).fill(0);
  for (let i = 0; i < msglen; i++) msg[i] = msg1[i];

  for (let i = 0; i < msglen; i++) {
    if (msg[i]) {
      for (let j = 0; j < 15; j++) {
        msg[i + j] = (msg[i + j] + DIV[j]) % 2;
      }
    }
  }

  return msg.slice(msglen, msglen + 14);
}

/** check_crc(): validates a91's trailing 14 bits are the CRC-14 of its
 *  first 77 bits (91 = 77 payload + 14 CRC; ft8.cc:186-217 zeroes bits
 *  77..90 before computing the CRC over "82" bits — see the comment there,
 *  "why 82? why not 77?" — 82 is the smallest CRC-cycle-aligned length
 *  ft8mon actually uses, preserved here verbatim rather than re-derived). */
export function checkCrc(a91: number[] | Uint8Array): boolean {
  const aa = new Array(91).fill(0);
  let nonZero = 0;
  for (let i = 0; i < 91; i++) {
    aa[i] = i < 77 ? a91[i] : 0;
    if (aa[i]) nonZero++;
  }
  if (nonZero === 0) return false;

  const out1 = ft8Crc(aa, 82);
  for (let i = 0; i < 14; i++) {
    if (out1[i] !== a91[91 - 14 + i]) return false;
  }
  return true;
}
