//! 프론트엔드로 그대로 넘길 수 있는 에러 타입.
//!
//! `Serialize` 는 `{ code, message }` 형태로 직렬화한다. `code` 는 JS 쪽에서 분기용으로 쓰고
//! `message` 는 이미 한국어로 완성된 사용자용 문장이다.

use serde::Serialize;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("암호화 키가 올바르지 않습니다.")]
    WrongKey,

    #[error("이 파일은 이 프로그램으로 묶은 파일이 아닙니다.")]
    NotContainer,

    #[error("파일이 손상되었거나 중간에 잘렸습니다.")]
    Corrupted,

    #[error("텍스트가 온전하지 않습니다. 시작·끝 표시 줄까지 빠짐없이 복사했는지 확인해 주세요.")]
    ArmorDamaged,

    #[error("더 새로운 버전({0})으로 묶인 파일입니다. 프로그램을 업데이트해 주세요.")]
    UnsupportedVersion(u16),

    #[error("안전하지 않은 경로가 들어 있습니다: {0}")]
    PathEscape(String),

    #[error("암호화 키를 입력해 주세요.")]
    EmptyKey,

    #[error("묶을 파일을 먼저 추가해 주세요.")]
    NothingToPack,

    #[error("풀어낼 위치를 지정해 주세요.")]
    NoDestination,

    #[error("{0}")]
    Io(String),

    #[error("키를 만드는 데 실패했습니다: {0}")]
    Kdf(String),

    #[error("내부 오류가 발생했습니다: {0}")]
    Internal(String),
}

impl Error {
    /// JS 쪽 분기용 안정 코드. 메시지 문구가 바뀌어도 이 값은 유지한다.
    pub fn code(&self) -> &'static str {
        match self {
            Error::WrongKey => "WrongKey",
            Error::NotContainer => "NotContainer",
            Error::Corrupted => "Corrupted",
            Error::ArmorDamaged => "ArmorDamaged",
            Error::UnsupportedVersion(_) => "UnsupportedVersion",
            Error::PathEscape(_) => "PathEscape",
            Error::EmptyKey => "EmptyKey",
            Error::NothingToPack => "NothingToPack",
            Error::NoDestination => "NoDestination",
            Error::Io(_) => "Io",
            Error::Kdf(_) => "Kdf",
            Error::Internal(_) => "Internal",
        }
    }

    /// 아래 계층에서 올라온 io 에러에 어디서 났는지 설명을 덧붙인다.
    ///
    /// 단, 봉투에 담겨 올라온 우리 에러는 그대로 통과시킨다. 어댑터를 여러 겹 쌓았기 때문에
    /// 그냥 감싸면 "파일을 읽을 수 없습니다: 텍스트가 온전하지 않습니다" 처럼 진단이 두 번
    /// 포개지고, `code` 도 실제 원인이 아닌 `Io` 로 뭉개져 UI 가 분기할 수 없다.
    pub fn io(context: &str, e: std::io::Error) -> Self {
        match Error::recover(e) {
            Error::Io(message) => Error::Io(format!("{context}: {message}")),
            // 아래 계층이 이미 더 정확한 진단을 올려보냈다.
            precise => precise,
        }
    }

    /// 이 에러를 `io::Error` 안에 넣는다.
    ///
    /// 컨테이너 리더는 `Read` 를 구현하고 그 위에 zstd 디코더가 올라간다. 중간 계층은 `io::Error`
    /// 밖에 통과시키지 못하므로, 원래 종류를 잃지 않으려면 봉투에 넣어 보냈다가 [`Error::recover`]
    /// 로 다시 꺼내야 한다. 이게 없으면 "키가 틀렸다" 가 "입출력 오류" 로 뭉개진다.
    pub fn into_io(self) -> std::io::Error {
        std::io::Error::new(std::io::ErrorKind::InvalidData, Wrapped(self))
    }

    /// io 계층을 통과해 돌아온 에러에서 원래 종류를 복원한다.
    pub fn recover(e: std::io::Error) -> Error {
        if e.get_ref().is_some_and(|r| r.is::<Wrapped>()) {
            match e.into_inner().expect("검사에서 Some 확인됨").downcast::<Wrapped>() {
                Ok(w) => return w.0,
                Err(other) => return Error::Io(other.to_string()),
            }
        }
        // 프레임 도중 EOF 는 파일이 잘렸다는 뜻이다.
        if e.kind() == std::io::ErrorKind::UnexpectedEof {
            Error::Corrupted
        } else {
            Error::Io(e.to_string())
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::recover(e)
    }
}

/// [`Error::into_io`] 전용 봉투. 외부에 노출할 필요는 없다.
#[derive(Debug)]
struct Wrapped(Error);

impl std::fmt::Display for Wrapped {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl std::error::Error for Wrapped {}

impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct Wire<'a> {
            code: &'a str,
            message: String,
        }
        Wire {
            code: self.code(),
            message: self.to_string(),
        }
        .serialize(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn survives_a_round_trip_through_io_error() {
        let io = Error::WrongKey.into_io();
        assert!(matches!(Error::recover(io), Error::WrongKey));

        let io = Error::PathEscape("..\\evil".into()).into_io();
        match Error::recover(io) {
            Error::PathEscape(p) => assert_eq!(p, "..\\evil"),
            other => panic!("복원 실패: {other:?}"),
        }
    }

    #[test]
    fn plain_eof_becomes_corrupted() {
        let io = std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "eof");
        assert!(matches!(Error::recover(io), Error::Corrupted));
    }

    #[test]
    fn serializes_with_code_and_message() {
        let json = serde_json::to_string(&Error::WrongKey).unwrap();
        assert!(json.contains("\"code\":\"WrongKey\""));
        assert!(json.contains("올바르지 않습니다"));
    }
}
