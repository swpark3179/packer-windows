//! 대용량을 QR 로 옮기는 **스트림 모드** — 파운틴(LT) 부호.
//!
//! [`crate::qr`] 의 조각 모드는 컨테이너를 N등분해 순서대로 찍게 한다. 그 방식의 벽은 용량이
//! 아니라 **놓친 한 장**이다. 순번이 고정돼 있으니 한 장을 놓치면 그 장이 다시 올 때까지
//! 기다려야 하고, 순차 슬라이드쇼에서 그건 한 바퀴를 통째로 다시 도는 일이다. 쿠폰 수집가
//! 문제라서 장수가 늘수록 급격히 나빠진다 — 10 MB(약 4,800장)를 5% 놓치며 찍으면 24분이
//! 아니라 한 시간이 넘는다.
//!
//! LT(Luby Transform) 부호는 그 항을 없앤다. 프레임마다 **소스 블록 몇 개를 XOR 한 것**을
//! 담고, 어떤 블록을 골랐는지는 프레임 번호를 시드로 한 난수열이 정한다. 받는 쪽은 아무
//! 프레임이나 K(1+ε)개쯤 모으면 전부 풀 수 있다 — 어떤 프레임인지는 상관없다. 그래서 화면은
//! 끝없이 돌기만 하면 되고, 놓친 프레임을 되찾으러 갈 일이 없다.
//!
//! # 잃는 것
//!
//! **기본 카메라로 찍어 붙여넣을 수 없다.** [`crate::qr`] 모듈 문서와 README 가 자랑하는
//! 성질이 여기서는 성립하지 않는다 — 프레임 하나는 XOR 된 바이트 덩어리라 사람이 이어 붙일
//! 방법이 없다. 그래서 **조각 모드를 대체하지 않고 옆에 둔다.** 조각 모드에 담기는 크기면
//! 그쪽이 언제나 낫고, 스트림 모드는 그 위에서만 제안한다. 화면도 그렇게 말한다.
//!
//! # 두 언어가 같은 난수열을 내야 한다
//!
//! 인코더는 여기(Rust), 디코더는 `mobile/www/stream.js`(자바스크립트)에 있다. 블록 선택이
//! 한 비트라도 어긋나면 **복원이 조용히 실패한다** — 프레임은 멀쩡히 읽히는데 XOR 이 안 맞아
//! 마지막에 GCM 인증 실패로만 나타난다. 그래서 표준 라이브러리 RNG 를 쓰지 않고 아래
//! [`Rng`] 를 규격으로 못박고, 양쪽 구현이 같은 값을 내는지 골든 픽스처
//! (`mobile/tests/fixtures/stream-frames.json`)로 확인한다.
//!
//! 자바스크립트에는 64비트 정수가 없으므로 **32비트 연산만** 쓴다. `Math.imul` 로 그대로 옮길
//! 수 있는 형태다.

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::{Error, Result};

// ---------------------------------------------------------------- 규격

/// 프레임 헤더의 매직. 폰이 조각 모드와 스트림 모드를 이걸로 가른다.
pub const MAGIC: [u8; 4] = *b"PQS1";

/// 헤더 크기. 아래 [`Frame::to_bytes`] 의 표와 같아야 한다.
pub const HEADER_LEN: usize = 24;

/// 컨테이너를 알아보는 짧은 지문. SHA-256 앞 8바이트.
///
/// 두 가지를 한다. 다른 묶음의 프레임이 섞이면 폰이 곧바로 걸러 내고(조각 모드의
/// `chunkLength` 충돌 검사와 같은 자리), 다 모은 뒤 복원한 바이트가 맞는지 확인한다.
pub const FINGERPRINT_LEN: usize = 8;

/// 스트림 모드로 내보낼 수 있는 최대 컨테이너 크기.
///
/// 프레임 하나에 실리는 payload 가 실측 1,441바이트(`qr::stream_capacity()` 1,465에서 헤더
/// 24를 뺀 값)이므로, 한 화면에 한 장씩 350ms 로 넘기면 **초당 약 4.1 KB** 다. 그래서:
///
/// | 컨테이너 | 프레임 | 350ms·1장 | 350ms·2장 |
/// | --- | --- | --- | --- |
/// | 1 MB | 약 760 | 약 4분 | 약 2분 |
/// | 10 MB | 약 7,800 | 약 45분 | 약 23분 |
/// | 16 MiB | 약 12,500 | 약 73분 | 약 37분 |
///
/// 뒤쪽 열은 화면이 프레임을 나란히 세울 때다. 카메라 프레임이 16:9 라 정사각형 심볼 하나로는
/// 좌우가 통째로 남고, 두 장을 세우면 그 빈 자리에 들어간다 — 넘김 횟수는 그대로다.
/// 여기(인코더)는 달라지는 것이 없다. 화면이 프레임을 몇 개씩 가져가든 `frame(seq)` 는 번호
/// 하나에 프레임 하나를 낼 뿐이고, 받는 쪽도 순서와 개수에 무관하다.
///
/// 16 MiB 를 상한으로 둔 것은 "여기까지가 쓸 만하다" 가 아니라 **"여기부터는 확실히 아니다"**
/// 라는 선이다. 컨테이너는 어차피 텍스트라서 클립보드(64 MiB)나 메일 첨부가 몇 초면 끝난다 —
/// QR 이 이기는 경우는 물리적으로 망이 끊긴 자리뿐이고, 화면은 예상 시간을 그대로 적어 준다.
pub const MAX_SOURCE_BYTES: usize = 16 * 1024 * 1024;

/// 로버스트 솔리톤 분포의 `c`. 작을수록 차수 1(= 그냥 블록 하나)이 자주 나온다.
///
/// 디코딩은 차수 1 프레임에서만 시작할 수 있으므로 초반에 몇 개는 반드시 나와야 한다.
/// 0.03 은 K = 100 에서 스파이크가 약 6% 를 차지하는 값이고, 실측 오버헤드가 5~8% 다.
const SOLITON_C: f64 = 0.03;

/// 디코딩 실패 허용 확률. 스파이크의 위치(`K/R`)를 정한다.
const SOLITON_DELTA: f64 = 0.05;

// ---------------------------------------------------------------- 난수

/// 프레임 번호에서 블록 선택을 만들어 내는 결정적 PRNG.
///
/// **이 구현이 규격이다.** `mobile/www/stream.js` 의 같은 이름 함수와 비트 단위로 같아야 한다.
/// 그래서 32비트 연산만 쓴다 — 자바스크립트에는 64비트 정수가 없고, `Math.imul` 이 아래
/// `wrapping_mul` 과 정확히 같은 결과를 낸다.
///
/// 알고리즘은 32비트 xorshift 에 곱셈 한 번을 얹은 것이다. 암호용이 아니다 — 필요한 성질은
/// "두 언어에서 같다" 와 "블록이 골고루 섞인다" 뿐이고, 실제 기밀성은 컨테이너 안쪽의
/// AES-GCM 이 이미 지고 있다.
pub struct Rng(u32);

impl Rng {
    /// 프레임 번호를 **섞어서** 상태로 삼는다.
    ///
    /// 시드를 그대로 쓰면 안 된다. xorshift 는 이웃한 시드에서 이웃한 첫 출력을 낸다 —
    /// 프레임 번호는 0, 1, 2, … 로 붙으므로 첫 난수가 계단처럼 늘어서고, 그 첫 난수가 곧
    /// **차수**다. 그러면 초반에 차수 1 프레임이 거의 나오지 않고 디코딩이 시작조차 못 한다
    /// (`degree_one_frames_appear_early` 가 이걸 잡는다).
    ///
    /// 그래서 MurmurHash3 의 마무리 함수(fmix32)를 한 번 통과시킨다. 32비트 연산뿐이라
    /// `Math.imul` 로 그대로 옮겨진다.
    pub fn new(seed: u32) -> Self {
        let mut h = seed;
        h ^= h >> 16;
        h = h.wrapping_mul(0x85EB_CA6B);
        h ^= h >> 13;
        h = h.wrapping_mul(0xC2B2_AE35);
        h ^= h >> 16;
        // xorshift 는 상태 0에서 영원히 0을 낸다.
        Self(if h == 0 { 0x9E37_79B9 } else { h })
    }

    pub fn next_u32(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        // 곱셈으로 하위 비트를 섞는다. xorshift 만으로는 낮은 자리의 주기가 짧다.
        x.wrapping_mul(0x2545_F491)
    }

    /// `0 <= n < bound`. 나머지 연산의 치우침을 버림으로 없앤다 (양쪽이 같아야 하므로 이
    /// 방식까지 규격이다).
    pub fn below(&mut self, bound: u32) -> u32 {
        debug_assert!(bound > 0);
        if bound == 1 {
            return 0;
        }
        // 받아들일 수 있는 최대 구간. 이 위의 값은 버리고 다시 뽑는다.
        let limit = u32::MAX - (u32::MAX % bound) - 1;
        loop {
            let value = self.next_u32();
            if value <= limit {
                return value % bound;
            }
        }
    }

    /// `[0, 1)` 실수. 상위 24비트만 써서 두 언어의 부동소수 반올림 차이를 피한다.
    pub fn unit(&mut self) -> f64 {
        f64::from(self.next_u32() >> 8) / f64::from(1u32 << 24)
    }
}

// ---------------------------------------------------------------- 분포

/// 로버스트 솔리톤 분포의 누적표. 차수 `d` 를 뽑는 데 쓴다.
///
/// 인코더와 디코더가 **같은 표**를 만들어야 한다. 부동소수 연산 순서까지 같아야 하므로
/// `stream.js` 는 이 함수를 그대로 옮겨 적는다.
fn soliton_cdf(blocks: usize) -> Vec<f64> {
    let k = blocks as f64;
    // 스파이크 위치. R 개 근처의 차수를 도드라지게 해 디코딩이 멈추지 않게 한다.
    let r = SOLITON_C * (k / SOLITON_DELTA).ln().max(1.0) * k.sqrt();
    let spike = if r >= 1.0 {
        (k / r).round().max(1.0)
    } else {
        k
    };

    let mut weights = Vec::with_capacity(blocks);
    for d in 1..=blocks {
        let df = d as f64;
        // 이상적 솔리톤.
        let ideal = if d == 1 {
            1.0 / k
        } else {
            1.0 / (df * (df - 1.0))
        };
        // 로버스트 항.
        let extra = if df < spike {
            r / (df * k)
        } else if (df - spike).abs() < 0.5 {
            r * (r / SOLITON_DELTA).ln() / k
        } else {
            0.0
        };
        weights.push(ideal + extra);
    }

    let total: f64 = weights.iter().sum();
    let mut cdf = Vec::with_capacity(blocks);
    let mut running = 0.0;
    for weight in weights {
        running += weight / total;
        cdf.push(running);
    }
    // 마지막은 정확히 1로 맞춘다. 누적 오차 때문에 0.9999… 로 끝나면 뽑기가 범위를 벗어난다.
    if let Some(last) = cdf.last_mut() {
        *last = 1.0;
    }
    cdf
}

/// 프레임 번호에서 이 프레임이 담을 소스 블록 번호들을 정한다.
///
/// **인코더와 디코더가 부르는 유일한 공통 함수다.** 결과가 어긋나면 복원이 조용히 실패한다.
pub fn block_indices(seq: u32, blocks: usize, cdf: &[f64]) -> Vec<usize> {
    if blocks == 0 {
        return Vec::new();
    }
    let mut rng = Rng::new(seq);

    let pick = rng.unit();
    let mut degree = cdf
        .iter()
        .position(|bound| pick < *bound)
        .unwrap_or(blocks - 1)
        + 1;
    degree = degree.min(blocks);

    // 중복 없이 `degree` 개를 뽑는다. 같은 블록을 두 번 XOR 하면 서로 지워져 차수가 달라진다.
    let mut chosen: Vec<usize> = Vec::with_capacity(degree);
    while chosen.len() < degree {
        let candidate = rng.below(blocks as u32) as usize;
        if !chosen.contains(&candidate) {
            chosen.push(candidate);
        }
    }
    chosen.sort_unstable();
    chosen
}

// ---------------------------------------------------------------- 인코더

/// 스트림 하나. 소스 블록을 들고 있다가 프레임을 무한히 찍어 낸다.
pub struct Encoder {
    /// 소스 바이트. 마지막 블록은 0으로 채워 길이를 맞춘다.
    padded: Vec<u8>,
    block_size: usize,
    blocks: usize,
    total_bytes: usize,
    fingerprint: [u8; FINGERPRINT_LEN],
    cdf: Vec<f64>,
}

/// 화면이 알아야 하는 스트림의 모양.
#[derive(Debug, Serialize, Clone)]
pub struct StreamInfo {
    pub total_bytes: usize,
    pub block_size: usize,
    pub blocks: usize,
    /// 16진수 8바이트. 화면이 "같은 묶음인지" 를 보여 줄 때 쓴다.
    pub fingerprint: String,
}

impl Encoder {
    /// `block_size` 는 심볼 하나에 들어갈 payload 크기다. 호출자가 QR 규격에서 정해 준다.
    pub fn new(source: &[u8], block_size: usize) -> Result<Self> {
        if source.is_empty() {
            return Err(Error::Internal("보낼 내용이 없습니다".to_string()));
        }
        if source.len() > MAX_SOURCE_BYTES {
            return Err(Error::Internal(format!(
                "QR 스트림으로 보내기에는 너무 큽니다 ({} MiB 까지)",
                MAX_SOURCE_BYTES / (1024 * 1024)
            )));
        }
        let block_size = block_size.max(1);
        let blocks = source.len().div_ceil(block_size);

        let mut padded = source.to_vec();
        padded.resize(blocks * block_size, 0);

        let digest = Sha256::digest(source);
        let mut fingerprint = [0u8; FINGERPRINT_LEN];
        fingerprint.copy_from_slice(&digest[..FINGERPRINT_LEN]);

        Ok(Self {
            padded,
            block_size,
            blocks,
            total_bytes: source.len(),
            fingerprint,
            cdf: soliton_cdf(blocks),
        })
    }

    pub fn info(&self) -> StreamInfo {
        StreamInfo {
            total_bytes: self.total_bytes,
            block_size: self.block_size,
            blocks: self.blocks,
            fingerprint: self
                .fingerprint
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect(),
        }
    }

    pub fn blocks(&self) -> usize {
        self.blocks
    }

    /// `seq` 번째 프레임의 바이트열. 헤더 + XOR 된 payload.
    ///
    /// | offset | size | 내용 |
    /// | --- | --- | --- |
    /// | 0 | 4 | 매직 `PQS1` |
    /// | 4 | 8 | 컨테이너 지문 (SHA-256 앞 8바이트) |
    /// | 12 | 4 | 컨테이너 전체 바이트 수 (u32 LE) |
    /// | 16 | 2 | 블록 크기 (u16 LE) |
    /// | 18 | 4 | 프레임 번호 = PRNG 시드 (u32 LE) |
    /// | 22 | 2 | payload CRC-16/IBM (u16 LE) |
    ///
    /// 블록 수는 싣지 않는다. `ceil(total_bytes / block_size)` 로 양쪽이 같은 값을 계산하므로,
    /// 실어 보내면 어긋날 수 있는 자리만 하나 늘어난다.
    pub fn frame(&self, seq: u32) -> Vec<u8> {
        let mut payload = vec![0u8; self.block_size];
        for index in block_indices(seq, self.blocks, &self.cdf) {
            let at = index * self.block_size;
            for (out, byte) in payload
                .iter_mut()
                .zip(&self.padded[at..at + self.block_size])
            {
                *out ^= byte;
            }
        }

        let mut out = Vec::with_capacity(HEADER_LEN + self.block_size);
        out.extend_from_slice(&MAGIC);
        out.extend_from_slice(&self.fingerprint);
        out.extend_from_slice(&(self.total_bytes as u32).to_le_bytes());
        out.extend_from_slice(&(self.block_size as u16).to_le_bytes());
        out.extend_from_slice(&seq.to_le_bytes());
        out.extend_from_slice(&crc16(&payload).to_le_bytes());
        debug_assert_eq!(out.len(), HEADER_LEN);
        out.extend_from_slice(&payload);
        out
    }
}

/// CRC-16/IBM (다항식 0xA001, 초기값 0).
///
/// QR 자체가 Reed-Solomon 으로 지켜 주지만, 한 프레임이라도 잘못 들어가면 XOR 이 오염돼
/// **전체 복원이 실패한다.** 그때는 어느 프레임이 문제였는지 알 방법이 없다. 2바이트로
/// 그 경우를 없앤다.
pub fn crc16(bytes: &[u8]) -> u16 {
    let mut crc: u16 = 0;
    for byte in bytes {
        crc ^= u16::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xA001
            } else {
                crc >> 1
            };
        }
    }
    crc
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 잘 안 눌리는 바이트열. 실제 컨테이너처럼 골고루 섞여야 분포 판단이 헐거워지지 않는다.
    fn source(len: usize) -> Vec<u8> {
        (0..len).map(|i| ((i * 251 + i / 97) % 256) as u8).collect()
    }

    /// 순수 자바스크립트 디코더가 할 일을 그대로 흉내 낸다 — 벨리프 프로퍼게이션.
    ///
    /// 여기서 도는 것이 `stream.js` 가 도는 것과 같아야 한다. 다르면 픽스처 계약 테스트가
    /// 잡는다.
    fn decode(
        frames: &[Vec<u8>],
        blocks: usize,
        block_size: usize,
        total: usize,
    ) -> Option<Vec<u8>> {
        let cdf = soliton_cdf(blocks);
        let mut solved: Vec<Option<Vec<u8>>> = vec![None; blocks];
        let mut pending: Vec<(Vec<usize>, Vec<u8>)> = Vec::new();

        for frame in frames {
            let seq = u32::from_le_bytes(frame[18..22].try_into().unwrap());
            pending.push((
                block_indices(seq, blocks, &cdf),
                frame[HEADER_LEN..].to_vec(),
            ));

            // 풀 수 있는 것이 없을 때까지 계속 훑는다.
            loop {
                let mut moved = false;
                for entry in pending.iter_mut() {
                    entry.0.retain(|index| {
                        if let Some(known) = &solved[*index] {
                            for (out, byte) in entry.1.iter_mut().zip(known) {
                                *out ^= byte;
                            }
                            moved = true;
                            false
                        } else {
                            true
                        }
                    });
                }
                for entry in pending.iter() {
                    if entry.0.len() == 1 && solved[entry.0[0]].is_none() {
                        solved[entry.0[0]] = Some(entry.1.clone());
                        moved = true;
                    }
                }
                pending.retain(|entry| entry.0.len() > 1);
                if !moved {
                    break;
                }
            }

            if solved.iter().all(Option::is_some) {
                let mut out = Vec::with_capacity(blocks * block_size);
                for block in solved.iter().flatten() {
                    out.extend_from_slice(block);
                }
                out.truncate(total);
                return Some(out);
            }
        }
        None
    }

    #[test]
    fn the_rng_is_deterministic_and_does_not_get_stuck() {
        let mut a = Rng::new(1);
        let mut b = Rng::new(1);
        for _ in 0..1000 {
            assert_eq!(a.next_u32(), b.next_u32());
        }
        // 시드 0은 xorshift 가 영원히 0을 낸다. 다른 값으로 바꿔 둔다.
        let mut zero = Rng::new(0);
        assert_ne!(zero.next_u32(), 0);
    }

    #[test]
    fn neighbouring_seeds_do_not_give_neighbouring_values() {
        // 프레임 번호는 0, 1, 2, … 로 붙는다. 시드를 섞지 않으면 첫 난수가 계단처럼 늘어서고,
        // 그 첫 난수가 곧 차수라서 초반에 차수 1이 나오지 않는다 — 디코딩이 시작을 못 한다.
        let first: Vec<f64> = (0..64u32).map(|seq| Rng::new(seq).unit()).collect();

        // 계단이면 이웃 간 차이가 거의 일정하다. 흩어져 있으면 부호가 자주 바뀐다.
        let flips = first
            .windows(2)
            .zip(first.windows(2).skip(1))
            .filter(|(a, b)| (a[1] - a[0]).is_sign_positive() != (b[1] - b[0]).is_sign_positive())
            .count();
        assert!(
            flips > 15,
            "이웃한 시드가 계단처럼 늘어선다: {flips}번만 방향이 바뀌었다"
        );

        // 그리고 [0,1) 을 고르게 덮어야 한다.
        for lane in 0..4 {
            let bound = f64::from(lane) / 4.0..f64::from(lane + 1) / 4.0;
            assert!(
                first.iter().any(|v| bound.contains(v)),
                "{lane}번째 구간이 비었다"
            );
        }
    }

    #[test]
    fn below_stays_in_range_and_covers_it() {
        let mut rng = Rng::new(7);
        let mut seen = [false; 5];
        for _ in 0..500 {
            let value = rng.below(5) as usize;
            assert!(value < 5);
            seen[value] = true;
        }
        assert!(seen.iter().all(|hit| *hit), "한쪽으로 치우쳤다");
        // bound 1은 언제나 0이고 난수를 쓰지 않는다.
        assert_eq!(Rng::new(3).below(1), 0);
    }

    #[test]
    fn unit_stays_below_one() {
        let mut rng = Rng::new(11);
        for _ in 0..1000 {
            let value = rng.unit();
            assert!((0.0..1.0).contains(&value), "{value}");
        }
    }

    #[test]
    fn block_choices_are_distinct_and_in_range() {
        let cdf = soliton_cdf(40);
        for seq in 0..500u32 {
            let picked = block_indices(seq, 40, &cdf);
            assert!(!picked.is_empty());
            assert!(picked.len() <= 40);
            assert!(picked.iter().all(|i| *i < 40));
            let mut sorted = picked.clone();
            sorted.dedup();
            assert_eq!(
                sorted.len(),
                picked.len(),
                "같은 블록을 두 번 골랐다: {picked:?}"
            );
            // 정렬해 둬야 두 언어의 결과를 그대로 비교할 수 있다.
            assert!(picked.windows(2).all(|w| w[0] < w[1]));
        }
    }

    #[test]
    fn degree_one_frames_appear_early() {
        // 디코딩은 차수 1 프레임에서만 시작한다. 초반에 하나도 없으면 영원히 멈춰 있다.
        let cdf = soliton_cdf(60);
        let ones = (0..120u32)
            .filter(|seq| block_indices(*seq, 60, &cdf).len() == 1)
            .count();
        assert!(ones >= 3, "차수 1이 {ones}개뿐이다");
    }

    #[test]
    fn a_stream_round_trips_with_modest_overhead() {
        for len in [1usize, 100, 5_000, 50_000] {
            let payload = source(len);
            let encoder = Encoder::new(&payload, 512).unwrap();
            let blocks = encoder.blocks();

            let frames: Vec<Vec<u8>> = (0..(blocks * 3 + 40) as u32)
                .map(|s| encoder.frame(s))
                .collect();
            let out = decode(&frames, blocks, 512, len).expect("복원돼야 한다");
            assert_eq!(out, payload, "len={len}");
        }
    }

    #[test]
    fn a_stream_survives_losing_a_third_of_the_frames() {
        // 파운틴 부호의 존재 이유다. 놓친 프레임을 되찾으러 가지 않아도 된다.
        let payload = source(20_000);
        let encoder = Encoder::new(&payload, 512).unwrap();
        let blocks = encoder.blocks();

        let frames: Vec<Vec<u8>> = (0..(blocks * 4 + 60) as u32)
            .filter(|seq| seq % 3 != 0)
            .map(|seq| encoder.frame(seq))
            .collect();
        assert_eq!(decode(&frames, blocks, 512, 20_000).unwrap(), payload);
    }

    #[test]
    fn frames_carry_the_header_the_phone_expects() {
        let payload = source(3_000);
        let encoder = Encoder::new(&payload, 512).unwrap();
        let frame = encoder.frame(42);

        assert_eq!(&frame[0..4], &MAGIC);
        assert_eq!(&frame[4..12], &Sha256::digest(&payload)[..FINGERPRINT_LEN]);
        assert_eq!(u32::from_le_bytes(frame[12..16].try_into().unwrap()), 3_000);
        assert_eq!(u16::from_le_bytes(frame[16..18].try_into().unwrap()), 512);
        assert_eq!(u32::from_le_bytes(frame[18..22].try_into().unwrap()), 42);
        assert_eq!(
            u16::from_le_bytes(frame[22..24].try_into().unwrap()),
            crc16(&frame[HEADER_LEN..])
        );
        assert_eq!(frame.len(), HEADER_LEN + 512);
    }

    #[test]
    fn different_sources_get_different_fingerprints() {
        // 다른 묶음의 프레임이 섞이는 것을 폰이 이걸로 걸러 낸다.
        let a = Encoder::new(&source(1_000), 256).unwrap();
        let b = Encoder::new(&source(1_001), 256).unwrap();
        assert_ne!(a.info().fingerprint, b.info().fingerprint);
        assert_eq!(a.info().fingerprint.len(), FINGERPRINT_LEN * 2);
    }

    #[test]
    fn refuses_nothing_and_refuses_too_much() {
        assert!(Encoder::new(&[], 512).is_err());
        assert!(Encoder::new(&vec![0u8; MAX_SOURCE_BYTES + 1], 512).is_err());
    }

    #[test]
    fn crc_catches_a_single_flipped_bit() {
        let clean = source(512);
        let mut dirty = clean.clone();
        dirty[100] ^= 0x01;
        assert_ne!(crc16(&clean), crc16(&dirty));
    }
}
