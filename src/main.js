// Packer 프론트엔드.
//
// 이 파일은 마크업의 클래스 이름을 하나도 모른다. 모든 참조는 `data-pk="..."` 훅으로만 한다.
// 그래서 디자인을 이식할 때 목업 마크업에 훅 속성만 붙이면 되고, 이 로직은 손대지 않아도 된다.
//
// 훅 목록 (없는 훅은 조용히 무시되므로 부분 이식도 안전하다):
//
//   탭        tab[data-tab=pack|unpack], panel[data-tab=pack|unpack]
//   입력 모드  pack-input-tab[data-input=files|text], pack-input-panel[data-input=…]
//   묶기      pack-dropzone, pack-list, pack-empty, pack-summary, pack-clear,
//             pack-add-files, pack-add-folders, pack-key, pack-key-toggle,
//             pack-key-strength, pack-submit, pack-progress, pack-progress-fill,
//             pack-progress-label, pack-status
//   텍스트 입력 pack-text, pack-text-name, pack-text-count
//   결과 모드  pack-result, pack-result-tab[data-result=text|qr],
//             pack-result-panel[data-result=…]
//   결과 텍스트 pack-output, pack-output-text, pack-output-copy, pack-output-note,
//             pack-save, pack-save-note, pack-reveal
//   결과 QR    pack-qr (data-state=single|split|toobig|stream), pack-qr-image, pack-qr-note,
//             pack-qr-nav, pack-qr-prev, pack-qr-next, pack-qr-index,
//             pack-qr-play, pack-qr-speed, pack-qr-speed-label,
//             pack-qr-jump, pack-qr-goto, pack-qr-goto-go, pack-qr-goto-clear,
//             pack-qr-goto-note
//   스트림     pack-qr-stream, pack-qr-stream-start, pack-qr-stream-note,
//             pack-qr-stream-speed, pack-qr-stream-speed-label,
//             pack-qr-stream-fast, pack-qr-stream-fast-note,
//             pack-qr-stream-frame, pack-qr-stream-grid,
//             pack-qr-tile[value=1|2|4], pack-qr-tiles-note
//   풀기      unpack-dropzone, unpack-pick, unpack-file, unpack-file-name,
//             unpack-file-meta, unpack-text, unpack-text-clear, unpack-source-note,
//             unpack-key, unpack-key-toggle, unpack-key-hint, unpack-dest,
//             unpack-dest-pick, unpack-submit, unpack-progress, unpack-progress-fill,
//             unpack-progress-label, unpack-status, unpack-reveal
//   목록 행   row-template  (안에 [data-field=name], [data-field=meta], [data-pk=row-remove])

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWebview } = window.__TAURI__.webview;

// ---------------------------------------------------------------- 상태

/// 세션 동안만 살아 있는 암호화 키.
///
/// 묶기 탭의 '기억' 버튼을 없앤 대신, "묶고 암호화하기" 가 성공하면 그 키를 여기에 담아 풀기 탭
/// 입력란을 채운다. **디스크에도, localStorage 에도, Rust 쪽에도 저장하지 않는다.** 앱을 닫으면
/// 사라지는 것이 의도다 — 키를 영속 저장하지 않겠다는 게 '기억' 버튼을 뺀 이유이기 때문이다.
const session = { key: "" };

const state = {
  activeTab: "pack",
  /// 무엇을 묶는지. `"files"` 면 드롭한 목록을, `"text"` 면 창에 친 글을 묶는다.
  inputMode: "files",
  /// 결과를 어떻게 옮길지. `"text"` | `"qr"`
  resultTab: "text",
  busy: false,
  /// 묶을 항목. `{ path, name, kind, size, fileCount }`
  items: [],
  /// 방금 묶어 낸 결과. `{ dest, text, savedPath }`
  ///
  /// `dest` 는 **임시 폴더**일 수 있다 — 저장 위치를 묻는 자리가 묶기 앞에서 뒤로 옮겨졌다.
  /// `savedPath` 는 사람이 '파일로 저장' 으로 정한 자리이고, 저장하기 전에는 null 이다.
  packed: null,
  /// 결과 QR 의 나눔과 지금 보고 있는 장.
  /// `{ total, pngModules, index, cache, playing, timer, dwellMs, only, lap }` (없으면 null)
  ///
  /// `only` 는 '놓친 장 부르기' 로 불러낸 번호 목록이다 (없으면 null). 목록이 있으면 넘기기와
  /// 자동 넘김이 **그 장들만** 오간다.
  qr: null,
  /// 스트림 모드로 흘려 보내는 중 (아니면 null).
  /// `{ path, seq, sent, timer, info, ready, filling, deadline }`
  ///
  /// `seq` 는 **다음에 만들** 프레임 번호이고 `ready` 는 이미 만들어 둔 프레임 줄이다 —
  /// 그리는 순간에 IPC 를 기다리지 않아야 슬라이더에 적힌 간격이 실제 간격이 된다.
  stream: null,
  /// 풀어낼 대상. `{ kind: "file" | "text", info, text }`
  source: null,
};

/// 마지막으로 쓴 폴더만 기억한다. 경로는 비밀이 아니고, 매번 같은 곳을 고르는 수고를 덜어 준다.
const REMEMBERED = { saveDir: "packer.lastSaveDir", destDir: "packer.lastDestDir" };

function remember(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 시크릿 모드나 저장소 차단 환경 — 기억하지 못해도 동작에는 지장이 없다.
  }
}

function recall(key) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- DOM 헬퍼

const el = (hook) => document.querySelector(`[data-pk="${hook}"]`);
const all = (hook) => Array.from(document.querySelectorAll(`[data-pk="${hook}"]`));

function setText(hook, text) {
  const node = el(hook);
  if (node) node.textContent = text;
}

function show(hook, visible) {
  const node = el(hook);
  if (node) node.hidden = !visible;
}

function parentDir(filePath) {
  const cut = Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/"));
  return cut > 0 ? filePath.slice(0, cut) : "";
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  const digits = i === 0 ? 0 : value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[i]}`;
}

/// QR 한도 근처에서 쓰는 크기 표기.
///
/// `formatBytes` 는 2953 도 3000 도 "2.9 KB" 로 적는다. 그러면 안내문이 "2.9 KB라서 2.9 KB 를
/// 넘습니다" 처럼 스스로 모순된다. QR 로 다룰 수 있는 범위가 전부 64 KB 아래에 들어오므로,
/// 그 아래는 정확한 바이트로 말해 값과 한도의 자릿수가 겹치지 않게 한다.
function qrBytes(bytes) {
  if (bytes >= 64 * 1024) return formatBytes(bytes);
  return `${String(bytes).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} B`;
}

/// Rust 쪽 에러는 `{ code, message }` 로 온다. message 는 이미 완성된 한국어 문장이다.
function errorText(err) {
  if (err && typeof err === "object" && typeof err.message === "string") return err.message;
  if (typeof err === "string") return err;
  return "알 수 없는 오류가 발생했습니다.";
}

// ---------------------------------------------------------------- 탭

function setTab(tab) {
  state.activeTab = tab;
  for (const button of all("tab")) {
    const isActive = button.dataset.tab === tab;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  }
  for (const panel of all("panel")) {
    panel.hidden = panel.dataset.tab !== tab;
  }
}

/// 탭 한 줄을 고른다. 버튼과 패널이 같은 `data-*` 값으로 짝지어져 있으면 어느 줄이든 쓴다.
function selectSubTab(tabHook, panelHook, key, value) {
  for (const button of all(tabHook)) {
    const isActive = button.dataset[key] === value;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  }
  for (const panel of all(panelHook)) {
    panel.hidden = panel.dataset[key] !== value;
  }
}

/**
 * 무엇을 묶을지 고른다.
 *
 * **모드를 바꿔도 담아 둔 것은 지우지 않는다.** 파일 목록과 텍스트는 서로 다른 자리에 있고,
 * 왔다 갔다 하는 사이에 한쪽이 사라지면 실수로 잃는다. 묶을 때 지금 모드의 것만 쓴다.
 */
function setInputMode(mode) {
  state.inputMode = mode;
  selectSubTab("pack-input-tab", "pack-input-panel", "input", mode);
  // "묶을 파일을 먼저 추가해 주세요" 는 모드를 바꾸는 순간 뜻을 잃는다. 성공 안내는 남긴다.
  clearErrorStatus("pack");
  refreshButtons();
}

/// 결과를 어떻게 옮길지 고른다.
function setResultTab(tab) {
  state.resultTab = tab;
  selectSubTab("pack-result-tab", "pack-result-panel", "result", tab);
  // QR 탭에서 나가면 화면에 그림이 서 있어도 폰은 아무것도 못 읽는다. 그대로 돌게 두면
  // 프레임 번호만 앞으로 가고 폰은 그 번호들을 영영 못 본다.
  if (tab !== "qr") {
    stopQrPlay();
    stopQrStream();
  }
}

/// 텍스트 입력 모드에 지금 들어 있는 글.
function packTextValue() {
  return el("pack-text")?.value ?? "";
}

/// 글자 수를 세어 준다. 묶기 전에 크기를 가늠할 수 있는 유일한 숫자다.
function renderPackTextCount() {
  const text = packTextValue();
  setText(
    "pack-text-count",
    text.length === 0 ? "" : `${text.length.toLocaleString("ko-KR")}자`,
  );
}

// ---------------------------------------------------------------- 묶기: 목록

function renderList() {
  const list = el("pack-list");
  const { items } = state;

  show("pack-empty", items.length === 0);
  const summary =
    items.length === 0
      ? ""
      : `${items.length}개 항목 · 파일 ${items.reduce((n, i) => n + i.fileCount, 0)}개 · ` +
        formatBytes(items.reduce((n, i) => n + i.size, 0));
  setText("pack-summary", summary);

  const clear = el("pack-clear");
  if (clear) clear.disabled = items.length === 0 || state.busy;

  if (!list) return;
  list.textContent = "";

  const template = el("row-template");
  for (const item of items) {
    let row;
    if (template && "content" in template) {
      row = template.content.firstElementChild.cloneNode(true);
    } else {
      // 목업에 행 템플릿이 없을 때를 위한 최소 형태.
      row = document.createElement("div");
      row.className = "row";
      row.innerHTML =
        '<span data-field="name"></span><span data-field="meta"></span>' +
        '<button type="button" data-pk="row-remove" aria-label="목록에서 제거">&times;</button>';
    }

    const name = row.querySelector('[data-field="name"]');
    if (name) {
      name.textContent = item.name;
      name.title = item.path;
    }

    const meta = row.querySelector('[data-field="meta"]');
    if (meta) {
      if (item.kind === "missing") {
        meta.textContent = "찾을 수 없음";
      } else if (item.kind === "dir") {
        meta.textContent = `폴더 · 파일 ${item.fileCount}개 · ${formatBytes(item.size)}`;
      } else {
        meta.textContent = formatBytes(item.size);
      }
    }

    row.dataset.kind = item.kind;
    const remove = row.querySelector('[data-pk="row-remove"]');
    if (remove) {
      remove.disabled = state.busy;
      remove.addEventListener("click", () => {
        state.items = state.items.filter((i) => i.path !== item.path);
        renderList();
        refreshButtons();
      });
    }

    list.appendChild(row);
  }
}

async function addPaths(paths) {
  if (!paths || paths.length === 0) return;
  // 이미 목록에 있는 건 다시 재지 않는다.
  const known = new Set(state.items.map((i) => i.path));
  const fresh = paths.filter((p) => !known.has(p));
  if (fresh.length === 0) return;

  try {
    const summary = await invoke("scan_paths", { paths: fresh });
    for (const item of summary.items) {
      state.items.push({
        path: item.path,
        name: item.name,
        kind: item.kind,
        size: item.size,
        fileCount: item.file_count,
      });
    }
    clearStatus("pack");
    renderList();
    refreshButtons();
  } catch (err) {
    setStatus("pack", errorText(err), "error");
  }
}

// ---------------------------------------------------------------- 풀기: 대상 고르기

function describe(info) {
  const shape = info.armored ? "텍스트" : "이전 형식(바이너리)";
  return `${formatBytes(info.byte_size)} · ${shape} · ${info.cipher} · ${info.compression} · 포맷 v${info.format_version}`;
}

function renderSource() {
  const { source } = state;
  show("unpack-file", Boolean(source));
  if (source) {
    setText("unpack-file-name", source.info.name);
    setText("unpack-file-meta", describe(source.info));
  }
  setText(
    "unpack-source-note",
    source ? (source.kind === "text" ? "붙여넣은 텍스트를 풉니다." : "선택한 파일을 풉니다.") : "",
  );
  show("unpack-source-note", Boolean(source));
  refreshButtons();
}

/// 파일을 대상으로 고른다. 붙여넣은 텍스트가 있었다면 비운다.
async function selectContainerFile(path) {
  try {
    const info = await invoke("inspect", { path });
    state.source = { kind: "file", info, text: null };
    const textarea = el("unpack-text");
    if (textarea) textarea.value = "";
    clearStatus("unpack");
  } catch (err) {
    state.source = null;
    setStatus("unpack", errorText(err), "error");
  }
  renderSource();
}

/// 붙여넣은 텍스트를 대상으로 고른다.
async function selectContainerText(text) {
  if (!text.trim()) {
    state.source = null;
    clearStatus("unpack");
    renderSource();
    return;
  }
  try {
    const info = await invoke("inspect_text", { text });
    state.source = { kind: "text", info, text };
    clearStatus("unpack");
  } catch (err) {
    state.source = null;
    setStatus("unpack", errorText(err), "error");
  }
  renderSource();
}

// ---------------------------------------------------------------- 상태 표시 / 진행률

function setStatus(tab, message, kind) {
  const node = el(`${tab}-status`);
  if (!node) return;
  node.textContent = message;
  node.dataset.kind = kind || "info";
  node.hidden = !message;
}

function clearStatus(tab) {
  setStatus(tab, "", "info");
  show(`${tab}-reveal`, false);
}

/// 오류만 걷어 낸다.
///
/// 성공 안내는 방금 묶어 낸 결과를 가리키는 문장이라, 입력 모드를 바꾸거나 다음에 묶을 글을
/// 적기 시작했다고 거짓이 되지 않는다. 함께 지우면 '탐색기에서 보기' 까지 사라져서, 저장해 둔
/// 파일로 가는 길이 이유 없이 끊긴다.
function clearErrorStatus(tab) {
  const node = el(`${tab}-status`);
  if (node && node.dataset.kind === "error") setStatus(tab, "", "info");
}

function renderProgress(tab, payload) {
  show(`${tab}-progress`, true);
  const { done_bytes: done, total_bytes: total, phase, current_path: current } = payload;

  const fill = el(`${tab}-progress-fill`);
  const ratio = total > 0 ? Math.min(done / total, 1) : 0;
  if (fill) {
    fill.style.width = total > 0 ? `${(ratio * 100).toFixed(1)}%` : "100%";
    // 총량을 모르는 동안은 불확정 상태로 둔다.
    fill.dataset.indeterminate = total > 0 ? "false" : "true";
  }

  const bar = el(`${tab}-progress`);
  if (bar) {
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    if (total > 0) bar.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
    else bar.removeAttribute("aria-valuenow");
  }

  const verb = tab === "pack" ? "묶는 중" : "푸는 중";
  let label;
  if (phase === "finishing") {
    label = "마무리하는 중…";
  } else if (total > 0) {
    label = `${verb} ${Math.round(ratio * 100)}% · ${formatBytes(done)} / ${formatBytes(total)}`;
    if (current) label += ` · ${current}`;
  } else {
    label = `${verb}…`;
  }
  setText(`${tab}-progress-label`, label);
}

function resetProgress(tab) {
  const fill = el(`${tab}-progress-fill`);
  if (fill) {
    fill.style.width = "0%";
    fill.dataset.indeterminate = "false";
  }
  setText(`${tab}-progress-label`, "");
  show(`${tab}-progress`, false);
}

// ---------------------------------------------------------------- 키 입력

/// 아주 대략적인 키 강도. Argon2id 가 실제 방어선이고 이건 사용자에게 주는 힌트다.
function keyStrength(key) {
  if (!key) return null;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(key)).length;
  const hasKorean = /[ㄱ-힝]/.test(key);
  const score = key.length + classes * 4 + (hasKorean ? 6 : 0);
  if (key.length < 8) return { level: "weak", text: "너무 짧습니다 (8자 이상 권장)" };
  if (score < 20) return { level: "weak", text: "약함" };
  if (score < 30) return { level: "fair", text: "보통" };
  return { level: "strong", text: "강함" };
}

function wireKeyField(tab) {
  const input = el(`${tab}-key`);
  if (!input) return;
  input.type = "password";
  input.setAttribute("autocomplete", "new-password");
  input.setAttribute("spellcheck", "false");

  input.addEventListener("input", () => {
    if (tab === "pack") {
      const strength = keyStrength(input.value);
      const node = el("pack-key-strength");
      if (node) {
        node.textContent = strength ? strength.text : "";
        node.dataset.level = strength ? strength.level : "";
        node.hidden = !strength;
      }
    }
    if (tab === "unpack") show("unpack-key-hint", false);
    clearStatus(tab);
    refreshButtons();
  });

  const toggle = el(`${tab}-key-toggle`);
  if (toggle) {
    const sync = () => {
      const shown = input.type === "text";
      toggle.setAttribute("aria-pressed", String(shown));
      toggle.classList.toggle("is-active", shown);
      if (!toggle.dataset.keepLabel) toggle.title = shown ? "키 숨기기" : "키 보기";
    };
    toggle.addEventListener("click", () => {
      input.type = input.type === "password" ? "text" : "password";
      sync();
    });
    sync();
  }
}

/// 묶기에서 쓴 키를 풀기 탭으로 이어 준다.
function applySessionKey() {
  const input = el("unpack-key");
  if (!input || !session.key) return;
  input.value = session.key;
  show("unpack-key-hint", true);
  refreshButtons();
}

// ---------------------------------------------------------------- 버튼 상태

/// 지금 모드에 묶을 것이 들어 있는지.
function hasSomethingToPack() {
  return state.inputMode === "text"
    ? packTextValue().trim().length > 0
    : state.items.length > 0;
}

function refreshButtons() {
  const packKey = el("pack-key");
  const packSubmit = el("pack-submit");
  if (packSubmit) {
    packSubmit.disabled = state.busy || !hasSomethingToPack() || !(packKey && packKey.value);
  }

  const unpackKey = el("unpack-key");
  const unpackSubmit = el("unpack-submit");
  if (unpackSubmit) {
    unpackSubmit.disabled = state.busy || !state.source || !(unpackKey && unpackKey.value);
  }

  const clear = el("pack-clear");
  if (clear) clear.disabled = state.busy || state.items.length === 0;

  const copy = el("pack-output-copy");
  if (copy) copy.disabled = state.busy || !state.packed;

  // QR 넘기기. 끝 판정과 작업 중 잠금을 한곳에서 계산한다 — 아래 일괄 잠금 목록에 넣으면
  // `disabled = state.busy` 가 끝 판정을 덮어써서 마지막 장에서도 '다음' 이 열린다.
  const qr = state.qr;
  const qrPrev = el("pack-qr-prev");
  const qrNext = el("pack-qr-next");
  const qrPlay = el("pack-qr-play");
  // 놓친 장 목록이 있으면 양끝은 **목록의** 양끝이다. 전체의 1번·마지막 장이 아니다.
  const at = qrOnlyAt(qr);
  const atFirst = qr?.only ? at === 0 : qr?.index === 0;
  const atLast = qr?.only ? at === qr.only.length - 1 : Boolean(qr) && qr.index >= qr.total - 1;
  if (qrPrev) qrPrev.disabled = state.busy || !qr || atFirst;
  if (qrNext) qrNext.disabled = state.busy || !qr || atLast;
  // 재생은 끝 장에서도 열어 둔다 — 거기서 누르면 처음부터 다시 돈다.
  if (qrPlay) qrPlay.disabled = state.busy || !qr || qr.total <= 1;

  for (const hook of [
    "pack-add-files",
    "pack-add-folders",
    "unpack-pick",
    "unpack-dest-pick",
    "unpack-text-clear",
    "pack-key-toggle",
    "unpack-key-toggle",
    "pack-qr-goto",
    "pack-qr-goto-go",
    "pack-qr-goto-clear",
    "pack-text-name",
  ]) {
    const node = el(hook);
    if (node) node.disabled = state.busy;
  }
  for (const node of [packKey, unpackKey, el("unpack-dest"), el("unpack-text"), el("pack-text")]) {
    if (node) node.disabled = state.busy;
  }
  // 저장은 결과가 있어야 뜻이 있다. 임시 폴더에 앉아 있는 것을 사람이 정한 자리로 옮기는 일이다.
  const save = el("pack-save");
  if (save) save.disabled = state.busy || !state.packed;
  for (const tab of all("tab")) tab.disabled = state.busy;
  for (const tab of all("pack-input-tab")) tab.disabled = state.busy;
  for (const tab of all("pack-result-tab")) tab.disabled = state.busy;
}

function setBusy(busy) {
  state.busy = busy;
  document.body.dataset.busy = String(busy);
  refreshButtons();
  renderList();
}

// ---------------------------------------------------------------- 동작: 묶기

/// 컨테이너 기본 파일 이름. 결과가 텍스트이므로 확장자도 `.txt` 다.
function suggestContainerName() {
  if (state.inputMode === "text") {
    const base = (el("pack-text-name")?.value || "").trim().replace(/\.[^.]+$/, "");
    if (base) return `${base}.packer.txt`;
    return datedContainerName();
  }
  if (state.items.length === 1) {
    const base = state.items[0].name.replace(/\.[^.]+$/, "");
    return `${base}.packer.txt`;
  }
  return datedContainerName();
}

function datedContainerName() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `packer-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.txt`;
}

function renderPackOutput(result) {
  state.packed = { dest: result.dest, text: result.preview || null, savedPath: null };

  const textarea = el("pack-output-text");
  if (textarea) textarea.value = result.preview || "";

  show("pack-result", true);
  show("pack-output", true);
  setText(
    "pack-output-note",
    result.preview_omitted
      ? `텍스트가 ${formatBytes(result.container_bytes)}라서 화면에는 띄우지 않았습니다. 아래 '파일로 저장' 으로 내려받아 그대로 보내 주세요.`
      : `${formatBytes(result.container_bytes)} · 전체를 복사해 메모장이나 메신저에 붙여도 그대로 풀립니다.`,
  );
  // **아직 어디에도 저장되지 않았다는 것을 먼저 말한다.** 예전에는 묶기 전에 저장 위치를
  // 물었으므로 결과가 뜬 시점에 파일은 이미 그 자리에 있었다. 지금은 임시 폴더에 앉아 있고
  // 다음 묶기에서 지워지므로, 그 사실을 감추면 사람은 저장한 줄 알고 앱을 닫는다.
  setText(
    "pack-save-note",
    "아직 파일로 저장하지 않았습니다 — 다시 묶으면 이 결과는 사라집니다.",
  );
  show("pack-reveal", false);

  // 화면에 못 띄운 경우에도 클립보드로는 옮길 수 있다 (파일에서 직접 읽는다).
  const copy = el("pack-output-copy");
  if (copy) copy.disabled = false;
  setResultTab("text");
  refreshButtons();
}

function clearPackOutput() {
  state.packed = null;
  const textarea = el("pack-output-text");
  if (textarea) textarea.value = "";
  show("pack-output", false);
  show("pack-result", false);
  setText("pack-save-note", "");
  show("pack-reveal", false);
  // 지난 QR 이 남으면 *이전* 컨테이너를 가리키는 그림을 새 결과인 줄 알고 찍어 보낸다.
  // 텍스트를 치우는 모든 경로에서 그림도 함께 사라지도록 여기 안에 둔다.
  clearPackQr();
  refreshButtons();
}

// ---------------------------------------------------------------- 결과 QR

/// 자동 넘김의 기본 체류 시간(ms). 슬라이더의 범위는 `index.html` 이 정한다.
///
/// 300ms 아래로 내리지 않는 이유가 둘이다. 하나, ML Kit 이 심볼 하나를 안정적으로 잡으려면
/// 디코드(40~120ms) 위에 카메라 노출·초점이 얹힌다. 둘, 화면을 가득 채운 고대비 그림이 초당
/// 3회를 넘겨 바뀌는 것은 WCAG 2.3.1 이 경고하는 구간에 들어간다. 두 하한이 거의 같은 자리에
/// 있어서, 접근성 쪽을 지키는 데 성능 비용이 들지 않는다.
const QR_DWELL_DEFAULT_MS = 350;

/// 슬라이더의 기본 하한(ms). `index.html` 의 `min` 과 같은 값이어야 한다 — 스트림의
/// '빠르게 보내기' 를 껐을 때 여기로 되돌린다.
const QR_DWELL_MIN_MS = 300;

/// 미리 받아 둘 장 수. 체류 시간 안에 IPC 왕복 + PNG 인코딩이 끝나야 그림이 끊기지 않는다.
const QR_PREFETCH = 3;

/**
 * 결과 텍스트를 QR 코드 그림으로도 보여 준다.
 *
 * 그림은 **한 장씩 받아 온다** (`qr_piece`). 조각 상한이 128장이라 한꺼번에 실어 보내면 응답이
 * 메가바이트가 되는데, 뷰어는 어차피 한 번에 한 장만 보여 준다. 첫 장은 묶기 응답에 함께
 * 실려 오므로 결과가 뜨는 순간 바로 그릴 수 있다.
 */
function renderPackQr(result) {
  const info = result.qr_plan;
  stopQrPlay();

  state.qr = info
    ? {
        total: Number(info.total) || 0,
        pngModules: Number(info.png_modules) || 0,
        index: 0,
        /// 받아 둔 그림. 조각 번호(1부터) → { png_base64, text_bytes }.
        cache: new Map(),
        playing: false,
        timer: null,
        dwellMs: qrDwellFromUi(),
        /// 놓친 장 목록 (1부터). 없으면 null — 그때는 전체를 순서대로 돈다.
        only: null,
        /// 그 목록을 몇 바퀴째 돌고 있는지. 목록은 되풀이하므로 이 숫자만이 진행을 말해 준다.
        lap: 0,
      }
    : null;

  if (state.qr && result.qr_first) {
    state.qr.cache.set(1, result.qr_first);
  }

  const section = el("pack-qr");
  if (section) {
    section.dataset.state = !state.qr ? "toobig" : state.qr.total > 1 ? "split" : "single";
  }

  show("pack-qr", true);
  // 안내 문구는 결과마다 한 번만 정한다. 장을 넘길 때는 건드리지 않는다 — 읽는 도중에 문장이
  // 바뀌면 읽던 자리를 잃는다.
  setText("pack-qr-note", qrNote(result, state.qr));
  // 지난 결과의 놓친 장 목록이 남아 있으면 새 묶음의 엉뚱한 장을 부른다.
  const jump = el("pack-qr-goto");
  if (jump) jump.value = "";
  setText("pack-qr-goto-note", "");
  showPackQrPage();
  void prefetchQr();

  // 조각 모드에 담기지 않는 크기면 스트림 모드를 제안한다. 담기는 크기면 제안하지 않는다 —
  // 스트림은 기본 카메라로 찍어 붙여넣을 수 없어서, 되는 쪽이 있으면 언제나 그쪽이 낫다.
  show("pack-qr-stream", !state.qr && Boolean(state.packed));
  setText("pack-qr-stream-note", "");
}

// ------------------------------------------------------------ 스트림 모드

/// 스트림이 앞서 만들어 두는 프레임 수.
///
/// 조각 모드의 [`QR_PREFETCH`] 와 같은 이유지만 여기서는 **정확도**의 문제이기도 하다. 예전에는
/// 프레임을 그리는 자리에서 `qr_stream_frame` 을 기다렸다가 그 뒤에 체류 시간을 셌다. 그러면
/// 실제 간격이 `체류 시간 + 만드는 시간` 이라 슬라이더에 적힌 것보다 늘 느렸고, 체류 시간을
/// 줄일수록 그 오차가 차지하는 비율이 커졌다 — 350ms 에서 10% 남짓이던 것이 150ms 에서는
/// 25% 가 된다. 빠른 구간을 열어 두려면 이 항부터 없애야 한다.
const STREAM_PREFETCH = 3;

/// 한 화면에 세울 프레임 수의 기본값.
///
/// **2 인 이유가 카메라 프레임의 모양에 있다.** 폰 카메라는 16:9(1920×1080)인데 QR 은
/// 정사각형이라, 한 장만 띄우면 프레임의 좌우가 통째로 논다 — 실제로 쓰이는 넓이가 56% 다.
/// 두 장을 나란히 세우면 심볼 한 변이 1080px 몫에서 960px 몫으로 11% 줄어드는 대신, 한 번
/// 비출 때 두 프레임이 들어간다.
///
/// 파운틴 부호라 받는 쪽은 손댈 것이 없다. 프레임마다 번호가 헤더에 들어 있고 순서도 중복도
/// 상관없으며, 폰의 스캐너는 이미 한 카메라 프레임에서 찾은 심볼을 **전부** 넘긴다
/// (`mobile/www/bridge.js` 의 `onBarcodes` 가 `event.barcodes` 를 훑는다).
///
/// # 왜 속도를 올리는 것보다 나은가
///
/// 넘김 **횟수**가 그대로이기 때문이다. `QR_DWELL_FAST_MIN_MS` 가 설명하는 두 벽 중
/// 롤링 셔터가 프레임을 찢는 비율은 넘기는 순간에 붙는 비용이라, 타일을 늘려도 늘지 않는다.
/// 초당 3회를 넘겨 바뀌는 화면을 경고하는 WCAG 2.3.1 도 마찬가지다 — 350ms 에 두 장은
/// 175ms 에 한 장과 처리량이 같은데 화면은 여전히 초당 2.9회만 바뀐다.
///
/// 남는 벽은 하나, **폰이 초당 푸는 심볼 수(8~12장)** 다. 350ms 에 두 장이면 초당 5.7장이라
/// 아직 아래에 있고, 네 장이면 11.4장으로 천장에 닿는다. 그래서 4장은 고를 수 있게만 두고
/// 기본값으로 삼지 않는다 (`renderStreamTiles` 가 그 선을 넘으면 화면에 적는다).
const STREAM_TILES_DEFAULT = 2;

/// 고를 수 있는 타일 수. 3장은 없다 — 2열로 세우는 4장이 같은 폭에서 더 많이 담는다.
const STREAM_TILE_CHOICES = [1, 2, 4];

/// 타일 하나가 한 열에서 쓰는 기준 폭(px). 한 장일 때는 조각 모드의 그림판과 같은 값이다.
const QR_STAGE_PX = 560;

/// 타일 판이 넓어질 수 있는 한도(px). 창 기본 폭(940)에서 바깥 여백을 뺀 값이다.
const QR_STAGE_MAX_PX = 840;

/// 타일 사이 여백(px). `styles.css` 의 `.qr-tile-grid` gap 과 같아야 배율 계산이 실제 자리와 맞다.
const QR_TILE_GAP_PX = 12;

/// 폰이 초당 풀 수 있는 심볼 수의 어림 천장. 이 위로는 보낸 프레임이 그냥 지나간다.
const PHONE_SYMBOLS_PER_SECOND = 12;

/// 지금 고른 타일 수.
function streamTiles() {
  for (const radio of all("pack-qr-tile")) {
    if (radio.checked && STREAM_TILE_CHOICES.includes(Number(radio.value))) {
      return Number(radio.value);
    }
  }
  return STREAM_TILES_DEFAULT;
}

/// 타일 수에 따른 열 수. 4장은 한 줄로 늘어놓지 않고 2×2 로 세운다.
function streamCols(tiles) {
  return tiles === 4 ? 2 : tiles;
}

/**
 * 타일 하나의 화면 폭(px).
 *
 * PNG 은 1모듈 = 1픽셀이므로 **정수 배율로만** 키운다. 배율에 소수점이 붙으면 모듈 폭이
 * 3px/4px 로 들쭉날쭉해져 초점이 맞아도 인식되지 않는다. 모듈당 3px 이 하한이다 — 그 아래로
 * 내려가느니 판이 넘치게 두는 편이 낫다. 인식되지 않는 그림은 작아도 쓸모가 없다.
 */
function streamTileWidth(modules, tiles) {
  if (!(modules > 0)) return 0;
  const cols = streamCols(tiles);
  // 한 장이면 지금까지와 똑같은 크기다. 여러 장이면 판을 넓혀 열마다 제 몫을 준다 —
  // 좁은 판을 그대로 나누면 타일이 하한까지 떨어져 판만 넘치고 얻는 것이 없다.
  const stage = Math.min(QR_STAGE_PX * cols, QR_STAGE_MAX_PX);
  const budget = Math.floor((stage - QR_TILE_GAP_PX * (cols - 1)) / cols);
  return modules * Math.max(3, Math.min(10, Math.floor(budget / modules)));
}

/// 타일 판을 `tiles` 장에 맞춘다. 이미 맞으면 그대로 두고 그림만 갈아 끼운다.
function ensureStreamTiles(tiles) {
  const grid = el("pack-qr-stream-grid");
  if (!grid) return [];
  grid.dataset.cols = String(streamCols(tiles));
  while (grid.childElementCount > tiles) grid.lastElementChild.remove();
  while (grid.childElementCount < tiles) {
    const image = document.createElement("img");
    image.className = "qr-image";
    image.draggable = false;
    grid.appendChild(image);
  }
  return Array.from(grid.children);
}

/// 한 화면 몫을 세운다. 프레임 수와 타일 수는 부르는 쪽이 맞춰 준다.
function paintStreamTiles(frames) {
  const tiles = frames.length;
  const images = ensureStreamTiles(tiles);
  const width = streamTileWidth(frames[0]?.modules ?? 0, tiles);
  for (let at = 0; at < images.length; at += 1) {
    const image = images[at];
    const frame = frames[at];
    if (!frame) continue;
    image.src = frame.url;
    if (width > 0) image.style.width = `${width}px`;
    else image.style.removeProperty("width");
    image.alt =
      tiles > 1
        ? `묶은 결과를 흘려 보내는 QR 코드 ${tiles}장 중 ${at + 1}번째`
        : "묶은 결과를 흘려 보내는 QR 코드";
  }
}

/**
 * 타일 수를 고친 결과를 화면에 적는다.
 *
 * **처리량을 그대로 말해 준다.** 타일을 늘리는 것은 넘김 속도를 올리는 것과 이득의 모양이
 * 달라서(넘김 횟수가 늘지 않는다), 두 조작을 같은 단위로 적어 주지 않으면 어느 쪽을 만져야
 * 하는지 알 수 없다. 그 단위가 '초당 몇 장' 이고, 폰 화면에도 같은 숫자가 뜬다.
 */
function renderStreamTiles() {
  const tiles = streamTiles();
  const perSecond = (tiles * 1000) / qrStreamDwell();
  const rate = `초당 ${perSecond.toFixed(1)}장`;

  let note =
    tiles === 1
      ? `한 번에 한 장씩 보냅니다 — ${rate}.`
      : `한 화면에 ${tiles}장을 세웁니다 — 넘김 횟수는 그대로고 초당 들어가는 양만 ` +
        `${tiles}배입니다 (${rate}). 폰은 한 카메라 프레임에서 본 심볼을 전부 받습니다.`;

  // 한 바퀴에 걸리는 시간은 타일 수와 넘김 속도의 곱으로 정해진다. 두 조작이 여기 붙어
  // 있으므로 결과도 여기 적는다 — 시작할 때 한 번 적어 둔 `pack-qr-note` 의 숫자는 설정을
  // 바꾸는 순간 거짓이 된다.
  const needed = Number(state.stream?.info?.frames_needed) || 0;
  if (needed > 0) {
    const minutes = Math.max(1, Math.round((needed * qrStreamDwell()) / (60000 * tiles)));
    note += ` 이 설정이면 한 바퀴에 약 ${minutes}분입니다.`;
  }

  if (perSecond > PHONE_SYMBOLS_PER_SECOND) {
    // 여기서부터는 늘려도 총량이 늘지 않는다. 그 사실은 PC 화면에 나타나지 않는다 —
    // PC 는 보낸 장수만 세고 있어서, 확인은 폰에서만 된다.
    note +=
      `\n폰이 초당 ${PHONE_SYMBOLS_PER_SECOND}장쯤까지만 풉니다. 지금 설정은 그 천장을 ` +
      `넘어서, 넘긴 프레임은 그냥 지나갑니다 — 넘김 속도를 늦추거나 장수를 줄여 주세요. ` +
      `폰에 뜨는 '초당 n장' 이 늘지 않으면 그 상태입니다.`;
  } else if (tiles === 4) {
    note += `\n4장은 판이 넓어집니다. 창을 키우거나 최대화해 네 장이 다 보이게 두세요 — ` +
      `잘린 심볼은 읽히지 않습니다.`;
  }

  setText("pack-qr-tiles-note", note);
}

/// '빠르게 보내기' 를 켰을 때 열리는 하한(ms). 기본 하한은 `index.html` 의 슬라이더가 정한다.
///
/// **스트림에서는 놓친 프레임의 값이 다르다.** 조각 모드에서 한 장을 놓치면 그 장이 다시 올
/// 때까지 한 바퀴를 기다려야 하지만(쿠폰 수집가 문제), 파운틴 부호에서는 다음 프레임이 그대로
/// 대신한다. 그래서 목표가 '한 프레임의 인식률' 에서 '초당 실제로 들어가는 바이트' 로 바뀌고,
/// 조금 놓치더라도 자주 넘기는 편이 이긴다.
///
/// 그렇다고 0 으로 갈 수 있는 것은 아니다. 두 벽이 남는다.
///
/// 하나, **폰이 초당 푸는 심볼 수**에 천장이 있다. ML Kit 의 디코드(125모듈 심볼에 40~120ms)
/// 위에 카메라 노출·초점이 얹혀 실제로는 초당 8~12장 언저리다. 그보다 빨리 넘기면 남는 프레임은
/// 그냥 버려진다 — 이득이 0 이 되는 것이 아니라, 아래 이유로 **마이너스**가 된다.
///
/// 둘, **찢어진 프레임**이다. 폰의 롤링 셔터는 한 장을 위에서 아래로 15~30ms 에 걸쳐 읽고,
/// 그 사이에 화면이 넘어가면 위아래가 다른 심볼인 그림이 찍혀 아무것도 읽히지 않는다. 체류
/// 시간이 D 일 때 못 쓰게 되는 비율이 대략 (읽는 시간)/D 이므로, D 를 줄이면 넘기는 횟수는
/// 선형으로 늘지만 성공률은 그만큼 깎인다. 150ms 언저리가 그 둘이 아직 남는 장사인 자리다 —
/// 더 내리면 기기에 따라 총량이 오히려 준다.
///
/// 150ms 는 초당 6.7회다. 초당 3회를 넘겨 바뀌는 고대비 그림은 WCAG 2.3.1 이 경고하는
/// 구간이므로 **기본값으로 두지 않고 켜야 열리게** 했다. 기본값 350ms 는 초당 2.9회로 그 선
/// 아래에 있다.
const QR_DWELL_FAST_MIN_MS = 150;

/// 껐다 켰을 때 이어 갈 자리. `{ path, seq, sent }`
///
/// **프레임 번호를 0 으로 되돌리면 안 된다.** 폰은 번호로 중복을 가리는데
/// (`mobile/www/stream.js` 의 `seen`), 이미 3,000장을 모아 둔 폰에게 0번부터 다시 보내면
/// 3,000장이 전부 중복으로 버려진다. 화면은 멀쩡히 돌고 폰은 한 장도 받지 못하는데, 폰의 계기는
/// 그 상태를 "PC 쪽 스트림이 멈춰 있는지 봐 주세요" 라고 **거꾸로** 읽는다 (새 프레임 없이
/// 중복만 느는 것은 원래 PC 가 멈췄다는 뜻이라서다). 속도를 바꾸려고 껐다 켜는 것만으로 그
/// 상태에 빠지므로, 같은 컨테이너면 번호를 이어 붙인다.
///
/// 이것이 스트림에서 '되감기' 에 해당하는 유일한 조작이다. 앞으로 이어 가는 것만 뜻이 있고,
/// 뒤로 가는 것은 폰이 이미 본 번호를 다시 보내는 일이라 언제나 손해다.
let streamResume = { path: "", seq: 0, sent: 0 };

/**
 * 파운틴 부호로 끝없이 흘려 보낸다.
 *
 * 조각 모드와 달리 **끝이 없다.** 아무 프레임이나 충분히 모으면 폰이 스스로 다 풀고 화면을
 * 바꾸므로, 여기서는 멈출 시점을 알 수 없고 알 필요도 없다. 그래서 '다음이 잠긴다' 는 신호가
 * 성립하지 않고, 대신 보낸 프레임 수와 예상 시간을 적어 준다.
 */
async function startQrStream() {
  if (!state.packed) return;
  stopQrPlay();

  let opened;
  try {
    opened = await invoke("qr_stream_open", { path: state.packed.dest });
  } catch (error) {
    setText("pack-qr-stream-note", `스트림을 열지 못했습니다: ${errorText(error)}`);
    return;
  }

  const path = state.packed.dest;
  const resumed = streamResume.path === path && streamResume.seq > 0;
  const stream = {
    path,
    seq: resumed ? streamResume.seq : 0,
    sent: resumed ? streamResume.sent : 0,
    timer: null,
    info: opened,
    /// 미리 만들어 둔 프레임 줄. `{ seq, url, modules }`
    ready: [],
    filling: false,
    /// 다음 프레임을 그릴 시각(`performance.now()` 기준). 만드는 시간이 간격에 얹히지 않도록
    /// 시각으로 잡는다 — 매번 `setTimeout(dwell)` 로 재면 그 시간만큼 계속 밀린다.
    deadline: 0,
  };
  state.stream = stream;
  const section = el("pack-qr");
  if (section) section.dataset.state = "stream";
  show("pack-qr-nav", false);
  // 조각 모드의 그림판은 접고 타일 판을 편다. 같은 <img> 를 돌려 쓰지 않는 이유는 배율이다 —
  // 한쪽은 한 장을, 다른 쪽은 여러 장을 세우므로 두 모드가 서로의 폭을 덮어쓴다.
  show("pack-qr-image", false);
  show("pack-qr-stream-frame", true);

  const tiles = streamTiles();
  // 이어서 보내는 것은 이 판이 끝날 때까지 변하지 않는 사실이라 **프레임마다 바뀌는 줄이 아니라**
  // 결과 안내에 적는다. 아래 `pack-qr-stream-note` 는 첫 프레임에서 곧바로 덮인다.
  const resumeLine = resumed
    ? `\n지난번 다음 번호(${stream.seq.toLocaleString("ko-KR")})부터 이어서 보냅니다 — ` +
      `폰이 모아 둔 것을 그대로 살립니다.`
    : "";
  // **걸리는 시간은 여기 적지 않는다.** 넘김 속도와 타일 수의 곱으로 정해지는데 둘 다 도는
  // 중에 바뀌므로, 시작할 때 한 번 적어 두면 곧 거짓말이 된다. 그 숫자는 두 조작이 붙어 있는
  // 타일 안내(`renderStreamTiles`)가 들고 있고, 아래에서 곧바로 한 번 그린다 — 45분이 걸릴
  // 일을 말없이 시작하지 않는다는 약속은 그쪽이 지킨다.
  setText(
    "pack-qr-note",
    `${qrBytes(opened.total_bytes)} · 프레임 약 ${opened.frames_needed.toLocaleString("ko-KR")}장.\n` +
      `이 QR 은 기본 카메라로 찍어 붙여넣을 수 없습니다 — 휴대폰의 '조각 모으기' 앱이 ` +
      `필요합니다. 순서는 상관없고 놓친 프레임도 되찾을 필요가 없습니다. 다 모이면 폰이 ` +
      `알아서 멈춥니다.${resumeLine}`,
  );
  setText("pack-qr-stream-note", "");
  setText("pack-qr-stream-start", "그만 보내기");
  // 이제 `frames_needed` 를 알게 됐으니 타일 안내가 한 바퀴 시간을 적을 수 있다.
  renderStreamTiles();

  // 첫 화면은 기다렸다 그린다 — 누르자마자 흰 판이 뜨면 고장으로 보인다. 딱 한 화면 몫만
  // 기다린다: 나머지는 첫 화면이 서 있는 동안 만들면 늦지 않는다.
  await fillQrStream(tiles);
  if (state.stream !== stream) return;
  tickQrStream();
}

/**
 * 프레임 줄을 [`STREAM_PREFETCH`] **화면** 몫만큼 채운다.
 *
 * 세는 단위가 장이 아니라 화면인 것이 중요하다. 타일을 넷으로 두면 한 번 넘길 때 네 장이
 * 나가므로, 장 수로 세어 두면 미리 만들어 둔 것이 한 화면도 못 되어 매 프레임마다 IPC 를
 * 기다리게 된다 — 그 기다림이 슬라이더에 적힌 간격을 실제 간격에서 떼어 놓는 항이다.
 *
 * 한 번에 하나씩 받는다. `qr_stream_frame` 은 Rust 쪽에서 뮤텍스 하나를 잡으므로 병렬로 불러도
 * 줄을 서고, 순서가 뒤섞이면 줄에 넣을 자리를 다시 정해야 한다.
 */
async function fillQrStream(want = STREAM_PREFETCH * streamTiles()) {
  const stream = state.stream;
  if (!stream || stream.filling) return;
  stream.filling = true;
  try {
    while (stream.ready.length < want) {
      const seq = stream.seq;
      let frame;
      try {
        frame = await invoke("qr_stream_frame", { seq });
      } catch {
        // 결과가 바뀌었거나 스트림이 닫혔다. 조용히 멈춘다.
        if (state.stream === stream) stopQrStream();
        return;
      }
      if (state.stream !== stream) return;
      stream.seq = seq + 1;
      const url = `data:image/png;base64,${frame.png_base64}`;
      stream.ready.push({ seq, url, modules: Number(frame.png_modules) || 0 });
      // 그리는 순간에 디코드가 걸리면 화면이 넘어가는 시점이 흔들린다. 미리 풀어 둔다 —
      // 같은 data URL 이라 웹뷰가 디코드한 비트맵을 그대로 쓴다. (jsdom 에는 없다.)
      warmImage(url);
    }
  } finally {
    stream.filling = false;
  }
}

/// PNG 을 미리 디코드해 둔다. 실패해도 잃을 것이 없으므로 기다리지 않는다.
function warmImage(url) {
  if (typeof Image !== "function") return;
  try {
    const image = new Image();
    image.src = url;
    // `decode` 가 없는 환경도 있고(테스트의 jsdom), 있어도 거절할 수 있다. 둘 다 그냥 넘긴다 —
    // 미리 못 풀었으면 그릴 때 풀면 된다.
    const decoded = image.decode?.();
    if (decoded && typeof decoded.catch === "function") decoded.catch(() => {});
  } catch {
    // 디코드를 미리 못 했을 뿐이다.
  }
}

/**
 * 만들어 둔 프레임 하나를 그리고 다음 시각을 잡는다.
 *
 * **밀린 것을 몰아 넘기지 않는다.** 시각으로 재는 스케줄러는 보통 늦은 만큼 따라잡지만, 여기서
 * 따라잡기는 프레임 두 장을 거의 동시에 지나가게 하는 일이라 폰이 둘 다 놓친다. 늦었으면 그
 * 자리에서 시계를 다시 맞춘다.
 */
function tickQrStream() {
  const stream = state.stream;
  if (!stream) return;

  const tiles = streamTiles();
  // **한 화면 몫이 다 차야 넘긴다.** 반만 채워 넘기면 빈 타일이 생기고, 폰은 그 자리에서
  // 초점을 다시 잡느라 옆의 멀쩡한 심볼까지 놓친다.
  if (stream.ready.length < tiles) {
    // 만드는 쪽이 못 따라왔다. 지금 그릴 것이 없으니 도착하는 대로 이어 간다 — 여기서 빈 화면을
    // 그리면 폰이 방금 읽던 심볼까지 잃는다.
    void fillQrStream();
    stream.deadline = 0;
    stream.timer = setTimeout(tickQrStream, 16);
    return;
  }

  const frames = stream.ready.splice(0, tiles);
  paintStreamTiles(frames);

  stream.sent += frames.length;
  markStreamResume(stream);

  // **보낸 장수만 세면 진행을 볼 수 없다.** 끝이 없는 스트림이라도 "대략 이만큼 보내면 폰이
  // 다 푼다" 는 양(`frames_needed`)은 알고 있으므로, 그 대비로 적는다. 폰도 같은 식으로
  // 자기 진행을 재고 있어서(`mobile/www/stream.js` 의 `framesNeeded`) 두 화면의 숫자가
  // 같은 뜻을 갖는다.
  const needed = Number(stream.info?.frames_needed) || 0;
  const sent = stream.sent.toLocaleString("ko-KR");
  setText(
    "pack-qr-index",
    needed > 0 ? `${sent} / 약 ${needed.toLocaleString("ko-KR")} 프레임` : `${sent} 프레임`,
  );
  setText("pack-qr-stream-note", streamNote(stream.sent, needed));
  setText("pack-qr-stream-start", "그만 보내기");

  void fillQrStream();

  const dwell = qrStreamDwell();
  const now = perfNow();
  stream.deadline = stream.deadline === 0 ? now + dwell : stream.deadline + dwell;
  if (stream.deadline < now) stream.deadline = now + dwell;
  stream.timer = setTimeout(tickQrStream, Math.max(0, stream.deadline - now));
}

/// 이어 갈 자리를 적어 둔다. **아직 그리지 않은 프레임의 번호까지 태우지 않는다** — 미리
/// 만들어 둔 것은 폰에게 한 번도 보이지 않은 번호라, 다음에 그대로 내보내면 된다.
function markStreamResume(stream) {
  const next = stream.ready.length > 0 ? stream.ready[0].seq : stream.seq;
  streamResume = { path: stream.path, seq: next, sent: stream.sent };
}

/// `performance.now()` 가 없는 환경(구형 웹뷰, 테스트)에서도 같은 뜻으로 흐르는 시계.
function perfNow() {
  return typeof performance === "object" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/**
 * 스트림을 보내는 동안의 한 줄.
 *
 * 한 바퀴를 넘겨도 멈추지 않는다는 사실을 그때 가서 말해 준다. 조각 모드와 달리 **같은
 * 프레임을 다시 보내는 것이 아니라** 매번 새 프레임을 만들기 때문에, 한 바퀴를 넘겨 계속
 * 보내는 것이 낭비가 아니라는 것을 알아야 그대로 두게 된다.
 */
function streamNote(sent, needed) {
  if (needed <= 0) return "보내는 중입니다. 폰이 다 모으면 알아서 멈춥니다.";
  if (sent >= needed) {
    const lap = Math.floor(sent / needed) + 1;
    return (
      `한 바퀴를 다 보냈습니다 (${lap}바퀴째). 폰이 아직 다 못 모았으면 그대로 두세요 — ` +
      `프레임은 매번 새로 만들어지므로 계속 보내는 것이 낭비가 아닙니다.`
    );
  }
  return `보내는 중입니다 — 한 바퀴의 ${Math.round((sent / needed) * 100)}%. 폰이 다 모으면 알아서 멈춥니다.`;
}

function stopQrStream() {
  const stream = state.stream;
  if (!stream) return;
  if (stream.timer !== null) clearTimeout(stream.timer);
  markStreamResume(stream);
  state.stream = null;
  // 컨테이너 바이트를 붙잡고 있을 이유가 없어졌다. 곧바로 놓는다.
  void invoke("qr_stream_close").catch(() => {});

  setText("pack-qr-stream-start", "스트림으로 보내기");
  setText("pack-qr-stream-note", "");
  setText("pack-qr-index", "");
  const section = el("pack-qr");
  if (section) section.dataset.state = "toobig";
  show("pack-qr-image", false);
  show("pack-qr-stream-frame", false);
  // 타일에 남은 그림은 이미 지나간 프레임이다. 판을 접어도 남겨 두면 다음에 켤 때 옛 프레임이
  // 한 박자 서 있게 된다.
  const grid = el("pack-qr-stream-grid");
  if (grid) grid.textContent = "";
  // 스트림이 닫혔으니 한 바퀴 시간도 다시 모르는 값이 된다.
  renderStreamTiles();
}

/// 스트림의 체류 시간. 전용 슬라이더가 있으면 그 값을, 없으면 조각 모드의 것을 따른다.
function qrStreamDwell() {
  const value = Number(el("pack-qr-stream-speed")?.value);
  return Number.isFinite(value) && value > 0 ? value : qrDwellFromUi();
}

/**
 * '빠르게 보내기' 를 켜고 끈다. 슬라이더의 **하한만** 바꾼다.
 *
 * 켜도 저절로 빨라지지 않는다 — 열어 준 구간으로 사람이 직접 내려야 한다. 켜는 순간 값까지
 * 끌어내리면 화면이 갑자기 초당 6회로 깜빡이게 되는데, 그건 이 토글이 켜야 열리게 되어 있는
 * 이유 그 자체다.
 */
function setStreamFast(on) {
  const slider = el("pack-qr-stream-speed");
  if (!slider) return;
  slider.min = String(on ? QR_DWELL_FAST_MIN_MS : QR_DWELL_MIN_MS);
  // 끌 때는 열어 뒀던 구간에 서 있을 수 있다. 되돌려 놓지 않으면 토글이 거짓말이 된다.
  if (!on && Number(slider.value) < QR_DWELL_MIN_MS) slider.value = String(QR_DWELL_MIN_MS);
  renderStreamSpeed();
  // 무엇을 열었는지, 무엇이 위험한지, 그리고 **빨라지지 않을 수도 있다**는 것까지 적는다.
  // 마지막 줄이 특히 중요하다: 폰이 못 따라오면 더 빨리 넘길수록 총량이 줄어드는데, 그 사실은
  // PC 화면에 나타나지 않는다(PC 는 보낸 장수만 세고 있다). 확인은 폰에서만 되므로 어디를
  // 봐야 하는지 짚어 준다.
  setText(
    "pack-qr-stream-fast-note",
    on
      ? `${QR_DWELL_FAST_MIN_MS}ms 까지 열었습니다. 스트림은 놓친 프레임을 다음 프레임이 ` +
        `대신하므로 조각 모드보다 빨리 넘겨도 됩니다. 다만 화면이 초당 3회를 넘겨 바뀌는 것은 ` +
        `빛에 민감한 사람에게 위험할 수 있습니다. 그리고 폰이 못 따라오면 오히려 느려집니다 — ` +
        `폰에 뜨는 '초당 n장' 이 늘지 않으면 도로 올려 주세요.`
      : "",
  );
}

/// 슬라이더 옆의 숫자. 도는 중에 바꿔도 다음 프레임부터 바로 먹는다.
///
/// 타일 안내도 함께 고친다 — 거기 적히는 '초당 몇 장' 은 타일 수와 넘김 속도의 곱이라,
/// 한쪽만 움직여도 숫자가 달라진다.
function renderStreamSpeed() {
  setText("pack-qr-stream-speed-label", `${qrStreamDwell()}ms`);
  renderStreamTiles();
}

/// 슬라이더가 있으면 그 값을, 없으면 기본값을.
function qrDwellFromUi() {
  const slider = el("pack-qr-speed");
  const value = Number(slider?.value);
  return Number.isFinite(value) && value > 0 ? value : QR_DWELL_DEFAULT_MS;
}

/// 한 장을 받아 캐시에 넣는다. 이미 있으면 그대로 돌려준다.
async function fetchQrPiece(index) {
  const qr = state.qr;
  if (!qr || index < 1 || index > qr.total) return null;

  const seen = qr.cache.get(index);
  if (seen) return seen;

  try {
    const image = await invoke("qr_piece", { index });
    // 받아 오는 사이에 결과가 바뀌었을 수 있다. 그때 캐시에 넣으면 다른 묶음의 그림이 섞인다.
    if (state.qr !== qr) return null;
    qr.cache.set(index, image);
    return image;
  } catch {
    // 그림 한 장을 못 받은 것뿐이다. 묶기는 이미 성공했고 텍스트도 화면에 있다.
    return null;
  }
}

/// 곧 보여 줄 몇 장을 미리 받아 둔다.
async function prefetchQr() {
  const qr = state.qr;
  if (!qr) return;
  // 놓친 장 목록을 도는 중이면 다음에 나올 장은 **목록의** 다음 장이다. 전체 순서로 미리
  // 받으면 정작 곧 그릴 장이 체류 시간 안에 도착하지 못한다.
  const at = Math.max(qrOnlyAt(qr), 0);
  for (let ahead = 0; ahead <= QR_PREFETCH; ahead += 1) {
    const page = qr.only ? qr.only[(at + ahead) % qr.only.length] : qr.index + 1 + ahead;
    await fetchQrPiece(page);
    if (state.qr !== qr) return;
  }
}

/// 지금 보고 있는 장을 그림·설명·번호·넘기기에 반영한다.
function showPackQrPage() {
  const qr = state.qr;
  const image = el("pack-qr-image");

  if (!qr) {
    if (image) {
      // `src = ""` 는 문서 URL 을 다시 요청한다. 반드시 속성 자체를 지운다.
      image.removeAttribute("src");
      image.style.removeProperty("width");
    }
    show("pack-qr-image", false);
    show("pack-qr-nav", false);
    setText("pack-qr-index", "");
    renderQrJump();
    refreshButtons();
    return;
  }

  const total = qr.total;
  const page = qr.cache.get(qr.index + 1);

  if (image) {
    if (page) {
      image.src = `data:image/png;base64,${page.png_base64}`;
    }
    // PNG 은 1모듈 = 1픽셀이다. 정수 배율로만 키운다 — 배율에 소수점이 붙으면 모듈 폭이
    // 3px/4px 로 들쭉날쭉해져 휴대폰이 초점을 맞춰도 인식하지 못한다.
    //
    // 모듈당 최소 3px 을 보장한다. 조각들은 모두 같은 규격이라 이 값은 장을 넘겨도 변하지
    // 않는다 — 그래서 그림을 아직 못 받았어도 자리는 먼저 잡아 둘 수 있다.
    const modules = qr.pngModules;
    if (modules > 0) {
      image.style.width = `${modules * Math.max(3, Math.min(10, Math.floor(560 / modules)))}px`;
    } else {
      image.style.removeProperty("width");
    }
    image.alt =
      total > 1
        ? `묶은 결과 텍스트를 담은 QR 코드 ${total}장 중 ${qr.index + 1}번째`
        : "묶은 결과 텍스트를 담은 QR 코드";
  }
  show("pack-qr-image", Boolean(page));

  // 한 장이면 넘길 곳이 영원히 없다. 뜻이 없는 조작 도구는 잠그기보다 감춘다 — 잠가 두면
  // 더 있을 것처럼 보인다. (pack-key-strength, pack-progress, pack-reveal 과 같은 규칙)
  show("pack-qr-nav", total > 1);
  // 놓친 장 목록을 도는 중에는 "전체에서 몇 번째" 만으로는 어디쯤인지 알 수 없다.
  const at = qrOnlyAt(qr);
  const inList = qr.only && at !== -1 ? ` · 부른 장 ${at + 1}/${qr.only.length}` : "";
  setText("pack-qr-index", total > 1 ? `${qr.index + 1} / ${total}${inList}` : "");
  renderQrJump();
  refreshButtons();
}

// ------------------------------------------------------------ 놓친 장 부르기
//
// 폰이 알려 준 번호를 그대로 받아 **그 장만** 보여 준다.
//
// 조각 모드에서 가장 오래 걸리는 구간은 마지막 몇 장이다. 순번이 고정돼 있으니 한 장을
// 놓치면 그 장이 다시 올 때까지 기다려야 하고, 순차 슬라이드쇼에서 그건 한 바퀴를 통째로
// 다시 도는 일이다 — 128장이면 두 장 때문에 45초를 기다린다. 폰은 이미 어느 장이 빠졌는지
// 알고 화면에 적고 있으므로(`mobile/www/app.js` 의 `남은 순번 3, 7, 12~15`), 그 글자를
// 그대로 옮겨 치면 그 장들만 돌게 하는 것이 가장 짧은 길이다.
//
// 표기는 폰이 쓰는 것과 맞춰 두었다 — `~` 범위, 쉼표 구분. 손이 먼저 가는 `-` 도 받는다.

/// 번호 하나 또는 범위. 범위를 먼저 시도해야 "12~15" 가 12 와 15 로 흩어지지 않는다.
const PAGE_TOKEN = /(\d+)\s*[-~]\s*(\d+)|(\d+)/g;

/**
 * "3, 7, 12~15" → `{ pages: [3, 7, 12, 13, 14, 15], dropped, junk }`.
 *
 * `dropped` 는 1~total 밖의 번호가 있었는지, `junk` 는 숫자로 읽을 수 없는 글자가 남았는지다.
 * 둘 다 **거절이 아니라 안내의 근거**다 — 읽어낸 번호가 하나라도 있으면 그것들로 진행한다.
 */
function parsePageList(text, total) {
  const pages = [];
  const seen = new Set();
  let dropped = false;

  const rest = String(text ?? "")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(PAGE_TOKEN, (match, from, to, one) => {
      const start = Number(from ?? one);
      const end = Number(to ?? one);
      const low = Math.min(start, end);
      const high = Math.max(start, end);
      if (low < 1 || high > total) dropped = true;
      // 도는 횟수는 total 을 넘지 않는다 — "1~99999" 를 적어도 여기서 멈춘다.
      for (let page = Math.max(low, 1); page <= Math.min(high, total); page += 1) {
        if (seen.has(page)) continue;
        seen.add(page);
        pages.push(page);
      }
      return "";
    });

  pages.sort((a, b) => a - b);
  return { pages, dropped, junk: /\S/.test(rest.replace(/[,.;:·]/g, "")) };
}

/// 번호 목록을 폰과 같은 표기로 되돌린다: [1, 2, 3, 7] → "1~3, 7".
function summarizePages(pages) {
  const runs = [];
  for (const page of pages) {
    const last = runs[runs.length - 1];
    if (last && page === last[1] + 1) last[1] = page;
    else runs.push([page, page]);
  }
  return runs.map(([from, to]) => (from === to ? String(from) : `${from}~${to}`)).join(", ");
}

/// 지금 장이 부른 목록의 몇 번째인지. 목록이 없거나 목록 밖이면 -1.
function qrOnlyAt(qr) {
  if (!qr || !qr.only) return -1;
  return qr.only.indexOf(qr.index + 1);
}

/// 부르기 칸을 보이고 감춘다. 한 장짜리에는 부를 것이 없다.
function renderQrJump() {
  const qr = state.qr;
  const usable = Boolean(qr) && qr.total > 1;
  show("pack-qr-jump", usable);
  show("pack-qr-goto-clear", Boolean(qr && qr.only));
  if (!usable) setText("pack-qr-goto-note", "");
}

/// 목록을 도는 중임을 적는다. 몇 바퀴째인지가 여기서 유일한 진행 표시다.
function renderQrOnlyNote(extra = "") {
  const qr = state.qr;
  if (!qr || !qr.only) return;
  setText(
    "pack-qr-goto-note",
    `부른 ${qr.only.length}장만 돌립니다 (${summarizePages(qr.only)}) · ${qr.lap}바퀴째. ` +
      `폰이 다 모으면 '전체로 돌아가기' 를 누르세요.${extra}`,
  );
}

/**
 * 입력칸을 읽어 그 장(들)을 부른다.
 *
 * 한 장이면 **그냥 그 장에 선다** — 자동 넘김은 뜻이 없고, 폰이 읽을 때까지 가만히 있는 것이
 * 맞다. 여러 장이면 그 목록만 되풀이해 돈다.
 */
function applyQrGoto() {
  const qr = state.qr;
  const input = el("pack-qr-goto");
  if (!qr || !input) return;

  const { pages, dropped, junk } = parsePageList(input.value, qr.total);
  if (pages.length === 0) {
    setText(
      "pack-qr-goto-note",
      junk || dropped
        ? `1 ~ ${qr.total} 사이의 번호를 쉼표로 적어 주세요 (예: 3, 7, 12~15).`
        : "",
    );
    return;
  }

  stopQrPlay();
  const skipped = dropped ? ` 1~${qr.total} 밖의 번호는 건너뛰었습니다.` : "";

  if (pages.length === 1) {
    qr.only = null;
    qr.lap = 0;
    goToQrPage(pages[0] - 1);
    // 이미 그 장을 보고 있었으면 `goToQrPage` 가 아무것도 하지 않는다. 그래도 번호 줄에서
    // 지난 목록 표시를 지워야 하므로 직접 한 번 더 그린다.
    showPackQrPage();
    setText(
      "pack-qr-goto-note",
      `${pages[0]}번 장입니다. 폰이 읽을 때까지 그대로 두세요.${skipped}`,
    );
    return;
  }

  qr.only = pages;
  qr.lap = 1;
  goToQrPage(pages[0] - 1);
  showPackQrPage();
  renderQrOnlyNote(skipped);
  // 목록을 넣었으면 바로 돈다. 여기서 한 번 더 누르게 하는 것은 아무 판단도 더해 주지 않는다.
  startQrPlay();
}

/// 목록을 놓고 전체로 돌아온다. 보고 있던 장은 그대로 둔다 — 지금 화면이 갑자기 1번으로
/// 튀면 폰이 그 장을 읽던 중일 수 있다.
function clearQrOnly() {
  const qr = state.qr;
  stopQrPlay();
  if (qr) {
    qr.only = null;
    qr.lap = 0;
  }
  const input = el("pack-qr-goto");
  if (input) input.value = "";
  setText("pack-qr-goto-note", "");
  renderQrJump();
  showPackQrPage();
}

/// 장을 옮긴다. 옮겼으면 참.
function goToQrPage(next) {
  const qr = state.qr;
  if (!qr || next === qr.index || next < 0 || next >= qr.total) return false;
  qr.index = next;
  showPackQrPage();
  void prefetchQr();
  return true;
}

function stepPackQr(delta) {
  const qr = state.qr;
  if (!qr) return;
  // 손으로 넘기기 시작했으면 자동 넘김은 비켜 준다. 둘이 동시에 장을 옮기면 어느 쪽도 못 쫓는다.
  stopQrPlay();

  if (qr.only) {
    // 목록을 부른 뒤에는 넘기기도 그 안에서만 움직인다. 여기서 전체를 오가면 방금 걸러 낸
    // 장들을 다시 지나가게 되어 부른 뜻이 사라진다.
    const at = qrOnlyAt(qr);
    const next = at === -1 ? 0 : Math.min(Math.max(at + delta, 0), qr.only.length - 1);
    if (!goToQrPage(qr.only[next] - 1)) return;
  } else {
    const last = qr.total - 1;
    // 끝에서 되돌아 감지 않는다. 순서대로 찍는 중에 1장으로 돌아가 버리면 어디까지 했는지 잃고,
    // '다음' 이 잠기는 것이 유일한 "다 찍었다" 신호이기도 하다.
    if (!goToQrPage(Math.min(Math.max(qr.index + delta, 0), last))) return;
  }

  // 방금 누른 버튼이 끝에서 잠기면 크로미움이 포커스를 body 로 떨어뜨린다. 키보드로 넘기던
  // 사람이 자리를 잃지 않도록 반대쪽 버튼으로 옮겨 준다.
  const back = el("pack-qr-prev");
  const forward = el("pack-qr-next");
  const active = document.activeElement;
  if (active === forward && forward?.disabled) back?.focus();
  else if (active === back && back?.disabled) forward?.focus();
}

// ------------------------------------------------------------ 자동 넘김

/**
 * 장을 스스로 넘긴다. **한 바퀴 돌고 마지막 장에서 멈춘다.**
 *
 * 되감지 않는 이유는 손으로 넘길 때와 같다: '다음' 이 잠기는 것이 "다 찍었다" 는 유일한
 * 신호다. 무한히 돌면 그 신호가 사라진다. 한 바퀴에 다 못 읽었으면 폰이 어느 장이 빠졌는지
 * 알려 주므로, 다시 누르면 된다.
 *
 * `setInterval` 이 아니라 `setTimeout` 재귀인 이유는 두 가지다. 프레임이 밀려도 간격이
 * 누적되지 않고, 속도를 바꾸면 다음 장부터 바로 반영된다.
 */
function tickQrPlay() {
  const qr = state.qr;
  if (!qr || !qr.playing) return;

  if (qr.only) {
    // **부른 목록은 되풀이한다.** 전체를 한 바퀴에 멈추는 근거('다음' 이 잠기는 것이 다 찍었다는
    // 신호)가 여기서는 성립하지 않는다 — 세 장짜리 목록의 한 바퀴는 1초라 신호가 되지 못하고,
    // 애초에 이 목록은 폰이 "이것만 있으면 된다" 고 알려 준 것이다. 대신 바퀴 수를 적어 준다.
    const at = qrOnlyAt(qr);
    const next = at === -1 ? 0 : (at + 1) % qr.only.length;
    if (next === 0 && at !== -1) {
      qr.lap += 1;
      renderQrOnlyNote();
    }
    goToQrPage(qr.only[next] - 1);
    qr.timer = setTimeout(tickQrPlay, qr.dwellMs);
    return;
  }

  if (qr.index + 1 >= qr.total) {
    stopQrPlay();
    return;
  }
  // `stepPackQr` 를 쓰지 않는다. 그쪽은 끝에서 포커스를 옮기는데, 타이머가 포커스를 훔치면
  // 키보드로 화면을 쓰던 사람이 자리를 잃는다.
  goToQrPage(qr.index + 1);
  qr.timer = setTimeout(tickQrPlay, qr.dwellMs);
}

function startQrPlay() {
  const qr = state.qr;
  if (!qr || qr.playing || qr.total <= 1) return;

  if (qr.only) {
    // 목록 밖에 서 있으면 목록 안으로 먼저 들어간다.
    if (qrOnlyAt(qr) === -1) goToQrPage(qr.only[0] - 1);
  } else if (qr.index + 1 >= qr.total) {
    // 마지막 장에서 누르면 처음부터 다시 돈다 — 그게 '다시 재생' 이다.
    goToQrPage(0);
  }

  qr.playing = true;
  qr.dwellMs = qrDwellFromUi();
  qr.timer = setTimeout(tickQrPlay, qr.dwellMs);
  renderQrPlayButton();
}

function stopQrPlay() {
  const qr = state.qr;
  if (!qr) return;
  if (qr.timer !== null) {
    clearTimeout(qr.timer);
    qr.timer = null;
  }
  qr.playing = false;
  renderQrPlayButton();
}

function renderQrPlayButton() {
  const qr = state.qr;
  setText("pack-qr-play", qr?.playing ? "멈춤" : "자동 넘김");
  const button = el("pack-qr-play");
  if (button) button.setAttribute("aria-pressed", qr?.playing ? "true" : "false");
}

function clearPackQr() {
  stopQrPlay();
  stopQrStream();
  // 결과가 바뀌면 이어 갈 자리도 뜻을 잃는다. 같은 경로에 다시 묶으면 지문이 달라서 폰이
  // 어차피 '다른 묶음' 으로 물리치는데, 그 자리를 이어 가면 화면만 새 묶음인 척하게 된다.
  streamResume = { path: "", seq: 0, sent: 0 };
  show("pack-qr-stream", false);
  state.qr = null;
  const jump = el("pack-qr-goto");
  if (jump) jump.value = "";
  setText("pack-qr-goto-note", "");
  const section = el("pack-qr");
  if (section) section.dataset.state = "";
  show("pack-qr", false);
  setText("pack-qr-note", "");
  renderQrPlayButton();
  showPackQrPage();
}

function qrNote(result, qr) {
  if (!qr) {
    const perQr = Number(result.qr_limit_bytes) || 0;
    const maxQr = Number(result.qr_limit_pieces) || 0;
    // 한도를 모르면(예전 응답) 숫자를 지어내지 않고 그 문장만 뺀다.
    const cap =
      perQr > 0 && maxQr > 0
        ? ` QR 코드 한 장에 ${qrBytes(perQr)} 씩 최대 ${maxQr}장까지만 나눕니다.`
        : "";
    return (
      `묶은 텍스트가 ${qrBytes(result.container_bytes)}라서 조각으로는 보낼 수 없습니다.${cap}\n` +
      `그보다 많이 나누면 순서대로 스캔해 이어 붙이는 일 자체가 현실적이지 않습니다. ` +
      `아래 스트림 모드로 보내거나, '텍스트로 보기' 탭에서 복사·저장해 보내 주세요.`
    );
  }

  const total = qr.total;
  if (total === 1) {
    const bytes = qr.cache.get(1)?.text_bytes;
    const size = bytes ? `${qrBytes(bytes)} · ` : "";
    return (
      `${size}휴대폰 기본 카메라로 비추면 이 텍스트가 그대로 보입니다. 거기서 복사해 ` +
      `풀기 탭에 붙여넣으면 그대로 풀립니다.`
    );
  }
  return (
    `${qrBytes(result.container_bytes)} · QR 코드 한 장에 담기지 않아 ${total}장으로 나눴습니다.\n` +
    `'자동 넘김' 을 누르고 휴대폰의 '조각 모으기' 앱으로 비추면 알아서 모읍니다 — 순서는 ` +
    `상관없고, 한 바퀴 돌면 멈춥니다. 남은 장이 있으면 다시 누르세요.\n` +
    `기본 카메라로 한 장씩 찍어 손으로 이어 붙일 수도 있습니다. 각 장 안에 #1/${total} 부터 ` +
    `#${total}/${total} 까지 순서 표시가 들어 있으니 붙여넣은 뒤 순서를 확인해 주세요 — ` +
    `표시 줄은 지우지 않아도 됩니다.`
  );
}

/**
 * 묶는다. **저장 위치는 묻지 않는다.**
 *
 * 예전에는 여기서 먼저 `pick_save_path` 를 띄웠다. 그러면 사람은 결과가 얼마나 큰지도, QR 로
 * 보낼 수 있는 크기인지도 모르는 채로 파일 자리를 정해야 한다 — QR 로 비추고 말 것이었다면
 * 그 파일은 애초에 만들 필요가 없었다. 그래서 결과는 임시 폴더에 앉히고(Rust 의 `PackedSlot`),
 * 텍스트로 부칠지 QR 로 비출지 고른 뒤에 '파일로 저장' 이 옮겨 적는다.
 */
async function doPack() {
  const key = el("pack-key")?.value || "";
  if (!key) return setStatus("pack", "암호화 키를 입력해 주세요.", "error");
  if (!hasSomethingToPack()) {
    return setStatus(
      "pack",
      state.inputMode === "text"
        ? "묶을 텍스트를 먼저 적어 주세요."
        : "묶을 파일을 먼저 추가해 주세요.",
      "error",
    );
  }

  const packingText = state.inputMode === "text";
  clearStatus("pack");
  clearPackOutput();
  resetProgress("pack");
  setBusy(true);
  try {
    const suggestedName = suggestContainerName();
    const result = packingText
      ? await invoke("pack_text", {
          text: packTextValue(),
          name: (el("pack-text-name")?.value || "").trim() || null,
          passphrase: key,
          dest: null,
          suggestedName,
        })
      : await invoke("pack", {
          paths: state.items.map((i) => i.path),
          passphrase: key,
          dest: null,
          suggestedName,
        });

    // 성공한 키만 이어 준다. 실패한 키를 풀기 탭에 흘려 보내면 혼란만 준다.
    session.key = key;
    applySessionKey();
    renderPackOutput(result);
    renderPackQr(result);

    const saved =
      result.original_bytes > 0
        ? Math.max(0, Math.round((1 - result.container_bytes / result.original_bytes) * 100))
        : 0;
    let message =
      `파일 ${result.file_count}개를 텍스트로 묶었습니다. ` +
      `${formatBytes(result.original_bytes)} → ${formatBytes(result.container_bytes)} (${saved}% 절약)`;
    if (result.changed.length > 0) {
      message += `\n묶는 도중 크기가 변한 파일 ${result.changed.length}개: ${result.changed.slice(0, 3).join(", ")}`;
    }
    if (result.skipped.length > 0) {
      message += `\n담지 못한 항목 ${result.skipped.length}개: ${result.skipped.slice(0, 3).join(", ")}`;
    }
    message += "\n같은 키가 풀기 탭에 채워졌습니다.";
    setStatus("pack", message, result.changed.length || result.skipped.length ? "warn" : "ok");
  } catch (err) {
    setStatus("pack", errorText(err), "error");
  } finally {
    setBusy(false);
    resetProgress("pack");
  }
}

/**
 * 임시 폴더에 앉아 있는 결과를 사람이 정한 자리로 옮겨 적는다.
 *
 * 경로를 Rust 로 넘기지 않는다 — `save_container` 는 자기가 붙잡고 있는 결과 하나만 복사한다.
 * 옮긴 뒤에도 임시 파일은 그대로 둔다: QR 스트림이 그 경로를 읽고 있고, 어차피 다음 묶기에서
 * 지워진다.
 */
async function saveContainer() {
  if (!state.packed) return;

  const dest = await invoke("pick_save_path", {
    suggestedName: suggestContainerName(),
    start: recall(REMEMBERED.saveDir) || null,
  });
  if (!dest) return; // 사용자가 취소했다.

  setBusy(true);
  try {
    const bytes = await invoke("save_container", { dest });
    state.packed.savedPath = dest;
    remember(REMEMBERED.saveDir, parentDir(dest));
    setText("pack-save-note", `${dest} 에 ${formatBytes(bytes)}로 저장했습니다.`);
    offerReveal("pack", dest);
  } catch (err) {
    setText("pack-save-note", "");
    setStatus("pack", errorText(err), "error");
  } finally {
    setBusy(false);
  }
}

async function copyPackOutput() {
  if (!state.packed) return;
  try {
    // 본문이 IPC 를 한 번 더 건너지 않도록 Rust 가 파일에서 직접 읽어 올린다.
    const bytes = await invoke("copy_container_to_clipboard", { path: state.packed.dest });
    setStatus("pack", `텍스트 ${formatBytes(bytes)}를 클립보드에 복사했습니다.`, "ok");
  } catch (err) {
    setStatus("pack", errorText(err), "error");
  }
}

// ---------------------------------------------------------------- 동작: 풀기

async function chooseDest() {
  const picked = await invoke("pick_dest_dir", {
    start: el("unpack-dest")?.value || recall(REMEMBERED.destDir) || null,
  });
  if (!picked) return null;
  const field = el("unpack-dest");
  if (field) field.value = picked;
  remember(REMEMBERED.destDir, picked);
  clearStatus("unpack");
  refreshButtons();
  return picked;
}

async function doUnpack() {
  const { source } = state;
  if (!source) {
    return setStatus("unpack", "풀어낼 파일을 고르거나 텍스트를 붙여넣어 주세요.", "error");
  }

  const key = el("unpack-key")?.value || "";
  if (!key) return setStatus("unpack", "암호화 키를 입력해 주세요.", "error");

  // 매번 어디에 풀지 정하게 한다. 비어 있으면 바로 폴더 선택을 띄운다.
  let dest = el("unpack-dest")?.value || "";
  if (!dest) {
    dest = await chooseDest();
    if (!dest) return;
  }

  clearStatus("unpack");
  resetProgress("unpack");
  setBusy(true);
  try {
    const result =
      source.kind === "text"
        ? await invoke("unpack_text", { text: source.text, passphrase: key, dest })
        : await invoke("unpack", { container: source.info.path, passphrase: key, dest });

    remember(REMEMBERED.destDir, result.dest);

    let message = `파일 ${result.file_count}개(${formatBytes(result.total_bytes)})를 풀었습니다.`;
    if (result.renamed.length > 0) {
      message += `\n같은 이름이 있어 번호를 붙인 항목: ${result.renamed.join(", ")}`;
    }
    if (result.skipped.length > 0) {
      message += `\n안전하지 않은 경로여서 건너뛴 항목 ${result.skipped.length}개: ${result.skipped.slice(0, 3).join(", ")}`;
    }
    if (result.hash_mismatch.length > 0) {
      message += `\n내용이 검증과 다른 파일 ${result.hash_mismatch.length}개: ${result.hash_mismatch.slice(0, 3).join(", ")}`;
    }
    const noisy =
      result.skipped.length || result.hash_mismatch.length || result.renamed.length;
    setStatus("unpack", message, noisy ? "warn" : "ok");
    offerReveal("unpack", result.dest);
  } catch (err) {
    setStatus("unpack", errorText(err), "error");
  } finally {
    setBusy(false);
    resetProgress("unpack");
  }
}

function offerReveal(tab, path) {
  const button = el(`${tab}-reveal`);
  if (!button) return;
  button.hidden = false;
  button.onclick = () => invoke("reveal", { path }).catch(() => {});
}

// ---------------------------------------------------------------- 드래그 앤 드롭

function highlight(on) {
  const zone = el(`${state.activeTab}-dropzone`);
  if (zone) zone.classList.toggle("is-dragover", on);
}

async function wireDragDrop() {
  // ⚠️ tauri.conf.json 의 `dragDropEnabled: true` 때문에 윈도우에서는 HTML5 `drop` 이벤트가
  // 웹뷰에 오지 않는다. 온다 해도 브라우저 이벤트는 절대 경로를 주지 않으므로 쓸 수 없다.
  // 반드시 Tauri 의 드래그 이벤트로 받아야 한다.
  await getCurrentWebview().onDragDropEvent((event) => {
    const payload = event.payload || {};
    if (payload.type === "enter" || payload.type === "over") return highlight(true);
    if (payload.type === "leave") return highlight(false);
    if (payload.type !== "drop") return;

    highlight(false);
    if (state.busy) return;

    const paths = payload.paths || [];
    if (paths.length === 0) return;

    if (state.activeTab === "unpack") {
      // 풀기는 컨테이너 하나만 다룬다.
      selectContainerFile(paths[0]);
    } else {
      addPaths(paths);
    }
  });

  // 웹뷰가 파일을 직접 열어 버리지 않도록 하는 안전망.
  for (const type of ["dragover", "drop", "dragenter"]) {
    window.addEventListener(type, (e) => e.preventDefault());
  }
}

// ---------------------------------------------------------------- 시작

function wireEvents() {
  for (const button of all("tab")) {
    button.addEventListener("click", () => setTab(button.dataset.tab));
  }

  el("pack-clear")?.addEventListener("click", () => {
    // 파일 목록만 비운다. 텍스트 입력 모드의 글은 다른 자리에 있고, 여기서 함께 지우면
    // 보이지도 않는 것이 사라진다.
    state.items = [];
    clearStatus("pack");
    clearPackOutput();
    renderList();
    refreshButtons();
  });

  for (const button of all("pack-input-tab")) {
    button.addEventListener("click", () => setInputMode(button.dataset.input));
  }
  for (const button of all("pack-result-tab")) {
    button.addEventListener("click", () => setResultTab(button.dataset.result));
  }
  el("pack-save")?.addEventListener("click", saveContainer);
  el("pack-text")?.addEventListener("input", () => {
    renderPackTextCount();
    clearErrorStatus("pack");
    refreshButtons();
  });
  el("pack-text-name")?.addEventListener("input", refreshButtons);

  el("pack-add-files")?.addEventListener("click", async () => {
    addPaths(await invoke("pick_files_to_pack"));
  });
  el("pack-add-folders")?.addEventListener("click", async () => {
    addPaths(await invoke("pick_folders_to_pack"));
  });
  el("pack-submit")?.addEventListener("click", doPack);
  el("pack-output-copy")?.addEventListener("click", copyPackOutput);
  el("pack-qr-prev")?.addEventListener("click", () => stepPackQr(-1));
  el("pack-qr-next")?.addEventListener("click", () => stepPackQr(1));
  el("pack-qr-play")?.addEventListener("click", () =>
    state.qr?.playing ? stopQrPlay() : startQrPlay(),
  );
  // 속도는 도는 중에 바꿔도 다음 장부터 바로 먹는다 (setTimeout 재귀라서).
  el("pack-qr-speed")?.addEventListener("input", () => {
    const dwell = qrDwellFromUi();
    if (state.qr) state.qr.dwellMs = dwell;
    setText("pack-qr-speed-label", `${dwell}ms`);
  });
  // 창이 가려지면 멈춘다. 안 보이는 화면에서 장이 넘어가면 돌아왔을 때 어디인지 알 수 없고,
  // 폰은 그동안 아무것도 읽지 못한다.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopQrPlay();
  });
  el("pack-qr-goto-go")?.addEventListener("click", applyQrGoto);
  el("pack-qr-goto-clear")?.addEventListener("click", clearQrOnly);
  // 번호를 치고 엔터를 누르는 것이 가장 자연스럽다. 폼이 아니라서 직접 받는다.
  el("pack-qr-goto")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    applyQrGoto();
  });
  el("pack-qr-stream-start")?.addEventListener("click", () =>
    state.stream ? stopQrStream() : void startQrStream(),
  );
  // 속도는 흘려 보내는 중에 바꿔도 다음 프레임부터 바로 먹는다 (시각으로 재는 스케줄러라서).
  el("pack-qr-stream-speed")?.addEventListener("input", renderStreamSpeed);
  el("pack-qr-stream-fast")?.addEventListener("change", (event) =>
    setStreamFast(Boolean(event.target?.checked)),
  );
  // 타일 수도 도는 중에 바꿀 수 있다. 다음 화면부터 그 수만큼 세운다 — `tickQrStream` 이
  // 매번 다시 읽고, 미리 만들어 둔 프레임은 몇 장이든 그대로 쓰인다 (번호만 다르면 된다).
  for (const radio of all("pack-qr-tile")) {
    radio.addEventListener("change", renderStreamTiles);
  }

  el("unpack-pick")?.addEventListener("click", async () => {
    const picked = await invoke("pick_container");
    if (picked) selectContainerFile(picked);
  });

  const pasted = el("unpack-text");
  if (pasted) {
    // 큰 텍스트를 붙여넣으면 input 이 한 번에 오지만, 손으로 고칠 때는 계속 온다.
    // 확인 요청을 매 글자마다 보내지 않도록 잠깐 모아서 보낸다.
    let timer = null;
    pasted.addEventListener("input", () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => selectContainerText(pasted.value), 250);
    });
  }
  el("unpack-text-clear")?.addEventListener("click", () => {
    if (pasted) pasted.value = "";
    state.source = null;
    clearStatus("unpack");
    renderSource();
  });

  el("unpack-dest-pick")?.addEventListener("click", chooseDest);
  el("unpack-dest")?.addEventListener("input", refreshButtons);
  el("unpack-submit")?.addEventListener("click", doUnpack);

  wireKeyField("pack");
  wireKeyField("unpack");

  // 폼 안에 있어도 엔터로 페이지가 새로고침되지 않게 한다.
  for (const form of document.querySelectorAll("form")) {
    form.addEventListener("submit", (e) => e.preventDefault());
  }
}

async function main() {
  wireEvents();
  setTab("pack");

  // 지난번에 쓴 폴더를 기본값으로 채운다 (경로만, 키는 절대 아니다).
  const destField = el("unpack-dest");
  const lastDest = recall(REMEMBERED.destDir);
  if (destField && lastDest) destField.value = lastDest;

  renderList();
  renderSource();
  // 마크업의 기본값을 그대로 따른다. 어느 탭이 처음 열려 있는지는 화면이 정하고, 상태는
  // 거기에 맞춰 선다.
  setInputMode(state.inputMode);
  setResultTab(state.resultTab);
  renderPackTextCount();
  // 슬라이더 값과 옆의 숫자를 처음부터 맞춰 둔다. 마크업의 기본값을 고쳐도 따라온다.
  renderStreamSpeed();
  clearPackOutput();
  resetProgress("pack");
  resetProgress("unpack");
  show("unpack-key-hint", false);
  clearStatus("pack");
  clearStatus("unpack");
  refreshButtons();

  await listen("pack-progress", (e) => renderProgress("pack", e.payload));
  await listen("unpack-progress", (e) => renderProgress("unpack", e.payload));
  await wireDragDrop();
}

// 정확히 한 번만 시작한다.
//
// `once: true` 가 중요하다. 배선이 두 번 돌면 '보기' 토글처럼 상태를 뒤집는 핸들러가 두 번
// 불려서 아무 일도 안 한 것처럼 보인다. readyState 검사는 스크립트가 늦게 실행돼 이미
// DOMContentLoaded 가 지나간 경우에도 앱이 뜨게 해 준다.
if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", main, { once: true });
} else {
  main();
}
