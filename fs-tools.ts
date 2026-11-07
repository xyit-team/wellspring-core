// 文件写入工具：write 整篇覆盖、edit 字面量替换
//
// 路径归一化与 read 共用；写权限由宿主按会话权限校验，read-only 回合拒绝
// 模型侧文本放在 data.content

import type {
    AgentCallToolResult,
    AgentTool,
    AgentToolParamSpec,
    PluginApi,
} from "wellspring/api/host/index.ts"

import { describePath, missingFile, workspacePath } from "./paths.ts"
import { hasRead, markRead } from "./read-tracking.ts"
import { looksBinary } from "./text.ts"
import { tool } from "./tool.ts"

function fail(message: string, code: string): AgentCallToolResult {
    return { success: false, data: { error: message, code } }
}

// 行数（结尾换行不计）
function lineCount(text: string): number {
    if (text === "") {
        return 0
    }
    return text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0)
}

// UTF-8 字节数
function utf8Bytes(text: string): number {
    return Buffer.byteLength(text, "utf8")
}

// 命中起点下标
function matchPositions(text: string, needle: string): number[] {
    const positions: number[] = []
    let from = 0
    for (;;) {
        const index = text.indexOf(needle, from)
        if (index < 0) {
            return positions
        }
        positions.push(index)
        from = index + needle.length
    }
}

// 行号（1 起）
function lineAt(text: string, index: number): number {
    let line = 1
    for (let cursor = 0; cursor < index; cursor += 1) {
        if (text.charCodeAt(cursor) === 10) {
            line += 1
        }
    }
    return line
}

// 整篇写入：父目录由宿主创建，目录与特殊文件拒绝
async function writeTool(
    api: PluginApi,
    args: Record<string, unknown>,
): Promise<AgentCallToolResult> {
    const path = await workspacePath(api, args, "file_path")
    const display = describePath(api, path)
    const content = args["content"]
    if (typeof content !== "string") {
        return fail(`无法写入 "${display}"：content 非字符串`, "FS_BAD_ARGUMENT")
    }
    const info = await api.workspaceFs.stat(path)
    if (info !== null && info.type !== "file") {
        const label = info.type === "directory" ? "是目录" : "不是普通文件"
        return fail(`无法写入 "${display}"：${label}`, "FS_NOT_REGULAR_FILE")
    }
    if (info !== null && !hasRead(display, { size: info.size, mtimeMs: info.mtimeMs })) {
        return fail(
            `无法覆盖 "${display}"：未读文件，或读后被改动` +
                "（read 后可覆盖，或用 edit 局部替换）",
            "FS_READ_REQUIRED",
        )
    }
    await api.workspaceFs.writeText(path, content)
    // 写入后刷新签名
    const after = await api.workspaceFs.stat(path)
    if (after !== null) {
        markRead(display, { size: after.size, mtimeMs: after.mtimeMs })
    }
    const lines = lineCount(content)
    const bytes = utf8Bytes(content)
    const verb = info === null ? "已创建" : "已覆盖"
    return {
        success: true,
        data: {
            path: display,
            lines,
            bytes,
            created: info === null,
            content: `${verb} ${display}（${lines} 行，${bytes} 字节）`,
        },
    }
}

// 字面量替换：默认唯一命中，多处命中报首个位置
// 未命中区分「原文不存在」与「CRLF 换行不符」
async function editTool(
    api: PluginApi,
    args: Record<string, unknown>,
): Promise<AgentCallToolResult> {
    const path = await workspacePath(api, args, "file_path")
    const display = describePath(api, path)
    const oldString = typeof args["old_string"] === "string" ? args["old_string"] : ""
    const newString = typeof args["new_string"] === "string" ? args["new_string"] : null
    if (oldString === "") {
        return fail("old_string 为空", "FS_BAD_ARGUMENT")
    }
    if (newString === null) {
        return fail("new_string 非字符串", "FS_BAD_ARGUMENT")
    }
    const text = await api.workspaceFs.readText(path)
    if (text === null) {
        return { success: false, data: { error: missingFile(api, path), code: "FS_NOT_FOUND" } }
    }
    if (looksBinary(text)) {
        return fail(`无法编辑 "${display}"：二进制文件，不是 UTF-8 文本`, "FS_NOT_TEXT")
    }
    const replaceAll = args["replace_all"] === true || args["replace_all"] === "true"
    const positions = matchPositions(text, oldString)
    if (positions.length === 0) {
        if (text.includes("\r\n") && oldString.includes("\n") && !oldString.includes("\r\n")) {
            const crlf = oldString.replace(/\n/g, "\r\n")
            if (text.includes(crlf)) {
                return fail(
                    `old_string 未命中："${display}" 为 CRLF 换行，old_string 内的换行应为 \\r\\n`,
                    "FS_NO_MATCH",
                )
            }
        }
        return fail(`old_string 未命中："${display}"`, "FS_NO_MATCH")
    }
    const first = positions[0] ?? 0
    if (!replaceAll && positions.length > 1) {
        return fail(
            `old_string 命中 ${positions.length} 处（首个第 ${lineAt(text, first)} 行）；` +
                "上下文需更长，或 replace_all:true",
            "FS_AMBIGUOUS_MATCH",
        )
    }
    const next = replaceAll
        ? text.split(oldString).join(newString)
        : `${text.slice(0, first)}${newString}${text.slice(first + oldString.length)}`
    await api.workspaceFs.writeText(path, next)

    const lines = positions.slice(0, 10).map((position) => lineAt(text, position))
    const at =
        positions.length === 1
            ? `第 ${lines[0]} 行`
            : `${positions.length} 处（首个第 ${lines[0]} 行）`
    return {
        success: true,
        data: {
            path: display,
            replaced: positions.length,
            lines,
            bytes: utf8Bytes(next),
            content: `已替换 ${display}：${at}`,
        },
    }
}

function fileTools(api: PluginApi): AgentTool[] {
    return [
        tool(
            "write",
            "写入 workspace 内 UTF-8 文本：整篇覆盖，既有文件需先 read；父目录自动创建",
            {
                file_path: "路径 相对路径按工作区根解析，工作区内绝对路径同样接受",
                content: "文件全文 原样写入，无换行或编码转换",
            },
            async (args) => await writeTool(api, args),
        ),
        tool(
            "edit",
            "按字面量替换 workspace 内文本文件的一段：old_string 需唯一命中，replace_all:true 时全部替换",
            {
                file_path: "路径 相对路径按工作区根解析，工作区内绝对路径同样接受",
                old_string: "待替换原文 按字面量匹配，非空",
                new_string: "替换后的内容 可为空（即删除）",
                replace_all: {
                    type: "boolean",
                    description: "true 时替换全部命中",
                    optional: true,
                },
            },
            async (args) => await editTool(api, args),
        ),
    ]
}

// 注册 write / edit
export function registerFileTools(api: PluginApi): void {
    for (const definition of fileTools(api)) {
        api.registerAgentTool?.(definition)
    }
}
