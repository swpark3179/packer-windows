// 모은 컨테이너를 **이 폰에서** 풀어낸다 — 데스크톱 '풀기' 탭의 폰 쪽 짝.
//
//   armor 텍스트 → Base64 → 헤더 · Argon2id 로 키 확인 → AES-256-GCM 청크 → zstd → 평문 스트림
//
// 데스크톱의 `commands.rs` 의 `unpack_staged` 와 같은 순서이고, 각 계층의 규칙은 그쪽 파일에서
// 그대로 옮겼다:
//
//   헤더 · 청크 프레임   src-tauri/src/container.rs
//   키 유도 · KCV        src-tauri/src/crypto.rs      (Argon2id 는 ./argon2.js)
//   평문 스트림          src-tauri/src/archive.rs     (매니페스트 · 파일 · 트레일러, bincode 2)
//   경로 검사            src-tauri/src/safepath.rs
//
// 두 구현이 어긋나면 폰에서는 원인을 알 수 없는 "손상되었습니다" 로만 나타나므로, Rust 가 만든
// 골든 픽스처(`tests/fixtures/unpack-container.json`)를 양쪽 테스트가 함께 붙잡는다
// (`src-tauri/tests/unpack_format.rs` · `tests/unpack.test.js`).
//
// `collector.js` 와 같은 규율: **DOM 도 Capacitor 도 모른다.** 파일을 쓰는 일은 호출자가 넘긴
// `sink` 가 한다 — 앱에서는 `bridge.js` 의 Filesystem 싱크, 테스트에서는 메모리 싱크다. 그래서
// 기기 없이 `node --test` 로 전부 검증된다.
//
// **목적지에 바로 쓰지 않는다.** 싱크는 임시 폴더를 가리키고, 다 성공한 뒤에야 호출자가 결과를
// 제자리로 옮긴다 (데스크톱 `unpack_to_dir` 와 같다). 마지막 청크의 인증은 평문을 다 흘려보낸
// **뒤에** 끝나므로, 그 전에 쓴 파일은 아직 믿을 수 있는 것이 아니기 때문이다.

import { argon2id } from "./argon2.js";
import { BEGIN_MARKER, END_MARKER } from "./armor.js";
import { CHUNK_CHARS } from "./export.js";
import { Sha256 } from "./sha256.js";
import { Decompress } from "./vendor/fzstd.js";

// ---------------------------------------------------------------- 오류

/// 데스크톱 `error.rs` 와 같은 코드와 문구. 화면이 두 앱에서 같은 말을 하게 한다.
const MESSAGE = {
  WrongKey: "암호화 키가 올바르지 않습니다.",
  NotContainer: "이 파일은 이 프로그램으로 묶은 파일이 아닙니다.",
  Corrupted: "파일이 손상되었거나 중간에 잘렸습니다.",
  // 데스크톱은 "복사했는지 확인해 주세요" 라고 말하지만 폰에서는 사람이 복사하지 않았다.
  ArmorDamaged: "모은 텍스트가 온전하지 않습니다. 다시 모아 주세요.",
  EmptyKey: "암호화 키를 입력해 주세요.",
  NoMemory: "이 기기의 메모리로는 키를 만들 수 없습니다. PC 의 풀기 탭을 써 주세요.",
};

export class UnpackError extends Error {
  /**
   * @param {"WrongKey"|"NotContainer"|"Corrupted"|"ArmorDamaged"|"UnsupportedVersion"|
   *         "EmptyKey"|"NoMemory"} code 데스크톱 `Error::code()` 와 같은 값
   */
  constructor(code, message = MESSAGE[code]) {
    super(message);
    this.name = "UnpackError";
    this.code = code;
  }
}

const corrupted = () => new UnpackError("Corrupted");
const unsupported = (version) =>
  new UnpackError(
    "UnsupportedVersion",
    `더 새로운 버전(${version})으로 묶인 파일입니다. 프로그램을 업데이트해 주세요.`,
  );

// ---------------------------------------------------------------- armor

const DECODE = new Int16Array(128).fill(-1);
for (const [index, ch] of [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"].entries()) {
  DECODE[ch.charCodeAt(0)] = index;
}

/**
 * armor 텍스트에서 컨테이너 바이트를 꺼낸다.
 *
 * 폰이 쥐고 있는 텍스트는 언제나 `collector.js` 가 합친 한 줄짜리라 순서 표시가 없다. 그래서
 * 본문에는 Base64 글자와 공백만 허용한다 — 데스크톱의 `ArmorReader` 보다 좁지만, 이 앱이 만든
 * 텍스트는 모두 통과한다.
 */
export function bytesFromArmor(text) {
  if (typeof text !== "string") throw new UnpackError("NotContainer");
  const begin = text.indexOf(BEGIN_MARKER);
  const end = text.indexOf(END_MARKER, begin + BEGIN_MARKER.length);
  if (begin < 0 || end < 0) throw new UnpackError("NotContainer");

  const body = text.slice(begin + BEGIN_MARKER.length, end).replace(/\s+/g, "");
  if (body.length % 4 !== 0) throw new UnpackError("ArmorDamaged");

  const pad = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((body.length / 4) * 3 - pad);
  let at = 0;
  for (let i = 0; i < body.length; i += 4) {
    const last = i + 4 === body.length;
    let word = 0;
    for (let j = 0; j < 4; j += 1) {
      const code = body.charCodeAt(i + j);
      let value;
      if (code === 61 /* = */ && last && j >= 4 - pad) value = 0;
      else value = code < 128 ? DECODE[code] : -1;
      if (value < 0) throw new UnpackError("ArmorDamaged");
      word = (word << 6) | value;
    }
    out[at++] = (word >> 16) & 255;
    if (at < out.length) out[at++] = (word >> 8) & 255;
    if (at < out.length) out[at++] = word & 255;
  }
  return out;
}

// ---------------------------------------------------------------- 헤더

const MAGIC = "FSXPACK1";
export const HEADER_LEN = 96;
export const FORMAT_VERSION = 1;
const KCV_LEN = 16;
const KEY_LEN = 32;
const TAG_LEN = 16;
const MIN_CHUNK_SIZE = 4 * 1024;
const MAX_CHUNK_SIZE = 16 * 1024 * 1024;
/// `crypto.rs` 의 상한. 남의 손을 거친 헤더가 터무니없는 비용을 요구해 앱을 죽이지 못하게 한다.
const MAX_M_COST = 1024 * 1024;
const MAX_T_COST = 16;
const MAX_P_COST = 16;

/**
 * 헤더 96바이트를 읽는다. 규칙은 `container.rs` 의 `Header::from_bytes` 와 같다.
 *
 * 원본 바이트(`raw`)를 그대로 들고 다니는 것이 중요하다 — 매 청크의 AAD 가 **파일에 있던 그
 * 바이트**라서, 파싱한 필드로 다시 만들면 예약 영역이 인증에서 빠진다.
 */
export function parseHeader(bytes) {
  if (bytes.length < HEADER_LEN) throw new UnpackError("NotContainer");
  const raw = bytes.subarray(0, HEADER_LEN);
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (raw[i] !== MAGIC.charCodeAt(i)) throw new UnpackError("NotContainer");
  }
  const view = new DataView(raw.buffer, raw.byteOffset, HEADER_LEN);
  const version = view.getUint16(8, true);
  if (version > FORMAT_VERSION) throw unsupported(version);
  if (version === 0) throw corrupted();
  // 버전이 우리 범위 안인데 알고리즘 번호를 모르면 손상된 파일이다.
  if (raw[10] !== 1 || raw[11] !== 1 || raw[12] !== 1) throw corrupted();

  const chunkSize = view.getUint32(60, true);
  if (chunkSize < MIN_CHUNK_SIZE || chunkSize > MAX_CHUNK_SIZE) throw corrupted();

  return {
    raw,
    version,
    salt: raw.slice(16, 48),
    memory: view.getUint32(48, true),
    passes: view.getUint32(52, true),
    lanes: view.getUint32(56, true),
    chunkSize,
    noncePrefix: raw.slice(64, 68),
    kcv: raw.slice(80, 96),
  };
}

/// `KdfParams::validate` 와 같다. 정상적으로 묶인 파일이면 이 범위를 벗어나지 않는다.
function checkKdf({ memory, passes, lanes }) {
  if (
    memory === 0 || passes === 0 || lanes === 0 ||
    memory > MAX_M_COST || passes > MAX_T_COST || lanes > MAX_P_COST
  ) {
    throw corrupted();
  }
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * 암호에서 키를 만들고 KCV 로 맞는지 본다. 맞으면 AES 키를 돌려준다.
 *
 * 여기서 걸러야 "키가 틀렸다" 와 "파일이 깨졌다" 를 구분해 말할 수 있다 — 그냥 복호화를
 * 시도하면 GCM 인증 실패가 두 경우 모두 똑같이 나온다 (`container.rs` 의 `open_header`).
 */
async function openKey(header, passphrase, onProgress, pause) {
  checkKdf(header);
  let okm;
  try {
    okm = await argon2id({
      password: new TextEncoder().encode(passphrase),
      salt: header.salt,
      memory: header.memory,
      passes: header.passes,
      lanes: header.lanes,
      tagLength: KEY_LEN + KCV_LEN,
      onProgress,
      pause,
    });
  } catch (error) {
    // 64 MiB 를 못 잡는 기기. 데스크톱이 만든 헤더라면 이것 말고는 실패할 길이 없다.
    if (error instanceof RangeError && /memory|allocat|Array buffer/i.test(error.message)) {
      throw new UnpackError("NoMemory");
    }
    if (error instanceof RangeError) throw corrupted();
    throw error;
  }

  try {
    if (!sameBytes(okm.subarray(KEY_LEN), header.kcv)) throw new UnpackError("WrongKey");
    return await globalThis.crypto.subtle.importKey(
      "raw",
      okm.slice(0, KEY_LEN),
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
  } finally {
    okm.fill(0);
  }
}

// ---------------------------------------------------------------- 청크

/**
 * 청크를 차례로 복호화해 평문을 하나씩 내놓는다. 규칙은 `ContainerReader::fill_next_chunk`.
 *
 * 프레임: `[u32 LE 평문 길이][u8 last][암호문 평문 길이][태그 16]`. nonce 는
 * `nonce_prefix(4) || 청크 번호 u64 LE`, AAD 는 `헤더 96바이트 || last`. 청크를 뒤섞거나 잘라내면
 * 번호나 AAD 가 어긋나 인증에서 걸린다.
 */
async function* plainChunks(bytes, header, key) {
  const aad = new Uint8Array(HEADER_LEN + 1);
  aad.set(header.raw);
  const iv = new Uint8Array(12);
  iv.set(header.noncePrefix);
  const ivView = new DataView(iv.buffer);

  let at = HEADER_LEN;
  for (let index = 0; ; index += 1) {
    if (at + 5 > bytes.length) throw corrupted();
    const plainLen = new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0, true);
    if (plainLen > header.chunkSize) throw corrupted();
    const flag = bytes[at + 4];
    if (flag !== 0 && flag !== 1) throw corrupted();
    const sealedEnd = at + 5 + plainLen + TAG_LEN;
    if (sealedEnd > bytes.length) throw corrupted();

    aad[HEADER_LEN] = flag;
    // 2^32 청크를 넘을 일이 없다 (청크 하나가 최소 4 KiB).
    ivView.setUint32(4, index >>> 0, true);
    ivView.setUint32(8, 0, true);

    let plain;
    try {
      plain = new Uint8Array(
        await globalThis.crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
          key,
          bytes.subarray(at + 5, sealedEnd),
        ),
      );
    } catch {
      throw corrupted();
    }
    at = sealedEnd;
    yield plain;
    // 종료 청크 뒤는 보지 않는다 — 데스크톱의 리더도 거기서 멈춘다.
    if (flag === 1) return;
  }
}

// ---------------------------------------------------------------- 평문 스트림

/**
 * 복호화 → zstd 를 거친 평문을 필요한 만큼씩 당겨 읽는다. Rust 의 `Read` 를 겹쳐 쌓은 것과 같은
 * 자리다 — 큰 파일도 통째로 메모리에 모으지 않는다.
 */
class PlainStream {
  constructor(chunks) {
    this.chunks = chunks;
    this.queue = [];
    this.queued = 0;
    this.ended = false;
    this.decoder = new Decompress((data) => {
      if (data.length > 0) {
        this.queue.push(data);
        this.queued += data.length;
      }
    });
  }

  /// 청크 하나를 더 풀어 넣는다. 더 넣을 것이 없으면 false.
  async pull() {
    if (this.ended) return false;
    const next = await this.chunks.next();
    try {
      if (next.done) {
        this.ended = true;
        // 프레임이 덜 끝났으면 여기서 던진다 — 잘린 스트림이다.
        this.decoder.push(new Uint8Array(0), true);
      } else {
        this.decoder.push(next.value, false);
      }
    } catch {
      throw corrupted();
    }
    return true;
  }

  /// 정확히 `n` 바이트. 그만큼 없으면 잘린 것이다.
  async read(n) {
    while (this.queued < n) {
      if (!(await this.pull())) throw corrupted();
    }
    const first = this.queue[0];
    if (first && first.length >= n) {
      const out = first.subarray(0, n);
      if (first.length === n) this.queue.shift();
      else this.queue[0] = first.subarray(n);
      this.queued -= n;
      return out;
    }
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const head = this.queue[0];
      const take = Math.min(head.length, n - filled);
      out.set(head.subarray(0, take), filled);
      filled += take;
      if (take === head.length) this.queue.shift();
      else this.queue[0] = head.subarray(take);
    }
    this.queued -= n;
    return out;
  }

  /**
   * 남은 것이 하나도 없는지. 남은 청크를 **끝까지 풀어 보고** 답한다.
   *
   * 페이로드를 다 읽은 뒤에도 이걸 불러야 한다. 그래야 zstd 가 프레임 꼬리까지 읽으면서 컨테이너의
   * 마지막 청크도 인증된다 — 데스크톱이 `decoder.read(&mut tail)` 로 한 바이트를 더 요청하는 것과
   * 같은 이유다.
   */
  async atEnd() {
    while (this.queued === 0 && (await this.pull()));
    return this.queued === 0;
  }
}

// ---------------------------------------------------------------- bincode 2 (standard)

/// `archive.rs` 의 `MAX_BLOB_BYTES`. 매니페스트·트레일러는 통째로 메모리에 올라간다.
const MAX_BLOB_BYTES = 64 * 1024 * 1024;
export const MANIFEST_VERSION = 1;

/**
 * bincode 2 `config::standard()` 읽기 — 리틀 엔디언, 정수는 가변 길이.
 *
 * 가변 정수: 250 이하는 그 한 바이트, 251 → u16, 252 → u32, 253 → u64 가 뒤따른다. 부호 있는
 * 정수는 지그재그로 접어 같은 방식으로 적는다. 타입보다 큰 표지(u16 자리에 252 등)는 bincode 가
 * 거절하므로 여기서도 거절한다.
 */
class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    this.at = 0;
  }

  need(n) {
    if (this.at + n > this.bytes.length) throw corrupted();
    const at = this.at;
    this.at += n;
    return at;
  }

  take(n) {
    const at = this.need(n);
    return this.bytes.subarray(at, at + n);
  }

  /** @param {16|32|64} width */
  varint(width) {
    const tag = this.bytes[this.need(1)];
    if (tag <= 250) return tag;
    if (tag === 251) return this.view.getUint16(this.need(2), true);
    if (tag === 252 && width >= 32) return this.view.getUint32(this.need(4), true);
    if (tag === 253 && width >= 64) {
      const value = this.view.getBigUint64(this.need(8), true);
      // 파일 크기·개수로 2^53 을 넘는 값은 정상적인 컨테이너에서 나오지 않는다.
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw corrupted();
      return Number(value);
    }
    throw corrupted();
  }

  /// i64. 시각만 이 모양이고 폰은 쓰지 않으므로 값 대신 자리만 넘긴다.
  skipSigned() {
    const tag = this.bytes[this.need(1)];
    if (tag <= 250) return;
    if (tag === 251) this.need(2);
    else if (tag === 252) this.need(4);
    else if (tag === 253) this.need(8);
    else throw corrupted();
  }

  string() {
    const bytes = this.take(this.varint(64));
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw corrupted();
    }
  }
}

/// `Manifest { version: u16, created_utc: i64, entries: Vec<Entry> }`,
/// `Entry { rel_path: String, kind: Kind, size: u64, mtime: i64 }`, `Kind { Dir, File }`.
export function decodeManifest(bytes) {
  const r = new Reader(bytes);
  const version = r.varint(16);
  r.skipSigned();
  const count = r.varint(64);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const path = r.string();
    const variant = r.varint(32);
    if (variant > 1) throw corrupted();
    const size = r.varint(64);
    r.skipSigned();
    entries.push({ path, kind: variant === 0 ? "dir" : "file", size });
  }
  return { version, entries };
}

/// `Trailer { hashes: Vec<[u8; 32]> }` — 배열은 길이 없이 32바이트 그대로 적힌다.
export function decodeTrailer(bytes) {
  const r = new Reader(bytes);
  const count = r.varint(64);
  const hashes = [];
  for (let i = 0; i < count; i += 1) hashes.push(r.take(32));
  return hashes;
}

async function readBlob(stream) {
  const head = await stream.read(4);
  const length = new DataView(head.buffer, head.byteOffset, 4).getUint32(0, true);
  if (length > MAX_BLOB_BYTES) throw corrupted();
  return stream.read(length);
}

// ---------------------------------------------------------------- 경로 검사

const RESERVED_STEMS = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);
const FORBIDDEN_CHARS = /[<>:"|?*\\]/;
const MAX_COMPONENT_BYTES = 255;
const utf8Length = (text) => new TextEncoder().encode(text).length;
/// Rust `to_ascii_uppercase` 와 같게 ASCII 만 올린다. `"ſ".toUpperCase()` 는 `"S"` 가 된다.
const asciiUpper = (text) => text.replace(/[a-z]/g, (ch) => ch.toUpperCase());

/**
 * 매니페스트의 상대 경로를 검사한다. `safepath.rs` 의 `sanitize_rel` 을 **문구까지** 옮겼다.
 *
 * 풀기는 남이 만든 파일에 적힌 경로대로 쓰는 동작이라, 폴더 밖으로 나가려는 시도를 전부 막는다.
 * 폰의 파일 시스템은 윈도우의 금지 글자를 받아 주지만 그대로 둔다 — 같은 컨테이너가 두 앱에서
 * 다르게 풀리면 안 되고, 이 파일들은 결국 PC 로 건너가기 쉽다.
 *
 * @returns {{ok: true, path: string} | {ok: false, reason: string}} `reason` 은 데스크톱이
 *   건너뛴 항목에 적는 바로 그 문자열이다.
 */
export function checkRelPath(rel) {
  const reject = (why) => ({ ok: false, reason: `${rel} (${why})` });

  if (rel === "") return reject("빈 경로");
  if (rel.includes("\0")) return reject("NUL 문자 포함");
  if (rel.startsWith("/")) return reject("절대 경로");

  for (const part of rel.split("/")) {
    if (part === "") return reject("빈 경로 조각");
    if (part === "." || part === "..") return reject("상대 경로 이동");
    if (utf8Length(part) > MAX_COMPONENT_BYTES) return reject("이름이 너무 김");
    if (FORBIDDEN_CHARS.test(part)) return reject("사용할 수 없는 문자");
    if (/[\u0000-\u001f]/.test(part)) return reject("제어 문자 포함");
    if (part.endsWith(".") || part.endsWith(" ")) return reject("끝에 점이나 공백");
    if (RESERVED_STEMS.has(asciiUpper(part.split(".")[0]))) return reject("예약된 장치 이름");
  }
  return { ok: true, path: rel };
}

// ---------------------------------------------------------------- 풀기

/// 한 번에 싱크로 넘길 바이트 수. 싱크가 Base64 로 옮겨 브리지에 넘기면 `CHUNK_CHARS`(32 KiB)
/// 글자가 된다 — 저장의 나눠 쓰기와 같은 크기다 (`export.js` 참고).
export const WRITE_BYTES = (CHUNK_CHARS / 4) * 3;

/**
 * 컨테이너를 풀어 `sink` 에 쓴다.
 *
 * `sink` 는 임시 폴더 기준의 상대 경로를 받는다:
 *   `makeDir(path)`                       폴더 하나 (부모까지)
 *   `writeFile(path, bytes, append)`      첫 조각은 `append = false`. 빈 파일도 한 번은 불린다.
 *
 * 진행은 두 단계다. `onPhase("key")` 뒤에는 Argon2 의 블록 수를, `onPhase("unpack")` 뒤에는 쓴
 * 파일 바이트를 `onProgress(done, total)` 로 보고한다 (총량은 매니페스트를 읽어야 안다 — 그 전에는
 * `total = 0` 이다).
 *
 * @param {{source: string | Uint8Array, passphrase: string, sink: object,
 *          onPhase?: (phase: "key" | "unpack") => void,
 *          onProgress?: (done: number, total: number) => void,
 *          pause?: () => Promise<void>}} options
 *   `source` 는 armor 텍스트나, 스트림 모드가 복원한 컨테이너 바이트 그대로다.
 * @returns {Promise<{fileCount: number, dirCount: number, totalBytes: number,
 *                    skipped: string[], hashMismatch: string[]}>}
 */
export async function unpackContainer(options) {
  const { source, passphrase, sink, onPhase = null, onProgress = null, pause } = options;
  if (typeof passphrase !== "string" || passphrase === "") throw new UnpackError("EmptyKey");

  const bytes = typeof source === "string" ? bytesFromArmor(source) : source;
  const header = parseHeader(bytes);

  onPhase?.("key");
  const key = await openKey(header, passphrase, onProgress, pause);

  onPhase?.("unpack");
  onProgress?.(0, 0);
  const stream = new PlainStream(plainChunks(bytes, header, key));

  const manifest = decodeManifest(await readBlob(stream));
  if (manifest.version > MANIFEST_VERSION) throw unsupported(manifest.version);

  const total = manifest.entries.reduce((sum, e) => sum + (e.kind === "file" ? e.size : 0), 0);
  let done = 0;
  onProgress?.(done, total);

  const report = { fileCount: 0, dirCount: 0, totalBytes: 0, skipped: [], hashMismatch: [] };
  /// 파일 순서대로 계산한 해시. 건너뛴 항목은 null.
  const computed = [];

  for (const entry of manifest.entries) {
    const checked = checkRelPath(entry.path);

    if (entry.kind === "dir") {
      if (!checked.ok) {
        report.skipped.push(checked.reason);
        continue;
      }
      await sink.makeDir(entry.path);
      report.dirCount += 1;
      continue;
    }

    if (!checked.ok) {
      report.skipped.push(checked.reason);
      // 건너뛰더라도 바이트는 반드시 소비해야 다음 파일의 경계가 맞는다.
      for (let left = entry.size; left > 0; ) {
        const step = Math.min(left, WRITE_BYTES);
        await stream.read(step);
        left -= step;
        done += step;
        onProgress?.(done, total);
      }
      computed.push(null);
      continue;
    }

    const hasher = new Sha256();
    if (entry.size === 0) await sink.writeFile(entry.path, new Uint8Array(0), false);
    for (let left = entry.size, first = true; left > 0; first = false) {
      const piece = await stream.read(Math.min(left, WRITE_BYTES));
      hasher.update(piece);
      await sink.writeFile(entry.path, piece, !first);
      left -= piece.length;
      done += piece.length;
      onProgress?.(done, total);
    }
    report.fileCount += 1;
    report.totalBytes += entry.size;
    computed.push({ path: entry.path, hash: hasher.digest() });
  }

  // 트레일러로 실제로 쓴 내용이 맞는지 확인한다.
  const hashes = decodeTrailer(await readBlob(stream));
  if (hashes.length !== computed.length) throw corrupted();
  computed.forEach((item, at) => {
    if (item && !sameBytes(item.hash, hashes[at])) report.hashMismatch.push(item.path);
  });

  // 페이로드 뒤에 남은 바이트가 있으면 우리가 만든 것이 아니거나 조작된 것이다.
  if (!(await stream.atEnd())) throw corrupted();

  return report;
}
