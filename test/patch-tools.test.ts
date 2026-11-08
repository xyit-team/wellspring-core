import assert from "node:assert/strict"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { after, before, test } from "node:test"

import pino from "pino"

import { withAgentToolContext } from "../.host/src/agent/tool-context.ts"
import type { SandboxAccess } from "../.host/src/config/types.ts"
import { DEFAULT_SETTINGS } from "../.host/src/config/defaults.ts"
import { Elog } from "../.host/src/logger/elog4js.ts"
import type { ResolvedPaths } from "../.host/src/platform/path.ts"
import { DirectBackend } from "../.host/src/sandbox/backends/direct.ts"
import { AgentToolRegistry } from "../.host/src/plugin/agent-tools.ts"
import { loadPlugins } from "../.host/src/plugin/loader.ts"
import { PluginRegistry } from "../.host/src/plugin/registry.ts"
import { shutdownAllSandboxPlugins } from "../.host/src/sandbox/plugin-client.ts"
import { LIMITS } from "../retention.ts"
import { PLUGIN_FILES } from "./plugin-files.ts"

let root = ""
let tools: AgentToolRegistry

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-patch-tools-"))
    tools = await loadCoreTools()
})

after(async () => {
    await shutdownAllSandboxPlugins()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function paths(): ResolvedPaths {
    return {
        configDir: join(root, "config"),
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        logDir: join(root, "logs"),
        sources: {
            configDir: "override",
            dataDir: "override",
            cacheDir: "override",
            logDir: "override",
        },
    }
}

async function loadCoreTools(): Promise<AgentToolRegistry> {
    const destination = join(root, "data", "plugins", "@xyit-team", "wellspring-core")
    await mkdir(destination, { recursive: true })
    for (const name of PLUGIN_FILES) {
        await cp(join(resolve(import.meta.dirname, ".."), name), join(destination, name))
    }
    const agentTools = new AgentToolRegistry()
    const plugins = await loadPlugins({
        paths: paths(),
        config: {
            ...DEFAULT_SETTINGS,
            sandbox: { ...DEFAULT_SETTINGS.sandbox, mode: "best-effort" },
        },
        logger: pino({ level: "silent" }),
        registry: new PluginRegistry(),
        agentTools,
        sandbox: { ...DEFAULT_SETTINGS.sandbox, mode: "best-effort" },
        sandboxBackend: new DirectBackend(),
    })
    assert.equal(plugins.find((plugin) => plugin.id === "@xyit-team/wellspring-core")?.status, "ok")
    return agentTools
}

interface ToolResult {
    readonly success: boolean
    readonly data: Record<string, unknown>
    readonly content?: string
}

// 工作区上下文里调工具；permission 决定宿主是否放行写入
async function callTool(
    name: string,
    permission: SandboxAccess,
    args: Record<string, unknown>,
    workspaceDir: string,
): Promise<ToolResult> {
    const record = tools.get(name)
    assert.ok(record, `工具未注册：${name}`)
    return await withAgentToolContext(
        {
            sessionId: "patch-tools-test",
            turn: 1,
            step: 1,
            workspaceDir,
            permission,
            allowExec: false,
            elog: new Elog({
                stdout: { write: () => {} },
                stderr: { write: () => {} },
                color: false,
            }),
        },
        async () => await record.tool.call(args),
    )
}

// 每个用例独立工作区
async function workspaceFor(name: string): Promise<string> {
    const directory = join(root, "workspaces", name)
    await mkdir(directory, { recursive: true })
    return directory
}

async function applyPatch(workspaceDir: string, patch: string): Promise<ToolResult> {
    return await callTool("apply_patch", "workspace-write", { patch }, workspaceDir)
}

// 补丁文本：每行 LF 连接，保留结尾换行
function diffLines(lines: readonly string[]): string {
    return `${lines.join("\n")}\n`
}

function resultFiles(result: ToolResult): Array<Record<string, unknown>> {
    const value = result.data["files"]
    assert.ok(Array.isArray(value), "files 不是数组")
    return value as Array<Record<string, unknown>>
}

test("单文件单 hunk：行号与内容正确", { timeout: 30_000 }, async () => {
    const workspaceDir = await workspaceFor("single")
    await mkdir(join(workspaceDir, "src"), { recursive: true })
    await writeFile(join(workspaceDir, "src/a.txt"), "one\ntwo\nthree\n", "utf8")
    const patch = diffLines([
        "diff --git a/src/a.txt b/src/a.txt",
        "index 1111111..2222222 100644",
        "--- a/src/a.txt",
        "+++ b/src/a.txt",
        "@@ -1,3 +1,3 @@",
        " one",
        "-two",
        "+TWO",
        " three",
    ])
    const result = await applyPatch(workspaceDir, patch)
    assert.equal(result.success, true, JSON.stringify(result.data))
    assert.equal(result.data["added"], 1)
    assert.equal(result.data["removed"], 1)
    const files = resultFiles(result)
    assert.equal(files.length, 1)
    assert.equal(files[0]?.["path"], join(workspaceDir, "src/a.txt"))
    assert.equal(files[0]?.["created"], false)
    const content = String(result.data["content"])
    const lines = content.split("\n")
    assert.equal(lines[0], "应用补丁：1 个文件（+1 −1）")
    // 模型侧明细用相对路径，data 里是绝对路径
    assert.equal(lines[1], "src/a.txt  +1 −1")
    assert.equal(await readFile(join(workspaceDir, "src/a.txt"), "utf8"), "one\nTWO\nthree\n")
})

test("多文件多 hunk 一次应用", { timeout: 30_000 }, async () => {
    const workspaceDir = await workspaceFor("multi")
    await writeFile(join(workspaceDir, "a.txt"), "a1\na2\na3\na4\na5\n", "utf8")
    await writeFile(join(workspaceDir, "b.txt"), "b1\nb2\nb3\n", "utf8")
    const patch = diffLines([
        "diff --git a/a.txt b/a.txt",
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1,2 +1,2 @@",
        " a1",
        "-a2",
        "+A2",
        "@@ -4,2 +4,3 @@",
        " a4",
        "-a5",
        "+A5",
        "+extra",
        "diff --git a/b.txt b/b.txt",
        "--- a/b.txt",
        "+++ b/b.txt",
        "@@ -2,1 +2,1 @@",
        "-b2",
        "+B2",
    ])
    const result = await applyPatch(workspaceDir, patch)
    assert.equal(result.success, true, JSON.stringify(result.data))
    assert.equal(result.data["added"], 4)
    assert.equal(result.data["removed"], 3)
    assert.equal(resultFiles(result).length, 2)
    assert.match(String(result.data["content"]), /应用补丁：2 个文件（\+4 −3）/)
    assert.equal(await readFile(join(workspaceDir, "a.txt"), "utf8"), "a1\nA2\na3\na4\nA5\nextra\n")
    assert.equal(await readFile(join(workspaceDir, "b.txt"), "utf8"), "b1\nB2\nb3\n")
})

test("hunk 行号漂移：按上下文在全文重新定位", { timeout: 30_000 }, async () => {
    const workspaceDir = await workspaceFor("drift")
    await writeFile(
        join(workspaceDir, "drift.txt"),
        "extra1\nextra2\nalpha\nbeta\ngamma\n",
        "utf8",
    )
    // 文件顶部多插了两行，补丁 oldStart 仍是旧的
    const patch = diffLines([
        "--- a/drift.txt",
        "+++ b/drift.txt",
        "@@ -1,3 +1,3 @@",
        " alpha",
        "-beta",
        "+BETA",
        " gamma",
    ])
    const result = await applyPatch(workspaceDir, patch)
    assert.equal(result.success, true, JSON.stringify(result.data))
    assert.equal(
        await readFile(join(workspaceDir, "drift.txt"), "utf8"),
        "extra1\nextra2\nalpha\nBETA\ngamma\n",
    )
})

test("上下文不匹配：整个补丁失败，任何文件都不写", { timeout: 30_000 }, async () => {
    const workspaceDir = await workspaceFor("hunk-miss")
    await writeFile(join(workspaceDir, "first.txt"), "first-old\n", "utf8")
    await writeFile(join(workspaceDir, "second.txt"), "second-old\n", "utf8")
    const patch = diffLines([
        "--- a/first.txt",
        "+++ b/first.txt",
        "@@ -1,1 +1,1 @@",
        "-first-old",
        "+first-new",
        "--- a/second.txt",
        "+++ b/second.txt",
        "@@ -1,1 +1,1 @@",
        "-no-such-line",
        "+whatever",
    ])
    const result = await applyPatch(workspaceDir, patch)
    assert.equal(result.success, false)
    assert.equal(result.data["code"], "PATCH_HUNK_NOT_FOUND")
    const error = String(result.data["error"])
    assert.match(error, /second\.txt/)
    assert.match(error, /@@ -1,1 \+1,1 @@/)
    assert.match(error, /附近内容/)
    // 原子性：前一个文件虽然可应用，也没有落盘
    assert.equal(await readFile(join(workspaceDir, "first.txt"), "utf8"), "first-old\n")
    assert.equal(await readFile(join(workspaceDir, "second.txt"), "utf8"), "second-old\n")
})

test("新建文件与已存在拒绝", { timeout: 30_000 }, async () => {
    const workspaceDir = await workspaceFor("create")
    const created = await applyPatch(
        workspaceDir,
        diffLines([
            "--- /dev/null",
            "+++ b/nested/dir/created.txt",
            "@@ -0,0 +1,2 @@",
            "+alpha",
            "+beta",
        ]),
    )
    assert.equal(created.success, true, JSON.stringify(created.data))
    assert.equal(created.data["added"], 2)
    assert.equal(created.data["removed"], 0)
    const files = resultFiles(created)
    assert.equal(files[0]?.["created"], true)
    assert.match(String(created.data["content"]), /（新建）/)
    // 新建文件用 LF，父目录由宿主创建
    assert.equal(
        await readFile(join(workspaceDir, "nested/dir/created.txt"), "utf8"),
        "alpha\nbeta\n",
    )

    // 无结尾换行标记
    const raw = await applyPatch(
        workspaceDir,
        diffLines([
            "--- /dev/null",
            "+++ b/raw.txt",
            "@@ -0,0 +1,1 @@",
            "+raw",
            "\\ No newline at end of file",
        ]),
    )
    assert.equal(raw.success, true, JSON.stringify(raw.data))
    assert.equal(await readFile(join(workspaceDir, "raw.txt"), "utf8"), "raw")

    const exists = await applyPatch(
        workspaceDir,
        diffLines([
            "--- /dev/null",
            "+++ b/nested/dir/created.txt",
            "@@ -0,0 +1,1 @@",
            "+x",
        ]),
    )
    assert.equal(exists.success, false)
    assert.equal(exists.data["code"], "PATCH_FILE_EXISTS")
})

test("删除文件：+++ /dev/null 拒绝并提示 delete_file", { timeout: 30_000 }, async () => {
    const workspaceDir = await workspaceFor("delete")
    await writeFile(join(workspaceDir, "gone.txt"), "bye\n", "utf8")
    const result = await applyPatch(
        workspaceDir,
        diffLines([
            "--- a/gone.txt",
            "+++ /dev/null",
            "@@ -1,1 +0,0 @@",
            "-bye",
        ]),
    )
    assert.equal(result.success, false)
    assert.equal(result.data["code"], "PATCH_DELETE_UNSUPPORTED")
    assert.match(String(result.data["error"]), /delete_file/)
    // 文件原样保留
    assert.equal(await readFile(join(workspaceDir, "gone.txt"), "utf8"), "bye\n")
})

test("非法补丁文本：PATCH_PARSE_ERROR 带行号", { timeout: 30_000 }, async () => {
    const workspaceDir = await workspaceFor("parse")

    const noSection = await applyPatch(workspaceDir, "这不是补丁\n")
    assert.equal(noSection.success, false)
    assert.equal(noSection.data["code"], "PATCH_PARSE_ERROR")
    assert.match(String(noSection.data["error"]), /第 1 行/)

    const badHeader = await applyPatch(
        workspaceDir,
        diffLines(["--- a/x.txt", "+++ b/x.txt", "@@ 非法 @@"]),
    )
    assert.equal(badHeader.success, false)
    assert.equal(badHeader.data["code"], "PATCH_PARSE_ERROR")
    assert.match(String(badHeader.data["error"]), /第 3 行/)
    assert.match(String(badHeader.data["error"]), /hunk 头不合法/)

    const shortBody = await applyPatch(
        workspaceDir,
        diffLines(["--- a/y.txt", "+++ b/y.txt", "@@ -1,2 +1,2 @@", " one"]),
    )
    assert.equal(shortBody.success, false)
    assert.equal(shortBody.data["code"], "PATCH_PARSE_ERROR")
    assert.match(String(shortBody.data["error"]), /行数/)

    const longBody = await applyPatch(
        workspaceDir,
        diffLines([
            "--- a/z.txt",
            "+++ b/z.txt",
            "@@ -1,1 +1,1 @@",
            "-one",
            "+ONE",
            "+EXTRA",
        ]),
    )
    assert.equal(longBody.success, false)
    assert.equal(longBody.data["code"], "PATCH_PARSE_ERROR")
    assert.match(String(longBody.data["error"]), /hunk 行数与头部声明不符/)
})

test("CRLF 文件补丁后仍用 CRLF", { timeout: 30_000 }, async () => {
    const workspaceDir = await workspaceFor("crlf")
    await writeFile(join(workspaceDir, "crlf.txt"), "one\r\ntwo\r\nthree\r\n", "utf8")
    const result = await applyPatch(
        workspaceDir,
        diffLines([
            "--- a/crlf.txt",
            "+++ b/crlf.txt",
            "@@ -1,3 +1,3 @@",
            " one",
            "-two",
            "+TWO",
            " three",
        ]),
    )
    assert.equal(result.success, true, JSON.stringify(result.data))
    assert.equal(
        await readFile(join(workspaceDir, "crlf.txt"), "utf8"),
        "one\r\nTWO\r\nthree\r\n",
    )
})

test("补丁写入后 markRead：紧接着 write 不再要求重读", { timeout: 30_000 }, async () => {
    const workspaceDir = await workspaceFor("mark-read")
    await writeFile(join(workspaceDir, "guarded.txt"), "keep\nold\n", "utf8")
    const patched = await applyPatch(
        workspaceDir,
        diffLines([
            "--- a/guarded.txt",
            "+++ b/guarded.txt",
            "@@ -2,1 +2,1 @@",
            "-old",
            "+new",
        ]),
    )
    assert.equal(patched.success, true, JSON.stringify(patched.data))
    const overwritten = await callTool(
        "write",
        "workspace-write",
        { file_path: "guarded.txt", content: "rewritten\n" },
        workspaceDir,
    )
    assert.equal(overwritten.success, true, JSON.stringify(overwritten.data))
    assert.equal(await readFile(join(workspaceDir, "guarded.txt"), "utf8"), "rewritten\n")
})

test("省略 count、纯插入与无结尾换行", { timeout: 30_000 }, async () => {
    const workspaceDir = await workspaceFor("hunk-shapes")

    // count 缺省为 1
    await writeFile(join(workspaceDir, "short.txt"), "a\nb\nc\n", "utf8")
    const omitted = await applyPatch(
        workspaceDir,
        diffLines(["--- a/short.txt", "+++ b/short.txt", "@@ -2 +2 @@", "-b", "+B"]),
    )
    assert.equal(omitted.success, true, JSON.stringify(omitted.data))
    assert.equal(await readFile(join(workspaceDir, "short.txt"), "utf8"), "a\nB\nc\n")

    // oldCount 0：纯插入
    await writeFile(join(workspaceDir, "insert.txt"), "x\ny\n", "utf8")
    const insert = await applyPatch(
        workspaceDir,
        diffLines([
            "--- a/insert.txt",
            "+++ b/insert.txt",
            "@@ -2,0 +3,1 @@",
            "+z",
        ]),
    )
    assert.equal(insert.success, true, JSON.stringify(insert.data))
    assert.equal(await readFile(join(workspaceDir, "insert.txt"), "utf8"), "x\ny\nz\n")

    // 两侧无结尾换行：保持无换行
    await writeFile(join(workspaceDir, "tail.txt"), "one\ntwo", "utf8")
    const tail = await applyPatch(
        workspaceDir,
        diffLines([
            "--- a/tail.txt",
            "+++ b/tail.txt",
            "@@ -1,2 +1,2 @@",
            " one",
            "-two",
            "\\ No newline at end of file",
            "+TWO",
            "\\ No newline at end of file",
        ]),
    )
    assert.equal(tail.success, true, JSON.stringify(tail.data))
    assert.equal(await readFile(join(workspaceDir, "tail.txt"), "utf8"), "one\nTWO")
})

test("修改缺失文件与二进制文件拒绝", { timeout: 30_000 }, async () => {
    const workspaceDir = await workspaceFor("target-checks")
    const missing = await applyPatch(
        workspaceDir,
        diffLines([
            "--- a/missing.txt",
            "+++ b/missing.txt",
            "@@ -1,1 +1,1 @@",
            "-a",
            "+b",
        ]),
    )
    assert.equal(missing.success, false)
    assert.equal(missing.data["code"], "FS_NOT_FOUND")
    assert.match(String(missing.data["error"]), /文件不存在/)

    await writeFile(join(workspaceDir, "blob.bin"), Buffer.from([0, 1, 2, 0, 255]))
    const binary = await applyPatch(
        workspaceDir,
        diffLines([
            "--- a/blob.bin",
            "+++ b/blob.bin",
            "@@ -1,1 +1,1 @@",
            "-a",
            "+b",
        ]),
    )
    assert.equal(binary.success, false)
    assert.equal(binary.data["code"], "FS_NOT_TEXT")
})

test("上限：补丁字节、文件数、单文件 hunk 数", { timeout: 30_000 }, async () => {
    const workspaceDir = await workspaceFor("limits")

    const tooBig = await applyPatch(workspaceDir, "x".repeat(LIMITS.patchBytes + 1))
    assert.equal(tooBig.success, false)
    assert.equal(tooBig.data["code"], "PATCH_BAD_ARGUMENT")

    const fileSections: string[] = []
    for (let index = 0; index <= LIMITS.patchFiles; index += 1) {
        fileSections.push("--- /dev/null", `+++ b/f${index}.txt`, "@@ -0,0 +1,1 @@", "+x")
    }
    const tooManyFiles = await applyPatch(workspaceDir, diffLines(fileSections))
    assert.equal(tooManyFiles.success, false)
    assert.equal(tooManyFiles.data["code"], "PATCH_BAD_ARGUMENT")
    assert.match(String(tooManyFiles.data["error"]), /文件/)

    const manyHunks: string[] = ["--- a/many.txt", "+++ b/many.txt"]
    for (let index = 0; index <= LIMITS.patchHunks; index += 1) {
        manyHunks.push("@@ -1,1 +1,1 @@", "-x", "+y")
    }
    const tooManyHunks = await applyPatch(workspaceDir, diffLines(manyHunks))
    assert.equal(tooManyHunks.success, false)
    assert.equal(tooManyHunks.data["code"], "PATCH_BAD_ARGUMENT")
    assert.match(String(tooManyHunks.data["error"]), /hunk/)
})
