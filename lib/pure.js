/**
 * Pure helpers for dsh-mission-control.
 *
 * Everything here is side-effect free so it can be unit-tested without a
 * Harness: config normalization, tree shaping and small formatting helpers.
 */

export const DEFAULTS = {
  /** Seconds between two [[MISSION_TICK]] reports. */
  reportIntervalSec: 120,
  /** Master switch for the ticker (the panel still works when false). */
  enabled: true,
  /** Preset ids treated as "the secretary". */
  secretaryPresets: ['orchestrator'],
  /** Preset ids treated as "the commander". */
  commanderPresets: ['commander'],
  /** Block write/edit for commanders so they delegate implementation. */
  denyCommanderWrites: true,
  /** Tool name the secretary uses to hand work to the commander. */
  dispatchToolName: 'dispatch',
  /** Stop ticking once the whole mission tree has been idle for this long. */
  idleStopMinutes: 20,
  /** Maximum timeline entries kept per mission. */
  maxEvents: 40,
  /** Queue a tick only when no newer tick is still pending. */
  minTickGapSec: 30,
}

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

/** First line of a possibly multi-line string, truncated to `max` chars. */
export function firstLine(value, max = 120) {
  const line = String(value ?? '').replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** Merge user config over DEFAULTS and coerce it into a usable shape. */
export function normalizeConfig(raw = {}) {
  const cfg = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  cfg.reportIntervalSec = clamp(Number(cfg.reportIntervalSec) || DEFAULTS.reportIntervalSec, 15, 3600)
  cfg.idleStopMinutes = clamp(Number(cfg.idleStopMinutes) || DEFAULTS.idleStopMinutes, 1, 240)
  cfg.maxEvents = clamp(Number(cfg.maxEvents) || DEFAULTS.maxEvents, 5, 200)
  cfg.minTickGapSec = clamp(Number(cfg.minTickGapSec) || DEFAULTS.minTickGapSec, 5, 600)
  cfg.enabled = cfg.enabled !== false
  if (typeof cfg.secretaryPresets === 'string') cfg.secretaryPresets = [cfg.secretaryPresets]
  if (!Array.isArray(cfg.secretaryPresets) || cfg.secretaryPresets.length === 0) {
    cfg.secretaryPresets = [...DEFAULTS.secretaryPresets]
  }
  cfg.secretaryPresets = cfg.secretaryPresets.map(String)
  if (typeof cfg.commanderPresets === 'string') cfg.commanderPresets = [cfg.commanderPresets]
  if (!Array.isArray(cfg.commanderPresets) || cfg.commanderPresets.length === 0) {
    cfg.commanderPresets = [...DEFAULTS.commanderPresets]
  }
  cfg.commanderPresets = cfg.commanderPresets.map(String)
  cfg.denyCommanderWrites = cfg.denyCommanderWrites !== false
  cfg.dispatchToolName = String(cfg.dispatchToolName || DEFAULTS.dispatchToolName)
  return cfg
}

/** Aggregate status counts over a flat node list. */
export function countNodes(nodes = []) {
  const out = { total: 0, running: 0, idle: 0, offline: 0 }
  for (const node of nodes) {
    out.total++
    if (node.status === 'running') out.running++
    else if (node.status === 'idle') out.idle++
    else out.offline++
  }
  return out
}

/**
 * Group a flat descendant list into one entry per commander and its workers.
 *
 * A session can dispatch several briefs over its life (or the secretary may
 * split one request into two independent missions), so the board must render
 * N groups instead of assuming a single commander. Commands are the direct
 * children of the secretary that carry the commander preset; if presets are
 * unavailable, every direct child is treated as one.
 */
export function groupTree(secretaryId, nodes = []) {
  const direct = nodes.filter((n) => n.parentId === secretaryId)
  const byPreset = direct.filter((n) => n.preset === 'commander')
  const commanders = byPreset.length > 0 ? byPreset : direct
  const groups = commanders
    .map((commander) => ({
      commander,
      workers: nodes.filter((n) => n.parentId === commander.id),
      startedAt: commander.firstSeenAt ?? null,
    }))
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  const grouped = new Set()
  for (const g of groups) {
    grouped.add(g.commander.id)
    for (const w of g.workers) grouped.add(w.id)
  }
  const loose = nodes.filter((n) => !grouped.has(n.id))
  return { groups, loose }
}

/** Coerce one subagent catalog entry into the shape the panel expects. */
export function nodeOf(entry, fallbackParent, lookup = {}) {
  const id = entry?.childId ?? entry?.sessionId ?? entry?.id ?? entry?.session
  if (!id) return null
  return {
    id: String(id),
    parentId: String(
      entry?.parentSessionId ?? entry?.parentId ?? entry?.parent ?? fallbackParent ?? '',
    ) || null,
    label: entry?.label ?? entry?.title ?? entry?.name ?? entry?.description ?? null,
    preset: lookup.preset ?? entry?.agentPreset ?? entry?.preset ?? null,
    mode: entry?.mode ? String(entry.mode) : null,
    status: lookup.status ?? 'offline',
    firstSeenAt: lookup.firstSeenAt ?? null,
    lastTool: lookup.lastTool ?? null,
    lastToolAt: lookup.lastToolAt ?? null,
  }
}
