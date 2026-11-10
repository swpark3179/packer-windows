// argon2.js — '풀어서 저장' 이 암호에서 키를 다시 만드는 계산.
//
//   npm test
//
// **의존성이 없어서 `npm install` 없이도 돌아간다.**
//
// 여기서 못박는 것은 하나다: 데스크톱의 Rust `argon2` 크레이트와 **비트 단위로 같은 값**을 낸다.
// 한 비트만 달라도 맞는 암호가 "암호화 키가 올바르지 않습니다" 로 나오고, 폰 화면에서는 그 원인을
// 알 길이 없다. 그래서 두 출처를 함께 쓴다 — RFC 9106 의 시험 벡터(비밀값·연관 데이터까지 쓰는
// 유일한 공개 벡터)와, Rust 가 만든 골든 벡터(`fixtures/unpack-container.json`). 골든 벡터의 마지막
// 줄은 실제로 묶을 때 쓰는 기본값(64 MiB · 3회 · 4레인)이다.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { argon2id, blake2b } from "../www/argon2.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const golden = JSON.parse(
  fs.readFileSync(path.join(root, "tests", "fixtures", "unpack-container.json"), "utf8"),
);

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (text) =>
  Uint8Array.from({ length: text.length / 2 }, (_, i) => Number.parseInt(text.slice(i * 2, i * 2 + 2), 16));
const utf8 = (text) => new TextEncoder().encode(text);
/// 테스트에서는 양보하지 않는다 — 화면이 없다.
const now = async () => {};

describe("BLAKE2b", () => {
  it("공개된 값과 같다", () => {
    // RFC 7693 부록 A 와 참조 구현의 값.
    assert.equal(
      hex(blake2b(new Uint8Array(0))),
      "786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419" +
        "d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce",
    );
    assert.equal(
      hex(blake2b(utf8("abc"))),
      "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1" +
        "7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
    );
  });

  it("블록 경계(128바이트)를 정확히 다룬다", () => {
    // 꽉 찬 마지막 블록은 '마지막' 표시를 달고 압축해야 한다 — 다음 블록이 있다고 보고 먼저
    // 압축해 버리면 이 길이에서만 값이 틀린다. 기대값은 파이썬 hashlib.blake2b 가 낸 것이다.
    const bytes = Uint8Array.from({ length: 1000 }, (_, i) => i & 255);
    assert.equal(
      hex(blake2b(bytes, 32)),
      "c636324d47d89f2b2434dc2c994100663fbbaea880ff020fc5de89dd0f77a1ec",
    );
  });
});

describe("Argon2id", () => {
  it("RFC 9106 5.3 의 시험 벡터와 같다", async () => {
    const tag = await argon2id({
      password: new Uint8Array(32).fill(1),
      salt: new Uint8Array(16).fill(2),
      secret: new Uint8Array(8).fill(3),
      data: new Uint8Array(12).fill(4),
      memory: 32,
      passes: 3,
      lanes: 4,
      tagLength: 32,
      pause: now,
    });
    assert.equal(hex(tag), "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659");
  });

  for (const vector of golden.vectors) {
    const label = `${vector.m} KiB · ${vector.t}회 · ${vector.p}레인`;
    it(`Rust 가 만든 골든 벡터와 같다 — ${label}`, async () => {
      const okm = await argon2id({
        password: utf8(vector.password),
        salt: unhex(vector.salt),
        memory: vector.m,
        passes: vector.t,
        lanes: vector.p,
        tagLength: 48,
        pause: now,
      });
      assert.equal(hex(okm), vector.okm);
    });
  }

  it("골든 벡터에 실제로 묶을 때 쓰는 기본값이 들어 있다", () => {
    // 이 줄이 빠지면 폰에서 몇 초 걸리는 바로 그 계산을 아무도 검사하지 않게 된다.
    const { m, t, p } = golden.contract.defaultKdf;
    assert.ok(golden.vectors.some((v) => v.m === m && v.t === t && v.p === p));
  });

  it("조각마다 진행을 보고하고 양보한다", async () => {
    const ticks = [];
    let pauses = 0;
    await argon2id({
      password: utf8("pw"),
      salt: new Uint8Array(16),
      memory: 64,
      passes: 2,
      lanes: 2,
      tagLength: 32,
      onProgress: (done, total) => ticks.push([done, total]),
      pause: async () => {
        pauses += 1;
      },
    });
    // 레인 2 × 슬라이스 4 × 패스 2 = 16 조각.
    assert.equal(pauses, 16);
    const total = ticks[0][1];
    assert.equal(total, 2 * 64);
    for (let i = 1; i < ticks.length; i += 1) assert.ok(ticks[i][0] >= ticks[i - 1][0]);
    assert.deepEqual(ticks.at(-1), [total, total], "끝에서 100% 에 닿아야 한다");
  });

  it("Rust 가 거절하는 파라미터는 계산하지 않고 거절한다", async () => {
    // 조용히 고쳐 계산하면 두 구현이 다른 키를 내고, 그 실패는 "키가 틀렸다" 로만 보인다.
    const base = { password: utf8("pw"), salt: new Uint8Array(16), passes: 1, lanes: 1, tagLength: 32, pause: now };
    await assert.rejects(argon2id({ ...base, memory: 7 }), RangeError); // 8·레인 미만
    await assert.rejects(argon2id({ ...base, memory: 64, lanes: 0 }), RangeError);
    await assert.rejects(argon2id({ ...base, memory: 64, passes: 0 }), RangeError);
    await assert.rejects(argon2id({ ...base, memory: 64, salt: new Uint8Array(7) }), RangeError);
  });
});
