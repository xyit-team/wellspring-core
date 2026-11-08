import assert from "node:assert/strict"
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
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
const workspaces: string[] = []

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-dir-tools-"))
    // 插件调用回访宿主时要用日志流
    const output: ElogStream = { write: () => undefined }
    initElog({ stdout: output, stderr: output, color: false, json: false })
    tools = await loadCoreTools()
})

after(async () => {
    await shutdownAllSandboxPlugins()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    for (const workspace of workspaces) {
        await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
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

// 每个用例独立临时工作区
async function workspaceFor(name: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), `wellspring-dir-tools-${name}-`))
    workspaces.push(directory)
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
            sessionId: "dir-tools-test",
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

test("默认深度 2：根下文件与两层目录可见，第三层不可见", { timeout: 30_000 }, async () => {
    const workspace = await workspaceFor("default-depth")
    await write(workspace, "root.txt", "r\n")
    await write(workspace, "src/a.ts", "a\n")
    await write(workspace, "src/deep/b.ts", "b\n")
    await write(workspace, "src/deep/deeper/c.ts", "c\n")

    const result = await callTool("list_dir", workspace, {})
    assert.equal(result.success, true, JSON.stringify(result.data))
    const content = String(result.data["content"])
    assert.match(content, /^root\.txt {2}2 B$/m)
    assert.match(content, /^src\/$/m)
    assert.match(content, /^ {2}a\.ts {2}2 B$/m)
    assert.match(content, /^ {2}deep\/$/m)
    assert.ok(!content.includes("b.ts"), content)
    assert.ok(!content.includes("deeper"), content)
    assert.equal(result.data["files"], 2)
    assert.equal(result.data["directories"], 2)
    // 深度是用户请求的范围，深层内容被挡住不算触顶
    assert.equal(result.data["truncated"], false)
    assert.ok(!content.includes("遍历达到上限"), content)
})

test("depth=1 只列一层；depth 越界返回 FS_BAD_ARGUMENT", { timeout: 30_000 }, async () => {
    const workspace = await workspaceFor("depth-one")
    await write(workspace, "top.txt", "t\n")
    await write(workspace, "src/a.ts", "a\n")
    await write(workspace, "src/deep/b.ts", "b\n")

    const one = await callTool("list_dir", workspace, { depth: 1 })
    assert.equal(one.success, true, JSON.stringify(one.data))
    const content = String(one.data["content"])
    assert.match(content, /^top\.txt {2}2 B$/m)
    assert.match(content, /^src\/$/m)
    assert.ok(!content.includes("a.ts"), content)
    assert.equal(one.data["files"], 1)
    assert.equal(one.data["directories"], 1)
    assert.equal(one.data["truncated"], false)

    for (const depth of [0, 99]) {
        const bad = await callTool("list_dir", workspace, { depth })
        assert.equal(bad.success, false)
        assert.equal(bad.data["code"], "FS_BAD_ARGUMENT")
        assert.match(String(bad.data["error"]), /1-8/)
    }
})

test("目录行以 / 结尾，缩进每层 +2，文件行显示人读大小", { timeout: 30_000 }, async () => {
    const workspace = await workspaceFor("format")
    await write(workspace, "a.txt", "hello")
    await write(workspace, "src/a.ts", "x".repeat(1200))
    await write(workspace, "src/deep/b.ts", "y".repeat(300))

    const result = await callTool("list_dir", workspace, { depth: 3 })
    assert.equal(result.success, true, JSON.stringify(result.data))
    assert.equal(
        String(result.data["content"]),
        [
            "a.txt  5 B",
            "src/",
            "  a.ts  1.2 kB",
            "  deep/",
            "    b.ts  300 B",
            "[共 2 个目录，3 个文件]",
        ].join("\n"),
    )
    assert.equal(result.data["files"], 3)
    assert.equal(result.data["directories"], 2)
    assert.equal(result.data["truncated"], false)
})

test("空目录照常输出目录行", { timeout: 30_000 }, async () => {
    const workspace = await workspaceFor("empty-dir")
    await write(workspace, "only.txt", "x")
    await mkdir(join(workspace, "empty"), { recursive: true })

    const result = await callTool("list_dir", workspace, { depth: 1 })
    assert.equal(result.success, true, JSON.stringify(result.data))
    assert.equal(
        String(result.data["content"]),
        ["empty/", "only.txt  1 B", "[共 1 个目录，1 个文件]"].join("\n"),
    )
    assert.equal(result.data["directories"], 1)
    assert.equal(result.data["files"], 1)
})

test(".gitignore 默认生效，include_ignored 绕过", { timeout: 30_000 }, async () => {
    const workspace = await workspaceFor("gitignore")
    await write(workspace, ".gitignore", "generated/\n*.log\n!keep.log\n")
    await write(workspace, "generated/x.txt", "needle\n")
    await write(workspace, "debug.log", "needle\n")
    await write(workspace, "keep.log", "needle\n")
    await write(workspace, "src/a.ts", "needle\n")

    const filtered = await callTool("list_dir", workspace, {})
    assert.equal(filtered.success, true, JSON.stringify(filtered.data))
    const text = String(filtered.data["content"])
    assert.ok(!text.includes("generated"), text)
    assert.ok(!text.includes("debug.log"), text)
    assert.match(text, /keep\.log/)
    assert.match(text, /src\//)
    assert.match(text, / {2}a\.ts/)
    assert.equal(filtered.data["directories"], 1)
    assert.equal(filtered.data["files"], 3)

    const bypass = await callTool("list_dir", workspace, { include_ignored: true })
    assert.equal(bypass.success, true, JSON.stringify(bypass.data))
    const bypassText = String(bypass.data["content"])
    assert.match(bypassText, /^generated\/$/m)
    assert.match(bypassText, /^ {2}x\.txt {2}\d+ B$/m)
    assert.match(bypassText, /debug\.log/)
    assert.match(bypassText, /keep\.log/)
})

test("点文件默认出现", { timeout: 30_000 }, async () => {
    const workspace = await workspaceFor("dotfiles")
    await write(workspace, ".env", "A=1\n")

    const result = await callTool("list_dir", workspace, {})
    assert.equal(result.success, true, JSON.stringify(result.data))
    assert.equal(
        String(result.data["content"]),
        [".env  4 B", "[共 0 个目录，1 个文件]"].join("\n"),
    )
})

test("path 指定起点：输出相对该起点", { timeout: 30_000 }, async () => {
    const workspace = await workspaceFor("start-path")
    await write(workspace, "src/a.ts", "a\n")
    await write(workspace, "src/deep/b.ts", "b\n")
    await write(workspace, "other/c.ts", "c\n")

    const result = await callTool("list_dir", workspace, { path: "src", depth: 1 })
    assert.equal(result.success, true, JSON.stringify(result.data))
    assert.equal(
        String(result.data["content"]),
        ["a.ts  2 B", "deep/", "[共 1 个目录，1 个文件]"].join("\n"),
    )
})

test("path 指向文件或不存在：FS_NOT_DIRECTORY / FS_NOT_FOUND", { timeout: 30_000 }, async () => {
    const workspace = await workspaceFor("path-errors")
    await write(workspace, "a.txt", "x")

    const onFile = await callTool("list_dir", workspace, { path: "a.txt" })
    assert.equal(onFile.success, false)
    assert.equal(onFile.data["code"], "FS_NOT_DIRECTORY")
    assert.match(String(onFile.data["error"]), /无法列出/)
    assert.match(String(onFile.data["error"]), /不是目录/)

    const missing = await callTool("list_dir", workspace, { path: "no-such-dir" })
    assert.equal(missing.success, false)
    assert.equal(missing.data["code"], "FS_NOT_FOUND")
    assert.match(String(missing.data["error"]), /文件不存在/)
})

test("条目达到上限 500：提前停止并标记 truncated", { timeout: 30_000 }, async () => {
    const workspace = await workspaceFor("entry-limit")
    for (let index = 0; index < 501; index += 1) {
        await write(workspace, `file-${String(index).padStart(3, "0")}.txt`, "x")
    }

    const result = await callTool("list_dir", workspace, { depth: 1 })
    assert.equal(result.success, true, JSON.stringify(result.data))
    assert.equal(result.data["files"], 500)
    assert.equal(result.data["directories"], 0)
    assert.equal(result.data["truncated"], true)
    const content = String(result.data["content"])
    assert.match(content, /\[条目达到上限 500\]/)
    assert.ok(!content.includes("file-500.txt"), content)
})
