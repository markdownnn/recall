// Recall - Chrome Web Store HERO MOCKUPS (designed, not real captures), EN + KO sets.
// Renders polished 1280x800 marketing images via Playwright into en/ and ko/ subfolders.
// Run: node scripts/store-mockups.mjs

import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, '..', 'assets/store/screenshots')
const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Apple SD Gothic Neo','Malgun Gothic',Helvetica,Arial,sans-serif`

// Localized side-panel chrome labels (the KO mockups show the Korean UI).
const L = {
  en: { ready: 'ready', saved: 'saved', search: 'Search', update: 'Update this page', recent: 'Recently saved',
        pill: '100% on your device - nothing ever leaves it' },
  ko: { ready: '준비됨', saved: '저장됨', search: '검색', update: '이 페이지 업데이트', recent: '최근 저장',
        pill: '100% 내 기기 안에서 - 아무것도 밖으로 안 나갑니다' },
}

function panel(inner) {
  return `<div style="width:404px;background:#fff;border-radius:22px;border:1px solid rgba(17,24,39,.06);
    box-shadow:0 40px 90px rgba(49,46,129,.32);overflow:hidden;font-family:${FONT}">${inner}</div>`
}
function head(right = '') {
  return `<div style="display:flex;align-items:center;justify-content:space-between;padding:18px 20px;border-bottom:1px solid #f1f2f7">
    <span style="font-size:18px;font-weight:800;color:#111827;letter-spacing:-.02em">Recall</span>${right}</div>`
}
const dotReady = (lab) => `<span style="display:inline-flex;align-items:center;gap:7px;font-size:13px;color:#6b7280">
  <span style="width:8px;height:8px;border-radius:99px;background:#22c55e"></span>${lab}</span>`
const badgeSaved = (lab) => `<span style="font-size:13px;font-weight:600;color:#15803d;background:#dcfce7;border:1px solid #bbf7d0;border-radius:99px;padding:4px 12px">${lab}</span>`
function searchbar(q, lab) {
  return `<div style="display:flex;gap:8px;padding:16px 18px">
    <div style="flex:1;border:1.5px solid #c7cdff;border-radius:11px;padding:11px 14px;font-size:14px;color:#111827">${q}</div>
    <div style="background:#4f46e5;color:#fff;border-radius:11px;padding:11px 18px;font-size:14px;font-weight:600">${lab}</div></div>`
}
function result(title, snippet, host, top) {
  return `<div style="margin:0 18px 12px;border:1px solid #eef0f5;border-radius:14px;padding:14px 16px;${top ? 'box-shadow:0 6px 18px rgba(79,70,229,.10);border-color:#dfe2ff' : ''}">
    <div style="font-size:14.5px;font-weight:700;color:#4f46e5;margin-bottom:6px">${title}</div>
    <div style="font-size:13px;line-height:1.55;color:#374151">${snippet}</div>
    <div style="font-size:12px;color:#9ca3af;margin-top:9px">${host}</div></div>`
}
function capturePanel(lab, title, host, recentTitles) {
  return head(badgeSaved(lab.saved)) +
    `<div style="padding:18px 20px 6px"><div style="font-size:15px;font-weight:700;color:#111827">${title}</div>
      <div style="font-size:13px;color:#9ca3af;margin-top:3px">${host}</div></div>
     <div style="margin:10px 20px 0;background:#eef2ff;color:#4338ca;font-weight:600;font-size:14px;text-align:center;border-radius:12px;padding:13px">${lab.update}</div>
     <div style="padding:14px 20px 4px;font-size:13px;color:#6b7280">${lab.recent}</div>
     <div style="padding:0 20px 18px">${recentTitles.map((t2, i) =>
       `<div style="display:flex;align-items:center;gap:10px;padding:9px 0;${i ? 'border-top:1px solid #f1f2f7' : ''}">
         <span style="width:7px;height:7px;border-radius:99px;background:#22c55e;flex:0 0 auto"></span>
         <span style="font-size:13.5px;color:#374151">${t2}</span></div>`).join('')}</div>`
}
function privatePanel(lab, heading, body, checks) {
  return head(dotReady(lab.ready)) +
    `<div style="padding:26px 22px;text-align:center">
      <div style="font-size:46px">&#128274;</div>
      <div style="font-size:17px;font-weight:700;color:#111827;margin-top:10px">${heading}</div>
      <div style="font-size:13.5px;line-height:1.6;color:#6b7280;margin-top:8px">${body}</div></div>
     <div style="margin:0 20px 20px;border-top:1px solid #f1f2f7;padding-top:14px">
       ${checks.map((t2) => `<div style="display:flex;align-items:center;gap:10px;padding:7px 0;font-size:14px;color:#374151">
         <span style="color:#16a34a;font-weight:800">&#10003;</span>${t2}</div>`).join('')}</div>`
}
function render(headline, sub, pill, inner, from, to) {
  return `<!doctype html><html><body style="margin:0">
  <div style="width:1280px;height:800px;box-sizing:border-box;display:flex;align-items:center;gap:76px;
    padding:0 92px;background:linear-gradient(135deg,${from} 0%,${to} 100%);font-family:${FONT}">
    <div style="flex:1;max-width:548px">
      <div style="font-size:23px;font-weight:800;color:#4338ca;letter-spacing:-.02em">Recall</div>
      <h1 style="font-size:52px;line-height:1.08;color:#171453;margin:20px 0 0;font-weight:800;letter-spacing:-.025em">${headline}</h1>
      <p style="font-size:22px;line-height:1.5;color:#4b5563;margin:22px 0 0">${sub}</p>
      <div style="margin-top:30px;display:inline-flex;align-items:center;gap:9px;font-size:15px;font-weight:600;color:#4338ca;
        background:rgba(255,255,255,.85);border:1px solid #c7cdff;border-radius:999px;padding:10px 18px">
        <span style="font-size:15px">&#128274;</span>${pill}</div>
    </div>
    <div style="flex:0 0 auto">${panel(inner)}</div>
  </div></body></html>`
}

// Each scene defines both languages. inner is built from the localized panel helpers.
const SCENES = [
  {
    id: '01-search', from: '#eef1ff', to: '#dbe0ff',
    en: {
      headline: 'Find anything you&#8217;ve read.',
      sub: 'Forgot the exact words? Just describe what it was about &#8212; Recall searches by meaning, not keywords.',
      inner: head(dotReady(L.en.ready)) + searchbar('why can&#8217;t I sleep at night', L.en.search) +
        result('Sleep, cortisol, and the body clock', 'Cortisol follows a daily rhythm, low at night so melatonin can rise. High evening cortisol blocks melatonin &#8212; the hormone problem that ruins sleep&#8230;', 'en.wikipedia.org', true) +
        result('Why your brain wakes at 3am', 'Light exposure late in the evening keeps the body clock from settling, so sleep pressure never fully&#8230;', 'sleepfoundation.org', false),
    },
    ko: {
      headline: '읽은 건, 다시 찾는다.',
      sub: '정확한 단어가 기억 안 나도 괜찮아요. 의미로 검색하면 Recall이 그 페이지를 찾아줍니다.',
      inner: head(dotReady(L.ko.ready)) + searchbar('밤에 잠 안 오는 이유', L.ko.search) +
        result('수면, 코르티솔, 그리고 생체시계', '코르티솔은 하루 주기로 움직여 밤에는 낮아지고 멜라토닌이 올라옵니다. 저녁에 코르티솔이 높으면 멜라토닌을 막아 잠을 망칩니다&#8230;', 'ko.wikipedia.org', true) +
        result('뇌가 새벽 3시에 깨는 이유', '늦은 저녁의 빛 노출이 생체시계를 흔들어, 잠을 부르는 압력이 끝까지 쌓이지 못하고&#8230;', 'ko.wikipedia.org', false),
    },
  },
  {
    id: '02-auto-capture', from: '#eafaf1', to: '#d6f0ff',
    en: {
      headline: 'It remembers, so you don&#8217;t have to.',
      sub: 'Recall quietly saves the pages you actually read &#8212; automatically, on-device. Find them again whenever you need.',
      inner: capturePanel(L.en, 'Attention Is All You Need', 'arxiv.org',
        ['The Illustrated Transformer', 'React useEffect, explained', 'How HTTP caching works']),
    },
    ko: {
      headline: '기억은 Recall이 대신.',
      sub: '실제로 읽은 페이지를 기기 안에서 자동으로 저장해요. 필요할 때 의미로 다시 찾으세요.',
      inner: capturePanel(L.ko, 'Attention Is All You Need', 'arxiv.org',
        ['트랜스포머 쉽게 이해하기', 'React useEffect 완벽 정리', 'HTTP 캐싱 동작 원리']),
    },
  },
  {
    id: '03-private', from: '#f1edff', to: '#e7e0ff',
    en: {
      headline: 'Private by design.',
      sub: 'No servers. No tracking. No accounts. The AI model and your entire reading history live on your computer &#8212; and stay there.',
      inner: privatePanel(L.en, 'On-device AI search',
        'A 107&#8201;MB model runs locally in your browser. Your pages are never uploaded, indexed in the cloud, or shared.',
        ['Zero network requests', 'Korean &amp; English search', 'Pause or forget anytime']),
    },
    ko: {
      headline: '처음부터, 프라이버시.',
      sub: '서버도, 추적도, 계정도 없어요. AI 모델과 읽은 기록 전부가 내 컴퓨터 안에만 있고, 그대로 머뭅니다.',
      inner: privatePanel(L.ko, '기기 내 AI 검색',
        '107&#8201;MB 모델이 브라우저에서 로컬로 실행돼요. 페이지는 업로드되거나 클라우드에 색인되거나 공유되지 않습니다.',
        ['네트워크 요청 0', '한국어·영어 검색', '언제든 일시중지·삭제']),
    },
  },
]

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  for (const lang of ['en', 'ko']) {
    const dir = path.join(OUT, lang)
    mkdirSync(dir, { recursive: true })
    for (const s of SCENES) {
      const c = s[lang]
      await page.setContent(render(c.headline, c.sub, L[lang].pill, c.inner, s.from, s.to), { waitUntil: 'load' })
      await page.screenshot({ path: path.join(dir, `${s.id}.png`) })
      console.log('rendered', `${lang}/${s.id}.png`)
    }
  }
  await browser.close()
  console.log('done -> ' + OUT)
}
main().catch((e) => { console.error(e); process.exit(1) })
