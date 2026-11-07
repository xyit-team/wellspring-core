// 文本判定：取样里出现 NUL，或替换字符占比超过一成，视为二进制
//
// 判定只看解码后文本的开头，不额外读文件

// 二进制取样字符数
const BINARY_SAMPLE_CHARS = 8000

export function looksBinary(text: string): boolean {
    const sample = text.slice(0, BINARY_SAMPLE_CHARS)
    if (sample === "") {
        return false
    }
    if (sample.includes("\u0000")) {
        return true
    }
    let replaced = 0
    for (const char of sample) {
        if (char === "\ufffd") {
            replaced += 1
        }
    }
    return replaced / sample.length > 0.1
}
