// Capacitor 네이티브 브리지.
//
// 데스크톱 앱이 `window.__TAURI__` 로 Rust 를 부르는 것과 같은 자리다. Capacitor 는 문서가
// 열릴 때 `window.Capacitor.Plugins.<이름>` 을 심어 주므로, **번들러 없이도** 네이티브를 부를 수
// 있다. 그래서 이 프로젝트는 저장소의 다른 프론트엔드와 똑같이 빌드 스텝이 없다.
//
// 대가가 하나 있다: `import { Resolution } from "@capacitor-mlkit/barcode-scanning"` 은 맨
// 이름(bare specifier)이라 웹뷰가 해석하지 못한다. 그래서 **enum 이름이 아니라 와이어 값**을
// 넘겨야 한다. 그 값들을 아래 한곳에 모아 두고 각각 출처를 적었다 — 흩어지면 틀렸을 때 찾기
// 어렵고, 틀려도 조용히 기본값으로 동작해 버린다.

import { chunkText, shouldChunk } from "./export.js";

/// `Resolution` — 네이티브는 **정수**로 받는다 (안드로이드 `call.getInt("resolution", 1)`).
export const RESOLUTION = Object.freeze({
  "640x480": 0,
  "1280x720": 1,
  "1920x1080": 2,
  "3840x2160": 3,
});

/// `BarcodeFormat.QrCode`. QR 만 찾게 하면 디코더가 다른 형식을 훑지 않아 더 빠르다.
const QR_CODE = "QR_CODE";
/// `LensFacing.Back`
const BACK = "BACK";
/// `Directory.Documents` — iOS 는 앱 문서 폴더, 안드로이드는 **공개** Documents 폴더다.
const DOCUMENTS = "DOCUMENTS";
/// `Directory.External` — 안드로이드 `context.getExternalFilesDir(null)`. iOS 에는 없다.
const EXTERNAL = "EXTERNAL";
/// `Directory.Cache` — 공유 시트로 넘길 파일을 두는 곳.
const CACHE = "CACHE";
/// `Encoding.UTF8` — 이 값을 주면 `data` 를 Base64 가 아니라 그냥 문자열로 넘길 수 있다.
const UTF8 = "utf8";
/// `ImpactStyle.Medium`
const MEDIUM = "MEDIUM";
/// `NotificationType.Success` / `.Warning`
const SUCCESS = "SUCCESS";
const WARNING = "WARNING";

const plugin = (name) => globalThis.Capacitor?.Plugins?.[name] ?? null;
const scanner = () => plugin("BarcodeScanner");

/// 네이티브 스캐너가 붙어 있는지. 그냥 브라우저로 이 페이지를 열면 false 다.
export function hasScanner() {
  return scanner() !== null;
}

/// 이 기기가 스캔을 지원하는지. 플러그인이 없으면 물어볼 것도 없다.
export async function isSupported() {
  const api = scanner();
  if (!api) return false;
  try {
    const result = await api.isSupported();
    return result?.supported !== false;
  } catch {
    // 알 수 없으면 지원한다고 보고 실제 시작에서 실패하게 둔다 — 여기서 막아 버리면
    // 쓸 수 있는 기기에서도 아무것도 못 하게 된다.
    return true;
  }
}

/// `'granted' | 'denied' | 'prompt' | 'prompt-with-rationale' | 'limited'`
export async function cameraPermission() {
  const api = scanner();
  if (!api) return "denied";
  const status = await api.checkPermissions();
  return status?.camera ?? "denied";
}

export async function requestCameraPermission() {
  const api = scanner();
  if (!api) return "denied";
  const status = await api.requestPermissions();
  return status?.camera ?? "denied";
}

export async function openSettings() {
  await scanner()?.openSettings();
}

/**
 * 연속 스캔을 시작한다. 미리보기는 웹뷰 **뒤**에 네이티브로 그려진다.
 *
 * `resolution` 이 이 앱에서 가장 중요한 설정이다. 플러그인 기본값은 `1280x720` 인데, Packer 의
 * QR 은 버전 40(여백 포함 185모듈)까지 커진다. 720p 로는 모듈당 카메라 픽셀이 2.3개밖에 안 되어
 * 초점이 맞아도 잘 안 읽힌다. 1080p 면 3.5개로 올라간다.
 */
export async function startScan(resolution = RESOLUTION["1920x1080"]) {
  await scanner().startScan({
    formats: [QR_CODE],
    lensFacing: BACK,
    resolution,
  });
}

export async function stopScan() {
  try {
    await scanner()?.stopScan();
  } catch {
    // 이미 멈춰 있는 경우. 멈추려는 것이 목적이므로 실패로 볼 이유가 없다.
  }
}

/// 인식 이벤트를 받는다. 반환값의 `remove()` 로 뗀다.
///
/// **이벤트 이름은 복수형 `barcodesScanned` 다.** 플러그인 README 의 예시는 단수
/// `barcodeScanned` 를 쓰지만 그쪽은 타입 정의에 없다. 한 프레임에 여러 심볼이 들어올 수 있어
/// `event.barcodes` 는 배열이다.
export async function onBarcodes(handler) {
  return scanner().addListener("barcodesScanned", (event) => {
    for (const barcode of event?.barcodes ?? []) handler(barcode);
  });
}

/// 스캔이 네이티브 쪽에서 죽었을 때 알려 준다 (권한 취소, 카메라 점유 등).
export async function onScanError(handler) {
  return scanner().addListener("scanError", (event) => handler(event?.message ?? ""));
}

/**
 * 심볼에서 텍스트를 꺼낸다.
 *
 * `rawValue` 는 심볼이 UTF-8 로 해석됐을 때만 채워진다고 타입 정의가 못박아 두었고, 아니면
 * `bytes` 를 쓰라고 한다. 조각 텍스트는 전부 ASCII 라서(`qr.rs`: "조각 텍스트에는 ASCII 만
 * 넣는다") 바이트를 그대로 글자로 바꿔도 결과가 같다 — 이 두 줄이 기기별 실패 한 종류를 없앤다.
 * 자바 바이트는 음수로 올 수 있어 `& 0xff` 로 되돌린다.
 */
export function barcodeText(barcode) {
  const raw = barcode?.rawValue;
  if (typeof raw === "string" && raw.length > 0) return raw;

  const bytes = barcode?.bytes;
  if (Array.isArray(bytes) && bytes.length > 0) {
    return bytes.map((byte) => String.fromCharCode(byte & 0xff)).join("");
  }
  return "";
}

/**
 * 심볼에서 **원시 바이트**를 꺼낸다. 스트림 모드 프레임용이다.
 *
 * 조각 모드는 ASCII 텍스트라 `rawValue` 로 충분하지만, 스트림 프레임은 XOR 된 바이너리다.
 * `rawValue` 는 UTF-8 로 해석됐을 때만 채워진다고 타입 정의가 못박아 두었으므로 바이너리에서는
 * 비거나 깨진 글자가 온다. 그래서 여기서는 `rawValue` 를 **보지 않는다.**
 *
 * 자바 바이트는 음수로 올 수 있어 `& 0xff` 로 되돌린다.
 */
export function barcodeBytes(barcode) {
  const bytes = barcode?.bytes;
  if (Array.isArray(bytes) && bytes.length > 0) {
    return Uint8Array.from(bytes, (byte) => byte & 0xff);
  }
  // `bytes` 를 주지 않는 기기를 위한 최후의 수단. ASCII 범위 밖이 섞이면 어차피 CRC 가 잡는다.
  const raw = barcode?.rawValue;
  if (typeof raw === "string" && raw.length > 0) {
    return Uint8Array.from(raw, (ch) => ch.charCodeAt(0) & 0xff);
  }
  return new Uint8Array(0);
}

// ---------------------------------------------------------------- 손전등

export async function torchAvailable() {
  try {
    const result = await scanner()?.isTorchAvailable();
    return result?.available === true;
  } catch {
    return false;
  }
}

export async function setTorch(on) {
  const api = scanner();
  if (!api) return;
  if (on) await api.enableTorch();
  else await api.disableTorch();
}

// ---------------------------------------------------------------- 내보내기

/**
 * 내려가며 처음 성공하는 폴더에 쓴다.
 *
 * `DOCUMENTS` 는 안드로이드에서 **공개** Documents 폴더다 — 플러그인이
 * `Environment.getExternalStoragePublicDirectory(DIRECTORY_DOCUMENTS)` 를 돌려준다. 이 목적지는
 * `inExternalStorage` 라 API 30 미만에서 `WRITE_EXTERNAL_STORAGE` 를 확인하는데, 그 권한은
 * 플러그인 매니페스트에도 우리 매니페스트에도 없다. 그래서 **안드로이드 10 이하에서는 대화상자도
 * 없이 즉시 거절된다** (`minSdk 24` 라 그 기기들이 사정권 안이다).
 *
 * 권한을 선언해서 고치지 않는 이유는, 그러면 저장할 때마다 권한 대화상자가 뜨기 때문이다.
 * `EXTERNAL`(`getExternalFilesDir`)과 `CACHE` 는 `inExternalStorage` 가 아니라 어느 버전에서도
 * 아무것도 묻지 않는다. 안드로이드 11+ 는 첫 줄에서 끝나고, 그 아래에서만 내려간다.
 * iOS 는 `DOCUMENTS` 가 앱 문서 폴더라 언제나 첫 줄에서 끝난다.
 */
const SAVE_ORDER = [DOCUMENTS, EXTERNAL, CACHE];

const filesystem = () => plugin("Filesystem");

/// 다음 프레임에 자리를 내준다. 이게 없으면 청크를 아무리 쪼개도 진행 막대가 그려지지 않는다.
const yieldFrame = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 텍스트 하나를 한 폴더에 쓴다. 크면 나눠 쓰고 그때마다 `onProgress(done, total)` 를 부른다.
 *
 * 짧은 텍스트는 나누지 않는다 (`shouldChunk`). 지금 조각 상한(16장)에서 합친 텍스트는 약
 * 46,000자라 늘 이쪽 길로 간다 — 나눠 쓰기는 조각 상한이 올라갔을 때를 위한 길이다.
 *
 * 중간에 실패하면 **쓰다 만 파일을 지운다.** 잘린 컨테이너가 PC 로 건너가면 한참 뒤 GCM 인증
 * 실패로만 나타나는데, `collector.js` 가 조각 단계에서 그 상황을 막으려고 애쓰는 것과 같은
 * 이유로 여기서도 남겨 두면 안 된다.
 */
async function writeOne(api, { fileName, directory, text, onProgress }) {
  const total = text.length;

  if (!shouldChunk(text)) {
    const written = await api.writeFile({
      path: fileName,
      data: text,
      directory,
      encoding: UTF8,
      recursive: true,
    });
    onProgress?.(total, total);
    return { uri: written?.uri ?? "", directory };
  }

  const chunks = chunkText(text);

  // 첫 쓰기는 try 밖에 둔다. 여기서 실패했다면 파일이 만들어지지도 않았으므로 지울 것이 없다 —
  // 안에 넣으면 애초에 쓸 수 없는 폴더(권한 없음)에까지 삭제를 한 번씩 날리게 된다.
  const written = await api.writeFile({
    path: fileName,
    data: chunks[0],
    directory,
    encoding: UTF8,
    recursive: true,
  });
  let done = chunks[0].length;
  onProgress?.(done, total);

  try {
    for (const chunk of chunks.slice(1)) {
      await yieldFrame();
      // `appendFile` 은 `uri` 를 돌려주지 않는다. 첫 쓰기의 것을 들고 간다.
      await api.appendFile({ path: fileName, data: chunk, directory, encoding: UTF8 });
      done += chunk.length;
      onProgress?.(done, total);
    }
  } catch (error) {
    try {
      await api.deleteFile({ path: fileName, directory });
    } catch {
      // 이미 지워졌거나 지울 수 없다. 목적은 남기지 않는 것이므로 이 실패는 삼킨다.
    }
    throw error;
  }
  return { uri: written?.uri ?? "", directory };
}

/**
 * 텍스트를 `.txt` 로 쓴다. 저장된 위치(`uri`)와 실제로 쓴 폴더를 돌려준다.
 *
 * 위치를 그대로 화면에 보여 주는 게 중요하다 — 플랫폼마다 실제 폴더가 달라서, 저장은 됐는데
 * 어디 있는지 모르는 상황이 가장 흔한 불만이다. 폴더 이름까지 함께 돌려주는 것은, 아래 단계로
 * 내려갔을 때 화면이 그 사실을 말해 줘야 하기 때문이다.
 */
export async function saveText(fileName, text, onProgress = null) {
  const api = filesystem();
  if (!api) throw new Error("이 기기에서는 파일로 저장할 수 없습니다.");

  let last = null;
  for (const directory of SAVE_ORDER) {
    try {
      return await writeOne(api, { fileName, directory, text, onProgress });
    } catch (error) {
      last = error;
    }
  }
  throw last ?? new Error("저장할 수 있는 폴더가 없습니다.");
}

/// 공유 시트를 쓸 수 있는지. 웹으로 그냥 열면 false 다.
export async function canShare() {
  const api = plugin("Share");
  if (!api) return false;
  try {
    const result = await api.canShare();
    return result?.value === true;
  } catch {
    return false;
  }
}

/**
 * 텍스트를 캐시에 쓴 뒤 시스템 공유/저장 시트로 넘긴다.
 *
 * **저장 경로를 사용자가 정하는 길이 이것이다.** iOS 는 시트의 '파일에 저장' 이 곧
 * `UIDocumentPickerViewController` 라 폴더를 직접 고를 수 있고, 안드로이드는 '내 파일'·드라이브·
 * 메신저가 뜬다. 대신 **최종 위치는 우리가 알 수 없다** — 고른 앱이 정하기 때문이다. 화면에는
 * 그렇게 적는다.
 *
 * 캐시에 쓰는 이유는 Capacitor 템플릿의 `file_paths.xml` 이 `<cache-path>` 를 노출하기
 * 때문이다. 넘긴 파일은 지우지 않는다 — 받는 앱이 URI 를 나중에 읽고, 캐시는 OS 가 알아서
 * 정리한다.
 *
 * `onReady` 는 시트를 **띄우기 직전**에 불린다. 호출자가 진행 막대를 거둘 자리다 — 사용자가
 * 앱을 고르는 동안 뒤에서 막대가 도는 것은 진행 중이라는 거짓말이고, 여기서 알려 주지 않으면
 * 호출자는 그 시점을 알 방법이 없다 (`api.share` 는 시트가 닫혀야 돌아온다).
 */
export async function shareText(fileName, text, onProgress = null, onReady = null) {
  const api = plugin("Share");
  const files = filesystem();
  if (!api || !files) throw new Error("이 기기에서는 다른 앱으로 보낼 수 없습니다.");

  const { uri } = await writeOne(files, { fileName, directory: CACHE, text, onProgress });
  await onReady?.();

  try {
    // `text` 는 넘기지 않는다. 함께 주면 안드로이드가 `text/plain` 으로 굳혀 첨부가 사라진다.
    const result = await api.share({ title: fileName, files: [uri], dialogTitle: "조각 파일 보내기" });
    return { shared: true, activityType: result?.activityType ?? "" };
  } catch (error) {
    // 사용자가 시트를 닫으면 두 플랫폼 모두 "Share canceled" 로 거절한다. 오류가 아니다.
    const message = error instanceof Error ? error.message : String(error ?? "");
    if (/cancel/i.test(message)) return { shared: false, activityType: "" };
    throw error;
  }
}

/// `"android" | "ios" | "web"`. 안내 문구가 플랫폼마다 달라야 해서 필요하다.
export function platform() {
  return globalThis.Capacitor?.getPlatform?.() ?? "web";
}

// ---------------------------------------------------------------- 피드백

/// 진동. 사용자는 폰이 아니라 PC 화면을 보고 있어서 화면 표시만으로는 알아채지 못한다.
export async function buzz(kind) {
  const haptics = plugin("Haptics");
  if (!haptics) return;
  try {
    if (kind === "done") await haptics.notification({ type: SUCCESS });
    else if (kind === "warn") await haptics.notification({ type: WARNING });
    else await haptics.impact({ style: MEDIUM });
  } catch {
    // 진동이 없는 기기. 알림 수단이 하나 줄어들 뿐이다.
  }
}

/// 스캔하는 동안 화면이 꺼지지 않게 한다. 자동 넘김이 한 바퀴 도는 동안 화면이 꺼지면
/// 흐름이 끊긴다 — 128장이면 45초쯤 폰을 들고만 있게 된다.
export async function keepAwake(on) {
  const api = plugin("KeepAwake");
  if (!api) return;
  try {
    if (on) await api.keepAwake();
    else await api.allowSleep();
  } catch {
    // 플러그인이 없거나 지원하지 않는 기기 — 기능에는 지장이 없다.
  }
}
