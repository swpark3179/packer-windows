//! Argon2id 키 유도 + AES-256-GCM 청크 단위 인증 암호화.
//!
//! 청크로 나누는 이유는 두 가지다. 원샷 GCM 은 평문 전체를 메모리에 올려야 하고 하나의 키/nonce
//! 조합당 약 64 GiB 한계가 있다. 1 MiB 청크로 끊으면 메모리 사용량이 파일 크기와 무관하게 일정하고
//! 진행률도 보고할 수 있다.
//!
//! nonce 는 `nonce_prefix(4B) || chunk_index u64 LE(8B)` 라서 한 파일 안에서 절대 겹치지 않고,
//! 청크를 재배열하면 인덱스가 어긋나 인증이 실패한다. AAD 에 헤더 전체와 마지막 청크 플래그를
//! 넣으므로 헤더 파라미터 위조나 파일 잘림도 인증 단계에서 걸린다.

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use rand::RngCore;
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::error::{Error, Result};

pub const KEY_LEN: usize = 32;
pub const KCV_LEN: usize = 16;
pub const TAG_LEN: usize = 16;
pub const SALT_LEN: usize = 32;

pub const DEFAULT_M_COST: u32 = 64 * 1024; // KiB 단위 → 64 MiB
pub const DEFAULT_T_COST: u32 = 3;
pub const DEFAULT_P_COST: u32 = 4;

/// 남의 손을 거친 헤더가 터무니없는 비용을 요구해서 앱을 죽이지 못하게 막는 상한.
const MAX_M_COST: u32 = 1024 * 1024; // 1 GiB
const MAX_T_COST: u32 = 16;
const MAX_P_COST: u32 = 16;

#[derive(Debug, Clone, Copy)]
pub struct KdfParams {
    pub salt: [u8; SALT_LEN],
    pub m_cost: u32,
    pub t_cost: u32,
    pub p_cost: u32,
}

impl KdfParams {
    /// 새로 묶을 때 쓰는 기본 파라미터 (솔트는 OS 난수).
    pub fn generate() -> Self {
        let mut salt = [0u8; SALT_LEN];
        rand::rngs::OsRng.fill_bytes(&mut salt);
        Self {
            salt,
            m_cost: DEFAULT_M_COST,
            t_cost: DEFAULT_T_COST,
            p_cost: DEFAULT_P_COST,
        }
    }

    fn validate(&self) -> Result<()> {
        if self.m_cost == 0
            || self.t_cost == 0
            || self.p_cost == 0
            || self.m_cost > MAX_M_COST
            || self.t_cost > MAX_T_COST
            || self.p_cost > MAX_P_COST
        {
            // 정상적으로 묶인 파일이면 절대 이 범위를 벗어나지 않는다.
            return Err(Error::Corrupted);
        }
        Ok(())
    }
}

/// Argon2id 로 유도한 비밀값. drop 될 때 메모리에서 지워진다.
#[derive(ZeroizeOnDrop)]
pub struct Keys {
    data: [u8; KEY_LEN],
    /// 헤더에 평문으로 저장되는 키 확인값. 키가 틀린 것과 파일이 손상된 것을 구분하는 데 쓴다.
    kcv: [u8; KCV_LEN],
}

impl Keys {
    pub fn kcv(&self) -> [u8; KCV_LEN] {
        self.kcv
    }

    pub fn kcv_matches(&self, expected: &[u8; KCV_LEN]) -> bool {
        ct_eq(&self.kcv, expected)
    }
}

/// 패스프레이즈에서 데이터 키와 키 확인값을 한 번에 유도한다.
///
/// Argon2id 출력 48바이트를 `[0..32]` = 데이터 키, `[32..48]` = KCV 로 쪼갠다. KCV 는 헤더에
/// 평문으로 남지만 KDF 출력의 다른 부분을 노출하지 않으므로 데이터 키는 안전하다. 덕분에 전체
/// 파일을 읽기 전에 "키가 틀렸다" 와 "파일이 깨졌다" 를 구분해 알려줄 수 있다.
pub fn derive_keys(passphrase: &str, params: &KdfParams) -> Result<Keys> {
    params.validate()?;

    let argon_params = argon2::Params::new(
        params.m_cost,
        params.t_cost,
        params.p_cost,
        Some(KEY_LEN + KCV_LEN),
    )
    .map_err(|e| Error::Kdf(e.to_string()))?;

    let argon = argon2::Argon2::new(
        argon2::Algorithm::Argon2id,
        argon2::Version::V0x13,
        argon_params,
    );

    let mut okm = [0u8; KEY_LEN + KCV_LEN];
    argon
        .hash_password_into(passphrase.as_bytes(), &params.salt, &mut okm)
        .map_err(|e| Error::Kdf(e.to_string()))?;

    let mut keys = Keys {
        data: [0u8; KEY_LEN],
        kcv: [0u8; KCV_LEN],
    };
    keys.data.copy_from_slice(&okm[..KEY_LEN]);
    keys.kcv.copy_from_slice(&okm[KEY_LEN..]);
    okm.zeroize();

    Ok(keys)
}

pub fn random_nonce_prefix() -> [u8; 4] {
    let mut p = [0u8; 4];
    rand::rngs::OsRng.fill_bytes(&mut p);
    p
}

fn nonce_for(prefix: &[u8; 4], index: u64) -> Nonce<aes_gcm::aead::consts::U12> {
    let mut n = [0u8; 12];
    n[..4].copy_from_slice(prefix);
    n[4..].copy_from_slice(&index.to_le_bytes());
    *Nonce::from_slice(&n)
}

/// 청크 인덱스를 스스로 세면서 봉인/개봉하는 상태 기계. 순서를 건너뛸 수 없다.
pub struct ChunkCipher {
    cipher: Aes256Gcm,
    nonce_prefix: [u8; 4],
    index: u64,
}

impl ChunkCipher {
    pub fn new(keys: &Keys, nonce_prefix: [u8; 4]) -> Result<Self> {
        let cipher = Aes256Gcm::new_from_slice(&keys.data)
            .map_err(|e| Error::Internal(format!("cipher init: {e}")))?;
        Ok(Self {
            cipher,
            nonce_prefix,
            index: 0,
        })
    }

    /// `aad` 는 호출자가 만든 `헤더 || last 플래그` 바이트열이다.
    pub fn seal(&mut self, plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
        let nonce = nonce_for(&self.nonce_prefix, self.index);
        let out = self
            .cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: plaintext,
                    aad,
                },
            )
            .map_err(|_| Error::Internal("암호화에 실패했습니다.".into()))?;
        self.index += 1;
        Ok(out)
    }

    /// 인증에 실패하면 `Corrupted`. 키가 틀린 경우는 호출 전에 KCV 로 이미 걸러진다.
    pub fn open(&mut self, sealed: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
        let nonce = nonce_for(&self.nonce_prefix, self.index);
        let out = self
            .cipher
            .decrypt(&nonce, Payload { msg: sealed, aad })
            .map_err(|_| Error::Corrupted)?;
        self.index += 1;
        Ok(out)
    }
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 테스트에서 64 MiB Argon2 를 매번 돌리면 너무 느리다.
    fn fast_params() -> KdfParams {
        KdfParams {
            salt: [7u8; SALT_LEN],
            m_cost: 8,
            t_cost: 1,
            p_cost: 1,
        }
    }

    #[test]
    fn same_passphrase_same_keys() {
        let p = fast_params();
        let a = derive_keys("열려라 참깨", &p).unwrap();
        let b = derive_keys("열려라 참깨", &p).unwrap();
        assert_eq!(a.kcv(), b.kcv());
    }

    #[test]
    fn different_passphrase_different_kcv() {
        let p = fast_params();
        let a = derive_keys("열려라 참깨", &p).unwrap();
        let b = derive_keys("열려라 참깨!", &p).unwrap();
        assert_ne!(a.kcv(), b.kcv());
        assert!(!a.kcv_matches(&b.kcv()));
    }

    #[test]
    fn different_salt_different_keys() {
        let mut p1 = fast_params();
        let mut p2 = fast_params();
        p1.salt = [1u8; SALT_LEN];
        p2.salt = [2u8; SALT_LEN];
        let a = derive_keys("같은 키", &p1).unwrap();
        let b = derive_keys("같은 키", &p2).unwrap();
        assert_ne!(a.kcv(), b.kcv());
    }

    #[test]
    fn seal_open_roundtrip() {
        let keys = derive_keys("pw", &fast_params()).unwrap();
        let prefix = [9, 9, 9, 9];
        let aad = b"header-bytes";

        let mut sealer = ChunkCipher::new(&keys, prefix).unwrap();
        let c0 = sealer.seal(b"first chunk", aad).unwrap();
        let c1 = sealer.seal(b"second chunk", aad).unwrap();

        let mut opener = ChunkCipher::new(&keys, prefix).unwrap();
        assert_eq!(opener.open(&c0, aad).unwrap(), b"first chunk");
        assert_eq!(opener.open(&c1, aad).unwrap(), b"second chunk");
    }

    #[test]
    fn reordered_chunks_fail() {
        let keys = derive_keys("pw", &fast_params()).unwrap();
        let aad = b"header-bytes";
        let mut sealer = ChunkCipher::new(&keys, [1, 2, 3, 4]).unwrap();
        let _c0 = sealer.seal(b"first", aad).unwrap();
        let c1 = sealer.seal(b"second", aad).unwrap();

        // 두 번째 청크를 첫 번째 자리에 놓으면 nonce 인덱스가 어긋나 인증이 깨진다.
        let mut opener = ChunkCipher::new(&keys, [1, 2, 3, 4]).unwrap();
        assert!(matches!(opener.open(&c1, aad), Err(Error::Corrupted)));
    }

    #[test]
    fn tampered_aad_fails() {
        let keys = derive_keys("pw", &fast_params()).unwrap();
        let mut sealer = ChunkCipher::new(&keys, [0, 0, 0, 1]).unwrap();
        let c = sealer.seal(b"payload", b"aad-v1").unwrap();

        let mut opener = ChunkCipher::new(&keys, [0, 0, 0, 1]).unwrap();
        assert!(matches!(opener.open(&c, b"aad-v2"), Err(Error::Corrupted)));
    }

    #[test]
    fn tampered_ciphertext_fails() {
        let keys = derive_keys("pw", &fast_params()).unwrap();
        let mut sealer = ChunkCipher::new(&keys, [5; 4]).unwrap();
        let mut c = sealer.seal(b"payload", b"aad").unwrap();
        c[0] ^= 0x01;

        let mut opener = ChunkCipher::new(&keys, [5; 4]).unwrap();
        assert!(matches!(opener.open(&c, b"aad"), Err(Error::Corrupted)));
    }

    #[test]
    fn hostile_kdf_params_rejected() {
        let bad = KdfParams {
            salt: [0u8; SALT_LEN],
            m_cost: u32::MAX,
            t_cost: 1,
            p_cost: 1,
        };
        assert!(matches!(derive_keys("pw", &bad), Err(Error::Corrupted)));
    }
}
