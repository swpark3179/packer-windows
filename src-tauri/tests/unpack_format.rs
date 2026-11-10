//! 모바일 앱의 **'풀어서 저장'** 이 읽는 컨테이너 형식의 계약 테스트.
//!
//! `stream_format.rs` 와 같은 정신이다. 묶는 쪽은 Rust(`container.rs` · `archive.rs` ·
//! `crypto.rs`), 푸는 쪽은 자바스크립트(`mobile/www/unpack.js` · `argon2.js`)에 있고, 둘은
//! **비트 단위로 같아야 한다.** Argon2 가 한 비트만 달라도 맞는 암호가 "키가 틀렸다" 로 나오고,
//! bincode 를 한 칸만 잘못 읽어도 멀쩡한 컨테이너가 "손상되었다" 로 나온다 — 어느 쪽이든 폰
//! 화면에서는 원인을 알 길이 없다.
//!
//! 그래서 골든 픽스처(`mobile/tests/fixtures/unpack-container.json`)를 커밋해 두고 양쪽에서
//! 붙잡는다.
//!
//! - 여기(Rust): 픽스처의 컨테이너가 **데스크톱의 풀기로 그대로 풀리는지**, 같은 원본에서 다시
//!   만든 평문 스트림(직렬화 결과)이 픽스처와 같은지, KDF 벡터가 `derive_keys` 와 맞는지 본다.
//!   `archive.rs` 의 직렬화나 `crypto.rs` 의 파라미터를 바꾸면 여기가 먼저 깨진다.
//! - 저쪽(`mobile/tests/unpack.test.js`, `argon2.test.js`): 같은 픽스처를 **풀어서** 같은 파일이
//!   나오는지, 같은 KDF 값이 나오는지 본다.
//!
//! 형식을 일부러 바꿨다면 픽스처를 다시 만든다:
//!
//! ```bash
//! cargo test --test unpack_format -- --ignored write_the_golden_fixture
//! ```
//!
//! 그리고 **모바일 테스트를 반드시 함께 돌린다.** 픽스처만 갈아 끼우면 두 구현이 어긋난
//! 채로 양쪽 테스트가 통과한다.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use packer_lib::archive::{self, Entry, Kind, Manifest, Scan, Source, Trailer, MANIFEST_VERSION};
use packer_lib::armor::{self, ArmorWriter};
use packer_lib::commands::{unpack_to_dir, ContainerSource};
use packer_lib::container::{
    ContainerWriter, Header, FORMAT_VERSION, HEADER_LEN, MAGIC, MIN_CHUNK_SIZE,
};
use packer_lib::crypto::{
    derive_keys, KdfParams, DEFAULT_M_COST, DEFAULT_P_COST, DEFAULT_T_COST, KCV_LEN, KEY_LEN,
    SALT_LEN,
};

const ALSO_FIX: &str = "컨테이너 형식이 바뀌었다. mobile/www/unpack.js · argon2.js 와 골든 \
                        픽스처도 함께 고쳐야 한다.";

/// 픽스처 컨테이너를 여는 암호. 한글과 공백을 일부러 섞는다 — 폰은 이걸 UTF-8 로 옮겨 Argon2 에
/// 넣어야 하고, 정규화(NFC/NFD)를 건드리면 안 된다.
const PASSWORD: &str = "열려라 참깨 2026!";

/// `commands.rs` 의 `ZSTD_LEVEL` 과 같다 (그쪽은 공개하지 않는 상수다).
const ZSTD_LEVEL: i32 = 6;

/// 매니페스트의 시각. 디스크의 mtime 을 쓰면 픽스처가 만들 때마다 달라진다.
const STAMP: i64 = 1_767_225_600; // 2026-01-01T00:00:00Z

const NONCE_PREFIX: [u8; 4] = [0x10, 0x20, 0x30, 0x40];

/// 픽스처 컨테이너의 KDF. 기본값(64 MiB)으로 두면 모바일 테스트가 컨테이너를 열 때마다 1초씩
/// 걸린다 — 기본값은 아래 `vectors` 가 따로 붙잡는다. 대신 **레인 2개 · 패스 2회** 로 두어,
/// 다른 레인을 참조하는 경로와 데이터에 따른 주소(Argon2d 절반)를 둘 다 밟게 한다.
const CONTAINER_KDF: (u32, u32, u32) = (64, 2, 2);

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("mobile/tests/fixtures/unpack-container.json")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).unwrap())
        .collect()
}

fn salt(seed: u8) -> [u8; SALT_LEN] {
    let mut out = [0u8; SALT_LEN];
    for (i, b) in out.iter_mut().enumerate() {
        *b = seed
            .wrapping_mul(31)
            .wrapping_add((i as u8).wrapping_mul(7));
    }
    out
}

/// 결정적인 의사난수 (xorshift32). 잘 안 눌리는 데이터를 만든다.
fn noise(len: usize, mut state: u32) -> Vec<u8> {
    (0..len)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            (state >> 24) as u8
        })
        .collect()
}

/// 적당히 눌리는 텍스트. zstd 가 허프만 리터럴과 FSE 시퀀스를 둘 다 쓰게 된다 — 반복 데이터만
/// 넣으면 디코더의 쉬운 길(RLE·긴 일치)만 밟는다.
fn words(target: usize) -> Vec<u8> {
    const VOCAB: &str = "packer 묶기 풀기 암호 container zstd argon2 블록 청크 frame \
                         QR 조각 스트림 파일 폴더 보고서 2026년 계획 data value \
                         the quick brown fox jumps over lazy dog 가나다 라마바 \
                         사아자 차카타 파하 alpha beta gamma delta epsilon 제타 에타";
    let vocab: Vec<&str> = VOCAB.split_whitespace().collect();
    assert_eq!(vocab.len(), 40);
    let mut out = String::new();
    let mut state = 0x9e37_79b9u32;
    let mut count = 0;
    while out.len() < target {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        out.push_str(vocab[(state as usize) % vocab.len()]);
        count += 1;
        out.push(if count % 12 == 0 { '\n' } else { ' ' });
    }
    out.into_bytes()
}

/// 픽스처 컨테이너에 담는 트리. **순서가 곧 매니페스트의 순서다** — `archive::scan` 은 디스크의
/// 디렉터리 순서를 따라서 기계마다 다르게 나오므로, 여기서는 직접 세운다.
fn tree() -> Vec<(&'static str, Option<Vec<u8>>)> {
    let repeat: Vec<u8> = b"0123456".iter().copied().cycle().take(300_000).collect();
    vec![
        ("프로젝트", None),
        (
            "프로젝트/readme.md",
            Some("# Packer\n한글 본문\n".as_bytes().to_vec()),
        ),
        ("프로젝트/src", None),
        (
            "프로젝트/src/main.rs",
            Some(
                "fn main() {\n    println!(\"풀렸다\");\n}\n"
                    .as_bytes()
                    .to_vec(),
            ),
        ),
        ("프로젝트/빈 파일.txt", Some(Vec::new())),
        ("프로젝트/빈폴더", None),
        ("프로젝트/data", None),
        // 컨테이너 청크(4 KiB) 여러 개에 걸치고, zstd 는 압축하지 못해 원시 블록으로 둔다.
        ("프로젝트/data/noise.bin", Some(noise(9_000, 0x1234_5678))),
        ("프로젝트/data/words.txt", Some(words(48_000))),
        // zstd 블록 상한(128 KiB)을 몇 번 넘는다.
        ("프로젝트/data/repeat.bin", Some(repeat)),
        (
            "메모.txt",
            Some("두 번째 원본 — 낱개 파일\n".as_bytes().to_vec()),
        ),
    ]
}

/// [`tree`] 를 `archive::write_payload` 가 먹는 모양으로 세운다. 실제 묶기와 같은 직렬화기를
/// 그대로 쓰는 것이 요점이다.
fn scan() -> Scan {
    let mut entries = Vec::new();
    let mut sources = Vec::new();
    let mut total_bytes = 0u64;
    let mut dir_count = 0;
    for (path, body) in tree() {
        match body {
            None => {
                dir_count += 1;
                entries.push(Entry {
                    rel_path: path.to_string(),
                    kind: Kind::Dir,
                    size: 0,
                    mtime: STAMP,
                });
            }
            Some(bytes) => {
                total_bytes += bytes.len() as u64;
                entries.push(Entry {
                    rel_path: path.to_string(),
                    kind: Kind::File,
                    size: bytes.len() as u64,
                    mtime: STAMP,
                });
                sources.push(Source::Memory(bytes));
            }
        }
    }
    let file_count = sources.len();
    Scan {
        manifest: Manifest {
            version: MANIFEST_VERSION,
            created_utc: STAMP,
            entries,
        },
        sources,
        total_bytes,
        file_count,
        dir_count,
        skipped: Vec::new(),
    }
}

fn payload() -> Vec<u8> {
    let mut out = Vec::new();
    archive::write_payload(&scan(), &mut out, &mut |_| {}).unwrap();
    out
}

fn blob(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(bytes);
}

fn bincode_of<T: serde::Serialize>(value: &T) -> Vec<u8> {
    bincode::serde::encode_to_vec(value, bincode::config::standard()).unwrap()
}

/// 남이 만든 컨테이너. 폴더 밖으로 나가려는 경로·윈도우 장치 이름·ADS 콜론과, 트레일러의
/// 해시가 틀린 파일을 섞는다. `archive.rs` 의 `unsafe_paths_are_skipped_without_breaking_the_stream`
/// 과 같은 모양이고, 폰이 **같은 문구로** 건너뛰었다고 말하는지를 본다.
fn hostile_payload() -> Vec<u8> {
    let file = |path: &str, size: u64| Entry {
        rel_path: path.to_string(),
        kind: Kind::File,
        size,
        mtime: STAMP,
    };
    let dir = |path: &str| Entry {
        rel_path: path.to_string(),
        kind: Kind::Dir,
        size: 0,
        mtime: STAMP,
    };
    let manifest = Manifest {
        version: MANIFEST_VERSION,
        created_utc: STAMP,
        entries: vec![
            file("../escape.txt", 5),
            file("sub/CON.txt", 3),
            dir("a:b"),
            file("safe.txt", 4),
            file("bad-hash.txt", 3),
            dir("ok"),
        ],
    };
    let mut out = Vec::new();
    blob(&mut out, &bincode_of(&manifest));
    out.extend_from_slice(b"EVIL!");
    out.extend_from_slice(b"con");
    out.extend_from_slice(b"GOOD");
    out.extend_from_slice(b"abc");
    let trailer = Trailer {
        hashes: vec![
            Sha256::digest(b"EVIL!").into(),
            Sha256::digest(b"con").into(),
            Sha256::digest(b"GOOD").into(),
            // 일부러 틀린 해시.
            [9u8; 32],
        ],
    };
    blob(&mut out, &bincode_of(&trailer));
    out
}

/// 평문 스트림을 실제 묶기와 같은 순서로 감싼다: zstd → AES-256-GCM 청크 → Base64 armor.
///
/// 청크는 최소 크기(4 KiB)로 둔다. 기본값(1 MiB)이면 픽스처가 청크 하나로 끝나 폰이 청크
/// 번호(nonce)와 `last` 플래그를 넘기는 길을 밟지 않는다.
fn seal(payload: &[u8], seed: u8) -> String {
    let (m_cost, t_cost, p_cost) = CONTAINER_KDF;
    let kdf = KdfParams {
        salt: salt(seed),
        m_cost,
        t_cost,
        p_cost,
    };
    let keys = derive_keys(PASSWORD, &kdf).unwrap();
    let header = Header::new(kdf, NONCE_PREFIX, keys.kcv(), MIN_CHUNK_SIZE).unwrap();

    let text_sink = ArmorWriter::new(Vec::new()).unwrap();
    let sealed = ContainerWriter::new(text_sink, header, &keys).unwrap();
    let mut encoder = zstd::Encoder::new(sealed, ZSTD_LEVEL).unwrap();
    encoder.write_all(payload).unwrap();
    let sealed = encoder.finish().unwrap();
    let text_sink = sealed.finish().unwrap();
    let text = String::from_utf8(text_sink.finish().unwrap()).unwrap();
    // 폰이 실제로 손에 쥐는 모양 — 조각을 합친 결과는 언제나 한 줄짜리다.
    armor::compact(&text).unwrap()
}

/// Argon2 출력 전체(데이터 키 32 + KCV 16). `derive_keys` 는 KCV 만 내보내므로 크레이트를 같은
/// 설정으로 직접 부른다 — 아래 검사가 두 길이 같은 값을 내는지 함께 본다.
fn okm(password: &str, kdf: &KdfParams) -> Vec<u8> {
    let params =
        argon2::Params::new(kdf.m_cost, kdf.t_cost, kdf.p_cost, Some(KEY_LEN + KCV_LEN)).unwrap();
    let argon = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut out = vec![0u8; KEY_LEN + KCV_LEN];
    argon
        .hash_password_into(password.as_bytes(), &kdf.salt, &mut out)
        .unwrap();
    out
}

/// KDF 벡터. 마지막 줄이 **실제로 묶을 때 쓰는 기본값**이다 — 폰에서 몇 초 걸리는 바로 그 계산.
///
/// 1203 은 일부러 4·레인의 배수가 아니다. 메모리를 그 배수로 내려 쓰되 H0 에는 **요청한 값**을
/// 넣어야 하는데, 그 둘을 헷갈리면 이 줄만 어긋난다. 또 세그먼트가 128 블록을 넘어 Argon2i
/// 주소 블록을 다시 만드는 길도 이 줄이 밟는다.
fn vector_params() -> Vec<(&'static str, KdfParams)> {
    vec![
        (
            "pw",
            KdfParams {
                salt: [7u8; SALT_LEN],
                m_cost: 8,
                t_cost: 1,
                p_cost: 1,
            },
        ),
        (
            "열려라 참깨",
            KdfParams {
                salt: salt(3),
                m_cost: 1203,
                t_cost: 2,
                p_cost: 1,
            },
        ),
        (
            "",
            KdfParams {
                salt: salt(4),
                m_cost: 256,
                t_cost: 3,
                p_cost: 4,
            },
        ),
        (
            PASSWORD,
            KdfParams {
                salt: salt(5),
                m_cost: DEFAULT_M_COST,
                t_cost: DEFAULT_T_COST,
                p_cost: DEFAULT_P_COST,
            },
        ),
    ]
}

fn entries_json() -> Vec<Value> {
    tree()
        .into_iter()
        .map(|(path, body)| match body {
            None => json!({ "path": path, "kind": "dir" }),
            Some(bytes) => json!({
                "path": path,
                "kind": "file",
                "size": bytes.len(),
                "sha256": hex(&Sha256::digest(&bytes)),
            }),
        })
        .collect()
}

fn build_fixture() -> Value {
    let scan = scan();
    let payload = payload();
    let vectors: Vec<Value> = vector_params()
        .into_iter()
        .map(|(password, kdf)| {
            json!({
                "password": password,
                "salt": hex(&kdf.salt),
                "m": kdf.m_cost,
                "t": kdf.t_cost,
                "p": kdf.p_cost,
                "okm": hex(&okm(password, &kdf)),
            })
        })
        .collect();

    json!({
        "_": "골든 픽스처 — src-tauri/tests/unpack_format.rs 가 만든다. 손으로 고치지 말 것.",
        "contract": {
            "headerLen": HEADER_LEN,
            "formatVersion": FORMAT_VERSION,
            "manifestVersion": MANIFEST_VERSION,
            "keyLen": KEY_LEN,
            "kcvLen": KCV_LEN,
            "defaultKdf": { "m": DEFAULT_M_COST, "t": DEFAULT_T_COST, "p": DEFAULT_P_COST },
        },
        "password": PASSWORD,
        "armor": seal(&payload, 1),
        "payloadSha256": hex(&Sha256::digest(&payload)),
        "report": {
            "fileCount": scan.file_count,
            "dirCount": scan.dir_count,
            "totalBytes": scan.total_bytes,
        },
        "entries": entries_json(),
        "hostile": {
            "armor": seal(&hostile_payload(), 2),
            "skipped": [
                "../escape.txt (상대 경로 이동)",
                "sub/CON.txt (예약된 장치 이름)",
                "a:b (사용할 수 없는 문자)",
            ],
            "hashMismatch": ["bad-hash.txt"],
            "entries": [
                { "path": "safe.txt", "kind": "file", "size": 4, "sha256": hex(&Sha256::digest(b"GOOD")) },
                { "path": "bad-hash.txt", "kind": "file", "size": 3, "sha256": hex(&Sha256::digest(b"abc")) },
                { "path": "ok", "kind": "dir" },
            ],
        },
        "vectors": vectors,
    })
}

fn golden() -> Value {
    let text = fs::read_to_string(fixture_path()).expect("골든 픽스처를 찾을 수 없다");
    serde_json::from_str(&text).expect("픽스처가 JSON 이 아니다")
}

/// 풀어낸 트리를 `(상대 경로, 종류, 크기, sha256)` 목록으로 적는다.
fn listing(root: &Path) -> Vec<(String, String, u64, String)> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).unwrap().flatten() {
            let path = entry.path();
            let rel = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            if path.is_dir() {
                stack.push(path.clone());
                out.push((rel, "dir".to_string(), 0, String::new()));
            } else {
                let bytes = fs::read(&path).unwrap();
                out.push((
                    rel,
                    "file".to_string(),
                    bytes.len() as u64,
                    hex(&Sha256::digest(&bytes)),
                ));
            }
        }
    }
    out.sort();
    out
}

fn expected_listing(entries: &Value) -> Vec<(String, String, u64, String)> {
    let mut out: Vec<_> = entries
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            (
                e["path"].as_str().unwrap().to_string(),
                e["kind"].as_str().unwrap().to_string(),
                e["size"].as_u64().unwrap_or(0),
                e["sha256"].as_str().unwrap_or("").to_string(),
            )
        })
        .collect();
    out.sort();
    out
}

#[test]
#[ignore = "픽스처를 일부러 다시 만들 때만 돈다"]
fn write_the_golden_fixture() {
    let text = serde_json::to_string_pretty(&build_fixture()).unwrap() + "\n";
    fs::write(fixture_path(), text).unwrap();
    println!("픽스처를 다시 만들었다: {}", fixture_path().display());
    println!("모바일 테스트도 반드시 함께 돌릴 것 — 안 그러면 어긋난 채로 양쪽이 통과한다.");
}

/// 폰이 내놓는 결과가 데스크톱의 결과와 같아야 한다 — 그 기준이 되는 쪽이 여기다.
#[test]
fn the_fixture_unpacks_the_same_way_on_the_desktop() {
    let golden = golden();
    let work = tempfile::tempdir().unwrap();
    let dest = work.path().join("풀림");

    let source = ContainerSource::Text(golden["armor"].as_str().unwrap().to_string());
    let outcome = unpack_to_dir(&source, PASSWORD, &dest, &mut |_| {}).unwrap();

    assert_eq!(
        outcome.file_count as u64,
        golden["report"]["fileCount"].as_u64().unwrap(),
        "{ALSO_FIX}"
    );
    assert_eq!(
        outcome.dir_count as u64,
        golden["report"]["dirCount"].as_u64().unwrap(),
        "{ALSO_FIX}"
    );
    assert_eq!(
        outcome.total_bytes,
        golden["report"]["totalBytes"].as_u64().unwrap(),
        "{ALSO_FIX}"
    );
    assert!(outcome.skipped.is_empty(), "{:?}", outcome.skipped);
    assert!(
        outcome.hash_mismatch.is_empty(),
        "{:?}",
        outcome.hash_mismatch
    );
    assert_eq!(
        listing(&dest),
        expected_listing(&golden["entries"]),
        "{ALSO_FIX}"
    );
}

#[test]
fn the_hostile_fixture_is_reported_in_the_same_words() {
    let golden = golden();
    let hostile = &golden["hostile"];
    let work = tempfile::tempdir().unwrap();
    let dest = work.path().join("풀림");

    let source = ContainerSource::Text(hostile["armor"].as_str().unwrap().to_string());
    let outcome = unpack_to_dir(&source, PASSWORD, &dest, &mut |_| {}).unwrap();

    let strings = |value: &Value| -> Vec<String> {
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect()
    };
    // 폰은 이 문구를 그대로 화면에 옮긴다. 데스크톱과 같은 말을 해야 한다.
    assert_eq!(outcome.skipped, strings(&hostile["skipped"]), "{ALSO_FIX}");
    assert_eq!(
        outcome.hash_mismatch,
        strings(&hostile["hashMismatch"]),
        "{ALSO_FIX}"
    );
    assert_eq!(
        listing(&dest),
        expected_listing(&hostile["entries"]),
        "{ALSO_FIX}"
    );
    assert!(!work.path().join("escape.txt").exists());
}

/// 평문 스트림(매니페스트 · 파일 · 트레일러)의 모양을 바이트 단위로 못박는다.
///
/// 컨테이너 자체를 비교하지 않는 이유는 zstd 출력이 라이브러리 버전에 따라 달라질 수 있어서다 —
/// 그건 형식이 바뀐 게 아니다. 폰이 직접 읽는 것은 압축을 푼 **이 스트림**이다.
#[test]
fn the_payload_layout_is_what_the_phone_reads() {
    let golden = golden();
    assert_eq!(
        hex(&Sha256::digest(payload())),
        golden["payloadSha256"].as_str().unwrap(),
        "{ALSO_FIX}"
    );
}

#[test]
fn the_kdf_vectors_hold() {
    let golden = golden();
    let vectors = golden["vectors"].as_array().unwrap();
    let params = vector_params();
    assert_eq!(vectors.len(), params.len(), "{ALSO_FIX}");

    for ((password, kdf), vector) in params.iter().zip(vectors) {
        assert_eq!(
            vector["password"].as_str().unwrap(),
            *password,
            "{ALSO_FIX}"
        );
        assert_eq!(
            vector["salt"].as_str().unwrap(),
            hex(&kdf.salt),
            "{ALSO_FIX}"
        );
        assert_eq!(
            vector["m"].as_u64().unwrap(),
            kdf.m_cost as u64,
            "{ALSO_FIX}"
        );
        assert_eq!(
            vector["t"].as_u64().unwrap(),
            kdf.t_cost as u64,
            "{ALSO_FIX}"
        );
        assert_eq!(
            vector["p"].as_u64().unwrap(),
            kdf.p_cost as u64,
            "{ALSO_FIX}"
        );

        let want = unhex(vector["okm"].as_str().unwrap());
        // 실제로 묶을 때 쓰는 함수가 내는 KCV 가 벡터의 뒤 16바이트와 같아야 한다.
        let keys = derive_keys(password, kdf).unwrap();
        assert_eq!(keys.kcv().as_slice(), &want[KEY_LEN..], "{ALSO_FIX}");
        assert_eq!(okm(password, kdf), want, "{ALSO_FIX}");
    }
}

/// 헤더의 자리를 글자 그대로 못박는다. 상수끼리 비교하면 아무것도 못 잡는다.
#[test]
fn the_header_layout_is_what_the_phone_reads() {
    let golden = golden();
    let contract = &golden["contract"];
    assert_eq!(
        contract["headerLen"].as_u64().unwrap(),
        HEADER_LEN as u64,
        "{ALSO_FIX}"
    );
    assert_eq!(
        contract["formatVersion"].as_u64().unwrap(),
        FORMAT_VERSION as u64,
        "{ALSO_FIX}"
    );
    assert_eq!(
        contract["manifestVersion"].as_u64().unwrap(),
        MANIFEST_VERSION as u64,
        "{ALSO_FIX}"
    );
    assert_eq!(
        contract["keyLen"].as_u64().unwrap(),
        KEY_LEN as u64,
        "{ALSO_FIX}"
    );
    assert_eq!(
        contract["kcvLen"].as_u64().unwrap(),
        KCV_LEN as u64,
        "{ALSO_FIX}"
    );
    assert_eq!(
        contract["defaultKdf"]["m"].as_u64().unwrap(),
        DEFAULT_M_COST as u64,
        "{ALSO_FIX}"
    );
    assert_eq!(
        contract["defaultKdf"]["t"].as_u64().unwrap(),
        DEFAULT_T_COST as u64,
        "{ALSO_FIX}"
    );
    assert_eq!(
        contract["defaultKdf"]["p"].as_u64().unwrap(),
        DEFAULT_P_COST as u64,
        "{ALSO_FIX}"
    );

    let text = golden["armor"].as_str().unwrap();
    let bytes = BASE64.decode(armor::body_of(text).unwrap()).unwrap();
    assert_eq!(&bytes[0..8], MAGIC, "{ALSO_FIX}");
    assert_eq!(
        u16::from_le_bytes([bytes[8], bytes[9]]),
        FORMAT_VERSION,
        "{ALSO_FIX}"
    );
    // 10 KDF · 11 암호 · 12 압축 — 모두 1번 알고리즘.
    assert_eq!(&bytes[10..13], &[1, 1, 1], "{ALSO_FIX}");
    let (m_cost, t_cost, p_cost) = CONTAINER_KDF;
    assert_eq!(&bytes[16..48], &salt(1), "{ALSO_FIX}");
    assert_eq!(
        u32::from_le_bytes(bytes[48..52].try_into().unwrap()),
        m_cost,
        "{ALSO_FIX}"
    );
    assert_eq!(
        u32::from_le_bytes(bytes[52..56].try_into().unwrap()),
        t_cost,
        "{ALSO_FIX}"
    );
    assert_eq!(
        u32::from_le_bytes(bytes[56..60].try_into().unwrap()),
        p_cost,
        "{ALSO_FIX}"
    );
    assert_eq!(
        u32::from_le_bytes(bytes[60..64].try_into().unwrap()),
        MIN_CHUNK_SIZE,
        "{ALSO_FIX}"
    );
    assert_eq!(&bytes[64..68], &NONCE_PREFIX, "{ALSO_FIX}");
    // 첫 청크 프레임: [u32 평문 길이][u8 last] — 청크가 여럿이므로 첫 프레임은 꽉 차 있다.
    assert_eq!(
        u32::from_le_bytes(bytes[HEADER_LEN..HEADER_LEN + 4].try_into().unwrap()),
        MIN_CHUNK_SIZE,
        "{ALSO_FIX}"
    );
    assert_eq!(bytes[HEADER_LEN + 4], 0, "{ALSO_FIX}");
}
