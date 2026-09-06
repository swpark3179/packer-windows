//! 스트림 모드 프레임 형식의 **계약 테스트**.
//!
//! `piece_format.rs` 와 같은 정신이다. 인코더는 Rust(`qrstream.rs`), 디코더는
//! 자바스크립트(`mobile/www/stream.js`)에 있고, 둘은 **같은 난수열**을 내야 한다. 한 비트라도
//! 어긋나면 프레임은 멀쩡히 읽히는데 XOR 이 안 맞아 마지막에 GCM 인증 실패로만 나타난다 —
//! 그때는 어디가 잘못됐는지 알 방법이 없다.
//!
//! 그래서 골든 픽스처를 저장소에 커밋해 두고 양쪽에서 붙잡는다.
//!
//! - 여기(Rust): 인코더가 만든 프레임이 픽스처와 **바이트 단위로 같은지** 본다.
//!   `qrstream.rs` 를 고쳐 형식이나 난수열이 바뀌면 여기가 먼저 깨진다.
//! - 저쪽(`mobile/tests/stream.test.js`): 같은 픽스처를 **디코딩해** 원본이 나오는지 본다.
//!   `stream.js` 를 고치면 저기가 깨진다.
//!
//! 형식을 일부러 바꿨다면 픽스처를 다시 만든다:
//!
//! ```bash
//! cargo test --test stream_format -- --ignored write_the_golden_fixture
//! ```
//!
//! 그리고 **모바일 테스트를 반드시 함께 돌린다.** 픽스처만 갈아 끼우면 두 구현이 어긋난
//! 채로 양쪽 테스트가 통과한다.

use std::fs;
use std::path::PathBuf;

use packer_lib::qrstream::{crc16, Encoder, HEADER_LEN, MAGIC};

const ALSO_FIX: &str =
    "스트림 프레임 형식이 바뀌었다. mobile/www/stream.js 와 골든 픽스처도 함께 고쳐야 한다.";

/// 픽스처가 담는 스트림. 값을 바꾸면 픽스처를 다시 만들어야 한다.
const SOURCE_LEN: usize = 1_000;
const BLOCK_SIZE: usize = 64;
const FRAME_COUNT: u32 = 48;

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("mobile/tests/fixtures/stream-frames.json")
}

/// 결정적인 소스 바이트. 잘 안 눌리는 데이터처럼 골고루 섞는다.
fn source() -> Vec<u8> {
    (0..SOURCE_LEN)
        .map(|i| ((i * 251 + i / 97) % 256) as u8)
        .collect()
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

/// 픽스처를 JSON 으로 적는다. 의존성을 늘리지 않으려고 직렬화는 손으로 한다 — 모양이 단순하고,
/// 이 파일이 계약 자체라서 눈으로 읽히는 편이 낫다.
fn render(encoder: &Encoder) -> String {
    let info = encoder.info();
    let frames: Vec<String> = (0..FRAME_COUNT)
        .map(|seq| format!("    \"{}\"", hex(&encoder.frame(seq))))
        .collect();

    format!(
        concat!(
            "{{\n",
            "  \"_\": \"골든 픽스처 — src-tauri/tests/stream_format.rs 가 만든다. 손으로 고치지 말 것.\",\n",
            "  \"source\": \"{}\",\n",
            "  \"totalBytes\": {},\n",
            "  \"blockSize\": {},\n",
            "  \"blocks\": {},\n",
            "  \"fingerprint\": \"{}\",\n",
            "  \"frames\": [\n{}\n  ]\n",
            "}}\n"
        ),
        hex(&source()),
        info.total_bytes,
        info.block_size,
        info.blocks,
        info.fingerprint,
        frames.join(",\n"),
    )
}

/// 아주 작은 JSON 읽기. 픽스처의 모양이 고정이라 정식 파서를 끌어올 이유가 없다.
fn field<'a>(json: &'a str, key: &str) -> &'a str {
    let at = json
        .find(&format!("\"{key}\""))
        .unwrap_or_else(|| panic!("픽스처에 {key} 가 없다"));
    let rest = &json[at + key.len() + 2..];
    let colon = rest.find(':').unwrap() + 1;
    let rest = rest[colon..].trim_start();
    if let Some(stripped) = rest.strip_prefix('"') {
        &stripped[..stripped.find('"').unwrap()]
    } else {
        let end = rest.find([',', '\n']).unwrap();
        rest[..end].trim()
    }
}

fn frames_of(json: &str) -> Vec<Vec<u8>> {
    let at = json.find("\"frames\"").expect("frames");
    let body = &json[at..];
    let open = body.find('[').unwrap();
    let close = body.find(']').unwrap();
    body[open + 1..close]
        .split(',')
        .map(|entry| unhex(entry.trim().trim_matches('"')))
        .collect()
}

#[test]
#[ignore = "픽스처를 일부러 다시 만들 때만 돈다"]
fn write_the_golden_fixture() {
    let encoder = Encoder::new(&source(), BLOCK_SIZE).unwrap();
    fs::write(fixture_path(), render(&encoder)).unwrap();
    println!("픽스처를 다시 만들었다: {}", fixture_path().display());
    println!("모바일 테스트도 반드시 함께 돌릴 것 — 안 그러면 어긋난 채로 양쪽이 통과한다.");
}

#[test]
fn frames_match_the_golden_fixture_byte_for_byte() {
    let encoder = Encoder::new(&source(), BLOCK_SIZE).unwrap();
    let golden = fs::read_to_string(fixture_path()).expect("골든 픽스처를 찾을 수 없다");

    assert_eq!(field(&golden, "source"), hex(&source()), "{ALSO_FIX}");
    assert_eq!(
        field(&golden, "totalBytes"),
        SOURCE_LEN.to_string(),
        "{ALSO_FIX}"
    );
    assert_eq!(
        field(&golden, "blockSize"),
        BLOCK_SIZE.to_string(),
        "{ALSO_FIX}"
    );
    assert_eq!(
        field(&golden, "blocks"),
        encoder.blocks().to_string(),
        "{ALSO_FIX}"
    );
    assert_eq!(
        field(&golden, "fingerprint"),
        encoder.info().fingerprint,
        "{ALSO_FIX}"
    );

    let frames = frames_of(&golden);
    assert_eq!(frames.len(), FRAME_COUNT as usize, "{ALSO_FIX}");
    for (seq, want) in frames.iter().enumerate() {
        assert_eq!(
            &encoder.frame(seq as u32),
            want,
            "{ALSO_FIX} ({seq}번 프레임)"
        );
    }
}

/// 헤더의 자리를 글자 그대로 못박는다. 상수끼리 비교하면 아무것도 못 잡는다.
#[test]
fn the_header_layout_is_what_the_phone_reads() {
    assert_eq!(&MAGIC, b"PQS1", "{ALSO_FIX}");
    assert_eq!(HEADER_LEN, 24, "{ALSO_FIX}");

    let encoder = Encoder::new(&source(), BLOCK_SIZE).unwrap();
    let frame = encoder.frame(7);

    assert_eq!(&frame[0..4], b"PQS1", "{ALSO_FIX}");
    // 4..12 지문, 12..16 전체 길이(LE), 16..18 블록 크기(LE), 18..22 프레임 번호(LE), 22..24 CRC.
    assert_eq!(
        u32::from_le_bytes(frame[12..16].try_into().unwrap()),
        SOURCE_LEN as u32,
        "{ALSO_FIX}"
    );
    assert_eq!(
        u16::from_le_bytes(frame[16..18].try_into().unwrap()),
        BLOCK_SIZE as u16,
        "{ALSO_FIX}"
    );
    assert_eq!(
        u32::from_le_bytes(frame[18..22].try_into().unwrap()),
        7,
        "{ALSO_FIX}"
    );
    assert_eq!(
        u16::from_le_bytes(frame[22..24].try_into().unwrap()),
        crc16(&frame[HEADER_LEN..]),
        "{ALSO_FIX}"
    );

    // 블록 수는 싣지 않는다 — 양쪽이 ceil(total / block) 로 같은 값을 계산한다.
    assert_eq!(frame.len(), HEADER_LEN + BLOCK_SIZE, "{ALSO_FIX}");
}
