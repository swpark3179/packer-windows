// set-native-version.mjs 의 앵커 정규식을 못박아 둔다.
//
// 이 스크립트는 **생성된** 파일을 고친다. Capacitor 가 템플릿을 바꾸면 정규식이 조용히 빗나가고,
// 그러면 릴리스가 1.0 (1) 로 빌드돼 두 번째 TestFlight 업로드에서야 터진다. 원인이 여기라는 걸
// 그때 알아내기는 어렵다. 그래서 스크립트를 실제 CLI 로 돌려 종료 코드까지 확인한다 —
// 워크플로가 의지하는 계약이 정확히 그것이다.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const mobileRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = path.join(mobileRoot, "scripts", "set-native-version.mjs");

// `cap add android` 가 내놓는 build.gradle 의 관련 부분.
const GRADLE = `apply plugin: 'com.android.application'

android {
    namespace "org.packer.scanner"
    compileSdk rootProject.ext.compileSdkVersion
    defaultConfig {
        applicationId "org.packer.scanner"
        minSdkVersion rootProject.ext.minSdkVersion
        targetSdkVersion rootProject.ext.targetSdkVersion
        versionCode 1
        versionName "1.0"
        testInstrumentationRunner "androidx.test.runner.AndroidJUnitRunner"
    }
    buildTypes {
        release {
            minifyEnabled false
        }
    }
}
`;

/** @param {string} short CFBundleShortVersionString 값 @param {string} full CFBundleVersion 값 */
const plistWith = (short, full) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleShortVersionString</key>
	<string>${short}</string>
	<key>CFBundleVersion</key>
	<string>${full}</string>
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
 * @param {{ gradle?: string, plist?: string }} files 넣을 파일 (빠뜨리면 그 플랫폼은 없는 셈)
 */
function makeProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "set-native-version-"));
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.copyFileSync(script, path.join(dir, "scripts", "set-native-version.mjs"));

  if (files.gradle !== undefined) {
    fs.mkdirSync(path.join(dir, "android", "app"), { recursive: true });
    fs.writeFileSync(path.join(dir, "android", "app", "build.gradle"), files.gradle);
  }
  if (files.plist !== undefined) {
    fs.mkdirSync(path.join(dir, "ios", "App", "App"), { recursive: true });
    fs.writeFileSync(path.join(dir, "ios", "App", "App", "Info.plist"), files.plist);
  }

  return {
    dir,
    run: (...args) =>
      spawnSync(process.execPath, [path.join(dir, "scripts", "set-native-version.mjs"), ...args], {
        encoding: "utf8",
      }),
    gradle: () => fs.readFileSync(path.join(dir, "android", "app", "build.gradle"), "utf8"),
    plist: () => fs.readFileSync(path.join(dir, "ios", "App", "App", "Info.plist"), "utf8"),
  };
}

test("빌드 설정 참조로 나온 판본에 버전과 빌드 번호를 넣는다", () => {
  const project = makeProject({
    gradle: GRADLE,
    plist: plistWith("$(MARKETING_VERSION)", "$(CURRENT_PROJECT_VERSION)"),
  });

  const result = project.run("--version", "1.4.2", "--build", "37");
  assert.equal(result.status, 0, result.stdout + result.stderr);

  assert.match(project.gradle(), /versionCode 37\n/);
  assert.match(project.gradle(), /versionName "1\.4\.2"/);
  assert.match(project.plist(), /<key>CFBundleShortVersionString<\/key>\s*<string>1\.4\.2<\/string>/);
  assert.match(project.plist(), /<key>CFBundleVersion<\/key>\s*<string>37<\/string>/);
});

test("리터럴로 나온 판본에도 똑같이 들어간다", () => {
  const project = makeProject({ gradle: GRADLE, plist: plistWith("1.0", "1") });

  assert.equal(project.run("--version", "2.0.0", "--build", "5").status, 0);
  assert.match(project.plist(), /<key>CFBundleShortVersionString<\/key>\s*<string>2\.0\.0<\/string>/);
  assert.match(project.plist(), /<key>CFBundleVersion<\/key>\s*<string>5<\/string>/);
});

test("versionName 을 바꿔도 다른 문자열은 건드리지 않는다", () => {
  const project = makeProject({ gradle: GRADLE });

  assert.equal(project.run("--version", "9.9.9", "--build", "1").status, 0);
  const gradle = project.gradle();
  assert.match(gradle, /applicationId "org\.packer\.scanner"/);
  assert.match(gradle, /testInstrumentationRunner "androidx\.test\.runner\.AndroidJUnitRunner"/);
  assert.match(gradle, /minifyEnabled false/);
});

test("두 번 돌려도 결과가 같다", () => {
  const project = makeProject({ gradle: GRADLE, plist: plistWith("1.0", "1") });

  assert.equal(project.run("--version", "3.1.4", "--build", "12").status, 0);
  const afterFirst = [project.gradle(), project.plist()];

  const second = project.run("--version", "3.1.4", "--build", "12");
  assert.equal(second.status, 0);
  assert.deepEqual([project.gradle(), project.plist()], afterFirst);
  assert.match(second.stdout, /이미/);
});

test("한쪽 플랫폼만 있어도 성공한다", () => {
  const androidOnly = makeProject({ gradle: GRADLE });
  const androidResult = androidOnly.run("--version", "1.0.1", "--build", "2");
  assert.equal(androidResult.status, 0);
  assert.match(androidResult.stdout, /ios\/ 없음/);

  const iosOnly = makeProject({ plist: plistWith("1.0", "1") });
  const iosResult = iosOnly.run("--version", "1.0.1", "--build", "2");
  assert.equal(iosResult.status, 0);
  assert.match(iosResult.stdout, /android\/ 없음/);
});

test("바꿀 자리가 없으면 죽는다", () => {
  // versionCode·versionName 이 빠진 build.gradle — 템플릿이 바뀐 상황을 흉내낸다.
  const project = makeProject({ gradle: GRADLE.replace(/\s*versionCode 1\n\s*versionName "1\.0"\n/, "\n") });

  const result = project.run("--version", "1.0.1", "--build", "2");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /::error::/);
});

test("네이티브 프로젝트가 하나도 없으면 죽는다", () => {
  const result = makeProject({}).run("--version", "1.0.1", "--build", "2");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /::error::/);
});

test("버전·빌드 번호 형식을 검사한다", () => {
  const project = makeProject({ gradle: GRADLE });

  for (const args of [
    ["--version", "v1.0.1", "--build", "2"],
    ["--version", "1.0", "--build", "2"],
    ["--version", "1.0.1", "--build", "0"],
    ["--version", "1.0.1", "--build", "abc"],
    ["--version", "1.0.1"],
    ["--build", "2"],
  ]) {
    const result = project.run(...args);
    assert.equal(result.status, 1, `이 인자는 거부해야 한다: ${args.join(" ")}`);
  }

  // 인자가 틀렸으면 파일을 건드리지 않았어야 한다.
  assert.match(project.gradle(), /versionCode 1\n/);
});
