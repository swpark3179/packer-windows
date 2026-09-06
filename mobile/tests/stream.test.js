// stream.js 를 검증한다.
//
//   npm test
//
// **의존성이 없어서 `npm install` 없이도 돌아간다** — `collector.test.js` 와 같은 성질이다.
//
// 여기서 지키는 계약은 하나다: **Rust 인코더와 이 디코더가 같은 난수열을 낸다.** 어긋나면
// 프레임은 멀쩡히 읽히는데 XOR 이 안 맞아 한참 뒤 PC 에서 복호화 실패로만 나타난다. 그래서
// 손으로 적은 예시가 아니라 `src-tauri/tests/stream_format.rs` 가 만든 **골든 픽스처**를
// 그대로 디코딩해 본다.
//
// 픽스처를 다시 만들려면:
//   cargo test --test stream_format -- --ignored write_the_golden_fixture
// 그리고 이 테스트를 반드시 함께 돌린다 — 픽스처만 갈아 끼우면 두 구현이 어긋난 채로 양쪽이
// 통과한다.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  HEADER_LEN,
  MAGIC,
  addFrame,
  blockIndices,
  createStream,
  crc16,
  isComplete,
  looksLikeStream,
  parseFrame,
  percent,
  rng,
  solitonCdf,
  takeBytes,
} from "../www/stream.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const golden = JSON.parse(
  fs.readFileSync(path.join(root, "tests", "fixtures", "stream-frames.json"), "utf8"),
);

const unhex = (text) =>
  Uint8Array.from({ length: text.length / 2 }, (_, i) =>
    Number.parseInt(text.slice(i * 2, i * 2 + 2), 16),
  );

const SOURCE = unhex(golden.source);
const FRAMES = golden.frames.map(unhex);

/** 픽스처의 프레임을 순서대로(혹은 골라서) 먹인다. */
function collect(frames) {
  const stream = createStream();
  const results = [];
  for (const frame of frames) {
    results.push(addFrame(stream, frame));
    if (isComplete(stream)) break;
  }
  return { stream, results };
}

// ---------------------------------------------------------------- 계약

describe("골든 픽스처 (Rust 인코더와의 계약)", () => {
  it("픽스처 자체가 온전하다", () => {
    assert.equal(SOURCE.length, golden.totalBytes);
    assert.equal(golden.blocks, Math.ceil(golden.totalBytes / golden.blockSize));
    assert.ok(FRAMES.length > golden.blocks, "복원하려면 블록 수보다 많아야 한다");
    for (const frame of FRAMES) {
      assert.equal(frame.length, HEADER_LEN + golden.blockSize);
    }
  });

  it("헤더를 Rust 가 쓴 그대로 읽는다", () => {
    const first = parseFrame(FRAMES[0]);
    assert.equal(first.ok, true);
    assert.equal(first.fingerprint, golden.fingerprint);
    assert.equal(first.totalBytes, golden.totalBytes);
    assert.equal(first.blockSize, golden.blockSize);
    assert.equal(first.blocks, golden.blocks);
    assert.equal(first.seq, 0);
  });

  it("프레임 번호를 헤더에서 그대로 읽는다", () => {
    for (const [at, frame] of FRAMES.entries()) {
      assert.equal(parseFrame(frame).seq, at);
    }
  });

  /**
   * **이 테스트가 이 파일의 존재 이유다.**
   *
   * 통과한다는 것은 `rng()` · `solitonCdf()` · `blockIndices()` 가 Rust 쪽과 같은 값을
   * 낸다는 뜻이다. 하나라도 어긋나면 XOR 이 안 맞아 여기서 복원이 실패한다.
   */
  it("Rust 가 만든 프레임을 원본 바이트로 되돌린다", () => {
    const { stream } = collect(FRAMES);
    assert.equal(isComplete(stream), true, `${stream.solvedCount}/${stream.blocks} 만 풀렸다`);
    assert.deepEqual(takeBytes(stream), SOURCE);
  });

  it("프레임의 3분의 1을 버려도 복원된다", () => {
    // 파운틴 부호의 존재 이유다 — 놓친 프레임을 되찾으러 갈 필요가 없다.
    const kept = FRAMES.filter((_, at) => at % 3 !== 0);
    const { stream } = collect(kept);
    assert.equal(isComplete(stream), true, `${stream.solvedCount}/${stream.blocks} 만 풀렸다`);
    assert.deepEqual(takeBytes(stream), SOURCE);
  });

  it("순서를 뒤집어 먹여도 복원된다", () => {
    // 순번을 채우는 방식이 아니므로 순서에 아무 의미가 없어야 한다.
    const { stream } = collect([...FRAMES].reverse());
    assert.equal(isComplete(stream), true);
    assert.deepEqual(takeBytes(stream), SOURCE);
  });

  it("블록 수보다 조금만 더 받으면 끝난다", () => {
    // 오버헤드가 크면 화면 앞에 오래 서 있어야 한다. 실측을 못박아 둔다.
    const { stream } = collect(FRAMES);
    assert.ok(
      stream.seen.size <= golden.blocks * 2,
      `${golden.blocks}블록에 ${stream.seen.size}프레임을 썼다 — 오버헤드가 너무 크다`,
    );
  });
});

// ---------------------------------------------------------------- 난수

describe("난수", () => {
  it("같은 시드는 같은 값을 낸다", () => {
    const a = rng(12345);
    const b = rng(12345);
    for (let i = 0; i < 200; i += 1) assert.equal(a.nextU32(), b.nextU32());
  });

  it("32비트를 벗어나지 않는다", () => {
    // Math.imul 과 >>> 0 을 빠뜨리면 여기서 드러난다 — Rust 쪽과 조용히 갈라지는 자리다.
    const random = rng(999);
    for (let i = 0; i < 500; i += 1) {
      const value = random.nextU32();
      assert.ok(Number.isInteger(value) && value >= 0 && value <= 0xffffffff, `${value}`);
    }
  });

  it("이웃한 시드가 계단처럼 늘어서지 않는다", () => {
    // 섞지 않으면 첫 난수가 계단이 되고, 그 첫 난수가 곧 차수라 디코딩이 시작을 못 한다.
    const first = Array.from({ length: 64 }, (_, seq) => rng(seq).unit());
    let flips = 0;
    for (let at = 1; at + 1 < first.length; at += 1) {
      const before = first[at] - first[at - 1];
      const after = first[at + 1] - first[at];
      if (before >= 0 !== after >= 0) flips += 1;
    }
    assert.ok(flips > 15, `${flips}번만 방향이 바뀌었다`);
  });

  it("unit 은 [0, 1) 안에 있다", () => {
    const random = rng(7);
    for (let i = 0; i < 500; i += 1) {
      const value = random.unit();
      assert.ok(value >= 0 && value < 1, `${value}`);
    }
  });

  it("below 는 범위를 지키고 골고루 덮는다", () => {
    const random = rng(31);
    const seen = new Set();
    for (let i = 0; i < 500; i += 1) {
      const value = random.below(5);
      assert.ok(value >= 0 && value < 5);
      seen.add(value);
    }
    assert.equal(seen.size, 5, "한쪽으로 치우쳤다");
    assert.equal(rng(3).below(1), 0);
  });
});

describe("블록 고르기", () => {
  it("중복 없이, 범위 안에서, 정렬해서 낸다", () => {
    const cdf = solitonCdf(40);
    for (let seq = 0; seq < 300; seq += 1) {
      const picked = blockIndices(seq, 40, cdf);
      assert.ok(picked.length >= 1 && picked.length <= 40);
      assert.equal(new Set(picked).size, picked.length, `중복: ${picked}`);
      assert.ok(picked.every((i) => i >= 0 && i < 40));
      assert.deepEqual(picked, [...picked].sort((a, b) => a - b));
    }
  });

  it("차수 1 프레임이 초반에 나온다", () => {
    // 디코딩은 차수 1 에서만 시작한다. 없으면 영원히 멈춰 있다.
    const cdf = solitonCdf(60);
    const ones = Array.from({ length: 120 }, (_, seq) => blockIndices(seq, 60, cdf)).filter(
      (picked) => picked.length === 1,
    ).length;
    assert.ok(ones >= 3, `차수 1이 ${ones}개뿐이다`);
  });
});

// ---------------------------------------------------------------- 프레임 판정

describe("프레임 판정", () => {
  it("우리 프레임이 아닌 것을 가른다", () => {
    // 조각 모드의 텍스트가 여기 들어오면 안 된다.
    const armor = new TextEncoder().encode("-----BEGIN PACKER CONTAINER-----\n#1/3\nQUFB\n");
    assert.equal(looksLikeStream(armor), false);
    assert.deepEqual(parseFrame(armor), { ok: false, reason: "not-stream" });
    assert.equal(looksLikeStream(new Uint8Array(4)), false, "헤더보다 짧다");
    assert.equal(looksLikeStream(null), false);
    assert.equal(MAGIC, "PQS1");
  });

  it("잘려 들어온 프레임을 거절한다", () => {
    const short = FRAMES[0].slice(0, FRAMES[0].length - 1);
    assert.deepEqual(parseFrame(short), { ok: false, reason: "damaged" });
  });

  it("한 비트만 뒤집혀도 CRC 가 잡는다", () => {
    // 한 프레임이라도 오염되면 XOR 이 번져 **전체** 복원이 실패한다. 그때는 어느 프레임이
    // 문제였는지 알 방법이 없다.
    const dirty = Uint8Array.from(FRAMES[0]);
    dirty[HEADER_LEN + 3] ^= 0x01;
    assert.deepEqual(parseFrame(dirty), { ok: false, reason: "damaged" });
  });

  it("CRC 는 Rust 가 적은 값과 같다", () => {
    for (const frame of FRAMES.slice(0, 5)) {
      const want = frame[22] | (frame[23] << 8);
      assert.equal(crc16(frame.slice(HEADER_LEN)), want);
    }
  });
});

// ---------------------------------------------------------------- 수집

describe("수집", () => {
  it("같은 프레임을 다시 넣으면 조용히 넘어간다", () => {
    // 연속 스캔은 같은 심볼을 초당 여러 번 읽는다.
    const stream = createStream();
    assert.equal(addFrame(stream, FRAMES[0]).status, "added");
    const again = addFrame(stream, FRAMES[0]);
    assert.equal(again.status, "duplicate");
    assert.equal(stream.pending.length + stream.solvedCount, 1);
  });

  it("다른 묶음이 섞이면 짚어 준다", () => {
    // 지문이 다르면 곧바로 걸러야 한다. 받아 두면 XOR 이 오염돼 마지막에야 드러난다.
    const other = Uint8Array.from(FRAMES[1]);
    other[4] ^= 0xff; // 지문 한 바이트
    const stream = createStream();
    assert.equal(addFrame(stream, FRAMES[0]).status, "added");
    assert.deepEqual(addFrame(stream, other), { status: "conflict", reason: "fingerprint" });
  });

  it("진행률은 뒤로 가지 않고 100 에서 끝난다", () => {
    const stream = createStream();
    let last = 0;
    for (const frame of FRAMES) {
      addFrame(stream, frame);
      const now = percent(stream);
      assert.ok(now >= last, `${last} → ${now}`);
      last = now;
      if (isComplete(stream)) break;
    }
    assert.equal(percent(stream), 100);
  });

  it("다 모이기 전에는 던진다", () => {
    const stream = createStream();
    addFrame(stream, FRAMES[0]);
    assert.equal(isComplete(stream), false);
    assert.throws(() => takeBytes(stream), /다 모이지 않았습니다/);
  });

  it("빈 수집은 진행률 0 이고 완성이 아니다", () => {
    const stream = createStream();
    assert.equal(percent(stream), 0);
    assert.equal(isComplete(stream), false);
  });
});
