// 한컴독스 캡처 도구 — 에이전트 주문용 CLI.
//   node hancom.js capture --file <경로> [--page N] [--grid] [--scale N] [--out <png>]
//   node hancom.js zoom    --name <문서이름> --clip "x,y,w,h" [--page N] [--scale N] [--out <png>]
//
// 좌표계: 캡처는 'A4 페이지 영역만' 깔끔히 잘라낸다(툴바·여백 제외).
//         clip 좌표는 그 페이지의 왼쪽 위(0,0) 기준 CSS px. --grid 가 100px 격자+라벨을 얹어줌.
// 결과 마지막 줄: RESULT_JSON=<...>
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const AUTH = path.join(DIR, 'auth.json');
const CAPDIR = path.join(DIR, 'captures');
const DLDIR = path.join(DIR, 'downloads');
const HOME = 'https://www.hancomdocs.com/ko/home';
const MYDRIVE = 'https://www.hancomdocs.com/ko/mydrive';
// 세로로 긴 뷰포트: A4 한 장이 통째로 들어가게
const VIEW = { width: 1280, height: 1500 };
const PAGE_H = 1143; // 100% 줌·A4 기준 페이지당 스크롤 높이(px), 문서 무관 일정
// 브라우저 표시 모드 — 기본은 headless(창 없음). --headed면 창을 띄워 동작을 눈으로 볼 수 있다(디버그용).
// (OS 분기 아님 — 런타임 옵션. headed일 때만 slowMo로 동작을 천천히 보여줌.)
let HEADED = false, SLOWMO = 0;

function parseArgs(argv) {
  const a = { _: argv[0] };
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2);
      const v = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
      a[k] = v;
    }
  }
  return a;
}
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
const log = (...x) => console.log(...x);
// RESULT_JSON은 기계 판독용 — 비ASCII를 \uXXXX로 이스케이프해 어떤 콘솔 코드페이지(Win CP949 등)서도
// 깨지지 않게 한다. 여전히 유효한 JSON이라 파싱하면 한글이 그대로 복원됨. (OS 무관)
const asciiSafe = (s) => Array.from(s).map((c) => c.charCodeAt(0) > 126 ? '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0') : c).join('');
const out = (o) => log('RESULT_JSON=' + asciiSafe(JSON.stringify(o)));

async function ensureLoggedIn(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // 리다이렉트가 마무리될 짧은 여유만 (networkidle 대신 domcontentloaded + 0.8s)
  await page.waitForTimeout(800);
  if (page.url().includes('accounts.hancom.com') || page.url().includes('/login')) {
    throw new Error('AUTH_EXPIRED — node login.js 로 재로그인 필요');
  }
}

async function setScroll(ed, top) {
  return await ed.evaluate((t) => {
    const el = document.getElementById('hcwoViewScroll');
    if (!el) return null;
    el.scrollTop = t; el.dispatchEvent(new Event('scroll', { bubbles: true }));
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientH: el.clientHeight };
  }, top);
}

// N페이지로 비례 점프 (총페이지 불필요)
async function gotoPage(ed, n, pageH = PAGE_H) {
  // page 1은 이미 맨 위 → 페이지네이션 강제(끝까지 스크롤) 생략해서 비용 절감
  if (n <= 1) { await setScroll(ed, 0); await ed.waitForTimeout(500); return { estTotal: null, pageH, scrollTop: 0 }; }
  await setScroll(ed, 9_999_999); await ed.waitForTimeout(2000);
  const s = await setScroll(ed, 9_999_999); await ed.waitForTimeout(800);
  const maxTop = s ? s.scrollHeight : n * pageH;
  const target = Math.min(Math.max(0, Math.round((n - 1) * pageH)), maxTop);
  await setScroll(ed, target); await ed.waitForTimeout(1600);
  return { estTotal: Math.max(1, Math.round(maxTop / pageH)), pageH, scrollTop: target, scrollHeight: maxTop };
}

// webhwp 상태바의 '현재 / 총' 쪽수 표시를 읽는다 → 추정(scrollHeight/PAGE_H) 대신 정확값.
// 페이지1에서도 읽히고 off-by-one이 없다. 표시가 없으면(UI 변경 등) null → 호출부가 추정으로 폴백.
async function readPageCount(ed) {
  try {
    return await ed.evaluate(() => {
      const el = document.querySelector('.status_page .section.text_wrap.fit_size')
              || document.querySelector('#status_bar .section.text_wrap.fit_size');
      const m = el && (el.textContent || '').match(/(\d{1,5})\s*\/\s*(\d{1,5})/);
      return m ? { current: Number(m[1]), total: Number(m[2]) } : null;
    });
  } catch { return null; }
}

// 캔버스 픽셀 스캔으로 흰 A4 페이지 사각형(뷰포트 CSS px) 검출
async function detectPageRect(ed) {
  await closeSidebar(ed); // 개체 사이드바가 열려 페이지가 밀렸으면 닫아 정상 위치에서 측정/캡처
  return await ed.evaluate(() => {
    const cvs = Array.from(document.querySelectorAll('canvas'));
    if (!cvs.length) return null;
    let canvas = cvs[0];
    for (const c of cvs) if (c.width * c.height > canvas.width * canvas.height) canvas = c;
    const r = canvas.getBoundingClientRect();
    const W = canvas.width, H = canvas.height;
    const sx = W / r.width, sy = H / r.height;
    const img = canvas.getContext('2d').getImageData(0, 0, W, H).data;
    const white = (px, py) => { const i = (py * W + px) * 4; return img[i] > 245 && img[i + 1] > 245 && img[i + 2] > 245; };
    const lefts = [], rights = [];
    for (let ratio = 0.2; ratio <= 0.8; ratio += 0.1) {
      const py = Math.floor(H * ratio); let l = -1, rt = -1;
      for (let px = 0; px < W; px++) if (white(px, py)) { l = px; break; }
      for (let px = W - 1; px >= 0; px--) if (white(px, py)) { rt = px; break; }
      if (l >= 0 && rt > l) { lefts.push(l); rights.push(rt); }
    }
    if (!lefts.length) return null;
    const med = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const pl = med(lefts), pr = med(rights);
    const colX = Math.min(W - 1, pl + Math.floor((pr - pl) * 0.04) + 3);
    let top = -1, bot = -1, runStart = -1, bestLen = 0;
    for (let py = 0; py < H; py++) {
      if (white(colX, py)) { if (runStart < 0) runStart = py; }
      else if (runStart >= 0) { const len = py - runStart; if (len > bestLen) { bestLen = len; top = runStart; bot = py - 1; } runStart = -1; }
    }
    if (runStart >= 0 && H - runStart > bestLen) { top = runStart; bot = H - 1; }
    return {
      x: Math.round(r.left + pl / sx), y: Math.round(r.top + top / sy),
      width: Math.round((pr - pl) / sx), height: Math.round((bot - top) / sy),
    };
  });
}

// 페이지 영역에 100px 격자+라벨(페이지 로컬 좌표) 오버레이
async function injectGrid(ed, rect) {
  await ed.evaluate((R) => {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    Object.assign(svg.style, { position: 'fixed', left: 0, top: 0, width: '100vw', height: '100vh', zIndex: 2147483647, pointerEvents: 'none' });
    svg.setAttribute('width', window.innerWidth); svg.setAttribute('height', window.innerHeight);
    const mk = (t, a) => { const e = document.createElementNS(ns, t); for (const k in a) e.setAttribute(k, a[k]); return e; };
    for (let lx = 0; lx <= R.width; lx += 100) {
      const x = R.x + lx;
      svg.appendChild(mk('line', { x1: x, y1: R.y, x2: x, y2: R.y + R.height, stroke: 'rgba(255,0,0,0.5)', 'stroke-width': lx % 500 === 0 ? 1.5 : 0.6 }));
      const t = mk('text', { x: x + 2, y: R.y + 14, fill: 'red', 'font-size': 12, 'font-family': 'monospace' }); t.textContent = lx; svg.appendChild(t);
    }
    for (let ly = 0; ly <= R.height; ly += 100) {
      const y = R.y + ly;
      svg.appendChild(mk('line', { x1: R.x, y1: y, x2: R.x + R.width, y2: y, stroke: 'rgba(0,90,255,0.5)', 'stroke-width': ly % 500 === 0 ? 1.5 : 0.6 }));
      const t = mk('text', { x: R.x + 2, y: y - 2, fill: 'blue', 'font-size': 12, 'font-family': 'monospace' }); t.textContent = ly; svg.appendChild(t);
    }
    svg.appendChild(mk('rect', { x: R.x, y: R.y, width: R.width, height: R.height, fill: 'none', stroke: 'rgba(0,160,0,0.7)', 'stroke-width': 1.5 }));
    document.body.appendChild(svg);
  }, rect);
}

// webhwp 에디터에서 "문서를 열 수 없습니다" 오류 다이얼로그 감지 (hwp/hwpx 무관 동일)
async function detectOpenError(editor) {
  try {
    return await editor.evaluate(() => {
      const t = (document.body && document.body.innerText) || '';
      return /문서를\s*열\s*수\s*없습니다|파일을\s*여는\s*동안\s*오류/.test(t);
    });
  } catch { return false; }
}

class CannotOpenError extends Error { constructor(name) { super('CANNOT_OPEN'); this.docName = name; } }
// 요청한 파일이 아닌 다른 문서가 열렸을 때(동시 업로드 race·동명 파일 등). 엉뚱한 문서를 캡처/검증하는 사고 차단.
class WrongDocError extends Error { constructor(name, title, docId) { super('WRONG_DOC'); this.docName = name; this.openedTitle = title; this.docId = docId; } }

// 협업/오버레이 흔적 숨기기 (캡처 혼동 방지).
//   DOM 흔적: 협업 커서 이름표·협업자 패널·채팅 위젯 → CSS로 가림.
//   캔버스 흔적: webhwp 는 캔버스를 2층으로 쌓는다 — '문서' 캔버스(흰 배경=불투명 픽셀 다수)와
//     '오버레이' 캔버스(거의 투명; 진입 presence '파란 물방울'·캐럿·원격커서가 여기 그려짐).
//     오버레이 캔버스만 visibility:hidden 하면 본문은 그대로 두고 물방울/커서를 즉시 제거(대기 0초).
//     (과거엔 '캔버스라 못 가림 → 단일 세션 보장만이 해결'로 오진했으나, 층을 나눠 가리면 됨.)
async function hideOverlays(ed) {
  await ed.addStyleTag({ content: `
    .user_cursor_container, .collaborationusers, .user_list, .collabo_user_list,
    .aori_widget, .aori_temp_widget, .aori_main_btn, .aori_main_area
    { display: none !important; visibility: hidden !important; }
  ` }).catch(() => {});
  await hideOverlayCanvases(ed);
}

// 오버레이 캔버스(거의 투명) 숨김. 문서/타일 캔버스(불투명 픽셀 다수)는 보존.
// 불투명 픽셀이 가장 많은 캔버스의 5% 미만인 캔버스만 오버레이로 보고 숨긴다(문서 타일 보호).
async function hideOverlayCanvases(ed) {
  await ed.evaluate(() => {
    const cvs = [...document.querySelectorAll('canvas')];
    if (cvs.length < 2) return; // 캔버스 1장이면 가릴 오버레이 없음
    const stats = cvs.map((c) => {
      let opaque = -1; // -1 = tainted/판독불가 → 건드리지 않음
      try {
        const d = c.getContext('2d').getImageData(0, 0, c.width, Math.min(c.height, 1200)).data;
        opaque = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 10) opaque++;
      } catch { opaque = -1; }
      return { c, opaque };
    });
    const maxOpaque = Math.max(...stats.map((s) => s.opaque));
    if (maxOpaque <= 0) return;
    for (const s of stats) {
      if (s.opaque >= 0 && s.opaque < maxOpaque * 0.05) {
        s.c.style.setProperty('visibility', 'hidden', 'important');
      }
    }
  }).catch(() => {});
}

async function openDoc(ctx, page, name) {
  // 파일명을 NFC로 정규화 — NFD(분해형 자모) 파일명(Mac 생성/다운로드 흔함)은 한컴독스가
  // NFC로 표시해 getByText 매칭이 깨진다. NFC면 양쪽이 일치(OS 분기 아님, 유니코드 정규화).
  name = String(name).normalize('NFC');
  await ensureLoggedIn(page, MYDRIVE);
  const row = page.getByText(name, { exact: false }).first();
  // 고정 대기 대신 행이 뜰 때까지만 (없으면 null → 업로드 경로)
  try { await row.waitFor({ timeout: 6000 }); } catch { return null; }
  // 드라이브는 '한 번 클릭 = 열기'. dblclick 은 열기를 2번 트리거해 편집기 탭이 2개 뜨고
  // 둘째(방치) 탭이 같은 계정 협업자로 잡힐 수 있어 단일 click 으로 연다(중복 세션 예방).
  const [editor] = await Promise.all([
    ctx.waitForEvent('page', { timeout: 12000 }),
    row.click(),
  ]);
  await editor.waitForLoadState('networkidle').catch(() => {});
  // 고정 대기 대신 "준비되면 진행"(내용 렌더 or 에러 다이얼로그 즉시 감지) — 매 호출 ~5초 절약
  const st = await waitForReady(editor);
  if (st === 'error') throw new CannotOpenError(name);
  // 엉뚱한 문서 차단: 편집기는 docId 로 신원이 정해진다.
  //   URL  = https://webhwp.hancomdocs.com/webhwp/?mode=HWP_EDITOR&docId=<id>&lang=ko_KR
  //   제목 = "<파일명> - 한컴오피스 Web v2 한글"
  // 이름으로 행을 클릭해 열기 때문에, 다중 세션 파이프라인에서 동시 업로드가 끝나며 다른 행이
  // 열리는 race / 동명 파일 등으로 "요청한 그 파일이 아닌" 문서가 열릴 수 있다. docId 를 1차 신원으로
  // 붙여두고(__docId), 제목으로 교차 확인해 불일치면 즉시 중단한다(잘못된 문서를 캡처/검증하는 사고 차단).
  // 제목은 캔버스 렌더 직후에도 잠깐 "불러오는 중..." placeholder 라 너무 일찍 읽으면 오탐(WRONG_DOC).
  // 제목이 안정될 때까지(placeholder 탈출 or stem 포함) 잠깐 폴링한 뒤 교차 확인. 끝까지 placeholder 면
  // docId 를 1차 신원으로 신뢰하고 진행(제목만 보고 오중단 금지).
  const stem = name.replace(/\.[^.]+$/, '');
  const isPlaceholder = (t) => !t || /^불러오는\s*중/.test(t) || /^불러오는/.test(t);
  let url = '', title = '';
  for (let i = 0; i < 16; i++) {
    const ident = await editor.evaluate(() => ({ url: location.href, title: document.title || '' })).catch(() => ({ url: '', title: '' }));
    url = ident.url; title = String(ident.title).normalize('NFC');
    if (!isPlaceholder(title) || (stem && title.includes(stem))) break;
    await editor.waitForTimeout(300);
  }
  const docId = (String(url).match(/[?&]docId=([^&#]+)/) || [])[1] || null;
  if (title && !isPlaceholder(title) && stem && !title.includes(stem)) throw new WrongDocError(name, title, docId);
  editor.__docId = docId; // 호출부가 결과(out)에 실어 보내 검증·로깅에 쓴다
  // 진입 presence(파란 물방울)는 대기로 빼지 않고, 스크린샷 직전 hideOverlays 에서
  // '오버레이 캔버스 숨김'으로 즉시 제거한다(대기 0초).
  return editor; // 'timeout'이어도 진행(렌더 매우 느린 예외 케이스)
}

// 고정 대기 대신 "준비되면 진행": 캔버스 내용(어두운 픽셀) or 에러 다이얼로그 뜨면 즉시 반환.
async function waitForReady(ed, maxMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const s = await ed.evaluate(() => {
      const t = (document.body && document.body.innerText) || '';
      if (/문서를\s*열\s*수\s*없습니다|파일을\s*여는\s*동안\s*오류/.test(t)) return { error: true };
      const el = document.getElementById('hcwoViewScroll'); if (!el) return {};
      const cvs = [...document.querySelectorAll('canvas')]; if (!cvs.length) return {};
      let c = cvs[0]; for (const x of cvs) if (x.width * x.height > c.width * c.height) c = x;
      let dark = 0;
      try { const d = c.getContext('2d').getImageData(0, 0, c.width, Math.min(c.height, 600)).data; for (let k = 0; k < d.length; k += 4) if (d[k] < 200) { if (++dark > 50) break; } } catch (e) {}
      return { ready: dark > 50 };
    }).catch(() => ({}));
    if (s.error) return 'error';
    if (s.ready) { await ed.waitForTimeout(700); return 'ready'; }
    await ed.waitForTimeout(350);
  }
  return (await detectOpenError(ed)) ? 'error' : 'timeout';
}

async function uploadFile(page, filePath) {
  await ensureLoggedIn(page, HOME);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 10000 }),
    page.getByText('문서 업로드').first().click(),
  ]);
  await chooser.setFiles(filePath);
  // '완료'가 뜨면 즉시 다음으로(조기 종료) — 대기는 대용량/느린 업로드를 위한 상한일 뿐이라
  // 작은 파일은 안 느려진다. 25s는 큰 파일에서 짧아 업로드 미완→열기 실패가 났어서 상한을 늘림.
  try { await page.getByText('완료', { exact: false }).first().waitFor({ timeout: 90000 }); } catch {}
  await page.waitForTimeout(2500);
}

async function withEditor(scale, fn) {
  const browser = await chromium.launch({ headless: !HEADED, slowMo: SLOWMO });
  const ctx = await browser.newContext({ storageState: AUTH, viewport: VIEW, deviceScaleFactor: scale, acceptDownloads: true });
  try { return await fn(ctx, await ctx.newPage()); }
  finally { await browser.close(); }
}

async function cmdCapture(args) {
  if (!args.file) throw new Error('--file 필요');
  const scale = Number(args.scale) || 1.5;
  const name = path.basename(args.file).normalize('NFC'); // 출력 docName도 NFC로(후속 --name 일치)
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(scale, async (ctx, page) => {
    let editor = await openDoc(ctx, page, name);
    if (!editor) {
      log('드라이브에 없음 → 업로드:', name);
      await uploadFile(page, args.file);
      editor = await openDoc(ctx, page, name);
      if (!editor) throw new Error('업로드 후에도 문서를 못 찾음: ' + name);
    } else log('이미 드라이브에 있음 → 열기:', name);

    let pageInfo = null;
    const n = args.page ? Number(args.page) : 1;
    pageInfo = await gotoPage(editor, n, Number(args['page-height']) || PAGE_H);

    const rect = await detectPageRect(editor);
    if (!rect || rect.width < 100) throw new Error('A4 페이지 영역 검출 실패');
    await hideOverlays(editor);
    if (args.grid) await injectGrid(editor, rect);

    const pTag = `p${n}_`;
    const suffix = args.grid ? 'grid' : 'full';
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_${pTag}${suffix}_${stamp()}.png`);
    await editor.screenshot({ path: shot, clip: rect });
    // 총 쪽수는 상태바 표시(정확) 우선, 없으면 스크롤 추정 폴백.
    // (상태바의 '현재 쪽'은 캐럿 기준이라 — 스크롤만 하면 page1 고정 — 캡처한 쪽과 무관해서 노출하지 않음.
    //  페이지 점프는 페이지 높이 균일(A4 100%) 가정. 비표준 문서는 --page-height로 보정.)
    const pc = await readPageCount(editor);
    out({ cmd: 'capture', shot, docName: name, docId: editor.__docId || null, page: n,
          totalPages: pc ? pc.total : null,
          estTotalPages: pc ? pc.total : pageInfo.estTotal,
          pageWidth: rect.width, pageHeight: rect.height, scale, grid: !!args.grid });
  });
}

async function cmdZoom(args) {
  if (!args.name || !args.clip) throw new Error('--name 과 --clip 필요');
  const [lx, ly, w, h] = String(args.clip).split(',').map(Number);
  if ([lx, ly, w, h].some(Number.isNaN)) throw new Error('--clip 형식: "x,y,w,h" (페이지 왼쪽위=0,0 기준)');
  const scale = Number(args.scale) || 3;
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(scale, async (ctx, page) => {
    const editor = await openDoc(ctx, page, args.name);
    if (!editor) throw new Error('문서를 못 찾음: ' + args.name);
    const n = args.page ? Number(args.page) : 1;
    await gotoPage(editor, n, Number(args['page-height']) || PAGE_H);
    const rect = await detectPageRect(editor);
    if (!rect || rect.width < 100) throw new Error('A4 페이지 영역 검출 실패');
    await hideOverlays(editor);
    // 페이지 로컬 → 뷰포트 좌표(오프셋), 페이지 경계로 클램프
    const clip = {
      x: rect.x + Math.max(0, lx),
      y: rect.y + Math.max(0, ly),
      width: Math.min(w, rect.width - Math.max(0, lx)),
      height: Math.min(h, rect.height - Math.max(0, ly)),
    };
    const shot = args.out || path.join(CAPDIR, `${String(args.name).replace(/\.[^.]+$/, '')}_p${n}_zoom_${stamp()}.png`);
    await editor.screenshot({ path: shot, clip });
    out({ cmd: 'zoom', shot, docName: args.name, docId: editor.__docId || null, page: n, clipLocal: { x: lx, y: ly, width: w, height: h }, scale });
  });
}

// 찾기 다이얼로그 열기 — 툴바 '찾기' 버튼을 DOM 셀렉터(title)로, 드롭다운의 '찾기...' 항목은
// 실제 위치를 DOM에서 읽어 클릭. (기존 하드코딩 좌표 click(309,95)/(335,167)는 창크기·UI버전·
// 배율에 따라 어긋나 다이얼로그가 안 열려 실패 → 셀렉터/DOM-위치로 견고화. OS 무관.)
async function openFindDialog(ed) {
  await ed.locator('a[title="찾기"]').first().click(); // 메인 찾기 버튼(title 고정 = 좌표 무관)
  await ed.waitForTimeout(900);
  // 드롭다운에서 '보이는' 찾기... 메뉴 항목의 실제 중심좌표를 읽어 클릭(좌표 드리프트 무관).
  // 숨은 동음 항목(툴바 버튼 라벨)을 피하려 offsetParent!=null 로 가시성 필터.
  const item = await ed.evaluate(() => {
    for (const el of document.querySelectorAll('a, div, span')) {
      const t = (el.textContent || '').trim();
      if (/^찾기\.\.\./.test(t) && t.length < 16) {
        const r = el.getBoundingClientRect();
        if (r.width > 20 && r.height > 8 && el.offsetParent !== null)
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }
    }
    return null;
  });
  if (!item) throw new Error('찾기 메뉴 항목(찾기...) 탐색 실패');
  await ed.mouse.click(item.x, item.y);
  await ed.waitForTimeout(1200);
}

// 캐럿을 문서 맨 앞으로. webhwp 의 '다음 찾기'는 캐럿 뒤부터 찾고 끝에서 한 바퀴 돈다 → 시작 위치에
// 따라 nth 순서가 '회전'한다(문서 중간에서 시작하면 첫 매치가 문서 첫 매치가 아님). 항상 문서 맨 앞에서
// 시작해 nth 를 '문서순'으로 결정론적이게 만든다(파일 리더의 occurrence nth 와 정합). 스크롤도 0 으로.
async function goDocStart(ed) {
  await focusBody(ed);
  await ed.keyboard.press('ControlOrMeta+Home').catch(() => {});
  await ed.keyboard.press('Control+Home').catch(() => {}); // webhwp 가 OS 무관 Ctrl+Home 바인딩일 수 있어 양쪽
  await ed.waitForTimeout(250);
  await setScroll(ed, 0).catch(() => {});
  await ed.waitForTimeout(200);
}

// 찾기 다이얼로그를 열고 text 를 검색해 매치로 점프. 검색칸에만 입력(편집 사고 방지).
// nth: '다음 찾기'를 nth 번 눌러 N번째 매치로 이동(기본 1 = 첫 매치, 캡처와 동일). 같은 구절이
// 여러 번 나올 때 특정 occurrence 를 정확히 겨냥. 첫 매치 위치로 되돌아오면(한 바퀴) wrapped=true
// (= 매치 수 < nth). 반환: {found, page, caret, landedNth, matchCount, wrapped} | {found:false}
async function findText(ed, text, nth = 1) {
  await goDocStart(ed); // 문서순 nth 보장(캐럿 회전 제거)
  await openFindDialog(ed);
  const box = await ed.evaluate(() => {
    const ins = Array.from(document.querySelectorAll('input')).map(el => { const r = el.getBoundingClientRect(); return { el, x: r.x, y: r.y, w: r.width, h: r.height, vis: r.width > 60 && r.height > 10 && getComputedStyle(el).visibility !== 'hidden' && el.getAttribute('aria-label') !== '문서 편집 영역' }; });
    const cand = ins.filter(i => i.vis && i.y > 300).sort((a, b) => b.w - a.w)[0];
    return cand ? { x: Math.round(cand.x), y: Math.round(cand.y), w: Math.round(cand.w), h: Math.round(cand.h) } : null;
  });
  if (!box) throw new Error('검색칸 탐색 실패');
  await ed.mouse.click(box.x + Math.min(box.w / 2, 40), box.y + box.h / 2);
  await ed.keyboard.press('ControlOrMeta+A');
  await ed.keyboard.type(text, { delay: 25 });
  // 검색 방향 '문서 전체'(한 바퀴) — '아래로' 기본은 캐럿 뒤만 찾아, 문서 맨앞(표지/상단 표)의 매치를 놓친다.
  const wholeDoc = await dialogBtnXY(ed, '문서 전체');
  if (wholeDoc) { await ed.mouse.click(wholeDoc.x, wholeDoc.y); await ed.waitForTimeout(300); }
  const nextBtn = { x: box.x + box.w + 70, y: box.y - 1 }; // '다음 찾기' ≈ 검색칸 오른쪽
  const N = Math.max(1, Number(nth) || 1);
  let page = null, caret = null, firstKey = null, wrapped = false, matchCount = 0, noMatch = false;
  for (let i = 0; i < N; i++) {
    await ed.mouse.click(nextBtn.x, nextBtn.y); await ed.waitForTimeout(i === 0 ? 1600 : 850);
    // no-match: 첫 클릭에서 '찾을 수 없습니다' 류 메시지가 뜨면 매치 0. DOM 텍스트로 감지(캐럿 위치 추측보다
    // 안정 — 문서 맨앞에 있는 매치를 '안 움직였다'고 오판하던 버그 제거).
    if (i === 0 && await findEndMessage(ed)) { noMatch = true; break; }
    page = await readCurrentPage(ed);
    caret = await readCaretRect(ed);
    const key = `${page}:${caret ? caret.x : '?'}:${caret ? caret.y : '?'}`;
    if (i === 0) { firstKey = key; matchCount = 1; }
    else if (key === firstKey) { wrapped = true; break; } // 첫 매치로 복귀 = 더 새 매치 없음
    else matchCount = i + 1;
  }
  await ed.mouse.click(nextBtn.x, nextBtn.y + 53); await ed.waitForTimeout(700); // 닫기
  await ed.keyboard.press('Escape'); await ed.waitForTimeout(400); // 검색 하이라이트 제거
  if (noMatch || !page || page <= 0) return { found: false };
  return { found: true, page, caret, landedNth: wrapped ? matchCount : N, matchCount: wrapped ? matchCount : null, wrapped };
}

// 같은 구절의 모든 occurrence 를 '다음 찾기' 순회로 열거(각 매치의 페이지+캐럿). 첫 매치 위치로
// 되돌아오면(한 바퀴) 멈춤. 긴 문서에서 "어느 occurrence 인지"를 정하려면, 이 목록의 page 로
// around --nth/capture --page 해서 맥락을 '읽고'(캡처=비전) 결정한다. body 는 canvas 라 텍스트
// DOM 이 없으므로 읽기 = 캡처.
async function findOccurrences(ed, text, max = 40) {
  await goDocStart(ed); // 문서 맨 앞부터 열거 → nth 가 문서순(파일 리더 occurrence 순서와 정합)
  const p0 = await readDocPos(ed); // 검색 전 위치(원자적) — 매칭 실패 시 캐럿이 여기서 안 움직임
  await openFindDialog(ed);
  const box = await ed.evaluate(() => {
    const ins = Array.from(document.querySelectorAll('input')).map(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, vis: r.width > 60 && r.height > 10 && getComputedStyle(el).visibility !== 'hidden' && el.getAttribute('aria-label') !== '문서 편집 영역' }; });
    const cand = ins.filter(i => i.vis && i.y > 300).sort((a, b) => b.w - a.w)[0];
    return cand ? { x: Math.round(cand.x), y: Math.round(cand.y), w: Math.round(cand.w), h: Math.round(cand.h) } : null;
  });
  if (!box) throw new Error('검색칸 탐색 실패');
  await ed.mouse.click(box.x + Math.min(box.w / 2, 40), box.y + box.h / 2);
  await ed.keyboard.press('ControlOrMeta+A');
  await ed.keyboard.type(text, { delay: 25 });
  // 검색 방향을 '문서 전체'로 — 캐럿이 문서 끝쪽이면 '아래로'는 그 뒤만 찾아 앞 페이지 매치를 놓친다.
  const wholeDoc = await dialogBtnXY(ed, '문서 전체');
  if (wholeDoc) { await ed.mouse.click(wholeDoc.x, wholeDoc.y); await ed.waitForTimeout(300); }
  const nextBtn = { x: box.x + box.w + 70, y: box.y - 1 };
  // 종료 판정 = webhwp 의 '끝 메시지'(findEndMessage, DOM 텍스트). 더 찾을 게 없으면 메시지를 띄우고
  // 캐럿을 안 옮긴다 → 그 클릭은 매치가 아님 → 멈춤(팬텀 +1 없이 정확한 개수). 이미지 확인 불필요.
  // 각 매치 위치는 readDocPos 로 scrollTop+caret 을 '한 번에(원자적)' 읽어 식별 — 따로 읽으면 스크롤 도중
  // 값이 어긋나 docY 가 깨지던 버그 차단. 백업으로 docY 재방문(한 바퀴)도 종료로 본다(메시지 못 잡을 때).
  const occ = [];
  for (let i = 0; i < max; i++) {
    await ed.mouse.click(nextBtn.x, nextBtn.y); await ed.waitForTimeout(i === 0 ? 1500 : 800);
    if (await findEndMessage(ed)) break; // 끝 메시지(빨간 "모두 찾았습니다" 등) = 더 없음 → 종료(이 클릭 안 셈)
    const m = await readDocPos(ed); // 원자적 docY,cx (scrollTop+caret 같이 읽어 스크롤 도중에도 일관)
    if (!m) break; // 캐럿 못 읽음 → 종료
    if (p0 && Math.abs(m.docY - p0.docY) <= 4 && Math.abs(m.cx - p0.cx) <= 4) break; // no-match 가드(검색 전 자리서 안 움직임)
    const dup = occ.find((o) => Math.abs(o.docY - m.docY) <= 10 && Math.abs(o.cx - m.cx) <= 15);
    if (dup) break; // 같은 위치 재방문(한 바퀴) → 종료(메시지 못 잡는 변형 대비 백업)
    const page = Math.floor(m.docY / PAGE_H) + 1; // 문서 스크롤 좌표로 페이지 추정(복잡 문서선 부정확할 수 있음)
    occ.push({ nth: occ.length + 1, page, cx: m.cx, docY: m.docY });
  }
  await ed.keyboard.press('Escape').catch(() => {}); await ed.waitForTimeout(300); // 메시지/다이얼로그 닫기
  await ed.keyboard.press('Escape').catch(() => {}); await ed.waitForTimeout(200);
  return occ;
}

// UI find 매치를 '문서순(위→아래)'으로 정렬해 반환. webhwp '다음 찾기' 클릭순서는 캐럿 시작위치(특히
// 떠다니는 표지 표처럼 본문 흐름 밖 객체) 때문에 '회전'할 수 있다 — 하지만 각 매치의 실제 위치
// docY=scrollTop+caret.y 로 정렬하면 문서순이 복원된다(파일 리더의 문서순 occurrence 와 정합).
// 끝에서 첫 매치로 되돌아온 '한 바퀴' 꼬리(팬텀)는 인접 중복으로 흡수. 각 항목에 uiNth(그 매치로 가려면
// '다음 찾기'를 몇 번 눌러야 하는지)를 달아 → 호출부가 findText(phrase, uiNth) 로 정확히 착지한다.
// 즉 '문서순 N번째'(read.mjs 와 동일 순서)를 UI 네비로 잇는 다리. 빈 칸·윗첨자 등 앵커 불가 케이스 커버.
async function enumerateDocOrder(ed, phrase) {
  const occ = await findOccurrences(ed, phrase); // [{nth(=uiNth 클릭수), docY, cx, page}] (UI 클릭 순서)
  const list = occ.slice();
  // 꼬리 팬텀 제거: 마지막 항목이 '첫 매치(occ[0]) 복귀'(한 바퀴)면 같은 매치를 한 번 더 센 것 → 버림.
  // 복귀는 occ[0] 의 거의 같은 위치(docY≤30·cx≤90)로 온다(실제 마지막 매치는 문서 끝쪽이라 멀다).
  if (list.length > 1) {
    const a = list[0], z = list[list.length - 1];
    if (Math.abs(a.docY - z.docY) <= 30 && Math.abs(a.cx - z.cx) <= 90) list.pop();
  }
  const sorted = list.sort((a, b) => a.docY - b.docY || a.cx - b.cx);
  const order = [];
  for (const o of sorted) {
    // 잔여 중복만 흡수(타이트): 같은 매치 재방문은 docY 거의 0 차이. 인접 '줄'(docY 차 ~20+)은 별개 매치라
    // 합치면 안 됨 → docY≤8·cx≤60 으로만 중복 판단(과합치 방지).
    const dup = order.find((p) => Math.abs(p.docY - o.docY) <= 8 && Math.abs(p.cx - o.cx) <= 60);
    if (dup) { if (o.nth < dup.uiNth) dup.uiNth = o.nth; continue; }
    order.push({ docRank: order.length + 1, uiNth: o.nth, docY: o.docY, cx: o.cx, page: o.page });
  }
  order.forEach((p, i) => { p.docRank = i + 1; });
  return order; // [{docRank(문서순 1..), uiNth(다음찾기 클릭수), docY, cx, page}]
}

// 매치의 '절대 문서 위치' docY=scrollTop+caret.y 와 cx 를 **한 번의 evaluate(원자적)**로 읽는다.
// scrollTop 과 caret 을 따로 읽으면 부드러운 스크롤 도중 값이 어긋나 docY 가 깨지던 버그를 차단.
// docY 는 스크롤 무관(캐럿은 문서상 고정) → 스크롤 애니메이션이 끝나길 기다릴 필요 없이 캐럿만 자리잡으면 안정.
async function readDocPos(ed) {
  return await ed.evaluate(() => {
    const el = document.getElementById('hcwoViewScroll');
    const c = document.querySelector('#HWP_CURSOR_VIEW, .BLINK_CURSOR');
    const r = c ? c.getBoundingClientRect() : null;
    if (!r || (r.width === 0 && r.height === 0)) return null;
    return { docY: (el ? el.scrollTop : 0) + Math.round(r.y), cx: Math.round(r.x) };
  }).catch(() => null);
}

// 찾기 다이얼로그의 '끝' 메시지(빨간 글자)를 DOM 텍스트로 감지 — 비전/캡처 불필요. 더 찾을 게 없으면
// webhwp 가 "…모두 찾았습니다" / "찾을 수 없습니다" 를 띄우고 캐럿을 안 옮긴다 → 깔끔한 종료·개수 신호.
async function findEndMessage(ed) {
  return await ed.evaluate(() => {
    for (const el of document.querySelectorAll('div, span, p, label')) {
      const t = (el.textContent || '').trim();
      if (t && t.length < 60 && el.offsetParent !== null && el.childElementCount === 0 &&
          /모두 찾았|찾을 수 없|찾지 못|없습니다|끝까지 찾/.test(t)) return t;
    }
    return null;
  }).catch(() => null);
}

// 찾기 직후 캐럿(매치 위치) 요소의 뷰포트 사각형. webhwp 는 캐럿을 DOM 요소로 그린다.
async function readCaretRect(ed) {
  return await ed.evaluate(() => {
    const el = document.querySelector('#HWP_CURSOR_VIEW, .BLINK_CURSOR');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  }).catch(() => null);
}

// 상태바 "현재 쪽 / 전체쪽" 에서 현재 쪽(캐럿 기준) 읽기
async function readCurrentPage(ed) {
  return await ed.evaluate(() => {
    for (const e of document.querySelectorAll('*')) {
      const t = (e.textContent || '').trim();
      const m = t.match(/(\d+)\s*\/\s*[\d?]+\s*쪽/);
      if (m && t.length < 60) return Number(m[1]);
    }
    return null;
  });
}

// 매치 캐럿 줄을 가로 밴드로 잘라 고배율 캡처(찾기가 이미 매치로 스크롤한 상태에서 호출). { rect, clip }.
// 세로 경계는 '문서 캔버스'(캐럿을 항상 포함)로 클램프하고, detectPageRect 는 가로(x/width)에만 쓴다.
// 찾기가 매치를 뷰포트 하단으로 스크롤하면 뷰포트가 두 페이지에 걸쳐, detectPageRect 가 캐럿이 없는
// 옆 페이지의 흰 영역(더 큰 쪽)을 잡는다 → 그 rect 바닥이 캐럿보다 위라 height 가 음수로 붕괴(40px)하고
// 밴드가 매치 위(이전 줄/제목)로 어긋나던 버그. 캐럿은 항상 보이므로 캔버스 세로범위로 클램프하면 안전. (OS 무관)
async function zoomBandShot(ed, caret, band, outPath) {
  const rect = await detectPageRect(ed);
  if (!rect || rect.width < 100) throw new Error('A4 페이지 영역 검출 실패');
  await hideOverlays(ed);
  const view = await ed.evaluate(() => {
    const cvs = [...document.querySelectorAll('canvas')]; if (!cvs.length) return null;
    let c = cvs[0]; for (const x of cvs) if (x.width * x.height > c.width * c.height) c = x;
    const b = c.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.top + b.height) };
  });
  const vTop = view ? view.top : rect.y;
  const vBot = view ? view.bottom : rect.y + rect.height;
  const top = Math.max(vTop, caret.y - Math.round(band / 2));
  const clip = { x: rect.x, y: top, width: rect.width, height: Math.max(40, Math.min(band, vBot - top)) };
  await ed.screenshot({ path: outPath, clip });
  return { rect, clip };
}

async function cmdAround(args) {
  if (!args.name || !args.text) throw new Error('--name 과 --text 필요');
  // --zoom: 매치 줄을 확대(고배율 기본). 일반 around 는 페이지 전체(1.5).
  const scale = Number(args.scale) || (args.zoom ? 2.5 : 1.5);
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(scale, async (ctx, page) => {
    const editor = await openDoc(ctx, page, args.name);
    if (!editor) throw new Error('문서를 못 찾음: ' + args.name);
    const nth = Math.max(1, Number(args.nth) || 1); // 같은 구절이 여러 번이면 N번째 매치를 본다
    const r = await findText(editor, String(args.text), nth);
    if (!r.found) { out({ cmd: 'around', found: false, text: args.text }); return; }
    if (r.wrapped) { out({ cmd: 'around', found: false, text: args.text, status: 'nth_out_of_range', nth, matchCount: r.matchCount }); return; }

    // --zoom: 격자 읽기 없이 '텍스트 위치로 바로 확대'. 찾기가 이미 매치로 스크롤했으므로
    //   gotoPage 생략하고, 그 스크롤 상태에서 캐럿 줄을 가로 밴드로 잘라낸다.
    if (args.zoom && r.caret) {
      const band = Number(args.band) || 180;               // 매치 줄 위아래 포함 높이(페이지 px)
      const shot = args.out || path.join(CAPDIR, `${String(args.name).replace(/\.[^.]+$/, '')}_findzoom_${stamp()}.png`);
      const { rect } = await zoomBandShot(editor, r.caret, band, shot);
      out({ cmd: 'around', found: true, zoom: true, text: args.text, docId: editor.__docId || null, page: r.page, shot, pageWidth: rect.width, band, scale });
      return;
    }

    // 기본: 매치 페이지를 깔끔히 정렬 후 페이지 전체 클린 캡처
    await gotoPage(editor, r.page);
    const rect = await detectPageRect(editor);
    if (!rect || rect.width < 100) throw new Error('A4 페이지 영역 검출 실패');
    await hideOverlays(editor);
    if (args.grid) await injectGrid(editor, rect);
    const shot = args.out || path.join(CAPDIR, `${String(args.name).replace(/\.[^.]+$/, '')}_find_${stamp()}.png`);
    await editor.screenshot({ path: shot, clip: rect });
    out({ cmd: 'around', found: true, text: args.text, docId: editor.__docId || null, page: r.page, shot, pageWidth: rect.width, pageHeight: rect.height, scale, grid: !!args.grid });
  });
}

// ───────────────────────── 정밀 위치(pinpoint) ─────────────────────────
// pinpoint: 로컬 원본 파일을 'occurrence-맵'으로 읽어, 같은 구절이 여러 곳이어도 '문서순 N번째'를 정확히
// 집어 캡처. 본문이 canvas(텍스트 DOM 없음)라 캡처-비전만으론 긴/복잡 문서에서 어디가 어디인지 특정이
// 어렵던 문제를, 파일을 직접 파싱해 보완한다. 두 갈래(자동 선택):
//   ① 앵커: read.mjs 로 그 칸 맥락에서 '유니크 앵커' 문자열을 만들어 UI find 한 번에 착지(빠름, 대부분).
//   ② 문서순 nth(폴백): 앵커가 불가/안 찾힘이면, UI find 매치 전체를 열거→docY 정렬해 문서순을 복원한 뒤
//      '문서순 N번째'(read.mjs 와 동일 순서) 매치로 이동. 빈 칸·동일 칸 반복·윗첨자 등 앵커 안 되는 것까지 커버.
//   --file 로컬 .hwp/.hwpx(읽기 원본) · --text 구절 · --nth 문서순 N번째(기본1)
//   --name 드라이브 문서명(생략 시 파일명에서 유추) · --band/--scale 캡처 옵션 · --out 저장경로
// 착지에 쓴 텍스트/위치는 편집 op(insert/replace/format)에도 그대로 이어 쓸 수 있다(정밀 편집의 토대).
// pinpoint --object <image|chart|shape> [--nth N]: 글자 없는 객체는 read.mjs(XML)로 문서순 열거 → 그
// N번째 객체의 '옆 텍스트(랜드마크)'를 UI find 로 찾아 그 자리를 넓게(band) 캡처한다(객체는 canvas 라
// 직접 못 짚으므로 랜드마크 우회). 읽기 전용(편집 아님).
async function pinpointObject(args) {
  const objType = String(args.object).toLowerCase();
  if (!['image', 'chart', 'shape'].includes(objType)) throw new Error('--object 는 image | chart | shape');
  const oN = Math.max(1, Number(args.nth) || 1);
  const name = String(args.name || path.basename(args.file).replace(/\.[^.]+$/, '')).normalize('NFC');
  const reader = await import('./read.mjs');
  const allObjs = await reader.getObjects(args.file);
  const objs = allObjs.filter((o) => o.type === objType);
  const counts = allObjs.reduce((a, o) => { a[o.type] = (a[o.type] || 0) + 1; return a; }, {});
  if (!objs.length) { out({ cmd: 'pinpoint', status: 'no_object', object: objType, available: counts }); return; }
  if (oN > objs.length) { out({ cmd: 'pinpoint', status: 'object_nth_out_of_range', object: objType, objectCount: objs.length }); return; }
  const obj = objs[oN - 1];
  const landmark = obj.beforeText || obj.afterText;
  const side = obj.beforeText ? 'before' : (obj.afterText ? 'after' : null);
  if (!landmark) { out({ cmd: 'pinpoint', status: 'no_landmark', object: objType, nth: oN, objectCount: objs.length, note: '그 객체 옆에 텍스트가 없어 랜드마크로 못 잡음 — capture --grid 로 좌표 캡처 권장.' }); return; }
  const band = Number(args.band) || 400; // 객체는 넓게
  const scale = Number(args.scale) || 2.5;
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(scale, async (ctx, page) => {
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('드라이브에서 문서 못 찾음: ' + name);
    const r = await findText(editor, landmark.normalize('NFC'));
    if (!r.found || !r.caret) { out({ cmd: 'pinpoint', status: 'landmark_not_found', object: objType, nth: oN, landmark, docId: editor.__docId || null, note: '랜드마크 텍스트를 UI 에서 못 찾음 — 더 가까운/유니크한 텍스트 필요.' }); return; }
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_pinobj_${objType}${oN}_${stamp()}.png`);
    const { rect } = await zoomBandShot(editor, r.caret, band, shot);
    out({ cmd: 'pinpoint', mode: 'object', object: objType, nth: oN, objectCount: objs.length, available: counts, landmark, landmarkSide: side, page: r.page, band, pageWidth: rect.width, shot, docId: editor.__docId || null,
      note: '객체 옆 랜드마크 "' + landmark.slice(0, 20) + '" 자리를 넓게 캡처. 객체가 캡처 안에 있는지 눈으로 확인.' });
  });
}

async function cmdPinpoint(args) {
  if (!args.file) throw new Error('--file 필요 (로컬 .hwp/.hwpx — 읽기 원본)');
  // --object <image|chart|shape>: 글자 없는 객체를 옆 텍스트(랜드마크)로 찾아 넓게 캡처(read.mjs 가 본다).
  if (args.object !== undefined && args.object !== true) { await pinpointObject(args); return; }
  if (args.text == null || args.text === true) throw new Error('--text 필요 (찾을 구절)');
  const phrase = String(args.text).normalize('NFC');
  const nth = Math.max(1, Number(args.nth) || 1);
  const name = String(args.name || path.basename(args.file).replace(/\.[^.]+$/, '')).normalize('NFC');
  // 편집 모드: --replace(교체) / --format(서식) / --insert(삽입). 셋 다 그 Nth occurrence 만. headless 전용.
  const isReplace = args.replace !== undefined;
  const isFormat = args.format !== undefined && args.format !== true;
  const isInsert = args.insert !== undefined;
  const apply = !!args.apply;
  if ((isReplace || isFormat || isInsert) && apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다. --headed 는 보기 전용 — 편집 금지.');
  // read.mjs(ESM)를 동적 import — 파일에서 occurrence-맵 → 대상 nth 의 최단 유니크 앵커.
  const reader = await import('./read.mjs');
  const units = await reader.getUnits(args.file);
  const loc = reader.deriveAnchor(units, phrase, nth);
  if (!loc.found) { out({ cmd: 'pinpoint', status: 'not_found_in_file', text: phrase, nth, matchCount: 0 }); return; }
  const scale = isReplace ? 1.5 : (Number(args.scale) || 3);
  const band = Number(args.band) || 160;
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(scale, async (ctx, page) => {
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('드라이브에서 문서 못 찾음: ' + name + ' (먼저 업로드 필요할 수 있음)');
    const base = {
      cmd: 'pinpoint', text: phrase, nth: loc.nth, matchCount: loc.matchCount,
      kind: loc.kind, address: loc.address,
      context: loc.before + '【' + loc.match + '】' + loc.after,
      docId: editor.__docId || null,
    };
    // 편집 결과 줌 캡처(바뀐/삽입된 자리). 못 찾으면 현재 쪽 전체. (replace/format/insert 공용)
    const capShot = async (findFor) => {
      const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_pinedit_nth${loc.nth}_${stamp()}.png`);
      const rr = await findText(editor, findFor, 1).catch(() => ({ found: false }));
      if (rr.found && rr.caret) { await zoomBandShot(editor, rr.caret, band, shot); }
      else { const n2 = (await readCurrentPage(editor)) || 1; await gotoPage(editor, n2); const rect = await detectPageRect(editor); await hideOverlays(editor); await editor.screenshot(rect ? { path: shot, clip: rect } : { path: shot }); }
      return shot;
    };

    // ── 핀포인트 교체(--replace): 유니크 앵커 → 네이티브 '모두 바꾸기'로 그 1곳만 교체 ──
    // 앵커가 유일하므로 모두바꾸기여도 정확히 1곳. 교체 문자열 = 앵커에서 phrase 부분만 새 텍스트로(이웃 보존).
    if (isReplace) {
      const newText = String(args.replace === true ? '' : args.replace).normalize('NFC');
      // ── 유니크 앵커 경로: 그 앵커는 문서에서 유일 → '모두 바꾸기'여도 정확히 1곳(이웃 보존) ──
      if (loc.unique) {
        const a = loc.anchor, off = loc.matchOffset || 0;
        const findStr = a, toStr = a.slice(0, off) + newText + a.slice(off + loc.match.length);
        if (!apply) { out({ ...base, dryRun: true, mode: 'replace', replaceFind: findStr, replaceTo: toStr,
          note: '--apply 시 이 유니크 앵커로 그 1곳만 교체(이웃 텍스트는 보존, 서식은 평문화될 수 있음).' }); return; }
        const { replaced, popup, saved } = await nativeReplaceAll(editor, findStr, toStr);
        const shot = await capShot(toStr);
        out({ ...base, applied: true, mode: 'replace', replaced, replaceFind: findStr, replaceTo: toStr, shot, popup, saved, ...(saved ? {} : { warning: 'save_unconfirmed' }) });
        return;
      }
      // ── 비유니크(동일/빈 텍스트 반복) 경로: 문서순 nth 매치만 단일 '바꾸기'로 교체 ──
      if (!apply) { out({ ...base, dryRun: true, mode: 'replace-nth', replaceFind: phrase, replaceTo: newText,
        note: '비유니크 — 유니크 앵커가 없어 문서순 ' + loc.nth + '번째 매치만 단일 바꾸기로 교체(이웃 보존, 서식 평문화 가능). --apply 시 실행.' }); return; }
      const order = await enumerateDocOrder(editor, phrase);
      if (!order.length) { out({ ...base, status: 'not_found_in_ui', note: 'UI find 가 구절을 못 찾음.' }); return; }
      if (loc.nth > order.length) { out({ ...base, status: 'nth_out_of_range', uiMatchCount: order.length, note: `UI 는 ${order.length}곳만 찾음(파일 ${loc.matchCount}곳).` }); return; }
      const uiNth = order[loc.nth - 1].uiNth;
      const { saved } = await nativeReplaceNth(editor, phrase, newText, uiNth);
      const shot = await capShot(newText);
      out({ ...base, applied: true, mode: 'replace-nth', uiNth, uiMatchCount: order.length, replaceFind: phrase, replaceTo: newText, shot, saved, ...(saved ? {} : { warning: 'save_unconfirmed' }) });
      return;
    }

    // 편집 대상의 UI 착지 위치(uiNth) = 문서순 nth 를 docY 정렬로 복원해 매핑(replace-nth 와 동일).
    const resolveUiNth = async () => {
      const order = await enumerateDocOrder(editor, phrase);
      if (!order.length) { out({ ...base, status: 'not_found_in_ui', note: 'UI find 가 구절을 못 찾음.' }); return null; }
      if (loc.nth > order.length) { out({ ...base, status: 'nth_out_of_range', uiMatchCount: order.length, note: `UI 는 ${order.length}곳만 찾음(파일 ${loc.matchCount}곳).` }); return null; }
      return { uiNth: order[loc.nth - 1].uiNth, uiMatchCount: order.length };
    };

    // ── 핀포인트 서식(--format): 그 N번째 매치만 굵게/기울임/밑줄/글자색/형광 ──
    if (isFormat) {
      const tokens = String(args.format).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      const KB = { bold: 'b', italic: 'i', underline: 'u' };
      const kb = [], colors = [];
      for (const t of tokens) {
        if (KB[t]) kb.push(KB[t]);
        else if (t.startsWith('color:')) colors.push(['.font_color', t.slice(6)]);
        else if (t.startsWith('highlight:')) colors.push(['.font_highlight_color', t.slice(10)]);
        else throw new Error('--format 토큰: bold|italic|underline|color:<색>|highlight:<색> (쉼표 구분)');
      }
      if (!kb.length && !colors.length) throw new Error('--format 비어있음');
      if (!apply) { out({ ...base, dryRun: true, mode: 'format', format: tokens, note: '--apply 시 그 ' + loc.nth + '번째 매치에 서식 적용.' }); return; }
      const u = await resolveUiNth(); if (!u) return;
      let saved = true;
      if (kb.length) { // 키보드 서식: 한 번 선택 후 토글
        const sel = await dragSelectPhrase(editor, phrase, u.uiNth);
        if (!sel.selChars) { out({ ...base, status: 'selection_failed', uiNth: u.uiNth, note: '구절 선택 실패.' }); return; }
        await focusBody(editor);
        for (const k of kb) { await editor.keyboard.press('ControlOrMeta+' + k); await editor.waitForTimeout(450); }
        const sv = await confirmSaved(editor); saved = saved && sv;
      }
      for (const [combo, c] of colors) { // 글자색/형광: 각각 재선택+팔레트
        const tcol = parseColor(c); if (!tcol) throw new Error('색 파싱 실패: ' + c);
        const res = await selectAndPickColor(editor, phrase, u.uiNth, tcol, combo);
        if (res.status) { out({ ...base, status: res.status, uiNth: u.uiNth }); return; }
        saved = saved && res.saved;
      }
      await editor.keyboard.press('Escape').catch(() => {});
      const shot = await capShot(phrase);
      out({ ...base, applied: true, mode: 'format', format: tokens, uiNth: u.uiNth, uiMatchCount: u.uiMatchCount, saved, ...(saved ? {} : { warning: 'save_unconfirmed' }), shot });
      return;
    }

    // ── 핀포인트 삽입(--insert): 그 N번째 매치 바로 뒤에 텍스트 삽입 ──
    if (isInsert) {
      const insText = String(args.insert === true ? '' : args.insert).normalize('NFC');
      if (!insText) throw new Error('--insert <텍스트> 필요');
      if (!apply) { out({ ...base, dryRun: true, mode: 'insert', insertText: insText, note: '--apply 시 그 ' + loc.nth + '번째 매치 뒤에 삽입.' }); return; }
      const u = await resolveUiNth(); if (!u) return;
      const r2 = await findText(editor, phrase, u.uiNth);
      if (!r2.found || !r2.caret) { out({ ...base, status: 'nav_failed', uiNth: u.uiNth, note: '문서순 nth 착지 실패.' }); return; }
      await focusBody(editor);
      await editor.mouse.click(r2.caret.x, r2.caret.y + Math.round((r2.caret.h || 12) / 2)); await editor.waitForTimeout(250); // 매치 끝에 캐럿
      await editor.keyboard.type(insText, { delay: 35 });
      const saved = await confirmSaved(editor);
      const shot = await capShot(insText);
      out({ ...base, applied: true, mode: 'insert', insertText: insText, uiNth: u.uiNth, uiMatchCount: u.uiMatchCount, saved, ...(saved ? {} : { warning: 'save_unconfirmed' }), shot });
      return;
    }
    const shoot = async (r, extra) => {
      const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_pin_nth${loc.nth}_${stamp()}.png`);
      const { rect } = await zoomBandShot(editor, r.caret, band, shot);
      out({ ...base, found: true, page: r.page, shot, pageWidth: rect.width, band, scale, ...extra });
    };

    // ① 앵커 경로(유니크할 때만): UI find 첫 매치로 한 번에.
    if (loc.unique) {
      const r = await findText(editor, loc.anchor, 1);
      if (r.found) { await shoot(r, { method: 'anchor', anchor: loc.anchor, note: '유니크 앵커 → 정확 착지' }); return; }
      // 파일엔 유니크지만 UI 에서 못 찾음(윗첨자/특수문자 경계 등) → 문서순 nth 폴백
    }

    // ② 문서순 nth 폴백: UI 매치 전체를 docY 로 정렬해 문서순 복원 → read.mjs 의 nth 와 같은 자리로.
    const order = await enumerateDocOrder(editor, phrase);
    if (!order.length) { out({ ...base, status: 'not_found_in_ui', note: 'UI find 가 구절을 못 찾음.' }); return; }
    if (loc.nth > order.length) { out({ ...base, status: 'nth_out_of_range', uiMatchCount: order.length, note: `UI 는 ${order.length}곳만 찾음(파일 ${loc.matchCount}곳). 순서 정합 확인 필요.` }); return; }
    const target = order[loc.nth - 1];
    const r = await findText(editor, phrase, target.uiNth); // 그 문서순 자리 = 다음찾기 uiNth 번
    if (!r.found) { out({ ...base, status: 'nav_failed', uiNth: target.uiNth, note: '문서순 nth 착지 실패.' }); return; }
    await shoot(r, { method: 'position-nth', uiNth: target.uiNth, uiMatchCount: order.length,
      note: loc.unique ? '앵커는 UI서 안 찾혀(윗첨자 등) → 문서순 nth 로 착지' : '동일/빈 텍스트 — 문서순 nth(docY 정렬)로 착지. address(표·행·열)로 교차확인.' });
  });
}

// 여러 단서를 각각 검색해 가장 많이 수렴하는 페이지를 찾아 캡처 (반복/모호한 단어 보완).
async function cmdLocate(args) {
  if (!args.name || !args.clues) throw new Error('--name 과 --clues "a,b,c" 필요');
  const clues = String(args.clues).split(',').map((s) => s.trim()).filter(Boolean);
  if (!clues.length) throw new Error('--clues 가 비어있음');
  const scale = Number(args.scale) || 1.5;
  fs.mkdirSync(CAPDIR, { recursive: true });
  const browser = await chromium.launch({ headless: !HEADED, slowMo: SLOWMO });
  try {
    const results = [];
    for (const clue of clues) {
      const ctx = await browser.newContext({ storageState: AUTH, viewport: VIEW, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      try {
        const ed = await openDoc(ctx, page, args.name);
        if (!ed) throw new Error('문서를 못 찾음: ' + args.name);
        const r = await findText(ed, clue);
        results.push({ clue, page: r.found ? r.page : null });
        log(`  '${clue}' → ${r.found ? r.page + '쪽' : '없음'}`);
      } finally { await ctx.close(); }
    }
    // 최빈 페이지 = 수렴 지점
    const votes = {};
    results.forEach((r) => { if (r.page) votes[r.page] = (votes[r.page] || 0) + 1; });
    const ranked = Object.entries(votes).sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]));
    const converged = ranked.length ? Number(ranked[0][0]) : null;
    let shot = null, docId = null;
    if (converged) {
      const ctx = await browser.newContext({ storageState: AUTH, viewport: VIEW, deviceScaleFactor: scale });
      const page = await ctx.newPage();
      try {
        const ed = await openDoc(ctx, page, args.name);
        docId = ed.__docId || null;
        await gotoPage(ed, converged);
        const rect = await detectPageRect(ed);
        if (!rect || rect.width < 100) throw new Error('A4 페이지 영역 검출 실패');
        await hideOverlays(ed);
        if (args.grid) await injectGrid(ed, rect);
        shot = args.out || path.join(CAPDIR, `${String(args.name).replace(/\.[^.]+$/, '')}_locate_p${converged}_${stamp()}.png`);
        await ed.screenshot({ path: shot, clip: rect });
      } finally { await ctx.close(); }
    }
    out({ cmd: 'locate', clues: results, votes, converged, docId, shot });
  } finally { await browser.close(); }
}

// ───────────────────────── 문서 편집 (insert-text) ─────────────────────────
// insert-text: 앵커 텍스트를 찾아 그 줄 끝에 새 한 줄을 추가.
// 안전: ① 블라인드 input 금지 — 캐럿은 findText(검색칸만 입력, 본문 미편집)로
//   본문에 위치시키고, ② 캐럿이 본문 페이지 영역 안인지 가드한 뒤에만 타이핑, ③ dry-run 기본
//   (--apply 없으면 read-only), ④ 편집은 headless 전용(--headed 금지), ⑤ 끝나면 캡처 1장.
async function cmdInsertText(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  if (!args.anchor) throw new Error('--anchor 필요 (본문에서 찾을 기준 텍스트 — 이 줄 끝에 새 줄 추가)');
  if (!args.text) throw new Error('--text 필요 (추가할 한 줄)');
  const apply = !!args.apply;
  // 편집은 headless 전용 — headed면 사용자 상호작용/스크롤로 캐럿 위치가 어긋나 오편집 위험.
  if (apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다. --headed 는 보기(캡처) 전용 — 편집 금지.');
  const scale = Number(args.scale) || 1.5;
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(scale, async (ctx, page) => {
    const name = String(args.name).normalize('NFC');
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('문서를 못 찾음(드라이브에 없음): ' + name);
    // 1) 앵커로 캐럿을 본문에 안전 위치 (findText = 검색칸만 입력 → 본문 미편집, 캐럿만 매치로 이동)
    const r = await findText(editor, String(args.anchor).normalize('NFC'));
    if (!r.found) { out({ cmd: 'insert-text', status: 'anchor_not_found', anchor: args.anchor, docId: editor.__docId || null }); return; }
    const n = r.page || 1;
    const rect = await detectPageRect(editor);
    const caret = r.caret; // findText가 닫기 전 읽어둔 매치(캐럿) 뷰포트 픽셀
    if (!caret) { out({ cmd: 'insert-text', status: 'caret_not_found', anchor: args.anchor, docId: editor.__docId || null }); return; }
    // 안전 가드: 캐럿이 본문 페이지 영역 안인가(제목칸/툴바 등 본문 밖이면 중단 — 블라인드 입력 방지)
    const inBody = !!rect && caret.x >= rect.x - 5 && caret.x <= rect.x + rect.width + 5
                   && caret.y >= rect.y - 5 && caret.y <= rect.y + rect.height + 300;
    if (!inBody) { out({ cmd: 'insert-text', status: 'caret_out_of_body', anchor: args.anchor, caret, pageRect: rect, note: '본문 밖 캐럿 → 중단(오편집 방지)' }); return; }

    if (!apply) {
      // dry-run: 타이핑 없이 "어디에 무엇을 넣을지"만 리포트 (read-only)
      out({ cmd: 'insert-text', dryRun: true, anchor: args.anchor, foundPage: n, caret, plannedText: args.text,
            docId: editor.__docId || null, note: '--apply 없으면 read-only. 적용 시: 캐럿 줄 끝 → Enter → 타이핑.' });
      return;
    }

    // 2) 적용: 캐럿 줄 클릭(본문 포커스) → 줄 끝(End) → 새 줄(Enter) → 타이핑
    await editor.mouse.click(caret.x, caret.y + Math.round((caret.h || 12) / 2));
    await editor.waitForTimeout(350);
    await editor.keyboard.press('End');   // 줄 끝으로 (webhwp 실측 동작 — 캡처로 검증)
    await editor.waitForTimeout(180);
    await editor.keyboard.press('Enter'); // 새 줄
    await editor.waitForTimeout(180);
    await editor.keyboard.type(String(args.text).normalize('NFC'), { delay: 35 });
    const saved = await confirmSaved(editor); // 서버 저장(OT 동기화) 확정 후 닫기 — 고정 대기 대체

    // 3) regression 캡처 — 의도한 영역만 바뀌었는지 한 장
    await gotoPage(editor, n);
    const rect2 = await detectPageRect(editor);
    await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_insert_p${n}_${stamp()}.png`);
    await editor.screenshot(rect2 ? { path: shot, clip: rect2 } : { path: shot });
    out({ cmd: 'insert-text', applied: true, anchor: args.anchor, text: args.text, page: n,
          saved, ...(saved ? {} : { warning: 'save_unconfirmed: 서버 동기화 미확인 — 재시도/동시열림 확인 권장' }),
          docId: editor.__docId || null, shot });
  });
}

// 한컴독스 네이티브 "찾아 바꾸기" 다이얼로그 열기 (편집 메뉴 > 찾기 > 찾아 바꾸기 = .find_replace).
// 좌표 하드코딩 없이 셀렉터/DOM위치로만 — 메뉴 버전·창크기 바뀌어도 견고.
async function openReplaceDialog(ed) {
  // 편집 탭 클릭(메뉴 열기)
  const editTab = await ed.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      const t = (el.textContent || '').trim();
      if (t === '편집' && el.childElementCount === 0) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.top < 140) return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }
    }
    return null;
  });
  if (!editTab) throw new Error('편집 탭 탐색 실패');
  await ed.mouse.click(editTab.x, editTab.y); await ed.waitForTimeout(700);
  // '찾기' 서브그룹 호버 → 플라이아웃
  const fg = await ed.evaluate(() => {
    for (const el of document.querySelectorAll('.sub_group_title')) {
      if ((el.textContent || '').trim() === '찾기') { const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }
    }
    return null;
  });
  if (!fg) throw new Error('찾기 서브그룹 탐색 실패');
  await ed.mouse.move(fg.x, fg.y); await ed.waitForTimeout(900);
  // '찾아 바꾸기...' (.find_replace) 클릭
  const fr = await ed.evaluate(() => {
    const el = document.querySelector('.find_replace');
    if (!el || el.offsetParent === null) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  if (!fr) throw new Error('찾아 바꾸기 항목(.find_replace) 탐색 실패');
  await ed.mouse.click(fr.x, fr.y); await ed.waitForTimeout(1300);
}

// 다이얼로그의 보이는 입력칸들(본문 편집 영역 제외) — 위→아래 순. 찾을내용=[0], 바꿀내용=[1].
async function dialogInputs(ed) {
  return await ed.evaluate(() => {
    return Array.from(document.querySelectorAll('input'))
      .map((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), al: el.getAttribute('aria-label') || '', vis: r.width > 60 && r.height > 10 && getComputedStyle(el).visibility !== 'hidden' && el.getAttribute('aria-label') !== '문서 편집 영역' }; })
      .filter((i) => i.vis).sort((a, b) => a.y - b.y);
  });
}

// 네이티브 '찾아 바꾸기'로 findStr→toStr 전부 교체 후 교체 횟수 반환(다이얼로그 열기·입력·모두바꾸기·팝업확인·닫기).
// ⚠️ 호출 전 findText 선호출 금지(다이얼로그 충돌로 교체 0). 다이얼로그 입력칸만 타이핑(본문 미입력). 편집이라
// headless 전용 호출부에서 가드. findStr 가 문서에서 '유일'하면 정확히 1곳만 교체된다(= pinpoint 교체의 토대).
async function nativeReplaceAll(editor, findStr, toStr) {
  await openReplaceDialog(editor);
  const ins = await dialogInputs(editor);
  const findBox = ins.find((i) => /찾을/.test(i.al)) || ins[0];
  const replBox = ins.find((i) => /바꿀/.test(i.al)) || ins[1];
  if (!findBox || !replBox) throw new Error('찾아 바꾸기 입력칸 탐색 실패(현재 ' + ins.length + '개)');
  await editor.mouse.click(findBox.x + Math.min(findBox.w / 2, 40), findBox.y + findBox.h / 2);
  await editor.keyboard.press('ControlOrMeta+A'); await editor.keyboard.press('Delete');
  await editor.keyboard.type(findStr, { delay: 20 });
  await editor.mouse.click(replBox.x + Math.min(replBox.w / 2, 40), replBox.y + replBox.h / 2);
  await editor.keyboard.press('ControlOrMeta+A'); await editor.keyboard.press('Delete');
  if (toStr) await editor.keyboard.type(toStr, { delay: 20 });
  const allBtn = await editor.evaluate(() => {
    for (const el of document.querySelectorAll('a, button, div, span')) {
      const t = (el.textContent || '').trim();
      if (t === '모두 바꾸기' && el.offsetParent !== null && el.childElementCount === 0) {
        const r = el.getBoundingClientRect(); if (r.width > 20 && r.height > 10) return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }
    }
    return null;
  });
  if (!allBtn) throw new Error("'모두 바꾸기' 버튼 탐색 실패");
  const syncP = watchSave(editor); // 교체 동작 전에 무장(팝업 처리 중 동기화가 떠도 놓치지 않게)
  await editor.mouse.click(allBtn.x, allBtn.y); await editor.waitForTimeout(1400);
  // 결과 팝업 텍스트로 교체 횟수 판정 ("…바꾸기를 N번 했습니다" / "찾을 수 없습니다")
  const popup = await editor.evaluate(() => {
    const t = [];
    for (const el of document.querySelectorAll('div, span, p')) {
      const s = (el.textContent || '').trim();
      if (s && s.length < 60 && /바꿨|바꾸기를|찾을 수 없|없습니다|완료|개를/.test(s) && el.offsetParent !== null && el.childElementCount === 0) t.push(s);
    }
    return [...new Set(t)];
  });
  const joined = popup.join(' ');
  const mm = joined.match(/(\d+)\s*번/);
  const replaced = mm ? Number(mm[1]) : (/찾을 수 없|없습니다/.test(joined) ? 0 : null);
  const okBtn = await editor.evaluate(() => {
    for (const el of document.querySelectorAll('a, button, div, span')) {
      const t = (el.textContent || '').trim();
      if (t === '확인' && el.offsetParent !== null && el.childElementCount === 0) { const r = el.getBoundingClientRect(); if (r.width > 15 && r.height > 10) return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }
    }
    return null;
  });
  if (okBtn) await editor.mouse.click(okBtn.x, okBtn.y); else await editor.keyboard.press('Enter').catch(() => {});
  await editor.waitForTimeout(500);
  await editor.keyboard.press('Escape').catch(() => {}); // 다이얼로그 닫기
  const saved = await confirmSaved(editor, syncP); // 교체 후 서버 저장 확정(미리 무장한 syncP)
  return { replaced, popup: joined, saved };
}

// 비유니크 occurrence 의 'uiNth 번째' 매치 한 곳만 교체. 유니크 앵커가 없을 때(동일/빈 텍스트 반복)
// '모두 바꾸기'로는 못 집으므로, 찾아바꾸기에서 '다음 찾기'를 uiNth 번 눌러 그 매치를 선택한 뒤
// 단일 '바꾸기'(현재 매치만)로 교체한다. 문서순 nth → uiNth 매핑은 호출부(enumerateDocOrder)가 한다.
async function nativeReplaceNth(editor, findStr, toStr, uiNth) {
  await goDocStart(editor);
  await openReplaceDialog(editor);
  const ins = await dialogInputs(editor);
  const findBox = ins.find((i) => /찾을/.test(i.al)) || ins[0];
  const replBox = ins.find((i) => /바꿀/.test(i.al)) || ins[1];
  if (!findBox || !replBox) throw new Error('찾아 바꾸기 입력칸 탐색 실패(현재 ' + ins.length + '개)');
  await editor.mouse.click(findBox.x + Math.min(findBox.w / 2, 40), findBox.y + findBox.h / 2);
  await editor.keyboard.press('ControlOrMeta+A'); await editor.keyboard.press('Delete');
  await editor.keyboard.type(findStr, { delay: 20 });
  await editor.mouse.click(replBox.x + Math.min(replBox.w / 2, 40), replBox.y + replBox.h / 2);
  await editor.keyboard.press('ControlOrMeta+A'); await editor.keyboard.press('Delete');
  if (toStr) await editor.keyboard.type(toStr, { delay: 20 });
  // 방향 '문서 전체'(enumerateDocOrder 의 다음찾기 순서와 동일하게 — 문서 맨앞부터)
  const whole = await dialogBtnXY(editor, '문서 전체');
  if (whole) { await editor.mouse.click(whole.x, whole.y); await editor.waitForTimeout(300); }
  // '다음 찾기' uiNth 번 → 대상(문서순 nth) 매치 선택
  const nextBtn = await dialogBtnXY(editor, '다음 찾기');
  if (!nextBtn) throw new Error("'다음 찾기' 버튼 탐색 실패");
  for (let i = 0; i < uiNth; i++) { await editor.mouse.click(nextBtn.x, nextBtn.y); await editor.waitForTimeout(i === 0 ? 1200 : 650); }
  // 단일 '바꾸기'(현재 선택 매치만 교체)
  const replBtn = await dialogBtnXY(editor, '바꾸기');
  if (!replBtn) throw new Error("'바꾸기'(단일) 버튼 탐색 실패");
  const syncP = watchSave(editor);
  await editor.mouse.click(replBtn.x, replBtn.y); await editor.waitForTimeout(1000);
  // 결과 팝업/확인 닫기
  const okBtn = await dialogBtnXY(editor, '확인');
  if (okBtn) { await editor.mouse.click(okBtn.x, okBtn.y); await editor.waitForTimeout(400); }
  await editor.keyboard.press('Escape').catch(() => {});
  const saved = await confirmSaved(editor, syncP);
  return { saved };
}

// replace-text: 네이티브 '찾아 바꾸기'로 find → to 전부 교체. --to "" 면 삭제.
// 안전: 다이얼로그 입력칸만 타이핑(본문 미입력), dry-run 기본, 편집 headless 전용, 끝 캡처.
async function cmdReplaceText(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  if (args.find == null || args.find === true) throw new Error('--find 필요 (바꿀 대상 텍스트)');
  if (args.to === undefined) throw new Error('--to 필요 (바꿀 결과 텍스트 — 삭제는 --to "")');
  const apply = !!args.apply;
  if (apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다. --headed 는 보기(캡처) 전용 — 편집 금지.');
  const findText0 = String(args.find).normalize('NFC');
  const toText = String(args.to === true ? '' : args.to).normalize('NFC');
  const scale = Number(args.scale) || 1.5;
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(scale, async (ctx, page) => {
    const name = String(args.name).normalize('NFC');
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('문서를 못 찾음(드라이브에 없음): ' + name);
    if (!apply) {
      // dry-run: 찾기(읽기전용)로 대상 존재만 확인. (찾아 바꾸기 다이얼로그를 열기 전 단독 호출이라 충돌 없음)
      const r = await findText(editor, findText0);
      if (!r.found) { out({ cmd: 'replace-text', status: 'find_not_found', find: findText0, docId: editor.__docId || null }); return; }
      out({ cmd: 'replace-text', dryRun: true, find: findText0, to: toText, foundPage: r.page, caret: r.caret,
            docId: editor.__docId || null, note: '--apply 없으면 read-only. 적용 시: 찾아 바꾸기로 모두 교체.' });
      return;
    }
    // 적용: 네이티브 찾아 바꾸기 (findText 선호출 금지 — 다이얼로그 충돌로 교체 0 됨)
    const { replaced, saved } = await nativeReplaceAll(editor, findText0, toText);

    // regression 캡처 (교체 후 현재 쪽)
    const n = (await readCurrentPage(editor)) || 1;
    await gotoPage(editor, n);
    const rect2 = await detectPageRect(editor);
    await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_replace_p${n}_${stamp()}.png`);
    await editor.screenshot(rect2 ? { path: shot, clip: rect2 } : { path: shot });
    out({ cmd: 'replace-text', applied: true, find: findText0, to: toText, replaced, page: n, saved, ...(saved ? {} : { warning: 'save_unconfirmed' }), docId: editor.__docId || null, shot });
  });
}

// set-cell-text: 표 셀 채우기. 본문 canvas라 셀 위치를 셀렉터로 못 짚으므로, 기준 셀의 기존
// 텍스트(--cell)를 찾기로 찾아 캐럿을 그 셀에 두고 → Tab 으로 대상 셀 이동 → 입력.
// 안전: 찾기(읽기전용)로만 캐럿 이동, 캐럿이 본문 영역 밖이면 중단, dry-run 기본, headless 전용.
async function cmdSetCellText(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  if (args.text == null || args.text === true) throw new Error('--text 필요 (채울 값)');
  const apply = !!args.apply;
  if (apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다. --headed 는 보기 전용 — 편집 금지.');
  // 셀 지정 두 방식: ① --cell <기존 텍스트> [--tab N] (직접) ② --file --table T --row R --col C
  // (빈 셀 포함, read.mjs 가 앵커 셀+colCnt 로 Tab 횟수 자동계산 — 텍스트 없는 셀도 도달).
  let cellText, tabN, nav = null;
  if (args.file && args.row !== undefined && args.col !== undefined) {
    const reader = await import('./read.mjs');
    nav = await reader.cellNav(args.file, Number(args.table) || 0, Number(args.row), Number(args.col));
    if (!nav.found) { out({ cmd: 'set-cell-text', status: 'cellnav_failed', why: nav.why, note: '표에 텍스트 셀이 없거나 colCnt 미상 → --cell 로 직접 지정. (병합 표는 어긋날 수 있음)' }); return; }
    cellText = String(nav.anchorText).normalize('NFC'); tabN = nav.tabSteps;
  } else {
    if (args.cell == null || args.cell === true) throw new Error('--cell 필요 (기준 셀 텍스트) 또는 --file --table --row --col');
    cellText = String(args.cell).normalize('NFC');
    tabN = args.tab !== undefined ? Math.max(0, Number(args.tab)) : 1; // 기준 셀에서 Tab 횟수(1=다음 셀)
  }
  const value = String(args.text).normalize('NFC');
  const scale = Number(args.scale) || 1.5;
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(scale, async (ctx, page) => {
    const name = String(args.name).normalize('NFC');
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('문서를 못 찾음(드라이브에 없음): ' + name);
    const r = await findText(editor, cellText);
    if (!r.found) { out({ cmd: 'set-cell-text', status: 'cell_not_found', cell: cellText, docId: editor.__docId || null }); return; }
    const n = r.page || 1;
    const rect = await detectPageRect(editor);
    const caret = r.caret;
    if (!caret) { out({ cmd: 'set-cell-text', status: 'caret_not_found', cell: cellText, docId: editor.__docId || null }); return; }
    const inBody = !!rect && caret.x >= rect.x - 5 && caret.x <= rect.x + rect.width + 5 && caret.y >= rect.y - 5 && caret.y <= rect.y + rect.height + 300;
    if (!inBody) { out({ cmd: 'set-cell-text', status: 'caret_out_of_body', cell: cellText, caret, pageRect: rect }); return; }
    if (!apply) {
      out({ cmd: 'set-cell-text', dryRun: true, cell: cellText, tab: tabN, text: value, foundPage: n, caret,
            ...(nav ? { target: { table: nav.tableIdx, row: nav.targetRow, col: nav.targetCol }, colCnt: nav.colCnt } : {}),
            docId: editor.__docId || null, note: '--apply 없으면 read-only. 적용 시: 앵커 "' + cellText + '" 에서 ' + (tabN < 0 ? 'Shift+Tab×' + Math.abs(tabN) : 'Tab×' + tabN) + ' 이동 후 입력.' });
      return;
    }
    // 기준(앵커) 셀에 캐럿 → Tab×N 으로 대상 셀 이동 (음수면 Shift+Tab 으로 역방향)
    await editor.mouse.click(caret.x, caret.y + Math.round((caret.h || 12) / 2));
    await editor.waitForTimeout(350);
    const steps = Math.abs(tabN), tabKey = tabN < 0 ? 'Shift+Tab' : 'Tab';
    for (let i = 0; i < steps; i++) { await editor.keyboard.press(tabKey); await editor.waitForTimeout(180); }
    // 대상 셀의 기존 내용을 선택해 교체 — webhwp Tab 은 셀 내용을 자동 선택하지 않으므로(캐럿만 셀 시작
    // 으로 이동) 명시 선택한다: 줄 시작(Home) → 줄 끝까지(Shift+End) → 타이핑이 선택을 교체. 빈 셀이면
    // 선택 0 → 그냥 입력. (단일 줄 셀 기준; 여러 줄 셀은 첫 줄만 선택되는 한계.)
    await editor.keyboard.press('Home');
    await editor.keyboard.down('Shift'); await editor.keyboard.press('End'); await editor.keyboard.up('Shift');
    await editor.waitForTimeout(120);
    await editor.keyboard.type(value, { delay: 35 });
    const saved = await confirmSaved(editor); // 셀 입력 후 저장 확정
    await gotoPage(editor, n);
    const rect2 = await detectPageRect(editor);
    await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_cell_p${n}_${stamp()}.png`);
    await editor.screenshot(rect2 ? { path: shot, clip: rect2 } : { path: shot });
    out({ cmd: 'set-cell-text', applied: true, cell: cellText, tab: tabN, text: value, page: n, saved, ...(saved ? {} : { warning: 'save_unconfirmed' }),
      ...(nav ? { target: { table: nav.tableIdx, row: nav.targetRow, col: nav.targetCol } } : {}), docId: editor.__docId || null, shot });
  });
}

// 상태바의 '선택 글자수' — 선택이 있으면 'N / M 글자'(N=선택), 없으면 'M 글자' → 0.
async function readSelectedCount(ed) {
  return await ed.evaluate(() => {
    for (const e of document.querySelectorAll('*')) {
      const t = (e.textContent || '').replace(/\s+/g, ' ').trim();
      const m = t.match(/(\d+)\s*\/\s*\d+\s*글자/);
      if (m) return Number(m[1]);
    }
    return 0;
  });
}

// 다이얼로그 버튼을 텍스트(DOM)로 찾아 좌표 반환 — 하드코딩 오프셋 brittleness 회피(§3).
async function dialogBtnXY(ed, label) {
  return await ed.evaluate((lab) => {
    for (const el of document.querySelectorAll('a, button, div, span')) {
      const t = (el.textContent || '').trim();
      if (t === lab && el.offsetParent !== null && el.childElementCount === 0) {
        const r = el.getBoundingClientRect();
        if (r.width > 15 && r.height > 10) return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }
    }
    return null;
  }, label);
}

// 찾기로 매치를 '선택된 채로' 남긴다(서식 적용용). 버튼은 DOM 텍스트로 클릭(오프셋 금지).
// 닫은 뒤 상태바로 선택 글자수(selChars) 확인 → 0이면 호출부가 재시도.
async function findSelect(ed, text) {
  await openFindDialog(ed);
  const box = await ed.evaluate(() => {
    const ins = Array.from(document.querySelectorAll('input')).map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, vis: r.width > 60 && r.height > 10 && getComputedStyle(el).visibility !== 'hidden' && el.getAttribute('aria-label') !== '문서 편집 영역' }; });
    const cand = ins.filter((i) => i.vis && i.y > 300).sort((a, b) => b.w - a.w)[0];
    return cand ? { x: Math.round(cand.x), y: Math.round(cand.y), w: Math.round(cand.w), h: Math.round(cand.h) } : null;
  });
  if (!box) throw new Error('검색칸 탐색 실패');
  await ed.mouse.click(box.x + Math.min(box.w / 2, 40), box.y + box.h / 2);
  await ed.keyboard.press('ControlOrMeta+A');
  await ed.keyboard.type(text, { delay: 25 });
  const next = await dialogBtnXY(ed, '다음 찾기');
  if (!next) throw new Error('다음 찾기 버튼 탐색 실패');
  await ed.mouse.click(next.x, next.y); await ed.waitForTimeout(1600); // 매치 선택
  const page = await readCurrentPage(ed);
  const close = await dialogBtnXY(ed, '닫기');
  if (close) { await ed.mouse.click(close.x, close.y); await ed.waitForTimeout(700); }
  const selChars = await readSelectedCount(ed);
  return { found: page && page > 0, page, selChars };
}

// format-text: 구절을 찾아 선택한 뒤 글자 서식을 키보드 단축키로 적용(굵게 Cmd+B/기울임 Cmd+I/밑줄 Cmd+U).
// ⚠️ 툴바 .bold 클릭은 선택에 신뢰성 있게 적용 안 됨(focus/toggle) → 키보드 단축키가 견고(실측 확인).
async function cmdFormatText(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  if (args.text == null || args.text === true) throw new Error('--text 필요 (서식 적용할 구절)');
  const styles = [];
  if (args.bold) styles.push(['b', '굵게']);
  if (args.italic) styles.push(['i', '기울임']);
  if (args.underline) styles.push(['u', '밑줄']);
  const strike = !!args.strike; // 취소선 — 키보드 단축키 없어 툴바 .strikethrough 클릭
  if (!styles.length && !strike) throw new Error('서식 플래그 필요 (--bold / --italic / --underline / --strike 중 하나 이상)');
  const apply = !!args.apply;
  if (apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다. --headed 는 보기 전용 — 편집 금지.');
  const phrase = String(args.text).normalize('NFC');
  const scale = Number(args.scale) || 1.5;
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(scale, async (ctx, page) => {
    const name = String(args.name).normalize('NFC');
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('문서를 못 찾음(드라이브에 없음): ' + name);
    if (!apply) {
      const r = await findText(editor, phrase);
      if (!r.found) { out({ cmd: 'format-text', status: 'text_not_found', text: phrase, docId: editor.__docId || null }); return; }
      out({ cmd: 'format-text', dryRun: true, text: phrase, styles: [...styles.map((s) => s[1]), ...(strike ? ['취소선'] : [])], foundPage: r.page,
            docId: editor.__docId || null, note: '--apply 없으면 read-only. 적용 시: 구절 선택 후 서식 적용.' });
      return;
    }
    // 선택(찾기). 선택이 비면(selChars 0) 서식이 안 먹으므로 확인 후 재시도(최대 3회).
    let r = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      r = await findSelect(editor, phrase);
      if (!r.found) { out({ cmd: 'format-text', status: 'text_not_found', text: phrase, docId: editor.__docId || null }); return; }
      if (r.selChars > 0) break;
    }
    if (!r.selChars) { out({ cmd: 'format-text', status: 'selection_failed', text: phrase, docId: editor.__docId || null, note: '구절 선택 실패(3회). 더 고유한 구절로.' }); return; }
    const n = r.page || 1;
    // 닫힌 다이얼로그 후 본문(편집 영역 input)에 포커스 보장 — 안 그러면 키보드 서식이 선택이 아닌
    // 캐럿 모드로만 먹는 간헐 실패가 난다(문서 선택은 input 포커스와 별개라 유지됨).
    await editor.evaluate(() => { const el = document.querySelector('input[aria-label="문서 편집 영역"]'); if (el) el.focus(); }).catch(() => {});
    await editor.waitForTimeout(150);
    for (const [key] of styles) { await editor.keyboard.press('ControlOrMeta+' + key); await editor.waitForTimeout(450); } // 키보드 서식 토글
    if (strike) { try { await clickSel(editor, '.strikethrough'); } catch (e) { /* 셀렉터 없으면 무시 */ } await editor.waitForTimeout(450); } // 취소선 = 툴바 토글
    const saved = await confirmSaved(editor); // 서식 적용 후 서버 저장 확정
    await editor.keyboard.press('Escape').catch(() => {}); // 선택 해제(깨끗한 캡처)
    await editor.waitForTimeout(300);
    await gotoPage(editor, n);
    const rect2 = await detectPageRect(editor);
    await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_format_p${n}_${stamp()}.png`);
    await editor.screenshot(rect2 ? { path: shot, clip: rect2 } : { path: shot });
    out({ cmd: 'format-text', applied: true, text: phrase, styles: [...styles.map((s) => s[1]), ...(strike ? ['취소선'] : [])], selChars: r.selChars, page: n, saved, ...(saved ? {} : { warning: 'save_unconfirmed' }), docId: editor.__docId || null, shot });
  });
}

// 본문(편집 영역 input)에 포커스 — 닫힌 다이얼로그/찾기 뒤 키보드·툴바가 캐럿에 안 먹는 문제 방지.
async function focusBody(ed) {
  await ed.evaluate(() => { const el = document.querySelector('input[aria-label="문서 편집 영역"]'); if (el) el.focus(); }).catch(() => {});
  await ed.waitForTimeout(150);
}

// 셀렉터로 요소(툴바 버튼 등) 클릭 — DOM 위치 기반(좌표 하드코딩 회피).
async function clickSel(ed, sel) {
  const xy = await ed.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el || el.offsetParent === null) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 3 || r.height < 3) return null;
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, sel);
  if (!xy) throw new Error('버튼 탐색 실패: ' + sel);
  await ed.mouse.click(xy.x, xy.y);
  await ed.waitForTimeout(400);
}

// 메뉴바 탭(파일/편집/입력/서식/쪽/표 …) 열기 — 텍스트로 탭 위치 찾아 클릭(상단 top<140). 메뉴 항목은
// 열려야 보이므로(숨김), 다이얼로그/서브 op 호출 전 이걸로 메뉴를 편다.
async function openMenu(ed, name) {
  const t = await ed.evaluate((nm) => {
    for (const el of document.querySelectorAll('*')) {
      if ((el.textContent || '').trim() === nm && el.childElementCount === 0) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.top < 140) return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }
    }
    return null;
  }, name);
  if (!t) throw new Error('메뉴 탭 탐색 실패: ' + name);
  await ed.mouse.click(t.x, t.y); await ed.waitForTimeout(800);
}

// 다이얼로그의 aria-label 입력칸을 값으로 채움(전체선택 후 교체).
async function setDialogField(ed, label, value) {
  const xy = await ed.evaluate((al) => { for (const el of document.querySelectorAll('input')) { if ((el.getAttribute('aria-label') || '') === al) { const r = el.getBoundingClientRect(); if (r.width > 10 && el.offsetParent !== null) return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; } } return null; }, label);
  if (!xy) throw new Error('입력칸 탐색 실패: ' + label);
  await ed.mouse.click(xy.x, xy.y); await ed.keyboard.press('ControlOrMeta+A'); await ed.keyboard.press('Delete');
  await ed.keyboard.type(String(value), { delay: 30 });
}

// 열린 메뉴/서브메뉴에서 정확히 일치하는 텍스트 항목의 중심좌표(보이는 것만, 상단 메뉴영역).
async function menuItemXY(ed, text) {
  return ed.evaluate((t) => {
    let best = null;
    for (const el of document.querySelectorAll('div, a, span, li')) {
      if (el.childElementCount !== 0) continue;
      if ((el.textContent || '').trim() !== t) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 18 && r.height > 8 && el.offsetParent !== null && r.y > 60) best = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }
    return best;
  }, text);
}

// 다이얼로그 버튼(확인/만들기/취소 등) 텍스트로 클릭.
async function clickDialogBtn(ed, text) {
  const xy = await ed.evaluate((t) => { for (const el of document.querySelectorAll('button, a, div, span')) { if ((el.textContent || '').trim() === t && el.offsetParent !== null && el.childElementCount === 0) { const r = el.getBoundingClientRect(); if (r.width > 15 && r.height > 10) return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; } } return null; }, text);
  if (!xy) return false;
  await ed.mouse.click(xy.x, xy.y); await ed.waitForTimeout(1000); return true;
}

// align: 단락 정렬(왼/가운데/오른/양쪽). 단락 단위라 선택 불필요 — 기준 텍스트(--anchor)로 그 단락에
// 캐럿을 두고, 본문 포커스 후 툴바 정렬 셀렉터 클릭.
// style: 단락에 '스타일'(바탕글/본문/개요 1~10/쪽 번호 등)을 적용. 서식 콤보(.e_style_item)에서 선택.
async function cmdStyle(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  if (!args.anchor) throw new Error('--anchor 필요 (스타일 적용할 단락 안의 텍스트)');
  if (!args.style || args.style === true) throw new Error('--style 필요 (스타일 이름, 예: "개요 1")');
  const styleName = String(args.style).normalize('NFC');
  const apply = !!args.apply;
  if (apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다. --headed 는 보기 전용 — 편집 금지.');
  const anchor = String(args.anchor).normalize('NFC');
  const name = String(args.name).normalize('NFC');
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(Number(args.scale) || 1.5, async (ctx, page) => {
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('문서를 못 찾음(드라이브에 없음): ' + name);
    const r = await findText(editor, anchor);
    if (!r.found || !r.caret) { out({ cmd: 'style', status: 'anchor_not_found', anchor, docId: editor.__docId || null }); return; }
    const n = r.page || 1;
    if (!apply) { out({ cmd: 'style', dryRun: true, anchor, style: styleName, foundPage: n, docId: editor.__docId || null, note: '--apply 시 그 단락에 스타일 적용.' }); return; }
    await focusBody(editor);
    await editor.mouse.click(r.caret.x, r.caret.y + Math.round((r.caret.h || 12) / 2)); await editor.waitForTimeout(250);
    const arrowXY = await editor.evaluate(() => { const a = document.querySelector('.e_style_item .btn_combo_arrow'); if (!a) return null; const r = a.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; });
    if (!arrowXY) throw new Error('스타일 콤보 ▼(.e_style_item .btn_combo_arrow) 탐색 실패');
    await editor.mouse.click(arrowXY.x, arrowXY.y); await editor.waitForTimeout(700);
    const picked = await editor.evaluate((want) => { const el = [...document.querySelectorAll('.e_style_item.dropdown_data')].find((e) => (e.textContent || '').trim() === want); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }, styleName);
    if (!picked) {
      const avail = await editor.evaluate(() => [...document.querySelectorAll('.e_style_item.dropdown_data')].map((e) => (e.textContent || '').trim()).filter(Boolean));
      await editor.keyboard.press('Escape').catch(() => {});
      out({ cmd: 'style', status: 'style_not_available', anchor, style: styleName, available: avail, docId: editor.__docId || null, note: '그 스타일이 목록에 없음 — available 중 정확한 이름으로.' }); return;
    }
    const syncP = watchSave(editor);
    await editor.mouse.click(picked.x, picked.y); await editor.waitForTimeout(300);
    const saved = await confirmSaved(editor, syncP);
    const n2 = (await readCurrentPage(editor)) || n; await gotoPage(editor, n2);
    const rect = await detectPageRect(editor); await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_style_p${n2}_${stamp()}.png`);
    await editor.screenshot(rect ? { path: shot, clip: rect } : { path: shot });
    out({ cmd: 'style', applied: true, anchor, style: styleName, page: n2, saved, ...(saved ? {} : { warning: 'save_unconfirmed' }), docId: editor.__docId || null, shot });
  });
}

// level: 단락의 개요/목록 수준을 한 단계 증가/감소(툴바 '한 수준 증가/감소'). --by N으로 여러 단계.
// level: 단락(문단번호/개요)의 한 수준 증가(상위)/감소(하위). webhwp 단축키 Ctrl+Num-(증가)/Ctrl+Num+(감소).
async function cmdLevel(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  if (!args.anchor) throw new Error('--anchor 필요 (수준 바꿀 단락 안의 텍스트)');
  const to = String(args.to || '').toLowerCase();
  if (!['increase', 'decrease'].includes(to)) throw new Error('--to 는 increase | decrease');
  const by = Math.max(1, Number(args.by) || 1);
  const apply = !!args.apply;
  if (apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다. --headed 는 보기 전용 — 편집 금지.');
  const anchor = String(args.anchor).normalize('NFC');
  const name = String(args.name).normalize('NFC');
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(Number(args.scale) || 1.5, async (ctx, page) => {
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('문서를 못 찾음(드라이브에 없음): ' + name);
    const r = await findText(editor, anchor);
    if (!r.found || !r.caret) { out({ cmd: 'level', status: 'anchor_not_found', anchor, docId: editor.__docId || null }); return; }
    const n = r.page || 1;
    if (!apply) { out({ cmd: 'level', dryRun: true, anchor, to, by, foundPage: n, docId: editor.__docId || null, note: '--apply 시 그 단락 수준 ' + to + ' ' + by + '단계.' }); return; }
    // 한 수준 증가/감소는 단축키 Ctrl+Num-(증가=상위, 가.→1.)/Ctrl+Num+(감소=하위, 1.→가.)로.
    // (툴바 셀렉터 의존 회피 — caret만 단락에 두면 됨. 1수준에서 증가는 더 올라갈 데 없어 무변화=정상.)
    await focusBody(editor);
    await editor.mouse.click(r.caret.x, r.caret.y + Math.round((r.caret.h || 12) / 2)); await editor.waitForTimeout(250);
    const key = to === 'increase' ? 'Control+NumpadSubtract' : 'Control+NumpadAdd';
    const syncP = watchSave(editor);
    for (let i = 0; i < by; i++) { await editor.keyboard.press(key); await editor.waitForTimeout(350); }
    const saved = await confirmSaved(editor, syncP, { settleMs: 650 });
    const n2 = (await readCurrentPage(editor)) || n; await gotoPage(editor, n2);
    const rect = await detectPageRect(editor); await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_level_p${n2}_${stamp()}.png`);
    await editor.screenshot(rect ? { path: shot, clip: rect } : { path: shot });
    out({ cmd: 'level', applied: true, anchor, to, by, page: n2, saved, ...(saved ? {} : { warning: 'save_unconfirmed' }), docId: editor.__docId || null, shot });
  });
}

async function cmdAlign(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  if (!args.anchor) throw new Error('--anchor 필요 (정렬할 단락 안의 텍스트)');
  const to = String(args.to || '').toLowerCase();
  const SEL = { left: '.align_left', center: '.align_center', right: '.align_right', justify: '.align_justify', distribute: '.align_distribute', divide: '.align_divide' };
  if (!SEL[to]) throw new Error('--to 는 left | center | right | justify | distribute | divide');
  const apply = !!args.apply;
  if (apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다. --headed 는 보기 전용 — 편집 금지.');
  const anchor = String(args.anchor).normalize('NFC');
  const scale = Number(args.scale) || 1.5;
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(scale, async (ctx, page) => {
    const name = String(args.name).normalize('NFC');
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('문서를 못 찾음(드라이브에 없음): ' + name);
    const r = await findText(editor, anchor);
    if (!r.found) { out({ cmd: 'align', status: 'anchor_not_found', anchor, docId: editor.__docId || null }); return; }
    const n = r.page || 1;
    if (!apply) {
      out({ cmd: 'align', dryRun: true, anchor, to, foundPage: n, docId: editor.__docId || null, note: '--apply 없으면 read-only. 적용 시: 단락 캐럿 → 정렬 ' + to + '.' });
      return;
    }
    await focusBody(editor);
    await clickSel(editor, SEL[to]);
    const saved = await confirmSaved(editor); // 정렬 적용 후 저장 확정
    await gotoPage(editor, n);
    const rect2 = await detectPageRect(editor);
    await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_align_p${n}_${stamp()}.png`);
    await editor.screenshot(rect2 ? { path: shot, clip: rect2 } : { path: shot });
    out({ cmd: 'align', applied: true, anchor, to, page: n, saved, ...(saved ? {} : { warning: 'save_unconfirmed' }), docId: editor.__docId || null, shot });
  });
}

// 캐럿 기반 단락 op 공통: 기준 텍스트로 단락에 캐럿 → 본문 포커스 → 셀렉터 클릭 → 캡처.
async function caretParagraphOp(args, cmd, sel, extra) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  if (!args.anchor) throw new Error('--anchor 필요 (대상 단락 안의 텍스트)');
  const apply = !!args.apply;
  if (apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다. --headed 는 보기 전용 — 편집 금지.');
  const anchor = String(args.anchor).normalize('NFC');
  const scale = Number(args.scale) || 1.5;
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(scale, async (ctx, page) => {
    const name = String(args.name).normalize('NFC');
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('문서를 못 찾음(드라이브에 없음): ' + name);
    const r = await findText(editor, anchor);
    if (!r.found) { out({ cmd, status: 'anchor_not_found', anchor, docId: editor.__docId || null }); return; }
    const n = r.page || 1;
    if (!apply) { out({ cmd, dryRun: true, anchor, ...extra, foundPage: n, docId: editor.__docId || null, note: '--apply 없으면 read-only.' }); return; }
    await focusBody(editor);
    await clickSel(editor, sel);
    const saved = await confirmSaved(editor); // 단락 op 적용 후 저장 확정
    const pc = await readPageCount(editor);
    await gotoPage(editor, n);
    const rect2 = await detectPageRect(editor);
    await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_${cmd}_p${n}_${stamp()}.png`);
    await editor.screenshot(rect2 ? { path: shot, clip: rect2 } : { path: shot });
    out({ cmd, applied: true, anchor, ...extra, page: n, totalPages: pc ? pc.total : null, saved, ...(saved ? {} : { warning: 'save_unconfirmed' }), docId: editor.__docId || null, shot });
  });
}

// list: 단락을 글머리표(bullet) 또는 문단번호(number) 목록으로 토글.
async function cmdList(args) {
  const type = String(args.type || 'bullet').toLowerCase();
  const SEL = { bullet: '.bullet_list', number: '.number_list' };
  if (!SEL[type]) throw new Error('--type 는 bullet | number');
  await caretParagraphOp(args, 'list', SEL[type], { type });
}

// line-spacing: 단락 줄간격(%) 설정. 단락 단위라 선택 불필요 — 앵커로 그 단락에 캐럿을 두고, 툴바
// .p_line_spacing 드롭다운(▼=클릭으로 열림)에서 % 프리셋(100·130·160·180·200·300) 픽.
async function cmdLineSpacing(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  if (!args.anchor) throw new Error('--anchor 필요 (대상 단락 안의 텍스트)');
  const pct = Math.round(Number(args.to) || 0);
  if (!pct) throw new Error('--to 필요 (줄간격 %, 예: 160)');
  const apply = !!args.apply;
  if (apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다. --headed 는 보기 전용 — 편집 금지.');
  const anchor = String(args.anchor).normalize('NFC');
  const scale = Number(args.scale) || 1.5;
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(scale, async (ctx, page) => {
    const name = String(args.name).normalize('NFC');
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('문서를 못 찾음(드라이브에 없음): ' + name);
    const r = await findText(editor, anchor);
    if (!r.found) { out({ cmd: 'line-spacing', status: 'anchor_not_found', anchor, docId: editor.__docId || null }); return; }
    const n = r.page || 1;
    if (!apply) { out({ cmd: 'line-spacing', dryRun: true, anchor, to: pct, foundPage: n, docId: editor.__docId || null, note: '--apply 시 그 단락 줄간격 ' + pct + '%.' }); return; }
    await focusBody(editor);
    if (r.caret) { await editor.mouse.click(r.caret.x, r.caret.y + 6); await editor.waitForTimeout(250); } // 그 단락에 캐럿
    // 툴바 줄간격 콤보의 ▼ 화살표(.btn_combo_arrow)를 클릭해 드롭다운을 연다(콤보 중앙=입력칸이라 안 열림).
    const arrow = await editor.evaluate(() => { const a = document.querySelector('.p_line_spacing .btn_combo_arrow'); if (!a) return null; const r = a.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; });
    if (!arrow) throw new Error('줄간격 콤보 ▼ 탐색 실패');
    await editor.mouse.click(arrow.x, arrow.y); await editor.waitForTimeout(700);
    // 프리셋 항목(.dropdown_data, 텍스트=숫자만 "100".."300") 픽. 프리셋(100/130/160/180/200/300)이면 그걸,
    // 아니면 입력칸에 직접 타이핑.
    const pick = await editor.evaluate((target) => {
      for (const el of document.querySelectorAll('.p_line_spacing.dropdown_data')) {
        if ((el.textContent || '').trim() === String(target)) { const r = el.getBoundingClientRect(); if (el.offsetParent !== null && r.width > 4 && r.height > 4) return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }
      }
      return null;
    }, pct);
    if (pick) { await editor.mouse.click(pick.x, pick.y); }
    else {
      // 비프리셋 값 — 콤보 입력칸에 직접 입력 후 Enter.
      const inp = await editor.evaluate(() => { const el = document.querySelector('.p_line_spacing input'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; });
      if (!inp) throw new Error('줄간격 입력칸 탐색 실패 (프리셋: 100/130/160/180/200/300)');
      await editor.mouse.click(inp.x, inp.y); await editor.keyboard.press('ControlOrMeta+A'); await editor.keyboard.press('Delete');
      await editor.keyboard.type(String(pct), { delay: 30 }); await editor.keyboard.press('Enter');
    }
    const saved = await confirmSaved(editor); // 줄간격 적용 후 저장 확정
    await gotoPage(editor, n);
    const rect2 = await detectPageRect(editor); await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_linespacing_p${n}_${stamp()}.png`);
    await editor.screenshot(rect2 ? { path: shot, clip: rect2 } : { path: shot });
    out({ cmd: 'line-spacing', applied: true, anchor, to: pct, page: n, saved, ...(saved ? {} : { warning: 'save_unconfirmed' }), docId: editor.__docId || null, shot });
  });
}

// 구절을 마우스 드래그로 정확히 선택. 드래그는 본문 캔버스에서 일어나 포커스를 보장하므로, 이후
// 툴바(글자크기·색) 적용이 안정적이다(찾기 선택은 닫은 뒤 포커스가 풀려 적용이 간헐 실패).
// 찾기로 캐럿(매치 끝쪽)·줄 y 를 얻고, 그 줄을 가로로 드래그하며 selChars==글자수가 되게 폭(W) 보정.
async function dragSelectPhrase(ed, phrase, nth = 1) {
  const r = await findText(ed, phrase, nth);
  if (!r.found) return { found: false, selChars: 0 };
  if (r.wrapped) return { found: true, wrapped: true, matchCount: r.matchCount, selChars: 0 };
  if (!r.caret) return { found: true, selChars: 0, page: r.page };
  const target = [...phrase].length;
  const y = r.caret.y + Math.round((r.caret.h || 14) / 2);
  const xEnd = r.caret.x; // 캐럿 ≈ 매치 끝(다음 찾기 후 커서는 매치 뒤)
  let W = Math.max(8, target * 13), best = { d: Infinity, sel: 0 };
  for (let i = 0; i < 5; i++) {
    await ed.mouse.move(xEnd, y); await ed.mouse.down();
    await ed.mouse.move(xEnd - Math.round(W / 2), y, { steps: 4 });
    await ed.mouse.move(xEnd - W, y, { steps: 6 }); await ed.mouse.up();
    await ed.waitForTimeout(300);
    const selChars = await readSelectedCount(ed);
    const d = Math.abs(selChars - target);
    if (d < best.d) best = { d, sel: selChars };
    if (selChars === target) return { found: true, selChars, page: r.page };
    const perChar = W / Math.max(1, selChars); // 글자당 픽셀 추정으로 보정
    W = Math.max(8, Math.round(W + (target - selChars) * (perChar || 13)));
  }
  return { found: true, selChars: best.sel, page: r.page }; // 정확히 못 맞춰도 최선치
}

// font-size: 구절을 드래그 선택 후 툴바 글자크기 입력칸에 pt 값 입력.
async function cmdFontSize(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  if (args.text == null || args.text === true) throw new Error('--text 필요 (크기 바꿀 구절)');
  const size = Number(args.size);
  if (!size || size < 1 || size > 300) throw new Error('--size 필요 (pt, 예: 14)');
  const nth = Math.max(1, Number(args.nth) || 1); // 같은 구절이 여러 번이면 N번째 매치
  const apply = !!args.apply;
  if (apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다. --headed 는 보기 전용 — 편집 금지.');
  const phrase = String(args.text).normalize('NFC');
  const scale = Number(args.scale) || 1.5;
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(scale, async (ctx, page) => {
    const name = String(args.name).normalize('NFC');
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('문서를 못 찾음(드라이브에 없음): ' + name);
    if (!apply) {
      const r = await findText(editor, phrase, nth);
      if (!r.found) { out({ cmd: 'font-size', status: 'text_not_found', text: phrase, docId: editor.__docId || null }); return; }
      if (r.wrapped) { out({ cmd: 'font-size', status: 'nth_out_of_range', text: phrase, nth, matchCount: r.matchCount, docId: editor.__docId || null }); return; }
      out({ cmd: 'font-size', dryRun: true, text: phrase, size, nth, foundPage: r.page, docId: editor.__docId || null, note: '--apply 없으면 read-only. 적용 시: 드래그 선택 후 크기 ' + size + 'pt.' });
      return;
    }
    const sel = await dragSelectPhrase(editor, phrase, nth);
    if (!sel.found) { out({ cmd: 'font-size', status: 'text_not_found', text: phrase, docId: editor.__docId || null }); return; }
    if (sel.wrapped) { out({ cmd: 'font-size', status: 'nth_out_of_range', text: phrase, nth, matchCount: sel.matchCount, docId: editor.__docId || null }); return; }
    if (!sel.selChars) { out({ cmd: 'font-size', status: 'selection_failed', text: phrase, docId: editor.__docId || null, note: '드래그 선택 실패.' }); return; }
    const n = sel.page || 1;
    // 툴바 글자크기 입력칸에 값 입력(선택에 적용)
    const box = await editor.evaluate(() => { const el = document.querySelector('.font_size input'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; });
    if (!box) throw new Error('글자크기 입력칸(.font_size input) 탐색 실패');
    await editor.mouse.click(box.x, box.y);
    await editor.keyboard.press('ControlOrMeta+A');
    await editor.keyboard.type(String(size), { delay: 30 });
    await editor.keyboard.press('Enter');
    const saved = await confirmSaved(editor); // 글자크기 적용 후 저장 확정
    await gotoPage(editor, n);
    const rect2 = await detectPageRect(editor);
    await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_fontsize_p${n}_${stamp()}.png`);
    await editor.screenshot(rect2 ? { path: shot, clip: rect2 } : { path: shot });
    out({ cmd: 'font-size', applied: true, text: phrase, size, selChars: sel.selChars, page: n, saved, ...(saved ? {} : { warning: 'save_unconfirmed' }), docId: editor.__docId || null, shot });
  });
}

// 색 이름/hex → [r,g,b]. 흔한 이름(영/한) + #RRGGBB 지원.
function parseColor(c) {
  c = String(c).trim().toLowerCase();
  const named = {
    red: [255, 0, 0], blue: [0, 0, 255], green: [0, 128, 0], black: [0, 0, 0], white: [255, 255, 255],
    yellow: [255, 255, 0], orange: [255, 165, 0], purple: [128, 0, 128], gray: [128, 128, 128], grey: [128, 128, 128],
    navy: [0, 0, 128], pink: [255, 192, 203], brown: [150, 75, 0],
    '빨강': [255, 0, 0], '빨간색': [255, 0, 0], '파랑': [0, 0, 255], '파란색': [0, 0, 255], '초록': [0, 128, 0],
    '녹색': [0, 128, 0], '검정': [0, 0, 0], '검은색': [0, 0, 0], '노랑': [255, 255, 0], '주황': [255, 165, 0],
    '보라': [128, 0, 128], '회색': [128, 128, 128], '남색': [0, 0, 128], '분홍': [255, 192, 203],
  };
  if (named[c]) return named[c];
  const m = c.match(/^#?([0-9a-f]{6})$/);
  if (m) { const h = m[1]; return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
  return null;
}

// font-color: 구절을 드래그 선택 후 글자색 팔레트에서 요청 색에 '가장 가까운' 스와치 클릭.
// 구절을 드래그 선택 후 색 팔레트(comboSel 의 ▼)에서 target[r,g,b]에 가장 가까운 스와치를 클릭.
// 글자색(.font_color)·형광펜(.font_highlight_color)이 같은 팔레트 메커니즘이라 공유. 반환 {sel, picked}|{status}.
async function selectAndPickColor(editor, phrase, nth, target, comboSel) {
  // 드래그 선택은 서식 많이 입힌 줄(큰 글자 등)에서 폭 추정이 빗나가 간헐 실패 → selChars 0 이면 재시도.
  let sel = await dragSelectPhrase(editor, phrase, nth);
  if (!sel.found) return { status: 'text_not_found' };
  if (sel.wrapped) return { status: 'nth_out_of_range', matchCount: sel.matchCount };
  for (let i = 0; i < 2 && !sel.selChars; i++) { sel = await dragSelectPhrase(editor, phrase, nth); }
  if (!sel.selChars) return { status: 'selection_failed' };
  const arrow = await editor.evaluate((cs) => { const el = document.querySelector(cs + ' .btn_combo_arrow'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }, comboSel);
  if (!arrow) throw new Error('색 드롭다운(' + comboSel + ' .btn_combo_arrow) 탐색 실패');
  await editor.mouse.click(arrow.x, arrow.y); await editor.waitForTimeout(900);
  const cells = await editor.evaluate(() => {
    const out = [];
    const pal = document.querySelector('.ui_color_pick');
    const scope = pal && pal.offsetParent !== null ? pal : document;
    for (const el of scope.querySelectorAll('a, li, div, span, td')) {
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.width > 22 || el.offsetParent === null) continue;
      const m = getComputedStyle(el).backgroundColor.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
      if (m) out.push({ r: +m[1], g: +m[2], b: +m[3], x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    }
    return out;
  });
  if (!cells.length) throw new Error('색 팔레트 스와치 탐색 실패');
  let best = cells[0], bd = Infinity;
  for (const c of cells) { const d = (c.r - target[0]) ** 2 + (c.g - target[1]) ** 2 + (c.b - target[2]) ** 2; if (d < bd) { bd = d; best = c; } }
  // 스와치 클릭으로 색 설정+적용. 단, 클릭한 색이 콤보의 '현재 색'과 같으면(예: 형광펜 기본=노랑) 설정만
  // 되고 선택엔 적용 안 되는 경우가 있다 → 동기화(handler/action) 가 안 뜨면 메인 버튼으로 현재색을 적용.
  const sp1 = watchSave(editor, 2800);
  await editor.mouse.click(best.x, best.y);
  let saved = await sp1;
  if (!saved) {
    const mainXY = await editor.evaluate((cs) => { const el = document.querySelector(cs + ' .btn_icon_inner') || document.querySelector(cs); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + Math.min(12, r.width / 2)), y: Math.round(r.y + r.height / 2) }; }, comboSel);
    if (mainXY) { const sp2 = watchSave(editor); await editor.mouse.click(mainXY.x, mainXY.y); saved = await sp2; }
  }
  await editor.waitForTimeout(450); // 서버 커밋 settle
  return { sel, picked: { r: best.r, g: best.g, b: best.b }, saved };
}

async function cmdFontColor(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  if (args.text == null || args.text === true) throw new Error('--text 필요 (색 바꿀 구절)');
  const target = parseColor(args.color);
  if (!target) throw new Error('--color 필요 (red|blue|green|black|yellow|... 또는 #RRGGBB)');
  const nth = Math.max(1, Number(args.nth) || 1); // 같은 구절이 여러 번이면 N번째 매치
  const apply = !!args.apply;
  if (apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다. --headed 는 보기 전용 — 편집 금지.');
  const phrase = String(args.text).normalize('NFC');
  const scale = Number(args.scale) || 1.5;
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(scale, async (ctx, page) => {
    const name = String(args.name).normalize('NFC');
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('문서를 못 찾음(드라이브에 없음): ' + name);
    if (!apply) {
      const r = await findText(editor, phrase, nth);
      if (!r.found) { out({ cmd: 'font-color', status: 'text_not_found', text: phrase, docId: editor.__docId || null }); return; }
      if (r.wrapped) { out({ cmd: 'font-color', status: 'nth_out_of_range', text: phrase, nth, matchCount: r.matchCount, docId: editor.__docId || null }); return; }
      out({ cmd: 'font-color', dryRun: true, text: phrase, color: args.color, nth, foundPage: r.page, docId: editor.__docId || null, note: '--apply 없으면 read-only.' });
      return;
    }
    const res = await selectAndPickColor(editor, phrase, nth, target, '.font_color');
    if (res.status) { out({ cmd: 'font-color', status: res.status, text: phrase, ...(res.matchCount ? { nth, matchCount: res.matchCount } : {}), docId: editor.__docId || null }); return; }
    const n = res.sel.page || 1;
    await gotoPage(editor, n);
    const rect2 = await detectPageRect(editor);
    await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_fontcolor_p${n}_${stamp()}.png`);
    await editor.screenshot(rect2 ? { path: shot, clip: rect2 } : { path: shot });
    out({ cmd: 'font-color', applied: true, text: phrase, color: args.color, picked: res.picked, selChars: res.sel.selChars, page: n, saved: res.saved, ...(res.saved ? {} : { warning: 'save_unconfirmed' }), docId: editor.__docId || null, shot });
  });
}


// find: 같은 구절의 모든 occurrence 를 열거(개수 + 각 페이지). 긴 문서에서 "어느 것"을 보거나
// 편집할지 정하는 출발점 — 목록을 보고 around --nth N(맥락 읽기) / 편집 op --nth N(타겟)으로 잇는다.
// highlight: 구절에 형광펜 색 적용. font-color 와 동일 메커니즘(.font_highlight_color 팔레트, 최근접 스와치).
async function cmdHighlight(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  if (args.text == null || args.text === true) throw new Error('--text 필요 (형광펜 칠할 구절)');
  const target = parseColor(args.color);
  if (!target) throw new Error('--color 필요 (yellow|green|red|... 또는 #RRGGBB)');
  const nth = Math.max(1, Number(args.nth) || 1);
  const apply = !!args.apply;
  if (apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다. --headed 는 보기 전용 — 편집 금지.');
  const phrase = String(args.text).normalize('NFC');
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(Number(args.scale) || 1.5, async (ctx, page) => {
    const name = String(args.name).normalize('NFC');
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('문서를 못 찾음(드라이브에 없음): ' + name);
    if (!apply) {
      const r = await findText(editor, phrase, nth);
      if (!r.found) { out({ cmd: 'highlight', status: 'text_not_found', text: phrase, docId: editor.__docId || null }); return; }
      if (r.wrapped) { out({ cmd: 'highlight', status: 'nth_out_of_range', text: phrase, nth, matchCount: r.matchCount, docId: editor.__docId || null }); return; }
      out({ cmd: 'highlight', dryRun: true, text: phrase, color: args.color, nth, foundPage: r.page, docId: editor.__docId || null, note: '--apply 없으면 read-only.' });
      return;
    }
    const res = await selectAndPickColor(editor, phrase, nth, target, '.font_highlight_color');
    if (res.status) { out({ cmd: 'highlight', status: res.status, text: phrase, ...(res.matchCount ? { nth, matchCount: res.matchCount } : {}), docId: editor.__docId || null }); return; }
    const n = res.sel.page || 1;
    await gotoPage(editor, n);
    const rect2 = await detectPageRect(editor); await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_highlight_p${n}_${stamp()}.png`);
    await editor.screenshot(rect2 ? { path: shot, clip: rect2 } : { path: shot });
    out({ cmd: 'highlight', applied: true, text: phrase, color: args.color, picked: res.picked, selChars: res.sel.selChars, page: n, saved: res.saved, ...(res.saved ? {} : { warning: 'save_unconfirmed' }), docId: editor.__docId || null, shot });
  });
}

// font-family: 구절의 글꼴을 바꾼다. 드래그 선택 후 툴바 글꼴 입력칸(.font_name input)에 글꼴명 입력.
async function cmdFontFamily(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  if (args.text == null || args.text === true) throw new Error('--text 필요 (글꼴 바꿀 구절)');
  if (!args.font || args.font === true) throw new Error('--font 필요 (글꼴 이름, 예: "맑은 고딕")');
  const font = String(args.font).normalize('NFC');
  const nth = Math.max(1, Number(args.nth) || 1);
  const apply = !!args.apply;
  if (apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다. --headed 는 보기 전용 — 편집 금지.');
  const phrase = String(args.text).normalize('NFC');
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(Number(args.scale) || 1.5, async (ctx, page) => {
    const name = String(args.name).normalize('NFC');
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('문서를 못 찾음(드라이브에 없음): ' + name);
    if (!apply) {
      const r = await findText(editor, phrase, nth);
      if (!r.found) { out({ cmd: 'font-family', status: 'text_not_found', text: phrase, docId: editor.__docId || null }); return; }
      if (r.wrapped) { out({ cmd: 'font-family', status: 'nth_out_of_range', text: phrase, nth, matchCount: r.matchCount, docId: editor.__docId || null }); return; }
      out({ cmd: 'font-family', dryRun: true, text: phrase, font, nth, foundPage: r.page, docId: editor.__docId || null, note: '--apply 없으면 read-only. 적용 시: 드래그 선택 후 글꼴 ' + font + '.' });
      return;
    }
    const sel = await dragSelectPhrase(editor, phrase, nth);
    if (!sel.found) { out({ cmd: 'font-family', status: 'text_not_found', text: phrase, docId: editor.__docId || null }); return; }
    if (sel.wrapped) { out({ cmd: 'font-family', status: 'nth_out_of_range', text: phrase, nth, matchCount: sel.matchCount, docId: editor.__docId || null }); return; }
    if (!sel.selChars) { out({ cmd: 'font-family', status: 'selection_failed', text: phrase, docId: editor.__docId || null, note: '드래그 선택 실패.' }); return; }
    const n = sel.page || 1;
    // 글꼴 콤보는 입력칸 타이핑이 안 먹는다(읽기전용 표시). ▼ 드롭다운을 열어 글꼴 목록에서 정확히
    // 일치하는 항목을 클릭해야 적용된다. 목록에 없는 글꼴이면 적용 불가 → available 목록과 함께 알린다.
    const arrowXY = await editor.evaluate(() => { const a = document.querySelector('.font_name .btn_combo_arrow'); if (!a) return null; const r = a.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; });
    if (!arrowXY) throw new Error('글꼴 콤보 ▼(.font_name .btn_combo_arrow) 탐색 실패');
    await editor.mouse.click(arrowXY.x, arrowXY.y); await editor.waitForTimeout(700); // ▼ 드롭다운 열기
    // 목록에서 글꼴명 정확 일치 항목을 화면에 보이게(scrollIntoView) 한 뒤 좌표 취득
    const picked = await editor.evaluate((want) => {
      const el = [...document.querySelectorAll('.font_name.dropdown_data')].find((e) => (e.textContent || '').trim() === want);
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }, font);
    if (!picked) {
      const avail = await editor.evaluate(() => [...document.querySelectorAll('.font_name.dropdown_data')].map((e) => (e.textContent || '').trim()).filter(Boolean));
      await editor.keyboard.press('Escape').catch(() => {});
      out({ cmd: 'font-family', status: 'font_not_available', text: phrase, font, available: avail, docId: editor.__docId || null, note: '그 글꼴이 이 문서의 글꼴 목록에 없음 — available 중에서 정확한 이름으로 지정.' });
      return;
    }
    await editor.mouse.click(picked.x, picked.y); await editor.waitForTimeout(300); // 글꼴 항목 클릭(적용)
    const saved = await confirmSaved(editor); // 글꼴 적용 후 저장 확정
    await gotoPage(editor, n);
    const rect2 = await detectPageRect(editor); await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_fontfam_p${n}_${stamp()}.png`);
    await editor.screenshot(rect2 ? { path: shot, clip: rect2 } : { path: shot });
    out({ cmd: 'font-family', applied: true, text: phrase, font, selChars: sel.selChars, page: n, saved, ...(saved ? {} : { warning: 'save_unconfirmed' }), docId: editor.__docId || null, shot });
  });
}

// ───────────────────────── 삽입 (표/그림) ─────────────────────────
// insert-table: 입력›표 다이얼로그로 R×C 표 생성. --anchor 있으면 그 줄 끝 다음 줄에, 없으면 문서 시작에.
async function cmdInsertTable(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  const rows = Math.max(1, Number(args.rows) || 0), cols = Math.max(1, Number(args.cols) || 0);
  if (!rows || !cols) throw new Error('--rows 와 --cols 필요 (양수)');
  const apply = !!args.apply;
  if (apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다. --headed 는 보기 전용.');
  const name = String(args.name).normalize('NFC');
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(Number(args.scale) || 1.5, async (ctx, page) => {
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('문서를 못 찾음(드라이브에 없음): ' + name);
    // 삽입 위치 캐럿
    if (args.anchor) {
      const r = await findText(editor, String(args.anchor).normalize('NFC'));
      if (!r.found) { out({ cmd: 'insert-table', status: 'anchor_not_found', anchor: args.anchor, docId: editor.__docId || null }); return; }
    } else { await goDocStart(editor); }
    if (!apply) { out({ cmd: 'insert-table', dryRun: true, rows, cols, anchor: args.anchor || null, docId: editor.__docId || null, note: '--apply 시 표 생성. --anchor 있으면 그 줄 다음에.' }); return; }
    await focusBody(editor);
    if (args.anchor) { await editor.keyboard.press('End'); await editor.keyboard.press('Enter'); await editor.waitForTimeout(300); }
    // 입력 메뉴 → 표 만들기 다이얼로그 → 줄/칸 개수 → 만들기
    await openMenu(editor, '입력');
    await clickSel(editor, '.insert_table'); await editor.waitForTimeout(900);
    await setDialogField(editor, '줄 개수', rows);
    await setDialogField(editor, '칸 개수', cols);
    await editor.waitForTimeout(200);
    const syncP = watchSave(editor); // 만들기(표 생성) 전에 무장
    if (!await clickDialogBtn(editor, '만들기')) throw new Error("'만들기' 버튼 탐색 실패");
    const saved = await confirmSaved(editor, syncP); // 표 생성 후 저장 확정
    const n = (await readCurrentPage(editor)) || 1; await gotoPage(editor, n);
    const rect = await detectPageRect(editor); await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_inserttbl_${stamp()}.png`);
    await editor.screenshot(rect ? { path: shot, clip: rect } : { path: shot });
    out({ cmd: 'insert-table', applied: true, rows, cols, anchor: args.anchor || null, page: n, saved, ...(saved ? {} : { warning: 'save_unconfirmed' }), shot, docId: editor.__docId || null });
  });
}

// insert-image: 입력›그림 다이얼로그(장치)로 로컬 이미지 삽입. --anchor 있으면 그 줄 다음에, 없으면 문서 시작.
async function cmdInsertImage(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  if (!args.file) throw new Error('--file 필요 (삽입할 이미지 경로)');
  const imgPath = path.resolve(args.file);
  if (!fs.existsSync(imgPath)) throw new Error('이미지 파일 없음: ' + imgPath);
  const apply = !!args.apply;
  if (apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다. --headed 는 보기 전용.');
  const name = String(args.name).normalize('NFC');
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(Number(args.scale) || 1.5, async (ctx, page) => {
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('문서를 못 찾음(드라이브에 없음): ' + name);
    if (args.anchor) {
      const r = await findText(editor, String(args.anchor).normalize('NFC'));
      if (!r.found) { out({ cmd: 'insert-image', status: 'anchor_not_found', anchor: args.anchor, docId: editor.__docId || null }); return; }
    } else { await goDocStart(editor); }
    if (!apply) { out({ cmd: 'insert-image', dryRun: true, file: imgPath, anchor: args.anchor || null, docId: editor.__docId || null, note: '--apply 시 그림 삽입. --anchor 있으면 그 줄 다음에.' }); return; }
    await focusBody(editor);
    if (args.anchor) { await editor.keyboard.press('End'); await editor.keyboard.press('Enter'); await editor.waitForTimeout(300); }
    // 입력 메뉴 → 그림 → '그림 넣기' 다이얼로그(장치) → file input 에 파일 → 넣기
    await openMenu(editor, '입력');
    await clickSel(editor, '.insert_image'); await editor.waitForTimeout(900);
    await editor.locator('input[type="file"]').last().setInputFiles(imgPath);
    await editor.waitForTimeout(1200);
    const syncP = watchSave(editor); // 넣기(그림 삽입) 전에 무장
    if (!await clickDialogBtn(editor, '넣기')) throw new Error("'넣기' 버튼 탐색 실패");
    const saved = await confirmSaved(editor, syncP); // 그림 삽입 후 저장 확정
    const n = (await readCurrentPage(editor)) || 1; await gotoPage(editor, n);
    const rect = await detectPageRect(editor); await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_insertimg_${stamp()}.png`);
    await editor.screenshot(rect ? { path: shot, clip: rect } : { path: shot });
    out({ cmd: 'insert-image', applied: true, file: imgPath, anchor: args.anchor || null, page: n, saved, ...(saved ? {} : { warning: 'save_unconfirmed' }), shot, docId: editor.__docId || null });
  });
}

// table-op: 표 줄/칸 추가·삭제. 대상 셀에 캐럿(--cell 텍스트로 찾기 [+--tab N])을 두면 표 메뉴가 활성 →
// 줄/칸 추가하기/지우기 서브메뉴 항목 클릭. op = insert-row-above|insert-row-below|insert-col-left|
// insert-col-right|delete-row|delete-col. (셀 합치기=블록 선택 필요라 별도, 셀 나누기=다이얼로그 별도.)
async function cmdTableOp(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  if (!args.cell || args.cell === true) throw new Error('--cell 필요 (대상 셀 텍스트)');
  const op = String(args.op || '');
  const OPS = {
    'insert-row-above': { menu: '줄/칸 추가하기', item: '위쪽에 줄 추가하기' },
    'insert-row-below': { menu: '줄/칸 추가하기', item: '아래쪽에 줄 추가하기' },
    'insert-col-left': { menu: '줄/칸 추가하기', item: '왼쪽에 칸 추가하기' },
    'insert-col-right': { menu: '줄/칸 추가하기', item: '오른쪽에 칸 추가하기' },
    'delete-row': { menu: '줄/칸 지우기', item: '줄 지우기' },
    'delete-col': { menu: '줄/칸 지우기', item: '칸 지우기' },
  };
  // split = 셀 나누기 다이얼로그(--split-rows/--split-cols), merge = 인접 셀 블록 선택 후 합치기
  const valid = [...Object.keys(OPS), 'split', 'merge'];
  if (!valid.includes(op)) throw new Error('--op 는 ' + valid.join(' | '));
  const apply = !!args.apply;
  if (apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다. --headed 는 보기 전용.');
  const cellText = String(args.cell).normalize('NFC');
  const tabN = args.tab !== undefined ? Math.max(0, Number(args.tab)) : 0;
  const name = String(args.name).normalize('NFC');
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(Number(args.scale) || 1.5, async (ctx, page) => {
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('문서를 못 찾음(드라이브에 없음): ' + name);
    const r = await findText(editor, cellText);
    if (!r.found || !r.caret) { out({ cmd: 'table-op', status: 'cell_not_found', cell: cellText, docId: editor.__docId || null }); return; }
    if (!apply) { out({ cmd: 'table-op', dryRun: true, cell: cellText, tab: tabN, op, foundPage: r.page, docId: editor.__docId || null, note: '--apply 시 표 op 실행.' }); return; }
    await focusBody(editor);
    await editor.mouse.click(r.caret.x, r.caret.y + 6); await editor.waitForTimeout(250); // 셀에 캐럿
    for (let i = 0; i < tabN; i++) { await editor.keyboard.press('Tab'); await editor.waitForTimeout(160); }
    const syncP = watchSave(editor); // 표 구조 변경 전에 무장(메뉴/다이얼로그 처리 중 동기화 놓치지 않게)
    if (op === 'split') {
      // 셀 나누기 다이얼로그: 줄/칸 개수로 현재 셀을 분할
      const sr = Math.max(1, Number(args['split-rows']) || 1), sc = Math.max(1, Number(args['split-cols']) || 1);
      await openMenu(editor, '표');
      const sp = await menuItemXY(editor, '셀 나누기...');
      if (!sp) throw new Error('셀 나누기... 탐색 실패 (셀에 캐럿 없음?)');
      await editor.mouse.click(sp.x, sp.y); await editor.waitForTimeout(1000);
      // 일부 복잡한 표(대형·병합 다수)는 이 경로로 '셀 나누기' 다이얼로그가 안 열린다 → 명확히 알림.
      const dialogOpen = await editor.evaluate(() => [...document.querySelectorAll('input')].some((e) => e.getAttribute('aria-label') === '줄 개수' && e.offsetParent !== null));
      if (!dialogOpen) { out({ cmd: 'table-op', status: 'split_dialog_not_opened', cell: cellText, op, docId: editor.__docId || null, note: "이 표/셀에선 '셀 나누기' 다이얼로그가 안 열림(대형·병합 많은 표의 webhwp 한계). 일반 표에선 정상." }); return; }
      try { await setDialogField(editor, '줄 개수', sr); } catch (e) {}
      try { await setDialogField(editor, '칸 개수', sc); } catch (e) {}
      await editor.waitForTimeout(200);
      if (!await clickDialogBtn(editor, '나누기')) throw new Error("'나누기' 버튼 탐색 실패");
      await editor.waitForTimeout(1300);
    } else if (op === 'merge') {
      // 인접 셀 블록 선택(현재 셀 + 오른쪽 N칸) 후 셀 합치기.
      // 본문 canvas 에선 Shift+→/드래그로는 셀 블록이 안 잡힌다(드래그는 표를 객체로 잡아버림).
      // 정석은 F5(셀 선택 = 블록 모드) → Shift+→ 로 칸 단위 확장 → 셀 합치기.
      const span = Math.max(1, Number(args.span) || 1); // 오른쪽으로 확장할 칸 수(1=다음 칸까지)
      await editor.keyboard.press('F5'); await editor.waitForTimeout(450); // 현재 셀을 블록 선택
      for (let i = 0; i < span; i++) { await editor.keyboard.press('Shift+ArrowRight'); await editor.waitForTimeout(300); }
      await openMenu(editor, '표');
      const mg = await menuItemXY(editor, '셀 합치기');
      if (!mg) throw new Error('셀 합치기 탐색 실패 (블록 선택 안 됨? 셀에 캐럿 없음?)');
      await editor.mouse.click(mg.x, mg.y); await editor.waitForTimeout(1300);
    } else {
      const spec = OPS[op];
      await openMenu(editor, '표');
      const parent = await menuItemXY(editor, spec.menu);
      if (!parent) throw new Error('표 메뉴 항목 탐색 실패: ' + spec.menu + ' (셀에 캐럿 없음?)');
      await editor.mouse.move(parent.x, parent.y); await editor.waitForTimeout(700); // 서브메뉴 펼침(호버)
      const item = await menuItemXY(editor, spec.item);
      if (!item) throw new Error('서브 항목 탐색 실패: ' + spec.item);
      await editor.mouse.click(item.x, item.y); await editor.waitForTimeout(1300);
    }
    const saved = await confirmSaved(editor, syncP); // 표 op 후 저장 확정(미리 무장한 syncP)
    const n = (await readCurrentPage(editor)) || 1; await gotoPage(editor, n);
    const rect = await detectPageRect(editor); await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_tableop_${stamp()}.png`);
    await editor.screenshot(rect ? { path: shot, clip: rect } : { path: shot });
    out({ cmd: 'table-op', applied: true, cell: cellText, tab: tabN, op, page: n, saved, ...(saved ? {} : { warning: 'save_unconfirmed' }), shot, docId: editor.__docId || null });
  });
}

// 편집 직후 호출 — 서버 저장 확정 대기. webhwp 는 자동저장이라 명시 저장 버튼/단축키가 없고(.d_save
// 비활성), 본문 변경은 타이핑 ~0.75s 후 디바운스된 OT 동기화(POST /webhwp/handler/action/<docId>) 로
// 서버에 올라간다. 그 POST 200 을 기다린 뒤 짧게 settle(서버 커밋 여유) 하고 닫아야 편집이 보존된다.
// 고정 대기(1.3~1.4s)보다 ① 망 속도에 자동 적응(느린 망에 안전), ② 보통 더 빠름(~1.1s), ③ 동기화가
// 안 잡히면 synced=false 로 '저장 미확정'을 호출부가 알 수 있다. 실측: settle 300~500ms 면 6/6 보존,
// settle 0 은 간헐 유실(POST 200 만으론 부족 — 서버 커밋 settle 필요).
// watchSave(editor): 편집 '전' 호출 — 다음 OT 동기화(handler/action POST 200)를 잡는 프라미스를 무장.
// 편집 동작과 confirmSaved 호출 사이에 긴 대기(팝업 처리·다이얼로그 닫기 등)가 있는 op 는 동기화가 그
// 사이에 이미 떠버려 '편집 후 무장'이면 놓친다(→ timeout). 그런 op 는 watchSave 로 미리 무장하고
// confirmSaved(editor, syncP) 로 받는다.
function watchSave(editor, timeoutMs = 6000) {
  return editor.waitForResponse(
    (resp) => /\/webhwp\/handler\/action\//.test(resp.url()) && resp.request().method() === 'POST' && resp.status() === 200,
    { timeout: timeoutMs }).then(() => true).catch(() => false);
}
async function confirmSaved(editor, syncP = null, { settleMs = 450 } = {}) {
  const synced = await (syncP || watchSave(editor)); // syncP 있으면 그걸, 없으면 지금 무장(편집 직후 호출용)
  await editor.waitForTimeout(settleMs); // 서버 커밋 여유
  return synced;
}

// page-number: 머리말/꼬리말에 쪽 번호 삽입. 쪽 메뉴 → 머리말|꼬리말 서브메뉴 → 왼쪽|가운데|오른쪽 쪽 번호.
async function cmdPageNumber(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  const where = String(args.where || 'header').toLowerCase();
  const align = String(args.align || 'right').toLowerCase();
  const WHERE = { header: '머리말', footer: '꼬리말' };
  const ALIGN = { left: '왼쪽 쪽 번호', center: '가운데 쪽 번호', right: '오른쪽 쪽 번호' };
  if (!WHERE[where]) throw new Error('--where 는 header | footer');
  if (!ALIGN[align]) throw new Error('--align 는 left | center | right');
  const apply = !!args.apply;
  if (apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다. --headed 는 보기 전용 — 편집 금지.');
  const name = String(args.name).normalize('NFC');
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(Number(args.scale) || 1.5, async (ctx, page) => {
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('문서를 못 찾음(드라이브에 없음): ' + name);
    if (!apply) { out({ cmd: 'page-number', dryRun: true, where, align, docId: editor.__docId || null, note: '--apply 시 ' + WHERE[where] + '에 ' + ALIGN[align] + ' 삽입.' }); return; }
    await focusBody(editor);
    const syncP = watchSave(editor);
    await openMenu(editor, '쪽');
    const parent = await menuItemXY(editor, WHERE[where]); // 머리말/꼬리말 (서브메뉴 부모)
    if (!parent) throw new Error(WHERE[where] + ' 메뉴 항목 탐색 실패');
    await editor.mouse.move(parent.x, parent.y); await editor.waitForTimeout(700); // 서브메뉴 펼침(호버)
    const item = await menuItemXY(editor, ALIGN[align]);
    if (!item) throw new Error(ALIGN[align] + ' 항목 탐색 실패 (서브메뉴 안 펼쳐짐?)');
    await editor.mouse.click(item.x, item.y); await editor.waitForTimeout(900);
    const saved = await confirmSaved(editor, syncP);
    // 머리말/꼬리말은 본문 밖(쪽 가장자리) → 맨 위로 스크롤 후 전체 뷰포트 캡처.
    await goDocStart(editor); await editor.waitForTimeout(400); await hideOverlays(editor);
    const n = (await readCurrentPage(editor)) || 1;
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_pagenum_${where}_${stamp()}.png`);
    await editor.screenshot({ path: shot });
    out({ cmd: 'page-number', applied: true, where, align, page: n, saved, ...(saved ? {} : { warning: 'save_unconfirmed' }), docId: editor.__docId || null, shot });
  });
}

// page-break: 기준 텍스트(--anchor) 줄 끝에서 쪽을 나눠 다음 내용을 새 쪽으로 보냄(쪽 메뉴 › 쪽 나누기).
async function cmdPageBreak(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  if (!args.anchor) throw new Error('--anchor 필요 (쪽 나눌 기준 텍스트 — 그 줄 끝에서 나눔)');
  const apply = !!args.apply;
  if (apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다. --headed 는 보기 전용 — 편집 금지.');
  const anchor = String(args.anchor).normalize('NFC');
  const name = String(args.name).normalize('NFC');
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(Number(args.scale) || 1.5, async (ctx, page) => {
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('문서를 못 찾음(드라이브에 없음): ' + name);
    const r = await findText(editor, anchor);
    if (!r.found || !r.caret) { out({ cmd: 'page-break', status: 'anchor_not_found', anchor, docId: editor.__docId || null }); return; }
    const n = r.page || 1;
    if (!apply) { out({ cmd: 'page-break', dryRun: true, anchor, foundPage: n, docId: editor.__docId || null, note: '--apply 시 그 줄 끝에서 쪽 나누기.' }); return; }
    await focusBody(editor);
    await editor.mouse.click(r.caret.x, r.caret.y + Math.round((r.caret.h || 12) / 2)); await editor.waitForTimeout(300);
    await editor.keyboard.press('End'); await editor.waitForTimeout(150); // 줄 끝
    const syncP = watchSave(editor);
    // 쪽 메뉴 › 쪽 나누기(.p_page_break). 키보드 단축키보다 메뉴 셀렉터가 견고.
    await openMenu(editor, '쪽');
    let clicked = false;
    try { await clickSel(editor, '.p_page_break'); clicked = true; } catch (e) { /* 메뉴 항목 텍스트로 폴백 */ }
    if (!clicked) { const it = await menuItemXY(editor, '쪽 나누기'); if (!it) throw new Error('쪽 나누기 항목 탐색 실패'); await editor.mouse.click(it.x, it.y); }
    await editor.waitForTimeout(800);
    const saved = await confirmSaved(editor, syncP);
    const pc = await readPageCount(editor);
    const n2 = (await readCurrentPage(editor)) || n; await gotoPage(editor, n2);
    const rect = await detectPageRect(editor); await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_pagebreak_p${n2}_${stamp()}.png`);
    await editor.screenshot(rect ? { path: shot, clip: rect } : { path: shot });
    out({ cmd: 'page-break', applied: true, anchor, page: n2, totalPages: pc ? pc.total : null, saved, ...(saved ? {} : { warning: 'save_unconfirmed' }), docId: editor.__docId || null, shot });
  });
}

// 글자/문단 모양 다이얼로그 공통 확인 버튼(설정/확인/적용 중 하나) 클릭.
async function clickDialogApply(ed) {
  for (const b of ['설정', '확인', '적용']) { if (await clickDialogBtn(ed, b)) return true; }
  return false;
}

// char-shape: 구절을 선택해 '글자 모양' 다이얼로그로 자간/장평 등 세밀 글자 서식. (서식 › 글자 모양)
async function cmdCharShape(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  if (args.text == null || args.text === true) throw new Error('--text 필요 (서식 적용할 구절)');
  const fields = [];
  if (args.spacing !== undefined) fields.push(['자간', Math.round(Number(args.spacing))]);   // 자간(%)
  if (args.width !== undefined) fields.push(['장평', Math.round(Number(args.width))]);        // 장평(%)
  if (args['rel-size'] !== undefined) fields.push(['상대 크기', Math.round(Number(args['rel-size']))]);
  if (args.position !== undefined) fields.push(['글자 위치', Math.round(Number(args.position))]);
  if (!fields.length) throw new Error('--spacing(자간%) / --width(장평%) / --rel-size / --position 중 하나 이상');
  const apply = !!args.apply;
  if (apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다. --headed 는 보기 전용 — 편집 금지.');
  const phrase = String(args.text).normalize('NFC');
  const name = String(args.name).normalize('NFC');
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(Number(args.scale) || 1.5, async (ctx, page) => {
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('문서를 못 찾음(드라이브에 없음): ' + name);
    if (!apply) { out({ cmd: 'char-shape', dryRun: true, text: phrase, fields: Object.fromEntries(fields), docId: editor.__docId || null, note: '--apply 시 구절 선택 후 글자 모양 적용.' }); return; }
    let sel = await dragSelectPhrase(editor, phrase);
    if (!sel.found) { out({ cmd: 'char-shape', status: 'text_not_found', text: phrase, docId: editor.__docId || null }); return; }
    for (let i = 0; i < 2 && !sel.selChars; i++) sel = await dragSelectPhrase(editor, phrase);
    if (!sel.selChars) { out({ cmd: 'char-shape', status: 'selection_failed', text: phrase, docId: editor.__docId || null }); return; }
    const n = sel.page || 1;
    await openMenu(editor, '서식');
    await clickSel(editor, '.char_shape'); await editor.waitForTimeout(1000);
    for (const [label, value] of fields) { try { await setDialogField(editor, label, value); } catch (e) {} }
    await editor.waitForTimeout(200);
    const syncP = watchSave(editor);
    if (!await clickDialogApply(editor)) throw new Error('글자 모양 설정/확인 버튼 탐색 실패');
    const saved = await confirmSaved(editor, syncP);
    await gotoPage(editor, n); const rect = await detectPageRect(editor); await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_charshape_p${n}_${stamp()}.png`);
    await editor.screenshot(rect ? { path: shot, clip: rect } : { path: shot });
    out({ cmd: 'char-shape', applied: true, text: phrase, fields: Object.fromEntries(fields), selChars: sel.selChars, page: n, saved, ...(saved ? {} : { warning: 'save_unconfirmed' }), docId: editor.__docId || null, shot });
  });
}

// para-shape: 기준 단락에 캐럿을 두고 '문단 모양' 다이얼로그로 여백/간격(mm). (서식 › 문단 모양) 단락 단위.
async function cmdParaShape(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  if (!args.anchor) throw new Error('--anchor 필요 (대상 단락 안의 텍스트)');
  const fields = [];
  if (args.left !== undefined) fields.push(['왼쪽', Number(args.left)]);       // 왼쪽 여백(mm)
  if (args.right !== undefined) fields.push(['오른쪽', Number(args.right)]);    // 오른쪽 여백(mm)
  if (args.before !== undefined) fields.push(['문단 위', Number(args.before)]); // 문단 위 간격(mm)
  if (args.after !== undefined) fields.push(['문단 아래', Number(args.after)]); // 문단 아래 간격(mm)
  if (!fields.length) throw new Error('--left / --right / --before / --after 중 하나 이상 (mm)');
  const apply = !!args.apply;
  if (apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다. --headed 는 보기 전용 — 편집 금지.');
  const anchor = String(args.anchor).normalize('NFC');
  const name = String(args.name).normalize('NFC');
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(Number(args.scale) || 1.5, async (ctx, page) => {
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('문서를 못 찾음(드라이브에 없음): ' + name);
    const r = await findText(editor, anchor);
    if (!r.found || !r.caret) { out({ cmd: 'para-shape', status: 'anchor_not_found', anchor, docId: editor.__docId || null }); return; }
    const n = r.page || 1;
    if (!apply) { out({ cmd: 'para-shape', dryRun: true, anchor, fields: Object.fromEntries(fields), foundPage: n, docId: editor.__docId || null, note: '--apply 시 그 단락에 문단 모양 적용(mm).' }); return; }
    await focusBody(editor);
    await editor.mouse.click(r.caret.x, r.caret.y + 6); await editor.waitForTimeout(250); // 그 단락에 캐럿
    await openMenu(editor, '서식');
    await clickSel(editor, '.para_shape'); await editor.waitForTimeout(1000);
    for (const [label, value] of fields) { try { await setDialogField(editor, label, value); } catch (e) {} }
    await editor.waitForTimeout(200);
    const syncP = watchSave(editor);
    if (!await clickDialogApply(editor)) throw new Error('문단 모양 설정/확인 버튼 탐색 실패');
    const saved = await confirmSaved(editor, syncP);
    await gotoPage(editor, n); const rect = await detectPageRect(editor); await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_parashape_p${n}_${stamp()}.png`);
    await editor.screenshot(rect ? { path: shot, clip: rect } : { path: shot });
    out({ cmd: 'para-shape', applied: true, anchor, fields: Object.fromEntries(fields), page: n, saved, ...(saved ? {} : { warning: 'save_unconfirmed' }), docId: editor.__docId || null, shot });
  });
}

// footnote: 기준 텍스트 뒤에 각주를 달고 내용을 입력(입력 툴바 .e_foot_note → 각주 영역에 캐럿).
async function cmdFootnote(args) {
  const isEnd = args._ === 'endnote';            // endnote = 미주, footnote = 각주
  const kind = isEnd ? '미주' : '각주';
  const cmd = isEnd ? 'endnote' : 'footnote';
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  if (!args.anchor) throw new Error('--anchor 필요 (' + kind + ' 달 기준 텍스트 — 그 뒤에 ' + kind + ')');
  if (args.text == null || args.text === true) throw new Error('--text 필요 (' + kind + ' 내용)');
  const apply = !!args.apply;
  if (apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다. --headed 는 보기 전용 — 편집 금지.');
  const anchor = String(args.anchor).normalize('NFC');
  const footText = String(args.text).normalize('NFC');
  const name = String(args.name).normalize('NFC');
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(Number(args.scale) || 1.5, async (ctx, page) => {
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('문서를 못 찾음(드라이브에 없음): ' + name);
    const r = await findText(editor, anchor);
    if (!r.found || !r.caret) { out({ cmd, status: 'anchor_not_found', anchor, docId: editor.__docId || null }); return; }
    const n = r.page || 1;
    if (!apply) { out({ cmd, dryRun: true, anchor, text: footText, foundPage: n, docId: editor.__docId || null, note: '--apply 시 그 위치에 ' + kind + '.' }); return; }
    await focusBody(editor);
    await editor.mouse.click(r.caret.x, r.caret.y + 6); await editor.waitForTimeout(250); // 달 위치(앵커 끝)
    const syncP = watchSave(editor);
    // 각주/미주 = 입력 › 주석 › 각주|미주 (서브메뉴). 툴바 셀렉터는 오버플로로 숨김이라 메뉴로.
    await openMenu(editor, '입력');
    const ann = await menuItemXY(editor, '주석');
    if (!ann) throw new Error('입력 › 주석 메뉴 탐색 실패');
    await editor.mouse.move(ann.x, ann.y); await editor.waitForTimeout(700); // 서브메뉴 펼침(호버)
    const fnItem = await menuItemXY(editor, kind);
    if (!fnItem) throw new Error('주석 › ' + kind + ' 항목 탐색 실패');
    await editor.mouse.click(fnItem.x, fnItem.y);
    await editor.waitForTimeout(1000); // 주석 편집 영역 열림 + 캐럿 이동
    await editor.keyboard.type(footText, { delay: 35 }); // 주석 내용
    const saved = await confirmSaved(editor, syncP);
    await goDocStart(editor); await editor.waitForTimeout(300); await hideOverlays(editor); // 주석은 쪽/문서 끝 → 전체 캡처
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_${cmd}_${stamp()}.png`);
    await editor.screenshot({ path: shot });
    out({ cmd, applied: true, anchor, text: footText, page: n, saved, ...(saved ? {} : { warning: 'save_unconfirmed' }), docId: editor.__docId || null, shot });
  });
}

// hyperlink: 구절을 선택해 하이퍼링크(주소) 연결(입력 › 하이퍼링크 다이얼로그).
async function cmdHyperlink(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  if (args.text == null || args.text === true) throw new Error('--text 필요 (링크 걸 구절)');
  if (!args.url) throw new Error('--url 필요 (링크 주소)');
  const apply = !!args.apply;
  if (apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다. --headed 는 보기 전용 — 편집 금지.');
  const phrase = String(args.text).normalize('NFC');
  const url = String(args.url);
  const name = String(args.name).normalize('NFC');
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(Number(args.scale) || 1.5, async (ctx, page) => {
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('문서를 못 찾음(드라이브에 없음): ' + name);
    if (!apply) { out({ cmd: 'hyperlink', dryRun: true, text: phrase, url, docId: editor.__docId || null, note: '--apply 시 구절에 링크.' }); return; }
    let sel = await dragSelectPhrase(editor, phrase);
    if (!sel.found) { out({ cmd: 'hyperlink', status: 'text_not_found', text: phrase, docId: editor.__docId || null }); return; }
    for (let i = 0; i < 2 && !sel.selChars; i++) sel = await dragSelectPhrase(editor, phrase);
    if (!sel.selChars) { out({ cmd: 'hyperlink', status: 'selection_failed', text: phrase, docId: editor.__docId || null }); return; }
    const n = sel.page || 1;
    // 하이퍼링크 = 입력 › 하이퍼링크... (툴바 .hyperlink 는 숨김). 메뉴 항목 텍스트에 말줄임표 포함.
    await openMenu(editor, '입력');
    const hl = await menuItemXY(editor, '하이퍼링크...');
    if (!hl) throw new Error('입력 › 하이퍼링크... 메뉴 탐색 실패');
    await editor.mouse.click(hl.x, hl.y);
    await editor.waitForTimeout(1200); // 다이얼로그
    let fieldOk = false;
    for (const lbl of ['웹 주소', '주소', 'URL', '연결 대상', '파일 이름', '경로']) { try { await setDialogField(editor, lbl, url); fieldOk = true; break; } catch (e) {} }
    if (!fieldOk) { const ins = await dialogInputs(editor); process.stderr.write('[hlk] inputs=' + JSON.stringify(ins.map((i) => i.al)) + '\n'); throw new Error('하이퍼링크 주소 입력칸 탐색 실패'); }
    // 표시할 텍스트가 비면(메뉴 열며 선택 풀림) '넣기'가 안 먹는다 → 구절로 채워 링크가 걸리게.
    try { await setDialogField(editor, '표시할 텍스트', phrase); } catch (e) {}
    await editor.waitForTimeout(200);
    const syncP = watchSave(editor);
    let btnOk = false;
    for (const b of ['넣기', '확인', '설정', '적용']) { if (await clickDialogBtn(editor, b)) { btnOk = true; break; } }
    if (!btnOk) await editor.keyboard.press('Enter').catch(() => {}); // 버튼 못 찾으면 Enter
    const saved = await confirmSaved(editor, syncP);
    await gotoPage(editor, n); const rect = await detectPageRect(editor); await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_hyperlink_p${n}_${stamp()}.png`);
    await editor.screenshot(rect ? { path: shot, clip: rect } : { path: shot });
    out({ cmd: 'hyperlink', applied: true, text: phrase, url, selChars: sel.selChars, page: n, saved, ...(saved ? {} : { warning: 'save_unconfirmed' }), docId: editor.__docId || null, shot });
  });
}

// memo: 기준 텍스트 위치에 메모(댓글)를 달고 내용 입력(입력 › 메모, 우측 여백에 표시).
async function cmdMemo(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  if (!args.anchor) throw new Error('--anchor 필요 (메모 달 기준 텍스트)');
  if (args.text == null || args.text === true) throw new Error('--text 필요 (메모 내용)');
  const apply = !!args.apply;
  if (apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다. --headed 는 보기 전용 — 편집 금지.');
  const anchor = String(args.anchor).normalize('NFC');
  const memoText = String(args.text).normalize('NFC');
  const name = String(args.name).normalize('NFC');
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(Number(args.scale) || 1.5, async (ctx, page) => {
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('문서를 못 찾음(드라이브에 없음): ' + name);
    const r = await findText(editor, anchor);
    if (!r.found || !r.caret) { out({ cmd: 'memo', status: 'anchor_not_found', anchor, docId: editor.__docId || null }); return; }
    const n = r.page || 1;
    if (!apply) { out({ cmd: 'memo', dryRun: true, anchor, text: memoText, foundPage: n, docId: editor.__docId || null, note: '--apply 시 그 위치에 메모.' }); return; }
    await focusBody(editor);
    await editor.mouse.click(r.caret.x, r.caret.y + 6); await editor.waitForTimeout(250);
    const syncP = watchSave(editor);
    await openMenu(editor, '입력');
    const it = await menuItemXY(editor, '메모');
    if (!it) throw new Error('입력 › 메모 항목 탐색 실패');
    await editor.mouse.click(it.x, it.y); await editor.waitForTimeout(1100); // 메모 입력 영역 열림 + 캐럿
    await editor.keyboard.type(memoText, { delay: 35 });
    const saved = await confirmSaved(editor, syncP);
    await editor.waitForTimeout(300); await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_memo_${stamp()}.png`);
    await editor.screenshot({ path: shot }); // 메모는 우측 여백 → 전체 뷰포트
    out({ cmd: 'memo', applied: true, anchor, text: memoText, page: n, saved, ...(saved ? {} : { warning: 'save_unconfirmed' }), docId: editor.__docId || null, shot });
  });
}

// insert-chart: 입력 › 차트… → 종류 그리드(.e_chart_type)에서 --type N 썸네일을 단일 클릭하면 그 차트가
// 기본 데이터로 삽입되고 데이터편집 모달이 열림 → Escape로 닫아 확정. 데이터 값은 이후 chart-data로 수정.
async function cmdInsertChart(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  const apply = !!args.apply;
  if (apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다. --headed 는 보기 전용 — 편집 금지.');
  const name = String(args.name).normalize('NFC');
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(Number(args.scale) || 1.5, async (ctx, page) => {
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('문서를 못 찾음(드라이브에 없음): ' + name);
    if (args.anchor) { const r = await findText(editor, String(args.anchor).normalize('NFC')); if (!r.found) { out({ cmd: 'insert-chart', status: 'anchor_not_found', anchor: args.anchor, docId: editor.__docId || null }); return; } }
    else { await goDocStart(editor); }
    if (!apply) { out({ cmd: 'insert-chart', dryRun: true, anchor: args.anchor || null, docId: editor.__docId || null, note: '--apply 시 기본 차트 삽입.' }); return; }
    await focusBody(editor);
    if (args.anchor) { await editor.keyboard.press('End'); await editor.keyboard.press('Enter'); await editor.waitForTimeout(300); }
    const syncP = watchSave(editor);
    await openMenu(editor, '입력');
    const it = await menuItemXY(editor, '차트...');
    if (!it) throw new Error('입력 › 차트... 메뉴 탐색 실패');
    await editor.mouse.click(it.x, it.y); await editor.waitForTimeout(1100); // 다이얼로그
    // '차트 삽입' 모달 = 차트 종류 썸네일 그리드(.e_chart_type 20개). 썸네일을 '단일 클릭'하면 그 차트가
    // 삽입되고 모달이 닫힌다(더블클릭하면 삽입된 차트가 다시 데이터편집 모달로 열려버림 — 단일 클릭만).
    const typeIdx = Math.max(0, Number(args.type) || 0); // 0=세로막대(기본), 0~19
    const cxy = await editor.evaluate((idx) => { const els = [...document.querySelectorAll('.e_chart_type')].filter((e) => e.offsetParent !== null && e.getBoundingClientRect().width > 30); const el = els[Math.min(idx, els.length - 1)]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), n: els.length }; }, typeIdx);
    if (!cxy) throw new Error('차트 종류 썸네일(.e_chart_type) 탐색 실패');
    await editor.mouse.click(cxy.x, cxy.y); await editor.waitForTimeout(1500); // 썸네일 클릭 = 차트 삽입 + 데이터편집 모달
    await editor.keyboard.press('Escape').catch(() => {}); await editor.waitForTimeout(900); // 데이터편집 모달 닫아 차트 확정(기본 데이터)
    const saved = await confirmSaved(editor, syncP);
    const n = (await readCurrentPage(editor)) || 1; await gotoPage(editor, n);
    const rect = await detectPageRect(editor); await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_insertchart_${stamp()}.png`);
    await editor.screenshot(rect ? { path: shot, clip: rect } : { path: shot });
    out({ cmd: 'insert-chart', applied: true, anchor: args.anchor || null, page: n, saved, ...(saved ? {} : { warning: 'save_unconfirmed' }), shot, docId: editor.__docId || null });
  });
}

// textbox: 입력 › 글상자(그리기 모드) → 캔버스에 드래그로 글상자를 그리고 내용 입력. --anchor 근처에 배치.
async function cmdTextbox(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  if (!args.anchor) throw new Error('--anchor 필요 (글상자 놓을 근처 텍스트)');
  const apply = !!args.apply;
  if (apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다. --headed 는 보기 전용 — 편집 금지.');
  const anchor = String(args.anchor).normalize('NFC');
  const boxText = args.text != null && args.text !== true ? String(args.text).normalize('NFC') : '';
  const wrap = args.wrap != null && args.wrap !== true ? String(args.wrap).toLowerCase() : null; // 본문과의 배치
  if (wrap && !['inline', 'square', 'topbottom', 'front', 'behind'].includes(wrap)) throw new Error('--wrap 는 inline|square|topbottom|front|behind');
  const name = String(args.name).normalize('NFC');
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(Number(args.scale) || 1.5, async (ctx, page) => {
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('문서를 못 찾음(드라이브에 없음): ' + name);
    const r = await findText(editor, anchor);
    if (!r.found || !r.caret) { out({ cmd: 'textbox', status: 'anchor_not_found', anchor, docId: editor.__docId || null }); return; }
    const n = r.page || 1;
    if (!apply) { out({ cmd: 'textbox', dryRun: true, anchor, text: boxText, foundPage: n, docId: editor.__docId || null, note: '--apply 시 그 근처에 글상자.' }); return; }
    await focusBody(editor);
    const c = r.caret;
    const syncP = watchSave(editor);
    await openMenu(editor, '입력');
    const it = await menuItemXY(editor, '글상자');
    if (!it) throw new Error('입력 › 글상자 메뉴 탐색 실패');
    await editor.mouse.click(it.x, it.y); await editor.waitForTimeout(700); // 그리기 모드 진입
    // 캐럿 아래쪽에 글상자 드래그(가로 240 × 세로 110px)
    const x0 = c.x, y0 = c.y + 24;
    await editor.mouse.move(x0, y0); await editor.mouse.down();
    await editor.mouse.move(x0 + 120, y0 + 55, { steps: 6 });
    await editor.mouse.move(x0 + 240, y0 + 110, { steps: 8 }); await editor.waitForTimeout(150);
    await editor.mouse.up(); await editor.waitForTimeout(600);
    if (boxText) await editor.keyboard.type(boxText, { delay: 35 }); // 글상자 안 내용
    let saved = await confirmSaved(editor, syncP); // 글상자 생성 저장 확정
    if (wrap) {
      // 글상자 객체 선택 상태로 → 개체 속성 → 본문과의 배치 설정 → 확인
      await editor.keyboard.press('Escape').catch(() => {}); await editor.waitForTimeout(300); // 글 편집 빠져나와 객체 선택
      if (!await objMenuClick(editor, x0 + 120, y0 + 55, '개체 속성...')) throw new Error('글상자 개체 속성 진입 실패');
      await setObjectWrap(editor, wrap);
      await editor.waitForTimeout(150);
      const syncP2 = watchSave(editor);
      if (!await clickDialogApply(editor)) throw new Error('개체 속성 확인 버튼 탐색 실패');
      saved = await confirmSaved(editor, syncP2); // 배치 변경 저장 확정
    }
    await gotoPage(editor, n); const rect = await detectPageRect(editor); await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_textbox_p${n}_${stamp()}.png`);
    await editor.screenshot(rect ? { path: shot, clip: rect } : { path: shot });
    out({ cmd: 'textbox', applied: true, anchor, text: boxText, wrap, page: n, saved, ...(saved ? {} : { warning: 'save_unconfirmed' }), docId: editor.__docId || null, shot });
  });
}

// ───────────────────────── 객체(그림·차트) ─────────────────────────
// 객체는 본문 canvas 에 픽셀로 그려져 DOM 셀렉터로 못 짚는다 → 페이지 좌표(--at "x,y", 그리드 캡처 참고)에
// 클릭. 우클릭 컨텍스트 메뉴(개체 속성/데이터 편집)로 진입. --at 의 한 점이 객체 안이면 충분(중앙 권장).
// 페이지좌표(at) → 우클릭 → 메뉴 항목(itemText) 클릭. 반환 true(항목 클릭)|false(그 좌표에 객체 없음).
// 열린 '개체 속성' 다이얼로그(기본 탭)에서 본문과의 배치를 설정. inline=글자처럼 취급(체크박스),
// square=어울림 · topbottom=자리 차지 · front=글 앞으로 · behind=글 뒤로 (DIV.e_object_properties, aria-label).
async function setObjectWrap(ed, mode) {
  if (mode === 'inline') {
    const xy = await ed.evaluate(() => { for (const el of document.querySelectorAll('input[type=checkbox]')) { const lab = el.closest('label') || el.parentElement; if (lab && /글자처럼 취급/.test(lab.textContent || '')) { if (el.checked) return 'already'; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; } } return null; });
    if (!xy) throw new Error("'글자처럼 취급' 체크박스 탐색 실패");
    if (xy !== 'already') { await ed.mouse.click(xy.x, xy.y); await ed.waitForTimeout(300); }
    return;
  }
  const AL = { square: '어울림', topbottom: '자리 차지', front: '글 앞으로', behind: '글 뒤로' };
  const al = AL[mode]; if (!al) throw new Error('--wrap 는 inline|square|topbottom|front|behind');
  const xy = await ed.evaluate((label) => { for (const e of document.querySelectorAll('.e_object_properties')) { if ((e.getAttribute('aria-label') || '') === label) { const r = e.getBoundingClientRect(); if (r.width > 5 && e.offsetParent !== null) return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; } } return null; }, al);
  if (!xy) throw new Error('본문과의 배치 버튼 탐색 실패: ' + al);
  await ed.mouse.click(xy.x, xy.y); await ed.waitForTimeout(300);
}

async function objMenuClick(ed, vx, vy, itemText) {
  await ed.mouse.click(vx, vy, { button: 'right' }); await ed.waitForTimeout(900);
  const xy = await ed.evaluate((t) => {
    for (const el of document.querySelectorAll('a, div, span, li, button')) {
      if ((el.textContent || '').trim() === t && el.offsetParent !== null && el.childElementCount === 0) {
        const r = el.getBoundingClientRect(); if (r.width > 10 && r.height > 8) return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }
    }
    return null;
  }, itemText);
  if (!xy) { await ed.keyboard.press('Escape').catch(() => {}); return false; }
  await ed.mouse.click(xy.x, xy.y); await ed.waitForTimeout(1300);
  return true;
}

// object-prop: '개체 속성' 다이얼로그 한 번 열어 크기(--width/--height mm)·위치(--pos "x,y" mm, 종이 기준
// 왼쪽/위쪽)·본문과의 배치(--wrap)를 같이 설정하는 통합 op. resize-object 의 상위 호환.
// 위치 입력칸(aria-label '기준' 2개: 첫째=가로, 둘째=세로)은 떠 있는 객체에서만 활성 — 글자처럼 취급이면 불가.
// 다이얼로그 안 정확 텍스트 클릭(탭/라디오 라벨 등). leaf 아니어도 크기 필터로 선별.
async function dlgClickText(ed, text) {
  const xy = await ed.evaluate((t) => {
    let best = null;
    for (const el of document.querySelectorAll('div,span,a,li,label')) {
      if ((el.textContent || '').trim() !== t || el.offsetParent === null) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 8 && r.width < 160 && r.height > 8 && r.height < 40) best = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }
    return best;
  }, text);
  if (!xy) return false;
  await ed.mouse.click(xy.x, xy.y); await ed.waitForTimeout(500); return true;
}

// 라벨 텍스트와 같은 행(y 근접)의 콤보 ▼ 를 연다. 같은 행에 여러 개면 라벨 오른쪽 가장 가까운 것.
async function openComboNearLabel(ed, label) {
  const xy = await ed.evaluate((t) => {
    let lab = null;
    for (const el of document.querySelectorAll('div,span,label')) { if ((el.textContent || '').trim() === t && el.offsetParent !== null && el.childElementCount === 0) { lab = el.getBoundingClientRect(); break; } }
    if (!lab) return null;
    let best = null, bd = 1e9;
    for (const a of document.querySelectorAll('.btn_combo_arrow')) {
      if (a.offsetParent === null) continue;
      const r = a.getBoundingClientRect();
      if (Math.abs((r.y + r.height / 2) - (lab.y + lab.height / 2)) > 12 || r.x < lab.right) continue;
      const d = r.x - lab.right;
      if (d < bd) { bd = d; best = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }
    }
    return best;
  }, label);
  if (!xy) return false;
  await ed.mouse.click(xy.x, xy.y); await ed.waitForTimeout(800); return true;
}

// 열려 있는 색 팔레트에서 target [r,g,b] 에 가장 가까운 스와치 클릭. (font-color 팔레트와 같은 메커니즘)
async function pickNearestSwatch(ed, target) {
  const cells = await ed.evaluate(() => {
    const out = [];
    const pal = document.querySelector('.ui_color_pick');
    const scope = pal && pal.offsetParent !== null ? pal : document;
    for (const el of scope.querySelectorAll('a, li, div, span, td')) {
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.width > 22 || el.offsetParent === null) continue;
      const m = getComputedStyle(el).backgroundColor.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
      if (m) out.push({ r: +m[1], g: +m[2], b: +m[3], x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    }
    return out;
  });
  if (!cells.length) return null;
  let best = cells[0], bd = Infinity;
  for (const c of cells) { const d = (c.r - target[0]) ** 2 + (c.g - target[1]) ** 2 + (c.b - target[2]) ** 2; if (d < bd) { bd = d; best = c; } }
  await ed.mouse.click(best.x, best.y); await ed.waitForTimeout(400);
  return { r: best.r, g: best.g, b: best.b };
}

async function cmdObjectProp(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  if (!args.at) throw new Error('--at "x,y" 필요 (객체 안의 한 점, 페이지 좌표 — capture --grid 로 확인)');
  const [ax, ay] = String(args.at).split(',').map(Number);
  if ([ax, ay].some(Number.isNaN)) throw new Error('--at 형식: "x,y"');
  const W = args.width !== undefined ? Number(args.width) : null;
  const H = args.height !== undefined ? Number(args.height) : null;
  let PX = null, PY = null;
  if (args.pos !== undefined && args.pos !== true) {
    const p = String(args.pos).split(',').map(Number);
    if (p.length !== 2 || p.some(Number.isNaN)) throw new Error('--pos 형식: "x,y" (mm, 종이 왼쪽/위쪽 기준)');
    [PX, PY] = p;
  }
  const wrap = args.wrap != null && args.wrap !== true ? String(args.wrap).toLowerCase() : null;
  if (wrap && !['inline', 'square', 'topbottom', 'front', 'behind'].includes(wrap)) throw new Error('--wrap 는 inline|square|topbottom|front|behind');
  if (wrap === 'inline' && PX !== null) throw new Error('--wrap inline(글자처럼 취급)과 --pos 는 동시 사용 불가(인라인은 좌표 배치가 없음)');
  // 도형 스타일: --fill <색|none>(채우기 면 색) · --border <색>(선 색) · --border-width <mm>(선 굵기)
  const fillArg = args.fill != null && args.fill !== true ? String(args.fill).trim() : null;
  const fillNone = !!fillArg && ['none', '없음'].includes(fillArg.toLowerCase());
  const fillRGB = fillArg && !fillNone ? parseColor(fillArg) : null;
  if (fillArg && !fillNone && !fillRGB) throw new Error('--fill 색 인식 실패: ' + fillArg + ' (이름·#RRGGBB·none)');
  const borderArg = args.border != null && args.border !== true ? String(args.border).trim() : null;
  const borderRGB = borderArg ? parseColor(borderArg) : null;
  if (borderArg && !borderRGB) throw new Error('--border 색 인식 실패: ' + borderArg + ' (이름·#RRGGBB)');
  const borderW = args['border-width'] !== undefined ? Number(args['border-width']) : null;
  if (borderW !== null && Number.isNaN(borderW)) throw new Error('--border-width 는 mm 숫자');
  const apply = !!args.apply;
  if (apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다. --headed 는 보기 전용.');
  const name = String(args.name).normalize('NFC');
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(Number(args.scale) || 1.5, async (ctx, page) => {
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('문서를 못 찾음(드라이브에 없음): ' + name);
    const rect = await detectPageRect(editor);
    if (!rect || rect.width < 100) throw new Error('A4 페이지 영역 검출 실패');
    if (!await objMenuClick(editor, rect.x + ax, rect.y + ay, '개체 속성...')) {
      out({ cmd: 'object-prop', status: 'object_not_found', at: [ax, ay], docId: editor.__docId || null, note: '그 좌표에 객체 없음(우클릭 메뉴에 "개체 속성" 없음). capture --grid 로 좌표 재확인.' }); return;
    }
    // 다이얼로그 필드 읽기: 너비/높이 + 위치 '기준' 2개(문서순: 가로, 세로)
    const readFields = () => editor.evaluate(() => {
      const f = { pos: [] };
      for (const el of document.querySelectorAll('input')) {
        if (el.offsetParent === null) continue;
        const al = el.getAttribute('aria-label') || '';
        const r = el.getBoundingClientRect();
        const item = { val: el.value, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), disabled: el.disabled || el.readOnly };
        if (al === '너비' || al === '높이') f[al] = item;
        else if (al === '기준') f.pos.push(item);
      }
      return f;
    });
    let fields = await readFields();
    const cur = {
      width: fields['너비'] && fields['너비'].val, height: fields['높이'] && fields['높이'].val,
      posX: fields.pos[0] ? fields.pos[0].val : null, posY: fields.pos[1] ? fields.pos[1].val : null,
    };
    const nothing = W === null && H === null && PX === null && !wrap && !fillArg && !borderArg && borderW === null;
    const req = { width: W, height: H, pos: PX !== null ? [PX, PY] : null, wrap, fill: fillArg, border: borderArg, borderWidth: borderW };
    if (!apply || nothing) {
      await editor.keyboard.press('Escape').catch(() => {}); await editor.waitForTimeout(400);
      out({ cmd: 'object-prop', dryRun: !apply, at: [ax, ay], current: cur, requested: req, docId: editor.__docId || null,
        note: nothing ? '설정할 속성 없음 → 현재 값만 읽음(mm, 위치=종이 왼쪽/위쪽 기준).' : '--apply 시 적용. 단위 mm.' }); return;
    }
    if (wrap) { await setObjectWrap(editor, wrap); await editor.waitForTimeout(300); fields = await readFields(); } // 배치 변경 후 필드 재독(인라인 해제 시 위치칸 활성화)
    const typeInto = async (fld, value) => {
      await editor.mouse.click(fld.x, fld.y); await editor.keyboard.press('ControlOrMeta+A'); await editor.keyboard.press('Delete');
      await editor.keyboard.type(String(value), { delay: 30 }); await editor.keyboard.press('Tab');
    };
    if (W !== null && fields['너비']) await typeInto(fields['너비'], W);
    if (H !== null && fields['높이']) await typeInto(fields['높이'], H);
    if (PX !== null) {
      if (fields.pos.length < 2 || fields.pos[0].disabled) {
        await editor.keyboard.press('Escape').catch(() => {}); await editor.waitForTimeout(400);
        out({ cmd: 'object-prop', status: 'pos_unavailable', at: [ax, ay], docId: editor.__docId || null, note: '위치 입력칸이 비활성(글자처럼 취급 객체) — --wrap square 등으로 떠 있는 배치로 바꿔야 위치 지정 가능.' }); return;
      }
      await typeInto(fields.pos[0], PX);
      await typeInto(fields.pos[1], PY);
    }
    // 도형 스타일 — 채우기 탭(면 색) / 선 탭(선 색·굵기). 색은 팔레트에서 요청색에 가장 가까운 스와치.
    const styled = {};
    if (fillArg) {
      if (!await dlgClickText(editor, '채우기')) {
        await editor.keyboard.press('Escape').catch(() => {}); await editor.waitForTimeout(400);
        out({ cmd: 'object-prop', status: 'fill_unavailable', at: [ax, ay], docId: editor.__docId || null, note: "이 객체엔 '채우기' 탭이 없음(직선/호 등 선 객체) — --border 로 선 색만 가능." }); return;
      }
      if (fillNone) {
        if (!await dlgClickText(editor, '색 채우기 없음')) throw new Error("'색 채우기 없음' 선택 실패");
        styled.fill = 'none';
      } else {
        await dlgClickText(editor, '색'); // '색' 라디오(면 색 활성화)
        if (!await openComboNearLabel(editor, '면 색')) throw new Error('면 색 콤보 탐색 실패');
        const picked = await pickNearestSwatch(editor, fillRGB);
        if (!picked) throw new Error('면 색 팔레트 스와치 탐색 실패');
        styled.fill = picked;
      }
    }
    if (borderArg || borderW !== null) {
      if (!await dlgClickText(editor, '선')) throw new Error("'선' 탭 탐색 실패");
      if (borderArg) {
        if (!await openComboNearLabel(editor, '색')) throw new Error('선 색 콤보 탐색 실패');
        const picked = await pickNearestSwatch(editor, borderRGB);
        if (!picked) throw new Error('선 색 팔레트 스와치 탐색 실패');
        styled.border = picked;
      }
      if (borderW !== null) await setDialogField(editor, '굵기', borderW);
    }
    await editor.waitForTimeout(300);
    const syncP = watchSave(editor); // 적용(확인) 전에 무장
    if (!await clickDialogApply(editor)) throw new Error('개체 속성 확인 버튼 탐색 실패');
    const saved = await confirmSaved(editor, syncP);
    const n = (await readCurrentPage(editor)) || 1; await gotoPage(editor, n);
    const rect2 = await detectPageRect(editor); await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_objprop_${stamp()}.png`);
    await editor.screenshot(rect2 ? { path: shot, clip: rect2 } : { path: shot });
    out({ cmd: 'object-prop', applied: true, at: [ax, ay], before: cur, requested: req, ...(Object.keys(styled).length ? { styled } : {}), page: n, saved, ...(saved ? {} : { warning: 'save_unconfirmed' }), shot, docId: editor.__docId || null });
  });
}

// resize-object: 그림/차트 크기를 '개체 속성' 다이얼로그의 너비/높이(mm 숫자)로 설정(드래그보다 정밀).
// --at "x,y"(객체 안 한 점, 페이지좌표) · --width/--height mm(둘 중 하나만도 가능) · --apply(없으면 현재크기만 읽음).
async function cmdResizeObject(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  if (!args.at) throw new Error('--at "x,y" 필요 (객체 안의 한 점, 페이지 좌표 — capture --grid 로 확인)');
  const [ax, ay] = String(args.at).split(',').map(Number);
  if ([ax, ay].some(Number.isNaN)) throw new Error('--at 형식: "x,y"');
  const W = args.width !== undefined ? Number(args.width) : null;
  const H = args.height !== undefined ? Number(args.height) : null;
  const apply = !!args.apply;
  if (apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다. --headed 는 보기 전용.');
  const name = String(args.name).normalize('NFC');
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(Number(args.scale) || 1.5, async (ctx, page) => {
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('문서를 못 찾음(드라이브에 없음): ' + name);
    const rect = await detectPageRect(editor);
    if (!rect || rect.width < 100) throw new Error('A4 페이지 영역 검출 실패');
    const vx = rect.x + ax, vy = rect.y + ay;
    if (!await objMenuClick(editor, vx, vy, '개체 속성...')) {
      out({ cmd: 'resize-object', status: 'object_not_found', at: [ax, ay], docId: editor.__docId || null, note: '그 좌표에 객체 없음(우클릭 메뉴에 "개체 속성" 없음). capture --grid 로 좌표 재확인.' }); return;
    }
    // 개체 속성 다이얼로그의 너비/높이 입력칸(aria-label) 읽기
    const fields = await editor.evaluate(() => {
      const f = {};
      for (const el of document.querySelectorAll('input')) {
        const al = el.getAttribute('aria-label') || '';
        if (al === '너비' || al === '높이') { const r = el.getBoundingClientRect(); f[al] = { val: el.value, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }
      }
      return f;
    });
    const cur = { width: fields['너비'] && fields['너비'].val, height: fields['높이'] && fields['높이'].val };
    if (!apply || (W === null && H === null)) {
      await editor.keyboard.press('Escape').catch(() => {}); await editor.waitForTimeout(400);
      out({ cmd: 'resize-object', dryRun: !apply, at: [ax, ay], currentSize: cur, requested: { width: W, height: H }, docId: editor.__docId || null,
        note: (W === null && H === null) ? '--width/--height 없음 → 현재 크기만 읽음(mm).' : '--apply 시 적용. 단위 mm.' }); return;
    }
    const setField = async (label, value) => {
      const fld = fields[label]; if (!fld) return false;
      await editor.mouse.click(fld.x, fld.y); await editor.keyboard.press('ControlOrMeta+A'); await editor.keyboard.press('Delete');
      await editor.keyboard.type(String(value), { delay: 30 }); await editor.keyboard.press('Tab'); return true;
    };
    if (W !== null) await setField('너비', W);
    if (H !== null) await setField('높이', H);
    await editor.waitForTimeout(300);
    const okXY = await editor.evaluate(() => { for (const el of document.querySelectorAll('a, button, div, span')) { const t = (el.textContent || '').trim(); if (t === '확인' && el.offsetParent !== null && el.childElementCount === 0) { const r = el.getBoundingClientRect(); if (r.width > 15 && r.height > 10) return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; } } return null; });
    const syncP = watchSave(editor); // 크기 적용(확인) 전에 무장
    if (okXY) await editor.mouse.click(okXY.x, okXY.y); else await editor.keyboard.press('Enter').catch(() => {});
    const saved = await confirmSaved(editor, syncP); // 개체 크기 변경 후 저장 확정
    const n = (await readCurrentPage(editor)) || 1; await gotoPage(editor, n);
    const rect2 = await detectPageRect(editor); await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_resizeobj_${stamp()}.png`);
    await editor.screenshot(rect2 ? { path: shot, clip: rect2 } : { path: shot });
    out({ cmd: 'resize-object', applied: true, at: [ax, ay], before: cur, after: { width: W !== null ? W : cur.width, height: H !== null ? H : cur.height }, page: n, saved, ...(saved ? {} : { warning: 'save_unconfirmed' }), shot, docId: editor.__docId || null });
  });
}

// chart-data: 차트의 '데이터 편집' 스프레드시트(DOM 그리드)에서 셀 값을 바꾼다 → 차트가 갱신됨.
// --at "x,y"(차트 안 한 점) · --set "B2=9.9,C3=4"(엑셀식 열문자+행번호=값, 콤마구분) · --apply.
// 셀 위치 = 열 헤더(A~D)의 x ∩ 행 헤더(1~N)의 y. 더블클릭 → 전체선택 → 타이핑 → Enter.
async function cmdChartData(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  if (!args.at) throw new Error('--at "x,y" 필요 (차트 안의 한 점, 페이지 좌표)');
  if (!args.set) throw new Error('--set "B2=9.9,C3=4" 필요 (엑셀식 셀=값)');
  const [ax, ay] = String(args.at).split(',').map(Number);
  if ([ax, ay].some(Number.isNaN)) throw new Error('--at 형식: "x,y"');
  const sets = String(args.set).split(',').map((s) => { const m = s.trim().match(/^([A-Za-z]+)(\d+)\s*=\s*(.+)$/); return m ? { col: m[1].toUpperCase(), row: Number(m[2]), value: m[3].trim() } : null; }).filter(Boolean);
  if (!sets.length) throw new Error('--set 파싱 실패. 예: "B2=9.9,C3=4"');
  const apply = !!args.apply;
  if (apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다.');
  const name = String(args.name).normalize('NFC');
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(Number(args.scale) || 1.5, async (ctx, page) => {
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('문서를 못 찾음(드라이브에 없음): ' + name);
    const rect = await detectPageRect(editor);
    if (!rect || rect.width < 100) throw new Error('A4 페이지 영역 검출 실패');
    if (!await objMenuClick(editor, rect.x + ax, rect.y + ay, '데이터 편집')) {
      out({ cmd: 'chart-data', status: 'chart_not_found', at: [ax, ay], docId: editor.__docId || null, note: '그 좌표에 차트 없음(우클릭 메뉴에 "데이터 편집" 없음). capture --grid 로 좌표 재확인.' }); return;
    }
    // 데이터 그리드 셀 좌표 = 열 헤더(A~D) x ∩ 행 헤더(숫자) y
    const cellXY = (col, rownum) => editor.evaluate(({ col, rownum }) => {
      const leaves = [...document.querySelectorAll('td, th, div, span')].filter((el) => el.childElementCount === 0 && el.offsetParent !== null);
      // 그리드 셀 크기(폭~79·높이~28)로 거름 — 툴바/페이지의 동일 글자(작은 요소)를 제외해야 행/열 헤더만 잡힌다.
      const pick = (txt) => leaves.filter((el) => (el.textContent || '').trim() === txt).map((el) => { const r = el.getBoundingClientRect(); return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2), w: r.width, h: r.height }; }).filter((e) => e.w > 55 && e.w < 140 && e.h > 18 && e.h < 42);
      const colEls = pick(col).sort((a, b) => a.cy - b.cy);     // 열 헤더 = 가장 위
      const rowEls = pick(String(rownum)).sort((a, b) => a.cx - b.cx); // 행 헤더 = 가장 왼쪽
      if (!colEls.length || !rowEls.length) return null;
      return { x: colEls[0].cx, y: rowEls[0].cy };
    }, { col, rownum });
    if (!apply) {
      await editor.keyboard.press('Escape').catch(() => {}); await editor.waitForTimeout(500);
      out({ cmd: 'chart-data', dryRun: true, at: [ax, ay], sets, docId: editor.__docId || null, note: '--apply 시 각 셀에 값 입력. 좌표는 열문자∩행번호.' }); return;
    }
    const done = [];
    const syncP = watchSave(editor); // 차트 데이터 변경 전에 무장(모달 닫을 때 동기화 떠도 놓치지 않게)
    for (const s of sets) {
      const xy = await cellXY(s.col, s.row);
      if (!xy) { done.push({ ...s, ok: false, why: 'cell_not_located' }); continue; }
      await editor.mouse.dblclick(xy.x, xy.y); await editor.waitForTimeout(350);
      await editor.keyboard.press('ControlOrMeta+A'); await editor.keyboard.type(s.value, { delay: 35 }); await editor.keyboard.press('Enter'); await editor.waitForTimeout(500);
      done.push({ ...s, ok: true });
    }
    await editor.keyboard.press('Escape').catch(() => {}); // 모달 닫기
    const saved = await confirmSaved(editor, syncP); // 차트 데이터 변경 후 저장 확정
    const n = (await readCurrentPage(editor)) || 1; await gotoPage(editor, n);
    const rect2 = await detectPageRect(editor); await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_chartdata_${stamp()}.png`);
    await editor.screenshot(rect2 ? { path: shot, clip: rect2 } : { path: shot });
    out({ cmd: 'chart-data', applied: true, at: [ax, ay], set: done, page: n, saved, ...(saved ? {} : { warning: 'save_unconfirmed' }), shot, docId: editor.__docId || null });
  });
}

// download: 드라이브 문서를 로컬 .hwp/.hwpx 로 내려받기. 편집기를 열어(openDoc — docId 신원확인으로
// 동명 오행 차단) 파일›다운로드(.d_download)를 누르고 download 이벤트를 저장. 원본 형식 그대로(변환 없음).
// read.mjs 가 읽으려면 로컬 파일 필요 — 드라이브 '현재 상태'를 받아와야 stale 안 됨(편집 후 재읽기 시 재다운로드).
async function cmdDownload(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  const name = String(args.name).normalize('NFC');
  fs.mkdirSync(DLDIR, { recursive: true });
  const browser = await chromium.launch({ headless: !HEADED, slowMo: SLOWMO });
  const ctx = await browser.newContext({ storageState: AUTH, viewport: VIEW, deviceScaleFactor: 1, acceptDownloads: true });
  try {
    const page = await ctx.newPage();
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('드라이브에서 문서 못 찾음: ' + name);
    // 메뉴바 '파일' 탭 열기 (텍스트로 탭 위치 탐색 — 좌표 하드코딩 회피)
    const fileTab = await editor.evaluate(() => {
      for (const el of document.querySelectorAll('*')) {
        const t = (el.textContent || '').trim();
        if (t === '파일' && el.childElementCount === 0) { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0 && r.top < 140) return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }
      }
      return null;
    });
    if (!fileTab) throw new Error('파일 메뉴 탐색 실패');
    await editor.mouse.click(fileTab.x, fileTab.y); await editor.waitForTimeout(800);
    // 파일 메뉴의 '다운로드' 항목(.d_download) — 원본 형식 직접 다운로드('준비 중' 토스트만, 형식선택 없음)
    const dlXY = await editor.evaluate(() => { const el = document.querySelector('.d_download'); if (!el || el.offsetParent === null) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; });
    if (!dlXY) throw new Error('.d_download 탐색 실패(파일 메뉴 안 열림)');
    const [download] = await Promise.all([
      editor.waitForEvent('download', { timeout: 60000 }),
      editor.mouse.click(dlXY.x, dlXY.y),
    ]);
    const suggested = download.suggestedFilename();
    const dest = args.out ? path.resolve(args.out) : path.join(DLDIR, suggested);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await download.saveAs(dest);
    out({ cmd: 'download', name, saved: dest, suggestedFilename: suggested, bytes: fs.statSync(dest).size, docId: editor.__docId || null });
  } finally { await browser.close(); }
}

// upload: 로컬 파일을 드라이브에 올림(새 문서로). 이후 --name <파일명> 으로 open/capture/edit/download.
// ⚠️ 같은 이름이어도 '교체'가 아니라 새 항목 생성(중복) — 편집은 UI 에서(자동저장), 로컬을 다시 올릴 필요는 보통 없음.
async function cmdUpload(args) {
  if (!args.file) throw new Error('--file 필요 (업로드할 로컬 파일 경로)');
  const file = path.resolve(args.file);
  if (!fs.existsSync(file)) throw new Error('파일 없음: ' + file);
  const browser = await chromium.launch({ headless: !HEADED, slowMo: SLOWMO });
  const ctx = await browser.newContext({ storageState: AUTH, viewport: VIEW, deviceScaleFactor: 1, acceptDownloads: true });
  try {
    const page = await ctx.newPage();
    await uploadFile(page, file);
    const name = path.basename(file).normalize('NFC');
    out({ cmd: 'upload', file, name, note: `드라이브에 올림 — 이후 --name "${name}" 으로 사용.` });
  } finally { await browser.close(); }
}

// 오른쪽 개체 사이드바(.side_bar)가 열려 있으면 닫는다. 사이드바는 객체 포커스가 풀려도 남아 본문을
// 왼쪽으로 밀어 캡처/좌표를 틀어지게 하므로(차트 더블클릭 등에서 열림), 캡처 전에 닫아 정상 레이아웃 보장.
async function closeSidebar(ed) {
  const xy = await ed.evaluate(() => {
    const sb = document.querySelector('.side_bar');
    if (!sb || sb.offsetParent === null) return null;
    const sr = sb.getBoundingClientRect();
    if (sr.width < 60) return null; // 이미 접힘
    // 사이드바 상단 우측의 접기('>') 버튼
    let best = null;
    for (const e of sb.querySelectorAll('a,button,div,span,i')) { if (e.childElementCount > 1) continue; const r = e.getBoundingClientRect(); if (r.y < sr.top + 42 && r.right > sr.right - 44 && r.width > 6 && r.width < 42 && r.height > 6 && r.height < 42) best = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }
    return best;
  }).catch(() => null);
  if (xy) { await ed.mouse.click(xy.x, xy.y); await ed.waitForTimeout(500); return true; }
  return false;
}

// equation: 입력 › 수식. 앵커 줄 다음에 한컴 수식 스크립트(--script, 예 "x^2 + y^2 = z^2")로 수식을 넣는다.
// 수식 편집기 하단 입력영역에 스크립트를 타이핑하면 렌더되고, 편집기를 닫으면(.close_btn) 본문에 확정.
async function cmdEquation(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  if (!args.anchor) throw new Error('--anchor 필요 (수식 넣을 기준 텍스트 — 그 줄 다음)');
  if (args.script == null || args.script === true) throw new Error('--script 필요 (한컴 수식 스크립트, 예 "x^2 + y^2")');
  const apply = !!args.apply;
  if (apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다. --headed 는 보기 전용 — 편집 금지.');
  const anchor = String(args.anchor).normalize('NFC');
  const script = String(args.script).normalize('NFC');
  const name = String(args.name).normalize('NFC');
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(Number(args.scale) || 1.5, async (ctx, page) => {
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('문서를 못 찾음(드라이브에 없음): ' + name);
    const r = await findText(editor, anchor);
    if (!r.found || !r.caret) { out({ cmd: 'equation', status: 'anchor_not_found', anchor, docId: editor.__docId || null }); return; }
    const n = r.page || 1;
    if (!apply) { out({ cmd: 'equation', dryRun: true, anchor, script, foundPage: n, docId: editor.__docId || null, note: '--apply 시 그 줄 다음에 수식 삽입.' }); return; }
    await focusBody(editor);
    await editor.mouse.click(r.caret.x, r.caret.y + Math.round((r.caret.h || 12) / 2)); await editor.waitForTimeout(250);
    await editor.keyboard.press('End'); await editor.keyboard.press('Enter'); await editor.waitForTimeout(200);
    await openMenu(editor, '입력');
    let opened = false;
    try { await clickSel(editor, '.show_eqeditor'); opened = true; } catch (e) { /* 메뉴 텍스트 폴백 */ }
    if (!opened) { for (const t of ['수식...', '수식…', '수식']) { const it = await menuItemXY(editor, t); if (it) { await editor.mouse.click(it.x, it.y); opened = true; break; } } }
    if (!opened) throw new Error('입력 › 수식 항목 탐색 실패');
    // 수식 편집기는 별도 iframe(formula_editor). 그 프레임의 스크립트 입력칸(textarea.textarea_box)에 직접 입력.
    let ef = null;
    for (let i = 0; i < 12 && !ef; i++) { ef = editor.frames().find((f) => (f.url() || '').includes('formula_editor')); if (!ef) await editor.waitForTimeout(300); }
    if (!ef) throw new Error('수식 편집기 프레임 탐색 실패');
    const ta = ef.locator('.textarea_box');
    const norm = (s) => s.replace(/\s+/g, '');
    // 입력칸에 스크립트 타이핑 → 실제로 들어갔는지 확인(클릭 빗나감 대비 1회 재시도)
    let typed = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      await ta.click({ timeout: 3000 }).catch(() => {});
      await ta.fill('').catch(() => {});
      await editor.keyboard.type(script, { delay: 28 }); await editor.waitForTimeout(400);
      typed = (await ta.inputValue().catch(() => '')) || '';
      if (norm(typed) === norm(script)) break;
    }
    if (norm(typed) !== norm(script)) throw new Error('수식 스크립트 입력 실패(입력칸 미반영): "' + typed.slice(0, 40) + '"');
    // 편집기 닫기(.close_btn, 모달 chrome=메인 프레임) → 확인 대화상자 넣기
    const closed = await editor.evaluate(() => {
      const t = [...document.querySelectorAll('*')].find((e) => (e.textContent || '').trim() === '수식 편집' && e.childElementCount === 0);
      const tr = t ? t.getBoundingClientRect() : null;
      let best = null, bestD = 1e9;
      for (const b of document.querySelectorAll('.close_btn')) { if (b.offsetParent === null) continue; const r = b.getBoundingClientRect(); if (r.width < 6) continue; if (tr) { if (Math.abs(r.top - tr.top) > 40) continue; const d = Math.abs(r.left - tr.right); if (d < bestD) { bestD = d; best = r; } } else best = r; }
      return best ? { x: Math.round(best.x + best.width / 2), y: Math.round(best.y + best.height / 2) } : null;
    });
    if (!closed) throw new Error('수식 편집기 닫기 버튼(.close_btn) 탐색 실패');
    // 닫기(.close_btn) → '수식을 넣을까요?' 확인 대화상자(또 다른 프레임)의 넣기 → '수식 편집' 모달이 닫힘(=확정).
    // confirmSaved는 줄바꿈 동기화를 수식 저장으로 오인하므로 신뢰하지 않고, 모달이 사라졌는지로 실제 반영을 확인한다.
    // (formula 편집기 iframe은 재사용되어 DOM에 남으므로 '프레임 소멸'은 신호로 못 씀 → 모달 타이틀 가시성으로 판정.)
    const modalOpen = () => editor.evaluate(() => { const t = [...document.querySelectorAll('*')].find((e) => (e.textContent || '').trim() === '수식 편집' && e.childElementCount === 0); return !!(t && t.offsetParent !== null); }).catch(() => true);
    // 수식 '확정(넣기)' 직전에 저장 감시를 다시 무장 — 그래야 앞선 줄바꿈 동기화가 아니라 '수식 삽입' 저장을 기다린다.
    // (이걸 안 하면 줄바꿈 sync로 confirmSaved가 일찍 끝나 수식이 flush 전에 브라우저가 닫혀 유실됨 = 미반영인데 applied 오보.)
    const syncP2 = watchSave(editor);
    let committed = false;
    for (let attempt = 0; attempt < 2 && !committed; attempt++) {
      await editor.mouse.click(closed.x, closed.y); await editor.waitForTimeout(700);
      let put = false;
      for (let i = 0; i < 8 && !put; i++) {
        for (const fr of editor.frames()) { const loc = fr.getByText('넣기', { exact: true }); if (await loc.count().catch(() => 0)) { await loc.first().click({ timeout: 2000 }).catch(() => {}); put = true; break; } }
        if (put) break;
        await editor.waitForTimeout(300);
      }
      if (!put && attempt === 1) throw new Error("수식 확정 '넣기' 버튼 탐색 실패");
      for (let i = 0; i < 10 && !committed; i++) { await editor.waitForTimeout(300); committed = !(await modalOpen()); }
    }
    if (!committed) throw new Error('수식 확정 실패(편집기가 안 닫힘 — 본문 미반영)');
    const saved = await confirmSaved(editor, syncP2, { settleMs: 650 }); // 수식 삽입 저장 확정(넉넉히 settle)
    const n2 = (await readCurrentPage(editor)) || n; await gotoPage(editor, n2);
    const rect = await detectPageRect(editor); await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_equation_p${n2}_${stamp()}.png`);
    await editor.screenshot(rect ? { path: shot, clip: rect } : { path: shot });
    out({ cmd: 'equation', applied: true, anchor, script, page: n2, saved, ...(saved ? {} : { warning: 'save_unconfirmed' }), docId: editor.__docId || null, shot });
  });
}

// caption: 입력 › 캡션 넣기. 페이지 좌표 --at 의 객체(그림/표/차트/도형)를 선택해 캡션을 단다.
// --position: 아래(기본)·위·왼쪽 위/가운데/아래·오른쪽 위/가운데/아래. --text 로 캡션 내용 지정.
const CAPTION_POS = { below: '아래', above: '위', left: '왼쪽 가운데', right: '오른쪽 가운데' };
async function cmdCaption(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  if (!args.at) throw new Error('--at "x,y" 필요 (객체 안의 한 점, 페이지 좌표 — capture --grid 로 확인)');
  if (args.text == null || args.text === true) throw new Error('--text 필요 (캡션 내용)');
  const [ax, ay] = String(args.at).split(',').map(Number);
  if ([ax, ay].some(Number.isNaN)) throw new Error('--at 형식: "x,y"');
  const text = String(args.text).normalize('NFC');
  // --position: 영문 별칭 또는 한글 서브메뉴 텍스트 그대로
  const posArg = args.position != null && args.position !== true ? String(args.position) : 'below';
  const posLabel = CAPTION_POS[posArg.toLowerCase()] || posArg.normalize('NFC');
  const apply = !!args.apply;
  if (apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다. --headed 는 보기 전용 — 편집 금지.');
  const name = String(args.name).normalize('NFC');
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(Number(args.scale) || 1.5, async (ctx, page) => {
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('문서를 못 찾음(드라이브에 없음): ' + name);
    const rect = await detectPageRect(editor);
    if (!rect || rect.width < 100) throw new Error('A4 페이지 영역 검출 실패');
    if (!apply) { out({ cmd: 'caption', dryRun: true, at: [ax, ay], text, position: posLabel, docId: editor.__docId || null, note: '--apply 시 그 객체에 캡션.' }); return; }
    await focusBody(editor);
    const vx = rect.x + ax, vy = rect.y + ay;
    await editor.mouse.click(vx, vy); await editor.waitForTimeout(500); // 객체 선택
    const syncP = watchSave(editor);
    await openMenu(editor, '입력');
    const cap = await editor.evaluate(() => { for (const el of document.querySelectorAll('div,span,li,a')) { if ((el.textContent || '').trim() === '캡션 넣기' && el.childElementCount === 0 && el.offsetParent !== null) { const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; } } return null; });
    if (!cap) { await editor.keyboard.press('Escape').catch(() => {}); out({ cmd: 'caption', status: 'object_not_selected', at: [ax, ay], docId: editor.__docId || null, note: '그 좌표에 객체 없음(캡션 넣기 비활성). capture --grid 로 좌표 재확인.' }); return; }
    await editor.mouse.move(cap.x, cap.y); await editor.waitForTimeout(800); // 서브메뉴 펼침
    const sub = await menuItemXY(editor, posLabel);
    if (!sub) throw new Error('캡션 위치 항목 탐색 실패: ' + posLabel);
    await editor.mouse.click(sub.x, sub.y); await editor.waitForTimeout(900); // 캡션 삽입 + 캡션 편집 포커스
    // 캡션 자리에 기본 텍스트(번호 등)가 선택돼 있음 → 모두 선택 후 교체
    await editor.keyboard.press('ControlOrMeta+A'); await editor.keyboard.type(text, { delay: 35 });
    await editor.keyboard.press('Escape').catch(() => {}); await editor.waitForTimeout(300);
    const saved = await confirmSaved(editor, syncP);
    const n = (await readCurrentPage(editor)) || 1; await gotoPage(editor, n);
    const rect2 = await detectPageRect(editor); await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_caption_p${n}_${stamp()}.png`);
    await editor.screenshot(rect2 ? { path: shot, clip: rect2 } : { path: shot });
    out({ cmd: 'caption', applied: true, at: [ax, ay], text, position: posLabel, page: n, saved, ...(saved ? {} : { warning: 'save_unconfirmed' }), docId: editor.__docId || null, shot });
  });
}

// shape: 입력 › 도형(그리기 개체). 앵커 근처 본문 canvas에 도형을 드래그로 그린다.
// --shape rect|ellipse|line|arc (가로 글상자는 textbox 사용). 선택 후 캔버스 드래그 → 도형 생성.
const SHAPE_TITLES = { rect: '직사각형', ellipse: '타원', line: '직선', arc: '호' };
async function cmdShape(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  if (!args.anchor) throw new Error('--anchor 필요 (도형 놓을 근처 텍스트)');
  const shape = args.shape != null && args.shape !== true ? String(args.shape).toLowerCase() : 'rect';
  if (!SHAPE_TITLES[shape]) throw new Error('--shape 는 rect|ellipse|line|arc');
  const apply = !!args.apply;
  if (apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다. --headed 는 보기 전용 — 편집 금지.');
  const wrap = args.wrap != null && args.wrap !== true ? String(args.wrap).toLowerCase() : null;
  if (wrap && !['inline', 'square', 'topbottom', 'front', 'behind'].includes(wrap)) throw new Error('--wrap 는 inline|square|topbottom|front|behind');
  const anchor = String(args.anchor).normalize('NFC');
  const name = String(args.name).normalize('NFC');
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(Number(args.scale) || 1.5, async (ctx, page) => {
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('문서를 못 찾음(드라이브에 없음): ' + name);
    const r = await findText(editor, anchor);
    if (!r.found || !r.caret) { out({ cmd: 'shape', status: 'anchor_not_found', anchor, docId: editor.__docId || null }); return; }
    const n = r.page || 1;
    if (!apply) { out({ cmd: 'shape', dryRun: true, anchor, shape, foundPage: n, docId: editor.__docId || null, note: '--apply 시 그 근처에 도형 그리기.' }); return; }
    await focusBody(editor);
    const c = r.caret;
    const syncP = watchSave(editor);
    await openMenu(editor, '입력');
    const it = await menuItemXY(editor, '도형');
    if (!it) throw new Error('입력 › 도형 메뉴 탐색 실패');
    await editor.mouse.move(it.x, it.y); await editor.waitForTimeout(800); // 서브메뉴(그리기 개체) 펼침
    const title = SHAPE_TITLES[shape];
    const sxy = await editor.evaluate((t) => { for (const el of document.querySelectorAll('.s_insert_shape')) { if ((el.getAttribute('title') || '') === t && el.offsetParent !== null) { const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; } } return null; }, title);
    if (!sxy) throw new Error('도형 종류 탐색 실패: ' + title);
    await editor.mouse.click(sxy.x, sxy.y); await editor.waitForTimeout(600); // 그리기 모드 진입
    // 캐럿 아래쪽에 도형 드래그. 선/호는 대각선, 사각형/타원은 박스.
    const x0 = c.x, y0 = c.y + 26;
    await editor.mouse.move(x0, y0); await editor.mouse.down();
    await editor.mouse.move(x0 + 100, y0 + 45, { steps: 6 });
    await editor.mouse.move(x0 + 200, y0 + 90, { steps: 8 }); await editor.waitForTimeout(150);
    await editor.mouse.up(); await editor.waitForTimeout(600);
    let saved = await confirmSaved(editor, syncP);
    if (wrap) {
      await editor.keyboard.press('Escape').catch(() => {}); await editor.waitForTimeout(300);
      if (!await objMenuClick(editor, x0 + 100, y0 + 45, '개체 속성...')) throw new Error('도형 개체 속성 진입 실패');
      await setObjectWrap(editor, wrap); await editor.waitForTimeout(150);
      const syncP2 = watchSave(editor);
      if (!await clickDialogApply(editor)) throw new Error('개체 속성 확인 버튼 탐색 실패');
      saved = await confirmSaved(editor, syncP2);
    }
    await editor.keyboard.press('Escape').catch(() => {});
    await gotoPage(editor, n); const rect = await detectPageRect(editor); await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_shape_p${n}_${stamp()}.png`);
    await editor.screenshot(rect ? { path: shot, clip: rect } : { path: shot });
    out({ cmd: 'shape', applied: true, anchor, shape, wrap, page: n, saved, ...(saved ? {} : { warning: 'save_unconfirmed' }), docId: editor.__docId || null, shot });
  });
}

// bookmark: 입력 › 책갈피. 앵커 위치에 이름표(책갈피)를 단다 — 본문엔 안 보이고 이동(이동 대상)용.
async function cmdBookmark(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  if (!args.anchor) throw new Error('--anchor 필요 (책갈피 달 기준 텍스트)');
  if (args['mark-name'] == null || args['mark-name'] === true) throw new Error('--mark-name 필요 (책갈피 이름)');
  const apply = !!args.apply;
  if (apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다. --headed 는 보기 전용 — 편집 금지.');
  const anchor = String(args.anchor).normalize('NFC');
  const markName = String(args['mark-name']).normalize('NFC');
  const name = String(args.name).normalize('NFC');
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(Number(args.scale) || 1.5, async (ctx, page) => {
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('문서를 못 찾음(드라이브에 없음): ' + name);
    const r = await findText(editor, anchor);
    if (!r.found || !r.caret) { out({ cmd: 'bookmark', status: 'anchor_not_found', anchor, docId: editor.__docId || null }); return; }
    const n = r.page || 1;
    if (!apply) { out({ cmd: 'bookmark', dryRun: true, anchor, markName, foundPage: n, docId: editor.__docId || null, note: '--apply 시 그 위치에 책갈피(이름표) 삽입.' }); return; }
    await focusBody(editor);
    await editor.mouse.click(r.caret.x, r.caret.y + Math.round((r.caret.h || 12) / 2)); await editor.waitForTimeout(300);
    const syncP = watchSave(editor);
    await openMenu(editor, '입력');
    let opened = false;
    try { await clickSel(editor, '.bookmark'); opened = true; } catch (e) { /* 메뉴 텍스트 폴백 */ }
    if (!opened) { for (const t of ['책갈피...', '책갈피…', '책갈피']) { const it = await menuItemXY(editor, t); if (it) { await editor.mouse.click(it.x, it.y); opened = true; break; } } }
    if (!opened) throw new Error('책갈피 항목 탐색 실패');
    await editor.waitForTimeout(1100);
    // 책갈피 이름 입력칸: aria-label 후보들 → 실패 시 다이얼로그 내 첫 텍스트 input
    let filled = false;
    for (const lab of ['책갈피 이름', '이름', '책갈피']) { try { await setDialogField(editor, lab, markName); filled = true; break; } catch (e) {} }
    if (!filled) { await editor.keyboard.type(markName, { delay: 30 }); } // 보통 이름칸 자동 포커스
    let inserted = false;
    for (const b of ['넣기', '추가', '설정', '확인']) { if (await clickDialogBtn(editor, b)) { inserted = true; break; } }
    if (!inserted) throw new Error('책갈피 삽입 버튼(넣기) 탐색 실패');
    await editor.waitForTimeout(500);
    const saved = await confirmSaved(editor, syncP);
    out({ cmd: 'bookmark', applied: true, anchor, markName, page: n, saved, ...(saved ? {} : { warning: 'save_unconfirmed' }), docId: editor.__docId || null, note: '책갈피는 본문에 안 보임 — .hwpx는 다운로드 후 read.mjs --bookmarks로 확인. (.hwp는 read.mjs가 못 읽어 0으로 나올 수 있음 — 삽입은 됨.)' });
  });
}

// field: 입력 › 필드 입력(누름틀). 앵커 줄 끝에 '클릭해 내용을 채우는 양식 자리(누름틀)'를 삽입한다.
// --guide = 자리에 표시될 안내문(예: "이름을 입력하세요"), --field-name = 필드 이름(선택, 양식 식별용).
async function cmdField(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  if (!args.anchor) throw new Error('--anchor 필요 (누름틀 넣을 기준 텍스트 — 그 줄 끝)');
  const apply = !!args.apply;
  if (apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다. --headed 는 보기 전용 — 편집 금지.');
  const anchor = String(args.anchor).normalize('NFC');
  const guide = args.guide != null && args.guide !== true ? String(args.guide).normalize('NFC') : null;
  const fieldName = args['field-name'] != null && args['field-name'] !== true ? String(args['field-name']).normalize('NFC') : null;
  const name = String(args.name).normalize('NFC');
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(Number(args.scale) || 1.5, async (ctx, page) => {
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('문서를 못 찾음(드라이브에 없음): ' + name);
    const r = await findText(editor, anchor);
    if (!r.found || !r.caret) { out({ cmd: 'field', status: 'anchor_not_found', anchor, docId: editor.__docId || null }); return; }
    const n = r.page || 1;
    if (!apply) { out({ cmd: 'field', dryRun: true, anchor, guide, fieldName, foundPage: n, docId: editor.__docId || null, note: '--apply 시 그 줄 끝에 누름틀(양식 자리) 삽입.' }); return; }
    await focusBody(editor);
    await editor.mouse.click(r.caret.x, r.caret.y + Math.round((r.caret.h || 12) / 2)); await editor.waitForTimeout(300);
    await editor.keyboard.press('End'); await editor.waitForTimeout(150);
    const syncP = watchSave(editor);
    await openMenu(editor, '입력');
    let opened = false;
    try { await clickSel(editor, '.field'); opened = true; } catch (e) { /* 메뉴 텍스트 폴백 */ }
    if (!opened) { for (const t of ['필드 입력...', '필드 입력…', '필드 입력']) { const it = await menuItemXY(editor, t); if (it) { await editor.mouse.click(it.x, it.y); opened = true; break; } } }
    if (!opened) throw new Error('필드 입력 항목 탐색 실패');
    await editor.waitForTimeout(1100);
    if (guide != null) { try { await setDialogField(editor, '입력할 내용의 안내문', guide); } catch (e) {} }
    if (fieldName != null) { try { await setDialogField(editor, '필드 이름', fieldName); } catch (e) {} }
    if (!await clickDialogBtn(editor, '넣기')) throw new Error("필드 입력 '넣기' 버튼 탐색 실패");
    await editor.waitForTimeout(600);
    const saved = await confirmSaved(editor, syncP);
    const n2 = (await readCurrentPage(editor)) || n; await gotoPage(editor, n2);
    const rect = await detectPageRect(editor); await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_field_p${n2}_${stamp()}.png`);
    await editor.screenshot(rect ? { path: shot, clip: rect } : { path: shot });
    out({ cmd: 'field', applied: true, anchor, guide, fieldName, page: n2, saved, ...(saved ? {} : { warning: 'save_unconfirmed' }), docId: editor.__docId || null, shot });
  });
}

// para-line: 입력 › 문단 띠. 앵커 줄 다음에 새 단락을 만들고 가로 구분선(문단 띠)을 넣는다.
async function cmdParaLine(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  if (!args.anchor) throw new Error('--anchor 필요 (문단 띠 넣을 기준 텍스트 — 그 줄 다음에 삽입)');
  const apply = !!args.apply;
  if (apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다. --headed 는 보기 전용 — 편집 금지.');
  const anchor = String(args.anchor).normalize('NFC');
  const name = String(args.name).normalize('NFC');
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(Number(args.scale) || 1.5, async (ctx, page) => {
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('문서를 못 찾음(드라이브에 없음): ' + name);
    const r = await findText(editor, anchor);
    if (!r.found || !r.caret) { out({ cmd: 'para-line', status: 'anchor_not_found', anchor, docId: editor.__docId || null }); return; }
    const n = r.page || 1;
    if (!apply) { out({ cmd: 'para-line', dryRun: true, anchor, foundPage: n, docId: editor.__docId || null, note: '--apply 시 그 줄 다음에 문단 띠(가로 구분선) 삽입.' }); return; }
    await focusBody(editor);
    await editor.mouse.click(r.caret.x, r.caret.y + Math.round((r.caret.h || 12) / 2)); await editor.waitForTimeout(300);
    await editor.keyboard.press('End'); await editor.keyboard.press('Enter'); await editor.waitForTimeout(200); // 다음 줄(새 단락)
    const syncP = watchSave(editor);
    await openMenu(editor, '입력');
    let clicked = false;
    try { await clickSel(editor, '.s_insert_line'); clicked = true; } catch (e) { /* 메뉴 텍스트 폴백 */ }
    if (!clicked) { const it = await menuItemXY(editor, '문단 띠'); if (!it) throw new Error('문단 띠 항목 탐색 실패'); await editor.mouse.click(it.x, it.y); }
    await editor.waitForTimeout(800);
    const saved = await confirmSaved(editor, syncP);
    const n2 = (await readCurrentPage(editor)) || n; await gotoPage(editor, n2);
    const rect = await detectPageRect(editor); await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_paraline_p${n2}_${stamp()}.png`);
    await editor.screenshot(rect ? { path: shot, clip: rect } : { path: shot });
    out({ cmd: 'para-line', applied: true, anchor, page: n2, saved, ...(saved ? {} : { warning: 'save_unconfirmed' }), docId: editor.__docId || null, shot });
  });
}

async function cmdFind(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  if (args.text == null || args.text === true) throw new Error('--text 필요 (찾을 구절)');
  const phrase = String(args.text).normalize('NFC');
  await withEditor(1.5, async (ctx, page) => {
    const name = String(args.name).normalize('NFC');
    const editor = await openDoc(ctx, page, name);
    if (!editor) throw new Error('문서를 못 찾음(드라이브에 없음): ' + name);
    const occ = await findOccurrences(editor, phrase);
    out({
      cmd: 'find', text: phrase, matchCount: occ.length,
      occurrences: occ.slice(0, 40).map((o) => ({ nth: o.nth, page: o.page, docY: o.docY, cx: o.cx })),
      docId: editor.__docId || null,
      note: occ.length > 1 ? '여러 곳 — around --text "..." --nth N 으로 각 맥락 확인 후, 편집 op에 --nth N.' : (occ.length === 1 ? '1곳(--nth 불필요).' : '없음.'),
    });
  });
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  HEADED = !!args.headed;                                    // --headed: 창 띄워 보기(디버그)
  SLOWMO = args.slowmo ? Number(args.slowmo) : (HEADED ? 400 : 0); // headed면 동작을 천천히
  try {
    if (args._ === 'capture') await cmdCapture(args);
    else if (args._ === 'zoom') await cmdZoom(args);
    else if (args._ === 'around') await cmdAround(args);
    else if (args._ === 'pinpoint') await cmdPinpoint(args);
    else if (args._ === 'locate') await cmdLocate(args);
    else if (args._ === 'find') await cmdFind(args);
    else if (args._ === 'download') await cmdDownload(args);
    else if (args._ === 'upload') await cmdUpload(args);
    else if (args._ === 'resize-object') await cmdResizeObject(args);
    else if (args._ === 'object-prop') await cmdObjectProp(args);
    else if (args._ === 'chart-data') await cmdChartData(args);
    else if (args._ === 'insert-table') await cmdInsertTable(args);
    else if (args._ === 'insert-image') await cmdInsertImage(args);
    else if (args._ === 'table-op') await cmdTableOp(args);
    else if (args._ === 'page-number') await cmdPageNumber(args);
    else if (args._ === 'page-break') await cmdPageBreak(args);
    else if (args._ === 'char-shape') await cmdCharShape(args);
    else if (args._ === 'para-shape') await cmdParaShape(args);
    else if (args._ === 'footnote') await cmdFootnote(args);
    else if (args._ === 'endnote') await cmdFootnote(args);
    else if (args._ === 'hyperlink') await cmdHyperlink(args);
    else if (args._ === 'memo') await cmdMemo(args);
    else if (args._ === 'insert-chart') await cmdInsertChart(args);
    else if (args._ === 'para-line') await cmdParaLine(args);
    else if (args._ === 'field') await cmdField(args);
    else if (args._ === 'bookmark') await cmdBookmark(args);
    else if (args._ === 'shape') await cmdShape(args);
    else if (args._ === 'caption') await cmdCaption(args);
    else if (args._ === 'equation') await cmdEquation(args);
    else if (args._ === 'textbox') await cmdTextbox(args);
    else if (args._ === 'font-family') await cmdFontFamily(args);
    else if (args._ === 'highlight') await cmdHighlight(args);
    else if (args._ === 'insert-text') await cmdInsertText(args);
    else if (args._ === 'replace-text') await cmdReplaceText(args);
    else if (args._ === 'set-cell-text') await cmdSetCellText(args);
    else if (args._ === 'format-text') await cmdFormatText(args);
    else if (args._ === 'align') await cmdAlign(args);
    else if (args._ === 'style') await cmdStyle(args);
    else if (args._ === 'level') await cmdLevel(args);
    else if (args._ === 'list') await cmdList(args);
    else if (args._ === 'font-size') await cmdFontSize(args);
    else if (args._ === 'line-spacing') await cmdLineSpacing(args);
    else if (args._ === 'font-color') await cmdFontColor(args);
    else { log('사용법: capture --file <경로> [--page N] [--grid] | zoom --name <이름> --clip "x,y,w,h" [--page N] | around --name <이름> --text "<검색어>" [--grid] | locate --name <이름> --clues "a,b,c" [--grid] | insert-text --name <이름> --anchor "<기준 텍스트>" --text "<추가할 줄>" [--apply] | replace-text --name <이름> --find "<대상>" --to "<교체>" [--apply] | set-cell-text --name <이름> --cell "<기준 셀 텍스트>" --text "<값>" [--tab N] [--apply] | format-text --name <이름> --text "<구절>" --bold|--italic|--underline [--apply]'); process.exit(2); }
    process.exit(0);
  } catch (e) {
    if (e instanceof CannotOpenError || e.message === 'CANNOT_OPEN') {
      out({ status: 'cannot_open', docName: e.docName, reason: 'webhwp가 파일을 열 수 없습니다(손상/형식 오류). hwp·hwpx 무관 동일 에러.' });
      process.exit(5);
    }
    if (e instanceof WrongDocError || e.message === 'WRONG_DOC') {
      out({ status: 'wrong_doc', docName: e.docName, openedTitle: e.openedTitle, docId: e.docId,
            reason: '요청한 파일과 다른 문서가 열렸습니다(동시 업로드 race·동명 파일 등). 재시도 전 드라이브 상태 확인 필요.' });
      process.exit(6);
    }
    console.error('ERR', e.message);
    out({ error: e.message });
    process.exit(e.message.startsWith('AUTH_EXPIRED') ? 4 : 1);
  }
})();
