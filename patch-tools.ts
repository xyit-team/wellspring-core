// 补丁工具：apply_patch
//
// 解析统一 diff 后按上下文写入多个文件
// 先把所有新内容在内存里算完再落盘，任一文件失败时不写任何文件
// 模型侧文本放在 data.content

import type {
    AgentCallToolResult,
    AgentTool,
    PluginApi,
} from "wellspring/api/host/index.ts"

import { describePath, missingFile, workspacePath } from "./paths.ts"
import { markRead } from "./read-tracking.ts"
import { LIMITS } from "./retention.ts"
import { looksBinary } from "./text.ts"
import { tool } from "./tool.ts"

// hunk 行：上下文 / 删除 / 新增
type HunkLine = {
    readonly kind: " " | "+" | "-"
    readonly text: string
}

// 单个 hunk
type Hunk = {
    readonly header: string
    readonly oldStart: number
    readonly oldCount: number
    readonly newStart: number
    readonly newCount: number
    readonly lines: readonly HunkLine[]
    // 新侧没有结尾换行
    readonly newNoNewline: boolean
}

// 单个文件段
type FilePatch = {
    readonly target: string
    readonly create: boolean
    readonly hunks: readonly Hunk[]
}

type ParseOk = { readonly ok: true; readonly files: readonly FilePatch[] }
type ParseBad = { readonly ok: false; readonly code: string; readonly error: string }
type ParseResult = ParseOk | ParseBad

// 内存里累计的文件状态
type FileState = {
    readonly path: string
    readonly display: string
    readonly created: boolean
    lines: string[]
    readonly crlf: boolean
    finalNewline: boolean
    added: number
    removed: number
    // 已应用 hunk 造成的行数差
    offset: number
}

// 结果里的单个文件
type FileResult = {
    readonly path: string
    readonly added: number
    readonly removed: number
    readonly created: boolean
}

// hunk 应用结果
type HunkOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string }

function fail(message: string, code: string): AgentCallToolResult {
    return { success: false, data: { error: message, code } }
}

// 单行提示：空行与超长行
function clipLine(text: string): string {
    if (text === "") {
        return "（空行）"
    }
    return text.length > 80 ? `${text.slice(0, 80)}…` : text
}

// 补丁按行拆开，去掉行尾 CR 与末尾换行产生的空行
function splitPatchLines(text: string): string[] {
    const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    if (lines[lines.length - 1] === "") {
        lines.pop()
    }
    return lines
}

// 文件段之外的 git 元信息行
const PREAMBLE_PREFIXES: readonly string[] = [
    "diff --git ",
    "index ",
    "old mode ",
    "new mode ",
    "new file mode ",
    "deleted file mode ",
    "similarity index ",
    "dissimilarity index ",
    "rename from ",
    "rename to ",
    "copy from ",
    "copy to ",
]

function isPreamble(line: string): boolean {
    return PREAMBLE_PREFIXES.some((prefix) => line.startsWith(prefix))
}

// --- / +++ 行里的路径，去掉行尾时间戳
function headerPath(line: string): string {
    const value = line.slice(4)
    const tab = value.indexOf("\t")
    return (tab < 0 ? value : value.slice(0, tab)).trim()
}

// 去掉 a/、b/ 前缀与开头的 ./
function normalizePatchPath(raw: string): string {
    let value = raw
    if (value.startsWith("a/") || value.startsWith("b/")) {
        value = value.slice(2)
    }
    while (value.startsWith("./")) {
        value = value.slice(2)
    }
    return value
}

function parseFailure(line: number | null, message: string): ParseBad {
    const head = line === null ? "补丁解析失败" : `补丁解析失败（第 ${line} 行）`
    return { ok: false, code: "PATCH_PARSE_ERROR", error: `${head}：${message}` }
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

type HunkParsed = {
    readonly ok: true
    readonly hunk: Hunk
    readonly next: number
}

// 解析一个 hunk：头部行数必须与正文一致
function parseHunk(lines: readonly string[], start: number): HunkParsed | ParseBad {
    const header = lines[start] ?? ""
    const match = HUNK_HEADER.exec(header)
    if (match === null) {
        return parseFailure(start + 1, `hunk 头不合法：${clipLine(header)}`)
    }
    const oldStart = Number(match[1])
    const oldCount = match[2] === undefined ? 1 : Number(match[2])
    const newStart = Number(match[3])
    const newCount = match[4] === undefined ? 1 : Number(match[4])
    if (oldCount > 0 && oldStart === 0) {
        return parseFailure(start + 1, "hunk 头不合法：oldStart 从 1 起")
    }
    if (newCount > 0 && newStart === 0) {
        return parseFailure(start + 1, "hunk 头不合法：newStart 从 1 起")
    }
    const body: HunkLine[] = []
    let oldSeen = 0
    let newSeen = 0
    let newNoNewline = false
    let lastKind: HunkLine["kind"] | null = null
    let cursor = start + 1

    // 标记该侧无结尾换行
    const markNoNewline = (line: number, previous: HunkLine["kind"] | null): ParseBad | null => {
        if (previous === null) {
            return parseFailure(line, "无法识别的行：\\ No newline at end of file")
        }
        if (previous !== "-") {
            newNoNewline = true
        }
        return null
    }

    while (oldSeen < oldCount || newSeen < newCount) {
        if (cursor >= lines.length) {
            return parseFailure(start + 1, "hunk 行数与头部声明不符：内容提前结束")
        }
        const line = lines[cursor] ?? ""
        if (line.startsWith("\\")) {
            if (line.trim() !== "\\ No newline at end of file") {
                return parseFailure(cursor + 1, `无法识别的行：${clipLine(line)}`)
            }
            const bad = markNoNewline(cursor + 1, lastKind)
            if (bad !== null) {
                return bad
            }
            cursor += 1
            continue
        }
        let kind: HunkLine["kind"]
        let text: string
        if (line === "") {
            // 容错：空白被 trim 成空串时按上下文空行处理
            kind = " "
            text = ""
        } else if (line.startsWith(" ")) {
            kind = " "
            text = line.slice(1)
        } else if (line.startsWith("-")) {
            kind = "-"
            text = line.slice(1)
        } else if (line.startsWith("+")) {
            kind = "+"
            text = line.slice(1)
        } else {
            return parseFailure(cursor + 1, "hunk 行数与头部声明不符：遇到非 hunk 行")
        }
        body.push({ kind, text })
        lastKind = kind
        if (kind !== "+") {
            oldSeen += 1
        }
        if (kind !== "-") {
            newSeen += 1
        }
        cursor += 1
    }

    // 行数已满后仍可能有换行标记
    while (cursor < lines.length) {
        const line = lines[cursor] ?? ""
        if (!line.startsWith("\\")) {
            break
        }
        if (line.trim() !== "\\ No newline at end of file") {
            return parseFailure(cursor + 1, `无法识别的行：${clipLine(line)}`)
        }
        const bad = markNoNewline(cursor + 1, lastKind)
        if (bad !== null) {
            return bad
        }
        cursor += 1
    }

    if (oldSeen !== oldCount || newSeen !== newCount) {
        return parseFailure(start + 1, "hunk 行数与头部声明不符")
    }
    return {
        ok: true,
        hunk: { header, oldStart, oldCount, newStart, newCount, lines: body, newNoNewline },
        next: cursor,
    }
}

// 解析整篇补丁
function parsePatch(text: string): ParseResult {
    const lines = splitPatchLines(text)
    const files: FilePatch[] = []
    let cursor = 0
    while (cursor < lines.length) {
        const line = lines[cursor] ?? ""
        if (line === "" || isPreamble(line)) {
            cursor += 1
            continue
        }
        if (line.startsWith("+++ ")) {
            return parseFailure(cursor + 1, "缺少 --- 行")
        }
        if (!line.startsWith("--- ")) {
            // 首个文件段之前的说明行忽略，之后视为无法识别
            if (files.length === 0) {
                cursor += 1
                continue
            }
            return parseFailure(cursor + 1, `无法识别的内容：${clipLine(line)}`)
        }
        const plusLine = lines[cursor + 1]
        if (plusLine === undefined || !plusLine.startsWith("+++ ")) {
            return parseFailure(cursor + 1, "--- 行后缺少 +++ 行")
        }
        const oldRaw = headerPath(line)
        const newRaw = headerPath(plusLine)
        cursor += 2
        if (newRaw === "/dev/null") {
            const target = normalizePatchPath(oldRaw)
            return {
                ok: false,
                code: "PATCH_DELETE_UNSUPPORTED",
                error: `不支持删除文件：${target === "" ? oldRaw : target}；用 delete_file 移入回收站`,
            }
        }
        const target = normalizePatchPath(newRaw)
        if (target === "") {
            return parseFailure(cursor - 1, "文件路径为空")
        }
        const hunks: Hunk[] = []
        for (;;) {
            while (cursor < lines.length && (lines[cursor] ?? "") === "") {
                cursor += 1
            }
            if (cursor >= lines.length) {
                break
            }
            const current = lines[cursor] ?? ""
            if (current.startsWith("@@")) {
                const parsed = parseHunk(lines, cursor)
                if (!parsed.ok) {
                    return parsed
                }
                hunks.push(parsed.hunk)
                cursor = parsed.next
                continue
            }
            if (current.startsWith("--- ") || isPreamble(current)) {
                break
            }
            if (current.startsWith("+++ ")) {
                return parseFailure(cursor + 1, "缺少 --- 行")
            }
            if (current.startsWith(" ") || current.startsWith("+") || current.startsWith("-")) {
                return parseFailure(cursor + 1, "hunk 行数与头部声明不符")
            }
            return parseFailure(cursor + 1, `无法识别的内容：${clipLine(current)}`)
        }
        if (hunks.length === 0) {
            const at = cursor < lines.length ? cursor + 1 : lines.length
            return parseFailure(at, "文件段缺少 @@ hunk 头")
        }
        files.push({ target, create: oldRaw === "/dev/null", hunks })
    }
    if (files.length === 0) {
        return parseFailure(1, "补丁中没有文件段：缺少 --- / +++ 行")
    }
    return { ok: true, files }
}

// 文件按 LF 拆行，CRLF 的 \r 去掉
function splitFileLines(text: string): string[] {
    const lines = text.replace(/\r\n/g, "\n").split("\n")
    if (lines[lines.length - 1] === "") {
        lines.pop()
    }
    return lines
}

// 按原文件换行与结尾换行拼回
function joinContent(state: FileState): string {
    if (state.lines.length === 0) {
        return ""
    }
    const lineBreak = state.crlf ? "\r\n" : "\n"
    return state.lines.join(lineBreak) + (state.finalNewline ? lineBreak : "")
}

// 旧行序列在 start 处是否逐行相等
function matchesAt(lines: readonly string[], needle: readonly string[], start: number): boolean {
    for (let offset = 0; offset < needle.length; offset += 1) {
        if (lines[start + offset] !== needle[offset]) {
            return false
        }
    }
    return true
}

// 找旧行序列的起点：原始行号优先，全文范围内取最近命中
function findMatch(lines: readonly string[], needle: readonly string[], expected: number): number {
    if (needle.length === 0) {
        return Math.max(0, Math.min(expected, lines.length))
    }
    let best = -1
    let bestDistance = Number.POSITIVE_INFINITY
    for (let start = 0; start + needle.length <= lines.length; start += 1) {
        if (!matchesAt(lines, needle, start)) {
            continue
        }
        const distance = Math.abs(start - expected)
        if (distance < bestDistance) {
            best = start
            bestDistance = distance
        }
    }
    return best
}

// hunk 未命中的提示：文件、hunk 头与附近一行
function hunkMissing(state: FileState, hunk: Hunk): string {
    let hint: string
    if (state.lines.length === 0) {
        hint = "文件为空"
    } else {
        const near = Math.max(0, Math.min(hunk.oldStart - 1, state.lines.length - 1))
        hint = `附近内容（第 ${near + 1} 行）：${clipLine(state.lines[near] ?? "")}`
    }
    return `补丁 hunk 未命中：${state.display}\n${hunk.header}\n${hint}`
}

// 应用一个 hunk：按原始行号附近匹配，失败时不动内容
function applyHunk(state: FileState, hunk: Hunk): HunkOutcome {
    const oldLines: string[] = []
    const newLines: string[] = []
    for (const line of hunk.lines) {
        if (line.kind !== "+") {
            oldLines.push(line.text)
        }
        if (line.kind !== "-") {
            newLines.push(line.text)
        }
    }
    const base =
        hunk.oldCount === 0
            ? state.created
                ? Math.max(0, hunk.newStart - 1)
                : hunk.oldStart
            : hunk.oldStart - 1
    const expected = Math.max(0, base + state.offset)
    const index = findMatch(state.lines, oldLines, expected)
    if (index < 0) {
        return { ok: false, error: hunkMissing(state, hunk) }
    }
    const touchesEnd = index + oldLines.length === state.lines.length
    state.lines.splice(index, oldLines.length, ...newLines)
    if (touchesEnd) {
        state.finalNewline = newLines.length > 0 ? !hunk.newNoNewline : true
    }
    state.offset += newLines.length - oldLines.length
    for (const line of hunk.lines) {
        if (line.kind === "+") {
            state.added += 1
        }
        if (line.kind === "-") {
            state.removed += 1
        }
    }
    return { ok: true }
}

async function applyPatchTool(
    api: PluginApi,
    args: Record<string, unknown>,
): Promise<AgentCallToolResult> {
    const raw = args["patch"]
    if (typeof raw !== "string" || raw.trim() === "") {
        return fail("patch 为空或非字符串", "PATCH_BAD_ARGUMENT")
    }
    const bytes = Buffer.byteLength(raw, "utf8")
    if (bytes > LIMITS.patchBytes) {
        return fail(`补丁 ${bytes} 字节，超过上限 ${LIMITS.patchBytes}`, "PATCH_BAD_ARGUMENT")
    }
    const parsed = parsePatch(raw)
    if (!parsed.ok) {
        return fail(parsed.error, parsed.code)
    }
    if (parsed.files.length > LIMITS.patchFiles) {
        return fail(
            `补丁含 ${parsed.files.length} 个文件，超过上限 ${LIMITS.patchFiles}`,
            "PATCH_BAD_ARGUMENT",
        )
    }
    for (const file of parsed.files) {
        if (file.hunks.length > LIMITS.patchHunks) {
            return fail(
                `补丁单文件含 ${file.hunks.length} 个 hunk，超过上限 ${LIMITS.patchHunks}`,
                "PATCH_BAD_ARGUMENT",
            )
        }
    }

    // 先算完全部新内容，任一文件失败直接返回
    const states = new Map<string, FileState>()
    const order: string[] = []
    for (const file of parsed.files) {
        const path = await workspacePath(api, { file_path: file.target }, "file_path")
        const display = describePath(api, path)
        let state = states.get(path)
        if (state === undefined) {
            const info = await api.workspaceFs.stat(path)
            if (file.create) {
                if (info !== null) {
                    return fail(`无法新建 "${display}"：文件已存在`, "PATCH_FILE_EXISTS")
                }
                state = {
                    path,
                    display,
                    created: true,
                    lines: [],
                    crlf: false,
                    finalNewline: true,
                    added: 0,
                    removed: 0,
                    offset: 0,
                }
            } else {
                if (info === null) {
                    return {
                        success: false,
                        data: { error: missingFile(api, path), code: "FS_NOT_FOUND" },
                    }
                }
                if (info.type !== "file") {
                    return fail(`无法应用补丁到 "${display}"：不是普通文件`, "FS_NOT_REGULAR_FILE")
                }
                const text = await api.workspaceFs.readText(path)
                if (text === null) {
                    return {
                        success: false,
                        data: { error: missingFile(api, path), code: "FS_NOT_FOUND" },
                    }
                }
                if (looksBinary(text)) {
                    return fail(
                        `无法应用补丁到 "${display}"：二进制文件，不是 UTF-8 文本`,
                        "FS_NOT_TEXT",
                    )
                }
                state = {
                    path,
                    display,
                    created: false,
                    lines: splitFileLines(text),
                    crlf: text.includes("\r\n"),
                    finalNewline: text.endsWith("\n"),
                    added: 0,
                    removed: 0,
                    offset: 0,
                }
            }
            states.set(path, state)
            order.push(path)
        } else if (file.create) {
            return fail(`无法新建 "${display}"：文件已存在`, "PATCH_FILE_EXISTS")
        }
        for (const hunk of file.hunks) {
            const outcome = applyHunk(state, hunk)
            if (!outcome.ok) {
                return fail(outcome.error, "PATCH_HUNK_NOT_FOUND")
            }
        }
    }

    // 校验全部通过后依次写入，写后刷新已读签名
    for (const path of order) {
        const state = states.get(path)
        if (state === undefined) {
            continue
        }
        await api.workspaceFs.writeText(path, joinContent(state))
        const after = await api.workspaceFs.stat(path)
        if (after !== null) {
            markRead(state.display, { size: after.size, mtimeMs: after.mtimeMs })
        }
    }

    const files: FileResult[] = []
    const detailLines: string[] = []
    let added = 0
    let removed = 0
    for (const path of order) {
        const state = states.get(path)
        if (state === undefined) {
            continue
        }
        files.push({
            path: state.display,
            added: state.added,
            removed: state.removed,
            created: state.created,
        })
        // 模型侧明细用相对路径
        const tag = state.created ? "（新建）" : ""
        detailLines.push(`${state.path}  +${state.added} −${state.removed}${tag}`)
        added += state.added
        removed += state.removed
    }
    const contentLines = [`应用补丁：${files.length} 个文件（+${added} −${removed}）`, ...detailLines]
    return {
        success: true,
        data: { content: contentLines.join("\n"), files, added, removed },
    }
}

function patchTools(api: PluginApi): AgentTool[] {
    return [
        tool(
            "apply_patch",
            "应用统一 diff 补丁到工作区文件：支持多文件与新建文件，不支持删除文件",
            {
                patch: "统一 diff 文本 含 --- / +++ 文件段与 @@ hunk 头，可一次改多个文件",
            },
            async (args) => await applyPatchTool(api, args),
        ),
    ]
}

// 注册 apply_patch
export function registerPatchTools(api: PluginApi): void {
    for (const definition of patchTools(api)) {
        api.registerAgentTool?.(definition)
    }
}
