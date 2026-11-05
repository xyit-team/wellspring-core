// 结果保留：按字符窗口裁剪并报告省略量
//
// 保留哪一段由各工具决定：搜索留头部、命令输出留尾部、网页正文留首尾
// 恢复动作同样归各工具：翻页、重定向到文件、换更窄的查询
// 切口不劈开代理对

type Retained = {
    readonly text: string
    /** 被裁掉的字符数；0 表示原文完整保留 */
    readonly omittedChars: number
}

/** 切口是否落在代理对中间 */
function splitsPair(text: string, index: number): boolean {
    const previous = text.charCodeAt(index - 1)
    const current = text.charCodeAt(index)
    return previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff
}

/** 保留开头 maxChars 个字符 */
export function retainHead(text: string, maxChars: number): Retained {
    if (text.length <= maxChars) {
        return { text, omittedChars: 0 }
    }
    // 切口落在代理对时前移一格
    let cut = Math.max(0, maxChars)
    if (splitsPair(text, cut)) cut -= 1
    return { text: text.slice(0, cut), omittedChars: text.length - cut }
}

/** 保留末尾 maxChars 个字符：命令输出与日志的有效部分通常在尾部 */
export function retainTail(text: string, maxChars: number): Retained {
    if (text.length <= maxChars) {
        return { text, omittedChars: 0 }
    }
    // 切口落在代理对时后移一格
    let cut = text.length - Math.max(0, maxChars)
    if (splitsPair(text, cut)) cut += 1
    return { text: text.slice(cut), omittedChars: cut }
}

/** 保留首尾，中间以 [...] 标记代替 */
export function retainHeadTail(text: string, headChars: number, tailChars: number): Retained {
    const total = headChars + tailChars
    if (text.length <= total) {
        return { text, omittedChars: 0 }
    }
    let headEnd = Math.max(0, headChars)
    if (splitsPair(text, headEnd)) headEnd -= 1
    let tailStart = Math.max(headEnd, text.length - Math.max(0, tailChars))
    if (splitsPair(text, tailStart)) tailStart += 1
    const head = text.slice(0, headEnd)
    const tail = text.slice(tailStart)
    return {
        text: `${head}\n\n[...]\n\n${tail}`,
        omittedChars: text.length - head.length - tail.length,
    }
}

/**
 * 按行留尾
 *
 * 按字符裁剪会从半行开始（progress 1428 变成 8）
 * 裁完丢掉开头那段半行；无换行的超长单行保持原样
 */
export function retainTailLines(text: string, maxChars: number): Retained {
    const kept = retainTail(text, maxChars)
    if (kept.omittedChars === 0) {
        return kept
    }
    const newline = kept.text.indexOf("\n")
    // 首行过长视为长行正文，丢弃会清空内容
    if (newline < 0 || newline > 200) {
        return kept
    }
    const dropped = newline + 1
    return { text: kept.text.slice(dropped), omittedChars: kept.omittedChars + dropped }
}

/** 省略提示 */
export function omittedNotice(kept: string, omitted: number, unit = "字符"): string {
    return `省略 ${omitted} ${unit}（本段保留${kept}）`
}

/**
 * 各工具的默认上限
 *
 * 进上下文的预算，与 sandbox.outputLimitBytes（进程产出上限）互相独立
 */
export const LIMITS = {
    /** read 单次调用的行数上限 */
    readLines: 2_000,
    /** read 单行字符上限 */
    readLineChars: 2_000,
    /** read 单次调用的 UTF-8 字节上限 */
    readBytes: 51_200,
    /** execute_code 保留的末尾 stdout 字符数 */
    execStdoutChars: 8_000,
    /** execute_code 保留的末尾 stderr 字符数 */
    execStderrChars: 4_000,
    /** web_fetch 保留的首部字符数 */
    fetchHeadChars: 80_000,
    /** web_fetch 保留的尾部字符数 */
    fetchTailChars: 20_000,
    /** web_search 最多列出的结果条数 */
    searchResults: 10,
    /** web_search 单条摘要字符数 */
    searchSnippetChars: 300,
} as const
