import assert from "node:assert/strict"
import { test } from "node:test"

import {
    renderExec,
    renderFetch,
    renderSearch,
    renderStop,
    renderTask,
} from "../render.ts"

/** 真实的 execute_code 结果：字段多、真正有用的很少 */
function execData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        sandboxId: "4bf3ed57-4f95-4fd8-be0b-0ef9179fbb89",
        backend: "direct",
        access: "danger-full-access",
        enforcement: "none",
        enforcementNotes: ["无隔离：以宿主用户身份执行，文件、网络、进程不受限"],
        exitCode: 0,
        signal: null,
        stdout: "hi\n",
        stderr: "",
        truncated: false,
        timedOut: false,
        memoryLimit: "none",
        memoryLimitReason: null,
        oomKilled: false,
        durationMs: 6,
        artifacts: [],
        artifactDir: "/home/x/.local/share/wellspring/sandbox/4bf3ed57/artifacts",
        sandboxDir: "/home/x/.local/share/wellspring/sandbox/4bf3ed57",
        ...overrides,
    }
}

test("renderExec：正文只有 stdout，元数据不进上下文", () => {
    const data = execData()
    assert.equal(renderExec(data), "hi")
    // 模型侧文本远小于序列化后的 data
    const compact = renderExec(data).length
    const raw = JSON.stringify(data).length
    assert.ok(compact * 10 < raw, `模型侧 ${compact} 字符，原始 ${raw} 字符`)
})

test("renderExec：stderr 单独成段，非 0 退出码作为结果告知", () => {
    const rendered = renderExec(
        execData({ exitCode: 1, stdout: "", stderr: "bash: nope: command not found\n" }),
    )
    assert.equal(rendered, "[stderr]\nbash: nope: command not found\n[退出码：1]")
})

test("renderExec：截断 / 超时 / 信号 / OOM 各占一行", () => {
    const rendered = renderExec(
        execData({ timedOut: true, truncated: true, signal: "SIGTERM", oomKilled: true }),
    )
    const lines = rendered.split("\n")
    assert.ok(lines.includes("[输出被截断：超出上限的部分已丢弃]"), rendered)
    assert.ok(lines.includes("[超时：进程已被终止]"), rendered)
    assert.ok(lines.includes("[信号：SIGTERM]"), rendered)
    assert.ok(lines.includes("[内存超限：进程被 OOM 杀掉]"), rendered)
    // 退出 0 不输出标记
    assert.ok(!rendered.includes("退出码"), rendered)
})

test("renderExec：空输出明确说没输出", () => {
    assert.equal(renderExec(execData({ stdout: "", stderr: "" })), "（无输出）")
})

test("renderExec：产物路径与大小保留，超出条数折叠", () => {
    const single = renderExec(
        execData({ artifacts: [{ path: "/tmp/out.pdf", size: 1536, sha256: "abc" }] }),
    )
    assert.match(single, /\[产物\] \/tmp\/out\.pdf（1\.5 kB）/, single)
    assert.ok(!single.includes("sha256"), "哈希对模型没有用")

    const many = Array.from({ length: 10 }, (_, index) => ({
        path: `/tmp/${index}.txt`,
        size: 1,
        sha256: "x",
    }))
    assert.match(renderExec(execData({ artifacts: many })), /另有 2 个未列出/)
})

test("renderExec：失败只留错误信息，不套 JSON", () => {
    assert.equal(renderExec({ error: "命令不能为空" }), "工具失败：命令不能为空")
})

test("renderExec：background 调用返回启动回执", () => {
    const rendered = renderExec({ taskId: "abc", sandboxId: "abc" })
    assert.match(rendered, /后台任务：abc/, rendered)
    assert.match(rendered, /query_task/, rendered)
})

test("renderTask：运行中给已捕获输出，结束后按执行结果渲染", () => {
    const running = renderTask({
        taskId: "abc",
        sandboxId: "abc",
        status: "running",
        stdout: "progress 1\n",
        stderr: "",
        result: null,
        error: null,
        startedAt: 1,
    })
    assert.equal(running, "[任务] abc 运行中\nprogress 1")

    const done = renderTask({
        taskId: "abc",
        sandboxId: "abc",
        status: "completed",
        stdout: "",
        stderr: "",
        result: execData({ exitCode: 2, stdout: "boom", stderr: "" }),
        error: null,
        startedAt: 1,
    })
    assert.equal(done, "[任务] abc 已完成\nboom\n[退出码：2]")
})

test("renderStop：区分停到了和没停到", () => {
    assert.equal(
        renderStop({ stopped: true, type: "ctrl_c", taskId: "abc" }),
        "已向 abc 发送 SIGINT",
    )
    assert.match(renderStop({ stopped: false, type: "kill", taskId: "abc" }), /不存在或已结束/)
})

test("renderSearch：标题、链接、摘要；丢掉正文与排序权重", () => {
    const rendered = renderSearch({
        results: [
            {
                title: "Hello  World",
                url: "https://example.com/a",
                snippet: "第一行\n第二行",
                summary: "摘要",
                content: "整页正文，模型不需要",
                siteName: "Example",
                date: "2026-01-01",
                authority: 7,
            },
        ],
    })
    assert.equal(rendered, "1. Hello World\n   https://example.com/a\n   第一行 第二行")
    assert.ok(!rendered.includes("整页正文"), "搜索结果正文不该进上下文")
    assert.ok(!rendered.includes("authority"))
})

test("renderSearch：空结果与失败", () => {
    assert.equal(renderSearch({ results: [] }), "（没有搜索结果）")
    assert.equal(renderSearch({ error: "web.missing-api-key" }), "工具失败：web.missing-api-key")
})

test("renderFetch：标题作一级标题，正文换行原样保留", () => {
    assert.equal(
        renderFetch({ title: " 示例站 ", content: "第一段\n\n第二段\n" }),
        "# 示例站\n\n第一段\n\n第二段",
    )
    assert.equal(renderFetch({ title: "", content: "" }), "（页面没有正文）")
})
