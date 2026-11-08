// 回收站工具：trash_list 列出条目，trash_restore 恢复回工作区
//
// 配合 delete_file：删除结果里带 trashId，可直接交给 trash_restore

import type { AgentCallToolResult, AgentTool, PluginApi } from "wellspring/api/host/index.ts"

import { tool } from "./tool.ts"
import { TrashError, listTrash, restoreTrash } from "./trash.ts"

function fail(message: string, code: string): AgentCallToolResult {
    return { success: false, data: { error: message, code } }
}

// 字节数转人读大小
function formatSize(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`
    }
    const kb = bytes / 1024
    if (kb < 1024) {
        return `${kb < 10 ? kb.toFixed(1) : String(Math.round(kb))} kB`
    }
    const mb = kb / 1024
    return `${mb < 10 ? mb.toFixed(1) : String(Math.round(mb))} MB`
}

// 删除时间：UTC，精确到分钟
function formatTime(at: string): string {
    const time = new Date(at)
    if (Number.isNaN(time.getTime())) {
        return "-"
    }
    const pad = (value: number): string => String(value).padStart(2, "0")
    return (
        `${time.getUTCFullYear()}-${pad(time.getUTCMonth() + 1)}-${pad(time.getUTCDate())} ` +
        `${pad(time.getUTCHours())}:${pad(time.getUTCMinutes())} UTC`
    )
}

function typeLabel(type: "file" | "directory"): string {
    return type === "directory" ? "目录" : "文件"
}

async function listTool(
    api: PluginApi,
    args: Record<string, unknown>,
): Promise<AgentCallToolResult> {
    const raw = args["limit"]
    const limit = raw === undefined ? 20 : Number(raw)
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        return fail(`limit 需要是 1-200 的整数，收到：${String(raw)}`, "FS_BAD_ARGUMENT")
    }
    const entries = await listTrash(api, limit)
    const lines = entries.map(
        (entry) =>
            `${entry.id}  ${typeLabel(entry.type)}  ${entry.path}` +
            `（${entry.files} 文件，${formatSize(entry.bytes)}）  ${formatTime(entry.at)}`,
    )
    return {
        success: true,
        data: {
            content: entries.length === 0 ? "回收站为空" : lines.join("\n"),
            entries,
        },
    }
}

async function restoreTool(
    api: PluginApi,
    args: Record<string, unknown>,
): Promise<AgentCallToolResult> {
    const raw = typeof args["entry"] === "string" ? args["entry"].trim() : ""
    const id = raw.replace(/^trash\//, "").replace(/\/+$/, "")
    if (id === "") {
        return fail("entry 为空", "TRASH_BAD_ID")
    }
    try {
        const restored = await restoreTrash(api, id)
        return {
            success: true,
            data: {
                path: restored.path,
                entry: id,
                files: restored.files,
                bytes: restored.bytes,
                content:
                    `已恢复：${restored.path}` +
                    `（${restored.files} 文件，${formatSize(restored.bytes)}）`,
            },
        }
    } catch (error) {
        if (error instanceof TrashError) {
            return fail(error.message, error.code)
        }
        return fail(error instanceof Error ? error.message : String(error), "TRASH_RESTORE_FAILED")
    }
}

function trashTools(api: PluginApi): AgentTool[] {
    return [
        tool(
            "trash_list",
            "列出回收站条目：id、原路径、类型、文件数、大小与删除时间",
            {
                limit: {
                    type: "integer",
                    description: "最多条数 1-200，默认 20",
                    optional: true,
                },
            },
            async (args) => await listTool(api, args),
        ),
        tool(
            "trash_restore",
            "把回收站条目恢复到原路径；目标已存在时拒绝",
            {
                entry: "回收站条目 id，来自 trash_list 或 delete_file 的 trashId",
            },
            async (args) => await restoreTool(api, args),
        ),
    ]
}

// 注册回收站工具
export function registerTrashTools(api: PluginApi): void {
    for (const definition of trashTools(api)) {
        api.registerAgentTool?.(definition)
    }
}
