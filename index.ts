// 核心 Agent 工具插件：read / write / edit / delete_file（移入回收站）/ grep / glob /
// execute_code / web_search / web_fetch / 后台任务 / SKILL 管理

import {
    getHost,
    onSessionStart,
    type PluginApi,
} from "wellspring/api/host/index.ts"

import { registerFileTools } from "./fs-tools.ts"
import { describePath, missingFile, workspacePath } from "./paths.ts"
import { markRead } from "./read-tracking.ts"
import { renderExec, renderFetch, renderReadWindow, renderSearch, renderStop, renderTask } from "./render.ts"
import { LIMITS } from "./retention.ts"
import { registerSearchTools } from "./search-tools.ts"
import { buildSessionSystemPrompt } from "./session-prompt.ts"
import { registerSkillTools } from "./skills.ts"
import { looksBinary } from "./text.ts"
import { tool } from "./tool.ts"
import { moveToTrash, trashRoot } from "./trash.ts"

/**
 * 解析读取目标
 *
 * 一次 stat 区分三种情况：不存在、是目录、不是普通文件
 */
async function resolveReadTarget(
    api: PluginApi,
    args: Record<string, unknown>,
): Promise<
    | {
          ok: true
          path: string
          display: string
          signature: { readonly size: number; readonly mtimeMs: number }
      }
    | { ok: false; data: Record<string, unknown> }
> {
    const path = await workspacePath(api, args, "file_path")
    const display = describePath(api, path)
    const info = await api.workspaceFs.stat(path)
    if (info === null) {
        return { ok: false, data: { error: missingFile(api, path), code: "FS_NOT_FOUND" } }
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
    return { ok: true, path, display, signature: { size: info.size, mtimeMs: info.mtimeMs } }
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
        return { success: false, data: { error: missingFile(api, target.path), code: "FS_NOT_FOUND" } }
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
    // 记录已读签名：write 覆盖前校验
    markRead(target.display, target.signature)
    return { success: true, data: { content: page.content, path: target.display } }
}

async function deletePathOf(api: PluginApi, args: Record<string, unknown>): Promise<string> {
    const path = await workspacePath(api, args, "path")
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
    const filePath = await deletePathOf(api, args)
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
            // 文件读写：write / edit
            registerFileTools(api)
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
            // 工作区检索：grep / glob
            registerSearchTools(api)
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
            registerSkillTools(api as PluginApi)
        },
    }
}
