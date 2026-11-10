// Argon2id (RFC 9106, 버전 0x13) — 의존성 없는 순수 자바스크립트.
//
// '풀어서 저장' 이 암호에서 키를 다시 만들 때 쓴다. 데스크톱은 Rust `argon2` 크레이트로 같은
// 일을 한다 (`src-tauri/src/crypto.rs` 의 `derive_keys`). **두 구현은 비트 단위로 같아야 한다** —
// 한 비트라도 어긋나면 맞는 암호를 넣어도 "암호화 키가 올바르지 않습니다" 로만 나타난다. 그래서
// Rust 가 만든 골든 벡터(`tests/fixtures/unpack-container.json` 의 `kdf`)와 RFC 9106 의 시험
// 벡터가 함께 붙잡는다 (`tests/argon2.test.js`).
//
// `collector.js` 와 같은 규율: **의존성이 없다.** DOM 도, Capacitor 도 모른다.
//
// 왜 직접 짰나: WebCrypto 에는 Argon2 가 없고, 이 앱은 번들러가 없어서 npm 패키지를 그대로
// 불러올 수 없다. 대신 이 파일은 한 가지 쓰임(Argon2id, 비밀값·연관 데이터 선택)에만 맞춰
// 두었고, 화면이 멈추지 않도록 **조각마다 양보하며 진행률을 보고한다** — 데스크톱의 기본값
// (64 MiB · 3회 · 4레인)이면 폰에서 몇 초가 걸린다.
//
// 64비트 정수는 자바스크립트에 없으므로 모든 64비트 값을 `Uint32Array` 의 [하위, 상위] 두 칸으로
// 들고 다닌다. 블록 하나(1 KiB)는 u32 256칸이다.

// ---------------------------------------------------------------- BLAKE2b

/// BLAKE2b 초기 벡터 (SHA-512 와 같다). [하위, 상위] 순서.
const IV = Uint32Array.from([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]);

/// 라운드마다 메시지 단어를 고르는 순서. 12라운드는 0~9 를 돈 뒤 0·1 을 한 번 더 쓴다.
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

/// 64비트 덧셈 `v[a] += v[b] + (xl, xh)`. 32비트 두 칸으로 나눠 올림을 직접 넘긴다.
function add64(v, a, b, xl, xh) {
  const lo = v[a] + v[b] + xl;
  v[a] = lo;
  v[a + 1] = v[a + 1] + v[b + 1] + xh + ((lo / 0x100000000) | 0);
}

/// BLAKE2b 의 G. 인덱스는 u32 칸 기준이다 (u64 i → 2i).
function mixB(v, a, b, c, d, m, x, y) {
  let xl;
  let xh;
  add64(v, a, b, m[x], m[x + 1]);
  // d = (d ^ a) >>> 32 — 두 칸을 맞바꾼다.
  xl = v[d] ^ v[a];
  xh = v[d + 1] ^ v[a + 1];
  v[d] = xh;
  v[d + 1] = xl;
  add64(v, c, d, 0, 0);
  // b = (b ^ c) >>> 24
  xl = v[b] ^ v[c];
  xh = v[b + 1] ^ v[c + 1];
  v[b] = (xl >>> 24) | (xh << 8);
  v[b + 1] = (xh >>> 24) | (xl << 8);
  add64(v, a, b, m[y], m[y + 1]);
  // d = (d ^ a) >>> 16
  xl = v[d] ^ v[a];
  xh = v[d + 1] ^ v[a + 1];
  v[d] = (xl >>> 16) | (xh << 16);
  v[d + 1] = (xh >>> 16) | (xl << 16);
  add64(v, c, d, 0, 0);
  // b = (b ^ c) >>> 63 — 왼쪽으로 1 돌리기와 같다.
  xl = v[b] ^ v[c];
  xh = v[b + 1] ^ v[c + 1];
  v[b] = (xl << 1) | (xh >>> 31);
  v[b + 1] = (xh << 1) | (xl >>> 31);
}

/**
 * BLAKE2b (키 없음, 출력 1~64바이트).
 *
 * Argon2 의 초기 해시 H0 와 가변 길이 해시 H' 에만 쓴다 — 메모리를 채우는 무거운 계산은 아래
 * BlaMka 가 한다. 그래서 여기는 빠르기보다 읽기 쉽게 두었다.
 *
 * @param {Uint8Array} input
 * @param {number} outLen 1~64
 */
export function blake2b(input, outLen = 64) {
  if (!(outLen >= 1 && outLen <= 64)) throw new RangeError("BLAKE2b 출력 길이는 1~64 바이트입니다.");

  const h = Uint32Array.from(IV);
  // 매개변수 블록의 첫 단어: 출력 길이 · 키 길이(0) · fanout 1 · depth 1.
  h[0] ^= 0x01010000 ^ outLen;

  const v = new Uint32Array(32);
  const m = new Uint32Array(32);
  const block = new Uint8Array(128);
  const words = new DataView(block.buffer);

  let counter = 0;
  const compress = (last) => {
    for (let i = 0; i < 32; i += 1) m[i] = words.getUint32(i * 4, true);
    v.set(h);
    v.set(IV, 16);
    // 지금까지 넣은 바이트 수 (2^53 을 넘을 일이 없다).
    v[24] ^= counter >>> 0;
    v[25] ^= Math.floor(counter / 0x100000000);
    if (last) {
      v[28] = ~v[28];
      v[29] = ~v[29];
    }
    for (let round = 0; round < 12; round += 1) {
      const s = SIGMA[round % 10];
      mixB(v, 0, 8, 16, 24, m, s[0] * 2, s[1] * 2);
      mixB(v, 2, 10, 18, 26, m, s[2] * 2, s[3] * 2);
      mixB(v, 4, 12, 20, 28, m, s[4] * 2, s[5] * 2);
      mixB(v, 6, 14, 22, 30, m, s[6] * 2, s[7] * 2);
      mixB(v, 0, 10, 20, 30, m, s[8] * 2, s[9] * 2);
      mixB(v, 2, 12, 22, 24, m, s[10] * 2, s[11] * 2);
      mixB(v, 4, 14, 16, 26, m, s[12] * 2, s[13] * 2);
      mixB(v, 6, 8, 18, 28, m, s[14] * 2, s[15] * 2);
    }
    for (let i = 0; i < 16; i += 1) h[i] ^= v[i] ^ v[i + 16];
  };

  // 마지막 블록은 꽉 차 있어도 '마지막' 표시를 달고 압축해야 하므로, 다음 바이트가 있을 때만
  // 앞 블록을 압축한다. 빈 입력도 빈 블록 하나를 마지막으로 압축한다.
  let fill = 0;
  for (let at = 0; at < input.length; at += 1) {
    if (fill === 128) {
      counter += 128;
      compress(false);
      fill = 0;
    }
    block[fill] = input[at];
    fill += 1;
  }
  counter += fill;
  block.fill(0, fill);
  compress(true);

  const out = new Uint8Array(outLen);
  const view = new DataView(h.buffer);
  for (let i = 0; i < outLen; i += 1) out[i] = view.getUint8(i);
  return out;
}

// ---------------------------------------------------------------- 바이트 도우미

const le32 = (value) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
};

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Argon2 의 가변 길이 해시 H'(RFC 9106 3.3절).
 *
 * 64바이트 이하면 BLAKE2b 한 번. 그보다 길면 64바이트 해시를 사슬처럼 이어 각각의 앞 32바이트를
 * 쓰고, 마지막 조각만 남은 길이로 뽑는다.
 */
function hashLong(input, outLen) {
  const prefixed = concat([le32(outLen), input]);
  if (outLen <= 64) return blake2b(prefixed, outLen);

  const out = new Uint8Array(outLen);
  const rounds = Math.ceil(outLen / 32) - 2;
  let link = blake2b(prefixed, 64);
  out.set(link.subarray(0, 32), 0);
  for (let i = 1; i < rounds; i += 1) {
    link = blake2b(link, 64);
    out.set(link.subarray(0, 32), i * 32);
  }
  out.set(blake2b(link, outLen - 32 * rounds), 32 * rounds);
  return out;
}

// ---------------------------------------------------------------- BlaMka

/// 블록 하나의 u32 칸 수 (1 KiB).
const BLOCK_WORDS = 256;

/// 두 32비트 수의 곱의 **상위** 32비트. `Math.imul` 은 하위만 주므로 한쪽을 16비트로 쪼갠다.
///
/// a·b = (a·bH + ⌊a·bL / 2^16⌋)·2^16 + (a·bL mod 2^16) 이고, 괄호 안은 2^49 아래라 double 로
/// 정확하다. 그 값을 2^16 으로 한 번 더 나눈 몫이 곧 상위 32비트다 — 버린 나머지가 올림을
/// 만들 만큼 크지 않다.
function mulHi(a, b) {
  const t = a * (b & 0xffff);
  return ((a * (b >>> 16) + Math.floor(t / 0x10000)) / 0x10000) >>> 0;
}

/**
 * Argon2 의 GB (BLAKE2b 의 G 에서 덧셈 자리에 `x + y + 2·lo(x)·lo(y)` 를 쓴다).
 *
 * 이 함수가 전체 시간의 대부분을 쓴다 — 64 MiB · 3회면 2,500만 번 불린다. 그래서 여덟 칸을 지역
 * 변수로 꺼내 한 번에 계산하고 마지막에 한 번만 되돌려 쓴다.
 */
function gb(v, a, b, c, d) {
  let al = v[a];
  let ah = v[a + 1];
  let bl = v[b];
  let bh = v[b + 1];
  let cl = v[c];
  let ch = v[c + 1];
  let dl = v[d];
  let dh = v[d + 1];
  let pl;
  let ph;
  let s;
  let xl;
  let xh;

  // a = a + b + 2·lo(a)·lo(b)
  pl = Math.imul(al, bl) >>> 0;
  ph = mulHi(al, bl);
  s = al + bl + ((pl << 1) >>> 0);
  ah = (ah + bh + ((ph << 1) | (pl >>> 31)) + ((s / 0x100000000) | 0)) >>> 0;
  al = s >>> 0;
  // d = (d ^ a) >>> 32
  xl = dl ^ al;
  dl = dh ^ ah;
  dh = xl;
  // c = c + d + 2·lo(c)·lo(d)
  pl = Math.imul(cl, dl >>> 0) >>> 0;
  ph = mulHi(cl, dl >>> 0);
  s = cl + (dl >>> 0) + ((pl << 1) >>> 0);
  ch = (ch + (dh >>> 0) + ((ph << 1) | (pl >>> 31)) + ((s / 0x100000000) | 0)) >>> 0;
  cl = s >>> 0;
  // b = (b ^ c) >>> 24
  xl = bl ^ cl;
  xh = bh ^ ch;
  bl = ((xl >>> 24) | (xh << 8)) >>> 0;
  bh = ((xh >>> 24) | (xl << 8)) >>> 0;
  // a = a + b + 2·lo(a)·lo(b)
  pl = Math.imul(al, bl) >>> 0;
  ph = mulHi(al, bl);
  s = al + bl + ((pl << 1) >>> 0);
  ah = (ah + bh + ((ph << 1) | (pl >>> 31)) + ((s / 0x100000000) | 0)) >>> 0;
  al = s >>> 0;
  // d = (d ^ a) >>> 16
  xl = dl ^ al;
  xh = dh ^ ah;
  dl = ((xl >>> 16) | (xh << 16)) >>> 0;
  dh = ((xh >>> 16) | (xl << 16)) >>> 0;
  // c = c + d + 2·lo(c)·lo(d)
  pl = Math.imul(cl, dl) >>> 0;
  ph = mulHi(cl, dl);
  s = cl + dl + ((pl << 1) >>> 0);
  ch = (ch + dh + ((ph << 1) | (pl >>> 31)) + ((s / 0x100000000) | 0)) >>> 0;
  cl = s >>> 0;
  // b = (b ^ c) >>> 63
  xl = bl ^ cl;
  xh = bh ^ ch;
  bl = (xl << 1) | (xh >>> 31);
  bh = (xh << 1) | (xl >>> 31);

  v[a] = al;
  v[a + 1] = ah;
  v[b] = bl;
  v[b + 1] = bh;
  v[c] = cl;
  v[c + 1] = ch;
  v[d] = dl;
  v[d + 1] = dh;
}

/// 16개의 u64 (u32 인덱스 i0..i15) 에 BLAKE2b 한 라운드를 메시지 없이 돈다.
function permute(v, i0, i1, i2, i3, i4, i5, i6, i7, i8, i9, i10, i11, i12, i13, i14, i15) {
  gb(v, i0, i4, i8, i12);
  gb(v, i1, i5, i9, i13);
  gb(v, i2, i6, i10, i14);
  gb(v, i3, i7, i11, i15);
  gb(v, i0, i5, i10, i15);
  gb(v, i1, i6, i11, i12);
  gb(v, i2, i7, i8, i13);
  gb(v, i3, i4, i9, i14);
}

/**
 * 압축 함수 G. `next = (with ? next : 0) ^ R ^ P(R)`, `R = prev ^ ref`.
 *
 * 레퍼런스 구현(`ref.c` 의 `fill_block`)과 같은 모양이다. P 는 8개의 행(연속한 u64 16개)에 먼저,
 * 그다음 8개의 열(u64 2i, 2i+1, 2i+16, 2i+17, … 2i+113)에 돈다.
 *
 * @param {Uint32Array} mem   메모리 (블록 오프셋은 u32 칸 기준)
 * @param {Uint32Array} r     작업 칸 256
 * @param {Uint32Array} tmp   작업 칸 256
 */
function compress(mem, prev, ref, next, withXor, r, tmp, refMem = mem, prevMem = mem) {
  for (let i = 0; i < BLOCK_WORDS; i += 1) r[i] = prevMem[prev + i] ^ refMem[ref + i];
  if (withXor) {
    for (let i = 0; i < BLOCK_WORDS; i += 1) tmp[i] = r[i] ^ mem[next + i];
  } else {
    tmp.set(r);
  }

  for (let row = 0; row < 8; row += 1) {
    const o = row * 32;
    permute(r, o, o + 2, o + 4, o + 6, o + 8, o + 10, o + 12, o + 14,
      o + 16, o + 18, o + 20, o + 22, o + 24, o + 26, o + 28, o + 30);
  }
  for (let col = 0; col < 8; col += 1) {
    const o = col * 4;
    permute(r, o, o + 2, o + 32, o + 34, o + 64, o + 66, o + 96, o + 98,
      o + 128, o + 130, o + 160, o + 162, o + 192, o + 194, o + 224, o + 226);
  }

  for (let i = 0; i < BLOCK_WORDS; i += 1) mem[next + i] = tmp[i] ^ r[i];
}

// ---------------------------------------------------------------- Argon2id

/// RFC 9106 의 형식 번호. Argon2id 는 2.
const TYPE_ID = 2;
const VERSION = 0x13;
/// 한 패스를 나누는 동기화 지점 수.
const SYNC_POINTS = 4;
/// 주소 블록 하나에 담기는 의사난수 개수 (u64 128개).
const ADDRESSES_PER_BLOCK = 128;

/// 기본 양보 함수. 화면이 그릴 틈을 준다.
const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Argon2id 로 `tagLength` 바이트를 유도한다.
 *
 * 조각(한 레인의 한 슬라이스)마다 `onProgress(done, total)` 를 부르고 `pause()` 로 양보한다.
 * 진행량은 채운 블록 수다. 기본 파라미터에서 조각은 48개라 막대가 눈에 보이게 오른다.
 *
 * 메모리를 할당하지 못하면 `RangeError` 가 난다 — 호출자가 "이 기기에서는 풀 수 없다" 로
 * 옮겨 말한다. 헤더가 요구하는 비용의 상한은 호출자가 먼저 막는다 (`unpack.js`).
 *
 * @param {{password: Uint8Array, salt: Uint8Array, memory: number, passes: number,
 *          lanes: number, tagLength: number, secret?: Uint8Array, data?: Uint8Array,
 *          onProgress?: (done: number, total: number) => void, pause?: () => Promise<void>}} options
 *   `memory` 는 KiB(= 블록 수) 단위다 — Rust `argon2::Params` 의 `m_cost` 와 같다.
 * @returns {Promise<Uint8Array>}
 */
export async function argon2id(options) {
  const {
    password,
    salt,
    memory,
    passes,
    lanes,
    tagLength,
    secret = new Uint8Array(0),
    data = new Uint8Array(0),
    onProgress = null,
    pause = nextFrame,
  } = options;

  // Rust `argon2::Params::new` 가 거절하는 값은 여기서도 거절한다. 조용히 고쳐 계산하면 두
  // 구현이 다른 키를 내고, 그 실패는 "키가 틀렸다" 로만 보인다.
  if (!(Number.isInteger(lanes) && lanes >= 1 && lanes <= 0xffffff)) {
    throw new RangeError("Argon2 레인 수가 올바르지 않습니다.");
  }
  if (!(Number.isInteger(passes) && passes >= 1)) throw new RangeError("Argon2 반복 횟수가 올바르지 않습니다.");
  if (!(Number.isInteger(memory) && memory >= 2 * SYNC_POINTS * lanes)) {
    throw new RangeError("Argon2 메모리가 너무 작습니다.");
  }
  if (!(Number.isInteger(tagLength) && tagLength >= 4)) throw new RangeError("Argon2 출력 길이가 올바르지 않습니다.");
  if (salt.length < 8) throw new RangeError("Argon2 솔트가 너무 짧습니다.");

  // H0. `memory` 는 요청한 값 그대로 넣는다 — 아래에서 4·레인의 배수로 내린 값이 아니다.
  const h0 = blake2b(
    concat([
      le32(lanes), le32(tagLength), le32(memory), le32(passes), le32(VERSION), le32(TYPE_ID),
      le32(password.length), password,
      le32(salt.length), salt,
      le32(secret.length), secret,
      le32(data.length), data,
    ]),
    64,
  );

  const segment = Math.floor(memory / (SYNC_POINTS * lanes));
  const laneLength = segment * SYNC_POINTS;
  const blocks = laneLength * lanes;
  const mem = new Uint32Array(blocks * BLOCK_WORDS);

  // 각 레인의 첫 두 블록.
  for (let lane = 0; lane < lanes; lane += 1) {
    for (let column = 0; column < 2; column += 1) {
      const bytes = hashLong(concat([h0, le32(column), le32(lane)]), 1024);
      const view = new DataView(bytes.buffer);
      const base = (lane * laneLength + column) * BLOCK_WORDS;
      for (let i = 0; i < BLOCK_WORDS; i += 1) mem[base + i] = view.getUint32(i * 4, true);
    }
  }

  const r = new Uint32Array(BLOCK_WORDS);
  const tmp = new Uint32Array(BLOCK_WORDS);
  const zero = new Uint32Array(BLOCK_WORDS);
  const input = new Uint32Array(BLOCK_WORDS);
  const address = new Uint32Array(BLOCK_WORDS);

  const total = passes * blocks;
  let done = 2 * lanes;
  onProgress?.(done, total);

  /// Argon2i 방식의 주소 블록. `address = G(0, G(0, input))`, 매번 카운터를 하나 올린다.
  const nextAddresses = () => {
    input[12] += 1; // u64 6번 칸 (카운터) 의 하위. 2^32 를 넘을 일이 없다.
    compress(address, 0, 0, 0, false, r, tmp, input, zero);
    compress(address, 0, 0, 0, false, r, tmp, address, zero);
  };

  for (let pass = 0; pass < passes; pass += 1) {
    for (let slice = 0; slice < SYNC_POINTS; slice += 1) {
      // Argon2id: 첫 패스의 앞 두 슬라이스만 데이터와 무관한 주소(Argon2i), 나머지는 데이터에
      // 따른 주소(Argon2d). 부채널 공격과 시간-메모리 절충 공격을 둘 다 막으려는 섞음이다.
      const independent = pass === 0 && slice < SYNC_POINTS / 2;

      for (let lane = 0; lane < lanes; lane += 1) {
        let start = 0;
        if (independent) {
          input.fill(0);
          input[0] = pass;
          input[2] = lane;
          input[4] = slice;
          input[6] = blocks;
          input[8] = passes;
          input[10] = TYPE_ID;
        }
        if (pass === 0 && slice === 0) {
          start = 2;
          if (independent) nextAddresses();
        }

        let current = lane * laneLength + slice * segment + start;
        let previous = current % laneLength === 0 ? current + laneLength - 1 : current - 1;

        for (let index = start; index < segment; index += 1, current += 1, previous += 1) {
          if (current % laneLength === 1) previous = current - 1;

          let j1;
          let j2;
          if (independent) {
            const slot = index % ADDRESSES_PER_BLOCK;
            if (slot === 0) nextAddresses();
            j1 = address[slot * 2];
            j2 = address[slot * 2 + 1];
          } else {
            j1 = mem[previous * BLOCK_WORDS];
            j2 = mem[previous * BLOCK_WORDS + 1];
          }

          const refLane = pass === 0 && slice === 0 ? lane : j2 % lanes;
          const sameLane = refLane === lane;

          // 참조할 수 있는 영역의 크기 (`ref.c` 의 `index_alpha`).
          let area;
          if (pass === 0) {
            if (slice === 0) area = index - 1;
            else if (sameLane) area = slice * segment + index - 1;
            else area = slice * segment + (index === 0 ? -1 : 0);
          } else if (sameLane) {
            area = laneLength - segment + index - 1;
          } else {
            area = laneLength - segment + (index === 0 ? -1 : 0);
          }
          const x = mulHi(j1, j1);
          const relative = area - 1 - mulHi(area, x);
          const begin = pass === 0 || slice === SYNC_POINTS - 1 ? 0 : (slice + 1) * segment;
          const refIndex = (begin + relative) % laneLength;

          compress(
            mem,
            previous * BLOCK_WORDS,
            (refLane * laneLength + refIndex) * BLOCK_WORDS,
            current * BLOCK_WORDS,
            pass > 0,
            r,
            tmp,
          );
        }

        done += segment - start;
        onProgress?.(done, total);
        await pause();
      }
    }
  }

  // 각 레인의 마지막 블록을 XOR 해 마지막 해시에 넣는다.
  const last = new Uint32Array(BLOCK_WORDS);
  for (let lane = 0; lane < lanes; lane += 1) {
    const base = (lane * laneLength + laneLength - 1) * BLOCK_WORDS;
    for (let i = 0; i < BLOCK_WORDS; i += 1) last[i] ^= mem[base + i];
  }
  // 메모리는 곧 풀려나지만, 비밀에서 나온 값이 다음 할당까지 남아 있지 않게 지운다.
  mem.fill(0);

  const tag = hashLong(new Uint8Array(last.buffer), tagLength);
  last.fill(0);
  return tag;
}
