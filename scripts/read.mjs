#!/usr/bin/env node
// read.mjs — claw-hancomdocs 파일 리더. .hwp/.hwpx 를 직접 파싱해 ground-truth 텍스트와
// 구절의 occurrence-맵(nth + 맥락 + 논리주소)을 만든다. 한컴독스 web 의 canvas/캡처를 우회.
//
// 읽기 통로(원본 파일은 손대지 않음, 인메모리 read-only):
//   .hwpx  → unzip → Contents/section*.xml
//   .hwp   → rhwp WASM exportHwpx() 로 같은 형식 XML 을 메모리로 추출 (파일 변환 아님)
// 두 경우 모두 같은 section XML 을 문서순으로 한 번 트리-walk 하여 텍스트 단위를 만든다:
//   본문 단락 → { kind:'body', section, para }
//   표 셀     → { kind:'cell', section, tableIdx, row, col }   (<hp:cellAddr> 의 rowAddr/colAddr)
// 평평하게 펴지 않고 <hp:tbl>/<hp:tc> 구조를 살려 → 단일 선형 스트림(nth) + 셀별 구조 맥락 + 이중카운트 0.
//
// ⚠️ 로컬 파일 필요(클라우드 문서만이면 다운로드 먼저). 주는 위치는 '논리주소+nth'지 화면 픽셀 아님.
//    occurrence 순서 ↔ 한컴독스 web find nth 순서는 한 케이스 대조 후 --nth 에 연결할 것(가정 금지).

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { unzipSync, strFromU8 } from './vendor/fflate/index.mjs';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

function decodeXmlEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function sectionIndex(name) { const m = name.match(/section(\d+)\.xml/); return m ? parseInt(m[1], 10) : 0; }
function sectionXmls(zipBytes) {
  const files = unzipSync(zipBytes);
  return Object.entries(files)
    .filter(([n]) => /^Contents\/section\d+\.xml$/.test(n))
    .sort(([a], [b]) => sectionIndex(a) - sectionIndex(b))
    .map(([, b]) => strFromU8(b));
}

async function loadRhwpDoc(bytes) {
  const wasmBytes = fs.readFileSync(path.join(__dirname, 'vendor', 'rhwp', 'rhwp_bg.wasm'));
  const rhwp = await import('./vendor/rhwp/rhwp.js');
  await rhwp.default({ module_or_path: wasmBytes });
  // rhwp layout pass 가 measureTextWidth 호출 — 텍스트 read 엔 싼 stub 로 충분.
  if (typeof globalThis.measureTextWidth !== 'function') {
    globalThis.measureTextWidth = (font, text) => text.length * (parseFloat(font) || 10) * 0.55;
  }
  return new rhwp.HwpDocument(new Uint8Array(bytes));
}

// section XML 을 문서순으로 트리-walk. 각 텍스트 단위(<hp:p>)에 컨테이너(본문/표셀) 태그를 단다.
// 핵심 구조: <hp:tbl> > <hp:tr> > <hp:tc> > <hp:subList> > <hp:p> > <hp:run> > <hp:t>text</hp:t>
//            <hp:tc> 의 행/열은 단락 뒤에 오는 <hp:cellAddr rowAddr colAddr/> 에 있음(지연 해석).
//            본문 단락도 run 안에 <hp:tbl> 을 품을 수 있어 텍스트는 '가장 안쪽' 단락 소유 → 단락 스택.
// tableCtx: { nextTableIdx } 를 넘겨 tableIdx 를 문서(섹션 간) 전역으로 증가.
function walkSectionUnits(xml, section, tableCtx) {
  const units = [];
  const paraStack = [];   // [{ container, text, _cell }]  text 는 가장 안쪽 단락에 누적
  const cellStack = [];   // [{ tableIdx, row, col }]  cellAddr 는 단락 뒤 → 객체 참조로 지연 채움
  const tableStack = [];  // [tableIdx]  중첩 표
  let inT = false;        // <hp:t> 안인지
  let bodyParaCount = 0;  // 섹션 내 최상위 본문 단락 인덱스
  let currentBodyPara = -1;

  const tagRe = /<[^>]+>/g;
  let last = 0, m;
  while ((m = tagRe.exec(xml))) {
    if (inT && paraStack.length) {
      const chunk = xml.slice(last, m.index);
      if (chunk) paraStack[paraStack.length - 1].text += decodeXmlEntities(chunk);
    }
    last = m.index + m[0].length;
    const tag = m[0];
    const isClose = tag[1] === '/';
    const isSelf = tag.endsWith('/>');
    const name = (tag.match(/^<\/?\s*([\w:]+)/) || [])[1];

    if (name === 'hp:t') {
      if (isClose) inT = false; else if (!isSelf) inT = true;
    } else if (name === 'hp:tbl') {
      if (isClose) tableStack.pop(); else if (!isSelf) tableStack.push(tableCtx.nextTableIdx++);
    } else if (name === 'hp:tc') {
      if (isClose) cellStack.pop();
      else if (!isSelf) cellStack.push({ tableIdx: tableStack[tableStack.length - 1] ?? -1, row: null, col: null });
    } else if (name === 'hp:cellAddr') {
      const cell = cellStack[cellStack.length - 1];
      if (cell) {
        const r = tag.match(/rowAddr="(\d+)"/); const c = tag.match(/colAddr="(\d+)"/);
        if (r) cell.row = parseInt(r[1], 10);
        if (c) cell.col = parseInt(c[1], 10);
      }
    } else if (name === 'hp:p') {
      if (isClose) {
        const p = paraStack.pop();
        if (p && p.text.trim()) units.push(p);
      } else if (!isSelf) {
        const cell = cellStack[cellStack.length - 1];
        if (cell) {
          paraStack.push({ container: { kind: 'cell' }, text: '', _cell: cell });
        } else if (paraStack.length === 0) {
          currentBodyPara = bodyParaCount++;
          paraStack.push({ container: { kind: 'body', section, para: currentBodyPara }, text: '' });
        } else {
          // 본문 단락 안의 비-표 컨트롤(글상자 등) 단락 — 최상위 본문 인덱스를 물려받음
          paraStack.push({ container: { kind: 'body', section, para: currentBodyPara, nested: true }, text: '' });
        }
      }
    }
  }
  // 셀 단락의 주소를 지연 해석(cellAddr 는 단락 뒤에 옴 → 참조 객체에 이제 row/col 채워져 있음)
  return units.map((u) => {
    if (u._cell) {
      return { kind: 'cell', address: { kind: 'cell', section, tableIdx: u._cell.tableIdx, row: u._cell.row, col: u._cell.col }, text: u.text };
    }
    return { kind: 'body', address: u.container, text: u.text };
  });
}

// 파일 → 문서순 텍스트 단위 [{ kind:'body'|'cell', address, text }]
export async function getUnits(file) {
  const bytes = fs.readFileSync(file);
  const isHwpx = bytes[0] === 0x50 && bytes[1] === 0x4b; // 'PK'
  const tableCtx = { nextTableIdx: 0 };
  if (isHwpx) {
    return sectionXmls(bytes).flatMap((xml, si) => walkSectionUnits(xml, si, tableCtx));
  }
  // .hwp: exportHwpx() 가 표를 보존한 채 같은 형식 XML 을 줌(인메모리, 원본 미변경).
  const doc = await loadRhwpDoc(bytes);
  try {
    return sectionXmls(doc.exportHwpx()).flatMap((xml, si) => walkSectionUnits(xml, si, tableCtx));
  } finally { if (typeof doc.free === 'function') doc.free(); }
}

// 문서 내 비텍스트 객체(그림/차트/도형)를 문서순으로 열거 + 각 객체의 앞/뒤 인접 텍스트(랜드마크).
// 본문이 canvas 라 UI 로는 객체를 못 짚으므로, XML 로 "N번째 그림"의 위치를 옆 텍스트로 잡아 캡처한다.
// 차트는 <hp:chart>(있으면) 우선, 그 chart 를 감싼 <hp:pic>/<hp:gso>는 중복 제외(같은 위치면 차트로).
export async function getObjects(file) {
  const bytes = fs.readFileSync(file);
  const isHwpx = bytes[0] === 0x50 && bytes[1] === 0x4b; // 'PK'
  let xmls;
  if (isHwpx) xmls = sectionXmls(bytes);
  else { const doc = await loadRhwpDoc(bytes); try { xmls = sectionXmls(doc.exportHwpx()); } finally { if (typeof doc.free === 'function') doc.free(); } }
  // 태그 → 타입. 그림/차트/수식/도형/OLE. (chart·equation 을 image 보다 먼저 판정하려고 분리 처리)
  // ⚠️ 차트=<hp:chart>, 수식=<hp:equation> 로 별도 저장됨 — 이미지(<hp:pic>)로 세지 않는다.
  const PIC = '<hp:pic', CHART = '<hp:chart', EQUATION = '<hp:equation';
  const SHAPES = ['<hp:container', '<hp:rect', '<hp:ellipse', '<hp:line', '<hp:polygon', '<hp:curve', '<hp:arc', '<hp:ole'];
  const all = [];
  xmls.forEach((xml, si) => {
    const texts = [...xml.matchAll(/<hp:t\b[^>]*>([^<]*)<\/hp:t>/g)].map((m) => ({ pos: m.index, end: m.index + m[0].length, text: decodeXmlEntities(m[1]) }));
    const nearText = (p) => {
      let before = '', after = '';
      for (let i = texts.length - 1; i >= 0; i--) { if (texts[i].end <= p && texts[i].text.trim()) { before = texts[i].text.trim(); break; } }
      for (let i = 0; i < texts.length; i++) { if (texts[i].pos >= p && texts[i].text.trim()) { after = texts[i].text.trim(); break; } }
      return { before, after };
    };
    const pushAll = (tag, type) => { let f = 0, p; while ((p = xml.indexOf(tag, f)) !== -1) { f = p + tag.length; all.push({ section: si, pos: p, type, ...nearText(p) }); } };
    pushAll(CHART, 'chart');
    pushAll(EQUATION, 'equation');
    pushAll(PIC, 'image');
    for (const s of SHAPES) pushAll(s, 'shape');
  });
  // 차트를 감싼 pic(거의 같은 위치)을 image 중복으로 빼기: 같은 섹션에서 chart 와 pos 가 매우 가까운 image 제거.
  const charts = all.filter((o) => o.type === 'chart');
  const filtered = all.filter((o) => !(o.type === 'image' && charts.some((c) => c.section === o.section && Math.abs(c.pos - o.pos) < 400)));
  filtered.sort((a, b) => a.section - b.section || a.pos - b.pos);
  return filtered.map((o, i) => ({ nth: i + 1, type: o.type, section: o.section, beforeText: o.before, afterText: o.after }));
}

// 책갈피(bookmark) 열거 — 본문에 안 보이는 이름표. .hwp/.hwpx 모두 섹션 XML 의 <hp:bookmark name="..."> 스캔.
export async function getBookmarks(file) {
  const bytes = fs.readFileSync(file);
  const isHwpx = bytes[0] === 0x50 && bytes[1] === 0x4b;
  let xmls;
  if (isHwpx) xmls = sectionXmls(bytes);
  else { const doc = await loadRhwpDoc(bytes); try { xmls = sectionXmls(doc.exportHwpx()); } finally { if (typeof doc.free === 'function') doc.free(); } }
  const names = [];
  xmls.forEach((xml, si) => { for (const m of xml.matchAll(/<hp:bookmark\b[^>]*\bname="([^"]*)"/g)) names.push({ section: si, name: decodeXmlEntities(m[1]) }); });
  return names;
}

// 구절의 occurrence-맵. 각 단위 텍스트에서 모든 매치를 찾아 nth+맥락+주소로(문서 스트림 순서).
export function occurrenceMap(units, phrase, ctx = 24) {
  const occ = [];
  for (const u of units) {
    let from = 0, idx;
    while ((idx = u.text.indexOf(phrase, from)) !== -1) {
      occ.push({
        nth: occ.length + 1,
        kind: u.kind,
        address: u.address,
        before: u.text.slice(Math.max(0, idx - ctx), idx),
        match: phrase,
        after: u.text.slice(idx + phrase.length, idx + phrase.length + ctx),
      });
      from = idx + phrase.length;
    }
  }
  return occ;
}

// 대상 occurrence(문서순 nth)를 'UI find 한 번에 착지'시키는 최단 유니크 앵커 문자열을 만든다.
// match 만으로 문서에서 유일하면 그걸, 아니면 뒤→앞으로 맥락을 한 칸씩 넓혀 문서 전체에서 1번만 나오는
// 부분문자열을 찾는다(그 칸/단락 텍스트 범위 안). 못 만들면(완전 동일 텍스트 반복) unique:false +
// 구조주소로 사용자/호출부가 판단. UI find 의 nth 순서는 회전될 수 있어 신뢰 못 하므로, 가능한 한
// '유니크 앵커 → nth=1' 로 착지하는 게 안전(=캡처/편집 타겟팅의 토대).
export function deriveAnchor(units, phrase, nth = 1, maxLen = 60) {
  const occ = occurrenceMap(units, phrase, 100);
  if (!occ.length) return { found: false, matchCount: 0 };
  const idx = Math.min(Math.max(1, nth), occ.length) - 1;
  const t = occ[idx];
  const full = t.before + t.match + t.after;       // 대상 칸/단락의 (잘린) 텍스트 창
  const mStart = t.before.length, mEnd = mStart + t.match.length;
  const countAll = (s) => units.reduce((n, u) => {
    let i = 0, c = 0; while ((i = u.text.indexOf(s, i)) !== -1) { c++; i += s.length; } return n + c;
  }, 0);
  // matchOffset = 앵커 안에서 phrase(match)가 시작하는 위치 → 편집(교체) 시 앵커에서 그 부분만 바꾸려고.
  const make = (anchor, unique, matchOffset) => ({
    found: true, anchor, unique, matchOffset, anchorCount: countAll(anchor), matchCount: occ.length,
    nth: idx + 1, kind: t.kind, address: t.address,
    before: t.before.slice(-20), match: t.match, after: t.after.slice(0, 20),
  });
  if (countAll(t.match) <= 1) return make(t.match, true, 0);  // 구절 자체로 유일(앵커=match)
  let lo = mStart, hi = mEnd;
  while ((hi - lo) < maxLen && (lo > 0 || hi < full.length)) {
    if (hi < full.length) { hi++; if (countAll(full.slice(lo, hi)) <= 1) return make(full.slice(lo, hi), true, mStart - lo); }
    if (lo > 0) { lo--; if (countAll(full.slice(lo, hi)) <= 1) return make(full.slice(lo, hi), true, mStart - lo); }
  }
  return make(full.slice(lo, hi), false, mStart - lo);  // 유니크화 실패(동일 텍스트 다수) — 구조주소로 구분
}

// 표별 colCnt(열 수) — 문서순 tableIdx 인덱스. <hp:tbl ... colCnt="N">. Tab 네비(빈 셀 도달) 계산용.
async function getTableColCounts(file) {
  const bytes = fs.readFileSync(file);
  const isHwpx = bytes[0] === 0x50 && bytes[1] === 0x4b;
  let xmls;
  if (isHwpx) xmls = sectionXmls(bytes);
  else { const doc = await loadRhwpDoc(bytes); try { xmls = sectionXmls(doc.exportHwpx()); } finally { if (typeof doc.free === 'function') doc.free(); } }
  return xmls.flatMap((xml) => [...xml.matchAll(/<hp:tbl\b[^>]*\bcolCnt="(\d+)"/g)].map((m) => Number(m[1])));
}

// 빈 셀 포함 임의 셀(table, row, col)로 가는 Tab 네비 정보. 텍스트 있는 '첫 셀(앵커)'에서 행우선 Tab 횟수
// 계산(빈 셀은 텍스트로 못 찾으니 앵커+Tab 으로 도달). 반환 tabSteps 음수면 Shift+Tab. ⚠️ 병합 셀 없는
// 단순 격자 가정(colCnt 기반 산술) — 병합 표는 어긋날 수 있음.
export async function cellNav(file, tableIdx, targetRow, targetCol) {
  const units = await getUnits(file);
  const cells = units.filter((u) => u.kind === 'cell' && u.address.tableIdx === tableIdx);
  if (!cells.length) return { found: false, why: 'no_text_cell_in_table' };
  const colCounts = await getTableColCounts(file);
  const colCnt = colCounts[tableIdx];
  if (!colCnt) return { found: false, why: 'colCnt_unknown' };
  const a = cells[0]; // 문서순 첫 텍스트 셀 = 앵커
  const tabSteps = (targetRow - a.address.row) * colCnt + (targetCol - a.address.col);
  return { found: true, anchorText: a.text, anchorRow: a.address.row, anchorCol: a.address.col, colCnt, tabSteps, targetRow, targetCol, tableIdx };
}

// --- CLI ---
const argv = process.argv.slice(2);
let file = null, text = null, inspect = false, locate = false, nth = 1, objects = false, bookmarks = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--text') text = argv[++i];
  else if (a === '--inspect') inspect = true;
  else if (a === '--objects') objects = true;
  else if (a === '--bookmarks') bookmarks = true;
  else if (a === '--locate') locate = true;
  else if (a === '--nth') nth = Math.max(1, Number(argv[++i]) || 1);
  else if (a === '-h' || a === '--help') { process.stderr.write('usage: read.mjs <file.hwp|.hwpx> [--text "<phrase>"] [--locate --nth N] [--inspect] [--objects] [--bookmarks]\n'); process.exit(0); }
  else if (!a.startsWith('--')) file = a;
}
if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  if (!file) { process.stderr.write('usage: read.mjs <file.hwp|.hwpx> [--text "<phrase>"] [--locate --nth N] [--inspect] [--objects] [--bookmarks]\n'); process.exit(2); }
  if (objects) {
    const objs = await getObjects(file);
    process.stdout.write(JSON.stringify({ cmd: 'objects', file: path.basename(file), count: objs.length, objects: objs }, null, 2) + '\n');
    process.exit(0);
  }
  if (bookmarks) {
    const bm = await getBookmarks(file);
    process.stdout.write(JSON.stringify({ cmd: 'bookmarks', file: path.basename(file), count: bm.length, bookmarks: bm }, null, 2) + '\n');
    process.exit(0);
  }
  const units = await getUnits(file);
  if (locate && text) {
    const loc = deriveAnchor(units, text, nth);
    process.stdout.write(JSON.stringify({ cmd: 'locate', file: path.basename(file), phrase: text, ...loc }, null, 2) + '\n');
  } else if (text) {
    const occ = occurrenceMap(units, text);
    process.stdout.write(JSON.stringify({ cmd: 'read', file: path.basename(file), phrase: text, matchCount: occ.length, occurrences: occ }, null, 2) + '\n');
  } else if (inspect) {
    const kinds = units.reduce((a, u) => { a[u.kind] = (a[u.kind] || 0) + 1; return a; }, {});
    const tables = new Set(units.filter((u) => u.kind === 'cell').map((u) => u.address.tableIdx));
    process.stdout.write(JSON.stringify({ cmd: 'read', file: path.basename(file), unitCount: units.length, kinds, tableCount: tables.size }, null, 2) + '\n');
  } else {
    process.stdout.write(units.map((u) => u.text).join('\n') + '\n');
  }
}
