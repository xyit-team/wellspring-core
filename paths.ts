// 工作区路径归一化
//
// 相对路径原样交给宿主，`..` 越界由 HostFileApi 拒绝
// 绝对路径落在工作区内时换成相对路径，工作区外抛出
// 工作区根由会话决定，插件只做换写

import { isAbsolute, relative, resolve, sep } from "node:path"

import type { PluginApi } from "wellspring/api/host/index.ts"

// 去掉路径两侧的成对引号
export function unquote(value: string): string {
    const match = /^(["'`])([\s\S]*)\1$/.exec(value)
    return match === null ? value : (match[2] ?? "").trim()
}

// 工作区根目录；宿主未同步时为空串
export function workspaceRoot(api: PluginApi): string {
    const root = api.workspaceFs.root
    return typeof root === "string" && isAbsolute(root) ? root : ""
}

// 本次调用的工作区根
//
// root 由宿主应答带回，插件进程里只有最近一次应答的缓存
// 会话并行或切换工作区后缓存落后，先用 stat(".") 让宿主带回最新值
export async function currentWorkspaceRoot(api: PluginApi): Promise<string> {
    try {
        await api.workspaceFs.stat(".")
    } catch {
        // 工作区不可读时沿用缓存值
    }
    return workspaceRoot(api)
}

// 错误提示中的绝对路径
export function describePath(api: PluginApi, path: string): string {
    const root = workspaceRoot(api)
    return root === "" ? path : resolve(root, path)
}

// 文件不存在提示：绝对路径 + 工作区根
export function missingFile(api: PluginApi, path: string): string {
    const root = workspaceRoot(api)
    if (root === "") {
        return `文件不存在：${path}`
    }
    return `文件不存在：${describePath(api, path)}\n工作区根目录：${root}`
}

// 工作区内路径归一化
//
// args[key] 是模型给的原始值：去引号、去空白后，相对路径原样返回
// 工作区内绝对路径换成相对路径，工作区外抛出
export async function workspacePath(
    api: PluginApi,
    args: Record<string, unknown>,
    key: string,
): Promise<string> {
    const raw = typeof args[key] === "string" ? String(args[key]).trim() : ""
    const value = unquote(raw)
    if (value === "") {
        throw new Error(`${key} 不能为空`)
    }
    const root = await currentWorkspaceRoot(api)
    if (!isAbsolute(value)) {
        return value
    }
    if (root === "") {
        return value
    }
    const target = resolve(value)
    const rel = relative(root, target)
    if (rel === "") {
        return "."
    }
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error(`路径不在工作区内：${target}\n工作区根目录：${root}`)
    }
    return rel.split(sep).join("/")
}
