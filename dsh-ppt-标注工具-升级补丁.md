# dsh-ppt 本地补丁（两处）：放映器标注工具 + 正文内联强调

> **这不是本仓库的代码**，而是对已安装插件 `dsh-ppt@0.9.0` 的**本地修改**，共两处：
> 1. **放映器标注工具**：生成后的 HTML 演示文稿支持激光笔、画笔标注与缩放平移。
> 2. **正文内联强调**：`**加粗**` 与 `==标红==` 能渲染进正文（HTML 出 `<strong>`/`.hl`，PPTX 出 run 级 `b="1"`/强调色）。
>
> 两处都改在**同一个文件**里，所以一起记录、一起恢复。
> 升级 `dsh-ppt` 会**静默覆盖**这两处：新生成的 deck 会丢掉它们，而**已生成的 HTML 文件不受影响**。

## 状态

| 项 | 值 |
| --- | --- |
| 插件 | `dsh-ppt@0.9.0`（普通包安装，非 `link:`；本机**没有**它的源码 checkout） |
| 改的文件 | `%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-ppt\skills\dsh-ppt\scripts\deck-core.mjs` |
| 备份 | 同目录 `deck-core.mjs.bak-before-annotation-tools`（**原始 0.9.0 版本**） |
| 补丁版备份 | `_sessionlog/plugin-patches/deck-core.mjs.patched-annotation-tools` |
| 补丁版 sha256 | `8e7e42194abfb4b50340adb47a1a4f727007d51706976129c34895dfc1798da4`（150450 字节，含两处补丁） |
| 测试工具 | `_sessionlog/plugin-patches/anno-tools-test/`（见文末，5 个脚本） |
| 改动范围 | `renderHtml()` / `renderHtmlSlide()`（放映器与页面渲染）、`parseInlineMarkdown()` 解析、`normalizeSlide()` 的 run 存储、`paragraphXml()` 与表格/文本形状的 run 输出、`LANGUAGES` 三份 UI 文案 |
| 未改动 | PPTX 导出结构（仍是原生 OOXML）、质量检查规则、编辑/撤销、CLI、浏览器半边 |

> 插件安装是普通包（`"dsh-ppt": "^0.9.0"`），本机不存在它的源码仓库，所以只能提供**整份文件**恢复
> 而不是 diff——这是不得已，不是懒。`~/.dsh/plugins/dsh-ppt/` 只是数据目录（`projects.jsonl`），不是源码。

## 功能与操作

| 功能 | 操作 | 行为 |
| --- | --- | --- |
| 激光笔 | 按住 `X`、或按住工具栏「✦ 激光笔」 | 彩色光点 + 渐隐拖尾跟随鼠标；松开即淡出。**不落笔**，不改画布 |
| 画笔（红） | `D` 切换 | 左键落笔；标注**按页存**，翻走再翻回仍在 |
| 画笔（绿） | `Shift+D` | 同上，绿色；工具栏按钮点亮表示当前是绿笔 |
| 清空标注 | `C` 或「⌫ 清空标注」 | 清空**全部页面**标注，可从撤销栈恢复 |
| 缩放 | `Shift+滚轮`、`Z` 按钮、工具栏「⤢ 缩放」 | 1×–3× 连续缩放，锚定鼠标位置 |
| 平移 | 缩放后直接拖拽 / 中键拖拽 / `Shift+`拖拽 | — |
| 复位 | `Esc`，或双击画面 | 回到 1×；`Esc` 的优先级在「关闭备注/总览」之后 |

工具栏固定在**左下角**，与右下角原有 HUD 分开；进入总览、黑屏/白屏或打印时自动隐藏。
缩放时工具栏按 `1/zoom` 反向缩放，保持可读可点。

## 补丁二：正文内联强调

原插件把 `**粗体**`、`<span>` 这类内联标记**直接剥掉**，正文里做不出任何强调（加粗只出现在标题/表头）。
现在两种标记可以在正文里用：

| 写法 | 效果 | HTML | PPTX |
| --- | --- | --- | --- |
| `**文字**` | 加粗 | `<strong>` | run 级 `b="1"` |
| `==文字==` | 标红（取主题强调色，可被 `brand.primaryColor` 覆盖） | `<span class="hl">` | run 级强调色 |

支持范围：**标题、副标题、要点、表格单元格、statement/quote 的正文**。

不变的旧行为（刻意保持）：
`*斜体*` 与 `` `代码` `` 仍然**只去标记、保留文字**；`<b>`、`<script>` 这类标签**照旧剥掉**（不渲染）；
没有标记的文本走**完全相同的旧代码路径**（manifest 里不会多出 `*Runs` 字段）。

实现要点：把 markup 解析成 `{plain, parts}`，`plain` 存回原有的 `title`/`bullets` 字段（保持旧行为与可访问性），
`parts` 另存为 `titleRuns` / `subtitleRuns` / `textRuns` / `bulletRuns` / `cellRuns`；
`renderHtmlSlide` 与 `paragraphXml`/表格单元格在有 run 时输出多段，没有时走单段旧路径。
表格的 `cellRuns` 会**跟着分页一起切**（否则续页强调会错位到别的单元格）。

## ⚠ 改完补丁必须知道：宿主会缓存插件模块

**实测教训**：补丁写好之后，由 DSH 宿主进程执行的 `ppt_create` / `ppt_edit` **仍然走旧代码**——
Node 的 ESM 模块在进程内缓存，宿主启动时已加载过 `deck-core.mjs`，之后不会重读。

- **新起的进程用新代码**：CLI `node build-deck.mjs ...` 每次都是新进程，立刻生效。
- **要让 `ppt_create` 也用新代码，只能重启 `dsh web`。**

判断在线的是哪一版：用 CLI 建一份带 `**x**` 的样例，看 manifest 里有没有 `titleRuns`。

## 判断这处补丁还在不在

生成任意一份 deck（哪怕只有一页），然后：

```powershell
# 两处补丁的存在性检查（语法标记 + 强调 CSS）
node -e "const fs=require('fs');const h=fs.readFileSync(process.argv[1],'utf8');console.log('anno-bar:',h.includes('anno-bar'),'laser:',h.includes('laser-canvas'),'emphasis-css:',h.includes('.hl{color:var(--accent)'))" "deck.html"
```

三处都是 `true` 说明两处补丁都在。**升级 dsh-ppt 之后请跑这一条**——升级后重新生成的 deck
如果没有这些，不要以为是 deck 的问题。

## 升级 dsh-ppt 之后怎么恢复

```powershell
$mod = "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-ppt\skills\dsh-ppt\scripts\deck-core.mjs"
# 1. 先看新版本是不是已经自带这些功能（官方可能自己加了）
node -e "const s=require('fs').readFileSync(process.argv[1],'utf8');console.log('has anno-bar:',s.includes('anno-bar'))" $mod
# 2. 若没有，备份新版本，再用补丁版覆盖
Copy-Item $mod "$mod.bak-before-repatch"
Copy-Item "E:\deepseekagent\dsh-creativity\_sessionlog\plugin-patches\deck-core.mjs.patched-annotation-tools" $mod -Force
```

**注意**：补丁版是基于 0.9.0 的 `deck-core.mjs` 整份文件，**不是 diff**。若官方升级改动了
`renderHtml` 附近的代码，直接覆盖会**丢掉官方的新修复**。正确做法是重新对本仓库记录的改动点
做一次移植（见下），而不是无脑覆盖。

## 改动点清单（重新移植时的锚点）

1. `LANGUAGES.{zh,en,bilingual}.ui` 各加 5 个键：
   `laserToggle` / `penToggle` / `zoomToggle` / `clearToggle` / `toolHint`。
2. CSS：在 `#blank` 规则之后加 `#stage` 的 transform 变量、`#pen-canvas`、`#laser-canvas`、
   `#anno-bar`、`body.pen-on/laser-on/zoomed/panning` 光标样式。
3. HTML：`#stage` 之后插入两个 `<canvas>` 与 `#anno-bar` 工具栏；
   `#help-panel` 增加一行快捷键说明与 `toolHint` 段落。
4. JS：在 `window.addEventListener('beforeunload', closePresenter)` 与 `${delivery.script}` 之间
   插入整个标注层（画布、笔画 Map、缩放/平移状态、指针事件、`requestAnimationFrame` 渲染循环、
   工具栏接线）；在 `go()` 里调用 `redrawPen(true)`；在 IIFE 末尾 `go()` 之前调用
   `fitPenCanvas() / applyZoom() / updateToolButtons() / requestAnimationFrame(tick)`。
5. 键盘：`keydown` 的守卫放开 `Shift`（否则 `Shift+D` 与 `Shift+滚轮` 收不到），
   新增 `X` / `D`(含 `Shift`) / `C` / `Z` 分支，`Esc` 增加「先复位缩放」一级；
   `keyup` 处理 `X` 松开；`wheel` 改 `{ passive: false }` 并在 `Shift` 时缩放。
6. 交互守卫：`wantsPan()` 决定「拖动是平移还是落笔」——中键、`Shift+左键`、或
   「已缩放且未开启画笔」时为平移。

补丁二的改动点（内联强调）：

1. `INLINE_TOKEN` 正则 + `parseInlineMarkdown()`（返回 `{plain, parts}`）；
   `stripInlineMarkdown()` 改为返回 `parseInlineMarkdown(value).plain`（保留导出，调用点不变）。
   解析前仍剥掉 `<...>` 标签；`*斜体*` 与 `` `代码` `` 只去标记。
2. `normalizeSlide()` 里用 `inlineRuns()` 算出 `titleRuns`/`subtitleRuns`/`textRuns`/`bulletRuns`
   与 `cellRuns`（表格），随 `...rich` 一起写进规范化结果；无标记时为 `null`，**不新增字段**。
3. `paginateTable()` 按同样的切片切 `cellRuns`。
4. `renderHtmlSlide()`：`composeInline()` / `inlineHtml()` 输出 `<strong>` 与 `<span class="hl">`；
   CSS 在 `.quote-attr` 后加 `.hl{color:var(--accent);font-weight:700}`。
5. `paragraphXml()` 新增 `accentColor` 与 `runs` 选项：有 runs 时输出多个 `<a:r>`（`b` 与颜色逐段决定）；
   `tableGraphicXml()` 新增 `slideRuns` 参数并逐格输出多 run。
   各布局的 `para(...)` 调用点补上 `runs: slide.xxxRuns` 与 `accentColor: p.accent`。
   注意：标题原本一律 `bold: true`，开启要点强调后改为 `bold: false`——否则 `**强调**` 与标题同粗细、失去对比。

## 已知限制（如实记录）

- **标注不进 PPTX、不落盘**。激光/画笔只存在于 HTML 放映的当前会话，刷新页面即清空；
  要留痕请用「检查与导出」或直接截图。这是刻意的：PPTX 是编辑产物，不该混入临时墨迹。
- **`Ctrl+滚轮` 仍然交给浏览器的页面缩放**，没有抢这个手势（是无障碍功能）。
  缩放行走 `Shift+滚轮` / `Z`。
- **工具栏按钮会拿到焦点**，此时按空格是「激活按钮」而不是翻页（已按此拦截）；
  点一下画面即可恢复翻页。
- 触摸设备上画笔依赖 `PointerEvent`，`touch-action` 已设为 `none`；未在真机触屏上验证过。
- 只在 `Microsoft Edge`（Chromium，headless）上自动化验证过；Firefox / Safari 未测。
- **内联强调不进 Markdown 表格的自动解析路径之外**：从 Markdown 文本写的表格单元格同样支持
  `**` 与 `==`（解析发生在规范化阶段，与来源无关），但**图片的 caption、备注、页脚**没有接内联 run。

## 验证记录（2026-10-13）

在 headless Edge（1280×720，CDP 驱动**真实鼠标/键盘事件**）上跑的 27 项断言全部通过，覆盖：
激光拖尾落笔与淡出、画笔红/绿双色、`C` 清空、`Shift+滚轮` 缩放、拖拽平移、
`Esc` 复位、**标注按页隔离与翻页恢复**、以及总览/备注/页码等原有功能未回归。

修复过程中实测抓到并修掉的两个真 bug（都写在这份记录里以免重犯）：

1. **平移手势不可达**：最初把「左键拖动」判为落笔，于是缩放后没有任何地方可以拖动平移。
   改为 `wantsPan()` 显式判定，并给 `#stage` 也挂上平移处理（否则画笔关闭时事件无处可去）。
2. **按页标注失效**：`redrawPen()` 误写成遍历**全部页面**的笔画 Map，导致翻到新页时
   把上一页的墨迹重画一遍。改为只取 `penStrokes.get(index)`。

另外查清一处**不是 bug 的现象**：`getComputedStyle` 读 `--deck-zoom` 会读到 180ms CSS 过渡的
中间值，测试必须轮询到稳定值再断言，否则会误报失败。

### 补丁二的验证（2026-10-13）

**18 项产物断言**（`verify-emphasis.mjs`，直接读 HTML + JSON）：
`<strong>`/`.hl` 真的渲染出来、标记不泄漏到可见文本、`<b>` 注入被剥掉、
manifest 里 `title`/`bullets` 保持无标记纯文本而 `*Runs` 保存结构、
没有标记的页面**不产生任何** `*Runs` 键（旧路径不变）。

**19 项真实浏览器断言**（`browser-emphasis.mjs`，headless Edge + CDP）：
关键一项是**算出来的颜色**——`.hl` 的 computed color 必须是
`rgb(192, 0, 0)`（`brand.primaryColor`），而不是 `soft` 主题的橙色 `rgb(229, 138, 47)`；
加粗的 computed `font-weight` 必须（900）重于正文（400）。
这条断言抓的就是「CSS 变量选错来源」这类错误。

**PPTX 侧**：把上面那份样例渲染成 PNG 逐页看过——加粗、标红、表格单元格强调都落在画面上，
`<b>` 注入表现为纯文本而非真标签。

> 写测试时踩的两个坑（都不是插件的问题，记录以免重犯）：
> ① `getComputedStyle(el).color` 的字符串用 `match(/[\d.]+/g)` 解析会被 `192.` 这类匹配吃掉小数点的写法坑到，
> 直接比较 `'rgb(192, 0, 0)'` 字符串最稳；
> ② 断言写「titleRuns 长度为 3」是拍脑袋的——分词颗粒度由标记位置决定，应断言**性质**（含 bold、含 accent）而不是长度。

## 怎么重跑这套验证

```powershell
$t = "E:\deepseekagent\dsh-creativity\_sessionlog\plugin-patches\anno-tools-test"
# 演示产物已集中到 演示/ 目录（该目录不进版本库，见 .gitignore）

# 1. 语法与关键标记（不需要浏览器）
node $t\syntax-check.mjs "E:\deepseekagent\dsh-creativity\演示\dsh-serendipity-缪斯.html"

# 2. 内容完整性（翻页数、图表、备注、无乱码）
node $t\verify-deck.mjs "E:\deepseekagent\dsh-creativity\演示\dsh-serendipity-缪斯.html"

# 3. 真实浏览器交互（需要 Edge；会自己起 headless 实例再关掉）
node $t\browser-test.mjs "file:///E:/deepseekagent/dsh-creativity/%E6%BC%94%E7%A4%BA/dsh-serendipity-%E7%BC%AA%E6%96%AF.html"

# 4. 改完放映器后，用项目自带内容重建三件套（不要重新创作内容）
node $t\rebuild-deck.mjs "E:\deepseekagent\dsh-creativity\演示\dsh-serendipity-缪斯.json"
```

`browser-test.mjs` 的两条实测注意事项（都踩过）：
headless 窗口在 `about:blank` 上默认只有 500×320，**必须先 `Emulation.setDeviceMetricsOverride`**
否则 (640,360) 上的输入落在视口外、事件根本不到页面；以及要等 `#anno-bar` 与 `window.__dshPpt`
都出现后再派发输入（玩家在初始化期间挂监听，早于此时刻的输入会被静默丢弃）。
