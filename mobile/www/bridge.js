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
/// `Directory.Documents`
const DOCUMENTS = "DOCUMENTS";
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
 * 텍스트를 문서 폴더에 `.txt` 로 쓴다. 저장된 위치(`uri`)를 돌려준다.
 *
 * 위치를 그대로 화면에 보여 주는 게 중요하다 — 플랫폼마다 실제 폴더가 달라서, 저장은 됐는데
 * 어디 있는지 모르는 상황이 가장 흔한 불만이다.
 */
export async function saveText(fileName, text) {
  const filesystem = plugin("Filesystem");
  if (!filesystem) throw new Error("이 기기에서는 파일로 저장할 수 없습니다.");

  const written = await filesystem.writeFile({
    path: fileName,
    data: text,
    directory: DOCUMENTS,
    encoding: UTF8,
    recursive: true,
  });
  return written?.uri ?? "";
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

/// 스캔하는 동안 화면이 꺼지지 않게 한다. 16장을 넘기다 화면이 꺼지면 흐름이 끊긴다.
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
