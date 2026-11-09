import assert from "node:assert/strict"
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
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
let workspace = ""
let tools: AgentToolRegistry

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-run-tools-"))
    workspace = join(root, "workspace")
    await mkdir(workspace, { recursive: true })
    // execute_code 需要 Agent 工具上下文，先初始化日志流
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

interface ToolResult {
    readonly success: boolean
    readonly data: Record<string, unknown>
    readonly content?: string
}

// 工作区上下文里调工具；execute_code 需要 allowExec
async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const record = tools.get(name)
    assert.ok(record, `工具未注册：${name}`)
    return await withAgentToolContext(
        {
            sessionId: "run-tools-test",
            turn: 1,
            step: 1,
            workspaceDir: workspace,
            permission: "workspace-write",
            allowExec: true,
            elog: getElog(),
        },
        async () => await record.tool.call(args),
    )
}

function nodeScript(script: string): Record<string, unknown> {
    // 沙箱 PATH 不一定含 node，直接给当前可执行文件
    return { command: process.execPath, argv: ["-e", script] }
}

test("stdout 超预算时落盘，run_output 可按行读回", { timeout: 60_000 }, async () => {
    const executed = await callTool("execute_code", nodeScript("process.stdout.write('y'.repeat(20000))"))
    assert.equal(executed.success, true, JSON.stringify(executed.data))
    const spill = String(executed.data["stdoutSpill"] ?? "")
    assert.match(spill, /^runs\/[0-9]{8}-[0-9]{9}-[0-9a-f]{6}\/stdout\.txt$/)
    const content = String(executed.content ?? "")
    assert.ok(content.includes(spill), content)
    assert.match(content, /run_output/)

    const read = await callTool("run_output", { file: spill })
    assert.equal(read.success, true, JSON.stringify(read.data))
    const text = String(read.data["content"])
    assert.match(text, /y{100}/)
    assert.match(text, /\[lines 1-1 of 1\]/)
    assert.match(text, /超过 2000 字符/)
})

test("多行输出落盘后按 offset / limit 分页", { timeout: 60_000 }, async () => {
    const script = "process.stdout.write(Array.from({length:1500},(_,i)=>'line '+i).join('\\n'))"
    const executed = await callTool("execute_code", nodeScript(script))
    assert.equal(executed.success, true, JSON.stringify(executed.data))
    const spill = String(executed.data["stdoutSpill"] ?? "")
    assert.notEqual(spill, "")

    const first = await callTool("run_output", { file: spill, limit: 3 })
    assert.equal(first.success, true, JSON.stringify(first.data))
    const firstText = String(first.data["content"])
    assert.match(firstText, /line 0/)
    assert.match(firstText, /line 2/)
    assert.match(firstText, /\[lines 1-3 of 1500\]/)
    assert.match(firstText, /继续读取：offset=4/)

    const last = await callTool("run_output", { file: spill, offset: 1499 })
    assert.equal(last.success, true, JSON.stringify(last.data))
    assert.match(String(last.data["content"]), /\[lines 1499-1500 of 1500\]/)
})

test("stderr 超预算同样落盘，正文只留尾部", { timeout: 60_000 }, async () => {
    const executed = await callTool(
        "execute_code",
        nodeScript("process.stderr.write('e'.repeat(5000))"),
    )
    assert.equal(executed.success, true, JSON.stringify(executed.data))
    const spill = String(executed.data["stderrSpill"] ?? "")
    assert.match(spill, /^runs\/.*\/stderr\.txt$/)
    const content = String(executed.content ?? "")
    assert.match(content, /\[stderr\]/)
    assert.ok(content.includes(spill), content)

    const read = await callTool("run_output", { file: spill })
    assert.equal(read.success, true, JSON.stringify(read.data))
    assert.match(String(read.data["content"]), /e{100}/)
})

test("未超预算不落盘", { timeout: 60_000 }, async () => {
    const executed = await callTool("execute_code", nodeScript("process.stdout.write('hi')"))
    assert.equal(executed.success, true, JSON.stringify(executed.data))
    assert.equal(executed.data["stdoutSpill"], undefined)
    assert.equal(executed.data["stderrSpill"], undefined)
    assert.equal(String(executed.content ?? ""), "hi")
})

test("run_output 只接受 runs/ 路径，缺失文件报错", { timeout: 30_000 }, async () => {
    const escaped = await callTool("run_output", { file: "../etc/passwd" })
    assert.equal(escaped.success, false)
    assert.equal(escaped.data["code"], "FS_BAD_ARGUMENT")

    const absolute = await callTool("run_output", { file: "/etc/passwd" })
    assert.equal(absolute.success, false)
    assert.equal(absolute.data["code"], "FS_BAD_ARGUMENT")

    const missing = await callTool("run_output", { file: "runs/missing/stdout.txt" })
    assert.equal(missing.success, false)
    assert.equal(missing.data["code"], "FS_NOT_FOUND")

    const empty = await callTool("run_output", { file: "" })
    assert.equal(empty.success, false)
    assert.equal(empty.data["code"], "FS_BAD_ARGUMENT")
})

test("run_output offset / limit 校验", { timeout: 60_000 }, async () => {
    const executed = await callTool("execute_code", nodeScript("process.stdout.write('y'.repeat(9000))"))
    const spill = String(executed.data["stdoutSpill"] ?? "")
    assert.notEqual(spill, "")

    const badOffset = await callTool("run_output", { file: spill, offset: 0 })
    assert.equal(badOffset.success, false)
    assert.equal(badOffset.data["code"], "FS_BAD_ARGUMENT")

    const badLimit = await callTool("run_output", { file: spill, limit: 0 })
    assert.equal(badLimit.success, false)
    assert.equal(badLimit.data["code"], "FS_BAD_ARGUMENT")

    const pastEof = await callTool("run_output", { file: spill, offset: 99 })
    assert.equal(pastEof.success, false)
    assert.equal(pastEof.data["code"], "FS_OUT_OF_RANGE")
})
