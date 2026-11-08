// 读取落盘输出：execute_code / query_task 截断时写到 runs/ 的完整文本
//
// 分页语义与 read 一致；只接受 runs/ 下的相对路径

import type { AgentCallToolResult, AgentTool, PluginApi } from "wellspring/api/host/index.ts"

import { renderReadWindow } from "./render.ts"
import { LIMITS } from "./retention.ts"
import { tool } from "./tool.ts"
import { RUNS_DIR } from "./spill.ts"

function fail(message: string, code: string): AgentCallToolResult {
    return { success: false, data: { error: message, code } }
}

async function runOutputTool(
    api: PluginApi,
    args: Record<string, unknown>,
): Promise<AgentCallToolResult> {
    const raw =
        typeof args["file"] === "string" ? args["file"].trim().replace(/\\/g, "/") : ""
    const file = raw.replace(/^\.\//, "")
    if (file === "") {
        return fail("file 为空", "FS_BAD_ARGUMENT")
    }
    if (!file.startsWith(`${RUNS_DIR}/`) || file.includes("..") || file.startsWith("/")) {
        return fail(`file 需要是 ${RUNS_DIR}/ 下的路径：${raw}`, "FS_BAD_ARGUMENT")
    }
    const text = await api.fs.readText(file)
    if (text === null) {
        return fail(`输出文件不存在：${file}`, "FS_NOT_FOUND")
    }
    const lines = text.split(/\r?\n/)
    if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop()
    }
    const rawOffset = args["offset"]
    const rawLimit = args["limit"]
    const offset = rawOffset === undefined ? 1 : Number(rawOffset)
    const limit = rawLimit === undefined ? LIMITS.readLines : Number(rawLimit)
    if (!Number.isInteger(offset) || offset < 1) {
        return fail(`offset 需要是正整数，收到：${String(rawOffset)}`, "FS_BAD_ARGUMENT")
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.readLines) {
        return fail(
            `limit 需要是 1-${LIMITS.readLines} 的整数，收到：${String(rawLimit)}`,
            "FS_BAD_ARGUMENT",
        )
    }
    if (offset > lines.length && !(lines.length === 0 && offset === 1)) {
        return fail(`offset ${offset} 超出范围：${file} 共 ${lines.length} 行`, "FS_OUT_OF_RANGE")
    }
    const page = renderReadWindow(lines, offset - 1, limit)
    return { success: true, data: { content: page.content, path: file } }
}

function runTools(api: PluginApi): AgentTool[] {
    return [
        tool(
            "run_output",
            "读取 execute_code / query_task 落盘的完整输出：file 为输出提示里的 runs/ 路径",
            {
                file: `输出文件路径，来自截断提示：${RUNS_DIR}/<id>/stdout.txt`,
                offset: { type: "integer", description: "起始行", optional: true },
                limit: { type: "integer", description: "行数", optional: true },
            },
            async (args) => await runOutputTool(api, args),
        ),
    ]
}

// 注册 run_output
export function registerRunTools(api: PluginApi): void {
    for (const definition of runTools(api)) {
        api.registerAgentTool?.(definition)
    }
}
