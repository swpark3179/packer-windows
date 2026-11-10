// 조금씩 먹이는 SHA-256 — 의존성 없음.
//
// '풀어서 저장' 이 풀어낸 파일마다 해시를 다시 계산해 컨테이너 트레일러의 값과 맞춰 본다
// (`src-tauri/src/archive.rs` 의 `read_payload` 와 같은 검사). WebCrypto 의 `digest` 는 한 번에
// 전부를 받아야 해서 쓸 수 없다 — 그러려면 파일을 통째로 메모리에 모아야 하는데, 풀기는 파일을
// 조각조각 흘려 쓰는 것이 요점이다.

const K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

export class Sha256 {
  constructor() {
    this.h = Uint32Array.from(INITIAL);
    this.w = new Uint32Array(64);
    this.block = new Uint8Array(64);
    this.fill = 0;
    this.length = 0;
  }

  /** @param {Uint8Array} bytes */
  update(bytes) {
    let at = 0;
    this.length += bytes.length;
    // 앞 조각이 남긴 반쪽 블록을 먼저 채운다.
    if (this.fill > 0) {
      const take = Math.min(64 - this.fill, bytes.length);
      this.block.set(bytes.subarray(0, take), this.fill);
      this.fill += take;
      at = take;
      if (this.fill < 64) return this;
      this.compress(this.block, 0);
      this.fill = 0;
    }
    for (; at + 64 <= bytes.length; at += 64) this.compress(bytes, at);
    if (at < bytes.length) {
      this.block.set(bytes.subarray(at), 0);
      this.fill = bytes.length - at;
    }
    return this;
  }

  /** @returns {Uint8Array} 32바이트 */
  digest() {
    const bits = this.length * 8;
    const tail = new Uint8Array(this.fill < 56 ? 64 : 128);
    tail.set(this.block.subarray(0, this.fill));
    tail[this.fill] = 0x80;
    const view = new DataView(tail.buffer);
    view.setUint32(tail.length - 8, Math.floor(bits / 0x100000000), false);
    view.setUint32(tail.length - 4, bits >>> 0, false);
    for (let at = 0; at < tail.length; at += 64) this.compress(tail, at);

    const out = new Uint8Array(32);
    const result = new DataView(out.buffer);
    for (let i = 0; i < 8; i += 1) result.setUint32(i * 4, this.h[i], false);
    return out;
  }

  compress(bytes, at) {
    const { w, h } = this;
    for (let i = 0; i < 16; i += 1) {
      const o = at + i * 4;
      w[i] = (bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3];
    }
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15];
      const b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }

    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let k = h[7];
    for (let i = 0; i < 64; i += 1) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (k + s1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += k;
  }
}

/** 한 번에 계산한다. 테스트와 짧은 입력용. */
export function sha256(bytes) {
  return new Sha256().update(bytes).digest();
}
