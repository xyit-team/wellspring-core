// 输出落盘：execute_code / query_task 的完整 stdout / stderr 写进 runs/<id>/
//
// 只在超过上下文预算时落盘；模型侧文本给路径，细节用 run_output 读回
// 保留最近 LIMITS.spillKeepRuns 个 run，超出按名字从旧到新清理

import { randomBytes } from "node:crypto"

import type { PluginApi } from "wellspring/api/host/index.ts"

import { LIMITS } from "./retention.ts"

export const RUNS_DIR = "runs"

export interface SpillPaths {
    readonly stdout?: string
    readonly stderr?: string
}

/** 时间戳 + 随机后缀：目录名可排序，同一毫秒也不冲突 */
function runStamp(): string {
    const now = new Date()
    const pad = (value: number, width = 2): string => String(value).padStart(width, "0")
    return [
        now.getFullYear(),
        pad(now.getMonth() + 1),
        pad(now.getDate()),
        "-",
        pad(now.getHours()),
        pad(now.getMinutes()),
        pad(now.getSeconds()),
        pad(now.getMilliseconds(), 3),
        "-",
        randomBytes(3).toString("hex"),
    ].join("")
}

// 保留最近若干次落盘
async function pruneRuns(api: PluginApi): Promise<void> {
    try {
        const entries = await api.fs.list(RUNS_DIR)
        const names = entries
            .filter((entry) => entry.type === "directory")
            .map((entry) => entry.name)
            .sort()
        const excess = names.length - LIMITS.spillKeepRuns
        for (const name of names.slice(0, Math.max(0, excess))) {
            await api.fs.remove(`${RUNS_DIR}/${name}`)
        }
    } catch {
        // 清理失败不影响本次结果
    }
}

// 写一路输出：超过落盘上限时保留前段并注明
async function writeStream(api: PluginApi, path: string, text: string): Promise<void> {
    if (text.length <= LIMITS.spillBytes) {
        await api.fs.writeText(path, text)
        return
    }
    const notice = `\n[落盘截断：原始 ${text.length} 字符，保留前 ${LIMITS.spillBytes} 字符]`
    await api.fs.writeText(path, text.slice(0, LIMITS.spillBytes) + notice)
}

/**
 * 落盘超预算的输出
 *
 * 只有超过 execute_code 的 stdout / stderr 上下文预算时才写文件
 * label 用于后台任务：同一任务重复 query 时复用已有落盘
 */
export async function spillExecOutput(
    api: PluginApi,
    output: { readonly stdout?: unknown; readonly stderr?: unknown },
    label?: string,
): Promise<SpillPaths> {
    const stdout = typeof output.stdout === "string" ? output.stdout : ""
    const stderr = typeof output.stderr === "string" ? output.stderr : ""
    const wantStdout = stdout.length > LIMITS.execStdoutChars
    const wantStderr = stderr.length > LIMITS.execStderrChars
    if (!wantStdout && !wantStderr) {
        return {}
    }
    const id = label === undefined || label === "" ? runStamp() : `task-${label}`
    const directory = `${RUNS_DIR}/${id}`
    const stdoutPath = `${directory}/stdout.txt`
    const stderrPath = `${directory}/stderr.txt`
    const exists = await api.fs.exists(`${directory}/meta.json`)
    if (!exists) {
        await api.fs.mkdir(directory)
        const meta: Record<string, unknown> = { at: new Date().toISOString() }
        if (wantStdout) {
            await writeStream(api, stdoutPath, stdout)
            meta["stdout"] = { chars: stdout.length, path: stdoutPath }
        }
        if (wantStderr) {
            await writeStream(api, stderrPath, stderr)
            meta["stderr"] = { chars: stderr.length, path: stderrPath }
        }
        await api.fs.writeJson(`${directory}/meta.json`, meta)
        await pruneRuns(api)
    }
    const paths: { stdout?: string; stderr?: string } = {}
    if (wantStdout && (await api.fs.exists(stdoutPath))) {
        paths.stdout = stdoutPath
    }
    if (wantStderr && (await api.fs.exists(stderrPath))) {
        paths.stderr = stderrPath
    }
    return paths
}
