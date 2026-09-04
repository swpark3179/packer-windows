//! 모바일 스캐너와 맺은 조각 형식 계약.
//!
//! `mobile/` 앱은 QR 로 나간 조각을 다시 모아 하나의 텍스트로 합친다. 그 파서는 armor 형식을
//! 자바스크립트로 다시 구현한 것이라, 이쪽이 바뀌면 조용히 어긋난다 — 폰이 조각을 못 읽거나,
//! 더 나쁘게는 잘못 이어 붙여서 PC 에서 한참 뒤에 GCM 인증 실패로만 드러난다.
//!
//! 이 파일이 깨지면 형식이 바뀐 것이다. 그러면 반드시 함께 고쳐야 한다:
//!
//!   mobile/www/collector.js        파서와 상수
//!   mobile/tests/collector.test.js 픽스처와 골든
//!
//! 나머지 계층은 `roundtrip.rs` 가 본다. 여기서는 **모바일이 의존하는 표면만** 못박는다.

use packer_lib::{armor, qr};

const ALSO_FIX: &str = "mobile/www/collector.js 와 mobile/tests/collector.test.js 도 함께 고쳐야 한다";

/// 테스트용 armor 본문. Base64 글자만 쓰고 길이는 4의 배수로 둔다 (실제 본문이 늘 그렇다).
fn body(length: usize) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    (0..length)
        .map(|at| ALPHABET[(at * 7 + 3) % ALPHABET.len()] as char)
        .collect()
}

/// `mobile/www/collector.js` 의 `parsePiece()` 가 하는 일을 그대로 한다: 시작·끝 표시와
/// `#숫자/숫자` 순서 표시를 걷어내고 본문 글자만 남긴다.
///
/// **이 함수는 모바일 파서의 참조 구현이다.** 여기를 고쳐야 테스트가 통과한다면 저쪽도 고쳐야 한다.
fn mobile_body_of(piece: &str) -> String {
    let no_markers = piece
        .replace(armor::BEGIN_MARKER, "")
        .replace(armor::END_MARKER, "");

    let bytes = no_markers.as_bytes();
    let mut body = String::with_capacity(bytes.len());
    let mut at = 0;

    while at < bytes.len() {
        let byte = bytes[at];
        if byte == armor::PIECE_MARK as u8 {
            // 표시 길이만큼만 건너뛴다 — 줄 끝까지 버리지 않는다.
            let mut to = at + 1;
            while bytes.get(to).is_some_and(u8::is_ascii_digit) {
                to += 1;
            }
            assert_eq!(
                bytes.get(to),
                Some(&b'/'),
                "순서 표시가 `#숫자/숫자` 모양이 아니다. {ALSO_FIX}"
            );
            to += 1;
            while bytes.get(to).is_some_and(u8::is_ascii_digit) {
                to += 1;
            }
            at = to;
        } else if byte.is_ascii_whitespace() {
            at += 1;
        } else {
            body.push(byte as char);
            at += 1;
        }
    }
    body
}

#[test]
fn markers_are_exactly_what_the_mobile_parser_looks_for() {
    // 상수를 자기 자신과 비교하면 아무것도 못 잡는다. 글자 그대로 적어 둔다.
    assert_eq!(armor::BEGIN_MARKER, "-----BEGIN PACKER CONTAINER-----", "{ALSO_FIX}");
    assert_eq!(armor::END_MARKER, "-----END PACKER CONTAINER-----", "{ALSO_FIX}");
    assert_eq!(armor::PIECE_MARK, '#', "{ALSO_FIX}");
    assert_eq!(qr::MAX_PIECES, 16, "{ALSO_FIX}");

    // 본문 글자에 `#` 가 없다는 것이 모바일 파서가 순서 표시를 집어내는 근거다. `/` 는 Base64
    // 글자라서 `/` 만으로는 안 된다.
    assert!(!armor::PIECE_MARK.is_ascii_alphanumeric());
    assert!(armor::PIECE_MARK != '+' && armor::PIECE_MARK != '/' && armor::PIECE_MARK != '=');
}

#[test]
fn three_piece_golden_is_byte_exact() {
    // per = div_ceil(40, 3) = 14 → next_multiple_of(4) = 16 → 16 / 16 / 8 로 잘린다.
    let body = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn";
    assert_eq!(body.len(), 40);

    // 이 세 줄은 mobile/tests/collector.test.js 의 GOLDEN_3 과 글자 그대로 같아야 한다.
    assert_eq!(
        armor::pieces(body, 3),
        vec![
            "-----BEGIN PACKER CONTAINER-----\n#1/3\nABCDEFGHIJKLMNOP\n".to_string(),
            "#2/3\nQRSTUVWXYZabcdef\n".to_string(),
            "#3/3\nghijklmn\n-----END PACKER CONTAINER-----\n".to_string(),
        ],
        "{ALSO_FIX}"
    );
}

#[test]
fn single_symbol_shape_has_no_piece_mark() {
    // `qr::render` 는 한 심볼에 들어가면 `pieces()` 를 거치지 않고 이걸 쓴다. 그래서 한 장짜리
    // QR 에는 `#1/1` 이 **없다** — 모바일 파서가 따로 다루는 유일한 예외다.
    let body = body(120);
    let whole = armor::wrap_single_line(&body);

    assert_eq!(whole, format!("-----BEGIN PACKER CONTAINER-----\n{body}\n-----END PACKER CONTAINER-----\n"));
    assert!(!whole.contains(armor::PIECE_MARK), "{ALSO_FIX}");

    // 반대로 `pieces(_, 1)` 은 한 장이어도 표시를 붙인다. 두 모양 다 들어올 수 있다.
    assert!(armor::pieces(&body, 1)[0].contains("#1/1\n"));
}

#[test]
fn piece_marks_are_plain_ascii_decimals_in_order() {
    let body = body(4000);

    for parts in 2..=qr::MAX_PIECES {
        let cut = armor::pieces(&body, parts);
        let total = cut.len();

        for (at, piece) in cut.iter().enumerate() {
            // 자리 채움도 공백도 없다. `#3/16` 이고 `#03/16` 이나 `# 3/16` 이 아니다.
            let mark = format!("#{}/{total}\n", at + 1);
            assert!(piece.contains(&mark), "{parts}조각 중 {}번: {ALSO_FIX}", at + 1);
            assert_eq!(piece.matches(armor::PIECE_MARK).count(), 1, "{ALSO_FIX}");

            // 시작 표시는 1번 장에만, 끝 표시는 마지막 장에만.
            assert_eq!(piece.contains(armor::BEGIN_MARKER), at == 0, "{ALSO_FIX}");
            assert_eq!(piece.contains(armor::END_MARKER), at + 1 == total, "{ALSO_FIX}");
        }
    }
}

#[test]
fn non_final_pieces_are_uniform_and_group_aligned() {
    // 모바일 앱은 이 불변식으로 "장수가 우연히 같은 다른 컨테이너" 를 잡아낸다
    // (collector.js 의 chunkLength / conflict "chunk"). 여기가 흔들리면 그 검사가
    // 엉뚱한 충돌을 내기 시작한다.
    let body = body(4000);

    for parts in 2..=qr::MAX_PIECES {
        let bodies: Vec<String> = armor::pieces(&body, parts)
            .iter()
            .map(|piece| mobile_body_of(piece))
            .collect();
        if bodies.len() < 2 {
            continue;
        }

        let per = bodies[0].len();
        assert_eq!(per % 4, 0, "조각 본문이 4자 묶음 경계에서 잘리지 않는다. {ALSO_FIX}");
        for slice in &bodies[..bodies.len() - 1] {
            assert_eq!(slice.len(), per, "마지막이 아닌 조각 길이가 제각각이다. {ALSO_FIX}");
        }

        let last = bodies.last().unwrap().len();
        assert!(last > 0 && last <= per, "마지막 조각 길이가 범위를 벗어났다. {ALSO_FIX}");
    }
}

#[test]
fn every_split_rejoins_through_the_markerless_wrapper() {
    // 이 파일에서 가장 값어치가 큰 단정이다. 모바일 앱이 하는 일을 그대로 흉내 내서 —
    // 표시를 떼고, 순서대로 이어 붙이고, 표시 없이 다시 감싼다 — 그 결과가 리더를 통과하고
    // 원래 본문과 같은지 본다. 앱의 합치기 전략 전체가 `cargo test` 마다 검증된다.
    let body = body(4000);

    for parts in 1..=qr::MAX_PIECES {
        let cut = armor::pieces(&body, parts);
        let joined: String = cut.iter().map(|piece| mobile_body_of(piece)).collect();
        let rewrapped = armor::wrap_single_line(&joined);

        // 표시를 남기지 않으므로 순서 검사는 아예 건너뛴다 (`seen.is_empty()`).
        assert!(!rewrapped.contains(armor::PIECE_MARK), "{ALSO_FIX}");
        assert!(
            armor::verify_pieces(&rewrapped).is_ok(),
            "{parts}조각을 합친 텍스트가 순서 검사에서 막혔다. {ALSO_FIX}"
        );
        assert_eq!(
            armor::body_of(&rewrapped).expect("합친 텍스트를 리더가 읽지 못했다"),
            body,
            "{parts}조각을 합쳤더니 본문이 달라졌다. {ALSO_FIX}"
        );
    }
}
