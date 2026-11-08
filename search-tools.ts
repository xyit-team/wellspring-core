// 工作区检索：grep 按正则搜文本，glob 按模式列文件
//
// 目录遍历、忽略目录与 glob 匹配来自 workspace-walk
// 模型侧文本放在 data.content
import type {
    AgentCallToolResult,
    AgentTool,
    PluginApi,
} from "wellspring/api/host/index.ts"

import { describePath, missingFile, workspacePath } from "./paths.ts"
import { LIMITS } from "./retention.ts"
import { looksBinary } from "./text.ts"
import { tool } from "./tool.ts"
import {
    globMatcher,
    normalizeRelative,
    walkWorkspace,
    type WalkFile,
} from "./workspace-walk.ts"

function fail(message: string, code: string): AgentCallToolResult {
    return { success: false, data: { error: message, code } }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

// 布尔参数兼容字符串
function isTrue(value: unknown): boolean {
    return value === true || value === "true"
}

// 搜索起点：缺省工作区根，显式给出时按相对路径归一
async function searchStart(api: PluginApi, args: Record<string, unknown>): Promise<string> {
    const raw = args["path"]
    if (typeof raw !== "string" || raw.trim() === "") {
        return "."
    }
    return normalizeRelative(await workspacePath(api, args, "path"))
}

// 额外搜索起点：数组或单个字符串（兼容 JSON 字符串形式）
function pathStarts(raw: unknown): string[] {
    if (Array.isArray(raw)) {
        return raw
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter((item) => item !== "")
    }
    if (typeof raw === "string" && raw.trim() !== "") {
        const value = raw.trim()
        if (value.startsWith("[")) {
            try {
                return pathStarts(JSON.parse(value) as unknown)
            } catch {
                return []
            }
        }
        return [value]
    }
    return []
}

async function grepTool(
    api: PluginApi,
    args: Record<string, unknown>,
): Promise<AgentCallToolResult> {
    const pattern = typeof args["pattern"] === "string" ? args["pattern"] : ""
    if (pattern === "") {
        return fail("pattern 为空", "SEARCH_BAD_PATTERN")
    }
    const ignoreCase = isTrue(args["ignore_case"])
    let expression: RegExp
    try {
        expression = new RegExp(pattern, ignoreCase ? "i" : "")
    } catch (error) {
        return fail(`正则表达式无效：${errorMessage(error)}`, "SEARCH_BAD_PATTERN")
    }
    const rawInclude = typeof args["include"] === "string" ? args["include"].trim() : ""
    let include: ((path: string) => boolean) | null = null
    if (rawInclude !== "") {
        try {
            include = globMatcher(rawInclude)
        } catch (error) {
            return fail(`include 模式无效：${errorMessage(error)}`, "SEARCH_BAD_PATTERN")
        }
    }
    const rawContext = args["context"]
    const context = rawContext === undefined ? 0 : Number(rawContext)
    if (!Number.isInteger(context) || context < 0 || context > LIMITS.grepContext) {
        return fail(
            `context 需要是 0-${LIMITS.grepContext} 的整数，收到：${String(rawContext)}`,
            "FS_BAD_ARGUMENT",
        )
    }
    const rawMax = args["max_results"]
    const maxMatches = rawMax === undefined ? LIMITS.grepMatches : Number(rawMax)
    if (!Number.isInteger(maxMatches) || maxMatches < 1 || maxMatches > LIMITS.grepMatches) {
        return fail(
            `max_results 需要是 1-${LIMITS.grepMatches} 的整数，收到：${String(rawMax)}`,
            "FS_BAD_ARGUMENT",
        )
    }
    const extras = pathStarts(args["paths"])
    if (extras.length > LIMITS.grepPaths) {
        return fail(
            `paths 最多 ${LIMITS.grepPaths} 个起点，收到：${extras.length}`,
            "FS_BAD_ARGUMENT",
        )
    }
    const respectGitignore = !isTrue(args["include_ignored"])

    const starts: string[] = []
    const rawPath = args["path"]
    if (typeof rawPath === "string" && rawPath.trim() !== "") {
        starts.push(normalizeRelative(await workspacePath(api, args, "path")))
    }
    for (const raw of extras) {
        starts.push(normalizeRelative(await workspacePath(api, { path: raw }, "path")))
    }
    if (starts.length === 0) {
        starts.push(".")
    }

    const groups = new Map<string, string[]>()
    const visited = new Set<string>()
    let matches = 0
    let scanned = 0
    let renderedLines = 0
    let matchesTruncated = false
    let scanTruncated = false
    let walkTruncated = false
    let outputTruncated = false

    const formatLine = (body: string): string => {
        const shown = body.trimEnd()
        return shown.length > LIMITS.grepLineChars
            ? `${shown.slice(0, LIMITS.grepLineChars)}…`
            : shown
    }

    // 命中行与上下文：相邻命中合并成一段，段间用 -- 分隔
    const renderBlock = (lines: readonly string[], matched: readonly number[]): string[] => {
        const output: string[] = []
        const matchedLines = new Set(matched)
        let previousEnd = -1
        for (const index of matched) {
            const from = Math.max(0, index - context)
            const to = Math.min(lines.length - 1, index + context)
            if (context > 0 && previousEnd >= 0 && from > previousEnd + 1) {
                output.push("  --")
            }
            for (let cursor = Math.max(from, previousEnd + 1); cursor <= to; cursor += 1) {
                const body = formatLine((lines[cursor] ?? "").replace(/\r$/, ""))
                const marker = matchedLines.has(cursor) ? ":" : "-"
                output.push(`  ${cursor + 1}${marker} ${body}`)
            }
            previousEnd = Math.max(previousEnd, to)
        }
        return output
    }

    const collect = (file: string, text: string): boolean => {
        const lines = text.split("\n")
        const matched: number[] = []
        for (let index = 0; index < lines.length; index += 1) {
            const body = (lines[index] ?? "").replace(/\r$/, "")
            if (!expression.test(body)) {
                continue
            }
            if (matches >= maxMatches) {
                matchesTruncated = true
                break
            }
            matched.push(index)
            matches += 1
        }
        if (matched.length > 0) {
            const block = renderBlock(lines, matched)
            groups.set(file, block)
            renderedLines += block.length + 1
            if (renderedLines >= LIMITS.grepOutputLines) {
                outputTruncated = true
                return false
            }
        }
        return !matchesTruncated
    }

    const visit = async (file: WalkFile): Promise<boolean> => {
        if (visited.has(file.path)) {
            return true
        }
        if (include !== null && !include(file.path)) {
            return true
        }
        if (file.size > LIMITS.grepFileBytes) {
            return true
        }
        if (scanned >= LIMITS.grepFiles) {
            scanTruncated = true
            return false
        }
        visited.add(file.path)
        scanned += 1
        const text = await api.workspaceFs.readText(file.path)
        if (text === null) {
            return true
        }
        if (looksBinary(text)) {
            return true
        }
        return collect(file.path, text)
    }

    for (const start of starts) {
        const info = await api.workspaceFs.stat(start)
        if (info === null) {
            return { success: false, data: { error: missingFile(api, start), code: "FS_NOT_FOUND" } }
        }
        if (info.type === "file") {
            if (!(await visit({ path: start, size: info.size, mtimeMs: info.mtimeMs, depth: 0 }))) {
                break
            }
            continue
        }
        if (info.type !== "directory") {
            return fail(
                `无法搜索 "${describePath(api, start)}"：不是普通文件或目录`,
                "FS_NOT_REGULAR_FILE",
            )
        }
        const walked = await walkWorkspace(api, start, { file: visit }, { respectGitignore })
        walkTruncated = walkTruncated || walked.truncated
        if (matchesTruncated || outputTruncated || scanTruncated) {
            break
        }
    }

    const contentLines: string[] = []
    let cut = false
    for (const [file, block] of groups) {
        if (contentLines.length >= LIMITS.grepOutputLines) {
            outputTruncated = true
            break
        }
        contentLines.push(file)
        for (const line of block) {
            if (contentLines.length >= LIMITS.grepOutputLines) {
                outputTruncated = true
                cut = true
                break
            }
            contentLines.push(line)
        }
        if (cut) {
            break
        }
    }
    const markers: string[] = []
    if (matchesTruncated) {
        markers.push(`[匹配数达到上限 ${maxMatches}，可能还有更多]`)
    }
    if (outputTruncated) {
        markers.push(`[结果行数达到上限 ${LIMITS.grepOutputLines}]`)
    }
    if (scanTruncated) {
        markers.push(`[已扫描 ${LIMITS.grepFiles} 个文件，达到上限]`)
    }
    if (walkTruncated) {
        markers.push("[目录遍历达到上限，可能漏掉部分目录]")
    }
    if (contentLines.length === 0) {
        contentLines.push(`未找到匹配：${pattern}`)
    }
    contentLines.push(...markers)
    return {
        success: true,
        data: {
            content: contentLines.join("\n"),
            matches,
            files: groups.size,
            scanned,
            truncated: matchesTruncated || outputTruncated || scanTruncated || walkTruncated,
        },
    }
}

async function globTool(
    api: PluginApi,
    args: Record<string, unknown>,
): Promise<AgentCallToolResult> {
    const pattern = typeof args["pattern"] === "string" ? args["pattern"].trim() : ""
    if (pattern === "") {
        return fail("pattern 为空", "GLOB_BAD_PATTERN")
    }
    let matchesPath: (path: string) => boolean
    try {
        matchesPath = globMatcher(pattern)
    } catch (error) {
        return fail(`glob 模式无效：${errorMessage(error)}`, "GLOB_BAD_PATTERN")
    }
    const respectGitignore = !isTrue(args["include_ignored"])
    const start = await searchStart(api, args)
    const info = await api.workspaceFs.stat(start)
    if (info === null) {
        return { success: false, data: { error: missingFile(api, start), code: "FS_NOT_FOUND" } }
    }
    if (info.type !== "directory") {
        return fail(`无法搜索 "${describePath(api, start)}"：不是目录`, "FS_NOT_DIRECTORY")
    }

    const matched: WalkFile[] = []
    const walked = await walkWorkspace(
        api,
        start,
        {
            file: (file) => {
                if (matchesPath(file.path)) {
                    matched.push(file)
                }
                return true
            },
        },
        { respectGitignore },
    )
    matched.sort(
        (left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path),
    )
    const listed = matched.slice(0, LIMITS.globPaths)
    const limitTruncated = matched.length > LIMITS.globPaths
    const contentLines = listed.map((file) => file.path)
    const markers: string[] = []
    if (limitTruncated) {
        markers.push(`[已列出 ${LIMITS.globPaths} 条，达到上限]`)
    }
    if (walked.truncated) {
        markers.push("[目录遍历达到上限，可能漏掉部分文件]")
    }
    if (contentLines.length === 0) {
        contentLines.push(`没有匹配的文件：${pattern}`)
    }
    contentLines.push(...markers)
    return {
        success: true,
        data: {
            content: contentLines.join("\n"),
            count: listed.length,
            truncated: limitTruncated || walked.truncated,
        },
    }
}

function searchTools(api: PluginApi): AgentTool[] {
    return [
        tool(
            "grep",
            "在工作区内按正则搜索文本，按文件分组返回行号与命中行，可带上下文；默认跳过 .gitignore 忽略的路径",
            {
                pattern: "正则 JS RegExp 语法，例如 foo|bar",
                path: {
                    type: "string",
                    description: "搜索起点：相对工作区根的目录或单个文件，默认工作区根",
                    optional: true,
                },
                include: {
                    type: "string",
                    description: "只搜路径匹配该 glob 的文件，如 *.ts、src/**/*.ts",
                    optional: true,
                },
                ignore_case: {
                    type: "boolean",
                    description: "true 时忽略大小写",
                    optional: true,
                },
                include_ignored: {
                    type: "boolean",
                    description: "true 时连 .gitignore 忽略的路径也搜；node_modules 等内置忽略目录仍跳过",
                    optional: true,
                },
                paths: {
                    type: "array",
                    items: { type: "string" },
                    description: "额外搜索起点：目录或文件，可多个；与 path 一起生效",
                    optional: true,
                },
                context: {
                    type: "integer",
                    description: `命中行前后各显示的上下文行数（0-${LIMITS.grepContext}），默认 0`,
                    optional: true,
                },
                max_results: {
                    type: "integer",
                    description: `最多返回的命中数（1-${LIMITS.grepMatches}），默认 ${LIMITS.grepMatches}`,
                    optional: true,
                },
            },
            async (args) => await grepTool(api, args),
        ),
        tool(
            "glob",
            "按 glob 匹配工作区内文件路径，按修改时间从新到旧返回；默认跳过 .gitignore 忽略的路径",
            {
                pattern: "glob 模式，支持 *、?、**、{a,b}",
                path: {
                    type: "string",
                    description: "搜索起点目录，默认工作区根",
                    optional: true,
                },
                include_ignored: {
                    type: "boolean",
                    description: "true 时连 .gitignore 忽略的路径也列；node_modules 等内置忽略目录仍跳过",
                    optional: true,
                },
            },
            async (args) => await globTool(api, args),
        ),
    ]
}

// 注册 grep / glob
export function registerSearchTools(api: PluginApi): void {
    for (const definition of searchTools(api)) {
        api.registerAgentTool?.(definition)
    }
}
