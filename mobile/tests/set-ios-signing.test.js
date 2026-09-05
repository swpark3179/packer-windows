// set-ios-signing.mjs 의 앵커를 못박아 둔다.
//
// 이 스크립트는 **생성된** project.pbxproj 를 고친다. Capacitor 가 템플릿을 바꾸면 앵커가
// 빗나가는데, 그때 조용히 넘어가면 앱 타겟이 `CODE_SIGN_STYLE = Automatic` 인 채로 아카이브에
// 들어가고 CI 는 서명과 상관없어 보이는 메시지로 죽는다. 그래서 실제 CLI 로 돌려 종료 코드까지
// 확인한다 — 워크플로가 의지하는 계약이 정확히 그것이다.
//
// 가장 중요한 계약은 마지막 두 가지다: **앱 타겟 Release 블록만** 고쳐야 한다. 프로젝트 수준이나
// Debug 까지 번지면 명령줄 빌드 설정을 걷어낸 의미가 없어진다.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const mobileRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = path.join(mobileRoot, "scripts", "set-ios-signing.mjs");

// `cap add ios --packagemanager cocoapods` 가 내놓는 project.pbxproj 의 관련 부분. 설정 이름과
// 들여쓰기(탭)를 템플릿 그대로 두었다 — 이 파일이 앵커의 기준이다.
const PBXPROJ = `// !$*UTF8*$!
{
	archiveVersion = 1;
	objectVersion = 46;
	objects = {

/* Begin XCBuildConfiguration section */
		504EC3141FED79650016851F /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				ALWAYS_SEARCH_USER_PATHS = NO;
				CODE_SIGN_IDENTITY = "iPhone Developer";
				GCC_PREPROCESSOR_DEFINITIONS = (
					"DEBUG=1",
					"$(inherited)",
				);
				IPHONEOS_DEPLOYMENT_TARGET = 15.5;
				SDKROOT = iphoneos;
			};
			name = Debug;
		};
		504EC3151FED79650016851F /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				ALWAYS_SEARCH_USER_PATHS = NO;
				CODE_SIGN_IDENTITY = "iPhone Developer";
				IPHONEOS_DEPLOYMENT_TARGET = 15.5;
				SDKROOT = iphoneos;
				VALIDATE_PRODUCT = YES;
			};
			name = Release;
		};
		504EC3171FED79650016851F /* Debug */ = {
			isa = XCBuildConfiguration;
			baseConfigurationReference = FC68EB0AF532CFC21C3344DD /* Pods-App.debug.xcconfig */;
			buildSettings = {
				ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;
				CODE_SIGN_STYLE = Automatic;
				CURRENT_PROJECT_VERSION = 1;
				INFOPLIST_FILE = App/Info.plist;
				IPHONEOS_DEPLOYMENT_TARGET = 15.5;
				MARKETING_VERSION = 1.0;
				OTHER_SWIFT_FLAGS = "$(inherited) \\"-D\\" \\"COCOAPODS\\" \\"-DDEBUG\\"";
				PRODUCT_BUNDLE_IDENTIFIER = org.packer.scanner;
				PRODUCT_NAME = "$(TARGET_NAME)";
				SWIFT_VERSION = 5.0;
				TARGETED_DEVICE_FAMILY = "1,2";
			};
			name = Debug;
		};
		504EC3181FED79650016851F /* Release */ = {
			isa = XCBuildConfiguration;
			baseConfigurationReference = AF51FD2D460BCFE21FA515B2 /* Pods-App.release.xcconfig */;
			buildSettings = {
				ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;
				CODE_SIGN_STYLE = Automatic;
				CURRENT_PROJECT_VERSION = 1;
				INFOPLIST_FILE = App/Info.plist;
				IPHONEOS_DEPLOYMENT_TARGET = 15.5;
				MARKETING_VERSION = 1.0;
				PRODUCT_BUNDLE_IDENTIFIER = org.packer.scanner;
				PRODUCT_NAME = "$(TARGET_NAME)";
				SWIFT_ACTIVE_COMPILATION_CONDITIONS = "";
				SWIFT_VERSION = 5.0;
				TARGETED_DEVICE_FAMILY = "1,2";
			};
			name = Release;
		};
/* End XCBuildConfiguration section */
	};
	rootObject = 504EC2FC1FED79650016851F /* Project object */;
}
`;

/**
 * 스크립트를 돌릴 수 있는 가짜 mobile/ 디렉터리를 만든다.
 *
 * 스크립트는 자기 위치에서 루트를 거꾸로 계산하므로(`scripts/` 의 부모), 스크립트 자체를
 * 임시 디렉터리로 복사해야 그 안의 ios/ 를 보게 된다.
 *
 * @param {string | null} pbxproj 넣을 project.pbxproj (`null` 이면 ios/ 가 없는 셈)
 */
function makeProject(pbxproj = PBXPROJ) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "set-ios-signing-"));
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.copyFileSync(script, path.join(dir, "scripts", "set-ios-signing.mjs"));

  const file = path.join(dir, "ios", "App", "App.xcodeproj", "project.pbxproj");
  if (pbxproj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, pbxproj);
  }

  return {
    dir,
    run: (...args) =>
      spawnSync(process.execPath, [path.join(dir, "scripts", "set-ios-signing.mjs"), ...args], {
        encoding: "utf8",
      }),
    pbxproj: () => fs.readFileSync(file, "utf8"),
  };
}

/**
 * `name = <이름>;` 으로 끝나는 XCBuildConfiguration 블록들을 통째로 꺼낸다.
 *
 * @param {string} content project.pbxproj 전체
 * @param {string} name 설정 이름 (`Debug` · `Release`)
 * @returns {string[]} 블록 본문들
 */
function blocks(content, name) {
  return [...content.matchAll(/isa = XCBuildConfiguration;([\s\S]*?)\n\t\t\tname = (\w+);/g)]
    .filter((match) => match[2] === name)
    .map((match) => match[1]);
}

test("앱 타겟 Release 에 수동 서명 설정을 넣는다", () => {
  const project = makeProject();

  const result = project.run("--team", "ABCD123456", "--profile", "Packer Scanner App Store");
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const [, appRelease] = blocks(project.pbxproj(), "Release");
  assert.match(appRelease, /\n\t{4}CODE_SIGN_STYLE = Manual;\n/);
  assert.match(appRelease, /\n\t{4}DEVELOPMENT_TEAM = ABCD123456;\n/);
  assert.match(appRelease, /\n\t{4}CODE_SIGN_IDENTITY = "Apple Distribution";\n/);
  assert.match(appRelease, /\n\t{4}PROVISIONING_PROFILE_SPECIFIER = "Packer Scanner App Store";\n/);
});

test("프로젝트 수준과 Debug 는 건드리지 않는다", () => {
  const project = makeProject();
  assert.equal(project.run("--team", "ABCD123456", "--profile", "packer").status, 0);
  const content = project.pbxproj();

  // 프로젝트 수준 Release 는 템플릿 그대로여야 한다. 여기까지 번지면 Pods 프로젝트와 무관하게
  // 앱 타겟 밖으로 새는 것이고, 명령줄 설정을 걷어낸 의미가 없다.
  const [projectRelease] = blocks(content, "Release");
  assert.match(projectRelease, /CODE_SIGN_IDENTITY = "iPhone Developer";/);
  assert.doesNotMatch(projectRelease, /PROVISIONING_PROFILE_SPECIFIER/);
  assert.doesNotMatch(projectRelease, /DEVELOPMENT_TEAM/);

  for (const debug of blocks(content, "Debug")) {
    assert.doesNotMatch(debug, /PROVISIONING_PROFILE_SPECIFIER/);
    assert.doesNotMatch(debug, /CODE_SIGN_STYLE = Manual;/);
  }
});

test("따옴표가 든 이름도 pbxproj 표기법으로 감싼다", () => {
  const project = makeProject();
  assert.equal(project.run("--team", "ABCD123456", "--profile", 'a "b" c').status, 0);
  assert.match(project.pbxproj(), /PROVISIONING_PROFILE_SPECIFIER = "a \\"b\\" c";/);
});

test("다른 설정과 구조는 그대로 남는다", () => {
  const project = makeProject();
  assert.equal(project.run("--team", "ABCD123456", "--profile", "packer").status, 0);
  const content = project.pbxproj();

  assert.match(content, /PRODUCT_BUNDLE_IDENTIFIER = org\.packer\.scanner;/);
  assert.match(content, /IPHONEOS_DEPLOYMENT_TARGET = 15\.5;/);
  assert.match(content, /OTHER_SWIFT_FLAGS = "\$\(inherited\) \\"-D\\" \\"COCOAPODS\\" \\"-DDEBUG\\"";/);
  // 배열 값(여러 줄)을 지나오면서 중괄호 짝을 놓치지 않았는지.
  assert.match(content, /GCC_PREPROCESSOR_DEFINITIONS = \(\n\t{5}"DEBUG=1",\n\t{5}"\$\(inherited\)",\n\t{4}\);/);
  assert.equal(blocks(content, "Release").length, 2);
  assert.equal(blocks(content, "Debug").length, 2);
});

test("두 번 돌려도 결과가 같다", () => {
  const project = makeProject();

  assert.equal(project.run("--team", "ABCD123456", "--profile", "packer").status, 0);
  const afterFirst = project.pbxproj();

  const second = project.run("--team", "ABCD123456", "--profile", "packer");
  assert.equal(second.status, 0);
  assert.equal(project.pbxproj(), afterFirst);
  assert.match(second.stdout, /이미/);
});

test("값이 바뀌면 갈아 끼운다", () => {
  const project = makeProject();

  assert.equal(project.run("--team", "ABCD123456", "--profile", "old").status, 0);
  assert.equal(project.run("--team", "WXYZ999999", "--profile", "new").status, 0);

  const content = project.pbxproj();
  assert.match(content, /DEVELOPMENT_TEAM = WXYZ999999;/);
  assert.match(content, /PROVISIONING_PROFILE_SPECIFIER = new;/);
  assert.doesNotMatch(content, /ABCD123456/);
  assert.doesNotMatch(content, /= old;/);
});

test("앱 타겟 블록을 못 찾으면 죽는다", () => {
  // INFOPLIST_FILE 이 빠진 판 — 템플릿이 바뀐 상황을 흉내낸다.
  const project = makeProject(PBXPROJ.replace(/\t*INFOPLIST_FILE = App\/Info\.plist;\n/g, ""));

  const result = project.run("--team", "ABCD123456", "--profile", "packer");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /::error::/);
});

test("ios/ 가 없으면 죽는다", () => {
  const result = makeProject(null).run("--team", "ABCD123456", "--profile", "packer");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /::error::/);
});

test("인자를 검사한다", () => {
  const project = makeProject();

  for (const args of [
    ["--team", "ABCD123456"],
    ["--profile", "packer"],
    ["--team", "", "--profile", "packer"],
    ["--team", "ABCD123456", "--profile", ""],
    ["--team", "SHORT", "--profile", "packer"],
    ["--team", "ABCD 123456", "--profile", "packer"],
    ["--team", "ABCD123456", "--profile", "packer", "--identity", ""],
  ]) {
    const result = project.run(...args);
    assert.equal(result.status, 1, `이 인자는 거부해야 한다: ${args.join(" ")}`);
  }

  // 인자가 틀렸으면 파일을 건드리지 않았어야 한다.
  assert.equal(project.pbxproj(), PBXPROJ);
});
