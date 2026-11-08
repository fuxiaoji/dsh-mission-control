/**
 * dsh-mission-control — Host half.
 *
 * What this plugin owns:
 *   1. the mission registry      — which secretary session dispatched which brief,
 *                                  when it started, and what happened since;
 *   2. the read-only status tool — `mission_status`, registered on the Host tool
 *                                  registry and refused for non-secretary callers;
 *   3. the report ticker         — wakes an idle secretary every N seconds with a
 *                                  [[MISSION_TICK]] prompt so it reports progress;
 *   4. the panel transport       — GET/POST /dsh-mission/api/*, same-origin JSON
 *                                  behind the Harness connection trust fence.
 *
 * It deliberately owns no spawning code: the secretary's `dispatch` tool is a
 * stock `@deepseek-ai/dsh-tool-subagent` instance pointed at the `commander`
 * preset, so child creation, depth limits, cancellation and cleanup stay with
 * the Harness. We observe; the Harness drives.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  countNodes,
  firstLine,
  groupTree,
  nodeOf as toNode,
  normalizeConfig,
} from './lib/pure.js'

export const name = 'dsh-mission-control'

export const inject = [
  'agents',
  'subagents',
  'agentPresets',
  'webServer',
  'connection',
  'timer',
  'tools',
]

const NAME = 'dsh-mission-control'
const ROUTE_PREFIX = '/dsh-mission/api'

const nowIso = () => new Date().toISOString()

/**
 * A complete, identified user message. `followup` accepts a message value and
 * commits it straight into history, so every field the wire needs must be here:
 * a partial `{ content, source }` lands in the log without a `role` and the
 * provider rejects the next request with "missing field role".
 */
function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config)

  const stateDir = path.join(dshHome(), 'mission-control')
  const statePath = path.join(stateDir, 'state.json')

  /** secretaryId -> mission record */
  const missions = new Map()
  /** agentId -> { tool, at } */
  const activity = new Map()
  /** agentId -> first time we saw it */
  const seen = new Map()
  /** agentId -> disposer */
  const tickers = new Map()
  /** agentId -> last tick wall clock */
  const lastTick = new Map()
  /** secretaryId -> { at, value } — coalesces HTTP polls with tool calls */
  const snapCache = new Map()

  let saveTimer = null
  let disposed = false

  // ---------------------------------------------------------------- state

  function loadState() {
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      if (raw && Array.isArray(raw.missions)) {
        for (const m of raw.missions) {
          if (m && m.secretaryId) {
            if (!m.briefs || typeof m.briefs !== 'object') m.briefs = {}
            missions.set(String(m.secretaryId), m)
          }
        }
      }
    } catch { /* first run, or a corrupt file we simply rebuild */ }
  }

  function scheduleSave() {
    if (disposed || saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      flush()
    }, 400)
    if (typeof saveTimer.unref === 'function') saveTimer.unref()
  }

  function flush() {
    if (disposed) return
    try {
      fs.mkdirSync(stateDir, { recursive: true })
      const payload = {
        version: 1,
        updatedAt: nowIso(),
        missions: [...missions.values()].slice(-50),
      }
      fs.writeFileSync(statePath, `${JSON.stringify(payload, null, 2)}\n`)
    } catch (err) {
      console.warn(`[${NAME}] could not persist mission state:`, err?.message ?? err)
    }
  }

  loadState()

  function mission(secretaryId) {
    let m = missions.get(secretaryId)
    if (!m) {
      m = {
        secretaryId,
        brief: '',
        briefs: {},
        startedAt: null,
        updatedAt: null,
        commanderId: null,
        events: [],
      }
      missions.set(secretaryId, m)
    }
    return m
  }

  function pushEvent(secretaryId, kind, text, agentId) {
    const m = mission(secretaryId)
    m.events.push({ t: Date.now(), kind, text: firstLine(text, 200), agentId: agentId ?? null })
    if (m.events.length > cfg.maxEvents) m.events.splice(0, m.events.length - cfg.maxEvents)
    m.updatedAt = Date.now()
    snapCache.delete(secretaryId)
    scheduleSave()
  }

  // ------------------------------------------------------------- presets

  function presetOf(agent) {
    if (!agent) return undefined
    try {
      const composed = ctx.agentPresets.composedPreset(agent.ctx)
      if (composed) return composed
    } catch { /* fall through to the session header */ }
    try {
      return agent.session?.header?.agentPreset ?? agent.session?.agentPreset ?? undefined
    } catch {
      return undefined
    }
  }

  function isSecretary(agent) {
    const preset = presetOf(agent)
    return Boolean(preset && cfg.secretaryPresets.includes(preset))
  }

  // ----------------------------------------------------------- read-only

  function statusOf(id) {
    const agent = ctx.agents.get(id)
    if (!agent) return 'offline'
    return agent.status === 'running' ? 'running' : 'idle'
  }

  function nodeOf(entry, fallbackParent) {
    const id = entry?.childId ?? entry?.sessionId ?? entry?.id ?? entry?.session
    if (!id) return null
    const live = ctx.agents.get(id)
    const act = activity.get(id)
    return toNode(entry, fallbackParent, {
      preset: live ? presetOf(live) : undefined,
      status: statusOf(String(id)),
      firstSeenAt: seen.get(String(id)) ?? null,
      lastTool: act ? act.tool : null,
      lastToolAt: act ? act.at : null,
    })
  }

  async function readTree(secretaryId) {
    const byId = new Map()
    let source = 'descendants'
    try {
      const list = await ctx.subagents.listDescendants(secretaryId)
      for (const e of Array.isArray(list) ? list : []) {
        const n = nodeOf(e, secretaryId)
        if (n) byId.set(n.id, n)
      }
    } catch {
      source = 'children'
      try {
        const list = await ctx.subagents.listChildren(secretaryId)
        for (const e of Array.isArray(list) ? list : []) {
          const n = nodeOf(e, secretaryId)
          if (n) byId.set(n.id, n)
        }
      } catch {
        source = 'none'
      }
    }
    return { nodes: [...byId.values()], source }
  }

  /**
   * Attach a brief to the child it created. The dispatch tool returns before
   * every backend has exposed the child id, so resolve the newest unmapped
   * direct child shortly after the call.
   */
  function addBrief(secretaryId, brief) {
    const m = mission(secretaryId)
    m.brief = brief
    scheduleSave()
    setTimeout(async () => {
      try {
        const kids = await ctx.subagents.listChildren(secretaryId)
        const list = (Array.isArray(kids) ? kids : [])
          .map((e) => nodeOf(e, secretaryId))
          .filter(Boolean)
        const unmapped = list.find((n) => !m.briefs[n.id])
        if (unmapped) {
          m.briefs[unmapped.id] = brief
          m.commanderId = m.commanderId ?? unmapped.id
          snapCache.delete(secretaryId)
          scheduleSave()
        }
      } catch { /* the board falls back to the session brief */ }
    }, 400)
  }

  async function buildSnapshot(secretaryId) {
    const cached = snapCache.get(secretaryId)
    if (cached && Date.now() - cached.at < 800) return cached.value
    const { nodes, source } = await readTree(secretaryId)

    // Safety net: if the tools/result observer never saw the dispatch (a
    // different dispatch tool name, or a session restored after a restart),
    // the tree itself still tells us a mission exists.
    let record = missions.get(secretaryId) ?? null
    if (!record && nodes.length > 0) {
      const firstSeen = Math.min(...nodes.map((n) => n.firstSeenAt || Date.now()))
      record = mission(secretaryId)
      record.startedAt = record.startedAt ?? firstSeen
      record.updatedAt = record.updatedAt ?? Date.now()
      scheduleSave()
    }

    const { groups, loose } = groupTree(secretaryId, nodes)
    const counts = countNodes(nodes)

    let lastActivityAt = 0
    for (const n of nodes) {
      const a = activity.get(n.id)
      if (a && a.at > lastActivityAt) lastActivityAt = a.at
    }
    if (!lastActivityAt) lastActivityAt = record?.updatedAt ?? record?.startedAt ?? 0
    const idleForMs = lastActivityAt ? Date.now() - lastActivityAt : null

    const primary = groups.find((g) => g.commander.status === 'running') ?? groups[0] ?? null
    const startedAt = primary?.commander.firstSeenAt ?? record?.startedAt ?? null
    const briefOf = (commanderId) => record?.briefs?.[commanderId] ?? record?.brief ?? ''

    const value = {
      ok: true,
      now: Date.now(),
      secretaryId,
      config: {
        reportIntervalSec: cfg.reportIntervalSec,
        enabled: cfg.enabled,
      },
      ticker: {
        armed: tickers.has(secretaryId),
        lastTickAt: lastTick.get(secretaryId) ?? null,
        nextTickAt: lastTick.get(secretaryId)
          ? lastTick.get(secretaryId) + cfg.reportIntervalSec * 1000
          : null,
      },
      mission: record
        ? {
            id: secretaryId,
            brief: briefOf(primary?.commander.id),
            startedAt,
            updatedAt: record.updatedAt,
            elapsedSec: startedAt ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : 0,
            counts,
            commander: primary?.commander ?? null,
            workers: primary?.workers ?? [],
            groups: groups.map((g) => ({
              commander: g.commander,
              workers: g.workers,
              brief: briefOf(g.commander.id),
              startedAt: g.startedAt,
            })),
            loose,
            events: record.events.slice(-20).reverse(),
            idleForSec: idleForMs == null ? null : Math.round(idleForMs / 1000),
            source,
          }
        : null,
    }

    snapCache.set(secretaryId, { at: Date.now(), value })
    if (snapCache.size > 40) {
      const oldest = [...snapCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest) snapCache.delete(oldest[0])
    }
    return value
  }

  // --------------------------------------------------------------- tools

  /**
   * One definition, registered on the Host context, so every agent sees it in
   * its schema. The executor refuses sessions that are not secretaries, which
   * keeps the secretary-only contract without a per-preset registry.
   */
  function missionStatusDefinition(resolveAgentId) {
    return {
      name: 'mission_status',
      description:
        'Read the live command tree of THIS session: every commander, its workers, their status, ' +
        'the current action, elapsed time and the recent timeline. Read-only: it never starts, ' +
        'stops or changes any work. Call it when the user asks for progress or when you receive ' +
        'a [[MISSION_TICK]] message.',
      parameters: {
        detail: {
          type: 'string',
          enum: ['brief', 'full'],
          description: 'brief (default) returns the essentials; full adds ids and the timeline.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args, exec) {
        const agentId = resolveAgentId() ?? exec?.agent?.id ?? exec?.agentId
        if (!agentId) {
          return JSON.stringify({ mission: null, hint: 'No calling agent.' })
        }
        const caller = ctx.agents.get(agentId)
        if (caller && !cfg.secretaryPresets.includes(String(presetOf(caller)))) {
          return JSON.stringify({
            mission: null,
            hint: 'mission_status is reserved for Mission Control (secretary) sessions.',
          })
        }
        const snap = await buildSnapshot(agentId)
        if (args?.detail === 'full') return JSON.stringify(snap)
        const m = snap.mission
        if (!m) {
          return JSON.stringify({
            mission: null,
            hint: '本会话还没有派过任务。用 dispatch 把简报交给指挥官。',
          })
        }
        return JSON.stringify({
          mission: {
            brief: firstLine(m.brief, 200),
            elapsedSec: m.elapsedSec,
            counts: m.counts,
            groups: (m.groups ?? []).map((g) => ({
              brief: firstLine(g.brief, 140),
              commander: {
                id: g.commander.id,
                label: g.commander.label,
                status: g.commander.status,
                lastTool: g.commander.lastTool,
              },
              workers: g.workers.map((w) => ({
                id: w.id,
                label: w.label,
                status: w.status,
                lastTool: w.lastTool,
              })),
            })),
            loose: (m.loose ?? []).map((n) => ({ label: n.label, status: n.status })),
            idleForSec: m.idleForSec,
            nextReportInSec: snap.ticker.nextTickAt
              ? Math.max(0, Math.round((snap.ticker.nextTickAt - Date.now()) / 1000))
              : null,
            recent: m.events.slice(0, 5).map((e) => e.text),
          },
        })
      },
    }
  }

  function installSecretary(agent) {
    if (agent.__missionControlInstalled) return
    agent.__missionControlInstalled = true
    armTicker(agent)
  }

  /**
   * A commander that can write files is a commander that will write files.
   * The persona already says "delegate, verify"; this makes the boundary real
   * for the two tools that produce deliverables. Shell stays available because
   * verification needs it.
   */
  function installCommander(agent) {
    if (!cfg.denyCommanderWrites) return
    try {
      agent.ctx.effect(() =>
        agent.ctx.tools.guard((exec) => {
          try {
            const tool = exec?.name ?? exec?.tool ?? exec?.toolName
            if (tool === 'write' || tool === 'edit') {
              return 'Commanders do not modify files. Delegate the change to a worker with the subagent tool, then verify its result.'
            }
          } catch { /* never break a call because the guard could not read it */ }
          return undefined
        }),
      )
    } catch (err) {
      console.warn(`[${NAME}] could not install the commander write guard:`, err?.message ?? err)
    }
  }

  // -------------------------------------------------------------- ticker

  function tickText(snap) {
    const m = snap.mission
    const parts = [
      `[[MISSION_TICK]] ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`,
      `汇报间隔 ${snap.config.reportIntervalSec}s；已经跑了 ${Math.round(m.elapsedSec / 60)} 分钟。`,
      `当前：${m.counts.running} 人在跑，${m.counts.offline} 人已停。`,
      '请调用 mission_status（只读）后，用不超过 4 行向用户汇报：进度 / 正在做什么 / 是否卡住或需要拍板。',
      '没有变化就只回一行「无变化」。不要做任何具体工作。',
    ]
    return parts.join('\n')
  }

  async function tick(agent) {
    if (!cfg.enabled || disposed) return
    if (!agent || agent.status === 'running') return
    if (!missions.has(agent.id)) return
    const last = lastTick.get(agent.id) ?? 0
    if (Date.now() - last < cfg.minTickGapSec * 1000) return
    let snap
    try {
      snap = await buildSnapshot(agent.id)
    } catch {
      return
    }
    if (!snap.mission || snap.mission.counts.total === 0) return
    // Quiet once the whole tree is not running: there is nothing new to say.
    if (snap.mission.counts.running === 0 && (snap.mission.idleForSec ?? 0) > 60) return
    if (snap.mission.idleForSec != null && snap.mission.idleForSec > cfg.idleStopMinutes * 60) return
    lastTick.set(agent.id, Date.now())
    try {
      await agent.followup(userMessage(tickText(snap)))
      pushEvent(agent.id, 'tick', '自动汇报已发出')
      snapCache.delete(agent.id)
    } catch (err) {
      console.warn(`[${NAME}] tick delivery failed:`, err?.message ?? err)
    }
  }

  function armTicker(agent) {
    if (tickers.has(agent.id)) return
    const every = Math.max(15, cfg.reportIntervalSec) * 1000
    const stop = ctx.interval(() => {
      void tick(agent)
    }, every)
    tickers.set(agent.id, stop)
  }

  function disarmTicker(agentId) {
    const stop = tickers.get(agentId)
    if (stop) {
      try { stop() } catch { /* already gone */ }
      tickers.delete(agentId)
    }
    lastTick.delete(agentId)
  }

  function rearmAll() {
    for (const [id, stop] of [...tickers]) {
      try { stop() } catch { /* ignore */ }
      tickers.delete(id)
      const agent = ctx.agents.get(id)
      if (agent && isSecretary(agent)) armTicker(agent)
    }
  }

  // ------------------------------------------------------------ observers

  ctx.on('agent/created', ({ agent } = {}) => {
    if (!agent) return
    if (!seen.has(agent.id)) seen.set(agent.id, Date.now())
    try {
      const preset = presetOf(agent)
      if (preset && cfg.secretaryPresets.includes(preset)) installSecretary(agent)
      else if (preset && cfg.commanderPresets.includes(preset)) installCommander(agent)
    } catch (err) {
      console.warn(`[${NAME}] agent setup failed:`, err?.message ?? err)
    }
  })

  ctx.on('agent/disposed', ({ agent } = {}) => {
    if (!agent) return
    disarmTicker(agent.id)
  })

  ctx.on('agent/status', ({ agent, status } = {}) => {
    if (!agent) return
    if (!seen.has(agent.id)) seen.set(agent.id, Date.now())
    if (status === 'idle' && isSecretary(agent)) {
      // Creation listeners run before the preset projection is readable in some
      // deployments, so the first idle status is the reliable install point.
      installSecretary(agent)
      armTicker(agent)
    }
  })

  // Capture the dispatch brief + the commander id from the tool outcome.
  ctx.on('tools/result', (exec, result) => {
    try {
      const agent = exec?.agent
      const id = agent?.id ?? exec?.agentId
      if (!id) return
      const tool = exec?.name ?? exec?.toolName
      if (!tool) return
      activity.set(id, { tool: String(tool), at: Date.now() })
      if (!seen.has(id)) seen.set(id, Date.now())
      if (tool !== cfg.dispatchToolName) return
      if (!isSecretary(agent)) return

      const args = exec?.args ?? exec?.arguments ?? exec?.input ?? {}
      const brief =
        args?.task ?? args?.prompt ?? args?.description ?? args?.message ?? JSON.stringify(args)
      const briefText = String(brief ?? '')
      const m = mission(id)
      m.startedAt = m.startedAt ?? Date.now()
      m.updatedAt = Date.now()
      const text = JSON.stringify(result ?? '')
      const match = text.match(/subagent[^\w-]*([\w-]{6,})/i)
      if (match && !m.commanderId) m.commanderId = match[1]
      pushEvent(id, 'dispatch', `秘书下单：${firstLine(briefText, 90)}`)
      addBrief(id, briefText)
      scheduleSave()
    } catch (err) {
      console.warn(`[${NAME}] tools/result observer failed:`, err?.message ?? err)
    }
  })

  ctx.on('subagent/start', (info) => {
    try {
      const parent = info?.parentSessionId ?? info?.parentId
      const child = info?.childId ?? info?.sessionId ?? info?.id
      if (!parent || !child) return
      const m = missions.get(String(parent))
      if (!m) return
      if (!seen.has(child)) seen.set(child, Date.now())
      pushEvent(String(parent), 'start', `启动 ${info?.label ?? info?.title ?? child}`, child)
    } catch { /* observe-only */ }
  })

  ctx.on('subagent/end', (info) => {
    try {
      const parent = info?.parentSessionId ?? info?.parentId
      const child = info?.childId ?? info?.sessionId ?? info?.id
      if (!parent) return
      if (!missions.has(String(parent))) return
      pushEvent(String(parent), 'end', `结束 ${info?.label ?? info?.title ?? child}`, child)
    } catch { /* observe-only */ }
  })

  // ------------------------------------------------------------ transport

  function json(res, code, body) {
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(JSON.stringify(body))
  }

  function denied(req) {
    try {
      const conn = ctx.connection
      if (!conn || typeof conn.requestRejection !== 'function') return 503
      const code = conn.requestRejection(req)
      return code === undefined || code === null || code === false ? 0 : Number(code) || 403
    } catch {
      return 503
    }
  }

  function readBody(req, limit = 32 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          reject(new Error('body too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  function route(pathname, handler) {
    return ctx.webServer.register({
      kind: 'exact',
      path: pathname,
      handler: async (req, res) => {
        const code = denied(req)
        if (code) {
          json(res, code, { ok: false, error: 'request rejected by the Harness trust fence' })
          return
        }
        try {
          await handler(req, res)
        } catch (err) {
          json(res, 500, { ok: false, error: String(err?.message ?? err) })
        }
      },
    })
  }

  ctx.effect(() =>
    route(`${ROUTE_PREFIX}/snapshot`, async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const sessionId = url.searchParams.get('sessionId')
      if (!sessionId) {
        json(res, 400, { ok: false, error: 'sessionId is required' })
        return
      }
      json(res, 200, await buildSnapshot(sessionId))
    }),
  )

  ctx.effect(() =>
    route(`${ROUTE_PREFIX}/missions`, async (_req, res) => {
      json(res, 200, {
        ok: true,
        missions: [...missions.values()]
          .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
          .slice(0, 20)
          .map((m) => ({
            secretaryId: m.secretaryId,
            brief: firstLine(m.brief, 140),
            startedAt: m.startedAt,
            updatedAt: m.updatedAt,
          })),
      })
    }),
  )

  ctx.effect(() =>
    route(`${ROUTE_PREFIX}/config`, async (req, res) => {
      if (req.method === 'GET') {
        json(res, 200, { ok: true, config: cfg })
        return
      }
      if (req.method !== 'POST') {
        json(res, 405, { ok: false })
        return
      }
      let body = {}
      try {
        body = JSON.parse((await readBody(req)) || '{}')
      } catch {
        json(res, 400, { ok: false, error: 'invalid JSON body' })
        return
      }
      if (body.reportIntervalSec !== undefined) {
        const v = Number(body.reportIntervalSec)
        if (!Number.isFinite(v) || v < 15 || v > 3600) {
          json(res, 400, { ok: false, error: 'reportIntervalSec must be between 15 and 3600' })
          return
        }
        cfg.reportIntervalSec = Math.round(v)
      }
      if (body.enabled !== undefined) cfg.enabled = body.enabled !== false
      rearmAll()
      scheduleSave()
      json(res, 200, { ok: true, config: cfg })
    }),
  )

  ctx.effect(() =>
    route(`${ROUTE_PREFIX}/tick`, async (req, res) => {
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: 'POST only' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const sessionId = url.searchParams.get('sessionId')
      const agent = sessionId ? ctx.agents.get(sessionId) : undefined
      if (!agent) {
        json(res, 404, { ok: false, error: 'no live agent for that session' })
        return
      }
      const snap = await buildSnapshot(sessionId)
      if (!snap.mission) {
        json(res, 409, { ok: false, error: 'this session has no mission yet' })
        return
      }
      lastTick.set(sessionId, Date.now())
      await agent.followup(userMessage(tickText(snap)))
      pushEvent(sessionId, 'tick', '手动催了一次汇报')
      json(res, 200, { ok: true })
    }),
  )

  try {
    ctx.effect(() => ctx.tools.register(missionStatusDefinition(() => undefined)))
  } catch (err) {
    console.warn(`[${NAME}] could not register mission_status:`, err?.message ?? err)
  }

  ctx.effect(() => () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    for (const stop of tickers.values()) {
      try { stop() } catch { /* ignore */ }
    }
    tickers.clear()
    flush()
    disposed = true
  })

  console.log(
    `[${NAME}] ready · every ${cfg.reportIntervalSec}s · presets: ${cfg.secretaryPresets.join(', ')}`,
  )
}
