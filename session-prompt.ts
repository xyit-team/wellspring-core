/*
 * 新会话的 system prompt：告诉模型当前运行环境与可用的工具。
 *
 * 由 onSessionStart 触发一次；平台在事件里传好宿主 OS、时间、模型、权限和工具列表，
 * 这里只负责排版，避免插件自己去拼宿主信息。
 */

import type { SessionStartEvent } from "wellspring/api/host/index.ts"

export interface SessionPromptOS {
    readonly platform: string
    readonly arch: string
    readonly release: string
    readonly node: string
}

const MAX_TOOL_DESCRIPTION = 160

function oneLine(text: string, max = MAX_TOOL_DESCRIPTION): string {
    const line = text.replace(/\s+/g, " ").trim()
    return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** 宿主时间戳按宿主时区显示；时区名不可用时退回 ISO */
export function formatSessionTime(time: number, timeZone: string): string {
    try {
        return new Intl.DateTimeFormat("zh-CN", {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone,
        }).format(new Date(time))
    } catch {
        return new Date(time).toISOString()
    }
}

export function buildSessionSystemPrompt(
    event: SessionStartEvent,
    os: SessionPromptOS,
): string {
    const lines = [
        "## 会话环境",
        `- 操作系统：${os.platform} ${os.arch}（${os.release}）`,
        `- Node.js：${os.node}`,
        `- 工作目录：${event.cwd}`,
        `- 当前时间：${formatSessionTime(event.time, event.timeZone)}（${event.timeZone}）`,
        `- 模式：${event.mode === "run" ? "Agent（可调用工具）" : "对话（无工具）"}`,
        `- 模型：${event.model}`,
        `- 沙箱权限：${event.permission}`,
        "",
        "## 可用工具",
    ]
    if (event.tools.length === 0) {
        lines.push("- 当前模式没有可调用的工具")
    } else {
        for (const tool of event.tools) {
            lines.push(`- ${tool.name}：${oneLine(tool.description)}`)
        }
    }
    lines.push(
        "",
        "## 联网与搜索",
        "- 网页搜索优先用 execute_code 跑 curl（例如 curl -sL '<url>'，需要检索就取搜索引擎的 HTML 结果页）：" +
            "这条路不经过供应商的联网接口。",
        "- web_search / web_fetch 走模型提供商的联网接口。只在 curl 拿不到内容时才用，" +
            "并且调用前先用 ask 询问用户是否允许使用供应商的联网搜索，得到同意再调用。",
        "",
        "工具参数里的相对路径以工作目录为基准；写操作受上面的沙箱权限限制。" +
            "「工作区可写」与「完全访问」默认可以联网，read-only 默认断网。",
    )
    return lines.join("\n")
}
