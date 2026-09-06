# 모바일 릴리스 (APK · Google Play · TestFlight)

`.github/workflows/release-mobile.yml` 이 세 가지를 한 번에 한다. Actions 탭에서 손으로
실행한다(자동 실행은 없다).

- 안드로이드 **서명된 APK** 를 GitHub 릴리스에 붙인다 (스토어를 거치지 않는 직접 설치용)
- 안드로이드 **AAB** 를 **Google Play** 트랙에 올린다
- iOS **IPA** 를 **TestFlight** 에 올린다

데스크톱 릴리스(`.github/workflows/release.yml`)와 **완전히 분리된 트랙**이다. 태그 접두사가
`mobile-v` 라서 서로의 버전을 끌어올리지 않는다 — 앱만 고쳤을 때 데스크톱 버전이 따라 오르거나
그 반대가 되는 일이 없다.

이 문서는 **한 번만** 하는 준비 작업을 다룬다. 준비가 끝나면 릴리스는 Actions 탭에서
버튼 한 번이다.

## 워크플로가 하는 일

| 잡 | 어디서 | 무엇 |
| --- | --- | --- |
| `prepare` | ubuntu | `mobile-v*` 태그를 훑어 다음 버전을 정하고, `npm ci && npm test` 로 앱 테스트를 돌린다 |
| `android` | ubuntu | `npm run add:android` → Gradle `assembleRelease bundleRelease` → APK 는 `zipalign`+`apksigner`, AAB 는 `jarsigner` 로 서명 |
| `play` | ubuntu | `android` 의 AAB 아티팩트를 받아 `scripts/upload-to-play.mjs` 로 Play 트랙에 올린다 |
| `ios` | macos-26 | iOS 26 SDK 이상을 담은 Xcode 를 고른 뒤 → `npm run add:ios` → `pod install` → `xcodebuild archive` → IPA → `altool` 로 TestFlight |
| `release` | ubuntu | 변경 이력을 만들고 `gh release create` 로 릴리스에 APK 를 붙인다 |

`android/` 와 `ios/` 는 저장소에 없는 **생성물**이라 매 실행마다 새로 만든다. 그래서
`scripts/patch-native.mjs`(필수 네이티브 설정), `scripts/set-native-version.mjs`(버전·빌드 번호),
`scripts/set-ios-signing.mjs`(iOS 앱 타겟의 수동 서명 설정)가 빌드 직전에 반드시 돌아야 하고,
워크플로가 그 순서를 지킨다. 자세한 근거는 세 스크립트의 첫 주석에 적어 두었다.

`play` 를 `android` 와 나누어 둔 것은 **업로드만 실패했을 때 다시 빌드하지 않기 위해서**다.
막히는 자리는 대개 서명이 아니라 Play 쪽 설정(권한·앱 콘텐츠 양식)이라, 그럴 때는 실행 화면의
`Re-run failed jobs` 를 누르면 같은 AAB 로 업로드만 다시 시도한다.

실행할 때 고르는 것:

| 입력 | 뜻 |
| --- | --- |
| `bump` | `major` · `minor` · `patch` — 올릴 자리 |
| `platforms` | `android+ios` · `android` · `ios` — 서명이 한쪽만 깨졌을 때 그쪽만 다시 돌리기 위한 것 |
| `play_track` | `none` · `internal` · `alpha` · `beta` · `production` — `none` 이면 Play 에 올리지 않는다 |
| `upload_to_play` | 끄면 번들을 올려 보고 `edits.validate` 까지만 한 뒤 되돌린다 (Play 에 아무것도 남지 않는다) |
| `upload_to_testflight` | 끄면 `altool --validate-app` 까지만 한다 (아래 '처음 실행하기' 참고) |

**`platforms: ios` 만 돌린 실행은 GitHub 릴리스를 만들지 않는다.** 붙일 APK 가 없고, 그 실행의
결과물은 TestFlight 빌드 자체다. 태그도 만들지 않으니 다음 실행이 같은 버전을 다시 계산한다.
Play 업로드가 실패했을 때도 같은 이유로 릴리스를 만들지 않는다 — 태그를 아껴 두어야 같은
실행을 이어서 고칠 수 있다.

**AAB 와 IPA 는 릴리스에 붙이지 않는다.** AAB 는 그 자체로 설치되는 파일이 아니고(Play 가 이걸로
기기별 APK 를 만들어 준다), IPA 는 TestFlight·ad-hoc 밖에서는 설치할 수 없다 — 받는 사람만
헷갈린다. 필요하면 그 실행의 워크플로 아티팩트(`android-aab` · `ios-ipa`)에서 내려받으면 된다.
Play 에 **처음** 올릴 때 손으로 올릴 파일이 바로 이 `android-aab` 다 (2절).

## 준비 체크리스트

- [ ] 안드로이드: 서명 키스토어를 만들어 secret 3개 등록
- [ ] Play: 개발자 계정 등록 (최초 1회 $25) 과 신원 확인
- [ ] Play: Play Console 에서 앱을 만들고 **첫 AAB 를 손으로 한 번 올린다** (API 로는 못 한다)
- [ ] Play: 앱 콘텐츠 양식(개인정보처리방침·데이터 보안·콘텐츠 등급 등)을 채운다
- [ ] Play: 서비스 계정을 만들어 JSON 키를 secret 1개로 등록하고 Play Console 에서 권한 부여
- [ ] iOS: Apple Developer Program 가입 (연 $99 · 개인도 가능)
- [ ] iOS: App Store Connect 에 `org.packer.scanner` 로 앱 등록
- [ ] iOS: 배포 인증서 `.p12` 를 만들어 secret 2개 등록
- [ ] iOS: App Store 프로비저닝 프로파일을 만들어 secret 1개 등록
- [ ] iOS: App Store Connect API 키를 만들어 secret 3개 등록
- [ ] Team ID 를 **변수**(secret 아님)로 등록
- [ ] `upload_to_play` · `upload_to_testflight` 를 끈 채로 한 번 돌려 자격 증명만 검증

APK 만 나눠 줄 거면 첫 항목 하나로 끝난다 — `platforms: android`, `play_track: none` 으로
돌리는 실행은 Play·iOS 자격 증명을 전혀 보지 않는다.

## 1. 안드로이드 서명 키스토어

APK 와 AAB 에 서명할 키를 만든다. 한 번 만들면 계속 쓴다. Play 에 올릴 때 이 키는
**업로드 키**가 된다 (2절의 '두 가지 서명' 참고).

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
> 따로 보관한다. Play 쪽은 업로드 키를 잃어도 Google 지원으로 교체할 수 있지만
> (Play 앱 서명 덕분이다), GitHub 릴리스로 직접 나눠 준 APK 는 그런 구제 수단이 없다.

secret 에 넣을 base64 문자열을 만든다 (**줄바꿈 없이 한 줄로** — `-w0` 를 빠뜨리면 잘린 값이
들어가서 `apksigner` 가 알아보기 힘든 오류를 낸다):

```bash
base64 -w0 upload.jks          # 리눅스 · WSL
base64 -i upload.jks | pbcopy  # macOS (클립보드로)
```

## 2. Google Play

시작하기 전에 알아 둘 것이 두 가지 있다. 둘 다 나중에 되돌리기 어렵다.

### 첫 업로드는 손으로 해야 한다

Play Developer API 는 **이미 Play Console 에 있는 앱에만** 번들을 올릴 수 있다. 앱을 만드는 것도,
그 앱의 첫 AAB 를 올리는 것도 API 로는 안 된다. 그래서 순서가 이렇게 된다.

1. 워크플로를 `play_track: none` 으로 한 번 돌려 **AAB 를 만든다** (아티팩트에서 받는다)
2. Play Console 에서 앱을 만들고 그 AAB 를 **손으로** 올린다
3. 그다음부터 워크플로가 자동으로 올린다

### 두 가지 서명 — GitHub 의 APK 와 Play 의 앱은 서로 덮어쓰지 못한다

Play 는 2021년부터 **Play 앱 서명**을 의무로 쓴다. 우리가 만든 키는 '업로드 키' 일 뿐이고,
사용자가 실제로 받는 앱은 Google 이 보관하는 '앱 서명 키' 로 다시 서명된다.

그 결과 **GitHub 릴리스에 붙는 APK 와 Play 에서 받은 앱은 서명이 다르다.** 안드로이드는 서명이
다르면 덮어쓰기를 거부하므로, 한쪽을 깔아 둔 기기에 다른 쪽을 설치하려면 먼저 지워야 한다
(데이터도 함께 지워진다). 두 갈래로 나눠 주기로 한 이상 피할 수 없는 일이고, 릴리스 노트에도
이 문장이 자동으로 들어간다.

앱을 만들 때 '앱 서명 키를 직접 업로드'(PEPK 도구)를 고르면 둘을 같은 키로 맞출 수 있다. 다만
그 순간부터 **키를 잃으면 Google 도 도와줄 수 없다.** 특별한 이유가 없으면 기본값(Google 이 앱
서명 키를 만들어 보관)을 쓰고 위 사실만 기억하는 편이 낫다. Play 와 똑같이 서명된 APK 가
필요하면 Play Console → **App Bundle Explorer → Downloads** 에서 받을 수 있다.

### 2-1. 개발자 계정

<https://play.google.com/console/signup> — **최초 1회 $25** (애플과 달리 연회비는 없다).

가입 뒤 **신원 확인**을 통과해야 앱을 낼 수 있다. 개인 계정은 신분증과 주소, 조직 계정은 D-U-N-S
번호가 필요하고 며칠 걸릴 수 있다.

> **2023년 11월 13일 이후에 만든 개인 계정**은 프로덕션으로 나가기 전에 비공개 테스트(closed
> testing)에서 **테스터 12명이 14일 연속** 참여한 기록이 있어야 한다. 내부 테스트(`internal`)
> 트랙은 이 제약과 무관하므로, 이 워크플로의 기본값인 `internal` 로 시작하면 된다.

### 2-2. 앱 만들기와 첫 AAB 올리기

1. 워크플로를 `platforms: android`, `play_track: none` 으로 한 번 돌린다. 끝나면 실행 화면 아래
   **Artifacts** 의 `android-aab` 에서 `packer-scanner-vX.Y.Z-android.aab` 를 받는다.
2. Play Console → **앱 만들기** → 앱 이름 · 기본 언어 · 앱/게임 · 무료/유료를 고른다.
   기본 언어는 나중에 릴리스 노트 언어(`PLAY_RELEASE_NOTES_LANGUAGE`)와 맞춰야 하니 기억해 둔다.
3. **테스트 → 내부 테스트 → 새 버전 만들기** → 1번 AAB 를 올린다.
   - 여기서 **Play 앱 서명 등록**과 **패키지 이름 확정**이 함께 일어난다. 패키지 이름은
     AAB 에서 읽어 `org.packer.scanner` 로 잡히고 (= `capacitor.config.json` 의 `appId`),
     **한 번 정해지면 바꿀 수 없다.**
4. 저장 → 버전 검토 → **내부 테스트로 출시**.
5. 같은 화면의 **테스터** 탭에서 이메일 목록을 만들고 **옵트인 링크**를 받아 나눠 준다. 내부
   테스트는 최대 100명이고 심사가 사실상 없어서 몇 분이면 받아 볼 수 있다.

여기까지 하면 API 가 이 앱을 알아본다.

### 2-3. 앱 콘텐츠 양식

Play Console 왼쪽 **정책 및 프로그램 → 앱 콘텐츠**. 개인정보처리방침 URL, 광고 포함 여부,
데이터 보안, 콘텐츠 등급, 타겟층 등을 채운다. 내부 테스트에서도 대부분 요구하고, 비워 두면
Play Console 의 출시 버튼이 잠긴다. API 로 올릴 때는 커밋이 거절되거나, 반영은 되지만
'검토를 위해 전송' 을 사람이 눌러야 하는 상태로 남는다 (5절의 '올린 뒤에 확인할 것').

이 앱은 네트워크를 전혀 쓰지 않고, 카메라 영상은 화면 안에서 디코딩만 되고 기기 밖으로 나가지
않는다. 저장하는 것은 사용자가 직접 만든 `.txt` 하나뿐이다. **다만 데이터 보안 양식은 법적
신고 내용이므로 직접 확인하고 답한다.**

### 2-4. 서비스 계정 (API 자격 증명)

워크플로가 Play 에 접속할 때 쓰는 계정이다. 개인 구글 계정이 아니라 서비스 계정을 쓴다.

1. Play Console → 왼쪽 아래 **설정 → API 액세스** → Google Cloud 프로젝트를 새로 만들거나
   기존 프로젝트를 연결한다.
2. 같은 화면의 **서비스 계정** → **새 서비스 계정 만들기** → 안내대로 Google Cloud Console 로
   이동해 서비스 계정을 만든다. 이름은 아무거나 좋고, **Cloud 쪽 역할(role)은 주지 않아도 된다**
   — 권한은 Play Console 에서 준다.
3. 만든 서비스 계정 → **키** 탭 → **키 추가 → 새 키 만들기 → JSON** → 파일이 내려받아진다.
   **다시 받을 수 없다.** 잃으면 키를 새로 만들어야 한다.
4. Play Console 의 API 액세스 화면으로 돌아와 새로고침하면 목록에 뜬다. → **액세스 권한 부여**
   - **앱 권한**: `Packer Scanner` 하나만 고른다.
   - **계정 권한**: `앱 버전 만들기 및 수정` 과 `테스트 트랙에 출시` 만 준다. 프로덕션 트랙까지
     쓸 생각이면 `프로덕션 트랙에 출시` 도 켠다. 재무·주문 관련 권한은 주지 않는다.
5. **권한이 반영되기까지 몇 분 걸린다.** 바로 돌리면 `The caller does not have permission` (403)
   이 난다 — 설정이 틀린 게 아니니 잠시 뒤 다시 돌린다.

### 2-5. base64 로 바꾸기

```bash
base64 -w0 play-service-account.json          # 리눅스 · WSL
base64 -i play-service-account.json | pbcopy  # macOS (클립보드로)
```

→ `PLAY_SERVICE_ACCOUNT_JSON_BASE64` secret 에 넣는다 (4절).

### 2-6. 어느 트랙에 올릴까

| 트랙 | 누가 받나 | 심사 | 쓰임 |
| --- | --- | --- | --- |
| `internal` | 내부 테스터 목록 (최대 100명) | 사실상 없음 (몇 분) | **기본값.** 평소 릴리스는 여기로 |
| `alpha` | 비공개 테스트 — 이메일 목록·구글 그룹 | 첫 회 심사 | 개인 계정의 '12명 14일' 요건을 채우는 트랙 |
| `beta` | 공개 테스트 — 링크로 누구나 | 심사 | 넓게 열어 보고 싶을 때 |
| `production` | 스토어 전체 | 심사 (며칠) | 정식 출시 |

`production` 을 고르면 워크플로는 **곧바로 100% 배포**로 올린다(단계적 출시를 쓰지 않는다).
정식 출시는 Play Console 에서 눈으로 확인하며 하는 편이 안전하다.

### 2-7. 워크플로가 Play 에 하는 일

`scripts/upload-to-play.mjs` 가 API 를 다섯 번 부른다. 의존성은 없고 Node 기본 모듈만 쓴다.

1. 서비스 계정 키로 JWT 를 만들어 액세스 토큰을 받는다
2. `edits.insert` — 편집을 연다
3. `edits.bundles.upload` — AAB 를 올린다 (Play 가 versionCode 를 돌려준다)
4. `edits.tracks.update` — 그 versionCode 를 트랙에 올린다
5. `edits.commit` — 반영한다 (`upload_to_play` 를 끄면 `edits.validate` 까지만 하고 편집을
   되돌린다)

3번에서 돌려받은 versionCode 가 워크플로가 넣은 빌드 번호와 다르면 커밋하지 않고 죽는다.
`set-native-version.mjs` 가 돌지 않아 `versionCode 1` 로 빌드된 번들을 올리는 사고를 막는 관문이다.

중간에 실패하면 열어 둔 편집을 지우고 나가므로 Play 쪽에는 아무것도 남지 않는다.

## 3. iOS

iOS 는 손이 많이 간다. 여섯 단계이고 순서대로 하면 된다. `.p12` 를 만드는 3단계는 **맥에서만**
할 수 있다(Keychain Access 가 필요하다). 나머지는 브라우저에서 한다.

### 3-1. Apple Developer Program

<https://developer.apple.com/programs/> 에서 가입한다. 연 $99 이고 승인에 하루 이틀 걸릴 수 있다.
**무료 계정으로는 TestFlight 에 올릴 수 없다.**

### 3-2. App ID 등록과 앱 만들기

1. <https://developer.apple.com/account/resources/identifiers/list> → **+** → App IDs → App
   → Bundle ID 를 **Explicit** 으로 `org.packer.scanner` (이 값은 `capacitor.config.json` 의
   `appId` 와 **정확히** 같아야 한다)
2. <https://appstoreconnect.apple.com> → 나의 앱 → **+** → 신규 앱
   → 플랫폼 iOS, 번들 ID 는 방금 만든 `org.packer.scanner`, 이름과 SKU 는 아무거나

2번을 빠뜨리면 빌드는 다 되고 업로드 마지막에
`No suitable application records were found` 로 죽는다.

### 3-3. 배포 인증서 `.p12` (맥에서)

1. **Keychain Access** → 메뉴 `인증서 지원` → `인증 기관에 인증서 요청`
   → 이메일 아무거나, `디스크에 저장` 선택, 키 크기 2048 · RSA → `CertificateSigningRequest.certSigningRequest` 저장
2. <https://developer.apple.com/account/resources/certificates/list> → **+**
   → **Apple Distribution** 선택 → 1번에서 만든 CSR 업로드 → `.cer` 내려받기
3. `.cer` 을 두 번 눌러 로그인 키체인에 넣는다
4. Keychain Access 왼쪽에서 **나의 인증서**(My Certificates) → `Apple Distribution: …` 항목을
   우클릭 → **내보내기** → `.p12` 로 저장, 암호를 정한다

> 4번에서 반드시 **나의 인증서** 목록에서 내보내야 한다. `인증서` 목록에서 내보내면 개인키가
> 빠진 `.p12` 가 나오고, CI 에서 "서명 신원을 하나도 못 찾았다" 로 죽는다.

### 3-4. App Store 프로비저닝 프로파일

<https://developer.apple.com/account/resources/profiles/list> → **+**
→ Distribution 쪽의 **App Store Connect** → App ID 는 `org.packer.scanner`
→ 인증서는 3-3 에서 만든 것 → 이름을 정하고 → `.mobileprovision` 내려받기

이름은 secret 으로 넣지 않는다 — 워크플로가 파일에서 직접 읽는다.

### 3-5. Team ID

<https://developer.apple.com/account> → **Membership details** 에 있는 10자짜리 값
(예: `A1B2C3D4E5`).

### 3-6. App Store Connect API 키

TestFlight 업로드에 쓴다. 만들려면 계정이 **Admin** 이어야 한다.

<https://appstoreconnect.apple.com/access/integrations/api> → 팀 키 → **+**
→ 이름 아무거나, 액세스는 **App Manager** → 생성

- **Issuer ID** — 키 목록 위에 있는 UUID
- **키 ID** — 만들어진 행에 있는 10자 값
- **`AuthKey_<키ID>.p8`** — **딱 한 번만 내려받을 수 있다.** 잃으면 키를 새로 만들어야 한다

### 3-7. base64 로 바꾸기

```bash
base64 -i dist.p12                  | pbcopy   # → IOS_DIST_CERT_P12_BASE64
base64 -i profile.mobileprovision   | pbcopy   # → IOS_PROVISIONING_PROFILE_BASE64
base64 -i AuthKey_ABCDE12345.p8     | pbcopy   # → APPSTORE_API_PRIVATE_KEY_BASE64
```

리눅스·WSL 이면 `base64 -w0 <파일>` 을 쓴다.

## 4. GitHub 에 등록하기

저장소 → `Settings` → `Secrets and variables` → `Actions`.
**Repository secrets** 에 넣는다 (Environment 쪽에 넣으면 이 워크플로는 읽지 못한다).

| Secret | 담는 것 | 어디서 |
| --- | --- | --- |
| `ANDROID_KEYSTORE_BASE64` | 키스토어 `.jks` 의 base64 | 1절 |
| `ANDROID_KEYSTORE_PASSWORD` | 키스토어 암호 | 1절 |
| `ANDROID_KEY_ALIAS` | 키 별칭 (위 명령대로면 `upload`) | 1절 |
| `ANDROID_KEY_PASSWORD` | **선택** — 비워 두면 키스토어 암호를 쓴다 | 1절 |
| `PLAY_SERVICE_ACCOUNT_JSON_BASE64` | 서비스 계정 JSON 키의 base64 | 2-4 · 2-5 |
| `IOS_DIST_CERT_P12_BASE64` | 배포 인증서 `.p12` 의 base64 | 3-3 |
| `IOS_DIST_CERT_PASSWORD` | `.p12` 를 내보낼 때 정한 암호 | 3-3 |
| `IOS_PROVISIONING_PROFILE_BASE64` | `.mobileprovision` 의 base64 | 3-4 |
| `APPSTORE_ISSUER_ID` | API Issuer ID (UUID) | 3-6 |
| `APPSTORE_KEY_ID` | API 키 ID (10자) | 3-6 |
| `APPSTORE_API_PRIVATE_KEY_BASE64` | `AuthKey_*.p8` 의 base64 | 3-6 |

같은 화면의 **Variables** 탭에 둘을 더 넣는다:

| Variable | 담는 것 |
| --- | --- |
| `APPLE_TEAM_ID` | 10자 팀 ID (3-5) |
| `PLAY_RELEASE_NOTES_LANGUAGE` | **선택** — Play 릴리스 노트를 넣을 언어 (예: `ko-KR`) |

Team ID 만 secret 이 아니라 변수인 이유: 비밀이 아니고, secret 으로 넣으면 GitHub 가 로그에서
`***` 로 가려 버려서 `No profile for team '***' matching …` 같은 서명 오류를 읽을 수 없게 된다.
서명 문제는 로그를 보고 고치는 종류라 가려지면 곤란하다.

`PLAY_RELEASE_NOTES_LANGUAGE` 는 비워 두어도 된다 — 그러면 릴리스 노트 없이 올린다. 넣을 때는
**Play Console 의 스토어 등록 정보에 실제로 있는 언어**여야 한다. 없는 언어를 보내면 Play 가
편집 전체를 거절한다.

## 5. 처음 실행하기

`Actions` → **Release (모바일)** → `Run workflow`. 이 순서로 하면 TestFlight 빌드 번호를
낭비하지 않고 문제를 다 잡을 수 있다.

1. `platforms: android`, `play_track: none`
   → 키스토어와 서명만 확인한다. 로그의 `apksigner verify --print-certs` 와 AAB 쪽
   `Certificate fingerprints` 가 내 인증서인지 본다. 성공하면 릴리스가 만들어지고 APK 가
   붙으며, 아티팩트에 **Play 에 손으로 올릴 AAB** 가 남는다 (2-2 에서 쓴다).
2. 2절을 따라 Play Console 에 앱을 만들고 그 AAB 를 손으로 올린다. 서비스 계정 권한이
   반영될 때까지 몇 분 기다린다.
3. `platforms: android`, `play_track: internal`, `upload_to_play: 끄기`
   → 서비스 계정 · 권한 · 패키지 이름을 검증만 한다(`edits.validate`). **Play 쪽 문제는 거의
   다 여기서 드러나고, Play 에는 아무것도 남지 않는다.**
4. `platforms: android`, `play_track: internal`, `upload_to_play: 켜기`
   → Play Console 내부 테스트에 새 버전이 뜬다.
5. `platforms: ios`, `play_track: none`, `upload_to_testflight: 끄기`
   → 키체인 · 프로파일 · 아카이브 · 업로드 자격까지 검증만 한다(`--validate-app`).
   **iOS 서명 문제는 거의 다 여기서 드러난다.**
6. `platforms: ios`, `play_track: none`, `upload_to_testflight: 켜기`
   → App Store Connect → TestFlight 에 빌드가 "처리 중" 으로 뜬다. 처리에 10~30분 걸린다.
7. `platforms: android+ios`, `play_track: internal` → 본 실행.

### 첫 업로드 뒤에 한 번 해야 하는 것 (iOS)

App Store Connect 가 **수출 규정 준수**(Export Compliance)를 묻는다. 답하지 않으면 빌드가
테스터에게 가지 않는다. 이 앱은 자기가 암호화를 하지 않는다 — 암호화는 데스크톱 Packer 가 하고,
앱은 이미 암호화된 텍스트를 QR 로 모아 그대로 저장할 뿐이다. 네트워크 통신도 없다.

매 빌드마다 묻는 것이 번거로우면 `Info.plist` 에
`ITSAppUsesNonExemptEncryption = false` 를 넣어 두면 질문이 사라진다. `ios/` 는 매번 새로
만들어지므로 `scripts/patch-native.mjs` 에 추가해야 유지된다. **다만 이건 법적 신고 내용이므로
직접 확인하고 넣기로 결정한다** — 그래서 기본으로는 넣지 않았다.

TestFlight **내부 테스터**(팀 구성원)는 처리가 끝나면 바로 받는다. **외부 테스터**에게 주려면
베타 심사를 한 번 통과해야 한다.

### 올린 뒤에 확인할 것 (Play)

워크플로가 성공했다는 것은 **버전이 트랙에 반영됐다**는 뜻이지, 테스터가 이미 받을 수 있다는
뜻은 아니다. Play Console → **테스트 → 내부 테스트** 에서 새 버전이 '사용 가능' 으로 바뀌었는지
본다. 처리에 보통 몇 분, 길면 한두 시간 걸린다.

`::warning::Play 가 이 편집을 자동으로 심사에 보내지 못한다고 답했습니다` 가 로그에 찍혔다면
반영은 됐지만 **Play Console 에서 직접 '검토를 위해 전송'** 을 눌러야 배포가 시작된다. 앱 콘텐츠
양식(2-3)이 덜 채워졌을 때 주로 이렇게 된다.

## 6. 자주 나는 오류

| 메시지 | 원인과 조치 |
| --- | --- |
| `secret … 이 비어 있습니다` | secret 이름 오타, 또는 Repository 가 아닌 Environment 에 넣었다 |
| `변수 APPLE_TEAM_ID 가 비어 있습니다` | Secrets 탭이 아니라 **Variables** 탭에 넣어야 한다 |
| `apksigner` 가 암호가 틀리다고 한다 | 암호 불일치, 또는 base64 를 `-w0` 없이 만들어 값이 잘렸다 |
| `AAB 에 서명이 붙지 않았습니다` | `jarsigner` 가 조용히 넘어간 경우다. 바로 위 `jarsigner -verify` 출력을 본다 — 대개 별칭(`ANDROID_KEY_ALIAS`)이 키스토어에 없는 이름이다 |
| Play: `The caller does not have permission` (403) | 서비스 계정에 이 앱 권한을 안 줬거나 (2-4 의 4번), 권한이 아직 반영되지 않았다. 몇 분 뒤 `play` 잡만 다시 돌려 본다 |
| Play: `Package not found: org.packer.scanner` (404) | 아직 Play Console 에 앱이 없거나 첫 AAB 를 손으로 올리지 않았다 (2-2). API 로는 앱을 만들 수 없다 |
| Play: `Track not found` (404) | `play_track` 이름이 틀렸거나, 이름을 직접 지은 비공개 트랙을 Play Console 에서 아직 만들지 않았다 |
| Play: `APK signature is invalid or does not exist` / `signed with the wrong key` | Play 에 등록된 업로드 키와 우리 키스토어가 다르다. 서명 스텝 로그의 `Certificate fingerprints` 와 Play Console → **앱 무결성 → 앱 서명** 의 업로드 인증서 지문을 견준다 |
| Play: `Version code N has already been used` | 같은 versionCode 를 두 번 올렸다. 빌드 번호는 `github.run_number` 라 보통 겹치지 않는다 — 워크플로 파일 이름을 바꿔 번호가 1로 초기화됐는지 본다 (7절) |
| Play: `The language ... is not associated with this app` | `PLAY_RELEASE_NOTES_LANGUAGE` 가 스토어 등록 정보에 없는 언어다. 변수를 비우거나 Play Console 의 기본 언어와 맞춘다 |
| Play: `올라간 versionCode 가 1 인데 --build 는 …` | 빌드 직전 `set-native-version.mjs` 가 돌지 않았다는 뜻이다. 커밋 전에 막아 세운 것이니 안드로이드 잡의 `버전 반영` 스텝 로그를 본다 |
| Play: `서비스 계정 키의 private_key 가 PEM 이 아닙니다` | base64 를 두 번 씌웠거나 값이 잘렸다. JSON 파일 **원본**을 `-w0` 로 한 번만 base64 한다 (2-5) |
| `find-identity` 가 신원을 0개 찾는다 | `.p12` 에 개인키가 없다. Keychain Access 의 **나의 인증서**에서 다시 내보낸다 (3-3) |
| codesign 이 응답 없이 멈춘다 | 워크플로가 `security set-key-partition-list` 로 막아 둔 증상이다. 이게 뜨면 키체인 준비 스텝이 실패한 것이니 그 로그를 본다 |
| `No profile for team 'XXXX' matching '…' found` | 프로파일이 그 팀·App ID 것이 아니거나, App Store 용이 아니다 (3-4 를 다시) |
| `… does not support provisioning profiles … (in target 'nanopb' from project 'Pods')` | `xcodebuild NAME=value` 로 넘긴 빌드 설정은 타겟을 골라 줄 수 없어 **워크스페이스의 모든 타겟**에 적용된다. pod 타겟은 프로파일을 품을 수 없어서 죽는다. 그래서 서명 설정은 명령줄이 아니라 `서명 설정 적용` 스텝(`scripts/set-ios-signing.mjs`)이 앱 타겟 빌드 설정에 직접 넣는다. 이 오류가 다시 났다면 `아카이브` 스텝에 서명 관련 설정이 되돌아온 것이다 (Podfile 의 `post_install` 로는 못 막는다 — 명령줄 설정이 프로젝트 파일 설정보다 우선한다) |
| `앱 타겟의 Release 빌드 설정을 찾지 못했다` | Capacitor 템플릿의 `project.pbxproj` 가 바뀌어 `scripts/set-ios-signing.mjs` 의 앵커가 빗나갔다. `mobile/tests/set-ios-signing.test.js` 의 고정 판본과 실제 파일을 견주어 앵커를 고친다 |
| `워크스페이스에 'App' 스킴이 없습니다` | `cap add ios` 는 공유 스킴을 만들지 않는다. 로그의 스킴 목록을 보고 이름을 확인하거나, 맥에서 Xcode 로 한 번 열어 `ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme` 을 만들어 커밋한다 |
| 앱은 켜지는데 **스캔이 안 된다** | iOS 프로젝트가 SPM 으로 만들어졌다. `npm run check:native` 가 잡아 주지만, 손으로 `npx cap add ios` 를 쓰면 이 상태가 된다 — 반드시 `npm run add:ios` |
| `No suitable application records were found` | App Store Connect 에 앱을 아직 등록하지 않았다 (3-2 의 2번) |
| `Authentication credentials are missing or invalid` | `APPSTORE_KEY_ID` 와 `.p8` 파일이 서로 다른 키다. 또는 API 키의 권한이 App Manager 보다 낮다 |
| `an attribute with a value that has already been used` | 빌드 번호가 중복이다. 아래 '빌드 번호' 를 본다 |
| `SDK version issue. This app was built with the iOS 18.5 SDK. All iOS and iPadOS apps must be built with the iOS 26 SDK or later` (409) | 낡은 Xcode 로 빌드됐다. **러너 이미지를 못박아도 Xcode 판본은 못박히지 않는다** — 이미지에는 Xcode 가 여러 벌 들어 있고 기본 선택본이 가장 새 판본이 아닐 수 있다(macos-15 의 기본값은 Xcode 26.x 를 담고도 16.4 였다). 워크플로의 `Xcode 고르기` 스텝이 iOS SDK 가 `MIN_IOS_SDK_MAJOR` 이상인 가장 새 Xcode 를 골라 이 상황을 막는다. 이 오류가 다시 났다면 Apple 이 요구 판본을 올린 것이니 워크플로 env 의 `MIN_IOS_SDK_MAJOR` 를 올린다 |
| `iOS 26 SDK 이상을 담은 Xcode 를 러너에서 찾지 못했습니다` | 위 스텝이 **빌드를 시작하기 전에** 막아 세운 것이다 (업로드에서 30분 뒤에 죽는 것보다 낫다). 러너 이미지에 그만한 Xcode 가 없다는 뜻이니 `runs-on` 을 더 새 macOS 이미지로 올린다. 어떤 Xcode 가 있는지는 그 스텝 로그가 판본별 SDK 와 함께 찍어 둔다 |
| `pod install` 이 podspec 을 못 찾는다 | `mobile/ios/App` 에서 `pod install --repo-update` 를 직접 돌려 본다. 그래도 안 되면 플러그인 버전이 CocoaPods 트렁크에 아직 없는지 확인한다 |
| `could not find compatible versions for pod "GoogleMLKit/BarcodeScanning"` … `required a higher minimum deployment target` | Podfile 의 배포 타깃이 GoogleMLKit 이 요구하는 값보다 낮다. `npm run add:ios` 가 15.5 로 올려 주므로, 이 오류가 났다면 `npx cap add ios` 를 손으로 썼거나 플러그인이 더 높은 값을 요구하도록 올라간 것이다. 후자면 `mobile/scripts/patch-native.mjs` 의 `IOS_DEPLOYMENT_TARGET` 을 올린다 |

## 7. 버전 · 빌드 번호 · 갱신 주기

**버전**(`0.1.1`)은 `mobile-v*` 태그에서 계산한다. 태그가 하나도 없는 최초 릴리스만
`mobile/package.json` 의 `version` 을 씨앗으로 쓰고, 그 뒤로는 태그가 기준이다. 버전 올림을
저장소에 되커밋하지 않으므로 `mobile/package.json` 의 값은 그대로 남는다(데스크톱 워크플로와
같은 방식이다).

**빌드 번호**(iOS `CFBundleVersion`, 안드로이드 `versionCode`)는 `github.run_number` 다. 항상
단조 증가하므로 같은 버전을 다시 빌드해 올려도 App Store Connect 와 Play 가 중복으로 거부하지
않는다. **주의: 워크플로 파일 이름을 바꾸면 이 번호가 1로 초기화된다.** 그렇게 되면 이미 쓴
번호와 겹쳐서 업로드가 거부되니, 파일 이름은 그냥 두는 것이 좋다.

Play 에 **손으로** 올린 첫 AAB 도 어느 실행에서 나온 것이므로 같은 번호 체계 위에 있다. 그 뒤의
실행은 번호가 더 크니 그대로 이어진다.

| 무엇 | 언제 다시 해야 하나 |
| --- | --- |
| 배포 인증서 `.p12` | 1년 (만료되면 3-3 을 다시 하고 secret 2개를 갈아 준다) |
| 프로비저닝 프로파일 | 1년, 또는 인증서를 새로 만들 때마다 |
| API 키 `.p8` | 만료 없음 (직접 폐기할 때까지) |
| Play 서비스 계정 JSON 키 | 만료 없음 (직접 폐기할 때까지) |
| 키스토어 | 없음 — **영구 보관** |
| 러너 이미지 · Xcode | Apple 이 업로드에 요구하는 최소 SDK 를 올릴 때 (새 iOS 가 나오고 이듬해쯤). 워크플로 env 의 `MIN_IOS_SDK_MAJOR` 를 올리고, `Xcode 고르기` 가 그만한 Xcode 를 못 찾으면 `runs-on` 도 더 새 이미지로 올린다 |
| `@capacitor/android` | Play 가 요구하는 **타겟 API 레벨**이 오를 때 (매년 8월경). `targetSdkVersion` 은 Capacitor 안드로이드 템플릿에서 온다 — 지금은 36 이라 여유가 있다. Play 가 거절하면 `npm update @capacitor/android` 로 올린다 |
