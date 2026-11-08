# @xyit-team/wellspring-core

Wellspring 官方核心插件：`read` / `write` / `edit` / `apply_patch` / `delete_file` /
`grep` / `glob` / `list_dir` / `trash_list` / `trash_restore` / `execute_code` / `run_output` /
`web_search` / `web_fetch` / `query_task` / `stop_task` 等 Agent 基础工具，外加 SKILL 管理与会话环境注入。

插件独立发版：npm 上是 `@xyit-team/wellspring-core@x.y.z`，GitHub Release 里附
可直接安装的 `wellspring-core-x.y.z.zip`。

## 安装与升级

```bash
# 从 npm 安装 / 升级（宿主 1.7 起支持来源写法）
wellspring plugin install npm:@xyit-team/wellspring-core
wellspring plugin update wellspring-core            # 默认走配置里的渠道

# 从 GitHub Release 安装（找不到 Release 时宿主会回落源码 tarball）
wellspring plugin install github:xyit-team/wellspring-core

# 本地开发
wellspring plugin link ./wellspring-core

# 看有没有新版本（宿主按清单声明的来源查询）
wellspring plugin list --check
```

本地名是 `wellspring-core`（清单里的 `wellspring.name`），所以目录是单层的，与 npm scope 无关：

```text
<dataDir>/plugins/wellspring-core/
<dataDir>/plugin-data/wellspring-core/
<configDir>/plugins/wellspring-core.json
```

从旧的、内置在宿主仓库里的版本升上来时目录完全一致，回收站与技能不用搬。

## 更新来源

清单里声明了两个来源，宿主据此查最新版本（插件自己不再注册探针、也不需要联网权限）：

```json
"wellspring": {
    "apiVersion": 1,
    "name": "wellspring-core",
    "npm": "@xyit-team/wellspring-core",
    "github": "xyit-team/wellspring-core"
}
```

- `wellspring plugin list --check`：npm 有新版就报「可更新（npm）：1.2.0 → 1.3.0」
- `wellspring plugin update wellspring-core`：按配置 `plugins.update.type` 选择渠道（默认 npm）
- GitHub 渠道优先取 Release 的 zip 资产，没有资产时回落 `codeload` 源码 tarball
- 更新前先 `wellspring stop`：宿主在服务运行中会拒绝更新

## 开发

```bash
npm install          # 装宿主包（只用来对类型与跑集成测试）与 typescript
npm run typecheck    # tsc --noEmit
npm test             # node --test
npm run build:zip    # 产出 release/wellspring-core-<version>.zip
```

测试分两类：

- `test/render.test.ts` / `retention.test.ts` / `session-prompt.test.ts`：纯函数，进 typecheck
- `test/plugin.test.ts` / `tools.test.ts` / `fs-tools.test.ts` / `search-tools.test.ts` / `patch-tools.test.ts` /
  `dir-tools.test.ts` / `trash-tools.test.ts` / `run-tools.test.ts`：起真实宿主 loader
  加载本插件跑工具。宿主的内部模块没法用包名引（`exports` 只放了 `.` 与 `./api/host`），
  Node 又不允许剥离 `node_modules` 下的 `.ts`，所以 `pretest` 会把宿主包的 `src/` 复制到 `.host/`，
  测试按 `../.host/src/**` 引；这两份**只跑运行时、不进 typecheck**

需要 `/bin/sh` 与 POSIX 信号的用例在 Windows 上自动跳过（`POSIX_ONLY`），CI 是 Linux，跑全量。

## 发布

```bash
# 1) 改 package.json 的 version，提交
# 2) 打同名 tag 并推送
git tag -a v1.3.0 -m "v1.3.0"
git push origin master refs/tags/v1.3.0
```

推 `v*` 标签会触发两条独立的工作流：

- **`release.yml`**：typecheck + 测试 + 打 `wellspring-core-<version>.zip` + 生成 `SHA256SUMS`，
  挂到同名 GitHub Release。**不需要 npm**，只依赖 `GITHUB_TOKEN`；失败了可以在 Actions 页面
  用 `Run workflow` 填同一个 tag 重跑。
- **`publish-npm.yml`**：发 `@xyit-team/wellspring-core@x.y.z` 到 npm。认证走 npm Trusted Publishing
  （OIDC），仓库里不存 `NPM_TOKEN`；已发布过的版本自动跳过，失败了同样可以 `Run workflow` 重跑。

两条工作流都会核对 tag 与 `package.json` 的 version（`v1.3.0` ↔ `1.3.0`），
对不上直接失败，避免发出与 tag 不符的包。

### npm 首次发布与 Trusted Publishing

trusted publisher 只能配在已经存在的包上，所以 `@xyit-team/wellspring-core` 第一次上架要手动发一次：

```bash
npm login              # 用对 @xyit-team 有发布权限的账号
npm publish --access public   # 在仓库根目录，发 package.json 里的版本
```

发完到 npmjs.com 的包页面 → Settings → Trusted publishing，配 GitHub Actions：

- 仓库：`xyit-team/wellspring-core`
- 工作流：`publish-npm.yml`
- 权限：publish

等价命令行（npm >= 11.15.0）：

```bash
npm trust github @xyit-team/wellspring-core \
  --repo xyit-team/wellspring-core \
  --file publish-npm.yml \
  --allow-publish -y
```

配好后推 tag 就由工作流发布，带 provenance 证明，不需要在 GitHub 里存 token。

没有 npm 时的安装方式：从 Release 下 zip 后 `wellspring plugin install ./wellspring-core-1.3.0.zip`，
或直接 `wellspring plugin install github:xyit-team/wellspring-core`（宿主会取 Release 的 zip 资产）。

Agent 基础工具：`read`、`write`、`edit`、`apply_patch`、`delete_file`、`grep`、`glob`、`list_dir`、
`trash_list`、`trash_restore`、`execute_code`、`run_output`、`web_search`、`web_fetch`、`query_task`、`stop_task`，
以及 SKILL 管理。

## 会话环境注入

新会话第一轮通过 `onSessionStart` 往 system prompt 注入一次运行环境与工具清单：

- 操作系统 / 架构 / 内核版本、Node.js 版本；
- 工作目录、当前时间（宿主时区）、会话模式、模型、沙箱权限；
- 本轮可用的工具（名称 + 一行描述，含平台内置 `ask`）。

只在第一轮注入一次；后续轮次需要追加系统提示时用 `onMessage` 的 before 阶段。

## delete_file

把 workspace 内文件或目录**移入回收站**，不直接永久删除：`path` 按会话工作区解析（相对路径或工作区内绝对路径），
目录要 `recursive: true`。工作区根目录、越出工作区的路径会被拒绝；当前回合权限为 `read-only` 时宿主直接拒绝写工作区。
该工具需要插件声明 `${workspace}` 的 `fs.write` 权限（已包含在 `package.json`）。

回收站放在插件数据目录，保留原相对路径，便于原样移回：

```text
<dataDir>/plugin-data/wellspring-core/trash/
  20261025-102530-1a2b3c/
    meta.json                 # at / path / type / files / bytes
    files/.tmp/old.txt        # 原文件按原相对路径存放
```

- 文件与目录都先复制进回收站，写入 `meta.json` 成功后才会删除工作区里的原条目
- 删除失败（包括 read-only 拒绝）会清掉这次复制，工作区内容与回收站都保持原样
- 回收站最多保留最近 200 次删除，超出后从最旧的条目开始清理
- 恢复：把 `files/` 下的条目移回工作区原路径；`meta.json` 里有原始路径与时间

## write / edit

- `write`：整篇覆盖写入 UTF-8 文本，父目录自动创建；目录与特殊文件拒绝；返回行数与字节数
- `edit`：按字面量替换一段，`old_string` 默认要求唯一命中——多处命中报出首个行号，要求补上下文或传 `replace_all: true`
- `new_string` 可以为空（即删除）；文件是 CRLF 换行而 `old_string` 用 LF 写时，单独提示换行对不上
- `write` 覆盖已有文件前要求本进程先 `read`；读后文件被改动需重读，新建文件不受限
- 两者都受会话沙箱权限约束：`read-only` 回合宿主直接拒绝写工作区

## apply_patch

按统一 diff 一次改多个文件：`---` / `+++` 文件头 + `@@` hunk，支持多文件与新建文件（`---` 为 `/dev/null`）；
删除文件不支持，用 `delete_file`。

- hunk 定位容忍行号漂移；上下文对不上时报文件与 hunk 头，整个补丁不落盘（先全部校验，再依次写入）
- 换行沿用原文件（CRLF 文件仍是 CRLF）；新建文件用 LF
- 上限：20 个文件、256 KB 补丁、单文件 200 hunk

## 回收站

`delete_file` 把条目移入 `<dataDir>/plugin-data/wellspring-core/trash/<id>/`，删除结果里带 `trashId`：

- `trash_list`：按时间从新到旧列出 id、原路径、类型、文件数、大小与删除时间
- `trash_restore`：按 id 恢复到原路径；目标已存在时拒绝

## grep / glob

- `grep`：正则搜索工作区文本，按文件分组返回行号与命中行；`path` 可以是目录或单个文件，`include` 按 glob 过滤路径，
  `ignore_case` 忽略大小写；默认跳过 `node_modules` / `.git` / `.svn` / `.hg` 与二进制文件
- `glob`：按模式匹配文件路径，支持 `*`、`?`、`**`、`{a,b}`；pattern 不含 `/` 时按文件名匹配任意深度，
  含 `/` 时按相对工作区根的整条路径匹配；结果按修改时间从新到旧
- 两者默认读工作区的 `.gitignore`（含嵌套；`path` 指向子目录时祖先规则仍生效），`include_ignored: true` 可绕过；
  内置忽略目录始终跳过。解析支持注释、`!` 取反、结尾 `/` 只匹配目录，不支持字符类与完整转义语义
- `grep` 支持 `context`（0-5 行上下文，命中行 `:`、上下文行 `-`、段间 `--`）、`max_results`（1-250）
  与 `paths`（多个搜索起点，文件去重），上下文行同样受单行 300 字符限制
- `list_dir`：缩进树列出目录内容，`depth` 1-8（默认 2）、`include_ignored` 可绕过 .gitignore，
  条目上限 500
- 两者共用一套目录遍历上限：深度 16、目录 4000、文件 20000，触顶会在结果末尾说明

## SKILL

遵循通用 SKILL 规范：每个技能是一个目录，内含 `SKILL.md`（YAML frontmatter + Markdown 正文），可以带脚本、模板等资源文件：

```markdown
---
name: demo-skill
description: 演示技能，说明它能做什么
whenToUse: 当用户需要演示时
license: MIT
allowed-tools: read, execute_code
metadata:
    owner: me
---

# 步骤

1. 先读文件
2. 再执行命令
```

- `name`：必填，小写字母/数字/连字符，≤64
- `description`：必填，≤1024 字符
- `whenToUse`、`license`、`allowed-tools`、`metadata`：可选
- `disable-model-invocation: true` / `user-invocable: false`：保留通用规范里的调用控制字段
- 其余 frontmatter 字段原样保留

技能保存在插件数据目录：`<dataDir>/plugin-data/wellspring-core/skills/<name>/`。

### 工具

| 工具            | 说明                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| `skill_list`    | 列出已安装技能、描述、触发时机与资源文件；无效目录会出现在 `invalid`                                   |
| `skill_read`    | 读取技能正文；`file` 可读取技能目录内的资源文件                                                        |
| `skill_install` | 用 `content` 安装 SKILL.md 全文，或用 `path` 从工作区目录/`.md` 文件安装（含资源复制）                 |
| `skill_modify`  | 整篇替换 SKILL.md，或只改 `description` / `whenToUse` / 正文；标量字段传裸文本，多包一层引号会自动去掉 |

安装时校验 frontmatter、限制单文件与总资源大小、阻止资源路径越界；已存在默认拒绝，传 `overwrite: true` 覆盖。

## 结果整形：模型只看渲染后的文本

工具的 `data` 是给界面、日志和测试用的结构化结果，逐字段进上下文只会占满窗口。
核心工具里 `execute_code` / `query_task` / `stop_task` / `web_search` / `web_fetch`
都通过 `render.ts` 交给宿主一段 `content`，模型只看这段文本，`data` 留在界面与日志里。

渲染形状照 `dsh-tool-bash` 的约定：

```text
<stdout>
[stderr]
<stderr>
[退出码：1]
[超时：进程已被终止]
[产物] /abs/report.pdf（1.5 kB）
```

- 正文是 stdout；stderr 单独成段；条件标记（截断 / 超时 / 信号 / 非 0 退出码 / OOM / 产物）每个占一行
- `sandboxId`、`backend`、`access`、`enforcementNotes`、`memoryLimitReason`、`artifactDir` 等元数据**不进上下文**
- 空输出写成 `（无输出）`，避免模型误判成工具没跑；非 0 退出码是供模型解读的结果，不是工具错误
- 失败只留 `工具失败：<error>`，无 JSON 包装
- `web_search` 只给标题、链接、摘要（丢掉 `content` 与 `authority`）；`web_fetch` 给标题 + 正文
- 模型侧文本进会话日志的 `tool/result.content`（回放用），结构化结果同事件的 `presentation` 字段（排查用）

`read` / `write` / `edit` / `apply_patch` / `skill_*` / `delete_file` / `trash_*` / `grep` / `glob` /
`list_dir` / `run_output` 返回人读文本（`data.content`），行为不变

## 结果上限：源头有界

`retention.ts` 定义每个工具的上下文预算（`LIMITS`），与 sandbox 的
`outputLimitBytes`（进程产出上限）互相独立

| 工具 | 上限 | 留哪一段 | 模型怎么拿到更多 |
| --- | --- | --- | --- |
| `read` | 2000 行 / 单行 2000 字符 / 单页 51200 字节 | 从 `offset` 起的头部窗口 | `offset` 翻页（footer 直接给下一页） |
| `execute_code` | stdout 8000 字符、stderr 4000 字符 | 尾部（截断点对齐到整行） | 重定向到文件后再 `read` |
| `web_fetch` | 首 80000 + 末 20000 字符 | 首尾，中间折成 `[...]` | 换更具体的页面 |
| `web_search` | 10 条、单条摘要 300 字符 | 头部 | 换更具体的查询 |
| `grep` | 250 行命中、单行 300 字符、5000 个文件、单文件 2 MB、结果行 1500（含上下文） | 头部（按遍历顺序） | 缩小 `pattern` / `path` / `include`，或调小 `context` / `max_results` |
| `glob` | 100 条路径 | 按 mtime 排序的头部 | 换更具体的 `pattern` 或 `path` |
| `list_dir` | 500 条、深度 8 | 深度优先的头部 | 缩小 `path` 或 `depth` |
| `apply_patch` | 20 文件、256 KB、单文件 200 hunk | 整单校验，失败不写 | 拆小补丁 |
| `execute_code` 落盘 | 单路 4 MB、保留 20 个 run | 前段 | `run_output` 按 offset 翻页 |

三条规则：

- **保留区间由工具决定**：命令输出与日志取尾部，网页正文取首尾，搜索清单取头部
  机制层（`retainHead` / `retainTail` / `retainHeadTail`）不含语义判断
- **截断必须说明**：每处上限在文本中留一行说明并给出省略量
  模型无法区分「文件末尾」与「到达上限」时会重复重试或误判任务完成
- **恢复动作由工具提供**：`read` 给出下一页 `offset`，`execute_code` 要求重定向到文件

切口永不劈开 UTF-16 代理对；`retainTailLines` 还会把开头那段被裁开的半行丢掉，
否则 `progress 1428` 会变成难读的 `8`。

## 输出落盘

`execute_code` / `query_task` 的单路输出超过上下文预算（stdout 8000 / stderr 4000 字符）时，完整文本写到
`<dataDir>/plugin-data/wellspring-core/runs/<id>/stdout.txt`（或 `stderr.txt`）：

- 模型侧文本的截断标记里给文件路径，`run_output file=runs/<id>/stdout.txt` 按行翻页读回
- 单路落盘上限 4 MB（超出保留前段并注明），保留最近 20 个 run
- 后台任务按 taskId 落盘一次，重复 `query_task` 复用已有文件

## 网络工具

`web_search` / `web_fetch` 调 `openai.baseUrl`（DeepSeek）的 `/v1/tools/search`、`/v1/tools/fetch`。
会话 system prompt 要求：网页搜索优先用 `execute_code` 跑 `curl`；确实要用供应商联网搜索时先用 `ask` 征得用户同意。
Key 用默认供应商：`OPENAI_API_KEY` 优先，其次 `<configDir>/credentials.json`（网页「供应商」里可保存）。
缺 Key 时工具直接返回 `web.missing-api-key` 错误，不会静默返回空结果。
