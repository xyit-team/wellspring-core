/*
 * SKILL 管理工具：按通用 SKILL 规范读写 SKILL.md。
 * 目录结构：<pluginDataDir>/skills/<name>/SKILL.md + 资源文件。
 */

import type {
    AgentCallToolResult,
    AgentTool,
    AgentToolParamSpec,
    HostFileEntry,
    PluginApi,
} from "wellspring/api/host/index.ts"

const SKILLS_DIR = "skills"
const SKILL_FILE = "SKILL.md"
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_SKILL_BYTES = 512 * 1024
const MAX_RESOURCE_BYTES = 2 * 1024 * 1024
const MAX_TOTAL_RESOURCE_BYTES = 10 * 1024 * 1024
const MAX_RESOURCE_FILES = 500
const MAX_RESOURCE_DEPTH = 6
const DESCRIPTION_MAX = 1024
const WHEN_TO_USE_MAX = 1024
const KNOWN_KEYS = new Set([
    "name",
    "description",
    "whenToUse",
    "license",
    "allowed-tools",
    "disable-model-invocation",
    "user-invocable",
    "metadata",
])

interface SkillInfo {
    readonly name: string
    readonly description: string
    readonly whenToUse?: string
    readonly license?: string
    readonly allowedTools: readonly string[]
    readonly metadata?: Readonly<Record<string, unknown>>
    readonly modelInvocable: boolean
    readonly userInvocable: boolean
    readonly extra: Readonly<Record<string, unknown>>
}

interface SkillDocument {
    readonly data: Record<string, unknown>
    readonly body: string
    readonly info: SkillInfo
}

interface ResourceEntry {
    readonly path: string
    readonly type: "file" | "directory"
    readonly size: number
}

interface WorkspaceResource {
    readonly path: string
    readonly bytes: Uint8Array
}

function fail(message: string): AgentCallToolResult {
    return { success: false, data: { error: message } }
}

async function guarded(
    run: () => Promise<AgentCallToolResult> | AgentCallToolResult,
): Promise<AgentCallToolResult> {
    try {
        return await run()
    } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
    }
}

function stringValue(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

/**
 * 分字段参数直接写进 frontmatter，模型偶尔按 YAML/JSON 习惯再包一层引号
 * （例如 "\"工具说明\""）。先剥掉这一层，避免落盘成嵌套引号。
 */
function unwrapQuotedScalar(value: string): string {
    const trimmed = value.trim()
    if (trimmed.length < 2) {
        return trimmed
    }
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if (first === '"' && last === '"') {
        try {
            const parsed: unknown = JSON.parse(trimmed)
            if (typeof parsed === "string") {
                return parsed
            }
        } catch {
            /* 不是合法 JSON 字符串：只剥外层引号 */
        }
        return trimmed.slice(1, -1)
    }
    if (first === "'" && last === "'") {
        return trimmed.slice(1, -1).replaceAll("''", "'")
    }
    return trimmed
}

/** 标量字段参数：接受裸文本，也容忍额外包的一层引号 */
function scalarField(args: Record<string, unknown>, key: string): string | undefined {
    const value = args[key]
    if (typeof value !== "string") {
        return undefined
    }
    const text = unwrapQuotedScalar(value).trim()
    return text === "" ? undefined : text
}

function requireString(args: Record<string, unknown>, key: string): string {
    const value = stringValue(args[key])
    if (value === undefined) {
        throw new Error(`${key} 不能为空`)
    }
    return value
}

function validateSkillName(name: string): void {
    if (!SKILL_NAME.test(name) || name.length > 64) {
        throw new Error(`SKILL 名称不合法：${name}（小写字母/数字/连字符，≤64）`)
    }
}

function normalizeDescription(value: string): string {
    const description = value.trim()
    if (description === "") {
        throw new Error("SKILL description 不能为空")
    }
    if (description.length > DESCRIPTION_MAX) {
        throw new Error(`SKILL description 超过 ${DESCRIPTION_MAX} 字符`)
    }
    return description
}

/* ── frontmatter（YAML 子集） ─────────────────────────────── */

function parseScalar(raw: string): unknown {
    const value = raw.trim()
    if (value === "") {
        return ""
    }
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
        try {
            return JSON.parse(value)
        } catch {
            return value.slice(1, -1)
        }
    }
    if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
        return value.slice(1, -1).replaceAll("''", "'")
    }
    if (value === "true") return true
    if (value === "false") return false
    if (value === "null" || value === "~") return null
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value)
    if (value.startsWith("[") && value.endsWith("]")) {
        const inner = value.slice(1, -1).trim()
        if (inner === "") return []
        return inner.split(",").map((item) => parseScalar(item.trim()))
    }
    return value
}

function parseNested(lines: readonly string[]): unknown {
    const cleaned = lines.filter((line) => line.trim() !== "")
    if (cleaned.length === 0) {
        return {}
    }
    const dedented = cleaned.map((line) => (line.startsWith("  ") ? line.slice(2) : line))
    if (dedented.every((line) => line.startsWith("- "))) {
        return dedented.map((line) => parseScalar(line.slice(2)))
    }
    const result: Record<string, unknown> = {}
    let index = 0
    while (index < dedented.length) {
        const line = dedented[index] ?? ""
        if (line.trim() === "" || line.trimStart().startsWith("#")) {
            index += 1
            continue
        }
        const match = /^([A-Za-z0-9_.-]+):(?:[ \t]*(.*))?$/.exec(line)
        if (match === null) {
            throw new Error(`frontmatter 无法解析：${line}`)
        }
        const key = match[1] ?? ""
        const rest = (match[2] ?? "").trim()
        if (rest === "") {
            const child: string[] = []
            index += 1
            while (index < dedented.length && (dedented[index] ?? "").startsWith("  ")) {
                child.push(dedented[index] ?? "")
                index += 1
            }
            result[key] = parseNested(child)
        } else {
            result[key] = parseScalar(rest)
            index += 1
        }
    }
    return result
}

function parseFrontmatter(lines: readonly string[]): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    let index = 0
    while (index < lines.length) {
        const line = lines[index] ?? ""
        if (line.trim() === "" || line.trimStart().startsWith("#")) {
            index += 1
            continue
        }
        if (line.startsWith(" ") || line.startsWith("\t")) {
            throw new Error(`frontmatter 缩进不合法：${line}`)
        }
        const match = /^([A-Za-z0-9_.-]+):(?:[ \t]*(.*))?$/.exec(line)
        if (match === null) {
            throw new Error(`frontmatter 无法解析：${line}`)
        }
        const key = match[1] ?? ""
        const rest = (match[2] ?? "").trim()
        if (rest === "|" || rest === ">") {
            const block: string[] = []
            index += 1
            while (index < lines.length) {
                const next = lines[index] ?? ""
                if (next.trim() !== "" && !next.startsWith("  ")) {
                    break
                }
                block.push(next)
                index += 1
            }
            const content = block.filter((item) => item.trim() !== "").map((item) => item.slice(2))
            result[key] = rest === "|" ? content.join("\n") : content.join(" ")
            continue
        }
        if (rest === "") {
            const child: string[] = []
            index += 1
            while (index < lines.length && (lines[index] ?? "").startsWith("  ")) {
                child.push(lines[index] ?? "")
                index += 1
            }
            result[key] = parseNested(child)
            continue
        }
        result[key] = parseScalar(rest)
        index += 1
    }
    return result
}

function splitFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
    const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")
    const lines = normalized.split("\n")
    if ((lines[0] ?? "").trim() !== "---") {
        throw new Error("SKILL.md 需要以 --- 开头的 YAML frontmatter")
    }
    let close = -1
    for (let index = 1; index < lines.length; index += 1) {
        if ((lines[index] ?? "").trim() === "---") {
            close = index
            break
        }
    }
    if (close === -1) {
        throw new Error("SKILL.md frontmatter 缺少结束的 ---")
    }
    return {
        data: parseFrontmatter(lines.slice(1, close)),
        body: lines
            .slice(close + 1)
            .join("\n")
            .replace(/^\n+/, "")
            .trimEnd(),
    }
}

function scalarString(value: unknown): string | undefined {
    if (typeof value === "string") {
        return value
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value)
    }
    return undefined
}

function buildSkillInfo(data: Record<string, unknown>): SkillInfo {
    const name = stringValue(data["name"])
    if (name === undefined) {
        throw new Error("SKILL frontmatter 缺少 name")
    }
    validateSkillName(name)
    const description = normalizeDescription(stringValue(data["description"]) ?? "")
    const whenToUseRaw = stringValue(data["whenToUse"])
    if (whenToUseRaw !== undefined && whenToUseRaw.length > WHEN_TO_USE_MAX) {
        throw new Error(`SKILL whenToUse 超过 ${WHEN_TO_USE_MAX} 字符`)
    }
    const license = stringValue(data["license"])
    const allowedToolsRaw = data["allowed-tools"]
    let allowedTools: string[] = []
    if (typeof allowedToolsRaw === "string") {
        allowedTools = allowedToolsRaw
            .split(",")
            .map((item) => item.trim())
            .filter((item) => item !== "")
    } else if (Array.isArray(allowedToolsRaw)) {
        allowedTools = allowedToolsRaw
            .map((item) => scalarString(item))
            .filter((item): item is string => item !== undefined)
    }
    const metadataRaw = data["metadata"]
    const metadata =
        typeof metadataRaw === "object" && metadataRaw !== null && !Array.isArray(metadataRaw)
            ? (metadataRaw as Record<string, unknown>)
            : undefined
    const extra: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(data)) {
        if (!KNOWN_KEYS.has(key)) {
            extra[key] = value
        }
    }
    return {
        name,
        description,
        ...(whenToUseRaw !== undefined ? { whenToUse: whenToUseRaw } : {}),
        ...(license !== undefined ? { license } : {}),
        allowedTools,
        ...(metadata !== undefined ? { metadata } : {}),
        modelInvocable: data["disable-model-invocation"] !== true,
        userInvocable: data["user-invocable"] !== false,
        extra,
    }
}

function parseSkill(text: string): SkillDocument {
    const { data, body } = splitFrontmatter(text)
    return { data, body, info: buildSkillInfo(data) }
}

/* ── 序列化 ───────────────────────────────────────────────── */

function needsQuotes(value: string): boolean {
    if (value === "") return true
    if (value !== value.trim()) return true
    if (/^(?:yes|no|on|off|true|false|null|~)$/i.test(value)) return true
    if (/^[-?:][ \t]/.test(value)) return true
    return !/^[A-Za-z0-9_./@$-]+$/.test(value)
}

function quoteScalar(value: unknown): string {
    if (typeof value === "string") {
        return needsQuotes(value) ? JSON.stringify(value) : value
    }
    if (value === null) return "null"
    return String(value)
}

function writeNode(lines: string[], key: string, value: unknown, indent: number): void {
    const prefix = " ".repeat(indent)
    if (Array.isArray(value)) {
        if (value.length === 0) {
            lines.push(`${prefix}${key}: []`)
            return
        }
        lines.push(`${prefix}${key}:`)
        for (const item of value) {
            lines.push(`${prefix}  - ${quoteScalar(item)}`)
        }
        return
    }
    if (typeof value === "object" && value !== null) {
        const entries = Object.entries(value as Record<string, unknown>)
        if (entries.length === 0) {
            lines.push(`${prefix}${key}: {}`)
            return
        }
        lines.push(`${prefix}${key}:`)
        for (const [childKey, childValue] of entries) {
            writeNode(lines, childKey, childValue, indent + 2)
        }
        return
    }
    lines.push(`${prefix}${key}: ${quoteScalar(value)}`)
}

function orderedKeys(data: Record<string, unknown>): string[] {
    const order = [
        "name",
        "description",
        "whenToUse",
        "license",
        "allowed-tools",
        "disable-model-invocation",
        "user-invocable",
        "metadata",
    ]
    const keys = order.filter((key) => data[key] !== undefined)
    for (const key of Object.keys(data).sort()) {
        if (!order.includes(key) && data[key] !== undefined) {
            keys.push(key)
        }
    }
    return keys
}

function serializeSkill(data: Record<string, unknown>, body: string): string {
    const lines = ["---"]
    for (const key of orderedKeys(data)) {
        writeNode(lines, key, data[key], 0)
    }
    lines.push("---", "")
    const trimmed = body.replace(/\s+$/, "")
    return trimmed === "" ? `${lines.join("\n")}\n` : `${lines.join("\n")}${trimmed}\n`
}

/* ── 文件系统辅助 ─────────────────────────────────────────── */

function skillDir(name: string): string {
    return `${SKILLS_DIR}/${name}`
}

function joinRelative(base: string, name: string): string {
    return base === "" ? name : `${base}/${name}`
}

function safeResourcePath(value: string): string {
    const normalized = value.trim().replaceAll("\\", "/")
    if (normalized === "" || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
        throw new Error(`资源路径不合法：${value}`)
    }
    const segments = normalized.split("/")
    for (const segment of segments) {
        if (segment === "" || segment === "." || segment === ".." || segment.includes("\0")) {
            throw new Error(`资源路径不合法：${value}`)
        }
    }
    return segments.join("/")
}

async function readSkillDocument(api: PluginApi, name: string): Promise<SkillDocument> {
    validateSkillName(name)
    if (!(await api.fs.exists(skillDir(name)))) {
        throw new Error(`SKILL 不存在：${name}`)
    }
    const text = await api.fs.readText(`${skillDir(name)}/${SKILL_FILE}`)
    if (text === null) {
        throw new Error(`SKILL 缺少 ${SKILL_FILE}：${name}`)
    }
    const document = parseSkill(text)
    if (document.info.name !== name) {
        throw new Error(`SKILL 目录名与 frontmatter 不一致：${name} / ${document.info.name}`)
    }
    return document
}

async function listResources(api: PluginApi, name: string, limit = 100): Promise<ResourceEntry[]> {
    const result: ResourceEntry[] = []
    const walk = async (directory: string, depth: number): Promise<void> => {
        if (result.length >= limit) {
            return
        }
        let entries: readonly HostFileEntry[]
        try {
            entries = await api.fs.list(directory)
        } catch {
            return
        }
        for (const entry of entries) {
            if (result.length >= limit) {
                return
            }
            const relative = joinRelative(directory.slice(skillDir(name).length + 1), entry.name)
            if (directory === skillDir(name) && entry.name === SKILL_FILE) {
                continue
            }
            if (entry.type === "directory") {
                if (depth < 3) {
                    await walk(`${directory}/${entry.name}`, depth + 1)
                }
                continue
            }
            if (entry.type === "file") {
                result.push({ path: relative, type: "file", size: entry.size })
            }
        }
    }
    await walk(skillDir(name), 0)
    return result.sort((left, right) => left.path.localeCompare(right.path))
}

function skillSummary(api: PluginApi, name: string): string {
    return `${SKILLS_DIR}/${name}`
}

function skillPayload(info: SkillInfo): Record<string, unknown> {
    return {
        name: info.name,
        description: info.description,
        ...(info.whenToUse !== undefined ? { whenToUse: info.whenToUse } : {}),
        ...(info.license !== undefined ? { license: info.license } : {}),
        allowedTools: [...info.allowedTools],
        ...(info.metadata !== undefined ? { metadata: info.metadata } : {}),
        modelInvocable: info.modelInvocable,
        userInvocable: info.userInvocable,
        ...(Object.keys(info.extra).length > 0 ? { extra: info.extra } : {}),
    }
}

async function readWorkspaceText(api: PluginApi, path: string): Promise<string> {
    const text = await api.workspaceFs.readText(path)
    if (text === null) {
        throw new Error(`工作区文件不存在：${path}`)
    }
    if (text.length > MAX_SKILL_BYTES) {
        throw new Error(`SKILL.md 超过 ${MAX_SKILL_BYTES} 字节：${path}`)
    }
    return text
}

async function collectWorkspaceResources(
    api: PluginApi,
    sourceRoot: string,
): Promise<WorkspaceResource[]> {
    const resources: WorkspaceResource[] = []
    let totalBytes = 0
    const walk = async (directory: string, depth: number): Promise<void> => {
        if (depth > MAX_RESOURCE_DEPTH) {
            throw new Error("SKILL 资源目录超过 6 层")
        }
        let entries: readonly HostFileEntry[]
        try {
            entries = await api.workspaceFs.list(directory)
        } catch {
            throw new Error(`无法读取 SKILL 资源目录：${directory}`)
        }
        for (const entry of entries) {
            const relative = joinRelative(directory, entry.name)
            if (entry.name === "node_modules" || entry.name === ".git") {
                continue
            }
            if (entry.type === "directory") {
                await walk(relative, depth + 1)
                continue
            }
            if (entry.type !== "file") {
                continue
            }
            if (directory === sourceRoot && entry.name === SKILL_FILE) {
                continue
            }
            if (entry.size > MAX_RESOURCE_BYTES) {
                throw new Error(`SKILL 资源过大：${relative}`)
            }
            if (resources.length >= MAX_RESOURCE_FILES) {
                throw new Error(`SKILL 资源文件超过 ${MAX_RESOURCE_FILES} 个`)
            }
            totalBytes += entry.size
            if (totalBytes > MAX_TOTAL_RESOURCE_BYTES) {
                throw new Error("SKILL 资源总大小超过 10 MB")
            }
            const bytes = await api.workspaceFs.readBytes(relative)
            if (bytes === null) {
                throw new Error(`无法读取 SKILL 资源：${relative}`)
            }
            resources.push({
                path: relative.slice(sourceRoot.length + 1),
                bytes,
            })
        }
    }
    await walk(sourceRoot, 0)
    return resources
}

/* ── 工具实现 ─────────────────────────────────────────────── */

async function listSkills(api: PluginApi): Promise<AgentCallToolResult> {
    const invalid: Array<{ name: string; error: string }> = []
    const skills: Array<Record<string, unknown>> = []
    let entries: readonly HostFileEntry[] = []
    try {
        entries = await api.fs.list(SKILLS_DIR)
    } catch {
        return { success: true, data: { skills: [], invalid: [], root: SKILLS_DIR } }
    }
    for (const entry of entries) {
        if (entry.type !== "directory") {
            continue
        }
        try {
            const document = await readSkillDocument(api, entry.name)
            const resources = await listResources(api, entry.name, 30)
            const stat = await api.fs.stat(`${skillDir(entry.name)}/${SKILL_FILE}`)
            skills.push({
                ...skillPayload(document.info),
                path: skillSummary(api, entry.name),
                updatedAt: stat?.mtimeMs ?? null,
                files: resources,
            })
        } catch (error) {
            invalid.push({
                name: entry.name,
                error: error instanceof Error ? error.message : String(error),
            })
        }
    }
    skills.sort((left, right) => String(left["name"]).localeCompare(String(right["name"])))
    return { success: true, data: { skills, invalid, root: SKILLS_DIR } }
}

async function readSkill(
    api: PluginApi,
    args: Record<string, unknown>,
): Promise<AgentCallToolResult> {
    const name = requireString(args, "name")
    const document = await readSkillDocument(api, name)
    const fileArg = stringValue(args["file"]) ?? SKILL_FILE
    const file = safeResourcePath(fileArg)
    const resources = await listResources(api, name)
    if (file === SKILL_FILE) {
        return {
            success: true,
            data: {
                skill: skillPayload(document.info),
                path: skillSummary(api, name),
                file,
                content: document.body,
                files: resources,
            },
        }
    }
    const target = `${skillDir(name)}/${file}`
    const stat = await api.fs.stat(target)
    if (stat === null || stat.type !== "file") {
        return fail(`SKILL 资源不存在：${name}/${file}`)
    }
    if (stat.size > MAX_SKILL_BYTES) {
        return fail(`SKILL 资源过大：${name}/${file}`)
    }
    const text = await api.fs.readText(target)
    if (text === null) {
        return fail(`SKILL 资源不是 UTF-8 文本：${name}/${file}`)
    }
    return {
        success: true,
        data: {
            skill: skillPayload(document.info),
            path: skillSummary(api, name),
            file,
            content: text,
            files: resources,
        },
    }
}

async function installSkill(
    api: PluginApi,
    args: Record<string, unknown>,
): Promise<AgentCallToolResult> {
    const content = typeof args["content"] === "string" ? args["content"] : undefined
    const sourcePath = stringValue(args["path"])
    if ((content === undefined) === (sourcePath === undefined)) {
        throw new Error("content 与 path 需要二选一")
    }
    const overwrite = args["overwrite"] === true || args["overwrite"] === "true"
    let document: SkillDocument
    let resources: WorkspaceResource[] = []
    if (content !== undefined) {
        if (content.length > MAX_SKILL_BYTES) {
            throw new Error(`SKILL.md 超过 ${MAX_SKILL_BYTES} 字节`)
        }
        document = parseSkill(content)
    } else {
        const path = (sourcePath ?? "").replace(/\/+$/, "")
        const stat = await api.workspaceFs.stat(path)
        if (stat === null) {
            throw new Error(`工作区路径不存在：${path}`)
        }
        if (stat.type === "directory") {
            const skillText = await readWorkspaceText(api, joinRelative(path, SKILL_FILE))
            document = parseSkill(skillText)
            resources = await collectWorkspaceResources(api, path)
        } else if (stat.type === "file") {
            if (!path.endsWith(".md")) {
                throw new Error("path 需要指向 SKILL.md 或包含 SKILL.md 的目录")
            }
            document = parseSkill(await readWorkspaceText(api, path))
        } else {
            throw new Error(`不支持的 SKILL 来源：${path}`)
        }
    }
    const name = document.info.name
    const nameArg = stringValue(args["name"])
    if (nameArg !== undefined && nameArg !== name) {
        throw new Error(`name 与 frontmatter 不一致：${nameArg} / ${name}`)
    }
    const target = skillDir(name)
    const exists = await api.fs.exists(target)
    if (exists && !overwrite) {
        throw new Error(`SKILL 已存在：${name}（覆盖请传 overwrite=true）`)
    }
    if (exists) {
        await api.fs.remove(target)
    }
    await api.fs.mkdir(target)
    await api.fs.writeText(`${target}/${SKILL_FILE}`, serializeSkill(document.data, document.body))
    for (const resource of resources) {
        const targetFile = `${target}/${resource.path}`
        const slash = targetFile.lastIndexOf("/")
        await api.fs.mkdir(targetFile.slice(0, slash))
        await api.fs.writeBytes(targetFile, resource.bytes)
    }
    const stat = await api.fs.stat(`${target}/${SKILL_FILE}`)
    return {
        success: true,
        data: {
            skill: {
                ...skillPayload(document.info),
                path: skillSummary(api, name),
                updatedAt: stat?.mtimeMs ?? null,
            },
            file: `${target}/${SKILL_FILE}`,
            files: resources.length + 1,
        },
    }
}

async function modifySkill(
    api: PluginApi,
    args: Record<string, unknown>,
): Promise<AgentCallToolResult> {
    const name = requireString(args, "name")
    const document = await readSkillDocument(api, name)
    const content = typeof args["content"] === "string" ? args["content"] : undefined
    const sourcePath = stringValue(args["path"])
    const description = scalarField(args, "description")
    const whenToUse = scalarField(args, "whenToUse")
    const body = typeof args["body"] === "string" ? args["body"] : undefined
    if (
        content === undefined &&
        sourcePath === undefined &&
        description === undefined &&
        whenToUse === undefined &&
        body === undefined
    ) {
        throw new Error("至少提供 content、path、description、whenToUse 或 body 之一")
    }
    let nextData: Record<string, unknown> = { ...document.data }
    let nextBody = document.body
    let nextInfo: SkillInfo
    if (content !== undefined || sourcePath !== undefined) {
        if (content !== undefined && sourcePath !== undefined) {
            throw new Error("content 与 path 只能提供一个")
        }
        const text =
            content !== undefined ? content : await readWorkspaceText(api, sourcePath ?? "")
        if (text.length > MAX_SKILL_BYTES) {
            throw new Error(`SKILL.md 超过 ${MAX_SKILL_BYTES} 字节`)
        }
        const parsed = parseSkill(text)
        if (parsed.info.name !== name) {
            throw new Error(`不能通过修改改名：${name} / ${parsed.info.name}`)
        }
        nextData = parsed.data
        nextBody = parsed.body
        nextInfo = parsed.info
    } else {
        if (description !== undefined) {
            nextData = { ...nextData, description: normalizeDescription(description) }
        }
        if (whenToUse !== undefined) {
            if (whenToUse.length > WHEN_TO_USE_MAX) {
                throw new Error(`SKILL whenToUse 超过 ${WHEN_TO_USE_MAX} 字符`)
            }
            nextData = { ...nextData, whenToUse }
        }
        nextInfo = buildSkillInfo(nextData)
    }
    if (body !== undefined) {
        nextBody = body.replace(/\s+$/, "")
    }
    const target = skillDir(name)
    await api.fs.writeText(`${target}/${SKILL_FILE}`, serializeSkill(nextData, nextBody))
    const stat = await api.fs.stat(`${target}/${SKILL_FILE}`)
    return {
        success: true,
        data: {
            skill: {
                ...skillPayload(nextInfo),
                path: skillSummary(api, name),
                updatedAt: stat?.mtimeMs ?? null,
            },
            file: `${target}/${SKILL_FILE}`,
            files: (await listResources(api, name)).length + 1,
        },
    }
}

function defineTool(
    name: string,
    description: string,
    params: Record<string, AgentToolParamSpec>,
    call: (api: PluginApi, args: Record<string, unknown>) => Promise<AgentCallToolResult>,
): (api: PluginApi) => AgentTool {
    return (api: PluginApi): AgentTool => ({
        name,
        introduction: { params, content: description },
        call: async (...values: unknown[]) => {
            const input =
                typeof values[0] === "object" && values[0] !== null
                    ? (values[0] as Record<string, unknown>)
                    : {}
            return await guarded(async () => call(api, input))
        },
    })
}

const SKILL_LIST_TOOL = defineTool(
    "skill_list",
    "列出已安装的 SKILL（通用 SKILL.md 规范），返回名称、描述、触发时机与资源文件",
    {},
    async (api) => await listSkills(api),
)

const SKILL_READ_TOOL = defineTool(
    "skill_read",
    "读取已安装 SKILL 的说明正文；file 可指定技能目录内的资源文件",
    {
        name: "SKILL 名称",
        file: {
            type: "string",
            description: "技能目录内的相对路径，默认 SKILL.md",
            optional: true,
        },
    },
    async (api, args) => await readSkill(api, args),
)

const SKILL_INSTALL_TOOL = defineTool(
    "skill_install",
    "安装 SKILL：content 传 SKILL.md 全文，或 path 指向工作区内含 SKILL.md 的目录/单个 .md；SKILL.md 需 YAML frontmatter（name、description）",
    {
        name: {
            type: "string",
            description: "可选，需与 frontmatter 的 name 一致",
            optional: true,
        },
        content: {
            type: "string",
            description: "SKILL.md 全文（含 frontmatter）",
            optional: true,
        },
        path: {
            type: "string",
            description: "工作区内技能目录或 .md 文件路径",
            optional: true,
        },
        overwrite: {
            type: "boolean",
            description: "已存在时覆盖",
            optional: true,
        },
    },
    async (api, args) => await installSkill(api, args),
)

const SKILL_MODIFY_TOOL = defineTool(
    "skill_modify",
    "修改已安装 SKILL：content/path 整篇替换 SKILL.md，或只改 description、whenToUse、body",
    {
        name: "SKILL 名称",
        content: {
            type: "string",
            description: "新的 SKILL.md 全文（含 frontmatter）",
            optional: true,
        },
        path: {
            type: "string",
            description: "工作区内新的 .md 文件路径",
            optional: true,
        },
        description: {
            type: "string",
            description: "新的 description；直接传文本，不要额外包引号",
            optional: true,
        },
        whenToUse: {
            type: "string",
            description: "新的 whenToUse；直接传文本，不要额外包引号",
            optional: true,
        },
        body: { type: "string", description: "新的说明正文（不含 frontmatter）", optional: true },
    },
    async (api, args) => await modifySkill(api, args),
)

/** 注册 SKILL 管理工具 */
export function registerSkillTools(api: PluginApi): void {
    for (const factory of [
        SKILL_LIST_TOOL,
        SKILL_READ_TOOL,
        SKILL_INSTALL_TOOL,
        SKILL_MODIFY_TOOL,
    ]) {
        api.registerAgentTool?.(factory(api))
    }
}
