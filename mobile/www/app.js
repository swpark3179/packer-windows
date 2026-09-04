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
  barcodeText,
  buzz,
  cameraPermission,
  hasScanner,
  isSupported,
  keepAwake,
  onBarcodes,
  onScanError,
  openSettings,
  requestCameraPermission,
  saveText,
  setTorch,
  startScan,
  stopScan,
  torchAvailable,
} from "./bridge.js";

// ---------------------------------------------------------------- 안내 문구

const REJECT_TEXT = {
  "not-packer": "Packer 가 만든 QR 이 아닙니다.",
  damaged: "조각을 온전히 읽지 못했습니다. 조금 더 가까이서 다시 비춰 주세요.",
  unaligned: "조각이 잘려 들어왔습니다. 다시 비춰 주세요.",
  range: "순번이 올바르지 않습니다.",
  structure: "Packer 조각의 모양이 아닙니다.",
};

const CONFLICT_TEXT = {
  total: "장수가 다른 묶음입니다. 한 묶음의 QR 만 비춰 주세요.",
  body: "같은 순번인데 내용이 다릅니다. 다른 묶음이 섞였습니다.",
  chunk: "다른 묶음의 조각입니다. 한 묶음의 QR 만 비춰 주세요.",
};

// ---------------------------------------------------------------- 상태

const state = {
  /// 지금 모으고 있는 조각들.
  collection: createCollection(),
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

function renderChips() {
  const list = el("scan-list");
  if (!list) return;

  const template = el("chip-template");
  const total = state.collection.total;
  if (!template || total === null) {
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

function handleBarcode(barcode) {
  if (!state.scanning) return;

  const text = barcodeText(barcode);
  if (text === "") return;

  const result = addPiece(state.collection, text);

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

async function finish() {
  // 합치기를 먼저 한다. 여기서 실패하면 카메라를 끄지 않고 계속 모을 수 있어야 한다.
  let joined;
  try {
    joined = joinCollection(state.collection);
  } catch (error) {
    warn(`합치지 못했습니다: ${reason(error)}`, "bad");
    return;
  }

  state.joined = joined;
  await endScan();

  setState("complete");
  setText(
    "result-summary",
    `${state.collection.total}장을 모두 읽어 ${joined.length.toLocaleString("ko-KR")}자로 합쳤습니다.`,
  );
  setText("result-note", "");
  enable("scan-save", true);
  void buzz("done");
}

// ---------------------------------------------------------------- 내보내기

function stamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

async function save() {
  if (state.joined === null) return;

  enable("scan-save", false);
  setText("result-note", "저장 중…");
  try {
    const name = `packer-${stamp()}.txt`;
    const uri = await saveText(name, state.joined);
    // 저장 위치를 그대로 보여 준다. 플랫폼마다 실제 폴더가 달라서, 저장은 됐는데 어디 있는지
    // 모르는 상황이 가장 흔한 불만이다.
    let where = name;
    try {
      where = uri ? decodeURIComponent(uri) : name;
    } catch {
      where = uri || name;
    }
    setText("result-note", `저장했습니다 — ${where}`);
  } catch (error) {
    setText("result-note", `저장하지 못했습니다: ${reason(error)}`);
  } finally {
    enable("scan-save", true);
  }
}

async function reset() {
  state.collection = createCollection();
  state.joined = null;
  state.lastWarning = "";
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
  on("scan-save", "click", () => void save());
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
