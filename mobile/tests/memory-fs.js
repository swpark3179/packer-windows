// 테스트용 가짜 Capacitor `Filesystem` — 메모리 위의 작은 파일 시스템.
//
// '풀어서 저장' 은 폴더를 만들고, 나눠 쓰고, 목록을 읽고, 옮기고, 지운다. 호출을 기록만 하는
// 가짜로는 "옮긴 뒤 임시 폴더가 사라졌는지", "이미 있던 파일이 살아남았는지" 를 물을 수 없어서
// 실제처럼 상태를 들고 있게 했다. 규칙은 플러그인의 동작을 따른다:
//
//   mkdir      이미 있으면 "Directory exists" 로 거절한다.
//   writeFile  `encoding` 이 없으면 `data` 를 Base64 로 보고 바이트로 푼다. `recursive` 면 부모를 만든다.
//   rename     대상이 파일이면 **지우고** 옮긴다 (그래서 앱이 이름을 먼저 피해야 한다). 폴더면 거절한다.
//
// 이 파일은 테스트가 아니다 (`package.json` 의 목록에 없다).

import { Buffer } from "node:buffer";

/**
 * @param {{deny?: string[]}} options `deny` 에 든 폴더(`DOCUMENTS` 등)는 모든 호출을 거절한다 —
 *   안드로이드 10 이하에서 권한 없이 공개 문서 폴더를 만질 때와 같다.
 */
export function memoryFilesystem(options = {}) {
  const deny = new Set(options.deny ?? []);
  /** "디렉터리:경로" → {type: "directory"} | {type: "file", bytes: Uint8Array} */
  const nodes = new Map();
  const calls = [];

  const norm = (path) => path.split("/").filter(Boolean).join("/");
  const key = (directory, path) => `${directory}:${norm(path)}`;
  const parent = (path) => {
    const p = norm(path);
    return p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
  };
  const guard = (method, given) => {
    calls.push([method, given]);
    if (deny.has(given.directory)) throw new Error(`denied: ${given.directory}`);
    // 디렉터리의 뿌리는 늘 있다.
    nodes.set(key(given.directory, ""), { type: "directory" });
  };
  const makeParents = (directory, path) => {
    const parts = norm(path).split("/");
    for (let i = 1; i < parts.length; i += 1) {
      const k = key(directory, parts.slice(0, i).join("/"));
      const node = nodes.get(k);
      if (node?.type === "file") throw new Error("The parent object of the destination is a file");
      if (!node) nodes.set(k, { type: "directory" });
    }
  };
  const decode = (data, encoding) =>
    encoding ? new TextEncoder().encode(data) : Uint8Array.from(Buffer.from(data, "base64"));
  const childrenOf = (directory, path) => {
    const prefix = `${key(directory, path)}${norm(path) ? "/" : ""}`;
    return [...nodes.keys()].filter((k) => k.startsWith(prefix) && k !== key(directory, path));
  };

  const api = {
    async mkdir(given) {
      guard("mkdir", given);
      const k = key(given.directory, given.path);
      if (nodes.has(k)) throw new Error("Directory exists");
      if (given.recursive) makeParents(given.directory, given.path);
      else if (nodes.get(key(given.directory, parent(given.path)))?.type !== "directory") {
        throw new Error("Parent directory must exist");
      }
      nodes.set(k, { type: "directory" });
    },
    async writeFile(given) {
      guard("writeFile", given);
      if (given.recursive) makeParents(given.directory, given.path);
      if (nodes.get(key(given.directory, given.path))?.type === "directory") {
        throw new Error("Is a directory");
      }
      nodes.set(key(given.directory, given.path), {
        type: "file",
        bytes: decode(given.data, given.encoding),
      });
      return { uri: `file:///${given.directory}/${norm(given.path)}` };
    },
    async appendFile(given) {
      guard("appendFile", given);
      const k = key(given.directory, given.path);
      const before = nodes.get(k)?.bytes ?? new Uint8Array(0);
      const more = decode(given.data, given.encoding);
      const bytes = new Uint8Array(before.length + more.length);
      bytes.set(before);
      bytes.set(more, before.length);
      nodes.set(k, { type: "file", bytes });
    },
    async readdir(given) {
      guard("readdir", given);
      if (nodes.get(key(given.directory, given.path))?.type !== "directory") {
        throw new Error("Folder does not exist.");
      }
      const depth = norm(given.path) === "" ? 0 : norm(given.path).split("/").length;
      const files = childrenOf(given.directory, given.path)
        .map((k) => k.slice(k.indexOf(":") + 1))
        .filter((p) => p.split("/").length === depth + 1)
        .map((p) => ({ name: p.split("/").pop(), type: nodes.get(key(given.directory, p)).type }));
      return { files };
    },
    async stat(given) {
      guard("stat", given);
      const node = nodes.get(key(given.directory, given.path));
      if (!node) throw new Error("File does not exist");
      return { type: node.type, size: node.bytes?.length ?? 0 };
    },
    async rename(given) {
      guard("rename", given);
      const from = key(given.directory, given.from);
      const to = key(given.toDirectory ?? given.directory, given.to);
      if (!nodes.has(from)) throw new Error("The source object does not exist");
      if (nodes.get(to)?.type === "directory") throw new Error("Cannot overwrite a directory");
      nodes.delete(to);
      const moved = [from, ...childrenOf(given.directory, given.from)];
      for (const k of moved) {
        nodes.set(to + k.slice(from.length), nodes.get(k));
        nodes.delete(k);
      }
    },
    async rmdir(given) {
      guard("rmdir", given);
      const k = key(given.directory, given.path);
      const inside = childrenOf(given.directory, given.path);
      if (inside.length > 0 && !given.recursive) throw new Error("Folder is not empty");
      for (const child of inside) nodes.delete(child);
      nodes.delete(k);
    },
    async deleteFile(given) {
      guard("deleteFile", given);
      nodes.delete(key(given.directory, given.path));
    },
    async getUri(given) {
      return { uri: `file:///${given.directory}/${norm(given.path)}` };
    },
  };

  return {
    api,
    calls,
    /** 한 디렉터리 안의 모든 경로 (정렬). 폴더는 끝에 `/` 를 붙인다. */
    list(directory) {
      return [...nodes.entries()]
        .filter(([k]) => k.startsWith(`${directory}:`) && k !== `${directory}:`)
        .map(([k, node]) => k.slice(directory.length + 1) + (node.type === "directory" ? "/" : ""))
        .sort();
    },
    read(directory, path) {
      return nodes.get(key(directory, path))?.bytes ?? null;
    },
    put(directory, path, text) {
      makeParents(directory, path);
      nodes.set(key(directory, path), { type: "file", bytes: new TextEncoder().encode(text) });
    },
  };
}
