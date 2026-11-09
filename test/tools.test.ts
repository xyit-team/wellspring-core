import assert from "node:assert/strict"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { after, before, test } from "node:test"

import pino from "pino"

import { withAgentToolContext } from "../.host/src/agent/tool-context.ts"
import { LIMITS } from "../retention.ts"
import { DEFAULT_SETTINGS } from "../.host/src/config/defaults.ts"
import { getElog, initElog, type ElogStream } from "../.host/src/logger/elog4js.ts"
import type { ResolvedPaths } from "../.host/src/platform/path.ts"
import { DirectBackend } from "../.host/src/sandbox/backends/direct.ts"
import { AgentToolRegistry } from "../.host/src/plugin/agent-tools.ts"
import { loadPlugins } from "../.host/src/plugin/loader.ts"
import { PluginRegistry } from "../.host/src/plugin/registry.ts"
import { shutdownAllSandboxPlugins } from "../.host/src/sandbox/plugin-client.ts"
import { PLUGIN_FILES } from "./plugin-files.ts"

/** Windows 上没有 /bin/sh 与 POSIX 信号；这些用例只在 Linux/macOS 上跑 */
const POSIX_ONLY = process.platform === "win32" ? "需要 /bin/sh 与 POSIX 信号，仅 Linux/macOS" : false

let root = ""
let dataDir = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-skill-quoting-"))
    dataDir = join(root, "data")
    // execute_code 需要 Agent 工具上下文，先初始化日志流
    const output: ElogStream = { write: () => undefined }
    initElog({ stdout: output, stderr: output, color: false, json: false })
})

after(async () => {
    await shutdownAllSandboxPlugins()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function paths(): ResolvedPaths {
    return {
        configDir: join(root, "config"),
        dataDir,
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

let cachedTools: AgentToolRegistry | null = null

/** 插件加载较慢，两个用例共用同一套已注册工具 */
async function coreTools(): Promise<AgentToolRegistry> {
    cachedTools ??= await loadCoreTools()
    return cachedTools
}

async function loadCoreTools(): Promise<AgentToolRegistry> {
    const destination = join(dataDir, "plugins", "@xyit", "wellspring-core")
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
    assert.equal(plugins.find((plugin) => plugin.id === "@xyit/wellspring-core")?.status, "ok")
    return agentTools
}

test("read 受单页字节预算约束：超额就收尾并给出下一页", { timeout: 30_000 }, async () => {
    const agentTools = await coreTools()
    const read = agentTools.get("read")
    assert.ok(read)
    // 3000 行 × 约 40 字节，超过 51200 字节单页预算
    const line = "一二三四五六七八九十".repeat(2)
    const body = Array.from({ length: 3000 }, (_, index) => `${index} ${line}`).join("\n")
    await writeFile(join(root, "big.txt"), `${body}\n`, "utf8")

    // 工作区取自 Agent 工具上下文，缺省为进程 cwd
    const inWorkspace = async <T>(run: () => Promise<T>): Promise<T> =>
        await withAgentToolContext(
            {
                sessionId: "core-tools-test",
                turn: 1,
                step: 1,
                workspaceDir: root,
                permission: "read-only",
                allowExec: false,
                elog: getElog(),
            },
            run,
        )

    const result = await inWorkspace(async () => await read.tool.call({ file_path: "big.txt" }))
    assert.equal(result.success, true, JSON.stringify(result.data))
    const content = String(result.data["content"])
    assert.match(content, /\[lines 1-\d+ of 3000\]/)
    assert.match(content, /本页在 \d+ 字节处收尾/, "要说明为什么提前结束")
    assert.match(content, /继续读取：offset=\d+/)
    // 模型侧文本不超过单页预算
    assert.ok(
        Buffer.byteLength(content, "utf8") < LIMITS.readBytes + 8192,
        `单页 ${Buffer.byteLength(content, "utf8")} 字节`,
    )
    // 未截断时无截断提示
    const small = await inWorkspace(
        async () => await read.tool.call({ file_path: "big.txt", limit: 5 }),
    )
    const smallText = String(small.data["content"])
    assert.match(smallText, /\[lines 1-5 of 3000\]/)
    assert.ok(!smallText.includes("字节处收尾"), smallText)
})

test(
    "execute_code 给出模型侧文本：data 的结构化字段不再进上下文",
    { timeout: 60_000, skip: POSIX_ONLY },
    async () => {
        const agentTools = await coreTools()
        const exec = agentTools.get("execute_code")
        assert.ok(exec)
        const result = await withAgentToolContext(
            {
                sessionId: "core-tools-test",
                turn: 1,
                step: 1,
                workspaceDir: root,
                permission: "read-only",
                allowExec: true,
                elog: getElog(),
            },
            async () =>
                // 插件运行于 sandbox，命令须在宿主与沙箱内均可用
                await exec.tool.call(
                    process.platform === "win32"
                        ? { command: "cmd", argv: ["/c", "echo hi"] }
                        : { command: "echo", argv: ["hi"] },
                ),
        )
        assert.equal(result.success, true, JSON.stringify(result.data))
        // 模型侧文本为一行输出，无 JSON 包装
        assert.equal(result.content, "hi")
        assert.ok(!String(result.content).includes("sandboxId"), "元数据不该出现在模型侧文本里")
        // 结构化结果保留给界面与日志
        assert.equal(typeof result.data["sandboxId"], "string")
        assert.equal(result.data["exitCode"], 0)
    },
)

test("skill_modify 容忍 description / whenToUse 多包一层引号", { timeout: 20_000 }, async () => {
    const agentTools = await coreTools()
    const install = agentTools.get("skill_install")
    const modify = agentTools.get("skill_modify")
    const read = agentTools.get("skill_read")
    const list = agentTools.get("skill_list")
    assert.ok(install)
    assert.ok(modify)
    assert.ok(read)
    assert.ok(list)

    const content = [
        "---",
        "name: quoted-skill",
        "description: 原始说明",
        "whenToUse: 原始时机",
        "---",
        "# 正文",
        "",
    ].join("\n")
    assert.equal((await install.tool.call({ content })).success, true)

    // 第一次按 YAML 习惯传了带引号的字符串：落盘不能再套一层
    const modified = await modify.tool.call({
        name: "quoted-skill",
        description: '"工具自检用临时技能"',
        whenToUse: "'需要自检时'",
    })
    assert.equal(modified.success, true)

    const reread = await read.tool.call({ name: "quoted-skill" })
    assert.equal(reread.success, true)
    const skill = reread.data["skill"] as { description: string; whenToUse?: string }
    assert.equal(skill.description, "工具自检用临时技能")
    assert.equal(skill.whenToUse, "需要自检时")

    const listed = await list.tool.call({})
    const item = (listed.data as { skills: Array<Record<string, unknown>> }).skills.find(
        (entry) => entry["name"] === "quoted-skill",
    )
    assert.equal(item?.["description"], "工具自检用临时技能")
    assert.equal(item?.["whenToUse"], "需要自检时")

    const raw = await readFile(
        join(dataDir, "plugin-data", "@xyit", "wellspring-core", "skills", "quoted-skill", "SKILL.md"),
        "utf8",
    )
    assert.ok(!raw.includes('\\"'), `frontmatter 不应出现嵌套引号：\n${raw}`)
    // 中文会被 YAML 序列化成一层引号，这是正常的；关键是不能再嵌套
    assert.match(raw, /description: "工具自检用临时技能"/)
    assert.match(raw, /whenToUse: "需要自检时"/)

    // 裸文本行为不变
    const plain = await modify.tool.call({ name: "quoted-skill", description: "普通说明" })
    assert.equal(plain.success, true)
    const again = await read.tool.call({ name: "quoted-skill" })
    assert.equal((again.data["skill"] as { description: string }).description, "普通说明")
})

test(
    "web_search / web_fetch 缺 Key 时返回明确错误，不再静默空结果",
    { timeout: 20_000 },
    async () => {
        const agentTools = await coreTools()
        const search = agentTools.get("web_search")
        const fetchTool = agentTools.get("web_fetch")
        assert.ok(search)
        assert.ok(fetchTool)
        const saved = process.env["OPENAI_API_KEY"]
        delete process.env["OPENAI_API_KEY"]
        try {
            const searched = await search.tool.call({ query: "DeepSeek" })
            assert.equal(searched.success, false, "缺 Key 时 web_search 必须失败")
            assert.match(String(searched.data["error"]), /web\.missing-api-key/)
            const fetched = await fetchTool.tool.call({ url: "https://example.com" })
            assert.equal(fetched.success, false, "缺 Key 时 web_fetch 必须失败")
            assert.match(String(fetched.data["error"]), /web\.missing-api-key/)
        } finally {
            if (saved !== undefined) {
                process.env["OPENAI_API_KEY"] = saved
            }
        }
    },
)
