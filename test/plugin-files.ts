// 插件发布文件：从 package.json 的 files 派生

import { readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dirname, "..")
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    files?: unknown
}
const declared = Array.isArray(manifest.files)
    ? manifest.files.filter((item): item is string => typeof item === "string")
    : []

export const PLUGIN_FILES: readonly string[] = ["package.json", ...declared]
