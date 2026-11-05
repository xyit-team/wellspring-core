/*
 * 跨平台测试入口：显式列出 test/ 下的 *.test.ts。
 *
 * 不用 `node --test test`：Node 24 不接受目录参数；也不用默认发现规则，
 * 不同 Node 版本对 .ts 的发现范围不一致。
 */

import { spawnSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const TEST_ROOT = fileURLToPath(new URL("../test/", import.meta.url))

const files = readdirSync(TEST_ROOT)
    .filter((name) => name.endsWith(".test.ts"))
    .sort()
    .map((name) => join(TEST_ROOT, name))

if (files.length === 0) {
    console.error("没有找到测试文件")
    process.exit(1)
}

console.log(`运行 ${files.length} 个测试文件：`)
for (const file of files) {
    console.log(`  ${relative(process.cwd(), file)}`)
}

/* 串行跑：集成测试会起真实沙盒子进程，并发时更容易撞上临时目录与端口 */
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files], {
    stdio: "inherit",
})
process.exit(result.status ?? 1)
