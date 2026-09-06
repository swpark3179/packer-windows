// 스트림 모드(파운틴 부호) 프레임을 모아 원본 바이트로 되돌리는 로직.
//
// `collector.js` 와 같은 규율이다: **의존성이 없다.** DOM 도 Capacitor 도 모른다. 카메라에서
// 읽어낸 바이트만 받고 바이트만 돌려준다 (`tests/stream.test.js`).
//
// 인코더는 `../../src-tauri/src/qrstream.rs` 에 있다. 그쪽 모듈 문서가 이 형식의 근거를 전부
// 담고 있으니 먼저 읽는 편이 빠르다. 요약하면:
//
//   프레임 = 헤더 24바이트 + (소스 블록 몇 개를 XOR 한) payload
//   어떤 블록을 골랐는지는 **프레임 번호를 시드로 한 난수열**이 정한다.
//
// 그래서 아무 프레임이나 K(1+ε)개쯤 모으면 전부 풀린다 — 놓친 프레임을 되찾으러 갈 일이 없다.
// 조각 모드(`collector.js`)와 달리 순번을 다 채울 필요가 없는 것이 이 모드의 존재 이유다.
//
// # 이 파일에서 절대 어긋나면 안 되는 것
//
// `rng()` · `solitonCdf()` · `blockIndices()` 는 Rust 쪽과 **비트 단위로 같아야 한다.** 하나라도
// 어긋나면 프레임은 멀쩡히 읽히는데 XOR 이 안 맞아, 한참 뒤 PC 에서 복호화 실패로만 나타난다.
// 그 계약은 골든 픽스처(`tests/fixtures/stream-frames.json`)가 양쪽에서 붙잡는다.

/// 헤더의 매직. 조각 모드와 스트림 모드를 이걸로 가른다.
export const MAGIC = "PQS1";

/// 헤더 크기. `qrstream.rs` 의 `HEADER_LEN`.
export const HEADER_LEN = 24;

/// 지문 길이 (SHA-256 앞 8바이트).
const FINGERPRINT_LEN = 8;

/// 로버스트 솔리톤 분포의 상수. `qrstream.rs` 의 `SOLITON_C` / `SOLITON_DELTA`.
const SOLITON_C = 0.03;
const SOLITON_DELTA = 0.05;

// ---------------------------------------------------------------- 난수

/**
 * `qrstream.rs` 의 `Rng` 를 그대로 옮긴 것.
 *
 * 32비트 연산만 쓴다 — 자바스크립트에는 64비트 정수가 없다. `Math.imul` 이 Rust 의
 * `wrapping_mul` 과 정확히 같은 결과를 내고, `>>> 0` 이 부호 없는 32비트로 되돌린다.
 *
 * 시드를 MurmurHash3 의 마무리 함수로 한 번 섞는 것이 중요하다. 프레임 번호는 0, 1, 2, … 로
 * 붙는데 xorshift 는 이웃한 시드에서 이웃한 첫 출력을 내고, 그 첫 출력이 곧 **차수**다.
 * 섞지 않으면 초반에 차수 1 프레임이 나오지 않아 디코딩이 시작조차 못 한다.
 */
export function rng(seed) {
  let h = seed >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  // xorshift 는 상태 0에서 영원히 0을 낸다.
  let state = h === 0 ? 0x9e3779b9 : h;

  const nextU32 = () => {
    let x = state;
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    state = x;
    return Math.imul(x, 0x2545f491) >>> 0;
  };

  return {
    nextU32,
    /// `0 <= n < bound`. 나머지 연산의 치우침을 버림으로 없앤다 — 이 방식까지 규격이다.
    below(bound) {
      if (bound <= 1) return 0;
      const limit = 0xffffffff - (0xffffffff % bound) - 1;
      for (;;) {
        const value = nextU32();
        if (value <= limit) return value % bound;
      }
    },
    /// `[0, 1)`. 상위 24비트만 써서 두 언어의 부동소수 반올림 차이를 피한다.
    unit() {
      return (nextU32() >>> 8) / 0x1000000;
    },
  };
}

// ---------------------------------------------------------------- 분포

/// `qrstream.rs` 의 `soliton_cdf()` 를 그대로 옮긴 것. **연산 순서까지 같아야 한다.**
export function solitonCdf(blocks) {
  const k = blocks;
  const r = SOLITON_C * Math.max(Math.log(k / SOLITON_DELTA), 1) * Math.sqrt(k);
  const spike = r >= 1 ? Math.max(Math.round(k / r), 1) : k;

  const weights = [];
  for (let d = 1; d <= blocks; d += 1) {
    const ideal = d === 1 ? 1 / k : 1 / (d * (d - 1));
    let extra = 0;
    if (d < spike) extra = r / (d * k);
    else if (Math.abs(d - spike) < 0.5) extra = (r * Math.log(r / SOLITON_DELTA)) / k;
    weights.push(ideal + extra);
  }

  let total = 0;
  for (const weight of weights) total += weight;

  const cdf = [];
  let running = 0;
  for (const weight of weights) {
    running += weight / total;
    cdf.push(running);
  }
  // 마지막은 정확히 1로. 누적 오차로 0.9999… 로 끝나면 뽑기가 범위를 벗어난다.
  if (cdf.length > 0) cdf[cdf.length - 1] = 1;
  return cdf;
}

/// `qrstream.rs` 의 `block_indices()`. **인코더와 디코더가 부르는 유일한 공통 함수다.**
export function blockIndices(seq, blocks, cdf) {
  if (blocks === 0) return [];
  const random = rng(seq);

  const pick = random.unit();
  let degree = cdf.findIndex((bound) => pick < bound);
  degree = (degree === -1 ? blocks - 1 : degree) + 1;
  if (degree > blocks) degree = blocks;

  // 중복 없이 뽑는다. 같은 블록을 두 번 XOR 하면 서로 지워져 차수가 달라진다.
  const chosen = [];
  while (chosen.length < degree) {
    const candidate = random.below(blocks);
    if (!chosen.includes(candidate)) chosen.push(candidate);
  }
  chosen.sort((a, b) => a - b);
  return chosen;
}

// ---------------------------------------------------------------- 프레임

/// `qrstream.rs` 의 `crc16()` — CRC-16/IBM.
export function crc16(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc & 0xffff;
}

const readU16 = (bytes, at) => bytes[at] | (bytes[at + 1] << 8);
const readU32 = (bytes, at) =>
  (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/// 카메라가 준 심볼이 스트림 프레임인지 값싸게 본다. 조각 모드와 가르는 유일한 판단이다.
export function looksLikeStream(bytes) {
  if (!bytes || bytes.length < HEADER_LEN) return false;
  for (let at = 0; at < 4; at += 1) {
    if (bytes[at] !== MAGIC.charCodeAt(at)) return false;
  }
  return true;
}

/**
 * 프레임 하나를 뜯는다.
 *
 * @returns `{ ok: true, fingerprint, totalBytes, blockSize, blocks, seq, payload }` 또는
 *   `{ ok: false, reason }` — `"not-stream"` · `"damaged"`(CRC 불일치나 길이가 안 맞음) ·
 *   `"range"`(헤더 값이 말이 안 됨).
 */
export function parseFrame(bytes) {
  if (!looksLikeStream(bytes)) return { ok: false, reason: "not-stream" };

  const totalBytes = readU32(bytes, 12);
  const blockSize = readU16(bytes, 16);
  const seq = readU32(bytes, 18);
  const crc = readU16(bytes, 22);

  if (totalBytes === 0 || blockSize === 0) return { ok: false, reason: "range" };
  // payload 는 블록 하나와 정확히 같은 크기다. 다르면 잘려 들어왔거나 우리 것이 아니다.
  if (bytes.length !== HEADER_LEN + blockSize) return { ok: false, reason: "damaged" };

  const payload = bytes.slice(HEADER_LEN);
  // QR 자체가 Reed-Solomon 으로 지켜 주지만, 한 프레임이라도 잘못 들어가면 XOR 이 오염돼
  // **전체 복원이 실패한다.** 그때는 어느 프레임이 문제였는지 알 방법이 없다.
  if (crc16(payload) !== crc) return { ok: false, reason: "damaged" };

  return {
    ok: true,
    fingerprint: toHex(bytes.slice(4, 4 + FINGERPRINT_LEN)),
    totalBytes,
    blockSize,
    // 블록 수는 싣지 않는다. 양쪽이 같은 식으로 계산한다.
    blocks: Math.ceil(totalBytes / blockSize),
    seq,
    payload,
  };
}

// ---------------------------------------------------------------- 수집

/// 빈 수집 상태. 모양은 첫 프레임에서 정해진다.
export function createStream() {
  return {
    fingerprint: null,
    totalBytes: 0,
    blockSize: 0,
    blocks: 0,
    cdf: null,
    /// 푼 블록. `solved[i]` 가 `Uint8Array` 면 그 블록은 확정이다.
    solved: [],
    solvedCount: 0,
    /// 아직 못 푼 프레임: `{ need: number[], data: Uint8Array }`.
    pending: [],
    /// 이미 본 프레임 번호. 같은 심볼이 초당 여러 번 들어온다.
    seen: new Set(),
  };
}

function xorInto(target, source) {
  for (let at = 0; at < target.length; at += 1) target[at] ^= source[at];
}

/**
 * 한 걸음 푼다 — 벨리프 프로퍼게이션.
 *
 * **다 모은 뒤 한 번에 풀지 않는다.** 프레임을 넣을 때마다 조금씩 풀어야 한다. 수천 프레임을
 * 쌓아 두었다가 마지막에 풀면 그 몇 초 동안 화면이 통째로 멈춘다.
 */
function propagate(stream) {
  for (;;) {
    let moved = false;

    for (const entry of stream.pending) {
      if (entry.need.length === 0) continue;
      const still = [];
      for (const index of entry.need) {
        const known = stream.solved[index];
        if (known) {
          xorInto(entry.data, known);
          moved = true;
        } else {
          still.push(index);
        }
      }
      entry.need = still;
    }

    for (const entry of stream.pending) {
      if (entry.need.length === 1 && !stream.solved[entry.need[0]]) {
        stream.solved[entry.need[0]] = entry.data;
        stream.solvedCount += 1;
        entry.need = [];
        moved = true;
      }
    }

    // 차수가 0이 된 것(이미 아는 블록들만으로 이뤄진 프레임)과 방금 푼 것은 버린다.
    stream.pending = stream.pending.filter((entry) => entry.need.length > 1);

    if (!moved) return;
  }
}

/**
 * 프레임 하나를 넣는다. `stream` 을 제자리에서 고친다.
 *
 * @returns `{ status, got?, need?, reason? }` — `status` 는
 *   `"added"` · `"duplicate"`(이미 본 프레임 번호) · `"conflict"`(다른 묶음이 섞였다) ·
 *   `"rejected"`(프레임으로 읽을 수 없다).
 */
export function addFrame(stream, bytes) {
  const parsed = parseFrame(bytes);
  if (!parsed.ok) return { status: "rejected", reason: parsed.reason };

  if (stream.fingerprint === null) {
    stream.fingerprint = parsed.fingerprint;
    stream.totalBytes = parsed.totalBytes;
    stream.blockSize = parsed.blockSize;
    stream.blocks = parsed.blocks;
    stream.cdf = solitonCdf(parsed.blocks);
    stream.solved = new Array(parsed.blocks).fill(null);
  } else if (stream.fingerprint !== parsed.fingerprint) {
    // 다른 묶음의 프레임. 조용히 받아 두면 XOR 이 오염돼 마지막에 복호화 실패로만 나타난다.
    return { status: "conflict", reason: "fingerprint" };
  }

  // 연속 스캔은 같은 심볼을 초당 여러 번 읽는다. 아무 일도 없었던 것처럼 넘어가야 한다.
  if (stream.seen.has(parsed.seq)) {
    return { status: "duplicate", got: stream.solvedCount, need: stream.blocks };
  }
  stream.seen.add(parsed.seq);

  stream.pending.push({
    need: blockIndices(parsed.seq, stream.blocks, stream.cdf),
    data: parsed.payload,
  });
  propagate(stream);

  return { status: "added", got: stream.solvedCount, need: stream.blocks };
}

/// 다 풀렸는지.
export function isComplete(stream) {
  return stream.blocks > 0 && stream.solvedCount === stream.blocks;
}

/// 0~100. 화면의 진행 막대가 그대로 쓴다.
export function percent(stream) {
  if (stream.blocks === 0) return 0;
  return Math.round((stream.solvedCount / stream.blocks) * 100);
}

/**
 * 푼 블록들을 이어 원본 바이트를 돌려준다.
 *
 * 마지막 블록의 채움(0)은 잘라 낸다 — 인코더가 블록 크기에 맞추려고 붙인 것이다.
 */
export function takeBytes(stream) {
  if (!isComplete(stream)) {
    throw new Error("프레임이 다 모이지 않았습니다.");
  }
  const out = new Uint8Array(stream.blocks * stream.blockSize);
  for (let index = 0; index < stream.blocks; index += 1) {
    out.set(stream.solved[index], index * stream.blockSize);
  }
  return out.subarray(0, stream.totalBytes);
}

/**
 * 복원한 바이트가 보낸 쪽의 것과 같은지 지문으로 확인한다.
 *
 * 여기까지 왔으면 CRC 를 통과한 프레임만 썼으므로 어긋날 일은 드물다. 그래도 확인하는 이유는,
 * 어긋났을 때 **여기서 말해 주지 않으면** PC 의 풀기 탭에서 "손상되었습니다" 로만 나타나기
 * 때문이다 — 그때는 다시 찍는 것 말고 할 수 있는 일이 없고, 무엇이 문제였는지도 모른다.
 *
 * 웹 크립토를 쓴다. Capacitor 는 `https://localhost` 로 서빙하므로 secure context 다.
 */
export async function verify(stream, bytes) {
  const digest = globalThis.crypto?.subtle?.digest;
  if (!digest) return true; // 확인할 수단이 없으면 막지 않는다.
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return toHex(hash.slice(0, FINGERPRINT_LEN)) === stream.fingerprint;
}
