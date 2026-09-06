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
use qrcode::{types::Version, Color, EcLevel, QrCode};
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

/// 조각 수 상한.
///
/// 한때 16이었다. QR 규격의 Structured Append 상한과 같은 값이었지만 실은 그 규격을 쓰지 않고
/// 있었고 — 폰의 기본 카메라가 모르기 때문이다 — 진짜 이유는 **사람이 '다음' 을 16번 눌러야
/// 한다**는 것이었다. 뷰어가 스스로 장을 넘기게 된 지금 그 비용은 초 단위 대기뿐이다.
///
/// 128장은 실측으로 본문 약 182,000자 = **컨테이너 약 132 KiB** 다. 자동 넘김을 프레임당
/// 350 ms 로 두면 한 바퀴가 45초다.
///
/// 이 값을 올릴 때 `commands::QR_SOURCE_LIMIT` 를 함께 올리지 않으면 **아무 일도 일어나지
/// 않는다** — 그쪽이 `plan()` 을 부르기 전에 먼저 자른다.
pub const MAX_PIECES: usize = 128;

/// 한 심볼의 모듈 수 상한. 버전 40 이 177, 버전 25 가 117 이다.
///
/// **이 값이 이 기능의 실제 성공률을 쥐고 있다.** 화면에 555px 로 띄우면 버전 40(177모듈)은
/// 모듈 하나가 3.1px, 96 DPI 기준 0.79mm 다. 그 크기에서는 초점이 맞아도 폰이 놓치는 일이
/// 잦았다 — `mobile/README.md` 가 인식률로 호소하던 것이 이 조건이다.
///
/// 125 로 내리면 조각이 1.5~2배로 늘어나는 대신 모든 심볼이 굵어진다. 예전에는 그 대가가
/// 비쌌다(16장 상한 안에서 담을 수 있는 크기가 줄었다). 상한을 64로 올리고 뷰어가 스스로
/// 넘기게 된 지금은 조각이 몇 장 더 느는 것이 초 단위 비용일 뿐이라, 굵은 쪽을 고른다.
const MAX_MODULES: usize = 125;

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

/// 나눔이 정해진 상태. 그림은 아직 그리지 않았다.
///
/// 그림을 미리 다 그리지 않는 이유는 크기다. 심볼 하나가 base64 로 약 6 KiB 라, 64장을 한
/// 응답에 실으면 372 KiB 이고 조각 상한을 더 올리면 곧 메가바이트가 된다. 그 정도가 되면
/// 직렬화·파싱만으로 웹뷰 메인 스레드가 몇 초씩 멈춘다. 대신 [`Self::image`] 로 한 장씩
/// 꺼내 간다 — 뷰어는 어차피 한 번에 한 장만 보여 준다.
pub struct QrPlan {
    texts: Vec<String>,
    version: Version,
    level: EcLevel,
    /// 여백까지 포함한 한 변의 모듈 수. 모든 조각이 같다.
    png_modules: usize,
}

/// 나눔의 요약. 응답에 실어 보내는 것은 그림이 아니라 이것이다.
#[derive(Debug, Serialize, Clone)]
pub struct QrPlanInfo {
    pub total: usize,
    pub png_modules: usize,
    pub ec_level: String,
}

impl QrPlan {
    pub fn total(&self) -> usize {
        self.texts.len()
    }

    pub fn info(&self) -> QrPlanInfo {
        QrPlanInfo {
            total: self.total(),
            png_modules: self.png_modules,
            ec_level: level_name(self.level).to_string(),
        }
    }

    /// `index` 는 1부터 센다. 범위를 벗어나면 [`Error::Internal`].
    pub fn image(&self, index: usize) -> Result<QrImage> {
        let text = self
            .texts
            .get(index.wrapping_sub(1))
            .ok_or_else(|| Error::Internal(format!("{index}번 QR 조각이 없습니다")))?;

        // 계획을 세울 때 이미 같은 버전·등급으로 인코딩해 봤으므로 여기서 실패할 일은 없다.
        // 그래도 unwrap 하지 않는다 — 이 경로는 사용자 입력을 타고 다시 들어온다.
        let code = QrCode::with_version(text.as_bytes(), self.version, self.level)
            .map_err(|e| png_failed(&e.to_string()))?;

        Ok(QrImage {
            index,
            total: self.total(),
            png_base64: BASE64.encode(to_png(&code)?),
            png_modules: self.png_modules,
            ec_level: level_name(self.level).to_string(),
            text_bytes: text.len(),
        })
    }
}

// ---------------------------------------------------------------- 만들기

/// armor 텍스트를 몇 조각으로 어떻게 나눌지 정한다.
///
/// 조각 수가 [`MAX_PIECES`] 를 넘거나 어떤 나눔으로도 [`MAX_MODULES`] 안에 못 들어가면
/// `Ok(None)` 이다. 실패가 아니라 "QR 로 옮길 만한 크기가 아니다" 라는 뜻이다.
pub fn plan(armored: &str) -> Result<Option<QrPlan>> {
    let body = armor::body_of(armored)?;

    // 한 심볼에 들어가면 그것으로 끝이다. 용량 표를 믿지 않고 실제로 인코딩해 본다.
    let whole = armor::wrap_single_line(&body);
    if let Some(plan) = encode_uniform(vec![whole]) {
        return Ok(Some(plan));
    }

    // 조각 수를 **이분 탐색**한다. 많이 나눌수록 조각이 짧아지므로 "들어가는가" 는 조각 수에
    // 대해 단조롭다 — 한 번 들어가기 시작하면 그보다 많이 나눠도 들어간다. 예전에는 하한부터
    // 하나씩 올렸는데, 상한이 16일 때는 몇 번이면 끝나서 공짜였다. 128장에서는 실패하는 큰
    // 입력마다 수십 번씩 본문 전체를 다시 자르게 되어 값이 붙는다.
    //
    // 단조성 가정은 `binary_search_agrees_with_a_linear_scan` 테스트가 지킨다.
    let low = body.len().div_ceil(MAX_SYMBOL_BYTES).max(2);
    if low > MAX_PIECES {
        return Ok(None);
    }

    let mut best = None;
    let (mut lo, mut hi) = (low, MAX_PIECES);
    while lo <= hi {
        let mid = lo + (hi - lo) / 2;
        match try_parts(&body, mid) {
            // 들어갔다. 더 적게 나눌 수 있는지 아래를 계속 본다 — 조각이 적을수록 사용자가
            // 기다리는 시간이 짧다.
            Some(plan) => {
                best = Some(plan);
                if mid == low {
                    break;
                }
                hi = mid - 1;
            }
            None => lo = mid + 1,
        }
    }
    Ok(best)
}

/// `parts` 조각으로 나눠 같은 규격에 담아 본다.
///
/// **실제로 나온 조각 수가 요청보다 적어도 그대로 받는다.** `armor::pieces()` 는 Base64 4자
/// 묶음을 쪼개지 않으려고 조각 길이를 4의 배수로 올림하므로, 요청한 수가 그대로 나오지 않는
/// 값이 많다 (본문 2,000자에 65조각을 요청하면 63조각이 나온다). 예전 선형 훑기는 그런 값을
/// 건너뛰었다 — 어차피 다음 값에서 만나기 때문이다. 이분 탐색에서 같은 짓을 하면 **단조성이
/// 깨진다**: 되는 조각 수 사이사이에 "안 됨" 이 뚫려 버려 탐색이 답을 넘겨 버린다.
///
/// 나온 개수를 그대로 받으면 조각 길이(`per`)가 `parts` 에 대해 단조 감소하므로 "들어가는가"
/// 도 단조가 된다. `armor::pieces()` 는 요청보다 **많이** 만들지는 않으므로 상한도 지켜진다.
fn try_parts(body: &str, parts: usize) -> Option<QrPlan> {
    encode_uniform(armor::pieces(body, parts))
}

/// 조각들을 모두 같은 버전·등급으로 인코딩할 수 있는지 본다. 하나라도 안 들어가면 `None`.
///
/// 가장 긴 조각으로 규격을 정한다. 등급을 H 부터 훑는 것은 두 가지를 동시에 한다: 담을 수 있는
/// 가장 튼튼한 등급을 고르고, 모듈 수가 상한을 넘으면 더 낮은 등급(= 더 작은 버전)으로 내려간다.
fn encode_uniform(pieces: Vec<String>) -> Option<QrPlan> {
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
        // 가장 긴 조각이 들어갔다고 나머지도 들어간다고 단정하지 않는다 — 짧은 조각이 다른
        // 인코딩 모드로 접히면서 오히려 더 커지는 경우가 규격상 가능하다.
        if !pieces
            .iter()
            .all(|piece| QrCode::with_version(piece.as_bytes(), version, level).is_ok())
        {
            continue;
        }
        return Some(QrPlan {
            texts: pieces,
            version,
            level,
            png_modules: probe.width() + 2 * QUIET_MODULES,
        });
    }
    None
}

// ---------------------------------------------------------------- 스트림 프레임

/// 스트림 모드([`crate::qrstream`]) 프레임 하나를 담은 심볼.
#[derive(Debug, Serialize)]
pub struct QrFrame {
    pub png_base64: String,
    pub png_modules: usize,
}

/// 스트림 프레임 payload 로 쓸 수 있는 최대 바이트 수.
///
/// [`MAX_MODULES`] 안에 들어가는 가장 큰 바이트 모드 심볼을 실제로 인코딩해 찾는다. 용량 표를
/// 믿지 않는 이유는 조각 모드와 같다 — 표를 그대로 쓰면 담을 수 있는 것을 못 담는다.
///
/// 조각 모드와 달리 등급을 훑지 않고 **L 로 고정**한다. 스트림은 프레임을 놓쳐도 다음 바퀴에
/// 잡으면 그만이라, 심볼 하나의 오류 정정을 두껍게 하는 것보다 한 프레임에 더 많이 담아
/// 전체 시간을 줄이는 편이 낫다.
pub fn stream_capacity() -> usize {
    // 0xAA 는 영숫자 모드로 접히지 않으므로 순수 바이트 모드 용량이 나온다.
    let fits = |len: usize| {
        QrCode::with_error_correction_level(vec![0xAAu8; len], EcLevel::L)
            .map(|code| code.width() <= MAX_MODULES)
            .unwrap_or(false)
    };

    let (mut lo, mut hi) = (1usize, MAX_SYMBOL_BYTES);
    while lo < hi {
        let mid = (lo + hi).div_ceil(2);
        if fits(mid) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    lo
}

/// 바이트열 하나를 심볼로 그린다. 스트림 프레임 전용이다.
///
/// 조각 모드와 달리 텍스트가 아니라 **원시 바이너리**를 담는다. Base64 를 씌우지 않아 33% 를
/// 더 담을 수 있고, 폰은 `barcode.bytes` 로 그대로 받는다 (`bridge.js` 의 `barcodeBytes`).
/// 어차피 사람이 읽을 수 있는 내용이 아니므로 ASCII 로 둘 이유가 없다.
pub fn render_frame(bytes: &[u8]) -> Result<QrFrame> {
    let code = QrCode::with_error_correction_level(bytes, EcLevel::L)
        .map_err(|e| png_failed(&e.to_string()))?;
    Ok(QrFrame {
        png_base64: BASE64.encode(to_png(&code)?),
        png_modules: code.width() + 2 * QUIET_MODULES,
    })
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

    /// 예전 `render()` 처럼 모든 조각을 그려서 돌려준다. 그림을 다 봐야 하는 테스트용이다.
    fn render_all(armored: &str) -> Option<Vec<QrImage>> {
        let plan = plan(armored).unwrap()?;
        Some(
            (1..=plan.total())
                .map(|index| plan.image(index).unwrap())
                .collect(),
        )
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
        let images = render_all(&armored(40)).unwrap();
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].index, 1);
        assert_eq!(images[0].total, 1);
        // 작으면 가장 튼튼한 등급을 쓸 여유가 있다.
        assert_eq!(images[0].ec_level, "H");
    }

    #[test]
    fn long_text_is_split_into_numbered_pieces_of_equal_size() {
        let images = render_all(&armored(10_000)).unwrap();
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
    fn every_symbol_stays_under_the_module_cap() {
        // 이 상한이 인식률을 쥐고 있다. 어떤 크기에서도 넘지 않아야 한다.
        for len in [40usize, 3_000, 10_000, 100_000] {
            let Some(plan) = plan(&armored(len)).unwrap() else {
                continue;
            };
            assert!(
                plan.png_modules <= MAX_MODULES + 2 * QUIET_MODULES,
                "len={len} 에서 {}모듈",
                plan.png_modules
            );
        }
    }

    #[test]
    fn png_is_a_1bit_grayscale_image_with_a_quiet_zone() {
        let images = render_all(&armored(200)).unwrap();
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
                    assert_eq!(
                        pixels[y * side + x],
                        255,
                        "여백이 흰색이 아니다: ({x}, {y})"
                    );
                }
            }
        }
        // 왼쪽 위 파인더 패턴의 첫 모듈은 검정이다.
        assert_eq!(pixels[QUIET_MODULES * side + QUIET_MODULES], 0);
    }

    #[test]
    fn splitting_starts_where_one_symbol_runs_out() {
        // MAX_MODULES 를 125 로 두었으므로 한 심볼의 상한은 버전 40 이 아니라 버전 25 쪽이다.
        // 실측: 본문 1,000자까지는 한 장, 그보다 크면 나뉜다.
        let one = render_all(&armored(1_000)).unwrap();
        assert_eq!(one.len(), 1);

        let more = render_all(&armored(3_000)).unwrap();
        assert!(more.len() > 1, "{}장", more.len());
        // 나뉘면 조각이 짧아져 오히려 더 튼튼한 등급을 쓸 여유가 생긴다.
        assert_ne!(more[0].ec_level, "L");
    }

    /// 이분 탐색이 옳으려면 "조각 수가 늘면 들어간다" 가 단조여야 한다. 그 가정을 여기서
    /// 실제로 확인한다 — 어긋나면 `plan()` 이 조용히 더 많은 조각을 고르거나 아예 못 찾는다.
    #[test]
    fn binary_search_agrees_with_a_linear_scan() {
        // 훑기는 조각 수에 제곱으로 비싸다(조각 수마다 그만큼 인코딩한다). 작은 본문 몇 개면
        // 단조성이 깨지는 모양 — 되는 값 사이에 구멍 —— 은 충분히 드러난다. 실제로 이 테스트가
        // 처음 잡아낸 것도 본문 2,000자에서였다.
        for len in [40usize, 1_000, 2_000, 5_000] {
            let text = armored(len);
            let body = armor::body_of(&text).unwrap();

            // 한 심볼에 들어가면 탐색을 타지 않는다.
            if encode_uniform(vec![armor::wrap_single_line(&body)]).is_some() {
                assert_eq!(plan(&text).unwrap().unwrap().total(), 1, "len={len}");
                continue;
            }

            // 조각 수를 하나씩 훑어 "되는지" 를 적는다. 훑기는 조각 수에 제곱으로 비싸므로
            // (조각 수마다 그만큼 인코딩한다) 답이 나오는 언저리만 본다 — 정렬 때문에 생기는
            // 구멍은 거기 몰려 있고, 실제로 이 테스트가 처음 잡아낸 것도 그 구간이었다.
            let low = body.len().div_ceil(MAX_SYMBOL_BYTES).max(2);
            let high = (low + 24).min(MAX_PIECES);
            let fits: Vec<Option<usize>> = (low..=high)
                .map(|parts| try_parts(&body, parts).map(|p| p.total()))
                .collect();

            // 단조성: 한 번 되기 시작하면 그 위로 구멍이 없어야 한다. 이분 탐색이 옳을 조건이다.
            let first = fits.iter().position(Option::is_some);
            if let Some(first) = first {
                let hole = fits[first..].iter().position(Option::is_none);
                assert!(
                    hole.is_none(),
                    "len={len}: {}장부터 되는데 {}장에서 구멍이 났다",
                    low + first,
                    low + first + hole.unwrap()
                );
            }

            // 그리고 이분 탐색은 훑기가 찾은 **가장 적은 조각 수**를 그대로 내야 한다.
            let fewest = fits.iter().flatten().copied().min();
            let found = plan(&text).unwrap().map(|p| p.total());
            assert_eq!(
                found, fewest,
                "len={len} 에서 이분 탐색이 더 나쁜 답을 냈다"
            );
        }
    }

    #[test]
    fn refuses_text_that_needs_too_many_pieces() {
        // 실측: 128조각에 본문 약 182,000자(컨테이너 약 132 KiB)까지 담긴다.
        let most = plan(&armored(180_000)).unwrap().unwrap();
        assert!(most.total() <= MAX_PIECES, "{}장", most.total());
        assert!(
            most.total() > MAX_PIECES / 2,
            "{}장 — 한계 근처여야 한다",
            most.total()
        );

        assert!(plan(&armored(400_000)).unwrap().is_none());
    }

    #[test]
    fn the_plan_response_stays_tiny_no_matter_how_many_pieces() {
        // 예전에는 조각 그림을 전부 한 응답에 실었다. 64장이면 372 KiB 이고 상한을 더 올리면
        // 곧 메가바이트가 된다. 이제 응답에 나가는 것은 요약뿐이고, 그림은 한 장씩 꺼내 간다.
        let plan = plan(&armored(180_000)).unwrap().unwrap();
        let info = serde_json::to_string(&plan.info()).unwrap();
        assert!(info.len() < 128, "{info}");

        // 한 장씩 꺼내면 그 한 장은 여전히 작다.
        let one = plan.image(1).unwrap();
        assert!(
            one.png_base64.len() < 16 * 1024,
            "{} 바이트",
            one.png_base64.len()
        );
    }

    #[test]
    fn asking_for_a_piece_that_is_not_there_is_an_error() {
        let plan = plan(&armored(40)).unwrap().unwrap();
        assert_eq!(plan.total(), 1);
        assert!(plan.image(1).is_ok());
        // 1부터 센다. 0도 2도 없다.
        assert!(plan.image(0).is_err());
        assert!(plan.image(2).is_err());
    }

    #[test]
    fn a_stream_frame_fits_the_module_cap() {
        let capacity = stream_capacity();
        // 실측 1,465 바이트 — 125모듈 상한이 버전 27(125모듈)까지 허용하고, 그 등급 L 용량이
        // 이 값이다. 이 숫자가 스트림의 처리율을 그대로 정하므로(프레임당 1,441 바이트 payload)
        // 크게 달라지면 README 의 시간 계산도 함께 고쳐야 한다.
        assert!(
            (1_200..1_800).contains(&capacity),
            "스트림 payload 용량이 {capacity} 바이트다 — README 의 처리율도 함께 고칠 것"
        );

        // 0xAA 를 쓴다. 0x5A('Z') 처럼 영숫자 글자를 쓰면 인코더가 영숫자 모드로 접어 더
        // 많이 담기고, 그러면 바이트 모드 용량을 재는 것이 아니게 된다.
        let frame = render_frame(&vec![0xAAu8; capacity]).unwrap();
        assert!(frame.png_modules <= MAX_MODULES + 2 * QUIET_MODULES);
        // 한 바이트만 더 넣으면 상한을 넘어야 한다 — 이분 탐색이 최대를 찾았다는 뜻이다.
        let over = QrCode::with_error_correction_level(vec![0xAAu8; capacity + 1], EcLevel::L);
        assert!(over.is_err() || over.unwrap().width() > MAX_MODULES);
    }

    #[test]
    fn stream_frames_are_all_the_same_size() {
        // 화면에서 프레임이 넘어갈 때 크기가 들썩이면 폰이 매번 초점을 다시 잡는다.
        let capacity = stream_capacity();
        let first = render_frame(&vec![0x01u8; capacity]).unwrap();
        let second = render_frame(&vec![0xFEu8; capacity]).unwrap();
        assert_eq!(first.png_modules, second.png_modules);
        assert!(first.png_modules <= MAX_MODULES + 2 * QUIET_MODULES);
    }

    #[test]
    fn rejects_text_that_is_not_a_container() {
        assert!(matches!(plan("그냥 메모"), Err(Error::NotContainer)));
    }
}
