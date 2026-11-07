// 工作区检索：grep 按正则搜文本，glob 按模式列文件
//
// 目录遍历、忽略目录与遍历上限共用一套，两个工具仅在匹配与整形上不同
// 模型侧文本放在 data.content

import type {
    AgentCallToolResult,
    AgentTool,
    HostFileEntry,
    PluginApi,
} from "wellspring/api/host/index.ts"

import { describePath, missingFile, workspacePath } from "./paths.ts"
import { LIMITS } from "./retention.ts"
import { looksBinary } from "./text.ts"
import { tool } from "./tool.ts"

// 内置忽略目录
const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", ".svn", ".hg"])

// 正则元字符
const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/g

type WalkFile = {
    readonly path: string
    readonly size: number
    readonly mtimeMs: number
}

type WalkOutcome = {
    // 深度、目录数或文件数触顶
    readonly truncated: boolean
}

// .gitignore 规则：按出现顺序判定，后者覆盖前者
type IgnoreRule = {
    // 规则所在目录，相对工作区根（"." 为根）
    readonly base: string
    readonly expression: RegExp
    // 以 / 结尾：只匹配目录
    readonly directoryOnly: boolean
    readonly negate: boolean
}

// .gitignore 解析：无效模式整行跳过
function parseGitignore(content: string, base: string): IgnoreRule[] {
    const rules: IgnoreRule[] = []
    for (const raw of content.split(/\r?\n/)) {
        const line = raw.trim()
        if (line === "" || line.startsWith("#")) {
            continue
        }
        let pattern = line
        const negate = pattern.startsWith("!")
        if (negate) {
            pattern = pattern.slice(1)
        }
        const directoryOnly = pattern.endsWith("/")
        if (directoryOnly) {
            pattern = pattern.replace(/\/+$/, "")
        }
        const anchored = pattern.startsWith("/")
        if (anchored) {
            pattern = pattern.replace(/^\/+/, "")
        }
        pattern = pattern.replace(/\/+$/, "")
        if (pattern === "") {
            continue
        }
        try {
            const source = globSource(pattern)
            // 带 / 或以 / 开头的按整条相对路径匹配，其余按文件名匹配任意深度
            const wholePath = anchored || pattern.includes("/")
            rules.push({
                base,
                expression: new RegExp(wholePath ? `^${source}$` : `^(?:.*/)?${source}$`),
                directoryOnly,
                negate,
            })
        } catch {
            // 无效模式整行跳过
        }
    }
    return rules
}

// 规则目录内的相对路径，不在目录下返回 null
function pathWithin(base: string, path: string): string | null {
    if (base === ".") {
        return path
    }
    return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : null
}

// 是否命中忽略规则
function ignoredBy(rules: readonly IgnoreRule[], path: string, directory: boolean): boolean {
    let ignored = false
    for (const rule of rules) {
        if (rule.directoryOnly && !directory) {
            continue
        }
        const relative = pathWithin(rule.base, path)
        if (relative === null) {
            continue
        }
        if (rule.expression.test(relative)) {
            ignored = !rule.negate
        }
    }
    return ignored
}

// 祖先目录的 .gitignore：从根到父目录，深层规则后判定
async function ancestorGitignore(api: PluginApi, start: string): Promise<IgnoreRule[]> {
    if (start === ".") {
        return []
    }
    const directories: string[] = ["."]
    let current = ""
    for (const part of start.split("/")) {
        current = current === "" ? part : `${current}/${part}`
        if (current !== start) {
            directories.push(current)
        }
    }
    const rules: IgnoreRule[] = []
    for (const directory of directories) {
        const content = await api.workspaceFs.readText(joinRelative(directory, ".gitignore"))
        if (content !== null) {
            rules.push(...parseGitignore(content, directory))
        }
    }
    return rules
}

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

// 相对路径归一：统一分隔符，去掉开头 ./ 与结尾 /
function normalizeRelative(path: string): string {
    const unified = path.replace(/\\/g, "/").replace(/\/{2,}/g, "/")
    const trimmed = unified.replace(/^\.\//, "").replace(/\/+$/, "")
    return trimmed === "" ? "." : trimmed
}

function joinRelative(base: string, name: string): string {
    return base === "." ? name : `${base}/${name}`
}

function basename(path: string): string {
    const slash = path.lastIndexOf("/")
    return slash < 0 ? path : path.slice(slash + 1)
}

function escapeRegExp(text: string): string {
    return text.replace(REGEXP_SPECIAL, "\\$&")
}

// glob 转正则源码：支持 *、?、**、{a,b}；花括号内按字面量，不嵌套
function globSource(pattern: string): string {
    let source = ""
    let index = 0
    while (index < pattern.length) {
        const char = pattern[index] ?? ""
        if (char === "*") {
            if (pattern[index + 1] === "*") {
                index += 1
                if (pattern[index + 1] === "/") {
                    index += 1
                    source += "(?:[^/]+/)*"
                } else {
                    source += ".*"
                }
            } else {
                source += "[^/]*"
            }
            index += 1
            continue
        }
        if (char === "?") {
            source += "[^/]"
            index += 1
            continue
        }
        if (char === "{") {
            const close = pattern.indexOf("}", index + 1)
            if (close < 0) {
                throw new Error("花括号未闭合：{")
            }
            const body = pattern.slice(index + 1, close)
            if (body.includes("{")) {
                throw new Error("花括号不支持嵌套")
            }
            const alternatives = body === "" ? [] : body.split(",")
            if (alternatives.length === 0 || alternatives.some((item) => item === "")) {
                throw new Error("花括号内有空选项")
            }
            source += `(?:${alternatives.map(escapeRegExp).join("|")})`
            index = close + 1
            continue
        }
        if (char === "}") {
            throw new Error("多余的 }")
        }
        source += escapeRegExp(char)
        index += 1
    }
    return source
}

// glob 匹配器：不含 / 按文件名，含 / 按整条相对路径
function globMatcher(pattern: string): (path: string) => boolean {
    const normalized = pattern.replace(/\\/g, "/").replace(/^\.\/+/, "")
    const expression = new RegExp(`^${globSource(normalized)}$`)
    const basenameOnly = !normalized.includes("/")
    return (path) => expression.test(basenameOnly ? basename(path) : path)
}

// 搜索起点：缺省工作区根，显式给出时按相对路径归一
async function searchStart(api: PluginApi, args: Record<string, unknown>): Promise<string> {
    const raw = args["path"]
    if (typeof raw !== "string" || raw.trim() === "") {
        return "."
    }
    return normalizeRelative(await workspacePath(api, args, "path"))
}

// 递归遍历：entries 按名字有序，深度/目录数/文件数触顶即停
// visit 返回 false 时提前中止
async function walkWorkspace(
    api: PluginApi,
    start: string,
    visit: (file: WalkFile) => boolean | Promise<boolean>,
    respectGitignore: boolean,
): Promise<WalkOutcome> {
    let directories = 0
    let files = 0
    let truncated = false
    const walk = async (
        directory: string,
        depth: number,
        inherited: readonly IgnoreRule[],
    ): Promise<boolean> => {
        if (directories >= LIMITS.walkDirs) {
            truncated = true
            return false
        }
        directories += 1
        let entries: readonly HostFileEntry[]
        try {
            entries = await api.workspaceFs.list(directory)
        } catch {
            // 目录在遍历中消失或不可读：跳过
            return true
        }
        let rules = inherited
        const hasGitignore =
            respectGitignore &&
            entries.some((entry) => entry.name === ".gitignore" && entry.type === "file")
        if (hasGitignore) {
            const content = await api.workspaceFs.readText(joinRelative(directory, ".gitignore"))
            if (content !== null) {
                const local = parseGitignore(content, directory)
                if (local.length > 0) {
                    rules = [...inherited, ...local]
                }
            }
        }
        for (const entry of entries) {
            const path = joinRelative(directory, entry.name)
            if (entry.type === "directory") {
                if (IGNORED_DIRECTORIES.has(entry.name)) {
                    continue
                }
                if (respectGitignore && ignoredBy(rules, path, true)) {
                    continue
                }
                if (depth + 1 > LIMITS.walkDepth) {
                    truncated = true
                    continue
                }
                if (!(await walk(path, depth + 1, rules))) {
                    return false
                }
                continue
            }
            if (entry.type !== "file") {
                continue
            }
            if (respectGitignore && ignoredBy(rules, path, false)) {
                continue
            }
            if (files >= LIMITS.walkFiles) {
                truncated = true
                return false
            }
            files += 1
            const file: WalkFile = {
                path,
                size: entry.size,
                mtimeMs: entry.mtimeMs,
            }
            if (!(await visit(file))) {
                return false
            }
        }
        return true
    }
    const rules = respectGitignore ? await ancestorGitignore(api, start) : []
    await walk(start, 0, rules)
    return { truncated }
}

async function grepTool(
    api: PluginApi,
    args: Record<string, unknown>,
): Promise<AgentCallToolResult> {
    const pattern = typeof args["pattern"] === "string" ? args["pattern"] : ""
    if (pattern === "") {
        return fail("pattern 为空", "SEARCH_BAD_PATTERN")
    }
    const ignoreCase = args["ignore_case"] === true || args["ignore_case"] === "true"
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
    const respectGitignore = !isTrue(args["include_ignored"])
    const start = await searchStart(api, args)
    const info = await api.workspaceFs.stat(start)
    if (info === null) {
        return { success: false, data: { error: missingFile(api, start), code: "FS_NOT_FOUND" } }
    }

    const groups = new Map<string, string[]>()
    let matches = 0
    let scanned = 0
    let matchesTruncated = false
    let scanTruncated = false
    let walkTruncated = false

    const collect = (file: string, text: string): boolean => {
        const lines = text.split("\n")
        const group: string[] = []
        for (let index = 0; index < lines.length; index += 1) {
            const body = (lines[index] ?? "").replace(/\r$/, "")
            if (!expression.test(body)) {
                continue
            }
            if (matches >= LIMITS.grepMatches) {
                matchesTruncated = true
                if (group.length > 0) {
                    groups.set(file, group)
                }
                return false
            }
            matches += 1
            const shown = body.trimEnd()
            const line =
                shown.length > LIMITS.grepLineChars
                    ? `${shown.slice(0, LIMITS.grepLineChars)}…`
                    : shown
            group.push(`${index + 1}: ${line}`)
        }
        if (group.length > 0) {
            groups.set(file, group)
        }
        return true
    }

    const visit = async (file: WalkFile): Promise<boolean> => {
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

    if (info.type === "file") {
        await visit({ path: start, size: info.size, mtimeMs: info.mtimeMs })
    } else if (info.type === "directory") {
        const walked = await walkWorkspace(api, start, visit, respectGitignore)
        walkTruncated = walked.truncated
    } else {
        return fail(
            `无法搜索 "${describePath(api, start)}"：不是普通文件或目录`,
            "FS_NOT_REGULAR_FILE",
        )
    }

    const contentLines: string[] = []
    for (const [file, lines] of groups) {
        contentLines.push(file)
        for (const line of lines) {
            contentLines.push(`  ${line}`)
        }
    }
    const markers: string[] = []
    if (matchesTruncated) {
        markers.push(`[匹配数达到上限 ${LIMITS.grepMatches}，可能还有更多]`)
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
            truncated: matchesTruncated || scanTruncated || walkTruncated,
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
        (file) => {
            if (matchesPath(file.path)) {
                matched.push(file)
            }
            return true
        },
        respectGitignore,
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
            "在工作区内按正则搜索文本，按文件分组返回行号与命中行；默认跳过 .gitignore 忽略的路径",
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
