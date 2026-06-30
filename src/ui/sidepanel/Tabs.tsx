import { t } from './strings'

// The single extension point for future tabs. Adding History/Settings later is a 3-line
// change: extend the union, push a row into TABS, add one `{tab === 'x' && <X/>}` line in
// SidePanel. No change to this presentational bar.
export type TabKey = 'search' // later: | 'history' | 'settings'

export const TABS: { key: TabKey; label: string }[] = [
  { key: 'search', label: t.searchTabLabel },
  // later: { key: 'history', label: t.historyTabLabel },
]

// Presentational tab bar. Renders even with a single tab so the scaffold is visible and
// the wiring is exercised from day one.
export function TabBar({ active, onSelect }: { active: TabKey; onSelect: (k: TabKey) => void }) {
  return (
    <div class="tabbar" role="tablist">
      {TABS.map((tab) => (
        <button
          key={tab.key}
          role="tab"
          aria-selected={tab.key === active}
          class={tab.key === active ? 'tab active' : 'tab'}
          onClick={() => onSelect(tab.key)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}
