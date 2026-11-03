# personal-website

[brocweselmann.com](https://brocweselmann.com): plain static HTML and CSS, hosted as a DigitalOcean static site.

## How it stays fresh

`tools/update.mjs` (Node 18+, no dependencies) pulls live content and **pre-renders it into `index.html`**
between `<!-- generated:… -->` markers, so the deployed site is fully static and works without JavaScript.

| Section | Source |
| --- | --- |
| **Lately** feed | Bluesky author feed (posts + reposts) and Substack Notes (notes + restacks), merged newest-first |
| **Projects & Skills** | `content/projects.json` (résumé projects, edit by hand) + your pinned GitHub repos, merged. Card images are the first image in each repo's README, self-hosted in `assets/repos/` (set `image` in `projects.json` to override). Skill chips come from `content/skills.json` and filter the cards by their `tech`. |
| **Personal: Wikipedia** | Public edit stats and recent edits for the account in `CONFIG.wikipedia` |
| **Personal: Wordle** | `content/wordle.json`, a hand-updated snapshot of SINEBot's `/stats` |
| **Download résumé** | `assets/Broc_Weselmann_Resume.pdf`, committed by hand (not fetched). It is built from [brocw/resume](https://github.com/brocw/resume)'s `resume.tex` with the phone number removed. |

The [`Refresh` workflow](.github/workflows/update.yml) runs this every other day (or on demand) and commits any changes.
DigitalOcean redeploys automatically on push. If a source is down, the last good copy in `data/*.json` is reused.

Run it locally:

```sh
GITHUB_TOKEN=$(gh auth token) node tools/update.mjs
```

Options (including/excluding reposts and restacks, feed length) live in `CONFIG` at the top of the script.
Experience, Education, and the About blurb are hand-written in `index.html`; projects, skills, and Wordle stats live in `content/`.
