// Packer 조각 모으기 — 배선.
//
// 이 파일은 마크업의 클래스 이름을 하나도 모른다. 모든 DOM 참조는 `data-pk="..."` 훅으로만
// 한다 (데스크톱 `src/main.js` 와 같은 규약). 없는 훅은 조용히 무시되므로 부분 이식도 안전하다.
//
// 판단은 전부 `collector.js` 에 있고 네이티브 호출은 전부 `bridge.js` 에 있다. 여기 있는 것은
// 둘을 화면에 잇는 일뿐이다.

import {
  addPiece,
  createCollection,
  isComplete,
  joinCollection,
  missingIndices,
} from "./collector.js";

import {
  addFrame,
  createStream,
  isComplete as streamComplete,
  looksLikeStream,
  percent as streamPercent,
  takeBytes,
  verify,
} from "./stream.js";

import {
  barcodeBytes,
  barcodeText,
  buzz,
  cameraPermission,
  canShare,
  hasScanner,
  isSupported,
  keepAwake,
  onBarcodes,
  onScanError,
  openSettings,
  platform,
  requestCameraPermission,
  saveText,
  setTorch,
  shareText,
  startScan,
  stopScan,
  torchAvailable,
} from "./bridge.js";

import {
  BUSY_DELAY_MS,
  BUSY_HOLD_MS,
  defaultFileName,
  safeFileName,
} from "./export.js";

import { armorFromBytes } from "./armor.js";

// ---------------------------------------------------------------- 안내 문구

const REJECT_TEXT = {
  "not-packer": "Packer 가 만든 QR 이 아닙니다.",
  damaged: "조각을 온전히 읽지 못했습니다. 조금 더 가까이서 다시 비춰 주세요.",
  unaligned: "조각이 잘려 들어왔습니다. 다시 비춰 주세요.",
  range: "순번이 올바르지 않습니다.",
  structure: "Packer 조각의 모양이 아닙니다.",
};

const STREAM_REJECT_TEXT = {
  "not-stream": "Packer 가 만든 QR 이 아닙니다.",
  damaged: "프레임을 온전히 읽지 못했습니다. 조금 더 가까이서 다시 비춰 주세요.",
  range: "프레임의 값이 올바르지 않습니다.",
};

const CONFLICT_TEXT = {
  total: "장수가 다른 묶음입니다. 한 묶음의 QR 만 비춰 주세요.",
  body: "같은 순번인데 내용이 다릅니다. 다른 묶음이 섞였습니다.",
  chunk: "다른 묶음의 조각입니다. 한 묶음의 QR 만 비춰 주세요.",
};

// ---------------------------------------------------------------- 상태

const state = {
  /// 지금 모으고 있는 조각들 (조각 모드).
  collection: createCollection(),
  /// 지금 모으고 있는 프레임들 (스트림 모드). 첫 심볼의 매직으로 어느 쪽인지 정해진다.
  stream: createStream(),
  /// `null` | `"pieces"` | `"stream"`. 한 번 정해지면 다 모을 때까지 바뀌지 않는다.
  mode: null,
  /// 다 모아 합친 텍스트 (아직이면 null).
  joined: null,
  scanning: false,
  /// 인식·오류 이벤트 구독. 멈출 때 뗀다.
  listeners: [],
  torch: false,
  /// 마지막으로 보여 준 경고. 같은 경고로 매 프레임 진동하지 않게 한다.
  lastWarning: "",
  /// 앱이 백그라운드로 가서 카메라를 놓았을 때, 돌아오면 다시 시작할지.
  resume: false,
  /// 저장·보내기가 도는 중인지. 두 버튼을 함께 잠근다.
  exporting: false,
  /// 진행 막대의 지연 표시 상태. `shownAt` 이 0이면 아직 띄우지 않았다.
  busy: { timer: null, shownAt: 0, done: 0, total: 0, phase: "" },
};

// ---------------------------------------------------------------- DOM 훅

const el = (hook) => document.querySelector(`[data-pk="${hook}"]`);

function setText(hook, text) {
  const node = el(hook);
  if (node) node.textContent = text;
}

function show(hook, visible) {
  const node = el(hook);
  if (node) node.hidden = !visible;
}

function enable(hook, on) {
  const node = el(hook);
  if (node) node.disabled = !on;
}

function on(hook, event, handler) {
  const node = el(hook);
  if (node) node.addEventListener(event, handler);
}

function setState(name) {
  const app = el("app");
  if (app) app.dataset.state = name;
}

/// 오류 메시지를 사람이 읽을 수 있게 꺼낸다.
const reason = (error) => (error instanceof Error ? error.message : String(error ?? ""));

// ---------------------------------------------------------------- 그리기

/**
 * 스캔 화면의 상태 줄.
 *
 * 같은 문구를 다시 쓰지 않는다. 연속 스캔은 초당 여러 번 이 경로를 지나므로, 매번 DOM 을
 * 건드리면 글자가 깜빡여 읽을 수 없다.
 */
function setStatus(text, tone = "") {
  const node = el("scan-status");
  if (!node) return;
  if (node.textContent === text && node.dataset.tone === tone) return;
  node.textContent = text;
  node.dataset.tone = tone;
}

/// 경고를 보여 준다. 문구가 바뀔 때만 진동한다.
function warn(text, tone) {
  if (state.lastWarning !== text) {
    state.lastWarning = text;
    void buzz("warn");
  }
  setStatus(text, tone);
}

/// 칩으로 보여 줄 수 있는 최대 장수.
///
/// 칩은 막대가 지우는 정보를 담고 있다 — **어느** 장이 빠졌는지. 그래서 들어가는 한 칩이 낫다.
/// 하지만 데스크톱 조각 상한이 128장까지 올라갔고, 그만큼을 폰 화면에 늘어놓으면 카메라를
/// 덮어 버린다. 그때는 칩을 **더하는** 것이 아니라 **막대로 바꾼다** — 빠진 순번은 바로 위의
/// `scan-total` 이 계속 말해 준다.
const CHIP_LIMIT = 24;

/// 칩이 화면에 안 들어갈 때 대신 쓰는 막대. 결과 화면의 것과 같은 컴포넌트다.
function renderScanBar() {
  const { collection } = state;
  const total = collection.total;
  if (total === null) return;

  const percent = Math.round((collection.pieces.size / total) * 100);
  const fill = el("scan-bar-fill");
  if (fill) fill.style.width = `${percent}%`;

  const bar = el("scan-bar");
  if (bar) {
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    bar.setAttribute("aria-valuenow", String(percent));
  }
}

function renderChips() {
  const list = el("scan-list");
  const total = state.collection.total;
  const asChips = total !== null && total <= CHIP_LIMIT;

  // 칩과 막대는 같은 자리를 놓고 서로 배타적이다.
  show("scan-list", asChips);
  show("scan-bar", total !== null && !asChips);

  if (!asChips) {
    if (list) list.replaceChildren();
    renderScanBar();
    return;
  }
  if (!list) return;

  const template = el("chip-template");
  if (!template) {
    list.replaceChildren();
    return;
  }

  const chips = [];
  for (let index = 1; index <= total; index += 1) {
    const chip = template.content.firstElementChild.cloneNode(true);
    const got = state.collection.pieces.has(index);
    chip.dataset.got = got ? "true" : "false";
    chip.setAttribute("aria-label", `${index}번 ${got ? "읽음" : "안 읽음"}`);
    const label = chip.querySelector("[data-field=index]");
    if (label) label.textContent = String(index);
    chips.push(chip);
  }
  list.replaceChildren(...chips);
}

function render() {
  if (state.mode === "stream") return renderStream();

  const { collection } = state;
  const total = collection.total;
  const got = collection.pieces.size;

  // 전체 장수를 모르는 동안에도 자리를 잡아 둔다. 첫 조각에서 갑자기 늘어나면 눈이 흔들린다.
  setText("scan-progress", total === null ? "0 / ?" : `${got} / ${total}`);

  if (total === null) {
    setText("scan-total", "QR 을 비추면 전체 장수를 알려 줍니다");
  } else {
    const missing = missingIndices(collection);
    if (missing.length === 0) setText("scan-total", "다 모았습니다");
    else if (missing.length > 6) setText("scan-total", `${missing.length}장 남았습니다`);
    else setText("scan-total", `남은 순번 ${missing.join(", ")}`);
  }

  renderChips();
}

/**
 * 스트림 모드의 진행 표시.
 *
 * 여기에는 칩이 없다. 순번을 채우는 방식이 아니라 **아무 프레임이나 모으면 되는** 방식이라,
 * "어느 장이 빠졌는지" 라는 개념 자체가 없다 — 그게 이 모드의 요점이다. 그래서 조각 모드가
 * 칩으로 말하던 것을 여기서는 막대와 퍼센트가 말한다.
 */
function renderStream() {
  const { stream } = state;
  const done = streamPercent(stream);

  setText("scan-progress", `${done}%`);
  setText(
    "scan-total",
    done === 100 ? "다 모았습니다" : "그대로 비추고 계세요 — 순서는 상관없습니다",
  );

  show("scan-list", false);
  show("scan-bar", true);
  const fill = el("scan-bar-fill");
  if (fill) fill.style.width = `${done}%`;
  const bar = el("scan-bar");
  if (bar) {
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    bar.setAttribute("aria-valuenow", String(done));
  }
}

// ---------------------------------------------------------------- 스캔

async function ensurePermission() {
  let permission = await cameraPermission();
  if (permission === "prompt" || permission === "prompt-with-rationale") {
    permission = await requestCameraPermission();
  }
  return permission;
}

function showDenied() {
  state.resume = false;
  setState("denied");
  setText(
    "perm-note",
    "카메라 권한이 없어 QR 을 읽을 수 없습니다. 설정에서 카메라를 켜고 다시 시작해 주세요.",
  );
  show("perm-settings", true);
  enable("scan-start", true);
}

async function beginScan() {
  if (state.scanning) return;

  const permission = await ensurePermission();
  // `limited` 는 iOS 가 제한적으로 허용한 상태다. 읽을 수는 있으므로 진행한다.
  if (permission !== "granted" && permission !== "limited") {
    showDenied();
    return;
  }

  show("scan-error", false);
  show("perm-settings", false);
  state.lastWarning = "";

  // 카메라가 뜨기 **전에** 투명 상태로 바꿔 둔다. 순서가 뒤바뀌면 불투명한 화면이 한 번 번쩍인다.
  setState("scanning");
  setStatus("");
  render();

  try {
    // 구독을 먼저 걸어 첫 프레임을 놓치지 않는다.
    state.listeners.push(await onBarcodes(handleBarcode));
    state.listeners.push(
      await onScanError((message) => warn(message || "카메라가 멈췄습니다.", "bad")),
    );

    await startScan();
    state.scanning = true;
    state.resume = true;

    await keepAwake(true);
    show("scan-torch", await torchAvailable());
  } catch (error) {
    await endScan();
    setState("idle");
    show("scan-error", true);
    setText("scan-error", `카메라를 열지 못했습니다: ${reason(error)}`);
  }
}

async function endScan() {
  state.scanning = false;

  await stopScan();
  await keepAwake(false);

  if (state.torch) {
    state.torch = false;
    try {
      await setTorch(false);
    } catch {
      // 카메라가 이미 닫혔다. 손전등도 함께 꺼진다.
    }
  }

  for (const listener of state.listeners) {
    try {
      await listener?.remove();
    } catch {
      // 이미 떨어진 구독.
    }
  }
  state.listeners = [];
}

/**
 * 심볼 하나를 받는다.
 *
 * **사용자에게 모드를 묻지 않는다.** 첫 심볼의 매직(`PQS1`)이 스트림 프레임인지 조각인지
 * 말해 주므로 그걸로 정하고, 한 번 정해지면 다 모을 때까지 바꾸지 않는다 — 도중에 다른 모드의
 * 심볼이 들어오면 그건 다른 묶음이 섞인 것이다.
 */
function handleBarcode(barcode) {
  if (!state.scanning) return;

  const bytes = barcodeBytes(barcode);
  if (state.mode === null && looksLikeStream(bytes)) state.mode = "stream";
  if (state.mode === "stream") {
    handleStreamFrame(bytes);
    return;
  }

  const text = barcodeText(barcode);
  if (text === "") return;

  const result = addPiece(state.collection, text);
  // 조각을 하나라도 제대로 받았으면 모드를 잠근다. 뒤늦게 다른 묶음의 스트림 프레임이 들어와도
  // 모으던 것을 버리고 갈아타지 않는다.
  if (result.status !== "rejected") state.mode = "pieces";

  // 같은 심볼이 계속 눈에 들어오는 것이 정상이다. 아무 일도 없었던 것처럼 넘어간다 —
  // 여기서 화면을 건드리거나 진동하면 쓸 수 없는 앱이 된다.
  if (result.status === "duplicate") return;

  if (result.status === "added") {
    state.lastWarning = "";
    void buzz("tick");
    setStatus(`${result.index}번 읽었습니다`);
    render();
    if (isComplete(state.collection)) void finish();
    return;
  }

  if (result.status === "conflict") {
    warn(CONFLICT_TEXT[result.reason] ?? "다른 묶음의 조각입니다.", "warn");
    return;
  }

  warn(REJECT_TEXT[result.reason] ?? "읽을 수 없는 QR 입니다.", "warn");
}

/// 스트림 프레임 하나. 조각 모드와 달리 **순번을 채우는 것이 아니라** 풀린 블록을 센다.
function handleStreamFrame(bytes) {
  const result = addFrame(state.stream, bytes);

  // 연속 스캔은 같은 심볼을 초당 여러 번 읽는다. 아무 일도 없었던 것처럼 넘어간다.
  if (result.status === "duplicate") return;

  if (result.status === "added") {
    state.lastWarning = "";
    void buzz("tick");
    render();
    if (streamComplete(state.stream)) void finishStream();
    return;
  }

  if (result.status === "conflict") {
    warn("다른 묶음의 QR 입니다. 한 묶음만 비춰 주세요.", "warn");
    return;
  }
  warn(STREAM_REJECT_TEXT[result.reason] ?? "읽을 수 없는 QR 입니다.", "warn");
}

async function finish() {
  // 합치기를 먼저 한다. 여기서 실패하면 카메라를 끄지 않고 계속 모을 수 있어야 한다.
  let joined;
  try {
    joined = joinCollection(state.collection);
  } catch (error) {
    warn(`합치지 못했습니다: ${reason(error)}`, "bad");
    return;
  }

  await showResult(
    joined,
    `${state.collection.total}장을 모두 읽어 ${joined.length.toLocaleString("ko-KR")}자로 합쳤습니다.`,
  );
}

/**
 * 스트림 모드를 마무리한다.
 *
 * 조각 모드와 달리 할 일이 하나 더 있다. 프레임이 실어 나른 것은 **Base64 를 벗긴 원시
 * 바이트**라서(프레임마다 33% 를 더 담기 위해서다) 여기서 다시 armor 로 감싸야 한다. 수 MB 면
 * 그 옮겨 적기만으로 몇 초가 걸리므로 조각으로 나눠 돌고 진행 막대에 보고한다 — 1단계에서
 * 만들어 둔 막대가 실제로 값을 하는 자리다.
 */
async function finishStream() {
  let bytes;
  try {
    bytes = takeBytes(state.stream);
  } catch (error) {
    warn(`복원하지 못했습니다: ${reason(error)}`, "bad");
    return;
  }

  // 카메라를 먼저 끈다. 옮겨 적는 동안 프레임이 계속 들어오면 화면만 붐빈다.
  await endScan();
  setState("complete");
  setText("result-summary", "");
  setText("result-note", "");

  startBusy("armor");
  let joined;
  try {
    joined = await armorFromBytes(bytes, tickBusy);
  } catch (error) {
    await stopBusy();
    setState("scanning");
    warn(`옮겨 적지 못했습니다: ${reason(error)}`, "bad");
    return;
  }
  await stopBusy();

  // 지문이 어긋나면 여기서 말해 준다. 조용히 넘기면 PC 의 풀기 탭에서 "손상되었습니다" 로만
  // 나타나고, 그때는 무엇이 문제였는지도 모른 채 처음부터 다시 찍어야 한다.
  const sound = await verify(state.stream, bytes).catch(() => true);
  const warning = sound ? "" : "\n복원한 내용이 보낸 쪽과 다릅니다 — 다시 모으는 편이 좋습니다.";

  await showResult(
    joined,
    `${bytes.length.toLocaleString("ko-KR")}바이트를 모두 복원했습니다.${warning}`,
  );
}

/// 결과 화면으로 넘어간다. 두 모드가 함께 쓴다.
async function showResult(joined, summary) {
  state.joined = joined;
  if (state.scanning) await endScan();

  setState("complete");
  setText("result-summary", summary);
  setText("result-note", "");
  resetExportProgress();

  const input = el("save-name");
  if (input) input.value = defaultFileName();
  setSaveHint();

  enable("scan-save", true);
  enable("scan-share", true);
  // 공유를 못 쓰는 기기에서는 감춘다 — 뜻 없는 조작 도구는 잠그기보다 감춘다 (scan-torch 와 같다).
  show("scan-share", await canShare());

  void buzz("done");
}

// ---------------------------------------------------------------- 진행 막대

const NUMBER = new Intl.NumberFormat("ko-KR");

const PHASE_TEXT = {
  save: "저장하는 중",
  share: "보낼 파일을 쓰는 중",
  armor: "텍스트로 옮겨 적는 중",
};

/**
 * 진행 막대를 그린다. 데스크톱 `src/main.js` 의 `renderProgress()` 와 같은 규칙이다.
 *
 * 바이트가 아니라 **글자 수**로 말한다. 우리는 글자 수를 정확히 알고, 결과 요약도 이미
 * "…자로 합쳤습니다" 라고 말하고 있어서 단위가 어긋나지 않는다.
 */
function renderExportProgress({ done, total, phase }) {
  const fill = el("export-progress-fill");
  const bar = el("export-progress");
  const label = el("export-progress-label");
  const name = PHASE_TEXT[phase] ?? "내보내는 중";

  if (bar) {
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
  }

  if (total > 0) {
    const percent = Math.min(100, Math.round((done / total) * 100));
    if (fill) {
      fill.style.width = `${percent}%`;
      delete fill.dataset.indeterminate;
    }
    bar?.setAttribute("aria-valuenow", String(percent));
    // 저장·보내기는 글자를 세고, 옮겨 적기는 바이트를 센다. 단위를 틀리게 적으면 사용자가
    // 파일 크기를 오해한다.
    const unit = phase === "armor" ? "바이트" : "자";
    setText(
      "export-progress-label",
      `${name} ${percent}% · ${NUMBER.format(done)} / ${NUMBER.format(total)}${unit}`,
    );
  } else {
    if (fill) {
      fill.style.width = "100%";
      fill.dataset.indeterminate = "true";
    }
    bar?.removeAttribute("aria-valuenow");
    setText("export-progress-label", `${name}…`);
  }
  if (label) label.hidden = false;
  show("export-progress", true);
}

function resetExportProgress() {
  const { busy } = state;
  if (busy.timer !== null) {
    clearTimeout(busy.timer);
    busy.timer = null;
  }
  busy.shownAt = 0;
  busy.done = 0;
  busy.total = 0;
  busy.phase = "";

  const fill = el("export-progress-fill");
  if (fill) {
    fill.style.width = "0";
    delete fill.dataset.indeterminate;
  }
  setText("export-progress-label", "");
  show("export-progress", false);
}

/// 막대를 **바로 띄우지 않는다.** 250ms 안에 끝나는 저장에서는 아무것도 보이지 않아야 한다.
function startBusy(phase) {
  const { busy } = state;
  busy.phase = phase;
  busy.done = 0;
  busy.total = 0;
  busy.shownAt = 0;
  busy.timer = setTimeout(() => {
    busy.timer = null;
    busy.shownAt = Date.now();
    renderExportProgress(busy);
  }, BUSY_DELAY_MS);
}

/// 진행 상황을 기록한다. 아직 막대를 안 띄웠으면 숫자만 담아 둔다.
function tickBusy(done, total) {
  const { busy } = state;
  busy.done = done;
  busy.total = total;
  if (busy.shownAt !== 0) renderExportProgress(busy);
}

/// 막대를 거둔다. 한 번 띄웠다면 최소 표시 시간을 채우고 나서 — 번쩍이고 사라지면 더 산만하다.
async function stopBusy() {
  const { busy } = state;
  if (busy.timer !== null) {
    clearTimeout(busy.timer);
    busy.timer = null;
  }
  if (busy.shownAt === 0) {
    resetExportProgress();
    return;
  }
  const left = BUSY_HOLD_MS - (Date.now() - busy.shownAt);
  if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
  resetExportProgress();
}

// ---------------------------------------------------------------- 내보내기

/// 저장한 폴더별 안내. 첫 줄에서 끝나지 못했다는 건 사용자가 알아야 하는 사실이다.
const WHERE_NOTE = {
  EXTERNAL: "\n이 폴더는 앱을 지우면 함께 사라집니다. '다른 앱으로 보내기' 로 옮겨 두세요.",
  CACHE: "\n임시 폴더입니다 — 기기가 공간을 정리하면 사라집니다. 지금 '다른 앱으로 보내기' 로 옮겨 주세요.",
};

/// `file:///...` 를 사람이 읽을 수 있게. 못 풀면 원문 그대로 둔다.
function readablePath(uri, fallback) {
  if (!uri) return fallback;
  try {
    return decodeURIComponent(uri);
  } catch {
    return uri;
  }
}

/// 입력칸의 이름을 규칙에 맞게 고치고, **고친 결과를 입력칸에 되돌려 적는다.**
function currentFileName() {
  const input = el("save-name");
  const name = safeFileName(input?.value ?? "");
  if (input && input.value !== name) input.value = name;
  return name;
}

function setSaveHint() {
  const where =
    platform() === "ios"
      ? "'파일에 저장' 을 고르면 폴더를 직접 정할 수 있습니다."
      : "저장 위치는 고른 앱이 정합니다.";
  setText("save-hint", `다른 앱으로 보내면 ${where}`);
}

/**
 * 합친 텍스트를 내보낸다.
 *
 * `"share"` 는 캐시에 쓴 뒤 시스템 시트로 넘긴다 — **저장 경로를 사용자가 정하는 길이 이것이다.**
 * `"save"` 는 이 기기의 문서 폴더에 바로 쓴다 (`bridge.js` 의 `SAVE_ORDER` 참고).
 */
async function runExport(mode) {
  if (state.joined === null || state.exporting) return;

  state.exporting = true;
  enable("scan-save", false);
  enable("scan-share", false);

  const name = currentFileName();
  setText("result-note", "");
  startBusy(mode);

  try {
    if (mode === "share") {
      // 시트가 뜨기 **전에** 막대를 거둔다. 사용자가 앱을 고르는 동안 뒤에서 막대가 도는 것은
      // 진행 중이라는 거짓말이다. 그 시점은 `shareText` 만 알므로 콜백으로 받는다.
      const result = await shareText(name, state.joined, tickBusy, async () => {
        await stopBusy();
        setText("result-note", "앱을 고르는 중…");
      });
      if (!result.shared) {
        setText("result-note", "보내기를 취소했습니다.");
      } else {
        const via = result.activityType ? ` (${result.activityType})` : "";
        setText("result-note", `보냈습니다${via} — 저장 위치는 고른 앱이 정합니다.`);
      }
      return;
    }

    const { uri, directory } = await saveText(name, state.joined, tickBusy);
    await stopBusy();
    // 저장 위치를 그대로 보여 준다. 플랫폼마다 실제 폴더가 달라서, 저장은 됐는데 어디 있는지
    // 모르는 상황이 가장 흔한 불만이다.
    setText("result-note", `저장했습니다 — ${readablePath(uri, name)}${WHERE_NOTE[directory] ?? ""}`);
  } catch (error) {
    await stopBusy();
    const what = mode === "share" ? "보내지" : "저장하지";
    setText("result-note", `${what} 못했습니다: ${reason(error)}`);
  } finally {
    state.exporting = false;
    enable("scan-save", true);
    enable("scan-share", true);
  }
}

async function reset() {
  state.collection = createCollection();
  state.stream = createStream();
  state.mode = null;
  state.joined = null;
  state.lastWarning = "";
  resetExportProgress();
  setText("result-note", "");
  render();
  await beginScan();
}

async function toggleTorch() {
  const next = !state.torch;
  try {
    await setTorch(next);
    state.torch = next;
  } catch {
    // 켜지지 않으면 상태를 되돌린다. 버튼 글자가 실제와 어긋나면 더 헷갈린다.
  }
  setText("scan-torch", state.torch ? "손전등 끄기" : "손전등");
}

// ---------------------------------------------------------------- 시작

function wire() {
  on("scan-start", "click", () => void beginScan());
  on("scan-stop", "click", () => {
    void endScan().then(() => {
      setState("idle");
      state.resume = false;
      setText("perm-note", "");
    });
  });
  on("scan-torch", "click", () => void toggleTorch());
  on("scan-save", "click", () => void runExport("save"));
  on("scan-share", "click", () => void runExport("share"));
  on("scan-reset", "click", () => void reset());
  on("perm-settings", "click", () => void openSettings());

  // 앱이 가려지면 카메라를 놓는다 (OS 가 어차피 회수한다). 돌아오면 하던 일을 이어 간다.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (state.scanning) void endScan();
      return;
    }
    if (state.resume && state.joined === null && !state.scanning) void beginScan();
  });
}

async function main() {
  wire();
  render();

  if (!hasScanner()) {
    // 그냥 브라우저로 이 페이지를 연 경우. 무엇이 없는지 분명히 말해 준다.
    setState("unsupported");
    enable("scan-start", false);
    setText("perm-note", "이 화면은 앱 안에서만 동작합니다 — 카메라 플러그인을 찾지 못했습니다.");
    return;
  }

  if (!(await isSupported())) {
    setState("unsupported");
    enable("scan-start", false);
    setText("perm-note", "이 기기에서는 QR 스캔을 지원하지 않습니다.");
    return;
  }

  // 이미 권한이 있으면 바로 시작한다 — 두 번째 실행부터는 버튼을 한 번 덜 누른다.
  // 권한이 없을 때 여기서 바로 물어보지는 않는다. 무엇에 쓰는 권한인지 먼저 읽게 한다.
  const permission = await cameraPermission();
  if (permission === "granted" || permission === "limited") {
    await beginScan();
    return;
  }

  setState("idle");
  setText("perm-note", "시작을 누르면 카메라 권한을 물어봅니다.");
}

void main();
