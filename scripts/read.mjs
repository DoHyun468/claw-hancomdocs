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
  const make = (anchor, unique) => ({
    found: true, anchor, unique, anchorCount: countAll(anchor), matchCount: occ.length,
    nth: idx + 1, kind: t.kind, address: t.address,
    before: t.before.slice(-20), match: t.match, after: t.after.slice(0, 20),
  });
  if (countAll(t.match) <= 1) return make(t.match, true);  // 구절 자체로 유일
  let lo = mStart, hi = mEnd;
  while ((hi - lo) < maxLen && (lo > 0 || hi < full.length)) {
    if (hi < full.length) { hi++; if (countAll(full.slice(lo, hi)) <= 1) return make(full.slice(lo, hi), true); }
    if (lo > 0) { lo--; if (countAll(full.slice(lo, hi)) <= 1) return make(full.slice(lo, hi), true); }
  }
  return make(full.slice(lo, hi), false);  // 유니크화 실패(동일 텍스트 다수) — 구조주소로 구분
}

// --- CLI ---
const argv = process.argv.slice(2);
let file = null, text = null, inspect = false, locate = false, nth = 1;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--text') text = argv[++i];
  else if (a === '--inspect') inspect = true;
  else if (a === '--locate') locate = true;
  else if (a === '--nth') nth = Math.max(1, Number(argv[++i]) || 1);
  else if (a === '-h' || a === '--help') { process.stderr.write('usage: read.mjs <file.hwp|.hwpx> [--text "<phrase>"] [--locate --nth N] [--inspect]\n'); process.exit(0); }
  else if (!a.startsWith('--')) file = a;
}
if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  if (!file) { process.stderr.write('usage: read.mjs <file.hwp|.hwpx> [--text "<phrase>"] [--locate --nth N] [--inspect]\n'); process.exit(2); }
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
