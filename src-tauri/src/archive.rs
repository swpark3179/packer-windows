//! 파일 트리를 하나의 바이트 스트림으로 직렬화하고 되돌린다.
//!
//! 평문 스트림 구조:
//!
//! ```text
//! [u32 LE manifest_len][bincode(Manifest)]
//! [file0 바이트 정확히 size][file1 …]
//! [u32 LE trailer_len][bincode(Trailer)]
//! ```
//!
//! 매니페스트가 앞에 있어야 읽는 쪽이 스트리밍으로 복원할 수 있다. 파일별 sha256 은 뒤쪽 트레일러에
//! 두는데, 그래야 묶을 때 파일을 두 번 읽지 않아도 된다 (해시는 쓰면서 계산한다).
//!
//! 각 파일은 매니페스트에 적힌 `size` 만큼 **정확히** 쓴다. 묶는 중에 원본이 변해도 스트림의 경계가
//! 흔들리지 않게 하려는 것이고, 크기가 달라진 파일은 [`PackReport::changed`] 로 사용자에게 알린다.

use std::collections::HashSet;
use std::fs;
use std::io::{self, Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use crate::error::{Error, Result};
use crate::safepath;

pub const MANIFEST_VERSION: u16 = 1;

/// 매니페스트/트레일러가 통째로 메모리에 올라가므로 상한을 둔다.
const MAX_BLOB_BYTES: u32 = 64 * 1024 * 1024;
const COPY_BUF: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Kind {
    Dir,
    File,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    /// 항상 `/` 로 구분되는 상대 경로.
    pub rel_path: String,
    pub kind: Kind,
    /// `Dir` 이면 0.
    pub size: u64,
    /// 유닉스 초. 복원할 때 다시 씌운다.
    pub mtime: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub version: u16,
    pub created_utc: i64,
    pub entries: Vec<Entry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Trailer {
    /// 매니페스트의 `File` 엔트리 순서와 1:1 대응하는 sha256.
    pub hashes: Vec<[u8; 32]>,
}

/// 진행률 콜백에 전달되는 소식.
///
/// 총량은 시작 시점에 모를 수도 있다 (풀기는 매니페스트를 읽어야 알 수 있다). 그래서 진행량과
/// 총량을 같은 채널로 흘려보내 UI 가 불확정 상태에서 확정 상태로 자연스럽게 넘어가게 한다.
pub enum Tick<'a> {
    /// 앞으로 처리할 파일 내용의 총 바이트.
    Total(u64),
    /// 방금 처리한 바이트와 그 파일의 경로.
    Advance { bytes: u64, path: &'a str },
}

/// 한 엔트리의 내용이 어디서 오는지.
///
/// **메모리에서 오는 갈래가 있어서 열거형이다.** 텍스트 입력 모드는 사람이 창에 친 글을 바로
/// 묶는데, 그걸 임시 파일로 한 번 떨어뜨리면 **평문이 디스크에 남는다** — 곧바로 지워도 지운
/// 자리를 덮어쓰지는 못한다. 이 앱이 없애려는 노출이 정확히 그것이라, 그 한 종류를 만들지
/// 않으려고 원본을 바이트로도 받는다.
pub enum Source {
    /// 디스크에서 스트리밍으로 읽는다. 파일을 통째로 메모리에 올리지 않는다.
    File(PathBuf),
    /// 이미 손에 있는 바이트. 어디에도 쓰지 않고 그대로 흘려보낸다.
    Memory(Vec<u8>),
}

impl Drop for Source {
    /// 메모리 원본은 **평문**이다. 놓을 때 지운다.
    ///
    /// 힙에서 그냥 풀려나면 그 바이트는 다음에 그 자리를 받는 할당까지 그대로 남아 있고,
    /// 프로세스가 죽어 코어 덤프가 떨어지면 거기에도 실린다. 임시 파일을 만들지 않으려고
    /// 이 갈래를 낸 것이므로, 메모리에서도 같은 규율을 지킨다.
    fn drop(&mut self) {
        if let Source::Memory(bytes) = self {
            bytes.zeroize();
        }
    }
}

impl Source {
    /// 안내 문구에 적을 이름. 메모리 원본에는 경로가 없다.
    fn label(&self) -> String {
        match self {
            Source::File(path) => path.display().to_string(),
            Source::Memory(_) => "입력한 텍스트".to_string(),
        }
    }

    fn open(&self) -> Result<Box<dyn Read + '_>> {
        match self {
            Source::File(path) => {
                let file = fs::File::open(path)
                    .map_err(|e| Error::io(&format!("{} 을 열 수 없습니다", path.display()), e))?;
                Ok(Box::new(file))
            }
            Source::Memory(bytes) => Ok(Box::new(Cursor::new(bytes.as_slice()))),
        }
    }
}

/// 묶기 전에 원본을 훑어 얻은 정보.
pub struct Scan {
    pub manifest: Manifest,
    /// `File` 엔트리와 같은 순서의 실제 원본.
    pub sources: Vec<Source>,
    pub total_bytes: u64,
    pub file_count: usize,
    pub dir_count: usize,
    /// 담지 못한 항목과 이유 (링크, 읽기 실패 등).
    pub skipped: Vec<String>,
}

#[derive(Debug, Default, Serialize)]
pub struct PackReport {
    pub file_count: usize,
    pub dir_count: usize,
    pub total_bytes: u64,
    /// 묶는 도중 크기가 달라진 파일 — 기록된 크기에 맞춰 잘리거나 0으로 채워졌다.
    pub changed: Vec<String>,
    pub skipped: Vec<String>,
}

#[derive(Debug, Default, Serialize)]
pub struct UnpackReport {
    pub file_count: usize,
    pub dir_count: usize,
    pub total_bytes: u64,
    /// 안전하지 않은 경로여서 쓰지 않은 항목. 스트림 정렬을 위해 바이트는 읽고 버렸다.
    pub skipped: Vec<String>,
    /// 트레일러의 sha256 과 실제로 쓴 내용이 다른 파일.
    pub hash_mismatch: Vec<String>,
}

fn unix_secs(t: SystemTime) -> i64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_secs() as i64,
        Err(e) => -(e.duration().as_secs() as i64),
    }
}

fn mtime_of(meta: &fs::Metadata) -> i64 {
    meta.modified().map(unix_secs).unwrap_or(0)
}

/// 드롭된 경로들을 훑어 매니페스트를 만든다. 폴더는 재귀적으로 들어간다.
///
/// 심볼릭 링크는 따라가지 않는다. 링크를 따라가면 순환에 빠질 수 있고, 사용자가 고른 폴더 밖의
/// 내용까지 조용히 담게 된다.
pub fn scan(roots: &[PathBuf]) -> Result<Scan> {
    let mut entries: Vec<Entry> = Vec::new();
    let mut sources: Vec<Source> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut taken: HashSet<String> = HashSet::new();
    let mut total_bytes = 0u64;
    let mut dir_count = 0usize;

    for root in roots {
        // 루트 자체는 사용자가 직접 고른 것이므로 링크여도 대상을 따라간다.
        let meta = match fs::metadata(root) {
            Ok(m) => m,
            Err(e) => {
                skipped.push(format!("{} — 열 수 없습니다: {e}", root.display()));
                continue;
            }
        };

        let raw_name = root
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_string)
            // `C:\` 처럼 파일 이름이 없는 경로.
            .unwrap_or_else(|| {
                root.to_string_lossy()
                    .chars()
                    .map(|c| if c.is_alphanumeric() { c } else { '_' })
                    .collect()
            });
        let top = safepath::unique_name(&mut taken, &raw_name);

        if meta.is_file() {
            total_bytes += meta.len();
            entries.push(Entry {
                rel_path: top,
                kind: Kind::File,
                size: meta.len(),
                mtime: mtime_of(&meta),
            });
            sources.push(Source::File(root.clone()));
            continue;
        }

        if !meta.is_dir() {
            skipped.push(format!("{} — 파일도 폴더도 아닙니다", root.display()));
            continue;
        }

        entries.push(Entry {
            rel_path: top.clone(),
            kind: Kind::Dir,
            size: 0,
            mtime: mtime_of(&meta),
        });
        dir_count += 1;

        for item in walkdir::WalkDir::new(root).min_depth(1).follow_links(false) {
            let item = match item {
                Ok(i) => i,
                Err(e) => {
                    skipped.push(format!("{root:?} 안에서 읽기 실패: {e}"));
                    continue;
                }
            };

            if item.file_type().is_symlink() {
                skipped.push(format!("{} — 링크는 담지 않습니다", item.path().display()));
                continue;
            }

            let Ok(relative) = item.path().strip_prefix(root) else {
                skipped.push(format!(
                    "{} — 경로를 해석할 수 없습니다",
                    item.path().display()
                ));
                continue;
            };

            // 매니페스트는 항상 `/` 를 쓴다. UTF-8 이 아닌 이름은 손상시키지 않고 건너뛴다.
            let mut parts = Vec::new();
            let mut lossy = false;
            for c in relative.components() {
                match c.as_os_str().to_str() {
                    Some(s) => parts.push(s.to_string()),
                    None => {
                        lossy = true;
                        break;
                    }
                }
            }
            if lossy {
                skipped.push(format!(
                    "{} — 이름을 UTF-8 로 표현할 수 없습니다",
                    item.path().display()
                ));
                continue;
            }
            let rel_path = format!("{top}/{}", parts.join("/"));

            let meta = match item.metadata() {
                Ok(m) => m,
                Err(e) => {
                    skipped.push(format!(
                        "{} — 정보를 읽을 수 없습니다: {e}",
                        item.path().display()
                    ));
                    continue;
                }
            };

            if meta.is_dir() {
                entries.push(Entry {
                    rel_path,
                    kind: Kind::Dir,
                    size: 0,
                    mtime: mtime_of(&meta),
                });
                dir_count += 1;
            } else if meta.is_file() {
                total_bytes += meta.len();
                entries.push(Entry {
                    rel_path,
                    kind: Kind::File,
                    size: meta.len(),
                    mtime: mtime_of(&meta),
                });
                sources.push(Source::File(item.path().to_path_buf()));
            }
        }
    }

    let file_count = sources.len();
    if file_count == 0 && dir_count == 0 {
        return Err(Error::NothingToPack);
    }

    Ok(Scan {
        manifest: Manifest {
            version: MANIFEST_VERSION,
            created_utc: unix_secs(SystemTime::now()),
            entries,
        },
        sources,
        total_bytes,
        file_count,
        dir_count,
        skipped,
    })
}

/// 손에 든 바이트 하나를 파일 한 개짜리 매니페스트로 세운다.
///
/// 텍스트 입력 모드가 쓴다. [`scan`] 과 하는 일은 같지만 **디스크를 건드리지 않는다** —
/// 임시 파일로 한 번 떨어뜨리면 평문이 디스크에 남고, 그것이 이 앱이 없애려는 노출 그 자체다.
/// 그래서 원본을 [`Source::Memory`] 로 들고 간다 ([`write_payload`] 가 그대로 흘려보낸다).
///
/// 이름은 컨테이너 안에서 쓸 파일 이름이다. 경로 구분자와 상위 참조는 여기서 걷어 낸다 —
/// 푸는 쪽의 [`safepath`] 가 다시 한번 막지만, 애초에 만들지 않는 편이 낫다.
pub fn scan_text(name: &str, bytes: Vec<u8>) -> Result<Scan> {
    if bytes.is_empty() {
        return Err(Error::NothingToPack);
    }
    let size = bytes.len() as u64;
    let entry = Entry {
        rel_path: text_entry_name(name),
        kind: Kind::File,
        size,
        mtime: unix_secs(SystemTime::now()),
    };

    Ok(Scan {
        manifest: Manifest {
            version: MANIFEST_VERSION,
            created_utc: unix_secs(SystemTime::now()),
            entries: vec![entry],
        },
        sources: vec![Source::Memory(bytes)],
        total_bytes: size,
        file_count: 1,
        dir_count: 0,
        skipped: Vec::new(),
    })
}

/// 사람이 적은 이름을 컨테이너 안의 파일 이름으로 다듬는다.
///
/// 비거나 전부 걷어내지면 [`DEFAULT_TEXT_NAME`] 으로 돌아간다 — 이름이 없다고 묶기를 거절하는
/// 것은 사용자가 고칠 거리도 아닌 일로 막아서는 것이다.
fn text_entry_name(name: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| match c {
            // 경로가 되는 글자와 제어문자만 막는다. 한글·공백·괄호는 파일 이름으로 멀쩡하다.
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    // `.` 과 `..` 은 파일 이름이 아니다.
    let cleaned = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if cleaned.is_empty() {
        return DEFAULT_TEXT_NAME.to_string();
    }
    // 확장자가 없으면 붙여 준다. 풀어낸 뒤 더블클릭으로 열리는 편이 낫다.
    if Path::new(cleaned).extension().is_none() {
        return format!("{cleaned}.txt");
    }
    cleaned.to_string()
}

/// 이름을 적지 않았을 때 컨테이너 안에 들어가는 파일 이름.
pub const DEFAULT_TEXT_NAME: &str = "메모.txt";

/// 한 항목의 크기만 빠르게 재본다. 드롭 목록에 표시할 용도.
///
/// [`scan`] 과 달리 매니페스트를 만들지 않는다. 파일 수만 명인 폴더를 목록에 한 줄 보여주려고
/// 엔트리를 전부 할당할 이유가 없다.
pub fn measure(root: &Path) -> (u64, usize, usize) {
    let Ok(meta) = fs::metadata(root) else {
        return (0, 0, 0);
    };
    if meta.is_file() {
        return (meta.len(), 1, 0);
    }
    if !meta.is_dir() {
        return (0, 0, 0);
    }

    let mut bytes = 0u64;
    let mut files = 0usize;
    let mut dirs = 1usize; // 자기 자신
    for item in walkdir::WalkDir::new(root).min_depth(1).follow_links(false) {
        let Ok(item) = item else { continue };
        if item.file_type().is_symlink() {
            continue;
        }
        if item.file_type().is_dir() {
            dirs += 1;
        } else if let Ok(m) = item.metadata() {
            if m.is_file() {
                bytes += m.len();
                files += 1;
            }
        }
    }
    (bytes, files, dirs)
}

fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    bincode::serde::encode_to_vec(value, bincode::config::standard())
        .map_err(|e| Error::Internal(format!("직렬화 실패: {e}")))
}

fn write_blob<W: Write>(out: &mut W, bytes: &[u8]) -> Result<()> {
    let len = u32::try_from(bytes.len())
        .map_err(|_| Error::Internal("직렬화 결과가 너무 큽니다".into()))?;
    out.write_all(&len.to_le_bytes())?;
    out.write_all(bytes)?;
    Ok(())
}

fn read_blob<R: Read>(r: &mut R) -> Result<Vec<u8>> {
    let mut len_buf = [0u8; 4];
    r.read_exact(&mut len_buf)?;
    let len = u32::from_le_bytes(len_buf);
    if len > MAX_BLOB_BYTES {
        return Err(Error::Corrupted);
    }
    let mut bytes = vec![0u8; len as usize];
    r.read_exact(&mut bytes)?;
    Ok(bytes)
}

/// 훑어둔 트리를 평문 스트림으로 써 내려간다.
///
/// `progress` 는 파일 내용 바이트가 나갈 때마다 `(방금 쓴 바이트, 현재 경로)` 로 불린다.
pub fn write_payload<W: Write>(
    scan: &Scan,
    out: &mut W,
    on: &mut dyn FnMut(Tick),
) -> Result<PackReport> {
    on(Tick::Total(scan.total_bytes));
    write_blob(out, &encode(&scan.manifest)?)?;

    let mut report = PackReport {
        file_count: scan.file_count,
        dir_count: scan.dir_count,
        total_bytes: scan.total_bytes,
        changed: Vec::new(),
        skipped: scan.skipped.clone(),
    };

    let mut hashes = Vec::with_capacity(scan.sources.len());
    let file_entries = scan
        .manifest
        .entries
        .iter()
        .filter(|e| e.kind == Kind::File);

    let mut buf = vec![0u8; COPY_BUF];
    for (entry, source) in file_entries.zip(scan.sources.iter()) {
        let mut hasher = Sha256::new();
        let mut remaining = entry.size;

        let mut reader = source.open()?;

        while remaining > 0 {
            let want = buf.len().min(remaining as usize);
            let n = reader
                .read(&mut buf[..want])
                .map_err(|e| Error::io(&format!("{} 을 읽을 수 없습니다", source.label()), e))?;
            if n == 0 {
                break; // 파일이 줄었다 — 아래에서 0으로 채운다.
            }
            hasher.update(&buf[..n]);
            out.write_all(&buf[..n])?;
            remaining -= n as u64;
            on(Tick::Advance {
                bytes: n as u64,
                path: &entry.rel_path,
            });
        }

        if remaining > 0 {
            // 기록된 크기를 지켜야 스트림 경계가 어긋나지 않는다.
            report.changed.push(entry.rel_path.clone());
            let zeros = vec![0u8; COPY_BUF];
            while remaining > 0 {
                let n = zeros.len().min(remaining as usize);
                hasher.update(&zeros[..n]);
                out.write_all(&zeros[..n])?;
                remaining -= n as u64;
                on(Tick::Advance {
                    bytes: n as u64,
                    path: &entry.rel_path,
                });
            }
        } else {
            // 파일이 커졌는지도 확인한다 — 남은 바이트가 있으면 잘린 것이다.
            let mut probe = [0u8; 1];
            if matches!(reader.read(&mut probe), Ok(1)) {
                report.changed.push(entry.rel_path.clone());
            }
        }

        hashes.push(hasher.finalize().into());
    }

    write_blob(out, &encode(&Trailer { hashes })?)?;
    Ok(report)
}

/// 평문 스트림을 읽어 `dest` 아래에 트리를 되살린다.
pub fn read_payload<R: Read>(
    r: &mut R,
    dest: &Path,
    on: &mut dyn FnMut(Tick),
) -> Result<UnpackReport> {
    let manifest: Manifest = {
        let bytes = read_blob(r)?;
        bincode::serde::decode_from_slice(&bytes, bincode::config::standard())
            .map_err(|_| Error::Corrupted)?
            .0
    };
    if manifest.version > MANIFEST_VERSION {
        return Err(Error::UnsupportedVersion(manifest.version));
    }
    on(Tick::Total(
        manifest
            .entries
            .iter()
            .filter(|e| e.kind == Kind::File)
            .map(|e| e.size)
            .sum(),
    ));

    fs::create_dir_all(dest)
        .map_err(|e| Error::io(&format!("{} 를 만들 수 없습니다", dest.display()), e))?;

    let mut report = UnpackReport::default();
    // 파일 순서대로 계산한 해시. 안전하지 않아 건너뛴 항목은 None.
    let mut computed: Vec<(String, Option<[u8; 32]>)> = Vec::new();
    let mut dir_mtimes: Vec<(PathBuf, i64)> = Vec::new();
    let mut buf = vec![0u8; COPY_BUF];

    for entry in &manifest.entries {
        match entry.kind {
            Kind::Dir => match safepath::resolve_under(dest, &entry.rel_path) {
                Ok(path) => {
                    fs::create_dir_all(&path).map_err(|e| {
                        Error::io(&format!("{} 를 만들 수 없습니다", path.display()), e)
                    })?;
                    dir_mtimes.push((path, entry.mtime));
                    report.dir_count += 1;
                }
                Err(Error::PathEscape(why)) => report.skipped.push(why),
                Err(e) => return Err(e),
            },

            Kind::File => {
                let target = match safepath::resolve_under(dest, &entry.rel_path) {
                    Ok(p) => Some(p),
                    Err(Error::PathEscape(why)) => {
                        report.skipped.push(why);
                        None
                    }
                    Err(e) => return Err(e),
                };

                match target {
                    // 건너뛰더라도 바이트는 반드시 소비해야 다음 파일 경계가 맞는다.
                    None => {
                        io::copy(&mut r.by_ref().take(entry.size), &mut io::sink())?;
                        computed.push((entry.rel_path.clone(), None));
                    }
                    Some(path) => {
                        if let Some(parent) = path.parent() {
                            fs::create_dir_all(parent).map_err(|e| {
                                Error::io(&format!("{} 를 만들 수 없습니다", parent.display()), e)
                            })?;
                        }
                        let mut file = fs::File::create(&path).map_err(|e| {
                            Error::io(&format!("{} 를 만들 수 없습니다", path.display()), e)
                        })?;

                        let mut hasher = Sha256::new();
                        let mut remaining = entry.size;
                        while remaining > 0 {
                            let want = buf.len().min(remaining as usize);
                            r.read_exact(&mut buf[..want])?;
                            hasher.update(&buf[..want]);
                            file.write_all(&buf[..want]).map_err(|e| {
                                Error::io(&format!("{} 에 쓸 수 없습니다", path.display()), e)
                            })?;
                            remaining -= want as u64;
                            on(Tick::Advance {
                                bytes: want as u64,
                                path: &entry.rel_path,
                            });
                        }
                        file.flush().map_err(|e| {
                            Error::io(&format!("{} 를 마무리할 수 없습니다", path.display()), e)
                        })?;
                        drop(file);

                        set_mtime(&path, entry.mtime);
                        report.file_count += 1;
                        report.total_bytes += entry.size;
                        computed.push((entry.rel_path.clone(), Some(hasher.finalize().into())));
                    }
                }
            }
        }
    }

    // 트레일러로 실제로 쓴 내용이 맞는지 확인한다.
    let trailer: Trailer = {
        let bytes = read_blob(r)?;
        bincode::serde::decode_from_slice(&bytes, bincode::config::standard())
            .map_err(|_| Error::Corrupted)?
            .0
    };
    if trailer.hashes.len() != computed.len() {
        return Err(Error::Corrupted);
    }
    for ((rel, actual), expected) in computed.iter().zip(trailer.hashes.iter()) {
        if let Some(actual) = actual {
            if actual != expected {
                report.hash_mismatch.push(rel.clone());
            }
        }
    }

    // 안쪽 파일을 다 쓴 뒤에 폴더 시간을 씌운다. 먼저 하면 파일 생성이 다시 갱신해 버린다.
    for (path, mtime) in dir_mtimes.iter().rev() {
        set_mtime(path, *mtime);
    }

    Ok(report)
}

/// 수정 시각 복원은 최선 노력이다. 실패해도 복원 자체는 성공으로 본다.
fn set_mtime(path: &Path, mtime: i64) {
    let ft = filetime::FileTime::from_unix_time(mtime, 0);
    let _ = filetime::set_file_mtime(path, ft);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_file(path: &Path, contents: &[u8]) {
        if let Some(p) = path.parent() {
            fs::create_dir_all(p).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    /// 트리를 직렬화했다가 되살려 원본과 같은지 확인한다.
    fn round_trip(roots: &[PathBuf]) -> (UnpackReport, PathBuf, tempfile::TempDir) {
        let scan = scan(roots).unwrap();
        let mut payload = Vec::new();
        write_payload(&scan, &mut payload, &mut |_| {}).unwrap();

        let out = tempfile::tempdir().unwrap();
        let dest = out.path().join("restored");
        let report = read_payload(&mut payload.as_slice(), &dest, &mut |_| {}).unwrap();
        (report, dest, out)
    }

    #[test]
    fn round_trips_a_nested_tree() {
        let src = tempfile::tempdir().unwrap();
        let root = src.path().join("proj");
        write_file(&root.join("readme.md"), b"# hello");
        write_file(&root.join("src/main.rs"), b"fn main() {}");
        write_file(&root.join("src/deep/nested/note.txt"), b"deep");
        write_file(&root.join("empty.bin"), b"");
        fs::create_dir_all(root.join("emptydir")).unwrap();

        let (report, dest, _keep) = round_trip(std::slice::from_ref(&root));

        assert_eq!(report.file_count, 4);
        assert!(report.skipped.is_empty(), "{:?}", report.skipped);
        assert!(
            report.hash_mismatch.is_empty(),
            "{:?}",
            report.hash_mismatch
        );

        assert_eq!(fs::read(dest.join("proj/readme.md")).unwrap(), b"# hello");
        assert_eq!(
            fs::read(dest.join("proj/src/main.rs")).unwrap(),
            b"fn main() {}"
        );
        assert_eq!(
            fs::read(dest.join("proj/src/deep/nested/note.txt")).unwrap(),
            b"deep"
        );
        assert_eq!(fs::read(dest.join("proj/empty.bin")).unwrap(), b"");
        // 빈 폴더도 살아남아야 한다.
        assert!(dest.join("proj/emptydir").is_dir());
    }

    #[test]
    fn round_trips_loose_files() {
        let src = tempfile::tempdir().unwrap();
        let a = src.path().join("a.txt");
        let b = src.path().join("b.bin");
        write_file(&a, b"alpha");
        write_file(&b, &(0u8..255).collect::<Vec<u8>>());

        let (report, dest, _keep) = round_trip(&[a, b]);
        assert_eq!(report.file_count, 2);
        assert_eq!(fs::read(dest.join("a.txt")).unwrap(), b"alpha");
        assert_eq!(
            fs::read(dest.join("b.bin")).unwrap(),
            (0u8..255).collect::<Vec<u8>>()
        );
    }

    #[test]
    fn round_trips_korean_names() {
        let src = tempfile::tempdir().unwrap();
        let root = src.path().join("보고서");
        write_file(&root.join("2026년 계획.txt"), "가나다라".as_bytes());

        let (_r, dest, _keep) = round_trip(&[root]);
        assert_eq!(
            fs::read(dest.join("보고서/2026년 계획.txt")).unwrap(),
            "가나다라".as_bytes()
        );
    }

    #[test]
    fn same_named_roots_do_not_collide() {
        let src = tempfile::tempdir().unwrap();
        let one = src.path().join("one/note.txt");
        let two = src.path().join("two/note.txt");
        write_file(&one, b"first");
        write_file(&two, b"second");

        let (report, dest, _keep) = round_trip(&[one, two]);
        assert_eq!(report.file_count, 2);
        assert_eq!(fs::read(dest.join("note.txt")).unwrap(), b"first");
        assert_eq!(fs::read(dest.join("note (2).txt")).unwrap(), b"second");
    }

    #[test]
    fn spans_multiple_copy_buffers() {
        let src = tempfile::tempdir().unwrap();
        let big = src.path().join("big.bin");
        let payload: Vec<u8> = (0..COPY_BUF * 3 + 12345).map(|i| (i % 253) as u8).collect();
        write_file(&big, &payload);

        let (_r, dest, _keep) = round_trip(&[big]);
        assert_eq!(fs::read(dest.join("big.bin")).unwrap(), payload);
    }

    #[test]
    fn empty_selection_is_rejected() {
        assert!(matches!(scan(&[]), Err(Error::NothingToPack)));
    }

    #[test]
    fn unsafe_paths_are_skipped_without_breaking_the_stream() {
        // 손으로 악의적인 매니페스트를 만들어, 건너뛴 파일 뒤의 파일이 멀쩡히 복원되는지 본다.
        let manifest = Manifest {
            version: MANIFEST_VERSION,
            created_utc: 0,
            entries: vec![
                Entry {
                    rel_path: "../escape.txt".into(),
                    kind: Kind::File,
                    size: 5,
                    mtime: 0,
                },
                Entry {
                    rel_path: "safe.txt".into(),
                    kind: Kind::File,
                    size: 4,
                    mtime: 0,
                },
            ],
        };

        let mut payload = Vec::new();
        write_blob(&mut payload, &encode(&manifest).unwrap()).unwrap();
        payload.extend_from_slice(b"EVIL!");
        payload.extend_from_slice(b"GOOD");
        let trailer = Trailer {
            hashes: vec![[0u8; 32], Sha256::digest(b"GOOD").into()],
        };
        write_blob(&mut payload, &encode(&trailer).unwrap()).unwrap();

        let out = tempfile::tempdir().unwrap();
        let dest = out.path().join("restored");
        let report = read_payload(&mut payload.as_slice(), &dest, &mut |_| {}).unwrap();

        assert_eq!(report.skipped.len(), 1, "{:?}", report.skipped);
        assert!(report.skipped[0].contains("escape.txt"));
        // 건너뛴 항목의 바이트를 정확히 소비했으므로 다음 파일이 어긋나지 않는다.
        assert_eq!(fs::read(dest.join("safe.txt")).unwrap(), b"GOOD");
        assert!(report.hash_mismatch.is_empty());
        // 출력 폴더 밖에 아무것도 만들어지지 않았다.
        assert!(!out.path().join("escape.txt").exists());
    }

    #[test]
    fn hash_mismatch_is_reported() {
        let manifest = Manifest {
            version: MANIFEST_VERSION,
            created_utc: 0,
            entries: vec![Entry {
                rel_path: "x.txt".into(),
                kind: Kind::File,
                size: 3,
                mtime: 0,
            }],
        };
        let mut payload = Vec::new();
        write_blob(&mut payload, &encode(&manifest).unwrap()).unwrap();
        payload.extend_from_slice(b"abc");
        // 일부러 틀린 해시를 넣는다.
        write_blob(
            &mut payload,
            &encode(&Trailer {
                hashes: vec![[9u8; 32]],
            })
            .unwrap(),
        )
        .unwrap();

        let out = tempfile::tempdir().unwrap();
        let report = read_payload(&mut payload.as_slice(), out.path(), &mut |_| {}).unwrap();
        assert_eq!(report.hash_mismatch, vec!["x.txt".to_string()]);
    }

    #[test]
    fn truncated_payload_is_rejected() {
        let src = tempfile::tempdir().unwrap();
        let f = src.path().join("f.bin");
        write_file(&f, &vec![7u8; 4096]);

        let scan = scan(&[f]).unwrap();
        let mut payload = Vec::new();
        write_payload(&scan, &mut payload, &mut |_| {}).unwrap();
        payload.truncate(payload.len() / 2);

        let out = tempfile::tempdir().unwrap();
        let err = read_payload(&mut payload.as_slice(), out.path(), &mut |_| {}).unwrap_err();
        assert!(matches!(err, Error::Corrupted), "예상과 다름: {err:?}");
    }

    #[test]
    fn progress_reports_every_content_byte() {
        let src = tempfile::tempdir().unwrap();
        let root = src.path().join("t");
        write_file(&root.join("a"), &vec![1u8; 1000]);
        write_file(&root.join("b"), &vec![2u8; 2000]);

        let scan = scan(&[root]).unwrap();
        let mut seen = 0u64;
        let mut payload = Vec::new();
        write_payload(&scan, &mut payload, &mut |t| {
            if let Tick::Advance { bytes, .. } = t {
                seen += bytes;
            }
        })
        .unwrap();
        assert_eq!(seen, 3000);
        assert_eq!(scan.total_bytes, 3000);
    }
}
