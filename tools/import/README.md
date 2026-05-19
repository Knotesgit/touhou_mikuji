# THWiki Import Tool

This folder contains a local-only data preparation tool for organizing Touhou omikuji draft data from THWiki pages.

It is not part of the public website. It must not run in the browser and must not run when the GitHub Pages site loads.

## Rules

- Use MediaWiki Action API first through `https://thwiki.cc/api.php`.
- Only read-only API actions are allowed: `action=query` and `action=parse`.
- Do not use edit, login, token, or write actions.
- Follow THWiki `robots.txt` crawl-delay rule: wait at least 60 seconds between real network requests, plus 5-15 seconds random jitter.
- Concurrency is exactly 1.
- Cache responses and reuse cache during debugging.
- Do not repeatedly request the same page.
- Do not bypass blocking, captcha, anti-bot checks, login requirements, or rate limits.
- Do not use proxies, IP rotation, browser automation, Puppeteer, or Playwright.
- Do not publish generated draft JSON without manual review.

## Legal And Data Review Notes

This importer does not solve copyright or licensing questions. Robots.txt access permission is not copyright permission.

Final data must be manually reviewed before it is moved into the public website data folder. Generated files under `tools/import/output/draft-json/` are drafts, not final site data.

Do not write scraped or draft data into `data/mikuji/` from this tool.

## Local Config

Network requests require `tools/import/import-config.local.json`.

Example:

```json
{
  "contact": "your-email@example.com",
  "userAgentProject": "TouhouMikujiDataImporter/0.1"
}
```

The User-Agent is:

```text
TouhouMikujiDataImporter/0.1 (non-commercial fan data organization; contact: YOUR_CONTACT)
```

If the config is missing, the script refuses network requests.

## Commands

Dry run. Makes zero network requests:

```sh
node tools/import/thwiki-import.mjs --dry-run
```

Single-page draft import:

```sh
node tools/import/thwiki-import.mjs --page "东方幻存神签/露米娅" --bilingual --limit 1
```

Full import is intentionally not implemented:

```sh
node tools/import/thwiki-import.mjs --confirm-full-import
```

## Output

- Cache: `tools/import/cache/`
- Raw API response copies: `tools/import/output/raw/`
- Draft JSON: `tools/import/output/draft-json/`

The cache and raw API response folders are local ignored output. Draft JSON is not ignored so reviewed draft structure can be inspected deliberately, but it is still not final website data.
