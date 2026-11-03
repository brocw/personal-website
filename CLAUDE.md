# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Personal site for brocweselmann.com: plain static HTML and CSS (`index.html` + `styles/style.css`), hosted as a DigitalOcean static site. It has no build step, no package.json, and no tests. DigitalOcean redeploys on every push to `main`.

## Commands

```sh
# Refresh feeds/projects and re-render them into index.html (Node 18+, no deps)
GITHUB_TOKEN=$(gh auth token) node tools/update.mjs

# Preview locally (any static server works)
python -m http.server
```

Without `GITHUB_TOKEN`, the GitHub fetch fails and its cached `data/*.json` copy is used.

## Architecture: pre-rendered content

`tools/update.mjs` fetches live data and **writes HTML directly into `index.html`** between marker comments:

- `generated:skills`, `generated:projects` (the Projects & Skills section)
- `generated:personal` (Wikipedia / Wordle cards)
- `generated:feed`

**Never hand-edit content between these markers.** The next run overwrites it. To change that markup, edit the render functions (`renderSkills`, `renderProjects`, `renderPersonal`, `renderEntry`) in `tools/update.mjs`. Everything outside the markers (hero and About blurb, Experience, Education, nav, footer, the inline script) is hand-written and stays as written. The script throws if a marker is missing, so keep every marker pair in place when restructuring `index.html`.

Data flow:
- **Feed ("Lately")**: Bluesky author feed + Substack Notes (including reposts/restacks), merged newest-first, capped at `CONFIG.feedLimit`.
- **Projects**: `content/projects.json` (hand-maintained, mirrors the résumé, in display order; `bullets` may contain raw `<strong>` HTML) enriched with GitHub data through the `repo` field. Pinned GitHub repos that aren't listed are appended after them. Card images are the first non-badge image in each repo's README, downloaded to `assets/repos/<owner>--<name>.<ext>` (stale copies are deleted when a README has no image). A project's `image` field overrides this, and cards with neither get a striped placeholder.
- **Skills**: `content/skills.json` groups. A chip's count and filter come from matching its name (case-insensitive) against each card's `tech` list (or the GitHub language for pinned-only repos), so `tech` spellings must match the skill names exactly.
- **Personal**: Wikipedia public API (`CONFIG.wikipedia.user`), and `content/wordle.json` (manual snapshot). Each card's closing note comes from `content/personal.json`. A card is omitted if its data is unavailable. A Strava running card is shelved in `docs/strava.md` with its code and setup steps.
- **Résumé PDF**: `assets/Broc_Weselmann_Resume.pdf` is a hand-committed copy, not fetched. It is built from `brocw/resume`'s `resume.tex` with the phone number removed from the header, so never replace it with that repo's `resume.pdf`. To refresh it, delete the number from a copy of `resume.tex`, run `pdflatex`, and commit the result here.
- **Fallback cache**: each successful fetch is written to `data/<source>.json`. If a source fails, the last good copy is reused, so a flaky API never blanks a section. These files are committed.

All tunables (accounts, include reposts/restacks, feed length, time zone) live in `CONFIG` at the top of `tools/update.mjs`.

## Frontend conventions

- The site must work **without JavaScript**. The inline `<script>` at the bottom of `index.html` only progressively enhances the page: skill-chip filtering of projects (relies on `button[data-skill]`, `.skill-status`, and each `.project`'s `data-skills="a|b"`), plus feed source filters and "Show more" (relies on `.feed`, `.filters`, `.feed-more`, `data-source`).
- Skills and per-project tech tags share one `.chip` style; keep them visually unified. Chip lists carry `data-limit` (`CHIP_LIMIT` in `update.mjs`: 5 per card, 8 per skill group); the inline script folds the rest behind a `(…)` chip and unfolds a card's list when the active filter matches a folded chip. Every `tech` entry should belong to a group in `content/skills.json`, or it renders on the card but can't be filtered.
- Theming uses CSS custom properties in `:root`, overridden in a `prefers-color-scheme: dark` block. Add new colors as variables in both places.

## CI

`.github/workflows/update.yml` runs `update.mjs` every other day, on manual dispatch, and on pushes to `main` that touch `tools/update.mjs`, `index.html`, or `content/`. It commits changes to `index.html`, `data/`, and `assets/` as `github-actions[bot]`. Pull before pushing to `main`, because the bot may have committed in the meantime.
