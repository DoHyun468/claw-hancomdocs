// 한컴독스 webhwp 도움말(RoboHelp 12) 전체 미러 + 목차 INDEX.md 생성
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

const BASE = 'https://webhwp.hancomdocs.com/cloud-hwp/help/Hwp/ko_kr';
const OUT = '/Users/reconlabs/Documents/sideproj/sideproj/claw-hancomdocs/ui-map/help';

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return await r.text();
}

// toc.js → gXMLBuffer 안 XML 파싱 (book: name/url/src, item: name/url)
function parseToc(jsText) {
  const m = jsText.match(/gXMLBuffer\s*=\s*"([\s\S]*)";/);
  if (!m) return [];
  const xml = m[1].replace(/\\"/g, '"');
  const nodes = [];
  const re = /<(book|item)\s+([^>]*?)\/?>(?:<\/\1>)?/g;
  let mm;
  while ((mm = re.exec(xml))) {
    const attrs = {};
    for (const a of mm[2].matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    nodes.push({ kind: mm[1], name: attrs.name, url: attrs.url, src: attrs.src });
  }
  return nodes;
}

async function buildTree(tocFile, depth = 0) {
  const nodes = parseToc(await fetchText(`${BASE}/whxdata/${tocFile}`));
  const out = [];
  for (const n of nodes) {
    const entry = { name: n.name, url: n.url, depth, children: [] };
    if (n.kind === 'book' && n.src) entry.children = await buildTree(n.src, depth + 1);
    out.push(entry);
  }
  return out;
}

function flatten(tree, acc = []) {
  for (const n of tree) { acc.push(n); flatten(n.children, acc); }
  return acc;
}

const tree = await buildTree('toc.js');
const flat = flatten(tree);
const urls = [...new Set(flat.map(n => n.url && n.url.split('#')[0]).filter(Boolean))];
console.log(`TOC entries: ${flat.length}, unique pages: ${urls.length}`);

let ok = 0, fail = [];
for (const u of urls) {
  try {
    const html = await fetchText(`${BASE}/${u}`);
    const p = join(OUT, u);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, html);
    ok++;
    if (ok % 20 === 0) console.log(`${ok}/${urls.length}`);
  } catch (e) { fail.push(`${u}: ${e.message}`); }
}

// INDEX.md — 목차 트리 그대로
let md = `# 한컴독스 webhwp 공식 도움말 미러 — 목차\n\n`;
md += `> 출처: ${BASE}/index.htm (Adobe RoboHelp 12, whxdata/toc.js 트리 크롤)\n`;
md += `> 미러일: 2026-06-11 · 페이지 ${ok}/${urls.length}개 · 재생성: \`node /tmp/fetch_help.mjs\`\n\n`;
for (const n of flat) {
  const indent = '  '.repeat(n.depth);
  md += n.url ? `${indent}- [${n.name}](${n.url.split('#')[0]})\n` : `${indent}- ${n.name}\n`;
}
if (fail.length) md += `\n## 실패\n${fail.map(f => `- ${f}`).join('\n')}\n`;
writeFileSync(join(OUT, 'INDEX.md'), md);
console.log(`DONE ok=${ok} fail=${fail.length}`);
if (fail.length) console.log(fail.join('\n'));
