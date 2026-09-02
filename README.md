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
  확인하고 "전체 복사" 로 클립보드에 담을 수 있다.
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

## 폰트

`src/fonts/` 에 Noto Sans KR 과 Roboto 를 자체 호스팅한다. 데스크탑 앱은 오프라인에서도 떠야
하고 Tauri 의 기본 CSP 가 원격 리소스를 막으므로 `fonts.googleapis.com` 을 걸 수 없다. Google 이
나눠 주는 unicode-range 서브셋을 그대로 가져왔기 때문에 WebView 는 실제로 화면에 나온 글자의
조각만 읽어 들인다. 다시 받으려면 `python scripts/fetch-fonts.py`.

가독성 조정: 본문 15px / 행간 1.6 / 한글 자간 −0.01em, 숫자에는 Roboto + `tabular-nums` 를
써서 파일 크기가 바뀔 때 자릿수가 흔들리지 않게 했다.
