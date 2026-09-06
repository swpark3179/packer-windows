# Packer 조각 모으기 (안드로이드 · iOS)

데스크톱 Packer 는 묶은 결과를 QR 코드로 내보낸다. 한 장에 담기지 않으면 **최대 128장**으로
갈라지고, 각 장에 `#i/N` 순서 표시가 붙는다. 지금까지 이걸 다시 모으는 일은 사람이 했다 —
기본 카메라로 한 장 찍고, 캡쳐하고, 복사하고, 붙여넣고, 그걸 열몇 번.

이 앱은 그 한 가지 일만 한다. 카메라를 켜 둔 채 PC 화면의 장을 넘기면 순번을 알아서 맞춰
모으고, 다 모이면 순서 표시를 떼고 하나의 텍스트로 합쳐 `.txt` 로 저장하거나 바로 다른 앱으로
보낸다 (아래 [저장 위치](#저장-위치)).

**순서는 상관없다.** `#i/N` 에 순번이 들어 있으니 아무 장부터 찍어도 되고, 같은 장을 여러 번
찍어도 조용히 무시한다. 그래서 PC 뷰어의 **'자동 넘김'** 을 눌러 두고 폰을 대고 있기만 하면
된다 — 한 바퀴 돌면 뷰어가 멈추고, 놓친 장이 있으면 다시 누르면 된다.

**조각 수 상한은 이 앱에 적혀 있지 않다.** 예전에는 데스크톱과 같은 상수를 들고 있다가 그보다
많은 조각을 전부 거절했는데, 그러면 데스크톱이 상한을 올리는 순간 구버전 앱이 신버전 QR 을
100% 거부한다 — 화면에는 "순번이 올바르지 않습니다" 만 뜬다. 지금은 순번이 말이 되기만 하면
몇 장이든 받는다.

합친 텍스트는 **여전히 암호화된 상태다.** 앱은 복호화하지 않는다 — PC 의 Packer **풀기** 탭에
붙여넣고 묶을 때 쓴 암호를 넣어야 파일이 돌아온다.

## 무엇으로 만들었나

**Capacitor 8 + 순수 HTML/CSS/ES 모듈.** 번들러도 프레임워크도 없다 — 저장소의 데스크톱
프론트엔드(`../src`)와 똑같은 방식이라 빌드 스텝이 없고 `www/` 를 고치면 바로 반영된다.

Capacitor 는 문서가 열릴 때 `window.Capacitor.Plugins.<이름>` 을 심어 주므로, 데스크톱이
`window.__TAURI__` 로 Rust 를 부르는 것과 같은 모양으로 네이티브를 부를 수 있다. 그래서 맨
이름 `import` 가 필요 없다. 대신 enum 이름이 아니라 **와이어 값**을 넘겨야 하고, 그 값들은
`www/bridge.js` 한곳에 출처와 함께 모아 두었다.

QR 디코딩은 **네이티브 ML Kit**(`@capacitor-mlkit/barcode-scanning`)이 한다. jsQR 같은 순수 JS
디코더는 이 프로젝트의 버전 40(177×177 모듈, 오류 정정 L) 심볼에 너무 약하다.

```
www/collector.js   조각 합치기 — 의존성 0, DOM·Capacitor 를 모른다. 앱의 실제 내용이 여기 다 있다.
www/stream.js      스트림 모드(파운틴 부호) 디코더 — 의존성 0
www/armor.js       복원한 바이트를 armor 텍스트로 옮겨 적기 — 의존성 0
www/export.js      파일 이름 정리와 나눠 쓰기 — 의존성 0
www/bridge.js      네이티브 호출과 와이어 값
www/app.js         둘을 화면에 잇는 배선. data-pk 훅으로만 DOM 을 만진다.
www/index.html     훅만 있는 마크업
www/styles.css     화면
scripts/           네이티브 필수 설정 패치 · 릴리스 버전 주입 (둘 다 멱등) · Play 업로드
tests/             node:test
```

## 준비

```bash
cd mobile
npm install
npm run add:android      # android/ 생성 + 필수 설정 적용
npm run add:ios          # ios/ 생성 + 필수 설정 적용 (아래 주의 사항 참고)
```

`android/` 와 `ios/` 는 **저장소에 없다**(생성물이다). 위 명령으로 언제든 다시 만들 수 있고,
`scripts/patch-native.mjs` 가 필수 설정을 다시 넣어 준다.

`www/` 를 고친 뒤에는:

```bash
npm run sync             # cap sync + 필수 설정 재적용
npm run android          # 기기/에뮬레이터에서 실행
npm run open:android     # Android Studio 로 열기
```

### iOS 는 반드시 CocoaPods 로 만들어야 한다

Capacitor 8 은 iOS 를 기본으로 Swift Package Manager 로 만든다. 그런데 스캐너 플러그인은
`.podspec` 만 있고 `Package.swift` 가 없어서, **SPM 프로젝트에는 아무 말 없이 빠진다** —
`Package.swift` 의 의존성 목록에 barcode-scanning 만 없고 빌드는 그대로 성공한다. 앱이 켜지고
버튼도 보이는데 스캔만 안 되는, 원인을 찾기 어려운 상태가 된다.

그래서 `npm run add:ios` 는 `--packagemanager cocoapods` 를 붙여 준다. 이 플래그는
`capacitor.config.json` 에 저장되지 않으므로 `npx cap add ios` 를 직접 쓰면 안 된다.
`npm run check:native` 가 SPM 으로 만들어진 경우를 잡아내 알려 준다.

`npx cap add ios --packagemanager cocoapods` 를 손으로 쓰는 것도 안 된다. 이 명령은 프로젝트를
만든 **뒤 곧바로** `pod install` 까지 돌리는데, 템플릿 Podfile 의 배포 타깃(15.0)이 스캐너
플러그인이 끌어오는 GoogleMLKit 8.0.0 의 요구(15.5)보다 낮아서 반드시 실패한다:

```
[!] CocoaPods could not find compatible versions for pod "GoogleMLKit/BarcodeScanning":
    ... they required a higher minimum deployment target.
```

배포 타깃을 올리는 `patch-native.mjs` 는 Podfile 이 생긴 **뒤에**만 돌 수 있으므로,
`npm run add:ios` (`scripts/add-ios.mjs`) 가 순서를 대신 지켜 준다 — 생성 → 배포 타깃 올리기 →
`cap sync ios` 로 `pod install` 다시. 마지막에 플러그인 목록(`packageClassList`)이 채워졌는지도
확인한다. 이게 비면 앱은 켜지는데 스캔·파일 저장이 조용히 죽는다.

iOS 빌드에는 **macOS** 가 필요하다(`pod install`, `xcodebuild`). 프로젝트 생성 자체는 리눅스에서도
되지만 — Capacitor 가 `pod` 이 없으면 경고만 남기고 넘어간다 — 빌드는 안 된다. 맥에서는
`npm run add:ios` 가 `pod install` 까지 끝내 주므로 바로 열면 된다:

```bash
npm run open:ios              # 서명 팀 설정 후 실기기에서 실행 (시뮬레이터는 카메라가 없다)
cd ios/App && pod install     # Pods 가 Podfile 과 어긋났을 때만
```

### 자동으로 들어가는 네이티브 설정

`scripts/patch-native.mjs` 가 넣는다. 플러그인이 알아서 해 주지 않는 것들이고, 빠지면 증상이
고약하다. `npm run check:native` 로 확인만 할 수도 있다 (CI 용).

| 어디 | 무엇 | 없으면 |
| --- | --- | --- |
| `AndroidManifest.xml` | `android.permission.CAMERA` | 권한 요청이 조용히 거절된다 |
| `AndroidManifest.xml` | ML Kit `DEPENDENCIES` meta-data | 첫 스캔에서 모델을 기다린다 |
| `Info.plist` | `NSCameraUsageDescription` | 카메라를 켜는 순간 앱이 죽는다 |
| `Info.plist` | `UIFileSharingEnabled`, `LSSupportsOpeningDocumentsInPlace` | 저장한 `.txt` 를 '파일' 앱에서 꺼낼 수 없다 |
| `res/xml/file_paths.xml` | FileProvider `<cache-path>` | 보내기가 `Failed to find configured root` 로 죽는다 — 저장은 되는데 보내기만 안 되는, 찾기 어려운 실패다 |
| `Podfile` | `platform :ios, '15.5'` | GoogleMLKit 8.0.0 의 최소 요구를 못 맞춰 `pod install` 이 실패한다 |
| `App.xcodeproj` | `IPHONEOS_DEPLOYMENT_TARGET = 15.5` | 앱이 자기보다 최소 버전이 높은 프레임워크를 링크해 15.0~15.4 기기에서 죽는다 |

안드로이드 빌드는 **JDK 21** 이 필요하다 (`minSdk 24`).

## 잘 안 읽힐 때

**이 앱에서 인식률이 가장 큰 관건이다.** Packer 의 QR 은 버전 40(여백 포함 185모듈)까지 커지고
오류 정정이 L 까지 내려간다. 모듈 하나가 화면에서 0.79mm 밖에 안 되므로 카메라 해상도가 모자라면
초점이 맞아도 안 읽힌다.

앱은 **1080p** 로 스캔한다(`www/bridge.js`). 플러그인 기본값은 720p 인데, 그러면 모듈당 카메라
픽셀이 2.3개뿐이라 아슬아슬하다. 1080p 면 3.5개가 된다.

그래도 안 읽히면 이 순서로:

1. **PC 창을 최대한 크게.** 데스크톱 뷰어는 모듈당 최소 3px 을 보장하지만 창이 작으면 그만큼
   작아진다.
2. **모니터 밝기를 올리고 반사를 피한다.** 화면과 평행하게, 15~25cm 정도.
3. **손전등은 켜지 말 것.** 모니터는 스스로 빛을 내므로 손전등은 반사만 늘린다. 버튼은
   종이에 인쇄한 QR 을 읽을 때를 위해 남겨 두었고 기본은 꺼짐이다.
4. **잘 안 읽히는 자리에서 거리를 조금씩 바꾼다.** 확대(줌)는 대부분의 폰에서 디지털 크롭이라
   오히려 정보가 줄어든다.
5. **데스크톱은 이미 심볼을 굵게 내보낸다.** `src-tauri/src/qr.rs` 의 `MAX_MODULES` 가 125라
   버전 25 언저리에서 끊긴다 — 예전(버전 40, 177모듈)보다 모듈당 카메라 픽셀이 눈에 띄게
   늘었다. 그래도 안 읽히면 그 값을 더 내린다. 조각이 늘어나는 대가는 뷰어의 '자동 넘김' 이
   대신 치른다.

## 두 가지 모드

데스크톱이 QR 을 내보내는 방식은 둘이고, **사용자는 고르지 않는다.** 첫 심볼의 매직으로 앱이
알아서 가른다.

| | 조각 모드 | 스트림 모드 |
| --- | --- | --- |
| 언제 | 컨테이너 132 KiB 까지 | 그보다 클 때 |
| 담는 것 | armor 텍스트 조각 (ASCII) | XOR 된 원시 바이트 |
| 모으는 법 | `#i/N` 순번을 빠짐없이 | 아무 프레임이나 충분히 |
| 놓치면 | 그 장이 다시 올 때까지 | **상관없다** |
| 기본 카메라 | 찍어서 붙여넣을 수 있다 | **안 된다 — 이 앱이 필수** |
| 진행 표시 | 칩(24장까지) 또는 막대 | 막대와 퍼센트 |

스트림 모드에 칩이 없는 것은 화면이 좁아서가 아니다. 순번을 채우는 방식이 아니라 **"어느 장이
빠졌는지" 라는 개념 자체가 없다** — 그게 이 모드의 요점이다.

다 모으면 할 일이 하나 더 있다. 프레임이 실어 나른 것은 Base64 를 벗긴 원시 바이트라(프레임마다
33% 를 더 담기 위해서다) 앱이 다시 armor 로 감싸야 한다(`www/armor.js`). 수 MB 면 그 옮겨 적기만
으로 몇 초가 걸리므로 조각으로 나눠 돌며 진행 막대에 보고한다 — 아래 진행 막대가 실제로 값을
하는 자리다. 결과는 `armor::wrap_single_line()` 과 바이트 단위로 같아서, PC 의 풀기 탭은 두
모드를 구별하지 않는다.

마지막에 헤더의 지문과 복원한 바이트의 SHA-256 앞 8바이트를 맞춰 본다. 어긋나면 **여기서**
말해 준다 — 조용히 넘기면 PC 에서 "손상되었습니다" 로만 나타나고, 그때는 무엇이 문제였는지도
모른 채 처음부터 다시 찍어야 한다.

### 난수열이 어긋나면 조용히 실패한다

`stream.js` 의 `rng()` · `solitonCdf()` · `blockIndices()` 는 `../src-tauri/src/qrstream.rs` 와
**비트 단위로 같아야 한다.** 어긋나면 프레임은 멀쩡히 읽히는데 XOR 이 안 맞아 한참 뒤 PC 에서
복호화 실패로만 드러난다.

그래서 골든 픽스처(`tests/fixtures/stream-frames.json`)가 양쪽에서 붙잡는다. Rust 쪽
`stream_format.rs` 는 인코더가 픽스처와 같은 바이트를 내는지 보고, `tests/stream.test.js` 는
같은 픽스처를 디코딩해 원본이 나오는지 본다. 형식을 일부러 바꿨다면:

```bash
cargo test --test stream_format -- --ignored write_the_golden_fixture
cd mobile && npm test          # 반드시 함께 — 픽스처만 갈면 어긋난 채로 양쪽이 통과한다
```

## 저장 위치

다 모으면 두 가지를 할 수 있다.

- **다른 앱으로 보내기** (기본) — 캐시에 쓴 `.txt` 를 시스템 공유 시트로 넘긴다. **저장 경로를
  사용자가 정하는 길이 이것이다.** iOS 는 시트의 '파일에 저장' 이 곧
  `UIDocumentPickerViewController` 라 폴더를 직접 고를 수 있고, 안드로이드는 '내 파일'·드라이브·
  메신저가 뜬다. 대신 **최종 위치는 앱이 알 수 없다** — 고른 앱이 정하기 때문이다. 화면에도
  그렇게 적는다. 지어낸 경로를 보여 주는 것보다 낫다.
- **이 기기에 저장** — 문서 폴더에 바로 쓰고 그 경로를 보여 준다.

파일 이름은 고칠 수 있다. 규칙은 `www/export.js` 의 `safeFileName()` 에 있고, **PC 로 옮겨 가는
파일**이라 폰이 아니라 윈도우 기준으로 막는다 (`src-tauri/src/safepath.rs` 와 같은 금지 글자와
장치 이름). 고친 결과는 조용히 쓰지 않고 **입력칸에 되돌려 적는다** — 저장 버튼을 눌렀는데 다른
이름으로 나가면 나중에 파일을 못 찾는다.

### 왜 폴더를 내려가며 시도하나

`Filesystem` 의 `DOCUMENTS` 는 안드로이드에서 **공개** Documents 폴더다 — 플러그인이
`Environment.getExternalStoragePublicDirectory(DIRECTORY_DOCUMENTS)` 를 돌려준다. 이 목적지는
`inExternalStorage` 라 API 30 미만에서 `WRITE_EXTERNAL_STORAGE` 를 확인하는데, **그 권한은
플러그인 매니페스트에도(비어 있다) 우리 매니페스트에도 없다.** 그래서:

| 안드로이드 | `DOCUMENTS` 쓰기 |
| --- | --- |
| 11+ (API 30+) | 된다. 권한 검사를 건너뛰고, 앱이 만든 파일이라 그냥 써진다 |
| 7~10 (API 24~29) | **대화상자도 없이 즉시 거절된다** (`minSdk 24` 라 사정권 안이다) |
| iOS | 앱 문서 폴더. `UIFileSharingEnabled` 덕에 '파일' 앱에서 보인다 |

권한을 선언해서 고치지 않는다. 그러면 **저장할 때마다 권한 대화상자가 뜬다.** 대신
`bridge.js` 의 `SAVE_ORDER` 가 `DOCUMENTS → EXTERNAL → CACHE` 로 내려가며 처음 성공하는 곳에
쓴다. `EXTERNAL`(`getExternalFilesDir`)과 `CACHE` 는 `inExternalStorage` 가 아니라 어느
버전에서도 아무것도 묻지 않는다. 안드로이드 11+ 와 iOS 는 늘 첫 줄에서 끝난다.

아래로 내려갔다는 사실은 **화면에 적는다** — 그 폴더들은 앱을 지우면 함께 사라지므로, 사용자가
보내기로 옮겨 둘 기회를 줘야 한다.

## 진행 막대

**작은 묶음에서는 뜨지 않는다. 그게 맞다.** 세 장짜리를 합쳐 쓰는 데는 밀리초밖에 안 걸리고,
그 크기에 막대를 띄우는 것은 거짓말이다. 반대로 조각 상한(128장)에 가까우면 합친 텍스트가 약
183,000자라 실제로 몇 초가 걸린다. 그래서 크기가 스스로 정하게 둔다 — 세 가지 규칙이다.

1. **지연 표시** — `BUSY_DELAY_MS`(250 ms) 안에 끝나면 막대를 아예 만들지 않는다.
2. **최소 표시 시간** — 한 번 띄웠으면 `BUSY_HOLD_MS`(400 ms)는 남긴다. 번쩍이고 사라지면 더
   산만하다.
3. **나눠 쓰기** — 텍스트가 `CHUNK_THRESHOLD`(128 KiB)를 넘으면 첫 조각은 `writeFile`, 나머지는
   `appendFile` 로 32 KiB 씩 쓰고 그때마다 진행률을 보고한다. 조각 사이에 한 프레임씩 양보하지
   않으면 막대가 그려지지도 않는다. 중간에 실패하면 **쓰다 만 파일을 지운다** — 잘린 컨테이너가
   PC 로 건너가면 한참 뒤 GCM 인증 실패로만 나타난다.

`tests/export.test.js` 의 가드 테스트가 두 경계를 함께 못박아 둔다: 옛 상한(16장 ≈ 46,000자)
에서는 나눠 쓰기를 타지 않고, 지금 상한(128장 ≈ 183,000자)에서는 탄다. 조각 상한을 다시
움직이면 거기가 먼저 깨져서, 막대를 띄우는 것이 여전히 정직한지 다시 보게 한다.

**공유 시트에는 확정 진행률을 붙일 수 없다.** SAF `content://` URI 에는 이어 쓰기가 없고
(플러그인이 `NotSupportedForContentScheme` 로 거절한다), iOS 의 문서 선택기는 이미 완성된
파일을 복사하는 물건이다. 그래서 보내기는 "캐시에 막대를 보며 쓰고, 넘길 때는 막대를 거둔다".
사용자가 앱을 고르는 동안 뒤에서 막대가 도는 것은 진행 중이라는 또 다른 거짓말이다.

**스캔 화면에서는 칩이 먼저다.** 칩은 막대가 지우는 정보를 담고 있다 — *어느* 장이 빠졌는지.
사용자가 실제로 행동하는 근거가 그것이고(`남은 순번 1, 3`), `n / N` 은 이미 정확하다. 게다가
카메라 위의 불투명한 판은 위의 투명 규칙과 정면으로 부딪친다.

조각이 `CHIP_LIMIT`(24장)을 넘으면 칩이 화면을 덮으므로 그때는 막대로 **바꾼다** — 더하지
않는다. 빠진 순번은 바로 위의 `scan-total` 이 계속 말해 준다.

## 형식 계약

입력 형식은 `../src-tauri/src/armor.rs` 가 정한다. 3장으로 갈라진 경우:

| 장 | 내용 |
| --- | --- |
| 1 | `-----BEGIN PACKER CONTAINER-----\n#1/3\n<base64>\n` |
| 2 | `#2/3\n<base64>\n` |
| 3 | `#3/3\n<base64>\n-----END PACKER CONTAINER-----\n` |

**한 장에 다 들어가면 `#1/1` 표시가 아예 없다** (`armor::wrap_single_line`). 파서는 두 모양을
모두 받는다.

합칠 때는 순서 표시를 **떼어** 내고 `BEGIN\n<본문 전부>\nEND\n` 로 다시 감싼다. 결과가
`wrap_single_line()` 과 바이트 단위로 같아진다. 표시를 남기지 않는 편이 안전한데,
`armor::verify_pieces()` 는 표시가 하나도 없으면 검사를 건너뛰지만 하나라도 남으면 1..N 이
빠짐없이 순서대로 있어야 `PieceOrder` 를 피하기 때문이다 — 실패할 수 있는 경로가 하나 적다.

이 가정은 **`../src-tauri/tests/piece_format.rs`** 가 못박아 둔다. `armor.rs` 를 고쳐 형식이
바뀌면 그 테스트가 먼저 깨지면서 `www/collector.js` 도 고쳐야 한다고 알려 준다.

## 디자인 이식용 훅

`www/app.js` 는 마크업의 클래스 이름을 하나도 모른다. 모든 DOM 참조는 `data-pk="..."` 로만
한다 (데스크톱 `../README.md` 의 훅 표와 같은 규약). 없는 훅은 조용히 무시되므로 부분 이식도
안전하다.

| 영역 | 훅 |
| --- | --- |
| 뼈대 | `app` (`data-state=idle\|denied\|scanning\|complete\|unsupported`) |
| 준비 | `intro` `perm-note` `perm-settings` `scan-start` `scan-error` |
| 스캔 | `scan-overlay` `scan-progress` `scan-total` `scan-list` `scan-bar` `scan-bar-fill` `chip-template` (안에 `[data-field=index]`, `data-got=true\|false`) `scan-status` (`data-tone=warn\|bad`) `scan-torch` `scan-stop` |
| 결과 | `result` `result-summary` `result-note` `save-name` `save-hint` `scan-share` `scan-save` `scan-reset` |
| 진행 막대 | `export-progress` `export-progress-fill` `export-progress-label` |

`intro` · `result` · `scan-overlay` 는 JS 가 만지지 않는다. `app` 의 `data-state` 하나로 CSS 가
전환한다.

### 카메라 위에 그릴 때 주의할 점

미리보기는 웹뷰 **뒤에** 네이티브로 그려진다. 그래서 배경색을 `body` 에 두면 안 된다 — CSS
규격상 루트가 투명하면 `body` 의 배경이 캔버스로 전파되고, 캔버스 칠하기는
`visibility: hidden` 의 영향을 받지 않는다. 플러그인이 `body` 를 감춰도 배경만 남아 카메라를
덮고, 증상은 "카메라가 검다" 로 보인다. 배경은 반드시 `[data-pk="app"]` 이 들고 있어야 한다
(`www/styles.css` 의 투명 규칙 블록 참고).

## 테스트

```bash
npm test
```

- `tests/collector.test.js` — 합치기 로직. **의존성이 없어서 `npm install` 없이도 돌아간다.**
  픽스처는 `armor::pieces()` 를 자바스크립트로 그대로 옮겨 만들므로 조각 경계가 실제와 어긋나지
  않는다.
- `tests/export.test.js` — 파일 이름 정리와 나눠 쓰기. **의존성 없이 돌아간다.** 진행 막대가
  오늘의 최대치에서 뜨지 않는다는 **가드 테스트**가 여기 있다.
- `tests/stream.test.js` — 스트림 디코더. **의존성 없이 돌아간다.** Rust 인코더가 만든 골든
  픽스처를 그대로 디코딩하므로, 두 언어의 난수열이 어긋나면 여기가 깨진다.
- `tests/armor.test.js` — 복원한 바이트를 armor 로 옮겨 적기. **의존성 없이 돌아간다.**
- `tests/bridge.test.js` — 저장·보내기. **의존성 없이 돌아간다** — `bridge.js` 는 DOM 을 만지지
  않고 `globalThis.Capacitor` 만 보므로 창이 필요 없다. 나눠 쓴 조각이 원문을 글자 하나 잃지
  않는지, 실패하면 쓰다 만 파일을 지우는지, 폴더 캐스케이드가 도는지를 못박는다.
- `tests/app.test.js` — `index.html` 을 jsdom 에 올리고 `window.Capacitor` 를 가짜 브리지로
  바꿔치기해 배선을 확인한다 (데스크톱 `tests/frontend.test.js` 와 같은 방식). jsdom 이 없으면
  건너뛴다.
- `tests/set-native-version.test.js` — 릴리스 버전을 네이티브에 넣는 스크립트를 실제 CLI 로
  돌려 확인한다. `cap add` 템플릿이 바뀌면 앵커 정규식이 조용히 빗나가는데, 그러면 릴리스가
  1.0 (1) 로 빌드돼 **두 번째 TestFlight 업로드에서야** 터진다.
- `tests/upload-to-play.test.js` — 가짜 Play 서버를 세워 업로드 스크립트를 실제 CLI 로 돌리고,
  JWT 서명과 오간 요청을 그대로 검사한다. 이쪽은 진짜로 올려 보기 전에는 맞는지 알 길이 없어서,
  틀리면 릴리스 당일에야 드러난다.

실기기 확인은 이렇게 한다:

1. 데스크톱에서 **잘 안 압축되는 파일**(JPEG·동영상·난수 바이트)을 묶는다. 파이프라인에 zstd 가
   있어서 텍스트 파일은 100KB 라도 한 장으로 끝날 수 있다. 컨테이너가 약 800B 를 넘으면
   갈라지고, 3~5장이 확인하기 좋다.
2. 앱을 켜고 데스크톱 QR 뷰어의 '다음' 으로 장을 넘기며 비춘다. **일부러 순서를 뒤섞어** 본다.
   그다음 **'자동 넘김'** 을 눌러 두고 폰만 대고 있어 본다 — 한 바퀴에 다 모여야 한다.
3. 상단 개수가 실제 장수와 같은지, 칩이 채워지는지, 마지막 장에서 자동으로 멈추는지 본다.
   **30장쯤 나오는 파일**로도 해 본다 — 칩 대신 진행 막대로 바뀌어야 한다 (`CHIP_LIMIT`).
4. 파일 이름을 고쳐 본다. `a/b: c` 를 넣고 저장하면 입력칸이 `a_b_c.txt` 로 **눈앞에서**
   고쳐져야 한다.
5. **이 기기에 저장** — 경로가 화면에 나오는지. 안드로이드 11+ 는 '내 파일' 의 `Documents` 에,
   iOS 는 '파일' 의 `내 iPhone → Packer Scanner` 에 있어야 한다. **안드로이드 9~10 기기가
   있으면 꼭 해 본다** — 문서 폴더가 막혀 아래 폴더로 내려가고, 화면이 그 사실을 말해야 한다.
   어느 경우에도 **권한 대화상자가 떠서는 안 된다.**
6. **다른 앱으로 보내기** — 시트가 `.txt` 를 달고 뜨는지, 이름이 적은 그대로인지. iOS 는
   '파일에 저장' 으로 폴더를 골라 보고, 안드로이드는 '내 파일' 이나 드라이브로 저장해 본다.
   한 번은 **취소**해서 "보내기를 취소했습니다." 만 뜨고 아무 일도 없는지 본다.
7. 저장한 `.txt` 를 PC 로 옮겨 **풀기 탭에 붙여넣고 원본이 복원되는지** 확인한다. 형식이
   맞았다는 최종 증거는 이것뿐이다.
8. **스트림 모드**는 조각 모드에 안 담기는 크기(컨테이너 132 KiB 초과)로 확인한다. 1 MB 쯤이
   4분이라 한 번은 견딜 만하다. PC 에서 '스트림으로 보내기' 를 누르고 폰을 대고 있으면 된다 —
   앱이 알아서 스트림으로 붙는다. **일부러 카메라를 몇 초 가려** 프레임을 놓쳐 본다: 조각
   모드와 달리 되찾으러 갈 필요 없이 진행률이 계속 올라야 한다. 다 모이면 "옮겨 적는 중"
   막대가 잠깐 돌고 결과가 뜬다. 그 `.txt` 도 PC 에서 원본으로 풀려야 한다.

**진행 막대는 정상적인 사용으로는 볼 수 없다** — 일부러 그렇게 만들었다. 확인하려면
`www/export.js` 의 `CHUNK_THRESHOLD` 를 잠깐 `8 * 1024` 로 내리고 `npm run sync` 한 뒤 저장해
본다. 막대가 뜨고, 눈에 보이는 단계로 차오르고, 100 % 에서 잠깐 머물다 사라져야 하며, 그렇게
저장한 파일도 풀기 탭에서 그대로 복원되어야 한다. **확인했으면 상수를 되돌린다.**

## 릴리스

`.github/workflows/release-mobile.yml` 이 서명된 APK 를 GitHub 릴리스에 붙이고, AAB 를 Google
Play 트랙에, IPA 를 TestFlight 에 올린다. Actions 탭에서 손으로 실행한다. 준비해야 하는 GitHub
secret 과 Play·애플·안드로이드 자격 증명을 만드는 방법은 [`RELEASE.md`](RELEASE.md) 에 있다.

**Play 에 처음 올릴 때는 손이 한 번 필요하다** — Play Developer API 는 이미 Play Console 에 있는
앱에만 번들을 올릴 수 있어서, 앱을 만들고 첫 AAB 를 올리는 것까지는 사람이 해야 한다. 그리고
Play 는 앱을 자기 키로 다시 서명하므로 **GitHub 릴리스의 APK 와 Play 에서 받은 앱은 서로
덮어쓰지 못한다.** 둘 다 `RELEASE.md` 2절에 적어 두었다.

버전은 `mobile-v*` 태그에서 계산하므로 데스크톱 `v*` 릴리스와 섞이지 않는다 — 앱만 고쳤을 때
데스크톱 버전이 따라 오르지 않는다. 빌드 직전에 `scripts/set-native-version.mjs` 가
`versionCode` · `versionName` · `CFBundleVersion` 을 넣는데, Capacitor 는 `package.json` 의 버전을
네이티브로 옮겨 주지 않으므로 이게 없으면 **모든 빌드가 1.0 (1)** 이 되고 App Store Connect 가
중복 빌드 번호로 거부한다.
