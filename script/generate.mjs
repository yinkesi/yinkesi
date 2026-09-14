#!/usr/bin/env node
/**
 * 生成 GitHub 主页的数据总览卡片：深色画布 + 极光色晕 + 玻璃芯片，
 * 风格参照 Apple 排印规则与 antigravity-drift（Updraft）深色套件。
 * 并把每日一句回写进 README.md。
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

/* ------- antigravity-drift 设计令牌 ------- */
const C = {
  bg: '#08090d',
  tileEmpty: '#1f2531',
  ink: '#e9ebf3',
  ink2: '#a2a9bd',
  ink3: '#6f7688',
  line: 'rgba(233,235,243,.11)',
  lineSoft: 'rgba(233,235,243,.05)',
  glass: 'rgba(180,190,224,.055)',
  blue: '#5b9dff',
  violet: '#b48ae0',
  pink: '#e87f89',
  green: '#39d353',
  grad: ['#5b9dff', '#b48ae0', '#e87f89'],
};
const LEVELS = ['#0e4429', '#006d32', '#26a641', '#39d353'];
const levelColor = c => (c === 0 ? C.tileEmpty : LEVELS[Math.min(3, Math.ceil(c / 3) - 1 + (c > 8 ? 1 : 0))]);

/* ---------------- 数据获取 ---------------- */

const QUERY = `query($login: String!) {
  user(login: $login) {
    followers { totalCount }
    repositories(first: 100, ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC,
                 orderBy: { field: STARGAZERS, direction: DESC }) {
      totalCount
      nodes { name url description stargazerCount forkCount
              repositoryTopics(first: 3) { nodes { topic { name } } }
              primaryLanguage { name color } }
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

  // 深色日历：API 给的是浅色阶，按贡献数映射到 GitHub 深色阶
  for (const d of days) {
    d.color = d.contributionCount === 0 ? C.tileEmpty
      : LEVELS[Math.min(3, Math.floor((d.contributionCount - 1) / 3))];
  }

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
    const e = map.get(l.name) ?? { name: l.name, color: l.color || C.ink3, count: 0 };
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
    login: LOGIN,
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
    topRepos: repos.filter(r => r.name !== LOGIN).slice(0, 4).map(r => ({
      name: r.name,
      url: r.url,
      description: r.description || '',
      lang: r.primaryLanguage?.name || '',
      langColor: r.primaryLanguage?.color || '#6f7688',
      stars: r.stargazerCount,
      topics: (r.repositoryTopics?.nodes ?? []).map(n => n.topic.name),
    })),
    langBytes: await fetchLangBytes(LOGIN, repos.map(r => r.name)),
  };
}

/* 逐仓库统计代码字节量，汇总出「语言分布（按代码量）」 */
async function fetchLangBytes(login, repoNames) {
  const totals = new Map();
  await Promise.all(repoNames.map(async name => {
    try {
      const j = await fetch(`https://api.github.com/repos/${login}/${name}/languages`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }).then(r => r.json());
      for (const [lang, bytes] of Object.entries(j)) totals.set(lang, (totals.get(lang) || 0) + bytes);
    } catch { /* 单仓库失败忽略 */ }
  }));
  return [...totals.entries()].map(([name, bytes]) => ({ name, bytes })).sort((a, b) => b.bytes - a.bytes);
}

/* 连续提交与单日峰值 */
function calcStats(days, langBytes) {
  let longest = 0, run = 0;
  for (const d of days) { run = d.contributionCount > 0 ? run + 1 : 0; longest = Math.max(longest, run); }
  let cur = 0;
  for (let i = days.length - 1; i >= 0 && days[i].contributionCount > 0; i--) cur++;
  const peak = days.reduce((m, d) => d.contributionCount > m.count ? { count: d.contributionCount, date: d.date } : m, { count: 0, date: '' });
  const totalBytes = langBytes.reduce((s, l) => s + l.bytes, 0);
  return { cur, longest, peak, langBytes, totalBytes };
}

/* 演示数据：模仿稀疏贡献 + 末尾一簇高塔 */
function demoData() {
  let seed = 42;
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
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
    login: 'yinkesi', days, totalContributions: 84, commits: 91, mergedPRs: 0,
    radar: { Commit: 91, Issue: 3, PullReq: 0, Review: 1, Repo: 8 },
    repos: 3, followers: 5, stars: 4, forks: 0,
    langs: [
      { name: 'Verilog', color: '#b2b7f8', count: 2 },
      { name: 'C', color: '#555555', count: 1 },
      { name: 'TypeScript', color: '#3178c6', count: 1 },
      { name: 'Python', color: '#3572A5', count: 1 },
      { name: 'other', color: '#444d55', count: 1 },
    ],
    topRepos: [
      { name: 'lumen-translate', url: 'https://github.com/yinkesi/lumen-translate', description: '沉浸式翻译工具', lang: 'TypeScript', langColor: '#3178c6', stars: 2 },
      { name: 'apple-park-3d', url: 'https://github.com/yinkesi/apple-park-3d', description: 'Apple Park 三维重建', lang: 'C++', langColor: '#f34b7d', stars: 1 },
      { name: 'cumcm2026', url: 'https://github.com/yinkesi/cumcm2026', description: '全国大学生数学建模竞赛', lang: 'Python', langColor: '#3572A5', stars: 1 },
      { name: 'nanogpt-lecture', url: 'https://github.com/yinkesi/nanogpt-lecture', description: 'karpathy nanoGPT 跟练', lang: 'JavaScript', langColor: '#f1e05a', stars: 0 },
    ],
    langBytes: [
      { name: 'TypeScript', bytes: 820e3 }, { name: 'JavaScript', bytes: 540e3 },
      { name: 'Python', bytes: 430e3 }, { name: 'C++', bytes: 260e3 },
      { name: 'C', bytes: 120e3 }, { name: 'HTML', bytes: 60e3 },
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

/* 深色画布上的语言色：向 surface-2 混合 22%，压一压浅色系配色的亮度 */
function soften(hex) {
  const mix = 0.22, base = [0x12, 0x15, 0x1d];
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16 & 255, n >> 8 & 255, n & 255]
    .map((v, i) => Math.round(v * (1 - mix) + base[i] * mix));
  return `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

/* 等距 3D 网格：菱形格沿左上→右下铺开，贡献数挤出柱体 */
function gridSvg(days) {
  const M = 7, OX = 185, OY = 165, HS = 3.4, HMAX = 32;
  const cells = days.map((d, i) => ({ ...d, w: Math.floor(i / 7), dy: i % 7 }));
  cells.sort((a, b) => (a.w + a.dy) - (b.w + b.dy)); // 由远及近
  let tiles = '', glows = '';
  for (const c of cells) {
    const x = OX + (c.w - c.dy) * 2 * M;
    const y = OY + (c.w + c.dy) * M;
    const h = Math.min(c.contributionCount * HS, HMAX);
    const color = c.color || C.tileEmpty;
    const top = `${f1(x)},${f1(y)} ${f1(x + 2 * M)},${f1(y + M)} ${f1(x)},${f1(y + 2 * M)} ${f1(x - 2 * M)},${f1(y + M)}`;
    if (h > 0) {
      // 柱体立在网格上：顶面向上抬升 h，墙面从抬升后的顶边连回格子原位
      const ty = y - h;
      tiles += `<polygon points="${f1(x - 2 * M)},${f1(ty + M)} ${f1(x)},${f1(ty + 2 * M)} ${f1(x)},${f1(y + 2 * M)} ${f1(x - 2 * M)},${f1(y + M)}" fill="${shade(color, 0.82)}"/>`;
      tiles += `<polygon points="${f1(x + 2 * M)},${f1(ty + M)} ${f1(x)},${f1(ty + 2 * M)} ${f1(x)},${f1(y + 2 * M)} ${f1(x + 2 * M)},${f1(y + M)}" fill="${shade(color, 0.6)}"/>`;
      tiles += `<polygon points="${f1(x)},${f1(ty)} ${f1(x + 2 * M)},${f1(ty + M)} ${f1(x)},${f1(ty + 2 * M)} ${f1(x - 2 * M)},${f1(ty + M)}" fill="${color}" stroke="rgba(233,235,243,.07)" stroke-width="1"/>`;
      glows += `<ellipse cx="${f1(x)}" cy="${f1(y + 2 * M)}" rx="17" ry="8" fill="${color}" opacity="0.32"/>`;
    } else {
      tiles += `<polygon points="${top}" fill="${color}" stroke="rgba(233,235,243,.09)" stroke-width="1"/>`;
    }
  }
  return `<g>${tiles}</g><g filter="url(#soft)">${glows}</g>`;
}

/* 雷达图：Commit/Issue/PullReq/Review/Repo，对数刻度（10/100/1K/10K） */
function radarSvg(radar) {
  const cx = 800, cy = 305, R = 96;
  const keys = ['Commit', 'Issue', 'PullReq', 'Review', 'Repo'];
  const ang = i => (-90 + i * 72) * Math.PI / 180;
  const pt = (i, r) => [cx + r * Math.cos(ang(i)), cy + r * Math.sin(ang(i))];
  const rOf = v => R * Math.log10(Math.max(v, 1)) / 4;
  let s = '';
  for (const [v, label] of [[10, '10'], [100, '100'], [1000, '1K'], [10000, '10K']]) {
    const r = R * Math.log10(v) / 4;
    const pts = keys.map((_, i) => pt(i, r).map(f1).join(',')).join(' ');
    s += `<polygon points="${pts}" fill="none" stroke="${C.lineSoft}" stroke-width="1" stroke-dasharray="3 4"/>`;
    const [lx, ly] = pt(0, r);
    s += `<text x="${f1(lx + 5)}" y="${f1(ly + 3)}" font-family="${MONO}" font-size="8.5" fill="${C.ink3}">${label}</text>`;
  }
  keys.forEach((k, i) => {
    const [x2, y2] = pt(i, R);
    s += `<line x1="${cx}" y1="${cy}" x2="${f1(x2)}" y2="${f1(y2)}" stroke="${C.lineSoft}" stroke-width="1" stroke-dasharray="3 4"/>`;
    const [tx, ty] = pt(i, R + 20);
    const anchor = Math.abs(tx - cx) < 6 ? 'middle' : tx > cx ? 'start' : 'end';
    s += `<text x="${f1(tx)}" y="${f1(ty + 4)}" font-family="${MONO}" font-size="11" letter-spacing="1.2" fill="${C.ink2}" text-anchor="${anchor}">${k.toUpperCase()}</text>`;
  });
  const data = keys.map((k, i) => pt(i, rOf(radar[k])).map(f1).join(',')).join(' ');
  s += `<polygon points="${data}" fill="url(#gradRing)" fill-opacity="0.22" stroke="url(#gradRing)" stroke-width="1.6" stroke-linejoin="round"/>`;
  keys.forEach((k, i) => {
    if (!radar[k]) return;
    const [vx, vy] = pt(i, rOf(radar[k]));
    s += `<circle cx="${f1(vx)}" cy="${f1(vy)}" r="2.4" fill="${C.grad[i % 3]}"/>`;
  });
  return s;
}

/* 语言环形图：按仓库主语言占比，发丝线分隔，中心放仓库数 */
function donutSvg(langs, repos) {
  const cx = 180, cy = 492, R = 84, r = 52;
  const total = langs.reduce((s, l) => s + l.count, 0);
  let s = '', a0 = -Math.PI / 2;
  const p = (a, rad) => `${f1(cx + rad * Math.cos(a))},${f1(cy + rad * Math.sin(a))}`;
  s += `<circle cx="${cx}" cy="${cy}" r="${(R + r) / 2}" fill="none" stroke="rgba(233,235,243,.055)" stroke-width="${R - r}"/>`;
  for (const l of langs) {
    const a1 = a0 + (l.count / total) * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    s += `<path d="M ${p(a0, R)} A ${R} ${R} 0 ${large} 1 ${p(a1, R)} L ${p(a1, r)} A ${r} ${r} 0 ${large} 0 ${p(a0, r)} Z" fill="${soften(l.color)}" stroke="${C.bg}" stroke-width="2"/>`;
    a0 = a1;
  }
  s += `<text x="${cx}" y="${cy + 2}" font-family="${SANS}" font-size="30" font-weight="700" letter-spacing="-0.6" fill="${C.ink}" text-anchor="middle">${repos}</text>`;
  s += `<text x="${cx}" y="${cy + 20}" font-family="${MONO}" font-size="9" letter-spacing="1.5" fill="${C.ink3}" text-anchor="middle">REPOS</text>`;
  // 图例：色块 + 名称 + 数量
  let ly = cy - ((langs.length - 1) * 25) / 2;
  for (const l of langs) {
    s += `<rect x="290" y="${f1(ly - 9)}" width="11" height="11" rx="3" fill="${soften(l.color)}"/>`;
    s += `<text x="310" y="${f1(ly + 1)}" font-family="${SANS}" font-size="13" fill="${C.ink2}">${esc(l.name)}</text>`;
    s += `<text x="425" y="${f1(ly + 1)}" font-family="${MONO}" font-size="11" fill="${C.ink3}" text-anchor="end">${l.count}</text>`;
    ly += 25;
  }
  return s;
}

const OCTICON_STAR = 'M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.751.751 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Zm0 2.445L6.615 5.5a.75.75 0 0 1-.564.41l-3.097.45 2.24 2.184a.75.75 0 0 1 .216.664l-.528 3.084 2.769-1.456a.75.75 0 0 1 .698 0l2.77 1.456-.53-3.084a.75.75 0 0 1 .216-.664l2.24-2.183-3.096-.45a.75.75 0 0 1-.564-.41L8 2.694Z';
const OCTICON_FORK = 'M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.25 2.25 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Zm6.75.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm-3 8.75a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z';

/* 玻璃芯片行：等宽小标签 + 数值，前置彩色圆点 */
function chipsSvg(d) {
  const items = [
    { dot: C.blue, label: `${d.repos} 公开仓库` },
    { dot: C.violet, label: `${d.stars} Stars` },
    { dot: C.pink, label: `${d.commits} Commits · 1Y` },
    { dot: C.blue, label: `${d.mergedPRs} 合并 PR` },
    { dot: C.violet, label: `${d.followers} Followers` },
    { dot: C.green, label: 'Updated Today' },
  ];
  const width = t => [...t].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e7f ? 11.5 : / /.test(ch) ? 3.6 : 6.8), 0);
  let x = 48, out = '';
  for (const it of items) {
    const w = Math.round(width(it.label) + 36);
    out += `<rect x="${x}" y="96" width="${w}" height="30" rx="15" fill="${C.glass}" stroke="${C.line}"/>`;
    out += `<circle cx="${x + 16}" cy="111" r="3" fill="${it.dot}"/>`;
    out += `<text x="${x + 26}" y="115" font-family="${MONO}" font-size="11" letter-spacing="0.5" fill="${C.ink2}">${esc(it.label)}</text>`;
    x += w + 10;
  }
  return out;
}

/* 底部统计：渐变大数字 + 等宽小标签 */
function statsSvg(d) {
  const groups = [
    { num: d.totalContributions, label: 'CONTRIBUTIONS' },
    { num: d.stars, label: 'STARS' },
    { num: d.forks, label: 'FORKS' },
  ];
  let s = '';
  const xs = [350, 480, 610];
  groups.forEach((g, i) => {
    s += `<text x="${xs[i]}" y="648" font-family="${SANS}" font-size="27" font-weight="700" letter-spacing="-0.5" fill="url(#gradText)" text-anchor="middle">${g.num}</text>`;
    s += `<text x="${xs[i]}" y="666" font-family="${MONO}" font-size="9" letter-spacing="1.6" fill="${C.ink3}" text-anchor="middle">${g.label}</text>`;
  });
  const icon = (path, x) =>
    `<g transform="translate(${x},633) scale(1.25)"><path fill-rule="evenodd" d="${path}" fill="${C.ink3}"/></g>`;
  s += icon(OCTICON_STAR, 430);
  s += icon(OCTICON_FORK, 558);
  return s;
}

const SANS = `-apple-system,'Segoe UI Variable Display','Segoe UI',Helvetica,'PingFang SC','Microsoft YaHei',sans-serif`;
const MONO = `'JetBrains Mono','Cascadia Code',Consolas,monospace`;

function makeSvg(d) {
  const from = d.days[0].date, to = d.days[d.days.length - 1].date;
  const kick = `GITHUB · @${d.login.toUpperCase()} — 数据总览`;
  const dates = `${from.replaceAll('-', '.')} → ${to.replaceAll('-', '.')} · DAILY SYNC`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1050" height="700" viewBox="0 0 1050 700">
<defs>
<linearGradient id="gradText" x1="0" y1="0" x2="1" y2="0"><stop offset="8%" stop-color="${C.grad[0]}"/><stop offset="52%" stop-color="${C.grad[1]}"/><stop offset="96%" stop-color="${C.grad[2]}"/></linearGradient>
<linearGradient id="gradRing" x1="0" y1="0" x2="1" y2="1"><stop offset="8%" stop-color="${C.grad[0]}"/><stop offset="52%" stop-color="${C.grad[1]}"/><stop offset="96%" stop-color="${C.grad[2]}"/></linearGradient>
<radialGradient id="glowBlue"><stop offset="0%" stop-color="${C.blue}" stop-opacity=".17"/><stop offset="100%" stop-color="${C.blue}" stop-opacity="0"/></radialGradient>
<radialGradient id="glowViolet"><stop offset="0%" stop-color="${C.violet}" stop-opacity=".14"/><stop offset="100%" stop-color="${C.violet}" stop-opacity="0"/></radialGradient>
<radialGradient id="glowPink"><stop offset="0%" stop-color="${C.pink}" stop-opacity=".10"/><stop offset="100%" stop-color="${C.pink}" stop-opacity="0"/></radialGradient>
<radialGradient id="vig" cx=".5" cy=".45" r=".75"><stop offset="62%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity=".5"/></radialGradient>
<filter id="soft" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="3"/></filter>
<filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter>
<clipPath id="card"><rect width="1050" height="700" rx="26"/></clipPath>
</defs>
<g clip-path="url(#card)">
<rect width="1050" height="700" fill="${C.bg}"/>
<ellipse cx="140" cy="110" rx="330" ry="230" fill="url(#glowBlue)"/>
<ellipse cx="890" cy="350" rx="360" ry="260" fill="url(#glowViolet)"/>
<ellipse cx="240" cy="650" rx="330" ry="220" fill="url(#glowPink)"/>
<rect width="1050" height="700" fill="url(#vig)"/>
<rect width="1050" height="700" filter="url(#grain)" opacity="0.05"/>
<rect x="0.5" y="0.5" width="1049" height="699" rx="26" fill="none" stroke="rgba(233,235,243,.08)"/>
<text x="48" y="56" font-family="${MONO}" font-size="11" letter-spacing="2.2" fill="${C.ink2}">${esc(kick)}</text>
<text x="1002" y="56" font-family="${MONO}" font-size="10.5" letter-spacing="1.2" fill="${C.ink3}" text-anchor="end">${dates}</text>
<line x1="48" y1="74" x2="1002" y2="74" stroke="${C.lineSoft}"/>
${chipsSvg(d)}
${gridSvg(d.days)}
${radarSvg(d.radar)}
${donutSvg(d.langs, d.repos)}
${statsSvg(d)}
<text x="48" y="682" font-family="${MONO}" font-size="9.5" letter-spacing="1.5" fill="${C.ink3}">3D CONTRIBUTION CALENDAR</text>
<text x="1002" y="682" font-family="${MONO}" font-size="9.5" letter-spacing="1.5" fill="${C.ink3}" text-anchor="end">GENERATED DAILY BY GITHUB ACTIONS</text>
</g>
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
    return `<details>\n<summary>每日一句 · Daily Quote</summary>\n\n> 「${j.hitokoto}」 —— ${j.from || '佚名'}\n\n</details>`;
  } catch {
    return null; // 拉不到就保留 README 里的旧句子
  }
}

/* 公开事件流 → 最近动态（中文渲染） */
async function fetchEvents(login) {
  const TYPES = {
    PushEvent: e => `推送 ${e.payload.size || 1} 个提交至 `,
    CreateEvent: e => e.payload.ref_type === 'repository' ? '创建了仓库 ' : null,
    WatchEvent: () => '给 ',
    ForkEvent: () => '复刻了 ',
    ReleaseEvent: () => '发布了 ',
    PublicEvent: () => '开源了 ',
  };
  const evs = await fetch(`https://api.github.com/users/${login}/events/public?per_page=60`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  }).then(r => r.json());
  if (!Array.isArray(evs)) return '- _暂时拉不到动态_';
  const items = [];
  const seen = new Set();
  for (const e of evs) {
    const fmt = TYPES[e.type];
    if (!fmt || seen.has(e.repo.name)) continue;
    const text = fmt(e);
    if (!text) continue; // 忽略建分支等噪音
    seen.add(e.repo.name);
    const date = e.created_at.slice(5, 7) + '.' + e.created_at.slice(8, 10);
    const url = 'https://github.com/' + e.repo.name;
    items.push({ date, text: `- \`${date}\` ${text}**[${e.repo.name}](${url})**`, at: e.created_at });
  }
  items.sort((a, b) => b.at.localeCompare(a.at)); // 严格按时间倒序（API 顺序偶有乱序）
  const lines = items.slice(0, 5).map(x => x.text);
  return lines.length ? lines.join('\n') : '- _暂无公开动态，快去写点代码～_';
}

/* 精选仓库：两栏项目卡片（emoji + 简介 + 技术标签 + 实时 Star 徽章） */
function reposTable(d) {
  if (!d.topRepos?.length) return '_暂无公开仓库_';
  const icons = ['🎮', '🎨', '🔍', '🌐', '🤖', '🧭', '🔭', '⚙️'];
  let cells = '';
  d.topRepos.forEach((r, i) => {
    const tags = [r.lang, ...(r.topics || [])].filter(Boolean).slice(0, 4)
      .map(t => '`' + t + '`').join(' ');
    const star = `<img src="https://img.shields.io/github/stars/${d.login}/${r.name}?style=flat-square&color=b48ae0&label=%E2%98%85" height="16" alt="stars"/>`;
    cells += `<td width="50%" valign="top">\n\n### ${icons[i % icons.length]} [${r.name}](${r.url})\n\n${r.description ? esc(r.description) : '*暂无简介*'}\n\n${tags} · ${star}\n\n</td>\n`;
    if (i % 2 === 1 && i !== d.topRepos.length - 1) cells += '</tr>\n<tr>\n';
  });
  return `<table>\n<tr>\n${cells}</tr>\n</table>`;
}

async function updateReadme(d) {
  let md = readFileSync(README, 'utf8');
  md = replaceBlock(md, 'repos', reposTable(d));
  md = replaceBlock(md, 'events', await fetchEvents(d.login));
  const q = await fetchQuote();
  if (q) md = replaceBlock(md, 'quote', q);
  writeFileSync(README, md);
}

/* ---------------- 年度统计卡（自绘，无第三方依赖） ---------------- */

const MMM = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const fmtBytes = b => b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : b >= 1e3 ? Math.round(b / 1e3) + ' KB' : String(b);

function makeStatsSvg(d, s) {
  const W = 1050, H = 640;
  /* --- 年度贡献面积图 --- */
  const gx0 = 48, gx1 = 1002, gy0 = 118, gy1 = 298;
  const n = d.days.length;
  const maxC = Math.max(5, ...d.days.map(x => x.contributionCount));
  const X = i => gx0 + i * (gx1 - gx0) / (n - 1);
  const Y = c => gy1 - (c / maxC) * (gy1 - gy0);
  const line = d.days.map((x, i) => `${f1(X(i))},${f1(Y(x.contributionCount))}`).join(' ');
  let chart = '';
  const step = Math.max(1, Math.ceil(maxC / 4));
  for (let c = step; c <= maxC; c += step) {
    const y = Y(c);
    chart += `<line x1="${gx0}" y1="${f1(y)}" x2="${gx1}" y2="${f1(y)}" stroke="${C.lineSoft}" stroke-dasharray="2 5"/>`;
    chart += `<text x="${gx1}" y="${f1(y - 4)}" font-family="${MONO}" font-size="8.5" fill="${C.ink3}" text-anchor="end">${c}</text>`;
  }
  chart += `<line x1="${gx0}" y1="${gy1}" x2="${gx1}" y2="${gy1}" stroke="${C.line}"/>`;
  for (let i = 0; i < n; i++) {
    if (d.days[i].date.slice(8, 10) !== '01') continue;
    const x = X(i);
    chart += `<line x1="${f1(x)}" y1="${gy1}" x2="${f1(x)}" y2="${gy1 + 5}" stroke="${C.ink3}"/>`;
    chart += `<text x="${f1(x)}" y="${gy1 + 17}" font-family="${MONO}" font-size="9" letter-spacing="1" fill="${C.ink3}">${MMM[+d.days[i].date.slice(5, 7) - 1]}</text>`;
  }
  chart += `<polygon points="${line} ${gx1},${gy1} ${gx0},${gy1}" fill="url(#gradArea)"/>`;
  chart += `<polyline points="${line}" fill="none" stroke="url(#gradRing2)" stroke-width="2" stroke-linejoin="round"/>`;
  const pi = d.days.findIndex(x => x.contributionCount === s.peak.count);
  if (s.peak.count > 0 && pi >= 0) {
    const px = Math.min(X(pi), gx1 - 110), py = Y(s.peak.count);
    chart += `<circle cx="${f1(X(pi))}" cy="${f1(py)}" r="3.5" fill="${C.pink}"/>`;
    chart += `<text x="${f1(px + 8)}" y="${f1(py - 8)}" font-family="${MONO}" font-size="9.5" fill="${C.pink}">峰值 ${s.peak.count} · ${s.peak.date.slice(5).replace('-', '.')}</text>`;
  }

  /* --- 语言分布（按代码字节量）--- */
  const langs = s.langBytes.slice(0, 6);
  const total = s.langBytes.reduce((x, l) => x + l.bytes, 0) || 1;
  const bx = 175, bw = 430;
  let bars = `<text x="48" y="352" font-family="${MONO}" font-size="10.5" letter-spacing="1.8" fill="${C.ink2}">语言分布 · LANGUAGES BY BYTES</text>`;
  langs.forEach((l, i) => {
    const y = 376 + i * 30, w = Math.max(4, l.bytes / langs[0].bytes * bw);
    const pct = (l.bytes / total * 100).toFixed(1);
    bars += `<text x="48" y="${f1(y + 11)}" font-family="${SANS}" font-size="12.5" fill="${C.ink2}">${esc(l.name)}</text>`;
    bars += `<rect x="${bx}" y="${y}" width="${bw}" height="12" rx="6" fill="rgba(233,235,243,.06)"/>`;
    bars += `<rect x="${bx}" y="${y}" width="${f1(w)}" height="12" rx="6" fill="${soften(langColorOf(l.name, d))}"/>`;
    bars += `<text x="${bx + bw + 12}" y="${f1(y + 10)}" font-family="${MONO}" font-size="10" fill="${C.ink3}">${pct}%</text>`;
  });

  /* --- 成就瓷砖 --- */
  const tiles = [
    { num: String(s.cur), label: '当前连续提交 · DAYS' },
    { num: String(s.longest), label: '最长连续提交 · DAYS' },
    { num: String(s.peak.count), label: '单日贡献峰值 · PEAK' },
    { num: fmtBytes(s.totalBytes), label: '公开代码总量 · BYTES' },
  ];
  let chips = '';
  tiles.forEach((t, i) => {
    const tx = 672 + (i % 2) * 170, ty = 366 + Math.floor(i / 2) * 104;
    chips += `<rect x="${tx}" y="${ty}" width="158" height="92" rx="14" fill="${C.glass}" stroke="${C.line}"/>`;
    chips += `<text x="${tx + 16}" y="${ty + 46}" font-family="${SANS}" font-size="24" font-weight="700" letter-spacing="-0.5" fill="url(#gradText2)">${esc(t.num)}</text>`;
    chips += `<text x="${tx + 16}" y="${ty + 70}" font-family="${MONO}" font-size="8.5" letter-spacing="1" fill="${C.ink3}">${esc(t.label)}</text>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
<linearGradient id="gradText2" x1="0" y1="0" x2="1" y2="0"><stop offset="8%" stop-color="${C.grad[0]}"/><stop offset="52%" stop-color="${C.grad[1]}"/><stop offset="96%" stop-color="${C.grad[2]}"/></linearGradient>
<linearGradient id="gradRing2" x1="0" y1="0" x2="1" y2="0"><stop offset="8%" stop-color="${C.grad[0]}"/><stop offset="52%" stop-color="${C.grad[1]}"/><stop offset="96%" stop-color="${C.grad[2]}"/></linearGradient>
<linearGradient id="gradArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${C.blue}" stop-opacity=".35"/><stop offset="100%" stop-color="${C.blue}" stop-opacity="0"/></linearGradient>
<radialGradient id="glow2a"><stop offset="0%" stop-color="${C.blue}" stop-opacity=".14"/><stop offset="100%" stop-color="${C.blue}" stop-opacity="0"/></radialGradient>
<radialGradient id="glow2b"><stop offset="0%" stop-color="${C.violet}" stop-opacity=".12"/><stop offset="100%" stop-color="${C.violet}" stop-opacity="0"/></radialGradient>
<radialGradient id="vig2" cx=".5" cy=".45" r=".75"><stop offset="62%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity=".5"/></radialGradient>
<filter id="grain2"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter>
<clipPath id="card2"><rect width="${W}" height="${H}" rx="26"/></clipPath>
</defs>
<g clip-path="url(#card2)">
<rect width="${W}" height="${H}" fill="${C.bg}"/>
<ellipse cx="160" cy="100" rx="320" ry="220" fill="url(#glow2a)"/>
<ellipse cx="900" cy="500" rx="340" ry="240" fill="url(#glow2b)"/>
<rect width="${W}" height="${H}" fill="url(#vig2)"/>
<rect width="${W}" height="${H}" filter="url(#grain2)" opacity="0.05"/>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="26" fill="none" stroke="rgba(233,235,243,.08)"/>
<text x="48" y="56" font-family="${MONO}" font-size="11" letter-spacing="2.2" fill="${C.ink2}">GITHUB · @${d.login.toUpperCase()} — 年度统计</text>
<text x="1002" y="56" font-family="${MONO}" font-size="10.5" letter-spacing="1.2" fill="${C.ink3}" text-anchor="end">SELF-HOSTED · NO THIRD-PARTY</text>
<line x1="48" y1="74" x2="1002" y2="74" stroke="${C.lineSoft}"/>
<text x="48" y="104" font-family="${MONO}" font-size="10.5" letter-spacing="1.8" fill="${C.ink2}">近一年贡献曲线 · CONTRIBUTIONS 1Y</text>
${chart}
${bars}
${chips}
<text x="48" y="622" font-family="${MONO}" font-size="9.5" letter-spacing="1.5" fill="${C.ink3}">ANNUAL OVERVIEW</text>
<text x="1002" y="622" font-family="${MONO}" font-size="9.5" letter-spacing="1.5" fill="${C.ink3}" text-anchor="end">GENERATED DAILY BY GITHUB ACTIONS</text>
</g>
</svg>
`;
}

/* SVG 里语言条颜色：优先用主图表已取到的语言色，否则给默认灰蓝 */
const LANG_FALLBACK = { JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572A5', 'C++': '#f34b7d', C: '#555555', HTML: '#e34c26', CSS: '#563d7c', Java: '#b07219', Shell: '#89e051', Verilog: '#b2b7f8', MATLAB: '#e16737', other: '#6f7688' };
const langColorOf = (name, d) => d.langs.find(l => l.name === name)?.color || LANG_FALLBACK[name] || '#6f7688';

/* ---------------- main ---------------- */

const data = DEMO ? demoData() : await fetchRealData();
writeFileSync(SVG_OUT, makeSvg(data));
writeFileSync('github-stats.svg', makeStatsSvg(data, calcStats(data.days, data.langBytes)));
console.log(`✓ 已生成 ${SVG_OUT} + github-stats.svg（contributions=${data.totalContributions}, commits=${data.commits}, stars=${data.stars}, repos=${data.repos}）`);
if (!DEMO) await updateReadme(data);
