import assert from "node:assert/strict"
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { after, before, test } from "node:test"

import pino from "pino"

import { DEFAULT_SETTINGS } from "../.host/src/config/defaults.ts"
import { emitSessionStart } from "../.host/src/api/host/hooks.ts"
import type { ResolvedPaths } from "../.host/src/platform/path.ts"
import { DirectBackend } from "../.host/src/sandbox/backends/direct.ts"
import { AgentToolRegistry } from "../.host/src/plugin/agent-tools.ts"
import { withAgentToolContext } from "../.host/src/agent/tool-context.ts"
import { createHostCapabilities } from "../.host/src/plugin/capabilities.ts"
import { loadPlugins } from "../.host/src/plugin/loader.ts"
import { shutdownAllSandboxPlugins } from "../.host/src/sandbox/plugin-client.ts"
import { PluginRegistry } from "../.host/src/plugin/registry.ts"
import { Elog } from "../.host/src/logger/elog4js.ts"
import { PLUGIN_FILES } from "./plugin-files.ts"

/** Windows 上没有 /bin/sh 与 POSIX 信号；这些用例只在 Linux/macOS 上跑 */
const POSIX_ONLY = process.platform === "win32" ? "需要 /bin/sh 与 POSIX 信号，仅 Linux/macOS" : false

let root = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-core-plugin-"))
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

test("@xyit-team/wellspring-core 注册全部 Agent 工具", { timeout: 20_000, skip: POSIX_ONLY }, async () => {
    const dataDir = join(root, "data")
    const destination = join(dataDir, "plugins", "@xyit-team", "wellspring-core")
    await mkdir(destination, { recursive: true })
    // 仓库根还有 node_modules / .host / test，只复制插件自己的文件
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
    assert.deepEqual(
        agentTools
            .list()
            .map((record) => record.tool.name)
            .sort(),
        [
            "delete_file",
            "edit",
            "execute_code",
            "glob",
            "grep",
            "query_task",
            "read",
            "skill_install",
            "skill_list",
            "skill_modify",
            "skill_read",
            "stop_task",
            "web_fetch",
            "web_search",
            "write",
        ],
    )

    // onSessionStart：core 插件把运行环境与工具列表注入 system prompt
    const prompt: string[] = []
    await emitSessionStart({
        sessionId: "core-session",
        mode: "run",
        turn: 1,
        input: "hi",
        cwd: process.cwd(),
        time: Date.now(),
        timeZone: "Asia/Shanghai",
        model: "test-model",
        permission: "workspace-write",
        tools: [
            { name: "read", description: "读取文件" },
            { name: "ask", description: "向用户提问" },
        ],
        prompt,
    })
    assert.equal(prompt.length, 1)
    const injected = prompt[0] ?? ""
    assert.match(injected, /## 会话环境/)
    assert.ok(injected.includes(`- 工作目录：${process.cwd()}`))
    assert.match(injected, /- 模型：test-model/)
    assert.match(injected, /- 沙箱权限：workspace-write/)
    assert.match(injected, /Asia\/Shanghai/)
    assert.match(injected, /## 可用工具/)
    assert.match(injected, /- read：读取文件/)
    assert.match(injected, /- ask：向用户提问/)

    const relative = ".tmp/core-read.txt"
    await mkdir(join(process.cwd(), ".tmp"), { recursive: true })
    await writeFile(join(process.cwd(), relative), "alpha\nbeta\n")
    const read = agentTools.get("read")
    assert.ok(read)
    const result = await read.tool.call({ file_path: relative })
    assert.equal(result.success, true)
    assert.match(String(result.data["content"] ?? ""), /1│ alpha/)

    // 工作区内的绝对路径直接可用：模型手里往往是绝对路径
    const absoluteRead = await read.tool.call({ file_path: join(process.cwd(), relative) })
    assert.equal(absoluteRead.success, true)
    assert.match(String(absoluteRead.data["content"] ?? ""), /1│ alpha/)

    // 工作区外：明确拒绝并带上根目录
    await assert.rejects(
        async () => await read.tool.call({ file_path: join(tmpdir(), "outside-workspace.txt") }),
        /不在工作区内/,
    )

    // 不存在：错误里带绝对路径与工作区根目录，够调用方自己纠偏
    const missingRead = await read.tool.call({ file_path: ".tmp/core-read-missing.txt" })
    assert.equal(missingRead.success, false)
    assert.match(String(missingRead.data["error"]), /文件不存在/)
    assert.match(String(missingRead.data["error"]), /工作区根目录/)
    assert.match(String(missingRead.data["error"]), /core-read-missing\.txt/)

    // 路径指向目录：给一句人话，别抛 EISDIR
    const dirRead = await read.tool.call({ file_path: ".tmp" })
    assert.equal(dirRead.success, false)
    assert.match(String(dirRead.data["error"]), /是目录/)
    assert.equal(dirRead.data["code"], "FS_NOT_DIRECTORY")

    // offset 越界：明确报错，而不是返回一个空窗口配一句 "lines 9999-100 of 100"
    const pastEof = await read.tool.call({ file_path: relative, offset: 9999 })
    assert.equal(pastEof.success, false)
    assert.match(String(pastEof.data["error"]), /offset 9999 超出范围/)
    assert.equal(pastEof.data["code"], "FS_OUT_OF_RANGE")

    // offset / limit 静默夹取会掩盖调用错误，改成结构化失败
    const badOffset = await read.tool.call({ file_path: relative, offset: 0 })
    assert.equal(badOffset.success, false)
    assert.match(String(badOffset.data["error"]), /offset 需要是正整数/)
    assert.equal(badOffset.data["code"], "FS_BAD_ARGUMENT")

    const badLimit = await read.tool.call({ file_path: relative, limit: 0 })
    assert.equal(badLimit.success, false)
    assert.match(String(badLimit.data["error"]), /limit 需要是 1-2000/)

    // 二进制文件：直说，不要吐解码乱码
    await writeFile(join(process.cwd(), ".tmp", "core-binary.bin"), Buffer.from([0, 1, 2, 0, 255]))
    const binaryRead = await read.tool.call({ file_path: ".tmp/core-binary.bin" })
    assert.equal(binaryRead.success, false)
    assert.match(String(binaryRead.data["error"]), /二进制文件/)
    assert.equal(binaryRead.data["code"], "FS_NOT_TEXT")

    /*
     * 会话工作区优先于宿主 cwd
     * `wellspring start` 常驻时 cwd 是启动目录，与会话工作区不同；
     * 同名文件放在两处，按会话上下文读到的必须是会话工作区那份。
     */
    const sessionWorkspace = await mkdtemp(join(tmpdir(), "wellspring-core-ws-"))
    await writeFile(join(sessionWorkspace, "same-name.txt"), "session\n")
    await writeFile(join(process.cwd(), ".tmp", "same-name.txt"), "cwd\n")
    const sessionRead = await withAgentToolContext(
        {
            sessionId: "s-workspace",
            turn: 1,
            step: 1,
            workspaceDir: sessionWorkspace,
            permission: "workspace-write",
            allowExec: true,
            elog: new Elog({
                stdout: { write: () => {} },
                stderr: { write: () => {} },
                color: false,
            }),
        },
        async () => await read.tool.call({ file_path: ".tmp/same-name.txt" }),
    )
    assert.equal(sessionRead.success, false, "会话工作区里没有 .tmp/same-name.txt")
    assert.match(String(sessionRead.data["error"]), /文件不存在/)
    const sessionRootRead = await withAgentToolContext(
        {
            sessionId: "s-workspace",
            turn: 1,
            step: 1,
            workspaceDir: sessionWorkspace,
            permission: "workspace-write",
            allowExec: true,
            elog: new Elog({
                stdout: { write: () => {} },
                stderr: { write: () => {} },
                color: false,
            }),
        },
        async () => await read.tool.call({ file_path: "same-name.txt" }),
    )
    assert.equal(sessionRootRead.success, true)
    assert.match(String(sessionRootRead.data["content"] ?? ""), /1│ session/)
    await rm(sessionWorkspace, { recursive: true, force: true })

    // delete_file：文件、目录（需 recursive）、不存在路径、工作区根目录
    const deleteTool = agentTools.get("delete_file")
    assert.ok(deleteTool)
    const deleteFile = join(process.cwd(), ".tmp", "core-delete.txt")
    await writeFile(deleteFile, "删除我\n")
    const deleted = await deleteTool.tool.call({ path: ".tmp/core-delete.txt" })
    assert.equal(deleted.success, true)
    assert.match(String(deleted.data["content"]), /已把文件移到回收站/)
    assert.match(String(deleted.data["content"]), /core-delete\.txt/)
    assert.equal(
        await readFile(deleteFile, "utf8").then(
            () => true,
            () => false,
        ),
        false,
    )
    // 原文件进回收站：内容保留，meta.json 记录原路径
    const trashRootDir = join(root, "data", "plugin-data", "@xyit-team", "wellspring-core", "trash")
    const deletedTrash = String(deleted.data["trashPath"] ?? "")
    assert.match(deletedTrash, /plugin-data[/\\]@xyit-team[/\\]wellspring-core[/\\]trash[/\\]/)
    assert.equal(deleted.data["trashRoot"], trashRootDir)
    assert.deepEqual((await readdir(deletedTrash)).sort(), ["files", "meta.json"])
    assert.equal(
        await readFile(join(deletedTrash, "files", ".tmp", "core-delete.txt"), "utf8"),
        "删除我\n",
    )
    const deletedMeta = JSON.parse(await readFile(join(deletedTrash, "meta.json"), "utf8")) as {
        path: string
        type: string
        files: number
    }
    assert.equal(deletedMeta.path, ".tmp/core-delete.txt")
    assert.equal(deletedMeta.type, "file")
    assert.equal(deletedMeta.files, 1)

    const nestedDir = join(process.cwd(), ".tmp", "core-delete-dir")
    await mkdir(nestedDir, { recursive: true })
    await writeFile(join(nestedDir, "nested.txt"), "x")
    const noRecursive = await deleteTool.tool.call({ path: ".tmp/core-delete-dir" })
    assert.equal(noRecursive.success, false)
    assert.match(String(noRecursive.data["error"]), /recursive/)
    const removedDir = await deleteTool.tool.call({
        path: ".tmp/core-delete-dir",
        recursive: true,
    })
    assert.equal(removedDir.success, true)
    assert.match(String(removedDir.data["content"]), /已把目录移到回收站/)
    assert.equal(
        await readFile(nestedDir, "utf8").then(
            () => true,
            () => false,
        ),
        false,
    )
    // 目录整棵进回收站
    const dirTrash = String(removedDir.data["trashPath"] ?? "")
    assert.equal(
        await readFile(join(dirTrash, "files", ".tmp", "core-delete-dir", "nested.txt"), "utf8"),
        "x",
    )

    const missingDelete = await deleteTool.tool.call({ path: ".tmp/no-such-file" })
    assert.equal(missingDelete.success, false)
    assert.match(String(missingDelete.data["error"]), /不存在/)
    await assert.rejects(async () => await deleteTool.tool.call({ path: "." }), /工作区根目录/)
    await assert.rejects(async () => await deleteTool.tool.call({ path: "a/.." }), /工作区根目录/)

    // delete_file 受本轮权限约束：read-only 下拒绝写工作区
    const elog = new Elog({
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        color: false,
    })
    const guardFile = join(process.cwd(), ".tmp", "core-delete-guard.txt")
    await writeFile(guardFile, "keep")
    const trashBeforeGuard = await readdir(trashRootDir)
    await assert.rejects(
        () =>
            withAgentToolContext(
                {
                    sessionId: "s",
                    turn: 1,
                    step: 1,
                    workspaceDir: process.cwd(),
                    permission: "read-only",
                    allowExec: true,
                    elog,
                },
                async () => await deleteTool.tool.call({ path: ".tmp/core-delete-guard.txt" }),
            ),
        /read-only/,
    )
    assert.equal(
        await readFile(guardFile, "utf8").then(
            () => true,
            () => false,
        ),
        true,
    )
    assert.deepEqual(await readdir(trashRootDir), trashBeforeGuard)

    const missing = await agentTools.get("query_task")?.tool.call({ task_id: "nope" })
    assert.equal(missing?.success, false)
    const stopped = await agentTools.get("stop_task")?.tool.call({ type: "kill", task_id: "nope" })
    assert.equal(stopped?.success, false)

    // ── SKILL 工具 ──
    const skillListTool = agentTools.get("skill_list")
    const skillInstallTool = agentTools.get("skill_install")
    const skillReadTool = agentTools.get("skill_read")
    const skillModifyTool = agentTools.get("skill_modify")
    assert.ok(skillListTool)
    assert.ok(skillInstallTool)
    assert.ok(skillReadTool)
    assert.ok(skillModifyTool)

    const emptyList = await skillListTool.tool.call({})
    assert.equal(emptyList.success, true)
    assert.deepEqual((emptyList.data as { skills: unknown[] }).skills, [])

    const skillText = [
        "---",
        "name: demo-skill",
        "description: 演示技能",
        "whenToUse: 当需要演示时",
        "metadata:",
        "  owner: core",
        "---",
        "# 步骤",
        "1. 打招呼",
        "",
    ].join("\n")
    const installed = await skillInstallTool.tool.call({ content: skillText })
    assert.equal(installed.success, true)
    assert.equal((installed.data as { skill: { name: string } }).skill.name, "demo-skill")

    const duplicate = await skillInstallTool.tool.call({ content: skillText })
    assert.equal(duplicate.success, false)
    assert.match(String(duplicate.data["error"]), /已存在/)
    const overwritten = await skillInstallTool.tool.call({ content: skillText, overwrite: true })
    assert.equal(overwritten.success, true)

    const listed = await skillListTool.tool.call({})
    const listedSkills = (listed.data as { skills: Array<Record<string, unknown>> }).skills
    const demo = listedSkills.find((item) => item["name"] === "demo-skill")
    assert.ok(demo)
    assert.equal(demo?.["description"], "演示技能")
    assert.equal(demo?.["whenToUse"], "当需要演示时")
    assert.deepEqual(demo?.["metadata"], { owner: "core" })

    const readSkillResult = await skillReadTool.tool.call({ name: "demo-skill" })
    assert.equal(readSkillResult.success, true)
    assert.match(String(readSkillResult.data["content"]), /# 步骤/)
    assert.equal((readSkillResult.data["skill"] as { description: string }).description, "演示技能")

    const modified = await skillModifyTool.tool.call({
        name: "demo-skill",
        description: "更新后的演示技能",
        body: "# 新步骤\n继续",
    })
    assert.equal(modified.success, true)
    const reread = await skillReadTool.tool.call({ name: "demo-skill" })
    const rereadSkill = reread.data["skill"] as {
        description: string
        metadata?: Record<string, unknown>
    }
    assert.equal(rereadSkill.description, "更新后的演示技能")
    assert.deepEqual(rereadSkill.metadata, { owner: "core" })
    assert.match(String(reread.data["content"]), /新步骤/)

    const invalid = await skillInstallTool.tool.call({ content: "---\nname: bad skill\n---\nx" })
    assert.equal(invalid.success, false)

    const sourceDir = join(process.cwd(), ".tmp", "core-skill-source")
    await mkdir(join(sourceDir, "scripts"), { recursive: true })
    await writeFile(
        join(sourceDir, "SKILL.md"),
        "---\nname: workspace-skill\ndescription: 从工作区安装\n---\n# 工作区技能\n",
        "utf8",
    )
    await writeFile(join(sourceDir, "scripts", "run.sh"), "#!/bin/sh\necho hi\n", "utf8")
    const fromWorkspace = await skillInstallTool.tool.call({ path: ".tmp/core-skill-source" })
    assert.equal(fromWorkspace.success, true)
    const resource = await skillReadTool.tool.call({
        name: "workspace-skill",
        file: "scripts/run.sh",
    })
    assert.equal(resource.success, true)
    assert.match(String(resource.data["content"]), /echo hi/)

    const traversal = await skillReadTool.tool.call({ name: "demo-skill", file: "../evil" })
    assert.equal(traversal.success, false)

    const execute = agentTools.get("execute_code")
    assert.ok(execute)
    const executeResult = await withAgentToolContext(
        {
            sessionId: "s",
            turn: 1,
            step: 1,
            workspaceDir: process.cwd(),
            permission: "read-only",
            allowExec: true,
            elog,
        },
        async () =>
            await execute.tool.call({
                command: "/bin/sh",
                argv: ["-c", "echo core"],
                sandbox_permissions: "workspace-write",
                network: false,
                background: false,
            }),
    )
    assert.equal(executeResult.success, true)
    assert.equal(executeResult.data["access"], "workspace-write")

    const background = await withAgentToolContext(
        {
            sessionId: "s",
            turn: 1,
            step: 1,
            workspaceDir: process.cwd(),
            permission: "read-only",
            allowExec: true,
            elog,
        },
        async () =>
            await execute.tool.call({
                command: "/bin/sleep",
                argv: ["60"],
                background: true,
            }),
    )
    assert.equal(background.success, true)
    assert.equal(typeof background.data["taskId"], "string")
    const stop = await agentTools.get("stop_task")?.tool.call({
        type: "kill",
        task_id: background.data["taskId"],
    })
    assert.equal(stop?.success, true)
    await new Promise((resolve) => setTimeout(resolve, 150))
    const cancelled = await agentTools.get("query_task")?.tool.call({
        task_id: background.data["taskId"],
    })
    assert.equal(cancelled?.data["status"], "cancelled")
    const taskResult = cancelled?.data["result"]
    if (taskResult !== null && typeof taskResult === "object") {
        assert.equal("hostArtifactDir" in taskResult, false)
        assert.equal("hostSandboxDir" in taskResult, false)
    }
})

test("宿主 capabilities 在 Agent 上下文中执行代码", { timeout: 20_000, skip: POSIX_ONLY }, async () => {
    const elog = new Elog({
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        color: false,
    })
    const capabilities = createHostCapabilities({
        config: {
            ...DEFAULT_SETTINGS,
            sandbox: { ...DEFAULT_SETTINGS.sandbox, mode: "best-effort" },
        },
        paths: paths(),
        logger: pino({ level: "silent" }),
    })
    const executeResult = await withAgentToolContext(
        {
            sessionId: "s",
            turn: 1,
            step: 1,
            workspaceDir: process.cwd(),
            permission: "read-only",
            allowExec: true,
            elog,
        },
        async () =>
            await capabilities.executeCode({
                command: "/bin/sh",
                argv: ["-c", "echo cap"],
            }),
    )
    assert.equal(executeResult.exitCode, 0)
    assert.match(executeResult.stdout, /cap/)
})

test("后台任务查询与停止", { timeout: 20_000, skip: POSIX_ONLY }, async () => {
    const elog = new Elog({
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        color: false,
    })
    const capabilities = createHostCapabilities({
        config: {
            ...DEFAULT_SETTINGS,
            sandbox: { ...DEFAULT_SETTINGS.sandbox, mode: "best-effort" },
        },
        paths: paths(),
        logger: pino({ level: "silent" }),
    })
    const task = await withAgentToolContext(
        {
            sessionId: "s",
            turn: 1,
            step: 1,
            workspaceDir: process.cwd(),
            permission: "read-only",
            allowExec: true,
            elog,
        },
        async () =>
            await capabilities.startBackgroundCode({
                command: "/bin/sleep",
                argv: ["60"],
            }),
    )
    const running = capabilities.queryTask(task.taskId)
    assert.equal(running?.status, "running")
    assert.equal(capabilities.stopTask(task.taskId, "kill"), true)
    await new Promise((resolve) => setTimeout(resolve, 200))
    const stopped = capabilities.queryTask(task.taskId)
    assert.notEqual(stopped?.status, "running")
})

test("capabilities 接受更宽 access", { timeout: 20_000, skip: POSIX_ONLY }, async () => {
    const elog = new Elog({
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        color: false,
    })
    const capabilities = createHostCapabilities({
        config: {
            ...DEFAULT_SETTINGS,
            sandbox: { ...DEFAULT_SETTINGS.sandbox, mode: "best-effort" },
        },
        paths: paths(),
        logger: pino({ level: "silent" }),
    })
    let approvals = 0
    let approvalRequest: Record<string, unknown> | null = null
    const executeResult = await withAgentToolContext(
        {
            sessionId: "s",
            turn: 1,
            step: 1,
            workspaceDir: process.cwd(),
            permission: "read-only",
            allowExec: false,
            approveExec: async (request) => {
                approvals += 1
                approvalRequest = request as unknown as Record<string, unknown>
                return true
            },
            elog,
        },
        async () =>
            await capabilities.executeCode({
                command: "/bin/sh",
                argv: ["-c", "echo write"],
                access: "workspace-write",
                justification: "构建产物需要写入工作区",
                network: true,
                stdin: "y\n",
                timeoutMs: 5000,
            }),
    )
    assert.equal(executeResult.access, "workspace-write")
    assert.equal(approvals, 1)
    assert.equal(approvalRequest?.["justification"], "构建产物需要写入工作区")
    assert.equal(approvalRequest?.["currentPermission"], "read-only")
    assert.equal(approvalRequest?.["requestedPermission"], "workspace-write")
    /*
     * 审批界面要展示参数，所以这些字段必须一路透传到插件：
     * argv 是真正危险的部分（command 只是可执行文件名），
     * 网络、标准输入、超时则决定这次调用还能做什么。
     */
    assert.deepEqual(approvalRequest?.["argv"], ["-c", "echo write"])
    assert.equal(approvalRequest?.["network"], true)
    assert.equal(approvalRequest?.["stdin"], "y\n")
    assert.equal(approvalRequest?.["timeoutMs"], 5000)
    // executeCode 是前台执行，不该带 background 标记
    assert.equal(approvalRequest?.["background"], undefined)
})
