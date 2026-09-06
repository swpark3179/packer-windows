# Packer 조각 모으기 (안드로이드 · iOS)

데스크톱 Packer 는 묶은 결과를 QR 코드로 내보낸다. 본문이 약 2,886자를 넘으면 한 장에 담기지
않아 **최대 16장**으로 갈라지고, 각 장에 `#i/N` 순서 표시가 붙는다. 지금까지 이걸 다시 모으는
일은 사람이 했다 — 기본 카메라로 한 장 찍고, 캡쳐하고, 복사하고, 붙여넣고, 16번.

이 앱은 그 한 가지 일만 한다. 카메라를 켜 둔 채 PC 화면의 장을 넘기면 순번을 알아서 맞춰
모으고, 다 모이면 순서 표시를 떼고 하나의 텍스트로 합쳐 `.txt` 로 저장한다.

**순서는 상관없다.** `#i/N` 에 순번이 들어 있으니 아무 장부터 찍어도 되고, 같은 장을 여러 번
찍어도 조용히 무시한다.

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
www/collector.js   순수 로직 — 의존성 0, DOM·Capacitor 를 모른다. 앱의 실제 내용이 여기 다 있다.
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
5. 그래도 안 되면 **데스크톱 쪽에서 심볼을 굵게** 만드는 것이 가장 확실하다.
   `src-tauri/src/qr.rs` 의 `MAX_MODULES` 를 125 로 내리면 조각이 1.5~2배로 늘어나는 대신 모든
   심볼이 굵어진다 (`qr.rs` 주석에 근거가 적혀 있다). 다만 16장 상한은 그대로라 QR 로 옮길 수
   있는 최대 크기가 줄어든다.

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
| 스캔 | `scan-overlay` `scan-progress` `scan-total` `scan-list` `chip-template` (안에 `[data-field=index]`, `data-got=true\|false`) `scan-status` (`data-tone=warn\|bad`) `scan-torch` `scan-stop` |
| 결과 | `result` `result-summary` `result-note` `scan-save` `scan-reset` |

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
   있어서 텍스트 파일은 100KB 라도 한 장으로 끝날 수 있다. 컨테이너가 약 2.2KB 를 넘으면
   갈라지고, 3~5장이 확인하기 좋다.
2. 앱을 켜고 데스크톱 QR 뷰어의 '다음' 으로 장을 넘기며 비춘다. **일부러 순서를 뒤섞어** 본다.
3. 상단 개수가 실제 장수와 같은지, 칩이 채워지는지, 마지막 장에서 자동으로 멈추는지 본다.
4. 저장한 `.txt` 를 PC 로 옮겨 **풀기 탭에 붙여넣고 원본이 복원되는지** 확인한다. 형식이
   맞았다는 최종 증거는 이것뿐이다.

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
