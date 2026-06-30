# Recall — Privacy Policy

_Last updated: 2026-06-30_

> This document has two parts: an **English** version and a **Korean (한국어)** version.
> They say the same thing. Host either or both at a public URL and paste that URL into
> the Chrome Web Store listing's "Privacy policy" field.

---

## English

### The short version

Recall keeps **everything on your own device**. It does not send your browsing,
the pages you read, your searches, or anything else to us or to any other server.
We do not have a server that receives your data. We collect nothing. We sell nothing.
There are no accounts, no logins, no analytics, and no ads.

### What Recall does

Recall helps you find pages you have already read. When you genuinely read a web page,
Recall saves a clean copy of that page's readable text **into a private database that
lives inside your browser, on your computer**. Later you can search those saved pages by
**meaning**, in your own words, in Korean or English. The search runs on your device too.

To do this, Recall uses two things that both run locally:

1. A small database (SQLite, stored in your browser's private OPFS storage).
2. A bundled language model (~107 MB, IBM Granite multilingual embeddings) that turns
   text into searchable "meaning vectors." The model file ships **inside the extension**.
   It is never downloaded at runtime.

### Where your data lives

All captured text, page titles, page URLs, and the search index live **only** in your
browser's local storage on your machine. None of it is uploaded. Recall's network policy
is enforced in code: the extension's Content Security Policy is `connect-src 'self'`,
which means the extension is **technically blocked from connecting to any remote server**.

### What is captured — and what is NOT

Recall is careful about what it saves. Capture is **gated**: a page is only auto-saved
after you have actually engaged with it (it has been visible for a dwell period **and**
you scrolled through a meaningful part of it or selected some text — short pages that fit
on screen count as read).

Recall **does not** auto-save:

- **Sensitive sites** on a built-in denylist: banking, payments and checkout, login /
  sign-in / auth pages, account and password settings, webmail, health portals, and
  password managers. (This is best-effort, not a guarantee — see "Limits" below.)
- **Search-results pages** (Google, Bing, DuckDuckGo, and others) — they are just lists
  of links.
- **Internal / private-network pages** — `localhost`, intranet hosts, and private IP
  ranges.
- **Very short pages** (under ~100 words).

When Recall does save a URL, it first **strips common tracking parameters**
(`utm_*`, `gclid`, `fbclid`, `msclkid`, and similar) so trackers are not stored.

Recall has **no telemetry**. There is no analytics code that runs; the telemetry seam in
the codebase is a do-nothing stub (`NullTelemetry`) and is never wired to any network.

### Your controls

You are always in charge of what Recall remembers:

- **Pause capturing** — a global switch that stops all saving.
- **Don't remember this site** — block a specific site from ever being saved.
- **Forget this site's history** — delete everything Recall saved from a site and its
  subdomains. This cannot be undone.
- **Per-page capture** — save (or skip) the current page yourself.

If you **uninstall** Recall, Chrome removes the extension and its local storage, so the
captured database is deleted along with it.

### What we receive

Nothing. There is no "we" on the receiving end. Recall has no backend, so there is no
data for us to access, store, share, or sell. Because nothing is transmitted, there is
nothing for third parties to receive either.

### Limits (an honest note)

The sensitive-site denylist is **best-effort**. New banks, health portals, and login
flows appear all the time, so no fixed list can be perfect. If a page you consider
private was saved, use **"Forget this site's history"** to delete it and **"Don't
remember this site"** so it is never saved again, or **Pause capturing** entirely.

### Children

Recall is a general-purpose productivity tool and is not directed at children.

### Changes

If this policy changes, the updated version will be published at the same URL with a new
"Last updated" date.

### Contact

Questions about privacy: **mark@linercorp.com**

---

## 한국어 (Korean)

### 한 줄 요약

Recall은 **모든 것을 당신의 기기 안에만** 보관합니다. 당신이 본 페이지, 검색어, 방문
기록 같은 어떤 것도 우리에게나 다른 서버로 보내지 않습니다. 데이터를 받는 서버 자체가
없습니다. 아무것도 수집하지 않고, 아무것도 팔지 않습니다. 계정도, 로그인도, 분석 추적도,
광고도 없습니다.

### Recall이 하는 일

Recall은 당신이 이미 읽은 페이지를 다시 찾도록 도와줍니다. 당신이 어떤 웹 페이지를
실제로 읽으면, Recall은 그 페이지의 읽을 만한 본문을 깨끗하게 정리해서 **브라우저 안,
즉 당신 컴퓨터 안의 비공개 데이터베이스에** 저장합니다. 나중에 당신은 그 저장된 페이지들을
**의미로** — 당신의 말로, 한국어나 영어로 — 검색할 수 있습니다. 검색도 당신의 기기에서
돌아갑니다.

이를 위해 Recall은 모두 로컬에서 도는 두 가지를 씁니다.

1. 작은 데이터베이스(SQLite, 브라우저의 비공개 OPFS 저장소에 보관).
2. 함께 들어 있는 언어 모델(약 107 MB, IBM Granite 다국어 임베딩). 글을 검색 가능한
   "의미 벡터"로 바꿔줍니다. 이 모델 파일은 **확장 프로그램 안에 들어 있고**, 실행 중에
   인터넷에서 내려받지 않습니다.

### 데이터가 사는 곳

저장된 모든 본문, 페이지 제목, 페이지 주소(URL), 검색 색인은 **오직** 당신 기기의
브라우저 로컬 저장소에만 있습니다. 어디로도 업로드되지 않습니다. 이 규칙은 코드로
강제됩니다. 확장 프로그램의 보안 정책(CSP)이 `connect-src 'self'`로 설정되어 있어,
확장 프로그램이 **어떤 원격 서버에도 접속할 수 없게 기술적으로 막혀** 있습니다.

### 무엇을 저장하고, 무엇을 저장하지 않는가

Recall은 무엇을 저장할지 신중합니다. 저장에는 **관문**이 있습니다. 당신이 페이지에 실제로
머문 뒤에만(일정 시간 화면에 보였고 **그리고** 의미 있는 만큼 스크롤했거나 텍스트를
선택했을 때 — 화면에 다 들어오는 짧은 페이지는 읽은 것으로 봅니다) 자동 저장됩니다.

Recall은 다음을 **자동 저장하지 않습니다.**

- 내장 차단 목록에 있는 **민감한 사이트**: 은행, 결제·체크아웃, 로그인·인증 페이지,
  계정·비밀번호 설정, 웹메일, 건강 포털, 비밀번호 관리자. (완벽한 보장이 아니라 최선의
  노력입니다 — 아래 "한계" 참고.)
- **검색 결과 페이지**(구글, 빙, 덕덕고 등) — 그저 링크 목록이라서요.
- **내부·사설 네트워크 페이지** — `localhost`, 인트라넷 호스트, 사설 IP 대역.
- **아주 짧은 페이지**(대략 100단어 미만).

URL을 저장할 때는 먼저 흔한 **추적용 파라미터**(`utm_*`, `gclid`, `fbclid`, `msclkid`
등)를 떼어내서 추적자가 저장되지 않게 합니다.

Recall에는 **수집·분석 기능이 없습니다.** 동작하는 분석 코드가 없고, 코드 안의 분석
자리는 아무 일도 하지 않는 빈 껍데기(`NullTelemetry`)이며 어떤 네트워크에도 연결되어
있지 않습니다.

### 당신의 통제권

무엇을 기억할지는 언제나 당신이 정합니다.

- **저장 일시정지** — 모든 저장을 멈추는 전체 스위치.
- **이 사이트는 기억하지 않기** — 특정 사이트를 저장 대상에서 영구 차단.
- **이 사이트 기록 지우기** — 어떤 사이트와 그 하위 도메인에서 저장한 것을 모두 삭제.
  되돌릴 수 없습니다.
- **페이지별 저장** — 지금 보는 페이지를 직접 저장하거나 건너뛰기.

Recall을 **삭제(제거)하면** 크롬이 확장 프로그램과 그 로컬 저장소를 함께 지우므로,
저장된 데이터베이스도 같이 삭제됩니다.

### 우리가 받는 것

없습니다. 받는 "우리" 자체가 없습니다. Recall에는 백엔드 서버가 없어서, 우리가 접근하거나
보관하거나 공유하거나 팔 데이터가 존재하지 않습니다. 아무것도 전송되지 않으므로 제3자가
받을 것도 없습니다.

### 한계 (솔직한 안내)

민감한 사이트 차단 목록은 **최선의 노력**입니다. 새로운 은행, 건강 포털, 로그인 흐름은
계속 생기므로 고정된 목록이 완벽할 수는 없습니다. 비공개라고 여기는 페이지가 저장됐다면,
**"이 사이트 기록 지우기"**로 삭제하고 **"이 사이트는 기억하지 않기"**로 다시 저장되지
않게 하거나, **저장 일시정지**로 아예 멈출 수 있습니다.

### 아동

Recall은 일반 생산성 도구이며 아동을 대상으로 하지 않습니다.

### 변경

이 정책이 바뀌면 같은 URL에 새 "최종 수정일"과 함께 갱신본을 올립니다.

### 문의

개인정보 관련 문의: **mark@linercorp.com**
