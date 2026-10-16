# AGENTS.md

## 项目目标

本项目的目标是编写一个 deepseek harness 插件，使 AI 具备创造力。后续如果效果好的话，考虑上传到github。

目标详情请查看"E:\deepseekagent\dsh-creativity\项目目标.md"（原 `项目目标.txt` 已更名为 .md）。

本项目主要使用dsh web+deepseek运行，可以直接在dsh web中进行插件测试。本电脑也安装了dsh桌面端，不要为dsh桌面端安装插件，确保dsh桌面端能正常运行，因为如果dsh web因为插件测试bug而无法启动，我将会手动启用dsh桌面端对其进行修复。

**当前实现**：`@1603801678/dsh-serendipity`（缪斯）——跨领域「结构素材库」插件，已安装到 web profile。
设计动机见 `docs/项目计划.md`，使用说明见 `README.md`，进度见 `TODO.md`。

## 本文件定位与维护

- 本文件后续将由 AI 自动修改和补充。
- 可以自由调整本文件的格式和叙述顺序，但不得改变原有内容的含义。
- 本文件只记录最关键、最通用的内容。
- 过于细节的内容应新建子 AGENTS 文件记录；本文件只做标记，并放链接指引到对应子 AGENTS。
- 新增或修改内容时，优先保持本文件简洁、通用。

### 子 AGENTS 索引

- `lib/AGENTS.md` —— **实现细节**：模块划分、dsh 插件 API 的坑（值 schema 的 `required` 只能写在 property 上、
  工具输出必须是 lossless JSON、cordis 服务名要显式传、Renderer 只拿得到 output schema 里的字段）、
  语料维护规则、测试与验证方法。

## 项目结构

```
lib/             宿主半边（纯 ESM，无构建步骤）：index.js 插件入口（导出 Config：drawMode 三档等 5 个
                 volatile 字段；0.2.0 起设置项靠它，不再有 settings.register）、
                 corpus.js 语料加载与校验、draw.js 抽取引擎、structure-tags.mjs 结构标签受控词表、
                 effectiveness.js 按覆盖度算有界权重、store.js 状态持久化、
                 sessions.js 每次会话的抽取指标（首次抽取在第几轮第几步／抽了几条／多少落点）、
                 tools.js 六个工具（draw/note/learn/stats/decompose/fetch）+ 漏记提醒、routes.js 只读 HTTP 接口
lib/corpus/      115 条素材（六类，JSON；由 tools/build-corpus.mjs 生成，不要手改）
test/            62 个用例；integration.test.js 用真实 cordis + ToolRuntime + SystemPrompt 挂载插件，
                 lint.test.js 把语料体检纳入测试（含来源领域重复率的防退化断言）
tools/           build-corpus.mjs 生成语料（素材的**源头**在这里）、lint-corpus.mjs 语料体检、
                 preview.mjs 生成人工检查用的渲染预览、verify-note-path.mjs 对真实状态目录验证落盘链路、
                 cleanup-verify-records.mjs 清掉验证脚本写进真实状态的记录（默认 dry-run）、
                 set-config.mjs 改本插件在 profile 里的配置、check-settings-schema.mjs 体检 Config 声明、
                 audit-tool-output.mjs 六个工具的 lossless-JSON 审计（升级 dsh 后跑）、
                 session-report.mjs 把导出的会话转录摘成【会话指标】+ 工具调用、
                 headless-test.patch.yml 把插件挂到 headless profile 上跑**真实 agent 会话**测试
docs/            项目计划.md（设计动机）、待决策与设计方案.md（用户提出的需求与建议方案）、
                  手动测试清单.md（重启后照做的人工验证步骤）、preview-draw.md（渲染样例）
_sessionlog/     用户导出的真实测试会话（session.jsonl）——分析 agent 实际行为的证据，勿删；
                 headless-runs/ 是我用 headless profile 跑的真实 agent 会话转录（见其 README.md）
演示/            只在本机保存的演示产物（三件套 + 逐页渲染 + assets/muse 图片素材）——
                 **不进版本库**（.gitignore 已忽略），由 tools/build-muse-deck.mjs 重建
cordis.patch.yml profile bundle patch（让插件行进入 profile roster）
```

## 技术约定

- **运行时语言**：纯 ESM JavaScript（JSDoc 类型注释），**不引入构建步骤** —— 源码即产物，
  `link:` 安装后改完代码重启 dsh 即生效。这是刻意的取舍：构建链会显著增加本项目的维护成本。
- **peer 依赖**：`@deepseek-ai/dsh-tools`（`defineTool`）、`dsh-system-prompt`，可选 `dsh-host-webserver`。
  用 `link:` 安装到 profile 时 Node 从源码目录解析这些包，需要在本仓库建 `node_modules` junction
  （见 README「让插件能解析 dsh SDK」与 `lib/AGENTS.md`）。
- **绝不拖垮启动**：插件内任何读文件都容错降级；插件加载失败只影响自己那一行，不能让 dsh web 起不来
  （所以禁止在模块顶层做 I/O，也不要在 `apply` 里抛异常）。
- **工具返回值必须是 lossless JSON**：可选字段要**省略**，不能赋 `undefined`。
- **配置是声明式的**（dsh 0.2.0 起）：插件导出 `Config`（schemastery，可编辑字段标 `.volatile()`），
  配置落在 profile 的 `cordis.patch.yml` 里本插件条目（`id: serendipity`）的 `config:` 块；
  旧的 `~/.dsh/settings.yaml` 已被 0.2.0 废弃。改配置用设置页卡片或 `tools/set-config.mjs`。
  细节见 `lib/AGENTS.md` 坑 12。
- **素材是内容，代码是机制**：素材质量靠 `lint-corpus` 的硬规则守（结构标签必须归一到受控词表、
  `bridge` 必须是问句、不得复制粘贴），而不是靠人工记忆。

## ⚠️ 改文本文件只能用 read/write/edit 工具，绝不用 PowerShell

本机 PowerShell 的 `Get-Content`/`Set-Content`/`-replace` 默认按**系统代码页**而非 UTF-8 处理文本。
用它做一次「读—改—写」往返，会把文件里所有中文变成不可逆的乱码；
配套的 `-replace` 还会吃掉字符串结尾的引号，让文件直接语法错误。

实测代价：一次 `(Get-Content ... -Raw) -replace ... | Set-Content ...` 同时损坏了
`lib/structure-tags.mjs` 与 `tools/lint-corpus.mjs` 两个文件，需要用「UTF-8 当成 GBK 解码」的
反向变换才救回来。

- 改文件内容：一律用 `read` / `write` / `edit` 工具。
- PowerShell 只用来跑命令（`node`、`git`、`Get-ChildItem` 之类），不要用它做文本替换。
- 自查：`node -e "const s=require('fs').readFileSync('文件','utf8');console.log((s.match(/\uFFFD/g)||[]).length)"`
  返回 0 才算干净。

## 权限与操作边界

- 在磁盘空间足够的情况下，AI 可以自行安装需要的软件。
- AI 可以自由操作当前工作目录内的文件。
- 删除其它目录（当前工作目录之外）的文件前，必须经过同意，并谨慎操作。

## 测试与验证

```powershell
npm test                 # 62 个用例
npm run lint:corpus      # 语料体检（FAIL 必须清零）
npm run preview          # 生成 docs/preview-draw.md，人工检查素材启发性与渲染
node tools/audit-tool-output.mjs   # 六个工具 × 多种参数的 lossless-JSON 审计（升级 dsh 后必跑）
node tools/session-report.mjs <session.jsonl>   # 真实会话的【会话指标】：第几轮第几步首次抽取、多少落点
```

**升级 dsh 之后**：按 `lib/AGENTS.md`「升级 dsh 之后怎么体检」那一节走一遍——升级会改 API
（0.1.1 → 0.2.0 就删掉了 `settings.register`、改了 client 脚本的取件方式），离线测试全绿也不能说明没事。

**真实 agent 会话测试**（跑真实模型、会花额度）见 `lib/AGENTS.md`「真实 agent 会话测试」：
用 `tools/headless-test.patch.yml` 把插件挂到 headless profile 上，配合临时 `USERPROFILE`
隔离状态目录，就能验证「真实模型是否按提示词做」——单元测试覆盖不到这一层。

**本机限制**：PowerShell 禁止脚本执行，`dsh.ps1` / `pnpm.ps1` 都调不动，必须用
`node <dsh安装目录>\node_modules\@deepseek-ai\dsh\lib\bin.js ...` 或 `cmd /c`。
宿主插件**不走 HMR**：改完 `lib/**` 必须重启 `dsh web` 才生效。

## profile 维护与启动故障排查

**已修事故（2026-10-04）**：`dsh web` 一启动就退出，报
`plugin tree failed to load: ... duplicate loader entry id: ssh`。
原因是 web profile 的 `dsh.profile.bundles` 里同时列了聚合包 `@captain1275/dsh-web-ui-all`
和它已经包含的子包 `@captain1275/dsh-ssh`——两者各自的 `cordis.patch.yml` 都 insert `id: ssh`，
cordis loader 撞到重复 id 后是**整棵插件树加载失败**（不是只坏一行），进程直接退出。
修法：从 bundles 里删掉 `@captain1275/dsh-ssh`（`dependencies` 里的那条保留，它是聚合包的传递依赖），
改前备份为 `package.json.bak-before-ssh-dup-fix`。
web profile 的 bundles 现状：base、web-app、**web-ui-all**、本项目插件；ssh 由 web-ui-all 带入。

**通用规则**：

- 往 profile 的 `bundles` 加插件前，先确认没有别的 bundle（尤其是**聚合包**）已经插入同一个 id。
  排查方法：拿报错里的 id 去 `~/.dsh/profiles/<name>/node_modules/**/cordis.patch.yml` 里 grep，
  看是哪几个 bundle 都写了它。聚合包（如 `@captain1275/dsh-web-ui-all`）会替子包插入 id，
  子包就**不能**再单独进 bundles。
- 验证启动时不要占用桌面端的 19387：用后台任务在空闲端口起临时实例
  `node <dsh安装目录>\node_modules\@deepseek-ai\dsh\lib\bin.js web --port 19488 --no-open`，
  探完首页与插件路由（`/api/dsh-ssh/hosts`、`/api/dsh-serendipity/summary`）再关掉它。
- 桌面端跑的是 `desktop` profile（只有 base + web-app，不含本项目插件），**不要动它**，
  它是 dsh web 起不来时的手动修复通道。

## 其它

程序编写时难免会出现bug，在比较重要的地方可以增加测试，自行评估效果。可以选择性地保存一些低成本的中间结果
（`docs/preview-draw.md` 就是为此而设），方便我后续人工检查。

- 改 profile 前先备份 `~/.dsh/profiles/<name>/{package.json,cordis.patch.yml}`，
  备份文件名形如 `*.bak-before-<变更名>`。
