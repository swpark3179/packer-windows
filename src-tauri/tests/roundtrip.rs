//! 압축 + 직렬화 + 암호화 전체 파이프라인을 끝에서 끝까지 검증한다.
//!
//! 단위 테스트는 각 계층을 따로 본다. 여기서는 실제 명령이 쓰는 경로 그대로
//! `pack_to_file` / `unpack_to_dir` 를 불러 디스크에 파일을 만들고 되살린다.

use std::fs;
use std::path::{Path, PathBuf};

use packer_lib::archive::Tick;
use packer_lib::commands::{pack_to_file, pack_to_file_with_qr, unpack_to_dir, ContainerSource};
use packer_lib::error::Error;

fn write_file(path: &Path, contents: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

/// 테스트용 트리를 만든다. 여러 계층, 빈 파일, 빈 폴더, 한글 이름, 이진 데이터를 섞는다.
fn build_tree(root: &Path) {
    write_file(
        &root.join("readme.md"),
        b"# Packer\n\xed\x95\x9c\xea\xb8\x80 \xeb\xb3\xb8\xeb\xac\xb8",
    );
    write_file(
        &root.join("src/main.rs"),
        b"fn main() { println!(\"hi\"); }",
    );
    write_file(&root.join("src/nested/deep/note.txt"), b"deep value");
    write_file(
        &root.join("자료/보고서 2026.csv"),
        "가,나,다\n1,2,3\n".as_bytes(),
    );
    write_file(&root.join("empty.txt"), b"");
    // 압축이 실제로 줄일 수 있는 반복 데이터.
    write_file(
        &root.join("data/repeat.bin"),
        &vec![0xABu8; 3 * 1024 * 1024],
    );
    // 압축이 거의 안 되는 데이터도 섞는다.
    let noise: Vec<u8> = (0..512 * 1024)
        .map(|i| ((i * 2654435761u64 as usize) >> 13) as u8)
        .collect();
    write_file(&root.join("data/noise.bin"), &noise);
    fs::create_dir_all(root.join("빈폴더")).unwrap();
}

/// 두 트리가 완전히 같은지 확인한다 (상대 경로 집합 + 파일 내용).
fn assert_trees_match(expected_root: &Path, actual_root: &Path) {
    let listing = |base: &Path| -> Vec<(String, Option<Vec<u8>>)> {
        let mut out = Vec::new();
        for entry in walkdir_all(base) {
            let rel = entry
                .strip_prefix(base)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            if rel.is_empty() {
                continue;
            }
            let body = if entry.is_file() {
                Some(fs::read(&entry).unwrap())
            } else {
                None
            };
            out.push((rel, body));
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    };

    let expected = listing(expected_root);
    let actual = listing(actual_root);

    let expected_names: Vec<&String> = expected.iter().map(|(n, _)| n).collect();
    let actual_names: Vec<&String> = actual.iter().map(|(n, _)| n).collect();
    assert_eq!(expected_names, actual_names, "트리 구조가 다르다");

    for ((name, want), (_, got)) in expected.iter().zip(actual.iter()) {
        assert_eq!(want, got, "{name} 의 내용이 다르다");
    }
}

fn walkdir_all(base: &Path) -> Vec<PathBuf> {
    let mut out = vec![base.to_path_buf()];
    let mut stack = vec![base.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for entry in rd.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p.clone());
            }
            out.push(p);
        }
    }
    out
}

fn silent(_: Tick) {}

fn from_file(path: &Path) -> ContainerSource {
    ContainerSource::File(path.to_path_buf())
}

fn from_text(text: &str) -> ContainerSource {
    ContainerSource::Text(text.to_string())
}

#[test]
fn packs_and_unpacks_a_real_tree() {
    let work = tempfile::tempdir().unwrap();
    let source = work.path().join("원본");
    build_tree(&source);

    let container = work.path().join("bundle.txt");
    let key = "열려라 참깨 2026!";

    let packed = pack_to_file(std::slice::from_ref(&source), key, &container, &mut silent).unwrap();
    assert!(container.is_file(), "컨테이너가 만들어지지 않았다");
    assert_eq!(packed.file_count, 7);
    assert!(packed.changed.is_empty(), "{:?}", packed.changed);
    assert!(packed.skipped.is_empty(), "{:?}", packed.skipped);

    // 3 MiB 짜리 반복 데이터가 들어 있으니 압축이 됐어야 한다.
    assert!(
        packed.container_bytes < packed.original_bytes,
        "압축이 안 됐다: {} → {}",
        packed.original_bytes,
        packed.container_bytes
    );

    let dest = work.path().join("복원");
    let restored = unpack_to_dir(&from_file(&container), key, &dest, &mut silent).unwrap();

    assert_eq!(restored.file_count, 7);
    assert!(restored.skipped.is_empty(), "{:?}", restored.skipped);
    assert!(
        restored.hash_mismatch.is_empty(),
        "sha256 불일치: {:?}",
        restored.hash_mismatch
    );

    // 최상위 폴더 이름까지 그대로 살아난다.
    assert_trees_match(&source, &dest.join("원본"));
}

#[test]
fn wrong_key_is_reported_and_leaves_nothing_behind() {
    let work = tempfile::tempdir().unwrap();
    let source = work.path().join("s");
    write_file(&source.join("secret.txt"), b"classified");

    let container = work.path().join("b.txt");
    pack_to_file(&[source], "right-key", &container, &mut silent).unwrap();

    let dest = work.path().join("out");
    let err = unpack_to_dir(&from_file(&container), "wrong-key", &dest, &mut silent).unwrap_err();
    assert!(matches!(err, Error::WrongKey), "예상과 다름: {err:?}");

    // 목적지에 부스러기가 남지 않아야 한다 — 임시 폴더까지 정리됐는지 확인한다.
    let leftovers: Vec<_> = fs::read_dir(&dest).unwrap().flatten().collect();
    assert!(
        leftovers.is_empty(),
        "실패 후 남은 항목: {:?}",
        leftovers.iter().map(|e| e.file_name()).collect::<Vec<_>>()
    );
}

/// 여러 파일이 든 컨테이너를 만든다. 일부라도 써진 뒤에 실패하도록 크기를 넉넉히 준다.
fn many_file_container(work: &Path) -> PathBuf {
    let source = work.join("s");
    for i in 0..20 {
        write_file(
            &source.join(format!("f{i}.bin")),
            &vec![i as u8; 200 * 1024],
        );
    }
    let container = work.join("b.txt");
    pack_to_file(&[source], "pw", &container, &mut silent).unwrap();
    container
}

fn assert_destination_is_clean(dest: &Path) {
    let leftovers: Vec<_> = fs::read_dir(dest).unwrap().flatten().collect();
    assert!(
        leftovers.is_empty(),
        "실패 후 남은 항목: {:?}",
        leftovers.iter().map(|e| e.file_name()).collect::<Vec<_>>()
    );
}

#[test]
fn truncated_text_leaves_nothing_behind() {
    let work = tempfile::tempdir().unwrap();
    let container = many_file_container(work.path());

    // 뒤쪽을 잘라낸다 — 끝 표시 줄이 사라진다.
    let text = fs::read_to_string(&container).unwrap();
    fs::write(&container, &text[..text.len() * 2 / 3]).unwrap();

    let dest = work.path().join("out");
    let err = unpack_to_dir(&from_file(&container), "pw", &dest, &mut silent).unwrap_err();
    // 텍스트가 잘린 것은 내용이 상한 것과 다른 문제다. 복사가 덜 됐다고 알려 줘야 한다.
    assert!(matches!(err, Error::ArmorDamaged), "예상과 다름: {err:?}");
    assert_destination_is_clean(&dest);
}

#[test]
fn tampered_text_body_leaves_nothing_behind() {
    let work = tempfile::tempdir().unwrap();
    let container = many_file_container(work.path());

    // 표시 줄은 온전한데 본문의 한 글자만 바뀐 경우. armor 는 통과하고 GCM 인증에서 걸려야 한다.
    let text = fs::read_to_string(&container).unwrap();
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    // 첫 본문 줄들은 헤더(매직 포함)라서 건드리면 "우리 파일이 아니다" 가 된다. 페이로드
    // 한가운데를 골라 암호문만 흐트러 놓는다.
    let body_lines: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, l)| !l.starts_with("-----") && l.len() == 76)
        .map(|(i, _)| i)
        .collect();
    assert!(body_lines.len() > 10, "본문이 너무 짧다");
    let body = body_lines[body_lines.len() / 2];
    let first = lines[body].remove(0);
    lines[body].insert(0, if first == 'A' { 'B' } else { 'A' });
    fs::write(&container, lines.join("\r\n")).unwrap();

    let dest = work.path().join("out");
    let err = unpack_to_dir(&from_file(&container), "pw", &dest, &mut silent).unwrap_err();
    assert!(matches!(err, Error::Corrupted), "예상과 다름: {err:?}");
    assert_destination_is_clean(&dest);
}

#[test]
fn does_not_overwrite_existing_files_in_destination() {
    let work = tempfile::tempdir().unwrap();
    let source = work.path().join("proj");
    write_file(&source.join("a.txt"), b"new content");

    let container = work.path().join("b.txt");
    pack_to_file(&[source], "pw", &container, &mut silent).unwrap();

    // 목적지에 같은 이름의 폴더가 이미 있고 그 안에 소중한 파일이 있다.
    let dest = work.path().join("out");
    write_file(&dest.join("proj/precious.txt"), b"do not lose me");

    let restored = unpack_to_dir(&from_file(&container), "pw", &dest, &mut silent).unwrap();

    assert_eq!(restored.renamed.len(), 1, "{:?}", restored.renamed);
    assert_eq!(
        fs::read(dest.join("proj/precious.txt")).unwrap(),
        b"do not lose me"
    );
    assert_eq!(
        fs::read(dest.join("proj (2)/a.txt")).unwrap(),
        b"new content"
    );
}

#[test]
fn loose_files_land_directly_in_the_destination() {
    let work = tempfile::tempdir().unwrap();
    let a = work.path().join("one.txt");
    let b = work.path().join("two.bin");
    write_file(&a, b"first");
    write_file(&b, &vec![9u8; 5000]);

    let container = work.path().join("b.txt");
    pack_to_file(&[a, b], "pw", &container, &mut silent).unwrap();

    let dest = work.path().join("out");
    unpack_to_dir(&from_file(&container), "pw", &dest, &mut silent).unwrap();

    assert_eq!(fs::read(dest.join("one.txt")).unwrap(), b"first");
    assert_eq!(fs::read(dest.join("two.bin")).unwrap(), vec![9u8; 5000]);
}

#[test]
fn progress_totals_match_the_real_payload() {
    let work = tempfile::tempdir().unwrap();
    let source = work.path().join("s");
    write_file(&source.join("a.bin"), &vec![1u8; 700_000]);
    write_file(&source.join("b.bin"), &vec![2u8; 300_000]);

    let container = work.path().join("b.txt");

    let mut announced_total = 0u64;
    let mut advanced = 0u64;
    pack_to_file(
        std::slice::from_ref(&source),
        "pw",
        &container,
        &mut |t| match t {
            Tick::Total(n) => announced_total = n,
            Tick::Advance { bytes, .. } => advanced += bytes,
        },
    )
    .unwrap();
    assert_eq!(announced_total, 1_000_000);
    assert_eq!(advanced, 1_000_000);

    let dest = work.path().join("out");
    let mut unpack_total = 0u64;
    let mut unpack_advanced = 0u64;
    unpack_to_dir(&from_file(&container), "pw", &dest, &mut |t| match t {
        Tick::Total(n) => unpack_total = n,
        Tick::Advance { bytes, .. } => unpack_advanced += bytes,
    })
    .unwrap();
    assert_eq!(unpack_total, 1_000_000);
    assert_eq!(unpack_advanced, 1_000_000);
}

#[test]
fn empty_key_is_rejected_on_both_sides() {
    let work = tempfile::tempdir().unwrap();
    let source = work.path().join("s");
    write_file(&source.join("a.txt"), b"x");
    let container = work.path().join("b.txt");

    let err = pack_to_file(std::slice::from_ref(&source), "", &container, &mut silent).unwrap_err();
    assert!(matches!(err, Error::EmptyKey), "예상과 다름: {err:?}");

    pack_to_file(&[source], "pw", &container, &mut silent).unwrap();
    let err = unpack_to_dir(
        &from_file(&container),
        "",
        &work.path().join("out"),
        &mut silent,
    )
    .unwrap_err();
    assert!(matches!(err, Error::EmptyKey), "예상과 다름: {err:?}");
}

#[test]
fn rejects_files_that_are_not_containers() {
    let work = tempfile::tempdir().unwrap();
    let not_ours = work.path().join("photo.jpg");
    fs::write(&not_ours, vec![0xFFu8; 4096]).unwrap();

    let err = unpack_to_dir(
        &from_file(&not_ours),
        "pw",
        &work.path().join("out"),
        &mut silent,
    )
    .unwrap_err();
    assert!(matches!(err, Error::NotContainer), "예상과 다름: {err:?}");
}

/// 100 MB 를 넘겨 청크 경로를 여러 번 밟는다. 시간이 걸리므로 `--ignored` 로만 돈다.
#[test]
#[ignore = "느림 — cargo test -- --ignored 로 실행"]
fn handles_a_large_file() {
    let work = tempfile::tempdir().unwrap();
    let source = work.path().join("big");
    // 120 MiB. 완전 반복은 아니고 압축은 되는 패턴.
    let chunk: Vec<u8> = (0..1024 * 1024).map(|i| (i % 97) as u8).collect();
    fs::create_dir_all(&source).unwrap();
    {
        use std::io::Write as _;
        let mut f = std::io::BufWriter::new(fs::File::create(source.join("big.bin")).unwrap());
        for _ in 0..120 {
            f.write_all(&chunk).unwrap();
        }
        f.flush().unwrap();
    }

    let container = work.path().join("big.txt");
    let packed =
        pack_to_file(std::slice::from_ref(&source), "pw", &container, &mut silent).unwrap();
    assert_eq!(packed.original_bytes, 120 * 1024 * 1024);

    let dest = work.path().join("out");
    let restored = unpack_to_dir(&from_file(&container), "pw", &dest, &mut silent).unwrap();
    assert_eq!(restored.total_bytes, 120 * 1024 * 1024);
    assert!(restored.hash_mismatch.is_empty());
    assert_trees_match(&source, &dest.join("big"));
}

// ---------------------------------------------------------------- 텍스트 형태

/// 저장된 결과가 실제로 "텍스트 에디터에 붙일 수 있는" 것인지 확인한다.
#[test]
fn output_is_copy_pasteable_text() {
    let work = tempfile::tempdir().unwrap();
    let source = work.path().join("s");
    write_file(&source.join("메모.txt"), "한글 내용".as_bytes());
    write_file(&source.join("blob.bin"), &[0u8, 1, 2, 255, 254, 128]);

    let container = work.path().join("bundle.txt");
    pack_to_file(
        std::slice::from_ref(&source),
        "pw123456",
        &container,
        &mut silent,
    )
    .unwrap();

    // 1) UTF-8 텍스트로 읽힌다 (바이너리라면 여기서 실패한다).
    let text = fs::read_to_string(&container).expect("텍스트로 읽히지 않는다");

    // 2) 시작·끝 표시로 감싸여 있다.
    assert!(text.starts_with("-----BEGIN PACKER CONTAINER-----"));
    assert!(text.trim_end().ends_with("-----END PACKER CONTAINER-----"));

    // 3) 에디터가 손대지 않을 글자만 들어 있다 — 제어 문자나 NUL 이 없어야 한다.
    for ch in text.chars() {
        assert!(
            // 시작·끝 표시 줄에는 공백이 정상적으로 들어간다.
            ch.is_ascii_graphic() || ch == ' ' || ch == '\r' || ch == '\n',
            "텍스트에 쓸 수 없는 글자: {ch:?}"
        );
    }

    // 4) 줄 길이가 적당해서 어디에 붙여도 접히지 않는다.
    for line in text.lines() {
        assert!(line.len() <= 76, "너무 긴 줄: {}", line.len());
    }
}

#[test]
fn unpacks_from_pasted_text() {
    let work = tempfile::tempdir().unwrap();
    let source = work.path().join("원본");
    build_tree(&source);

    let container = work.path().join("bundle.txt");
    let key = "열려라 참깨 2026!";
    pack_to_file(std::slice::from_ref(&source), key, &container, &mut silent).unwrap();

    // 사용자가 파일을 열어 전체를 복사해 붙여넣은 상황.
    let pasted = fs::read_to_string(&container).unwrap();

    let dest = work.path().join("복원");
    let restored = unpack_to_dir(&from_text(&pasted), key, &dest, &mut silent).unwrap();

    assert_eq!(restored.file_count, 7);
    assert!(restored.hash_mismatch.is_empty());
    assert_trees_match(&source, &dest.join("원본"));
}

#[test]
fn unpacks_from_text_pasted_into_a_message() {
    let work = tempfile::tempdir().unwrap();
    let source = work.path().join("s");
    write_file(&source.join("note.txt"), b"hello from a chat message");

    let container = work.path().join("bundle.txt");
    pack_to_file(
        std::slice::from_ref(&source),
        "pw123456",
        &container,
        &mut silent,
    )
    .unwrap();

    // 메일이나 메신저로 오갈 때 앞뒤에 사람 말이 붙고 줄바꿈이 LF 로 바뀌는 일이 흔하다.
    let body = fs::read_to_string(&container)
        .unwrap()
        .replace("\r\n", "\n");
    let messy = format!("안녕하세요!\n아래 내용 풀어 보세요.\n\n{body}\n\n감사합니다.\n");

    let dest = work.path().join("out");
    unpack_to_dir(&from_text(&messy), "pw123456", &dest, &mut silent).unwrap();
    assert_eq!(
        fs::read(dest.join("s/note.txt")).unwrap(),
        b"hello from a chat message"
    );
}

#[test]
fn pack_hands_back_text_ready_to_copy() {
    let work = tempfile::tempdir().unwrap();
    let source = work.path().join("s");
    write_file(&source.join("a.txt"), b"small enough to preview");

    let container = work.path().join("bundle.txt");
    let packed = pack_to_file(
        std::slice::from_ref(&source),
        "pw123456",
        &container,
        &mut silent,
    )
    .unwrap();

    // 작은 결과물은 화면에 바로 띄울 수 있게 텍스트를 함께 돌려준다.
    assert!(!packed.preview_omitted);
    let preview = packed.preview.expect("미리보기 텍스트가 없다");
    assert_eq!(preview, fs::read_to_string(&container).unwrap());

    // 그 텍스트만으로 풀 수 있어야 한다.
    let dest = work.path().join("out");
    unpack_to_dir(&from_text(&preview), "pw123456", &dest, &mut silent).unwrap();
    assert_eq!(
        fs::read(dest.join("s/a.txt")).unwrap(),
        b"small enough to preview"
    );
}

#[test]
fn rejects_plain_text_that_is_not_ours() {
    let work = tempfile::tempdir().unwrap();
    let err = unpack_to_dir(
        &from_text("그냥 평범한 메모입니다.\n두 번째 줄.\n"),
        "pw123456",
        &work.path().join("out"),
        &mut silent,
    )
    .unwrap_err();
    assert!(matches!(err, Error::NotContainer), "예상과 다름: {err:?}");
}

#[test]
fn reports_text_that_was_copied_incompletely() {
    let work = tempfile::tempdir().unwrap();
    let source = work.path().join("s");
    write_file(&source.join("a.bin"), &vec![3u8; 8192]);

    let container = work.path().join("bundle.txt");
    pack_to_file(
        std::slice::from_ref(&source),
        "pw123456",
        &container,
        &mut silent,
    )
    .unwrap();

    // 끝 표시 줄까지 못 긁어 온 흔한 실수.
    let full = fs::read_to_string(&container).unwrap();
    let half = &full[..full.len() / 2];

    let err = unpack_to_dir(
        &from_text(half),
        "pw123456",
        &work.path().join("out"),
        &mut silent,
    )
    .unwrap_err();
    assert!(matches!(err, Error::ArmorDamaged), "예상과 다름: {err:?}");
}

#[test]
fn wrong_key_on_pasted_text_is_still_reported_precisely() {
    let work = tempfile::tempdir().unwrap();
    let source = work.path().join("s");
    write_file(&source.join("a.txt"), b"secret");

    let container = work.path().join("bundle.txt");
    pack_to_file(
        std::slice::from_ref(&source),
        "right-key",
        &container,
        &mut silent,
    )
    .unwrap();
    let pasted = fs::read_to_string(&container).unwrap();

    let err = unpack_to_dir(
        &from_text(&pasted),
        "wrong-key",
        &work.path().join("out"),
        &mut silent,
    )
    .unwrap_err();
    assert!(matches!(err, Error::WrongKey), "예상과 다름: {err:?}");
}

/// 텍스트로 바뀌기 전 버전이 만든 원시 바이너리 컨테이너도 계속 읽을 수 있어야 한다.
#[test]
fn still_reads_a_raw_binary_container() {
    use packer_lib::armor::ArmorReader;
    use std::io::{BufReader, Read as _};

    let work = tempfile::tempdir().unwrap();
    let source = work.path().join("s");
    write_file(&source.join("legacy.txt"), b"packed by the old build");

    let armored = work.path().join("bundle.txt");
    pack_to_file(
        std::slice::from_ref(&source),
        "pw123456",
        &armored,
        &mut silent,
    )
    .unwrap();

    // armor 를 벗겨 옛 형식(원시 바이너리)을 그대로 만들어 낸다.
    let mut raw = Vec::new();
    ArmorReader::new(BufReader::new(fs::File::open(&armored).unwrap()))
        .read_to_end(&mut raw)
        .unwrap();
    assert!(raw.starts_with(b"FSXPACK1"), "매직이 보이지 않는다");

    let legacy = work.path().join("legacy.fsx");
    fs::write(&legacy, &raw).unwrap();

    let dest = work.path().join("out");
    unpack_to_dir(&from_file(&legacy), "pw123456", &dest, &mut silent).unwrap();
    assert_eq!(
        fs::read(dest.join("s/legacy.txt")).unwrap(),
        b"packed by the old build"
    );
}

#[test]
fn text_is_larger_than_binary_but_still_compresses_well() {
    let work = tempfile::tempdir().unwrap();
    let source = work.path().join("s");
    // 잘 압축되는 내용이면 Base64 로 4/3 배 늘어나도 원본보다 작아야 한다.
    write_file(&source.join("repeat.bin"), &vec![0x42u8; 4 * 1024 * 1024]);

    let container = work.path().join("bundle.txt");
    let packed = pack_to_file(
        std::slice::from_ref(&source),
        "pw123456",
        &container,
        &mut silent,
    )
    .unwrap();

    assert_eq!(packed.original_bytes, 4 * 1024 * 1024);
    assert!(
        packed.container_bytes < packed.original_bytes / 10,
        "압축이 기대만큼 되지 않았다: {} → {}",
        packed.original_bytes,
        packed.container_bytes
    );
}

// ---------------------------------------------------------------- QR

/// 화면에 띄우는 정수 배율. `main.js` 의 규칙과 같은 값이어야 한다.
///
/// PNG 은 1모듈 = 1픽셀로 저장하고 확대는 화면 쪽에서 한다. 그래서 검증도 저장된 비트맵이
/// 아니라 **사용자가 실제로 보는 그림**을 대상으로 해야 한다 — 1픽셀 격자는 디코더가 모듈
/// 중심을 집어내지 못해서(`DataEcc`), 사람이 폰으로 찍는 상황과 다르다.
fn display_scale(png_modules: usize) -> usize {
    (560 / png_modules).clamp(3, 10)
}

/// 나눔에서 모든 조각을 그려 낸다.
///
/// 앱은 뷰어가 장을 넘길 때마다 한 장씩 그리지만(`qr_piece`), 테스트는 전부를 봐야 한다.
fn all_pieces(plan: &packer_lib::qr::QrPlan) -> Vec<packer_lib::qr::QrImage> {
    (1..=plan.total()).map(|i| plan.image(i).unwrap()).collect()
}

/// Base64 PNG → 8비트 회색조 → 화면 배율로 확대 → QR 디코드.
fn decode_qr_png(png_base64: &str) -> String {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(png_base64)
        .unwrap();

    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    // 1비트로 저장했으므로 8비트 회색조로 펼쳐 받는다 (0 = 검정, 255 = 흰색).
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().unwrap();
    let mut buf = vec![0u8; reader.output_buffer_size().unwrap()];
    let info = reader.next_frame(&mut buf).unwrap();
    assert_eq!(info.width, info.height, "QR 은 정사각형이다");
    let width = info.width as usize;

    // 화면이 하는 것과 같은 정수 배율 확대 (보간 없이 네모를 그대로 키운다).
    let scale = display_scale(width);
    let side = width * scale;
    let mut prepared = rqrr::PreparedImage::prepare_from_greyscale(side, side, |x, y| {
        buf[(y / scale) * width + (x / scale)]
    });
    let grids = prepared.detect_grids();
    assert_eq!(grids.len(), 1, "심볼을 하나만 찾아야 한다");
    grids[0].decode().unwrap().1
}

/// 압축도 안 되고 규칙도 없는 바이트열.
///
/// 곱셈 해시를 그대로 쓰면 이웃한 값의 차이가 일정해서 zstd 가 규칙을 찾아낸다. 그러면 "QR 에
/// 안 들어갈 만큼 크다" 같은 크기 조건이 조용히 성립하지 않는다.
fn incompressible(len: usize) -> Vec<u8> {
    let mut state = 0x2545_F491_4F6C_DD1Du64;
    (0..len)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 24) as u8
        })
        .collect()
}

/// QR 로 옮길 만한 작은 트리. 큰 트리는 QR 한도를 한참 넘는다.
fn build_small_tree(root: &Path) {
    write_file(&root.join("메모.txt"), "한글 내용\n두 번째 줄\n".as_bytes());
    write_file(&root.join("blob.bin"), &[0u8, 1, 2, 255, 254, 128]);
    write_file(&root.join("empty.txt"), b"");
    write_file(
        &root.join("conf/settings.json"),
        br#"{"theme":"dark","scale":150}"#,
    );
}

/// 이 기능이 실제로 약속을 지키는지 — 화면의 그림을 폰으로 찍어 이어 붙이면 파일이 돌아온다.
///
/// 그림을 눈으로 확인할 수 없으니 PNG 를 되읽어 QR 디코더에 넣고, 나온 문자열을 붙여넣기
/// 경로(`ContainerSource::Text`)에 그대로 넘겨 원본과 바이트까지 같은지 본다. 이 테스트가
/// 통과하면 인코딩·여백·조각 나눔·`#` 주석 규칙·리더 관용성이 모두 동시에 맞다는 뜻이다.
#[test]
fn qr_pieces_round_trip_through_a_real_decoder() {
    let work = tempfile::tempdir().unwrap();
    let source = work.path().join("원본");
    build_small_tree(&source);
    // 한 심볼을 넘겨 조각 나눔 경로까지 밟게 한다. 압축이 거의 안 되는 데이터라야 한다.
    write_file(&source.join("noise.bin"), &incompressible(6000));

    let container = work.path().join("bundle.txt");
    let key = "열려라 참깨 2026!";
    let (packed, plan) =
        pack_to_file_with_qr(std::slice::from_ref(&source), key, &container, &mut silent).unwrap();

    let images = all_pieces(plan.as_ref().expect("이 크기는 QR 로 나와야 한다"));
    assert!(!packed.qr_omitted);
    // 요약과 실제 그림이 어긋나면 뷰어가 있지도 않은 장을 넘기려 한다.
    assert_eq!(packed.qr_plan.as_ref().unwrap().total, images.len());
    // 첫 장은 응답에 함께 실려 온다.
    assert_eq!(
        packed.qr_first.as_ref().unwrap().png_base64,
        images[0].png_base64
    );
    assert!(images.len() > 1, "조각이 나뉘어야 한다: {}", images.len());
    // 화면에서 장을 넘길 때 크기가 들썩이지 않도록 모두 같은 규격이어야 한다.
    assert!(images
        .iter()
        .all(|i| i.png_modules == images[0].png_modules));
    assert!(images.iter().all(|i| i.ec_level == images[0].ec_level));

    // 사용자가 조각을 순서대로 찍어 이어 붙인 상황. 카메라 앱이 조각 끝의 줄바꿈을 떼어 낸
    // 최악의 경우로 만든다 — 그러면 앞 조각 본문 끝에 다음 조각의 순서 표시가 달라붙는다.
    let mut pasted = String::new();
    for (at, image) in images.iter().enumerate() {
        assert_eq!(image.index, at + 1);
        assert_eq!(image.total, images.len());
        pasted.push_str(decode_qr_png(&image.png_base64).trim_end_matches('\n'));
    }

    let dest = work.path().join("복원");
    let restored = unpack_to_dir(&from_text(&pasted), key, &dest, &mut silent).unwrap();
    assert!(
        restored.hash_mismatch.is_empty(),
        "{:?}",
        restored.hash_mismatch
    );
    assert!(restored.skipped.is_empty(), "{:?}", restored.skipped);
    assert_trees_match(&source, &dest.join("원본"));
}

/// 조각을 순서대로 찍지 않으면 무엇이 잘못됐는지 짚어 준다.
///
/// 이 안내가 없으면 "이 파일은 이 프로그램으로 묶은 파일이 아닙니다" 나 "손상되었습니다" 가
/// 나오는데, 둘 다 사실과 다르고 사용자를 엉뚱한 곳으로 보낸다.
#[test]
fn reports_pieces_pasted_out_of_order() {
    let work = tempfile::tempdir().unwrap();
    let source = work.path().join("원본");
    build_small_tree(&source);
    write_file(&source.join("noise.bin"), &incompressible(6000));

    let container = work.path().join("bundle.txt");
    let key = "순서 테스트";
    let (_, plan) =
        pack_to_file_with_qr(std::slice::from_ref(&source), key, &container, &mut silent).unwrap();

    let mut texts: Vec<String> = all_pieces(&plan.unwrap())
        .iter()
        .map(|image| decode_qr_png(&image.png_base64))
        .collect();
    assert!(texts.len() > 2, "순서를 바꿔 볼 만큼 나뉘어야 한다");
    texts.swap(1, 2);

    let dest = work.path().join("복원");
    match unpack_to_dir(&from_text(&texts.concat()), key, &dest, &mut silent) {
        Err(Error::PieceOrder(found)) => {
            assert!(found.contains('#'), "찾은 순서를 보여 줘야 한다: {found}");
        }
        other => panic!("순서가 뒤바뀐 걸 못 짚었다: {other:?}"),
    }
    assert_destination_is_clean(&dest);
}

/// 조각 형식 자체는 디코더 없이도 지켜져야 한다. `rqrr` 을 나중에 걷어내도 이 계약은 남는다.
#[test]
fn qr_pieces_survive_the_paste_path_without_a_decoder() {
    let work = tempfile::tempdir().unwrap();
    let source = work.path().join("원본");
    build_small_tree(&source);

    let container = work.path().join("bundle.txt");
    let key = "조각 형식";
    pack_to_file(std::slice::from_ref(&source), key, &container, &mut silent).unwrap();

    let text = fs::read_to_string(&container).unwrap();
    let body = packer_lib::armor::body_of(&text).unwrap();
    let pieces = packer_lib::armor::pieces(&body, 5);

    let dest = work.path().join("복원");
    let restored = unpack_to_dir(&from_text(&pieces.concat()), key, &dest, &mut silent).unwrap();
    assert!(restored.hash_mismatch.is_empty());
    assert_trees_match(&source, &dest.join("원본"));
}

/// QR 로 옮길 만한 크기가 아니면 조용히 비워 두고, 화면이 그 이유를 말할 수 있게 한도를 알려 준다.
#[test]
fn qr_is_omitted_for_a_large_container() {
    let work = tempfile::tempdir().unwrap();
    let source = work.path().join("원본");
    // 압축이 안 되는 400 KiB — 어떤 나눔으로도 조각 상한에 담기지 않는다.
    write_file(&source.join("noise.bin"), &incompressible(400 * 1024));

    let container = work.path().join("bundle.txt");
    let (packed, plan) =
        pack_to_file_with_qr(std::slice::from_ref(&source), "키", &container, &mut silent).unwrap();

    assert!(plan.is_none());
    assert!(packed.qr_plan.is_none());
    assert!(packed.qr_first.is_none());
    assert!(packed.qr_omitted);
    assert_eq!(packed.qr_limit_pieces, 128);
    assert_eq!(packed.qr_limit_bytes, 2953);
    // 묶기 자체는 성공했다. 텍스트는 정상으로 나와야 한다.
    assert!(packed.container_bytes > 0);
}

/// 작은 묶음은 한 장으로 나온다. 사용자가 폰을 한 번만 대면 끝나는 경우다.
#[test]
fn a_small_bundle_fits_in_a_single_symbol() {
    let work = tempfile::tempdir().unwrap();
    let source = work.path().join("메모.txt");
    write_file(&source, "회의 시간 3시로 변경\n장소는 그대로\n".as_bytes());

    let container = work.path().join("bundle.txt");
    let key = "한 장이면 충분";
    let (packed, plan) =
        pack_to_file_with_qr(std::slice::from_ref(&source), key, &container, &mut silent).unwrap();

    let images = all_pieces(plan.as_ref().expect("작은 메모는 한 장에 담겨야 한다"));
    assert_eq!(images.len(), 1);
    assert_eq!(images[0].total, 1);
    assert_eq!(packed.qr_plan.as_ref().unwrap().total, 1);

    // 한 장짜리도 스캔해서 붙여넣으면 그대로 풀린다.
    let dest = work.path().join("복원");
    let pasted = decode_qr_png(&images[0].png_base64);
    unpack_to_dir(&from_text(&pasted), key, &dest, &mut silent).unwrap();
    assert_eq!(
        fs::read(dest.join("메모.txt")).unwrap(),
        fs::read(&source).unwrap()
    );
}
