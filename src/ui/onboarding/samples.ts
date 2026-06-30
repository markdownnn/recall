// Bundled demo docs seeded through the REAL capture pipeline by the onboarding try-it card,
// so a new user can search real on-device results immediately. Every url is on DEMO_HOST so
// the card's "Remove demo data" (forget-host on DEMO_HOST) cleans them in one call.

export interface SampleDoc {
  // Storage url: on DEMO_HOST so capture + forget-by-host work as one unit. This is what the
  // pages table keys on.
  url: string
  // The REAL public page this sample summarizes. The try-it result card links here so a click
  // opens a live page instead of the fake demo host (which would 404). Storage/forget still
  // key on `url`, untouched.
  sourceUrl: string
  title: string
  text: string
}

// A clearly-fake, reserved-style host. The pages table stores host = new URL(url).hostname,
// so every seeded page gets host === DEMO_HOST and forget-by-host removes exactly these.
export const DEMO_HOST = 'recall-demo.example'

export const SAMPLES: SampleDoc[] = [
  {
    url: 'https://recall-demo.example/photosynthesis',
    sourceUrl: 'https://en.wikipedia.org/wiki/Photosynthesis',
    title: 'How photosynthesis works',
    text:
      'Photosynthesis is how a green plant makes its own food from sunlight. Inside the ' +
      'leaves there is a green pigment called chlorophyll, and chlorophyll is very good at ' +
      'catching light energy. The plant pulls water up through its roots and takes in carbon ' +
      'dioxide gas from the air through tiny holes in its leaves. Using the energy it caught ' +
      'from the sun, the plant joins the water and the carbon dioxide together to build a ' +
      'simple sugar called glucose, which is the food it lives on and uses to grow. As a ' +
      'side effect of making that sugar, the plant releases oxygen back into the air, and ' +
      'that is the same oxygen that people and animals need to breathe. The first part of ' +
      'the process, the light reactions, happens in tiny structures called thylakoids, where ' +
      'the captured light energy is stored. The second part, the sugar building steps, can ' +
      'then run using that stored energy. So a quiet leaf is really a small solar powered ' +
      'food factory working all day long.',
  },
  {
    url: 'https://recall-demo.example/sleep-and-cortisol',
    sourceUrl: 'https://en.wikipedia.org/wiki/Cortisol',
    title: 'Sleep, cortisol, and the body clock',
    text:
      'Cortisol is a stress hormone made by the adrenal glands, two small organs that sit ' +
      'on top of the kidneys. It follows a daily rhythm: it is high in the morning to help ' +
      'you wake up and feel alert, and it slowly falls through the day so that by night it is ' +
      'low. When cortisol is low at night, another signal called melatonin can rise, and ' +
      'melatonin is the chemical that tells the body it is time to sleep. The trouble starts ' +
      'when stress or bright screen light late in the evening keeps cortisol high when it ' +
      'should be dropping. High evening cortisol blocks melatonin from rising, and that is ' +
      'the hormone problem that ruins sleep. People then have trouble falling asleep and they ' +
      'wake up through the night. Keeping the evening calm and dim, and getting bright light ' +
      'in the morning, helps the body clock keep cortisol and melatonin on their normal ' +
      'schedule, so sleep comes more easily and stays deeper.',
  },
  {
    url: 'https://recall-demo.example/http-caching',
    sourceUrl: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Caching',
    title: 'How HTTP caching speeds up the web',
    text:
      'When your browser loads a web page it has to fetch many files: the page itself, the ' +
      'styles, the scripts, and the images. Downloading all of those again every single ' +
      'visit would be slow and would waste data. HTTP caching solves this by letting the ' +
      'browser keep a local copy of a file and reuse it instead of asking the server again. ' +
      'The server controls this with response headers. A Cache-Control header can say how ' +
      'long a copy stays fresh, for example one hour, and during that time the browser uses ' +
      'its stored copy with no network request at all. After the copy goes stale the browser ' +
      'can make a quick conditional request using an ETag or a Last-Modified value; if ' +
      'nothing changed the server answers with a tiny 304 Not Modified and the old copy is ' +
      'reused, saving the full download. Good caching makes a site feel fast, lowers the load ' +
      'on the server, and lets pages work even on a weak connection, which is why almost ' +
      'every fast website tunes its cache headers carefully.',
  },
]

// Pure guard: a sample is valid only if it has a non-empty title, real text, and its url
// is parseable AND hosted on DEMO_HOST (so cleanup by host can never miss it).
export function isValidSample(d: SampleDoc): boolean {
  if (!d.title.trim() || !d.text.trim()) return false
  try {
    return new URL(d.url).hostname === DEMO_HOST
  } catch {
    return false
  }
}

// Demo pages are STORED under DEMO_HOST (so "Remove demo data" is one forget-host call), but
// their real source lives in `sourceUrl`. Every result renderer (search, history, try-it) must
// link to the real page, not the fake demo host (which 404s). Returns the real source for a
// known demo url, otherwise the url unchanged - so it is a safe no-op for real captured pages.
const SOURCE_BY_URL = new Map(SAMPLES.map((s) => [s.url, s.sourceUrl]))
export function demoLinkFor(url: string): string {
  return SOURCE_BY_URL.get(url) ?? url
}
