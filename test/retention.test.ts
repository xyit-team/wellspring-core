import assert from "node:assert/strict"
import { test } from "node:test"

import {
    renderExec,
    renderFetch,
    renderReadWindow,
    renderSearch,
} from "../render.ts"
import {
    LIMITS,
    omittedNotice,
    retainHead,
    retainHeadTail,
    retainTail,
} from "../retention.ts"

test("retainHead / retainTail：预算内原样返回，超出就报省略量", () => {
    assert.deepEqual(retainHead("abc", 10), { text: "abc", omittedChars: 0 })
    assert.deepEqual(retainTail("abc", 10), { text: "abc", omittedChars: 0 })
    assert.deepEqual(retainHead("abcdef", 2), { text: "ab", omittedChars: 4 })
    assert.deepEqual(retainTail("abcdef", 2), { text: "ef", omittedChars: 4 })
})

test("retainHead / retainTail：切口不劈开代理对", () => {
    // emoji 占两个 UTF-16 码元
    const text = "ab😀cd"
    assert.equal(retainHead(text, 3).text, "ab", "切在代理对中间时往前挪一格")
    assert.equal(retainTail(text, 3).text, "cd", "从代理对中间起切时往后挪一格")
    assert.ok(!/\p{Surrogate}/u.test(retainHead(text, 3).text))
    assert.ok(!/\p{Surrogate}/u.test(retainTail(text, 3).text))
})

test("retainHeadTail：中间用 [...] 标记，两端都保留", () => {
    const text = `${"a".repeat(50)}${"m".repeat(100)}${"z".repeat(50)}`
    const kept = retainHeadTail(text, 10, 10)
    assert.equal(kept.omittedChars, 180)
    assert.ok(kept.text.startsWith("a".repeat(10)))
    assert.ok(kept.text.endsWith("z".repeat(10)))
    assert.ok(kept.text.includes("[...]"))
    assert.ok(!kept.text.includes("m"))
})

test("retainHeadTail：预算够就一个字都不动", () => {
    const kept = retainHeadTail("short", 10, 10)
    assert.equal(kept.omittedChars, 0)
    assert.equal(kept.text, "short")
})

test("omittedNotice：统一措辞，单位可换", () => {
    assert.equal(omittedNotice("首尾", 42), "省略 42 字符（本段保留首尾）")
    assert.equal(omittedNotice("尾部", 3, "行"), "省略 3 行（本段保留尾部）")
})

test("renderReadWindow：行号对齐 + 分页 footer", () => {
    const lines = Array.from({ length: 5 }, (_, index) => `line ${index}`)
    const page = renderReadWindow(lines, 0, 2)
    assert.equal(page.shown, 2)
    assert.match(page.content, /^1│ line 0\n2│ line 1/, page.content)
    assert.match(page.content, /\[lines 1-2 of 5\]/)
    assert.match(page.content, /\[继续读取：offset=3\]/)
})

test("renderReadWindow：读完末页就不再提示继续", () => {
    const page = renderReadWindow(["a", "b"], 0, 10)
    assert.equal(page.shown, 2)
    assert.match(page.content, /\[lines 1-2 of 2\]/)
    assert.ok(!page.content.includes("继续读取"), page.content)
})

test("renderReadWindow：字节预算先到就收尾，并说明原因", () => {
    // 每行约 4000 字节（中文 3 字节/字），20 行超过 51200 字节单页上限
    const lines = Array.from({ length: 20 }, () => "中".repeat(1333))
    const page = renderReadWindow(lines, 0, 20)
    assert.ok(page.shown < 20, `应在字节上限处收尾，实际 ${page.shown} 行`)
    assert.ok(page.shown > 0, "小预算也不该返回空页")
    assert.match(page.content, /本页在 \d+ 字节处收尾/)
    assert.match(page.content, new RegExp(`继续读取：offset=${page.shown + 1}`))
    const body = page.content.split("\n\n[lines")[0] ?? ""
    assert.ok(Buffer.byteLength(body, "utf8") <= LIMITS.readBytes + 4096)
})

test("renderReadWindow：超长行截断并如实计数", () => {
    const long = "x".repeat(LIMITS.readLineChars + 500)
    const page = renderReadWindow(["短行", long], 0, 10)
    assert.match(page.content, /…/)
    assert.match(page.content, /\[有 1 行超过 2000 字符，已截断\]/)
})

test("renderExec：超长 stdout 留尾部，且从整行开始", () => {
    const stdout = Array.from({ length: 2000 }, (_, index) => `progress ${index}`).join("\n")
    const rendered = renderExec({ exitCode: 0, stdout: `${stdout}\nDONE\n`, stderr: "" })
    // 尾部裁剪从整行开始
    assert.ok(/^progress \d+\n/.test(rendered), rendered.slice(0, 40))
    assert.ok(rendered.includes("DONE"), "尾部必须保住")
    assert.ok(!rendered.includes("progress 0\n"), "头部应被裁掉")
    assert.match(
        rendered,
        /\[stdout 截断：保留末尾 8000 字符，省略 \d+ 字符；全文：重定向到文件后 read\]/,
    )
    assert.ok(rendered.length < stdout.length + 200)
})

test("renderExec：短输出不加任何截断标记", () => {
    assert.equal(renderExec({ exitCode: 0, stdout: "ok\n", stderr: "" }), "ok")
})

test("renderFetch：长正文保留首尾", () => {
    const content = `${"头".repeat(90_000)}${"中".repeat(50_000)}${"尾".repeat(30_000)}`
    const rendered = renderFetch({ title: "T", content })
    assert.match(rendered, /^# T\n\n/)
    assert.ok(rendered.includes("头头"), "开头要留")
    assert.ok(rendered.includes("尾尾"), "结尾要留")
    assert.match(rendered, /\[正文截断：保留首 80000 与末 20000 字符，省略 \d+ 字符\]/)
    assert.ok(!rendered.includes("中中"), "中间应被省略")
})

test("renderFetch：短正文原样返回，不加标记", () => {
    assert.equal(renderFetch({ title: "", content: "正文" }), "正文")
})

test("renderSearch：条数与摘要都有上限", () => {
    const results = Array.from({ length: 15 }, (_, index) => ({
        title: `T${index}`,
        url: `https://e.com/${index}`,
        snippet: "摘".repeat(500),
        summary: "",
        content: "",
    }))
    const rendered = renderSearch({ results })
    assert.match(rendered, /^1\. T0/)
    assert.ok(!rendered.includes("11. T10"), "超过 10 条不列出")
    assert.match(rendered, /\[另有 5 条结果未列出/)
    const snippetLine = rendered.split("\n")[2] ?? ""
    assert.ok(snippetLine.length < 320, `摘要行过长：${snippetLine.length}`)
    assert.ok(snippetLine.endsWith("…"))
})
