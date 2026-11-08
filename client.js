/**
 * dsh-mission-control — Web Client half.
 *
 * One surface: a command card above the composer (`conversation.input.dock`).
 * It polls the Host's read-only snapshot route and draws the live command tree:
 * secretary → commander → workers, with status, current action, elapsed time,
 * the recent timeline and the report cadence.
 *
 * The card renders nothing until a mission exists, so a normal session stays
 * exactly as it was.
 */

window.__ModuleLoader__.load({
  id: 'dsh-mission-control',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const API = '/dsh-mission/api'
    const POLL_MS = 2500

    // ------------------------------------------------------------- i18n

    const STRINGS = {
      zh: {
        title: '任务大厅',
        commander: '指挥官',
        worker: '工人',
        running: '运行中',
        idle: '空闲',
        offline: '未启动',
        reporting: '汇报间隔',
        seconds: '秒',
        save: '保存',
        saved: '已保存',
        plan: '任务简报',
        missions: '任务组',
        timeline: '时间线',
        noTimeline: '还没有事件',
        nextReport: '下次汇报',
        overdue: '即将汇报',
        expand: '展开',
        collapse: '收起',
        total: '总任务',
        active: '在跑',
        elapsed: '已用',
        empty: '指挥官还没有派工。',
        simulate: '模拟汇报',
      },
      en: {
        title: 'Mission Control',
        commander: 'Commander',
        worker: 'Worker',
        running: 'running',
        idle: 'idle',
        offline: 'offline',
        reporting: 'Report every',
        seconds: 's',
        save: 'Save',
        saved: 'Saved',
        plan: 'Brief',
        missions: 'Missions',
        timeline: 'Timeline',
        noTimeline: 'No events yet',
        nextReport: 'Next report',
        overdue: 'due now',
        expand: 'Expand',
        collapse: 'Collapse',
        total: 'Tasks',
        active: 'Active',
        elapsed: 'Elapsed',
        empty: 'The commander has not delegated yet.',
        simulate: 'Nudge report',
      },
    }

    function detectLang(ctx) {
      try {
        const snap = ctx.locale && ctx.locale.getSnapshot && ctx.locale.getSnapshot()
        const id = snap && (snap.id || snap.locale || snap.language)
        if (id) return String(id).toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
      } catch { /* fall through */ }
      try {
        if (typeof navigator !== 'undefined' && navigator.language) {
          return navigator.language.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
        }
      } catch { /* ignore */ }
      return 'en'
    }

    // ------------------------------------------------------------ helpers

    const pad = (n) => (n < 10 ? `0${n}` : `${n}`)

    function clock(ms) {
      if (!ms) return '—'
      const d = new Date(ms)
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    }

    function duration(sec) {
      if (sec == null || !Number.isFinite(sec)) return '—'
      const s = Math.max(0, Math.round(sec))
      const m = Math.floor(s / 60)
      if (m < 60) return `${m}:${pad(s % 60)}`
      return `${Math.floor(m / 60)}:${pad(m % 60)}:${pad(s % 60)}`
    }

    function statusLabel(status, t) {
      if (status === 'running') return t.running
      if (status === 'idle') return t.idle
      return t.offline
    }

    function Dot({ status }) {
      return h('span', {
        className: `dmc-dot ${status || 'offline'}`,
        'aria-hidden': true,
      })
    }

    function Stat({ label, value, accent }) {
      return h(
        'div',
        { className: 'dmc-stat' },
        h('div', { className: 'dmc-stat-value', style: accent ? { color: 'var(--dsw-alias-brand-primary)' } : null }, value),
        h('div', { className: 'dmc-stat-label' }, label),
      )
    }

    // -------------------------------------------------------------- data

    function useSnapshot(sessionId) {
      const [snap, setSnap] = useState(null)
      const [failed, setFailed] = useState(0)
      const alive = useRef(true)

      const load = useCallback(async () => {
        if (!sessionId) return
        try {
          const res = await fetch(`${API}/snapshot?sessionId=${encodeURIComponent(sessionId)}`, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const data = await res.json()
          if (!alive.current) return
          setSnap(data)
          setFailed(0)
        } catch {
          if (!alive.current) return
          setFailed((n) => n + 1)
        }
      }, [sessionId])

      useEffect(() => {
        alive.current = true
        if (!sessionId) return undefined
        load()
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return
          load()
        }, POLL_MS)
        return () => {
          alive.current = false
          clearInterval(timer)
        }
      }, [sessionId, load])

      return { snap, failed, reload: load }
    }

    // -------------------------------------------------------------- card

    function MissionCard(props) {
      const ctx = props.__ctx
      const lang = props.__lang
      const t = STRINGS[lang]
      const sessionId = props.sessionId || (props.session && props.session.id)
      const { snap, failed, reload } = useSnapshot(sessionId)
      const [open, setOpen] = useState(false)
      const [draft, setDraft] = useState('')
      const [saving, setSaving] = useState(false)
      const [savedAt, setSavedAt] = useState(0)
      const [nudging, setNudging] = useState(false)

      const mission = snap && snap.mission
      if (!mission) return null

      const counts = mission.counts || { total: 0, running: 0, idle: 0, offline: 0 }
      const commander = mission.commander
      const workers = mission.workers || []
      const groups =
        mission.groups && mission.groups.length
          ? mission.groups
          : commander
            ? [{ commander, workers, brief: mission.brief, startedAt: commander.firstSeenAt }]
            : []
      const allWorkers = groups.reduce((acc, g) => acc.concat(g.workers || []), [])
      const extraGroups = Math.max(0, groups.length - 1)
      const loose = mission.loose || []
      const events = mission.events || []
      const interval = (snap.config && snap.config.reportIntervalSec) || 120
      const draftValue = draft === '' ? String(interval) : draft

      const activeColor =
        counts.running > 0 ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-state-success-primary)'

      async function saveInterval() {
        const value = Number(draftValue)
        if (!Number.isFinite(value) || value < 15 || value > 3600) return
        setSaving(true)
        try {
          const res = await fetch(`${API}/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ reportIntervalSec: value }),
          })
          if (res.ok) {
            setSavedAt(Date.now())
            setDraft('')
            reload()
          }
        } catch { /* keep the old value */ }
        setSaving(false)
      }

      async function nudge() {
        setNudging(true)
        try {
          await fetch(`${API}/tick?sessionId=${encodeURIComponent(sessionId)}`, {
            method: 'POST',
            headers: { accept: 'application/json' },
          })
          reload()
        } catch { /* ignore */ }
        setTimeout(() => setNudging(false), 1200)
      }

      const head = h(
        'div',
        {
          className: 'dmc-bar',
          role: 'button',
          tabIndex: 0,
          onClick: () => setOpen((v) => !v),
          onKeyDown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') setOpen((v) => !v)
          },
          'aria-expanded': open,
        },
        h('span', { className: `dmc-radar ${counts.running > 0 ? 'live' : ''}`, 'aria-hidden': true },
          h('span', { className: 'dmc-radar-core' })),
        h('span', { className: 'dmc-title' }, t.title),
        h('span', { className: 'dmc-sep' }),
        commander
          ? h(
              'span',
              { className: 'dmc-commander' },
              h(Dot, { status: commander.status }),
              h('span', { className: 'dmc-commander-name' }, commander.label || t.commander),
              h('span', { className: 'dmc-muted' },
                counts.running > 0
                  ? `${counts.running} ${t.active}`
                  : statusLabel(commander.status, t)),
              extraGroups > 0
                ? h('span', { className: 'dmc-more' }, `+${extraGroups}`)
                : null,
              commander.lastTool
                ? h('code', { className: 'dmc-tool' }, commander.lastTool)
                : null,
            )
          : h('span', { className: 'dmc-muted' }, t.empty),
        h('span', { className: 'dmc-grow' }),
        h(
          'span',
          { className: 'dmc-pips', title: `${t.total}: ${counts.total}` },
          allWorkers.slice(0, 8).map((w) =>
            h('span', {
              key: w.id,
              className: `dmc-pip ${w.status}`,
              title: `${w.label || t.worker} · ${statusLabel(w.status, t)}`,
            }),
          ),
          allWorkers.length > 8 ? h('span', { className: 'dmc-more' }, `+${allWorkers.length - 8}`) : null,
        ),
        h('span', { className: 'dmc-num' }, duration(mission.elapsedSec)),
        snap.ticker && snap.ticker.nextTickAt
          ? h('span', { className: 'dmc-muted dmc-next' },
              `${t.nextReport} ${duration(Math.max(0, (snap.ticker.nextTickAt - Date.now()) / 1000))}`)
          : null,
        h('span', { className: 'dmc-chevron' }, open ? '▴' : '▾'),
      )

      const body = open
        ? h(
            'div',
            { className: 'dmc-body' },
            h(
              'div',
              { className: 'dmc-stats' },
              h(Stat, { label: t.total, value: counts.total }),
              h(Stat, { label: t.active, value: counts.running, accent: counts.running > 0 }),
              h(Stat, { label: t.elapsed, value: duration(mission.elapsedSec) }),
              h(Stat, { label: t.reporting, value: `${interval}s` }),
            ),
            h(
              'div',
              { className: 'dmc-section' },
              h('div', { className: 'dmc-section-title' }, t.missions),
              groups.length === 0
                ? h('div', { className: 'dmc-empty' }, t.empty)
                : groups.map((g, gi) =>
                    h(
                      'div',
                      { key: g.commander.id, className: 'dmc-group' },
                      h(
                        'div',
                        { className: 'dmc-node dmc-node-root' },
                        h(
                          'span',
                          { className: 'dmc-node-badge' },
                          groups.length > 1 ? `${t.commander} ${gi + 1}` : t.commander,
                        ),
                        h(Dot, { status: g.commander.status }),
                        h('span', { className: 'dmc-node-label' }, g.commander.label || t.commander),
                        h('span', { className: 'dmc-muted' },
                          `${statusLabel(g.commander.status, t)}${g.commander.lastTool ? ` · ${g.commander.lastTool}` : ''}`),
                        g.startedAt
                          ? h('span', { className: 'dmc-node-time' }, clock(g.startedAt))
                          : null,
                      ),
                      g.brief
                        ? h('div', { className: 'dmc-group-brief' }, g.brief)
                        : null,
                      (g.workers || []).length === 0
                        ? h('div', { className: 'dmc-empty' }, t.empty)
                        : h(
                            'div',
                            { className: 'dmc-workers' },
                            (g.workers || []).map((w) =>
                              h(
                                'div',
                                { key: w.id, className: 'dmc-node' },
                                h('span', { className: 'dmc-node-branch', 'aria-hidden': true }, '└'),
                                h(Dot, { status: w.status }),
                                h('span', { className: 'dmc-node-label' }, w.label || w.id.slice(0, 8)),
                                h('span', { className: 'dmc-muted' },
                                  `${statusLabel(w.status, t)}${w.lastTool ? ` · ${w.lastTool}` : ''}`),
                              ),
                            ),
                          ),
                    ),
                  ),
              loose.length > 0
                ? h(
                    'div',
                    { className: 'dmc-loose' },
                    loose.map((n) =>
                      h('div', { key: n.id, className: 'dmc-node' },
                        h(Dot, { status: n.status }),
                        h('span', { className: 'dmc-node-label' }, n.label || n.id.slice(0, 8)),
                        h('span', { className: 'dmc-muted' }, statusLabel(n.status, t)),
                      ),
                    ),
                  )
                : null,
            ),
            h(
              'div',
              { className: 'dmc-section' },
              h('div', { className: 'dmc-section-title' }, t.timeline),
              events.length === 0
                ? h('div', { className: 'dmc-empty' }, t.noTimeline)
                : h(
                    'div',
                    { className: 'dmc-events' },
                    events.slice(0, 8).map((e, i) =>
                      h(
                        'div',
                        { key: `${e.t}-${i}`, className: 'dmc-event' },
                        h('span', { className: 'dmc-event-time' }, clock(e.t)),
                        h('span', { className: `dmc-event-kind ${e.kind}` }, e.kind),
                        h('span', { className: 'dmc-event-text' }, e.text),
                      ),
                    ),
                  ),
            ),
            h(
              'div',
              { className: 'dmc-footer' },
              h('label', { className: 'dmc-field' },
                h('span', null, t.reporting),
                h('input', {
                  className: 'dmc-input',
                  type: 'number',
                  min: 15,
                  max: 3600,
                  value: draftValue,
                  onChange: (e) => setDraft(e.target.value),
                }),
                h('span', null, t.seconds),
              ),
              h('button', {
                className: 'dmc-btn',
                onClick: saveInterval,
                disabled: saving || Number(draftValue) === interval,
              }, saving ? '…' : (Date.now() - savedAt < 2500 ? t.saved : t.save)),
              h('button', { className: 'dmc-btn ghost', onClick: nudge, disabled: nudging },
                nudging ? '…' : t.simulate),
              h('span', { className: 'dmc-grow' }),
              h('span', { className: 'dmc-muted dmc-source' }, mission.source || ''),
            ),
          )
        : null

      return h('div', { className: `dmc ${counts.running > 0 ? 'live' : ''}` }, head, body)
    }

    // ------------------------------------------------------------- styles

    const CSS = `
.dmc { border:1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  border-radius: 14px; margin: 0 0 8px; overflow: hidden; color: var(--dsw-alias-label-primary);
  font-size: 13px; line-height: 1.45; }
.dmc.live { box-shadow: inset 2px 0 0 var(--dsw-alias-brand-primary); }
.dmc-bar { display:flex; align-items:center; gap:8px; padding:9px 12px; cursor:pointer;
  user-select:none; min-height: 38px; }
.dmc-bar:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset:-2px; }
.dmc-bar:hover { background: var(--dsw-alias-bg-layer-2); }
.dmc-radar { width:14px; height:14px; border-radius:50%; border:1.5px solid var(--dsw-alias-border-l2);
  display:inline-flex; align-items:center; justify-content:center; flex:0 0 auto; }
.dmc-radar.live { border-color: var(--dsw-alias-brand-primary); }
.dmc-radar-core { width:5px; height:5px; border-radius:50%; background: var(--dsw-alias-label-secondary); }
.dmc-radar.live .dmc-radar-core { background: var(--dsw-alias-brand-primary); animation: dmc-pulse 1.6s ease-in-out infinite; }
@keyframes dmc-pulse { 0%,100% { opacity:1; transform:scale(1);} 50% { opacity:.35; transform:scale(.75);} }
.dmc-title { font-weight: 600; letter-spacing: .02em; white-space:nowrap; }
.dmc-sep { width:1px; height:14px; background: var(--dsw-alias-border-l1); }
.dmc-commander { display:flex; align-items:center; gap:6px; min-width:0; }
.dmc-commander-name { font-weight:500; max-width: 160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dmc-muted { color: var(--dsw-alias-label-secondary); font-size:12px; white-space:nowrap; }
.dmc-tool { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:11px; padding:1px 6px;
  border-radius:6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.dmc-dot { width:7px; height:7px; border-radius:50%; flex:0 0 auto; background: var(--dsw-alias-state-idle-primary); }
.dmc-dot.running { background: var(--dsw-alias-brand-primary); animation: dmc-pulse 1.6s ease-in-out infinite; }
.dmc-dot.idle { background: var(--dsw-alias-state-success-primary); }
.dmc-dot.offline { background: var(--dsw-alias-border-l2); }
.dmc-grow { flex:1 1 auto; }
.dmc-pips { display:flex; gap:3px; align-items:center; }
.dmc-pip { width:6px; height:6px; border-radius:2px; background: var(--dsw-alias-border-l2); }
.dmc-pip.running { background: var(--dsw-alias-brand-primary); }
.dmc-pip.idle { background: var(--dsw-alias-state-success-primary); }
.dmc-more { font-size:10px; color: var(--dsw-alias-label-secondary); }
.dmc-num { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px;
  color: var(--dsw-alias-label-secondary); }
.dmc-next { display:none; }
@media (min-width: 720px) { .dmc-next { display:inline; } }
.dmc-chevron { color: var(--dsw-alias-label-secondary); }
.dmc-body { border-top:1px solid var(--dsw-alias-border-l1); padding: 10px 12px 12px; max-height: 46vh; overflow:auto; }
.dmc-stats { display:flex; gap:18px; margin-bottom:10px; }
.dmc-stat-value { font-size:15px; font-weight:600; font-variant-numeric: tabular-nums; }
.dmc-stat-label { font-size:11px; color: var(--dsw-alias-label-secondary); }
.dmc-section { margin-top: 10px; }
.dmc-section-title { font-size:11px; letter-spacing:.08em; text-transform:uppercase;
  color: var(--dsw-alias-label-secondary); margin-bottom:6px; }
.dmc-brief { white-space:pre-wrap; max-height:78px; overflow:hidden; padding:8px 10px;
  border-radius:8px; background: var(--dsw-alias-bg-layer-2); font-size:12px;
  display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; }
.dmc-node { display:flex; align-items:center; gap:7px; padding:5px 0; min-width:0; }
.dmc-group { margin-bottom: 12px; }
.dmc-group:last-child { margin-bottom: 0; }
.dmc-group-brief { font-size:12px; color: var(--dsw-alias-label-secondary); padding:2px 0 3px 18px;
  display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.dmc-loose { border-top:1px dashed var(--dsw-alias-border-l1); margin-top:8px; padding-top:6px; }
.dmc-node-root { border-bottom:1px dashed var(--dsw-alias-border-l1); }
.dmc-node-badge { font-size:10px; padding:1px 6px; border-radius:999px; background:
  color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent); color: var(--dsw-alias-brand-primary);
  font-weight:600; }
.dmc-node-branch { color: var(--dsw-alias-border-l2); margin-left:6px; }
.dmc-node-label { font-size:12px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dmc-node-time { margin-left:auto; font-size:11px; color: var(--dsw-alias-label-secondary); }
.dmc-empty { color: var(--dsw-alias-label-secondary); font-size:12px; padding:6px 0; }
.dmc-events { display:flex; flex-direction:column; gap:3px; }
.dmc-event { display:flex; gap:8px; align-items:baseline; font-size:12px; }
.dmc-event-time { font-family: ui-monospace, monospace; font-size:11px; color: var(--dsw-alias-label-secondary); }
.dmc-event-kind { font-size:10px; padding:0 5px; border-radius:4px; background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary); }
.dmc-event-kind.dispatch { color: var(--dsw-alias-brand-primary); }
.dmc-event-kind.end { color: var(--dsw-alias-state-success-primary); }
.dmc-event-text { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dmc-footer { display:flex; align-items:center; gap:8px; margin-top:12px; padding-top:10px;
  border-top:1px solid var(--dsw-alias-border-l1); }
.dmc-field { display:flex; align-items:center; gap:6px; font-size:12px; color: var(--dsw-alias-label-secondary); }
.dmc-input { width:64px; padding:4px 6px; border-radius:6px; border:1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size:12px; }
.dmc-btn { padding:4px 10px; border-radius:7px; border:1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size:12px; cursor:pointer; }
.dmc-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
.dmc-btn:disabled { opacity:.45; cursor: default; }
.dmc-btn.ghost { background: transparent; }
.dmc-source { text-transform: uppercase; letter-spacing:.08em; font-size:10px; }
`

    // --------------------------------------------------------------- apply

    return {
      inject: ['slots'],
      apply(ctx) {
        const lang = detectLang(ctx)

        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-dsh-plugin', 'mission-control')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => {
            try { style.remove() } catch { /* page teardown */ }
          }
        })

        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: 'mission-control',
              order: 30,
              label: () => STRINGS[lang].title,
            },
            (props) => h(MissionCard, { ...props, __ctx: ctx, __lang: lang }),
          ),
        )
      },
    }
  },
})
