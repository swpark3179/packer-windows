// export.js 를 검증한다.
//
//   npm test
//
// **의존성이 없어서 `npm install` 없이도 돌아간다** — `collector.test.js` 와 같은 성질이다.
// `export.js` 는 DOM 도 Capacitor 도 시계도 모르므로 여기서 전부 확인된다.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BUSY_DELAY_MS,
  BUSY_HOLD_MS,
  CHUNK_CHARS,
  CHUNK_THRESHOLD,
  MAX_NAME_LENGTH,
  chunkText,
  defaultFileName,
  safeFileName,
  shouldChunk,
  stamp,
} from "../www/export.js";

/// 테스트가 시계에 흔들리지 않도록 고정한다.
const FIXED = new Date(2026, 8, 6, 14, 15, 30);
const FIXED_NAME = "packer-20260906-141530.txt";

describe("stamp / defaultFileName", () => {
  it("연월일-시분초를 빠짐없이 두 자리로 적는다", () => {
    assert.equal(stamp(FIXED), "20260906-141530");
    // 한 자리 값들이 0으로 채워지는지. 이게 어긋나면 파일 이름이 정렬되지 않는다.
    assert.equal(stamp(new Date(2026, 0, 2, 3, 4, 5)), "20260102-030405");
  });

  it("기본 이름은 ASCII 만 쓴다", () => {
    const name = defaultFileName(FIXED);
    assert.equal(name, FIXED_NAME);
    // 안드로이드 공유 시트의 MIME 판정이 ASCII 밖 글자에서 확장자를 놓친다 (export.js 주석).
    // eslint-disable-next-line no-control-regex
    assert.match(name, /^[\x20-\x7e]+$/);
  });
});

describe("safeFileName", () => {
  const cases = [
    ["", FIXED_NAME, "빈 이름은 기본값으로"],
    ["   ", FIXED_NAME, "공백뿐이면 기본값으로"],
    ["..", FIXED_NAME, "점뿐이면 기본값으로"],
    ["보고서", "보고서.txt", "확장자를 붙인다"],
    ["보고서.txt", "보고서.txt", "이미 있으면 겹쳐 붙이지 않는다"],
    ["x.TXT", "x.TXT", "사용자가 적은 대소문자를 그대로 둔다"],
    ["a/b:c", "a_b_c.txt", "윈도우가 못 쓰는 글자를 밑줄로"],
    ['a<b>c|d"e*f?g\\h', "a_b_c_d_e_f_g_h.txt", "나머지 금지 글자도 전부"],
    ["a b", "a_b.txt", "공백은 밑줄로"],
    ["a   b", "a_b.txt", "연속 공백도 밑줄 하나로"],
    ["a//b", "a_b.txt", "연속 밑줄도 하나로"],
    ["보고서.txt ", "보고서.txt", "끝의 공백은 윈도우가 지운다"],
    ["...보고서", "보고서.txt", "앞의 점도 지운다"],
    ["CON.txt", "_CON.txt", "윈도우 장치 이름은 피한다"],
    ["nul", "_nul.txt", "대소문자를 가리지 않는다"],
    ["CONSOLE", "CONSOLE.txt", "장치 이름을 포함하기만 한 것은 그대로 둔다"],
    [null, FIXED_NAME, "문자열이 아니면 기본값으로"],
  ];

  for (const [input, want, why] of cases) {
    it(`${why} — ${JSON.stringify(input)}`, () => {
      assert.equal(safeFileName(input, FIXED), want);
    });
  }

  it("너무 긴 이름은 자른다", () => {
    const name = safeFileName("가".repeat(200), FIXED);
    assert.equal(name, `${"가".repeat(MAX_NAME_LENGTH)}.txt`);
  });

  it("고친 이름을 다시 고쳐도 그대로다", () => {
    for (const [input] of cases) {
      const once = safeFileName(input, FIXED);
      assert.equal(safeFileName(once, FIXED), once, `${JSON.stringify(input)} → ${once}`);
    }
  });
});

describe("chunkText", () => {
  const body = "ABCDEFGHIJ";

  it("이어 붙이면 원문과 같다", () => {
    for (const size of [1, 3, 4, 9, 10, 11, 1000]) {
      assert.equal(chunkText(body, size).join(""), body, `size=${size}`);
    }
  });

  it("딱 나누어떨어질 때와 남을 때", () => {
    assert.deepEqual(chunkText(body, 5), ["ABCDE", "FGHIJ"]);
    assert.deepEqual(chunkText(body, 4), ["ABCD", "EFGH", "IJ"]);
  });

  it("빈 문자열도 조각 하나로 나온다", () => {
    // 첫 조각은 writeFile 이라, 여기서 빈 배열을 주면 파일 자체가 만들어지지 않는다.
    assert.deepEqual(chunkText("", 100), [""]);
  });

  it("서로게이트 쌍을 쪼개지 않는다", () => {
    const pairs = "😀😀😀"; // 각 2 코드 유닛
    for (const size of [1, 2, 3, 4, 5]) {
      const chunks = chunkText(pairs, size);
      assert.equal(chunks.join(""), pairs, `size=${size}`);
      for (const chunk of chunks) {
        const last = chunk.charCodeAt(chunk.length - 1);
        // size=1 은 쪼갤 수 밖에 없다(조각 하나에 코드 유닛 하나). 그 외에는 짝이 살아 있어야 한다.
        if (size > 1) assert.ok(!(last >= 0xd800 && last <= 0xdbff), `쪼개졌다: ${chunks}`);
      }
    }
  });

  it("기본 크기는 CHUNK_CHARS 다", () => {
    assert.equal(chunkText("x".repeat(CHUNK_CHARS + 1)).length, 2);
  });
});

describe("shouldChunk", () => {
  it("임계값 경계", () => {
    assert.equal(shouldChunk("x".repeat(CHUNK_THRESHOLD - 1)), false);
    assert.equal(shouldChunk("x".repeat(CHUNK_THRESHOLD)), true);
    assert.equal(shouldChunk(null), false);
  });

  /**
   * **가드 테스트.**
   *
   * `qr.rs` 의 조각 상한은 128장이고, 조각 하나에 들어가는 armor 본문이 실측 약 1,430자라
   * 합친 텍스트는 최대 약 183,000자다. 그 크기는 나눠 쓰기 경로를 **탄다** — 브리지 한 번에
   * 넘기기에 크고, 실제로 몇 초가 걸린다.
   *
   * 반대로 예전 상한(16장 ≈ 46,000자)에서는 밀리초라 막대를 띄우는 것이 거짓말이었다. 두
   * 경계를 함께 못박아 둔다. 상한을 다시 움직이면 여기가 먼저 깨져서, 막대를 띄우는 것이
   * 여전히 정직한지 다시 보게 한다.
   */
  it("옛 상한(16장)에서는 막대가 뜰 일이 없고, 지금 상한(128장)에서는 뜬다", () => {
    const joined = (pieces, perPiece) => "x".repeat(pieces * perPiece + 2 * 32 + 2);
    assert.equal(shouldChunk(joined(16, 2_920)), false, "밀리초짜리 작업에 막대는 거짓말이다");
    assert.equal(shouldChunk(joined(128, 1_430)), true, "이 크기는 실제로 몇 초가 걸린다");
  });
});

describe("진행 막대 타이밍 상수", () => {
  it("눈에 보일 만큼 기다리고, 보였으면 읽을 만큼 남긴다", () => {
    // 250ms 아래로 내리면 빠른 저장에서 막대가 번쩍인다. 위로 올리면 느린 저장이 멈춘 것처럼
    // 보인다. 값 자체보다 "둘 다 0이 아니다" 가 계약이다.
    assert.ok(BUSY_DELAY_MS >= 150 && BUSY_DELAY_MS <= 500);
    assert.ok(BUSY_HOLD_MS >= BUSY_DELAY_MS);
  });
});
