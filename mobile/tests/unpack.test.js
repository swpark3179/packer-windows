// unpack.js — 모은 컨테이너를 이 폰에서 풀어내는 파이프라인.
//
//   npm test
//
// **의존성이 없어서 `npm install` 없이도 돌아간다.** `unpack.js` 는 파일을 직접 쓰지 않고 넘겨받은
// 싱크에 쓰므로, 여기서는 메모리 싱크를 넘긴다.
//
// 입력은 Rust 가 만든 골든 픽스처다 (`src-tauri/tests/unpack_format.rs`). 그쪽은 같은 픽스처가
// 데스크톱의 풀기로 **같은 파일**이 되는지 보고, 여기는 폰이 그대로 따라 하는지 본다. 픽스처의
// 컨테이너는 실제 묶기와 같은 길(직렬화 → zstd 6 → AES-256-GCM → Base64)을 지났고, 청크를 4 KiB 로
// 잘게 잘라 청크 번호와 `last` 플래그를 넘기는 길까지 밟는다.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { Sha256, sha256 } from "../www/sha256.js";
import {
  WRITE_BYTES,
  bytesFromArmor,
  checkRelPath,
  decodeManifest,
  unpackContainer,
} from "../www/unpack.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const golden = JSON.parse(
  fs.readFileSync(path.join(root, "tests", "fixtures", "unpack-container.json"), "utf8"),
);
const PASSWORD = golden.password;

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const nodeSha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const now = async () => {};

/// 메모리 싱크. 호출 순서와 조각 크기까지 남긴다.
function memorySink() {
  const files = new Map();
  const dirs = [];
  const writes = [];
  return {
    files,
    dirs,
    writes,
    async makeDir(rel) {
      dirs.push(rel);
    },
    async writeFile(rel, bytes, append) {
      writes.push({ rel, length: bytes.length, append });
      const before = append ? files.get(rel) : new Uint8Array(0);
      assert.ok(before, `${rel}: 첫 쓰기 없이 이어 쓰기가 왔다`);
      const next = new Uint8Array(before.length + bytes.length);
      next.set(before);
      next.set(bytes, before.length);
      files.set(rel, next);
    },
  };
}

const unpack = (overrides = {}) =>
  unpackContainer({ source: golden.armor, passphrase: PASSWORD, sink: memorySink(), pause: now, ...overrides });

/// 픽스처의 컨테이너 바이트를 고친 armor 로 다시 감싼다.
function rearmor(edit) {
  const bytes = bytesFromArmor(golden.armor);
  edit(bytes);
  return `-----BEGIN PACKER CONTAINER-----\n${Buffer.from(bytes).toString("base64")}\n-----END PACKER CONTAINER-----\n`;
}

describe("SHA-256 — 조금씩 먹이기", () => {
  it("한 번에 넣은 것과 나눠 넣은 것이 같다", () => {
    const bytes = Uint8Array.from({ length: 5_000 }, (_, i) => (i * 31 + 7) & 255);
    for (const step of [1, 3, 63, 64, 65, 1000]) {
      const hasher = new Sha256();
      for (let at = 0; at < bytes.length; at += step) hasher.update(bytes.subarray(at, at + step));
      assert.equal(hex(hasher.digest()), nodeSha(bytes), `step=${step}`);
    }
  });

  it("빈 입력과 패딩 경계(55·56·64바이트)", () => {
    for (const length of [0, 55, 56, 63, 64, 119, 120]) {
      const bytes = new Uint8Array(length).fill(0x61);
      assert.equal(hex(sha256(bytes)), nodeSha(bytes), `length=${length}`);
    }
  });
});

describe("벤더링한 zstd 디코더", () => {
  it("배포본 그대로다", () => {
    // 위의 머리말을 뺀 본문이 `vendor/fzstd.js` 에 적어 둔 원본 해시와 같아야 한다. 손으로 고친
    // 줄이 섞이면 다음에 올릴 때 조용히 사라진다.
    const text = fs.readFileSync(path.join(root, "www", "vendor", "fzstd.js"), "utf8");
    const [head, body] = text.split(/\n\n(.*)/s);
    const recorded = /sha256\s+([0-9a-f]{64})/.exec(head)?.[1];
    assert.ok(recorded, "머리말에 원본 해시가 없다");
    assert.equal(nodeSha(Buffer.from(body, "utf8")), recorded);
  });
});

describe("풀기 — 골든 픽스처", () => {
  it("데스크톱이 푸는 것과 같은 파일이 나온다", async () => {
    const sink = memorySink();
    const report = await unpack({ sink });

    assert.deepEqual(report, {
      fileCount: golden.report.fileCount,
      dirCount: golden.report.dirCount,
      totalBytes: golden.report.totalBytes,
      skipped: [],
      hashMismatch: [],
    });
    for (const entry of golden.entries) {
      if (entry.kind === "dir") {
        assert.ok(sink.dirs.includes(entry.path), `${entry.path} 폴더가 없다`);
        continue;
      }
      const bytes = sink.files.get(entry.path);
      assert.ok(bytes, `${entry.path} 가 없다`);
      assert.equal(bytes.length, entry.size, entry.path);
      assert.equal(nodeSha(bytes), entry.sha256, entry.path);
    }
    assert.equal(sink.files.size, golden.entries.filter((e) => e.kind === "file").length);
  });

  it("스트림 모드가 복원한 바이트를 그대로 받아도 같다", async () => {
    // 스트림 모드는 Base64 를 벗긴 원시 바이트를 들고 있다. 다시 감쌌다 벗길 이유가 없다.
    const sink = memorySink();
    const report = await unpack({ source: bytesFromArmor(golden.armor), sink });
    assert.equal(report.fileCount, golden.report.fileCount);
    assert.equal(nodeSha(sink.files.get("메모.txt")), golden.entries.at(-1).sha256);
  });

  it("빈 파일도 만든다", async () => {
    const sink = memorySink();
    await unpack({ sink });
    assert.equal(sink.files.get("프로젝트/빈 파일.txt")?.length, 0);
  });

  it("큰 파일은 정해진 크기로 나눠 쓰고, 첫 조각만 새로 쓴다", async () => {
    const sink = memorySink();
    await unpack({ sink });
    const pieces = sink.writes.filter((w) => w.rel === "프로젝트/data/repeat.bin");
    assert.ok(pieces.length > 3, `조각이 너무 적다: ${pieces.length}`);
    assert.equal(pieces[0].append, false);
    assert.ok(pieces.slice(1).every((w) => w.append));
    assert.ok(pieces.every((w) => w.length <= WRITE_BYTES));
  });

  it("두 단계로 진행을 보고하고, 풀어내기는 원래 파일의 총량에 닿는다", async () => {
    const phases = [];
    const ticks = [];
    await unpack({
      onPhase: (phase) => {
        phases.push(phase);
        ticks.length = 0;
      },
      onProgress: (done, total) => ticks.push([done, total]),
    });
    assert.deepEqual(phases, ["key", "unpack"]);
    // 매니페스트를 읽기 전에는 총량을 모른다 — 0 으로 시작해 막대가 훑고 지나가는 모양이 된다.
    assert.deepEqual(ticks[0], [0, 0]);
    assert.deepEqual(ticks.at(-1), [golden.report.totalBytes, golden.report.totalBytes]);
  });
});

describe("풀기 — 남이 만든 컨테이너", () => {
  it("폴더 밖으로 나가는 경로는 데스크톱과 같은 문구로 건너뛰고, 뒤의 파일은 멀쩡하다", async () => {
    const sink = memorySink();
    const report = await unpack({ source: golden.hostile.armor, sink });

    assert.deepEqual(report.skipped, golden.hostile.skipped);
    assert.deepEqual(report.hashMismatch, golden.hostile.hashMismatch);
    assert.deepEqual([...sink.files.keys()].sort(), ["bad-hash.txt", "safe.txt"]);
    assert.deepEqual(sink.dirs, ["ok"]);
    assert.equal(Buffer.from(sink.files.get("safe.txt")).toString(), "GOOD");
  });
});

describe("풀기 — 실패를 구분해 말한다", () => {
  it("암호가 틀리면 키가 틀렸다고 말한다 — 손상과 섞지 않는다", async () => {
    await assert.rejects(unpack({ passphrase: "열려라 참깨 2026" }), { code: "WrongKey" });
  });

  it("암호를 비우면 계산을 시작하지도 않는다", async () => {
    await assert.rejects(unpack({ passphrase: "" }), { code: "EmptyKey" });
  });

  it("암호문을 한 바이트 고치면 손상으로 본다", async () => {
    const source = rearmor((bytes) => {
      bytes[200] ^= 0x01;
    });
    await assert.rejects(unpack({ source }), { code: "Corrupted" });
  });

  it("마지막 청크를 잘라내면 잘린 것으로 본다", async () => {
    const full = bytesFromArmor(golden.armor);
    const source = full.subarray(0, full.length - 40);
    await assert.rejects(unpack({ source }), { code: "Corrupted" });
  });

  it("헤더의 예약 바이트를 고쳐도 인증에서 걸린다", async () => {
    // AAD 가 파일에 있던 96바이트 그대로라서다. 파싱한 필드로 다시 만들면 이 검사가 빠진다.
    const source = rearmor((bytes) => {
      bytes[13] ^= 0xff;
    });
    await assert.rejects(unpack({ source }), { code: "Corrupted" });
  });

  it("첫 청크에 종료 플래그를 세우면 인증에서 걸린다", async () => {
    const source = rearmor((bytes) => {
      bytes[96 + 4] = 1;
    });
    await assert.rejects(unpack({ source }), { code: "Corrupted" });
  });

  it("더 새로운 형식이면 업데이트하라고 말한다", async () => {
    const source = rearmor((bytes) => {
      bytes[8] = 2;
    });
    await assert.rejects(unpack({ source }), { code: "UnsupportedVersion", message: /버전\(2\)/ });
  });

  it("터무니없는 키 유도 비용을 요구하면 메모리를 잡기 전에 거절한다", async () => {
    const source = rearmor((bytes) => {
      new DataView(bytes.buffer, bytes.byteOffset).setUint32(48, 0xffffffff, true);
    });
    await assert.rejects(unpack({ source }), { code: "Corrupted" });
  });

  it("우리 컨테이너가 아니면 그렇게 말한다", async () => {
    await assert.rejects(unpack({ source: "그냥 글" }), { code: "NotContainer" });
    const zip = rearmor((bytes) => bytes.set([0x50, 0x4b, 0x03, 0x04], 0));
    await assert.rejects(unpack({ source: zip }), { code: "NotContainer" });
  });

  it("Base64 가 깨졌으면 텍스트가 온전하지 않다고 말한다", async () => {
    const broken = golden.armor.replace(/\n([A-Za-z0-9+/]{8})/, "\n$1#");
    await assert.rejects(unpack({ source: broken }), { code: "ArmorDamaged" });
  });
});

describe("경로 검사 — safepath.rs 와 같은 판단", () => {
  const ok = (rel) => checkRelPath(rel).ok;
  const why = (rel) => checkRelPath(rel).reason;

  it("평범한 경로와 한글 이름은 받는다", () => {
    assert.ok(ok("note.txt"));
    assert.ok(ok("proj/src/main.rs"));
    assert.ok(ok("보고서/2026년 계획.xlsx"));
    assert.ok(ok("emoji/🔒.txt"));
    assert.ok(ok("CONSOLE.txt"));
    assert.ok(ok("COM10.txt"));
  });

  it("빠져나가는 경로는 막는다 — 문구까지 같다", () => {
    assert.equal(why("../evil.txt"), "../evil.txt (상대 경로 이동)");
    assert.equal(why("a/./b"), "a/./b (상대 경로 이동)");
    assert.equal(why("/etc/passwd"), "/etc/passwd (절대 경로)");
    assert.equal(why("C:/Windows/evil.dll"), "C:/Windows/evil.dll (사용할 수 없는 문자)");
    assert.equal(why("..\\..\\evil.txt"), "..\\..\\evil.txt (사용할 수 없는 문자)");
    assert.equal(why("a//b"), "a//b (빈 경로 조각)");
    assert.equal(why(""), " (빈 경로)");
    assert.equal(why("a\0b"), "a\0b (NUL 문자 포함)");
  });

  it("윈도우의 함정도 막는다 — 풀어낸 파일은 결국 PC 로 건너가기 쉽다", () => {
    assert.match(why("CON"), /예약된 장치 이름/);
    assert.match(why("dir/nul.txt"), /예약된 장치 이름/);
    assert.match(why("normal.txt:hidden"), /사용할 수 없는 문자/);
    assert.match(why("weird."), /끝에 점이나 공백/);
    assert.match(why("weird "), /끝에 점이나 공백/);
    assert.match(why("bell\u0007.txt"), /제어 문자 포함/);
    assert.match(why(`${"가".repeat(86)}.txt`), /이름이 너무 김/); // 86×3 + 4 = 262 바이트
  });

  it("대문자로 바꿀 때 ASCII 만 바꾼다 — Rust 의 to_ascii_uppercase 와 같게", () => {
    // `"ſ".toUpperCase()` 는 "S" 다. 유니코드 규칙으로 올리면 Rust 가 받는 이름을 거절하게 된다.
    assert.ok(ok("ſ.txt"));
  });
});

describe("bincode 2 — 가변 길이 정수", () => {
  it("250 을 넘는 값은 표지 뒤에 리틀 엔디언으로 읽는다", () => {
    // version 1 · created 0 · 항목 1개 · 경로 길이 251 (표지 251 + u16) · File · 크기 70000
    // (표지 252 + u32) · mtime 0
    const name = "a".repeat(251);
    const bytes = Uint8Array.from([
      1, 0, 1,
      251, 251, 0, ...Buffer.from(name),
      1,
      252, 0x70, 0x11, 0x01, 0x00,
      0,
    ]);
    assert.deepEqual(decodeManifest(bytes), {
      version: 1,
      entries: [{ path: name, kind: "file", size: 70_000 }],
    });
  });

  it("타입보다 큰 표지나 모르는 종류는 손상으로 본다", () => {
    // u16 자리(version)에 u32 표지.
    assert.throws(() => decodeManifest(Uint8Array.from([252, 1, 0, 0, 0, 0, 0])), { code: "Corrupted" });
    // Kind 의 변형 번호 2.
    assert.throws(() => decodeManifest(Uint8Array.from([1, 0, 1, 1, 0x61, 2, 0, 0])), { code: "Corrupted" });
    // 중간에 끊긴 매니페스트.
    assert.throws(() => decodeManifest(Uint8Array.from([1, 0, 1, 5, 0x61])), { code: "Corrupted" });
  });
});
