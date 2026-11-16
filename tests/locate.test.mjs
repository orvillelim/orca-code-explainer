import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import activate, { deactivate } from '../worker/main.mjs'
import { fileHasText, locateFile } from '../worker/project-reader.mjs'
import { fingerprintText } from '../src/text-fingerprint.mjs'

const text = 'extends Node\n\nfunc ready():\n    print("hello")\n'
const fingerprint = { ...fingerprintText(text), lines: text.split('\n').length }

async function fixture(t, { cached, context, duplicate = false, firstName = 'main', third = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'code-explainer-locate-'))
  t.after(async () => {
    deactivate()
    await rm(root, { recursive: true, force: true })
  })
  const workspaces = ['first', 'second', ...(third ? ['third'] : [])].map((id) => ({
    id, name: id === 'first' ? firstName : 'main', branch: 'main', path: join(root, id), hostId: 'local'
  }))
  await Promise.all(workspaces.map((row) => mkdir(row.path)))
  await writeFile(join(workspaces[0].path, 'original.gd'), duplicate ? text : '# unrelated\n')
  await writeFile(join(workspaces[1].path, 'current.gd'), text)
  // Remembered places, as `[workspaceId, relativePath]`, stored under `<workspace id>-<text hash>`.
  const remembered = Object.fromEntries((cached ?? []).map(([workspaceId, relativePath]) => [
    `${workspaceId}-${fingerprint.hash}`, { relativePath, alsoMatches: [] }
  ]))
  const storage = new Map(cached ? [['locations', remembered]] : [])
  const handlers = new Map()
  const events = new Map()
  activate({
    events: { on: (name, handler) => events.set(name, handler) },
    storage: {
      get: async (key) => structuredClone(storage.get(key)),
      set: async (key, value) => { storage.set(key, structuredClone(value)) }
    },
    panels: { handle: (name, handler) => handlers.set(name, handler) },
    host: { call: async (method) => {
      if (method === 'workspace.list') return { workspaces }
      if (method === 'workspace.readContext') return context ?? { displayName: 'main', branch: 'main' }
      throw new Error(`Unexpected host call: ${method}`)
    } },
    log: () => {}
  })
  return { workspaces, storage, events, locate: () => handlers.get('locate')({ fingerprint }) }
}

test('the focused workspace wins over a cached copy at a different path', async (t) => {
  const { locate } = await fixture(t, {
    duplicate: true,
    cached: [['first', 'original.gd']],
    context: { workspaceId: 'second' }
  })
  assert.deepEqual(await locate(), {
    workspaceId: 'second', relativePath: 'current.gd', alsoMatches: []
  })
})

test('ambiguous workspace names still find the file in another project', async (t) => {
  const { locate } = await fixture(t)
  assert.deepEqual(await locate(), {
    workspaceId: 'second', relativePath: 'current.gd', alsoMatches: []
  })
})

test('a cached location is rechecked after its contents change', async (t) => {
  const { locate } = await fixture(t, { cached: [['first', 'original.gd']] })
  assert.equal((await locate()).workspaceId, 'second')
})

test('a cached path cannot leave its workspace', async (t) => {
  const { locate, workspaces } = await fixture(t, {
    cached: [['first', '../second/current.gd']]
  })
  assert.equal(await fileHasText(workspaces[0].path, '../second/current.gd', fingerprint), false)
  assert.equal((await locate()).workspaceId, 'second')
})

test('each workspace remembers its own copy of the same text', async (t) => {
  const { locate, storage } = await fixture(t, {
    duplicate: true,
    cached: [['first', 'original.gd'], ['second', 'current.gd']],
    context: { workspaceId: 'first' }
  })
  assert.deepEqual(await locate(), { workspaceId: 'first', relativePath: 'original.gd', alsoMatches: [] })
  assert.deepEqual(Object.keys(storage.get('locations')).sort(), [
    `first-${fingerprint.hash}`, `second-${fingerprint.hash}`
  ])
})

test('a found file is remembered under its workspace and text hash', async (t) => {
  const { locate, storage } = await fixture(t)
  await locate()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(storage.get('locations'), {
    [`second-${fingerprint.hash}`]: { relativePath: 'current.gd', alsoMatches: [] }
  })
})

test('removing a workspace forgets the files found in it', async (t) => {
  const { events, storage } = await fixture(t, {
    cached: [['first', 'original.gd'], ['second', 'current.gd'], ['removed-worktree', 'old.gd']]
  })
  // Orca names the removed workspace by its internal id, so the plugin compares with the list.
  await events.get('workspace.removed')({ workspaceId: 'repo::/somewhere', kind: 'worktree', path: '/somewhere' })
  assert.deepEqual(Object.keys(storage.get('locations')).sort(), [
    `first-${fingerprint.hash}`, `second-${fingerprint.hash}`
  ])
})

test('the workspaces that could be focused are searched before the others', async (t) => {
  // `first` is not named like the focused workspace, so its copy loses to `second`'s.
  const { locate } = await fixture(t, { duplicate: true, firstName: 'feature', third: true })
  assert.equal((await locate()).workspaceId, 'second')
})

test('lookup checks only the file types the editors open', async (t) => {
  const { workspaces, locate } = await fixture(t)
  const root = workspaces[1].path
  await writeFile(join(root, 'notes.txt'), text)
  assert.deepEqual(await locateFile(root, fingerprint, undefined, new Set(['.gd'])), ['current.gd'])
  assert.deepEqual((await locateFile(root, fingerprint)).sort(), ['current.gd', 'notes.txt'])
  // `.txt` is not one of the plugin's editor types, so the worker never reports it.
  assert.deepEqual((await locate()).alsoMatches, [])
})

test('lookup normalizes BOM and CRLF and respects cancellation', async (t) => {
  const { workspaces } = await fixture(t)
  const root = workspaces[1].path
  await writeFile(join(root, 'current.gd'), '\ufeff' + text.replaceAll('\n', '\r\n'))
  assert.equal(await fileHasText(root, 'current.gd', fingerprint), true)
  assert.deepEqual(await locateFile(root, fingerprint), ['current.gd'])
  assert.deepEqual(await locateFile(root, fingerprint, AbortSignal.abort()), [])
})
