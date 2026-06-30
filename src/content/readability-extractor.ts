import { Readability } from '@mozilla/readability'
import type { ExtractionPort } from '../core/ports'
import { stripBoilerplate } from '../core/boilerplate-strip'
import { cleanReferenceNodes } from '../core/reference-clean'

// The production extraction pipeline behind the ExtractionPort seam:
//   1. clone the live document (never mutate the page the user is reading);
//   2. DOM pre-clean - cleanReferenceNodes() removes citation structure (sup.reference,
//      reflist/ol.references/mw-references-wrap, and #References/#See_also/... sections)
//      BEFORE Readability, so the citation chunk never enters the "article" in the first place;
//   3. Readability 0.6 .parse() to isolate the article;
//   4. block-join - re-parse article.content (HTML) and join h1-h4/p/li/blockquote/pre on
//      their own lines so paragraph boundaries survive for the chunker AND so section headings
//      land on their own line for the text-level safety net;
//   5. stripBoilerplate() - the text-level fallback that catches reference sections on
//      non-Wikipedia pages whose DOM shape the selector pre-clean does not know.
//
// linkDensityModifier (new in Readability 0.6) is left at its default. It only shifts
// Readability's INTERNAL link-density thresholds, and the golden-set harness scores
// pre-extracted fixtures (it does not run Readability), so its effect cannot be measured there.
// The measurable lever for citation pollution is the DOM pre-clean above; the option is noted
// here as the tuning hook if a Readability-in-the-loop A/B harness is added later.
const BLOCK_SEL = 'h1,h2,h3,h4,p,li,blockquote,pre'

export class ReadabilityExtractor implements ExtractionPort {
  extract(doc: Document): { title: string; text: string } | null {
    const clone = doc.cloneNode(true) as Document
    cleanReferenceNodes(clone.documentElement)
    const article = new Readability(clone).parse()
    let text: string
    if (article?.content) {
      const parsed = new DOMParser().parseFromString(article.content, 'text/html')
      const blocks = [...parsed.querySelectorAll(BLOCK_SEL)]
      const joined = blocks.map((b) => b.textContent?.trim() ?? '').filter(Boolean).join('\n')
      text = stripBoilerplate(joined).trim()
    } else {
      text = article?.textContent?.trim() || (doc.body?.innerText ?? '')
    }
    if (!text) return null
    return { title: article?.title ?? doc.title, text }
  }
}
