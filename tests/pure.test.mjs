import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULTS,
  countNodes,
  firstLine,
  groupTree,
  normalizeConfig,
  nodeOf,
} from '../lib/pure.js'

test('firstLine collapses whitespace and truncates with an ellipsis', () => {
  assert.equal(firstLine('  a\n\n b\tc  '), 'a b c')
  assert.equal(firstLine('abcdef', 4), 'abc…')
  assert.equal(firstLine(null), '')
})

test('normalizeConfig fills defaults', () => {
  const cfg = normalizeConfig()
  assert.equal(cfg.reportIntervalSec, DEFAULTS.reportIntervalSec)
  assert.deepEqual(cfg.secretaryPresets, ['orchestrator'])
  assert.deepEqual(cfg.commanderPresets, ['commander'])
  assert.equal(cfg.denyCommanderWrites, true)
  assert.equal(cfg.enabled, true)
})

test('normalizeConfig clamps and coerces values', () => {
  assert.equal(normalizeConfig({ reportIntervalSec: 1 }).reportIntervalSec, 15)
  assert.equal(normalizeConfig({ reportIntervalSec: 99999 }).reportIntervalSec, 3600)
  assert.equal(normalizeConfig({ reportIntervalSec: '90' }).reportIntervalSec, 90)
  assert.deepEqual(normalizeConfig({ secretaryPresets: 'boss' }).secretaryPresets, ['boss'])
  assert.deepEqual(normalizeConfig({ secretaryPresets: [] }).secretaryPresets, ['orchestrator'])
  assert.equal(normalizeConfig({ enabled: 'no' }).enabled, true)
  assert.equal(normalizeConfig({ enabled: false }).enabled, false)
  assert.equal(normalizeConfig({ denyCommanderWrites: false }).denyCommanderWrites, false)
})

test('countNodes aggregates the three states', () => {
  const counts = countNodes([
    { status: 'running' },
    { status: 'idle' },
    { status: 'offline' },
    { status: 'running' },
  ])
  assert.deepEqual(counts, { total: 4, running: 2, idle: 1, offline: 1 })
})

test('groupTree builds one group per commander, in newest-first order', () => {
  const nodes = [
    { id: 'c1', parentId: 's', preset: 'commander', firstSeenAt: 100 },
    { id: 'w1', parentId: 'c1', preset: 'worker' },
    { id: 'w2', parentId: 'c1', preset: 'worker' },
    { id: 'c2', parentId: 's', preset: 'commander', firstSeenAt: 200 },
    { id: 'w3', parentId: 'c2', preset: 'worker' },
  ]
  const { groups, loose } = groupTree('s', nodes)
  assert.equal(groups.length, 2)
  assert.equal(groups[0].commander.id, 'c2')
  assert.deepEqual(groups[0].workers.map((w) => w.id), ['w3'])
  assert.equal(groups[1].commander.id, 'c1')
  assert.deepEqual(groups[1].workers.map((w) => w.id), ['w1', 'w2'])
  assert.deepEqual(loose, [])
})

test('groupTree falls back to direct children when presets are unknown', () => {
  const nodes = [
    { id: 'a', parentId: 's', preset: null, firstSeenAt: 1 },
    { id: 'b', parentId: 'a', preset: null },
  ]
  const { groups } = groupTree('s', nodes)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].commander.id, 'a')
  assert.deepEqual(groups[0].workers.map((w) => w.id), ['b'])
})

test('nodeOf normalizes catalog field names from any provider', () => {
  const a = nodeOf({ childId: 'x', parentSessionId: 'p', label: 'Worker A' }, 'fallback', {
    status: 'running',
    preset: 'worker',
  })
  assert.equal(a.id, 'x')
  assert.equal(a.parentId, 'p')
  assert.equal(a.label, 'Worker A')
  assert.equal(a.status, 'running')
  assert.equal(a.preset, 'worker')

  const b = nodeOf({ sessionId: 'y', title: 'B' }, 'fallback')
  assert.equal(b.id, 'y')
  assert.equal(b.parentId, 'fallback')
  assert.equal(b.status, 'offline')

  assert.equal(nodeOf({}, 'fallback'), null)
})
