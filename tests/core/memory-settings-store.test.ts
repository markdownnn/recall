import { MemorySettingsStore } from '../../src/adapters/memory-settings-store'

// The denylist (the sites a user blocks via "Don't remember this site") is read back by the
// Settings tab to render the list with a per-row "remove". Production stores it in a SQLite
// table behind the SettingsPort; this in-memory store is the pure contract double so the
// list/add/remove behaviour can be pinned without a worker. Mirrors MemoryVectorStore.

// Scenario: a fresh profile has blocked no sites, so the Settings denylist must come back
// empty (not undefined) and the panel renders its empty state.
// Coverage: integration (real MemorySettingsStore - the SettingsPort contract).
test('a fresh store lists no denied hosts and is not paused', async () => {
  const s = new MemorySettingsStore()
  const got = await s.get()
  expect(got.paused).toBe(false)
  expect(got.userDenyHosts).toEqual([])
})

// Scenario: the user blocks two sites; the Settings tab LIST query must return exactly those
// hosts so each gets a remove button. This is the new list query the Settings UI depends on.
// Coverage: integration (real MemorySettingsStore - the SettingsPort contract).
test('addDenyHost makes the host appear in the listed denied hosts', async () => {
  const s = new MemorySettingsStore()
  await s.addDenyHost('a.example')
  await s.addDenyHost('b.example')
  const hosts = (await s.get()).userDenyHosts
  expect(hosts).toContain('a.example')
  expect(hosts).toContain('b.example')
  expect(hosts.length).toBe(2)
})

// Scenario: blocking the same site twice must not list it twice (the SQL table is a PRIMARY
// KEY set), so the Settings list never shows a duplicate row.
// Coverage: integration (real MemorySettingsStore - the SettingsPort contract).
test('addDenyHost is idempotent: a repeat add does not duplicate the host', async () => {
  const s = new MemorySettingsStore()
  await s.addDenyHost('a.example')
  await s.addDenyHost('a.example')
  expect((await s.get()).userDenyHosts).toEqual(['a.example'])
})

// Scenario: the Settings "remove" button un-blocks a site; the list query must then NOT return
// it, proving the removal is real (the e2e then proves capture works again).
// Coverage: integration (real MemorySettingsStore - the SettingsPort contract).
test('removeDenyHost drops the host from the listed denied hosts', async () => {
  const s = new MemorySettingsStore()
  await s.addDenyHost('a.example')
  await s.addDenyHost('b.example')
  await s.removeDenyHost('a.example')
  const hosts = (await s.get()).userDenyHosts
  expect(hosts).toEqual(['b.example'])
})

// Scenario: pausing capture is a global setting that lives next to the denylist; flipping it
// must persist so the Settings toggle reflects the real state on reopen.
// Coverage: integration (real MemorySettingsStore - the SettingsPort contract).
test('setPaused persists the paused flag', async () => {
  const s = new MemorySettingsStore()
  await s.setPaused(true)
  expect((await s.get()).paused).toBe(true)
  await s.setPaused(false)
  expect((await s.get()).paused).toBe(false)
})
