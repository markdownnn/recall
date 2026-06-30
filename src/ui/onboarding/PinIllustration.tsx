// Schematic line-art of the Chrome "pin the extension" flow, shown in the
// "How to open Recall" section. Inline Preact SVG (not a build asset) so it
// scales crisply and can read the page's --accent CSS variable directly.
//
// What it depicts:
//   1. The browser toolbar (top-right): omnibox end + a row of small icons,
//      with the extensions PUZZLE-PIECE icon highlighted (click this first).
//   2. A dropdown listing "Recall" with a PIN (thumbtack) icon next to it,
//      the pin highlighted in the indigo accent (click this to pin).
//   3. A subtle dashed arrow connecting puzzle -> pin, plus the Recall icon
//      now sitting pinned in the toolbar.
//
// Coordinates are tuned for a 560x250 viewBox; the element is width:100% and
// responsive via the .pin-illustration rule in onboarding.css.

// Material "extension" (puzzle piece) glyph, drawn in a 24x24 box.
const PUZZLE_PATH =
  'M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4' +
  'c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20' +
  'c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7s2.7 1.21 2.7 2.7V22H17' +
  'c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z'

// Material "push_pin" (thumbtack) glyph, drawn in a 24x24 box.
const PIN_PATH =
  'M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5' +
  'c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z'

export function PinIllustration() {
  return (
    <svg
      class="pin-illustration"
      viewBox="0 0 560 250"
      role="img"
      aria-labelledby="pin-illo-title pin-illo-desc"
      font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    >
      <title id="pin-illo-title">How to pin Recall to the toolbar</title>
      <desc id="pin-illo-desc">
        Click the extensions puzzle-piece icon in the Chrome toolbar, then click
        the pin icon next to Recall to keep it visible.
      </desc>

      {/* ---- Browser toolbar strip ---- */}
      <rect x="24" y="20" width="512" height="48" rx="12" fill="#ffffff" stroke="#e5e7eb" stroke-width="1.5" />
      {/* Omnibox / address bar */}
      <rect x="44" y="34" width="250" height="20" rx="10" fill="#f3f4f6" />
      <circle cx="58" cy="44" r="3" fill="#cbd0d8" />

      {/* Recall, now pinned in the toolbar (the outcome) */}
      <rect x="362" y="34" width="20" height="20" rx="6" fill="var(--accent-soft, #eef2ff)" stroke="var(--accent, #4f46e5)" stroke-width="1.5" />
      <rect x="368" y="40" width="8" height="8" rx="2" fill="var(--accent, #4f46e5)" />

      {/* Extensions puzzle-piece icon, highlighted (step 1) */}
      <circle cx="420" cy="44" r="17" fill="#ffffff" stroke="var(--accent, #4f46e5)" stroke-width="2" />
      <g transform="translate(410,34) scale(0.833)" fill="#4b5563">
        <path d={PUZZLE_PATH} />
      </g>

      {/* Overflow menu (three dots) */}
      <circle cx="500" cy="37" r="2" fill="#9ca3af" />
      <circle cx="500" cy="44" r="2" fill="#9ca3af" />
      <circle cx="500" cy="51" r="2" fill="#9ca3af" />

      {/* Step badge 1 */}
      <circle cx="441" cy="25" r="9.5" fill="var(--accent, #4f46e5)" />
      <text x="441" y="29" text-anchor="middle" font-size="11" font-weight="700" fill="#ffffff">1</text>

      {/* ---- Dropdown popover ---- */}
      {/* Caret pointing up to the puzzle icon */}
      <path d="M414 96 L420 88 L426 96 Z" fill="#ffffff" stroke="#e5e7eb" stroke-width="1.5" />
      <rect x="320" y="96" width="200" height="120" rx="12" fill="#ffffff" stroke="#e5e7eb" stroke-width="1.5" />
      {/* cover the caret base seam */}
      <rect x="415" y="96" width="10" height="3" fill="#ffffff" />

      <text x="336" y="119" font-size="11" font-weight="600" fill="#9ca3af" letter-spacing="0.04em">EXTENSIONS</text>
      <line x1="320" y1="128" x2="520" y2="128" stroke="#f0f1f4" stroke-width="1.5" />

      {/* Row: Recall (the target) */}
      <rect x="328" y="138" width="184" height="30" rx="7" fill="var(--accent-soft, #eef2ff)" />
      <rect x="338" y="145" width="16" height="16" rx="4" fill="var(--accent-soft, #eef2ff)" stroke="var(--accent, #4f46e5)" stroke-width="1.5" />
      <rect x="342" y="149" width="8" height="8" rx="2" fill="var(--accent, #4f46e5)" />
      {/* Brand label, split into two adjacent <text> nodes on purpose: it reads
          "Recall" visually, but no single element has the exact text "Recall",
          so the onboarding e2e's exact brand locator stays unambiguous. */}
      <text x="364" y="158" font-size="13" font-weight="600" fill="#111827">Re</text>
      <text x="380" y="158" font-size="13" font-weight="600" fill="#111827">call</text>
      {/* Pin icon, highlighted (step 2) */}
      <g transform="translate(484,145) scale(0.667)" fill="var(--accent, #4f46e5)">
        <path d={PIN_PATH} />
      </g>

      {/* Row: another extension (muted, for context) */}
      <rect x="338" y="183" width="16" height="16" rx="4" fill="#f1f2f4" />
      <text x="364" y="196" font-size="13" font-weight="500" fill="#9ca3af">Other extension</text>
      <g transform="translate(484,183) scale(0.667)" fill="none" stroke="#cbd0d8" stroke-width="2">
        <path d={PIN_PATH} />
      </g>

      {/* Step badge 2 */}
      <circle cx="504" cy="140" r="9.5" fill="var(--accent, #4f46e5)" />
      <text x="504" y="144" text-anchor="middle" font-size="11" font-weight="700" fill="#ffffff">2</text>

      {/* ---- Subtle dashed arrow: puzzle -> pin ---- */}
      <path
        d="M432 58 C 470 70, 500 96, 496 132"
        fill="none"
        stroke="var(--accent, #4f46e5)"
        stroke-width="2"
        stroke-dasharray="4 4"
        opacity="0.55"
      />
      <path d="M491 124 L496 134 L501 125 Z" fill="var(--accent, #4f46e5)" opacity="0.55" />
    </svg>
  )
}
