import { t } from './strings'

// The single extension point for tabs. Adding one is a 3-line change: extend the union, push a
// row into TABS, add one `{tab === 'x' && <X/>}` line in SidePanel. No change to this bar.
export type TabKey = 'search' | 'history' | 'settings'

export const TABS: { key: TabKey; label: string }[] = [
  { key: 'search', label: t.searchTabLabel },
  { key: 'history', label: t.historyTabLabel },
  { key: 'settings', label: t.settingsTabLabel },
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
