// 네이티브 프로젝트에 꼭 필요한 설정을 넣는다. 몇 번 돌려도 결과가 같다.
//
//   node scripts/patch-native.mjs          넣는다
//   node scripts/patch-native.mjs --check   넣었는지만 확인한다 (CI 용, 고치지 않는다)
//
// `android/` 와 `ios/` 는 생성물이라 저장소에 없다. `npx cap add …` 로 다시 만들면 아래 설정이
// 전부 사라지는데, 증상이 고약하다 — iOS 는 카메라를 켜는 순간 그냥 죽고(`NSCameraUsageDescription`
// 없음), 안드로이드는 권한 요청이 조용히 거절된다. 그래서 `npm run sync` 가 `cap sync` 뒤에
// 이 스크립트를 자동으로 돌린다.
//
// 왜 플러그인이 알아서 해 주지 않나: `@capacitor-mlkit/barcode-scanning` 의 AndroidManifest 는
// 비어 있고, Capacitor 안드로이드 템플릿은 INTERNET 권한만 선언한다. 문서가 직접 넣으라고 한다.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const checkOnly = process.argv.includes("--check");

// GoogleMLKit 8.0.0 (`@capacitor-mlkit/barcode-scanning` 8.x 이 `~> 8.0.0` 으로 끌어온다) 의
// podspec 이 iOS 15.5 이상을 요구한다. Capacitor 8 템플릿은 Podfile 도 Xcode 프로젝트도 15.0 으로
// 나오므로, 그대로 두면 `pod install` 이 의존성을 풀지 못하고 죽는다:
//
//   [!] CocoaPods could not find compatible versions for pod "GoogleMLKit/BarcodeScanning":
//       ... Specs satisfying the `GoogleMLKit/BarcodeScanning (~> 8.0.0)` dependency were found,
//       but they required a higher minimum deployment target.
//
// Podfile 만 올리면 Pods 는 15.5 로, 앱 타겟은 15.0 으로 빌드된다. 앱이 자기 최소 버전보다 높은
// 프레임워크를 링크하는 꼴이라 15.0~15.4 기기에서 실행 중에 죽는다. 그래서 양쪽을 같이 올린다.
const IOS_DEPLOYMENT_TARGET = "15.5";

let changed = 0;
let missing = 0;
let skipped = 0;

const rel = (file) => path.relative(root, file);

function report(file, label, state) {
  const mark = { added: "넣었다", present: "이미 있다", missing: "없다" }[state];
  console.log(`  ${state === "missing" ? "✗" : "·"} ${label} — ${mark}`);
  if (state === "added") changed += 1;
  if (state === "missing") missing += 1;
}

/**
 * `needle` 이 없으면 `insert(content)` 로 고쳐 쓴다.
 *
 * @param {string} file 대상 파일
 * @param {string} label 사람이 읽을 이름
 * @param {string} needle 이미 적용됐는지 알아보는 표식
 * @param {(content: string) => string} insert
 */
function ensure(file, label, needle, insert) {
  const content = fs.readFileSync(file, "utf8");
  if (content.includes(needle)) {
    report(file, label, "present");
    return;
  }
  if (checkOnly) {
    report(file, label, "missing");
    return;
  }
  const next = insert(content);
  if (next === content) {
    // 끼워 넣을 자리를 못 찾았다. 조용히 넘어가면 나중에 런타임에서 터진다.
    console.log(`  ✗ ${label} — 끼워 넣을 자리를 찾지 못했다 (${rel(file)} 를 직접 고쳐야 한다)`);
    missing += 1;
    return;
  }
  fs.writeFileSync(file, next);
  report(file, label, "added");
}

/** `a` 가 `b` 보다 낮으면 음수. "15.10" 을 15.1 로 읽지 않도록 자리별로 비교한다. */
function compareVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * `re` 가 잡은 배포 타깃이 `minimum` 보다 낮으면 올린다. 이미 같거나 높으면 그대로 둔다 —
 * 템플릿이 언젠가 더 높은 값으로 나와도 끌어내리지 않는다.
 *
 * 정규식은 반드시 **세 덩어리**로, `g` 플래그를 붙여 잡는다 — (앞) (버전) (뒤). pbxproj 처럼
 * 같은 설정이 타겟·설정마다 여러 번 나오는 파일을 한 번에 고치기 위해서다.
 *
 * @param {string} file 대상 파일
 * @param {string} label 사람이 읽을 이름
 * @param {RegExp} re 버전을 세 덩어리로 잡는 정규식 (`g` 필요)
 * @param {string} minimum 최소 버전
 */
function ensureDeploymentTarget(file, label, re, minimum) {
  const content = fs.readFileSync(file, "utf8");
  const found = [...content.matchAll(re)];
  if (found.length === 0) {
    // 템플릿이 바뀌어 자리를 놓친 것이다. 조용히 넘어가면 pod install 이 원인을 알기 어려운
    // 메시지로 죽는다.
    console.log(`  ✗ ${label} — 바꿀 자리를 찾지 못했다 (${rel(file)} 의 템플릿이 바뀌었다)`);
    missing += 1;
    return;
  }
  if (found.every((match) => compareVersions(match[2], minimum) >= 0)) {
    report(file, label, "present");
    return;
  }
  if (checkOnly) {
    report(file, label, "missing");
    return;
  }
  const next = content.replace(re, (all, before, current, after) =>
    compareVersions(current, minimum) < 0 ? before + minimum + after : all,
  );
  fs.writeFileSync(file, next);
  report(file, label, "added");
}

// ---------------------------------------------------------------- 안드로이드

const manifest = path.join(root, "android", "app", "src", "main", "AndroidManifest.xml");

if (!fs.existsSync(manifest)) {
  console.log("android/ 없음 — `npx cap add android` 를 먼저 실행한다. 건너뛴다.");
  skipped += 1;
} else {
  console.log(`android (${rel(manifest)})`);

  ensure(
    manifest,
    "CAMERA 권한",
    "android.permission.CAMERA",
    (content) =>
      content.replace(
        /(\n\s*)(<application)/,
        `$1<uses-permission android:name="android.permission.CAMERA" />\n$1$2`,
      ),
  );

  // ML Kit 모델을 앱 설치 시점에 함께 내려받게 한다. 없으면 첫 스캔에서 모델을 기다린다.
  ensure(
    manifest,
    "ML Kit DEPENDENCIES meta-data",
    "com.google.mlkit.vision.DEPENDENCIES",
    (content) =>
      content.replace(
        /(\n(\s*)<\/application>)/,
        `\n$2    <meta-data android:name="com.google.mlkit.vision.DEPENDENCIES" android:value="barcode_ui" />$1`,
      ),
  );
}

// 공유 시트는 파일을 FileProvider 로만 넘긴다 (`SharePlugin.java` 의 `getUriForFile`). 우리는
// 캐시에 쓴 `.txt` 를 넘기므로 `<cache-path>` 가 선언돼 있어야 한다. 없으면 보내는 순간
//
//   IllegalArgumentException: Failed to find configured root that contains /data/.../cache/...
//
// 로 죽는다 — 빌드도 되고 앱도 켜지고 저장도 되는데 보내기만 안 되는, 찾기 어려운 실패다.
// Capacitor 8 템플릿에는 들어 있지만 `android/` 는 생성물이라 템플릿이 바뀌면 조용히 사라진다.
const filePaths = path.join(root, "android", "app", "src", "main", "res", "xml", "file_paths.xml");

if (fs.existsSync(filePaths)) {
  console.log(`android (${rel(filePaths)})`);
  ensure(
    filePaths,
    "공유용 FileProvider cache-path",
    "<cache-path",
    (content) =>
      content.replace(
        /(\n?(\s*)<\/paths>)/,
        `\n$2    <cache-path name="packer_cache" path="." />$1`,
      ),
  );
}

// ---------------------------------------------------------------- iOS

const plist = path.join(root, "ios", "App", "App", "Info.plist");
const podfile = path.join(root, "ios", "App", "Podfile");
const pbxproj = path.join(root, "ios", "App", "App.xcodeproj", "project.pbxproj");
const spmDir = path.join(root, "ios", "App", "CapApp-SPM");

// Capacitor 8 은 iOS 를 기본으로 **Swift Package Manager** 로 만든다. 그런데 스캐너 플러그인은
// `.podspec` 만 있고 `Package.swift` 가 없어서, SPM 프로젝트에는 **아무 말 없이 빠진다** —
// `Package.swift` 의 의존성 목록에 barcode-scanning 만 없고 빌드는 성공한다. 그래서 앱이 켜지고
// 카메라 버튼도 보이는데 스캔만 안 되는, 원인을 찾기 어려운 상태가 된다.
//
// 반드시 `npx cap add ios --packagemanager cocoapods` 로 만들어야 한다 (= `npm run add:ios`).
// 이 플래그는 capacitor.config.json 에 저장되지 않고, `ios/` 는 저장소에 없다. 그래서 다시
// 만들 때마다 놓칠 수 있어 여기서 소리 내어 막는다.
if (fs.existsSync(spmDir)) {
  console.log("ios (SPM 으로 만들어졌다)");
  console.log("  ✗ 이 프로젝트는 CocoaPods 로 만들어야 한다 — SPM 에는 QR 스캐너 플러그인이");
  console.log("    빠진 채로 빌드가 성공해서, 앱은 켜지지만 스캔이 되지 않는다.");
  console.log("    고치기:  rm -rf ios && npm run add:ios");
  missing += 1;
}

if (!fs.existsSync(plist)) {
  console.log("ios/ 없음 — `npx cap add ios` 를 먼저 실행한다. 건너뛴다.");
  skipped += 1;
} else {
  console.log(`ios (${rel(plist)})`);

  // 키 순서는 plist 에서 뜻이 없으므로 최상위 <dict> 바로 뒤에 넣는다 — 파일 끝의
  // `</dict>` 를 찾는 방식은 중첩 dict 가 마지막에 오면 엉뚱한 자리에 넣게 된다.
  const intoDict = (block) => (content) => content.replace(/(<dict>)/, `$1\n${block}`);

  ensure(
    plist,
    "NSCameraUsageDescription",
    "NSCameraUsageDescription",
    intoDict(
      "\t<key>NSCameraUsageDescription</key>\n" +
        "\t<string>PC 화면의 QR 코드를 읽어 하나의 텍스트로 합치기 위해 카메라를 사용합니다.</string>",
    ),
  );

  // 저장한 .txt 가 '파일' 앱에 보이려면 이 둘이 필요하다. 내보내기 수단이 파일 저장 하나뿐이니
  // 이게 빠지면 기능 자체가 성립하지 않는다 — 저장은 되는데 꺼낼 수 없다.
  ensure(
    plist,
    "UIFileSharingEnabled",
    "UIFileSharingEnabled",
    intoDict("\t<key>UIFileSharingEnabled</key>\n\t<true/>"),
  );
  ensure(
    plist,
    "LSSupportsOpeningDocumentsInPlace",
    "LSSupportsOpeningDocumentsInPlace",
    intoDict("\t<key>LSSupportsOpeningDocumentsInPlace</key>\n\t<true/>"),
  );
}

// Podfile 의 platform 줄은 pod 해석(resolution)에 쓰인다. 여기가 낮으면 pod install 이 아예
// 실패한다. `cap sync` 는 `def capacitor_pods` 블록과 `require_relative` 줄만 다시 쓰므로,
// 한 번 올려 두면 sync 를 몇 번 하든 15.5 로 남는다.
if (fs.existsSync(podfile)) {
  console.log(`ios (${rel(podfile)})`);
  ensureDeploymentTarget(
    podfile,
    `Podfile 배포 타깃 ${IOS_DEPLOYMENT_TARGET} 이상`,
    /(platform :ios, ')([\d.]+)(')/g,
    IOS_DEPLOYMENT_TARGET,
  );
}

// 앱 타겟도 같이 올린다. Podfile 만 올리면 Pods 는 15.5, 앱은 15.0 으로 빌드돼 15.0~15.4 기기에서
// 실행 중에 죽는다. `cap sync` 는 project.pbxproj 를 건드리지 않으니 한 번 넣으면 그대로 남는다.
if (fs.existsSync(pbxproj)) {
  console.log(`ios (${rel(pbxproj)})`);
  ensureDeploymentTarget(
    pbxproj,
    `IPHONEOS_DEPLOYMENT_TARGET ${IOS_DEPLOYMENT_TARGET} 이상`,
    /(IPHONEOS_DEPLOYMENT_TARGET = )([\d.]+)(;)/g,
    IOS_DEPLOYMENT_TARGET,
  );
}

// ---------------------------------------------------------------- 결과

console.log("");
if (missing > 0) {
  console.log(
    checkOnly
      ? `설정 ${missing}개가 빠져 있다. \`npm run sync\` 를 실행한다.`
      : `설정 ${missing}개를 넣지 못했다. 위 파일을 직접 확인한다.`,
  );
  process.exit(1);
}
if (skipped === 2) {
  console.log("네이티브 프로젝트가 없다. `npx cap add android` / `npx cap add ios` 를 먼저 실행한다.");
} else {
  console.log(changed > 0 ? `설정 ${changed}개를 넣었다.` : "네이티브 설정이 모두 갖춰져 있다.");
}
