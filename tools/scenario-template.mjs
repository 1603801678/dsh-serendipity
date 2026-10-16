// 情境图的 HTML 模板（被 build-scenario-images.mjs import 的模块，不是页面）。
//
// 两条几何约束，都踩过：
//  1. 画布比例必须匹配 dsh-ppt 的 `image` 版面：mediaBoxes() 给的是 11.6×4.66 英寸 ≈ 2.489:1，
//     所以这里出 2560×1028。
//  2. PPTX 侧图片用的是 `<a:stretch><a:fillRect/>`（拉伸填满），**内容一旦超出画布就会被裁掉**，
//     而且是左右各裁一半。所以每张图的横向内容必须真的放得下 —— 用
//     `node tools/measure-scenario-images.mjs` 量，超出就来调 DS 里的比例。
//
// 基准尺寸 DS 是「按画布 1280 宽」定的比例，再乘 S 放大；`.cv` 里没写 font-size 的元素
// 继承 CSS 里的默认值（默认值就是按 DS 换算出来的），只有需要不同的组才在标签上覆盖。
const W = 2560
const H = 1028
const S = 1.54                      // 全局放大系数
const n = (v) => Math.round(v * S)  // 只出数值，调用处自己补 px

// 基准尺寸（画布 1280 宽时的相对比例）
const DS = { h1: 118, h2: 108, h3: 98, mid: 76, sml: 68, arrow: 62, arrowS: 46, lbl: 24, sm: 20, gap: 26, gapL: 60 }

const s = {
  e1: n(DS.h1), e2: n(DS.h2), e3: n(DS.h3), em: n(DS.mid), es: n(DS.sml),
  ar: n(DS.arrow), ars: n(DS.arrowS), gap: DS.gap * S, gapL: DS.gapL * S,
}

const CSS = `
  html,body{margin:0;width:${W}px;height:${H}px;background:#fff;overflow:hidden}
  .cv{position:relative;width:${W}px;height:${H}px;background:#fff;
      font-family:"Microsoft YaHei","Noto Sans SC",sans-serif;color:#111;
      display:flex;flex-direction:column;justify-content:center;align-items:center}
  .row{display:flex;align-items:center;justify-content:center;gap:${s.gap}px}
  .e{font-family:"Segoe UI Emoji";line-height:1;font-size:${s.e1}px}
  .arw{font-family:"Segoe UI Symbol",sans-serif;color:#111;line-height:1;font-size:${s.ar}px}
  .lbl{font-size:${n(DS.lbl)}px;color:#111;text-align:center;line-height:1.3;white-space:nowrap}
  .sm{font-size:${n(DS.sm)}px;color:#6B6B6B;text-align:center;white-space:nowrap}
  .cap{font-size:${n(DS.lbl * 1.18)}px;font-weight:700;color:#C00000;text-align:center;line-height:1.3;white-space:nowrap}
  .grp{display:flex;flex-direction:column;align-items:center;gap:${n(10)}px}
`

const ICONS = {
  // 你的问题 → 找出结构 → 从远域借来
  'cover-hero': `
    <div class="cv">
      <div class="row" style="gap:44px">
        <div class="grp"><span class="e">💻</span><span class="lbl">你的问题</span></div>
        <span class="arw">➜</span>
        <div class="grp"><span class="e">🧠</span><span class="lbl">找出可迁移的结构</span></div>
        <span class="arw">➜</span>
        <div class="grp">
          <div class="row" style="gap:10px">
            <span class="e" style="font-size:${s.em}">🩺</span><span class="e" style="font-size:${s.em}">🦠</span>
            <span class="e" style="font-size:${s.em}">🔬</span><span class="e" style="font-size:${s.em}">🌾</span>
            <span class="e" style="font-size:${s.em}">🎼</span>
          </div>
          <span class="lbl">从完全不相干的领域借来</span>
        </div>
      </div>
    </div>`,

  // 左：组合很擅长；右：跨域连接没有机制
  'problem-gap': `
    <div class="cv">
      <div class="row" style="gap:${s.gapL}px;align-items:flex-start">
        <div class="grp">
          <div class="row" style="gap:12px">
            <span class="e" style="font-size:${s.e2}">🧩</span>
            <span class="arw" style="font-size:${s.ars}">＋</span>
            <span class="e" style="font-size:${s.e2}">🧩</span>
            <span class="arw" style="font-size:${s.ars}">➜</span>
            <span class="e" style="font-size:${s.e2}">🧩</span>
          </div>
          <span class="lbl">重组已有元素</span>
          <span class="cap">很擅长</span>
        </div>
        <div class="grp">
          <div class="row" style="gap:12px">
            <span class="e" style="font-size:${s.e2}">🔬</span>
            <span class="arw" style="font-size:${s.ars}">✕</span>
            <span class="e" style="font-size:${s.e2}">🎼</span>
            <span class="arw" style="font-size:${s.ars}">➜</span>
            <span class="e" style="font-size:${s.e2}">❓</span>
          </div>
          <span class="lbl">连接不该连的东西</span>
          <span class="cap">没有机制</span>
        </div>
      </div>
    </div>`,

  // far / near / generate 三种用法
  'three-scopes': `
    <div class="cv">
      <div class="row" style="gap:${s.gapL}px;align-items:flex-start">
        <div class="grp">
          <div class="row" style="gap:10px">
            <span class="e" style="font-size:${s.e3}">🧠</span><span class="arw" style="font-size:${s.arrowS2 || s.ars}">➜</span>
            <span class="e" style="font-size:${s.e3}">🩺</span><span class="arw" style="font-size:${s.arrowS2 || s.ars}">➜</span>
            <span class="e" style="font-size:${s.e3}">🎯</span>
          </div>
          <span class="lbl">far：抽跨域结构素材</span>
          <span class="sm">需要跳出框架时</span>
        </div>
        <div class="grp">
          <div class="row" style="gap:10px">
            <span class="e" style="font-size:${s.e3}">📚</span><span class="arw" style="font-size:${s.arrowS2 || s.ars}">➜</span>
            <span class="e" style="font-size:${s.e3}">📊</span>
          </div>
          <span class="lbl">near：同领域基准</span>
          <span class="sm">判断自己是否真的新</span>
        </div>
        <div class="grp">
          <div class="row" style="gap:10px">
            <span class="e" style="font-size:${s.e3}">🎲</span><span class="arw" style="font-size:${s.arrowS2 || s.ars}">➜</span>
            <span class="e" style="font-size:${s.e3}">🧭</span>
          </div>
          <span class="lbl">generate：随机方向</span>
          <span class="sm">要一个没人替你定的方向</span>
        </div>
      </div>
    </div>`,

  // 一个形状在两个远域各出现一次
  'collide': `
    <div class="cv">
      <div class="row" style="gap:${s.gapL}px">
        <div class="grp"><span class="e">🐺</span><span class="lbl">生态学</span></div>
        <div class="grp">
          <span class="cap">同一个形状</span>
          <span class="arw" style="font-size:${s.ar}">⇄</span>
          <span class="sm">捕食者–猎物周期</span>
        </div>
        <div class="grp"><span class="e">🔧</span><span class="lbl">工程学</span></div>
      </div>
    </div>`,

  // 延迟兑现通道
  'delayed-payoff': `
    <div class="cv">
      <div class="row" style="gap:${s.gap + 8}px">
        <div class="grp"><span class="e" style="font-size:${s.e3}">📦</span><span class="lbl">读过</span></div>
        <span class="arw" style="font-size:${s.ars}">➜</span>
        <div class="grp"><span class="e" style="font-size:${s.e3}">🤷</span><span class="lbl">当时没用</span></div>
        <span class="arw" style="font-size:${s.ars}">➜</span>
        <div class="grp"><span class="e" style="font-size:${s.e3}">⏳</span><span class="lbl">放很久</span></div>
        <span class="arw" style="font-size:${s.ars}">➜</span>
        <div class="grp"><span class="e" style="font-size:${s.e3}">💡</span><span class="lbl">后来有用</span></div>
      </div>
    </div>`,

  // 覆盖度权重三档
  'coverage-weight': `
    <div class="cv">
      <div class="row" style="gap:${s.gapL}px;align-items:flex-start">
        <div class="grp"><span class="e" style="font-size:${s.e2}">✅</span><span class="lbl">读得多的</span><span class="cap">×0.85</span></div>
        <div class="grp"><span class="e" style="font-size:${s.e2}">➖</span><span class="lbl">样本不足</span><span class="cap" style="color:#6B6B6B">不调整</span></div>
        <div class="grp"><span class="e" style="font-size:${s.e2}">🌟</span><span class="lbl">没读过的</span><span class="cap">×1.25</span></div>
      </div>
    </div>`,

  // generate：随机指定领域 × 结构核心
  'generate-direction': `
    <div class="cv">
      <div class="row" style="gap:${s.gap + 10}px">
        <div class="grp"><span class="e" style="font-size:${s.e2}">🎲</span><span class="lbl">随机抽</span></div>
        <span class="arw" style="font-size:${s.ar}">➜</span>
        <div class="grp">
          <div class="row" style="gap:10px">
            <span class="e" style="font-size:${s.e3}">🎪</span>
            <span class="cap" style="font-size:${Math.round(DS.lbl * 1.6 * S)}px">×</span>
            <span class="e" style="font-size:${s.e3}">🔗</span>
          </div>
          <span class="lbl">具体领域 × 结构核心</span>
        </div>
        <span class="arw" style="font-size:${s.ar}">➜</span>
        <div class="grp"><span class="e" style="font-size:${s.e2}">🔎</span><span class="lbl">去那里找真事</span></div>
      </div>
    </div>`,

  // 三种处境对应不同素材
  'three-needs': `
    <div class="cv">
      <div class="row" style="gap:${s.gapL}px;align-items:flex-start">
        <div class="grp">
          <div class="row" style="gap:8px"><span class="e" style="font-size:${s.e3}">🔬</span><span class="arw" style="font-size:${s.ars}">➜</span><span class="e" style="font-size:${s.e3}">📐</span></div>
          <span class="lbl">要总结规律</span>
          <span class="sm">他域规律 · 形式系统</span>
        </div>
        <div class="grp">
          <div class="row" style="gap:8px"><span class="e" style="font-size:${s.e3}">🛠️</span><span class="arw" style="font-size:${s.ars}">➜</span><span class="e" style="font-size:${s.e3}">✅</span></div>
          <span class="lbl">要解决具体问题</span>
          <span class="sm">他域做法 · 生活观察</span>
        </div>
        <div class="grp">
          <div class="row" style="gap:8px"><span class="e" style="font-size:${s.e3}">🎨</span><span class="arw" style="font-size:${s.ars}">➜</span><span class="e" style="font-size:${s.e3}">✨</span></div>
          <span class="lbl">要找「有趣」</span>
          <span class="sm">艺术结构 · 反直觉发现</span>
        </div>
      </div>
    </div>`,

  // 三层机制各配一个真实例子（上一版漏了例子，观众看不懂「关系映射」这类词）
  'three-levels': `
    <div class="cv">
      <div class="row" style="gap:${s.gapL}px;align-items:flex-start">
        <div class="grp">
          <div class="row" style="gap:8px"><span class="e" style="font-size:${s.e3}">🪐</span><span class="arw" style="font-size:${s.ars}">➜</span><span class="e" style="font-size:${s.e3}">⚛️</span></div>
          <span class="lbl">关系映射</span>
          <span class="sm">波尔借太阳系的形状</span>
        </div>
        <div class="grp">
          <div class="row" style="gap:8px"><span class="e" style="font-size:${s.e3}">🎷</span><span class="arw" style="font-size:${s.ars}">✕</span><span class="e" style="font-size:${s.e3}">📐</span></div>
          <span class="lbl">约束违反</span>
          <span class="sm">爵士乐手故意离调</span>
        </div>
        <div class="grp">
          <div class="row" style="gap:8px"><span class="e" style="font-size:${s.e3}">🖼️</span><span class="arw" style="font-size:${s.ars}">➜</span><span class="e" style="font-size:${s.e3}">🧊</span></div>
          <span class="lbl">转化式创造</span>
          <span class="sm">毕加索解构古典形式</span>
        </div>
      </div>
    </div>`,

  // 一个实例证明三条机制同时在起作用
  'lister-route': `
    <div class="cv">
      <div class="row" style="gap:28px">
        <div class="grp"><span class="e" style="font-size:${s.e2}">🌾</span><span class="lbl">农业</span><span class="sm">石炭酸能杀菌</span></div>
        <span class="arw" style="font-size:${s.ar}">➜</span>
        <div class="grp"><span class="e" style="font-size:${s.em}">🧠</span><span class="lbl">借的是关系</span><span class="sm">腐败 ← 微生物</span></div>
        <span class="arw" style="font-size:${s.ar}">➜</span>
        <div class="grp"><span class="e" style="font-size:${s.e2}">🏥</span><span class="lbl">外科</span><span class="sm">术前消毒</span></div>
        <span class="arw" style="font-size:${s.ar}">➜</span>
        <div class="grp"><span class="cap">死亡率大降</span><span class="sm">从 45% 到 15%</span></div>
      </div>
    </div>`,

  // 三种处境与可用素材的对应（合并原「三种处境」+「六类素材」）
  'needs-library': `
    <div class="cv">
      <div class="row" style="gap:36px">
        <div class="grp"><span class="e" style="font-size:${s.em}">📐</span><span class="lbl">为具体情况总结规律</span><span class="sm">他域规律 · 形式系统</span></div>
        <span class="arw" style="font-size:${s.ars}">➜</span>
        <div class="grp"><span class="e" style="font-size:${s.em}">🧩</span><span class="lbl">为具体问题找方法</span><span class="sm">他域做法 · 生活观察</span></div>
        <span class="arw" style="font-size:${s.ars}">➜</span>
        <div class="grp"><span class="e" style="font-size:${s.em}">🎨</span><span class="lbl">为创作找「有趣」</span><span class="sm">艺术结构 · 反直觉发现</span></div>
      </div>
    </div>`,

  // 「映射」到底是什么：把两个领域的因果形状对上
  'mapping-def': `
    <div class="cv">
      <div class="row" style="gap:44px;align-items:center">
        <div class="grp"><span class="e" style="font-size:${s.e2}">🌾</span><span class="lbl">麦田里</span><span class="sm">腐败 ⇠ 微生物在繁殖</span></div>
        <div class="grp"><span class="cap">把箭头换成同一件事</span><span class="arw" style="font-size:${s.ar}">⇄</span></div>
        <div class="grp"><span class="e" style="font-size:${s.e2}">🏥</span><span class="lbl">伤口上</span><span class="sm">腐败 ⇠ 微生物在繁殖</span></div>
      </div>
    </div>`,
}

export const SCENARIO_NAMES = Object.keys(ICONS)
export const SCENARIO_CANVAS = { w: W, h: H }

/** 生成一张情境图的完整 HTML。name 未定义时直接报错，避免静默出一张白图。 */
export function scenarioHtml(name) {
  const body = ICONS[name]
  if (!body) throw new Error('未定义的情境图：' + name + '；可用：' + SCENARIO_NAMES.join(', '))
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>${CSS}</style></head><body>${body}</body></html>`
}
