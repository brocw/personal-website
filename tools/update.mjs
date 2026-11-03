#!/usr/bin/env node
// Fetches live content and pre-renders it into index.html so the site stays 100% static.
//
//   GITHUB_TOKEN=$(gh auth token) node tools/update.mjs
//
// Sources:
//   - Bluesky author feed (posts + reposts)    -> social feed
//   - Substack notes                           -> social feed
//   - content/projects.json + GitHub repos     -> project gallery (GitHub data needs GITHUB_TOKEN);
//     each card's image is the first image in the repo README, self-hosted in assets/repos/
//   - content/skills.json                      -> skill chips that filter the project gallery
//   - Wikipedia, content/wordle.json           -> Personal section
//
// The résumé PDF (assets/Broc_Weselmann_Resume.pdf) is committed by hand, not fetched: the
// site copy omits the phone number that brocw/resume's resume.pdf includes.
//
// If a source fails, the last good copy in data/*.json is reused, so a flaky API never
// blanks out a section of the live site. Requires Node 18+ (global fetch). No dependencies.

import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG = {
  bluesky: { actor: 'brocw.bsky.social', includeReposts: true },
  substack: { handle: 'brocw', includeRestacks: true },
  github: { login: 'brocw' },
  wikipedia: { user: 'DaBattlefrog', recent: 5 },
  feedLimit: 30,
  timeZone: 'America/New_York',
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const INDEX = join(ROOT, 'index.html');
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; brocweselmann.com site builder)' };

// ---------- helpers ----------

const esc = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: CONFIG.timeZone });

async function getJSON(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { ...UA, ...(opts.headers || {}) } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function cached(name, fn) {
  const file = join(DATA, `${name}.json`);
  try {
    const data = await fn();
    await writeFile(file, JSON.stringify(data, null, 2) + '\n');
    console.log(`✓ ${name}: fetched ${Array.isArray(data) ? data.length + ' items' : 'ok'}`);
    return data;
  } catch (err) {
    console.warn(`! ${name}: ${err.message} — using cached copy`);
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch {
      return null;
    }
  }
}

// Plain text -> HTML paragraphs with bare URLs linked.
function textToHtml(text = '') {
  const linkify = (s) =>
    esc(s).replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (u) => `<a href="${u}" rel="noopener">${u}</a>`);
  return text
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p>${linkify(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

// ---------- Bluesky ----------

const bskyPostUrl = (uri, handle) => `https://bsky.app/profile/${handle}/post/${uri.split('/').pop()}`;

// Bluesky rich text: facets index into the UTF-8 bytes of the text.
function bskyRichText(text = '', facets = []) {
  const buf = Buffer.from(text, 'utf8');
  let out = '';
  let pos = 0;
  for (const f of [...facets].sort((a, b) => a.index.byteStart - b.index.byteStart)) {
    const { byteStart, byteEnd } = f.index;
    if (byteStart < pos || byteEnd > buf.length) continue;
    const feat = f.features?.[0] || {};
    const href =
      feat.$type === 'app.bsky.richtext.facet#link' ? feat.uri
      : feat.$type === 'app.bsky.richtext.facet#mention' ? `https://bsky.app/profile/${feat.did}`
      : feat.$type === 'app.bsky.richtext.facet#tag' ? `https://bsky.app/hashtag/${encodeURIComponent(feat.tag)}`
      : null;
    out += esc(buf.subarray(pos, byteStart).toString('utf8'));
    const seg = esc(buf.subarray(byteStart, byteEnd).toString('utf8'));
    out += href ? `<a href="${esc(href)}" rel="noopener">${seg}</a>` : seg;
    pos = byteEnd;
  }
  out += esc(buf.subarray(pos).toString('utf8'));
  return out.trim() ? `<p>${out.replace(/\n/g, '<br>')}</p>` : '';
}

function bskyMedia(embed) {
  if (!embed) return {};
  const t = embed.$type || '';
  if (t.startsWith('app.bsky.embed.images')) return { images: embed.images.map((i) => ({ src: i.thumb, alt: i.alt || '' })) };
  if (t.startsWith('app.bsky.embed.video')) return { video: embed.thumbnail ? { src: embed.thumbnail, alt: embed.alt || '' } : null };
  if (t.startsWith('app.bsky.embed.external')) {
    const e = embed.external;
    return { link: { url: e.uri, title: e.title, description: e.description, image: e.thumb } };
  }
  if (t.startsWith('app.bsky.embed.recordWithMedia')) return { ...bskyMedia(embed.media), ...bskyMedia(embed.record) };
  if (t.startsWith('app.bsky.embed.record')) {
    const r = embed.record;
    if (r?.$type === 'app.bsky.embed.record#viewRecord') {
      return {
        quote: {
          author: r.author.displayName || r.author.handle,
          handle: r.author.handle,
          text: r.value?.text || '',
          url: bskyPostUrl(r.uri, r.author.handle),
        },
      };
    }
  }
  return {};
}

async function fetchBluesky() {
  const { actor, includeReposts } = CONFIG.bluesky;
  const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${actor}&limit=100&filter=posts_no_replies`;
  const { feed } = await getJSON(url);
  return feed
    .filter((item) => includeReposts || !item.reason)
    .filter((item) => !item.reason || item.reason.$type === 'app.bsky.feed.defs#reasonRepost')
    .filter((item) => item.reason || item.post.author.handle === actor) // drop pinned/odd items from others
    .map(({ post, reason }) => ({
      source: 'bluesky',
      kind: reason ? 'repost' : 'post',
      date: reason ? reason.indexedAt : post.record.createdAt,
      postedAt: post.record.createdAt,
      url: bskyPostUrl(post.uri, post.author.handle),
      author: { name: post.author.displayName || post.author.handle, handle: post.author.handle, avatar: post.author.avatar || '' },
      html: bskyRichText(post.record.text, post.record.facets),
      ...bskyMedia(post.embed),
    }));
}

// ---------- Substack ----------

async function fetchSubstack() {
  const { handle, includeRestacks } = CONFIG.substack;
  const profile = await getJSON(`https://substack.com/api/v1/user/${handle}/public_profile`);
  const items = [];
  let cursor = '';
  for (let page = 0; page < 5; page++) {
    const data = await getJSON(
      `https://substack.com/api/v1/reader/feed/profile/${profile.id}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    items.push(...data.items);
    if (!data.nextCursor) break;
    cursor = data.nextCursor;
  }

  const out = [];
  for (const it of items) {
    const ctxType = it.context?.type;
    const c = it.comment;
    const isOwnNote = ctxType === 'note' && c && c.user_id === profile.id;
    const isRestack = ctxType === 'comment_restack' || ctxType === 'post_restack';
    if (!isOwnNote && !(includeRestacks && isRestack)) continue;

    const entry = {
      source: 'substack',
      kind: isOwnNote ? 'post' : 'repost',
      date: it.context?.timestamp || c?.date,
    };

    if (c) {
      entry.postedAt = c.date;
      entry.url = `https://substack.com/@${c.handle}/note/c-${c.id}`;
      entry.author = { name: c.name, handle: c.handle, avatar: c.photo_url || '' };
      entry.html = textToHtml(c.body);
      for (const a of c.attachments || []) {
        if (a.type === 'image') (entry.images ||= []).push({ src: a.imageUrl, alt: '' });
        if (a.type === 'post' && a.post) {
          entry.link = {
            url: a.post.canonical_url,
            title: a.post.title,
            description: a.publication?.name || a.post.subtitle || '',
            image: a.post.cover_image,
          };
        }
        if (a.type === 'link' && a.linkMetadata) {
          entry.link = { url: a.linkMetadata.url, title: a.linkMetadata.title, description: a.linkMetadata.host, image: a.linkMetadata.image };
        }
      }
    } else if (it.post) {
      const p = it.post;
      entry.postedAt = p.post_date;
      entry.url = p.canonical_url;
      entry.author = { name: it.publication?.name || 'Substack', handle: it.publication?.subdomain || '', avatar: it.publication?.logo_url || '' };
      entry.html = '';
      entry.link = { url: p.canonical_url, title: p.title, description: p.subtitle || '', image: p.cover_image };
    } else continue;

    out.push(entry);
  }
  return out;
}

// ---------- GitHub: pinned repos + repos referenced in content/projects.json ----------

// Returns every repo of interest, in pinned order first, each flagged with `pinned`.
async function fetchGitHub(projects) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) throw new Error('no GITHUB_TOKEN set');
  const fields = `name nameWithOwner description url stargazerCount owner { login } primaryLanguage { name color } openGraphImageUrl`;
  const extra = projects.filter((p) => p.repo).map((p) => p.repo.split('/'));
  const aliases = extra
    .map(([owner, name], i) => `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields} }`)
    .join('\n');
  const query = `{
    user(login: ${JSON.stringify(CONFIG.github.login)}) { pinnedItems(first: 6, types: REPOSITORY) { nodes { ... on Repository { ${fields} } } } }
    ${aliases}
  }`;
  const res = await getJSON('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.data?.user) throw new Error(res.errors?.map((e) => e.message).join('; ') || 'empty response');
  if (res.errors) console.warn(`! github: ${res.errors.map((e) => e.message).join('; ')}`); // e.g. a renamed repo

  const shape = (r, pinned) => ({
    name: r.name,
    fullName: r.nameWithOwner,
    owner: r.owner.login,
    description: r.description || '',
    url: r.url,
    stars: r.stargazerCount,
    language: r.primaryLanguage,
    image: r.openGraphImageUrl,
    pinned,
  });
  const byName = new Map();
  for (const r of res.data.user.pinnedItems.nodes) byName.set(r.nameWithOwner.toLowerCase(), shape(r, true));
  extra.forEach((_, i) => {
    const r = res.data[`r${i}`];
    if (r && !byName.has(r.nameWithOwner.toLowerCase())) byName.set(r.nameWithOwner.toLowerCase(), shape(r, false));
  });
  const repos = [...byName.values()];
  await Promise.all(repos.map(async (r) => (r.readmeImage = await fetchReadmeImage(r.fullName, token))));
  return repos;
}

// First non-badge image in a markdown/HTML README, resolved to an absolute URL.
function firstReadmeImage(md, base) {
  const re = /!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)|<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
  for (const m of md.matchAll(re)) {
    const src = m[1] || m[2];
    if (/shields\.io|badge|\.svg(\?|$)/i.test(src)) continue;
    try {
      const url = new URL(src, base);
      // github.com/<owner>/<repo>/blob/<ref>/<path> is an HTML page; point at the raw file instead.
      const blob = url.hostname === 'github.com' && url.pathname.match(/^\/([^/]+\/[^/]+)\/blob\/(.+)$/);
      return blob ? `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}` : url.href;
    } catch {}
  }
  return '';
}

async function fetchReadmeImage(fullName, token) {
  const res = await fetch(`https://api.github.com/repos/${fullName}/readme`, {
    headers: { ...UA, Authorization: `bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (res.status === 404) return '';
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${fullName} README`);
  const { content, encoding, download_url } = await res.json();
  return firstReadmeImage(Buffer.from(content, encoding).toString('utf8'), download_url);
}

// Self-host each repo's README image (hotlinking GitHub's CDNs gets rate-limited).
// Fetched sequentially with a retry; on failure the previously downloaded copy is kept.
// Repos whose README has no image lose any stale copy and fall back to a placeholder card.
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif' };

async function downloadRepoImages(repos) {
  if (!repos?.length) return;
  const dir = join(ROOT, 'assets', 'repos');
  await mkdir(dir, { recursive: true });
  const existing = await readdir(dir);
  for (const r of repos) {
    const base = r.fullName.replace('/', '--');
    const old = existing.filter((f) => f.slice(0, f.lastIndexOf('.')) === base);
    r.localImage = '';
    if (!r.readmeImage) {
      await Promise.all(old.map((f) => rm(join(dir, f))));
      continue;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(r.readmeImage, { headers: UA });
        if (!res.ok) throw new Error(`${res.status}`);
        const ext = IMAGE_EXT[(res.headers.get('content-type') || '').split(';')[0].trim()];
        if (!ext) throw new Error('not a supported image');
        const file = `${base}.${ext}`;
        await writeFile(join(dir, file), Buffer.from(await res.arrayBuffer()));
        await Promise.all(old.filter((f) => f !== file).map((f) => rm(join(dir, f))));
        r.localImage = `assets/repos/${file}`;
        break;
      } catch (err) {
        if (attempt < 2) { await new Promise((ok) => setTimeout(ok, 2000 * (attempt + 1))); continue; }
        console.warn(`! repo image ${r.fullName}: ${err.message}`);
        if (old.length) r.localImage = `assets/repos/${old[0]}`;
      }
    }
  }
}

// ---------- Wikipedia ----------

async function fetchWikipedia() {
  const { user, recent } = CONFIG.wikipedia;
  const api = 'https://en.wikipedia.org/w/api.php?format=json&formatversion=2&action=query';
  const { query } = await getJSON(
    `${api}&list=users|usercontribs&ususers=${encodeURIComponent(user)}&usprop=editcount|registration` +
      `&ucuser=${encodeURIComponent(user)}&ucnamespace=0&uclimit=500&ucprop=title|timestamp|comment`,
  );
  const u = query.users[0];
  if (!u || u.missing) throw new Error(`user ${user} not found`);
  const contribs = query.usercontribs || [];
  const seen = new Set();
  const latest = contribs.filter((c) => !seen.has(c.title) && seen.add(c.title));
  return {
    user: u.name,
    editCount: u.editcount,
    registered: u.registration,
    articlesEdited: seen.size,
    recent: latest.slice(0, recent).map((c) => ({ title: c.title, date: c.timestamp, comment: c.comment || '' })),
  };
}

// ---------- rendering ----------

const SOURCE_LABEL = { bluesky: 'Bluesky', substack: 'Substack' };

function renderEntry(e) {
  const img = (src, alt, cls = '') =>
    `<img${cls ? ` class="${cls}"` : ''} src="${esc(src)}" alt="${esc(alt)}" loading="lazy" decoding="async">`;
  const parts = [];

  if (e.kind === 'repost') {
    parts.push(`<p class="post-context"><span aria-hidden="true">↻</span> Broc ${e.source === 'substack' ? 'restacked' : 'reposted'}</p>`);
  }

  parts.push(`<header class="post-head">
        ${e.author.avatar ? img(e.author.avatar, '', 'post-avatar') : '<span class="post-avatar"></span>'}
        <span class="post-who"><span class="post-name">${esc(e.author.name)}</span>${e.author.handle ? `<span class="post-handle">@${esc(e.author.handle)}</span>` : ''}</span>
        <span class="post-source post-source--${e.source}">${SOURCE_LABEL[e.source]}</span>
      </header>`);

  if (e.html) parts.push(`<div class="post-body">${e.html}</div>`);

  if (e.images?.length) {
    parts.push(`<div class="post-media post-media--${Math.min(e.images.length, 4)}">${e.images
      .slice(0, 4)
      .map((i) => img(i.src, i.alt))
      .join('')}</div>`);
  }
  if (e.video) {
    parts.push(`<a class="post-media post-media--1 post-video" href="${esc(e.url)}" rel="noopener" aria-label="Watch video on ${SOURCE_LABEL[e.source]}">${img(e.video.src, e.video.alt)}<span class="play" aria-hidden="true">▶</span></a>`);
  }
  if (e.quote) {
    parts.push(`<a class="post-quote" href="${esc(e.quote.url)}" rel="noopener">
        <span class="post-quote-who"><strong>${esc(e.quote.author)}</strong> @${esc(e.quote.handle)}</span>
        <span class="post-quote-text">${esc(e.quote.text)}</span>
      </a>`);
  }
  if (e.link) {
    let host = '';
    try { host = new URL(e.link.url).hostname.replace(/^www\./, ''); } catch {}
    parts.push(`<a class="post-link" href="${esc(e.link.url)}" rel="noopener">
        ${e.link.image ? img(e.link.image, '') : ''}
        <span class="post-link-text"><span class="post-link-host">${esc(host)}</span><strong>${esc(e.link.title || e.link.url)}</strong>${e.link.description ? `<span>${esc(e.link.description)}</span>` : ''}</span>
      </a>`);
  }

  parts.push(`<footer class="post-foot"><a href="${esc(e.url)}" rel="noopener"><time datetime="${esc(e.date)}">${fmtDate(e.date)}</time> ↗</a></footer>`);

  return `<li class="post" data-source="${e.source}">
      <article>
      ${parts.join('\n      ')}
      </article>
    </li>`;
}

function renderFeed(entries) {
  if (!entries.length) return '<li class="post post--empty">Nothing here yet — check back soon.</li>';
  return entries.map(renderEntry).join('\n    ');
}

const skillKey = (name) => name.trim().toLowerCase();

// Lists longer than data-limit are folded behind a "(…)" chip by the inline script (all chips show without JS).
const CHIP_LIMIT = { card: 5, group: 8 };

const chipList = (names, cls = 'chips') =>
  `<ul class="${cls}" data-limit="${CHIP_LIMIT.card}">${names.map((n) => `<li class="chip" data-skill="${esc(skillKey(n))}">${esc(n)}</li>`).join('')}</ul>`;

// Résumé projects (content/projects.json) enriched with GitHub data, then any pinned repos
// that aren't already listed. Works without GitHub data too (placeholders, no stars).
function buildCards(projects, repos) {
  const byName = new Map((repos || []).map((r) => [r.fullName.toLowerCase(), r]));
  const listed = new Set();
  const cards = projects.map((p) => {
    const r = p.repo ? byName.get(p.repo.toLowerCase()) : null;
    if (r) listed.add(r.fullName.toLowerCase());
    return {
      name: p.name,
      url: p.url || r?.url,
      image: p.image || r?.localImage || '',
      color: r?.language?.color,
      tech: p.tech?.length ? p.tech : r?.language?.name ? [r.language.name] : [],
      body: p.bullets?.length ? `<ul>${p.bullets.map((b) => `<li>${b}</li>`).join('')}</ul>` : `<p>${esc(r?.description || p.description || '')}</p>`,
      repo: r,
    };
  });
  for (const r of repos || []) {
    if (!r.pinned || listed.has(r.fullName.toLowerCase())) continue;
    cards.push({
      name: r.name,
      url: r.url,
      image: r.localImage || '',
      color: r.language?.color,
      tech: r.language?.name ? [r.language.name] : [],
      body: `<p>${esc(r.description)}</p>`,
      repo: r,
    });
  }
  return cards;
}

function renderProjects(cards) {
  return cards
    .map((c) => {
      const r = c.repo;
      const meta = [
        r?.stars ? `<span title="GitHub stars">★ ${r.stars}</span>` : '',
        r && r.owner !== CONFIG.github.login ? `<span>with @${esc(r.owner)}</span>` : '',
      ].filter(Boolean).join('');
      const media = c.image
        ? `<img src="${esc(c.image)}" alt="" loading="lazy" decoding="async">`
        : `<span class="project-placeholder" style="--c:${esc(c.color || 'var(--accent)')}">${esc(c.name)}</span>`;
      return `<li class="project" data-skills="${esc(c.tech.map(skillKey).join('|'))}">
      <a class="project-media" href="${esc(c.url)}" rel="noopener" tabindex="-1" aria-hidden="true">${media}</a>
      <div class="project-body">
        <h3><a href="${esc(c.url)}" rel="noopener">${esc(c.name)}</a></h3>
        ${c.tech.length ? chipList(c.tech, 'chips chips--sm') : ''}
        ${c.body}
        ${meta ? `<p class="project-meta">${meta}</p>` : ''}
      </div>
    </li>`;
    })
    .join('\n    ');
}

// Skill groups as filter chips with project counts, most-used first. Skills no project uses
// are hidden, as are groups left empty.
function renderSkills(groups, cards) {
  const count = new Map();
  for (const c of cards) for (const t of new Set(c.tech.map(skillKey))) count.set(t, (count.get(t) || 0) + 1);
  return groups
    .map((g) => {
      const chips = g.skills
        .map((name) => [name, count.get(skillKey(name)) || 0])
        .filter(([, n]) => n)
        .sort((a, b) => b[1] - a[1])
        .map(([name, n]) => `<li><button type="button" class="chip" data-skill="${esc(skillKey(name))}" aria-pressed="false">${esc(name)} <span class="chip-count" aria-label="${n} project${n === 1 ? '' : 's'}">${n}</span></button></li>`)
        .join('');
      return chips ? `<div class="skill-group"><h3>${esc(g.name)}</h3><ul class="chips" data-limit="${CHIP_LIMIT.group}">${chips}</ul></div>` : '';
    })
    .filter(Boolean)
    .join('\n    ');
}

// ---------- Personal section ----------

const fmtNum = (n) => Number(n).toLocaleString('en-US');

const stat = (value, label) => `<div class="stat"><dt>${label}</dt><dd>${value}</dd></div>`;

const cardNote = (text) => (text?.trim() ? `<div class="card-note">${textToHtml(text)}</div>` : '');

function renderWikipedia(wiki, note) {
  const page = (t) => `https://en.wikipedia.org/wiki/${encodeURIComponent(t.replace(/ /g, '_'))}`;
  // "/* Section */ text" is MediaWiki's section-link syntax in edit summaries.
  const summary = (c) => c.replace(/\/\*\s*(.*?)\s*\*\//, '§ $1 ·').replace(/·\s*$/, '').trim();
  const edits = wiki.recent
    .map((e) => `<li><a href="${esc(page(e.title))}" rel="noopener"><span class="row-main">${esc(e.title)}</span><span class="row-meta">${fmtDate(e.date)}${e.comment ? ` · ${esc(summary(e.comment))}` : ''}</span></a></li>`)
    .join('');
  return `<article class="card card--wiki">
        <header class="card-head"><h3>Wikipedia</h3><a class="card-src" href="https://en.wikipedia.org/wiki/Special:Contributions/${esc(encodeURIComponent(wiki.user))}" rel="noopener">${esc(wiki.user)} ↗</a></header>
        <dl class="stats">
          ${stat(fmtNum(wiki.editCount), 'edits')}
          ${stat(fmtNum(wiki.articlesEdited), 'articles improved')}
          ${stat(new Date(wiki.registered).getFullYear(), 'editing since')}
        </dl>
        ${edits ? `<h4>Recent edits</h4><ul class="rows">${edits}</ul>` : ''}
        ${cardNote(note)}
      </article>`;
}

function renderWordle(w, note) {
  const total = w.medals.gold + w.medals.silver + w.medals.bronze;
  const medal = (k, icon, label) =>
    `<span class="medal medal--${k}" style="--share:${((w.medals[k] / total) * 100).toFixed(1)}%" title="${w.medals[k]} ${label}"><span aria-hidden="true">${icon}</span> ${w.medals[k]}<span class="sr"> ${label}</span></span>`;
  return `<article class="card card--wordle">
        <header class="card-head"><h3>Wordle</h3><a class="card-src" href="https://github.com/brocw/sinebot" rel="noopener">via SINEBot ↗</a></header>
        <dl class="stats">
          ${stat(`👑 ${w.crowns}`, `crowns · #${w.rank} of ${w.players}`)}
          ${stat(w.guesses.avg.toFixed(2), 'avg guesses')}
          ${stat(fmtNum(w.daysPlayed), 'days played')}
        </dl>
        <h4>Medals</h4>
        <div class="medals">${medal('gold', '👑', 'first places')}${medal('silver', '🥈', 'second places')}${medal('bronze', '🥉', 'third places')}</div>
        <ul class="rows rows--plain">
          <li><span class="row-main">Best month</span><span class="row-meta">${esc(w.bestMonth.month)} · ${w.bestMonth.avg.toFixed(2)} avg over ${w.bestMonth.plays} plays</span></li>
          <li><span class="row-main">Best weekday</span><span class="row-meta">${esc(w.bestDay.day)} · ${w.bestDay.avg.toFixed(2)} avg · worst is ${esc(w.worstDay.day)} (${w.worstDay.avg.toFixed(2)})</span></li>
          <li><span class="row-main">Current streak</span><span class="row-meta">${w.currentStreak} days · ${w.winRate}% win rate</span></li>
        </ul>
        ${cardNote(note)}
      </article>`;
}

function renderPersonal({ wiki, wordle, notes = {} }) {
  return [wiki && renderWikipedia(wiki, notes.wikipedia), wordle && renderWordle(wordle, notes.wordle)].filter(Boolean).join('\n      ');
}

function inject(html, name, content) {
  const re = new RegExp(`(<!-- generated:${name} -->)[\\s\\S]*?(<!-- /generated:${name} -->)`);
  if (!re.test(html)) throw new Error(`marker "generated:${name}" not found in index.html`);
  return html.replace(re, `$1\n    ${content}\n    $2`);
}

// ---------- main ----------

await mkdir(DATA, { recursive: true });

const readContent = async (name) => JSON.parse(await readFile(join(ROOT, 'content', name), 'utf8'));
const [{ projects }, { groups: skillGroups }, wordle, notes] = await Promise.all([
  readContent('projects.json'),
  readContent('skills.json'),
  readContent('wordle.json').catch(() => null),
  readContent('personal.json').catch(() => ({})),
]);

const [bluesky, substack, repos, wiki] = await Promise.all([
  cached('bluesky', fetchBluesky),
  cached('substack', fetchSubstack),
  cached('github', () => fetchGitHub(projects)),
  cached('wikipedia', fetchWikipedia),
]);
await downloadRepoImages(repos);

const feed = [...(bluesky || []), ...(substack || [])]
  .filter((e) => e.date)
  .sort((a, b) => new Date(b.date) - new Date(a.date))
  .slice(0, CONFIG.feedLimit);
const cards = buildCards(projects, repos);

let html = await readFile(INDEX, 'utf8');
const before = html;
html = inject(html, 'feed', renderFeed(feed));
html = inject(html, 'skills', renderSkills(skillGroups, cards));
html = inject(html, 'projects', renderProjects(cards));
html = inject(html, 'personal', renderPersonal({ wiki, wordle, notes }));

if (html !== before) {
  await writeFile(INDEX, html);
  console.log(`✓ index.html: rendered ${feed.length} feed items, ${cards.length} projects`);
} else {
  console.log('✓ index.html: no changes');
}
