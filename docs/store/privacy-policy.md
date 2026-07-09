# Recall - Privacy Policy

_Last updated: 2026-07-08_

## The short version

Recall keeps your reading data on your own device. It does not send the pages you read,
your saved page text, your page URLs, your search queries, or your Ask questions to us or
to any other server. We collect nothing. We sell nothing. There are no accounts, no logins,
no analytics, and no ads.

Model files may be loaded from the extension package or from a configured Cloudflare R2
model bucket. Those files are public model artifacts. They are not your data.

## What Recall does

Recall helps you find and ask about pages you have already read. When you genuinely read a
web page, Recall saves a clean copy of that page's readable text into a private database
inside your browser, on your computer. Later you can search those saved pages by meaning in
English, or ask a question that is answered only from saved passages.

To do this, Recall uses:

1. A small database, SQLite, stored in your browser's private OPFS storage.
2. A BGE English embedding model that turns text into searchable meaning vectors.
3. A WebLLM answer model that writes Ask answers from retrieved saved passages.

## Where your data lives

Captured text, page titles, page URLs, the search index, search queries, and Ask questions
live only in your browser's local storage on your machine. None of that user data is
uploaded.

## What is captured, and what is not

Recall is careful about what it saves. Capture is gated: a page is only auto-saved after
you have actually engaged with it.

Recall does not auto-save:

- Sensitive sites on a built-in denylist: banking, payments and checkout, login or auth
  pages, account and password settings, webmail, health portals, and password managers.
- Search-results pages, because they are just lists of links.
- Internal or private-network pages, such as `localhost`, intranet hosts, and private IP
  ranges.
- Very short pages.

When Recall saves a URL, it first strips common tracking parameters such as `utm_*`,
`gclid`, `fbclid`, `msclkid`, and similar values.

Recall has no telemetry. There is no analytics code that runs. The telemetry seam in the
codebase is a do-nothing stub and is not wired to any network.

## Your controls

You are always in charge of what Recall remembers:

- Pause capturing globally.
- Block a specific site with "Don't remember this site".
- Delete everything Recall saved from a site and its subdomains with "Forget this site's
  history".
- Save or skip the current page yourself.

If you uninstall Recall, Chrome removes the extension and its local storage, so the local
captured database is deleted too.

## What we receive

Nothing. Recall has no backend that receives your reading data. Because your captured page
data, searches, and Ask questions are not transmitted, there is nothing for us or third
parties to receive, store, share, or sell.

## Limits

The sensitive-site denylist is best-effort. New banks, health portals, and login flows
appear all the time, so no fixed list can be perfect. If a page you consider private was
saved, use "Forget this site's history" to delete it and "Don't remember this site" so it
is not saved again, or pause capturing entirely.

Recall is tuned for English. Other languages are not part of this version.

## Children

Recall is a general-purpose productivity tool and is not directed at children.

## Changes

If this policy changes, the updated version will be published at the same URL with a new
"Last updated" date.

## Contact

Questions about privacy: **mark@linercorp.com**
