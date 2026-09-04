// 네이티브 프로젝트에 릴리스 버전과 빌드 번호를 넣는다. 몇 번 돌려도 결과가 같다.
//
//   node scripts/set-native-version.mjs --version 0.1.1 --build 7
//
// 왜 필요한가: Capacitor 는 `package.json` 이나 `capacitor.config.json` 의 버전을 네이티브로 옮겨
// 주지 않는다. `npx cap add …` 가 만든 프로젝트는 언제나 안드로이드 `versionCode 1` ·
// `versionName "1.0"`, iOS `CFBundleShortVersionString`/`CFBundleVersion` = 1.0/1 로 나온다.
// `android/` 와 `ios/` 는 생성물이라 저장소에 없고 CI 가 매번 새로 만드니, 넣어 주지 않으면
// **모든 릴리스가 1.0 (1)** 이 된다. App Store Connect 는 이미 올라간 빌드 번호를 거부하므로
// 두 번째 TestFlight 업로드부터 통째로 막힌다.
//
// 이 스크립트가 하는 일은 그 한 가지다. 자리를 못 찾으면 조용히 넘어가지 않고 죽는다 —
// 넘어가면 빌드는 성공하고 업로드 단계에서야 터지는데, 그때는 원인이 여기라는 걸 알기 어렵다.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let changed = 0;
let missing = 0;
let skipped = 0;

const rel = (file) => path.relative(root, file);

function usage(message) {
  console.log(`::error::${message}`);
  console.log("");
  console.log("사용법: node scripts/set-native-version.mjs --version <X.Y.Z> --build <정수>");
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

const version = readArg("version").trim();
const build = readArg("build").trim();

// X.Y.Z 만 받는다. 워크플로가 계산한 값이라 여기서 틀릴 일은 없지만, 손으로 돌릴 때
// `--version v0.1.1` 처럼 넣으면 안드로이드 versionName 에 'v' 가 박혀 버린다.
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  usage(`--version 이 X.Y.Z 형식이 아닙니다: '${version}'`);
}
if (!/^\d+$/.test(build) || Number(build) < 1) {
  usage(`--build 가 1 이상의 정수가 아닙니다: '${build}'`);
}

/**
 * `re` 가 잡은 자리의 값을 `value` 로 바꿔 쓴다.
 *
 * 정규식은 반드시 **세 덩어리**로 잡아야 한다 — (앞) (바꿀 값) (뒤). 가운데만 갈아 끼우므로
 * 파일의 다른 부분은 건드리지 않고, 이미 그 값이면 다시 쓰지 않는다.
 *
 * @param {string} file 대상 파일
 * @param {string} label 사람이 읽을 이름
 * @param {RegExp} re 값을 세 덩어리로 잡는 정규식
 * @param {string} value 새 값
 */
function setValue(file, label, re, value) {
  const content = fs.readFileSync(file, "utf8");
  const found = re.exec(content);
  if (!found) {
    console.log(`  ✗ ${label} — 바꿀 자리를 찾지 못했다 (${rel(file)} 의 템플릿이 바뀌었다)`);
    missing += 1;
    return;
  }
  if (found[2] === value) {
    console.log(`  · ${label} — 이미 ${value}`);
    return;
  }
  fs.writeFileSync(file, content.replace(re, (_all, before, _old, after) => before + value + after));
  console.log(`  · ${label} — ${found[2] || "(빈 값)"} -> ${value}`);
  changed += 1;
}

// ---------------------------------------------------------------- 안드로이드

const gradle = path.join(root, "android", "app", "build.gradle");

if (!fs.existsSync(gradle)) {
  console.log("android/ 없음 — `npm run add:android` 를 먼저 실행한다. 건너뛴다.");
  skipped += 1;
} else {
  console.log(`android (${rel(gradle)})`);
  setValue(gradle, "versionCode", /(versionCode\s+)(\d+)(\s*\n)/, build);
  setValue(gradle, "versionName", /(versionName\s+")([^"]*)(")/, version);
}

// ---------------------------------------------------------------- iOS

const plist = path.join(root, "ios", "App", "App", "Info.plist");

if (!fs.existsSync(plist)) {
  console.log("ios/ 없음 — `npm run add:ios` 를 먼저 실행한다. 건너뛴다.");
  skipped += 1;
} else {
  console.log(`ios (${rel(plist)})`);

  // 템플릿은 이 두 값을 `$(MARKETING_VERSION)` · `$(CURRENT_PROJECT_VERSION)` 빌드 설정 참조로
  // 넣어 두지만, 리터럴로 박아 두는 판본도 있었다. 정규식은 `<string>` 안을 통째로 갈아 끼우니
  // 어느 쪽이든 결과가 같다. 리터럴로 확정해 두면 xcodebuild 인자가 빠져도 버전이 흔들리지 않는다.
  setValue(
    plist,
    "CFBundleShortVersionString",
    /(<key>CFBundleShortVersionString<\/key>\s*<string>)([^<]*)(<\/string>)/,
    version,
  );
  setValue(
    plist,
    "CFBundleVersion",
    /(<key>CFBundleVersion<\/key>\s*<string>)([^<]*)(<\/string>)/,
    build,
  );
}

// ---------------------------------------------------------------- 결과

console.log("");
if (missing > 0) {
  console.log(`::error::버전을 넣지 못한 자리가 ${missing}개 있다. 위 파일을 직접 확인한다.`);
  process.exit(1);
}
// patch-native.mjs 는 양쪽이 다 없으면 안내만 하고 성공으로 끝나지만, 여기서는 실패로 본다.
// 이 스크립트는 빌드 직전에만 돌고, 그 시점에 네이티브 프로젝트가 없다는 건 호출 순서가
// 잘못됐다는 뜻이다. 성공으로 넘기면 1.0 (1) 로 빌드된 결과물이 그대로 스토어까지 간다.
if (skipped === 2) {
  console.log("::error::네이티브 프로젝트가 하나도 없다. `npm run add:android` / `npm run add:ios` 를 먼저 실행한다.");
  process.exit(1);
}
console.log(changed > 0 ? `버전 ${version} (빌드 ${build}) 을 넣었다.` : `이미 버전 ${version} (빌드 ${build}) 이다.`);
