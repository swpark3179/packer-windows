//! 묶은 결과를 스마트폰 카메라로 옮기는 QR 코드.
//!
//! 결과물이 텍스트라서 그대로 그림으로 옮길 수 있다. 폰의 기본 카메라 앱으로 비추면 텍스트가
//! 그대로 나오고, 복사해서 다른 기기의 Packer 에 붙여넣으면 파일이 돌아온다. 케이블도 네트워크도
//! 계정도 필요 없다.
//!
//! 심볼 하나에는 바이트 모드로 최대 2953바이트(버전 40, ECC L)까지만 들어간다. 규격에는 여러
//! 심볼을 이어 붙이는 Structured Append 가 있지만 폰의 **기본** 카메라 앱은 그걸 모른다 — 한 장씩
//! 읽을 뿐이다. 그래서 이어 붙이는 일을 규격에 맡길 수 없다. 대신 사람에게 맡긴다: 조각마다
//! `#2/5` 같은 번호를 텍스트 안에 적어 두고 순서대로 찍어 붙여넣게 한다. 리더가 그 번호를
//! 무시하도록 [`crate::armor`] 를 좁게 넓혀 두었다.
//!
//! 담는 양보다 **모듈 크기**가 중요하다. 화면에 띄운 그림을 폰으로 찍는 것이 전제이기 때문이다.
//! 그래서 세 가지를 지킨다:
//!
//! - 담을 수 있는 가장 튼튼한 ECC 등급을 고른다 (H → Q → M → L 순으로 시도).
//! - 조각들을 **모두 같은 버전·등급**으로 인코딩한다. 그러지 않으면 시작·끝 표시가 붙은 첫
//!   조각과 마지막 조각만 한 단계 커져서, 화면에 크기가 다른 사각형이 섞여 나온다.
//! - PNG 을 **1모듈 = 1픽셀**로 그린다. 확대는 화면 쪽에서 정수 배율로만 한다. 배율에 소수점이
//!   붙으면 모듈 폭이 1px/2px 로 들쭉날쭉해져 초점이 맞아도 인식되지 않는다.
//!
//! 조각 텍스트에는 ASCII 만 넣는다. 바이트 모드 QR 에는 믿을 수 있는 문자셋 선언이 없어서 —
//! 디코더마다 ISO-8859-1 이나 UTF-8 로 제각기 짐작한다 — 한글을 넣으면 기기에 따라 깨진다.
//! 우리 payload 는 전부 ASCII 라 어느 해석으로 읽어도 바이트가 같다. 한국어 안내는 UI 에만 둔다.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use qrcode::{Color, EcLevel, QrCode};
use serde::Serialize;

use crate::armor;
use crate::error::{Error, Result};

// ---------------------------------------------------------------- 한도

/// 한 심볼(버전 40, ECC L)이 바이트 모드로 담는 최대 바이트 수.
///
/// 조각 수의 **하한**을 값싸게 잡는 데만 쓴다. 실제 판정은 인코딩을 해 보고 한다 — 표시 줄이
/// 전부 대문자와 하이픈이라 인코더가 그 부분을 영숫자 모드로 접어 20바이트쯤 더 담기 때문에,
/// 이 표를 그대로 믿으면 담을 수 있는 것을 못 담는다.
pub const MAX_SYMBOL_BYTES: usize = 2953;

/// 조각 수 상한. QR 규격의 Structured Append 상한과 같은 16으로 둔다.
///
/// 이보다 많으면 순서대로 찍어 이어 붙이는 일 자체가 현실적이지 않다. 기술적 한계가 아니라
/// 사람의 한계라서, 안내 문구도 그렇게 말한다.
pub const MAX_PIECES: usize = 16;

/// 한 심볼의 모듈 수 상한. 버전 40 이 177 이므로 기본값은 사실상 제한 없음이다.
///
/// **이 값이 이 기능의 실제 성공률을 쥐고 있다.** 화면에 555px 로 띄우면 버전 40(177모듈)은
/// 모듈 하나가 3.1px, 96 DPI 기준 0.79mm 다. 실기기에서 버전 40 이 잘 안 읽히면 이 값만 125 로
/// 내리면 된다 — 조각이 1.5~2배로 늘어나는 대신 모든 심볼이 굵어진다.
const MAX_MODULES: usize = 177;

/// 규격이 요구하는 조용한 여백(modules). 이게 없으면 어떤 디코더도 심볼을 찾지 못한다.
///
/// CSS 패딩으로 대신할 수 없다. 패딩은 픽셀 고정인데 모듈 크기는 화면 배율에 따라 변하고,
/// 화면을 캡처해 잘라내면 아예 사라진다. 그림 안에 구워 둬야 어디로 옮겨도 살아남는다.
const QUIET_MODULES: usize = 4;

/// 오류 정정 등급을 튼튼한 것부터. 담을 수 있는 가장 앞의 등급을 쓴다.
const LEVELS: [EcLevel; 4] = [EcLevel::H, EcLevel::Q, EcLevel::M, EcLevel::L];

// ---------------------------------------------------------------- 결과

/// 화면에 띄울 QR 조각 하나.
#[derive(Debug, Serialize)]
pub struct QrImage {
    /// 1부터 시작하는 조각 번호.
    pub index: usize,
    /// 전체 조각 수. 1이면 나누지 않았다는 뜻이다.
    pub total: usize,
    /// `data:image/png;base64,` 뒤에 그대로 붙일 Base64 PNG.
    pub png_base64: String,
    /// 여백까지 포함한 한 변의 모듈 수. 1모듈 = 1픽셀이므로 PNG 한 변의 픽셀 수와 같다.
    /// 조각들은 모두 같은 값이다.
    pub png_modules: usize,
    /// 오류 정정 등급: `"L"` | `"M"` | `"Q"` | `"H"`.
    pub ec_level: String,
    /// 이 조각에 담은 텍스트 바이트 수.
    pub text_bytes: usize,
}

// ---------------------------------------------------------------- 만들기

/// armor 텍스트를 QR 조각들로 만든다.
///
/// 조각 수가 [`MAX_PIECES`] 를 넘거나 어떤 나눔으로도 [`MAX_MODULES`] 안에 못 들어가면
/// `Ok(None)` 이다. 실패가 아니라 "QR 로 옮길 만한 크기가 아니다" 라는 뜻이다.
pub fn render(armored: &str) -> Result<Option<Vec<QrImage>>> {
    let body = armor::body_of(armored)?;

    // 한 심볼에 들어가면 그것으로 끝이다. 용량 표를 믿지 않고 실제로 인코딩해 본다.
    let whole = armor::wrap_single_line(&body);
    if let Some(codes) = encode_uniform(std::slice::from_ref(&whole)) {
        return images(&codes, std::slice::from_ref(&whole)).map(Some);
    }

    // 값싼 하한에서 시작해 조각 수를 하나씩 올린다. 실패하는 시도는 Reed-Solomon 을 돌기 전에
    // DataTooLong 으로 빠지므로 사실상 공짜다.
    let low = body.len().div_ceil(MAX_SYMBOL_BYTES).max(2);
    for parts in low..=MAX_PIECES {
        let cut = armor::pieces(&body, parts);
        // 4자 정렬 때문에 요청보다 적게 나올 수 있다. 그 개수는 이미 지나온 값이다.
        if cut.len() != parts {
            continue;
        }
        if let Some(codes) = encode_uniform(&cut) {
            return images(&codes, &cut).map(Some);
        }
    }
    Ok(None)
}

/// 조각들을 모두 같은 버전·등급으로 인코딩한다. 하나라도 안 들어가면 `None`.
///
/// 가장 긴 조각으로 규격을 정한다. 등급을 H 부터 훑는 것은 두 가지를 동시에 한다: 담을 수 있는
/// 가장 튼튼한 등급을 고르고, 모듈 수가 상한을 넘으면 더 낮은 등급(= 더 작은 버전)으로 내려간다.
fn encode_uniform(pieces: &[String]) -> Option<Vec<QrCode>> {
    let longest = pieces.iter().max_by_key(|piece| piece.len())?;
    for level in LEVELS {
        // DataTooLong 이면 다음 등급으로. 이 판정이 용량 표를 대신한다.
        let Ok(probe) = QrCode::with_error_correction_level(longest.as_bytes(), level) else {
            continue;
        };
        if probe.width() > MAX_MODULES {
            continue;
        }
        let version = probe.version();
        let coded: Option<Vec<QrCode>> = pieces
            .iter()
            .map(|piece| QrCode::with_version(piece.as_bytes(), version, level).ok())
            .collect();
        if coded.is_some() {
            return coded;
        }
    }
    None
}

fn images(codes: &[QrCode], texts: &[String]) -> Result<Vec<QrImage>> {
    let total = codes.len();
    codes
        .iter()
        .zip(texts)
        .enumerate()
        .map(|(at, (code, text))| {
            Ok(QrImage {
                index: at + 1,
                total,
                png_base64: BASE64.encode(to_png(code)?),
                png_modules: code.width() + 2 * QUIET_MODULES,
                ec_level: level_name(code.error_correction_level()).to_string(),
                text_bytes: text.len(),
            })
        })
        .collect()
}

/// 모듈 격자를 1비트 회색조 PNG 로 그린다. 1모듈 = 1픽셀.
///
/// 8비트로 그려도 파일 크기는 거의 같지만(deflate 가 흡수한다) 원본 버퍼가 8배 커진다. 1비트가
/// 흑백 격자에 정확히 맞는 표현이고 어떤 뷰어·프린터든 그대로 읽는다.
fn to_png(code: &QrCode) -> Result<Vec<u8>> {
    let modules = code.width();
    let side = modules + 2 * QUIET_MODULES;
    let row_bytes = side.div_ceil(8);

    // 1비트 회색조에서 표본 0이 검정, 1이 흰색이다. 흰 종이에서 시작해 어두운 칸의 비트만 지운다.
    let blank = vec![0xFFu8; row_bytes];
    let mut raw = Vec::with_capacity(row_bytes * side);
    for _ in 0..QUIET_MODULES {
        raw.extend_from_slice(&blank);
    }
    for y in 0..modules {
        let mut row = blank.clone();
        for x in 0..modules {
            if code[(x, y)] == Color::Dark {
                let at = QUIET_MODULES + x;
                row[at / 8] &= !(0x80u8 >> (at % 8));
            }
        }
        raw.extend_from_slice(&row);
    }
    for _ in 0..QUIET_MODULES {
        raw.extend_from_slice(&blank);
    }
    debug_assert_eq!(raw.len(), row_bytes * side);

    let mut out = Vec::new();
    {
        let side = u32::try_from(side).map_err(|_| png_failed("그림이 너무 큽니다"))?;
        let mut encoder = png::Encoder::new(&mut out, side, side);
        encoder.set_color(png::ColorType::Grayscale);
        encoder.set_depth(png::BitDepth::One);
        // 압축·필터는 기본값(Balanced + Adaptive)을 그대로 둔다. 그림이 185×185 밖에 안 돼서
        // 가장 잘 줄이는 설정을 써도 몇 마이크로초고, 결과는 가장 작다. set_compression 은
        // 필터까지 함께 덮어쓰므로 굳이 건드리면 순서 함정만 생긴다.
        let mut writer = encoder
            .write_header()
            .map_err(|e| png_failed(&e.to_string()))?;
        writer
            .write_image_data(&raw)
            .map_err(|e| png_failed(&e.to_string()))?;
        writer.finish().map_err(|e| png_failed(&e.to_string()))?;
    }
    Ok(out)
}

fn png_failed(detail: &str) -> Error {
    Error::Internal(format!("QR 그림을 만들 수 없습니다: {detail}"))
}

fn level_name(level: EcLevel) -> &'static str {
    match level {
        EcLevel::L => "L",
        EcLevel::M => "M",
        EcLevel::Q => "Q",
        EcLevel::H => "H",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// 테스트용 armor 텍스트. 실제 컨테이너가 아니어도 형식만 맞으면 된다.
    ///
    /// 본문은 Base64 알파벳 64자를 골고루 섞어 만든다. `AAAA...` 처럼 대문자만 쓰면 인코더가
    /// 그 부분을 영숫자 모드로 접어 실제보다 훨씬 많이 담겨서, 용량 판단이 전부 헐거워진다.
    fn armored(body_len: usize) -> String {
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let body: String = (0..body_len.next_multiple_of(4))
            .map(|i| ALPHABET[(i * 37 + i / 64) % ALPHABET.len()] as char)
            .collect();
        armor::wrap_single_line(&body)
    }

    /// PNG 을 8비트 회색조 픽셀로 되읽는다. 0 = 검정, 255 = 흰색.
    fn decode_png(png_base64: &str) -> (usize, Vec<u8>) {
        let bytes = BASE64.decode(png_base64).unwrap();
        let mut decoder = png::Decoder::new(Cursor::new(bytes));
        decoder.set_transformations(png::Transformations::normalize_to_color8());
        let mut reader = decoder.read_info().unwrap();
        let mut buf = vec![0u8; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut buf).unwrap();
        assert_eq!(info.width, info.height, "QR 은 정사각형이다");
        buf.truncate((info.width * info.height) as usize);
        (info.width as usize, buf)
    }

    #[test]
    fn small_text_becomes_one_symbol_at_the_strongest_level() {
        let images = render(&armored(40)).unwrap().unwrap();
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].index, 1);
        assert_eq!(images[0].total, 1);
        // 작으면 가장 튼튼한 등급을 쓸 여유가 있다.
        assert_eq!(images[0].ec_level, "H");
    }

    #[test]
    fn long_text_is_split_into_numbered_pieces_of_equal_size() {
        let images = render(&armored(10_000)).unwrap().unwrap();
        assert!(images.len() > 1, "나뉘어야 한다: {}", images.len());
        assert!(images.len() <= MAX_PIECES);

        for (at, image) in images.iter().enumerate() {
            assert_eq!(image.index, at + 1);
            assert_eq!(image.total, images.len());
            // 화면에 같은 크기로 나와야 장을 넘길 때 뷰어가 들썩이지 않는다.
            assert_eq!(image.png_modules, images[0].png_modules);
            assert_eq!(image.ec_level, images[0].ec_level);
        }
    }

    #[test]
    fn png_is_a_1bit_grayscale_image_with_a_quiet_zone() {
        let images = render(&armored(200)).unwrap().unwrap();
        let image = &images[0];

        let bytes = BASE64.decode(&image.png_base64).unwrap();
        let decoder = png::Decoder::new(Cursor::new(bytes));
        let reader = decoder.read_info().unwrap();
        assert_eq!(reader.info().bit_depth, png::BitDepth::One);
        assert_eq!(reader.info().color_type, png::ColorType::Grayscale);
        assert_eq!(reader.info().width as usize, image.png_modules);

        let (side, pixels) = decode_png(&image.png_base64);
        assert_eq!(side, image.png_modules);

        // 여백 4모듈이 사방으로 흰색이어야 한다. 없으면 디코더가 심볼을 찾지 못한다.
        for y in 0..side {
            for x in 0..side {
                let in_quiet = x < QUIET_MODULES
                    || y < QUIET_MODULES
                    || x >= side - QUIET_MODULES
                    || y >= side - QUIET_MODULES;
                if in_quiet {
                    assert_eq!(pixels[y * side + x], 255, "여백이 흰색이 아니다: ({x}, {y})");
                }
            }
        }
        // 왼쪽 위 파인더 패턴의 첫 모듈은 검정이다.
        assert_eq!(pixels[QUIET_MODULES * side + QUIET_MODULES], 0);
    }

    #[test]
    fn splitting_starts_where_one_symbol_runs_out() {
        // 실측: 본문 2,900자까지는 한 장(버전 40, ECC L), 그보다 크면 나뉜다.
        // 나뉘면 조각이 짧아져 오히려 더 튼튼한 등급을 쓸 여유가 생긴다.
        let one = render(&armored(2_900)).unwrap().unwrap();
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].ec_level, "L");

        let two = render(&armored(3_000)).unwrap().unwrap();
        assert_eq!(two.len(), 2);
        assert_eq!(two[0].ec_level, "Q");
    }

    #[test]
    fn refuses_text_that_needs_too_many_pieces() {
        // 실측: 16조각이면 본문 46,000자쯤이 한계다. 그 위로는 QR 을 내주지 않는다.
        let most = render(&armored(46_000)).unwrap().unwrap();
        assert_eq!(most.len(), MAX_PIECES);

        assert!(render(&armored(60_000)).unwrap().is_none());
    }

    #[test]
    fn the_whole_gallery_stays_small_enough_to_ship_over_ipc() {
        // QR 모듈 패턴은 이미 오류정정 부호라 deflate 가 거의 줄이지 못한다. 그림 한 장이
        // 대략 모듈수²/8 바이트고, 최악(16장 × 버전 40)이 실측 93 KiB 다. 같은 응답에 이미
        // 실려 가는 preview(최대 2 MiB) 옆에서는 무시할 만하다. 배율을 손대면 이 값이 조용히
        // 터질 수 있어 못박아 둔다.
        let images = render(&armored(46_000)).unwrap().unwrap();
        assert_eq!(images.len(), MAX_PIECES);
        let total: usize = images.iter().map(|i| i.png_base64.len()).sum();
        assert!(
            total < 160 * 1024,
            "{}장 합쳐 {total} 바이트 — 너무 크다",
            images.len()
        );
    }

    #[test]
    fn rejects_text_that_is_not_a_container() {
        assert!(matches!(render("그냥 메모"), Err(Error::NotContainer)));
    }
}
