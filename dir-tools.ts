// 目录浏览：list_dir
//
// 复用 workspace-walk 的遍历与忽略规则
// 输出缩进树：目录行以 / 结尾，文件行附人读大小；末尾计数行与触顶标记

import type { AgentCallToolResult, AgentTool, PluginApi } from "wellspring/api/host/index.ts"

import { describePath, missingFile, workspacePath } from "./paths.ts"
import { LIMITS } from "./retention.ts"
import { tool } from "./tool.ts"
import {
    normalizeRelative,
    walkWorkspace,
    workspaceBasename,
    type WalkFile,
} from "./workspace-walk.ts"

// 每层缩进空格数
const INDENT = 2

// 列出的条目
type ListedEntry = {
    readonly kind: "directory" | "file"
    // 相对工作区根的路径
    readonly path: string
    // 相对起点的深度，起点下第一层为 1
    readonly depth: number
    readonly size: number
}

function fail(message: string, code: string): AgentCallToolResult {
    return { success: false, data: { error: message, code } }
}

// 布尔参数兼容字符串
function isTrue(value: unknown): boolean {
    return value === true || value === "true"
}

// 字节数转人读大小：与 render.ts 的 formatSize 同口径
function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    const kb = bytes / 1024
    if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : String(Math.round(kb))} kB`
    const mb = kb / 1024
    return `${mb < 10 ? mb.toFixed(1) : String(Math.round(mb))} MB`
}

// 起点目录：缺省工作区根，显式给出时按相对路径归一
async function listStart(api: PluginApi, args: Record<string, unknown>): Promise<string> {
    const raw = args["path"]
    if (typeof raw !== "string" || raw.trim() === "") {
        return "."
    }
    return normalizeRelative(await workspacePath(api, args, "path"))
}

// depth 校验：缺省 LIMITS.listDepth，越界报错并带取值范围
function depthOf(
    args: Record<string, unknown>,
):
    | { readonly ok: true; readonly depth: number }
    | { readonly ok: false; readonly data: Record<string, unknown> } {
    const raw = args["depth"]
    if (raw === undefined) {
        return { ok: true, depth: LIMITS.listDepth }
    }
    const depth = Number(raw)
    if (!Number.isInteger(depth) || depth < 1 || depth > LIMITS.listMaxDepth) {
        return {
            ok: false,
            data: {
                error: `depth 需要是 1-${LIMITS.listMaxDepth} 的整数，收到：${String(raw)}`,
                code: "FS_BAD_ARGUMENT",
            },
        }
    }
    return { ok: true, depth }
}

// 缩进树的一行
function renderEntry(entry: ListedEntry): string {
    const indent = " ".repeat(INDENT * (entry.depth - 1))
    const name = workspaceBasename(entry.path)
    if (entry.kind === "directory") {
        return `${indent}${name}/`
    }
    return `${indent}${name}  ${formatSize(entry.size)}`
}

async function listDirTool(
    api: PluginApi,
    args: Record<string, unknown>,
): Promise<AgentCallToolResult> {
    const depthOption = depthOf(args)
    if (!depthOption.ok) {
        return { success: false, data: depthOption.data }
    }
    const respectGitignore = !isTrue(args["include_ignored"])
    const start = await listStart(api, args)
    const info = await api.workspaceFs.stat(start)
    if (info === null) {
        return { success: false, data: { error: missingFile(api, start), code: "FS_NOT_FOUND" } }
    }
    if (info.type !== "directory") {
        return fail(`无法列出 "${describePath(api, start)}"：不是目录`, "FS_NOT_DIRECTORY")
    }

    const entries: ListedEntry[] = []
    let limitReached = false
    // 到条目上限时返回 false 提前停止
    const push = (entry: ListedEntry): boolean => {
        entries.push(entry)
        if (entries.length >= LIMITS.listEntries) {
            limitReached = true
            return false
        }
        return true
    }
    await walkWorkspace(
        api,
        start,
        {
            directory: (path, entryDepth) =>
                push({ kind: "directory", path, depth: entryDepth, size: 0 }),
            file: (file: WalkFile) =>
                push({ kind: "file", path: file.path, depth: file.depth, size: file.size }),
        },
        { respectGitignore, maxDepth: depthOption.depth },
    )

    let directories = 0
    let files = 0
    for (const entry of entries) {
        if (entry.kind === "directory") {
            directories += 1
        } else {
            files += 1
        }
    }
    const lines = entries.map(renderEntry)
    lines.push(`[共 ${directories} 个目录，${files} 个文件]`)
    if (limitReached) {
        lines.push(`[条目达到上限 ${LIMITS.listEntries}]`)
    }
    return {
        success: true,
        data: {
            content: lines.join("\n"),
            files,
            directories,
            truncated: limitReached,
        },
    }
}

function dirTools(api: PluginApi): AgentTool[] {
    return [
        tool(
            "list_dir",
            "列出工作区目录内容，按名称排序；默认深度 2，默认遵循 .gitignore",
            {
                path: {
                    type: "string",
                    description: "起点目录：相对工作区根，默认工作区根",
                    optional: true,
                },
                depth: {
                    type: "integer",
                    description: `相对起点的层数 1-${LIMITS.listMaxDepth}，默认 ${LIMITS.listDepth}`,
                    optional: true,
                },
                include_ignored: {
                    type: "boolean",
                    description: "true 时不读 .gitignore；node_modules 等内置忽略目录仍跳过",
                    optional: true,
                },
            },
            async (args) => await listDirTool(api, args),
        ),
    ]
}

// 注册 list_dir
export function registerDirTools(api: PluginApi): void {
    for (const definition of dirTools(api)) {
        api.registerAgentTool?.(definition)
    }
}
