//! 컨테이너 안의 경로를 디스크에 쓰기 전에 검사한다.
//!
//! 풀기는 **남이 만든 파일에 적힌 경로대로 디스크에 쓰는** 동작이다. 그래서 컨테이너를 만든 쪽을
//! 신뢰할 수 없다고 보고, 선택한 출력 폴더를 벗어나려는 시도를 전부 막는다. 흔히 zip-slip 이라
//! 부르는 문제이고, 여기에 윈도우 특유의 함정(예약 장치 이름, ADS 콜론, 끝에 붙은 점/공백)까지
//! 같이 처리한다.

use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

/// 윈도우에서 파일 이름으로 쓸 수 없는 장치 이름. 확장자가 붙어도 (`CON.txt`) 여전히 예약이다.
const RESERVED_STEMS: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// 윈도우 파일 이름에 쓸 수 없는 문자. `/` 는 우리 포맷의 구분자라 따로 처리한다.
const FORBIDDEN_CHARS: &[char] = &['<', '>', ':', '"', '|', '?', '*', '\\'];

const MAX_COMPONENT_LEN: usize = 255;

/// 매니페스트의 상대 경로 문자열을 검증해 플랫폼 경로로 바꾼다.
///
/// 입력은 항상 `/` 로 구분된 상대 경로다. 조금이라도 수상하면 통과시키지 않고 거절한다.
pub fn sanitize_rel(rel: &str) -> Result<PathBuf> {
    let reject = |why: &str| Err(Error::PathEscape(format!("{rel} ({why})")));

    if rel.is_empty() {
        return reject("빈 경로");
    }
    if rel.contains('\0') {
        return reject("NUL 문자 포함");
    }
    if rel.starts_with('/') {
        return reject("절대 경로");
    }

    let mut out = PathBuf::new();
    let mut components = 0;

    for part in rel.split('/') {
        if part.is_empty() {
            return reject("빈 경로 조각");
        }
        if part == "." || part == ".." {
            return reject("상대 경로 이동");
        }
        if part.len() > MAX_COMPONENT_LEN {
            return reject("이름이 너무 김");
        }
        if part.chars().any(|c| FORBIDDEN_CHARS.contains(&c)) {
            return reject("사용할 수 없는 문자");
        }
        if part.chars().any(|c| (c as u32) < 0x20) {
            return reject("제어 문자 포함");
        }
        // 윈도우는 끝에 붙은 점/공백을 조용히 떼어내므로 다른 파일을 가리킬 수 있다.
        if part.ends_with('.') || part.ends_with(' ') {
            return reject("끝에 점이나 공백");
        }
        let stem = part.split('.').next().unwrap_or(part).to_ascii_uppercase();
        if RESERVED_STEMS.contains(&stem.as_str()) {
            return reject("예약된 장치 이름");
        }

        out.push(part);
        components += 1;
    }

    if components == 0 {
        return reject("경로 조각 없음");
    }
    Ok(out)
}

/// 출력 폴더 아래의 최종 경로를 만든다.
///
/// [`sanitize_rel`] 이 `..` 와 절대 경로를 이미 막았으므로 문자열만으로는 탈출할 수 없다. 남은
/// 구멍은 심볼릭 링크/정션이다. 우리가 링크를 만들지는 않지만 출력 폴더에 이미 있을 수 있으므로,
/// 경로를 따라가며 실제로 존재하는 조각 중 링크가 있으면 거절한다.
pub fn resolve_under(root: &Path, rel: &str) -> Result<PathBuf> {
    let safe = sanitize_rel(rel)?;
    let full = root.join(&safe);

    let mut probe = root.to_path_buf();
    for component in safe.components() {
        probe.push(component);
        match std::fs::symlink_metadata(&probe) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(Error::PathEscape(format!(
                    "{rel} (경로에 링크가 있음: {})",
                    probe.display()
                )));
            }
            // 아직 없는 조각은 우리가 만들 것이므로 문제없다.
            _ => {}
        }
    }

    Ok(full)
}

/// 여러 원본을 한 컨테이너에 담을 때 최상위 이름이 겹치지 않도록 번호를 붙인다.
///
/// 서로 다른 폴더에서 온 `note.txt` 두 개가 서로를 덮어쓰면 안 된다.
pub fn unique_name(taken: &mut std::collections::HashSet<String>, desired: &str) -> String {
    if taken.insert(desired.to_string()) {
        return desired.to_string();
    }
    let (stem, ext) = match desired.rsplit_once('.') {
        // 앞이 비어 있으면 `.gitignore` 같은 숨김 파일이므로 전체를 stem 으로 본다.
        Some((s, e)) if !s.is_empty() => (s, Some(e)),
        _ => (desired, None),
    };
    for n in 2.. {
        let candidate = match ext {
            Some(e) => format!("{stem} ({n}).{e}"),
            None => format!("{stem} ({n})"),
        };
        if taken.insert(candidate.clone()) {
            return candidate;
        }
    }
    unreachable!("빈 후보가 반드시 나온다")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn is_escape(rel: &str) -> bool {
        matches!(sanitize_rel(rel), Err(Error::PathEscape(_)))
    }

    #[test]
    fn accepts_ordinary_paths() {
        assert_eq!(sanitize_rel("note.txt").unwrap(), PathBuf::from("note.txt"));
        assert_eq!(
            sanitize_rel("proj/src/main.rs").unwrap(),
            PathBuf::from("proj").join("src").join("main.rs")
        );
    }

    #[test]
    fn accepts_korean_and_unicode_names() {
        assert_eq!(
            sanitize_rel("보고서/2026년 계획.xlsx").unwrap(),
            PathBuf::from("보고서").join("2026년 계획.xlsx")
        );
        assert!(sanitize_rel("emoji/🔒.txt").is_ok());
    }

    #[test]
    fn rejects_parent_traversal() {
        assert!(is_escape("../evil.txt"));
        assert!(is_escape("a/../../evil.txt"));
        assert!(is_escape(".."));
        assert!(is_escape("a/./b"));
    }

    #[test]
    fn rejects_absolute_and_drive_paths() {
        assert!(is_escape("/etc/passwd"));
        assert!(is_escape("C:/Windows/System32/evil.dll"));
        // 백슬래시는 구분자로 인정하지 않으므로 조각 안에 있으면 거절한다.
        assert!(is_escape("..\\..\\evil.txt"));
        assert!(is_escape("C:\\Windows\\evil.dll"));
    }

    #[test]
    fn rejects_alternate_data_streams() {
        assert!(is_escape("normal.txt:hidden"));
        assert!(is_escape("a/b:c"));
    }

    #[test]
    fn rejects_windows_reserved_device_names() {
        assert!(is_escape("CON"));
        assert!(is_escape("con"));
        assert!(is_escape("CON.txt"));
        assert!(is_escape("dir/NUL"));
        assert!(is_escape("LPT9.log"));
        // 예약어처럼 보이지만 실제로는 안전한 이름.
        assert!(sanitize_rel("CONSOLE.txt").is_ok());
        assert!(sanitize_rel("COM10.txt").is_ok());
    }

    #[test]
    fn rejects_trailing_dot_or_space() {
        assert!(is_escape("weird."));
        assert!(is_escape("weird "));
        assert!(is_escape("dir./file.txt"));
    }

    #[test]
    fn rejects_control_characters_and_wildcards() {
        assert!(is_escape("bell\u{7}.txt"));
        assert!(is_escape("what?.txt"));
        assert!(is_escape("star*.txt"));
        assert!(is_escape("pipe|.txt"));
    }

    #[test]
    fn rejects_empty_and_nul() {
        assert!(is_escape(""));
        assert!(is_escape("a//b"));
        assert!(is_escape("a\0b"));
    }

    #[test]
    fn resolve_stays_under_root() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let p = resolve_under(root, "sub/file.txt").unwrap();
        assert!(p.starts_with(root));
        assert!(resolve_under(root, "../outside.txt").is_err());
    }

    #[test]
    fn unique_name_numbers_collisions() {
        let mut taken = HashSet::new();
        assert_eq!(unique_name(&mut taken, "note.txt"), "note.txt");
        assert_eq!(unique_name(&mut taken, "note.txt"), "note (2).txt");
        assert_eq!(unique_name(&mut taken, "note.txt"), "note (3).txt");
        assert_eq!(unique_name(&mut taken, "folder"), "folder");
        assert_eq!(unique_name(&mut taken, "folder"), "folder (2)");
        // 숨김 파일은 확장자로 쪼개지 않는다.
        assert_eq!(unique_name(&mut taken, ".gitignore"), ".gitignore");
        assert_eq!(unique_name(&mut taken, ".gitignore"), ".gitignore (2)");
    }
}
