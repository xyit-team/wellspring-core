// 工具结果的模型侧渲染
//
// data 供界面、日志与测试使用：sandboxId、backend、access、enforcementNotes、
// memoryLimitReason、artifactDir 等字段不进上下文
// 文本形状：stdout → [stderr] 段 → 条件标记（截断 / 超时 / 信号 / 退出码 / OOM / 产物）
// 渲染函数为纯函数，接受残缺 data，输出文本

import { LIMITS, retainHead, retainHeadTail, retainTailLines } from "./retention.ts"

type Data = Record<string, unknown>

/** 产物列表条数上限 */
const MAX_ARTIFACTS = 8

function isObject(value: unknown): value is Data {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function textOf(value: unknown): string {
    return typeof value === "string" ? value : ""
}

function numberOrNull(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null
}

/** 去掉输出结尾空白 */
function trimTrailing(text: string): string {
    return text.replace(/\s+$/, "")
}

/** 失败时返回错误文本；无 error 字段时为 null */
function errorOf(data: Data): string | null {
    const error = textOf(data["error"])
    return error === "" ? null : `工具失败：${error}`
}

/** 字节数转人读大小 */
function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    const kb = bytes / 1024
    if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : String(Math.round(kb))} kB`
    const mb = kb / 1024
    return `${mb < 10 ? mb.toFixed(1) : String(Math.round(mb))} MB`
}

/** 产物行：路径与大小 */
function artifactLine(value: unknown): string {
    if (!Array.isArray(value)) return ""
    const paths: string[] = []
    for (const item of value) {
        if (!isObject(item)) continue
        const path = textOf(item["path"])
        if (path === "") continue
        const size = numberOrNull(item["size"])
        paths.push(size === null ? path : `${path}（${formatSize(size)}）`)
    }
    if (paths.length === 0) return ""
    const shown = paths.slice(0, MAX_ARTIFACTS)
    const rest = paths.length - shown.length
    return `[产物] ${shown.join("、")}${rest > 0 ? `，另有 ${rest} 个未列出` : ""}`
}

/** 一次执行的附加事实，每个占一行 */
function execMarkers(data: Data): string[] {
    const markers: string[] = []
    if (data["truncated"] === true) {
        markers.push("[输出被截断：超出上限的部分已丢弃]")
    }
    if (data["timedOut"] === true) {
        markers.push("[超时：进程已被终止]")
    }
    if (data["oomKilled"] === true) {
        markers.push("[内存超限：进程被 OOM 杀掉]")
    }
    const signal = textOf(data["signal"])
    if (signal !== "") {
        markers.push(`[信号：${signal}]`)
    }
    const exitCode = numberOrNull(data["exitCode"])
    // 非 0 退出是供模型解读的结果，不是工具错误；0 不用报
    if (exitCode !== null && exitCode !== 0) {
        markers.push(`[退出码：${exitCode}]`)
    }
    const artifacts = artifactLine(data["artifacts"])
    if (artifacts !== "") {
        markers.push(artifacts)
    }
    return markers
}

/** UTF-8 字节数：read 的预算是字节，不是字符 */
function utf8Bytes(text: string): number {
    let bytes = 0
    for (const char of text) {
        const code = char.codePointAt(0) ?? 0
        if (code < 0x80) bytes += 1
        else if (code < 0x800) bytes += 2
        else if (code < 0x10000) bytes += 3
        else bytes += 4
    }
    return bytes
}

export interface ReadWindow {
    readonly content: string
    /** 本页最后一行的行号（1 起）；下一页从 shown + 1 开始 */
    readonly shown: number
}

/**
 * read 的一页：带行号的行 + 分页 footer
 *
 * 三重上限，先到者收尾：行数（offset/limit）、单行字符数、本页总字节数
 * 收尾原因写入 footer，区分「文件末尾」与「到达上限」
 */
export function renderReadWindow(lines: readonly string[], start: number, limit: number): ReadWindow {
    const total = lines.length
    const end = Math.min(total, start + limit)
    const width = String(total).length
    const out: string[] = []
    let bytes = 0
    let shown = start
    let clippedLines = 0
    for (let index = start; index < end; index += 1) {
        const line = lines[index] ?? ""
        const clipped = line.length > LIMITS.readLineChars
        if (clipped) clippedLines += 1
        const body = clipped ? `${line.slice(0, LIMITS.readLineChars)}…` : line
        const rendered = `${String(index + 1).padStart(width)}│ ${body}`
        const size = utf8Bytes(rendered) + 1
        // 至少保留一行，小预算下不返回空页
        if (bytes + size > LIMITS.readBytes && shown > start) break
        bytes += size
        out.push(rendered)
        shown = index + 1
    }
    out.push("")
    out.push(`[lines ${start + 1}-${shown} of ${total}]`)
    if (shown < total) {
        out.push(`[继续读取：offset=${shown + 1}]`)
    }
    if (shown < end) {
        out.push(`[本页在 ${LIMITS.readBytes} 字节处收尾，单页上限]`)
    }
    if (clippedLines > 0) {
        out.push(`[有 ${clippedLines} 行超过 ${LIMITS.readLineChars} 字符，已截断]`)
    }
    return { content: out.join("\n"), shown }
}

/** 后台任务启动回执 */
export function renderTaskStarted(data: Data): string {
    const taskId = textOf(data["taskId"])
    if (taskId === "") {
        return "后台任务已启动；输出：query_task"
    }
    return `后台任务：${taskId}（query_task 输出，stop_task 停止）`
}

/**
 * execute_code 的模型侧文本
 *
 * 正文为 stdout，stderr 单独成段，条件标记贴尾
 * background 调用无 exitCode，返回启动回执
 */
export function renderExec(data: Data): string {
    const failure = errorOf(data)
    if (failure !== null) return failure
    if (!("exitCode" in data) && textOf(data["taskId"]) !== "") {
        return renderTaskStarted(data)
    }
    const parts: string[] = []
    const markers: string[] = []
    // 留尾部：报错、失败堆栈与最终汇总都在尾部
    const stdout = retainTailLines(trimTrailing(textOf(data["stdout"])), LIMITS.execStdoutChars)
    const stderr = retainTailLines(trimTrailing(textOf(data["stderr"])), LIMITS.execStderrChars)
    if (stdout.text !== "") parts.push(stdout.text)
    if (stderr.text !== "") parts.push("[stderr]", stderr.text)
    if (stdout.omittedChars > 0) {
        markers.push(
            `[stdout 截断：保留末尾 ${LIMITS.execStdoutChars} 字符，省略 ${stdout.omittedChars} 字符；` +
                "全文：重定向到文件后 read]",
        )
    }
    if (stderr.omittedChars > 0) {
        markers.push(
            `[stderr 截断：保留末尾 ${LIMITS.execStderrChars} 字符，省略 ${stderr.omittedChars} 字符]`,
        )
    }
    markers.push(...execMarkers(data))
    if (parts.length === 0 && markers.length === 0) {
        return "（无输出）"
    }
    return [...parts, ...markers].join("\n")
}

function statusLabel(status: string): string {
    if (status === "running") return "运行中"
    if (status === "completed") return "已完成"
    if (status === "failed") return "失败"
    if (status === "cancelled") return "已取消"
    return status === "" ? "状态未知" : status
}

/**
 * query_task 的模型侧文本
 *
 * 运行中返回已捕获输出，结束后按 execute_code 的规则渲染结果
 * taskId 与 sandboxId 同值，只保留一个
 */
export function renderTask(data: Data): string {
    const failure = errorOf(data)
    if (failure !== null) return failure
    const taskId = textOf(data["taskId"])
    const parts: string[] = [
        `[任务] ${taskId === "" ? "(未知)" : taskId} ${statusLabel(textOf(data["status"]))}`,
    ]
    const error = textOf(data["error"])
    if (error !== "") parts.push(`[错误] ${error}`)
    const result = isObject(data["result"]) ? data["result"] : null
    if (result !== null) {
        const body = renderExec(result)
        if (body !== "") parts.push(body)
        return parts.join("\n")
    }
    const stdout = retainTailLines(trimTrailing(textOf(data["stdout"])), LIMITS.execStdoutChars)
    const stderr = retainTailLines(trimTrailing(textOf(data["stderr"])), LIMITS.execStderrChars)
    if (stdout.text !== "") parts.push(stdout.text)
    if (stderr.text !== "") parts.push("[stderr]", stderr.text)
    if (stdout.text === "" && stderr.text === "") parts.push("（暂无输出）")
    if (stdout.omittedChars > 0 || stderr.omittedChars > 0) {
        parts.push("[输出截断：仅最新一段；完整输出：任务结束后 query_task]")
    }
    return parts.join("\n")
}

/** stop_task 的模型侧文本 */
export function renderStop(data: Data): string {
    const failure = errorOf(data)
    if (failure !== null) return failure
    const taskId = textOf(data["taskId"])
    const label = taskId === "" ? "任务" : taskId
    if (data["stopped"] !== true) {
        return `未停止：${label} 不存在或已结束`
    }
    const mode = textOf(data["type"]) === "ctrl_c" ? "SIGINT" : "SIGKILL"
    return `已向 ${label} 发送 ${mode}`
}

/** 摘要类字段压成一行 */
function oneLine(text: string): string {
    return text.replace(/\s+/g, " ").trim()
}

/** web_search 的模型侧文本：标题、链接、摘要 */
export function renderSearch(data: Data): string {
    const failure = errorOf(data)
    if (failure !== null) return failure
    const raw = data["results"]
    if (!Array.isArray(raw) || raw.length === 0) {
        return "（没有搜索结果）"
    }
    const lines: string[] = []
    let listed = 0
    let omitted = 0
    for (const item of raw) {
        if (!isObject(item)) continue
        // 条数上限
        if (listed >= LIMITS.searchResults) {
            omitted += 1
            continue
        }
        listed += 1
        lines.push(`${listed}. ${oneLine(textOf(item["title"])) || "(无标题)"}`)
        const url = textOf(item["url"])
        if (url !== "") lines.push(`   ${url}`)
        const snippet = retainHead(
            oneLine(textOf(item["snippet"])) || oneLine(textOf(item["summary"])),
            LIMITS.searchSnippetChars,
        )
        if (snippet.text !== "") {
            lines.push(`   ${snippet.omittedChars > 0 ? `${snippet.text}…` : snippet.text}`)
        }
    }
    if (listed === 0) return "（没有搜索结果）"
    if (omitted > 0) {
        lines.push(`[另有 ${omitted} 条结果未列出；更全的结果：换更具体的查询]`)
    }
    return lines.join("\n")
}

/** web_fetch 的模型侧文本：标题与正文，正文换行保持原样 */
export function renderFetch(data: Data): string {
    const failure = errorOf(data)
    if (failure !== null) return failure
    const title = oneLine(textOf(data["title"]))
    const content = trimTrailing(textOf(data["content"]))
    if (content === "") {
        return title === "" ? "（页面没有正文）" : `# ${title}\n\n（页面没有正文）`
    }
    // 正文首尾均有内容（开头定义、结尾结论），两端都留
    const bounded = retainHeadTail(content, LIMITS.fetchHeadChars, LIMITS.fetchTailChars)
    const body =
        bounded.omittedChars === 0
            ? content
            : `${bounded.text}\n\n[正文截断：保留首 ${LIMITS.fetchHeadChars} 与末 ${LIMITS.fetchTailChars} 字符，` +
              `省略 ${bounded.omittedChars} 字符]`
    return title === "" ? body : `# ${title}\n\n${body}`
}
