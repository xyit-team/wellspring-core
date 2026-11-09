import assert from "node:assert/strict"
import { cp, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { after, before, test } from "node:test"

import pino from "pino"

import { withAgentToolContext } from "../.host/src/agent/tool-context.ts"
import { DEFAULT_SETTINGS } from "../.host/src/config/defaults.ts"
import { getElog, initElog, type ElogStream } from "../.host/src/logger/elog4js.ts"
import type { ResolvedPaths } from "../.host/src/platform/path.ts"
import { DirectBackend } from "../.host/src/sandbox/backends/direct.ts"
import { AgentToolRegistry } from "../.host/src/plugin/agent-tools.ts"
import { loadPlugins } from "../.host/src/plugin/loader.ts"
import { PluginRegistry } from "../.host/src/plugin/registry.ts"
import { shutdownAllSandboxPlugins } from "../.host/src/sandbox/plugin-client.ts"
import { PLUGIN_FILES } from "./plugin-files.ts"

let root = ""
let tools: AgentToolRegistry

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-search-tools-"))
    // 插件调用回访宿主时要用日志流
    const output: ElogStream = { write: () => undefined }
    initElog({ stdout: output, stderr: output, color: false, json: false })
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
    const destination = join(root, "data", "plugins", "@xyit", "wellspring-core")
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
    assert.equal(plugins.find((plugin) => plugin.id === "@xyit/wellspring-core")?.status, "ok")
    return agentTools
}

// 每个用例独立工作区，路径展示相对该目录
async function workspaceFor(name: string): Promise<string> {
    const directory = join(root, "workspaces", name)
    await mkdir(directory, { recursive: true })
    return directory
}

async function write(
    workspace: string,
    relative: string,
    content: string | Uint8Array,
): Promise<void> {
    const target = join(workspace, relative)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
}

interface ToolResult {
    readonly success: boolean
    readonly data: Record<string, unknown>
    readonly content?: string
}

// 工作区上下文里调工具
async function callTool(
    name: string,
    workspaceDir: string,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    const record = tools.get(name)
    assert.ok(record, `工具未注册：${name}`)
    return await withAgentToolContext(
        {
            sessionId: "search-tools-test",
            turn: 1,
            step: 1,
            workspaceDir,
            permission: "workspace-write",
            allowExec: false,
            elog: getElog(),
        },
        async () => await record.tool.call(args),
    )
}

test("grep 按文件分组返回行号，默认跳过 node_modules 与 .git", { timeout: 30_000 }, async () => {
    const workspace = await workspaceFor("grep-basic")
    await write(workspace, "src/a.ts", "const a = 1\nconst foo = 2\n// foo again\n")
    await write(workspace, "src/b.ts", 'export const bar = "foo"\n')
    await write(workspace, "node_modules/dep/index.js", "foo in dependency\n")
    await write(workspace, ".git/config", "foo in git config\n")

    const result = await callTool("grep", workspace, { pattern: "foo" })
    assert.equal(result.success, true, JSON.stringify(result.data))
    assert.equal(result.data["matches"], 3)
    assert.equal(result.data["files"], 2)
    assert.equal(result.data["scanned"], 2)
    assert.equal(result.data["truncated"], false)
    assert.equal(
        String(result.data["content"]),
        [
            "src/a.ts",
            "  2: const foo = 2",
            "  3: // foo again",
            "src/b.ts",
            '  1: export const bar = "foo"',
        ].join("\n"),
    )
})

test("grep 无命中返回文案", { timeout: 30_000 }, async () => {
    const workspace = await workspaceFor("grep-miss")
    await write(workspace, "a.txt", "alpha\n")

    const result = await callTool("grep", workspace, { pattern: "beta" })
    assert.equal(result.success, true, JSON.stringify(result.data))
    assert.equal(result.data["matches"], 0)
    assert.equal(result.data["files"], 0)
    assert.equal(String(result.data["content"]), "未找到匹配：beta")
})

test("grep include 过滤：无斜杠按文件名，含斜杠按相对路径", { timeout: 30_000 }, async () => {
    const workspace = await workspaceFor("grep-include")
    await write(workspace, "src/a.ts", "needle\n")
    await write(workspace, "src/b.js", "needle\n")
    await write(workspace, "docs/readme.md", "needle\n")

    const byName = await callTool("grep", workspace, { pattern: "needle", include: "*.md" })
    assert.equal(byName.success, true, JSON.stringify(byName.data))
    assert.equal(byName.data["matches"], 1)
    assert.equal(String(byName.data["content"]), "docs/readme.md\n  1: needle")

    const byPath = await callTool("grep", workspace, { pattern: "needle", include: "src/*.ts" })
    assert.equal(byPath.success, true, JSON.stringify(byPath.data))
    assert.equal(byPath.data["matches"], 1)
    assert.equal(String(byPath.data["content"]), "src/a.ts\n  1: needle")
})

test("grep 非法正则返回 SEARCH_BAD_PATTERN", { timeout: 30_000 }, async () => {
    const workspace = await workspaceFor("grep-bad-regex")
    await write(workspace, "a.txt", "alpha\n")

    const result = await callTool("grep", workspace, { pattern: "(" })
    assert.equal(result.success, false)
    assert.equal(result.data["code"], "SEARCH_BAD_PATTERN")
    assert.match(String(result.data["error"]), /正则表达式无效/)
})

test("grep path 指向单个文件", { timeout: 30_000 }, async () => {
    const workspace = await workspaceFor("grep-single-file")
    await write(workspace, "src/a.ts", "foo\nbar\nfoo\n")
    await write(workspace, "src/b.ts", "foo\n")

    const result = await callTool("grep", workspace, { pattern: "foo", path: "src/a.ts" })
    assert.equal(result.success, true, JSON.stringify(result.data))
    assert.equal(result.data["matches"], 2)
    assert.equal(result.data["scanned"], 1)
    assert.equal(String(result.data["content"]), "src/a.ts\n  1: foo\n  3: foo")
})

test("grep ignore_case 生效", { timeout: 30_000 }, async () => {
    const workspace = await workspaceFor("grep-ignore-case")
    await write(workspace, "a.txt", "Foo Bar\nfoo bar\n")

    const sensitive = await callTool("grep", workspace, { pattern: "FOO" })
    assert.equal(sensitive.data["matches"], 0)

    const insensitive = await callTool("grep", workspace, { pattern: "FOO", ignore_case: true })
    assert.equal(insensitive.data["matches"], 2)
})

test("grep 跳过二进制文件", { timeout: 30_000 }, async () => {
    const workspace = await workspaceFor("grep-binary")
    await write(workspace, "text.txt", "needle\n")
    await write(workspace, "blob.bin", Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0, 0]))

    const result = await callTool("grep", workspace, { pattern: "needle" })
    assert.equal(result.success, true, JSON.stringify(result.data))
    assert.equal(result.data["matches"], 1)
    // 二进制计入 scanned，不出现在结果
    assert.equal(result.data["scanned"], 2)
    const content = String(result.data["content"])
    assert.ok(!content.includes("blob.bin"), content)
    assert.match(content, /^text\.txt\n {2}1: needle$/)
})

test("grep 去掉 CRLF 的 \\r 并截断超长行", { timeout: 30_000 }, async () => {
    const workspace = await workspaceFor("grep-lines")
    const long = `x${"y".repeat(400)}needle`
    await write(workspace, "crlf.txt", `first\r\nsecond needle\r\n${long}\r\n`)

    const result = await callTool("grep", workspace, { pattern: "needle" })
    assert.equal(result.success, true, JSON.stringify(result.data))
    assert.equal(result.data["matches"], 2)
    const content = String(result.data["content"])
    assert.ok(!content.includes("\r"), "命中行里的 \\r 要去掉")
    assert.match(content, /  2: second needle/)
    const third = content.split("\n").find((line) => line.startsWith("  3: "))
    assert.ok(third !== undefined)
    assert.ok(third.endsWith("…"), third)
})

test("glob *.ts 嵌套命中并按 mtime 从新到旧排序，跳过 node_modules", { timeout: 30_000 }, async () => {
    const workspace = await workspaceFor("glob-ts")
    await write(workspace, "src/a.ts", "a\n")
    await write(workspace, "src/deep/b.ts", "b\n")
    await write(workspace, "src/c.js", "c\n")
    await write(workspace, "node_modules/dep/d.ts", "d\n")
    await write(workspace, "readme.md", "r\n")
    await utimes(join(workspace, "src/a.ts"), new Date(3000), new Date(3000))
    await utimes(join(workspace, "src/deep/b.ts"), new Date(2000), new Date(2000))

    const result = await callTool("glob", workspace, { pattern: "*.ts" })
    assert.equal(result.success, true, JSON.stringify(result.data))
    assert.equal(result.data["count"], 2)
    assert.equal(result.data["truncated"], false)
    assert.equal(String(result.data["content"]), "src/a.ts\nsrc/deep/b.ts")
})

test("glob src/**/*.ts 命中多级目录，path 指定起点", { timeout: 30_000 }, async () => {
    const workspace = await workspaceFor("glob-deep")
    await write(workspace, "src/a.ts", "a\n")
    await write(workspace, "src/deep/b.ts", "b\n")
    await write(workspace, "other/c.ts", "c\n")
    await utimes(join(workspace, "src/a.ts"), new Date(2000), new Date(2000))
    await utimes(join(workspace, "src/deep/b.ts"), new Date(3000), new Date(3000))

    const fromRoot = await callTool("glob", workspace, { pattern: "src/**/*.ts" })
    assert.equal(fromRoot.success, true, JSON.stringify(fromRoot.data))
    assert.equal(fromRoot.data["count"], 2)
    assert.equal(String(fromRoot.data["content"]), "src/deep/b.ts\nsrc/a.ts")

    const fromSrc = await callTool("glob", workspace, { pattern: "src/**/*.ts", path: "src" })
    assert.equal(fromSrc.success, true, JSON.stringify(fromSrc.data))
    assert.equal(String(fromSrc.data["content"]), String(fromRoot.data["content"]))
})

test("glob 花括号选项", { timeout: 30_000 }, async () => {
    const workspace = await workspaceFor("glob-brace")
    await write(workspace, "a.ts", "a\n")
    await write(workspace, "b.js", "b\n")
    await write(workspace, "c.md", "c\n")

    const result = await callTool("glob", workspace, { pattern: "*.{ts,js}" })
    assert.equal(result.success, true, JSON.stringify(result.data))
    assert.equal(result.data["count"], 2)
    assert.deepEqual(String(result.data["content"]).split("\n").sort(), ["a.ts", "b.js"])
})

test("grep / glob 尊重 .gitignore，include_ignored 可以绕过", { timeout: 30_000 }, async () => {
    const workspace = await workspaceFor("gitignore")
    await write(workspace, ".gitignore", "generated/\n*.log\n!keep.log\n")
    await write(workspace, "generated/x.txt", "needle\n")
    await write(workspace, "debug.log", "needle\n")
    await write(workspace, "keep.log", "needle\n")
    await write(workspace, "src/a.ts", "needle\n")

    const grep = await callTool("grep", workspace, { pattern: "needle" })
    assert.equal(grep.success, true, JSON.stringify(grep.data))
    const text = String(grep.data["content"])
    assert.ok(!text.includes("generated/x.txt"), text)
    assert.ok(!text.includes("debug.log"), text)
    assert.match(text, /keep\.log/)
    assert.match(text, /src\/a\.ts/)

    const glob = await callTool("glob", workspace, { pattern: "*.log" })
    assert.equal(glob.success, true, JSON.stringify(glob.data))
    assert.equal(String(glob.data["content"]), "keep.log")

    const bypass = await callTool("grep", workspace, {
        pattern: "needle",
        include_ignored: true,
    })
    assert.match(String(bypass.data["content"]), /generated\/x\.txt/)
    assert.match(String(bypass.data["content"]), /debug\.log/)
})

test("嵌套 .gitignore 与子目录起点都按祖先规则过滤", { timeout: 30_000 }, async () => {
    const workspace = await workspaceFor("gitignore-nested")
    await write(workspace, ".gitignore", "*.log\n")
    await write(workspace, "sub/.gitignore", "secret.txt\n")
    await write(workspace, "sub/secret.txt", "needle\n")
    await write(workspace, "sub/ok.txt", "needle\n")
    await write(workspace, "sub/a.log", "needle\n")

    const fromRoot = await callTool("grep", workspace, { pattern: "needle" })
    const text = String(fromRoot.data["content"])
    assert.ok(!text.includes("secret.txt"), text)
    assert.ok(!text.includes("a.log"), text)
    assert.match(text, /sub\/ok\.txt/)

    // 起点在 sub：根 .gitignore 仍生效
    const fromSub = await callTool("grep", workspace, { pattern: "needle", path: "sub" })
    const subText = String(fromSub.data["content"])
    assert.ok(!subText.includes("a.log"), subText)
    assert.match(subText, /sub\/ok\.txt/)
})

test("glob 无匹配返回文案", { timeout: 30_000 }, async () => {
    const workspace = await workspaceFor("glob-miss")
    await write(workspace, "a.txt", "a\n")

    const result = await callTool("glob", workspace, { pattern: "*.rs" })
    assert.equal(result.success, true, JSON.stringify(result.data))
    assert.equal(result.data["count"], 0)
    assert.equal(result.data["truncated"], false)
    assert.equal(String(result.data["content"]), "没有匹配的文件：*.rs")
})

test("glob 非法模式返回 GLOB_BAD_PATTERN", { timeout: 30_000 }, async () => {
    const workspace = await workspaceFor("glob-bad")
    await write(workspace, "a.ts", "a\n")

    const result = await callTool("glob", workspace, { pattern: "{a" })
    assert.equal(result.success, false)
    assert.equal(result.data["code"], "GLOB_BAD_PATTERN")
    assert.match(String(result.data["error"]), /glob 模式无效/)
})

test("grep context 带出命中行前后文，相邻命中合并", { timeout: 30_000 }, async () => {
    const workspace = await workspaceFor("grep-context")
    await write(
        workspace,
        "src/a.ts",
        ["line1", "line2", "foo", "line4", "line5", "bar", "line7"].join("\n") + "\n",
    )

    const result = await callTool("grep", workspace, { pattern: "foo|bar", context: 1 })
    assert.equal(result.success, true, JSON.stringify(result.data))
    assert.equal(result.data["matches"], 2)
    assert.equal(
        String(result.data["content"]),
        [
            "src/a.ts",
            "  2- line2",
            "  3: foo",
            "  4- line4",
            "  5- line5",
            "  6: bar",
            "  7- line7",
        ].join("\n"),
    )
})

test("grep max_results 限制命中数并说明截断", { timeout: 30_000 }, async () => {
    const workspace = await workspaceFor("grep-max")
    await write(workspace, "many.txt", ["needle1", "needle2", "needle3", "needle4"].join("\n") + "\n")

    const result = await callTool("grep", workspace, { pattern: "needle", max_results: 2 })
    assert.equal(result.success, true, JSON.stringify(result.data))
    assert.equal(result.data["matches"], 2)
    assert.equal(result.data["truncated"], true)
    assert.match(String(result.data["content"]), /\[匹配数达到上限 2，可能还有更多\]/)
})

test("grep paths 搜多个起点并去重", { timeout: 30_000 }, async () => {
    const workspace = await workspaceFor("grep-paths")
    await write(workspace, "a/x.txt", "needle\n")
    await write(workspace, "b/y.txt", "needle\n")
    await write(workspace, "c/z.txt", "needle\n")

    const result = await callTool("grep", workspace, { pattern: "needle", paths: ["a", "b"] })
    assert.equal(result.success, true, JSON.stringify(result.data))
    assert.equal(result.data["matches"], 2)
    const text = String(result.data["content"])
    assert.match(text, /a\/x\.txt/)
    assert.match(text, /b\/y\.txt/)
    assert.ok(!text.includes("c/z.txt"), text)

    // 重复起点不重复输出
    const deduped = await callTool("grep", workspace, {
        pattern: "needle",
        paths: ["a", "a/x.txt"],
    })
    assert.equal(deduped.data["matches"], 1)
    assert.equal(String(deduped.data["content"]).match(/a\/x\.txt/g)?.length, 1)
})

test("grep context / max_results 参数校验", { timeout: 30_000 }, async () => {
    const workspace = await workspaceFor("grep-context-bad")
    await write(workspace, "a.txt", "foo\n")

    const badContext = await callTool("grep", workspace, { pattern: "foo", context: 99 })
    assert.equal(badContext.success, false)
    assert.equal(badContext.data["code"], "FS_BAD_ARGUMENT")

    const badMax = await callTool("grep", workspace, { pattern: "foo", max_results: 0 })
    assert.equal(badMax.success, false)
    assert.equal(badMax.data["code"], "FS_BAD_ARGUMENT")
})
