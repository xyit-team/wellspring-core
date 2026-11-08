/*
 * 回收站：delete_file 先把条目复制到插件数据目录的 trash/<时间戳>/files/<原相对路径>，
 * 成功写入 meta.json 后再删除工作区里的原条目；删除失败会回滚回收站副本。
 */

import { randomBytes } from "node:crypto"
import { join } from "node:path"

import type { HostFileApi, PluginApi } from "wellspring/api/host/index.ts"

const TRASH_DIR = "trash"
/* 回收站只保留最近 200 次删除 */
const KEEP_ENTRIES = 200

export interface TrashResult {
    /** 插件数据目录内的相对路径，形如 trash/20261025-... */
    readonly entry: string
    /** 回收站条目的绝对路径 */
    readonly absolutePath: string
    /** 回收站里对应原条目的路径 */
    readonly itemPath: string
    readonly files: number
    readonly bytes: number
}

interface CopyCounter {
    files: number
    bytes: number
}

function joinRelative(base: string, name: string): string {
    return base === "" ? name : `${base}/${name}`
}

/** 时间戳 + 随机后缀：目录名可排序，同一秒内也不冲突 */
function trashStamp(): string {
    const now = new Date()
    const pad = (value: number, width = 2): string => String(value).padStart(width, "0")
    const stamp = [
        now.getFullYear(),
        pad(now.getMonth() + 1),
        pad(now.getDate()),
        "-",
        pad(now.getHours()),
        pad(now.getMinutes()),
        pad(now.getSeconds()),
        pad(now.getMilliseconds(), 3),
    ].join("")
    return `${stamp}-${randomBytes(3).toString("hex")}`
}

async function copyEntry(
    source: HostFileApi,
    target: HostFileApi,
    from: string,
    to: string,
    type: string,
    counter: CopyCounter,
): Promise<void> {
    if (type === "directory") {
        await target.mkdir(to)
        const entries = await source.list(from)
        for (const entry of entries) {
            await copyEntry(
                source,
                target,
                joinRelative(from, entry.name),
                joinRelative(to, entry.name),
                entry.type,
                counter,
            )
        }
        return
    }
    if (type !== "file") {
        throw new Error(`不支持的文件类型：${from}`)
    }
    const bytes = await source.readBytes(from)
    if (bytes === null) {
        throw new Error(`读取失败：${from}`)
    }
    const parent = to.includes("/") ? to.slice(0, to.lastIndexOf("/")) : ""
    if (parent !== "") {
        await target.mkdir(parent)
    }
    await target.writeBytes(to, bytes)
    counter.files += 1
    counter.bytes += bytes.length
}

async function pruneTrash(fs: HostFileApi): Promise<void> {
    try {
        const entries = await fs.list(TRASH_DIR)
        const names = entries
            .filter((entry) => entry.type === "directory")
            .map((entry) => entry.name)
            .sort()
        if (names.length <= KEEP_ENTRIES) {
            return
        }
        for (const name of names.slice(0, names.length - KEEP_ENTRIES)) {
            await fs.remove(`${TRASH_DIR}/${name}`)
        }
    } catch {
        // 清理失败不影响本次删除结果
    }
}

/** 把工作区条目移进回收站；返回回收站里的位置（绝对路径可直接交给用户恢复） */
export async function moveToTrash(
    api: PluginApi,
    relativePath: string,
    type: "file" | "directory",
): Promise<TrashResult> {
    const workspaceFs = api.workspaceFs
    const trashFs = api.fs
    const stamp = trashStamp()
    const entry = `${TRASH_DIR}/${stamp}`
    const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
    const itemPath = joinRelative(`${entry}/files`, normalized)
    const counter: CopyCounter = { files: 0, bytes: 0 }
    const dataRoot = join(api.paths.dataDir, "plugin-data", api.plugin.id)
    try {
        await trashFs.mkdir(entry)
        await copyEntry(workspaceFs, trashFs, relativePath, itemPath, type, counter)
        await trashFs.writeJson(`${entry}/meta.json`, {
            at: new Date().toISOString(),
            path: relativePath,
            type,
            item: itemPath,
            files: counter.files,
            bytes: counter.bytes,
        })
        await workspaceFs.remove(relativePath)
    } catch (error) {
        // 原条目还在时清掉半成品；已删原条目则保留副本
        const remaining = await workspaceFs.stat(relativePath).catch(() => null)
        if (remaining !== null) {
            await trashFs.remove(entry).catch(() => undefined)
        }
        throw error
    }
    await pruneTrash(trashFs)
    return {
        entry,
        absolutePath: join(dataRoot, entry),
        itemPath: join(dataRoot, itemPath),
        files: counter.files,
        bytes: counter.bytes,
    }
}

/** 回收站根目录（绝对路径），供工具输出与恢复操作使用 */
export function trashRoot(api: PluginApi): string {
    return join(api.paths.dataDir, "plugin-data", api.plugin.id, TRASH_DIR)
}

/** 回收站条目 id 的形状：trashStamp() 生成的目录名 */
const TRASH_ID = /^[0-9]{8}-[0-9]{9}-[0-9a-f]{6}$/

/** 回收站操作失败：code 供工具映射成结构化错误 */
export class TrashError extends Error {
    readonly code: string

    constructor(code: string, message: string) {
        super(message)
        this.code = code
    }
}

export interface TrashEntry {
    readonly id: string
    /** 删除时间（ISO 8601） */
    readonly at: string
    /** 原工作区相对路径 */
    readonly path: string
    readonly type: "file" | "directory"
    readonly files: number
    readonly bytes: number
}

/** 列出回收站条目：按时间从新到旧，最多 limit 条；读不出的条目跳过 */
export async function listTrash(api: PluginApi, limit: number): Promise<TrashEntry[]> {
    const entries = await api.fs.list(TRASH_DIR).catch(() => [])
    const names = entries
        .filter((entry) => entry.type === "directory" && TRASH_ID.test(entry.name))
        .map((entry) => entry.name)
        .sort()
        .reverse()
    const result: TrashEntry[] = []
    for (const name of names.slice(0, limit)) {
        const meta = await api.fs.readJson<Record<string, unknown>>(`${TRASH_DIR}/${name}/meta.json`)
        if (meta === null) {
            continue
        }
        const path = typeof meta["path"] === "string" ? meta["path"] : ""
        const type = meta["type"] === "directory" ? "directory" : "file"
        const at = typeof meta["at"] === "string" ? meta["at"] : ""
        if (path === "") {
            continue
        }
        result.push({
            id: name,
            at,
            path,
            type,
            files: typeof meta["files"] === "number" ? meta["files"] : 0,
            bytes: typeof meta["bytes"] === "number" ? meta["bytes"] : 0,
        })
    }
    return result
}

/** 从回收站恢复一个条目；目标已存在或条目无效时抛出 */
export async function restoreTrash(api: PluginApi, id: string): Promise<TrashResult & { path: string }> {
    if (!TRASH_ID.test(id)) {
        throw new TrashError("TRASH_BAD_ID", `回收站条目 id 不合法：${id}`)
    }
    const entry = `${TRASH_DIR}/${id}`
    const meta = await api.fs.readJson<Record<string, unknown>>(`${entry}/meta.json`)
    if (meta === null) {
        throw new TrashError("TRASH_ENTRY_NOT_FOUND", `回收站条目不存在：${id}`)
    }
    const originalPath = typeof meta["path"] === "string" ? meta["path"] : ""
    const itemPath = typeof meta["item"] === "string" ? meta["item"] : `${entry}/files/${originalPath}`
    const type = meta["type"] === "directory" ? "directory" : "file"
    if (originalPath === "" || originalPath.includes("..")) {
        throw new TrashError("TRASH_BAD_META", `回收站条目路径无效：${id}`)
    }
    const exists = await api.workspaceFs.exists(originalPath)
    if (exists) {
        throw new TrashError("TRASH_TARGET_EXISTS", `恢复目标已存在：${originalPath}`)
    }
    const counter: CopyCounter = { files: 0, bytes: 0 }
    try {
        await copyEntry(api.fs, api.workspaceFs, itemPath, originalPath, type, counter)
    } catch (error) {
        await api.workspaceFs.remove(originalPath).catch(() => undefined)
        throw error
    }
    await api.fs.remove(entry).catch(() => undefined)
    const dataRoot = join(api.paths.dataDir, "plugin-data", api.plugin.id)
    return {
        entry,
        absolutePath: join(dataRoot, entry),
        itemPath: join(dataRoot, itemPath),
        files: counter.files,
        bytes: counter.bytes,
        path: originalPath,
    }
}
