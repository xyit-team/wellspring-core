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

/*
 * 补丁：宿主 1.7.x 的 supervisor 写完 stdin 只包了 try/catch。
 *
 * 子进程不读 stdin、又退得比写入快时，`child.stdin.end()` 会异步失败（EPIPE）。
 * try/catch 抓不到异步错误，宿主也没挂 error 监听，于是它变成未处理的 'error' 事件。
 * 在 Node 24/26 的测试进程里，这个事件会在收尾时触发原生断言
 * （Assertion failed: (env_->execution_async_id()) == (0)），直接把进程打崩 ——
 * 崩得随机，取决于子进程退出与写入的先后，所以同一条提交时而通过时而失败。
 *
 * 空监听就够：命令已经结束，stdin 写不进去没有别的后果。
 * 上游 supervisor 自己监听 stdin error 后，这段可以删。
 */
const supervisorFile = join(target, "src", "sandbox", "supervisor.ts")
const supervisor = await readFile(supervisorFile, "utf8")
const stdinEnd = 'child.stdin?.end(options.stdin ?? "")'
if (supervisor.includes("child.stdin?.on(")) {
    // 上游已经处理过，不用补
} else if (supervisor.includes(stdinEnd)) {
    await writeFile(
        supervisorFile,
        supervisor.replace(
            stdinEnd,
            'child.stdin?.on("error", () => {})\n        child.stdin?.end(options.stdin ?? "")',
        ),
        "utf8",
    )
    console.log("已给宿主 supervisor 的 stdin 补 error 监听（规避 EPIPE 打崩测试进程）")
} else {
    console.warn(
        "宿主 supervisor 的 stdin 写法变了，EPIPE 补丁未生效；若集成测试随机崩，检查上游是否已修",
    )
}

console.log(`已准备宿主源码：${pkg.name}@${pkg.version} → .host/src`)
