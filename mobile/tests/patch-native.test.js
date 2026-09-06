// patch-native.mjs 의 앵커를 못박아 둔다.
//
// set-native-version.test.js 와 같은 이유다 — 이 스크립트도 **생성된** 파일을 고치고, 빗나가면
// 증상이 늦게, 엉뚱한 자리에서 나타난다. 배포 타깃은 특히 그렇다: 낮으면 `pod install` 이
// "could not find compatible versions for pod GoogleMLKit/BarcodeScanning" 로 죽고, Podfile 만
// 올리고 앱 타겟을 빼먹으면 빌드는 되는데 15.0~15.4 기기에서 실행 중에 죽는다.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const mobileRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = path.join(mobileRoot, "scripts", "patch-native.mjs");

// `cap add android` 가 내놓는 AndroidManifest.xml (권한 선언은 INTERNET 하나뿐이다).
const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application
        android:allowBackup="true"
        android:label="@string/app_name">
        <activity android:name=".MainActivity" />
    </application>

    <uses-permission android:name="android.permission.INTERNET" />
</manifest>
`;

/// Capacitor 8 안드로이드 템플릿의 `res/xml/file_paths.xml` 그대로.
/// 공유 시트가 캐시의 파일을 넘기려면 `<cache-path>` 가 있어야 한다.
const FILE_PATHS = `<?xml version="1.0" encoding="utf-8"?>
<paths xmlns:android="http://schemas.android.com/apk/res/android">
    <external-path name="my_images" path="." />
    <cache-path name="my_cache_images" path="." />
</paths>
`;

/// 템플릿이 바뀌어 캐시 경로가 빠진 경우.
const FILE_PATHS_WITHOUT_CACHE = `<?xml version="1.0" encoding="utf-8"?>
<paths xmlns:android="http://schemas.android.com/apk/res/android">
    <external-path name="my_images" path="." />
</paths>
`;

// `cap add ios --packagemanager cocoapods` 가 내놓는 Podfile.
const podfileWith = (target) => `require_relative '../../node_modules/@capacitor/ios/scripts/pods_helpers'

platform :ios, '${target}'
use_frameworks!

def capacitor_pods
  pod 'Capacitor', :path => '../../node_modules/@capacitor/ios'
  pod 'CapacitorMlkitBarcodeScanning', :path => '../../node_modules/@capacitor-mlkit/barcode-scanning'
end

target 'App' do
  capacitor_pods
end

post_install do |installer|
  assertDeploymentTarget(installer)
end
`;

// project.pbxproj 는 타겟·설정마다 같은 키가 여러 번 나온다. 한 자리만 고치면 나머지가 남는다.
const pbxprojWith = (...targets) => `// !$*UTF8*$!
{
	objects = {
${targets
  .map(
    (target, index) => `		ABCDEF0${index} /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				IPHONEOS_DEPLOYMENT_TARGET = ${target};
				PRODUCT_BUNDLE_IDENTIFIER = org.packer.scanner;
			};
		};`,
  )
  .join("\n")}
	};
}
`;

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key>
	<string>Packer Scanner</string>
	<key>UILaunchStoryboardName</key>
	<string>LaunchScreen</string>
</dict>
</plist>
`;

/**
 * 스크립트를 돌릴 수 있는 가짜 mobile/ 디렉터리를 만든다.
 *
 * 스크립트는 자기 위치에서 루트를 거꾸로 계산하므로(`scripts/` 의 부모), 스크립트 자체를
 * 임시 디렉터리로 복사해야 그 안의 android/ · ios/ 를 보게 된다.
 *
 * @param {{ manifest?: string, filePaths?: string, plist?: string, podfile?: string,
 *          pbxproj?: string, spm?: boolean }} files
 */
function makeProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "patch-native-"));
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.copyFileSync(script, path.join(dir, "scripts", "patch-native.mjs"));

  const write = (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };

  const manifest = path.join(dir, "android", "app", "src", "main", "AndroidManifest.xml");
  const filePaths = path.join(dir, "android", "app", "src", "main", "res", "xml", "file_paths.xml");
  const plist = path.join(dir, "ios", "App", "App", "Info.plist");
  const podfile = path.join(dir, "ios", "App", "Podfile");
  const pbxproj = path.join(dir, "ios", "App", "App.xcodeproj", "project.pbxproj");

  if (files.manifest !== undefined) write(manifest, files.manifest);
  if (files.filePaths !== undefined) write(filePaths, files.filePaths);
  if (files.plist !== undefined) write(plist, files.plist);
  if (files.podfile !== undefined) write(podfile, files.podfile);
  if (files.pbxproj !== undefined) write(pbxproj, files.pbxproj);
  if (files.spm) fs.mkdirSync(path.join(dir, "ios", "App", "CapApp-SPM"), { recursive: true });

  return {
    dir,
    run: (...args) =>
      spawnSync(process.execPath, [path.join(dir, "scripts", "patch-native.mjs"), ...args], {
        encoding: "utf8",
      }),
    manifest: () => fs.readFileSync(manifest, "utf8"),
    filePaths: () => fs.readFileSync(filePaths, "utf8"),
    plist: () => fs.readFileSync(plist, "utf8"),
    podfile: () => fs.readFileSync(podfile, "utf8"),
    pbxproj: () => fs.readFileSync(pbxproj, "utf8"),
  };
}

/** iOS 프로젝트 한 벌 (배포 타깃은 템플릿 기본값인 15.0). */
const freshIOS = () => ({
  plist: PLIST,
  podfile: podfileWith("15.0"),
  pbxproj: pbxprojWith("15.0", "15.0", "15.0", "15.0"),
});

test("템플릿의 15.0 을 Podfile 과 Xcode 프로젝트 양쪽에서 올린다", () => {
  const project = makeProject(freshIOS());

  const result = project.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);

  assert.match(project.podfile(), /platform :ios, '15\.5'/);
  assert.equal(project.pbxproj().match(/IPHONEOS_DEPLOYMENT_TARGET = 15\.5;/g).length, 4);
  assert.doesNotMatch(project.pbxproj(), /IPHONEOS_DEPLOYMENT_TARGET = 15\.0;/);
  // 다른 설정은 건드리지 않는다.
  assert.match(project.pbxproj(), /PRODUCT_BUNDLE_IDENTIFIER = org\.packer\.scanner;/);
  assert.match(project.podfile(), /pod 'CapacitorMlkitBarcodeScanning'/);
});

test("이미 더 높은 배포 타깃은 끌어내리지 않는다", () => {
  const project = makeProject({
    ...freshIOS(),
    podfile: podfileWith("16.0"),
    pbxproj: pbxprojWith("16.0", "16.0"),
  });

  assert.equal(project.run().status, 0);
  assert.match(project.podfile(), /platform :ios, '16\.0'/);
  assert.doesNotMatch(project.pbxproj(), /15\.5/);
});

test("한 자리만 낮아도 그 자리를 올린다", () => {
  const project = makeProject({ ...freshIOS(), pbxproj: pbxprojWith("16.0", "15.0") });

  assert.equal(project.run().status, 0);
  assert.match(project.pbxproj(), /IPHONEOS_DEPLOYMENT_TARGET = 16\.0;/);
  assert.match(project.pbxproj(), /IPHONEOS_DEPLOYMENT_TARGET = 15\.5;/);
});

test("Info.plist 에 카메라·파일 공유 키를 넣는다", () => {
  const project = makeProject(freshIOS());

  assert.equal(project.run().status, 0);
  const plist = project.plist();
  assert.match(plist, /<key>NSCameraUsageDescription<\/key>\s*<string>[^<]+<\/string>/);
  assert.match(plist, /<key>UIFileSharingEnabled<\/key>\s*<true\/>/);
  assert.match(plist, /<key>LSSupportsOpeningDocumentsInPlace<\/key>\s*<true\/>/);
  // 원래 있던 키는 그대로다.
  assert.match(plist, /<key>UILaunchStoryboardName<\/key>/);
});

test("AndroidManifest 에 CAMERA 권한과 ML Kit meta-data 를 넣는다", () => {
  const project = makeProject({ manifest: MANIFEST });

  assert.equal(project.run().status, 0);
  const manifest = project.manifest();
  assert.match(manifest, /<uses-permission android:name="android\.permission\.CAMERA" \/>/);
  assert.match(manifest, /com\.google\.mlkit\.vision\.DEPENDENCIES/);
  assert.match(manifest, /android:value="barcode_ui"/);
  // meta-data 는 </application> 앞, 즉 application 안에 들어가야 한다.
  assert.ok(manifest.indexOf("DEPENDENCIES") < manifest.indexOf("</application>"));
});

test("템플릿에 이미 있는 공유용 cache-path 는 그대로 둔다", () => {
  const project = makeProject({ manifest: MANIFEST, filePaths: FILE_PATHS });

  const result = project.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(project.filePaths(), FILE_PATHS, "손대지 않아야 한다");
  assert.match(result.stdout, /공유용 FileProvider cache-path — 이미 있다/);
});

test("cache-path 가 빠져 있으면 넣는다", () => {
  // 없으면 보내기가 `Failed to find configured root` 로 죽는다 — 저장은 되는데 보내기만
  // 안 되는, 찾기 어려운 실패다.
  const project = makeProject({ manifest: MANIFEST, filePaths: FILE_PATHS_WITHOUT_CACHE });

  assert.equal(project.run().status, 0);
  const paths = project.filePaths();
  assert.match(paths, /<cache-path[^>]*path="\."/);
  assert.ok(paths.indexOf("<cache-path") < paths.indexOf("</paths>"), "paths 안에 들어가야 한다");
  // 원래 있던 항목은 그대로다.
  assert.match(paths, /<external-path name="my_images"/);
});

test("--check 는 빠진 cache-path 를 알리기만 하고 고치지 않는다", () => {
  const project = makeProject({ manifest: MANIFEST, filePaths: FILE_PATHS_WITHOUT_CACHE });

  const result = project.run("--check");
  assert.equal(result.status, 1);
  assert.equal(project.filePaths(), FILE_PATHS_WITHOUT_CACHE);
});

test("두 번 돌려도 결과가 같다", () => {
  const project = makeProject({
    manifest: MANIFEST,
    filePaths: FILE_PATHS_WITHOUT_CACHE,
    ...freshIOS(),
  });

  assert.equal(project.run().status, 0);
  const afterFirst = [
    project.manifest(),
    project.filePaths(),
    project.plist(),
    project.podfile(),
    project.pbxproj(),
  ];

  const second = project.run();
  assert.equal(second.status, 0);
  assert.deepEqual(
    [
      project.manifest(),
      project.filePaths(),
      project.plist(),
      project.podfile(),
      project.pbxproj(),
    ],
    afterFirst,
  );
  assert.match(second.stdout, /모두 갖춰져 있다/);
});

test("--check 는 고치지 않고, 빠진 게 있으면 죽는다", () => {
  const project = makeProject(freshIOS());

  const result = project.run("--check");
  assert.equal(result.status, 1);
  assert.match(project.podfile(), /platform :ios, '15\.0'/);
  assert.match(project.pbxproj(), /IPHONEOS_DEPLOYMENT_TARGET = 15\.0;/);
  assert.doesNotMatch(project.plist(), /NSCameraUsageDescription/);

  assert.equal(project.run().status, 0);
  assert.equal(project.run("--check").status, 0);
});

test("SPM 으로 만들어졌으면 죽는다", () => {
  const project = makeProject({ ...freshIOS(), spm: true });

  const result = project.run();
  assert.equal(result.status, 1);
  assert.match(result.stdout, /CocoaPods 로 만들어야 한다/);
});

test("바꿀 자리가 없으면 죽는다", () => {
  // platform 줄이 빠진 Podfile — 템플릿이 바뀐 상황을 흉내낸다.
  const project = makeProject({
    ...freshIOS(),
    podfile: podfileWith("15.0").replace(/platform :ios, '15\.0'\n/, ""),
  });

  const result = project.run();
  assert.equal(result.status, 1);
  assert.match(result.stdout, /바꿀 자리를 찾지 못했다/);
});

test("네이티브 프로젝트가 하나도 없으면 안내만 하고 성공한다", () => {
  const result = makeProject({}).run();
  assert.equal(result.status, 0);
  assert.match(result.stdout, /네이티브 프로젝트가 없다/);
});
