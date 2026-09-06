// upload-to-play.mjs 가 Play Developer API 와 주고받는 내용을 못박아 둔다.
//
// 이 스크립트는 눈으로 확인할 수 없는 자리에서 돈다 — 진짜 Play 에 올려 보기 전에는 JWT 가
// 맞는지, 트랙 본문이 맞는지 알 길이 없고, 틀리면 릴리스 당일에야 알게 된다. 그래서 가짜
// Play 서버를 세워 **실제 CLI 를 돌리고** 오간 요청을 그대로 검사한다.
//
// spawnSync 를 쓰지 않는 이유: 가짜 서버가 같은 프로세스의 이벤트 루프에서 돌기 때문에,
// 동기로 기다리면 서버가 응답할 기회를 얻지 못하고 서로 멈춘다.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const mobileRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = path.join(mobileRoot, "scripts", "upload-to-play.mjs");

const PACKAGE = "org.packer.scanner";
const EDIT_ID = "edit-4242";
const BUILD = "42";

// 진짜 서비스 계정 키와 같은 모양. private_key 는 실제로 서명에 쓰이므로 진짜 키여야 한다.
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const serviceAccount = {
  type: "service_account",
  project_id: "packer-scanner",
  private_key_id: "key-id-1",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  client_email: "release@packer-scanner.iam.gserviceaccount.com",
  token_uri: "https://oauth2.googleapis.com/token",
};

/**
 * 가짜 Play 를 띄운다. 경로 뒤쪽을 보고 단계를 알아내며, 오간 요청을 전부 모아 둔다.
 *
 * `overrides` 는 단계별로 응답을 갈아 끼운다. getter 로 넣으면 호출할 때마다 다른 응답을 낼 수
 * 있다 (첫 커밋만 거절하는 시나리오에 쓴다).
 *
 * @param {Record<string, { status?: number, body?: unknown }>} overrides
 */
async function startPlay(overrides = {}) {
  const calls = [];

  const defaults = {
    token: { body: { access_token: "test-token", expires_in: 3600 } },
    insert: { body: { id: EDIT_ID, expiryTimeSeconds: "9999999999" } },
    upload: { body: { versionCode: Number(BUILD), sha256: "abc" } },
    tracks: { body: { track: "internal" } },
    validate: { body: { id: EDIT_ID } },
    commit: { body: { id: EDIT_ID } },
    delete: { status: 204, body: "" },
  };

  /** 요청 하나가 어느 단계인지 알아본다. @param {string} method @param {string} url */
  const stepOf = (method, url) => {
    if (url.startsWith("/token")) return "token";
    if (url.includes("/bundles?")) return "upload";
    if (url.includes("/tracks/")) return "tracks";
    if (url.includes(":validate")) return "validate";
    if (url.includes(":commit")) return "commit";
    if (method === "DELETE") return "delete";
    return "insert";
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const step = stepOf(req.method, req.url);
      calls.push({ step, method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });

      const reply = { ...defaults[step], ...(overrides[step] ?? {}) };
      const body = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? {});
      res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
      res.end(body);
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * 스크립트를 돌린다.
 *
 * @param {string[]} args
 * @param {Record<string, string>} env 프로세스 환경에 얹을 값
 */
function run(args, env = {}) {
  const child = spawn(process.execPath, [script, ...args], {
    env: { ...process.env, PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify(serviceAccount), ...env },
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));

  return new Promise((resolve) => {
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/** 임시 AAB 하나를 만든다 (내용은 아무래도 좋고, 바이트가 그대로 올라가는지만 본다). */
function makeAab() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upload-to-play-"));
  const file = path.join(dir, "app.aab");
  fs.writeFileSync(file, Buffer.from("PKfake-bundle"));
  return file;
}

/** 매번 같은 필수 인자 묶음. @param {{ url: string }} play @param {string} aab @param {string[]} extra */
const baseArgs = (play, aab, extra = []) => [
  "--aab", aab,
  "--package", PACKAGE,
  "--track", "internal",
  "--version", "1.2.3",
  "--build", BUILD,
  "--token-url", `${play.url}/token`,
  "--api-base", play.url,
  ...extra,
];

const steps = (calls) => calls.map((call) => call.step);
const jsonBody = (call) => JSON.parse(call.body.toString("utf8"));
const find = (calls, step) => calls.find((call) => call.step === step);

test("번들을 올리고 트랙을 갱신한 뒤 커밋한다", async (t) => {
  const play = await startPlay();
  t.after(() => play.close());
  const aab = makeAab();

  const result = await run(baseArgs(play, aab));
  assert.equal(result.status, 0, result.stdout + result.stderr);

  assert.deepEqual(steps(play.calls), ["token", "insert", "upload", "tracks", "commit"]);

  // 토큰을 받은 뒤의 모든 요청이 그 토큰을 달고 가야 한다.
  for (const call of play.calls.filter((each) => each.step !== "token")) {
    assert.equal(call.headers.authorization, "Bearer test-token", `${call.step} 에 토큰이 없다`);
  }

  // 업로드는 파일 바이트를 그대로 실어 보낸다.
  const upload = find(play.calls, "upload");
  assert.match(upload.url, /uploadType=media/);
  assert.equal(upload.headers["content-type"], "application/octet-stream");
  assert.deepEqual(upload.body, fs.readFileSync(aab));

  // 트랙 본문 — 여기가 틀리면 앱이 엉뚱한 트랙에 올라간다.
  const tracks = find(play.calls, "tracks");
  assert.equal(tracks.method, "PUT");
  assert.ok(tracks.url.endsWith(`/edits/${EDIT_ID}/tracks/internal`), tracks.url);
  assert.deepEqual(jsonBody(tracks), {
    track: "internal",
    releases: [{ name: `1.2.3 (${BUILD})`, versionCodes: [BUILD], status: "completed" }],
  });

  assert.ok(find(play.calls, "commit").url.endsWith(":commit"));
});

test("서비스 계정 키로 서명한 JWT 를 토큰으로 바꾼다", async (t) => {
  const play = await startPlay();
  t.after(() => play.close());

  assert.equal((await run(baseArgs(play, makeAab()))).status, 0);

  const token = find(play.calls, "token");
  const form = new URLSearchParams(token.body.toString("utf8"));
  assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");

  const [rawHeader, rawClaims, rawSignature] = form.get("assertion").split(".");
  const header = JSON.parse(Buffer.from(rawHeader, "base64url").toString("utf8"));
  const claims = JSON.parse(Buffer.from(rawClaims, "base64url").toString("utf8"));

  assert.deepEqual(header, { alg: "RS256", typ: "JWT", kid: serviceAccount.private_key_id });
  assert.equal(claims.iss, serviceAccount.client_email);
  assert.equal(claims.scope, "https://www.googleapis.com/auth/androidpublisher");
  // aud 가 토큰을 받으러 가는 주소와 다르면 진짜 토큰 서버는 서명을 거절한다.
  assert.equal(claims.aud, `${play.url}/token`);
  assert.ok(claims.exp > claims.iat, "exp 가 iat 보다 뒤여야 한다");

  const verified = crypto
    .createVerify("RSA-SHA256")
    .update(`${rawHeader}.${rawClaims}`)
    .verify(publicKey, Buffer.from(rawSignature, "base64url"));
  assert.ok(verified, "JWT 서명이 서비스 계정 키로 검증되지 않는다");
});

test("--validate-only 는 커밋하지 않고 편집을 되돌린다", async (t) => {
  const play = await startPlay();
  t.after(() => play.close());

  const result = await run(baseArgs(play, makeAab(), ["--validate-only"]));
  assert.equal(result.status, 0, result.stdout + result.stderr);

  assert.deepEqual(steps(play.calls), ["token", "insert", "upload", "tracks", "validate", "delete"]);
  assert.match(result.stdout, /검증만 했습니다/);
});

test("릴리스 노트는 언어를 넘겼을 때만, 500자까지만 싣는다", async (t) => {
  const withNotes = await startPlay();
  t.after(() => withNotes.close());

  const notes = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "play-notes-")), "notes.txt");
  fs.writeFileSync(notes, `${"가".repeat(600)}\n`);

  const result = await run(
    baseArgs(withNotes, makeAab(), ["--notes-language", "ko-KR", "--notes-file", notes]),
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const release = jsonBody(find(withNotes.calls, "tracks")).releases[0];
  assert.equal(release.releaseNotes.length, 1);
  assert.equal(release.releaseNotes[0].language, "ko-KR");
  assert.equal(release.releaseNotes[0].text.length, 500);

  // 언어를 안 넘기면 아예 넣지 않는다 — 스토어 등록 정보에 없는 언어를 보내면 Play 가 거절한다.
  const without = await startPlay();
  t.after(() => without.close());

  const plain = await run(baseArgs(without, makeAab()));
  assert.equal(plain.status, 0);
  assert.equal(jsonBody(find(without.calls, "tracks")).releases[0].releaseNotes, undefined);
  assert.match(plain.stdout, /릴리스 노트는 넣지 않는다/);
});

test("자동 심사 전송이 막히면 changesNotSentForReview 로 다시 커밋한다", async (t) => {
  let attempts = 0;
  // 첫 커밋만 Play 가 실제로 내놓는 메시지로 거절한다.
  const play = await startPlay({
    get commit() {
      attempts += 1;
      if (attempts > 1) return { body: { id: EDIT_ID } };
      return {
        status: 400,
        body: {
          error: {
            code: 400,
            message:
              "Changes cannot be sent for review automatically. Please set the query parameter changesNotSentForReview to true.",
          },
        },
      };
    },
  });
  t.after(() => play.close());

  const result = await run(baseArgs(play, makeAab()));
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const commits = play.calls.filter((call) => call.step === "commit");
  assert.equal(commits.length, 2);
  assert.ok(!commits[0].url.includes("changesNotSentForReview"), commits[0].url);
  assert.match(commits[1].url, /changesNotSentForReview=true/);
  assert.match(result.stdout, /::warning::/);
});

test("versionCode 가 --build 와 다르면 커밋하지 않고 죽는다", async (t) => {
  const play = await startPlay({ upload: { body: { versionCode: 1 } } });
  t.after(() => play.close());

  const result = await run(baseArgs(play, makeAab()));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /::error::/);
  assert.match(result.stdout, /set-native-version/);
  // 트랙까지 가지 않고, 열어 둔 편집은 되돌린다.
  assert.deepEqual(steps(play.calls), ["token", "insert", "upload", "delete"]);
});

test("Play 가 거절하면 응답 본문을 그대로 남기고 죽는다", async (t) => {
  const play = await startPlay({
    insert: { status: 403, body: { error: { code: 403, message: "The caller does not have permission" } } },
  });
  t.after(() => play.close());

  const result = await run(baseArgs(play, makeAab()));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /HTTP 403/);
  assert.match(result.stdout, /does not have permission/);
});

test("트랙 갱신이 실패하면 편집을 되돌린다", async (t) => {
  const play = await startPlay({ tracks: { status: 404, body: { error: { message: "Track not found." } } } });
  t.after(() => play.close());

  const result = await run(baseArgs(play, makeAab()));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Track not found/);
  assert.deepEqual(steps(play.calls), ["token", "insert", "upload", "tracks", "delete"]);
});

test("서비스 계정 키가 없거나 깨졌으면 요청을 시작하지도 않는다", async (t) => {
  const play = await startPlay();
  t.after(() => play.close());
  const aab = makeAab();

  const empty = await run(baseArgs(play, aab), { PLAY_SERVICE_ACCOUNT_JSON: "" });
  assert.equal(empty.status, 1);
  assert.match(empty.stdout, /PLAY_SERVICE_ACCOUNT_JSON/);

  const notJson = await run(baseArgs(play, aab), { PLAY_SERVICE_ACCOUNT_JSON: "not json" });
  assert.equal(notJson.status, 1);
  assert.match(notJson.stdout, /JSON/);

  const noKey = await run(baseArgs(play, aab), {
    PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify({ ...serviceAccount, private_key: undefined }),
  });
  assert.equal(noKey.status, 1);

  // base64 가 한 번 더 씌워지거나 줄바꿈이 깨진 키 — 진짜 서버에서는 invalid_grant 로만 보인다.
  const brokenPem = await run(baseArgs(play, aab), {
    PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify({ ...serviceAccount, private_key: "LS0tLS1CRUdJTiBQ" }),
  });
  assert.equal(brokenPem.status, 1);
  assert.match(brokenPem.stdout, /PEM/);

  assert.deepEqual(play.calls, [], "키가 잘못됐는데 Play 를 부르면 안 된다");
});

test("인자 형식을 검사한다", async (t) => {
  const play = await startPlay();
  t.after(() => play.close());
  const aab = makeAab();

  const cases = [
    ["--aab", "/없는/파일.aab", "--package", PACKAGE, "--track", "internal", "--version", "1.2.3", "--build", BUILD],
    ["--aab", aab, "--package", "packer", "--track", "internal", "--version", "1.2.3", "--build", BUILD],
    ["--aab", aab, "--package", PACKAGE, "--track", "", "--version", "1.2.3", "--build", BUILD],
    ["--aab", aab, "--package", PACKAGE, "--track", "internal", "--version", "v1.2.3", "--build", BUILD],
    ["--aab", aab, "--package", PACKAGE, "--track", "internal", "--version", "1.2.3", "--build", "0"],
    ["--aab", aab, "--package", PACKAGE, "--track", "internal", "--version", "1.2.3", "--build", "abc"],
    // 노트 파일만 주고 언어를 안 주면 어떤 언어로 올릴지 알 수 없다.
    ["--aab", aab, "--package", PACKAGE, "--track", "internal", "--version", "1.2.3", "--build", BUILD,
      "--notes-file", aab],
  ];

  for (const args of cases) {
    const result = await run([...args, "--token-url", `${play.url}/token`, "--api-base", play.url]);
    assert.equal(result.status, 1, `이 인자는 거부해야 한다: ${args.join(" ")}`);
    assert.match(result.stdout, /사용법/);
  }

  assert.deepEqual(play.calls, [], "인자가 틀렸는데 Play 를 부르면 안 된다");
});
