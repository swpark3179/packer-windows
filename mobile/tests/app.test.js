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
import { Buffer } from "node:buffer";
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

// Rust 인코더가 만든 골든 픽스처. 스트림 모드는 이걸 그대로 먹여 검증한다.
const streamGolden = JSON.parse(
  fs.readFileSync(path.join(root, "tests", "fixtures", "stream-frames.json"), "utf8"),
);
const unhex = (text) =>
  Uint8Array.from({ length: text.length / 2 }, (_, i) =>
    Number.parseInt(text.slice(i * 2, i * 2 + 2), 16),
  );
const STREAM_SOURCE = unhex(streamGolden.source);
const STREAM_FRAMES = streamGolden.frames.map(unhex);

// 타이밍을 여기에 다시 적지 않는다. `export.js` 가 바뀌면 테스트가 함께 움직여야 한다.
const { BUSY_DELAY_MS, BUSY_HOLD_MS } = await import("../www/export.js");
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
  const appended = [];
  const shared = [];
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
          if ((options.failWrite ?? []).includes(given.directory)) {
            throw new Error(`denied: ${given.directory}`);
          }
          if (options.slowWriteMs) await new Promise((r) => setTimeout(r, options.slowWriteMs));
          written.push(given);
          return { uri: `file:///${given.directory}/${given.path}` };
        },
        appendFile: async (given) => appended.push(given),
        deleteFile: async (given) => log.push(["deleteFile", given]),
      },
      Share: {
        canShare: async () => ({ value: options.share !== false }),
        share: async (given) => {
          if (options.shareError) throw new Error(options.shareError);
          shared.push(given);
          return { activityType: options.activityType ?? "" };
        },
      },
      Haptics: { impact: async () => log.push(["buzz"]), notification: async () => log.push(["buzz"]) },
      KeepAwake: { keepAwake: async () => {}, allowSleep: async () => {} },
    },
    getPlatform: () => options.platform ?? "android",
  };

  instance += 1;
  await import(`${path.join(root, "www", "app.js")}?boot=${instance}`);

  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  await settle();

  return {
    dom,
    log,
    written,
    appended,
    shared,
    settle,
    /** 시간이 흐르게 둔다 — 진행 막대의 지연 표시를 확인할 때 쓴다. */
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    /** 저장·보내기 버튼을 누르되 **끝날 때까지 기다리지 않는다.** */
    press: (hook) => {
      dom.window.document.querySelector(`[data-pk="${hook}"]`)?.click();
    },
    el: (hook) => dom.window.document.querySelector(`[data-pk="${hook}"]`),
    state: () => dom.window.document.querySelector('[data-pk="app"]').dataset.state,
    /** QR 한 장을 인식한 것처럼 먹인다. */
    scan: async (text) => {
      listeners.barcodesScanned?.({ barcodes: [{ rawValue: text }] });
      await settle();
    },
    /** 스트림 프레임 한 장. 바이너리라 `bytes` 로만 온다. */
    scanFrame: async (frame) => {
      listeners.barcodesScanned?.({ barcodes: [{ bytes: Array.from(frame) }] });
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
    assert.match(app.el("scan-total").textContent, /남은 순번 1, 3 \(2장\)/);
  });

  it("조각이 많으면 칩 대신 막대로 바꾼다", async () => {
    // 128장을 폰 화면에 늘어놓으면 카메라를 덮는다. 칩을 **더하는** 게 아니라 **바꾼다** —
    // 어느 장이 빠졌는지는 scan-total 이 계속 말해 준다.
    const app = await boot();
    const body = "ABCD".repeat(40); // 160자 → 40조각
    const pieces = makePieces(body, 40);
    assert.ok(pieces.length > 24, `${pieces.length}장`);

    await app.scan(pieces[0]);

    assert.equal(app.el("scan-list").hidden, true);
    assert.equal(app.el("scan-bar").hidden, false);
    assert.equal(app.el("scan-bar").getAttribute("aria-valuenow"), "3");
    // 많이 남아도 **옮겨 칠 수 있는 글자**로 말한다. 이어진 번호는 범위로 접는다.
    assert.match(app.el("scan-total").textContent, /남은 순번 2~40 \(39장\)/);

    await app.scan(pieces[1]);
    assert.equal(app.el("scan-bar").getAttribute("aria-valuenow"), "5");
  });

  it("스트림 프레임을 알아보고 끝까지 복원해 저장한다", async () => {
    // 사용자에게 모드를 묻지 않는다 — 첫 심볼의 매직이 말해 준다. 프레임은 Rust 인코더가
    // 만든 골든 픽스처를 그대로 쓴다 (tests/fixtures/stream-frames.json).
    const app = await boot();
    for (const frame of STREAM_FRAMES) {
      await app.scanFrame(frame);
      if (app.state() === "complete") break;
    }
    // 화면은 복원되는 즉시 넘어가고, 텍스트로 옮겨 적는 일은 그 뒤에 이어진다.
    await app.wait(60);

    assert.equal(app.state(), "complete", "다 모으면 결과로 넘어가야 한다");
    assert.ok(app.log.some(([name]) => name === "stopScan"), "카메라를 놓아야 한다");
    assert.match(app.el("result-summary").textContent, /^1,000바이트를 모두 복원했습니다/);

    await app.click("scan-save");

    // 저장된 텍스트가 `armor::wrap_single_line()` 과 같은 모양이라야 풀기 탭이 그대로 받는다.
    const [file] = app.written;
    const lines = file.data.split("\n");
    assert.equal(lines[0], "-----BEGIN PACKER CONTAINER-----");
    assert.equal(lines[2], "-----END PACKER CONTAINER-----");
    assert.equal(lines[1], Buffer.from(STREAM_SOURCE).toString("base64"));
  });

  it("조각을 모으는 중이면 스트림 프레임에 갈아타지 않는다", async () => {
    // 모드는 첫 심볼로 정해지고 다 모을 때까지 바뀌지 않는다. 뒤늦게 다른 묶음이 들어와도
    // 모으던 것을 버리면 안 된다.
    const app = await boot();
    await app.scan(makePieces(BODY, 3)[0]);
    assert.equal(app.el("scan-progress").textContent, "1 / 3");

    await app.scanFrame(STREAM_FRAMES[0]);

    assert.equal(app.el("scan-progress").textContent, "1 / 3", "모으던 것을 잃으면 안 된다");
    assert.equal(app.el("scan-list").hidden, false, "조각 모드의 칩이 그대로 있어야 한다");
  });

  it("스트림 모드에서는 칩 대신 막대만 쓴다", async () => {
    // 순번을 채우는 방식이 아니라 "어느 장이 빠졌는지" 라는 개념 자체가 없다.
    const app = await boot();
    await app.scanFrame(STREAM_FRAMES[0]);

    assert.equal(app.el("scan-list").hidden, true);
    assert.equal(app.el("scan-bar").hidden, false);
    assert.match(app.el("scan-progress").textContent, /^\d+%$/);
    // 순서를 걱정하지 않아도 된다는 말은 이 모드에서 가장 자주 필요한 안내다.
    assert.match(app.el("scan-status").textContent, /순서는 상관없습니다/);
  });

  it("스트림 진행을 퍼센트 하나로만 말하지 않는다", async () => {
    // 픽스처는 1,000바이트 · 64바이트 블록 16개 (framesNeeded = 16 + 2 + 8 = 26).
    const app = await boot();
    await app.scanFrame(STREAM_FRAMES[0]);
    await app.scanFrame(STREAM_FRAMES[1]);

    assert.match(app.el("scan-progress").textContent, /^\d+%$/);
    // 퍼센트의 실체 — 블록 몇 개가 풀렸는지. 1 오르는 것이 눈에 보여야 한다.
    assert.match(app.el("scan-total").textContent, /^블록 \d+ \/ 16$/);

    const label = app.el("scan-bar-label");
    assert.equal(label.hidden, false);
    // 받은 프레임과 필요한 양, 그리고 크기. 총량 대비 어디쯤인지가 여기 다 있다.
    assert.match(label.textContent, /^프레임 2 \/ 약 26장 · \d+ B \/ 1000 B$/);
  });

  it("복원이 서 있는 동안에도 받은 프레임 층은 자란다", async () => {
    // **이 성질이 없으면 화면은 멈춘 것과 구별되지 않는다.** LT 복원은 마지막에 몰아서
    // 일어나므로, 그 전까지 움직이는 표시가 하나는 있어야 한다.
    const app = await boot();
    const width = (hook) => Number.parseFloat(app.el(hook).style.width) || 0;

    let stalledButMoving = false;
    let lastFill = 0;
    let lastLead = 0;

    for (const frame of STREAM_FRAMES) {
      await app.scanFrame(frame);
      if (app.state() === "complete") break;
      const fill = width("scan-bar-fill");
      const lead = width("scan-bar-lead");
      assert.ok(lead >= lastLead, `받은 프레임 층이 줄었다: ${lastLead} → ${lead}`);
      assert.ok(lead >= fill, `옅은 층이 진짜 진행보다 뒤처지면 덮여 보이지 않는다`);
      if (fill === lastFill && lead > lastLead) stalledButMoving = true;
      lastFill = fill;
      lastLead = lead;
    }

    assert.ok(stalledButMoving, "퍼센트가 서 있는 동안 자라는 층이 없다");
  });

  it("프레임이 끊기면 그 사실을 말한다", async () => {
    // 계기는 1초마다 돈다. 3초 넘게 새 프레임이 없으면 그때부터 말한다 (app.js 의 STALL_MS).
    const app = await boot();
    await app.scanFrame(STREAM_FRAMES[0]);
    assert.equal(app.el("scan-bar-note").hidden, false);

    await app.wait(4200);
    assert.match(app.el("scan-bar-note").textContent, /초째 새 프레임이 없습니다/);

    // 같은 번호만 되풀이해 들어오면 원인이 다르다 — 심볼은 읽히는데 PC 가 안 넘어가고 있다.
    await app.scanFrame(STREAM_FRAMES[0]);
    await app.wait(1200);
    assert.match(app.el("scan-bar-note").textContent, /같은 프레임만 들어옵니다/);
  });

  it("몇 장 안 남으면 PC 에 넣을 번호를 알려 준다", async () => {
    // 마지막 몇 장을 놓쳐 한 바퀴를 다시 도는 것이 조각 모드에서 가장 오래 걸리는 구간이다.
    // 데스크톱의 '놓친 장 부르기' 가 이 글자를 그대로 받는다.
    const app = await boot();
    const pieces = makePieces(BODY, 3);

    await app.scan(pieces[0]);
    // 이어진 번호는 범위로 접는다 — PC 쪽 입력칸이 같은 표기를 받는다.
    assert.match(app.el("scan-status").textContent, /PC 에 넣을 번호: 2~3$/);

    await app.scan(pieces[1]);
    assert.match(app.el("scan-status").textContent, /PC 에 넣을 번호: 3$/);
  });

  it("스트림 도중에 다른 묶음이 섞이면 짚어 준다", async () => {
    const app = await boot();
    await app.scanFrame(STREAM_FRAMES[0]);

    const other = Uint8Array.from(STREAM_FRAMES[1]);
    other[4] ^= 0xff; // 지문 한 바이트
    await app.scanFrame(other);

    assert.match(app.el("scan-status").textContent, /다른 묶음/);
  });

  it("조각이 적으면 칩을 그대로 쓴다", async () => {
    const app = await boot();
    await app.scan(makePieces(BODY, 3)[0]);
    assert.equal(app.el("scan-list").hidden, false);
    assert.equal(app.el("scan-bar").hidden, true);
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
    assert.match(app.el("result-note").textContent, /^저장했습니다 — file:\/\/\/DOCUMENTS\/packer-/);
    // 입력칸에 보이던 이름 그대로 나가야 한다.
    assert.equal(app.el("save-name").value, file.path);
  });

  it("완료 화면에 기본 파일 이름이 미리 채워진다", async () => {
    const app = await boot();
    for (const piece of makePieces(BODY, 3)) await app.scan(piece);
    assert.match(app.el("save-name").value, /^packer-\d{8}-\d{6}\.txt$/);
  });

  it("이름을 고치면 그 이름으로 나간다", async () => {
    const app = await boot();
    for (const piece of makePieces(BODY, 3)) await app.scan(piece);

    app.el("save-name").value = "내 결과";
    await app.click("scan-save");

    assert.equal(app.written[0].path, "내_결과.txt");
  });

  it("쓸 수 없는 글자는 저장하기 전에 고쳐서 보여 준다", async () => {
    // 조용히 고치면 나중에 파일을 못 찾는다. 입력칸에 되돌려 적는다.
    const app = await boot();
    for (const piece of makePieces(BODY, 3)) await app.scan(piece);

    app.el("save-name").value = "a/b: c";
    await app.click("scan-save");

    assert.equal(app.el("save-name").value, "a_b_c.txt");
    assert.equal(app.written[0].path, "a_b_c.txt");
  });

  it("문서 폴더에 못 쓰면 다음 폴더로 내려가고 그 사실을 말해 준다", async () => {
    // 안드로이드 10 이하가 실제로 이 길로 온다.
    const app = await boot({ failWrite: ["DOCUMENTS"] });
    for (const piece of makePieces(BODY, 3)) await app.scan(piece);

    await app.click("scan-save");

    assert.equal(app.written[0].directory, "EXTERNAL");
    assert.match(app.el("result-note").textContent, /앱을 지우면 함께 사라집니다/);
  });

  it("보내기는 캐시에 쓴 파일을 공유 시트로 넘긴다", async () => {
    const app = await boot({ activityType: "com.sec.android.app.myfiles" });
    for (const piece of makePieces(BODY, 3)) await app.scan(piece);

    assert.equal(app.el("scan-share").hidden, false);
    await app.click("scan-share");

    assert.equal(app.written[0].directory, "CACHE");
    assert.equal(app.shared.length, 1);
    assert.deepEqual(app.shared[0].files, [`file:///CACHE/${app.written[0].path}`]);
    assert.match(app.el("result-note").textContent, /^보냈습니다 \(com\.sec/);
  });

  it("앱을 고르는 동안에는 막대가 돌지 않는다", async () => {
    // 시트 뒤에서 도는 막대는 "진행 중" 이라는 또 다른 거짓말이다.
    const app = await boot({ slowWriteMs: BUSY_DELAY_MS + 150 });
    for (const piece of makePieces(BODY, 3)) await app.scan(piece);

    app.press("scan-share");
    await app.wait(BUSY_DELAY_MS + 60);
    assert.equal(app.el("export-progress").hidden, false, "쓰는 동안에는 떠 있어야 한다");

    await app.wait(BUSY_DELAY_MS + BUSY_HOLD_MS + 300);
    assert.equal(app.el("export-progress").hidden, true);
    assert.equal(app.shared.length, 1);
  });

  it("보내기를 취소하면 취소했다고만 말한다", async () => {
    const app = await boot({ shareError: "Share canceled" });
    for (const piece of makePieces(BODY, 3)) await app.scan(piece);

    await app.click("scan-share");

    assert.equal(app.el("result-note").textContent, "보내기를 취소했습니다.");
  });

  it("공유를 못 쓰는 기기에서는 보내기 버튼을 감춘다", async () => {
    // 뜻 없는 조작 도구는 잠그기보다 감춘다 (scan-torch 와 같은 규칙).
    const app = await boot({ share: false });
    for (const piece of makePieces(BODY, 3)) await app.scan(piece);
    assert.equal(app.el("scan-share").hidden, true);
  });

  it("안내 문구는 플랫폼에 맞춘다", async () => {
    const ios = await boot({ platform: "ios" });
    for (const piece of makePieces(BODY, 3)) await ios.scan(piece);
    assert.match(ios.el("save-hint").textContent, /파일에 저장/);

    const android = await boot({ platform: "android" });
    for (const piece of makePieces(BODY, 3)) await android.scan(piece);
    assert.match(android.el("save-hint").textContent, /고른 앱이 정합니다/);
  });

  it("빨리 끝나는 저장에서는 진행 막대가 아예 보이지 않는다", async () => {
    // 밀리초짜리 작업에 막대를 띄우는 것은 거짓말이다. 16장 규모에서는 늘 이쪽이어야 한다.
    const app = await boot();
    for (const piece of makePieces(BODY, 3)) await app.scan(piece);

    await app.click("scan-save");
    assert.equal(app.el("export-progress").hidden, true);

    // 지연 표시 시간이 지나고 나서도 뒤늦게 뜨면 안 된다.
    await app.wait(BUSY_DELAY_MS + 60);
    assert.equal(app.el("export-progress").hidden, true);
  });

  it("오래 걸리는 저장에서는 막대가 뜨고, 다 되면 거둔다", async () => {
    const app = await boot({ slowWriteMs: BUSY_DELAY_MS + 150 });
    for (const piece of makePieces(BODY, 3)) await app.scan(piece);

    app.press("scan-save");
    await app.wait(BUSY_DELAY_MS + 60);

    const bar = app.el("export-progress");
    assert.equal(bar.hidden, false, "지연 시간이 지났으면 떠야 한다");
    assert.equal(bar.getAttribute("role"), "progressbar");
    // 총량을 아직 모르는 구간이다 — 훑고 지나가는 모양으로 둔다.
    assert.equal(app.el("export-progress-fill").dataset.indeterminate, "true");

    // 최소 표시 시간을 채운 뒤에 사라진다.
    await app.wait(BUSY_DELAY_MS + BUSY_HOLD_MS + 300);
    assert.equal(bar.hidden, true);
    assert.match(app.el("result-note").textContent, /^저장했습니다/);
  });

  it("저장하는 동안에는 두 버튼을 함께 잠근다", async () => {
    const app = await boot({ slowWriteMs: BUSY_DELAY_MS + 150 });
    for (const piece of makePieces(BODY, 3)) await app.scan(piece);

    app.press("scan-save");
    await app.settle();
    assert.equal(app.el("scan-save").disabled, true);
    assert.equal(app.el("scan-share").disabled, true);

    await app.wait(BUSY_DELAY_MS + BUSY_HOLD_MS + 300);
    assert.equal(app.el("scan-save").disabled, false);
    assert.equal(app.el("scan-share").disabled, false);
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
