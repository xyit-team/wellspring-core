// 核心 Agent 工具插件：read / delete_file（移入回收站）/ execute_code / web_search / web_fetch / SKILL 管理

import { isAbsolute, relative, resolve, sep } from "node:path"

import {
    getHost,
    onSessionStart,
    type AgentTool,
    type AgentToolParamSpec,
    type PluginApi,
} from "wellspring/api/host/index.ts"

import { renderExec, renderFetch, renderReadWindow, renderSearch, renderStop, renderTask } from "./render.ts"
import { LIMITS } from "./retention.ts"
import { buildSessionSystemPrompt } from "./session-prompt.ts"
import { registerSkillTools } from "./skills.ts"
import { moveToTrash, trashRoot } from "./trash.ts"

/** 二进制取样的字符数：只看开头，不额外读文件 */
const BINARY_SAMPLE_CHARS = 8000

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** 去掉路径两侧的成对引号 */
function unquote(value: string): string {
    const match = /^(["'`])([\s\S]*)\1$/.exec(value)
    return match === null ? value : (match[2] ?? "").trim()
}

/** 工作区根目录；宿主还没同步过来时为空串 */
function workspaceRoot(api: PluginApi): string {
    const root = api.workspaceFs.root
    return typeof root === "string" && isAbsolute(root) ? root : ""
}

/** 错误提示中的绝对路径 */
function describePath(api: PluginApi, path: string): string {
    const root = workspaceRoot(api)
    return root === "" ? path : resolve(root, path)
}

/**
 * 工作区内路径归一化
 *
 * 相对路径原样交给宿主，`..` 越界由 HostFileApi 拒绝
 * 绝对路径落在工作区内时换成相对路径，工作区外抛出错误
 * 工作区根由会话决定，插件只做换写，不做判定
 */
function workspacePath(api: PluginApi, args: Record<string, unknown>, key: string): string {
    const raw = typeof args[key] === "string" ? String(args[key]).trim() : ""
    const value = unquote(raw)
    if (value === "") {
        throw new Error(`${key} 不能为空`)
    }
    if (!isAbsolute(value)) {
        return value
    }
    const root = workspaceRoot(api)
    if (root === "") {
        return value
    }
    const target = resolve(value)
    const rel = relative(root, target)
    if (rel === "") {
        return "."
    }
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error(`路径不在工作区内：${target}\n工作区根目录：${root}`)
    }
    return rel.split(sep).join("/")
}

function missingFile(path: string, api: PluginApi): string {
    const root = workspaceRoot(api)
    if (root === "") {
        return `文件不存在：${path}`
    }
    return `文件不存在：${describePath(api, path)}\n工作区根目录：${root}`
}

/**
 * 解析读取目标
 *
 * 一次 stat 区分三种情况：不存在、是目录、不是普通文件
 */
async function resolveReadTarget(
    api: PluginApi,
    args: Record<string, unknown>,
): Promise<
    | { ok: true; path: string; display: string }
    | { ok: false; data: Record<string, unknown> }
> {
    const path = workspacePath(api, args, "file_path")
    const display = describePath(api, path)
    const info = await api.workspaceFs.stat(path)
    if (info === null) {
        return { ok: false, data: { error: missingFile(path, api), code: "FS_NOT_FOUND" } }
    }
    if (info.type === "directory") {
        return {
            ok: false,
            data: {
                error: `无法读取 "${display}"：是目录，不是普通文件`,
                code: "FS_NOT_DIRECTORY",
            },
        }
    }
    if (info.type === "other") {
        return {
            ok: false,
            data: {
                error: `无法读取 "${display}"：不是普通文件`,
                code: "FS_NOT_REGULAR_FILE",
            },
        }
    }
    return { ok: true, path, display }
}

/**
 * 二进制判定：取样中出现 NUL，或替换字符占比超过一成
 *
 * 判定只看解码后文本的开头，不额外读文件
 */
function looksBinary(text: string): boolean {
    const sample = text.slice(0, BINARY_SAMPLE_CHARS)
    if (sample === "") {
        return false
    }
    if (sample.includes("\u0000")) {
        return true
    }
    let replaced = 0
    for (const char of sample) {
        if (char === "\ufffd") {
            replaced += 1
        }
    }
    return replaced / sample.length > 0.1
}

/**
 * offset / limit 校验
 *
 * 缺省取默认值，显式给出时要求正整数；offset 超出总行数时报错
 */
function readWindow(args: Record<string, unknown>, display: string, total: number):
    | { ok: true; start: number; limit: number }
    | { ok: false; data: Record<string, unknown> } {
    const rawOffset = args["offset"]
    const rawLimit = args["limit"]
    const offset = rawOffset === undefined ? 1 : Number(rawOffset)
    const limit = rawLimit === undefined ? LIMITS.readLines : Number(rawLimit)
    if (!Number.isInteger(offset) || offset < 1) {
        return {
            ok: false,
            data: { error: `offset 需要是正整数，收到：${String(rawOffset)}`, code: "FS_BAD_ARGUMENT" },
        }
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.readLines) {
        return {
            ok: false,
            data: {
                error: `limit 需要是 1-${LIMITS.readLines} 的整数，收到：${String(rawLimit)}`,
                code: "FS_BAD_ARGUMENT",
            },
        }
    }
    // offset 超出总行数
    if (offset > total && !(total === 0 && offset === 1)) {
        return {
            ok: false,
            data: {
                error: `offset ${offset} 超出范围："${display}" 共 ${total} 行`,
                code: "FS_OUT_OF_RANGE",
            },
        }
    }
    return { ok: true, start: offset - 1, limit }
}

async function readTool(
    api: PluginApi,
    args: Record<string, unknown>,
): Promise<{ success: boolean; data: Record<string, unknown> }> {
    const target = await resolveReadTarget(api, args)
    if (!target.ok) {
        return { success: false, data: target.data }
    }
    const text = await api.workspaceFs.readText(target.path)
    if (text === null) {
        // stat 与读取之间文件被删除
        return { success: false, data: { error: missingFile(target.path, api), code: "FS_NOT_FOUND" } }
    }
    if (looksBinary(text)) {
        return {
            success: false,
            data: {
                error: `无法读取 "${target.display}"：二进制文件，不是 UTF-8 文本`,
                code: "FS_NOT_TEXT",
            },
        }
    }
    const lines = text.split(/\r?\n/)
    if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop()
    }
    const window = readWindow(args, target.display, lines.length)
    if (!window.ok) {
        return { success: false, data: window.data }
    }
    const page = renderReadWindow(lines, window.start, window.limit)
    return { success: true, data: { content: page.content, path: target.display } }
}

function deletePathOf(api: PluginApi, args: Record<string, unknown>): string {
    const path = workspacePath(api, args, "path")
    const normalized = path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "")
    if (normalized === "" || normalized === "." || normalized.split("/").includes("..")) {
        throw new Error("不能删除工作区根目录，路径也不能包含 ..")
    }
    return path
}

async function deleteFileTool(
    api: PluginApi,
    args: Record<string, unknown>,
): Promise<{ success: boolean; data: Record<string, unknown> }> {
    const filePath = deletePathOf(api, args)
    const recursive = args["recursive"] === true || args["recursive"] === "true"
    const info = await api.workspaceFs.stat(filePath)
    if (info === null) {
        return { success: false, data: { error: `路径不存在：${describePath(api, filePath)}` } }
    }
    if (info.type === "directory" && !recursive) {
        return {
            success: false,
            data: { error: `${filePath} 是目录；删除目录需要 recursive:true` },
        }
    }
    if (info.type === "other") {
        return { success: false, data: { error: `不支持的路径类型：${filePath}` } }
    }
    const moved = await moveToTrash(api, filePath, info.type)
    const label = info.type === "directory" ? "目录" : "文件"
    return {
        success: true,
        data: {
            path: filePath,
            type: info.type,
            trashPath: moved.absolutePath,
            trashItem: moved.itemPath,
            trashRoot: trashRoot(api),
            files: moved.files,
            bytes: moved.bytes,
            content: `已把${label}移到回收站：${filePath}（${moved.itemPath}）`,
        },
    }
}

async function callCapability(
    api: PluginApi,
    name: string,
    args: Record<string, unknown>,
): Promise<{ success: boolean; data: Record<string, unknown> }> {
    try {
        if (name === "web_search") {
            const results = await api.capabilities.webSearch(
                String(args["query"] ?? ""),
                typeof args["count"] === "number" ? args["count"] : undefined,
            )
            return { success: true, data: { results } }
        }
        if (name === "web_fetch") {
            const page = await api.capabilities.webFetch(String(args["url"] ?? ""))
            return { success: true, data: { title: page.title, content: page.content } }
        }
        if (name === "execute_code") {
            const background = args["background"] === true || args["background"] === "true"
            const network = args["network"] === true || args["network"] === "true"
            const rawArgv = args["argv"]
            const argv = Array.isArray(rawArgv)
                ? rawArgv.filter((item): item is string => typeof item === "string")
                : typeof rawArgv === "string"
                  ? (JSON.parse(rawArgv) as unknown[]).filter(
                        (item): item is string => typeof item === "string",
                    )
                  : []
            const access: "read-only" | "workspace-write" | "danger-full-access" | undefined =
                args["sandbox_permissions"] === "workspace-write" ||
                args["sandbox_permissions"] === "danger-full-access" ||
                args["sandbox_permissions"] === "read-only"
                    ? args["sandbox_permissions"]
                    : undefined
            const request = {
                command: String(args["command"] ?? ""),
                argv,
                cwd: typeof args["cwd"] === "string" ? args["cwd"] : undefined,
                stdin: typeof args["stdin"] === "string" ? args["stdin"] : undefined,
                timeoutMs: Number.isFinite(Number(args["timeoutMs"]))
                    ? Number(args["timeoutMs"])
                    : undefined,
                memoryMB: Number.isFinite(Number(args["memoryMB"]))
                    ? Number(args["memoryMB"])
                    : undefined,
                network,
                access,
                justification:
                    typeof args["justification"] === "string" ? args["justification"] : undefined,
            }
            if (background) {
                const task = await api.capabilities.startBackgroundCode(request)
                return { success: true, data: { ...task } }
            }
            const result = await api.capabilities.executeCode(request)
            const { hostArtifactDir: _artifact, hostSandboxDir: _sandbox, ...safe } = result
            return { success: result.exitCode === 0, data: { ...safe } }
        }
        if (name === "query_task") {
            const taskId =
                typeof args["task_id"] === "string" && args["task_id"] !== ""
                    ? args["task_id"]
                    : undefined
            const task = await api.capabilities.queryTask(taskId)
            if (task === null) {
                return { success: false, data: { error: "没有任务" } }
            }
            if (task.result === null) {
                return { success: true, data: { ...task } }
            }
            const {
                hostArtifactDir: _artifact,
                hostSandboxDir: _sandbox,
                ...safeResult
            } = task.result
            return { success: true, data: { ...task, result: safeResult } }
        }
        if (name === "stop_task") {
            const taskId =
                typeof args["task_id"] === "string" && args["task_id"] !== ""
                    ? args["task_id"]
                    : undefined
            const type = args["type"] === "ctrl_c" ? "ctrl_c" : "kill"
            const stopped = await api.capabilities.stopTask(taskId, type)
            return { success: stopped, data: { stopped, type, taskId: taskId ?? null } }
        }
        return { success: false, data: { error: `未知工具：${name}` } }
    } catch (error) {
        return {
            success: false,
            data: { error: error instanceof Error ? error.message : String(error) },
        }
    }
}

/**
 * 注册一个工具
 *
 * render 把 data 渲染成模型侧文本；给出后 data 仅用于界面与日志
 * 未给出时沿用宿主旧规则（data.content 或序列化）
 */
function tool(
    name: string,
    content: string,
    params: Record<string, AgentToolParamSpec>,
    call: (
        args: Record<string, unknown>,
    ) => Promise<{ success: boolean; data: Record<string, unknown> }>,
    render?: (data: Record<string, unknown>) => string,
): AgentTool {
    return {
        name,
        introduction: { params, content },
        call: async (...values: unknown[]) => {
            const input = isObject(values[0]) ? values[0] : {}
            const result = await call(input)
            if (render === undefined) {
                return result
            }
            return { success: result.success, data: result.data, content: render(result.data) }
        },
    }
}

export function setup() {
    let api: PluginApi | null = null
    return {
        id: "wellspring-core",
        name: "Wellspring Core",
        version: "1.1.0",
        status: "ok" as const,
        init(pluginApi: PluginApi) {
            api = pluginApi
            // 新会话第一轮注入一次运行环境与可用工具列表
            onSessionStart((event) => {
                event.prompt.push(buildSessionSystemPrompt(event, getHost().getOS()))
            })
            registerSkillTools(api)
            api.registerAgentTool?.(
                tool(
                    "read",
                    "读取 workspace 内 UTF-8 文本，返回带行号内容",
                    {
                        file_path: "路径 相对路径按工作区根解析，工作区内绝对路径同样接受",
                        offset: { type: "integer", description: "起始行", optional: true },
                        limit: { type: "integer", description: "行数", optional: true },
                    },
                    async (args) => await readTool(api as PluginApi, args),
                ),
            )
            api.registerAgentTool?.(
                tool(
                    "delete_file",
                    "把 workspace 内的文件或目录移到回收站（插件数据目录的 trash/），不会永久删除；目录需要 recursive:true",
                    {
                        path: "路径 相对路径按工作区根解析，工作区内绝对路径同样接受",
                        recursive: {
                            type: "boolean",
                            description: "true 时连同目录内容一起移入回收站",
                            optional: true,
                        },
                    },
                    async (args) => await deleteFileTool(api as PluginApi, args),
                ),
            )
            api.registerAgentTool?.(
                tool(
                    "web_search",
                    "模型提供商联网搜索（优先用 curl；用前先 ask 征得用户同意）",
                    {
                        query: "搜索词",
                        count: { type: "integer", description: "结果数", optional: true },
                    },
                    async (args) => await callCapability(api as PluginApi, "web_search", args),
                    renderSearch,
                ),
            )
            api.registerAgentTool?.(
                tool(
                    "web_fetch",
                    "抓取网页 Markdown 正文",
                    { url: "网页地址" },
                    async (args) => await callCapability(api as PluginApi, "web_fetch", args),
                    renderFetch,
                ),
            )
            api.registerAgentTool?.(
                tool(
                    "query_task",
                    "查询后台 execute_code 任务状态与输出",
                    {
                        task_id: { type: "string", description: "任务 id，可留空", optional: true },
                    },
                    async (args) => await callCapability(api as PluginApi, "query_task", args),
                    renderTask,
                ),
            )
            api.registerAgentTool?.(
                tool(
                    "stop_task",
                    "停止后台任务：ctrl_c 发 SIGINT，kill 发 SIGKILL",
                    {
                        type: {
                            type: "string",
                            enum: ["ctrl_c", "kill"],
                            description: "停止方式",
                        },
                        task_id: { type: "string", description: "任务 id，可留空", optional: true },
                    },
                    async (args) => await callCapability(api as PluginApi, "stop_task", args),
                    renderStop,
                ),
            )
            api.registerAgentTool?.(
                tool(
                    "execute_code",
                    "在 sandbox 中执行命令",
                    {
                        command: "可执行文件",
                        argv: {
                            type: "array",
                            items: { type: "string" },
                            description: "参数",
                            optional: true,
                        },
                        cwd: { type: "string", description: "工作目录", optional: true },
                        stdin: { type: "string", description: "标准输入", optional: true },
                        timeoutMs: {
                            type: "integer",
                            description: "超时毫秒",
                            optional: true,
                        },
                        memoryMB: {
                            type: "integer",
                            description: "物理内存上限 MB（cgroup，默认取 sandbox.defaultMemoryMB）",
                            optional: true,
                        },
                        background: {
                            type: "boolean",
                            description: "true 时后台执行",
                            optional: true,
                        },
                        network: {
                            type: "boolean",
                            description:
                                "true 时允许网络；工作区可写与完全访问默认联网，read-only 默认断网，传 false 可关掉",
                            optional: true,
                        },
                        sandbox_permissions: {
                            type: "string",
                            enum: ["read-only", "workspace-write", "danger-full-access"],
                            description: "请求权限",
                            optional: true,
                        },
                        justification: {
                            type: "string",
                            description: "申请更宽权限的理由",
                            optional: true,
                        },
                    },
                    async (args) => await callCapability(api as PluginApi, "execute_code", args),
                    renderExec,
                ),
            )
        },
    }
}
