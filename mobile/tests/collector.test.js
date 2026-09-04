// collector.js 를 카메라 없이 검증한다.
//
//   npm test
//
// 픽스처는 `src-tauri/src/armor.rs` 의 `pieces()` 를 자바스크립트로 그대로 옮겨 만든다 —
// 손으로 적은 예시가 아니라 같은 계산이라, 조각 경계와 표시 위치가 실제 출력과 어긋나지 않는다.
// Rust 쪽이 바뀌면 `src-tauri/tests/piece_format.rs` 가 먼저 깨져서 알려 준다.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BEGIN_MARKER,
  END_MARKER,
  MAX_PIECES,
  addPiece,
  createCollection,
  isComplete,
  joinCollection,
  missingIndices,
  parsePiece,
} from "../www/collector.js";

// ---------------------------------------------------------------- 픽스처

/** `armor::pieces()` 와 같은 조각 나누기. */
function makePieces(body, parts) {
  // Rust: body.len().div_ceil(parts.max(1)).next_multiple_of(4).max(4)
  const wanted = Math.ceil(body.length / Math.max(parts, 1));
  const per = Math.max(4, wanted % 4 === 0 ? wanted : wanted + (4 - (wanted % 4)));

  const slices = [];
  if (body.length === 0) {
    slices.push("");
  } else {
    for (let at = 0; at < body.length; at += per) slices.push(body.slice(at, at + per));
  }
  const total = slices.length;

  return slices.map((slice, at) => {
    let out = "";
    if (at === 0) out += `${BEGIN_MARKER}\n`;
    out += `#${at + 1}/${total}\n`;
    out += slice;
    out += "\n";
    if (at + 1 === total) out += `${END_MARKER}\n`;
    return out;
  });
}

/** `armor::wrap_single_line()` — 한 장에 다 들어간 경우. 순서 표시가 없다. */
const wrapSingleLine = (body) => `${BEGIN_MARKER}\n${body}\n${END_MARKER}\n`;

/** 결정적인 Base64 본문. 길이는 4의 배수로 둔다 (armor 본문이 늘 그렇다). */
function makeBody(length) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let at = 0; at < length; at += 1) out += alphabet[(at * 7 + 3) % alphabet.length];
  return out;
}

/** 조각을 순서대로 다 넣는다. */
function collectAll(pieces) {
  const collection = createCollection();
  for (const piece of pieces) addPiece(collection, piece);
  return collection;
}

// ---------------------------------------------------------------- 픽스처 자체 검증

describe("픽스처", () => {
  it("armor::pieces() 와 같은 모양을 만든다", () => {
    const pieces = makePieces(makeBody(300), 3);

    assert.equal(pieces.length, 3);
    assert.ok(pieces[0].startsWith(`${BEGIN_MARKER}\n#1/3\n`));
    assert.ok(pieces[1].startsWith("#2/3\n"));
    assert.ok(pieces[2].endsWith(`${END_MARKER}\n`));
    // 시작 표시는 1번 장에만, 끝 표시는 마지막 장에만.
    assert.ok(!pieces[1].includes(BEGIN_MARKER));
    assert.ok(!pieces[1].includes(END_MARKER));
    assert.ok(!pieces[0].includes(END_MARKER));
  });

  it("4자 정렬 때문에 요청보다 적게 나올 수 있다", () => {
    // 본문 8자를 4조각으로 나누라고 하면 per=4 가 되어 2조각만 나온다. `/N` 에는 실제 개수가 적힌다.
    const pieces = makePieces(makeBody(8), 4);
    assert.equal(pieces.length, 2);
    assert.ok(pieces[0].includes("#1/2\n"));
  });
});

// ---------------------------------------------------------------- parsePiece

describe("parsePiece", () => {
  it("가운데 장은 시작·끝 표시 없이 순서 표시만 있다", () => {
    const parsed = parsePiece("#2/3\nQUFB\n");
    assert.deepEqual(parsed, {
      ok: true,
      index: 2,
      total: 3,
      body: "QUFB",
      hasBegin: false,
      hasEnd: false,
    });
  });

  it("표시 없는 한 장 컨테이너를 1/1 로 읽는다", () => {
    const body = makeBody(120);
    const parsed = parsePiece(wrapSingleLine(body));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.index, 1);
    assert.equal(parsed.total, 1);
    assert.equal(parsed.body, body);
    assert.equal(parsed.hasBegin, true);
    assert.equal(parsed.hasEnd, true);
  });

  it("CRLF 로 읽혀도 같게 해석한다", () => {
    const lf = parsePiece("#2/3\nQUFB\n");
    const crlf = parsePiece("#2/3\r\nQUFB\r\n");
    assert.deepEqual(crlf, lf);
  });

  it("줄바꿈이 사라져 뭉쳐도 본문을 잃지 않는다", () => {
    // armor.rs 가 관용을 두는 바로 그 경우 (`...AbCd#2/3RkZG...`).
    const parsed = parsePiece("#2/3QUFB");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.body, "QUFB");
  });

  it("우리 QR 이 아니면 not-packer", () => {
    assert.deepEqual(parsePiece("https://example.com"), { ok: false, reason: "not-packer" });
    assert.deepEqual(parsePiece("WIFI:S:home;T:WPA;P:secret;;"), {
      ok: false,
      reason: "not-packer",
    });
    assert.deepEqual(parsePiece(""), { ok: false, reason: "not-packer" });
    assert.deepEqual(parsePiece(undefined), { ok: false, reason: "not-packer" });
  });

  it("시작 표시만 있고 순서 표시가 없으면 damaged", () => {
    assert.deepEqual(parsePiece(`${BEGIN_MARKER}\nQUFB\n`), { ok: false, reason: "damaged" });
    assert.deepEqual(parsePiece(`QUFB\n${END_MARKER}\n`), { ok: false, reason: "damaged" });
  });

  it("본문에 Base64 아닌 글자가 섞이면 damaged", () => {
    assert.deepEqual(parsePiece("#2/3\nQUF*\n"), { ok: false, reason: "damaged" });
    // 표시를 하나 떼어 낸 뒤에도 `#` 가 남으면 여기서 걸린다 — `#` 는 본문 글자가 아니다.
    // (심볼 두 개를 한꺼번에 찍은 경우)
    assert.deepEqual(parsePiece("#2/3\nQUFB#3/3\nQkJC\n"), { ok: false, reason: "damaged" });
  });

  it("마지막이 아닌 조각의 본문이 4의 배수가 아니면 unaligned", () => {
    assert.deepEqual(parsePiece("#2/3\nQUF\n"), { ok: false, reason: "unaligned" });
    // 마지막 장은 예외다 — 여기서 `=` 채움이 끝나므로 4의 배수가 아닐 수 있다.
    assert.equal(parsePiece(`#3/3\nQUF=\n${END_MARKER}\n`).ok, true);
  });

  it("말이 안 되는 순번은 range", () => {
    assert.deepEqual(parsePiece("#4/3\nQUFB\n"), { ok: false, reason: "range" });
    assert.deepEqual(parsePiece("#0/3\nQUFB\n"), { ok: false, reason: "range" });
    assert.deepEqual(parsePiece(`#1/${MAX_PIECES + 1}\nQUFB\n`), { ok: false, reason: "range" });
  });
});

// ---------------------------------------------------------------- 모으기

describe("addPiece", () => {
  it("처음 보는 순번은 added, 전체 장수를 알려 준다", () => {
    const collection = createCollection();
    const result = addPiece(collection, makePieces(makeBody(300), 3)[1]);

    assert.equal(result.status, "added");
    assert.equal(result.index, 2);
    assert.equal(result.total, 3);
    assert.equal(collection.total, 3);
  });

  it("같은 장을 20번 넣어도 상태가 그대로다", () => {
    const pieces = makePieces(makeBody(300), 3);
    const collection = createCollection();

    assert.equal(addPiece(collection, pieces[0]).status, "added");
    for (let at = 0; at < 20; at += 1) {
      const result = addPiece(collection, pieces[0]);
      assert.equal(result.status, "duplicate");
      assert.equal(result.index, 1);
    }
    assert.equal(collection.pieces.size, 1);
    assert.deepEqual(missingIndices(collection), [2, 3]);
  });

  it("전체 장수가 다른 조각은 conflict", () => {
    const collection = createCollection();
    addPiece(collection, "#1/3\nQUFB\n"); // 시작 표시가 없으니 rejected 지만 total 도 안 정해진다
    assert.equal(collection.total, null);

    addPiece(collection, makePieces(makeBody(300), 3)[1]);
    const result = addPiece(collection, "#2/5\nQUFB\n");
    assert.equal(result.status, "conflict");
    assert.equal(result.reason, "total");
  });

  it("장수는 같은데 조각 크기가 다른 컨테이너는 conflict", () => {
    // 크기가 다른 두 파일이 우연히 같은 장수로 나뉜 경우. 순번만 보면 알 수 없다.
    const mine = makePieces(makeBody(300), 3); // per = 100
    const other = makePieces(makeBody(360), 3); // per = 120

    const collection = createCollection();
    assert.equal(addPiece(collection, mine[0]).status, "added");
    assert.equal(collection.chunkLength, 100);

    const result = addPiece(collection, other[1]);
    assert.equal(result.status, "conflict");
    assert.equal(result.reason, "chunk");
    assert.equal(collection.pieces.size, 1);
  });

  it("마지막 장이 조각 크기보다 길면 conflict", () => {
    const collection = createCollection();
    addPiece(collection, makePieces(makeBody(300), 3)[1]); // per = 100
    const result = addPiece(collection, `#3/3\n${makeBody(104)}\n${END_MARKER}\n`);
    assert.equal(result.status, "conflict");
    assert.equal(result.reason, "chunk");
  });

  it("같은 순번인데 내용이 다르면 conflict", () => {
    const collection = createCollection();
    addPiece(collection, "#2/3\nQUFB\n");
    const result = addPiece(collection, "#2/3\nQkJC\n");
    assert.equal(result.status, "conflict");
    assert.equal(result.reason, "body");
    // 먼저 들어온 것을 덮어쓰지 않는다.
    assert.equal(collection.pieces.get(2).body, "QUFB");
  });

  it("1번 장에 시작 표시가 없으면 rejected(structure)", () => {
    const collection = createCollection();
    const result = addPiece(collection, "#1/3\nQUFB\n");
    assert.equal(result.status, "rejected");
    assert.equal(result.reason, "structure");
    assert.equal(collection.pieces.size, 0);
  });

  it("마지막 장에 끝 표시가 없으면 rejected(structure)", () => {
    const collection = createCollection();
    const result = addPiece(collection, "#3/3\nQUFB\n");
    assert.equal(result.status, "rejected");
    assert.equal(result.reason, "structure");
  });

  it("우리 것이 아닌 QR 은 상태를 건드리지 않는다", () => {
    const pieces = makePieces(makeBody(300), 3);
    const collection = collectAll([pieces[0], pieces[1]]);
    const before = collection.pieces.size;

    assert.equal(addPiece(collection, "https://example.com").status, "rejected");
    assert.equal(collection.pieces.size, before);
    assert.equal(collection.total, 3);
  });
});

// ---------------------------------------------------------------- 합치기

describe("joinCollection", () => {
  it("뒤섞인 순서로 찍어도 올바르게 합쳐진다", () => {
    const body = makeBody(300);
    const pieces = makePieces(body, 3);

    // 데스크톱 뷰어는 순서대로 넘기게 되어 있지만, 앱은 순번을 알고 있으니 순서가 필요 없다.
    const collection = collectAll([pieces[2], pieces[0], pieces[1]]);

    assert.equal(isComplete(collection), true);
    assert.equal(joinCollection(collection), wrapSingleLine(body));
  });

  it("합친 결과에는 순서 표시가 하나도 없다", () => {
    const pieces = makePieces(makeBody(1200), 5);
    const joined = joinCollection(collectAll(pieces));

    assert.ok(!joined.includes("#"));
    // 시작 표시는 자기 줄에 혼자 있어야 한다 (`armor::looks_armored`).
    assert.equal(joined.split("\n")[0], BEGIN_MARKER);
    assert.ok(joined.endsWith(`\n${END_MARKER}\n`));
  });

  it("표시 없는 한 장 컨테이너는 넣는 즉시 완성이고 원문 그대로 나온다", () => {
    const body = makeBody(2884);
    const single = wrapSingleLine(body);

    const collection = createCollection();
    assert.equal(addPiece(collection, single).status, "added");
    assert.equal(isComplete(collection), true);
    assert.equal(joinCollection(collection), single);
  });

  it("상한 16장까지 합쳐진다", () => {
    const body = makeBody(MAX_PIECES * 2880);
    const pieces = makePieces(body, MAX_PIECES);

    assert.equal(pieces.length, MAX_PIECES);
    assert.equal(joinCollection(collectAll(pieces)), wrapSingleLine(body));
  });

  it("다 모이기 전에는 던진다", () => {
    const pieces = makePieces(makeBody(300), 3);
    const collection = collectAll([pieces[0], pieces[2]]);

    assert.equal(isComplete(collection), false);
    assert.deepEqual(missingIndices(collection), [2]);
    assert.throws(() => joinCollection(collection), /다 모이지 않았습니다/);
  });

  it("전체 장수를 모르면 남은 순번도 모른다", () => {
    assert.deepEqual(missingIndices(createCollection()), []);
    assert.equal(isComplete(createCollection()), false);
  });
});
