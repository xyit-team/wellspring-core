/*
 * core 插件的 onSessionStart 系统提示排版。
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import type { SessionStartEvent } from "wellspring/api/host/index.ts"
import {
    buildSessionSystemPrompt,
    formatSessionTime,
} from "../session-prompt.ts"

const os = { platform: "linux", arch: "x64", release: "6.8.0", node: "v26.12.1" }

function event(overrides: Partial<SessionStartEvent> = {}): SessionStartEvent {
    return {
        sessionId: "s",
        mode: "run",
        turn: 1,
        input: "hi",
        cwd: "/home/demo/workspace",
        time: Date.UTC(2026, 9, 31, 8, 30),
        timeZone: "Asia/Shanghai",
        model: "deepseek-chat",
        permission: "workspace-write",
        tools: [],
        prompt: [],
        ...overrides,
    } as SessionStartEvent
}

test("buildSessionSystemPrompt：环境、时间、模型、权限与工具列表", () => {
    const prompt = buildSessionSystemPrompt(event(), os)
    assert.match(prompt, /## 会话环境/)
    assert.match(prompt, /- 操作系统：linux x64（6\.8\.0）/)
    assert.match(prompt, /- Node\.js：v26\.12\.1/)
    assert.match(prompt, /- 工作目录：\/home\/demo\/workspace/)
    assert.match(prompt, /2026年10月31日/)
    assert.match(prompt, /Asia\/Shanghai/)
    assert.match(prompt, /- 模式：Agent（可调用工具）/)
    assert.match(prompt, /- 模型：deepseek-chat/)
    assert.match(prompt, /- 沙箱权限：workspace-write/)
    assert.match(prompt, /## 可用工具/)
    assert.match(prompt, /没有可调用的工具/)
})

test("buildSessionSystemPrompt：网页搜索优先 curl，供应商搜索要先问", () => {
    const prompt = buildSessionSystemPrompt(event(), os)
    assert.match(prompt, /## 联网与搜索/)
    assert.match(prompt, /网页搜索优先用 execute_code 跑 curl/)
    assert.match(prompt, /先用 ask 询问用户是否允许/)
})

test("buildSessionSystemPrompt：列出工具并截断过长描述", () => {
    const prompt = buildSessionSystemPrompt(
        event({
            mode: "chat",
            tools: [
                { name: "read", description: "读取文件" },
                { name: "long", description: "x".repeat(500) },
            ],
        }),
        os,
    )
    assert.match(prompt, /- 模式：对话（无工具）/)
    assert.match(prompt, /- read：读取文件/)
    assert.match(prompt, /- long：x{100,}…/)
    assert.doesNotMatch(prompt, /x{161}/)
})

test("formatSessionTime：非法时区退回 ISO", () => {
    assert.equal(
        formatSessionTime(Date.UTC(2026, 9, 31, 8, 30), "Not/AZone"),
        "2026-10-31T08:30:00.000Z",
    )
})
