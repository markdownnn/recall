// Tracks how long a page has been VISIBLE and fires once that reaches a threshold.
// Pure and deterministic: the clock (now) and visibility (isVisible) are injected, so
// it is unit-testable. The content script wires `now` to Date.now and `isVisible` to
// document.visibilityState, calls onVisibilityChange() on the visibilitychange event,
// and tick() on a poll interval.
//
// Hidden time never counts: a background tab (e.g. a middle-click-opened link the user
// never looks at) never accumulates and never fires. Visible time accumulates across
// hide/show cycles, so 5s visible + away + 5s visible reaches the 10s threshold.
export class DwellTracker {
  private visibleMs = 0
  private streakStart: number | null = null // start of the ongoing visible streak, or null if hidden
  private fired = false

  constructor(
    private readonly thresholdMs: number,
    private readonly now: () => number,
    private readonly isVisible: () => boolean,
    private readonly onDwell: () => void,
  ) {}

  // Start (or restart for a new page/candidate) accumulation from zero.
  reset(): void {
    this.visibleMs = 0
    this.fired = false
    this.streakStart = this.isVisible() ? this.now() : null
  }

  // Call on every visibilitychange event.
  onVisibilityChange(): void {
    if (this.isVisible()) {
      if (this.streakStart === null) this.streakStart = this.now()
    } else {
      this.flush()
    }
  }

  // Call periodically; fires onDwell once total visible time reaches the threshold.
  tick(): void {
    if (this.fired) return
    const ongoing = this.streakStart !== null ? this.now() - this.streakStart : 0
    if (this.visibleMs + ongoing >= this.thresholdMs) {
      this.fired = true
      this.onDwell()
    }
  }

  private flush(): void {
    if (this.streakStart !== null) {
      this.visibleMs += this.now() - this.streakStart
      this.streakStart = null
    }
  }
}
