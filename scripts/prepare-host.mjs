/*
 * 把宿主包的 src/ 复制到 .host/，供集成测试直接跑宿主 TS 源码。
 *
 * 为什么要复制：Node 24 的类型剥离明确拒绝 node_modules 下的 .ts
 * （ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING），而宿主包只把 `.` 与 `./api/host`
 * 放进 exports，内部模块又没法用包名引。宿主自己加载插件时也是同样的做法
 * （plugin-client 把 SDK 复制到 dataDir 再跑）。
 *
 * .host/ 是构建产物，已在 .gitignore 里。
 */

import { cp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

const repoRoot = join(import.meta.dirname, "..")
const packageDir = join(repoRoot, "node_modules", "@xyit", "wellspring")
const target = join(repoRoot, ".host")

const pkg = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"))

await rm(target, { recursive: true, force: true })
await cp(join(packageDir, "src"), join(target, "src"), { recursive: true })
/* 宿主内部有 resolve(import.meta.dirname, "../..") 取包根的地方（例如读版本号） */
await cp(join(packageDir, "package.json"), join(target, "package.json"))

/* 宿主源码里若 import "../../package.json"，这里补一份最小元数据即可 */
await writeFile(
    join(target, "package.json"),
    `${JSON.stringify({ name: pkg.name, version: pkg.version, type: "module" }, null, 4)}\n`,
    "utf8",
)

console.log(`已准备宿主源码：${pkg.name}@${pkg.version} → .host/src`)
