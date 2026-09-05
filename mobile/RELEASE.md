# 모바일 릴리스 (APK · TestFlight)

`.github/workflows/release-mobile.yml` 이 안드로이드 **서명된 APK** 를 GitHub 릴리스에 붙이고,
iOS **IPA** 를 **TestFlight** 에 올린다. Actions 탭에서 손으로 실행한다(자동 실행은 없다).

데스크톱 릴리스(`.github/workflows/release.yml`)와 **완전히 분리된 트랙**이다. 태그 접두사가
`mobile-v` 라서 서로의 버전을 끌어올리지 않는다 — 앱만 고쳤을 때 데스크톱 버전이 따라 오르거나
그 반대가 되는 일이 없다.

이 문서는 **한 번만** 하는 준비 작업을 다룬다. 준비가 끝나면 릴리스는 Actions 탭에서
버튼 한 번이다.

## 워크플로가 하는 일

| 잡 | 어디서 | 무엇 |
| --- | --- | --- |
| `prepare` | ubuntu | `mobile-v*` 태그를 훑어 다음 버전을 정하고, `npm ci && npm test` 로 앱 테스트를 돌린다 |
| `android` | ubuntu | `npm run add:android` → Gradle `assembleRelease` → `zipalign` + `apksigner` 로 서명 |
| `ios` | macos-15 | `npm run add:ios` → `pod install` → `xcodebuild archive` → IPA → `altool` 로 TestFlight |
| `release` | ubuntu | 변경 이력을 만들고 `gh release create` 로 릴리스에 APK 를 붙인다 |

`android/` 와 `ios/` 는 저장소에 없는 **생성물**이라 매 실행마다 새로 만든다. 그래서
`scripts/patch-native.mjs`(필수 네이티브 설정), `scripts/set-native-version.mjs`(버전·빌드 번호),
`scripts/set-ios-signing.mjs`(iOS 앱 타겟의 수동 서명 설정)가 빌드 직전에 반드시 돌아야 하고,
워크플로가 그 순서를 지킨다. 자세한 근거는 세 스크립트의 첫 주석에 적어 두었다.

실행할 때 고르는 것:

| 입력 | 뜻 |
| --- | --- |
| `bump` | `major` · `minor` · `patch` — 올릴 자리 |
| `platforms` | `android+ios` · `android` · `ios` — 서명이 한쪽만 깨졌을 때 그쪽만 다시 돌리기 위한 것 |
| `upload_to_testflight` | 끄면 `altool --validate-app` 까지만 한다 (아래 '처음 실행하기' 참고) |

**`platforms: ios` 만 돌린 실행은 GitHub 릴리스를 만들지 않는다.** 붙일 APK 가 없고, 그 실행의
결과물은 TestFlight 빌드 자체다. 태그도 만들지 않으니 다음 실행이 같은 버전을 다시 계산한다.

**IPA 는 릴리스에 붙이지 않는다.** TestFlight·ad-hoc 밖에서는 설치할 수 없어서 받는 사람만
헷갈린다. 필요하면 그 실행의 워크플로 아티팩트(`ios-ipa`)에서 내려받으면 된다.

## 준비 체크리스트

- [ ] 안드로이드: 서명 키스토어를 만들어 secret 3개 등록
- [ ] iOS: Apple Developer Program 가입 (연 $99 · 개인도 가능)
- [ ] iOS: App Store Connect 에 `org.packer.scanner` 로 앱 등록
- [ ] iOS: 배포 인증서 `.p12` 를 만들어 secret 2개 등록
- [ ] iOS: App Store 프로비저닝 프로파일을 만들어 secret 1개 등록
- [ ] iOS: App Store Connect API 키를 만들어 secret 3개 등록
- [ ] Team ID 를 **변수**(secret 아님)로 등록
- [ ] `upload_to_testflight` 를 끈 채로 한 번 돌려 서명만 검증

안드로이드만 쓸 거면 첫 항목만 하면 된다 — `platforms: android` 로 돌리는 실행은 iOS secret 을
전혀 보지 않는다.

## 1. 안드로이드 서명 키스토어

APK 에 서명할 키를 만든다. 한 번 만들면 계속 쓴다.

```bash
keytool -genkeypair -v \
  -keystore upload.jks -storetype PKCS12 \
  -alias upload -keyalg RSA -keysize 2048 -validity 10000
```

이름·조직 같은 것을 물어보는데 아무렇게나 넣어도 앱 동작에는 영향이 없다. 암호는 하나만 정하면
된다 — **PKCS12 키스토어는 키 암호와 키스토어 암호가 같아야 한다.** (그래서
`ANDROID_KEY_PASSWORD` secret 은 선택 사항이고, 비워 두면 워크플로가 키스토어 암호를 그대로 쓴다.)

> **키스토어를 잃어버리면 같은 앱으로 업데이트를 낼 수 없다.** 안드로이드는 서명 키가 앱의
> 신원이라, 다른 키로 서명한 APK 는 기존 설치본을 덮어쓰지 못한다. 암호와 함께 안전한 곳에
> 따로 보관한다. 지금은 스토어를 거치지 않고 APK 를 직접 나눠 주는 구조지만, 나중에 Play
> 스토어로 갈 때도 같은 키를 쓰게 된다.

secret 에 넣을 base64 문자열을 만든다 (**줄바꿈 없이 한 줄로** — `-w0` 를 빠뜨리면 잘린 값이
들어가서 `apksigner` 가 알아보기 힘든 오류를 낸다):

```bash
base64 -w0 upload.jks          # 리눅스 · WSL
base64 -i upload.jks | pbcopy  # macOS (클립보드로)
```

## 2. iOS

iOS 는 손이 많이 간다. 여섯 단계이고 순서대로 하면 된다. `.p12` 를 만드는 3단계는 **맥에서만**
할 수 있다(Keychain Access 가 필요하다). 나머지는 브라우저에서 한다.

### 2-1. Apple Developer Program

<https://developer.apple.com/programs/> 에서 가입한다. 연 $99 이고 승인에 하루 이틀 걸릴 수 있다.
**무료 계정으로는 TestFlight 에 올릴 수 없다.**

### 2-2. App ID 등록과 앱 만들기

1. <https://developer.apple.com/account/resources/identifiers/list> → **+** → App IDs → App
   → Bundle ID 를 **Explicit** 으로 `org.packer.scanner` (이 값은 `capacitor.config.json` 의
   `appId` 와 **정확히** 같아야 한다)
2. <https://appstoreconnect.apple.com> → 나의 앱 → **+** → 신규 앱
   → 플랫폼 iOS, 번들 ID 는 방금 만든 `org.packer.scanner`, 이름과 SKU 는 아무거나

2번을 빠뜨리면 빌드는 다 되고 업로드 마지막에
`No suitable application records were found` 로 죽는다.

### 2-3. 배포 인증서 `.p12` (맥에서)

1. **Keychain Access** → 메뉴 `인증서 지원` → `인증 기관에 인증서 요청`
   → 이메일 아무거나, `디스크에 저장` 선택, 키 크기 2048 · RSA → `CertificateSigningRequest.certSigningRequest` 저장
2. <https://developer.apple.com/account/resources/certificates/list> → **+**
   → **Apple Distribution** 선택 → 1번에서 만든 CSR 업로드 → `.cer` 내려받기
3. `.cer` 을 두 번 눌러 로그인 키체인에 넣는다
4. Keychain Access 왼쪽에서 **나의 인증서**(My Certificates) → `Apple Distribution: …` 항목을
   우클릭 → **내보내기** → `.p12` 로 저장, 암호를 정한다

> 4번에서 반드시 **나의 인증서** 목록에서 내보내야 한다. `인증서` 목록에서 내보내면 개인키가
> 빠진 `.p12` 가 나오고, CI 에서 "서명 신원을 하나도 못 찾았다" 로 죽는다.

### 2-4. App Store 프로비저닝 프로파일

<https://developer.apple.com/account/resources/profiles/list> → **+**
→ Distribution 쪽의 **App Store Connect** → App ID 는 `org.packer.scanner`
→ 인증서는 2-3 에서 만든 것 → 이름을 정하고 → `.mobileprovision` 내려받기

이름은 secret 으로 넣지 않는다 — 워크플로가 파일에서 직접 읽는다.

### 2-5. Team ID

<https://developer.apple.com/account> → **Membership details** 에 있는 10자짜리 값
(예: `A1B2C3D4E5`).

### 2-6. App Store Connect API 키

TestFlight 업로드에 쓴다. 만들려면 계정이 **Admin** 이어야 한다.

<https://appstoreconnect.apple.com/access/integrations/api> → 팀 키 → **+**
→ 이름 아무거나, 액세스는 **App Manager** → 생성

- **Issuer ID** — 키 목록 위에 있는 UUID
- **키 ID** — 만들어진 행에 있는 10자 값
- **`AuthKey_<키ID>.p8`** — **딱 한 번만 내려받을 수 있다.** 잃으면 키를 새로 만들어야 한다

### 2-7. base64 로 바꾸기

```bash
base64 -i dist.p12                  | pbcopy   # → IOS_DIST_CERT_P12_BASE64
base64 -i profile.mobileprovision   | pbcopy   # → IOS_PROVISIONING_PROFILE_BASE64
base64 -i AuthKey_ABCDE12345.p8     | pbcopy   # → APPSTORE_API_PRIVATE_KEY_BASE64
```

리눅스·WSL 이면 `base64 -w0 <파일>` 을 쓴다.

## 3. GitHub 에 등록하기

저장소 → `Settings` → `Secrets and variables` → `Actions`.
**Repository secrets** 에 넣는다 (Environment 쪽에 넣으면 이 워크플로는 읽지 못한다).

| Secret | 담는 것 | 어디서 |
| --- | --- | --- |
| `ANDROID_KEYSTORE_BASE64` | 키스토어 `.jks` 의 base64 | 1절 |
| `ANDROID_KEYSTORE_PASSWORD` | 키스토어 암호 | 1절 |
| `ANDROID_KEY_ALIAS` | 키 별칭 (위 명령대로면 `upload`) | 1절 |
| `ANDROID_KEY_PASSWORD` | **선택** — 비워 두면 키스토어 암호를 쓴다 | 1절 |
| `IOS_DIST_CERT_P12_BASE64` | 배포 인증서 `.p12` 의 base64 | 2-3 |
| `IOS_DIST_CERT_PASSWORD` | `.p12` 를 내보낼 때 정한 암호 | 2-3 |
| `IOS_PROVISIONING_PROFILE_BASE64` | `.mobileprovision` 의 base64 | 2-4 |
| `APPSTORE_ISSUER_ID` | API Issuer ID (UUID) | 2-6 |
| `APPSTORE_KEY_ID` | API 키 ID (10자) | 2-6 |
| `APPSTORE_API_PRIVATE_KEY_BASE64` | `AuthKey_*.p8` 의 base64 | 2-6 |

같은 화면의 **Variables** 탭에 하나 더 넣는다:

| Variable | 담는 것 |
| --- | --- |
| `APPLE_TEAM_ID` | 10자 팀 ID (2-5) |

Team ID 만 secret 이 아니라 변수인 이유: 비밀이 아니고, secret 으로 넣으면 GitHub 가 로그에서
`***` 로 가려 버려서 `No profile for team '***' matching …` 같은 서명 오류를 읽을 수 없게 된다.
서명 문제는 로그를 보고 고치는 종류라 가려지면 곤란하다.

## 4. 처음 실행하기

`Actions` → **Release (모바일)** → `Run workflow`. 이 순서로 하면 TestFlight 빌드 번호를
낭비하지 않고 문제를 다 잡을 수 있다.

1. `platforms: android`, `upload_to_testflight: 끄기`
   → 키스토어와 APK 서명만 확인한다. 로그의 `apksigner verify --print-certs` 출력이 내
   인증서인지 본다. 성공하면 릴리스가 만들어지고 APK 가 붙는다.
2. `platforms: ios`, `upload_to_testflight: 끄기`
   → 키체인 · 프로파일 · 아카이브 · 업로드 자격까지 검증만 한다(`--validate-app`).
   **iOS 서명 문제는 거의 다 여기서 드러난다.**
3. `platforms: ios`, `upload_to_testflight: 켜기`
   → App Store Connect → TestFlight 에 빌드가 "처리 중" 으로 뜬다. 처리에 10~30분 걸린다.
4. `platforms: android+ios` → 본 실행.

### 첫 업로드 뒤에 한 번 해야 하는 것

App Store Connect 가 **수출 규정 준수**(Export Compliance)를 묻는다. 답하지 않으면 빌드가
테스터에게 가지 않는다. 이 앱은 자기가 암호화를 하지 않는다 — 암호화는 데스크톱 Packer 가 하고,
앱은 이미 암호화된 텍스트를 QR 로 모아 그대로 저장할 뿐이다. 네트워크 통신도 없다.

매 빌드마다 묻는 것이 번거로우면 `Info.plist` 에
`ITSAppUsesNonExemptEncryption = false` 를 넣어 두면 질문이 사라진다. `ios/` 는 매번 새로
만들어지므로 `scripts/patch-native.mjs` 에 추가해야 유지된다. **다만 이건 법적 신고 내용이므로
직접 확인하고 넣기로 결정한다** — 그래서 기본으로는 넣지 않았다.

TestFlight **내부 테스터**(팀 구성원)는 처리가 끝나면 바로 받는다. **외부 테스터**에게 주려면
베타 심사를 한 번 통과해야 한다.

## 5. 자주 나는 오류

| 메시지 | 원인과 조치 |
| --- | --- |
| `secret … 이 비어 있습니다` | secret 이름 오타, 또는 Repository 가 아닌 Environment 에 넣었다 |
| `변수 APPLE_TEAM_ID 가 비어 있습니다` | Secrets 탭이 아니라 **Variables** 탭에 넣어야 한다 |
| `apksigner` 가 암호가 틀리다고 한다 | 암호 불일치, 또는 base64 를 `-w0` 없이 만들어 값이 잘렸다 |
| `find-identity` 가 신원을 0개 찾는다 | `.p12` 에 개인키가 없다. Keychain Access 의 **나의 인증서**에서 다시 내보낸다 (2-3) |
| codesign 이 응답 없이 멈춘다 | 워크플로가 `security set-key-partition-list` 로 막아 둔 증상이다. 이게 뜨면 키체인 준비 스텝이 실패한 것이니 그 로그를 본다 |
| `No profile for team 'XXXX' matching '…' found` | 프로파일이 그 팀·App ID 것이 아니거나, App Store 용이 아니다 (2-4 를 다시) |
| `… does not support provisioning profiles … (in target 'nanopb' from project 'Pods')` | `xcodebuild NAME=value` 로 넘긴 빌드 설정은 타겟을 골라 줄 수 없어 **워크스페이스의 모든 타겟**에 적용된다. pod 타겟은 프로파일을 품을 수 없어서 죽는다. 그래서 서명 설정은 명령줄이 아니라 `서명 설정 적용` 스텝(`scripts/set-ios-signing.mjs`)이 앱 타겟 빌드 설정에 직접 넣는다. 이 오류가 다시 났다면 `아카이브` 스텝에 서명 관련 설정이 되돌아온 것이다 (Podfile 의 `post_install` 로는 못 막는다 — 명령줄 설정이 프로젝트 파일 설정보다 우선한다) |
| `앱 타겟의 Release 빌드 설정을 찾지 못했다` | Capacitor 템플릿의 `project.pbxproj` 가 바뀌어 `scripts/set-ios-signing.mjs` 의 앵커가 빗나갔다. `mobile/tests/set-ios-signing.test.js` 의 고정 판본과 실제 파일을 견주어 앵커를 고친다 |
| `워크스페이스에 'App' 스킴이 없습니다` | `cap add ios` 는 공유 스킴을 만들지 않는다. 로그의 스킴 목록을 보고 이름을 확인하거나, 맥에서 Xcode 로 한 번 열어 `ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme` 을 만들어 커밋한다 |
| 앱은 켜지는데 **스캔이 안 된다** | iOS 프로젝트가 SPM 으로 만들어졌다. `npm run check:native` 가 잡아 주지만, 손으로 `npx cap add ios` 를 쓰면 이 상태가 된다 — 반드시 `npm run add:ios` |
| `No suitable application records were found` | App Store Connect 에 앱을 아직 등록하지 않았다 (2-2 의 2번) |
| `Authentication credentials are missing or invalid` | `APPSTORE_KEY_ID` 와 `.p8` 파일이 서로 다른 키다. 또는 API 키의 권한이 App Manager 보다 낮다 |
| `an attribute with a value that has already been used` | 빌드 번호가 중복이다. 아래 '빌드 번호' 를 본다 |
| `pod install` 이 podspec 을 못 찾는다 | `mobile/ios/App` 에서 `pod install --repo-update` 를 직접 돌려 본다. 그래도 안 되면 플러그인 버전이 CocoaPods 트렁크에 아직 없는지 확인한다 |
| `could not find compatible versions for pod "GoogleMLKit/BarcodeScanning"` … `required a higher minimum deployment target` | Podfile 의 배포 타깃이 GoogleMLKit 이 요구하는 값보다 낮다. `npm run add:ios` 가 15.5 로 올려 주므로, 이 오류가 났다면 `npx cap add ios` 를 손으로 썼거나 플러그인이 더 높은 값을 요구하도록 올라간 것이다. 후자면 `mobile/scripts/patch-native.mjs` 의 `IOS_DEPLOYMENT_TARGET` 을 올린다 |

## 6. 버전 · 빌드 번호 · 갱신 주기

**버전**(`0.1.1`)은 `mobile-v*` 태그에서 계산한다. 태그가 하나도 없는 최초 릴리스만
`mobile/package.json` 의 `version` 을 씨앗으로 쓰고, 그 뒤로는 태그가 기준이다. 버전 올림을
저장소에 되커밋하지 않으므로 `mobile/package.json` 의 값은 그대로 남는다(데스크톱 워크플로와
같은 방식이다).

**빌드 번호**(iOS `CFBundleVersion`, 안드로이드 `versionCode`)는 `github.run_number` 다. 항상
단조 증가하므로 같은 버전을 다시 빌드해 올려도 App Store Connect 가 중복으로 거부하지 않는다.
**주의: 워크플로 파일 이름을 바꾸면 이 번호가 1로 초기화된다.** 그렇게 되면 이미 쓴 번호와
겹쳐서 업로드가 거부되니, 파일 이름은 그냥 두는 것이 좋다.

| 무엇 | 언제 다시 해야 하나 |
| --- | --- |
| 배포 인증서 `.p12` | 1년 (만료되면 2-3 을 다시 하고 secret 2개를 갈아 준다) |
| 프로비저닝 프로파일 | 1년, 또는 인증서를 새로 만들 때마다 |
| API 키 `.p8` | 만료 없음 (직접 폐기할 때까지) |
| 키스토어 | 없음 — **영구 보관** |
