// bridge.js 의 저장·보내기를 기기 없이 검증한다.
//
//   npm test
//
// **의존성이 없어서 `npm install` 없이도 돌아간다.** `bridge.js` 는 DOM 을 만지지 않고
// `globalThis.Capacitor` 만 보므로, 가짜 플러그인을 심어 두면 그대로 돌아간다 —
// `app.test.js` 가 jsdom 을 세우는 것과 달리 여기서는 창이 필요 없다.
//
// 여기서 못박는 계약은 세 가지다: 나눠 쓰기가 원문을 글자 하나 잃지 않는다는 것, 실패하면
// 쓰다 만 파일을 남기지 않는다는 것, 그리고 문서 폴더에 못 쓰면 조용히 실패하지 않고 다음
// 폴더로 내려간다는 것 (안드로이드 10 이하가 실제로 그렇다 — `bridge.js` 의 `SAVE_ORDER` 주석).

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { CHUNK_THRESHOLD } from "../www/export.js";

/// `bridge.js` 는 모듈을 한 번만 읽으므로, 가짜 플러그인은 호출 사이에 갈아 끼운다.
const bridge = await import("../www/bridge.js");

/**
 * 가짜 Capacitor 를 심는다.
 *
 * @param {{failWrite?: string[], failAppendAt?: number, shareError?: string, noShare?: boolean,
 *          noFilesystem?: boolean, platform?: string}} options
 */
function install(options = {}) {
  const log = { write: [], append: [], deleted: [], shared: [], listeners: [], emit: null };
  let appends = 0;

  const Filesystem = {
    async writeFile(given) {
      if ((options.failWrite ?? []).includes(given.directory)) {
        throw new Error(`denied: ${given.directory}`);
      }
      log.write.push(given);
      return { uri: `file:///${given.directory}/${given.path}` };
    },
    async appendFile(given) {
      appends += 1;
      if (options.failAppendAt === appends) throw new Error("append failed");
      log.append.push(given);
    },
    async deleteFile(given) {
      log.deleted.push(given);
    },
  };

  const Share = {
    async canShare() {
      return { value: true };
    },
    async share(given) {
      if (options.shareError) throw new Error(options.shareError);
      log.shared.push(given);
      return { activityType: "com.sec.android.app.myfiles" };
    },
  };

  /// 연속 스캔을 흉내 낸다. `emit` 으로 한 카메라 프레임 몫을 통째로 흘려보낸다.
  const BarcodeScanner = {
    async addListener(name, handler) {
      log.listeners.push(name);
      if (name === "barcodesScanned") log.emit = (barcodes) => handler({ barcodes });
      return { remove: async () => {} };
    },
  };

  const plugins = {};
  if (!options.noFilesystem) plugins.Filesystem = Filesystem;
  if (!options.noShare) plugins.Share = Share;
  if (!options.noScanner) plugins.BarcodeScanner = BarcodeScanner;

  globalThis.Capacitor = { Plugins: plugins, getPlatform: () => options.platform ?? "android" };
  return log;
}

afterEach(() => {
  delete globalThis.Capacitor;
});

/// 나눠 쓰기 경로를 타는 크기. 임계값에서 파생시켜 두면 상수를 바꿔도 테스트가 따라온다.
const BIG = "x".repeat(CHUNK_THRESHOLD + 5_000);
const SMALL = "-----BEGIN PACKER CONTAINER-----\nAAAA\n-----END PACKER CONTAINER-----\n";

describe("saveText — 한 번에 쓰기", () => {
  it("짧은 텍스트는 나누지 않는다", async () => {
    const log = install();
    const { uri, directory } = await bridge.saveText("packer.txt", SMALL);

    assert.equal(log.write.length, 1);
    assert.equal(log.append.length, 0);
    assert.deepEqual(log.write[0], {
      path: "packer.txt",
      data: SMALL,
      directory: "DOCUMENTS",
      encoding: "utf8",
      recursive: true,
    });
    assert.equal(directory, "DOCUMENTS");
    assert.equal(uri, "file:///DOCUMENTS/packer.txt");
  });

  it("진행률은 한 번, 끝난 값으로 온다", async () => {
    install();
    const ticks = [];
    await bridge.saveText("packer.txt", SMALL, (done, total) => ticks.push([done, total]));
    assert.deepEqual(ticks, [[SMALL.length, SMALL.length]]);
  });
});

describe("saveText — 나눠 쓰기", () => {
  it("첫 조각만 writeFile 이고 나머지는 appendFile 이다", async () => {
    const log = install();
    await bridge.saveText("big.txt", BIG);

    assert.equal(log.write.length, 1);
    assert.ok(log.append.length >= 4, `조각이 너무 적다: ${log.append.length}`);
    // recursive 는 첫 쓰기에만. append 에 붙이면 플러그인이 무시하지만 뜻이 어긋난다.
    assert.equal(log.write[0].recursive, true);
    for (const call of log.append) {
      assert.equal(call.recursive, undefined);
      assert.equal(call.encoding, "utf8");
      assert.equal(call.directory, "DOCUMENTS");
      assert.equal(call.path, "big.txt");
    }
  });

  it("이어 붙이면 원문과 글자 하나까지 같다", async () => {
    const log = install();
    await bridge.saveText("big.txt", BIG);
    const rebuilt = log.write[0].data + log.append.map((call) => call.data).join("");
    assert.equal(rebuilt.length, BIG.length);
    assert.equal(rebuilt, BIG);
  });

  it("진행률은 뒤로 가지 않고 정확히 총량에서 끝난다", async () => {
    install();
    const ticks = [];
    await bridge.saveText("big.txt", BIG, (done, total) => ticks.push([done, total]));

    assert.ok(ticks.length >= 5);
    let last = -1;
    for (const [done, total] of ticks) {
      assert.equal(total, BIG.length);
      assert.ok(done >= last, `진행률이 뒤로 갔다: ${last} → ${done}`);
      last = done;
    }
    assert.deepEqual(ticks.at(-1), [BIG.length, BIG.length]);
  });

  it("중간에 실패하면 쓰다 만 파일을 지우고 다음 폴더로 내려간다", async () => {
    // 잘린 컨테이너가 PC 로 건너가면 한참 뒤 GCM 인증 실패로만 나타난다. 남겨 두면 안 된다.
    const log = install({ failAppendAt: 3 });
    const { directory } = await bridge.saveText("big.txt", BIG);

    assert.deepEqual(log.deleted, [{ path: "big.txt", directory: "DOCUMENTS" }]);
    assert.equal(directory, "EXTERNAL", "실패한 폴더를 넘어가야 한다");
    // 내려간 뒤의 결과도 온전해야 한다. 앞 시도에서 쓴 조각이 섞이면 안 된다.
    const rebuilt =
      log.write.at(-1).data +
      log.append.filter((call) => call.directory === "EXTERNAL").map((call) => call.data).join("");
    assert.equal(rebuilt, BIG);
  });

  it("만들지도 못한 파일은 지우려 들지 않는다", async () => {
    // 쓸 수 없는 폴더에까지 삭제를 날리면, 실패 하나가 실패 두 개가 된다.
    const log = install({ failWrite: ["EXTERNAL", "CACHE"], failAppendAt: 3 });
    await assert.rejects(() => bridge.saveText("big.txt", BIG), /denied: CACHE/);
    assert.deepEqual(log.deleted, [{ path: "big.txt", directory: "DOCUMENTS" }]);
  });
});

describe("saveText — 폴더 캐스케이드", () => {
  it("문서 폴더에 못 쓰면 다음 폴더로 내려간다", async () => {
    // 안드로이드 10 이하가 실제로 이 길로 온다 (선언되지 않은 저장 권한 → 즉시 거절).
    const log = install({ failWrite: ["DOCUMENTS"] });
    const { directory, uri } = await bridge.saveText("packer.txt", SMALL);

    assert.equal(directory, "EXTERNAL");
    assert.equal(uri, "file:///EXTERNAL/packer.txt");
    assert.equal(log.write.length, 1, "성공한 쓰기만 기록된다");
  });

  it("두 폴더가 막히면 캐시까지 내려간다", async () => {
    install({ failWrite: ["DOCUMENTS", "EXTERNAL"] });
    const { directory } = await bridge.saveText("packer.txt", SMALL);
    assert.equal(directory, "CACHE");
  });

  it("전부 막히면 마지막 오류를 그대로 던진다", async () => {
    install({ failWrite: ["DOCUMENTS", "EXTERNAL", "CACHE"] });
    await assert.rejects(() => bridge.saveText("packer.txt", SMALL), /denied: CACHE/);
  });

  it("플러그인이 아예 없으면 그렇게 말한다", async () => {
    install({ noFilesystem: true });
    await assert.rejects(() => bridge.saveText("packer.txt", SMALL), /저장할 수 없습니다/);
  });
});

describe("shareText", () => {
  it("캐시에 쓴 파일을 그대로 넘긴다", async () => {
    const log = install();
    const result = await bridge.shareText("보고서.txt", SMALL);

    assert.equal(log.write[0].directory, "CACHE");
    assert.equal(log.shared.length, 1);
    assert.deepEqual(log.shared[0].files, ["file:///CACHE/보고서.txt"]);
    assert.equal(log.shared[0].title, "보고서.txt");
    // `text` 를 함께 넘기면 안드로이드가 text/plain 으로 굳혀 첨부가 사라진다.
    assert.equal(log.shared[0].text, undefined);
    assert.equal(result.shared, true);
    assert.equal(result.activityType, "com.sec.android.app.myfiles");
  });

  it("시트를 띄우기 직전에 알려 준다", async () => {
    // 호출자가 진행 막대를 거둘 자리다. `api.share` 는 시트가 닫혀야 돌아오므로, 이걸로
    // 알려 주지 않으면 사용자가 앱을 고르는 내내 막대가 돈다.
    const log = install();
    const order = [];
    await bridge.shareText(
      "packer.txt",
      SMALL,
      () => order.push("progress"),
      () => order.push("ready"),
    );

    assert.deepEqual(order, ["progress", "ready"], "쓰기가 끝난 뒤에 불려야 한다");
    // 그리고 시트는 그 뒤에 뜬다.
    assert.equal(log.shared.length, 1);
  });

  it("넘긴 캐시 파일은 지우지 않는다", async () => {
    // 받는 앱이 URI 를 나중에 읽는다. 지우면 빈 파일이 저장된다.
    const log = install();
    await bridge.shareText("packer.txt", SMALL);
    assert.deepEqual(log.deleted, []);
  });

  it("취소는 오류가 아니다", async () => {
    // 두 플랫폼 모두 "Share canceled" 로 거절한다.
    install({ shareError: "Share canceled" });
    assert.deepEqual(await bridge.shareText("packer.txt", SMALL), {
      shared: false,
      activityType: "",
    });
  });

  it("진짜 오류는 그대로 던진다", async () => {
    install({ shareError: "no activity found" });
    await assert.rejects(() => bridge.shareText("packer.txt", SMALL), /no activity found/);
  });

  it("공유 플러그인이 없으면 그렇게 말한다", async () => {
    install({ noShare: true });
    assert.equal(await bridge.canShare(), false);
    await assert.rejects(() => bridge.shareText("packer.txt", SMALL), /보낼 수 없습니다/);
  });
});

describe("platform", () => {
  it("네이티브가 알려 주는 값을 그대로 쓴다", async () => {
    install({ platform: "ios" });
    assert.equal(bridge.platform(), "ios");
  });

  it("그냥 브라우저로 열면 web 이다", () => {
    delete globalThis.Capacitor;
    assert.equal(bridge.platform(), "web");
  });
});

describe("onBarcodes — 한 프레임에 여러 심볼", () => {
  it("한 번에 들어온 심볼을 하나도 버리지 않는다", async () => {
    // **PC 의 스트림 모드가 이 계약 위에 서 있다.** 화면에 프레임을 1·2·4장 나란히 세우는 것은
    // 카메라 프레임이 16:9 라 정사각형 심볼 하나로는 좌우가 노는 것을 쓰는 일인데, 여기서
    // 첫 심볼만 넘기면 나머지는 그냥 버려진다 — 화면은 멀쩡히 도는데 처리량만 그대로다.
    const log = install();
    const seen = [];
    await bridge.onBarcodes((barcode) => seen.push(barcode.rawValue));

    assert.deepEqual(log.listeners, ["barcodesScanned"]);
    log.emit([{ rawValue: "A" }, { rawValue: "B" }, { rawValue: "C" }, { rawValue: "D" }]);
    assert.deepEqual(seen, ["A", "B", "C", "D"]);
  });

  it("심볼이 없는 프레임은 아무 일도 일으키지 않는다", async () => {
    const log = install();
    let calls = 0;
    await bridge.onBarcodes(() => (calls += 1));

    log.emit([]);
    log.emit(undefined);
    assert.equal(calls, 0);
  });
});

// ---------------------------------------------------------------- 풀어서 저장

describe("unpackToDevice — 임시 폴더에 풀고 제자리로 옮긴다", () => {
  /// 메모리 파일 시스템을 심는다. 호출을 기록만 하는 가짜로는 "옮긴 뒤 무엇이 남았는지" 를 물을
  /// 수 없어서, 여기서는 상태를 들고 있는 가짜를 쓴다 (`memory-fs.js`).
  async function installMemory(options = {}) {
    const { memoryFilesystem } = await import("./memory-fs.js");
    const fs = memoryFilesystem(options);
    globalThis.Capacitor = { Plugins: { Filesystem: fs.api }, getPlatform: () => "android" };
    return fs;
  }

  /// `unpack.js` 대신 싱크에 몇 가지를 써 보는 가짜 일꾼.
  const writeSome = async (sink) => {
    await sink.makeDir("프로젝트");
    await sink.makeDir("프로젝트"); // 같은 폴더를 두 번 — 두 번째는 조용히 넘어가야 한다.
    await sink.writeFile("프로젝트/a.bin", Uint8Array.from([0, 1, 2, 255]), false);
    await sink.writeFile("프로젝트/a.bin", Uint8Array.from([7]), true);
    await sink.writeFile("메모.txt", new TextEncoder().encode("안녕"), false);
    await sink.writeFile("빈.txt", new Uint8Array(0), false);
    return { fileCount: 3 };
  };

  it("문서 폴더 아래 고른 폴더에 풀고, 임시 폴더를 남기지 않는다", async () => {
    const fs = await installMemory();
    const result = await bridge.unpackToDevice("Packer/2026", writeSome);

    assert.equal(result.fileCount, 3, "일꾼의 결과를 그대로 돌려준다");
    assert.equal(result.directory, "DOCUMENTS");
    assert.equal(result.uri, "file:///DOCUMENTS/Packer/2026");
    assert.deepEqual(result.renamed, []);
    assert.deepEqual(fs.list("DOCUMENTS"), [
      "Packer/",
      "Packer/2026/",
      "Packer/2026/메모.txt",
      "Packer/2026/빈.txt",
      "Packer/2026/프로젝트/",
      "Packer/2026/프로젝트/a.bin",
    ]);
    assert.deepEqual([...fs.read("DOCUMENTS", "Packer/2026/프로젝트/a.bin")], [0, 1, 2, 255, 7]);
    assert.equal(new TextDecoder().decode(fs.read("DOCUMENTS", "Packer/2026/메모.txt")), "안녕");
  });

  it("바이트는 Base64 로, 인코딩 없이 넘긴다 — 플러그인이 그래야 바이너리로 쓴다", async () => {
    const fs = await installMemory();
    await bridge.unpackToDevice("Packer", writeSome);
    const writes = fs.calls.filter(([name]) => name === "writeFile" || name === "appendFile");
    assert.ok(writes.length > 0);
    for (const [, given] of writes) assert.equal(given.encoding, undefined);
    const first = writes.find(([, given]) => given.path.endsWith("a.bin"))[1];
    assert.equal(first.data, "AAEC/w==");
    assert.equal(first.recursive, true);
  });

  it("같은 이름이 이미 있으면 번호를 붙이고, 있던 파일은 건드리지 않는다", async () => {
    // Capacitor 의 rename 은 대상 파일이 있으면 지우고 옮긴다. 이름을 먼저 피하지 않으면 사용자의
    // 파일이 소리 없이 사라진다.
    const fs = await installMemory();
    fs.put("DOCUMENTS", "Packer/메모.txt", "원래 있던 메모");
    const result = await bridge.unpackToDevice("Packer", writeSome);

    assert.deepEqual(result.renamed, ["메모.txt → 메모 (2).txt"]);
    assert.equal(new TextDecoder().decode(fs.read("DOCUMENTS", "Packer/메모.txt")), "원래 있던 메모");
    assert.equal(new TextDecoder().decode(fs.read("DOCUMENTS", "Packer/메모 (2).txt")), "안녕");
  });

  it("중간에 실패하면 반쯤 풀린 파일을 남기지 않는다", async () => {
    const fs = await installMemory();
    fs.put("DOCUMENTS", "Packer/있던 것.txt", "그대로");
    await assert.rejects(
      bridge.unpackToDevice("Packer", async (sink) => {
        await sink.writeFile("반쯤.bin", Uint8Array.from([1, 2, 3]), false);
        throw new Error("파일이 손상되었거나 중간에 잘렸습니다.");
      }),
      /손상/,
    );
    assert.deepEqual(fs.list("DOCUMENTS"), ["Packer/", "Packer/있던 것.txt"]);
  });

  it("문서 폴더에 못 쓰면 저장과 같은 순서로 내려간다", async () => {
    // 안드로이드 10 이하가 실제로 이 길로 온다 (`SAVE_ORDER`).
    const fs = await installMemory({ deny: ["DOCUMENTS"] });
    const result = await bridge.unpackToDevice("Packer", writeSome);
    assert.equal(result.directory, "EXTERNAL");
    assert.ok(fs.list("EXTERNAL").includes("Packer/메모.txt"));
  });

  it("어디에도 못 쓰면 마지막 이유를 그대로 올린다", async () => {
    await installMemory({ deny: ["DOCUMENTS", "EXTERNAL", "CACHE"] });
    let ran = false;
    await assert.rejects(
      bridge.unpackToDevice("Packer", async () => {
        ran = true;
      }),
      /denied: CACHE/,
    );
    assert.equal(ran, false, "쓸 곳이 없으면 풀기를 시작하지도 않는다 — 키 유도만 몇 초다");
  });

  it("WebCrypto 와 Filesystem 이 둘 다 있어야 쓸 수 있다고 말한다", async () => {
    await installMemory();
    assert.equal(bridge.canUnpack(), true);
    install({ noFilesystem: true });
    assert.equal(bridge.canUnpack(), false);
  });
});
