// main.js 의 배선을 실제 창 없이 검증한다.
//
// index.html 을 jsdom 에 올리고 `window.__TAURI__` 를 가짜 브리지로 바꿔치기한 뒤 main.js 를
// 그대로 실행한다. 덕분에 탭 전환, 목록 렌더링, 버튼 활성화, 에러 표시, 텍스트 복사/붙여넣기,
// 그리고 무엇보다 **묶기에서 쓴 키가 풀기 탭으로 이어지는지** 를 사람 손 없이 확인할 수 있다.
//
//   pnpm test

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(root, "src", "index.html"), "utf8");
const mainJs = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");

const BEGIN = "-----BEGIN PACKER CONTAINER-----";
const END = "-----END PACKER CONTAINER-----";

/** 실제 결과물과 같은 모양의 가짜 armor 텍스트. */
const ARMOR_TEXT = [BEGIN, "A".repeat(76), "B".repeat(76), "Cg==", END, ""].join("\r\n");

/**
 * 줄바꿈을 LF 로 맞춘다.
 *
 * `textarea.value` 는 DOM 규격상 CRLF 가 LF 로 정규화된다 (실제 브라우저도 같다). armor 리더가
 * LF 도 받아 주므로 기능에는 영향이 없고, 파일에서 직접 읽는 '전체 복사' 경로는 CRLF 그대로다.
 */
const lf = (text) => text.replace(/\r\n/g, "\n");

/** 다음 마이크로태스크/타이머까지 기다린다. main() 이 await 를 여러 번 하므로 몇 번 돌려준다. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 붙여넣기 확인은 250ms 모아서 보내므로 그만큼 기다려 준다. */
const settleDebounce = () => new Promise((resolve) => setTimeout(resolve, 320));

/**
 * 가짜 Tauri 브리지를 붙인 jsdom 창을 만들고 main.js 를 실행한다.
 *
 * @param {Record<string, Function>} handlers 명령 이름 → 응답 함수
 */
async function mount(handlers = {}) {
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const { window } = dom;

  const calls = [];
  const listeners = new Map();
  let dragDropHandler = null;

  window.__TAURI__ = {
    core: {
      invoke: async (name, args) => {
        calls.push({ name, args });
        const handler = handlers[name];
        if (!handler) throw { code: "Internal", message: `가짜 핸들러 없음: ${name}` };
        return handler(args);
      },
    },
    event: {
      listen: async (name, cb) => {
        listeners.set(name, cb);
        return () => listeners.delete(name);
      },
    },
    webview: {
      getCurrentWebview: () => ({
        onDragDropEvent: async (cb) => {
          dragDropHandler = cb;
          return () => {
            dragDropHandler = null;
          };
        },
      }),
    },
  };

  window.eval(mainJs);
  window.dispatchEvent(new window.Event("DOMContentLoaded"));
  await settle();
  await settle();
  await settle();

  const hook = (name) => window.document.querySelector(`[data-pk="${name}"]`);

  return {
    dom,
    window,
    calls,
    hook,
    /** 훅이 화면에 보이는지 (hidden 속성 기준). */
    visible: (name) => {
      const node = hook(name);
      return Boolean(node) && !node.hidden;
    },
    text: (name) => hook(name)?.textContent ?? null,
    /** 반사 프로퍼티(.src)는 문서 URL 로 해석되어 속성을 지운 뒤에도 ""(null 아님)을 준다.
     *  "비운 게 아니라 속성을 제거했다" 는 getAttribute 로만 표현된다. */
    attr: (name, attribute) => hook(name)?.getAttribute(attribute) ?? null,
    value: (name) => hook(name)?.value ?? null,
    called: (name) => calls.some((c) => c.name === name),
    argsOf: (name) => calls.find((c) => c.name === name)?.args ?? null,
    click: async (name) => {
      hook(name).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await settle();
      await settle();
      await settle();
    },
    /** 자동 넘김처럼 시간이 흘러야 하는 것을 기다린다. */
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    type: async (name, value) => {
      const input = hook(name);
      input.value = value;
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
      await settle();
    },
    /** 체크박스를 켜고 끈다. `click` 과 달리 상태를 직접 정해 두 번 누르는 실수를 없앤다. */
    check: async (name, on) => {
      const input = hook(name);
      input.checked = on;
      input.dispatchEvent(new window.Event("change", { bubbles: true }));
      await settle();
    },
    /** 텍스트 영역에 붙여넣고 확인 요청이 나가기까지 기다린다. */
    paste: async (name, value) => {
      const input = hook(name);
      input.value = value;
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
      await settleDebounce();
      await settle();
      await settle();
    },
    drop: async (paths) => {
      assert.ok(dragDropHandler, "드래그 드롭 핸들러가 등록되지 않았다");
      dragDropHandler({ payload: { type: "drop", paths } });
      await settle();
      await settle();
      await settle();
    },
    dragOver: async () => {
      dragDropHandler({ payload: { type: "over" } });
      await settle();
    },
    dragLeave: async () => {
      dragDropHandler({ payload: { type: "leave" } });
      await settle();
    },
    emit: async (event, payload) => {
      const cb = listeners.get(event);
      assert.ok(cb, `${event} 리스너가 없다`);
      cb({ payload });
      await settle();
    },
    rows: () => Array.from(window.document.querySelectorAll('[data-pk="pack-list"] .row')),
    /** 스트림 타일 판에 서 있는 그림들. `src` 속성을 그대로 준다. */
    tiles: () =>
      Array.from(hook("pack-qr-stream-grid")?.children ?? []).map((img) =>
        img.getAttribute("src"),
      ),
    /** 타일에 인라인으로 박힌 폭. 정수 배율이 실제로 적용됐는지 본다. */
    tileWidths: () =>
      Array.from(hook("pack-qr-stream-grid")?.children ?? []).map((img) => img.style.width),
    /** 타일 수 라디오를 고른다. */
    pickTiles: async (count) => {
      const radio = Array.from(
        window.document.querySelectorAll('[data-pk="pack-qr-tile"]'),
      ).find((r) => r.value === String(count));
      assert.ok(radio, `${count}장 선택지가 없다`);
      radio.checked = true;
      radio.dispatchEvent(new window.Event("change", { bubbles: true }));
      await settle();
    },
    /** 안쪽 탭을 누른다. `which` 는 data-input / data-result 값이다. */
    subtab: async (name, which) => {
      const button = Array.from(
        window.document.querySelectorAll(`[data-pk="${name}"]`),
      ).find((b) => b.dataset.input === which || b.dataset.result === which);
      assert.ok(button, `${name}=${which} 탭이 없다`);
      button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await settle();
      await settle();
    },
  };
}

/** jsdom 은 이미지를 디코드하지 않는다. Rust 가 준 문자열이 src 로 그대로 흘러가는지만 본다. */
const qrPage = (n) => ({
  index: n,
  total: 0, // 아래 qrPages 에서 채운다.
  png_base64: `QRPNG${n}`,
  // floor(560/100)=5 → 500px. 클램프 [3,10] 안쪽이라 산술 자체를 못박는다.
  png_modules: 100,
  ec_level: "M",
  text_bytes: 1024,
});
const qrPages = (total) =>
  Array.from({ length: total }, (_, i) => ({ ...qrPage(i + 1), total }));

/**
 * `total` 장짜리 나눔을 흉내 내는 응답 조각.
 *
 * 그림은 응답에 실려 오지 않는다 — 첫 장만 함께 오고 나머지는 `qr_piece` 로 받아 간다
 * (조각 상한이 128장이라 전부 실으면 응답이 메가바이트가 된다).
 */
const qrPlan = (total) => ({
  qr_plan: { total, png_modules: 100, ec_level: "M" },
  qr_first: { ...qrPage(1), total },
  qr_omitted: false,
});

/** QR 한 장에 담기는 최대 바이트와 최대 장수 (Rust 의 qr::MAX_SYMBOL_BYTES / MAX_PIECES). */
const QR_LIMIT_BYTES = 2953;
const QR_LIMIT_PIECES = 128;

const PACK_RESULT = {
  // 저장 위치를 나중에 묻게 되면서 결과는 **임시 폴더**에 먼저 앉는다. 사람이 고른 자리는
  // `save_container` 가 옮겨 적은 뒤에야 생긴다.
  dest: "C:\\temp\\packer-out-a1\\bundle.txt",
  container_bytes: 1024,
  original_bytes: 4096,
  file_count: 2,
  dir_count: 1,
  changed: [],
  skipped: [],
  preview: ARMOR_TEXT,
  preview_omitted: false,
  ...qrPlan(1),
  qr_limit_bytes: QR_LIMIT_BYTES,
  qr_limit_pieces: QR_LIMIT_PIECES,
};

/** 흔한 응답을 미리 채운 핸들러 모음. */
function handlers(overrides = {}) {
  return {
    scan_paths: async ({ paths }) => ({
      items: paths.map((p) => ({
        path: p,
        name: p.split(/[\\/]/).pop(),
        kind: /\.(txt|bin)$/.test(p) ? "file" : "dir",
        size: 2048,
        file_count: /\.(txt|bin)$/.test(p) ? 1 : 4,
      })),
      total_bytes: 2048 * paths.length,
      file_count: paths.length,
      dir_count: 0,
    }),

    /// 뷰어가 장을 넘길 때마다 한 장씩 받아 간다. 실제 명령과 같이 1부터 센다.
    qr_piece: async ({ index }) => ({ ...qrPage(index), total: 0 }),

    qr_stream_open: async () => ({
      total_bytes: 400 * 1024,
      block_size: 1441,
      blocks: 285,
      fingerprint: "0123456789abcdef",
      png_modules: 133,
      frames_needed: 317,
    }),
    qr_stream_frame: async ({ seq }) => ({ png_base64: `FRAME${seq}`, png_modules: 133 }),
    qr_stream_close: async () => null,

    inspect: async ({ path: p }) => ({
      source: "file",
      path: p,
      name: p.split(/[\\/]/).pop(),
      byte_size: 5000,
      armored: true,
      format_version: 1,
      kdf: "Argon2id",
      cipher: "AES-256-GCM",
      compression: "zstd",
      chunk_size: 1048576,
    }),

    inspect_text: async ({ text }) => {
      if (!text.includes(BEGIN)) {
        throw { code: "NotContainer", message: "이 파일은 이 프로그램으로 묶은 파일이 아닙니다." };
      }
      return {
        source: "text",
        path: null,
        name: "붙여넣은 텍스트",
        byte_size: text.length,
        armored: true,
        format_version: 1,
        kdf: "Argon2id",
        cipher: "AES-256-GCM",
        compression: "zstd",
        chunk_size: 1048576,
      };
    },

    pick_save_path: async () => "C:\\out\\bundle.txt",
    pick_dest_dir: async () => "C:\\out\\restored",
    pick_files_to_pack: async () => ["C:\\src\\picked.txt"],
    pick_folders_to_pack: async () => ["C:\\src\\folder"],
    pick_container: async () => "C:\\out\\bundle.txt",
    reveal: async () => null,
    copy_container_to_clipboard: async () => 4096,

    pack: async () => PACK_RESULT,
    pack_text: async () => PACK_RESULT,
    save_container: async () => 1024,

    unpack: async () => ({
      dest: "C:\\out\\restored",
      file_count: 2,
      dir_count: 1,
      total_bytes: 4096,
      skipped: [],
      hash_mismatch: [],
      renamed: [],
    }),

    unpack_text: async () => ({
      dest: "C:\\out\\restored",
      file_count: 2,
      dir_count: 1,
      total_bytes: 4096,
      skipped: [],
      hash_mismatch: [],
      renamed: [],
    }),

    ...overrides,
  };
}

let open = [];
afterEach(() => {
  for (const dom of open) dom.window.close();
  open = [];
});

async function boot(overrides) {
  const app = await mount(handlers(overrides));
  open.push(app.dom);
  return app;
}

/** 묶기를 끝까지 한 번 돌린다. */
async function packOnce(app, key = "열려라 참깨 2026!") {
  await app.drop(["C:\\src\\a.txt"]);
  await app.type("pack-key", key);
  await app.click("pack-submit");
}

describe("첫 화면", () => {
  it("묶기 탭만 보이고 풀기 패널은 숨어 있다", async () => {
    const app = await boot();
    const panels = Array.from(app.window.document.querySelectorAll('[data-pk="panel"]'));
    assert.equal(panels.find((p) => p.dataset.tab === "pack").hidden, false);
    assert.equal(panels.find((p) => p.dataset.tab === "unpack").hidden, true);
  });

  it("담긴 항목이 없으면 묶기 버튼이 잠겨 있다", async () => {
    const app = await boot();
    assert.equal(app.hook("pack-submit").disabled, true);
    assert.equal(app.hook("pack-clear").disabled, true);
    assert.equal(app.visible("pack-empty"), true);
    assert.equal(app.visible("pack-progress"), false);
    assert.equal(app.visible("pack-status"), false);
    // 결과 텍스트 영역은 묶기 전에는 나오지 않는다.
    assert.equal(app.visible("pack-output"), false);
  });

  it("'기억' 버튼이 어디에도 없다", async () => {
    const app = await boot();
    // 요청대로 제거했다. 문구로도, 훅으로도 남아 있지 않아야 한다.
    assert.equal(app.window.document.body.textContent.includes("기억"), false);
    assert.equal(app.window.document.querySelector('[data-pk="pack-remember"]'), null);
  });
});

describe("탭 전환", () => {
  it("풀기를 누르면 패널이 맞바뀐다", async () => {
    const app = await boot();
    const tabs = Array.from(app.window.document.querySelectorAll('[data-pk="tab"]'));
    const unpackTab = tabs.find((t) => t.dataset.tab === "unpack");
    unpackTab.dispatchEvent(new app.window.MouseEvent("click", { bubbles: true }));
    await settle();

    const panels = Array.from(app.window.document.querySelectorAll('[data-pk="panel"]'));
    assert.equal(panels.find((p) => p.dataset.tab === "pack").hidden, true);
    assert.equal(panels.find((p) => p.dataset.tab === "unpack").hidden, false);
    assert.equal(unpackTab.getAttribute("aria-selected"), "true");
  });
});

describe("묶기 목록", () => {
  it("드롭한 경로를 scan_paths 로 재서 행으로 그린다", async () => {
    const app = await boot();
    await app.drop(["C:\\src\\메모.txt", "C:\\src\\폴더"]);

    const rows = app.rows();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].querySelector('[data-field="name"]').textContent, "메모.txt");
    assert.equal(rows[1].querySelector('[data-field="name"]').textContent, "폴더");
    assert.match(rows[1].querySelector('[data-field="meta"]').textContent, /폴더 · 파일 4개/);
    assert.equal(app.visible("pack-empty"), false);
    assert.match(app.text("pack-summary"), /2개 항목/);
  });

  it("같은 경로를 다시 드롭해도 중복되지 않는다", async () => {
    const app = await boot();
    await app.drop(["C:\\src\\a.txt"]);
    await app.drop(["C:\\src\\a.txt"]);
    assert.equal(app.rows().length, 1);
  });

  it("행의 제거 버튼이 그 항목만 뺀다", async () => {
    const app = await boot();
    await app.drop(["C:\\src\\a.txt", "C:\\src\\b.bin"]);
    app
      .rows()[0]
      .querySelector('[data-pk="row-remove"]')
      .dispatchEvent(new app.window.MouseEvent("click", { bubbles: true }));
    await settle();

    const rows = app.rows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].querySelector('[data-field="name"]').textContent, "b.bin");
  });

  it("모두 비우기가 목록과 결과 텍스트를 함께 치운다", async () => {
    const app = await boot();
    await packOnce(app);
    assert.equal(app.visible("pack-output"), true);

    await app.click("pack-clear");
    assert.equal(app.rows().length, 0);
    assert.equal(app.visible("pack-empty"), true);
    assert.equal(app.visible("pack-output"), false, "지난 결과가 남아 있으면 헷갈린다");
  });

  it("드래그 중에는 드롭존이 강조된다", async () => {
    const app = await boot();
    await app.dragOver();
    assert.equal(app.hook("pack-dropzone").classList.contains("is-dragover"), true);
    await app.dragLeave();
    assert.equal(app.hook("pack-dropzone").classList.contains("is-dragover"), false);
  });
});

describe("암호화 키", () => {
  it("항목과 키가 모두 있어야 묶기 버튼이 열린다", async () => {
    const app = await boot();
    await app.drop(["C:\\src\\a.txt"]);
    assert.equal(app.hook("pack-submit").disabled, true, "키가 없으면 잠겨 있어야 한다");
    await app.type("pack-key", "열려라 참깨");
    assert.equal(app.hook("pack-submit").disabled, false);
  });

  it("보기 버튼이 키를 평문으로 바꾼다", async () => {
    const app = await boot();
    assert.equal(app.hook("pack-key").type, "password");
    await app.click("pack-key-toggle");
    assert.equal(app.hook("pack-key").type, "text");
    await app.click("pack-key-toggle");
    assert.equal(app.hook("pack-key").type, "password");
  });

  it("짧은 키에 경고를 띄운다", async () => {
    const app = await boot();
    await app.type("pack-key", "abc");
    assert.equal(app.visible("pack-key-strength"), true);
    assert.match(app.text("pack-key-strength"), /짧습니다/);
    await app.type("pack-key", "Zaq12wsx!열려라참깨");
    assert.equal(app.hook("pack-key-strength").dataset.level, "strong");
  });
});

describe("묶고 암호화하기", () => {
  it("경로와 키를 그대로 pack 에 넘긴다", async () => {
    const app = await boot();
    await app.drop(["C:\\src\\a.txt", "C:\\src\\b.bin"]);
    await app.type("pack-key", "열려라 참깨");
    await app.click("pack-submit");

    const args = app.argsOf("pack");
    assert.ok(args, "pack 이 호출되지 않았다");
    // jsdom 창의 배열은 프로토타입이 달라 strict 비교를 통과하지 못한다. 값만 본다.
    assert.deepEqual(Array.from(args.paths), ["C:\\src\\a.txt", "C:\\src\\b.bin"]);
    assert.equal(args.passphrase, "열려라 참깨");
  });

  it("묶기 전에는 저장 위치를 묻지 않는다", async () => {
    // 결과를 텍스트로 부칠지 QR 로 비출지는 크기를 알아야 정할 수 있고, 그 크기는 묶어 봐야
    // 나온다. QR 로 비추고 말 것이었다면 파일은 애초에 만들 필요가 없었다.
    const app = await boot();
    await packOnce(app);

    assert.equal(app.called("pick_save_path"), false);
    assert.equal(app.argsOf("pack").dest, null);
    assert.equal(app.visible("pack-output"), true);
  });

  it("아직 저장되지 않았다는 것을 결과에 적는다", async () => {
    const app = await boot();
    await packOnce(app);

    assert.match(app.text("pack-save-note"), /아직 파일로 저장하지 않았습니다/);
    assert.equal(app.visible("pack-reveal"), false, "저장하기 전에는 열어 볼 자리가 없다");
  });

  it("성공하면 절약률과 안내를 보여 준다", async () => {
    const app = await boot();
    await packOnce(app);

    assert.equal(app.visible("pack-status"), true);
    assert.equal(app.hook("pack-status").dataset.kind, "ok");
    assert.match(app.text("pack-status"), /파일 2개를 텍스트로 묶었습니다/);
    assert.match(app.text("pack-status"), /75% 절약/);
  });

  it("실패하면 Rust 가 준 한국어 문장을 그대로 띄운다", async () => {
    const app = await boot({
      pack: async () => {
        throw { code: "Io", message: "D:\\x 를 만들 수 없습니다: 액세스가 거부되었습니다" };
      },
    });
    await packOnce(app);

    assert.equal(app.hook("pack-status").dataset.kind, "error");
    assert.match(app.text("pack-status"), /액세스가 거부되었습니다/);
    assert.equal(app.visible("pack-output"), false);
    assert.equal(app.visible("pack-qr"), false, "실패한 뒤 지난 QR 이 남으면 엉뚱한 그림을 보낸다");
  });

  it("건너뛴 항목이 있으면 경고로 알린다", async () => {
    const app = await boot({
      pack: async () => ({
        dest: "C:\\out\\bundle.txt",
        container_bytes: 1024,
        original_bytes: 4096,
        file_count: 1,
        dir_count: 0,
        changed: ["a.txt"],
        skipped: ["C:\\src\\link — 링크는 담지 않습니다"],
        preview: ARMOR_TEXT,
        preview_omitted: false,
      }),
    });
    await packOnce(app, "pw123456");

    assert.equal(app.hook("pack-status").dataset.kind, "warn");
    assert.match(app.text("pack-status"), /크기가 변한 파일 1개/);
    assert.match(app.text("pack-status"), /담지 못한 항목 1개/);
  });
});

describe("입력 모드 — 파일 선택 / 텍스트 입력", () => {
  it("처음에는 파일 선택 모드로 선다", async () => {
    const app = await boot();
    const panels = Array.from(
      app.window.document.querySelectorAll('[data-pk="pack-input-panel"]'),
    );
    assert.equal(panels.find((p) => p.dataset.input === "files").hidden, false);
    assert.equal(panels.find((p) => p.dataset.input === "text").hidden, true);
  });

  it("텍스트 입력으로 바꾸면 드롭존 대신 글 칸이 선다", async () => {
    const app = await boot();
    await app.subtab("pack-input-tab", "text");

    const panels = Array.from(
      app.window.document.querySelectorAll('[data-pk="pack-input-panel"]'),
    );
    assert.equal(panels.find((p) => p.dataset.input === "files").hidden, true);
    assert.equal(panels.find((p) => p.dataset.input === "text").hidden, false);
  });

  it("텍스트 모드에서는 글과 키가 모두 있어야 묶기가 열린다", async () => {
    const app = await boot();
    await app.subtab("pack-input-tab", "text");
    await app.type("pack-key", "pw123456");
    assert.equal(app.hook("pack-submit").disabled, true, "빈 글로는 묶을 것이 없다");

    await app.type("pack-text", "  \n  ");
    assert.equal(app.hook("pack-submit").disabled, true, "공백만 있는 것도 빈 글이다");

    await app.type("pack-text", "옮길 메모 한 줄");
    assert.equal(app.hook("pack-submit").disabled, false);
  });

  it("적은 글을 pack_text 로 넘긴다 — 임시 파일을 거치지 않는다", async () => {
    const app = await boot();
    await app.subtab("pack-input-tab", "text");
    await app.type("pack-text-name", "회의록");
    await app.type("pack-text", "첫 줄\n둘째 줄");
    await app.type("pack-key", "pw123456");
    await app.click("pack-submit");

    const args = app.argsOf("pack_text");
    assert.ok(args, "pack_text 가 호출되지 않았다");
    assert.equal(args.text, "첫 줄\n둘째 줄");
    assert.equal(args.name, "회의록");
    assert.equal(args.passphrase, "pw123456");
    assert.equal(args.dest, null);
    assert.equal(app.called("pack"), false, "파일 쪽 명령이 함께 불리면 안 된다");
  });

  it("이름을 비워 두면 Rust 가 기본 이름을 정하게 둔다", async () => {
    const app = await boot();
    await app.subtab("pack-input-tab", "text");
    await app.type("pack-text", "이름 없는 메모");
    await app.type("pack-key", "pw123456");
    await app.click("pack-submit");

    // 빈 문자열이 아니라 null 이다. 기본값을 JS 에 한 번 더 적어 두면 언젠가 어긋난다.
    assert.equal(app.argsOf("pack_text").name, null);
  });

  it("글자 수를 세어 준다 — 묶기 전에 크기를 가늠할 유일한 숫자다", async () => {
    const app = await boot();
    await app.subtab("pack-input-tab", "text");
    assert.equal(app.text("pack-text-count"), "");
    await app.type("pack-text", "12345");
    assert.match(app.text("pack-text-count"), /5자/);
  });

  it("모드를 오가도 담아 둔 것이 사라지지 않는다", async () => {
    const app = await boot();
    await app.drop(["C:\\src\\a.txt"]);
    await app.subtab("pack-input-tab", "text");
    await app.type("pack-text", "지워지면 안 되는 글");
    await app.subtab("pack-input-tab", "files");

    assert.equal(app.rows().length, 1, "파일 목록이 사라졌다");
    await app.subtab("pack-input-tab", "text");
    assert.equal(app.value("pack-text"), "지워지면 안 되는 글");
  });

  it("파일이 담겨 있어도 텍스트 모드에서는 글만 묶는다", async () => {
    const app = await boot();
    await app.drop(["C:\\src\\a.txt"]);
    await app.subtab("pack-input-tab", "text");
    await app.type("pack-text", "이것만 묶는다");
    await app.type("pack-key", "pw123456");
    await app.click("pack-submit");

    assert.equal(app.called("pack"), false);
    assert.equal(app.argsOf("pack_text").text, "이것만 묶는다");
  });

  it("'모두 비우기' 는 파일 목록만 비운다", async () => {
    const app = await boot();
    await app.subtab("pack-input-tab", "text");
    await app.type("pack-text", "남아 있어야 하는 글");
    await app.subtab("pack-input-tab", "files");
    await app.drop(["C:\\src\\a.txt"]);
    await app.click("pack-clear");

    assert.equal(app.rows().length, 0);
    assert.equal(app.value("pack-text"), "남아 있어야 하는 글");
  });
});

describe("결과 모드 — 텍스트 / QR 탭", () => {
  it("묶고 나서야 결과 탭이 뜨고, 텍스트 쪽이 먼저 열린다", async () => {
    const app = await boot();
    assert.equal(app.visible("pack-result"), false);

    await packOnce(app);
    assert.equal(app.visible("pack-result"), true);
    const panels = Array.from(
      app.window.document.querySelectorAll('[data-pk="pack-result-panel"]'),
    );
    assert.equal(panels.find((p) => p.dataset.result === "text").hidden, false);
    assert.equal(panels.find((p) => p.dataset.result === "qr").hidden, true);
  });

  it("QR 탭으로 옮기면 그림 쪽이 열린다", async () => {
    const app = await boot();
    await packOnce(app);
    await app.subtab("pack-result-tab", "qr");

    const panels = Array.from(
      app.window.document.querySelectorAll('[data-pk="pack-result-panel"]'),
    );
    assert.equal(panels.find((p) => p.dataset.result === "qr").hidden, false);
    assert.equal(panels.find((p) => p.dataset.result === "text").hidden, true);
    assert.equal(app.visible("pack-qr"), true);
  });

  it("QR 탭에서 나가면 흘려 보내던 것을 멈춘다", async () => {
    // 안 보이는 화면에서 프레임 번호만 앞으로 가면 폰은 그 번호들을 영영 못 본다.
    const app = await boot({
      pack: async () => ({
        ...PACK_RESULT,
        container_bytes: 400 * 1024,
        qr_plan: null,
        qr_first: null,
        qr_omitted: true,
      }),
    });
    await packOnce(app, "pw123456");
    await app.subtab("pack-result-tab", "qr");
    await app.click("pack-qr-stream-start");
    assert.equal(app.text("pack-qr-stream-start"), "그만 보내기");

    await app.subtab("pack-result-tab", "text");
    assert.ok(app.called("qr_stream_close"), "탭을 떠나면 붙잡은 바이트를 놓아야 한다");
    assert.equal(app.text("pack-qr-stream-start"), "스트림으로 보내기");
  });

  it("'파일로 저장' 이 위치를 묻고 그 자리로 옮겨 적는다", async () => {
    const app = await boot();
    await packOnce(app);
    assert.equal(app.called("pick_save_path"), false, "묶을 때는 묻지 않는다");

    await app.click("pack-save");

    assert.ok(app.argsOf("pick_save_path").suggestedName.endsWith(".txt"));
    // 경로를 Rust 로 넘기지 않는다 — 원본은 Rust 가 붙잡고 있는 결과 하나뿐이다.
    assert.deepEqual(Object.keys(app.argsOf("save_container")), ["dest"]);
    assert.equal(app.argsOf("save_container").dest, "C:\\out\\bundle.txt");
    assert.match(app.text("pack-save-note"), /C:\\out\\bundle\.txt/);
    assert.match(app.text("pack-save-note"), /저장했습니다/);
    assert.equal(app.visible("pack-reveal"), true);
  });

  it("저장 위치를 취소하면 아무것도 옮기지 않는다", async () => {
    const app = await boot({ pick_save_path: async () => null });
    await packOnce(app);
    await app.click("pack-save");

    assert.equal(app.called("save_container"), false);
    // 묶은 결과 자체는 그대로 있다 — 취소한 것은 저장이지 묶기가 아니다.
    assert.equal(app.visible("pack-output"), true);
    assert.match(app.text("pack-save-note"), /아직 파일로 저장하지 않았습니다/);
  });

  it("저장에 실패하면 이유를 그대로 띄운다", async () => {
    const app = await boot({
      save_container: async () => {
        throw { code: "Io", message: "D:\\x 로 저장할 수 없습니다: 액세스가 거부되었습니다" };
      },
    });
    await packOnce(app);
    await app.click("pack-save");

    assert.equal(app.hook("pack-status").dataset.kind, "error");
    assert.match(app.text("pack-status"), /액세스가 거부되었습니다/);
    assert.equal(app.visible("pack-reveal"), false);
  });

  it("저장한 뒤 입력 모드를 바꿔도 열어 볼 자리가 남는다", async () => {
    const app = await boot();
    await packOnce(app);
    await app.click("pack-save");
    await app.subtab("pack-input-tab", "text");

    assert.equal(app.visible("pack-reveal"), true, "저장해 둔 파일로 가는 길이 끊기면 안 된다");
    assert.match(app.text("pack-save-note"), /저장했습니다/);
  });

  it("다시 묶으면 저장 표시가 처음으로 돌아간다", async () => {
    const app = await boot();
    await packOnce(app);
    await app.click("pack-save");
    assert.equal(app.visible("pack-reveal"), true);

    await app.click("pack-submit");
    assert.match(app.text("pack-save-note"), /아직 파일로 저장하지 않았습니다/);
    assert.equal(app.visible("pack-reveal"), false, "지난 결과를 가리키는 자리가 남으면 안 된다");
  });
});

describe("텍스트 결과 — 요청의 핵심", () => {
  it("묶은 결과를 복사할 수 있는 텍스트로 보여 준다", async () => {
    const app = await boot();
    await packOnce(app);

    assert.equal(app.visible("pack-output"), true, "결과 텍스트가 보이지 않는다");
    const shown = app.value("pack-output-text");
    // 텍스트 에디터에 그대로 붙일 수 있는 형태여야 한다.
    assert.ok(shown.startsWith(BEGIN), `시작 표시가 없다: ${shown.slice(0, 40)}`);
    assert.ok(shown.trimEnd().endsWith(END), "끝 표시가 없다");
    assert.equal(lf(shown), lf(ARMOR_TEXT));
  });

  it("결과 텍스트 영역은 읽기 전용이고 선택할 수 있다", async () => {
    const app = await boot();
    await packOnce(app);
    const area = app.hook("pack-output-text");
    assert.equal(area.readOnly, true, "실수로 고쳐지면 풀 수 없게 된다");
    assert.equal(area.tagName, "TEXTAREA");
  });

  it("전체 복사가 파일 경로로 클립보드 명령을 부른다", async () => {
    const app = await boot();
    await packOnce(app);
    await app.click("pack-output-copy");

    // 본문을 IPC 로 한 번 더 넘기지 않고 Rust 가 파일에서 직접 읽어 올린다.
    const args = app.argsOf("copy_container_to_clipboard");
    assert.ok(args, "클립보드 명령이 호출되지 않았다");
    // 저장 전에는 임시 폴더의 것을 읽는다. 복사는 저장과 무관하게 언제든 된다.
    assert.equal(args.path, "C:\\temp\\packer-out-a1\\bundle.txt");
    assert.equal(app.hook("pack-status").dataset.kind, "ok");
    assert.match(app.text("pack-status"), /클립보드에 복사했습니다/);
  });

  it("텍스트가 너무 크면 화면에 띄우지 않고 그 이유를 말해 준다", async () => {
    const app = await boot({
      pack: async () => ({
        dest: "C:\\out\\big.txt",
        container_bytes: 40 * 1024 * 1024,
        original_bytes: 80 * 1024 * 1024,
        file_count: 3,
        dir_count: 0,
        changed: [],
        skipped: [],
        preview: null,
        preview_omitted: true,
      }),
    });
    await packOnce(app, "pw123456");

    assert.equal(app.visible("pack-output"), true);
    assert.equal(app.value("pack-output-text"), "");
    assert.match(app.text("pack-output-note"), /화면에는 띄우지 않았습니다/);
    // 그래도 클립보드로는 옮길 수 있어야 한다.
    assert.equal(app.hook("pack-output-copy").disabled, false);
  });

  it("클립보드 복사가 실패하면 이유를 보여 준다", async () => {
    const app = await boot({
      copy_container_to_clipboard: async () => {
        throw { code: "Io", message: "텍스트가 너무 커서 클립보드로 옮길 수 없습니다 (80 MB)." };
      },
    });
    await packOnce(app);
    await app.click("pack-output-copy");

    assert.equal(app.hook("pack-status").dataset.kind, "error");
    assert.match(app.text("pack-status"), /클립보드로 옮길 수 없습니다/);
  });
});

describe("QR 코드 — 휴대폰으로 옮기기", () => {
  it("묶은 결과를 QR 코드 그림으로도 보여 준다", async () => {
    const app = await boot();
    await packOnce(app);

    assert.equal(app.visible("pack-qr"), true);
    assert.equal(app.hook("pack-qr").dataset.state, "single");
    assert.equal(app.visible("pack-qr-image"), true);
    assert.equal(app.attr("pack-qr-image", "src"), "data:image/png;base64,QRPNG1");
    assert.match(app.text("pack-qr-note"), /기본 카메라/);
    // 스캔한 다음 무엇을 해야 하는지까지 말해 줘야 쓸모가 있다. 카메라는 뜻 없는 Base64 벽만
    // 보여 주기 때문이다.
    assert.match(app.text("pack-qr-note"), /풀기 탭에 붙여넣으면/);
  });

  it("한 장이면 넘기기 도구가 아예 나오지 않는다", async () => {
    const app = await boot();
    await packOnce(app);

    // 뜻이 없는 조작 도구는 잠그기보다 감춘다 — 잠가 두면 더 있을 것처럼 보인다.
    assert.equal(app.visible("pack-qr-nav"), false);
    assert.equal(app.text("pack-qr-index"), "");
  });

  it("QR 그림을 정수 배율로만 키운다", async () => {
    const app = await boot();
    await packOnce(app);

    // 모듈 폭에 소수점이 붙으면 휴대폰이 초점을 맞춰도 인식하지 못한다.
    // 100모듈 → floor(560/100)=5배 → 500px.
    assert.equal(app.hook("pack-qr-image").style.width, "500px");
  });

  it("여러 장으로 나뉘면 장수와 이어 붙이는 방법을 알려 준다", async () => {
    const app = await boot({
      pack: async () => ({ ...PACK_RESULT, container_bytes: 12 * 1024, ...qrPlan(16) }),
    });
    await packOnce(app, "pw123456");

    assert.equal(app.hook("pack-qr").dataset.state, "split");
    assert.equal(app.visible("pack-qr-nav"), true);
    assert.equal(app.text("pack-qr-index"), "1 / 16");

    const note = app.text("pack-qr-note");
    assert.match(note, /16장으로 나눴습니다/);
    // 이제 쉬운 길이 먼저다 — 자동 넘김 + 조각 모으기 앱.
    assert.match(note, /자동 넘김/);
    assert.match(note, /한 바퀴 돌면 멈춥니다/);
    // 손으로 이어 붙이는 길도 남아 있고, 앱이 이어 붙여 주지 않는다는 사실도 말해야 한다.
    assert.match(note, /손으로 이어 붙일 수도 있습니다/);
    // 추상적인 표기 대신 실제 값이라야 붙여넣은 텍스트에서 알아본다.
    assert.match(note, /#1\/16 부터 #16\/16 까지/);
    // 순서 표시를 쓰레기로 보고 지우다 Base64 를 함께 지우는 사고를 막는다.
    assert.match(note, /지우지 않아도 됩니다/);
  });

  it("자동 넘김이 스스로 장을 넘기고 마지막 장에서 멈춘다", async () => {
    const app = await boot({ pack: async () => ({ ...PACK_RESULT, ...qrPlan(3) }) });
    await packOnce(app, "pw123456");

    // 속도를 최소로 내려 테스트가 오래 걸리지 않게 한다.
    app.hook("pack-qr-speed").value = "300";
    await app.click("pack-qr-play");
    assert.equal(app.text("pack-qr-play"), "멈춤");
    assert.equal(app.hook("pack-qr-play").getAttribute("aria-pressed"), "true");

    await app.wait(1100);

    assert.equal(app.text("pack-qr-index"), "3 / 3");
    // 한 바퀴 돌면 멈춘다. '다음' 이 잠기는 것이 "다 찍었다" 는 유일한 신호라서, 무한히
    // 돌면 그 신호가 사라진다.
    assert.equal(app.text("pack-qr-play"), "자동 넘김");
    assert.equal(app.hook("pack-qr-next").disabled, true);
  });

  it("자동 넘김 중에 손으로 넘기면 자동이 비켜 준다", async () => {
    const app = await boot({ pack: async () => ({ ...PACK_RESULT, ...qrPlan(8) }) });
    await packOnce(app, "pw123456");

    app.hook("pack-qr-speed").value = "1500";
    await app.click("pack-qr-play");
    await app.click("pack-qr-next");

    // 둘이 동시에 장을 옮기면 어느 쪽도 못 쫓는다.
    assert.equal(app.text("pack-qr-play"), "자동 넘김");
    assert.equal(app.text("pack-qr-index"), "2 / 8");
  });

  it("한 장짜리에는 자동 넘김이 뜻이 없다", async () => {
    const app = await boot();
    await packOnce(app);
    // nav 자체가 감춰지므로 버튼도 함께 사라진다.
    assert.equal(app.visible("pack-qr-nav"), false);
    assert.equal(app.hook("pack-qr-play").disabled, true);
    // 부를 장도 없다.
    assert.equal(app.visible("pack-qr-jump"), false);
  });

  it("놓친 장 번호를 넣으면 그 장이 바로 나온다", async () => {
    // 마지막 한두 장 때문에 한 바퀴(128장이면 45초)를 다시 도는 것을 없애려고 있는 길이다.
    const app = await boot({ pack: async () => ({ ...PACK_RESULT, ...qrPlan(16) }) });
    await packOnce(app, "pw123456");

    assert.equal(app.visible("pack-qr-jump"), true);
    await app.type("pack-qr-goto", "7");
    await app.click("pack-qr-goto-go");

    assert.equal(app.text("pack-qr-index"), "7 / 16");
    // 한 장이면 돌 이유가 없다 — 폰이 읽을 때까지 가만히 서 있는 것이 맞다.
    assert.equal(app.text("pack-qr-play"), "자동 넘김");
    assert.match(app.text("pack-qr-goto-note"), /7번 장입니다/);
    assert.equal(app.visible("pack-qr-goto-clear"), false);

    // 보고 있던 장을 다시 불러도 말은 해 준다 — 잘못 눌렀다고 오해하지 않도록.
    await app.click("pack-qr-goto-go");
    assert.equal(app.text("pack-qr-index"), "7 / 16");
    assert.match(app.text("pack-qr-goto-note"), /7번 장입니다/);
  });

  it("목록을 돌다가 한 장을 부르면 목록을 놓는다", async () => {
    const app = await boot({ pack: async () => ({ ...PACK_RESULT, ...qrPlan(16) }) });
    await packOnce(app, "pw123456");

    await app.type("pack-qr-goto", "3, 7");
    await app.click("pack-qr-goto-go");
    assert.equal(app.text("pack-qr-index"), "3 / 16 · 부른 장 1/2");

    await app.type("pack-qr-goto", "9");
    await app.click("pack-qr-goto-go");

    assert.equal(app.text("pack-qr-index"), "9 / 16", "목록 표시가 남으면 안 된다");
    assert.equal(app.text("pack-qr-play"), "자동 넘김", "한 장을 부르면 돌기를 멈춘다");
    assert.equal(app.visible("pack-qr-goto-clear"), false);
  });

  it("여러 장을 넣으면 그 목록만 되풀이해 돈다", async () => {
    const asked = [];
    const app = await boot({
      pack: async () => ({ ...PACK_RESULT, ...qrPlan(16) }),
      qr_piece: async ({ index }) => {
        asked.push(index);
        return { ...qrPage(index), total: 16 };
      },
    });
    await packOnce(app, "pw123456");

    app.hook("pack-qr-speed").value = "300";
    await app.type("pack-qr-goto", "3, 7");
    // 여기서부터 받아 온 장만 센다. 그 앞의 것은 1번 장 둘레를 미리 받아 둔 것이다.
    const before = asked.length;
    await app.click("pack-qr-goto-go");

    // 넣자마자 돈다. 여기서 한 번 더 누르게 하는 것은 아무 판단도 더해 주지 않는다.
    assert.equal(app.text("pack-qr-play"), "멈춤");
    assert.equal(app.text("pack-qr-index"), "3 / 16 · 부른 장 1/2");
    assert.match(app.text("pack-qr-goto-note"), /부른 2장만 돌립니다 \(3, 7\)/);
    assert.match(app.text("pack-qr-goto-note"), /1바퀴째/);

    await app.wait(700);

    // 전체 순회는 한 바퀴에 멈추지만 부른 목록은 되풀이한다 — 두 장짜리 한 바퀴는 신호가
    // 되지 못하고, 이 목록은 폰이 "이것만 있으면 된다" 고 알려 준 것이다.
    assert.equal(app.text("pack-qr-play"), "멈춤", "목록은 한 바퀴에 멈추지 않는다");
    assert.match(app.text("pack-qr-goto-note"), /[2-9]바퀴째/);
    assert.match(app.text("pack-qr-index"), /^(3|7) \/ 16 · 부른 장 [12]\/2$/);
    // 부르지 않은 장은 미리 받지도 않는다. 곧 그릴 장이 체류 시간 안에 도착해야 한다.
    // (3번은 1번 장 둘레를 미리 받을 때 이미 캐시에 들어가 다시 묻지 않을 수 있다.)
    const outside = asked.slice(before).filter((page) => page !== 3 && page !== 7);
    assert.deepEqual(outside, [], `부르지 않은 장을 받아 왔다: ${outside}`);

    await app.click("pack-qr-goto-clear");
    assert.equal(app.text("pack-qr-goto-note"), "");
    assert.equal(app.value("pack-qr-goto"), "");
    assert.match(app.text("pack-qr-index"), /^(3|7) \/ 16$/, "보던 장은 그대로 둔다");

    // 목록을 놓았으면 넘기기는 다시 전체를 오간다.
    const page = Number(app.text("pack-qr-index").split(" ")[0]);
    await app.click("pack-qr-next");
    assert.equal(app.text("pack-qr-index"), `${page + 1} / 16`);
  });

  it("범위 표기를 폰이 적어 준 그대로 받는다", async () => {
    // 폰 화면의 "남은 순번 12~15" 를 그대로 옮겨 칠 수 있어야 한다 (mobile 의 summarizeIndices).
    const app = await boot({ pack: async () => ({ ...PACK_RESULT, ...qrPlan(16) }) });
    await packOnce(app, "pw123456");

    await app.type("pack-qr-goto", "12~15");
    await app.click("pack-qr-goto-go");
    assert.equal(app.text("pack-qr-index"), "12 / 16 · 부른 장 1/4");

    // 손이 먼저 가는 `-` 도 받는다.
    await app.click("pack-qr-goto-clear");
    await app.type("pack-qr-goto", "2-3");
    await app.click("pack-qr-goto-go");
    assert.equal(app.text("pack-qr-index"), "2 / 16 · 부른 장 1/2");
  });

  it("넣은 번호를 읽을 수 없으면 무엇을 적어야 하는지 말해 준다", async () => {
    const app = await boot({ pack: async () => ({ ...PACK_RESULT, ...qrPlan(16) }) });
    await packOnce(app, "pw123456");

    await app.type("pack-qr-goto", "없는 번호");
    await app.click("pack-qr-goto-go");
    assert.match(app.text("pack-qr-goto-note"), /1 ~ 16 사이의 번호/);
    assert.equal(app.text("pack-qr-index"), "1 / 16", "읽을 수 없으면 장을 옮기지 않는다");

    // 범위 밖은 건너뛰되, 읽어낸 번호가 있으면 그것으로 진행한다.
    await app.type("pack-qr-goto", "5, 99");
    await app.click("pack-qr-goto-go");
    assert.equal(app.text("pack-qr-index"), "5 / 16");
    assert.match(app.text("pack-qr-goto-note"), /밖의 번호는 건너뛰었습니다/);
  });

  it("새로 묶으면 지난 결과의 부른 목록이 남지 않는다", async () => {
    // 남아 있으면 새 묶음의 엉뚱한 장을 부른다.
    const app = await boot({ pack: async () => ({ ...PACK_RESULT, ...qrPlan(16) }) });
    await packOnce(app, "pw123456");
    await app.type("pack-qr-goto", "3, 7");
    await app.click("pack-qr-goto-go");

    await packOnce(app, "pw123456");
    assert.equal(app.value("pack-qr-goto"), "");
    assert.equal(app.text("pack-qr-goto-note"), "");
    assert.equal(app.text("pack-qr-index"), "1 / 16");
  });

  it("그림은 한 장씩 받아 온다", async () => {
    // 조각 상한이 128장이라 전부 실어 보내면 응답이 메가바이트가 된다.
    const asked = [];
    const app = await boot({
      pack: async () => ({ ...PACK_RESULT, ...qrPlan(4) }),
      qr_piece: async ({ index }) => {
        asked.push(index);
        return { ...qrPage(index), total: 4 };
      },
    });
    await packOnce(app, "pw123456");

    // 첫 장은 묶기 응답에 실려 오므로 다시 묻지 않는다.
    assert.ok(!asked.includes(1), `1번은 이미 받았다: ${asked}`);
    // 대신 앞의 몇 장을 미리 받아 둔다 — 자동 넘김의 체류 시간 안에 그림이 도착해야 한다.
    assert.ok(asked.includes(2), `미리 받아야 한다: ${asked}`);

    await app.click("pack-qr-next");
    assert.equal(app.attr("pack-qr-image", "src"), "data:image/png;base64,QRPNG2");
  });

  it("다음·이전으로 장을 넘기고 양끝에서는 잠긴다", async () => {
    const app = await boot({ pack: async () => ({ ...PACK_RESULT, ...qrPlan(3) }) });
    await packOnce(app, "pw123456");

    assert.equal(app.text("pack-qr-index"), "1 / 3");
    assert.equal(app.hook("pack-qr-prev").disabled, true, "첫 장에서는 이전이 잠겨 있어야 한다");
    assert.equal(app.hook("pack-qr-next").disabled, false);
    // 첫 장에서 이전을 눌러도 뒤로 돌지 않는다.
    await app.click("pack-qr-prev");
    assert.equal(app.text("pack-qr-index"), "1 / 3");

    await app.click("pack-qr-next");
    assert.equal(app.text("pack-qr-index"), "2 / 3");
    assert.equal(app.attr("pack-qr-image", "src"), "data:image/png;base64,QRPNG2");
    assert.equal(app.hook("pack-qr-prev").disabled, false);

    await app.click("pack-qr-next");
    assert.equal(app.text("pack-qr-index"), "3 / 3");
    // '다음' 이 잠기는 것이 "다 찍었다" 는 유일한 신호다.
    assert.equal(app.hook("pack-qr-next").disabled, true);
    // 끝에서 되돌아 감지도 않는다. 16장을 찍는 중에 1장으로 돌아가면 자리를 잃는다.
    await app.click("pack-qr-next");
    assert.equal(app.text("pack-qr-index"), "3 / 3");

    await app.click("pack-qr-prev");
    assert.equal(app.text("pack-qr-index"), "2 / 3");
  });

  it("장을 넘기면 그림 설명도 함께 바뀐다", async () => {
    const app = await boot({ pack: async () => ({ ...PACK_RESULT, ...qrPlan(3) }) });
    await packOnce(app, "pw123456");

    assert.match(app.attr("pack-qr-image", "alt"), /3장 중 1번째/);
    await app.click("pack-qr-next");
    assert.match(app.attr("pack-qr-image", "alt"), /3장 중 2번째/);
  });

  it("장을 넘겨도 안내 문구는 그대로 있다", async () => {
    const app = await boot({ pack: async () => ({ ...PACK_RESULT, ...qrPlan(3) }) });
    await packOnce(app, "pw123456");

    const before = app.text("pack-qr-note");
    await app.click("pack-qr-next");
    // 안내는 결과마다 한 번만 정한다. 넘길 때마다 다시 쓰면 읽는 도중에 문장이 바뀐다.
    assert.equal(app.text("pack-qr-note"), before);
  });

  it("정해진 장수를 넘으면 크기와 한도와 이유를 말해 준다", async () => {
    const app = await boot({
      pack: async () => ({
        ...PACK_RESULT,
        dest: "C:\\out\\big.txt",
        container_bytes: 2 * 1024 * 1024,
        qr_plan: null,
        qr_first: null,
        qr_omitted: true,
      }),
    });
    await packOnce(app, "pw123456");

    // 자리를 없애면 "어제는 보였는데" 하고 고장으로 읽힌다. 자리는 두고 이유를 말한다.
    assert.equal(app.visible("pack-qr"), true);
    assert.equal(app.hook("pack-qr").dataset.state, "toobig");
    assert.equal(app.visible("pack-qr-image"), false);
    // `src=""` 는 문서 URL 을 다시 요청한다. 속성 자체가 없어야 한다.
    assert.equal(app.attr("pack-qr-image", "src"), null);
    assert.equal(app.visible("pack-qr-nav"), false);

    const note = app.text("pack-qr-note");
    assert.match(note, /2\.0 MB/, `실제 크기를 말해 줘야 한다: ${note}`);
    // 반올림하면 "2.9 KB라서 2.9 KB 를 넘습니다" 가 되어 스스로 모순된다.
    assert.match(note, /2,953 B/);
    assert.match(note, /128장까지만/);
    assert.match(note, /현실적이지 않습니다/, "왜 안 되는지가 빠지면 게으름으로 보인다");
    // 묶기 자체는 성공했다. 경고로 뒤집지 않는다.
    assert.equal(app.hook("pack-status").dataset.kind, "ok");
  });

  it("조각 모드에 담기면 스트림을 제안하지 않는다", async () => {
    // 스트림은 기본 카메라로 찍어 붙여넣을 수 없다. 되는 쪽이 있으면 언제나 그쪽이 낫다.
    const app = await boot({ pack: async () => ({ ...PACK_RESULT, ...qrPlan(3) }) });
    await packOnce(app, "pw123456");
    assert.equal(app.visible("pack-qr-stream"), false);
  });

  it("조각 모드에 안 담기면 스트림을 제안한다", async () => {
    const app = await boot({
      pack: async () => ({
        ...PACK_RESULT,
        container_bytes: 400 * 1024,
        qr_plan: null,
        qr_first: null,
        qr_omitted: true,
      }),
    });
    await packOnce(app, "pw123456");

    assert.equal(app.visible("pack-qr-stream"), true);
    // 조각 모드가 왜 안 되는지는 여전히 말해 준다.
    assert.match(app.text("pack-qr-note"), /128장까지만/);
  });

  it("스트림은 프레임을 계속 흘려 보내고, 끝을 약속하지 않는다", async () => {
    const app = await boot({
      pack: async () => ({
        ...PACK_RESULT,
        container_bytes: 400 * 1024,
        qr_plan: null,
        qr_first: null,
        qr_omitted: true,
      }),
    });
    await packOnce(app, "pw123456");

    app.hook("pack-qr-speed").value = "300";
    await app.click("pack-qr-stream-start");

    assert.equal(app.hook("pack-qr").dataset.state, "stream");
    // 기본은 두 장이다. 한 화면에 두 프레임이 나란히 선다.
    assert.deepEqual(app.tiles(), [
      "data:image/png;base64,FRAME0",
      "data:image/png;base64,FRAME1",
    ]);
    assert.equal(app.visible("pack-qr-stream-frame"), true);
    assert.equal(app.visible("pack-qr-image"), false, "조각 모드의 그림판은 접혀 있어야 한다");
    // 조각 모드의 넘기기는 뜻이 없다 — 끝이 없으므로 '다음' 도 없다.
    assert.equal(app.visible("pack-qr-nav"), false);

    const note = app.text("pack-qr-note");
    assert.match(note, /317장/);
    // 기본 카메라로 안 된다는 사실을 감추지 않는다.
    assert.match(note, /기본 카메라로 찍어 붙여넣을 수 없습니다/);
    // 예상 시간은 넘김 속도와 타일 수의 곱이라 그 둘이 붙어 있는 자리에서 적는다. 45분이
    // 걸릴 일을 말없이 시작하지 않는다는 약속은 시작하자마자 그려지는 이 줄이 지킨다.
    assert.match(app.text("pack-qr-tiles-note"), /한 바퀴에 약 \d+분/);

    await app.wait(800);
    // 보낸 장수만 세면 진행을 볼 수 없다. "한 바퀴" 대비로 적는다 — 그 양(frames_needed)은
    // 폰도 같은 식으로 계산하므로 두 화면의 숫자가 같은 뜻을 갖는다.
    const index = app.text("pack-qr-index");
    assert.match(index, /^\d+ \/ 약 317 프레임$/, index);
    const sent = Number(index.split(" ")[0]);
    assert.ok(sent >= 2, `${sent}장만 보냈다`);
    assert.match(app.text("pack-qr-stream-note"), /한 바퀴의 \d+%/);
    assert.notEqual(app.tiles()[0], "data:image/png;base64,FRAME0");
  });

  it("한 화면에 1·2·4장을 세울 수 있다", async () => {
    const app = await boot({
      pack: async () => ({
        ...PACK_RESULT,
        container_bytes: 400 * 1024,
        qr_plan: null,
        qr_first: null,
        qr_omitted: true,
      }),
    });
    await packOnce(app, "pw123456");

    await app.pickTiles(1);
    await app.click("pack-qr-stream-start");
    assert.deepEqual(app.tiles(), ["data:image/png;base64,FRAME0"]);
    await app.click("pack-qr-stream-start");

    await app.pickTiles(4);
    await app.click("pack-qr-stream-start");
    const four = app.tiles();
    assert.equal(four.length, 4, `${four.length}장이 섰다`);
    // 프레임 번호가 겹치면 폰이 셋을 중복으로 버린다. 넷 다 서로 달라야 한다.
    assert.equal(new Set(four).size, 4, `번호가 겹쳤다: ${four.join(", ")}`);
    // 4장은 한 줄로 늘어놓지 않는다 — 같은 폭에서 2×2 가 더 크게 담긴다.
    assert.equal(app.hook("pack-qr-stream-grid").dataset.cols, "2");
  });

  it("타일을 늘려도 그림은 정수 배율로만 커진다", async () => {
    // 배율에 소수점이 붙으면 모듈 폭이 3px/4px 로 들쭉날쭉해져 초점이 맞아도 안 읽힌다.
    // 133모듈에서 한 장이면 4배(532px), 두 장이면 판을 넓혀도 3배(399px)가 한계다.
    const app = await boot({
      pack: async () => ({
        ...PACK_RESULT,
        container_bytes: 400 * 1024,
        qr_plan: null,
        qr_first: null,
        qr_omitted: true,
      }),
    });
    await packOnce(app, "pw123456");

    await app.pickTiles(1);
    await app.click("pack-qr-stream-start");
    assert.deepEqual(app.tileWidths(), ["532px"]);
    await app.click("pack-qr-stream-start");

    await app.pickTiles(2);
    await app.click("pack-qr-stream-start");
    assert.deepEqual(app.tileWidths(), ["399px", "399px"]);
    for (const width of app.tileWidths()) {
      assert.equal(Number(width.replace("px", "")) % 133, 0, `${width} 가 정수 배율이 아니다`);
    }
  });

  it("타일 수를 처리량으로 적어 준다 — 속도 조절과 같은 단위로", async () => {
    const app = await boot({
      pack: async () => ({
        ...PACK_RESULT,
        container_bytes: 400 * 1024,
        qr_plan: null,
        qr_first: null,
        qr_omitted: true,
      }),
    });
    await packOnce(app, "pw123456");
    app.hook("pack-qr-stream-speed").value = "500";

    await app.pickTiles(2);
    // 500ms 에 두 장이면 초당 4.0장이다.
    assert.match(app.text("pack-qr-tiles-note"), /초당 4\.0장/);
    // 넘김 횟수가 그대로라는 것이 이 조작의 요지다. 그 말을 적어 둔다.
    assert.match(app.text("pack-qr-tiles-note"), /넘김 횟수는 그대로/);

    await app.pickTiles(1);
    assert.match(app.text("pack-qr-tiles-note"), /초당 2\.0장/);
  });

  it("설정을 바꾸면 한 바퀴 시간도 같이 고쳐 준다", async () => {
    // 시작할 때 `pack-qr-note` 에 적어 둔 숫자는 설정을 바꾸는 순간 거짓이 된다. 두 조작이
    // 붙어 있는 자리에서 결과도 같이 보여야 어느 쪽을 만질지 정할 수 있다.
    const app = await boot({
      pack: async () => ({
        ...PACK_RESULT,
        container_bytes: 400 * 1024,
        qr_plan: null,
        qr_first: null,
        qr_omitted: true,
      }),
    });
    await packOnce(app, "pw123456");
    // 스트림이 열리기 전에는 잴 것이 없다. 없는 숫자를 지어내지 않는다.
    assert.doesNotMatch(app.text("pack-qr-tiles-note"), /한 바퀴에 약/);

    app.hook("pack-qr-stream-speed").value = "1000";
    await app.pickTiles(1);
    await app.click("pack-qr-stream-start");
    // 317프레임 × 1000ms ÷ 1장 = 317초 ≈ 5분.
    assert.match(app.text("pack-qr-tiles-note"), /한 바퀴에 약 5분/);

    await app.pickTiles(4);
    // 같은 속도에 네 장이면 4분의 1이다.
    assert.match(app.text("pack-qr-tiles-note"), /한 바퀴에 약 1분/);
  });

  it("폰이 못 따라오는 설정이면 그렇게 말해 준다", async () => {
    // 초당 12장 언저리가 ML Kit 의 천장이다. 그 위로는 보낸 프레임이 그냥 지나가므로,
    // 더 늘리는 것이 이득이 0 이 아니라 마이너스가 된다.
    const app = await boot({
      pack: async () => ({
        ...PACK_RESULT,
        container_bytes: 400 * 1024,
        qr_plan: null,
        qr_first: null,
        qr_omitted: true,
      }),
    });
    await packOnce(app, "pw123456");

    app.hook("pack-qr-stream-speed").value = "300";
    await app.pickTiles(2);
    assert.doesNotMatch(app.text("pack-qr-tiles-note"), /천장을 넘어서/);

    // 300ms 에 네 장이면 초당 13.3장 — 천장 위다.
    await app.pickTiles(4);
    assert.match(app.text("pack-qr-tiles-note"), /천장을 넘어서/);
    assert.match(app.text("pack-qr-tiles-note"), /초당 n장/);
  });

  it("흘려 보내는 중에 타일 수를 바꾸면 다음 화면부터 먹는다", async () => {
    const app = await boot({
      pack: async () => ({
        ...PACK_RESULT,
        container_bytes: 400 * 1024,
        qr_plan: null,
        qr_first: null,
        qr_omitted: true,
      }),
    });
    await packOnce(app, "pw123456");

    app.hook("pack-qr-stream-speed").value = "300";
    await app.pickTiles(2);
    await app.click("pack-qr-stream-start");
    assert.equal(app.tiles().length, 2);

    await app.pickTiles(4);
    await app.wait(700);
    assert.equal(app.tiles().length, 4, "바꾼 수가 다음 화면부터 서야 한다");
    assert.equal(new Set(app.tiles()).size, 4);
  });

  it("타일 수만큼 한 번에 세므로 진행도 그만큼 빨리 찬다", async () => {
    const app = await boot({
      pack: async () => ({
        ...PACK_RESULT,
        container_bytes: 400 * 1024,
        qr_plan: null,
        qr_first: null,
        qr_omitted: true,
      }),
    });
    await packOnce(app, "pw123456");

    app.hook("pack-qr-stream-speed").value = "300";
    await app.pickTiles(4);
    await app.click("pack-qr-stream-start");
    await app.wait(700);

    const index = app.text("pack-qr-index");
    const sent = Number(index.split(" ")[0]);
    // 세 화면이면 12장이다. 타이머 오차를 감안해 두 화면(8장)만 요구한다.
    assert.ok(sent >= 8, `${sent}장만 보냈다 — 화면마다 4장이 나가야 한다`);
    assert.equal(sent % 4, 0, `${sent}장 — 화면 단위로 떨어져야 한다`);
  });

  it("스트림을 멈추면 컨테이너를 붙잡고 있지 않는다", async () => {
    const app = await boot({
      pack: async () => ({
        ...PACK_RESULT,
        container_bytes: 400 * 1024,
        qr_plan: null,
        qr_first: null,
        qr_omitted: true,
      }),
    });
    await packOnce(app, "pw123456");

    await app.click("pack-qr-stream-start");
    assert.equal(app.text("pack-qr-stream-start"), "그만 보내기");

    await app.click("pack-qr-stream-start");
    assert.ok(app.called("qr_stream_close"), "붙잡고 있던 바이트를 놓아야 한다");
    assert.equal(app.text("pack-qr-stream-start"), "스트림으로 보내기");
    assert.equal(app.visible("pack-qr-image"), false);
    assert.equal(app.visible("pack-qr-stream-frame"), false);
    // 판에 남은 그림은 이미 지나간 프레임이다. 다음에 켤 때 한 박자 서 있으면 안 된다.
    assert.deepEqual(app.tiles(), []);
  });

  it("빠르게 보내기를 켜야 300ms 아래가 열린다", async () => {
    const app = await boot({
      pack: async () => ({
        ...PACK_RESULT,
        container_bytes: 400 * 1024,
        qr_plan: null,
        qr_first: null,
        qr_omitted: true,
      }),
    });
    await packOnce(app, "pw123456");

    const speed = app.hook("pack-qr-stream-speed");
    // 기본 하한은 초당 3회 아래에 있다 (WCAG 2.3.1).
    assert.equal(speed.min, "300");
    assert.equal(app.text("pack-qr-stream-fast-note"), "");

    await app.check("pack-qr-stream-fast", true);
    assert.equal(speed.min, "150");
    // 켜도 저절로 빨라지지 않는다 — 열어 줄 뿐이다.
    assert.equal(speed.value, "350");
    // 무엇을 열었는지, 무엇이 위험한지, 왜 빨라지지 않을 수 있는지를 다 적는다.
    const note = app.text("pack-qr-stream-fast-note");
    assert.match(note, /150ms 까지 열었습니다/);
    assert.match(note, /빛에 민감한/);
    assert.match(note, /초당 n장/);

    speed.value = "150";
    speed.dispatchEvent(new app.window.Event("input", { bubbles: true }));
    assert.equal(app.text("pack-qr-stream-speed-label"), "150ms");

    // 끄면 열어 뒀던 구간에서 데리고 나온다. 안 그러면 토글이 거짓말이 된다.
    await app.check("pack-qr-stream-fast", false);
    assert.equal(speed.min, "300");
    assert.equal(speed.value, "300");
    assert.equal(app.text("pack-qr-stream-speed-label"), "300ms");
    assert.equal(app.text("pack-qr-stream-fast-note"), "");
  });

  it("껐다 켜면 프레임 번호를 이어 간다", async () => {
    // 폰은 번호로 중복을 가린다. 0번부터 다시 보내면 이미 모아 둔 것이 전부 중복으로 버려지고,
    // 폰의 계기는 그 상태를 "PC 가 멈췄다" 고 거꾸로 읽는다.
    const asked = [];
    const app = await boot({
      pack: async () => ({
        ...PACK_RESULT,
        container_bytes: 400 * 1024,
        qr_plan: null,
        qr_first: null,
        qr_omitted: true,
      }),
      qr_stream_frame: async ({ seq }) => {
        asked.push(seq);
        return { png_base64: `FRAME${seq}`, png_modules: 133 };
      },
    });
    await packOnce(app, "pw123456");

    await app.click("pack-qr-stream-start");
    await app.wait(800);
    const sent = Number(app.text("pack-qr-index").split(" ")[0]);
    assert.ok(sent >= 2, `${sent}장만 보냈다`);

    await app.click("pack-qr-stream-start");
    const restarted = asked.length;
    await app.click("pack-qr-stream-start");

    const after = asked.slice(restarted);
    assert.ok(after.length > 0, "다시 켰는데 프레임을 만들지 않았다");
    assert.ok(Math.min(...after) >= sent, `${Math.min(...after)}번으로 되돌아갔다 (${sent}장 보낸 뒤)`);
    // 보낸 장수도 이어 간다 — 폰이 모아 둔 것을 살렸으므로 0% 로 되돌리면 거짓이 된다.
    assert.ok(Number(app.text("pack-qr-index").split(" ")[0]) >= sent);
    // 이어 간다는 사실은 프레임마다 바뀌는 줄이 아니라 결과 안내에 적힌다 (곧 덮이지 않게).
    assert.match(app.text("pack-qr-note"), /이어서 보냅니다/);
  });

  it("스트림은 그리는 자리에서 프레임을 기다리지 않는다", async () => {
    // 만드는 시간이 체류 시간에 얹히면 슬라이더에 적힌 간격이 실제 간격이 아니게 된다.
    // 그 오차는 빠른 구간에서 특히 크다 — 150ms 에 40ms 가 붙으면 27% 가 어긋난다.
    const app = await boot({
      pack: async () => ({
        ...PACK_RESULT,
        container_bytes: 400 * 1024,
        qr_plan: null,
        qr_first: null,
        qr_omitted: true,
      }),
      qr_stream_frame: async ({ seq }) => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { png_base64: `FRAME${seq}`, png_modules: 133 };
      },
    });
    await packOnce(app, "pw123456");

    await app.check("pack-qr-stream-fast", true);
    const speed = app.hook("pack-qr-stream-speed");
    speed.value = "150";
    speed.dispatchEvent(new app.window.Event("input", { bubbles: true }));

    await app.click("pack-qr-stream-start");
    await app.wait(900);

    // 150ms 라면 900ms 에 6장 언저리다. 만드는 40ms 가 매번 얹혔다면 190ms 라 4장에 그친다.
    const sent = Number(app.text("pack-qr-index").split(" ")[0]);
    assert.ok(sent >= 5, `150ms 로 900ms 를 돌았는데 ${sent}장만 보냈다`);
  });

  it("한도를 알려 주지 않은 응답에도 0 B 같은 숫자를 지어내지 않는다", async () => {
    const app = await boot({
      pack: async () => ({
        ...PACK_RESULT,
        container_bytes: 2 * 1024 * 1024,
        qr_plan: null,
        qr_first: null,
        qr_limit_bytes: undefined,
        qr_limit_pieces: undefined,
      }),
    });
    await packOnce(app, "pw123456");

    const note = app.text("pack-qr-note");
    assert.match(note, /2\.0 MB/);
    assert.doesNotMatch(note, /0 B|0장/, `모르는 한도를 지어내면 안 된다: ${note}`);
  });

  it("다시 묶기 전에는 지난 QR 이 남지 않는다", async () => {
    const app = await boot({ pack: async () => ({ ...PACK_RESULT, ...qrPlan(3) }) });
    await packOnce(app, "pw123456");
    await app.click("pack-qr-next");
    assert.equal(app.visible("pack-qr"), true);

    await app.click("pack-clear");

    // 지난 그림이 남으면 *이전* 컨테이너를 새 결과인 줄 알고 찍어 보낸다.
    assert.equal(app.visible("pack-qr"), false);
    assert.equal(app.attr("pack-qr-image", "src"), null);
    assert.equal(app.text("pack-qr-index"), "");
    assert.equal(app.hook("pack-qr-next").disabled, true);
  });

  it("작업 중에는 QR 넘기기도 잠긴다", async () => {
    // QR 이 떠 있는 상태를 유지한 채 다른 작업을 붙잡아 둔다 — 묶기를 다시 걸면 QR 이 먼저
    // 치워지므로, 풀기를 끝나지 않는 상태로 세워 두고 확인한다.
    const app = await boot({
      pack: async () => ({ ...PACK_RESULT, ...qrPlan(3) }),
      unpack_text: () => new Promise(() => {}),
    });
    await packOnce(app, "pw123456");
    assert.equal(app.hook("pack-qr-next").disabled, false);

    await app.click("pack-qr-next");
    // 훅은 패널이 감춰져 있어도 문서 전체에서 찾는다. 다른 풀기 테스트와 같은 방식이다.
    await app.paste("unpack-text", ARMOR_TEXT);
    await app.click("unpack-dest-pick");
    await app.click("unpack-submit");

    assert.equal(app.window.document.body.dataset.busy, "true");
    assert.equal(app.hook("pack-qr-next").disabled, true);
    assert.equal(app.hook("pack-qr-prev").disabled, true);
  });
});

describe("키 이어짐 — 요청의 핵심", () => {
  it("묶기가 성공하면 같은 키가 풀기 탭에 채워진다", async () => {
    const app = await boot();
    assert.equal(app.value("unpack-key"), "", "처음에는 비어 있어야 한다");

    await packOnce(app, "열려라 참깨 2026!");

    assert.equal(app.value("unpack-key"), "열려라 참깨 2026!");
    assert.equal(app.visible("unpack-key-hint"), true);
  });

  it("묶기가 실패하면 키를 이어 주지 않는다", async () => {
    const app = await boot({
      pack: async () => {
        throw { code: "Io", message: "쓸 수 없습니다" };
      },
    });
    await packOnce(app, "틀린-키");
    assert.equal(app.value("unpack-key"), "", "실패한 키는 흘려보내지 않는다");
  });

  it("키를 localStorage 에 저장하지 않는다", async () => {
    const app = await boot();
    await packOnce(app, "비밀-키-1234");

    // 경로는 기억해도 되지만 키는 절대 남아선 안 된다. '기억' 버튼을 뺀 이유가 이것이다.
    const dump = JSON.stringify({ ...app.window.localStorage });
    assert.equal(dump.includes("비밀-키-1234"), false, `localStorage 에 키가 남았다: ${dump}`);
  });
});

describe("풀기 — 파일에서", () => {
  async function withFile(overrides) {
    const app = await boot(overrides);
    await app.click("unpack-pick");
    return app;
  }

  it("고른 파일의 정보를 키 없이 보여 준다", async () => {
    const app = await withFile();
    assert.equal(app.visible("unpack-file"), true);
    assert.equal(app.text("unpack-file-name"), "bundle.txt");
    assert.match(app.text("unpack-file-meta"), /텍스트/);
    assert.match(app.text("unpack-file-meta"), /AES-256-GCM/);
    assert.match(app.text("unpack-file-meta"), /포맷 v1/);
    assert.match(app.text("unpack-source-note"), /파일을 풉니다/);
  });

  it("대상과 키가 모두 있어야 풀기 버튼이 열린다", async () => {
    const app = await boot();
    assert.equal(app.hook("unpack-submit").disabled, true);
    await app.click("unpack-pick");
    assert.equal(app.hook("unpack-submit").disabled, true, "키가 없으면 잠겨 있어야 한다");
    await app.type("unpack-key", "pw123456");
    assert.equal(app.hook("unpack-submit").disabled, false);
  });

  it("우리 파일이 아니면 그렇게 말해 준다", async () => {
    const app = await withFile({
      inspect: async () => {
        throw { code: "NotContainer", message: "이 파일은 이 프로그램으로 묶은 파일이 아닙니다." };
      },
    });
    assert.equal(app.visible("unpack-file"), false);
    assert.equal(app.hook("unpack-status").dataset.kind, "error");
    assert.match(app.text("unpack-status"), /묶은 파일이 아닙니다/);
    assert.equal(app.hook("unpack-submit").disabled, true);
  });

  it("이전 형식(바이너리)도 그렇게 표시하고 풀어 준다", async () => {
    const app = await withFile({
      inspect: async ({ path: p }) => ({
        source: "file",
        path: p,
        name: "legacy.fsx",
        byte_size: 4096,
        armored: false,
        format_version: 1,
        kdf: "Argon2id",
        cipher: "AES-256-GCM",
        compression: "zstd",
        chunk_size: 1048576,
      }),
    });
    assert.match(app.text("unpack-file-meta"), /이전 형식\(바이너리\)/);
    await app.type("unpack-key", "pw123456");
    assert.equal(app.hook("unpack-submit").disabled, false);
  });

  it("고른 폴더를 그대로 unpack 에 넘긴다", async () => {
    const app = await withFile();
    await app.type("unpack-key", "pw123456");
    await app.click("unpack-dest-pick");
    await app.click("unpack-submit");

    const args = app.argsOf("unpack");
    assert.ok(args, "unpack 이 호출되지 않았다");
    assert.equal(args.container, "C:\\out\\bundle.txt");
    assert.equal(args.passphrase, "pw123456");
    assert.equal(args.dest, "C:\\out\\restored");
  });

  it("위치를 비워 둔 채 누르면 폴더 선택을 먼저 띄운다", async () => {
    const app = await withFile();
    await app.type("unpack-key", "pw123456");
    await app.click("unpack-submit");

    assert.ok(app.called("pick_dest_dir"), "폴더 선택을 띄우지 않았다");
    assert.ok(app.called("unpack"));
  });

  it("키가 틀리면 그렇게 말해 준다", async () => {
    const app = await withFile({
      unpack: async () => {
        throw { code: "WrongKey", message: "암호화 키가 올바르지 않습니다." };
      },
    });
    await app.type("unpack-key", "틀린키123");
    await app.click("unpack-dest-pick");
    await app.click("unpack-submit");

    assert.equal(app.hook("unpack-status").dataset.kind, "error");
    assert.match(app.text("unpack-status"), /키가 올바르지 않습니다/);
  });

  it("건너뛴 경로와 이름 충돌을 보고한다", async () => {
    const app = await withFile({
      unpack: async () => ({
        dest: "C:\\out\\restored",
        file_count: 3,
        dir_count: 1,
        total_bytes: 9000,
        skipped: ["../evil.txt (상대 경로 이동)"],
        hash_mismatch: [],
        renamed: ["proj → proj (2)"],
      }),
    });
    await app.type("unpack-key", "pw123456");
    await app.click("unpack-dest-pick");
    await app.click("unpack-submit");

    assert.equal(app.hook("unpack-status").dataset.kind, "warn");
    assert.match(app.text("unpack-status"), /건너뛴 항목 1개/);
    assert.match(app.text("unpack-status"), /proj \(2\)/);
  });
});

describe("풀기 — 붙여넣은 텍스트에서", () => {
  it("붙여넣으면 키 없이 내용을 확인해 준다", async () => {
    const app = await boot();
    await app.paste("unpack-text", ARMOR_TEXT);

    assert.ok(app.called("inspect_text"), "텍스트 확인 요청이 나가지 않았다");
    assert.equal(app.visible("unpack-file"), true);
    assert.equal(app.text("unpack-file-name"), "붙여넣은 텍스트");
    assert.match(app.text("unpack-source-note"), /붙여넣은 텍스트를 풉니다/);
  });

  it("붙여넣은 텍스트를 unpack_text 로 넘긴다", async () => {
    const app = await boot();
    await app.paste("unpack-text", ARMOR_TEXT);
    await app.type("unpack-key", "pw123456");
    await app.click("unpack-dest-pick");
    await app.click("unpack-submit");

    const args = app.argsOf("unpack_text");
    assert.ok(args, "unpack_text 가 호출되지 않았다");
    assert.equal(lf(args.text), lf(ARMOR_TEXT));
    assert.equal(args.passphrase, "pw123456");
    assert.equal(args.dest, "C:\\out\\restored");
    // 파일 경로로 부르는 명령은 쓰이지 않아야 한다.
    assert.equal(app.called("unpack"), false);
  });

  it("우리 텍스트가 아니면 그렇게 말해 준다", async () => {
    const app = await boot();
    await app.paste("unpack-text", "그냥 평범한 메모입니다.");

    assert.equal(app.hook("unpack-status").dataset.kind, "error");
    assert.match(app.text("unpack-status"), /묶은 파일이 아닙니다/);
    assert.equal(app.hook("unpack-submit").disabled, true);
  });

  it("비우면 대상이 사라진다", async () => {
    const app = await boot();
    await app.paste("unpack-text", ARMOR_TEXT);
    assert.equal(app.visible("unpack-file"), true);

    await app.click("unpack-text-clear");
    assert.equal(app.value("unpack-text"), "");
    assert.equal(app.visible("unpack-file"), false);
    assert.equal(app.hook("unpack-submit").disabled, true);
  });

  it("파일을 고르면 붙여넣은 텍스트를 비운다", async () => {
    const app = await boot();
    await app.paste("unpack-text", ARMOR_TEXT);
    await app.click("unpack-pick");

    // 두 입구 중 무엇을 쓸지 헷갈리지 않게 하나만 살아 있어야 한다.
    assert.equal(app.value("unpack-text"), "");
    assert.equal(app.text("unpack-file-name"), "bundle.txt");
    assert.match(app.text("unpack-source-note"), /파일을 풉니다/);
  });

  it("텍스트가 잘렸으면 복사가 덜 됐다고 알려 준다", async () => {
    const app = await boot({
      inspect_text: async () => {
        throw {
          code: "ArmorDamaged",
          message: "텍스트가 온전하지 않습니다. 시작·끝 표시 줄까지 빠짐없이 복사했는지 확인해 주세요.",
        };
      },
    });
    await app.paste("unpack-text", ARMOR_TEXT.slice(0, 100));

    assert.equal(app.hook("unpack-status").dataset.kind, "error");
    assert.match(app.text("unpack-status"), /빠짐없이 복사했는지/);
  });
});

describe("진행률", () => {
  it("총량을 알면 퍼센트로, 모르면 불확정으로 표시한다", async () => {
    const app = await boot();

    await app.emit("pack-progress", {
      phase: "packing",
      done_bytes: 0,
      total_bytes: 0,
      current_path: "",
    });
    assert.equal(app.visible("pack-progress"), true);
    assert.equal(app.hook("pack-progress-fill").dataset.indeterminate, "true");
    assert.match(app.text("pack-progress-label"), /묶는 중…/);

    await app.emit("pack-progress", {
      phase: "packing",
      done_bytes: 512,
      total_bytes: 2048,
      current_path: "proj/a.txt",
    });
    assert.equal(app.hook("pack-progress-fill").dataset.indeterminate, "false");
    assert.equal(app.hook("pack-progress-fill").style.width, "25%");
    assert.match(app.text("pack-progress-label"), /25%/);
    assert.match(app.text("pack-progress-label"), /proj\/a\.txt/);
    assert.equal(app.hook("pack-progress").getAttribute("aria-valuenow"), "25");
  });

  it("풀기 진행률은 풀기 쪽 막대만 움직인다", async () => {
    const app = await boot();
    await app.emit("unpack-progress", {
      phase: "unpacking",
      done_bytes: 1000,
      total_bytes: 4000,
      current_path: "x",
    });
    assert.equal(app.hook("unpack-progress-fill").style.width, "25%");
    assert.equal(app.visible("pack-progress"), false);
    assert.match(app.text("unpack-progress-label"), /푸는 중/);
  });
});
