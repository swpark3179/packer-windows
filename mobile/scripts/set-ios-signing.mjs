// iOS 앱 타겟에 수동 서명 설정을 넣는다 (= CI 의 `서명 설정 적용` 스텝). 몇 번 돌려도 결과가 같다.
//
//   node scripts/set-ios-signing.mjs --team ABCD123456 --profile "프로파일 이름"
//
// 왜 이 스크립트가 있나 — `xcodebuild` 의 명령줄 빌드 설정은 **워크스페이스의 모든 타겟**에
// 적용된다. 타겟을 골라 줄 방법이 없다. 그래서 예전처럼
//
//   xcodebuild archive … PROVISIONING_PROFILE_SPECIFIER="$PROFILE_NAME"
//
// 라고 쓰면 앱 타겟뿐 아니라 Pods 프로젝트의 모든 pod 타겟에도 같은 값이 박히고, 프레임워크·
// 정적 라이브러리 타겟은 프로파일을 품을 수 없으므로 빌드가 이렇게 죽는다:
//
//   error: nanopb does not support provisioning profiles. nanopb does not support provisioning
//   profiles, but provisioning profile … has been manually specified.
//   (in target 'nanopb' from project 'Pods')
//
// Podfile 의 `post_install` 로 pod 타겟 설정을 지워도 소용없다 — 명령줄 설정이 프로젝트 파일
// 설정보다 **우선**하기 때문이다. 그러니 명령줄에서 빼고, 서명 설정을 앱 타겟의 빌드 설정에
// 직접 넣는 수밖에 없다. 그게 이 스크립트다 (fastlane 의 `update_code_signing_settings` 와 같은 일).
//
// 앱 타겟에만 넣으면 pod 타겟들은 CocoaPods 가 만들어 준 기본값(`CODE_SIGN_IDENTITY[sdk=iphoneos*]`
// 을 빈 값으로 두어 빌드 중에는 서명하지 않는다)을 그대로 쓴다. pod 프레임워크의 서명은 앱 타겟의
// `[CP] Embed Pods Frameworks` 스크립트가 앱과 같은 신원으로 나중에 해 준다. 맥에서 Xcode 로 여는
// 것과 똑같은 경로다.
//
// 자리를 못 찾으면 조용히 넘어가지 않고 죽는다 — 넘어가면 `CODE_SIGN_STYLE = Automatic` 인 채로
// 아카이브가 돌아 "No signing certificate … found" 처럼 원인과 멀어진 메시지로 터진다.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// 아카이브가 `-configuration Release` 로 돌기 때문에 Release 만 고친다. Debug 를 건드리면 맥에서
// `npm run ios` 로 시뮬레이터에 띄울 때 배포 프로파일을 요구하게 된다.
const CONFIGURATION = "Release";

// 앱 타겟의 빌드 설정 블록을 알아보는 표식. 프로젝트 수준 블록에는 없고 앱 타겟에만 있다.
const APP_TARGET_MARKER = "INFOPLIST_FILE";

function usage(message) {
  console.log(`::error::${message}`);
  console.log("");
  console.log('사용법: node scripts/set-ios-signing.mjs --team <팀 ID> --profile <프로파일 이름> [--identity <신원>]');
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

const team = readArg("team").trim();
const profile = readArg("profile").trim();
// `--identity` 는 거의 언제나 기본값이라 워크플로가 넘기지 않는다. 다만 넘겼는데 비어 있으면
// 기본값으로 슬쩍 되돌리지 않고 죽는다 — 빈 값이 들어온 쪽을 고쳐야 한다.
const identity = process.argv.includes("--identity") ? readArg("identity").trim() : "Apple Distribution";

// 팀 ID 는 영숫자 10 자다. 여기서 막지 않으면 잘못된 값이 그대로 박혀서, 아카이브가
// `No profile for team 'XXXX' …` 라는 한 발 늦은 메시지로 죽는다.
if (!/^[A-Za-z0-9]{10}$/.test(team)) {
  usage(`--team 이 팀 ID(영숫자 10자) 형식이 아닙니다: '${team}'`);
}
// 프로파일 이름은 `.mobileprovision` 에서 꺼낸 값이라 공백도 들어온다. 비어 있는 것만 막는다.
if (!profile) {
  usage("--profile 이 비어 있습니다.");
}
if (!identity) {
  usage("--identity 가 비어 있습니다.");
}

const pbxproj = path.join(root, "ios", "App", "App.xcodeproj", "project.pbxproj");

if (!fs.existsSync(pbxproj)) {
  console.log("::error::ios/ 없음 — `npm run add:ios` 를 먼저 실행한다.");
  process.exit(1);
}

/**
 * pbxproj 의 값 표기법으로 감싼다. 영숫자와 `_.$/` 만 쓰인 값은 따옴표 없이 그대로 쓰고,
 * 그 밖(공백이 든 프로파일 이름 등)은 따옴표로 감싸며 `"` 와 `\` 를 이스케이프한다.
 *
 * @param {string} value 넣을 값
 * @returns {string} pbxproj 에 그대로 쓸 수 있는 표기
 */
function quote(value) {
  if (/^[A-Za-z0-9_.$/]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * `openAt` 의 `{` 와 짝이 되는 `}` 위치를 찾는다. 따옴표 안의 중괄호는 세지 않는다.
 *
 * @param {string} text 대상 문자열
 * @param {number} openAt 여는 중괄호 위치
 * @returns {number} 닫는 중괄호 위치 (못 찾으면 -1)
 */
function matchBrace(text, openAt) {
  let depth = 0;
  for (let i = openAt; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      i += 1;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * `configuration` 이름을 가진 앱 타겟의 `buildSettings` 본문 범위를 모두 찾는다.
 *
 * @param {string} content project.pbxproj 전체
 * @param {string} configuration 설정 이름 (`Release`)
 * @returns {{ start: number, end: number, body: string }[]} 앞에서부터 차례로
 */
function findAppTargetSettings(content, configuration) {
  const found = [];
  const marker = "isa = XCBuildConfiguration;";

  for (let at = content.indexOf(marker); at !== -1; at = content.indexOf(marker, at + 1)) {
    // 이 블록 안의 `buildSettings = {` 만 본다. 다음 XCBuildConfiguration 블록까지 넘어가면
    // 짝이 맞지 않는 범위를 잡게 되므로 거기서 멈춘다.
    const next = content.indexOf(marker, at + 1);
    const settingsAt = content.indexOf("buildSettings = {", at);
    if (settingsAt === -1 || (next !== -1 && settingsAt > next)) continue;

    const open = content.indexOf("{", settingsAt);
    const close = matchBrace(content, open);
    if (close === -1) continue;

    // 닫는 중괄호 뒤에 `name = Release;` 가 온다.
    const name = /\bname = ([^;\s]+);/.exec(content.slice(close, close + 200))?.[1];
    const body = content.slice(open + 1, close);
    if (name !== configuration || !body.includes(APP_TARGET_MARKER)) continue;

    found.push({ start: open + 1, end: close, body });
  }

  return found;
}

/**
 * 빌드 설정 본문에 `key = value;` 를 넣거나 이미 있는 값을 갈아 끼운다. `KEY[sdk=…]` 처럼
 * 조건이 붙은 판본이 있으면 그쪽도 같이 맞춘다 — 조건이 붙은 쪽이 우선하기 때문이다.
 *
 * @param {string} body `buildSettings = { … }` 안쪽
 * @param {string} key 설정 이름
 * @param {string} value 넣을 값 (따옴표는 이 함수가 붙인다)
 * @returns {{ body: string, was: string | null }} 고친 본문과 원래 값 (없었으면 null)
 */
function setSetting(body, key, value) {
  const indent = /\n([\t ]+)\S/.exec(body)?.[1] ?? "\t\t\t\t";
  const written = quote(value);
  const existing = new RegExp(`(\\n[\\t ]*${key}(?:\\[[^\\]]*\\])? = )([^;\\n]*)(;)`, "g");

  if (existing.test(body)) {
    let was = null;
    existing.lastIndex = 0;
    const next = body.replace(existing, (_all, before, old, after) => {
      was ??= old;
      return before + written + after;
    });
    return { body: next, was };
  }

  // 없으면 알파벳 순서를 지켜 끼워 넣는다. Xcode 가 그 순서로 쓰기 때문에, 나중에 사람이 열어
  // 저장해도 쓸데없는 차이가 생기지 않는다.
  const line = `${indent}${key} = ${written};`;
  const lines = body.split("\n");
  const at = lines.findIndex((text) => {
    const name = /^[\t ]*([A-Za-z0-9_]+)(?:\[[^\]]*\])? = /.exec(text)?.[1];
    return name !== undefined && name > key;
  });
  if (at === -1) lines.splice(lines.length - 1, 0, line);
  else lines.splice(at, 0, line);
  return { body: lines.join("\n"), was: null };
}

// ---------------------------------------------------------------- 적용

console.log(`ios (${path.relative(root, pbxproj)})`);

const content = fs.readFileSync(pbxproj, "utf8");
const blocks = findAppTargetSettings(content, CONFIGURATION);

if (blocks.length === 0) {
  console.log(
    `::error::앱 타겟의 ${CONFIGURATION} 빌드 설정을 찾지 못했다 (${APP_TARGET_MARKER} 가 든 ` +
      "XCBuildConfiguration 블록이 없다). Capacitor 템플릿이 바뀌었을 수 있다.",
  );
  process.exit(1);
}

const settings = [
  ["CODE_SIGN_STYLE", "Manual"],
  ["DEVELOPMENT_TEAM", team],
  ["CODE_SIGN_IDENTITY", identity],
  ["PROVISIONING_PROFILE_SPECIFIER", profile],
];

// 뒤에서부터 고쳐야 앞 블록의 위치가 밀리지 않는다.
let next = content;
for (const block of [...blocks].reverse()) {
  let body = block.body;
  for (const [key, value] of settings) {
    const result = setSetting(body, key, value);
    body = result.body;
  }
  next = next.slice(0, block.start) + body + next.slice(block.end);
}

for (const [key, value] of settings) {
  console.log(`  · ${key} = ${value}`);
}

if (next === content) {
  console.log(`\n앱 타겟 ${CONFIGURATION} 설정 ${blocks.length}곳이 이미 그 값이다.`);
} else {
  fs.writeFileSync(pbxproj, next);
  console.log(`\n앱 타겟 ${CONFIGURATION} 설정 ${blocks.length}곳에 수동 서명을 넣었다.`);
}
