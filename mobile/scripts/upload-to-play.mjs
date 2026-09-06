// 서명된 AAB 를 Google Play 에 올린다. 의존성 없이 Play Developer API 를 직접 부른다.
//
//   PLAY_SERVICE_ACCOUNT_JSON="$(cat key.json)" node scripts/upload-to-play.mjs \
//     --aab dist/app.aab --package org.packer.scanner --track internal \
//     --version 0.1.2 --build 42
//
// 왜 직접 부르나: fastlane 도, 서드파티 액션도 쓰지 않는다. 이 워크플로가 Play 에 시키는 일은
// "번들 하나를 올리고 트랙 하나를 갱신한다" 뿐이라 API 호출 다섯 번이면 끝난다. 배포 자격
// 증명을 다루는 자리라 남의 코드를 끼우지 않는 편이 낫고, 실패했을 때 읽을 로그도 우리 것이다.
//
// API 는 '편집(edit)' 단위로 움직인다. 편집을 하나 열고, 그 안에 번들을 올리고, 트랙을 갱신한
// 다음, 커밋해야 실제로 반영된다. 커밋하지 않은 편집은 7일 뒤 저절로 사라지므로, 중간에 죽으면
// Play 쪽에는 아무것도 남지 않는다 (그래도 지저분하니 실패 시 지우고 나간다).
//
//   1. 서비스 계정 키로 JWT 를 만들어 액세스 토큰으로 바꾼다
//   2. edits.insert          — 편집을 연다
//   3. edits.bundles.upload  — AAB 를 올린다 (versionCode 를 돌려준다)
//   4. edits.tracks.update   — 그 versionCode 를 트랙에 올린다
//   5. edits.commit          — 반영한다 (--validate-only 면 edits.validate 까지만)
//
// **첫 릴리스는 이 스크립트로 못 올린다.** Play Console 에서 앱을 만들고 AAB 를 한 번 손으로
// 올려야 API 가 그 패키지 이름을 알아본다. 자세한 절차는 mobile/RELEASE.md 에 있다.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_API_BASE = "https://androidpublisher.googleapis.com";

// 업로드는 수십 MB 를 밀어 넣으므로 넉넉히 준다. 나머지는 응답만 받으면 끝이라 짧게 잡는다.
// 타임아웃이 없으면 멈춘 연결 하나가 잡 전체의 제한 시간을 다 태운다.
const UPLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const CALL_TIMEOUT_MS = 60 * 1000;

/** @param {string} message */
function fail(message) {
  console.log(`::error::${message}`);
  process.exit(1);
}

function usage(message) {
  console.log(`::error::${message}`);
  console.log("");
  console.log("사용법: node scripts/upload-to-play.mjs --aab <파일> --package <패키지> \\");
  console.log("          --track <internal|alpha|beta|production> --version <X.Y.Z> --build <정수>");
  console.log("        [--notes-language <ko-KR>] [--notes-file <파일>] [--validate-only]");
  console.log("");
  console.log("서비스 계정 키는 환경 변수 PLAY_SERVICE_ACCOUNT_JSON 으로 넘긴다 (JSON 그대로).");
  process.exit(1);
}

/**
 * `--이름 값` 꼴로 넘어온 인자를 읽는다.
 *
 * @param {string} name 앞의 `--` 를 뗀 이름
 * @returns {string} 값 (없으면 빈 문자열)
 */
function readArg(name) {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1) return "";
  return `${process.argv[at + 1] ?? ""}`;
}

const args = {
  aab: readArg("aab").trim(),
  packageName: readArg("package").trim(),
  track: readArg("track").trim(),
  version: readArg("version").trim(),
  build: readArg("build").trim(),
  notesLanguage: readArg("notes-language").trim(),
  notesFile: readArg("notes-file").trim(),
  validateOnly: process.argv.includes("--validate-only"),
  // 테스트가 가짜 서버를 물리는 자리다. 평소에는 넘기지 않는다.
  tokenUrl: readArg("token-url").trim(),
  apiBase: readArg("api-base").trim() || DEFAULT_API_BASE,
};

if (!args.aab) usage("--aab 가 없습니다.");
if (!fs.existsSync(args.aab)) usage(`--aab 파일이 없습니다: '${args.aab}'`);
if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(args.packageName)) {
  usage(`--package 가 안드로이드 패키지 이름 형식이 아닙니다: '${args.packageName}'`);
}
// 트랙 이름은 목록으로 못박지 않는다 — Play 는 이름을 직접 지은 비공개 테스트 트랙도 받는다.
// 없는 트랙을 넘기면 tracks.update 가 404 로 분명하게 알려 준다.
if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(args.track)) {
  usage(`--track 이 트랙 이름 형식이 아닙니다: '${args.track}'`);
}
if (!/^\d+\.\d+\.\d+$/.test(args.version)) {
  usage(`--version 이 X.Y.Z 형식이 아닙니다: '${args.version}'`);
}
if (!/^\d+$/.test(args.build) || Number(args.build) < 1) {
  usage(`--build 가 1 이상의 정수가 아닙니다: '${args.build}'`);
}
if (args.notesFile && !args.notesLanguage) {
  usage("--notes-file 을 쓰려면 --notes-language 도 같이 넘겨야 합니다 (예: ko-KR).");
}
if (args.notesLanguage && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(args.notesLanguage)) {
  usage(`--notes-language 가 언어 코드 형식이 아닙니다: '${args.notesLanguage}'`);
}

// ---------------------------------------------------------------- 서비스 계정 키

const rawKey = process.env.PLAY_SERVICE_ACCOUNT_JSON ?? "";
if (!rawKey.trim()) {
  fail("환경 변수 PLAY_SERVICE_ACCOUNT_JSON 이 비어 있습니다. mobile/RELEASE.md 의 준비 절차를 확인하세요.");
}

let key;
try {
  key = JSON.parse(rawKey);
} catch (error) {
  fail(`PLAY_SERVICE_ACCOUNT_JSON 을 JSON 으로 읽지 못했습니다: ${error.message}`);
}
if (!key.client_email || !key.private_key) {
  fail("서비스 계정 키에 client_email 또는 private_key 가 없습니다. Play Console 이 아니라 Google Cloud 에서 받은 **JSON 키** 여야 합니다.");
}
// base64 를 두 번 씌우거나 줄바꿈이 깨진 키를 여기서 잡는다. 그러지 않으면 서명 자체는 되고
// 토큰 요청이 `invalid_grant` 로 죽어서 원인을 찾기 어렵다.
if (!`${key.private_key}`.includes("BEGIN PRIVATE KEY")) {
  fail("서비스 계정 키의 private_key 가 PEM 이 아닙니다. secret 을 만들 때 값이 깨진 것 같습니다 (base64 는 줄바꿈 없이 한 줄로 만듭니다).");
}

const tokenUrl = args.tokenUrl || key.token_uri || DEFAULT_TOKEN_URL;

// ---------------------------------------------------------------- HTTP

const b64url = (value) => Buffer.from(value).toString("base64url");

/**
 * 요청을 보내고 JSON 을 돌려준다. 2xx 가 아니면 응답 본문을 그대로 실어 던진다 —
 * Play 의 오류 메시지는 대체로 그 자체가 조치 방법이라 가릴 이유가 없다.
 *
 * @param {string} what 사람이 읽을 단계 이름
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: any, timeout?: number }} options
 * @returns {Promise<any>} 응답 JSON (본문이 비어 있으면 빈 객체)
 */
async function call(what, url, options = {}) {
  const { method = "GET", headers = {}, body, timeout = CALL_TIMEOUT_MS } = options;

  let response;
  try {
    response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeout) });
  } catch (error) {
    throw new Error(`${what} 요청이 실패했습니다 (${url}): ${error.message}`);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${what} 이(가) HTTP ${response.status} 로 실패했습니다:\n${text.trim() || "(본문 없음)"}`);
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} 의 응답이 JSON 이 아닙니다:\n${text.slice(0, 500)}`);
  }
}

/** 서비스 계정 키로 서명한 JWT 를 액세스 토큰으로 바꾼다. */
async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  if (key.private_key_id) header.kid = key.private_key_id;
  // aud 는 반드시 토큰을 받으러 가는 그 주소여야 한다 — 다르면 토큰 서버가 서명을 거절한다.
  const claims = {
    iss: key.client_email,
    scope: SCOPE,
    aud: tokenUrl,
    iat: now,
    exp: now + 3600,
  };

  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  let signature;
  try {
    signature = crypto.createSign("RSA-SHA256").update(signingInput).sign(key.private_key);
  } catch (error) {
    throw new Error(`서비스 계정 키로 서명하지 못했습니다: ${error.message}`);
  }

  const form = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: `${signingInput}.${signature.toString("base64url")}`,
  });

  const token = await call("액세스 토큰 요청", tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!token.access_token) {
    throw new Error(`액세스 토큰이 응답에 없습니다: ${JSON.stringify(token).slice(0, 300)}`);
  }
  return token.access_token;
}

// ---------------------------------------------------------------- 본 작업

const editsUrl = `${args.apiBase}/androidpublisher/v3/applications/${encodeURIComponent(args.packageName)}/edits`;

/** 실패하더라도 진행을 막지 않는다 — 편집은 어차피 7일 뒤 사라진다. */
async function deleteEdit(auth, editId) {
  try {
    await call("편집 취소", `${editsUrl}/${encodeURIComponent(editId)}`, {
      method: "DELETE",
      headers: auth,
    });
    console.log(`  · 편집 ${editId} 을 취소했다.`);
  } catch (error) {
    console.log(`  · 편집 ${editId} 을 취소하지 못했다 (7일 뒤 저절로 사라진다): ${error.message}`);
  }
}

async function main() {
  console.log(`Play 업로드 — ${args.packageName} · ${args.version} (빌드 ${args.build}) · 트랙 ${args.track}`);

  const token = await getAccessToken();
  const auth = { authorization: `Bearer ${token}` };
  console.log(`  · 서비스 계정 ${key.client_email} 으로 인증했다.`);

  const edit = await call("편집 열기", editsUrl, { method: "POST", headers: auth });
  if (!edit.id) throw new Error(`편집 ID 가 응답에 없습니다: ${JSON.stringify(edit).slice(0, 300)}`);
  console.log(`  · 편집 ${edit.id} 을 열었다.`);

  try {
    const aab = fs.readFileSync(args.aab);
    const sizeMb = (aab.length / 1048576).toFixed(1);
    console.log(`  · ${path.basename(args.aab)} (${sizeMb} MB) 를 올리는 중…`);

    const uploaded = await call(
      "번들 업로드",
      `${args.apiBase}/upload/androidpublisher/v3/applications/${encodeURIComponent(args.packageName)}/edits/${encodeURIComponent(edit.id)}/bundles?uploadType=media`,
      {
        method: "POST",
        headers: { ...auth, "content-type": "application/octet-stream" },
        body: aab,
        timeout: UPLOAD_TIMEOUT_MS,
      },
    );

    const versionCode = `${uploaded.versionCode ?? ""}`;
    if (!versionCode) {
      throw new Error(`업로드 응답에 versionCode 가 없습니다: ${JSON.stringify(uploaded).slice(0, 300)}`);
    }
    // 여기가 `set-native-version.mjs` 가 제 일을 했는지 확인하는 마지막 관문이다. 어긋났다면
    // 빌드가 엉뚱한 versionCode 로 나온 것이고, 그대로 커밋하면 다음 릴리스의 번호까지 꼬인다.
    if (versionCode !== args.build) {
      throw new Error(
        `올라간 versionCode 가 ${versionCode} 인데 --build 는 ${args.build} 입니다. ` +
          "빌드 직전에 `scripts/set-native-version.mjs` 가 돌지 않았을 가능성이 큽니다.",
      );
    }
    console.log(`  · versionCode ${versionCode} 로 올라갔다.`);

    const release = {
      name: `${args.version} (${args.build})`,
      versionCodes: [versionCode],
      status: "completed",
    };
    if (args.notesLanguage) {
      const text = args.notesFile ? fs.readFileSync(args.notesFile, "utf8").trim() : `${args.version}`;
      // Play 는 500자를 넘는 릴리스 노트를 거절한다. 잘라서 올리는 편이 릴리스 전체를 실패시키는
      // 것보다 낫다 — 전체 변경 이력은 GitHub 릴리스에 그대로 남는다.
      release.releaseNotes = [{ language: args.notesLanguage, text: text.slice(0, 500) }];
    } else {
      console.log("  · 릴리스 노트는 넣지 않는다 (--notes-language 가 없다).");
    }

    await call("트랙 갱신", `${editsUrl}/${encodeURIComponent(edit.id)}/tracks/${encodeURIComponent(args.track)}`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ track: args.track, releases: [release] }),
    });
    console.log(`  · 트랙 '${args.track}' 을 versionCode ${versionCode} 로 맞췄다.`);

    if (args.validateOnly) {
      await call("편집 검증", `${editsUrl}/${encodeURIComponent(edit.id)}:validate`, {
        method: "POST",
        headers: auth,
      });
      console.log("  · 검증을 통과했다.");
      await deleteEdit(auth, edit.id);
      console.log("");
      console.log("검증만 했습니다 (upload_to_play 가 꺼져 있습니다). Play 에는 아무것도 반영되지 않았습니다.");
      return;
    }

    try {
      await call("편집 커밋", `${editsUrl}/${encodeURIComponent(edit.id)}:commit`, {
        method: "POST",
        headers: auth,
      });
    } catch (error) {
      // Play 는 계정·앱 상태에 따라 편집을 자동으로 심사에 보내지 못한다며 이 플래그를 요구한다.
      // 그때는 다시 커밋하되, 심사에 보내는 것은 사람이 해야 한다는 것을 분명히 남긴다.
      if (!/changesNotSentForReview/i.test(error.message)) throw error;
      console.log(`::warning::Play 가 이 편집을 자동으로 심사에 보내지 못한다고 답했습니다. changesNotSentForReview=true 로 다시 커밋합니다 — 반영은 되지만 **Play Console 에서 직접 '검토를 위해 전송'** 을 눌러야 배포가 시작됩니다.`);
      await call("편집 커밋 (changesNotSentForReview)", `${editsUrl}/${encodeURIComponent(edit.id)}:commit?changesNotSentForReview=true`, {
        method: "POST",
        headers: auth,
      });
    }

    console.log("");
    console.log(`Play 트랙 '${args.track}' 에 ${args.version} (빌드 ${args.build}) 을 반영했습니다.`);
    console.log("Play Console 에서 처리가 끝나기까지 몇 분 걸립니다.");
  } catch (error) {
    await deleteEdit(auth, edit.id);
    throw error;
  }
}

main().catch((error) => fail(error.message));
