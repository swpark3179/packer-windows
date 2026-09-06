// 복원한 컨테이너 바이트를 붙여넣을 수 있는 armor 텍스트로 감싼다.
//
// 스트림 모드(`stream.js`)만 이걸 쓴다. 조각 모드는 armor 텍스트를 **그대로** 실어 나르므로
// 이어 붙이기만 하면 끝이지만(`collector.js` 의 `joinCollection`), 스트림 모드는 Base64 를 한
// 겹 벗긴 원시 바이트를 흘린다 — 프레임마다 33% 를 더 담기 위해서다. 그 대가로 마지막에 폰이
// 다시 Base64 로 옮겨 적어야 하고, 그게 이 파일이다.
//
// `collector.js` 와 같은 규율: **의존성이 없다.** DOM 도 Capacitor 도 모른다.
//
// 결과는 `armor::wrap_single_line()` 과 **바이트 단위로 같아야 한다.** 그래야 조각 모드가
// 내놓는 `.txt` 와 구별되지 않고, PC 의 풀기 탭이 두 경우를 똑같이 받는다.

export const BEGIN_MARKER = "-----BEGIN PACKER CONTAINER-----";
export const END_MARKER = "-----END PACKER CONTAINER-----";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// 한 번에 옮겨 적을 바이트 수. 3의 배수라야 조각 경계에 `=` 채움이 생기지 않는다.
///
/// 여기서 양보하지 않으면 10 MB 짜리를 옮겨 적는 동안 화면이 통째로 멈춘다.
const STEP_BYTES = 60 * 1024;

/**
 * 바이트열을 Base64 로 옮겨 적는다.
 *
 * `btoa` 를 쓰지 않는 이유가 둘이다. 바이너리 문자열을 한 번 만들어야 해서 큰 입력에서 메모리를
 * 두 배로 쓰고, 웹뷰마다 큰 입력에서 다르게 군다. 표를 직접 도는 편이 예측 가능하다.
 */
function base64Chunk(bytes) {
  let out = "";
  let at = 0;
  for (; at + 2 < bytes.length; at += 3) {
    const word = (bytes[at] << 16) | (bytes[at + 1] << 8) | bytes[at + 2];
    out +=
      ALPHABET[(word >> 18) & 63] +
      ALPHABET[(word >> 12) & 63] +
      ALPHABET[(word >> 6) & 63] +
      ALPHABET[word & 63];
  }
  // 남은 1~2바이트. 마지막 조각에서만 일어난다 (STEP_BYTES 가 3의 배수라서).
  const left = bytes.length - at;
  if (left === 1) {
    const word = bytes[at] << 16;
    out += `${ALPHABET[(word >> 18) & 63]}${ALPHABET[(word >> 12) & 63]}==`;
  } else if (left === 2) {
    const word = (bytes[at] << 16) | (bytes[at + 1] << 8);
    out += `${ALPHABET[(word >> 18) & 63]}${ALPHABET[(word >> 12) & 63]}${ALPHABET[(word >> 6) & 63]}=`;
  }
  return out;
}

/**
 * 컨테이너 바이트를 armor 텍스트로 감싼다.
 *
 * 큰 입력에서 화면이 멈추지 않도록 조각으로 나눠 돌고, 조각마다 `onProgress(done, total)` 를
 * 부른 뒤 한 프레임씩 양보한다. 10 MB 면 Base64 만으로도 몇 초가 걸린다 — 진행 막대가 실제로
 * 값을 하는 자리다.
 *
 * @param {Uint8Array} bytes
 * @param {(done: number, total: number) => void} [onProgress] 바이트 기준
 * @returns {Promise<string>} `armor::wrap_single_line()` 과 바이트 단위로 같은 텍스트
 */
export async function armorFromBytes(bytes, onProgress = null) {
  const total = bytes.length;
  let body = "";

  for (let at = 0; at < total; at += STEP_BYTES) {
    body += base64Chunk(bytes.subarray(at, Math.min(at + STEP_BYTES, total)));
    onProgress?.(Math.min(at + STEP_BYTES, total), total);
    // 다음 프레임에 자리를 내준다. 이게 없으면 막대가 그려지지 않는다.
    if (at + STEP_BYTES < total) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (total === 0) onProgress?.(0, 0);

  return `${BEGIN_MARKER}\n${body}\n${END_MARKER}\n`;
}
