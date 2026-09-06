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
  const log = { write: [], append: [], deleted: [], shared: [] };
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

  const plugins = {};
  if (!options.noFilesystem) plugins.Filesystem = Filesystem;
  if (!options.noShare) plugins.Share = Share;

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
