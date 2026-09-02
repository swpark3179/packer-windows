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
use std::time::{Duration, Instant};

use rand::RngCore;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use zeroize::Zeroize;

use crate::archive::{self, Tick};
use crate::armor::{self, ArmorReader, ArmorWriter};
use crate::container::{self, ContainerReader, ContainerWriter, Header};
use crate::crypto;
use crate::error::{Error, Result};
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
                Ok((Box::new(ArmorReader::new(Cursor::new(text.as_bytes()))), true))
            }

            ContainerSource::File(path) => {
                let file = fs::File::open(path)
                    .map_err(|e| Error::io(&format!("{} 를 열 수 없습니다", path.display()), e))?;
                let mut reader = BufReader::new(file);

                // 앞부분만 엿본다. 초기 버전이 만든 원시 바이너리 컨테이너도 읽어 줘야
                // 이미 만들어 둔 파일이 갑자기 열리지 않는 일이 없다. 새로 묶을 때는 항상
                // 텍스트로만 쓴다.
                let head = reader
                    .fill_buf()
                    .map_err(|e| Error::io(&format!("{} 를 읽을 수 없습니다", path.display()), e))?;
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
}

#[tauri::command]
pub async fn pack(
    app: AppHandle,
    paths: Vec<String>,
    passphrase: String,
    dest: String,
) -> Result<PackOutcome> {
    blocking(move || pack_blocking(app, paths, passphrase, dest)).await
}

fn pack_blocking(
    app: AppHandle,
    paths: Vec<String>,
    mut passphrase: String,
    dest: String,
) -> Result<PackOutcome> {
    if passphrase.is_empty() {
        return Err(Error::EmptyKey);
    }
    let roots = dedupe(paths);
    if roots.is_empty() {
        return Err(Error::NothingToPack);
    }
    let dest_path = PathBuf::from(&dest);

    let mut reporter = Reporter::new(app, EVENT_PACK, "packing");
    let outcome = pack_to_file(&roots, &passphrase, &dest_path, &mut |t| reporter.on(t));
    passphrase.zeroize();
    if outcome.is_ok() {
        reporter.finish();
    }

    match outcome {
        Ok(o) => Ok(o),
        Err(e) => {
            // 반쯤 쓰다 만 텍스트는 남기지 않는다. 열리지 않는 파일이 디스크에 남아 있으면
            // 사용자는 성공했는지 실패했는지 알 수 없다.
            let _ = fs::remove_file(&dest_path);
            Err(e)
        }
    }
}

/// Tauri 창 없이도 쓸 수 있는 묶기 진입점. 통합 테스트가 이걸 직접 부른다.
pub fn pack_to_file(
    roots: &[PathBuf],
    passphrase: &str,
    dest_path: &Path,
    on: &mut dyn FnMut(Tick),
) -> Result<PackOutcome> {
    // 호출자(명령 래퍼)도 검사하지만, 이 함수 자체의 불변식이므로 여기서도 지킨다.
    // 빈 키로 묶인 컨테이너는 아무나 열 수 있으니 조용히 통과시키면 안 된다.
    if passphrase.is_empty() {
        return Err(Error::EmptyKey);
    }

    let scan = archive::scan(roots)?;

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

    Ok(PackOutcome {
        dest: dest_path.to_string_lossy().to_string(),
        container_bytes,
        original_bytes: report.total_bytes,
        file_count: report.file_count,
        dir_count: report.dir_count,
        changed: report.changed,
        skipped: report.skipped,
        preview,
        preview_omitted,
    })
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
    for _ in 0..64 {
        let mut raw = [0u8; 8];
        rand::rngs::OsRng.fill_bytes(&mut raw);
        let name: String = raw.iter().fold(".packer-part-".to_string(), |mut acc, b| {
            acc.push_str(&format!("{b:02x}"));
            acc
        });
        let candidate = dest.join(name);
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
