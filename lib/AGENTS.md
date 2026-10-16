# 实现细节（子 AGENTS）

本文件记录**代码层面的实现约定与坑**。项目总体目标与协作边界见根目录 `AGENTS.md`；
设计动机见 `docs/项目计划.md`。

## 模块划分

| 文件 | 职责 | 关键约束 |
| --- | --- | --- |
| `lib/index.js` | cordis 插件的宿主半边：`name` / `inject` / **`Config`** / `apply` | `inject` 只声明 `tools`、`systemPrompt`；`webServer` 走嵌套 `ctx.inject`，保证 headless 部署也能用工具；`Config` 的可编辑字段必须 `.volatile()`（见坑 12） |
| `lib/corpus.js` | 加载 + 校验语料（内置 `lib/corpus/*.json` + 用户 `~/.dsh/dsh-serendipity/corpus/`） | 校验失败只丢弃该条并记录原因，绝不抛异常 |
| `lib/hash.js` | 素材 id 与项目 key | id = hash(`origin \|\| label`)，**不得**依赖数组下标；项目 key 对路径大小写/斜杠不敏感 |
| `lib/draw.js` | 抽取引擎：跨域交错、`collide` 碰撞对 | 跨域交错 + 结构标签上限 + 来源上限；池子抽干时放宽重复并在结果里 `exhausted=true`；`collide` 反过来**奖励**共享结构、把同来源当硬排除 |
| `lib/text.js` | 词元切分与重叠（中文二元组 / 拉丁按词） | `generate` 的「避开已读领域」与 `collide` 的「来源距离」共用；粗粒度、很少触发，需要精确去重的地方用 id |
| `lib/store.js` | 状态持久化 | 原子写（temp + rename）；读失败降级为空状态并记 problem；**外部素材**（不在语料里的结构）单独标记 `external`，不计入 `seenIds` |
| `lib/sessions.js` | 每次会话的抽取指标（首次抽取的轮/步/该轮耗时，draws/items/notes/landed/提醒）与历史条数上限 | 只描述**不评分**，任何一项都不进抽样权重；`sessionReport: false` 时连记录一起停（不只是不显示）；`sessionPosition` 对没有事件日志的 exec 返回 `undefined` 而不是抛 |
| `lib/tools.js` | 六个 agent 工具 + 漏记提醒注册表 | 全部用 `defineTool`；**规范返回值必须是 lossless JSON**；描述是每次请求的固定成本，量它用 `tools/measure-tools.mjs` |
| `lib/routes.js` | 只读 HTTP 接口 + `GET/POST /settings` 配置读写 | loopback + 同源围栏；写操作只经设置服务，不直接改文件；`/sessions` 支持 `?cwd=`（HTTP 侧没有会话，否则只能报宿主的工作目录） |
| `lib/client.js` | **浏览器半边**：设置页「素材抽取（缪斯）」的卡片 | 懒 CJS 表（`window.__ModuleLoader__.load`），无构建步骤；注册失败只能自己吞，不能让 GUI 起不来 |
| `lib/structure-tags.mjs` | 结构标签受控词表（`CONTROLLED` + `TAG_ALIASES`） | 抽取与 lint 共用；新增标签必须先在这里归一，否则 lint 报 FAIL |
| `lib/fields.mjs` | **领域地名志**（13 个家族 / 223 个具体领域 + 每族一句「看什么」） | 纯内容、无逻辑；由 `test/serendipity.test.js` 的 `fields:` 用例守格式（唯一、够具体、不带括注） |
| `lib/generate.js` | `scope: "generate"` 的配对抽样（领域 × 结构核心） | 权重**导出**给测试算精确分布；配对记忆由 `store.generatedPairs` 保证不重复 |
| `lib/effectiveness.js` | 按**覆盖度**给类别/结构核心算有界权重 | **只看读了多少（`read`）和有没有落点（`landed`）**；自评 `hit`/`transformation` 只记录、不进权重；权重钳制在 0.85~1.25，样本 <15 时一律中性；**外部素材不是读取** |

> `lib/structure-tags.mjs` 原先放在 `tools/` 下，但它被测试与抽取逻辑共同依赖，放在 `lib/` 更合理。
> 改动它之后务必跑 `npm run lint:corpus` + `npm test`（lint 会验证语料的每个标签都能归一）。

## 踩过的坑（务必保留测试覆盖）

1. **`defineTool` 输出契约不接受 `undefined` 成员**（`value is not lossless JSON`）。
   可选字段必须**省略**而不是赋值 `undefined`。这是集成测试抓到的真实 bug——第一个 `serendipity_draw` 调用就会失败。
   对应测试：`test/integration.test.js` 的「dispatches end to end」。
   **2026-10-13 又踩了一次**：`stats.effectiveness.landedLag` 的 `medianDays`/`maxDays` 在「还没有延迟落点」
   时被赋成显式 `undefined`，于是**整份 stats 报告**被拒（`tool "serendipity_stats" returned invalid output`），
   而 `JSON.stringify` 会丢掉 `undefined`，所以读字段的单元测试全绿。修法是空列表时**不写这两个键**。
   现在的护栏：`test/serendipity.test.js` 的 lossless 遍历（`assertLossless`）+
   `test/integration.test.js` 把 stats 走真实 ToolRuntime 派发 + `tools/audit-tool-output.mjs`
   对六个工具 × 多种参数做全量审计（升级 dsh 后值得跑一遍）。
2. **值 schema DSL 的 `required` 只能出现在 object 的 property 上**。
   放在根对象、`array.items` 的元素对象上都会抛 `schema.required is not supported by the value schema DSL`。
   写法：`properties: { x: { type: 'string', required: true } }`，根对象不写 `required`。
3. **cordis Service 的服务名必须显式传**：`super(ctx, 'webServer', config)`。
   类名不会自动推导成 `ctx.webServer`，写错会导致嵌套 `ctx.inject(['webServer'])` 永不触发。
4. **`ctx.plugin()` 返回 thenable Fiber**，`await` 它才会完成服务注册；`new Context()` 上没有 `dispose`，
   要 dispose 的是某个 fiber。
5. **`Renderer` 只拿到 output schema 里的字段**。曾出现 `categoryName` 没进 schema 导致渲染出 `undefined`——
   集成测试用 `assert.doesNotMatch(text, /undefined/)` 兜住了这类问题。
6. **不要修改调用方传入的数组**：`DrawEngine` 内部拷贝 `materials`/`byId`，
   因为 `serendipity_learn` 会就地增改；否则会污染 `loadCorpus()` 的返回结果。
7. **`exec.deferContext()` 是让插件"说话"的通道**：漏记提醒就是这么做的。
   实测 `dsh-agent-loop` 在工具结果提交时把 `additionalContexts` 收进下一步请求（`acceptContext`），
   所以提醒会在下一次模型请求时可见。消息形状：`{ role: 'user', source: { kind: 'plugin', plugin, form: 'notice' }, content: [{ type: 'text', text }] }`。
8. **待记录状态按 session id 隔离**，存在 `lib/tools.js` 的模块级 Map 里（带 1 小时 TTL）。
   不用 service 是因为工具是全局注册的，session id 已足够做键；但**别忘了 TTL**，
   否则长期运行的宿主会积累死条目。
9. **抽样是随机的，所以统计类断言必须固定随机源**：`DrawEngine` 接受 `random` 注入
   （测试里用 `seeded(seed)`），否则 `violate`/`bias`/跨域分散这些断言会随机翻红——
   而且「改成宽松阈值」会把测试变废。固定种子后连跑 6 次全绿，且断言可以保持严格。
10. **权重必须「有界 + 有证据门槛 + 不优化自评」**（`lib/effectiveness.js`）。
    - **不拿 `hit` 学习**。自评有用不是证据（LLM 判新意会随提示词大幅摇摆、还偏向给自己打高分），
      而且长期研究里**素材的价值是延迟兑现的**：今天看着没用的结构可能是三个月后的枢纽。
      用「今天有没有用」当目标，等于把延迟兑现的素材标记为失败并学会避开它——误差不是随机噪声，是有方向的偏差。
    - 现在优化的是**覆盖度**（读取历史本身的属性，热情吹不动它）：某类别/结构核心被读得相对过多就降频，
      没读过的顶格加权，有 `landed` 落点的给一次**有界抬升**（是「抬向天花板的比例」而不是加法，
      否则一个落点能把被压制的类别直接顶到 1.25，实测真数据上就是这样）。
    - 中立点不是「占比」而是**读取率**：`bucket.read / bucket.items` 对比 `totalRead / totalItems`。
      踩过三种错法，都写进了代码注释：占比式（`1-share*4`）过 25% 就饱和，读透与没读过一起被钳到 0.85，
      杠杆等于空操作；「用过桶的均值」会跟着数据走（所有读都在一个类别时，那个均值就是读透的条数本身）；
      「按桶个数均分」忽略每桶有多少素材。
    - **标定要注意小桶**：245 个结构核心摊在 115 条素材上，一个核心的期望读取数只有约 0.3，
      第一次把地板设在 2.7 倍，结果**只读过一次的核心被判成 3 倍而压到地板**——把「读稀有素材一次」当成过度消费，
      与目标正好相反。地板必须超过「只有一条素材的桶读过一次」，天花板取 1/4 才对称。
    - 权重钳制在 0.85~1.25 且从不用作过滤器——插件存在的意义就是拿**远**素材，
      把「读透了」的类别降频到接近 0 等于抽卡机自己消灭了意外性。样本 <15 一律中性，否则前几轮笔记会锁死抽样。
    - 覆盖度统计**必须包含 `structureTags`**（`store.recordNotes` 里已存），否则只能按类别学。
    - **延迟兑现有专用通道，不能"以后再说"**：`landed` 是**写笔记那一刻**记的，
      所以「当时没用」的素材落点是空的。若没有机制把它送回来，**延迟兑现永远记不上**，
      被计入的信号就永久偏向「立刻能用」的东西——正是这个设计要避开的偏差。三件事缺一不可：
      ① 同一个 id 允许**以后补记** `landed`（合并进原记录、记 `landedAt`、算出延迟）；
      ② `draw` 每次递回 1~2 条「有笔记但没落点」的旧素材（`reconsider`，按读过时长排序）；
      ③ 延迟被统计出来并展示（`stats.effectiveness.landedLag`）。
    - **`reconsider` 必须有年龄门槛**（`RECONSIDER_MIN_AGE_MS` = 24 小时）。漏了它时实测会把
      几分钟前刚写完的笔记递回来——那不是「再看一眼」，而是「你刚说它没用，确定吗？」，
      等于对自评施压。这个 bug 正是被测试抓到的：候选列表混进了别的用例刚写的条目。
    - **`landedAt` 缺失时回退到 `notedAt`**。字段是新加的，历史记录里有 `landed` 却没有 `landedAt`；
      直接跳过它们会把**年头最久**的样本排除在延迟统计之外，恰好丢掉最该看的那几条。
      回退值同时报 `approximated` 计数，免得数字显得比实际精确。
11. **一次抽取是「噪声探针」，测不出「倾向」**：`bias` 是*倾向*不是*过滤*，
    用 60 个样本的占比去断言它会假阴（实测某种子下 22% 恰好等于基线）。
    正确做法是用 `draw({ count: 1 })` 做单次加权抽样，换不同种子跑几百次取大样本。
    实测 `bias` 的提升约 **1.6x**；测试同时钉住上下界（1.4x ~ 3x），
    防止将来改权重时把 bias 悄悄变成空操作或过滤器。
    **覆盖度权重比 bias 弱得多（×0.85~×1.25）**，400 次抽样根本分辨不出来，
    而且被「已读 ×0.35」的重复阻尼盖过去——原来的断言因此长期假绿（21.8% vs 21.7%）。
    做法改成：`scoreMaterial` **导出**，测试直接算出**精确的预期分布**（不受噪声影响），
    再单独验证采样器确实跟着权重走（只对方向断言，不对数值断言）。
    另外探针必须用**有项目历史的 cwd** 抽取；用临时 scratch 路径等于在测中性权重，这也是原来测不出来的原因。
12. **设置能力：0.2.0 起是「声明 Config」，不是「调 register」。**
    实测：从本仓库解析 `@deepseek-ai/schemastery` **能成功**，`@deepseek-ai/dsh-settings` **失败**
    （`link:` 安装时 peer 包从插件自己目录开始解析）。第一版设置项就是这么**静默失败**的——
    `import().catch()` 吞掉了错误，GUI 里根本没有设置标签页，而测试全绿。
    当时走的是 `ctx.settings.register(ns, schema, …)`；**dsh 0.2.0 把这个方法删了**
    （线上实测 `child.settings.register is not a function`），换成：
    - 插件**导出 `Config`**（schemastery schema），可编辑字段必须 `.volatile()`；宿主在 `apply` 之前
      按它校验，并把解析结果作为第二个参数交给 `apply`。
    - volatile 字段解析成**活引用**（`{ get() }`）：读取要写 `configField(config, key)`
      （兼容单元测试里直接传普通对象的情形），不能在挂载时捕获一次值。
    - 写入口是 `ctx.settings.update(<profile 条目 id>, patch)`，条目 id 取自 `ctx.fiber.entry.options.id`
      （本插件是 `serendipity`，**不是**包名、也不是自己起的 namespace）；配置落在 profile 的
      `cordis.patch.yml`，`~/.dsh/settings.yaml` 已被 0.2.0 改名成 `settings.yaml.imported` 并废弃。
    - volatile-only 的改动**不重启插件**：宿主就地改写引用并广播 `loader/volatile-update`，
      所以插件必须监听该事件重新 `sync()`（见坑 15 那套 disposer 逻辑），否则「关掉插件」这类
      由配置决定的挂载会留在旧状态。
    - 测试用假 Settings 服务钉住「写到了正确的条目 id + 值立刻生效」，用假 configEditor 提供条目 id
      （`test/integration.test.js`）。
    **教训：任何「用 catch 兜住的可选能力」都必须有一条断言证明它在应该生效时会生效。**
    这条迁移本身就是教训的第二次兑现：0.2.0 升级后 `GET /api/dsh-serendipity/settings` 报
    `register-failed`，而那正是当初为「静默失败」加的诊断字段。
13. **工具 schema 是每次请求都要付的固定成本**（`tools/measure-tools.mjs` 可量）：
    6 个工具的 schema ≈ 2300 token，提示词段落 ≈ 780 token，合计约占 128k 上下文的 2%。
    描述里大部分是散文，精简措辞能直接省 token；但**不要为了省 token 删掉「什么时候该用」的判断依据**
    ——那正是模型选对工具与参数的依据。
14. **设置项注册了 ≠ GUI 里看得到。** 官方设置页的插件标签页渲染的是
    **「宿主已注册的 namespace」∩「浏览器侧注册了 card 的 namespace」**：
    `dsh-client-ui-settings-plugins` 只给 `bash`、`agent-loop`、`web-search` 注册了 card
    （`ctx.slots.register({ name: 'settings.plugin.item', key: <namespace> }, Card)`）。
    第三方插件要在界面上出现**必须自带浏览器半边**；只有宿主半边、只声明 Config 的话，
    `describe()` 里有它，界面上什么都没有。
    本插件改成了注册 `settings.section`（自己的设置页），见第 16 条。
    另外 `GET /api/dsh-serendipity/settings` 会报告接线状态
    （`declared` / `schema-unavailable` + `entryId` + `service`）——
    **以后排查「设置没生效」先看这个路由，不要靠猜。**
15. **`ctx.effect` 的返回值不是 disposer。** 它返回 **thenable wrapper**（`disposeAsync` 挂在 `.then` 上），
    把它当函数调用是**静默 no-op**（调用 Promise 不报错）。
    正确的 disposer 是 effect 回调 `return` 的那个函数（与 dsh-ssh 的写法一致）：
    `const dispose = ctx.effect(() => { const ds = [...]; return () => { for (const d of ds) d() } }, 'label')`。
    实测后果：设置热重载时旧注册没释放，工具数最终变成 0。
    `test/integration.test.js` 的「a volatile change re-mounts the surfaces」用例专门守这条（改值后 6 → 0 → 6），
    它同时是「配置改动必须重新挂载」的护栏。
16. **浏览器半边是手写即可的懒 CJS 表，不需要打包器。**
    格式：`window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => { ... } })`；
    脚本执行时只注册 factory，模块体（含样式注入）在 materialization 时才跑。
    宿主侧要求：`package.json` 的 `exports["./client"]`（字符串或 `{default}`）+ `dsh.client.platform: 'web'`。
    **dsh 0.2.0 的取件方式变了**：不再直接 `GET /plugins/<id>/client.js`，而是由宿主把若干插件的
    client 脚本**拼成一个组合包**（`/plugins/??<id>/client.js&rev=<artifactRev>`，rev 是文件
    mtime/ctime/size 的哈希），boot manifest 放在 index 的 `globalThis.__DSH_BOOT__` 里；
    本插件仍是**原文件**参与拼接（无构建步骤），宿主验证方式是读 boot manifest 确认自己的行在里面、
    再按行里的 URL 取一次（`200` + 内容里能看到自己的注释头）。dsh.client.inject 里写的
    `@deepseek-ai/dsh-client-ui-slots` 在 0.2.0 已不是 client 包（`slots` 服务改由
    `dsh-client-ui-renderer` 提供）——该字段现在会被无声跳过，服务注入才是真正生效的那层。
    `react` 等属于 shell 提供的 static modules，可**直接 `require('react')` 而不必声明**；
    但通过 `ctx` 用到的服务（如 `slots`）必须写进 `dsh.client.inject`。
    客户端半边里未捕获的异常会**让整个 GUI 启动失败**，所以注册一律包 try/catch。
    `test/client.test.js` 钉住这些机械性要求（id、apply/inject 导出、路由契约、禁止 host-only import）。
17. **`oneOf` 的分支必须互斥，而「基础字段 + 一个可选字段」这种写法做不到**。
    给 `serendipity_note` 的 item 加 `landed` 时，写成 `oneOf: [不带到 landed 的对象, 带到 landed 的对象]`，
    第二个分支是第一个的**超集**，于是任何带 `note` 的参数**两个分支都匹配**，
    运行时直接报 `must match exactly one oneOf branch (matched 2)`——工具完全不可用。
    真正要表达的规则（「`landed` 只有写明地点才算数」「转变要有改动前后」）是**计数规则**，
    应该写在代码里，用**一个**对象 schema 就够了。
18. **`store.recordNotes` 是字段逐个重建条目，每加一个字段都要显式带上**。
    加 `landed` 时漏了 `recordDraw` 里的同样一段，结果**素材被重新抽到时落点被静默抹掉**，
    全局 `landed` 计数也随之被 `recordNotes` 的 else 分支回退——
    「落点」这个唯一被计入的信号，只要素材再出现一次就消失。
    同理，**计数必须按「合并后的记录」算**：重记一条只想改 `hit` 的笔记时，
    若按参数原样比较，没提到的 `landed` 会被判成「撤销了落点」。
    对策：合并后的值算计数器；布尔字段（`hit`/`transformation`）由工具层解析成确定的真值，
    `landed` 这类**事实字段**则保留旧值，只有显式传空字符串才撤销。
    `test/serendipity.test.js` 的 store 用例把「重抽不抹落点」「空串撤销落点」两条都钉住了。

19. **`landed` 曾经只认「插件自己发出的 id」，代价是真实数据里丢掉了一整类落点。**
    2026-10-10 的真实会话：agent 抓了 6 篇外部文章、逐条提炼、写进设计文档并标了落点，
    然后两次尝试记录都被拒（第一次整批 8 条被 schema 拒绝，第二次换成自造 id 后
    「未识别 id（未写入）」记 0 条），于是它自己得出「这是设计如此」的结论，放弃了这批落点——
    而那是它自评最重的三条。该项目插件记 14 条落点，真实是 20 条，**被漏掉的全是来自网络的那批**。
    现在的规则：**一条笔记只要有 `id`（可以是自起的）或 `label`（结构名，先按标题匹配语料）就入库**；
    匹配不到语料的记为**外部素材**。
    - 外部素材**不是读取**：`seenIds` 排除它、`tallyOutcomes` 的 `overall.read` 排除它，
      否则「库读了多少」会被库里本来没有的东西抬高，覆盖度权重那条中立线会被拉偏。
    - 计数也分开：`stats.landed`（语料）与 `stats.externalLanded`（外部）**永远不合并**，
      「发出量→落点」的比率只对语料成立。
    - `items[].id` 从 `required` 改成**可选**：schema 校验在 execute 之前，一条缺 id 会让**整批**作废，
      插件代码没有机会容错。现在缺 id 只让**那一条**被报告（并给出补救措辞），同批其余照常写入。
    - `recordNotes` 的返回带 `settled`（每条解析后的 `{ id, external, landed, hit, backed }`），
      调用方**不要**再从原始参数重新推导计数：按标题匹配上语料的那条在参数里没有 id，
      重新推导会把语料落点记成外部落点。
20. **`const note = resolveNote(raw)` 会遮蔽原始 note，而且测试可能照样绿。**
    改 `recordNotes` 时把解析结果命名成 `note`，于是函数体里 `note.note` / `note.landed` / `note.hit`
    全都取到解析对象（全是 `undefined`）——**每条笔记只剩 `category` 与 `notedAt` 落盘**。
    这一类 bug 的可怕之处是它**部分通过**：断言 `category`、条数、计数的测试都还是绿的，
    只有断言「笔记内容还在」的测试会红。命名上把「原始输入」与「解析结果」分开（`raw` / `resolved`），
    并且**任何合并逻辑都要有一条断言证明合并后的字段真的写进了文件**。
21. **`fetch` 的来源清单必须是实测的、按 host 记的、随内容分组的。**
    - 旧的静态清单写「知乎可达」，而实际 `www.zhihu.com` 200、`zhuanlan.zhihu.com` **403**——
      **键必须是 host，不能是站点**。
    - 首页与文章页要分开：`gcores.com/` 200 但只是导航（现在提取后按行长分布判为 `indexPage` 并明确告知），
      `/articles/<id>` 才是正文。
    - 会浪费调用的三件事都固化了：**arXiv 空格关键词 = OR**（实测 57 万条无关结果）、
      **API 的 `*_url` 模板字段吃掉整个输出预算**（现在递归剥掉、深层折叠成 `{…}`）、
      **PDF 被当纯文本返回**（现在按 content-type 与 `%PDF` 魔数拒绝并说明改用 `/abs/` 或 API）。
    - 改清单前先跑 `node tools/probe-sources.mjs`（46 个目标）与 `tools/probe-search.mjs`，
      它们是有日期的实测，不是记忆。
22. **`scope: "generate"` 是「不抽素材」的第三种返回形态**（前两种是 `near` 的比较任务与默认的素材）。
    它必须**完全不记账**：不计 `draws`、不写 `seenIds`、不占去重预算、不产生漏记提醒——
    什么都没发出去，所以什么都不该记。测试里有一条专门钉住这四个「不动」。
    配对记忆（`store.recordGenerated`）要有上限，否则长项目会把状态文件撑大；
    权重函数 `fieldWeight` **导出**，测试算精确分布、只对采样器做方向断言（同坑 11 的道理）。
    领域词元用**二元组**而不是单字：单字会让「消防工程」和「工业工程」因一个「工」字就算重叠，
    惩罚退化成均匀噪声；二元组只在真的像同一片区域时命中（因此它**很少触发**，
    「不要重复方向」主要靠配对记忆保证——这一点写在代码注释里，别指望它做重活）。
24. **`collide` 是「反过来的拥挤惩罚」，而它顺手暴露出两个静默失败。**
    普通抽取对共享结构核心的候选罚 ×0.55/×0.15（覆盖面要宽），`collide` 反过来**奖励**它、
    并把「同来源」当**硬排除**（同一个领域里的两条不是碰撞，是重读）。
    - **`bias` 想钉住形状就必须是过滤器，不能是权重。** 第一版用 ×12 加权，在 ~75 个竞争形状面前
      只有约 14% 命中率——`bias: "阈值"` 每七次里约有六次给别的形状。**静默不照做比不支持更糟**，
      所以现在把候选限制在命名的核心上，只在限制导致无法成对时才退回覆盖率加权。
    - **`bias` 的匹配必须走受控词表**（`toControlled`）：写别名 `预警` 的人要的是核心 `阈值`。
      另外——`Set` 没有 `includes`，只有 `has`；写成 `biasTokens.includes(...)` 会永远返回
      `undefined`，也就是**这个功能一次都不会生效而没有任何报错**。
    - **配对要枚举后整体打分**，不要「先选一个再选最远的」：贪心先优化相关性再优化距离，
      实测给出过 `可靠性工程 / 航空航天` 配一条共享「可靠性」这个词的素材，碰撞距离只有 0.15。
      组很小（一个形状几条素材），枚举便宜且能同时优化两端。
    - **选形状时按「这个形状最远能撞多远」加权**（`bestPairDistance`，0.25 地板）。
      语料里能成对的形状中约六分之一最佳距离 < 0.5，避开它们之后实测平均距离 **0.76 → 0.84**、
      低距离配对 **17.5% → 6.3%**（单对约 1.1ms）。距离比较用**记忆化**（origin 重复率高），
      否则每次抽取要重复几千次分词。
    - `collide` 仍然是**交付**：要 `store.recordDraw` / 标记已读 / 计入去重预算，
      与 `near`/`generate`「只给任务不记账」正好相反。测试里两边都有断言，别搞混。
    - `weightedPick` 返回的是**下标**不是 key——`pickCore`/`pickCollisionPair` 第一次写成
      `const core = weightedPick(...)` 就拿到了数字下标，随后 `grouped.get(core)` 直接崩。
25. **工具 schema 是每次请求都要付的固定成本，加了能力就要重新量**（`tools/measure-tools.mjs`）。
    2026-10-12 加完会话报告、`sessions` 段与「开放式目标」提示词之后：6 个工具 ≈ **3178 token**、
    提示词段落 ≈ **1416 token**，合计约占 128k 上下文的 **3.6%**（2026-10-10 是 3176 + 1310 ≈ 3.5%，
    再往前是 ≈2.4%）。做法是把**长表格与解释放进渲染**（只在真正调用时付一次），
    描述里只留「什么时候用」和两条最贵的语法陷阱。
26. **会话报告：三个「看起来对、其实在骗人」的取数方式。**
    - **耗时从那**一轮**的 `turn/start` 起算，不是 `session.header.createdAt`。** 后者是会话被创建
      （或上次 resume）的时刻：早上开的会话中午才提问，会报「开场后 4 小时」——而这个数字正是用来判断
      「插件用得多早」的。位置（轮/步）与耗时必须来自同一次事件扫描，否则三者互相矛盾。
    - **补记不得当成新工作。** `recordNotes` 的 `settled` 因此多了 `firstNote` 与 `landedNew`：
      `noted` 只数首次笔记，`landed` 只数**这次才建立**的落点。少了这两个字段，真实会话里
      「先记 6 条无落点、稍后补记 3 条落点」会被算成 9 条条目，而延迟兑现通道（同一 id 反复补记）
      正是这个插件最鼓励的动作。
    - **关掉开关必须连记录一起停。** `sessionReport: false` 只隐藏显示的话，用户明确让它别记的东西
      还在往项目文件里长。测试直接读盘断言 `sessions` 仍是空的。
    - `emptyProject().sessions = {}` 让「没有会话」与「报告被关掉」在磁盘上长得一样，
      所以 `/sessions` 与 `serendipity_stats` 都另带一个 `enabled` / `reportEnabled` 字段——
      **空列表与功能关闭不能都读成「没抽过」**，这正是这个功能要修的那类误判。
27. **一句无条件打印的文案会跟它上面两行的数字打架。** `renderNote` 里「落点为 0 是正常的……」
    原本无条件输出，于是真实会话的结果同时写着「其中有落点（写明了结构去了哪里）3 条」与
    「落点为 0 是正常的」。这类 bug 不会让测试变红（没人断言那句话），却会让工具在自己最核心的
    那个数字上显得不可信。修法是把安抚语并进 `landed === 0` 分支，并补一条**双向**断言：
    有落点时不得出现，没落点时必须出现。

## 语料维护

- 素材**不手写 JSON**，统一维护在 `tools/build-corpus.mjs` 里再序列化，避免逗号/编码错误。
- `detail` 必须写机理（为什么有效/为什么反直觉），只有事实的条目一律不收。
- `bridge` 必须是问句或祈使句，逼读者做关系对齐。
- 新增类别时要同步改：`CATEGORIES`、`CATEGORY_NAMES`、`build-corpus.mjs`、`serendipity_learn` 的 enum、
  以及 `docs/项目计划.md` 的表格。
- **新增结构标签必须先在 `lib/structure-tags.mjs` 里映射到受控核心**，否则 `npm run lint:corpus` 报 FAIL。
  这条规则是为了防止标签碎化（不加约束时 115 条素材散出 245 个标签，检索与去重直接失效）。
  当前词表：76 个受控核心 + 285 条别名，覆盖语料里全部 245 个标签。
- 提交前跑 `npm run lint:corpus`：FAIL 必须清零，WARN 是给人看的复查清单
  （「这段 detail 是不是没讲机理」这种判断只能人读，所以它永远是 WARN，不是 FAIL）。
- **`origin` 必须是真的来源领域，且尽量不重复**。它是「远不远」的唯一信号：
  实测把「日常厨房」这类泛称收敛成真正的领域后，独立领域从 107 升到 114/115。
  lint 会监控独立领域比值（<0.85 告警）与过泛的领域名（≤2 字）；
  `test/lint.test.js` 里有一条断言专门守这个比值，别删。

## 测试与验证

```powershell
npm test                     # 62 个用例
npm run lint:corpus          # 语料体检
npm run preview              # 生成 docs/preview-draw.md
node tools/audit-tool-output.mjs # 六个工具 × 多种参数的 lossless-JSON 审计（升级 dsh 后必跑）
node tools/measure-tools.mjs # 量工具 schema 的 token 占用
node tools/probe-sources.mjs # 素材来源可达性实测（46 个目标，改 fetch 清单前先跑）
node tools/probe-search.mjs  # 搜索端点实测（B站专栏搜索、少数派列表、萌娘百科随机…）
node tools/session-report.mjs <session.jsonl>
                             # 默认打【会话指标】：第几轮第几步首次抽取、抽了几条、多少落点、有没有漏记
node tools/session-report.mjs <session.jsonl> --tools --user --assistant --reasoning
                             # 再把调用参数、用户消息、模型结论摘出来，不把 5MB 转录读进上下文
```

### 升级 dsh 之后怎么体检（2026-10-13 实战流程）

0.1.1-rc.2 → 0.2.0-rc.2 这次升级打断了设置注册，另一处 lossless 违规是顺手发现的。可复用的顺序：

1. `npm test` + `node tools/lint-corpus.mjs` + `node tools/audit-tool-output.mjs`（离线，先跑）。
2. 起一个**空闲端口的临时实例**，看启动日志有没有 `skipping profile bundle …`（版本门会跳过 peer 范围不符的插件）：
   `node <dsh>\lib\bin.js web --port 19488 --no-open`。
3. `GET` 本插件的每个路由，重点看 `/settings` 的 `stage` / `entryId` / `service`——
   设置接线断了只有这里会说出来。
4. 浏览器半边：带 token 换 cookie 后取首页，读 `globalThis.__DSH_BOOT__`，确认自己的行在里面，
   再按行里的 URL 取一次脚本（0.2.0 是组合包 URL，见坑 16）。
5. 真要验写入路径，先备份 profile 的 `cordis.patch.yml`，用**等于默认值**的 patch 试一次
   （`POST /api/dsh-serendipity/settings`，要带同源 `Origin`），确认文件里出现条目、
   运行中的实例立刻反映（volatile 就地生效），**然后把 patch 还原**。
6. 收尾：杀掉临时实例、还原 profile、删掉临时脚本（别留在仓库根）。

> `tools/check-network.mjs` 是更早的粗探测（只测首页），已被 `probe-sources.mjs` 取代；
> 保留它是因为它列的是「曾经以为可达」的那批站点，用来对照变化。

### 真实 agent 会话测试（跑真实模型，会花额度）

单元测试覆盖不到「真实模型到底会不会按提示词做」。用 `tools/headless-test.patch.yml` 把插件挂到
headless profile 上，就能让真实 agent 跑一次闭环；**状态目录用临时 `USERPROFILE` 隔离**，不动真实数据：

```powershell
$iso = "E:\deepseekagent\dsh-creativity\.tmp-test-home"
Copy-Item "$env:USERPROFILE\.dsh\.credentials.yaml" "$iso\.dsh\.credentials.yaml"   # 用完删掉
cmd /c "set USERPROFILE=$iso&& set HOME=$iso&& set DSH_HOME=$iso\.dsh&& node <dsh>\lib\bin.js --profile headless --patch E:\deepseekagent\dsh-creativity\tools\headless-test.patch.yml ""用 serendipity_draw 抽 3 条素材，读完并记录。做完就停。"""
```

三个坑（都踩过）：

1. patch 里的 `name` 必须是 **`file:///` URL**。写包名 → 临时 DSH_HOME 里没装这个包，
   报 `ERR_MODULE_NOT_FOUND`；写 Windows 绝对路径 `E:/...` → ESM loader 当成协议 `e:`，
   报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。
2. `DSH_HOME` 要显式设成隔离目录。cmd 里 `%USERPROFILE%\.dsh` 是**解析期**展开，
   会拿到真实主目录（第一次就踩了）。
3. 插件状态根是 `homedir()/.dsh/dsh-serendipity`，`homedir()` 跟随 `USERPROFILE`/`HOME`，所以隔离有效；
   但 `stateRoot()` **不读 `DSH_HOME`**，两个环境变量别搞混。凭据副本用完即删，
   `.tmp-test-home/` 已在 `.gitignore`（绝不能提交）。

实测收益（2026-10-06）：真实 agent **两次拒绝编造 `landed`**，第二次还自己 grep 核对后否证了候选落点；
但同一批测试也暴露了 reconsider 的措辞**在诱导编造**（agent 自述「我一度以为找到了落点」）——
这类问题只有真跑才会出现，所以重要改动值得跑一次。

`test/serendipity.test.js` 覆盖：语料完整性、id 稳定性、抽取的跨域分散/去重/抽干/`violate`/`bias`、
  **覆盖度权重**（证据门槛 / 上下界 / 不被过滤 / 只吃覆盖度与落点、自评不进权重 / 预期分布的精确断言）、
  **落点与自评分开计数**（重抽不抹落点、空串撤销落点）、**外部素材落点**
  （自起 id / 按 label 匹配语料 / 缺 id 只报那一条不连坐 / 不进 `seenIds` 与覆盖度 / 统计里分开报）、
  **延迟兑现通道**
  （补记落点并入原记录并算出延迟 / 重复补记不改写落点时刻 / 撤销落点连延迟一起消失 /
  `reconsider` 的候选条件、年龄门槛、与 `recall` 不重复引用）、horizon 分档与召回、
  **随机配对生成**（地名志体检 / 避让已读的精确权重与方向断言 / 配对记忆与上限 /
  「不计抽取、不标已读、不占去重」四条不动）、**碰撞对**
  （成对共享受控核心且来源不同 / `bias` 写核心或别名都**钉住**形状 / 距离权重与「同来源硬排除」的精确断言 /
  平均距离的方向断言 / 抽干后退化为重复 / 仍然是交付会记账）、
  **拆解的一次性提示**（设计类目的提示、非设计不提示、用过不再提示）、
  near 比较任务、分析库存取与复用、**fetch 容错 + 索引页识别 + 二进制拒绝 + JSON 噪声剥除**、
  存储容错、工具往返、漏记提醒、路由围栏与 `/summary` 字段契约、**会话指标**
  （首次抽取只记一次 / 补记不重复计数 / 历史上限 / `sessionReport:false` 连记录一起关掉 /
  `/sessions` 的 `?cwd=` 与 `enabled`）、**「落点为 0」文案的双向断言**。
- `test/integration.test.js`：真实 cordis + `ToolRuntime` + `SystemPrompt` 挂载；drawMode 三档；
  **Config 声明**（五个字段都在、都 `.volatile()`、解析出活引用）；
  **volatile 改动重新挂载**（假 Settings 服务模拟宿主的就地改写 + `loader/volatile-update` 事件，
  6 → 0 → 6，含 `ctx.effect` disposer 的回归护栏）；
  **卡片写入路径**（假 Settings + 假 configEditor：POST `/settings` → `settings.update('serendipity', …)`，
  非法值与未知键在写之前就被拒）；**stats 走真实输出契约**；端到端派发一次工具。
- `test/client.test.js`：**浏览器半边契约**（manifest 的 `exports["./client"]` 与 `dsh.client`、
  `__ModuleLoader__` 的 id、`apply`/`inject` 导出、配置路由契约、禁止 host-only import）。
- `test/lint.test.js`：语料体检纳入测试。
- 依赖 SDK 通过本仓库 `node_modules/@deepseek-ai/*` junction 解析，见 README「让插件能解析 dsh SDK」。
  **注意 `@deepseek-ai/dsh-settings` 不在其中**——所以设置能力必须走 `ctx.settings` 服务（见坑 12）。

## 环境注意事项

- 本机 PowerShell 禁止脚本执行：`dsh.ps1` / `pnpm.ps1` 都不能直接调用，
  要用 `node <dsh安装目录>\node_modules\@deepseek-ai\dsh\lib\bin.js ...` 或 `cmd /c`。
- 宿主插件**不走 HMR**：改 `lib/**` 后必须重启 `dsh web` 才生效。
- 安装/改 profile 前先备份 `~/.dsh/profiles/<name>/{package.json,cordis.patch.yml}`。
