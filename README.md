# Packer

파일과 폴더를 하나의 **암호화된 텍스트**로 묶고, 같은 키로 원본 트리를 그대로 되살리는 윈도우
데스크탑 프로그램. Tauri v2 (Rust + WebView2).

결과물은 바이너리가 아니라 메모장에 붙일 수 있는 텍스트다. 그래서 메신저·메일 본문으로 그냥
보낼 수 있다.

```
-----BEGIN PACKER CONTAINER-----
RlNYUEFDSzEBAAEBAQAAAEK5K6b6r1aIIlxEpDdMCbgnJMwY3L43uqdbB7QKUNsBAAABAAMAAAAE
...
-----END PACKER CONTAINER-----
```

- **묶기** — 창으로 파일/폴더를 끌어다 놓고 암호화 키를 넣은 뒤 "묶고 암호화하기".
  압축 + 직렬화 + 암호화를 한 번에 처리하고 `.txt` 로 저장한다. 결과 텍스트를 화면에서 바로
  확인하고 "전체 복사" 로 클립보드에 담을 수 있다. **QR 코드로도 띄운다** — 한 장에 담기지
  않으면 여러 장으로 나눠 한 번에 한 장씩 보여 주고, 사용자가 순서대로 스캔해 이어 붙인다.
- **풀기** — `.txt` 파일을 놓거나 **받은 텍스트를 붙여넣고** 같은 키로 "풀고 복호화하기".
  복호화 + 역직렬화 + 압축해제 후 지정한 폴더에 모아 준다.

"묶고 암호화하기" 가 성공하면 그 키가 풀기 탭에 자동으로 채워진다. **키는 메모리에만 있고
디스크·localStorage 어디에도 저장하지 않는다** — 앱을 닫으면 사라진다.

---

## 실행

```bash
pnpm install
pnpm dev            # 개발 모드로 창 띄우기
pnpm build          # 릴리스 빌드 → src-tauri/target/release/bundle/nsis/*-setup.exe
```

필요한 것: Rust (MSVC 툴체인), Visual Studio Build Tools, Windows SDK, WebView2 런타임,
Node + pnpm. Tauri CLI 는 `devDependencies` 로 들어 있어 따로 설치하지 않아도 된다.

## 테스트

```bash
pnpm test           # 프론트엔드 배선 (jsdom + 가짜 Tauri 브리지)
pnpm test:rust      # 암호/컨테이너/직렬화 + 끝에서 끝까지 라운드트립
cargo test --manifest-path src-tauri/Cargo.toml -- --ignored   # 대용량(120 MiB) 라운드트립
```

## 구조

```
src/                    프론트엔드 (빌드 스텝 없음, WebView 가 그대로 읽는다)
  index.html            화면
  main.js               배선 — data-pk 훅으로만 DOM 을 참조한다
  styles.css            스타일 + 타이포그래피
  fonts/                자체 호스팅한 Noto Sans KR / Roboto
scripts/fetch-fonts.py  src/fonts/ 를 다시 받아 채운다
tests/frontend.test.js  프론트엔드 테스트
src-tauri/src/
  commands.rs           Tauri 명령 + 파이프라인 조립 + 진행률
  armor.rs              Base64 텍스트 껍데기 (복사·붙여넣기 가능한 형태)
  container.rs          컨테이너 헤더와 청크 프레이밍
  crypto.rs             Argon2id 키 유도 + AES-256-GCM
  archive.rs            트리 순회, 매니페스트 직렬화, 복원
  safepath.rs           zip-slip / 윈도우 예약 이름 방어
  error.rs              사용자용 한국어 메시지가 붙은 에러
```

## 컨테이너 포맷

세 단계를 실제로 세 단계로 쌓는다. `ContainerWriter` 가 `Write`, `ContainerReader` 가 `Read` 를
구현하므로 어댑터를 겹쳐 놓기만 하면 되고, 중간 결과를 메모리에 모으지 않는다.

```
묶기:  원본 파일 → 직렬화 → zstd → AES-256-GCM 청크 → Base64 armor → .txt
풀기:  그 역순
```

### 헤더 (96 바이트, 평문)

| offset | size | 내용 |
| --- | --- | --- |
| 0 | 8 | 매직 `FSXPACK1` |
| 8 | 2 | 포맷 버전 (u16 LE) |
| 10 | 3 | KDF / 암호 / 압축 ID |
| 13 | 3 | 예약 |
| 16 | 32 | Argon2id 솔트 |
| 48 | 12 | Argon2id m_cost(KiB) / t_cost / p_cost |
| 60 | 4 | 청크 크기 |
| 64 | 4 | nonce 접두사 |
| 68 | 12 | 예약 |
| 80 | 16 | 키 확인값 (KCV) |

이어서 청크가 반복된다: `[u32 LE 평문 길이][u8 마지막 청크 플래그][암호문][태그 16바이트]`

### 텍스트 껍데기 (`armor.rs`)

위 바이트열을 그대로는 텍스트 파일에 담을 수 없으므로 Base64 로 옮기고 PEM 처럼 시작/끝 표시로
감싼다. 한 줄 76자(=57바이트)로 접어 어디에 붙여도 흐트러지지 않게 한다. 크기는 약 4/3 배로
늘어나지만, 압축이 앞단에서 이미 줄여 놓기 때문에 보통은 원본보다 훨씬 작다.

표시 줄 바깥에는 아무 정보도 두지 않는다. 알고리즘이나 버전을 여기에 적으면 사람이 그 값을 믿게
되는데 armor 는 인증 범위 밖이라 누구든 고칠 수 있다. 실제 파라미터는 전부 복호화로 검증되는
바이너리 헤더에서만 읽는다.

읽을 때는 관대하게 받는다 — 시작 표시 앞의 인용문이나 안내문은 건너뛰고, 본문의 공백과
줄바꿈(CRLF/LF 둘 다)은 무시한다. 대신 Base64 가 아닌 글자가 섞이거나 끝 표시가 없으면
`ArmorDamaged`("텍스트가 온전하지 않습니다") 로 알린다 — 붙여넣다 일부가 빠진 흔한 실수를
조용히 통과시키면 더 헷갈린다.

초기 버전이 만든 원시 바이너리 컨테이너도 계속 읽을 수 있다. 입력 앞 8바이트가 매직과 같으면
armor 를 거치지 않는다. 새로 묶을 때는 항상 텍스트로만 쓴다.

### QR 코드 (한 장 2,953바이트 · 최대 16장)

묶은 텍스트를 QR 코드로도 띄운다. 휴대폰 기본 카메라로 비추면 텍스트가 그대로 보이고, 복사해서
다른 기기의 풀기 탭에 붙여넣으면 파일이 돌아온다. 케이블도 메신저도 계정도 필요 없다.

QR 코드 한 장에 바이트 모드로 들어가는 최대치는 2,953바이트(버전 40, 오류 정정 L)다. armor 가
4/3 배로 늘려 놓기 때문에 원본이 몇 KB만 넘어도 한 장에는 담기지 않는다. 그때는 **여러 장으로
나눈다** — 줄바꿈을 없앤 armor 본문을 N등분해 1번 장에 시작 표시, N번 장에 끝 표시를 붙이고,
각 장에 `#i/N` 순서 표시를 넣는다. 순서대로 이어 붙이면 그대로 유효한 컨테이너가 된다.

```
-----BEGIN PACKER CONTAINER-----      ← 1번 장에만
#1/3
QUFBQkJCQ0ND...
```

**이어 붙이는 건 사람이 한다.** 규격에는 여러 심볼을 잇는 Structured Append 가 있지만 휴대폰
**기본** 카메라 앱은 그걸 모른다 — 한 장씩 읽을 뿐이다. 데스크톱 앱도 QR 을 읽지 않는다(내보내기
전용). 그래서 순서 표시를 텍스트 안에 넣어 붙여넣은 뒤에도 눈으로 확인할 수 있게 했다.

손으로 이어 붙이는 수고를 덜려면 [`mobile/`](mobile/README.md) 의 스캐너 앱을 쓴다. 카메라를
켜 둔 채 장을 넘기면 `#i/N` 에서 순번을 읽어 알아서 맞춰 모으고(순서는 상관없다), 다 모이면
순서 표시를 떼고 하나의 텍스트로 합쳐 `.txt` 로 저장하거나 바로 다른 앱으로 보낸다 — 저장
위치는 시스템 공유 시트에서 직접 고른다. 합친 결과는 `wrap_single_line` 과
같은 모양이라 그대로 풀기 탭에 붙여넣을 수 있다. 형식 가정은 `src-tauri/tests/piece_format.rs`
가 못박아 두었다 — armor 형식을 고치면 그 테스트가 먼저 깨져서 모바일 파서도 함께 고쳐야
한다고 알려 준다. `ArmorReader` 는
본문 어디에 있든 `#숫자/숫자` 만 정확히 건너뛴다 — 줄 끝까지 버리지 않는 이유는, 붙여넣는 과정에서
줄바꿈이 사라져 `...AbCd#2/3RkZG...` 처럼 뭉쳐도 본문을 잃지 않아야 하기 때문이다. 순서가 어긋나면
`PieceOrder` 로 짚어 준다. 이게 없으면 한참 뒤 GCM 인증 실패로만 나타나서 안내가 "이 파일은 이
프로그램으로 묶은 파일이 아닙니다" 같은 **사실과 다른 말**을 하게 된다.

`#` 하나만 예외로 두는 것이 "깨진 붙여넣기를 조용히 통과시키지 않는다" 는 약속을 깨지 않는
이유는 `armor.rs` 모듈 문서에 적어 두었다. 요지는 두 가지다: `#` 은 손상의 산물이 아니고, 바이트
손실을 실제로 막는 것은 armor 의 글자 검사가 아니라 청크마다 붙는 GCM 태그와 헤더의 KCV 다.

**16장이 상한이다.** QR 규격의 Structured Append 한계와 같은 값이고, 실측으로 armor 본문 약
46,000자까지 담긴다. 그보다 커지면 `qr` 이 `null` 로 오고 화면이 크기와 한도를 적어 준다. 장수를
더 늘리는 것은 기술적으로 가능하지만 순서대로 스캔해 이어 붙이는 일 자체가 현실적이지 않다.

**한 번에 한 장만 크게 보여 준다.** 버전 40 은 177×177모듈(여백 포함 185)이라 16장을 타일로
늘어놓으면 한 장이 185px 남짓, 모듈 하나가 1픽셀까지 줄어 휴대폰이 읽지 못한다. 그래서 큰 그림
한 장에 `3 / 16` 번호와 이전·다음만 둔다. 양끝에서 되돌아 감지 않는 것도 의도다 — '다음' 이
잠기는 것이 "다 찍었다" 는 유일한 신호이고, 아무 장이나 먼저 찍을 수 없어 순서가 어긋나지 않는다.

PNG 은 **1모듈 = 1픽셀**로 만들고 여백(quiet zone) 4모듈을 그림 안에 포함한다. 확대는 화면 쪽에서
정수 배율로만 한다(모듈당 최소 3px, 버전 40 이면 555px) — 배율에 소수점이 붙으면 모듈 폭이
3px/4px 로 들쭉날쭉해져 초점이 맞아도 인식되지 않는다. 여백을 CSS 패딩에만 두면 안 된다: 패딩은
12px 고정인데 모듈은 3~10px 로 변해 배율이 높을 때 4모듈을 채우지 못하고, 화면을 캡처해 잘라내면
함께 사라진다.

조각 텍스트에는 ASCII 만 넣는다. 바이트 모드 QR 에는 믿을 수 있는 문자셋 선언이 없어 디코더마다
ISO-8859-1 이나 UTF-8 로 제각기 짐작하는데, 우리 payload 는 전부 ASCII 라 어느 해석으로 읽어도
바이트가 같다. 한국어 안내는 화면에만 둔다.

이 관용은 리더에만 있고 라이터는 그대로다. `.txt` 형식은 달라지지 않는다. 다만 조각을 이어 붙인
텍스트는 이 변경 이전 빌드에서 `ArmorDamaged` 가 된다.

### 설계 근거

- **청크 단위 암호화** — 원샷 GCM 은 평문 전체를 메모리에 올려야 하고 키/nonce 당 약 64 GiB
  한계가 있다. 1 MiB 청크로 끊으면 메모리 사용량이 파일 크기와 무관하게 일정하고 진행률도
  보고할 수 있다.
- **nonce = 접두사(4B) ‖ 청크 인덱스(8B LE)** — 한 파일 안에서 절대 겹치지 않고, 청크를
  재배열하면 인덱스가 어긋나 인증이 실패한다.
- **AAD = 파일에 있던 헤더 96바이트 그대로 ‖ 마지막 청크 플래그** — 헤더의 어느 바이트든
  (아직 쓰지 않는 예약 영역까지) 고치면 인증이 깨지고, 플래그를 위조해 파일을 잘라내는 것도
  막힌다. 그래서 `Header` 는 파싱한 필드를 다시 직렬화하지 않고 원본 바이트를 들고 다닌다 —
  구조체에 담지 않은 바이트가 인증 범위에서 빠지면 사실상 위조 가능해지기 때문이다.
- **KCV** — Argon2id 출력 48바이트를 `[0..32]` 데이터 키, `[32..48]` 키 확인값으로 쪼개
  헤더에 확인값을 남긴다. 덕분에 파일 전체를 읽기 전에 "키가 틀렸다"와 "파일이 깨졌다"를
  구분해 말할 수 있다. 그냥 복호화하면 GCM 인증 실패가 두 경우 모두 똑같이 나온다.
- **매니페스트는 암호화 안쪽** — 파일 이름이 노출되지 않는다.
- **파일별 sha256 은 뒤쪽 트레일러** — 묶을 때 파일을 두 번 읽지 않아도 된다 (쓰면서 계산).
- **각 파일은 기록된 크기만큼 정확히 쓴다** — 묶는 중에 원본이 변해도 스트림 경계가 흔들리지
  않고, 크기가 달라진 파일은 결과 보고에 나온다.
- **풀기는 임시 폴더에 먼저** — 목적지 안 `.packer-part-<난수>` 에 풀고 다 성공하면 옮긴다.
  중간에 실패해도 사용자가 고른 폴더에 반쯤 복원된 파일이 남지 않는다. 같은 볼륨이라
  옮기는 건 rename 이므로 사실상 공짜다. 이름이 겹치면 `이름 (2)` 로 번호를 붙여
  기존 파일을 덮어쓰지 않는다.
- **경로 검사** (`safepath.rs`) — 풀기는 남이 만든 파일에 적힌 경로대로 디스크에 쓰는 동작이다.
  절대 경로, `..`, 백슬래시, ADS 콜론, 윈도우 예약 장치 이름(`CON` `NUL` `COM1`…), 끝에 붙은
  점/공백을 모두 거절한다. 건너뛴 항목의 바이트는 읽고 버려 다음 파일 경계를 유지한다.

## 디자인 이식용 훅

`main.js` 는 마크업의 클래스 이름을 하나도 모른다. 모든 DOM 참조는 `data-pk="..."` 속성으로만
한다. 목업을 이식할 때는 목업 마크업에 아래 훅을 붙이면 되고 로직은 손대지 않아도 된다.

| 영역 | 훅 |
| --- | --- |
| 탭 | `tab[data-tab=pack\|unpack]`, `panel[data-tab=pack\|unpack]` |
| 묶기 | `pack-dropzone` `pack-list` `pack-empty` `pack-summary` `pack-clear` `pack-add-files` `pack-add-folders` `pack-key` `pack-key-toggle` `pack-key-strength` `pack-submit` `pack-progress` `pack-progress-fill` `pack-progress-label` `pack-status` `pack-reveal` |
| 결과 텍스트 | `pack-output` `pack-output-text` `pack-output-copy` `pack-output-note` |
| 결과 QR | `pack-qr` (`data-state=single\|split\|toobig`) `pack-qr-image` `pack-qr-note` `pack-qr-nav` `pack-qr-prev` `pack-qr-next` `pack-qr-index` |
| 풀기 | `unpack-dropzone` `unpack-pick` `unpack-file` `unpack-file-name` `unpack-file-meta` `unpack-text` `unpack-text-clear` `unpack-source-note` `unpack-key` `unpack-key-toggle` `unpack-key-hint` `unpack-dest` `unpack-dest-pick` `unpack-submit` `unpack-progress` `unpack-progress-fill` `unpack-progress-label` `unpack-status` `unpack-reveal` |
| 목록 행 | `row-template` (안에 `[data-field=name]` `[data-field=meta]` `[data-pk=row-remove]`) |

없는 훅은 조용히 무시되므로 부분 이식도 안전하다.

### 이식할 때 주의할 점

- **드래그 앤 드롭은 Tauri 이벤트로만 받는다.** `tauri.conf.json` 의 `dragDropEnabled: true`
  때문에 윈도우에서는 HTML5 `drop` 이벤트가 웹뷰에 오지 않고, 온다 해도 브라우저 이벤트는
  절대 경로를 주지 않는다. `main.js` 의 `onDragDropEvent` 배선을 그대로 두면 된다.
- **`[hidden] { display: none !important }` 규칙을 지운다면 대체 수단이 필요하다.** 브라우저
  기본 스타일의 `[hidden]` 은 작성자 스타일보다 약해서, `.panel { display: flex }` 같은 규칙
  하나만으로도 숨겨야 할 패널이 그대로 보인다. JS 가 여러 훅을 `hidden` 으로 토글한다.
- **`main()` 은 한 번만 돌아야 한다.** `main.js` 끝의 `readyState` 검사와 `{ once: true }` 를
  건드리지 말 것. 배선이 두 번 돌면 '보기' 토글처럼 상태를 뒤집는 핸들러가 두 번 불려서 아무
  일도 안 한 것처럼 보인다.
- **결과 텍스트 영역은 등폭 글꼴로 둔다.** armor 본문은 76자 고정폭이라 등폭이어야 줄이
  가지런히 맞고 "온전히 복사됐다" 는 느낌을 준다.
- **QR 판은 어두운 테마에서도 흰 바탕이어야 한다.** 색을 반전한 QR 은 휴대폰 기본 카메라가
  읽지 못한다. `.qr-frame` 의 흰 배경과 `.qr-image` 의 `image-rendering: pixelated`, 고대비
  모드용 `forced-color-adjust: none` 을 목업 값으로 덮어쓰지 말 것. 확대 배율은 `main.js` 가
  `png_modules` 의 정수 배로 인라인 지정하고, `.qr-index` 의 `min-width` 는 장을 넘길 때
  '다음' 버튼이 옆으로 밀리지 않게 하는 값이다.

## 폰트

`src/fonts/` 에 Noto Sans KR 과 Roboto 를 자체 호스팅한다. 데스크탑 앱은 오프라인에서도 떠야
하고 Tauri 의 기본 CSP 가 원격 리소스를 막으므로 `fonts.googleapis.com` 을 걸 수 없다. Google 이
나눠 주는 unicode-range 서브셋을 그대로 가져왔기 때문에 WebView 는 실제로 화면에 나온 글자의
조각만 읽어 들인다. 다시 받으려면 `python scripts/fetch-fonts.py`.

가독성 조정: 본문 15px / 행간 1.6 / 한글 자간 −0.01em, 숫자에는 Roboto + `tabular-nums` 를
써서 파일 크기가 바뀔 때 자릿수가 흔들리지 않게 했다.
