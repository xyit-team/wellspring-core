// 工作区遍历：目录递归、内置忽略目录、.gitignore 规则与 glob 匹配
//
// grep / glob / list_dir 共用；遍历上限取自 LIMITS
// 模型侧文本由各工具自己整形

import type { HostFileEntry, PluginApi } from "wellspring/api/host/index.ts"

import { LIMITS } from "./retention.ts"

// 内置忽略目录
const DEFAULT_IGNORED_DIRECTORIES = new Set(["node_modules", ".git", ".svn", ".hg"])

// 正则元字符
const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/g

// .gitignore 规则：按出现顺序判定，后者覆盖前者
type IgnoreRule = {
    // 规则所在目录，相对工作区根（"." 为根）
    readonly base: string
    readonly expression: RegExp
    // 以 / 结尾：只匹配目录
    readonly directoryOnly: boolean
    readonly negate: boolean
}

export type WalkFile = {
    readonly path: string
    readonly size: number
    readonly mtimeMs: number
    /** 相对工作区根的深度，根下第一层为 1 */
    readonly depth: number
}

export type WalkVisitor = {
    /** 返回 false 停止遍历 */
    readonly directory?: (path: string, depth: number) => boolean | void | Promise<boolean | void>
    /** 返回 false 停止遍历 */
    readonly file?: (file: WalkFile) => boolean | void | Promise<boolean | void>
}

export type WalkOptions = {
    /** false 时不读 .gitignore；缺省 true */
    readonly respectGitignore?: boolean
    /** 最大深度，缺省 LIMITS.walkDepth */
    readonly maxDepth?: number
    /** 最多访问的文件数，缺省 LIMITS.walkFiles */
    readonly maxFiles?: number
    /** 最多访问的目录数，缺省 LIMITS.walkDirs */
    readonly maxDirs?: number
}

export type WalkOutcome = {
    /** 深度、目录数或文件数触顶 */
    readonly truncated: boolean
    readonly files: number
    readonly directories: number
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

/** 相对路径归一：统一分隔符，去掉开头 ./ 与结尾 / */
export function normalizeRelative(path: string): string {
    const unified = path.replace(/\\/g, "/").replace(/\/{2,}/g, "/")
    const trimmed = unified.replace(/^\.\//, "").replace(/\/+$/, "")
    return trimmed === "" ? "." : trimmed
}

/** 拼接工作区相对路径 */
export function joinRelative(base: string, name: string): string {
    return base === "." ? name : `${base}/${name}`
}

/** 取路径最后一段 */
export function workspaceBasename(path: string): string {
    const slash = path.lastIndexOf("/")
    return slash < 0 ? path : path.slice(slash + 1)
}

function escapeRegExp(text: string): string {
    return text.replace(REGEXP_SPECIAL, "\\$&")
}

// glob 转正则源码：支持 *、?、**、{a,b}；花括号内按字面量，不嵌套
export function globSource(pattern: string): string {
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

/** glob 匹配器：不含 / 按文件名，含 / 按整条相对路径 */
export function globMatcher(pattern: string): (path: string) => boolean {
    const normalized = pattern.replace(/\\/g, "/").replace(/^\.\/+/, "")
    const expression = new RegExp(`^${globSource(normalized)}$`)
    const basenameOnly = !normalized.includes("/")
    return (path) => expression.test(basenameOnly ? workspaceBasename(path) : path)
}

// 递归遍历：entries 按名字有序，深度/目录数/文件数触顶即停
// visitor 返回 false 时提前中止
export async function walkWorkspace(
    api: PluginApi,
    start: string,
    visitor: WalkVisitor,
    options: WalkOptions = {},
): Promise<WalkOutcome> {
    const respectGitignore = options.respectGitignore !== false
    const maxDepth = options.maxDepth ?? LIMITS.walkDepth
    const maxFiles = options.maxFiles ?? LIMITS.walkFiles
    const maxDirs = options.maxDirs ?? LIMITS.walkDirs
    let directories = 0
    let files = 0
    let truncated = false
    const walk = async (
        directory: string,
        depth: number,
        inherited: readonly IgnoreRule[],
    ): Promise<boolean> => {
        if (directories >= maxDirs) {
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
            const childDepth = depth + 1
            if (childDepth > maxDepth) {
                truncated = true
                continue
            }
            const path = joinRelative(directory, entry.name)
            if (entry.type === "directory") {
                if (DEFAULT_IGNORED_DIRECTORIES.has(entry.name)) {
                    continue
                }
                if (respectGitignore && ignoredBy(rules, path, true)) {
                    continue
                }
                if (visitor.directory !== undefined) {
                    const keep = await visitor.directory(path, childDepth)
                    if (keep === false) {
                        return false
                    }
                }
                if (!(await walk(path, childDepth, rules))) {
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
            if (files >= maxFiles) {
                truncated = true
                return false
            }
            files += 1
            const file: WalkFile = { path, size: entry.size, mtimeMs: entry.mtimeMs, depth: childDepth }
            if (visitor.file !== undefined) {
                const keep = await visitor.file(file)
                if (keep === false) {
                    return false
                }
            }
        }
        return true
    }
    const rules = respectGitignore ? await ancestorGitignore(api, start) : []
    await walk(start, 0, rules)
    return { truncated, files, directories }
}
