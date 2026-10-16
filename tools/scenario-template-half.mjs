// 半幅情境图的 HTML 模板（被 build-scenario-images.mjs 调用）。
//
// 关键：`image-right` 的图框是 8.28×4.66 英寸 ≈ **1.78:1**（横向很宽）。
// 出竖构图（比如 0.9:1）会被 `object-fit: contain` 缩到贴合高度，横向只占三分之一，
// 屏幕上看起来图很小——这是实测踩过的坑。所以这里出 **1.5:1**，构图以横向为主，
// 竖向排布也要拆成左右两列。
const W = 2160
const H = 1440
const S = 1.0

const CSS = `
  html,body{margin:0;width:${W}px;height:${H}px;background:#fff;overflow:hidden}
  .cv{position:relative;width:${W}px;height:${H}px;background:#fff;
      font-family:"Microsoft YaHei","Noto Sans SC",sans-serif;color:#111;
      display:flex;flex-direction:column;justify-content:center;align-items:center;gap:34px}
  .e{font-family:"Segoe UI Emoji";line-height:1;font-size:${Math.round(190 * S)}px}
  .arw{font-family:"Segoe UI Symbol",sans-serif;color:#111;line-height:1;font-size:${Math.round(104 * S)}px}
  .lbl{font-size:${Math.round(42 * S)}px;color:#111;text-align:center;line-height:1.26;max-width:2000px}
  .sm{font-size:${Math.round(34 * S)}px;color:#6B6B6B;text-align:center;line-height:1.28;max-width:2000px}
  .cap{font-size:${Math.round(48 * S)}px;font-weight:700;color:#C00000;text-align:center;line-height:1.26;max-width:2000px}
  .row{display:flex;align-items:center;justify-content:center;gap:34px}
  .grp{display:flex;flex-direction:column;align-items:center;gap:14px}
  .card{display:flex;flex-direction:column;align-items:center;gap:14px;
        border:3px solid #111;border-radius:20px;padding:26px 34px;background:#fff}
  .cardhl{border-color:#C00000;border-width:5px}
`

const ICONS = {
  // 映射是什么：两个领域的因果箭头对上（左右并排，横向构图）
  'half-mapping-def': `
    <div class="cv">
      <div class="row" style="gap:60px">
        <div class="card" style="min-width:760px">
          <span class="e" style="font-size:${Math.round(200 * S)}px">🌾</span>
          <span class="lbl">麦田里</span>
          <span class="sm">腐败 ⇠ 微生物在繁殖</span>
        </div>
        <div class="grp"><span class="cap">把箭头换成同一件事</span><span class="arw" style="font-size:${Math.round(130 * S)}px">⇄</span></div>
        <div class="card cardhl" style="min-width:760px">
          <span class="e" style="font-size:${Math.round(200 * S)}px">🏥</span>
          <span class="lbl">伤口上</span>
          <span class="sm">腐败 ⇠ 微生物在繁殖</span>
        </div>
      </div>
    </div>`,

  // 三种处境 → 可用素材（三列并排）
  'half-needs-library': `
    <div class="cv">
      <div class="row" style="gap:56px;align-items:flex-start">
        <div class="grp"><span class="e">📐</span><span class="lbl">要总结规律</span><span class="sm">他域规律 · 形式系统</span></div>
        <div class="grp"><span class="e">🧩</span><span class="lbl">要解决问题</span><span class="sm">他域做法 · 生活观察</span></div>
        <div class="grp"><span class="e">🎨</span><span class="lbl">要找「有趣」</span><span class="sm">艺术结构 · 反直觉发现</span></div>
      </div>
    </div>`,

  // collide：同一形状的两个远域
  'half-collide': `
    <div class="cv">
      <div class="row" style="gap:110px">
        <div class="grp"><span class="e" style="font-size:${Math.round(210 * S)}px">🐺</span><span class="lbl">生态学</span></div>
        <div class="grp"><span class="cap">同一个形状</span><span class="arw" style="font-size:${Math.round(130 * S)}px">⇄</span><span class="sm">捕食者–猎物周期</span></div>
        <div class="grp"><span class="e" style="font-size:${Math.round(210 * S)}px">🔧</span><span class="lbl">工程学</span></div>
      </div>
    </div>`,

  // generate：随机抽「领域 × 结构核心」
  'half-generate-direction': `
    <div class="cv">
      <div class="row" style="gap:44px">
        <div class="grp"><span class="e" style="font-size:${Math.round(180 * S)}px">🎲</span><span class="lbl">随机抽</span></div>
        <span class="arw">➜</span>
        <div class="card cardhl" style="min-width:900px">
          <div class="row" style="gap:20px">
            <span class="e" style="font-size:${Math.round(190 * S)}px">🎪</span>
            <span class="cap" style="font-size:${Math.round(70 * S)}px">×</span>
            <span class="e" style="font-size:${Math.round(190 * S)}px">🔗</span>
          </div>
          <span class="lbl">具体领域 × 结构核心</span>
        </div>
        <span class="arw">➜</span>
        <div class="grp"><span class="e" style="font-size:${Math.round(180 * S)}px">🔎</span><span class="lbl">去找真事</span></div>
      </div>
    </div>`,

  // 覆盖度权重三档
  'half-coverage-weight': `
    <div class="cv">
      <div class="row" style="gap:70px;align-items:flex-start">
        <div class="grp"><span class="e">✅</span><span class="lbl">读得多的</span><span class="cap">×0.85</span></div>
        <div class="grp"><span class="e">➖</span><span class="lbl">样本不足</span><span class="cap" style="color:#6B6B6B">不调整</span></div>
        <div class="grp"><span class="e">🌟</span><span class="lbl">没读过的</span><span class="cap">×1.25</span></div>
      </div>
    </div>`,

  // 延迟兑现（四步横向）
  'half-delayed-payoff': `
    <div class="cv">
      <div class="row" style="gap:26px">
        <div class="grp"><span class="e" style="font-size:${Math.round(170 * S)}px">📦</span><span class="lbl">读过</span></div>
        <span class="arw" style="font-size:${Math.round(96 * S)}px">➜</span>
        <div class="grp"><span class="e" style="font-size:${Math.round(170 * S)}px">🤷</span><span class="lbl">当时没用</span></div>
        <span class="arw" style="font-size:${Math.round(96 * S)}px">➜</span>
        <div class="grp"><span class="e" style="font-size:${Math.round(170 * S)}px">⏳</span><span class="lbl">放很久</span></div>
        <span class="arw" style="font-size:${Math.round(96 * S)}px">➜</span>
        <div class="grp"><span class="e" style="font-size:${Math.round(170 * S)}px">💡</span><span class="lbl">后来有用</span></div>
      </div>
      <div class="sm">每次 draw 递回一两条最老的旧素材</div>
    </div>`,
}

export const HALF_SCENARIO_NAMES = Object.keys(ICONS)
export const HALF_SCENARIO_CANVAS = { w: W, h: H }

export function halfScenarioHtml(name) {
  const body = ICONS[name]
  if (!body) throw new Error('未定义的半幅情境图：' + name + '；可用：' + HALF_SCENARIO_NAMES.join(', '))
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>${CSS}</style></head><body>${body}</body></html>`
}
