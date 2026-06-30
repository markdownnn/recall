// The declarative section model. The whole onboarding scroll is THIS array, in order.
// Adding a section = push one object here (+ a renderer in SECTION_RENDERERS only if the
// kind is brand-new). Removing = delete the object. Reordering = move objects. The driver
// (Onboarding) maps SECTIONS to SECTION_RENDERERS[kind] and names no individual section -
// this array is the single source of truth for what shows and in what order.
//
// Static sections (hero, how-it-works, search-by-meaning, open-recall) carry only { id, kind }
// because their prose is owner-approved inline copy that lives in its renderer (kept byte-
// identical for the e2e). Only the live try-it card needs data: the samples to seed and the
// example queries to offer.

import { SAMPLES } from './samples'
import type { SampleDoc } from './samples'

export type OnboardingSection =
  | { kind: 'hero'; id: string }
  | { kind: 'how-it-works'; id: string }
  | { kind: 'search-by-meaning'; id: string }
  | { kind: 'try-it'; id: string; samples: SampleDoc[]; exampleQueries: string[] }
  | { kind: 'open-recall'; id: string }

// The set of kinds that have a renderer. The sections test pins every SECTIONS entry against
// this so a new kind without a renderer is caught before it can crash at render.
export const SECTION_KINDS = [
  'hero', 'how-it-works', 'search-by-meaning', 'try-it', 'open-recall',
] as const

export const SECTIONS: OnboardingSection[] = [
  { kind: 'hero', id: 'hero' },
  { kind: 'how-it-works', id: 'how-it-works' },
  { kind: 'search-by-meaning', id: 'search-by-meaning' },
  // The one live card: seed the bundled samples, then search them with the real engine.
  {
    kind: 'try-it',
    id: 'try-it',
    samples: SAMPLES,
    exampleQueries: [
      'how plants turn sunlight into food',
      'the hormone that ruins sleep',
      'why a browser keeps a copy of a page',
    ],
  },
  { kind: 'open-recall', id: 'open-recall' },
]
