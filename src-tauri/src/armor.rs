//! ASCII armor — 컨테이너를 텍스트 에디터로 옮길 수 있는 형태로 감싼다.
//!
//! 암호화 결과는 본질적으로 임의의 바이트열이라 텍스트 파일에 그대로 담을 수 없다. 그래서
//! Base64 로 옮기고 PEM 처럼 시작/끝 표시로 감싼다. 이렇게 하면 메모장에 붙이거나 메신저로
//! 보내거나 이메일 본문에 넣어도 내용이 상하지 않는다.
//!
//! ```text
//! -----BEGIN PACKER CONTAINER-----
//! kR3vQm9... (한 줄 76자)
//! ...
//! -----END PACKER CONTAINER-----
//! ```
//!
//! 표시 줄 바깥에는 아무 정보도 두지 않는다. 알고리즘이나 버전을 여기에 적어 두면 사람이 그
//! 값을 믿게 되는데, armor 는 인증 범위 밖이라 누구든 고칠 수 있다. 실제 파라미터는 전부
//! 복호화로 검증되는 바이너리 헤더에서만 읽는다.
//!
//! 읽을 때는 최대한 관대하게 받는다. 시작 표시 앞의 잡다한 줄(메일 인용, 안내문)은 건너뛰고,
//! 본문의 공백과 줄바꿈은 무시한다. 대신 Base64 가 아닌 글자가 섞이면 조용히 넘기지 않고
//! 잘못됐다고 알린다 — 붙여넣다 일부가 깨진 경우를 조용히 통과시키면 더 헷갈린다.
//!
//! # 조각 표시
//!
//! 예외가 딱 하나 있다. 컨테이너를 QR 코드로 옮길 때 한 심볼에 다 담기지 않으면 여러 조각으로
//! 나누는데, 사람이 순서대로 이어 붙여야 하므로 조각마다 `#2/5` 같은 번호를 본문에 적어 둔다.
//! 리더는 이 표시를 건너뛴다.
//!
//! ```text
//! -----BEGIN PACKER CONTAINER-----
//! #1/3
//! kR3vQm9...
//! ```
//!
//! `#` 만 예외로 두는 것이 위의 약속을 깨지 않는 이유:
//!
//! 1. `#` 은 손상의 산물이 아니다. 이 검사가 막는 실패(잘림, 줄 재배치, 공백 삽입, `> ` 인용
//!    접두)는 어느 것도 본문 한가운데에 `#` 을 만들어 내지 않는다. 게다가 `#` 하나만으로는
//!    통과하지 못하고 `#숫자/숫자` 모양이 정확히 맞아야 한다.
//! 2. 바이트가 실제로 빠지면 그 약속을 실제로 지고 있는 계층이 잡는다. 청크마다 AES-GCM 태그가
//!    있고 헤더에 KCV 가 있어서 조용한 성공은 애초에 불가능하다. 여기서 글자를 검사하는 것은
//!    안전성이 아니라 **진단 품질** 의 문제다 — 어디가 잘못됐는지 빨리 말해 주려는 것이다.
//! 3. 포기한 진단보다 더 나은 진단을 되돌려 받는다. 실제로 사용자를 물어뜯는 경우(조각을 잘못된
//!    순서로 붙여넣음)를 [`verify_pieces`] 가 이름 있는 에러로 짚어 준다. 그게 없으면 정체불명의
//!    복호화 실패로만 나타난다.
//!
//! 표시는 줄 끝까지가 아니라 **표시 길이만큼만** 건너뛴다. 붙여넣는 과정에서 줄바꿈이 모두
//! 사라져 `...AbCd#2/5RkZG...` 처럼 한 줄로 뭉쳐도 본문을 잃지 않아야 하기 때문이다.
//!
//! 이 관용은 리더에만 있고 라이터는 그대로다. `.txt` 형식은 달라지지 않는다. 다만 조각을 이어
//! 붙인 텍스트는 이 변경 이전 빌드에서 [`Error::ArmorDamaged`] 가 된다.

use std::io::{self, BufRead, Read, Write};
use std::sync::LazyLock;

use base64::Engine as _;

use crate::error::{Error, Result};

pub const BEGIN_MARKER: &str = "-----BEGIN PACKER CONTAINER-----";
pub const END_MARKER: &str = "-----END PACKER CONTAINER-----";

/// 조각 표시를 여는 글자. 본문 안에서 `#숫자/숫자` 만 건너뛴다.
pub const PIECE_MARK: char = '#';

/// PEM 관례를 따른 줄 길이. 76자는 Base64 로 정확히 57바이트에 대응한다.
const LINE_WIDTH_BYTES: usize = 57;
/// 메모장에서 열어도 줄이 깨지지 않도록 CRLF 를 쓴다.
const NEWLINE: &str = "\r\n";

/// 시작 표시 앞에서 이만큼을 넘겨도 못 찾으면 우리 텍스트가 아니라고 본다.
///
/// 이 상한이 없으면 줄바꿈 없는 거대한 파일을 끌어다 놓았을 때 한 줄을 읽으려다 파일 전체를
/// 메모리에 올린다.
const MAX_PREAMBLE_BYTES: u64 = 1024 * 1024;

/// 붙여넣는 과정에서 끝의 `=` 가 떨어져 나가는 경우가 있어 패딩을 느슨하게 받는다.
/// 실제 데이터가 잘렸는지는 GCM 인증이 잡아내므로 여기서 엄격할 이유가 없다.
static ENGINE: LazyLock<base64::engine::GeneralPurpose> = LazyLock::new(|| {
    base64::engine::GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        base64::engine::GeneralPurposeConfig::new()
            .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent),
    )
});

/// Base64 로 옮겨 적으면서 흘려보내는 `Write` 어댑터.
///
/// 반드시 [`ArmorWriter::finish`] 로 마무리해야 남은 바이트와 끝 표시가 나간다.
pub struct ArmorWriter<W: Write> {
    inner: W,
    pending: Vec<u8>,
}

impl<W: Write> ArmorWriter<W> {
    pub fn new(mut inner: W) -> Result<Self> {
        inner
            .write_all(BEGIN_MARKER.as_bytes())
            .and_then(|()| inner.write_all(NEWLINE.as_bytes()))
            .map_err(|e| Error::io("텍스트를 쓸 수 없습니다", e))?;
        Ok(Self {
            inner,
            pending: Vec::with_capacity(LINE_WIDTH_BYTES),
        })
    }

    fn write_line(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.inner.write_all(ENGINE.encode(bytes).as_bytes())?;
        self.inner.write_all(NEWLINE.as_bytes())
    }

    pub fn finish(mut self) -> Result<W> {
        if !self.pending.is_empty() {
            let tail = std::mem::take(&mut self.pending);
            self.write_line(&tail)
                .map_err(|e| Error::io("텍스트를 쓸 수 없습니다", e))?;
        }
        self.inner
            .write_all(END_MARKER.as_bytes())
            .and_then(|()| self.inner.write_all(NEWLINE.as_bytes()))
            .and_then(|()| self.inner.flush())
            .map_err(|e| Error::io("텍스트를 마무리할 수 없습니다", e))?;
        Ok(self.inner)
    }
}

impl<W: Write> Write for ArmorWriter<W> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.pending.extend_from_slice(data);
        // 중간 줄은 항상 꽉 채운다. 그래야 패딩이 마지막 줄에만 생긴다.
        while self.pending.len() >= LINE_WIDTH_BYTES {
            let group: Vec<u8> = self.pending.drain(..LINE_WIDTH_BYTES).collect();
            self.write_line(&group)?;
        }
        Ok(data.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// Base64 텍스트를 되돌려 바이트를 흘려주는 `Read` 어댑터.
pub struct ArmorReader<R: BufRead> {
    inner: R,
    line: String,
    /// 아직 4자 묶음을 못 채운 Base64 글자.
    partial: Vec<u8>,
    out: Vec<u8>,
    out_pos: usize,
    started: bool,
    finished: bool,
    /// 시작 표시를 찾기 전까지 훑은 바이트 수.
    scanned: u64,
}

impl<R: BufRead> ArmorReader<R> {
    /// 생성 시점에는 아무것도 읽지 않는다. 덕분에 호출자가 먼저 앞부분을 엿보고
    /// armor 인지 원시 바이너리인지 판단할 수 있다.
    pub fn new(inner: R) -> Self {
        Self {
            inner,
            line: String::new(),
            partial: Vec::new(),
            out: Vec::new(),
            out_pos: 0,
            started: false,
            finished: false,
            scanned: 0,
        }
    }

    /// 더 읽을 수 없을 때 어떤 잘못인지 정한다.
    ///
    /// 시작 표시를 본 뒤라면 우리 텍스트인데 뒤가 잘린 것이고, 보기도 전이라면 애초에 우리
    /// 것이 아니다. 이 구분이 사용자에게 주는 안내를 완전히 갈라놓는다.
    fn give_up(&self) -> Error {
        if self.started {
            Error::ArmorDamaged
        } else {
            Error::NotContainer
        }
    }

    fn decode(&mut self, chars: &[u8]) -> Result<()> {
        self.out = ENGINE.decode(chars).map_err(|_| Error::ArmorDamaged)?;
        self.out_pos = 0;
        Ok(())
    }

    /// 낼 수 있는 바이트가 생기거나 끝 표시를 만날 때까지 줄을 읽는다.
    fn fill(&mut self) -> Result<()> {
        loop {
            self.line.clear();
            let read = match self.inner.read_line(&mut self.line) {
                Ok(n) => n,
                // 애초에 텍스트가 아니다. 사진이나 zip 을 끌어다 놓으면 여기로 온다.
                Err(e) if e.kind() == io::ErrorKind::InvalidData => {
                    return Err(self.give_up());
                }
                Err(e) => return Err(Error::io("텍스트를 읽을 수 없습니다", e)),
            };

            if read == 0 {
                return Err(self.give_up());
            }

            if !self.started {
                // 시작 표시를 찾느라 거대한 파일을 통째로 훑지 않는다. 우리 텍스트라면
                // 표시 줄이 맨 앞이나 짧은 인용문 뒤에 있다.
                self.scanned += read as u64;
                if self.scanned > MAX_PREAMBLE_BYTES {
                    return Err(Error::NotContainer);
                }
            }

            let trimmed = self.line.trim();

            if !self.started {
                // 시작 표시 앞의 안내문·인용 부호 같은 건 그냥 넘긴다.
                if trimmed == BEGIN_MARKER {
                    self.started = true;
                }
                continue;
            }

            if trimmed == END_MARKER {
                self.finished = true;
                if !self.partial.is_empty() {
                    let tail = std::mem::take(&mut self.partial);
                    self.decode(&tail)?;
                }
                return Ok(());
            }

            scan_body_line(&self.line, &mut self.partial)?;

            // 4자씩만 되돌릴 수 있다. 남는 글자는 다음 줄과 함께 처리한다.
            let usable = self.partial.len() / 4 * 4;
            if usable > 0 {
                let chunk: Vec<u8> = self.partial.drain(..usable).collect();
                self.decode(&chunk)?;
                return Ok(());
            }
        }
    }
}

impl<R: BufRead> Read for ArmorReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        while self.out_pos >= self.out.len() {
            if self.finished {
                return Ok(0);
            }
            self.fill().map_err(Error::into_io)?;
        }
        let n = (self.out.len() - self.out_pos).min(buf.len());
        buf[..n].copy_from_slice(&self.out[self.out_pos..self.out_pos + n]);
        self.out_pos += n;
        Ok(n)
    }
}

// ---------------------------------------------------------------- 본문 다루기

/// 본문에 쓸 수 있는 Base64 글자인지. 리더와 [`body_of`] 가 같은 판단을 쓰도록 한 곳에 둔다.
fn is_body_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/' || byte == b'='
}

/// 이 자리에서 시작하는 조각 표시를 읽는다. `(조각 번호, 전체 조각 수, 표시 길이)`.
///
/// `#` 하나만으로는 통과하지 못한다. `#숫자/숫자` 모양이 정확히 맞아야만 표시로 인정하므로,
/// 본문에 끼어든 다른 `#` 은 여전히 잘못된 글자로 잡힌다.
fn read_piece_mark(bytes: &[u8]) -> Option<(usize, usize, usize)> {
    if bytes.first() != Some(&(PIECE_MARK as u8)) {
        return None;
    }
    let digits = |from: usize| {
        let mut to = from;
        while bytes.get(to).is_some_and(u8::is_ascii_digit) {
            to += 1;
        }
        (to > from).then_some(to)
    };

    let index_end = digits(1)?;
    if bytes.get(index_end) != Some(&b'/') {
        return None;
    }
    let total_end = digits(index_end + 1)?;

    let index = std::str::from_utf8(&bytes[1..index_end])
        .ok()?
        .parse()
        .ok()?;
    let total = std::str::from_utf8(&bytes[index_end + 1..total_end])
        .ok()?
        .parse()
        .ok()?;
    Some((index, total, total_end))
}

/// 본문 한 줄에서 Base64 글자만 뽑아 `out` 뒤에 붙인다.
///
/// 공백과 줄바꿈은 무시하고, 조각 표시는 그 길이만큼만 건너뛴다 (모듈 문서 참고).
fn scan_body_line(line: &str, out: &mut Vec<u8>) -> Result<()> {
    let bytes = line.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        let byte = bytes[at];
        if byte == PIECE_MARK as u8 {
            let (_, _, len) = read_piece_mark(&bytes[at..]).ok_or(Error::ArmorDamaged)?;
            at += len;
        } else if byte.is_ascii_whitespace() {
            at += 1;
        } else if is_body_byte(byte) {
            out.push(byte);
            at += 1;
        } else {
            return Err(Error::ArmorDamaged);
        }
    }
    Ok(())
}

/// 시작 표시와 끝 표시 사이의 줄을 차례로 넘겨준다.
///
/// 판단은 [`ArmorReader`] 와 같다: 시작 표시를 못 보면 애초에 우리 것이 아니고, 보고도 끝 표시
/// 없이 끝나면 우리 것인데 잘린 것이다.
fn for_each_body_line<F>(text: &str, mut on_line: F) -> Result<()>
where
    F: FnMut(&str) -> Result<()>,
{
    let mut started = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if !started {
            if trimmed == BEGIN_MARKER {
                started = true;
            }
            continue;
        }
        if trimmed == END_MARKER {
            return Ok(());
        }
        on_line(line)?;
    }
    Err(if started {
        Error::ArmorDamaged
    } else {
        Error::NotContainer
    })
}

/// armor 텍스트에서 공백·줄바꿈·조각 표시를 모두 걷어낸 Base64 본문만 뽑아낸다.
pub fn body_of(text: &str) -> Result<String> {
    let mut body = Vec::new();
    for_each_body_line(text, |line| scan_body_line(line, &mut body))?;
    // scan_body_line 이 Base64 글자만 넣으므로 항상 ASCII 다.
    String::from_utf8(body).map_err(|_| Error::ArmorDamaged)
}

/// 뽑아낸 본문을 한 줄짜리 armor 텍스트로 감싼다.
pub fn wrap_single_line(body: &str) -> String {
    format!("{BEGIN_MARKER}\n{body}\n{END_MARKER}\n")
}

/// 줄바꿈을 없애 한 줄로 다시 적는다.
///
/// QR 한 심볼의 용량은 바이트로 정해져 있는데 76자마다 넣는 CRLF 가 전체의 2.6% 를 차지한다.
/// 리더가 본문의 공백과 줄바꿈을 전부 무시하므로 (`survives_reflowed_whitespace`) 한 줄로
/// 붙여도 그대로 풀린다.
pub fn compact(text: &str) -> Result<String> {
    Ok(wrap_single_line(&body_of(text)?))
}

/// 본문을 `parts` 조각으로 나눠, 각 조각을 그대로 붙여넣을 수 있는 텍스트로 만든다.
///
/// 순서대로 이어 붙이면 (줄바꿈을 넣든 안 넣든) 그대로 유효한 armor 텍스트가 된다. 첫 조각에
/// 시작 표시, 마지막 조각에 끝 표시가 붙고, 모든 조각에 `#i/N` 순서 표시가 들어간다.
///
/// 표시는 ASCII 로만 적는다. 바이트 모드 QR 에는 믿을 수 있는 문자셋 선언이 없어서 한글을 넣으면
/// 디코더에 따라 깨진다.
///
/// Base64 4자 묶음은 쪼개지 않으므로, 실제로 나온 조각 수가 요청보다 적을 수 있다. `/N` 에는
/// 항상 실제 조각 수를 적는다.
pub fn pieces(body: &str, parts: usize) -> Vec<String> {
    let per = body.len().div_ceil(parts.max(1)).next_multiple_of(4).max(4);
    // 빈 본문(0바이트 페이로드)도 조각 하나로는 나와야 한다.
    let slices: Vec<&[u8]> = if body.is_empty() {
        vec![b""]
    } else {
        body.as_bytes().chunks(per).collect()
    };
    let total = slices.len();

    slices
        .iter()
        .enumerate()
        .map(|(i, slice)| {
            let mut out = String::with_capacity(per + 80);
            if i == 0 {
                out.push_str(BEGIN_MARKER);
                out.push('\n');
            }
            out.push_str(&format!("{PIECE_MARK}{}/{total}\n", i + 1));
            out.push_str(std::str::from_utf8(slice).expect("Base64 본문은 ASCII 다"));
            out.push('\n');
            if i + 1 == total {
                out.push_str(END_MARKER);
                out.push('\n');
            }
            out
        })
        .collect()
}

/// 붙여넣은 텍스트의 조각 표시가 1..N 순서대로 빠짐없이 있는지 확인한다.
///
/// 조각을 잘못된 순서로 붙이면 Base64 는 멀쩡히 통과하고 한참 뒤 헤더 매직이나 GCM 인증에서
/// "우리 파일이 아니다" 또는 "손상됐다" 로 끝난다. 사용자가 고칠 수 있는 문제인데 안내가 원인을
/// 엉뚱한 곳으로 보낸다.
///
/// 표시가 아예 없으면(한 조각이거나 저장된 파일을 그대로 복사한 경우) 아무것도 검사하지 않는다.
/// 형식 자체가 깨진 텍스트도 넘긴다 — 그건 리더가 더 정확히 진단한다.
pub fn verify_pieces(text: &str) -> Result<()> {
    let mut seen: Vec<(usize, usize)> = Vec::new();
    let scanned = for_each_body_line(text, |line| {
        let bytes = line.as_bytes();
        for (at, byte) in bytes.iter().enumerate() {
            if *byte == PIECE_MARK as u8 {
                if let Some((index, total, _)) = read_piece_mark(&bytes[at..]) {
                    seen.push((index, total));
                }
            }
        }
        Ok(())
    });

    if scanned.is_err() || seen.is_empty() {
        return Ok(());
    }

    let total = seen[0].1;
    let in_order = total == seen.len()
        && seen
            .iter()
            .enumerate()
            .all(|(at, (index, n))| *n == total && *index == at + 1);
    if in_order {
        return Ok(());
    }

    // 찾은 순서를 그대로 보여 준다. 어디서 어긋났는지는 사용자가 손에 든 조각과 맞춰 봐야 안다.
    let mut listed: Vec<String> = seen
        .iter()
        .take(12)
        .map(|(index, n)| format!("{PIECE_MARK}{index}/{n}"))
        .collect();
    if seen.len() > listed.len() {
        listed.push("…".to_string());
    }
    Err(Error::PieceOrder(listed.join(" ")))
}

/// 이 텍스트가 armor 로 보이는지. 붙여넣은 내용을 다루기 전에 값싸게 걸러낸다.
pub fn looks_armored(text: &str) -> bool {
    text.lines().any(|line| line.trim() == BEGIN_MARKER)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn armor(bytes: &[u8]) -> String {
        let mut writer = ArmorWriter::new(Vec::new()).unwrap();
        writer.write_all(bytes).unwrap();
        String::from_utf8(writer.finish().unwrap()).unwrap()
    }

    fn dearmor(text: &str) -> Result<Vec<u8>> {
        let mut reader = ArmorReader::new(Cursor::new(text.as_bytes()));
        let mut out = Vec::new();
        reader.read_to_end(&mut out)?;
        Ok(out)
    }

    #[test]
    fn round_trips_every_length_boundary() {
        // 57바이트(한 줄)와 3바이트(Base64 묶음) 경계를 모두 지나가 본다.
        for len in [0usize, 1, 2, 3, 4, 56, 57, 58, 114, 115, 1000] {
            let payload: Vec<u8> = (0..len).map(|i| (i * 7 % 251) as u8).collect();
            let text = armor(&payload);
            assert_eq!(dearmor(&text).unwrap(), payload, "len={len}");
        }
    }

    #[test]
    fn output_is_plain_printable_text() {
        let payload: Vec<u8> = (0..=255u8).collect();
        let text = armor(&payload);
        assert!(text.starts_with(BEGIN_MARKER));
        assert!(text.trim_end().ends_with(END_MARKER));
        // 텍스트 에디터가 손대지 않을 글자만 있어야 한다.
        for ch in text.chars() {
            assert!(
                ch.is_ascii_alphanumeric() || "+/=-\r\n ".contains(ch),
                "예상 밖의 글자: {ch:?}"
            );
        }
    }

    #[test]
    fn wraps_body_lines_at_76_columns() {
        let payload = vec![0x5Au8; 57 * 3 + 10];
        let text = armor(&payload);
        let body: Vec<&str> = text
            .lines()
            .filter(|l| !l.starts_with("-----") && !l.is_empty())
            .collect();
        assert_eq!(body.len(), 4, "{body:?}");
        for line in &body[..3] {
            assert_eq!(line.len(), 76);
        }
        assert!(body[3].len() <= 76);
        // 패딩은 마지막 줄에만 있어야 한다.
        assert!(body[..3].iter().all(|l| !l.contains('=')));
    }

    #[test]
    fn ignores_preamble_before_the_begin_marker() {
        let payload = b"secret payload".to_vec();
        let text = armor(&payload);
        let noisy = format!("안녕하세요, 아래 내용을 풀어 주세요.\r\n\r\n{text}");
        assert_eq!(dearmor(&noisy).unwrap(), payload);
    }

    #[test]
    fn ignores_trailing_text_after_the_end_marker() {
        let payload = b"secret payload".to_vec();
        let text = format!("{}\r\n감사합니다.\r\n", armor(&payload));
        assert_eq!(dearmor(&text).unwrap(), payload);
    }

    #[test]
    fn survives_reflowed_whitespace() {
        let payload: Vec<u8> = (0..500).map(|i| (i % 253) as u8).collect();
        let text = armor(&payload);

        // 메신저나 에디터가 줄을 다시 흘리거나 공백을 끼워 넣어도 되돌릴 수 있어야 한다.
        let body: String = text
            .lines()
            .filter(|l| !l.starts_with("-----"))
            .collect::<Vec<_>>()
            .join("");
        let reflowed = format!(
            "{BEGIN_MARKER}\n{}\n{END_MARKER}\n",
            body.as_bytes()
                .chunks(20)
                .map(|c| String::from_utf8_lossy(c).to_string())
                .collect::<Vec<_>>()
                .join("\n  ")
        );
        assert_eq!(dearmor(&reflowed).unwrap(), payload);

        // LF 만 있는 경우도 마찬가지.
        assert_eq!(dearmor(&text.replace("\r\n", "\n")).unwrap(), payload);
    }

    #[test]
    fn rejects_text_without_a_begin_marker() {
        assert!(matches!(
            dearmor("그냥 평범한 메모입니다.\n"),
            Err(Error::NotContainer)
        ));
        assert!(matches!(dearmor(""), Err(Error::NotContainer)));
    }

    #[test]
    fn rejects_text_cut_off_before_the_end_marker() {
        let payload = vec![1u8; 300];
        let text = armor(&payload);
        let cut = &text[..text.len() / 2];
        assert!(matches!(dearmor(cut), Err(Error::ArmorDamaged)));
    }

    #[test]
    fn rejects_non_base64_characters_in_the_body() {
        let text = format!("{BEGIN_MARKER}\r\nAAAA한글AAAA\r\n{END_MARKER}\r\n");
        assert!(matches!(dearmor(&text), Err(Error::ArmorDamaged)));
    }

    #[test]
    fn looks_armored_spots_our_text() {
        assert!(looks_armored(&armor(b"x")));
        assert!(looks_armored(&format!("앞말\n{BEGIN_MARKER}\nAAAA\n")));
        assert!(!looks_armored("평범한 텍스트"));
        assert!(!looks_armored(""));
    }

    /// 조각 텍스트에서 순서 표시와 표시 줄을 뺀 Base64 본문만 뽑아낸다.
    fn piece_body(piece: &str) -> String {
        piece
            .lines()
            .filter(|l| !l.starts_with("-----") && !l.starts_with(PIECE_MARK))
            .collect()
    }

    #[test]
    fn compact_keeps_the_markers_and_drops_the_line_breaks() {
        let payload: Vec<u8> = (0..1000).map(|i| (i % 251) as u8).collect();
        let text = armor(&payload);
        let one_line = compact(&text).unwrap();

        let lines: Vec<&str> = one_line.lines().collect();
        assert_eq!(lines.len(), 3, "{lines:?}");
        assert_eq!(lines[0], BEGIN_MARKER);
        assert_eq!(lines[2], END_MARKER);
        assert!(
            one_line.len() < text.len(),
            "줄바꿈을 없앴으면 더 짧아야 한다"
        );
        assert_eq!(dearmor(&one_line).unwrap(), payload);
    }

    #[test]
    fn compact_rejects_text_that_is_not_ours() {
        assert!(matches!(
            compact("그냥 평범한 메모입니다.\n"),
            Err(Error::NotContainer)
        ));
        let text = armor(&vec![1u8; 300]);
        assert!(matches!(
            compact(&text[..text.len() / 2]),
            Err(Error::ArmorDamaged)
        ));
        let dirty = format!("{BEGIN_MARKER}\r\nAAAA한글AAAA\r\n{END_MARKER}\r\n");
        assert!(matches!(compact(&dirty), Err(Error::ArmorDamaged)));
    }

    #[test]
    fn pieces_reassemble_into_the_original() {
        for len in [0usize, 1, 57, 500, 5000, 30_000] {
            let payload: Vec<u8> = (0..len).map(|i| (i * 7 % 251) as u8).collect();
            let body = body_of(&armor(&payload)).unwrap();

            for parts in 1..=16 {
                let cut = pieces(&body, parts);
                // 붙여넣는 사람이 줄바꿈을 어떻게 다루든 되돌아와야 한다.
                for joined in [cut.join(""), cut.join("\n"), cut.join("\r\n")] {
                    assert_eq!(
                        dearmor(&joined).unwrap(),
                        payload,
                        "len={len} parts={parts}"
                    );
                }
            }
        }
    }

    #[test]
    fn reads_pieces_joined_without_the_line_breaks() {
        let payload: Vec<u8> = (0..600).map(|i| (i % 251) as u8).collect();
        let body = body_of(&armor(&payload)).unwrap();
        let cut = pieces(&body, 3);

        // 카메라 앱이 조각 끝의 줄바꿈을 떼어 내면 앞 조각의 본문 끝에 다음 조각의 순서 표시가
        // 그대로 달라붙는다: `...AbCd#2/3`. 표시만 정확히 걷어내야 본문을 잃지 않는다.
        let trimmed: String = cut.iter().map(|p| p.trim_end_matches('\n')).collect();
        assert!(trimmed.contains(&format!("{PIECE_MARK}2/3")));
        assert_eq!(dearmor(&trimmed).unwrap(), payload);

        // 표시 뒤의 줄바꿈까지 사라진 더 나쁜 경우 (`...AbCd#2/3RkZG...`).
        let mut squashed = trimmed.clone();
        for i in 1..=3 {
            squashed = squashed.replace(
                &format!("{PIECE_MARK}{i}/3\n"),
                &format!("{PIECE_MARK}{i}/3"),
            );
        }
        assert_eq!(dearmor(&squashed).unwrap(), payload);
    }

    #[test]
    fn pieces_are_numbered_and_the_ends_are_marked() {
        let body = body_of(&armor(&vec![9u8; 4000])).unwrap();
        let cut = pieces(&body, 5);
        assert_eq!(cut.len(), 5);

        assert!(cut[0].starts_with(BEGIN_MARKER));
        assert!(cut.last().unwrap().trim_end().ends_with(END_MARKER));
        // 가운데 조각에는 표시 줄이 없어야 한다. 표시가 여러 번 나오면 이어 붙였을 때 깨진다.
        for piece in &cut[1..] {
            assert!(!piece.starts_with(BEGIN_MARKER));
        }
        for (i, piece) in cut.iter().enumerate() {
            assert!(
                piece.contains(&format!("{PIECE_MARK}{}/5", i + 1)),
                "{}번 조각에 순서 표시가 없다",
                i + 1
            );
        }

        // 화면에 같은 크기로 나오도록 조각 길이를 고르게 나눈다.
        let lengths: Vec<usize> = cut.iter().map(|p| piece_body(p).len()).collect();
        let longest = lengths.iter().max().unwrap();
        let shortest = lengths.iter().min().unwrap();
        assert!(longest - shortest <= 4, "{lengths:?}");
    }

    #[test]
    fn pieces_split_on_base64_group_boundaries() {
        // 4자 묶음을 쪼개지 않으면 조각 하나만 봐도 온전한 Base64 다.
        let body = body_of(&armor(&vec![3u8; 2000])).unwrap();
        let cut = pieces(&body, 4);
        for piece in &cut[..cut.len() - 1] {
            assert_eq!(piece_body(piece).len() % 4, 0);
        }
    }

    #[test]
    fn verify_pieces_accepts_a_correct_sequence() {
        let body = body_of(&armor(&vec![5u8; 3000])).unwrap();
        let cut = pieces(&body, 4);
        assert!(verify_pieces(&cut.join("")).is_ok());
    }

    #[test]
    fn verify_pieces_catches_a_swapped_order() {
        let body = body_of(&armor(&vec![5u8; 3000])).unwrap();
        let mut cut = pieces(&body, 4);
        cut.swap(1, 2);

        match verify_pieces(&cut.join("")) {
            Err(Error::PieceOrder(found)) => {
                assert!(
                    found.contains("#3/4 #2/4"),
                    "찾은 순서를 그대로 보여 줘야 한다: {found}"
                );
            }
            other => panic!("순서가 뒤바뀐 걸 못 잡았다: {other:?}"),
        }
    }

    #[test]
    fn verify_pieces_catches_a_missing_piece() {
        let body = body_of(&armor(&vec![5u8; 3000])).unwrap();
        let mut cut = pieces(&body, 4);
        cut.remove(2);
        assert!(matches!(
            verify_pieces(&cut.join("")),
            Err(Error::PieceOrder(_))
        ));
    }

    #[test]
    fn verify_pieces_ignores_text_without_any_marks() {
        // 한 조각이거나 저장된 파일을 그대로 복사한 경우. 검사할 것이 없다.
        assert!(verify_pieces(&armor(b"secret payload")).is_ok());
        // 형식이 깨진 텍스트는 리더가 더 정확히 진단한다. 여기서 가로채지 않는다.
        assert!(verify_pieces("우리 것이 아닌 메모").is_ok());
    }

    #[test]
    fn verify_pieces_agrees_with_the_reader_when_line_breaks_are_lost() {
        // 표시를 줄 앞에서만 찾으면, 줄바꿈이 사라진 정상 붙여넣기에서 조각을 못 보고
        // 엉뚱한 순서 오류를 낸다. 두 판단이 같은 자리를 봐야 한다.
        let payload = vec![7u8; 3000];
        let body = body_of(&armor(&payload)).unwrap();
        let squashed: String = pieces(&body, 4)
            .iter()
            .map(|p| p.trim_end_matches('\n'))
            .collect();

        assert!(
            verify_pieces(&squashed).is_ok(),
            "정상 붙여넣기를 오류로 봤다"
        );
        assert_eq!(dearmor(&squashed).unwrap(), payload);
    }

    #[test]
    fn still_rejects_other_stray_characters() {
        // 예외는 `#숫자/숫자` 하나뿐이다.
        for junk in [
            "AAAA%AAAA",
            "AAAA@AAAA",
            "AAAA한글AAAA",
            "AAAA*AAAA",
            "AAAA#AAAA",
            "AAAA#1AAAA",
            "AAAA#/2AAAA",
        ] {
            let text = format!("{BEGIN_MARKER}\r\n{junk}\r\n{END_MARKER}\r\n");
            assert!(
                matches!(dearmor(&text), Err(Error::ArmorDamaged)),
                "통과시키면 안 되는 본문: {junk}"
            );
        }
    }

    #[test]
    fn reads_correctly_through_small_buffers() {
        // zstd 디코더는 작은 조각으로 여러 번 읽어 간다.
        let payload: Vec<u8> = (0..2000).map(|i| (i % 251) as u8).collect();
        let text = armor(&payload);

        let mut reader = ArmorReader::new(Cursor::new(text.as_bytes()));
        let mut out = Vec::new();
        let mut tiny = [0u8; 7];
        loop {
            let n = reader.read(&mut tiny).unwrap();
            if n == 0 {
                break;
            }
            out.extend_from_slice(&tiny[..n]);
        }
        assert_eq!(out, payload);
    }
}
