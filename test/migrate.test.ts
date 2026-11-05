import assert from "node:assert/strict"
import { test } from "node:test"

import type { MigrateInput, MigrateResult } from "../migrate.ts"
import {
    CURRENT_PLUGIN_ID,
    LEGACY_PLUGIN_ID,
    parseMigrateArgs,
    runCoreMigrate,
    type MigrateOutput,
} from "../migrate.ts"

interface Recorder {
    readonly lines: string[]
    readonly output: MigrateOutput
}

function recorder(): Recorder {
    const lines: string[] = []
    return {
        lines,
        output: {
            info: (text) => lines.push(`info:${text}`),
            warn: (text) => lines.push(`warn:${text}`),
            error: (text) => lines.push(`error:${text}`),
            print: (text) => lines.push(`print:${text ?? ""}`),
        },
    }
}

function fakeMigrate(result: MigrateResult, seen: MigrateInput[] = []) {
    return {
        async movePluginData(input: MigrateInput): Promise<MigrateResult> {
            seen.push(input)
            return result
        },
    }
}

const okResult: MigrateResult = {
    ok: true,
    from: LEGACY_PLUGIN_ID,
    to: CURRENT_PLUGIN_ID,
    steps: ["迁移插件数据：a → b"],
    skipped: ["旧插件目录保留"],
}

test("迁移命令：默认把旧 id 迁到新 id，不带可选开关", async () => {
    const seen: MigrateInput[] = []
    const { lines, output } = recorder()
    const code = await runCoreMigrate({
        migrate: fakeMigrate(okResult, seen),
        argv: [],
        json: false,
        output,
    })

    assert.equal(code, 0)
    assert.deepEqual(seen, [{ from: LEGACY_PLUGIN_ID, to: CURRENT_PLUGIN_ID }])
    assert.ok(lines.some((line) => line.includes("迁移插件数据")))
    /* 跳过项要走 warn，别混进成功步骤里 */
    assert.ok(lines.some((line) => line.startsWith("warn:") && line.includes("旧插件目录保留")))
    assert.ok(lines.some((line) => line.includes("重启 Wellspring 后生效")))
})

test("迁移命令：--remove-old / --force 透传给宿主", async () => {
    const seen: MigrateInput[] = []
    const { output } = recorder()
    const code = await runCoreMigrate({
        migrate: fakeMigrate(okResult, seen),
        argv: ["--remove-old", "--force"],
        json: false,
        output,
    })

    assert.equal(code, 0)
    assert.deepEqual(seen, [{ from: LEGACY_PLUGIN_ID, to: CURRENT_PLUGIN_ID, removeOld: true, force: true }])
})

test("迁移命令：--json 只输出 JSON", async () => {
    const { lines, output } = recorder()
    const code = await runCoreMigrate({
        migrate: fakeMigrate(okResult),
        argv: ["--json"],
        json: true,
        output,
    })

    assert.equal(code, 0)
    assert.equal(lines.length, 1)
    assert.ok(lines[0]?.startsWith("print:"))
    const parsed = JSON.parse(String(lines[0]?.slice("print:".length))) as MigrateResult
    assert.equal(parsed.ok, true)
    assert.equal(parsed.to, CURRENT_PLUGIN_ID)
})

test("迁移命令：宿主失败时返回 1 并说明原因", async () => {
    const { lines, output } = recorder()
    const code = await runCoreMigrate({
        migrate: fakeMigrate({
            ok: false,
            from: LEGACY_PLUGIN_ID,
            to: CURRENT_PLUGIN_ID,
            steps: ["迁移插件数据：a → b"],
            skipped: [],
            error: "新 id 的数据目录已经存在",
        }),
        argv: [],
        json: false,
        output,
    })

    assert.equal(code, 1)
    assert.ok(lines.some((line) => line.startsWith("error:") && line.includes("已经存在")))
    assert.ok(lines.some((line) => line.includes("已完成的部分保持原样")))
})

test("迁移命令：没有 migrate 能力时给出升级提示", async () => {
    const { lines, output } = recorder()
    const code = await runCoreMigrate({ migrate: undefined, argv: [], json: false, output })
    assert.equal(code, 1)
    assert.ok(lines.some((line) => line.includes("hostApi: migrate")))
})

test("迁移命令：参数解析与拼错参数", () => {
    assert.deepEqual(parseMigrateArgs([]), {})
    assert.deepEqual(parseMigrateArgs(["--remove-old"]), { removeOld: true })
    assert.deepEqual(parseMigrateArgs(["--force", "--json"]), { force: true })
    assert.throws(() => parseMigrateArgs(["--unknown"]), /不认识的参数/)
})
