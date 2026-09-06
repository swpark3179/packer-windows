// armor.js 를 검증한다.
//
//   npm test
//
// **의존성이 없어서 `npm install` 없이도 돌아간다.**
//
// 지켜야 하는 계약은 하나다: 결과가 Rust 의 `armor::wrap_single_line()` 과 **바이트 단위로
// 같다.** 그래야 스트림 모드가 내놓는 `.txt` 가 조각 모드의 것과 구별되지 않고, PC 의 풀기
// 탭이 두 경우를 똑같이 받는다.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";

import { BEGIN_MARKER, END_MARKER, armorFromBytes } from "../www/armor.js";

/// 참조 구현. Node 의 Base64 는 표준이라 이것과 어긋나면 우리 쪽이 틀린 것이다.
const reference = (bytes) =>
  `${BEGIN_MARKER}\n${Buffer.from(bytes).toString("base64")}\n${END_MARKER}\n`;

const bytes = (len) => Uint8Array.from({ length: len }, (_, i) => (i * 251 + Math.floor(i / 97)) % 256);

describe("armorFromBytes", () => {
  it("길이 경계마다 표준 Base64 와 같다", async () => {
    // 3바이트 묶음 경계(채움 `=` 이 생기는 자리)를 모두 지나가 본다.
    for (const len of [0, 1, 2, 3, 4, 5, 6, 57, 1000, 60 * 1024, 60 * 1024 + 1, 60 * 1024 + 2]) {
      assert.equal(await armorFromBytes(bytes(len)), reference(bytes(len)), `len=${len}`);
    }
  });

  it("조각 경계에서 채움 문자가 끼어들지 않는다", async () => {
    // 나눠 도는 단위가 3의 배수가 아니면 조각마다 `=` 가 생겨 본문이 통째로 망가진다.
    // 채움은 **맨 끝에만** 있어야 한다 (마지막 조각의 남은 1~2바이트).
    const payload = bytes(200 * 1024);
    const body = (await armorFromBytes(payload)).split("\n")[1];

    const firstPad = body.indexOf("=");
    if (firstPad !== -1) {
      assert.ok(firstPad >= body.length - 2, `본문 ${firstPad}번째에 채움 문자가 있다`);
    }
    assert.equal(await armorFromBytes(payload), reference(payload));
  });

  it("조각을 여러 번 도는 크기에서도 표준과 같다", async () => {
    // STEP_BYTES(60 KiB)를 여러 번 넘기면서, 남는 바이트 수를 0·1·2 로 모두 지나가 본다.
    for (const len of [180 * 1024, 180 * 1024 + 1, 180 * 1024 + 2]) {
      assert.equal(await armorFromBytes(bytes(len)), reference(bytes(len)), `len=${len}`);
    }
  });

  it("wrap_single_line 과 같은 모양이다 — 세 줄", async () => {
    const lines = (await armorFromBytes(bytes(500))).split("\n");
    assert.equal(lines.length, 4, "끝에 줄바꿈 하나가 더 있다");
    assert.equal(lines[0], BEGIN_MARKER);
    assert.equal(lines[2], END_MARKER);
    assert.equal(lines[3], "");
  });

  it("진행률은 뒤로 가지 않고 총량에서 끝난다", async () => {
    const ticks = [];
    const payload = bytes(200 * 1024);
    await armorFromBytes(payload, (done, total) => ticks.push([done, total]));

    assert.ok(ticks.length >= 3, `${ticks.length}번만 보고했다`);
    let last = -1;
    for (const [done, total] of ticks) {
      assert.equal(total, payload.length);
      assert.ok(done >= last);
      last = done;
    }
    assert.deepEqual(ticks.at(-1), [payload.length, payload.length]);
  });
});
