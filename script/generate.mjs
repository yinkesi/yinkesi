#!/usr/bin/env node
/**
 * 生成 GitHub 主页的 3D 贡献日历大图（含雷达图 / 语言环形图 / 统计行），
 * 并把统计数字、徽章、每日一句回写进 README.md。
 *
 * 用法：
 *   node script/generate.mjs           # 真实数据，需要环境变量 GITHUB_TOKEN
 *   node script/generate.mjs --demo    # 内置演示数据，本地预览布局用，不改 README
 */
import { readFileSync, writeFileSync } from 'node:fs';

const LOGIN = process.env.LOGIN || 'yinkesi';
const TOKEN = process.env.GITHUB_TOKEN;
const DEMO = process.argv.includes('--demo');
const README = 'README.md';
const SVG_OUT = 'github-3d.svg';

/* ---------------- 数据获取 ---------------- */

const QUERY = `query($login: String!) {
  user(login: $login) {
    followers { totalCount }
    repositories(first: 100, ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC,
                 orderBy: { field: STARGAZERS, direction: DESC }) {
      totalCount
      nodes { name stargazerCount forkCount primaryLanguage { name color } }
    }
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount color } }
      }
      totalCommitContributions
      totalIssueContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      totalRepositoryContributions
    }
  }
}`;

async function fetchRealData() {
  if (!TOKEN) throw new Error('缺少 GITHUB_TOKEN 环境变量');
  const gq = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ query: QUERY, variables: { login: LOGIN } }),
  }).then(r => r.json());
  if (gq.errors?.length) throw new Error('GraphQL: ' + JSON.stringify(gq.errors));
  const u = gq.data.user;
  const cc = u.contributionsCollection;
  const days = cc.contributionCalendar.weeks.flatMap(w => w.contributionDays);
  const repos = u.repositories.nodes;

  // 合并的 PR 数走 Search API（GraphQL 没有现成计数）
  let mergedPRs = 0;
  try {
    const s = await fetch(
      `https://api.github.com/search/issues?q=author:${LOGIN}+type:pr+is:merged`,
      { headers: { Authorization: `Bearer ${TOKEN}` } }
    ).then(r => r.json());
    mergedPRs = s.total_count ?? 0;
  } catch { /* 拿不到就记 0 */ }

  // 语言占比：按公开仓库的主语言计数（超过 6 种时剩余归入 other）
  const map = new Map();
  for (const r of repos) {
    const l = r.primaryLanguage;
    if (!l) continue;
    const e = map.get(l.name) ?? { name: l.name, color: l.color || '#8b949e', count: 0 };
    e.count++;
    map.set(l.name, e);
  }
  let langs = [...map.values()].sort((a, b) => b.count - a.count);
  if (langs.length > 6) {
    const rest = langs.slice(5);
    langs = [...langs.slice(0, 5), {
      name: 'other', color: '#444d55', count: rest.reduce((s, l) => s + l.count, 0),
    }];
  }

  return {
    days,
    totalContributions: cc.contributionCalendar.totalContributions,
    commits: cc.totalCommitContributions,
    mergedPRs,
    radar: {
      Commit: cc.totalCommitContributions,
      Issue: cc.totalIssueContributions,
      PullReq: cc.totalPullRequestContributions,
      Review: cc.totalPullRequestReviewContributions,
      Repo: cc.totalRepositoryContributions,
    },
    repos: u.repositories.totalCount,
    followers: u.followers.totalCount,
    stars: repos.reduce((s, r) => s + r.stargazerCount, 0),
    forks: repos.reduce((s, r) => s + r.forkCount, 0),
    langs,
  };
}

/* 演示数据：模仿参考截图的稀疏贡献 + 末尾一簇高塔 */
function demoData() {
  let seed = 42;
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const levelColor = c => (c === 0 ? '#ebedf0' : c <= 2 ? '#9be9a8' : c <= 5 ? '#40c463' : c <= 8 ? '#30a14e' : '#216e39');
  const days = [];
  for (let i = 0; i < 371; i++) {
    const w = Math.floor(i / 7);
    let c = 0;
    if (w >= 45 && rand() < 0.5) c = 1 + Math.floor(rand() * 10);
    else if (rand() < 0.06) c = 1 + Math.floor(rand() * 2);
    days.push({
      date: new Date(Date.now() - (370 - i) * 864e5).toISOString().slice(0, 10),
      contributionCount: c,
      color: levelColor(c),
    });
  }
  return {
    days,
    totalContributions: 84,
    commits: 91,
    mergedPRs: 0,
    radar: { Commit: 91, Issue: 3, PullReq: 0, Review: 1, Repo: 8 },
    repos: 3, followers: 5, stars: 4, forks: 0,
    langs: [
      { name: 'Verilog', color: '#b2b7f8', count: 2 },
      { name: 'C', color: '#555555', count: 1 },
      { name: 'TypeScript', color: '#3178c6', count: 1 },
      { name: 'Python', color: '#3572A5', count: 1 },
      { name: 'other', color: '#444d55', count: 1 },
    ],
  };
}

/* ---------------- SVG 绘制 ---------------- */

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const f1 = n => n.toFixed(1);

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16 & 255, n >> 8 & 255, n & 255].map(v => Math.round(v * f));
  return `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

/* 等距 3D 网格：菱形格沿左上→右下铺开，贡献数挤出柱体 */
function gridSvg(days) {
  const M = 7.5, OX = 185, OY = 130, HS = 3.4, HMAX = 34;
  const cells = days.map((d, i) => ({ ...d, w: Math.floor(i / 7), dy: i % 7 }));
  cells.sort((a, b) => (a.w + a.dy) - (b.w + b.dy)); // 由远及近
  let out = '';
  for (const c of cells) {
    const x = OX + (c.w - c.dy) * 2 * M;
    const y = OY + (c.w + c.dy) * M;
    const h = Math.min(c.contributionCount * HS, HMAX);
    const color = c.color || '#ebedf0';
    const top = `${f1(x)},${f1(y)} ${f1(x + 2 * M)},${f1(y + M)} ${f1(x)},${f1(y + 2 * M)} ${f1(x - 2 * M)},${f1(y + M)}`;
    if (h > 0) {
      out += `<polygon points="${f1(x - 2 * M)},${f1(y + M)} ${f1(x)},${f1(y + 2 * M)} ${f1(x)},${f1(y + 2 * M + h)} ${f1(x - 2 * M)},${f1(y + M + h)}" fill="${shade(color, 0.82)}"/>`;
      out += `<polygon points="${f1(x + 2 * M)},${f1(y + M)} ${f1(x)},${f1(y + 2 * M)} ${f1(x)},${f1(y + 2 * M + h)} ${f1(x + 2 * M)},${f1(y + M + h)}" fill="${shade(color, 0.62)}"/>`;
    }
    out += `<polygon points="${top}" fill="${color}" stroke="#fff" stroke-width="1"/>`;
  }
  return out;
}

/* 雷达图：Commit/Issue/PullReq/Review/Repo，对数刻度（10/100/1K/10K） */
function radarSvg(radar) {
  const cx = 757, cy = 195, R = 106;
  const keys = ['Commit', 'Issue', 'PullReq', 'Review', 'Repo'];
  const ang = i => (-90 + i * 72) * Math.PI / 180;
  const pt = (i, r) => [cx + r * Math.cos(ang(i)), cy + r * Math.sin(ang(i))];
  const rOf = v => R * Math.log10(Math.max(v, 1)) / 4;
  let s = '';
  for (const [v, label] of [[10, '10'], [100, '100'], [1000, '1K'], [10000, '10K']]) {
    const r = R * Math.log10(v) / 4;
    const pts = keys.map((_, i) => pt(i, r).map(f1).join(',')).join(' ');
    s += `<polygon points="${pts}" fill="none" stroke="#c9d1d9" stroke-width="1" stroke-dasharray="3 3"/>`;
    const [lx, ly] = pt(0, r);
    s += `<text x="${f1(lx + 5)}" y="${f1(ly + 3)}" font-size="9" fill="#8b949e">${label}</text>`;
  }
  keys.forEach((k, i) => {
    const [x2, y2] = pt(i, R);
    s += `<line x1="${cx}" y1="${cy}" x2="${f1(x2)}" y2="${f1(y2)}" stroke="#d0d7de" stroke-width="1" stroke-dasharray="3 3"/>`;
    const [tx, ty] = pt(i, R + 22);
    const anchor = Math.abs(tx - cx) < 6 ? 'middle' : tx > cx ? 'start' : 'end';
    s += `<text x="${f1(tx)}" y="${f1(ty + 4)}" font-size="13" fill="#24292f" text-anchor="${anchor}">${k}</text>`;
  });
  const data = keys.map((k, i) => pt(i, rOf(radar[k])).map(f1).join(',')).join(' ');
  s += `<polygon points="${data}" fill="#2da44e" fill-opacity="0.35" stroke="#2da44e" stroke-width="1.6"/>`;
  return s;
}

/* 语言环形图：按仓库主语言占比 */
function donutSvg(langs) {
  const cx = 190, cy = 452, R = 92, r = 54;
  const total = langs.reduce((s, l) => s + l.count, 0);
  let s = '', a0 = -Math.PI / 2;
  const p = (a, rad) => `${f1(cx + rad * Math.cos(a))},${f1(cy + rad * Math.sin(a))}`;
  for (const l of langs) {
    const a1 = a0 + (l.count / total) * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    if (langs.length === 1) {
      s += `<circle cx="${cx}" cy="${cy}" r="${(R + r) / 2}" fill="none" stroke="${l.color}" stroke-width="${R - r}"/>`;
    } else {
      s += `<path d="M ${p(a0, R)} A ${R} ${R} 0 ${large} 1 ${p(a1, R)} L ${p(a1, r)} A ${r} ${r} 0 ${large} 0 ${p(a0, r)} Z" fill="${l.color}" stroke="#fff" stroke-width="2"/>`;
    }
    a0 = a1;
  }
  let ly = cy - ((langs.length - 1) * 26) / 2;
  for (const l of langs) {
    s += `<rect x="302" y="${f1(ly - 10)}" width="13" height="13" rx="2" fill="${l.color}"/>`;
    s += `<text x="323" y="${f1(ly + 2)}" font-size="14" fill="#24292f">${esc(l.name)}</text>`;
    ly += 26;
  }
  return s;
}

const OCTICON_STAR = 'M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.751.751 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Zm0 2.445L6.615 5.5a.75.75 0 0 1-.564.41l-3.097.45 2.24 2.184a.75.75 0 0 1 .216.664l-.528 3.084 2.769-1.456a.75.75 0 0 1 .698 0l2.77 1.456-.53-3.084a.75.75 0 0 1 .216-.664l2.24-2.183-3.096-.45a.75.75 0 0 1-.564-.41L8 2.694Z';
const OCTICON_FORK = 'M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.25 2.25 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Zm6.75.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm-3 8.75a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z';

/* 底部统计行：84 contributions ☆ 4 ⑂ 0 */
function statsSvg(d) {
  const Y = 618, num = 'font-size="20" font-weight="600" fill="#24292f"';
  const lbl = 'font-size="15" fill="#57606a"';
  const icon = (path, x) =>
    `<g transform="translate(${x},${Y - 17}) scale(1.15)"><path fill-rule="evenodd" d="${path}" fill="#57606a"/></g>`;
  let x = 352;
  let s = `<text x="${x}" y="${Y}" ${num}>${d.totalContributions}</text>`;
  x += String(d.totalContributions).length * 12 + 8;
  s += `<text x="${x}" y="${Y}" ${lbl}>contributions</text>`;
  x += 13 * 6.6 + 42;
  s += icon(OCTICON_STAR, x);
  x += 26;
  s += `<text x="${x}" y="${Y}" ${num}>${d.stars}</text>`;
  x += String(d.stars).length * 12 + 42;
  s += icon(OCTICON_FORK, x);
  x += 24;
  s += `<text x="${x}" y="${Y}" ${num}>${d.forks}</text>`;
  return s;
}

function makeSvg(d) {
  const from = d.days[0].date, to = d.days[d.days.length - 1].date;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1050" height="660" viewBox="0 0 1050 660" font-family="-apple-system,'Segoe UI',Helvetica,Arial,sans-serif">
<rect width="1050" height="660" fill="#ffffff"/>
<text x="1012" y="42" font-size="12" fill="#8b949e" text-anchor="end">${from.replaceAll('-', '.')} / ${to.replaceAll('-', '.')}</text>
${gridSvg(d.days)}
${radarSvg(d.radar)}
${donutSvg(d.langs)}
${statsSvg(d)}
<text x="525" y="646" font-size="11" fill="#8b949e" text-anchor="middle">3D contribution calendar · generated daily by GitHub Actions</text>
</svg>
`;
}

/* ---------------- README 回写 ---------------- */

function replaceBlock(text, tag, content) {
  const re = new RegExp(`<!-- ${tag}:start -->[\\s\\S]*?<!-- ${tag}:end -->`);
  if (!re.test(text)) throw new Error(`README.md 缺少标记 <!-- ${tag}:start/end -->`);
  return text.replace(re, `<!-- ${tag}:start -->\n${content}\n<!-- ${tag}:end -->`);
}

async function fetchQuote() {
  try {
    const j = await fetch('https://v1.hitokoto.cn/?max_length=48').then(r => r.json());
    return `<details>\n<summary>每日一句</summary>\n\n> 「${j.hitokoto}」 —— ${j.from || '佚名'}\n\n</details>`;
  } catch {
    return null; // 拉不到就保留 README 里的旧句子
  }
}

function updateReadme(d) {
  let md = readFileSync(README, 'utf8');
  md = replaceBlock(md, 'stats',
    `<p align="center">${d.repos} 公开仓库 · ${d.stars} Public Stars · ${d.commits} 过去一年 Commits · ${d.mergedPRs} 合并 PR · ${d.followers} Followers</p>`);
  md = replaceBlock(md, 'badges', [
    `![Public Repos](https://img.shields.io/badge/Public_Repos-${d.repos}-2088FF?labelColor=4c5166)`,
    `![Followers](https://img.shields.io/badge/Followers-${d.followers}-0969DA)`,
    `![Stars](https://img.shields.io/badge/Stars-${d.stars}-0969DA)`,
    `![Profile updated](https://img.shields.io/badge/Profile_updated-today-2088FF?labelColor=4c5166)`,
  ].join(' '));
  return fetchQuote().then(q => {
    if (q) md = replaceBlock(md, 'quote', q);
    writeFileSync(README, md);
  });
}

/* ---------------- main ---------------- */

const data = DEMO ? demoData() : await fetchRealData();
writeFileSync(SVG_OUT, makeSvg(data));
console.log(`✓ 已生成 ${SVG_OUT}（contributions=${data.totalContributions}, commits=${data.commits}, stars=${data.stars}, repos=${data.repos}）`);
if (!DEMO) await updateReadme(data);
