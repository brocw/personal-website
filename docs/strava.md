# Strava running card (shelved)

A "Running" card for the Personal section showing recent runs and year-to-date totals from the Strava API.
It is shelved for now. This file keeps the setup steps and the removed code so it can be restored.

## One-time setup

1. Create an API application at <https://www.strava.com/settings/api> (the authorization callback domain can be `localhost`).
2. Open this URL, approve, and copy the `code=` value from the `localhost` URL you're redirected to:
   `https://www.strava.com/oauth/authorize?client_id=CLIENT_ID&response_type=code&redirect_uri=http://localhost&approval_prompt=force&scope=read,activity:read`
3. Exchange the code for a refresh token:
   `curl -X POST https://www.strava.com/oauth/token -d client_id=CLIENT_ID -d client_secret=CLIENT_SECRET -d code=CODE -d grant_type=authorization_code`
4. Save `refresh_token` from the response plus the client ID and secret as repo secrets (`gh secret set STRAVA_REFRESH_TOKEN`, and so on).

`activity:read` only exposes activities visible to Everyone or Followers, so private runs never appear.

## Restoring it

1. Paste the code below into `tools/update.mjs`: the fetcher above `// ---------- rendering ----------`, and the helpers and renderer above `renderWikipedia`.
2. Add `strava: { recent: 4 },` to `CONFIG`, add `cached('strava', fetchStrava)` to the main `Promise.all` (and `strava` to its destructuring), and pass `strava` to `renderPersonal`, rendering `strava && renderRunning(strava)` first.
3. Add `.card--run { --c: #fc4c02; }` (Strava orange) to the personal-card rules in `styles/style.css`.
4. Pass the secrets to the workflow step in `.github/workflows/update.yml`:
   ```yaml
          STRAVA_CLIENT_ID: ${{ secrets.STRAVA_CLIENT_ID }}
          STRAVA_CLIENT_SECRET: ${{ secrets.STRAVA_CLIENT_SECRET }}
          STRAVA_REFRESH_TOKEN: ${{ secrets.STRAVA_REFRESH_TOKEN }}
   ```

## Fetcher

```js
// ---------- Strava ----------

const RUN_TYPES = new Set(['Run', 'TrailRun', 'VirtualRun']);

async function fetchStrava() {
  const { STRAVA_CLIENT_ID: id, STRAVA_CLIENT_SECRET: secret, STRAVA_REFRESH_TOKEN: refresh } = process.env;
  if (!id || !secret || !refresh) throw new Error('no STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET / STRAVA_REFRESH_TOKEN set');
  const tok = await getJSON('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: id, client_secret: secret, grant_type: 'refresh_token', refresh_token: refresh }),
  });
  if (tok.refresh_token && tok.refresh_token !== refresh) {
    console.warn('! strava: Strava issued a new refresh token; update the STRAVA_REFRESH_TOKEN secret if this one stops working');
  }
  const auth = { headers: { Authorization: `Bearer ${tok.access_token}` } };
  const athlete = await getJSON('https://www.strava.com/api/v3/athlete', auth);
  const [stats, activities] = await Promise.all([
    getJSON(`https://www.strava.com/api/v3/athletes/${athlete.id}/stats`, auth),
    getJSON('https://www.strava.com/api/v3/athlete/activities?per_page=60', auth),
  ]);
  const totals = (t) => ({ count: t.count, distance: t.distance, movingTime: t.moving_time, elevation: t.elevation_gain });
  // Deliberately no maps, polylines or start locations: just the numbers.
  return {
    athleteId: athlete.id,
    ytd: totals(stats.ytd_run_totals),
    all: totals(stats.all_run_totals),
    recent: activities
      .filter((a) => RUN_TYPES.has(a.sport_type || a.type) && !a.private)
      .slice(0, CONFIG.strava.recent)
      .map((a) => ({
        name: a.name,
        date: a.start_date,
        distance: a.distance,
        movingTime: a.moving_time,
        elevation: a.total_elevation_gain,
        url: `https://www.strava.com/activities/${a.id}`,
      })),
  };
}
```

## Helpers and renderer

```js
const miles = (m) => m / 1609.344;
const fmtMiles = (m) => miles(m).toFixed(miles(m) < 100 ? 1 : 0);
function fmtDuration(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.round(sec % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
const fmtPace = (sec, m) => (m > 0 ? `${fmtDuration(sec / miles(m))} /mi` : '');

function renderRunning(strava) {
  const year = new Date().getFullYear();
  const runs = strava.recent
    .map((a) => `<li><a href="${esc(a.url)}" rel="noopener"><span class="row-main">${esc(a.name)}</span><span class="row-meta">${fmtDate(a.date)} · ${fmtMiles(a.distance)} mi · ${fmtPace(a.movingTime, a.distance)}</span></a></li>`)
    .join('');
  return `<article class="card card--run">
        <header class="card-head"><h3>Running</h3><a class="card-src" href="https://www.strava.com/athletes/${esc(strava.athleteId)}" rel="noopener">Strava ↗</a></header>
        <dl class="stats">
          ${stat(fmtMiles(strava.ytd.distance), `miles in ${year}`)}
          ${stat(fmtNum(strava.ytd.count), `runs in ${year}`)}
          ${stat(fmtPace(strava.ytd.movingTime, strava.ytd.distance).replace(' /mi', ''), 'avg pace /mi')}
        </dl>
        ${runs ? `<h4>Recent runs</h4><ul class="rows">${runs}</ul>` : ''}
        <p class="card-foot">${fmtMiles(strava.all.distance)} miles across ${fmtNum(strava.all.count)} runs all-time</p>
      </article>`;
}
```
