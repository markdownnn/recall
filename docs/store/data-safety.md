# Data safety / Privacy practices — answers to paste

These are concrete answers for the Chrome Web Store **Privacy practices** tab. Recall
collects and transmits **no** data; everything is processed and stored on-device. Where
the dashboard asks you to certify, the honest answer is the privacy-friendly one.

## Privacy policy URL

Host `docs/store/privacy-policy.md` (or its English half) at a public URL and paste it
into **Privacy policy URL**. This field is required.

## Single purpose

> Recall helps you re-find web pages you have already read by saving their readable text
> locally and letting you search that text by meaning. All capture, storage, and search
> happen on the user's own device; the extension transmits no data.

## Permission justifications

See `permissions.md` - paste each row into the matching permission's justification box.

## "Are you using remote code?"

**No.** All JavaScript/WASM is bundled in the package. The embedding model (~107 MB) and
the ONNX runtime ship inside the extension; nothing is fetched or `eval`'d from a remote
source at runtime. (CSP: `connect-src 'self'`, `script-src 'self' 'wasm-unsafe-eval'`.)

## Data collection & use (the "What data does your item collect?" checklist)

For every data category the form lists, the answer is **NOT collected** and **NOT
transmitted**, because nothing leaves the device. If the form forces you to acknowledge
that the extension *processes* certain data locally, answer truthfully that it is
**processed on-device only and never sent off the device**:

| Data type | Collected/transmitted off device? | Note |
| --- | --- | --- |
| Personally identifiable info (name, address, email, ID, etc.) | No | Not requested, not stored. |
| Health information | No | Health portals are denylisted from capture. |
| Financial / payment info | No | Banking/payment/checkout sites are denylisted. |
| Authentication information (passwords) | No | Login/auth pages and password managers are denylisted. |
| Personal communications (email, messages) | No | Webmail is denylisted. |
| Location | No | Not requested. |
| Web history | No (not transmitted) | The text/URLs of pages the user reads are saved **only in local OPFS storage on the device**. Never uploaded. |
| Website content (text the user reads) | No (not transmitted) | Readable page text is extracted and indexed **locally only** for on-device search. |
| User activity (clicks, analytics) | No | No analytics/telemetry. The telemetry seam is a no-op stub. |

## Required certifications

You can truthfully check all three:

- [x] I do **not** sell or transfer user data to third parties (outside approved use cases).
- [x] I do **not** use or transfer user data for purposes unrelated to the item's single purpose.
- [x] I do **not** use or transfer user data to determine creditworthiness or for lending.

## Heads-up: this item may get heavier review

Recall reads **website content** (the text of pages the user reads) via a broad content
script. Even though that text **never leaves the device**, "reads website content" plus
`<all_urls>` typically triggers Google's stricter review. Be ready to explain - using
this file and `permissions.md` - that:

1. Reading page text is the core, single purpose (local semantic search of your reading).
2. The text is processed and stored **on-device only**; CSP blocks all network egress.
3. Sensitive categories (finance, health, auth, webmail) are denylisted from capture.

If review pushes back on `<all_urls>`, see the optional `activeTab`-only narrowing in
`permissions.md`.
