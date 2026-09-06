//! `.fsx` 컨테이너 파일의 헤더와 청크 프레이밍.
//!
//! 파일 구조:
//!
//! ```text
//! offset size  field
//! 0      8     magic "FSXPACK1"
//! 8      2     format_version  u16 LE
//! 10     1     kdf_id          1 = Argon2id
//! 11     1     cipher_id       1 = AES-256-GCM
//! 12     1     compression_id  1 = zstd
//! 13     3     reserved (0)
//! 16     32    kdf_salt
//! 48     4     argon2 m_cost (KiB)  u32 LE
//! 52     4     argon2 t_cost        u32 LE
//! 56     4     argon2 p_cost        u32 LE
//! 60     4     chunk_size           u32 LE
//! 64     4     nonce_prefix
//! 68     12    reserved (0)
//! 80     16    kcv — 키 확인값
//! 96     ..    청크 반복
//! ```
//!
//! 청크 프레임: `[u32 LE plain_len][u8 last][ciphertext plain_len][tag 16]`
//!
//! 매 청크의 AAD 는 `파일에 있는 헤더 96바이트 그대로 || last 플래그` 다. 그래서 헤더의 어느
//! 바이트든 (아직 쓰지 않는 예약 영역까지) 고치면 인증이 실패하고, `last` 플래그를 위조해 파일을
//! 잘라내는 것도 막힌다.
//!
//! [`ContainerWriter`] 는 `Write`, [`ContainerReader`] 는 `Read` 를 구현한다. 덕분에 zstd 인코더/
//! 디코더를 그대로 위에 얹어 `파일 → 컨테이너 → zstd → 직렬화` 파이프라인을 조립할 수 있다.

use std::io::{self, Read, Write};

use crate::crypto::{self, ChunkCipher, KdfParams, Keys, KCV_LEN, SALT_LEN, TAG_LEN};
use crate::error::{Error, Result};

pub const MAGIC: &[u8; 8] = b"FSXPACK1";
pub const FORMAT_VERSION: u16 = 1;
pub const HEADER_LEN: usize = 96;

pub const KDF_ARGON2ID: u8 = 1;
pub const CIPHER_AES256GCM: u8 = 1;
pub const COMPRESSION_ZSTD: u8 = 1;

pub const DEFAULT_CHUNK_SIZE: u32 = 1024 * 1024;
/// 악의적인 헤더가 청크마다 거대한 버퍼를 잡게 만들지 못하도록 하는 상한.
pub const MAX_CHUNK_SIZE: u32 = 16 * 1024 * 1024;
pub const MIN_CHUNK_SIZE: u32 = 4 * 1024;

/// 프레임 하나가 평문 위에 추가로 쓰는 바이트 수.
pub const FRAME_OVERHEAD: usize = 4 + 1 + TAG_LEN;

/// 컨테이너 헤더.
///
/// 파일에 있던 96바이트를 그대로 들고 다니고 그것이 유일한 진실이다. 파싱한 필드를 다시
/// 직렬화해서 AAD 를 만들면, 구조체에 담지 않은 바이트(예약 영역)는 인증 범위에서 빠져
/// 조용히 위조 가능해진다. 그래서 필드는 읽기 전용 접근자로만 노출한다.
#[derive(Debug, Clone)]
pub struct Header {
    raw: [u8; HEADER_LEN],
    format_version: u16,
    kdf: KdfParams,
    chunk_size: u32,
    nonce_prefix: [u8; 4],
    kcv: [u8; KCV_LEN],
}

impl Header {
    /// 새로 묶을 때 쓰는 헤더.
    pub fn new(
        kdf: KdfParams,
        nonce_prefix: [u8; 4],
        kcv: [u8; KCV_LEN],
        chunk_size: u32,
    ) -> Result<Self> {
        if !(MIN_CHUNK_SIZE..=MAX_CHUNK_SIZE).contains(&chunk_size) {
            return Err(Error::Internal(format!(
                "청크 크기가 범위를 벗어났습니다: {chunk_size}"
            )));
        }

        let mut raw = [0u8; HEADER_LEN];
        raw[0..8].copy_from_slice(MAGIC);
        raw[8..10].copy_from_slice(&FORMAT_VERSION.to_le_bytes());
        raw[10] = KDF_ARGON2ID;
        raw[11] = CIPHER_AES256GCM;
        raw[12] = COMPRESSION_ZSTD;
        // 13..16 예약
        raw[16..48].copy_from_slice(&kdf.salt);
        raw[48..52].copy_from_slice(&kdf.m_cost.to_le_bytes());
        raw[52..56].copy_from_slice(&kdf.t_cost.to_le_bytes());
        raw[56..60].copy_from_slice(&kdf.p_cost.to_le_bytes());
        raw[60..64].copy_from_slice(&chunk_size.to_le_bytes());
        raw[64..68].copy_from_slice(&nonce_prefix);
        // 68..80 예약
        raw[80..96].copy_from_slice(&kcv);

        Ok(Self {
            raw,
            format_version: FORMAT_VERSION,
            kdf,
            chunk_size,
            nonce_prefix,
            kcv,
        })
    }

    pub fn from_bytes(b: &[u8; HEADER_LEN]) -> Result<Self> {
        if &b[0..8] != MAGIC {
            return Err(Error::NotContainer);
        }

        let format_version = u16::from_le_bytes([b[8], b[9]]);
        if format_version > FORMAT_VERSION {
            return Err(Error::UnsupportedVersion(format_version));
        }
        if format_version == 0 {
            return Err(Error::Corrupted);
        }

        // 버전이 우리 범위 안인데 알고리즘 ID 를 모르겠다면 손상된 파일이다.
        if b[10] != KDF_ARGON2ID || b[11] != CIPHER_AES256GCM || b[12] != COMPRESSION_ZSTD {
            return Err(Error::Corrupted);
        }

        let chunk_size = u32::from_le_bytes(b[60..64].try_into().expect("4바이트"));
        if !(MIN_CHUNK_SIZE..=MAX_CHUNK_SIZE).contains(&chunk_size) {
            return Err(Error::Corrupted);
        }

        let mut salt = [0u8; SALT_LEN];
        salt.copy_from_slice(&b[16..48]);
        let mut nonce_prefix = [0u8; 4];
        nonce_prefix.copy_from_slice(&b[64..68]);
        let mut kcv = [0u8; KCV_LEN];
        kcv.copy_from_slice(&b[80..96]);

        Ok(Self {
            raw: *b,
            format_version,
            kdf: KdfParams {
                salt,
                m_cost: u32::from_le_bytes(b[48..52].try_into().expect("4바이트")),
                t_cost: u32::from_le_bytes(b[52..56].try_into().expect("4바이트")),
                p_cost: u32::from_le_bytes(b[56..60].try_into().expect("4바이트")),
            },
            chunk_size,
            nonce_prefix,
            kcv,
        })
    }

    pub fn read_from<R: Read>(r: &mut R) -> Result<Self> {
        let mut buf = [0u8; HEADER_LEN];
        match r.read_exact(&mut buf) {
            Ok(()) => {}
            // 96바이트도 안 되는 파일은 애초에 우리 컨테이너가 아니다.
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Err(Error::NotContainer),
            Err(e) => return Err(Error::io("헤더를 읽을 수 없습니다", e)),
        }
        Self::from_bytes(&buf)
    }

    pub fn as_bytes(&self) -> &[u8; HEADER_LEN] {
        &self.raw
    }

    pub fn format_version(&self) -> u16 {
        self.format_version
    }

    pub fn chunk_size(&self) -> u32 {
        self.chunk_size
    }

    pub fn nonce_prefix(&self) -> [u8; 4] {
        self.nonce_prefix
    }

    pub fn kdf(&self) -> &KdfParams {
        &self.kdf
    }

    pub fn kcv(&self) -> &[u8; KCV_LEN] {
        &self.kcv
    }

    /// `헤더 원본 바이트 || last 플래그` — 청크 인증에 쓰는 AAD.
    fn aad(&self, last: bool) -> Vec<u8> {
        let mut aad = Vec::with_capacity(HEADER_LEN + 1);
        aad.extend_from_slice(&self.raw);
        aad.push(u8::from(last));
        aad
    }
}

/// 평문을 받아 청크 단위로 암호화해 내려보내는 `Write` 어댑터.
///
/// 반드시 [`ContainerWriter::finish`] 로 마무리해야 한다. 그래야 마지막 청크에 종료 플래그가
/// 붙어 읽는 쪽이 파일 잘림을 구분할 수 있다.
pub struct ContainerWriter<W: Write> {
    inner: W,
    header: Header,
    cipher: ChunkCipher,
    buf: Vec<u8>,
    chunk_size: usize,
    sealed_plain: u64,
}

impl<W: Write> ContainerWriter<W> {
    pub fn new(mut inner: W, header: Header, keys: &Keys) -> Result<Self> {
        inner
            .write_all(header.as_bytes())
            .map_err(|e| Error::io("헤더를 쓸 수 없습니다", e))?;
        let cipher = ChunkCipher::new(keys, header.nonce_prefix())?;
        let chunk_size = header.chunk_size() as usize;
        Ok(Self {
            inner,
            header,
            cipher,
            buf: Vec::with_capacity(chunk_size),
            chunk_size,
            sealed_plain: 0,
        })
    }

    /// 지금까지 봉인해서 내려보낸 평문 바이트 수.
    pub fn sealed_plain_bytes(&self) -> u64 {
        self.sealed_plain
    }

    fn emit(&mut self, plain: &[u8], last: bool) -> io::Result<()> {
        let aad = self.header.aad(last);
        let sealed = self.cipher.seal(plain, &aad).map_err(Error::into_io)?;

        let mut frame = Vec::with_capacity(FRAME_OVERHEAD + plain.len());
        frame.extend_from_slice(&(plain.len() as u32).to_le_bytes());
        frame.push(u8::from(last));
        frame.extend_from_slice(&sealed);
        self.inner.write_all(&frame)?;
        self.sealed_plain += plain.len() as u64;
        Ok(())
    }

    /// 남은 평문을 마지막 청크로 봉인하고 내부 writer 를 돌려준다.
    ///
    /// 남은 바이트가 0이어도 반드시 빈 종료 청크를 하나 쓴다. 평문 길이가 청크 크기의 정확한
    /// 배수일 때도 종료 표시가 있어야 하기 때문이다.
    pub fn finish(mut self) -> Result<W> {
        let tail = std::mem::take(&mut self.buf);
        self.emit(&tail, true).map_err(Error::recover)?;
        self.inner
            .flush()
            .map_err(|e| Error::io("파일을 마무리할 수 없습니다", e))?;
        Ok(self.inner)
    }
}

impl<W: Write> Write for ContainerWriter<W> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.buf.extend_from_slice(data);
        while self.buf.len() >= self.chunk_size {
            let chunk: Vec<u8> = self.buf.drain(..self.chunk_size).collect();
            self.emit(&chunk, false)?;
        }
        Ok(data.len())
    }

    /// 일부러 부분 청크를 내보내지 않는다. 청크를 꽉 채워야 프레임 오버헤드가 줄고,
    /// 종료 플래그는 [`ContainerWriter::finish`] 한 곳에서만 붙는다.
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// 청크를 복호화해 평문을 흘려주는 `Read` 어댑터.
pub struct ContainerReader<R: Read> {
    inner: R,
    header: Header,
    cipher: ChunkCipher,
    plain: Vec<u8>,
    /// `plain` 안에서 아직 넘겨주지 않은 부분의 시작 위치.
    pos: usize,
    saw_last: bool,
    consumed_ciphertext: u64,
}

impl<R: Read> ContainerReader<R> {
    /// 헤더를 이미 읽어 키까지 확인한 뒤에 호출한다.
    pub fn new(inner: R, header: Header, keys: &Keys) -> Result<Self> {
        let cipher = ChunkCipher::new(keys, header.nonce_prefix())?;
        Ok(Self {
            inner,
            header,
            cipher,
            plain: Vec::new(),
            pos: 0,
            saw_last: false,
            consumed_ciphertext: 0,
        })
    }

    /// 지금까지 읽어 처리한 암호문 바이트 수 (헤더 제외). 진행률 계산에 쓴다.
    pub fn consumed_ciphertext(&self) -> u64 {
        self.consumed_ciphertext
    }

    /// 종료 플래그가 붙은 청크를 정상적으로 읽었는지.
    pub fn completed(&self) -> bool {
        self.saw_last
    }

    fn fill_next_chunk(&mut self) -> Result<()> {
        let mut len_buf = [0u8; 4];
        // 종료 청크를 못 본 채로 파일이 끝났다면 잘린 파일이다.
        if read_full(&mut self.inner, &mut len_buf)? != ReadFull::Done {
            return Err(Error::Corrupted);
        }

        let plain_len = u32::from_le_bytes(len_buf);
        if plain_len > self.header.chunk_size() {
            return Err(Error::Corrupted);
        }

        let mut flag_buf = [0u8; 1];
        if read_full(&mut self.inner, &mut flag_buf)? != ReadFull::Done {
            return Err(Error::Corrupted);
        }
        let last = match flag_buf[0] {
            0 => false,
            1 => true,
            _ => return Err(Error::Corrupted),
        };

        let mut sealed = vec![0u8; plain_len as usize + TAG_LEN];
        if read_full(&mut self.inner, &mut sealed)? != ReadFull::Done {
            return Err(Error::Corrupted);
        }

        let aad = self.header.aad(last);
        let plain = self.cipher.open(&sealed, &aad)?;

        self.consumed_ciphertext += (FRAME_OVERHEAD + plain_len as usize) as u64;
        self.plain = plain;
        self.pos = 0;
        self.saw_last = last;
        Ok(())
    }
}

impl<R: Read> Read for ContainerReader<R> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if out.is_empty() {
            return Ok(0);
        }
        while self.pos >= self.plain.len() {
            if self.saw_last {
                return Ok(0);
            }
            self.fill_next_chunk().map_err(Error::into_io)?;
        }
        let n = (self.plain.len() - self.pos).min(out.len());
        out[..n].copy_from_slice(&self.plain[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

#[derive(PartialEq, Eq, Debug)]
enum ReadFull {
    Done,
    /// 첫 바이트도 못 읽었다 — 깔끔한 EOF.
    Eof,
    /// 일부만 읽고 EOF — 프레임이 잘렸다.
    Partial,
}

/// `read_exact` 와 달리 "깔끔한 EOF" 와 "중간에 잘린 EOF" 를 구분해서 알려준다.
fn read_full<R: Read>(r: &mut R, buf: &mut [u8]) -> Result<ReadFull> {
    let mut filled = 0;
    while filled < buf.len() {
        match r.read(&mut buf[filled..]) {
            Ok(0) => {
                return Ok(if filled == 0 {
                    ReadFull::Eof
                } else {
                    ReadFull::Partial
                })
            }
            Ok(n) => filled += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(Error::io("파일을 읽을 수 없습니다", e)),
        }
    }
    Ok(ReadFull::Done)
}

/// 헤더를 읽고 키를 유도한 뒤 KCV 로 검증한다.
///
/// 이 단계에서 걸러야 "키가 틀렸다" 와 "파일이 깨졌다" 를 구분해서 말할 수 있다. 그냥 복호화를
/// 시도하면 GCM 인증 실패가 두 경우 모두 똑같이 나온다.
pub fn open_header<R: Read>(r: &mut R, passphrase: &str) -> Result<(Header, Keys)> {
    let header = Header::read_from(r)?;
    let keys = crypto::derive_keys(passphrase, header.kdf())?;
    if !keys.kcv_matches(header.kcv()) {
        return Err(Error::WrongKey);
    }
    Ok((header, keys))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::derive_keys;
    use std::io::Cursor;

    fn fast_kdf() -> KdfParams {
        KdfParams {
            salt: [3u8; SALT_LEN],
            m_cost: 8,
            t_cost: 1,
            p_cost: 1,
        }
    }

    /// 테스트에서 1 MiB 청크를 쓰면 여러 청크 경로를 밟기 어렵다.
    fn small_header(kdf: KdfParams, kcv: [u8; KCV_LEN]) -> Header {
        Header::new(kdf, [4, 4, 4, 4], kcv, MIN_CHUNK_SIZE).unwrap()
    }

    fn seal(payload: &[u8], pass: &str) -> Vec<u8> {
        let kdf = fast_kdf();
        let keys = derive_keys(pass, &kdf).unwrap();
        let header = small_header(kdf, keys.kcv());
        let mut w = ContainerWriter::new(Vec::new(), header, &keys).unwrap();
        w.write_all(payload).unwrap();
        w.finish().unwrap()
    }

    fn unseal(bytes: &[u8], pass: &str) -> Result<Vec<u8>> {
        let mut cur = Cursor::new(bytes);
        let (header, keys) = open_header(&mut cur, pass)?;
        let mut r = ContainerReader::new(cur, header, &keys)?;
        let mut out = Vec::new();
        r.read_to_end(&mut out)?;
        assert!(r.completed(), "종료 청크를 보지 못했다");
        Ok(out)
    }

    #[test]
    fn header_bytes_round_trip() {
        let h = small_header(fast_kdf(), [0xAB; KCV_LEN]);
        let back = Header::from_bytes(h.as_bytes()).unwrap();
        assert_eq!(back.format_version(), FORMAT_VERSION);
        assert_eq!(back.kdf().salt, h.kdf().salt);
        assert_eq!(back.kdf().m_cost, h.kdf().m_cost);
        assert_eq!(back.chunk_size(), h.chunk_size());
        assert_eq!(back.nonce_prefix(), h.nonce_prefix());
        assert_eq!(back.kcv(), h.kcv());
        assert_eq!(back.as_bytes(), h.as_bytes());
    }

    #[test]
    fn rejects_foreign_files() {
        let mut junk = vec![0u8; HEADER_LEN];
        junk[0..4].copy_from_slice(b"PK\x03\x04"); // zip
        let mut cur = Cursor::new(junk);
        assert!(matches!(
            open_header(&mut cur, "pw"),
            Err(Error::NotContainer)
        ));
    }

    #[test]
    fn rejects_too_short_files() {
        let mut cur = Cursor::new(b"FSXPACK1".to_vec());
        assert!(matches!(
            open_header(&mut cur, "pw"),
            Err(Error::NotContainer)
        ));
    }

    #[test]
    fn rejects_newer_format_version() {
        let h = small_header(fast_kdf(), [0; KCV_LEN]);
        let mut bytes = *h.as_bytes();
        bytes[8..10].copy_from_slice(&(FORMAT_VERSION + 1).to_le_bytes());
        assert!(matches!(
            Header::from_bytes(&bytes),
            Err(Error::UnsupportedVersion(_))
        ));
    }

    #[test]
    fn rejects_absurd_chunk_size() {
        let h = small_header(fast_kdf(), [0; KCV_LEN]);
        let mut bytes = *h.as_bytes();
        bytes[60..64].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(matches!(Header::from_bytes(&bytes), Err(Error::Corrupted)));
    }

    #[test]
    fn empty_payload_round_trips() {
        let sealed = seal(b"", "pw");
        assert_eq!(unseal(&sealed, "pw").unwrap(), b"");
    }

    #[test]
    fn single_chunk_round_trips() {
        let payload = "hello 김치".as_bytes();
        let sealed = seal(payload, "pw");
        assert_eq!(unseal(&sealed, "pw").unwrap(), payload);
    }

    #[test]
    fn many_chunks_round_trip() {
        // 청크 크기의 정확한 배수 + 애매한 나머지 둘 다 확인한다.
        for len in [
            MIN_CHUNK_SIZE as usize,
            MIN_CHUNK_SIZE as usize * 3,
            MIN_CHUNK_SIZE as usize * 3 + 17,
        ] {
            let payload: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
            let sealed = seal(&payload, "pw");
            assert_eq!(unseal(&sealed, "pw").unwrap(), payload, "len={len}");
        }
    }

    #[test]
    fn wrong_key_is_distinguished_from_corruption() {
        let sealed = seal(b"secret", "correct-horse");
        assert!(matches!(
            unseal(&sealed, "wrong-horse"),
            Err(Error::WrongKey)
        ));
    }

    #[test]
    fn truncated_file_is_detected() {
        let payload: Vec<u8> = (0..MIN_CHUNK_SIZE as usize * 3).map(|i| i as u8).collect();
        let sealed = seal(&payload, "pw");
        // 종료 청크를 잘라낸다.
        let cut = &sealed[..sealed.len() - 100];
        assert!(matches!(unseal(cut, "pw"), Err(Error::Corrupted)));
    }

    #[test]
    fn tampered_reserved_header_byte_breaks_authentication() {
        let mut sealed = seal(b"payload", "pw");
        // 예약 바이트는 구조체 필드로 파싱하지 않는다. 그래도 AAD 는 파일에 있던 원본 96바이트라서
        // 인증에서 걸려야 한다 — 이게 깨지면 헤더 일부가 사실상 위조 가능해진다.
        sealed[13] ^= 0xFF;
        assert!(matches!(unseal(&sealed, "pw"), Err(Error::Corrupted)));
    }

    #[test]
    fn tampered_nonce_prefix_breaks_authentication() {
        let mut sealed = seal(b"payload", "pw");
        sealed[64] ^= 0xFF;
        assert!(matches!(unseal(&sealed, "pw"), Err(Error::Corrupted)));
    }

    #[test]
    fn flipping_the_last_flag_breaks_authentication() {
        let payload: Vec<u8> = (0..MIN_CHUNK_SIZE as usize * 2).map(|i| i as u8).collect();
        let mut sealed = seal(&payload, "pw");
        // 첫 프레임의 last 플래그(헤더 바로 뒤 4바이트 길이 다음 1바이트)를 세운다.
        sealed[HEADER_LEN + 4] = 1;
        assert!(matches!(unseal(&sealed, "pw"), Err(Error::Corrupted)));
    }

    #[test]
    fn tampered_ciphertext_breaks_authentication() {
        let mut sealed = seal(b"payload bytes here", "pw");
        let body = HEADER_LEN + 5;
        sealed[body] ^= 0x01;
        assert!(matches!(unseal(&sealed, "pw"), Err(Error::Corrupted)));
    }

    #[test]
    fn rejects_out_of_range_chunk_size_at_construction() {
        let kdf = fast_kdf();
        assert!(Header::new(kdf, [0; 4], [0; KCV_LEN], 0).is_err());
        assert!(Header::new(kdf, [0; 4], [0; KCV_LEN], MAX_CHUNK_SIZE + 1).is_err());
        assert!(Header::new(kdf, [0; 4], [0; KCV_LEN], DEFAULT_CHUNK_SIZE).is_ok());
    }
}
