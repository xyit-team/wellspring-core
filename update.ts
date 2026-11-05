/*
 * 版本探针：查 npm registry 取最新版本，并给出对应的 GitHub Release zip。
 *
 * 宿主只在 `plugin list --check` / `plugins.checkUpdates()` 时调用，注册阶段不发请求。
 * 插件清单里声明了 `sandbox.network: true`——否则 sandbox 默认断网（bwrap 不 share-net、
 * seatbelt 拒绝出网），探针会以失败告终。
 *
 * 只认 GitHub Release 的 .zip：宿主的下载地址校验要求 http(s) 且以 .zip 结尾，
 * tarball 与 npm 包页会被记为探针错误。
 */

/** npm 包名，与 package.json 的 name 一致 */
const PACKAGE_NAME = "@xyit/wellspring-core"
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`
const RELEASE_BASE = "https://github.com/xyit-team/wellspring-core/releases/download"
/** 探针在宿主侧有 10s 上限，这里留出余量 */
const PROBE_TIMEOUT_MS = 8_000

export interface LatestRelease {
    readonly version: string
    readonly downloadUrl: string
}

/** GitHub Release 里的插件 zip 地址 */
export function releaseZipUrl(version: string): string {
    return `${RELEASE_BASE}/v${version}/wellspring-core-${version}.zip`
}

/** 版本探针：返回最新版本与下载地址 */
export async function fetchLatestRelease(): Promise<LatestRelease> {
    const response = await fetch(REGISTRY_URL, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!response.ok) {
        throw new Error(`npm registry 返回 ${response.status}`)
    }
    const payload = (await response.json()) as { version?: unknown }
    const version = typeof payload.version === "string" ? payload.version.trim() : ""
    if (version === "") {
        throw new Error("npm registry 没有返回 version")
    }
    return { version, downloadUrl: releaseZipUrl(version) }
}
