// Tracks how far DOWN a page the user has scrolled (and whether they selected text) and
// answers "did they engage with it?" Pure and deterministic: the content script reads
// window.scrollY / innerHeight / document scrollHeight / the selection length and feeds
// them in, so this stays DOM-free and unit-testable.
//
// Model (CONFIRMED): a page is ENGAGED if it is SHORT (content fits ~1.5 screens, so no
// real scrolling is needed to read it) OR the user scrolled at least halfway through a
// long page OR the user selected a few words of text. "Max reached fraction" = the
// deepest (scrollY + viewport) / scrollHeight the user ever reached; it is sticky
// (scrolling back up does not lower it). A selection is also sticky once seen. This gates
// AUTO-capture only - a long page left open but never touched is probably not read.
export const SHORT_PAGE_RATIO = 1.5 // short when scrollHeight <= viewport * 1.5
export const ENGAGED_FRACTION = 0.5 // long page counts as read once maxFrac >= 0.5
export const MIN_SELECTION_CHARS = 10 // a few words; avoids double-click-a-word false positives

export class EngagementTracker {
  private maxFrac = 0
  private selected = false

  // Call on every scroll event (and once after content settles). viewport = innerHeight,
  // scrollHeight = full document height. Records the deepest fraction seen.
  onScroll(scrollY: number, viewport: number, scrollHeight: number): void {
    if (scrollHeight <= 0) return
    const frac = (scrollY + viewport) / scrollHeight
    if (frac > this.maxFrac) this.maxFrac = frac
  }

  // Call on selection change with the trimmed length of the current selection. A few
  // words (>= MIN_SELECTION_CHARS) sticks; a stray single-word double-click does not.
  onSelection(selectedChars: number): void {
    if (selectedChars >= MIN_SELECTION_CHARS) this.selected = true
  }

  // Short pages are engaged with no scrolling; long pages need maxFrac >= ENGAGED_FRACTION
  // OR a sticky selection.
  engaged(viewport: number, scrollHeight: number): boolean {
    if (scrollHeight <= viewport * SHORT_PAGE_RATIO) return true
    return this.maxFrac >= ENGAGED_FRACTION || this.selected
  }

  // Start fresh for a new page/candidate (e.g. SPA navigation).
  reset(): void {
    this.maxFrac = 0
    this.selected = false
  }
}
