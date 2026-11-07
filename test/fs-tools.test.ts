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
    root = await mkdtemp(join(tmpdir(), "wellspring-fs-tools-"))
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
    workspaceDir = workspace,
): Promise<ToolResult> {
    const record = tools.get(name)
    assert.ok(record, `工具未注册：${name}`)
    return await withAgentToolContext(
        {
            sessionId: "fs-tools-test",
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

test("write 创建文件与父目录，内容原样落盘", { timeout: 30_000 }, async () => {
    const result = await callTool("write", "workspace-write", {
        file_path: "nested/dir/a.txt",
        content: "alpha\nbeta\n",
    })
    assert.equal(result.success, true, JSON.stringify(result.data))
    assert.equal(result.data["created"], true)
    assert.equal(result.data["lines"], 2)
    assert.equal(result.data["bytes"], 11)
    assert.match(String(result.data["content"]), /已创建/)
    assert.equal(await readFile(join(workspace, "nested/dir/a.txt"), "utf8"), "alpha\nbeta\n")

    const overwritten = await callTool("write", "workspace-write", {
        file_path: "nested/dir/a.txt",
        content: "gamma",
    })
    assert.equal(overwritten.success, true)
    assert.equal(overwritten.data["created"], false)
    assert.match(String(overwritten.data["content"]), /已覆盖/)
    assert.equal(await readFile(join(workspace, "nested/dir/a.txt"), "utf8"), "gamma")
})

test("write 拒绝目录，read-only 回合拒绝写入", { timeout: 30_000 }, async () => {
    await mkdir(join(workspace, "a-directory"), { recursive: true })
    const onDirectory = await callTool("write", "workspace-write", {
        file_path: "a-directory",
        content: "x",
    })
    assert.equal(onDirectory.success, false)
    assert.equal(onDirectory.data["code"], "FS_NOT_REGULAR_FILE")

    const content = await callTool("write", "workspace-write", {
        file_path: "blocked.txt",
        content: "x",
    })
    assert.equal(content.success, true)

    // 宿主按本次调用的会话权限拒绝写工作区
    await assert.rejects(
        async () =>
            await callTool("write", "read-only", { file_path: "blocked.txt", content: "changed" }),
        /read-only/,
    )
    assert.equal(await readFile(join(workspace, "blocked.txt"), "utf8"), "x")
})

test("edit 唯一命中：行号与其余内容保持原样", { timeout: 30_000 }, async () => {
    await writeFile(join(workspace, "edit.txt"), "line1\nline2\nline3\n", "utf8")
    const result = await callTool("edit", "workspace-write", {
        file_path: "edit.txt",
        old_string: "line2",
        new_string: "LINE2",
    })
    assert.equal(result.success, true, JSON.stringify(result.data))
    assert.equal(result.data["replaced"], 1)
    assert.deepEqual(result.data["lines"], [2])
    assert.match(String(result.data["content"]), /第 2 行/)
    assert.equal(await readFile(join(workspace, "edit.txt"), "utf8"), "line1\nLINE2\nline3\n")
})

test("edit 多处命中拒绝，replace_all 全部替换", { timeout: 30_000 }, async () => {
    await writeFile(join(workspace, "multi.txt"), "old x\nold x\n", "utf8")
    const ambiguous = await callTool("edit", "workspace-write", {
        file_path: "multi.txt",
        old_string: "old x",
        new_string: "new",
    })
    assert.equal(ambiguous.success, false)
    assert.equal(ambiguous.data["code"], "FS_AMBIGUOUS_MATCH")
    assert.match(String(ambiguous.data["error"]), /命中 2 处/)

    const replaced = await callTool("edit", "workspace-write", {
        file_path: "multi.txt",
        old_string: "old x",
        new_string: "new",
        replace_all: true,
    })
    assert.equal(replaced.success, true)
    assert.equal(replaced.data["replaced"], 2)
    assert.equal(await readFile(join(workspace, "multi.txt"), "utf8"), "new\nnew\n")
})

test("edit 未命中：普通原文与 CRLF 换行分开提示", { timeout: 30_000 }, async () => {
    await writeFile(join(workspace, "crlf.txt"), "one\r\ntwo\r\n", "utf8")
    const miss = await callTool("edit", "workspace-write", {
        file_path: "crlf.txt",
        old_string: "nope",
        new_string: "x",
    })
    assert.equal(miss.success, false)
    assert.equal(miss.data["code"], "FS_NO_MATCH")

    const lfOnly = await callTool("edit", "workspace-write", {
        file_path: "crlf.txt",
        old_string: "one\ntwo",
        new_string: "x",
    })
    assert.equal(lfOnly.success, false)
    assert.equal(lfOnly.data["code"], "FS_NO_MATCH")
    assert.match(String(lfOnly.data["error"]), /CRLF/)

    const exact = await callTool("edit", "workspace-write", {
        file_path: "crlf.txt",
        old_string: "one\r\ntwo",
        new_string: "one\r\ntwo\r\nthree",
    })
    assert.equal(exact.success, true)
    assert.equal(await readFile(join(workspace, "crlf.txt"), "utf8"), "one\r\ntwo\r\nthree\r\n")
})

test("edit 拒绝二进制与不存在的文件", { timeout: 30_000 }, async () => {
    await writeFile(join(workspace, "blob.bin"), Buffer.from([0, 1, 2, 0, 255]))
    const binary = await callTool("edit", "workspace-write", {
        file_path: "blob.bin",
        old_string: "a",
        new_string: "b",
    })
    assert.equal(binary.success, false)
    assert.equal(binary.data["code"], "FS_NOT_TEXT")

    const missing = await callTool("edit", "workspace-write", {
        file_path: "not-there.txt",
        old_string: "a",
        new_string: "b",
    })
    assert.equal(missing.success, false)
    assert.equal(missing.data["code"], "FS_NOT_FOUND")
    assert.match(String(missing.data["error"]), /文件不存在/)
})

test("切换工作区后，工作区内绝对路径仍按当前会话解析", { timeout: 30_000 }, async () => {
    const other = await mkdtemp(join(tmpdir(), "wellspring-fs-tools-other-"))
    try {
        // 先在本工作区调用一次，root 缓存停在本工作区
        await callTool("write", "workspace-write", { file_path: "before.txt", content: "x" })
        const target = join(other, "moved", "x.txt")
        const written = await callTool(
            "write",
            "workspace-write",
            { file_path: target, content: "ok\n" },
            other,
        )
        assert.equal(written.success, true, JSON.stringify(written.data))
        assert.equal(await readFile(target, "utf8"), "ok\n")
    } finally {
        await rm(other, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
})

test("write 覆盖已有文件前要求先读，读后被改动又要重读", { timeout: 30_000 }, async () => {
    await writeFile(join(workspace, "guard.txt"), "old\n", "utf8")
    const blocked = await callTool("write", "workspace-write", {
        file_path: "guard.txt",
        content: "new\n",
    })
    assert.equal(blocked.success, false)
    assert.equal(blocked.data["code"], "FS_READ_REQUIRED")
    assert.match(String(blocked.data["error"]), /未读文件/)

    const read = await callTool("read", "workspace-write", { file_path: "guard.txt" })
    assert.equal(read.success, true, JSON.stringify(read.data))

    const allowed = await callTool("write", "workspace-write", {
        file_path: "guard.txt",
        content: "new\n",
    })
    assert.equal(allowed.success, true, JSON.stringify(allowed.data))
    assert.equal(await readFile(join(workspace, "guard.txt"), "utf8"), "new\n")

    // 刚写完的版本视为已读
    const again = await callTool("write", "workspace-write", {
        file_path: "guard.txt",
        content: "next\n",
    })
    assert.equal(again.success, true, JSON.stringify(again.data))

    // 外部改动后旧签名失效
    await writeFile(join(workspace, "guard.txt"), "changed externally\n", "utf8")
    const stale = await callTool("write", "workspace-write", {
        file_path: "guard.txt",
        content: "x",
    })
    assert.equal(stale.success, false)
    assert.equal(stale.data["code"], "FS_READ_REQUIRED")

    // 新文件无需先读
    const created = await callTool("write", "workspace-write", {
        file_path: "brand-new.txt",
        content: "x",
    })
    assert.equal(created.success, true, JSON.stringify(created.data))
})

test("write / edit 参数校验：content 不是字符串、old_string 为空", { timeout: 30_000 }, async () => {
    const badContent = await callTool("write", "workspace-write", {
        file_path: "bad.txt",
        content: 42,
    })
    assert.equal(badContent.success, false)
    assert.equal(badContent.data["code"], "FS_BAD_ARGUMENT")

    const emptyOld = await callTool("edit", "workspace-write", {
        file_path: "bad.txt",
        old_string: "",
        new_string: "x",
    })
    assert.equal(emptyOld.success, false)
    assert.equal(emptyOld.data["code"], "FS_BAD_ARGUMENT")
})
