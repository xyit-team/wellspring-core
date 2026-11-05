/*
 * `wellspring core-migrate`：把无 scope 的旧插件（wellspring-core）的数据搬到
 * @xyit/wellspring-core。
 *
 * 为什么需要：插件 id 决定数据目录（<dataDir>/plugin-data/<id>），id 从
 * wellspring-core 变成 @xyit/wellspring-core 之后，回收站、技能与插件配置都在旧目录里，
 * 不搬过去用户就会以为「技能/回收站丢了」。
 *
 * 搬文件由宿主做（hostApi: migrate）：插件自己的 sandbox 只放开了 pluginDir、
 * pluginDataDir 与 workspace，看不到兄弟 data 目录、configDir 与 plugins-state.json。
 */

import type { PluginApi } from "wellspring/api/host/index.ts"

/**
 * 迁移能力的结构化类型
 *
 * 宿主 1.6.0 才在 api/host 里导出 HostMigrateApi；插件要能对着更早的宿主类型通过
 * tsc，所以本地描述一遍（形状与宿主一致），运行时再探测宿主是否提供。
 */
export interface MigrateInput {
    readonly from: string
    readonly to: string
    readonly removeOld?: boolean
    readonly force?: boolean
}

export interface MigrateResult {
    readonly ok: boolean
    readonly from: string
    readonly to: string
    readonly steps: readonly string[]
    readonly skipped: readonly string[]
    readonly error?: string
}

export interface MigrateApi {
    movePluginData(input: MigrateInput): Promise<MigrateResult>
}

/** 旧版（无 scope）的插件 id */
export const LEGACY_PLUGIN_ID = "wellspring-core"
/** 新仓库发布后的插件 id，与 package.json 的 name 一致 */
export const CURRENT_PLUGIN_ID = "@xyit/wellspring-core"

export interface CoreMigrateOptions {
    /** 连旧插件目录一起删掉 */
    readonly removeOld?: boolean
    /** 新 id 已经有数据时覆盖 */
    readonly force?: boolean
}

/** 从 `wellspring core-migrate` 的参数里解析选项；不认识的参数抛错 */
export function parseMigrateArgs(argv: readonly string[]): CoreMigrateOptions {
    let options: CoreMigrateOptions = {}
    const unknown: string[] = []
    for (const arg of argv) {
        if (arg === "--remove-old") {
            options = { ...options, removeOld: true }
            continue
        }
        if (arg === "--force") {
            options = { ...options, force: true }
            continue
        }
        if (arg === "--json") {
            continue
        }
        unknown.push(arg)
    }
    if (unknown.length > 0) {
        throw new Error(`不认识的参数：${unknown.join(" ")}`)
    }
    return options
}

/** 命令输出接口，只用到这三个方法（便于测试注入） */
export interface MigrateOutput {
    info(text: string): void
    warn(text: string): void
    error(text: string): void
    print(text?: string): void
}

/**
 * 执行迁移并打印结果；返回进程退出码
 *
 * 与 CLI 的其它命令一致：失败返回 1，成功返回 0。
 */
export async function runCoreMigrate(
    options: {
        readonly migrate: MigrateApi | undefined
        readonly argv: readonly string[]
        readonly json: boolean
        readonly output: MigrateOutput
    },
): Promise<number> {
    const { migrate, argv, json, output } = options
    let parsed: CoreMigrateOptions
    try {
        parsed = parseMigrateArgs(argv)
    } catch (error) {
        output.error(error instanceof Error ? error.message : String(error))
        return 1
    }

    if (migrate === undefined) {
        output.error(
            "宿主没有 migrate 能力：升级 Wellspring（需要支持 hostApi: migrate 的版本）后再试",
        )
        return 1
    }

    const result: MigrateResult = await migrate.movePluginData({
        from: LEGACY_PLUGIN_ID,
        to: CURRENT_PLUGIN_ID,
        ...(parsed.removeOld === true ? { removeOld: true } : {}),
        ...(parsed.force === true ? { force: true } : {}),
    })

    /* 全局 --json 由宿主传进来；写在命令后面的 --json 会落到 argv 里，这里一起认 */
    const wantJson = json || argv.includes("--json")
    if (wantJson) {
        output.print(JSON.stringify(result, null, 4))
        return result.ok ? 0 : 1
    }

    output.info(`迁移 ${LEGACY_PLUGIN_ID} → ${CURRENT_PLUGIN_ID}`)
    for (const step of result.steps) {
        output.info(`  ✓ ${step}`)
    }
    for (const skipped of result.skipped) {
        output.warn(`  - ${skipped}`)
    }
    if (!result.ok) {
        output.error(`迁移失败：${result.error ?? "未知错误"}`)
        if (result.steps.length > 0) {
            output.warn("已完成的部分保持原样，修掉上面的问题后可以重跑（已迁走的数据不会再动）")
        }
        return 1
    }
    if (result.steps.length > 0) {
        output.info("迁移完成；重启 Wellspring 后生效（wellspring stop && wellspring start）")
    } else {
        output.info("没有需要迁移的数据（旧 id 的目录本来就不存在）")
    }
    return 0
}

/** 运行时探测宿主是否提供 migrate 能力 */
export function readMigrateApi(api: PluginApi): MigrateApi | undefined {
    const candidate = (api as PluginApi & { migrate?: MigrateApi }).migrate
    return typeof candidate?.movePluginData === "function" ? candidate : undefined
}

/** 注册给宿主的命令描述 */
export function createMigrateCommand(api: PluginApi) {
    return {
        name: "core-migrate",
        summary: "把旧版 wellspring-core（无 scope）的数据迁到 @xyit/wellspring-core",
        usage: "wellspring core-migrate [--remove-old] [--force] [--json]",
        async run(context: {
            readonly argv: readonly string[]
            readonly json: boolean
            readonly output: MigrateOutput
        }): Promise<number> {
            return await runCoreMigrate({
                migrate: readMigrateApi(api),
                argv: context.argv,
                json: context.json,
                output: context.output,
            })
        },
    }
}
