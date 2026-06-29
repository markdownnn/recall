import { DwellTracker } from '../../src/content/dwell-tracker'

// A controllable clock + visibility, so dwell behavior is deterministic.
function setup(startVisible: boolean) {
  let t = 0
  let visible = startVisible
  let fired = 0
  const dt = new DwellTracker(
    10_000,
    () => t,
    () => visible,
    () => {
      fired++
    },
  )
  return {
    dt,
    advance: (ms: number) => {
      t += ms
    },
    show: () => {
      visible = true
      dt.onVisibilityChange()
    },
    hide: () => {
      visible = false
      dt.onVisibilityChange()
    },
    fired: () => fired,
  }
}

// Scenario: a page the user keeps looking at must auto-capture after the dwell window.
// Coverage: integration (pure tracker, real time math, no mock)
test('visible the whole time fires once at the threshold', () => {
  const s = setup(true)
  s.dt.reset()
  s.advance(9_000)
  s.dt.tick()
  expect(s.fired()).toBe(0)
  s.advance(1_000)
  s.dt.tick()
  expect(s.fired()).toBe(1)
  // does not fire again
  s.advance(5_000)
  s.dt.tick()
  expect(s.fired()).toBe(1)
})

// Scenario: a background tab (middle-click-opened link the user never views) must NOT
// be captured even long after the dwell window passes. This is the whole point of the
// visibility gate.
// Coverage: integration (pure tracker)
test('hidden the whole time never fires', () => {
  const s = setup(false)
  s.dt.reset()
  s.advance(60_000)
  s.dt.tick()
  expect(s.fired()).toBe(0)
})

// Scenario: a user reads a bit, switches away, comes back and finishes reading. The
// visible time should accumulate across the gap and capture once it totals the window.
// Coverage: integration (pure tracker)
test('visible time accumulates across hide/show cycles', () => {
  const s = setup(true)
  s.dt.reset()
  s.advance(6_000) // visible 6s
  s.dt.tick()
  expect(s.fired()).toBe(0)
  s.hide()
  s.advance(30_000) // hidden 30s -> does not count
  s.dt.tick()
  expect(s.fired()).toBe(0)
  s.show()
  s.advance(3_000) // visible 3s more (total 9s) -> still under
  s.dt.tick()
  expect(s.fired()).toBe(0)
  s.advance(2_000) // visible 2s more (total 11s) -> fires
  s.dt.tick()
  expect(s.fired()).toBe(1)
})

// Scenario: navigating to a new page (or bouncing) restarts the dwell from zero.
// Coverage: integration (pure tracker)
test('reset restarts accumulation', () => {
  const s = setup(true)
  s.dt.reset()
  s.advance(9_000)
  s.dt.reset() // new candidate
  s.advance(5_000) // only 5s on the new candidate
  s.dt.tick()
  expect(s.fired()).toBe(0)
  s.advance(6_000) // total 11s on the new candidate
  s.dt.tick()
  expect(s.fired()).toBe(1)
})
