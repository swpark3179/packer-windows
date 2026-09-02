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

use std::io::{self, BufRead, Read, Write};
use std::sync::LazyLock;

use base64::Engine as _;

use crate::error::{Error, Result};

pub const BEGIN_MARKER: &str = "-----BEGIN PACKER CONTAINER-----";
pub const END_MARKER: &str = "-----END PACKER CONTAINER-----";

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

            for byte in self.line.bytes() {
                if byte.is_ascii_whitespace() {
                    continue;
                }
                if !(byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/' || byte == b'=') {
                    return Err(Error::ArmorDamaged);
                }
                self.partial.push(byte);
            }

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
        assert!(matches!(dearmor("그냥 평범한 메모입니다.\n"), Err(Error::NotContainer)));
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
