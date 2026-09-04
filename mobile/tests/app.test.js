// `app.js` 의 배선을 카메라 없이 검증한다.
//
//   npm install && npm test
//
// `index.html` 을 jsdom 에 올리고 `window.Capacitor` 를 가짜 브리지로 바꿔치기한 뒤 `app.js` 를
// 그대로 실행한다 (데스크톱 `tests/frontend.test.js` 가 `window.__TAURI__` 를 바꿔치기하는 것과
// 같은 방식이다). 덕분에 자동 시작, 해상도 설정, 칩 목록, 중복 무시, 완료 전환, 파일 저장까지
// 기기 없이 확인된다.
//
// jsdom 이 없으면 이 파일은 건너뛴다 — `collector.test.js` 는 의존성이 없어서 설치 없이도
// 돌아야 하고, 그 성질을 지키려고 여기만 선택적으로 둔다.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

let JSDOM = null;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  // 아래 describe 가 건너뛴다.
}

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BEGIN = "-----BEGIN PACKER CONTAINER-----";
const END = "-----END PACKER CONTAINER-----";

/** `armor::pieces()` 와 같은 조각 나누기 (collector.test.js 와 같은 계산). */
function makePieces(body, parts) {
  const wanted = Math.ceil(body.length / Math.max(parts, 1));
  const per = Math.max(4, wanted % 4 === 0 ? wanted : wanted + (4 - (wanted % 4)));
  const slices = [];
  for (let at = 0; at < body.length; at += per) slices.push(body.slice(at, at + per));
  const total = slices.length;
  return slices.map((slice, at) => {
    let out = "";
    if (at === 0) out += `${BEGIN}\n`;
    out += `#${at + 1}/${total}\n${slice}\n`;
    if (at + 1 === total) out += `${END}\n`;
    return out;
  });
}

/** 40자, 3장으로 16/16/8 로 갈라진다. */
const BODY = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn";

/** `app.js` 는 모듈 캐시를 타므로 테스트마다 다른 주소로 불러 새 인스턴스를 만든다. */
let instance = 0;

/**
 * jsdom 창과 가짜 네이티브 브리지를 세우고 `app.js` 를 실행한다.
 *
 * @param {{permission?: string, torch?: boolean}} options
 */
async function boot(options = {}) {
  const html = fs.readFileSync(path.join(root, "www", "index.html"), "utf8");
  const dom = new JSDOM(html, { url: "https://localhost/" });

  globalThis.window = dom.window;
  globalThis.document = dom.window.document;

  const log = [];
  const written = [];
  const listeners = {};

  globalThis.Capacitor = {
    Plugins: {
      BarcodeScanner: {
        isSupported: async () => ({ supported: true }),
        checkPermissions: async () => ({ camera: options.permission ?? "granted" }),
        requestPermissions: async () => ({ camera: options.permission ?? "granted" }),
        startScan: async (given) => log.push(["startScan", given]),
        stopScan: async () => log.push(["stopScan"]),
        isTorchAvailable: async () => ({ available: options.torch !== false }),
        enableTorch: async () => log.push(["enableTorch"]),
        disableTorch: async () => log.push(["disableTorch"]),
        openSettings: async () => log.push(["openSettings"]),
        addListener: async (name, handler) => {
          listeners[name] = handler;
          return { remove: async () => delete listeners[name] };
        },
      },
      Filesystem: {
        writeFile: async (given) => {
          written.push(given);
          return { uri: `file:///Documents/${given.path}` };
        },
      },
      Haptics: { impact: async () => log.push(["buzz"]), notification: async () => log.push(["buzz"]) },
      KeepAwake: { keepAwake: async () => {}, allowSleep: async () => {} },
    },
  };

  instance += 1;
  await import(`${path.join(root, "www", "app.js")}?boot=${instance}`);

  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  await settle();

  return {
    dom,
    log,
    written,
    el: (hook) => dom.window.document.querySelector(`[data-pk="${hook}"]`),
    state: () => dom.window.document.querySelector('[data-pk="app"]').dataset.state,
    /** QR 한 장을 인식한 것처럼 먹인다. */
    scan: async (text) => {
      listeners.barcodesScanned?.({ barcodes: [{ rawValue: text }] });
      await settle();
    },
    /** `rawValue` 가 빈 기기를 흉내 낸다 — `bytes` 로 떨어져야 한다. */
    scanBytes: async (text) => {
      const bytes = [...text].map((ch) => ch.charCodeAt(0));
      listeners.barcodesScanned?.({ barcodes: [{ bytes }] });
      await settle();
    },
    click: async (hook) => {
      dom.window.document.querySelector(`[data-pk="${hook}"]`)?.click();
      await settle();
    },
  };
}

describe("앱 배선", { skip: JSDOM ? false : "jsdom 이 없습니다 — npm install 후 다시" }, () => {
  before(() => {
    assert.ok(JSDOM, "jsdom");
  });

  it("권한이 이미 있으면 스스로 스캔을 시작한다", async () => {
    const app = await boot();
    assert.equal(app.state(), "scanning");
    assert.ok(app.log.some(([name]) => name === "startScan"));
  });

  it("1080p 로 QR 만 찾는다", async () => {
    const app = await boot();
    const [, options] = app.log.find(([name]) => name === "startScan");

    // 이 세 줄이 인식률을 쥐고 있다. 플러그인 기본값은 720p(=1) 인데 버전 40 심볼에는 부족하다.
    assert.equal(options.resolution, 2, "1920x1080 의 와이어 값");
    assert.deepEqual(options.formats, ["QR_CODE"]);
    assert.equal(options.lensFacing, "BACK");
  });

  it("권한이 없으면 물어보기 전에 설명을 먼저 보여 준다", async () => {
    const app = await boot({ permission: "denied" });
    assert.equal(app.state(), "idle");
    assert.equal(app.el("scan-torch").hidden, true);

    await app.click("scan-start");
    assert.equal(app.state(), "denied");
    assert.equal(app.el("perm-settings").hidden, false);
  });

  it("첫 조각에서 전체 장수와 칩 목록이 생긴다", async () => {
    const app = await boot();
    const pieces = makePieces(BODY, 3);

    await app.scan(pieces[1]);
    assert.equal(app.el("scan-progress").textContent, "1 / 3");
    assert.equal(app.el("scan-list").children.length, 3);
    assert.equal(app.el("scan-list").children[1].dataset.got, "true");
    assert.equal(app.el("scan-list").children[0].dataset.got, "false");
    assert.match(app.el("scan-total").textContent, /남은 순번 1, 3/);
  });

  it("같은 장을 계속 비춰도 화면이 흔들리지 않는다", async () => {
    const app = await boot();
    const pieces = makePieces(BODY, 3);

    await app.scan(pieces[0]);
    const status = app.el("scan-status").textContent;

    for (let at = 0; at < 10; at += 1) await app.scan(pieces[0]);

    assert.equal(app.el("scan-progress").textContent, "1 / 3");
    assert.equal(app.el("scan-status").textContent, status, "중복은 문구도 바꾸지 않는다");
  });

  it("낯선 QR 은 알려 주기만 하고 모아 둔 것을 건드리지 않는다", async () => {
    const app = await boot();
    const pieces = makePieces(BODY, 3);

    await app.scan(pieces[0]);
    await app.scan("https://example.com");

    assert.equal(app.el("scan-status").textContent, "Packer 가 만든 QR 이 아닙니다.");
    assert.equal(app.el("scan-progress").textContent, "1 / 3");
    assert.equal(app.state(), "scanning");
  });

  it("다른 묶음이 섞이면 짚어 준다", async () => {
    const app = await boot();
    await app.scan(makePieces(BODY, 3)[0]); // per = 16
    await app.scan(makePieces("A".repeat(120), 3)[1]); // per = 40

    assert.match(app.el("scan-status").textContent, /다른 묶음/);
    assert.equal(app.el("scan-progress").textContent, "1 / 3");
  });

  it("rawValue 가 비는 기기에서도 bytes 로 읽는다", async () => {
    const app = await boot();
    await app.scanBytes(makePieces(BODY, 3)[0]);
    assert.equal(app.el("scan-progress").textContent, "1 / 3");
  });

  it("뒤섞인 순서로 다 모으면 카메라를 끄고 결과로 넘어간다", async () => {
    const app = await boot();
    const [first, second, third] = makePieces(BODY, 3);

    await app.scan(third);
    await app.scan(first);
    assert.equal(app.state(), "scanning");

    await app.scan(second);
    assert.equal(app.state(), "complete");
    assert.ok(app.log.some(([name]) => name === "stopScan"), "카메라를 놓아야 한다");
    assert.match(app.el("result-summary").textContent, /^3장을 모두 읽어 105자/);
  });

  it("저장하면 wrap_single_line 과 같은 텍스트가 나간다", async () => {
    const app = await boot();
    for (const piece of makePieces(BODY, 3)) await app.scan(piece);

    await app.click("scan-save");

    assert.equal(app.written.length, 1);
    const [file] = app.written;
    assert.match(file.path, /^packer-\d{8}-\d{6}\.txt$/);
    assert.equal(file.directory, "DOCUMENTS");
    assert.equal(file.encoding, "utf8");
    // 순서 표시를 떼고 합친 결과가 `armor::wrap_single_line()` 과 바이트 단위로 같아야 한다.
    assert.equal(file.data, `${BEGIN}\n${BODY}\n${END}\n`);
    assert.ok(!file.data.includes("#"));
    // 어디에 저장됐는지 반드시 알려 준다.
    assert.match(app.el("result-note").textContent, /^저장했습니다 — file:\/\/\/Documents\/packer-/);
  });

  it("다시 모으기를 누르면 처음 상태로 돌아가 스캔을 재개한다", async () => {
    const app = await boot();
    for (const piece of makePieces(BODY, 3)) await app.scan(piece);
    assert.equal(app.state(), "complete");

    await app.click("scan-reset");

    assert.equal(app.state(), "scanning");
    assert.equal(app.el("scan-progress").textContent, "0 / ?");
    assert.equal(app.el("scan-list").children.length, 0);
  });

  it("손전등은 기본이 꺼짐이고 토글로 켠다", async () => {
    const app = await boot();
    // 모니터를 비추면 반사가 심해지므로 자동으로 켜지 않는다.
    assert.ok(!app.log.some(([name]) => name === "enableTorch"));
    assert.equal(app.el("scan-torch").hidden, false);

    await app.click("scan-torch");
    assert.ok(app.log.some(([name]) => name === "enableTorch"));
    assert.equal(app.el("scan-torch").textContent, "손전등 끄기");
  });

  it("손전등을 못 쓰는 기기에서는 버튼을 감춘다", async () => {
    const app = await boot({ torch: false });
    assert.equal(app.el("scan-torch").hidden, true);
  });
});
