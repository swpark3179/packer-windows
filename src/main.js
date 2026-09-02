// Packer 프론트엔드.
//
// 이 파일은 마크업의 클래스 이름을 하나도 모른다. 모든 참조는 `data-pk="..."` 훅으로만 한다.
// 그래서 디자인을 이식할 때 목업 마크업에 훅 속성만 붙이면 되고, 이 로직은 손대지 않아도 된다.
//
// 훅 목록 (없는 훅은 조용히 무시되므로 부분 이식도 안전하다):
//
//   탭        tab[data-tab=pack|unpack], panel[data-tab=pack|unpack]
//   묶기      pack-dropzone, pack-list, pack-empty, pack-summary, pack-clear,
//             pack-add-files, pack-add-folders, pack-key, pack-key-toggle,
//             pack-key-strength, pack-submit, pack-progress, pack-progress-fill,
//             pack-progress-label, pack-status, pack-reveal
//   결과 텍스트 pack-output, pack-output-text, pack-output-copy, pack-output-note
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
  busy: false,
  /// 묶을 항목. `{ path, name, kind, size, fileCount }`
  items: [],
  /// 방금 묶어 낸 결과. `{ dest, text }`
  packed: null,
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

function refreshButtons() {
  const packKey = el("pack-key");
  const packSubmit = el("pack-submit");
  if (packSubmit) {
    packSubmit.disabled = state.busy || state.items.length === 0 || !(packKey && packKey.value);
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

  for (const hook of [
    "pack-add-files",
    "pack-add-folders",
    "unpack-pick",
    "unpack-dest-pick",
    "unpack-text-clear",
    "pack-key-toggle",
    "unpack-key-toggle",
  ]) {
    const node = el(hook);
    if (node) node.disabled = state.busy;
  }
  for (const node of [packKey, unpackKey, el("unpack-dest"), el("unpack-text")]) {
    if (node) node.disabled = state.busy;
  }
  for (const tab of all("tab")) tab.disabled = state.busy;
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
  if (state.items.length === 1) {
    const base = state.items[0].name.replace(/\.[^.]+$/, "");
    return `${base}.packer.txt`;
  }
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `packer-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.txt`;
}

function renderPackOutput(result) {
  state.packed = { dest: result.dest, text: result.preview || null };

  const textarea = el("pack-output-text");
  if (textarea) textarea.value = result.preview || "";

  show("pack-output", true);
  setText(
    "pack-output-note",
    result.preview_omitted
      ? `텍스트가 ${formatBytes(result.container_bytes)}라서 화면에는 띄우지 않았습니다. 저장된 파일을 그대로 보내 주세요.`
      : `${formatBytes(result.container_bytes)} · 전체를 복사해 메모장이나 메신저에 붙여도 그대로 풀립니다.`,
  );

  // 화면에 못 띄운 경우에도 클립보드로는 옮길 수 있다 (파일에서 직접 읽는다).
  const copy = el("pack-output-copy");
  if (copy) copy.disabled = false;
  refreshButtons();
}

function clearPackOutput() {
  state.packed = null;
  const textarea = el("pack-output-text");
  if (textarea) textarea.value = "";
  show("pack-output", false);
  refreshButtons();
}

async function doPack() {
  const key = el("pack-key")?.value || "";
  if (!key) return setStatus("pack", "암호화 키를 입력해 주세요.", "error");
  if (state.items.length === 0) return setStatus("pack", "묶을 파일을 먼저 추가해 주세요.", "error");

  const dest = await invoke("pick_save_path", {
    suggestedName: suggestContainerName(),
    start: recall(REMEMBERED.saveDir) || null,
  });
  if (!dest) return; // 사용자가 취소했다.

  clearStatus("pack");
  clearPackOutput();
  resetProgress("pack");
  setBusy(true);
  try {
    const result = await invoke("pack", {
      paths: state.items.map((i) => i.path),
      passphrase: key,
      dest,
    });

    // 성공한 키만 이어 준다. 실패한 키를 풀기 탭에 흘려 보내면 혼란만 준다.
    session.key = key;
    applySessionKey();
    remember(REMEMBERED.saveDir, parentDir(result.dest));
    renderPackOutput(result);

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
    offerReveal("pack", result.dest);
  } catch (err) {
    setStatus("pack", errorText(err), "error");
  } finally {
    setBusy(false);
    resetProgress("pack");
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
    state.items = [];
    clearStatus("pack");
    clearPackOutput();
    renderList();
    refreshButtons();
  });

  el("pack-add-files")?.addEventListener("click", async () => {
    addPaths(await invoke("pick_files_to_pack"));
  });
  el("pack-add-folders")?.addEventListener("click", async () => {
    addPaths(await invoke("pick_folders_to_pack"));
  });
  el("pack-submit")?.addEventListener("click", doPack);
  el("pack-output-copy")?.addEventListener("click", copyPackOutput);

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
