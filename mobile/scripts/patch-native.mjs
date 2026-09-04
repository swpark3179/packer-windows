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

// ---------------------------------------------------------------- iOS

const plist = path.join(root, "ios", "App", "App", "Info.plist");
const podfile = path.join(root, "ios", "App", "Podfile");
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

if (fs.existsSync(podfile)) {
  console.log(`ios (${rel(podfile)})`);
  // 플러그인이 iOS 15.5 이상을 요구한다. 템플릿은 15.0 으로 나온다.
  ensure(podfile, "deployment target 15.5", "platform :ios, '15.5'", (content) =>
    content.replace(/platform :ios, '[\d.]+'/, "platform :ios, '15.5'"),
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
