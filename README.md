# @xyit/wellspring-core

Wellspring 官方核心插件：`read` / `delete_file` / `execute_code` / `web_search` / `web_fetch` /
`query_task` / `stop_task` 等 Agent 基础工具，外加 SKILL 管理与会话环境注入。

从主仓库独立出来后，插件按自己的节奏发版：npm 上是 `@xyit/wellspring-core@x.y.z`，
GitHub Release 里附可直接安装的 `wellspring-core-x.y.z.zip`。

## 安装与升级

```bash
# 从源码目录（开发时）
wellspring plugin link ./wellspring-core

# 从 GitHub Release 的 zip 安装 / 升级
wellspring plugin install ./wellspring-core-1.0.0.zip
wellspring plugin update ./wellspring-core-1.0.0.zip

# 也可以用 npm 打出来的 tgz（`npm pack` 的产物）
wellspring plugin install ./xyit-wellspring-core-1.0.0.tgz

# 看有没有新版本（插件自带版本探针，查 npm registry）
wellspring plugin list --check
```

插件 id 是 `@xyit/wellspring-core`（带 scope），目录按 npm 惯例嵌套：

```text
<dataDir>/plugins/@xyit/wellspring-core/
<dataDir>/plugin-data/@xyit/wellspring-core/
<configDir>/plugins/@xyit/wellspring-core.json
```

## 从旧版升级：`wellspring core-migrate`

插件 id 从 `wellspring-core` 变成 `@xyit/wellspring-core`，数据目录也跟着变。
新插件注册了一个命令，把旧 id 的数据一次搬过来（回收站、技能、插件配置），
并清掉旧 id 的禁用标记（新 id 保持启用）：

```bash
# 先装新版，再迁移
wellspring plugin install ./wellspring-core-1.0.0.zip
wellspring core-migrate

# 顺带删掉旧插件目录（旧 id 已经不再需要）
wellspring core-migrate --remove-old
# 新 id 已经有数据、确认要覆盖时
wellspring core-migrate --force
# 脚本里用：只输出 JSON
wellspring core-migrate --json
```

- 幂等：再跑一次只会提示「旧数据不存在」，不会重复搬或覆盖新数据
- 默认不动旧插件目录，只打印后续命令；`--remove-old` 才会删（删不掉时提示先 `wellspring stop`）
- 新 id 的数据目录里已经有真实内容时默认拒绝，避免把两边的技能/回收站搅在一起
- 迁移完成后重启生效：`wellspring stop && wellspring start`；旧插件目录留着的话用
  `wellspring plugin remove wellspring-core` 删掉

命令需要宿主支持 `hostApi: migrate`（wellspring ≥ 1.6.0）；更早的宿主会提示升级，
也可以手动把 `plugin-data/wellspring-core/` 改名成 `plugin-data/@xyit/wellspring-core/`。

## 自动检查更新

`init` 里注册了版本探针（`update.ts`）：查 `registry.npmjs.org` 的 `latest`，返回最新版本与
对应 GitHub Release 的 zip 地址，宿主在 `wellspring plugin list --check` 时调用。

探针要访问网络，所以清单里声明了 `sandbox.network: true`——sandbox 默认断网
（bwrap 不 `--share-net`、seatbelt 拒绝出网），不声明的话探针必然失败。
Windows / Node permission 后端本来就不隔离网络，这个字段只是声明意图。

网络不可达、registry 报错都只记为这一项的失败，不影响插件加载与其它插件。

## 开发

```bash
npm install          # 装宿主包（只用来对类型与跑集成测试）与 typescript
npm run typecheck    # tsc --noEmit
npm test             # node --test
npm run build:zip    # 产出 release/wellspring-core-<version>.zip
```

测试分两类：

- `test/render.test.ts` / `retention.test.ts` / `session-prompt.test.ts`：纯函数，进 typecheck
- `test/plugin.test.ts` / `test/tools.test.ts`：起真实宿主 loader 加载本插件跑工具。宿主的内部模块
  没法用包名引（`exports` 只放了 `.` 与 `./api/host`），Node 又不允许剥离 `node_modules` 下的 `.ts`，
  所以 `pretest` 会把宿主包的 `src/` 复制到 `.host/`，测试按 `../.host/src/**` 引；
  这两份**只跑运行时、不进 typecheck**

需要 `/bin/sh` 与 POSIX 信号的用例在 Windows 上自动跳过（`POSIX_ONLY`），CI 是 Linux，跑全量。

## 发布

```bash
# 1) 改 package.json 的 version，提交
# 2) 打同名 tag 并推送，CI 会 typecheck + 测试 + npm publish + 建 Release
git tag -a v1.0.0 -m "v1.0.0"
git push origin master refs/tags/v1.0.0
```

CI 里 tag 必须与 `package.json` 的 version 一致（`v1.0.0` ↔ `1.0.0`），
否则直接失败，避免发出与 tag 不符的包。npm 发布需要仓库 secret `NPM_TOKEN`。

Agent 基础工具：`read`、`delete_file`、`execute_code`、`web_search`、`web_fetch`、`query_task`、`stop_task`，以及 SKILL 管理。

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
<dataDir>/plugin-data/@xyit/wellspring-core/trash/
  20261025-102530-1a2b3c/
    meta.json                 # at / path / type / files / bytes
    files/.tmp/old.txt        # 原文件按原相对路径存放
```

- 文件与目录都先复制进回收站，写入 `meta.json` 成功后才会删除工作区里的原条目
- 删除失败（包括 read-only 拒绝）会清掉这次复制，工作区内容与回收站都保持原样
- 回收站最多保留最近 200 次删除，超出后从最旧的条目开始清理
- 恢复：把 `files/` 下的条目移回工作区原路径；`meta.json` 里有原始路径与时间

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

技能保存在插件数据目录：`<dataDir>/plugin-data/@xyit/wellspring-core/skills/<name>/`。

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

`read` / `skill_*` / `delete_file` 返回人读文本（`data.content`），行为不变

## 结果上限：源头有界

`retention.ts` 定义每个工具的上下文预算（`LIMITS`），与 sandbox 的
`outputLimitBytes`（进程产出上限）互相独立

| 工具 | 上限 | 留哪一段 | 模型怎么拿到更多 |
| --- | --- | --- | --- |
| `read` | 2000 行 / 单行 2000 字符 / 单页 51200 字节 | 从 `offset` 起的头部窗口 | `offset` 翻页（footer 直接给下一页） |
| `execute_code` | stdout 8000 字符、stderr 4000 字符 | 尾部（截断点对齐到整行） | 重定向到文件后再 `read` |
| `web_fetch` | 首 80000 + 末 20000 字符 | 首尾，中间折成 `[...]` | 换更具体的页面 |
| `web_search` | 10 条、单条摘要 300 字符 | 头部 | 换更具体的查询 |

三条规则：

- **保留区间由工具决定**：命令输出与日志取尾部，网页正文取首尾，搜索清单取头部
  机制层（`retainHead` / `retainTail` / `retainHeadTail`）不含语义判断
- **截断必须说明**：每处上限在文本中留一行说明并给出省略量
  模型无法区分「文件末尾」与「到达上限」时会重复重试或误判任务完成
- **恢复动作由工具提供**：`read` 给出下一页 `offset`，`execute_code` 要求重定向到文件

切口永不劈开 UTF-16 代理对；`retainTailLines` 还会把开头那段被裁开的半行丢掉，
否则 `progress 1428` 会变成难读的 `8`。

## 网络工具

`web_search` / `web_fetch` 调 `openai.baseUrl`（DeepSeek）的 `/v1/tools/search`、`/v1/tools/fetch`。
会话 system prompt 要求：网页搜索优先用 `execute_code` 跑 `curl`；确实要用供应商联网搜索时先用 `ask` 征得用户同意。
Key 用默认供应商：`OPENAI_API_KEY` 优先，其次 `<configDir>/credentials.json`（网页「供应商」里可保存）。
缺 Key 时工具直接返回 `web.missing-api-key` 错误，不会静默返回空结果。
