# Recall — Chrome Web Store submission guide

A literal do-this-then-that checklist. Files referenced here live in `docs/store/` and
`assets/store/`.

---

## Part A — Already DONE in the repo (verify, don't redo)

- [x] **MV3 manifest** with name "Recall", side panel UI, no popup. (`manifest.config.ts`)
- [x] **No remote code.** JavaScript/WASM are bundled. Model artifact files may be loaded
      from the extension package or a configured Cloudflare R2 bucket; those files are data,
      not executable extension code.
- [x] **No telemetry / analytics.** `src/core/telemetry.ts` is a never-wired `NullTelemetry`.
- [x] **Icons** at 16/32/48/128. (`public/icons/`, also in `dist-ext/icons/`)
- [x] **English-only locale** (`public/_locales/en/messages.json`).
- [x] **Privacy gate** in code: dwell+engagement, denylist, SERP/internal skip, tracking-param strip.
- [x] **Promo tiles** generated: `assets/store/promo-small-440x280.png`,
      `assets/store/promo-marquee-1400x560.png`.
- [x] **Store copy drafted:** `listing-en.md`, `privacy-policy.md`, `permissions.md`,
      `data-safety.md`.

---

## Part B — Things the OWNER must do (in order)

### 1. Build a fresh package
Run a clean package build to get the upload zip:
```
npm run package
```
This produces `recall-extension.zip` (runs `prebuild` model fetch/verify + `vite build`,
then zips `dist-ext` without source maps). Upload **this** zip.

### 2. Screenshots (designed hero mockups - already generated)
Three polished 1280x800 marketing hero images are ready in `assets/store/screenshots/en/`:
`01-search.png` (search by meaning), `02-auto-capture.png`, and `03-private.png`
(on-device privacy). They are designed mockups (clean HTML/CSS, not raw captures).
To tweak copy/colors/content and regenerate:
```
node scripts/store-mockups.mjs
```
Upload at least one (3-5 is better). Lead with `01-search-results.png`.

### 3. Host the privacy policy and copy the URL
- Publish `docs/store/privacy-policy.md` (or its English half) at a public URL
  (GitHub Pages, a gist's raw URL, or your site).
- Keep that URL handy for step 6.

### 4. Create the item in the dashboard
- Go to the Chrome Web Store Developer Dashboard -> **New item** -> upload
  `recall-extension.zip` from step 1.

### 5. Fill the Store listing tab
- **Category:** Productivity.
- **Language:** add English.
- **Short description (EN):** paste from `listing-en.md`.
- **Detailed description (EN):** paste from `listing-en.md`.
- **Screenshots:** upload the PNGs from step 2 (1280x800).
- **Promo tiles:** upload `assets/store/promo-small-440x280.png` (small) and
  `assets/store/promo-marquee-1400x560.png` (marquee).
- **Icon:** the 128px icon is taken from the package; no separate upload needed.

### 6. Fill the Privacy practices tab
Use `data-safety.md` for exact answers:
- **Privacy policy URL:** paste the URL from step 3.
- **Single purpose:** paste the single-purpose statement.
- **Permission justifications:** paste each row from `permissions.md` into the matching
  permission box.
- **Remote code:** answer **No**.
- **Data collection:** mark every category as **not collected / not transmitted**
  (everything is on-device). See the table in `data-safety.md`.
- **Certifications:** check all three (no selling, no unrelated use, no creditworthiness).

### 7. Expect heavier review (don't be surprised)
"Reads website content" + `<all_urls>` usually triggers stricter review. Have the
talking points from `data-safety.md` ready: page text is read on-device only, CSP blocks
egress, sensitive sites are denylisted. If asked to narrow permissions, see the optional
`activeTab`-only experiment noted in `permissions.md` (it removes silent auto-capture, so
only adopt it deliberately).

### 8. Submit for review
- Double-check the listing preview, then **Submit for review**.

---

## Quick reference — which file feeds which dashboard field

| Dashboard field | Source file |
| --- | --- |
| Short + detailed description (EN) | `listing-en.md` |
| Single-purpose statement | `listing-en.md` / `data-safety.md` |
| Privacy policy URL | hosted `privacy-policy.md` |
| Permission justifications | `permissions.md` |
| Data collection answers + certifications | `data-safety.md` |
| Screenshots | `assets/store/screenshots/` (after step 2) |
| Promo tiles | `assets/store/promo-*.png` |
| Upload package | `recall-extension.zip` (from `npm run package`) |
