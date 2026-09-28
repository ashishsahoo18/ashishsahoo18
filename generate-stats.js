'use strict';

/**
 * GitHub statistics SVG generator.
 * Every number in the output comes from the GitHub API for USERNAME.
 * Nothing is hard-coded except styling (colors, layout).
 */

const fs = require('fs');
const path = require('path');

const USERNAME = process.env.GITHUB_USERNAME || 'ashishsahoo18';
const TOKEN = process.env.GITHUB_TOKEN || '';
const OUTPUT = path.join(__dirname, 'github-stats.svg');
const MAX_LANGUAGES = 7;
const API = 'https://api.github.com';

// ---------- HTTP helpers ----------

function headers() {
  const h = {
    Accept: 'application/vnd.github+json',
    'User-Agent': `${USERNAME}-stats-generator`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  return h;
}

async function rest(url) {
  const res = await fetch(url.startsWith('http') ? url : API + url, { headers: headers() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub REST ${res.status} for ${url}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function paginate(url) {
  const items = [];
  for (let page = 1; ; page++) {
    const sep = url.includes('?') ? '&' : '?';
    const batch = await rest(`${url}${sep}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

async function graphql(query, variables) {
  const res = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GitHub GraphQL HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors && json.errors.length) {
    throw new Error(`GitHub GraphQL: ${json.errors.map((e) => e.message).join('; ')}`);
  }
  return json.data;
}

// ---------- Data collection ----------

async function fetchUser() {
  const user = await rest(`/users/${encodeURIComponent(USERNAME)}`);
  // Safety check: refuse to produce a card for the wrong account.
  if (String(user.login).toLowerCase() !== USERNAME.toLowerCase()) {
    throw new Error(`Login mismatch: expected ${USERNAME}, got ${user.login}`);
  }
  return user;
}

async function fetchRepos() {
  // /users/{u}/repos returns only PUBLIC repos. type=owner excludes org repos I merely belong to.
  const repos = await paginate(`/users/${encodeURIComponent(USERNAME)}/repos?type=owner&sort=pushed`);
  return repos.filter((r) => r.owner && r.owner.login.toLowerCase() === USERNAME.toLowerCase());
}

async function fetchLanguageBytes(repos) {
  // Forks are excluded: their code is mostly someone else's.
  const own = repos.filter((r) => !r.fork);
  const totals = new Map();
  const BATCH = 5;
  for (let i = 0; i < own.length; i += BATCH) {
    const slice = own.slice(i, i + BATCH);
    const results = await Promise.all(
      slice.map((r) => rest(`/repos/${r.full_name}/languages`).catch((e) => {
        console.warn(`Skipping languages for ${r.full_name}: ${e.message}`);
        return {};
      }))
    );
    for (const langs of results) {
      for (const [lang, bytes] of Object.entries(langs)) {
        totals.set(lang, (totals.get(lang) || 0) + bytes);
      }
    }
  }
  return totals; // repos with no detected language simply return {} and add nothing
}

async function fetchContributions() {
  // The REST API has no contribution count. GraphQL requires authentication.
  if (!TOKEN) {
    console.warn('No GITHUB_TOKEN set: contributions and commits will be omitted.');
    return null;
  }
  const now = new Date();
  const from12 = new Date(now.getTime() - 365 * 24 * 3600 * 1000);
  const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const query = `
    query($login: String!, $from: DateTime!, $to: DateTime!, $yearFrom: DateTime!) {
      user(login: $login) {
        last12: contributionsCollection(from: $from, to: $to) {
          contributionCalendar { totalContributions }
        }
        thisYear: contributionsCollection(from: $yearFrom, to: $to) {
          totalCommitContributions
        }
      }
    }`;
  try {
    const data = await graphql(query, {
      login: USERNAME,
      from: from12.toISOString(),
      to: now.toISOString(),
      yearFrom: yearStart.toISOString(),
    });
    return {
      contributions: data.user.last12.contributionCalendar.totalContributions,
      commits: data.user.thisYear.totalCommitContributions,
      year: now.getUTCFullYear(),
    };
  } catch (e) {
    console.warn(`Contributions unavailable: ${e.message}`);
    return null;
  }
}

// ---------- Calculations ----------

/**
 * percentage = language_bytes / total_language_bytes * 100
 * Rounded to 2 decimals with the largest-remainder method so the
 * displayed values always sum to exactly 100.00.
 */
function computeLanguagePercentages(bytesMap) {
  const entries = [...bytesMap.entries()].filter(([, b]) => b > 0);
  const total = entries.reduce((s, [, b]) => s + b, 0);
  if (total === 0) return [];

  const rows = entries.map(([name, bytes]) => {
    const exact = (bytes / total) * 10000; // hundredths of a percent
    return { name, bytes, floor: Math.floor(exact), frac: exact - Math.floor(exact) };
  });
  let remaining = 10000 - rows.reduce((s, r) => s + r.floor, 0);
  [...rows].sort((a, b) => b.frac - a.frac).forEach((r) => {
    if (remaining > 0) { r.floor += 1; remaining -= 1; }
  });
  return rows
    .map((r) => ({ name: r.name, bytes: r.bytes, pct: r.floor / 100 }))
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
}

function pickFeatured(repos) {
  // Rule: most stars among non-fork public repos; ties broken by most recent push.
  const candidates = repos.filter((r) => !r.fork);
  if (!candidates.length) return null;
  return candidates.sort(
    (a, b) =>
      b.stargazers_count - a.stargazers_count ||
      new Date(b.pushed_at || 0) - new Date(a.pushed_at || 0)
  )[0];
}

// ---------- SVG rendering ----------

const esc = (s) =>
  String(s)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const fmt = (n) => Number(n).toLocaleString('en-US');

const LANG_COLORS = {
  JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572A5', Java: '#b07219',
  HTML: '#e34c26', CSS: '#563d7c', PHP: '#4F5D95', C: '#555555', 'C++': '#f34b7d',
  'C#': '#178600', Go: '#00ADD8', Rust: '#dea584', Ruby: '#701516', Shell: '#89e051',
  Kotlin: '#A97BFF', Swift: '#F05138', Dart: '#00B4AB', 'Jupyter Notebook': '#DA5B0B',
  SCSS: '#c6538c', Vue: '#41b883', Dockerfile: '#384d54', Makefile: '#427819',
};
const FALLBACK = ['#e63946', '#2a9d8f', '#8d6cab', '#f4a261', '#4c8eda', '#c9a227', '#6c757d'];
const OTHER_COLOR = '#5a5a5a';

function polar(cx, cy, r, angle) {
  return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
}

function donutSlice(cx, cy, R, r, a0, a1) {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = polar(cx, cy, R, a0);
  const [x1, y1] = polar(cx, cy, R, a1);
  const [x2, y2] = polar(cx, cy, r, a1);
  const [x3, y3] = polar(cx, cy, r, a0);
  const f = (n) => n.toFixed(3);
  return `M${f(x0)} ${f(y0)} A${R} ${R} 0 ${large} 1 ${f(x1)} ${f(y1)} L${f(x2)} ${f(y2)} A${r} ${r} 0 ${large} 0 ${f(x3)} ${f(y3)} Z`;
}

function renderSvg(d) {
  const W = 800, H = 560;
  const ACCENT = '#ff3b3b';
  const cx = 210, cy = 205, R = 125, r = 72;

  // Language slices
  let visible = d.languages.filter((l) => l.pct > 0);
  const shown = visible.slice(0, MAX_LANGUAGES);
  const rest = visible.slice(MAX_LANGUAGES);
  const otherPct = Math.round(rest.reduce((s, l) => s + l.pct, 0) * 100) / 100;

  const slices = shown.map((l, i) => ({
    ...l,
    color: LANG_COLORS[l.name] || FALLBACK[i % FALLBACK.length],
  }));
  if (otherPct > 0) slices.push({ name: 'Other', pct: otherPct, color: OTHER_COLOR });

  let chart = '';
  if (!slices.length) {
    chart = `<circle cx="${cx}" cy="${cy}" r="${(R + r) / 2}" fill="none" stroke="#2a2a2a" stroke-width="${R - r}"/>
      <text x="${cx}" y="${cy + 5}" text-anchor="middle" font-size="14" fill="#888">No language data</text>`;
  } else if (slices.length === 1) {
    chart = `<circle cx="${cx}" cy="${cy}" r="${(R + r) / 2}" fill="none" stroke="${slices[0].color}" stroke-width="${R - r}"/>`;
  } else {
    const sum = slices.reduce((s, l) => s + l.pct, 0);
    let angle = -Math.PI / 2;
    for (const s of slices) {
      const sweep = (s.pct / sum) * Math.PI * 2;
      chart += `<path d="${donutSlice(cx, cy, R, r, angle, angle + sweep)}" fill="${s.color}" stroke="#121212" stroke-width="1.5"/>\n    `;
      angle += sweep;
    }
  }

  // Legend
  let legend = '';
  const legendX = 450;
  shown.forEach((_, i) => {
    const s = slices[i];
    const y = 96 + i * 32;
    legend += `<circle cx="${legendX}" cy="${y}" r="8" fill="${s.color}"/>
    <text x="${legendX + 22}" y="${y + 5}" font-size="14" font-family="'SFMono-Regular',Consolas,'Liberation Mono',monospace" fill="#e6e6e6">${esc(truncate(s.name, 22))} (${s.pct.toFixed(2)}%)</text>\n    `;
  });
  if (otherPct > 0) {
    legend += `<text x="${legendX}" y="${96 + shown.length * 32 + 6}" font-size="12" font-family="'SFMono-Regular',Consolas,monospace" fill="#8a8a8a">+ ${rest.length} more language${rest.length === 1 ? '' : 's'} (${otherPct.toFixed(2)}%)</text>`;
  }

  // Stat rows
  const rows = [
    ['📅', 'Last updated:', d.updated],
    ['📌', 'Featured repository:', d.featured ? `${USERNAME}/${truncate(d.featured.name, 28)}` : 'None'],
  ];
  if (d.contrib) rows.push(['📈', 'Contributions (last 12 mo):', fmt(d.contrib.contributions)]);
  rows.push(
    ['📁', 'Public repositories:', fmt(d.publicRepos)],
    ['⭐', 'Total stars:', fmt(d.stars)],
    ['👥', 'Followers / Following:', `${fmt(d.followers)} / ${fmt(d.following)}`]
  );
  if (d.contrib) rows.push(['📝', `Commits in ${d.contrib.year}:`, fmt(d.contrib.commits)]);

  const rowStart = 378, rowGap = 25;
  const mono = "font-family=\"'SFMono-Regular',Consolas,'Liberation Mono',monospace\"";
  const stats = rows
    .map(([icon, label, value], i) => {
      const y = rowStart + i * rowGap;
      return `<text x="60" y="${y}" font-size="15" fill="${ACCENT}">${icon} ${esc(label)}</text>
    <text x="345" y="${y}" font-size="15" font-weight="700" ${mono} fill="#ffffff">${esc(value)}</text>`;
    })
    .join('\n    ');

  const ruleNote = 'Featured: most-starred non-fork repo. Languages: bytes across non-fork public repos. Auto-generated via GitHub API.';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="GitHub statistics for ${esc(USERNAME)}">
  <title>GitHub statistics for @${esc(USERNAME)}</title>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="#121212" stroke="#3a3a3a"/>
  <g font-family="'Segoe UI',-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif">
    <text x="60" y="52" font-size="28" font-weight="700" fill="${ACCENT}">📊 GitHub Statistics - @${esc(USERNAME)}</text>
    ${chart}
    ${legend}
    ${stats}
    <text x="60" y="${H - 14}" font-size="10.5" fill="#777">${esc(ruleNote)}</text>
  </g>
</svg>
`;
}

// ---------- Main ----------

async function main() {
  console.log(`Generating stats for: ${USERNAME}`);
  const user = await fetchUser();
  const repos = await fetchRepos();
  const langBytes = await fetchLanguageBytes(repos);
  const contrib = await fetchContributions();

  const stars = repos.reduce((s, r) => s + (r.stargazers_count || 0), 0);
  const featured = pickFeatured(repos);
  const languages = computeLanguagePercentages(langBytes);

  const data = {
    publicRepos: user.public_repos,
    stars,
    followers: user.followers,
    following: user.following,
    languages,
    featured,
    contrib,
    updated: new Date().toLocaleDateString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
    }),
  };

  const svg = renderSvg(data);
  fs.writeFileSync(OUTPUT, svg, 'utf8'); // only reached if every required call succeeded

  console.log('--- Verification summary ---');
  console.log('Account       :', user.login, `(${user.html_url})`);
  console.log('Public repos  :', data.publicRepos);
  console.log('Total stars   :', stars);
  console.log('Followers     :', data.followers, '| Following:', data.following);
  console.log('Featured repo :', featured ? featured.full_name : 'none');
  console.log('Contributions :', contrib ? contrib.contributions : 'omitted (no token)');
  console.log('Commits       :', contrib ? `${contrib.commits} in ${contrib.year}` : 'omitted (no token)');
  console.log('Languages     :', languages.map((l) => `${l.name} ${l.pct.toFixed(2)}%`).join(', ') || 'none');
  console.log('Wrote         :', OUTPUT);
}

main().catch((err) => {
  console.error('Failed to generate stats:', err.message);
  process.exit(1); // leave the previous SVG untouched
});
