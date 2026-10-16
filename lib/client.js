/**
 * dsh-serendipity — browser half: the settings card with the 素材抽取 switch.
 *
 * A plugin bundle is a *lazy CJS table*: executing the script only registers a
 * factory (`window.__ModuleLoader__.load({ id, factory })`); module bodies — CSS
 * injection included — run at materialization. `require` resolves the modules the
 * host declared in `dsh.client.inject` plus React, so this file needs no bundler.
 *
 * Two deliberate choices:
 *
 * 1. **It talks to the plugin's own HTTP route**, not to the settings-scope card
 *    machinery. That machinery (`settings.plugin.item` + staged forms + the
 *    official field components) is only usable with the SDK's own UI kit, and
 *    hand-writing against it without a browser to test in is how you ship a card
 *    that renders nothing. A plain form over `GET/POST /api/dsh-serendipity/settings`
 *    uses only React and `fetch`, and the route writes through the settings service
 *    anyway — so a GUI change and a hand-edited document take the same path.
 *
 * 2. **Failures stay inside the card.** The web shell fails the whole boot when a
 *    client plugin's `apply` throws, so everything here is defensive: a missing
 *    slot, a failing fetch, or an unexpected payload degrades the card, never the
 *    GUI.
 *
 * The card registers into the official `settings.section` slot, which renders as
 * its own settings page — the same slot the third-party Web UI plugin uses for its
 * 人格设定 / 关于 pages.
 */

window.__ModuleLoader__.load({
  id: '@1603801678/dsh-serendipity',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** Services this client plugin needs before `apply` runs. */
    const inject = ['slots']

    /** Route family owned by the host half of this package. */
    const API = '/api/dsh-serendipity/settings'

    /** The three draw modes, with the copy the card shows. */
    const MODES = [
      {
        value: 'autonomous',
        label: '自主（默认）',
        hint: '工具可用，且在系统提示词里声明；由 agent 自己判断什么时候该抽素材。',
      },
      {
        value: 'onRequest',
        label: '按需',
        hint: '工具可用，但不在提示词里声明——只有你明确要求时才会用。',
      },
      {
        value: 'off',
        label: '关闭',
        hint: '完全不挂载任何工具与提示词段落。',
      },
    ]

    /** Inject the card's stylesheet once (module bodies run at materialization). */
    function ensureStyles() {
      const tagId = '@1603801678/dsh-serendipity/settings-card.css'
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return
      const style = document.createElement('style')
      style.setAttribute('data-plugin-css', tagId)
      style.textContent = [
        '.dsh-ser-card{display:flex;flex-direction:column;gap:14px;padding:4px 0 8px}',
        '.dsh-ser-radio{display:flex;gap:10px;align-items:flex-start;cursor:pointer;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}',
        '.dsh-ser-radio:hover{border-color:var(--dsw-alias-border-l3, var(--dsw-alias-border-l2))}',
        '.dsh-ser-radio input{margin-top:2px}',
        '.dsh-ser-radioLabel{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}',
        '.dsh-ser-hint{margin:2px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
        '.dsh-ser-row{display:flex;gap:8px;align-items:center}',
        '.dsh-ser-button{font:inherit;font-size:13px;padding:6px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-brand-primary, #4d6bfe);color:#fff;cursor:pointer}',
        '.dsh-ser-button:disabled{opacity:.5;cursor:default}',
        '.dsh-ser-buttonGhost{font:inherit;font-size:13px;padding:6px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
        '.dsh-ser-note{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
        '.dsh-ser-error{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-error, #d33)}',
        '.dsh-ser-ok{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
      ].join('\n')
      document.head.appendChild(style)
    }

    /** Read the plugin's effective config from its own route. */
    async function loadConfig() {
      const response = await fetch(API, { headers: { accept: 'application/json' } })
      const payload = await response.json()
      if (payload.ok !== true) throw new Error(payload.error ?? `HTTP ${response.status}`)
      return payload
    }

    /** Merge a patch through the host (which writes via the settings service). */
    async function saveConfig(patch) {
      const response = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const payload = await response.json()
      if (payload.ok !== true) throw new Error(payload.error ?? `HTTP ${response.status}`)
      return payload
    }

    /**
     * The settings card.
     * @returns {object} the card element.
     */
    function SettingsCard() {
      const [config, setConfig] = React.useState(undefined)
      const [draft, setDraft] = React.useState(undefined)
      const [status, setStatus] = React.useState('loading')
      const [error, setError] = React.useState(undefined)
      const [saved, setSaved] = React.useState(false)

      const reload = React.useCallback(() => {
        setStatus('loading')
        setError(undefined)
        loadConfig()
          .then((payload) => {
            setConfig(payload.config ?? {})
            setDraft(payload.config ?? {})
            setStatus('ready')
          })
          .catch((cause) => {
            setError(cause instanceof Error ? cause.message : String(cause))
            setStatus('error')
          })
      }, [])

      React.useEffect(() => { reload() }, [reload])

      const dirty = config !== undefined && draft !== undefined && (
        config.drawMode !== draft.drawMode
        || config.enabled !== draft.enabled
        || config.announceToAgent !== draft.announceToAgent
        || config.sessionReport !== draft.sessionReport
      )

      const save = React.useCallback(() => {
        setError(undefined)
        setSaved(false)
        setStatus('saving')
        saveConfig({
          drawMode: draft.drawMode,
          enabled: draft.enabled,
          announceToAgent: draft.announceToAgent,
          sessionReport: draft.sessionReport,
        })
          .then((payload) => {
            setConfig(payload.config ?? draft)
            setDraft(payload.config ?? draft)
            setStatus('ready')
            setSaved(true)
          })
          .catch((cause) => {
            setError(cause instanceof Error ? cause.message : String(cause))
            setStatus('ready')
          })
      }, [draft])

      if (status === 'loading') {
        return h('p', { className: 'dsh-ser-note' }, '正在读取配置…')
      }
      if (status === 'error') {
        return h('div', { className: 'dsh-ser-card' }, [
          h('p', { className: 'dsh-ser-error', key: 'e' }, `读取配置失败：${error}`),
          h('p', { className: 'dsh-ser-note', key: 'h' },
            '插件本身不受影响。可以用 node tools/set-config.mjs 改，或直接编辑 profile 的 cordis.patch.yml 里 serendipity 条目的 config。'),
          h('div', { className: 'dsh-ser-row', key: 'r' },
            h('button', { type: 'button', className: 'dsh-ser-buttonGhost', onClick: reload }, '重试')),
        ])
      }

      const set = (key, value) => {
        setSaved(false)
        setDraft((previous) => ({ ...previous, [key]: value }))
      }

      return h('div', { className: 'dsh-ser-card' }, [
        h('div', { key: 'modes' }, MODES.map((mode) => h('label', {
          key: mode.value,
          className: 'dsh-ser-radio',
          style: { marginBottom: 6 },
        }, [
          h('input', {
            key: 'i',
            type: 'radio',
            name: 'dsh-ser-draw-mode',
            checked: draft.drawMode === mode.value,
            disabled: status === 'saving',
            onChange: () => set('drawMode', mode.value),
          }),
          h('span', { key: 't' }, [
            h('span', { className: 'dsh-ser-radioLabel', key: 'l' }, mode.label),
            h('p', { className: 'dsh-ser-hint', key: 'h' }, mode.hint),
          ]),
        ]))),

        h('label', { key: 'enabled', className: 'dsh-ser-radio' }, [
          h('input', {
            key: 'i',
            type: 'checkbox',
            checked: draft.enabled === true,
            disabled: status === 'saving',
            onChange: (event) => set('enabled', event.target.checked),
          }),
          h('span', { key: 't' }, [
            h('span', { className: 'dsh-ser-radioLabel', key: 'l' }, '总开关'),
            h('p', { className: 'dsh-ser-hint', key: 'h' }, '关掉等价于把抽取模式设为「关闭」。'),
          ]),
        ]),

        h('label', { key: 'announce', className: 'dsh-ser-radio' }, [
          h('input', {
            key: 'i',
            type: 'checkbox',
            checked: draft.announceToAgent === true,
            disabled: status === 'saving' || draft.drawMode !== 'autonomous',
            onChange: (event) => set('announceToAgent', event.target.checked),
          }),
          h('span', { key: 't' }, [
            h('span', { className: 'dsh-ser-radioLabel', key: 'l' }, '在系统提示词里声明本插件'),
            h('p', { className: 'dsh-ser-hint', key: 'h' },
              draft.drawMode === 'autonomous'
                ? '只在「自主」模式下有意义；关掉后 agent 不会被告知这个能力存在。'
                : '仅在「自主」模式下生效（当前模式不会声明）。'),
          ]),
        ]),

        h('label', { key: 'session', className: 'dsh-ser-radio' }, [
          h('input', {
            key: 'i',
            type: 'checkbox',
            checked: draft.sessionReport === true,
            disabled: status === 'saving',
            onChange: (event) => set('sessionReport', event.target.checked),
          }),
          h('span', { key: 't' }, [
            h('span', { className: 'dsh-ser-radioLabel', key: 'l' }, '会话报告'),
            h('p', { className: 'dsh-ser-hint', key: 'h' },
              '记录每次会话的抽取指标（第几步首次抽、抽了几条、多少条写明落点），'
              + '在 serendipity_stats 与 /api/dsh-serendipity/sessions 里可查。关掉后完全不记录。'),
          ]),
        ]),

        h('div', { className: 'dsh-ser-row', key: 'actions' }, [
          h('button', {
            key: 'save',
            type: 'button',
            className: 'dsh-ser-button',
            disabled: status === 'saving' || !dirty,
            onClick: save,
          }, status === 'saving' ? '保存中…' : (dirty ? '保存' : '已保存')),
          h('button', {
            key: 'reset',
            type: 'button',
            className: 'dsh-ser-buttonGhost',
            disabled: status === 'saving' || !dirty,
            onClick: () => { setDraft(config); setSaved(false); setError(undefined) },
          }, '撤销改动'),
        ]),

        saved && !dirty
          ? h('p', { key: 'ok', className: 'dsh-ser-ok' }, '已保存，立即生效——不需要重启 dsh web。')
          : null,
        error !== undefined
          ? h('p', { key: 'err', className: 'dsh-ser-error' }, error)
          : null,
        h('p', { key: 'foot', className: 'dsh-ser-note' },
          '改动经设置服务写进 profile 的 cordis.patch.yml（serendipity 条目的 config），工具与提示词段落随即重新注册。'),
      ])
    }

    /**
     * Register the settings page.
     * @param {object} ctx - client root context.
     */
    function apply(ctx) {
      try {
        if (ctx.slots === undefined) return
        ensureStyles()
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'serendipity',
          order: 60,
          label: () => '素材抽取（缪斯）',
          inject: () => ({}),
        }, SettingsCard))
      } catch (error) {
        // A client plugin that throws takes the whole shell boot down with it.
        console.error('[dsh-serendipity] client apply failed:', error)
      }
    }

    return { apply, inject }
  },
})
