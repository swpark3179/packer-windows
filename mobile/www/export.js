// 합친 텍스트를 파일로 내보낼 때 필요한 순수 계산 — 파일 이름 정리와 나눠 쓰기.
//
// `collector.js` 와 같은 규율이다: **의존성이 없다.** DOM 도, Capacitor 도, 시계도 모른다
// (`stamp()` 는 `Date` 를 인자로 받는다). 그래서 기기 없이 `node --test` 로 전부 검증된다
// (`tests/export.test.js`).
//
// 이 파일이 따로 있는 이유는 `collector.js` 를 건드리지 않기 위해서다. 저쪽은 "조각을 모아
// 합친다" 하나만 하고, 그 결과를 **어디에 어떤 이름으로** 두느냐는 다른 관심사다.

// ---------------------------------------------------------------- 파일 이름

/// 확장자를 뺀 이름의 최대 길이. 안드로이드·iOS 는 255바이트까지 받지만, 그만큼 긴 이름은
/// 공유 시트나 파일 목록에서 잘려 나와 어차피 읽을 수 없다.
export const MAX_NAME_LENGTH = 64;

/// 결과물은 텍스트라서 확장자도 텍스트로 둔다 (`commands.rs` 의 `CONTAINER_EXTENSION` 과 같다).
const EXTENSION = ".txt";

/// 윈도우에서 파일 이름으로 쓸 수 없는 글자. **PC 로 옮겨 가는 파일**이므로 폰 기준이 아니라
/// 윈도우 기준으로 막는다 — `src-tauri/src/safepath.rs` 와 같은 판단이다.
const FORBIDDEN = /[/\\:*?"<>|]/g;

/// 제어 문자. 파일 이름에 들어가면 도구마다 다르게 깨진다.
const CONTROL = /[\u0000-\u001f\u007f]/g;

/// 확장자가 붙어도 (`CON.txt`) 여전히 예약인 윈도우 장치 이름.
/// `safepath.rs` 의 `RESERVED_STEMS` 를 그대로 옮겼다.
const RESERVED_STEMS = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

/// `20260906-141530`. `Date` 를 받는 이유는 테스트가 시계를 고정할 수 있어야 하기 때문이다.
export function stamp(now = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

/// 사용자가 아무것도 고치지 않았을 때 쓰는 이름. 아래 `safeFileName` 의 주석과 같은 이유로
/// 기본값은 ASCII 로만 둔다.
export function defaultFileName(now = new Date()) {
  return `packer-${stamp(now)}${EXTENSION}`;
}

/**
 * 사용자가 적은 이름을 실제로 쓸 수 있는 파일 이름으로 고친다.
 *
 * 조용히 고치지 않고 **화면의 입력칸에 되돌려 적는다** (`app.js`). 저장 버튼을 눌렀는데 다른
 * 이름으로 나가면 나중에 파일을 못 찾는다.
 *
 * 공백을 밑줄로 바꾸는 데에는 안드로이드 쪽 이유가 하나 더 있다. 공유 시트의 MIME 판정이
 * `MimeTypeMap.getFileExtensionFromUrl()` 을 타는데, 그 정규식이 `[a-zA-Z_0-9.\-()%]` 밖의
 * 글자를 만나면 확장자를 못 찾고 모든 형식으로 떨어져 고를 수 있는 앱이 달라진다. 한글 이름은
 * 어차피 그렇게 되지만 막지 않는다 — 사용자가 고른 이름을 우리가 로마자로 바꿔 놓는 편이 더
 * 나쁘다.
 */
export function safeFileName(input, now = new Date()) {
  const fallback = defaultFileName(now);
  if (typeof input !== "string") return fallback;

  const name = input
    .replace(CONTROL, "")
    .replace(FORBIDDEN, "_")
    // 앞뒤의 점·공백을 **먼저** 걷어낸다. 공백을 밑줄로 바꾼 뒤에 걷어내면 `"보고서.txt "` 가
    // `"보고서.txt_"` 로 굳어 확장자가 하나 더 붙는다. 윈도우도 이 순서로 이름을 정리한다.
    .replace(/^[\s.]+/, "")
    .replace(/[\s.]+$/, "")
    .replace(/\s+/g, "_")
    .replace(/_{2,}/g, "_");

  // 확장자는 하나만. `x.TXT` 는 그대로 두고 `x.txt.txt` 는 만들지 않는다.
  const hasExtension = name.toLowerCase().endsWith(EXTENSION);
  let stem = hasExtension ? name.slice(0, -EXTENSION.length).replace(/[\s.]+$/, "") : name;
  if (stem === "") return fallback;

  if (RESERVED_STEMS.has(stem.toUpperCase())) stem = `_${stem}`;
  if (stem.length > MAX_NAME_LENGTH) stem = stem.slice(0, MAX_NAME_LENGTH).replace(/[\s.]+$/, "");
  if (stem === "") return fallback;

  // 사용자가 적은 확장자의 대소문자는 그대로 둔다.
  return stem + (hasExtension ? name.slice(-EXTENSION.length) : EXTENSION);
}

// ---------------------------------------------------------------- 나눠 쓰기

/// 한 번에 브리지로 넘길 글자 수. Capacitor 는 JSON 문자열로 넘기므로 한 덩어리가 크면
/// 직렬화·파싱이 메인 스레드를 붙잡는다. 32 KiB 면 어느 기기에서도 한 프레임 안에 끝난다.
export const CHUNK_CHARS = 32 * 1024;

/// 이보다 짧으면 나누지 않고 한 번에 쓴다.
///
/// **오늘의 최대치보다 일부러 한참 위에 둔 값이다.** 조각 상한 16장이면 합친 텍스트가 약
/// 46,000자고 쓰는 데 밀리초밖에 안 걸린다. 그 크기에 진행 막대를 띄우면 거짓말이 된다.
/// `tests/export.test.js` 의 가드 테스트가 이 관계를 못박아 둔다 — 조각 상한을 올려서 그
/// 테스트가 깨지면, 그때가 진행 막대가 진짜로 필요해진 시점이다.
export const CHUNK_THRESHOLD = 128 * 1024;

/// 진행 막대를 띄우기 전에 기다리는 시간. 이 안에 끝나면 아무것도 보여 주지 않는다.
export const BUSY_DELAY_MS = 250;

/// 한 번 띄운 막대를 최소한 이만큼은 남겨 둔다. 없으면 막대가 번쩍이고 사라진다.
export const BUSY_HOLD_MS = 400;

export function shouldChunk(text) {
  return typeof text === "string" && text.length >= CHUNK_THRESHOLD;
}

/**
 * 텍스트를 `size` 글자씩 나눈다. 이어 붙이면 원문과 **글자 단위로 같다.**
 *
 * 빈 문자열도 `[""]` 하나로 돌려준다 — 첫 조각은 `writeFile` 이라 파일 자체는 만들어져야 한다.
 *
 * 서로게이트 쌍은 쪼개지 않는다. 지금 payload 는 Base64 + ASCII 라 생길 수 없는 일이지만,
 * 쪼개진 채 UTF-8 로 인코딩되면 대체 문자가 들어가 파일이 조용히 망가진다 — 나중에 이 함수를
 * 다른 데 쓸 때를 위해 여기서 막아 둔다.
 */
export function chunkText(text, size = CHUNK_CHARS) {
  const step = Math.max(1, Math.floor(size));
  if (text.length === 0) return [""];

  const out = [];
  let at = 0;
  while (at < text.length) {
    let end = Math.min(at + step, text.length);
    if (end < text.length) {
      const code = text.charCodeAt(end - 1);
      // 0xD800~0xDBFF 가 상위 서로게이트다. 여기서 끊으면 짝이 갈라진다.
      if (code >= 0xd800 && code <= 0xdbff && end - 1 > at) end -= 1;
    }
    out.push(text.slice(at, end));
    at = end;
  }
  return out;
}
