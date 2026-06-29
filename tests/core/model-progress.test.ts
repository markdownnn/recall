import { reduceModelProgress, INITIAL_MODEL_STATUS, ModelStatus } from '../../src/core/model-progress'

describe('reduceModelProgress', () => {
  test('progress event with 42 produces loading state at 42%', () => {
    const result = reduceModelProgress(INITIAL_MODEL_STATUS, { status: 'progress', progress: 42 })
    expect(result).toEqual({ state: 'loading', percent: 42 })
  })

  test('percent is monotonic non-decreasing - lower value does not reduce percent', () => {
    const after42 = reduceModelProgress(INITIAL_MODEL_STATUS, { status: 'progress', progress: 42 })
    const after30 = reduceModelProgress(after42, { status: 'progress', progress: 30 })
    expect(after30.percent).toBe(42)
    expect(after30.state).toBe('loading')
  })

  test('ready event produces ready state at 100%', () => {
    const result = reduceModelProgress(INITIAL_MODEL_STATUS, { status: 'ready' })
    expect(result).toEqual({ state: 'ready', percent: 100 })
  })

  test('unknown status returns prev unchanged', () => {
    const prev: ModelStatus = { state: 'loading', percent: 55 }
    const result = reduceModelProgress(prev, { status: 'some-unknown-status' })
    expect(result).toBe(prev)
  })

  test('initiate event transitions to loading state', () => {
    const result = reduceModelProgress(INITIAL_MODEL_STATUS, { status: 'initiate' })
    expect(result).toEqual({ state: 'loading', percent: 0 })
  })

  test('download event transitions to loading state', () => {
    const result = reduceModelProgress(INITIAL_MODEL_STATUS, { status: 'download' })
    expect(result).toEqual({ state: 'loading', percent: 0 })
  })

  test('done event keeps current loading state and percent', () => {
    const prev: ModelStatus = { state: 'loading', percent: 75 }
    const result = reduceModelProgress(prev, { status: 'done' })
    expect(result).toEqual({ state: 'loading', percent: 75 })
  })
})
