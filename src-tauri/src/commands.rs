//! 프론트엔드가 호출하는 Tauri 명령과 실제 파이프라인 조립.
//!
//! 묶기: `원본 파일 → 직렬화 → zstd → AES-256-GCM 청크 → Base64 armor → .txt`
//! 풀기: 그 역순.
//!
//! 결과물은 **텍스트**다. 암호화 결과는 임의의 바이트열이라 그대로는 텍스트 파일에 담을 수
//! 없으므로 마지막에 Base64 로 옮겨 적는다. 덕분에 메모장에 붙이거나 메신저·메일 본문으로
//! 보내도 내용이 상하지 않는다. 대신 크기가 약 4/3 배로 늘어난다.
//!
//! 각 계층이 `Write`/`Read` 를 구현하기 때문에 어댑터를 겹쳐 쌓기만 하면 되고, 중간 결과를
//! 메모리에 모으지 않으므로 파일 크기와 무관하게 메모리 사용량이 일정하다.
//!
//! 무거운 작업은 전부 [`tauri::async_runtime::spawn_blocking`] 안에서 돈다. 안 그러면 Argon2
//! 유도만으로도 창이 수백 밀리초 얼어붙는다.

use std::collections::HashSet;
use std::fs;
use std::io::{self, BufRead, BufReader, BufWriter, Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use rand::RngCore;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use zeroize::Zeroize;

use crate::archive::{self, Tick};
use crate::armor::{self, ArmorReader, ArmorWriter};
use crate::container::{self, ContainerReader, ContainerWriter, Header};
use crate::crypto;
use crate::error::{Error, Result};
use crate::qr;
use crate::qrstream;
use crate::safepath;

pub const EVENT_PACK: &str = "pack-progress";
pub const EVENT_UNPACK: &str = "unpack-progress";

/// zstd 압축 레벨. 6은 기본값(3)보다 뚜렷하게 잘 줄이면서도 대용량에서 체감할 만큼
/// 느려지지 않는 지점이다. 더 올리면 압축률 이득은 미미하고 시간이 급격히 늘어난다.
const ZSTD_LEVEL: i32 = 6;

/// 진행률 이벤트 최소 간격. 이보다 자주 보내면 IPC 만 붐비고 화면은 달라지지 않는다.
const EMIT_INTERVAL: Duration = Duration::from_millis(50);

/// 결과물은 텍스트라서 확장자도 텍스트로 둔다. 더블클릭하면 메모장에서 바로 열린다.
pub const CONTAINER_EXTENSION: &str = "txt";

/// 화면의 텍스트 영역에 그대로 띄울 상한. 이보다 크면 붙여넣기로 옮길 만한 크기가 아니고,
/// IPC 로 넘기는 것도 낭비다. 파일로는 정상적으로 저장된다.
const TEXT_PREVIEW_LIMIT: u64 = 2 * 1024 * 1024;

/// 클립보드로 넘길 상한. 이보다 크면 대부분의 에디터가 붙여넣기에서 버티지 못한다.
const CLIPBOARD_LIMIT: u64 = 64 * 1024 * 1024;

/// QR 로 만들어 볼 만한 컨테이너 크기 상한.
///
/// 정확한 판정은 [`qr::plan`] 이 실제 인코딩으로 하지만, 2 MiB 텍스트를 붙잡고 조각을 세지
/// 않도록 여기서 먼저 자른다.
///
/// **이 값이 [`qr::MAX_PIECES`] 와 함께 움직이지 않으면 조각 상한을 올려도 아무 일이 일어나지
/// 않는다** — 여기서 먼저 잘리기 때문이다. 조각 상한 64장에 담기는 컨테이너가 실측 약
/// 137 KiB 이고 armor 가 4/3 배로 늘리므로, 그보다 넉넉히 위에 둔다.
const QR_SOURCE_LIMIT: u64 = 256 * 1024;

// ---------------------------------------------------------------- 진행률

#[derive(Serialize, Clone)]
struct ProgressPayload {
    phase: &'static str,
    done_bytes: u64,
    /// 0이면 아직 총량을 모른다는 뜻 (UI 는 불확정 상태로 표시한다).
    total_bytes: u64,
    current_path: String,
}

struct Reporter {
    app: AppHandle,
    event: &'static str,
    phase: &'static str,
    total: u64,
    done: u64,
    current: String,
    last_emit: Option<Instant>,
}

impl Reporter {
    fn new(app: AppHandle, event: &'static str, phase: &'static str) -> Self {
        Self {
            app,
            event,
            phase,
            total: 0,
            done: 0,
            current: String::new(),
            last_emit: None,
        }
    }

    fn on(&mut self, tick: Tick) {
        match tick {
            Tick::Total(total) => {
                self.total = total;
                self.emit();
            }
            Tick::Advance { bytes, path } => {
                self.done += bytes;
                if self.current != path {
                    self.current.clear();
                    self.current.push_str(path);
                }
                let due = self.last_emit.is_none_or(|t| t.elapsed() >= EMIT_INTERVAL);
                if due {
                    self.emit();
                }
            }
        }
    }

    fn emit(&mut self) {
        // 이벤트가 한 번 실패해도 작업 자체는 계속해야 한다.
        let _ = self.app.emit(
            self.event,
            ProgressPayload {
                phase: self.phase,
                done_bytes: self.done,
                total_bytes: self.total,
                current_path: self.current.clone(),
            },
        );
        self.last_emit = Some(Instant::now());
    }

    /// 마지막 한 방. 스로틀 때문에 100% 프레임이 누락되는 걸 막는다.
    fn finish(&mut self) {
        self.phase = "finishing";
        self.current.clear();
        self.emit();
    }
}

// ---------------------------------------------------------------- 컨테이너 입력

/// 풀어낼 대상. 파일에서 읽거나, 사용자가 붙여넣은 텍스트에서 읽는다.
pub enum ContainerSource {
    File(PathBuf),
    Text(String),
}

impl ContainerSource {
    /// 알맞은 리더와 "텍스트 armor 였는지" 를 돌려준다.
    fn open(&self) -> Result<(Box<dyn Read + '_>, bool)> {
        match self {
            ContainerSource::Text(text) => {
                if !armor::looks_armored(text) {
                    return Err(Error::NotContainer);
                }
                // 여러 조각으로 나눈 QR 을 잘못된 순서로 붙였다면 여기서 짚어 준다. 그냥
                // 흘려보내면 한참 뒤 헤더 매직이나 GCM 인증 실패로만 나타나서, 안내가 원인을
                // 엉뚱한 곳("우리 파일이 아니다") 으로 보낸다.
                armor::verify_pieces(text)?;
                Ok((
                    Box::new(ArmorReader::new(Cursor::new(text.as_bytes()))),
                    true,
                ))
            }

            ContainerSource::File(path) => {
                let file = fs::File::open(path)
                    .map_err(|e| Error::io(&format!("{} 를 열 수 없습니다", path.display()), e))?;
                let mut reader = BufReader::new(file);

                // 앞부분만 엿본다. 초기 버전이 만든 원시 바이너리 컨테이너도 읽어 줘야
                // 이미 만들어 둔 파일이 갑자기 열리지 않는 일이 없다. 새로 묶을 때는 항상
                // 텍스트로만 쓴다.
                let head = reader.fill_buf().map_err(|e| {
                    Error::io(&format!("{} 를 읽을 수 없습니다", path.display()), e)
                })?;
                let raw = head.starts_with(container::MAGIC);

                if raw {
                    Ok((Box::new(reader), false))
                } else {
                    Ok((Box::new(ArmorReader::new(reader)), true))
                }
            }
        }
    }

    fn name(&self) -> String {
        match self {
            ContainerSource::File(path) => path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("(이름 없음)")
                .to_string(),
            ContainerSource::Text(_) => "붙여넣은 텍스트".to_string(),
        }
    }

    fn byte_size(&self) -> u64 {
        match self {
            ContainerSource::File(path) => fs::metadata(path).map(|m| m.len()).unwrap_or(0),
            ContainerSource::Text(text) => text.len() as u64,
        }
    }
}

// ---------------------------------------------------------------- 드롭 목록

#[derive(Debug, Serialize)]
pub struct DroppedItem {
    pub path: String,
    pub name: String,
    /// `file` | `dir` | `missing`
    pub kind: &'static str,
    pub size: u64,
    pub file_count: usize,
}

#[derive(Debug, Serialize)]
pub struct DropSummary {
    pub items: Vec<DroppedItem>,
    pub total_bytes: u64,
    pub file_count: usize,
    pub dir_count: usize,
}

/// 드롭된 경로들의 이름과 크기를 재서 목록에 표시할 정보를 만든다.
#[tauri::command]
pub async fn scan_paths(paths: Vec<String>) -> Result<DropSummary> {
    blocking(move || {
        let mut items = Vec::new();
        let mut total_bytes = 0u64;
        let mut file_count = 0usize;
        let mut dir_count = 0usize;

        for path in dedupe(paths) {
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("(이름 없음)")
                .to_string();

            let kind = match fs::metadata(&path) {
                Ok(m) if m.is_dir() => "dir",
                Ok(m) if m.is_file() => "file",
                _ => "missing",
            };

            let (size, files, dirs) = archive::measure(&path);
            total_bytes += size;
            file_count += files;
            dir_count += dirs;

            items.push(DroppedItem {
                path: path.to_string_lossy().to_string(),
                name,
                kind,
                size,
                file_count: files,
            });
        }

        Ok(DropSummary {
            items,
            total_bytes,
            file_count,
            dir_count,
        })
    })
    .await
}

// ---------------------------------------------------------------- 들여다보기

#[derive(Debug, Serialize)]
pub struct ContainerInfo {
    /// `file` | `text`
    pub source: &'static str,
    pub path: Option<String>,
    pub name: String,
    pub byte_size: u64,
    /// 텍스트(Base64 armor) 형태였는지.
    pub armored: bool,
    pub format_version: u16,
    pub kdf: &'static str,
    pub cipher: &'static str,
    pub compression: &'static str,
    pub chunk_size: u32,
}

/// 키 없이 헤더만 읽어 이 입력이 우리 컨테이너인지, 어떤 방식으로 묶였는지 알려준다.
pub fn inspect_source(source: &ContainerSource) -> Result<ContainerInfo> {
    let (mut reader, armored) = source.open()?;
    let header = Header::read_from(&mut reader)?;

    Ok(ContainerInfo {
        source: match source {
            ContainerSource::File(_) => "file",
            ContainerSource::Text(_) => "text",
        },
        path: match source {
            ContainerSource::File(p) => Some(p.to_string_lossy().to_string()),
            ContainerSource::Text(_) => None,
        },
        name: source.name(),
        byte_size: source.byte_size(),
        armored,
        format_version: header.format_version(),
        kdf: "Argon2id",
        cipher: "AES-256-GCM",
        compression: "zstd",
        chunk_size: header.chunk_size(),
    })
}

#[tauri::command]
pub async fn inspect(path: String) -> Result<ContainerInfo> {
    blocking(move || inspect_source(&ContainerSource::File(PathBuf::from(path)))).await
}

/// 붙여넣은 텍스트를 키 없이 확인한다.
#[tauri::command]
pub async fn inspect_text(text: String) -> Result<ContainerInfo> {
    blocking(move || inspect_source(&ContainerSource::Text(text))).await
}

// ---------------------------------------------------------------- 묶기

#[derive(Debug, Serialize)]
pub struct PackOutcome {
    pub dest: String,
    /// 저장된 텍스트의 바이트 수.
    pub container_bytes: u64,
    pub original_bytes: u64,
    pub file_count: usize,
    pub dir_count: usize,
    /// 묶는 도중 크기가 달라진 파일.
    pub changed: Vec<String>,
    /// 담지 못한 항목.
    pub skipped: Vec<String>,
    /// 화면에 바로 띄울 armor 텍스트. 너무 크면 `None` 이고 `preview_omitted` 가 참이 된다.
    pub preview: Option<String>,
    pub preview_omitted: bool,
    /// 스마트폰 카메라로 찍어 옮길 수 있는 QR 조각의 **요약**. 몇 장인지와 어떤 크기인지만
    /// 담는다. 그림은 [`qr_piece`] 로 한 장씩 꺼내 간다 — 뷰어는 한 번에 한 장만 보여 주고,
    /// 조각 상한이 64장이라 전부 실어 보내면 응답이 수백 KiB 가 된다.
    ///
    /// 조각이 `qr_limit_pieces` 를 넘으면 `None` 이고 `qr_omitted` 가 참이 된다.
    pub qr_plan: Option<qr::QrPlanInfo>,
    /// 첫 장만 함께 실어 보낸다. 결과가 뜨자마자 보여 줄 수 있어 왕복 한 번을 아낀다.
    pub qr_first: Option<qr::QrImage>,
    pub qr_omitted: bool,
    /// QR 한 장에 담기는 최대 바이트와 최대 장수. 화면의 안내 문구가 그대로 쓴다 —
    /// 상수를 JS 에 한 번 더 적어 두면 언젠가 어긋난다.
    pub qr_limit_bytes: usize,
    pub qr_limit_pieces: usize,
}

/// 마지막으로 묶어 낸 컨테이너가 놓인 자리.
///
/// **저장 위치를 먼저 묻지 않게 된 뒤로 생겼다.** 결과를 텍스트로 옮길지 QR 로 보낼지는
/// 묶어 보고 나서야 정할 수 있는데(크기를 알아야 갈래가 갈린다), 그러려면 묶기가 먼저 끝나
/// 있어야 한다. 그래서 목적지를 주지 않으면 임시 폴더에 쓰고, 화면의 '파일로 저장' 이
/// [`save_container`] 로 옮겨 적는다.
///
/// 담고 있는 것은 **이미 armor 로 옮겨진 암호문**이다. 평문도 암호도 여기 들어오지 않는다.
#[derive(Default)]
pub struct PackedSlot(Mutex<Option<Packed>>);

/// 방금 만든 컨테이너 하나.
pub struct Packed {
    path: PathBuf,
    /// 임시 폴더에 만든 것이면 그 폴더. 다음 묶기에서 통째로 지운다.
    temp_dir: Option<PathBuf>,
}

impl PackedSlot {
    /// 새 결과를 담고 **지난 임시 폴더를 지운다.**
    ///
    /// 지우는 자리가 여기인 이유는, 임시 컨테이너의 수명이 정확히 "다음 묶기까지" 이기 때문이다.
    /// 사람이 저장하지 않고 다시 묶으면 앞의 것은 그 순간 쓸모를 잃는다.
    fn put(&self, packed: Option<Packed>) {
        let mut slot = match self.0.lock() {
            Ok(slot) => slot,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(old) = slot.take() {
            if let Some(dir) = old.temp_dir {
                let _ = fs::remove_dir_all(dir);
            }
        }
        *slot = packed;
    }

    /// 지금 들고 있는 컨테이너의 경로.
    fn path(&self) -> Result<PathBuf> {
        let slot = match self.0.lock() {
            Ok(slot) => slot,
            Err(poisoned) => poisoned.into_inner(),
        };
        slot.as_ref()
            .map(|packed| packed.path.clone())
            .ok_or_else(|| Error::Internal("저장할 결과가 없습니다".to_string()))
    }
}

/// 마지막으로 묶은 결과의 QR 나눔.
///
/// 그림을 미리 다 그려 응답에 싣는 대신, 나눔만 여기 붙잡아 두고 뷰어가 장을 넘길 때마다 한
/// 장씩 그려 준다 ([`qr_piece`]). 조각 상한이 64장이라 전부 실으면 응답이 수백 KiB 가 되고,
/// 상한을 더 올리면 곧 메가바이트가 된다.
///
/// **담고 있는 것은 armor 텍스트 조각들이고, 그건 이미 암호화된 바이트다.** 평문도 암호도 여기
/// 들어오지 않는다 — 그 둘은 여전히 어디에도 남기지 않는다.
#[derive(Default)]
pub struct QrSlot(Mutex<Option<qr::QrPlan>>);

impl QrSlot {
    fn put(&self, plan: Option<qr::QrPlan>) {
        // 잠금이 깨졌다면 담고 있던 나눔을 버리고 새것으로 채운다. QR 그림 하나 때문에 앱을
        // 죽일 이유가 없다.
        match self.0.lock() {
            Ok(mut slot) => *slot = plan,
            Err(poisoned) => *poisoned.into_inner() = plan,
        }
    }
}

/// QR 조각 한 장을 그려 준다. `index` 는 1부터 센다.
///
/// 뷰어가 장을 넘길 때마다 부른다. 앞뒤 몇 장을 미리 받아 두므로 자동 넘김의 체류 시간 안에
/// 넉넉히 들어온다.
#[tauri::command]
pub async fn qr_piece(app: AppHandle, index: usize) -> Result<qr::QrImage> {
    blocking(move || {
        let slot = app.state::<QrSlot>();
        let guard = slot
            .0
            .lock()
            .map_err(|_| Error::Internal("QR 나눔을 읽을 수 없습니다".to_string()))?;
        guard
            .as_ref()
            .ok_or_else(|| Error::Internal("보여 줄 QR 이 없습니다".to_string()))?
            .image(index)
    })
    .await
}

// ---------------------------------------------------------------- QR 스트림

/// 지금 내보내고 있는 스트림.
///
/// 조각 모드의 [`QrSlot`] 과 같은 자리다. 담는 것은 **암호화된 컨테이너 바이트**이고, 평문도
/// 암호도 여기 들어오지 않는다.
#[derive(Default)]
pub struct StreamSlot(Mutex<Option<qrstream::Encoder>>);

/// 스트림을 열 때 화면이 받는 것.
#[derive(Serialize)]
pub struct StreamOpened {
    #[serde(flatten)]
    pub info: qrstream::StreamInfo,
    /// 프레임 하나를 그린 심볼의 한 변(모듈 수). 화면이 배율을 정하는 데 쓴다.
    pub png_modules: usize,
    /// 블록 수에 8% 남짓을 더한 값 — 대략 이만큼 보내면 폰이 다 푼다.
    ///
    /// PC 는 예상 시간과 "한 바퀴의 몇 %" 를 이걸로 적고, **폰도 같은 식을 갖고 있다**
    /// (`mobile/www/stream.js` 의 `framesNeeded`). 폰은 이 값을 받지 못하므로(프레임 헤더에
    /// 없다) 스스로 계산하는데, 두 식이 어긋나면 같은 스트림을 두고 두 화면이 다른 진행을
    /// 말하게 된다. 아래 계산을 고치면 그쪽도 함께 고쳐야 한다.
    pub frames_needed: usize,
}

/// 컨테이너 파일을 열어 스트림 인코더를 세운다.
///
/// armor 텍스트가 아니라 **되돌린 원시 바이트**를 흘린다. Base64 를 한 겹 벗기면 프레임마다
/// 33% 를 더 담을 수 있고, 폰이 마지막에 다시 armor 로 감싸면 `.txt` 는 똑같이 나온다.
#[tauri::command]
pub async fn qr_stream_open(app: AppHandle, path: String) -> Result<StreamOpened> {
    blocking(move || {
        let file = PathBuf::from(&path);
        let text = fs::read(&file)
            .map_err(|e| Error::io(&format!("{} 를 열 수 없습니다", file.display()), e))?;

        // 초기 버전이 만든 원시 바이너리 컨테이너도 그대로 받는다 (`armor.rs` 의 관용과 같다).
        let source = match std::str::from_utf8(&text) {
            Ok(as_text) if armor::looks_armored(as_text) => {
                let body = armor::body_of(as_text)?;
                BASE64_STANDARD
                    .decode(body.as_bytes())
                    .map_err(|_| Error::ArmorDamaged)?
            }
            _ => text,
        };

        let capacity = qr::stream_capacity();
        let block_size = capacity.saturating_sub(qrstream::HEADER_LEN).max(1);
        let encoder = qrstream::Encoder::new(&source, block_size)?;

        // 프레임 하나를 실제로 그려 화면이 쓸 배율을 알아 온다. 모든 프레임이 같은 크기다.
        let png_modules = qr::render_frame(&encoder.frame(0))?.png_modules;
        // LT 부호의 실측 오버헤드는 5~8% 다. 넉넉히 잡아 화면이 시간을 과소평가하지 않게 한다.
        // **`mobile/www/stream.js` 의 `framesNeeded()` 와 같은 식이다.**
        let frames_needed = encoder.blocks() + encoder.blocks().div_ceil(12) + 8;

        let opened = StreamOpened {
            info: encoder.info(),
            png_modules,
            frames_needed,
        };
        match app.state::<StreamSlot>().0.lock() {
            Ok(mut slot) => *slot = Some(encoder),
            Err(poisoned) => *poisoned.into_inner() = Some(encoder),
        }
        Ok(opened)
    })
    .await
}

/// `seq` 번째 프레임의 그림. 화면이 끝없이 세어 올리며 부른다.
#[tauri::command]
pub async fn qr_stream_frame(app: AppHandle, seq: u32) -> Result<qr::QrFrame> {
    blocking(move || {
        let slot = app.state::<StreamSlot>();
        let guard = slot
            .0
            .lock()
            .map_err(|_| Error::Internal("스트림을 읽을 수 없습니다".to_string()))?;
        let encoder = guard
            .as_ref()
            .ok_or_else(|| Error::Internal("열려 있는 스트림이 없습니다".to_string()))?;
        qr::render_frame(&encoder.frame(seq))
    })
    .await
}

/// 스트림을 닫는다. 컨테이너 바이트를 메모리에 붙잡고 있을 이유가 없어지면 곧바로 놓는다.
#[tauri::command]
pub async fn qr_stream_close(app: AppHandle) -> Result<()> {
    match app.state::<StreamSlot>().0.lock() {
        Ok(mut slot) => *slot = None,
        Err(poisoned) => *poisoned.into_inner() = None,
    }
    Ok(())
}

/// 고른 파일·폴더를 묶는다.
///
/// `dest` 를 주지 않으면 **임시 폴더에 쓴다.** 저장 위치를 묻는 자리가 묶기 앞에서 뒤로
/// 옮겨졌기 때문이다 — 결과를 텍스트로 옮길지 QR 로 보낼지는 크기를 알아야 정할 수 있고,
/// 그 크기는 묶어 봐야 나온다. 화면은 결과를 보고 나서 '파일로 저장'([`save_container`])을
/// 누른다.
#[tauri::command]
pub async fn pack(
    app: AppHandle,
    paths: Vec<String>,
    passphrase: String,
    dest: Option<String>,
    suggested_name: Option<String>,
) -> Result<PackOutcome> {
    blocking(move || {
        let roots = dedupe(paths);
        let scan = if roots.is_empty() {
            Err(Error::NothingToPack)
        } else {
            archive::scan(&roots)
        };
        pack_blocking(app, scan, passphrase, dest, suggested_name)
    })
    .await
}

/// 창에 직접 친 텍스트를 묶는다.
///
/// **평문을 디스크에 떨어뜨리지 않는다.** 임시 파일로 한 번 쓰고 지우는 편이 훨씬 짧은 길이지만,
/// 지운 자리를 덮어쓰지는 못하므로 이 앱이 없애려는 노출을 스스로 하나 만드는 셈이 된다.
/// 그래서 [`archive::scan_text`] 가 바이트를 그대로 들고 파이프라인으로 들어간다.
#[tauri::command]
pub async fn pack_text(
    app: AppHandle,
    text: String,
    name: Option<String>,
    passphrase: String,
    dest: Option<String>,
    suggested_name: Option<String>,
) -> Result<PackOutcome> {
    blocking(move || {
        let mut text = text;
        let entry_name = name.unwrap_or_else(|| archive::DEFAULT_TEXT_NAME.to_string());
        let scan = archive::scan_text(&entry_name, text.as_bytes().to_vec());
        // 평문 사본을 손에 쥐고 있을 이유가 없다. `scan` 이 이미 바이트를 가져갔고,
        // 그쪽은 놓일 때 스스로 지운다 (`archive::Source` 의 `Drop`).
        text.zeroize();
        pack_blocking(app, scan, passphrase, dest, suggested_name)
    })
    .await
}

/// 훑기 결과와 키를 받아 묶는다.
///
/// **키를 지우는 자리가 여기 하나다.** 훑을 것이 없거나(`NothingToPack`) 훑기가 실패한 경우도
/// 이 함수를 지나게 하려고 `scan` 을 `Result` 로 받는다 — 갈래마다 `zeroize` 를 흩어 놓으면
/// 새 갈래가 하나 생길 때마다 조용히 빠뜨리게 된다.
fn pack_blocking(
    app: AppHandle,
    scan: Result<archive::Scan>,
    mut passphrase: String,
    dest: Option<String>,
    suggested_name: Option<String>,
) -> Result<PackOutcome> {
    let outcome = pack_guarded(app, scan, &passphrase, dest, suggested_name);
    passphrase.zeroize();
    outcome
}

fn pack_guarded(
    app: AppHandle,
    scan: Result<archive::Scan>,
    passphrase: &str,
    dest: Option<String>,
    suggested_name: Option<String>,
) -> Result<PackOutcome> {
    if passphrase.is_empty() {
        return Err(Error::EmptyKey);
    }
    let scan = scan?;

    // 목적지를 주지 않았으면 임시 폴더에 쓴다. 폴더째 만들어 두는 것은 그 안의 파일 이름을
    // 사람이 고른 이름 그대로 둘 수 있어서다 — 나중에 '탐색기에서 보기' 로 열어도 알아본다.
    let staged = match dest {
        Some(_) => None,
        None => Some(temp_dir_in(&std::env::temp_dir(), "packer-out-")?),
    };
    let dest_path = match (&dest, &staged) {
        (Some(dest), _) => PathBuf::from(dest),
        (None, Some(dir)) => dir.join(temp_container_name(suggested_name.as_deref())),
        (None, None) => unreachable!("staged 는 dest 가 없을 때만 None 이다"),
    };

    // `Reporter` 가 핸들을 가져가므로 QR 나눔을 담아 둘 몫을 따로 챙긴다. `AppHandle` 복제는
    // 참조 세기만 올린다.
    let handle = app.clone();
    let mut reporter = Reporter::new(app, EVENT_PACK, "packing");
    let packed = pack_scan_with_qr(scan, passphrase, &dest_path, &mut |t| reporter.on(t));
    if packed.is_ok() {
        reporter.finish();
    }
    let outcome = packed.map(|(outcome, plan)| {
        // 나눔을 붙잡아 둬야 `qr_piece` 가 장을 넘길 때마다 다시 계산하지 않는다.
        handle.state::<QrSlot>().put(plan);
        outcome
    });

    match outcome {
        Ok(o) => {
            // 지난 임시 컨테이너는 이 순간 쓸모를 잃는다. `put` 이 함께 지운다.
            handle.state::<PackedSlot>().put(Some(Packed {
                path: dest_path,
                temp_dir: staged,
            }));
            Ok(o)
        }
        Err(e) => {
            // 반쯤 쓰다 만 텍스트는 남기지 않는다. 열리지 않는 파일이 디스크에 남아 있으면
            // 사용자는 성공했는지 실패했는지 알 수 없다.
            let _ = fs::remove_file(&dest_path);
            if let Some(dir) = staged {
                let _ = fs::remove_dir_all(dir);
            }
            Err(e)
        }
    }
}

/// 임시 폴더 안에 쓸 파일 이름. 화면이 제안한 이름을 쓰되 경로가 되는 글자는 걷어 낸다.
fn temp_container_name(suggested: Option<&str>) -> String {
    let cleaned: String = suggested
        .unwrap_or("")
        .trim()
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if cleaned.is_empty() {
        return format!("packer.{CONTAINER_EXTENSION}");
    }
    cleaned.to_string()
}

/// 임시 폴더에 있는 컨테이너를 사람이 고른 자리로 옮겨 적는다.
///
/// **경로를 화면에서 받지 않는다.** 원본은 [`PackedSlot`] 이 들고 있는 것 하나뿐이라,
/// 이 명령으로는 방금 묶은 결과 말고 다른 파일을 복사해 낼 수 없다.
///
/// 옮긴 뒤에도 임시 파일은 그대로 둔다. QR 스트림([`qr_stream_open`])이 그 경로를 읽고 있고,
/// 어차피 다음 묶기에서 [`PackedSlot::put`] 이 지운다.
#[tauri::command]
pub async fn save_container(app: AppHandle, dest: String) -> Result<u64> {
    blocking(move || {
        let from = app.state::<PackedSlot>().path()?;
        let to = PathBuf::from(&dest);
        if from == to {
            // 이미 그 자리에 있다. 자기 자신에게 복사하면 내용이 잘린다.
            return fs::metadata(&to)
                .map(|m| m.len())
                .map_err(|e| Error::io(&format!("{} 를 읽을 수 없습니다", to.display()), e));
        }
        if let Some(parent) = to.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent).map_err(|e| {
                    Error::io(&format!("{} 를 만들 수 없습니다", parent.display()), e)
                })?;
            }
        }
        fs::copy(&from, &to)
            .map_err(|e| Error::io(&format!("{} 로 저장할 수 없습니다", to.display()), e))
    })
    .await
}

/// Tauri 창 없이도 쓸 수 있는 묶기 진입점. 통합 테스트가 이걸 직접 부른다.
pub fn pack_to_file(
    roots: &[PathBuf],
    passphrase: &str,
    dest_path: &Path,
    on: &mut dyn FnMut(Tick),
) -> Result<PackOutcome> {
    pack_to_file_with_qr(roots, passphrase, dest_path, on).map(|(outcome, _)| outcome)
}

/// [`pack_to_file`] 과 같되 QR 나눔도 함께 돌려준다.
///
/// 나눔은 [`PackOutcome`] 에 담지 않는다. 그 구조체는 IPC 로 건너가는 것이고 나눔은 조각
/// 텍스트를 통째로 들고 있어서, 실어 보내면 응답이 수백 KiB 가 된다. 명령 래퍼만 이걸 받아
/// [`QrSlot`] 에 넣어 두고, 뷰어는 [`qr_piece`] 로 한 장씩 가져간다.
pub fn pack_to_file_with_qr(
    roots: &[PathBuf],
    passphrase: &str,
    dest_path: &Path,
    on: &mut dyn FnMut(Tick),
) -> Result<(PackOutcome, Option<qr::QrPlan>)> {
    // 호출자(명령 래퍼)도 검사하지만, 이 함수 자체의 불변식이므로 여기서도 지킨다.
    // 빈 키로 묶인 컨테이너는 아무나 열 수 있으니 조용히 통과시키면 안 된다.
    if passphrase.is_empty() {
        return Err(Error::EmptyKey);
    }
    pack_scan_with_qr(archive::scan(roots)?, passphrase, dest_path, on)
}

/// [`pack_to_file_with_qr`] 과 같되 이미 훑어 둔 [`archive::Scan`] 에서 시작한다.
///
/// 원본이 디스크가 아니라 **메모리**일 수 있어서 갈라졌다 — 텍스트 입력 모드는 사람이 창에 친
/// 글을 임시 파일 없이 그대로 묶는다 ([`archive::scan_text`]).
pub fn pack_scan_with_qr(
    scan: archive::Scan,
    passphrase: &str,
    dest_path: &Path,
    on: &mut dyn FnMut(Tick),
) -> Result<(PackOutcome, Option<qr::QrPlan>)> {
    if passphrase.is_empty() {
        return Err(Error::EmptyKey);
    }

    let kdf = crypto::KdfParams::generate();
    let keys = crypto::derive_keys(passphrase, &kdf)?;
    let header = Header::new(
        kdf,
        crypto::random_nonce_prefix(),
        keys.kcv(),
        container::DEFAULT_CHUNK_SIZE,
    )?;

    if let Some(parent) = dest_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| Error::io(&format!("{} 를 만들 수 없습니다", parent.display()), e))?;
        }
    }
    let file = fs::File::create(dest_path)
        .map_err(|e| Error::io(&format!("{} 를 만들 수 없습니다", dest_path.display()), e))?;

    // 아래에서 위로: 파일 ← 버퍼 ← Base64 ← 암호화 ← 압축 ← 직렬화
    let text_sink = ArmorWriter::new(BufWriter::new(file))?;
    let sealed = ContainerWriter::new(text_sink, header, &keys)?;
    let mut encoder = zstd::Encoder::new(sealed, ZSTD_LEVEL).map_err(Error::recover)?;

    let report = archive::write_payload(&scan, &mut encoder, on)?;

    // 위에서 아래로 닫는다. zstd 프레임을 먼저 마무리해야 남은 평문이 마지막 청크에 담기고,
    // 그 청크까지 Base64 로 옮겨진 뒤에 끝 표시 줄이 나간다.
    let sealed = encoder.finish().map_err(Error::recover)?;
    let text_sink = sealed.finish()?;
    let mut buffered = text_sink.finish()?;
    buffered
        .flush()
        .map_err(|e| Error::io("파일을 마무리할 수 없습니다", e))?;
    let file = buffered
        .into_inner()
        .map_err(|e| Error::io("파일을 마무리할 수 없습니다", e.into_error()))?;
    file.sync_all()
        .map_err(|e| Error::io("파일을 디스크에 기록할 수 없습니다", e))?;
    drop(file);

    let container_bytes = fs::metadata(dest_path).map(|m| m.len()).unwrap_or(0);

    // 붙여넣어 쓸 수 있는 크기면 텍스트를 바로 실어 보낸다 (왕복 한 번을 아낀다).
    let (preview, preview_omitted) = if container_bytes <= TEXT_PREVIEW_LIMIT {
        match fs::read_to_string(dest_path) {
            Ok(text) => (Some(text), false),
            Err(_) => (None, true),
        }
    } else {
        (None, true)
    };

    // QR 은 덧붙이는 정보다. 만들다 실패해도 묶기 자체는 이미 성공했으므로 조용히 비워 둔다 —
    // 그림 하나 때문에 성공한 결과를 에러로 되돌리면 안 된다.
    //
    // 이미 메모리에 있는 preview 를 그대로 쓴다. QR_SOURCE_LIMIT 가 TEXT_PREVIEW_LIMIT 보다
    // 한참 작으므로 QR 대상이면 텍스트는 항상 손에 있고, 파일을 다시 읽을 일이 없다.
    let qr = match preview.as_deref() {
        Some(text) if container_bytes <= QR_SOURCE_LIMIT => qr::plan(text).unwrap_or(None),
        _ => None,
    };
    // 첫 장은 함께 실어 보낸다. 결과가 뜨자마자 보여 줄 수 있어 왕복 한 번을 아낀다.
    let qr_first = qr.as_ref().and_then(|plan| plan.image(1).ok());
    let qr_plan = qr.as_ref().map(qr::QrPlan::info);

    Ok((
        PackOutcome {
            dest: dest_path.to_string_lossy().to_string(),
            container_bytes,
            original_bytes: report.total_bytes,
            file_count: report.file_count,
            dir_count: report.dir_count,
            changed: report.changed,
            skipped: report.skipped,
            preview,
            preview_omitted,
            qr_omitted: qr_plan.is_none(),
            qr_plan,
            qr_first,
            qr_limit_bytes: qr::MAX_SYMBOL_BYTES,
            qr_limit_pieces: qr::MAX_PIECES,
        },
        qr,
    ))
}

// ---------------------------------------------------------------- 텍스트 다루기

/// 컨테이너 텍스트를 클립보드에 올린다.
///
/// 파일에서 직접 읽어 올리므로 본문이 IPC 를 한 번 더 건너지 않는다.
#[tauri::command]
pub async fn copy_container_to_clipboard(app: AppHandle, path: String) -> Result<u64> {
    blocking(move || {
        let p = PathBuf::from(&path);
        let byte_size = fs::metadata(&p)
            .map_err(|e| Error::io(&format!("{} 를 열 수 없습니다", p.display()), e))?
            .len();
        if byte_size > CLIPBOARD_LIMIT {
            return Err(Error::Io(format!(
                "텍스트가 너무 커서 클립보드로 옮길 수 없습니다 ({} MB). 저장된 파일을 그대로 보내 주세요.",
                byte_size / 1024 / 1024
            )));
        }

        let text = fs::read_to_string(&p).map_err(|_| {
            Error::Io("이 파일은 텍스트가 아니어서 복사할 수 없습니다.".to_string())
        })?;
        app.clipboard()
            .write_text(text)
            .map_err(|e| Error::Io(format!("클립보드에 옮길 수 없습니다: {e}")))?;
        Ok(byte_size)
    })
    .await
}

// ---------------------------------------------------------------- 풀기

#[derive(Debug, Serialize)]
pub struct UnpackOutcome {
    pub dest: String,
    pub file_count: usize,
    pub dir_count: usize,
    pub total_bytes: u64,
    /// 안전하지 않은 경로여서 쓰지 않은 항목.
    pub skipped: Vec<String>,
    /// 저장된 sha256 과 다르게 복원된 파일.
    pub hash_mismatch: Vec<String>,
    /// 목적지에 같은 이름이 이미 있어 번호를 붙인 항목.
    pub renamed: Vec<String>,
}

#[tauri::command]
pub async fn unpack(
    app: AppHandle,
    container: String,
    passphrase: String,
    dest: String,
) -> Result<UnpackOutcome> {
    blocking(move || {
        unpack_blocking(
            app,
            ContainerSource::File(PathBuf::from(container)),
            passphrase,
            dest,
        )
    })
    .await
}

/// 붙여넣은 텍스트에서 곧바로 풀어낸다.
#[tauri::command]
pub async fn unpack_text(
    app: AppHandle,
    text: String,
    passphrase: String,
    dest: String,
) -> Result<UnpackOutcome> {
    blocking(move || unpack_blocking(app, ContainerSource::Text(text), passphrase, dest)).await
}

fn unpack_blocking(
    app: AppHandle,
    source: ContainerSource,
    mut passphrase: String,
    dest: String,
) -> Result<UnpackOutcome> {
    if passphrase.is_empty() {
        return Err(Error::EmptyKey);
    }
    if dest.trim().is_empty() {
        return Err(Error::NoDestination);
    }

    let mut reporter = Reporter::new(app, EVENT_UNPACK, "unpacking");
    let outcome = unpack_to_dir(&source, &passphrase, &PathBuf::from(&dest), &mut |t| {
        reporter.on(t)
    });
    passphrase.zeroize();
    if outcome.is_ok() {
        reporter.finish();
    }
    outcome
}

/// Tauri 창 없이도 쓸 수 있는 풀기 진입점. 통합 테스트가 이걸 직접 부른다.
///
/// 목적지 안의 임시 폴더에 먼저 풀고 다 성공하면 옮긴다. 이렇게 하지 않으면 중간에 실패했을 때
/// 사용자가 고른 폴더에 반쯤 복원된 파일들이 뒤섞여 남는다. 같은 볼륨이라 옮기는 건 rename
/// 이므로 사실상 공짜다.
pub fn unpack_to_dir(
    source: &ContainerSource,
    passphrase: &str,
    dest_dir: &Path,
    on: &mut dyn FnMut(Tick),
) -> Result<UnpackOutcome> {
    if passphrase.is_empty() {
        return Err(Error::EmptyKey);
    }
    if dest_dir.as_os_str().is_empty() {
        return Err(Error::NoDestination);
    }
    fs::create_dir_all(dest_dir)
        .map_err(|e| Error::io(&format!("{} 를 만들 수 없습니다", dest_dir.display()), e))?;

    let staging = staging_dir(dest_dir)?;
    let outcome = unpack_staged(source, passphrase, &staging, dest_dir, on);
    // 성공했으면 이미 비어 있고, 실패했으면 부스러기가 여기서 사라진다.
    let _ = fs::remove_dir_all(&staging);
    outcome
}

fn unpack_staged(
    source: &ContainerSource,
    passphrase: &str,
    staging: &Path,
    dest_dir: &Path,
    on: &mut dyn FnMut(Tick),
) -> Result<UnpackOutcome> {
    let (mut reader, _armored) = source.open()?;

    // 헤더를 먼저 읽고 KCV 로 키를 확인한다. 여기서 걸러야 "키가 틀렸다" 를 정확히 말할 수 있다.
    let (header, keys) = container::open_header(&mut reader, passphrase)?;

    let sealed = ContainerReader::new(reader, header, &keys)?;
    let mut decoder = zstd::Decoder::new(sealed).map_err(Error::recover)?;

    let report = archive::read_payload(&mut decoder, staging, on)?;

    // 페이로드 뒤에 남은 바이트가 있으면 우리가 만든 것이 아니거나 조작된 것이다. 한 바이트를
    // 더 요청하면 zstd 가 프레임 꼬리까지 읽으면서 컨테이너의 마지막 청크도 인증하게 된다.
    let mut tail = [0u8; 1];
    if decoder.read(&mut tail).map_err(Error::recover)? != 0 {
        return Err(Error::Corrupted);
    }

    let renamed = move_into_place(staging, dest_dir)?;

    Ok(UnpackOutcome {
        dest: dest_dir.to_string_lossy().to_string(),
        file_count: report.file_count,
        dir_count: report.dir_count,
        total_bytes: report.total_bytes,
        skipped: report.skipped,
        hash_mismatch: report.hash_mismatch,
        renamed,
    })
}

/// 임시 폴더의 최상위 항목들을 목적지로 옮긴다. 이름이 겹치면 번호를 붙여 덮어쓰지 않는다.
fn move_into_place(staging: &Path, dest: &Path) -> Result<Vec<String>> {
    let mut taken: HashSet<String> = HashSet::new();
    let listing = fs::read_dir(dest)
        .map_err(|e| Error::io(&format!("{} 를 읽을 수 없습니다", dest.display()), e))?;
    for entry in listing.flatten() {
        taken.insert(entry.file_name().to_string_lossy().to_string());
    }

    let mut renamed = Vec::new();
    let staged = fs::read_dir(staging)
        .map_err(|e| Error::io(&format!("{} 를 읽을 수 없습니다", staging.display()), e))?;
    for entry in staged {
        let entry = entry.map_err(|e| Error::io("임시 폴더를 읽을 수 없습니다", e))?;
        let name = entry.file_name().to_string_lossy().to_string();
        let final_name = safepath::unique_name(&mut taken, &name);
        if final_name != name {
            renamed.push(format!("{name} → {final_name}"));
        }
        fs::rename(entry.path(), dest.join(&final_name)).map_err(|e| {
            Error::io(
                &format!("{name} 을 {} 로 옮길 수 없습니다", dest.display()),
                e,
            )
        })?;
    }
    Ok(renamed)
}

fn staging_dir(dest: &Path) -> Result<PathBuf> {
    temp_dir_in(dest, ".packer-part-")
}

/// `parent` 안에 아무도 쓰지 않는 이름으로 폴더를 하나 만든다.
///
/// 이름을 난수로 짓고 `create_dir` 의 성공 자체를 자리 잡기로 삼는다 — 있는지 먼저 보고 만들면
/// 그 사이에 다른 실행이 끼어들 수 있다.
fn temp_dir_in(parent: &Path, prefix: &str) -> Result<PathBuf> {
    for _ in 0..64 {
        let mut raw = [0u8; 8];
        rand::rngs::OsRng.fill_bytes(&mut raw);
        let name: String = raw.iter().fold(prefix.to_string(), |mut acc, b| {
            acc.push_str(&format!("{b:02x}"));
            acc
        });
        let candidate = parent.join(name);
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(Error::io("임시 폴더를 만들 수 없습니다", e)),
        }
    }
    Err(Error::Internal("임시 폴더를 만들 수 없습니다".into()))
}

// ---------------------------------------------------------------- 파일 선택 / 탐색기

/// 묶을 파일을 고른다 (드래그가 어려운 경우의 대안).
#[tauri::command]
pub async fn pick_files_to_pack(app: AppHandle) -> Result<Vec<String>> {
    blocking(move || {
        let picked = app.dialog().file().blocking_pick_files();
        Ok(picked
            .unwrap_or_default()
            .into_iter()
            .filter_map(to_path_string)
            .collect())
    })
    .await
}

/// 묶을 폴더를 고른다.
#[tauri::command]
pub async fn pick_folders_to_pack(app: AppHandle) -> Result<Vec<String>> {
    blocking(move || {
        let picked = app.dialog().file().blocking_pick_folders();
        Ok(picked
            .unwrap_or_default()
            .into_iter()
            .filter_map(to_path_string)
            .collect())
    })
    .await
}

/// 풀어낼 컨테이너 텍스트 파일을 고른다.
#[tauri::command]
pub async fn pick_container(app: AppHandle) -> Result<Option<String>> {
    blocking(move || {
        let picked = app
            .dialog()
            .file()
            .add_filter("Packer 텍스트", &[CONTAINER_EXTENSION])
            .add_filter("모든 파일", &["*"])
            .blocking_pick_file();
        Ok(picked.and_then(to_path_string))
    })
    .await
}

/// 풀어낼 위치를 고른다. `start` 가 있으면 그 폴더에서 시작한다.
#[tauri::command]
pub async fn pick_dest_dir(app: AppHandle, start: Option<String>) -> Result<Option<String>> {
    blocking(move || {
        let mut builder = app.dialog().file();
        if let Some(dir) = start.as_deref().filter(|d| Path::new(d).is_dir()) {
            builder = builder.set_directory(dir);
        }
        Ok(builder.blocking_pick_folder().and_then(to_path_string))
    })
    .await
}

/// 컨테이너 텍스트를 저장할 위치를 고른다.
#[tauri::command]
pub async fn pick_save_path(
    app: AppHandle,
    suggested_name: String,
    start: Option<String>,
) -> Result<Option<String>> {
    blocking(move || {
        let mut builder = app
            .dialog()
            .file()
            .set_file_name(&suggested_name)
            .add_filter("Packer 텍스트", &[CONTAINER_EXTENSION]);
        if let Some(dir) = start.as_deref().filter(|d| Path::new(d).is_dir()) {
            builder = builder.set_directory(dir);
        }
        Ok(builder.blocking_save_file().and_then(to_path_string))
    })
    .await
}

/// 탐색기에서 해당 항목을 선택된 상태로 띄운다.
#[tauri::command]
pub async fn reveal(app: AppHandle, path: String) -> Result<()> {
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| Error::Io(format!("{path} 를 탐색기에서 열 수 없습니다: {e}")))
}

/// 다이얼로그가 돌려준 값을 평범한 경로 문자열로 바꾼다.
///
/// 데스크탑에서는 항상 실제 경로가 오지만, 타입 자체는 URI 도 표현할 수 있어서 실패를 허용한다.
fn to_path_string(picked: tauri_plugin_dialog::FilePath) -> Option<String> {
    picked
        .into_path()
        .ok()
        .map(|p| p.to_string_lossy().to_string())
}

// ---------------------------------------------------------------- 공통

/// 순서를 지키면서 중복 경로를 걸러낸다. 같은 파일을 두 번 드롭하는 일은 흔하다.
fn dedupe(paths: Vec<String>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    paths
        .into_iter()
        .filter(|p| !p.trim().is_empty())
        .filter(|p| seen.insert(p.clone()))
        .map(PathBuf::from)
        .collect()
}

/// 무거운 동기 작업을 블로킹 스레드로 넘긴다.
async fn blocking<T, F>(job: F) -> Result<T>
where
    F: FnOnce() -> Result<T> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|e| Error::Internal(format!("작업 스레드가 중단되었습니다: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_temp_container_name_never_becomes_a_path() {
        // 화면이 제안한 이름을 그대로 쓰되, 임시 폴더 **밖**을 가리키게 두면 안 된다.
        for suggested in ["../../evil.txt", "C:\\Windows\\x.txt", "  ..  ", "", "   "] {
            let name = temp_container_name(Some(suggested));
            assert!(!name.contains('/'), "{suggested} → {name}");
            assert!(!name.contains('\\'), "{suggested} → {name}");
            assert!(!name.starts_with('.'), "{suggested} → {name}");
            assert!(!name.is_empty(), "{suggested} → 빈 이름");
        }
    }

    #[test]
    fn a_sane_suggestion_is_kept_as_it_is() {
        // 이름을 알아볼 수 있어야 '탐색기에서 보기' 로 열었을 때 자기 파일인 줄 안다.
        assert_eq!(
            temp_container_name(Some("보고서.packer.txt")),
            "보고서.packer.txt"
        );
        assert_eq!(
            temp_container_name(None),
            format!("packer.{CONTAINER_EXTENSION}")
        );
    }

    #[test]
    fn temp_dirs_do_not_collide() {
        let parent = std::env::temp_dir();
        let a = temp_dir_in(&parent, "packer-test-").unwrap();
        let b = temp_dir_in(&parent, "packer-test-").unwrap();
        assert_ne!(a, b);
        assert!(a.is_dir() && b.is_dir());
        let _ = fs::remove_dir_all(&a);
        let _ = fs::remove_dir_all(&b);
    }
}
