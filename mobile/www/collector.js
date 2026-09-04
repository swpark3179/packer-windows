// QR 조각을 모아 하나의 컨테이너 텍스트로 합치는 로직.
//
// 이 파일은 **의존성이 없다** — DOM 도, Capacitor 도 모른다. 카메라에서 읽어낸 문자열만 받고
// 문자열만 돌려준다. 그래서 기기 없이 `node --test` 로 전부 검증된다 (`tests/collector.test.js`).
// 앱의 실제 내용은 여기 다 있고, `app.js` 는 이걸 화면과 카메라에 잇는 배선일 뿐이다.
//
// 입력 형식은 데스크톱 쪽 `src-tauri/src/armor.rs` 가 정한다. 3장으로 나뉜 경우:
//
//   1번 장   -----BEGIN PACKER CONTAINER-----\n#1/3\n<base64>\n
//   2번 장   #2/3\n<base64>\n
//   3번 장   #3/3\n<base64>\n-----END PACKER CONTAINER-----\n
//
// **한 장에 다 들어가면 `#1/1` 표시가 아예 없다** (`armor::wrap_single_line`). 두 모양을 모두
// 받아야 한다. 이 가정은 `src-tauri/tests/piece_format.rs` 계약 테스트가 지켜 준다.

export const BEGIN_MARKER = "-----BEGIN PACKER CONTAINER-----";
export const END_MARKER = "-----END PACKER CONTAINER-----";

/// 조각 수 상한. `qr.rs` 의 `MAX_PIECES` 와 같은 값이다 (QR 규격의 Structured Append 한계).
export const MAX_PIECES = 16;

/// armor 본문에 쓰이는 글자. `armor.rs` 의 `is_body_byte()` 와 같다.
///
/// **`#` 이 여기 없다는 게 파서의 핵심 근거다.** 그래서 `#` 를 찾는 것만으로 순서 표시를
/// 본문과 헷갈리지 않고 집어낼 수 있다. (`/` 는 Base64 글자라서 `/` 만으로는 안 된다.)
const BODY_PATTERN = /^[A-Za-z0-9+/=]*$/;

/// 순서 표시. 숫자는 Rust `read_piece_mark()` 와 같이 greedy 로 읽는다.
const PIECE_MARK_PATTERN = /#(\d+)\/(\d+)/;

/**
 * QR 한 장에서 읽어낸 텍스트를 조각으로 해석한다.
 *
 * @returns `{ ok: true, index, total, body, hasBegin, hasEnd }` 또는
 *   `{ ok: false, reason }` — `reason` 은
 *   `"not-packer"`(우리 QR 이 아니다) · `"damaged"`(우리 것 같은데 온전하지 않다) ·
 *   `"range"`(순번이 말이 안 된다).
 */
export function parsePiece(text) {
  if (typeof text !== "string") return { ok: false, reason: "not-packer" };

  const normalized = text.replace(/\r\n/g, "\n");
  const hasBegin = normalized.includes(BEGIN_MARKER);
  const hasEnd = normalized.includes(END_MARKER);

  // 시작·끝 표시를 먼저 떼어 낸다. 남은 것에서 순서 표시와 본문만 보면 된다.
  let rest = normalized.split(BEGIN_MARKER).join("").split(END_MARKER).join("");

  const mark = PIECE_MARK_PATTERN.exec(rest);
  let index;
  let total;

  if (mark) {
    index = Number(mark[1]);
    total = Number(mark[2]);
    rest = rest.slice(0, mark.index) + rest.slice(mark.index + mark[0].length);
  } else {
    // 표시가 없으면 한 장짜리 컨테이너여야 한다. 가운데 장(2/3 같은)은 시작·끝 표시가 둘 다
    // 없지만 순서 표시는 반드시 있으므로 여기로 오지 않는다.
    if (!hasBegin && !hasEnd) return { ok: false, reason: "not-packer" };
    if (!hasBegin || !hasEnd) return { ok: false, reason: "damaged" };
    index = 1;
    total = 1;
  }

  // 남은 글자에서 공백을 지운 것이 본문이다. 표시를 하나 떼어 낸 뒤에도 `#` 가 남아 있으면
  // (표시가 둘인 텍스트) Base64 검사에서 걸린다 — `#` 는 본문 글자가 아니다.
  const body = rest.replace(/\s+/g, "");
  if (!BODY_PATTERN.test(body)) {
    // 우리 표시를 하나라도 달고 있으면 "우리 것인데 깨졌다" 고 말해 주는 편이 낫다.
    return { ok: false, reason: mark || hasBegin || hasEnd ? "damaged" : "not-packer" };
  }

  if (index < 1 || total < 1 || index > total || total > MAX_PIECES) {
    return { ok: false, reason: "range" };
  }

  // `armor::pieces()` 는 본문을 4의 배수(`next_multiple_of(4)`)로 자르므로, 마지막이 아닌 조각의
  // 본문 길이는 늘 4의 배수다. 어긋나면 조각 하나가 잘려 들어온 것이다 — 여기서 잡지 않으면
  // Base64 정렬이 밀려 합친 뒤 복호화가 실패하고, 그때는 어느 장이 문제인지 알 수 없다.
  if (index < total && body.length % 4 !== 0) {
    return { ok: false, reason: "unaligned" };
  }

  return { ok: true, index, total, body, hasBegin, hasEnd };
}

/// 빈 수집 상태를 만든다. `total` 과 `chunkLength` 는 첫 조각을 받을 때 정해진다.
export function createCollection() {
  return { total: null, chunkLength: null, pieces: new Map() };
}

/**
 * 조각 하나를 수집 상태에 넣는다. `collection` 을 제자리에서 고친다.
 *
 * @returns `{ status, index?, total?, reason? }` — `status` 는
 *   `"added"`(처음 보는 순번) · `"duplicate"`(이미 있고 내용도 같다) ·
 *   `"conflict"`(다른 컨테이너가 섞였다) · `"rejected"`(조각으로 읽을 수 없다).
 */
export function addPiece(collection, text) {
  const parsed = parsePiece(text);
  if (!parsed.ok) return { status: "rejected", reason: parsed.reason };

  const { index, total, body, hasBegin, hasEnd } = parsed;

  // `armor::pieces()` 는 1번 장에만 시작 표시를, 마지막 장에만 끝 표시를 붙인다. 어긋나면
  // 우리 writer 가 만든 조각이 아니다 — 조용히 받아 두면 합친 뒤 한참 지나 GCM 인증 실패로만
  // 드러나고, 그때는 원인을 짚어 줄 수 없다.
  if ((index === 1) !== hasBegin || (index === total) !== hasEnd) {
    return { status: "rejected", reason: "structure" };
  }

  if (collection.total !== null && collection.total !== total) {
    return { status: "conflict", reason: "total", index, total };
  }

  // 장수가 우연히 같은 **다른** 컨테이너를 섞어 찍는 경우를 여기서 잡는다. `armor::pieces()` 는
  // 모든 조각을 똑같이 `per` 자로 자르므로(마지막 장만 그보다 짧다), 마지막이 아닌 조각의 길이는
  // 한 컨테이너 안에서 전부 같다. 크기가 다른 파일을 묶으면 이 값이 달라진다.
  //
  // 이걸 놓치면 순번은 다 채워졌는데 합친 텍스트가 PC 에서 GCM 인증 실패로만 나타난다 —
  // 사용자는 한참 뒤에, 원인을 알 수 없는 채로 처음부터 다시 찍어야 한다.
  if (collection.chunkLength !== null) {
    const tooLong = index === total && body.length > collection.chunkLength;
    const wrongSize = index < total && body.length !== collection.chunkLength;
    if (tooLong || wrongSize) {
      return { status: "conflict", reason: "chunk", index, total };
    }
  }

  const seen = collection.pieces.get(index);
  if (seen) {
    // 연속 스캔은 같은 심볼을 초당 여러 번 읽는다. 같은 내용이면 아무 일도 없었던 것처럼
    // 넘어가야 한다 — 여기서 화면이 깜빡이거나 진동이 울리면 쓸 수 없는 앱이 된다.
    if (seen.body === body) return { status: "duplicate", index, total };
    return { status: "conflict", reason: "body", index, total };
  }

  collection.total = total;
  if (index < total) collection.chunkLength = body.length;
  collection.pieces.set(index, { body, hasBegin, hasEnd });
  return { status: "added", index, total };
}

/// 아직 못 읽은 순번을 오름차순으로. 전체 장수를 모르면 빈 배열이다.
export function missingIndices(collection) {
  if (collection.total === null) return [];
  const missing = [];
  for (let index = 1; index <= collection.total; index += 1) {
    if (!collection.pieces.has(index)) missing.push(index);
  }
  return missing;
}

/// 전체 장수를 알고, 그만큼 다 모였는지.
export function isComplete(collection) {
  return collection.total !== null && collection.pieces.size === collection.total;
}

/**
 * 순서 표시를 떼고 하나의 컨테이너 텍스트로 합친다.
 *
 * 스캔해 온 시작·끝 표시를 재사용하지 않고 직접 붙인다. 결과가 `armor::wrap_single_line()` 과
 * 바이트 단위로 같아지고, `looks_armored()` 가 요구하는 "시작 표시만 있는 줄" 조건도 만족한다.
 *
 * 표시를 남기지 않는 것이 안전한 이유: `armor::verify_pieces()` 는 표시가 하나도 없으면 곧바로
 * 통과시키지만, 하나라도 남으면 1..N 이 빠짐없이 순서대로 있어야 `PieceOrder` 를 피한다. 떼어
 * 내는 편이 실패할 수 있는 경로가 하나 적다.
 */
export function joinCollection(collection) {
  if (!isComplete(collection)) {
    throw new Error("조각이 다 모이지 않았습니다.");
  }
  let body = "";
  for (let index = 1; index <= collection.total; index += 1) {
    body += collection.pieces.get(index).body;
  }
  return `${BEGIN_MARKER}\n${body}\n${END_MARKER}\n`;
}
