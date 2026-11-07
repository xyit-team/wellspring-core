// 先读后写：记下插件进程里读过的文件
//
// 覆盖已有文件前要求本进程先读过；读后文件被外部改动，记录失效
// 记录按绝对路径存放，超出上限淘汰最早记录

// 读到的文件签名
type ReadSignature = {
    readonly size: number
    readonly mtimeMs: number
}

// 记录上限
const MAX_TRACKED_FILES = 500

const tracked = new Map<string, ReadSignature>()

// 记一次已读：read 成功、write 落盘后
export function markRead(path: string, signature: ReadSignature): void {
    tracked.delete(path)
    tracked.set(path, signature)
    while (tracked.size > MAX_TRACKED_FILES) {
        const oldest = tracked.keys().next().value
        if (oldest === undefined) {
            return
        }
        tracked.delete(oldest)
    }
}

// 已读且签名未变
export function hasRead(path: string, signature: ReadSignature): boolean {
    const seen = tracked.get(path)
    return (
        seen !== undefined && seen.size === signature.size && seen.mtimeMs === signature.mtimeMs
    )
}
