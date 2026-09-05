// iOS 네이티브 프로젝트를 만든다 (= `npm run add:ios`).
//
//   node scripts/add-ios.mjs
//
// `cap add ios` 한 줄로 끝나지 않는 이유가 두 가지 있다.
//
// (1) 배포 타깃 — `cap add ios` 는 프로젝트를 만든 **뒤 곧바로** `pod install` 까지 돌린다.
//     그런데 템플릿 Podfile 은 `platform :ios, '15.0'` 이고, 스캐너 플러그인이 끌어오는
//     GoogleMLKit 8.0.0 은 15.5 이상을 요구한다. 그래서 첫 `pod install` 은 반드시 실패한다:
//
//       [!] CocoaPods could not find compatible versions for pod "GoogleMLKit/BarcodeScanning":
//           ... they required a higher minimum deployment target.
//
//     배포 타깃을 올리는 patch-native.mjs 는 `cap add` **뒤에**만 돌 수 있다 — Podfile 이 그때
//     생기기 때문이다. 그러니 순서가 이렇게 될 수밖에 없다:
//
//       1) cap add ios --packagemanager cocoapods   프로젝트 생성 (pod install 은 실패할 수 있다)
//       2) patch-native.mjs                         Podfile·Xcode 프로젝트 배포 타깃을 올린다
//       3) cap sync ios                             pod install 을 다시 — 이번엔 풀린다
//
// (2) 조용한 실패 — 3) 을 빼면 안 된다. `cap add` 가 pod install 에서 죽으면 그 **뒤에** 오는 일이
//     통째로 건너뛰어지는데, 그 중에 `ios/App/App/capacitor.config.json` 의 `packageClassList`
//     가 있다. Capacitor 8 은 이 목록으로 iOS 플러그인을 등록한다. 비어 있으면 빌드는 성공하고
//     앱도 켜지는데 스캔·햅틱·파일 저장이 전부 조용히 죽는다 — SPM 함정과 증상이 똑같다.
//     3) 의 `cap sync` 가 copy·update 를 통째로 다시 돌려 이 목록을 채우고, 마지막에 확인한다.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const iosDir = path.join(root, "ios");
const podfile = path.join(iosDir, "App", "Podfile");
const nativeConfig = path.join(iosDir, "App", "App", "capacitor.config.json");

/** @param {string} message */
function fail(message) {
  console.log(`::error::${message}`);
  process.exit(1);
}

/**
 * 하위 명령을 출력 그대로 물려받아 돌린다.
 *
 * @param {string} command 실행 파일
 * @param {string[]} args 인자
 * @returns {number} 종료 코드
 */
function run(command, args) {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    // 윈도우에서 `npx` 는 `npx.cmd` 라 셸 없이는 실행되지 않는다.
    shell: process.platform === "win32",
  });
  if (result.error) {
    fail(`${command} 을(를) 실행하지 못했습니다: ${result.error.message}`);
  }
  return result.status ?? 1;
}

// `cap add` 는 이미 있는 플랫폼을 덮어쓰지 않고 죽는다. 여기서 먼저 막아 두면 아래에서 "Podfile 이
// 있으니 pod install 만 실패한 것" 으로 잘못 읽는 일이 없다.
if (fs.existsSync(iosDir)) {
  fail("ios/ 가 이미 있습니다. 다시 만들려면 먼저 지우세요:  rm -rf mobile/ios");
}

// 1) 생성. pod install 에서 죽는 것은 위 (1) 의 이유로 예상된 일이라 여기서 멈추지 않는다.
//    다만 Podfile 조차 없다면 pod install 이전에 죽은 것이니 그대로 실패로 본다.
const added = run("npx", ["cap", "add", "ios", "--packagemanager", "cocoapods"]);
if (added !== 0) {
  if (!fs.existsSync(podfile)) {
    fail("`cap add ios` 가 iOS 프로젝트를 만들지 못했습니다. 위 로그를 확인하세요.");
  }
  console.log(
    "\n`cap add ios` 가 pod install 에서 멈췄습니다. 템플릿 Podfile 의 배포 타깃이 15.0 이라 예상된\n" +
      "일입니다 — 배포 타깃을 올리고 다시 시도합니다.",
  );
}

// 2) 배포 타깃·카메라 권한 설명 등 필수 설정.
if (run(process.execPath, [path.join(root, "scripts", "patch-native.mjs")]) !== 0) {
  fail("patch-native.mjs 가 실패했습니다. 위 로그를 확인하세요.");
}

// 3) 이번 pod install 은 15.5 로 풀린다. 1) 에서 건너뛴 일도 여기서 함께 채워진다.
if (run("npx", ["cap", "sync", "ios"]) !== 0) {
  fail("`cap sync ios` 가 실패했습니다. 위 로그를 확인하세요.");
}

// 위 (2) 의 조용한 실패를 여기서 잡는다. 맥이 아니면 pod install 자체가 건너뛰어지지만
// (`cap sync` 가 경고만 남기고 넘어간다), 이 목록은 pod 와 무관하게 채워져야 한다.
let packageClassList;
try {
  packageClassList = JSON.parse(fs.readFileSync(nativeConfig, "utf8")).packageClassList;
} catch (error) {
  fail(`${path.relative(root, nativeConfig)} 을(를) 읽지 못했습니다: ${error.message}`);
}
if (!Array.isArray(packageClassList) || packageClassList.length === 0) {
  fail(
    "플러그인 목록(packageClassList)이 비어 있습니다. 이대로 빌드하면 앱은 켜지지만 스캔·파일 저장이 " +
      "동작하지 않습니다. 위 `cap sync ios` 로그를 확인하세요.",
  );
}

console.log(`\niOS 프로젝트를 만들었습니다. 등록된 플러그인: ${packageClassList.join(", ")}`);
