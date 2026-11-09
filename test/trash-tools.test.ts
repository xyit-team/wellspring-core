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
import { PLUGIN_FILES } from "./plugin-files.ts"

let root = ""
let workspace = ""
let tools: AgentToolRegistry

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-trash-tools-"))
    workspace = join(root, "workspace")
    await mkdir(workspace, { recursive: true })
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

// 工作区上下文里调工具
async function callTool(
    name: string,
    args: Record<string, unknown>,
    permission: SandboxAccess = "workspace-write",
): Promise<ToolResult> {
    const record = tools.get(name)
    assert.ok(record, `工具未注册：${name}`)
    return await withAgentToolContext(
        {
            sessionId: "trash-tools-test",
            turn: 1,
            step: 1,
            workspaceDir: workspace,
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

test("delete_file 的条目可列出并恢复，恢复后回收站清空", { timeout: 30_000 }, async () => {
    await writeFile(join(workspace, "keep.txt"), "hello\n", "utf8")
    const deleted = await callTool("delete_file", { path: "keep.txt" })
    assert.equal(deleted.success, true, JSON.stringify(deleted.data))
    const trashId = String(deleted.data["trashId"] ?? "")
    assert.match(trashId, /^[0-9]{8}-[0-9]{9}-[0-9a-f]{6}$/)
    assert.match(String(deleted.data["content"]), /trashId [0-9a-f-]+/)

    const listed = await callTool("trash_list", {})
    assert.equal(listed.success, true, JSON.stringify(listed.data))
    const text = String(listed.data["content"])
    assert.ok(text.includes(trashId), text)
    assert.match(text, /文件/)
    assert.match(text, /keep\.txt/)
    assert.match(text, /UTC/)

    const restored = await callTool("trash_restore", { entry: trashId })
    assert.equal(restored.success, true, JSON.stringify(restored.data))
    assert.equal(restored.data["path"], "keep.txt")
    assert.equal(await readFile(join(workspace, "keep.txt"), "utf8"), "hello\n")

    const empty = await callTool("trash_list", {})
    assert.equal(String(empty.data["content"]), "回收站为空")
})

test("目录按整棵恢复", { timeout: 30_000 }, async () => {
    await mkdir(join(workspace, "docs/sub"), { recursive: true })
    await writeFile(join(workspace, "docs/a.md"), "a\n", "utf8")
    await writeFile(join(workspace, "docs/sub/b.md"), "b\n", "utf8")
    const deleted = await callTool("delete_file", { path: "docs", recursive: true })
    assert.equal(deleted.success, true, JSON.stringify(deleted.data))

    const listed = await callTool("trash_list", {})
    assert.match(String(listed.data["content"]), /目录/)
    assert.match(String(listed.data["content"]), /2 文件/)

    const trashId = String(deleted.data["trashId"] ?? "")
    const restored = await callTool("trash_restore", { entry: trashId })
    assert.equal(restored.success, true, JSON.stringify(restored.data))
    assert.equal(await readFile(join(workspace, "docs/a.md"), "utf8"), "a\n")
    assert.equal(await readFile(join(workspace, "docs/sub/b.md"), "utf8"), "b\n")
})

test("恢复目标已存在时拒绝", { timeout: 30_000 }, async () => {
    await writeFile(join(workspace, "dupe.txt"), "old\n", "utf8")
    const deleted = await callTool("delete_file", { path: "dupe.txt" })
    const trashId = String(deleted.data["trashId"] ?? "")
    await writeFile(join(workspace, "dupe.txt"), "new\n", "utf8")

    const restored = await callTool("trash_restore", { entry: trashId })
    assert.equal(restored.success, false, JSON.stringify(restored.data))
    assert.equal(restored.data["code"], "TRASH_TARGET_EXISTS")
    assert.equal(await readFile(join(workspace, "dupe.txt"), "utf8"), "new\n")
})

test("条目 id 非法与不存在", { timeout: 30_000 }, async () => {
    const badId = await callTool("trash_restore", { entry: "../etc/passwd" })
    assert.equal(badId.success, false)
    assert.equal(badId.data["code"], "TRASH_BAD_ID")

    const missing = await callTool("trash_restore", { entry: "20260101-000000000-abcdef" })
    assert.equal(missing.success, false)
    assert.equal(missing.data["code"], "TRASH_ENTRY_NOT_FOUND")

    const empty = await callTool("trash_restore", { entry: "" })
    assert.equal(empty.success, false)
    assert.equal(empty.data["code"], "TRASH_BAD_ID")
})

test("trash_list 的 limit 校验", { timeout: 30_000 }, async () => {
    for (const limit of [0, 201, "abc"]) {
        const result = await callTool("trash_list", { limit })
        assert.equal(result.success, false, `limit=${String(limit)}`)
        assert.equal(result.data["code"], "FS_BAD_ARGUMENT")
    }
})
