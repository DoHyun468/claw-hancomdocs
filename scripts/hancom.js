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
  const ident = await editor.evaluate(() => ({ url: location.href, title: document.title || '' }));
  const docId = (String(ident.url).match(/[?&]docId=([^&#]+)/) || [])[1] || null;
  const title = String(ident.title).normalize('NFC');
  const stem = name.replace(/\.[^.]+$/, '');
  if (title && stem && !title.includes(stem)) throw new WrongDocError(name, title, docId);
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

// 찾기 다이얼로그를 열고 text를 검색해 매치로 점프. 검색칸에만 입력(편집 사고 방지).
// 반환: {found, scrollTop, page} | null
async function findText(ed, text) {
  await openFindDialog(ed);
  // 새로 뜬 보이는 input = 검색칸
  const box = await ed.evaluate(() => {
    const ins = Array.from(document.querySelectorAll('input')).map(el => { const r = el.getBoundingClientRect(); return { el, x: r.x, y: r.y, w: r.width, h: r.height, vis: r.width > 60 && r.height > 10 && getComputedStyle(el).visibility !== 'hidden' && el.getAttribute('aria-label') !== '문서 편집 영역' }; });
    // 다이얼로그 중앙쯤(세로 1/3~2/3)에 있는 가장 넓은 입력
    const cand = ins.filter(i => i.vis && i.y > 300).sort((a, b) => b.w - a.w)[0];
    return cand ? { x: Math.round(cand.x), y: Math.round(cand.y), w: Math.round(cand.w), h: Math.round(cand.h) } : null;
  });
  if (!box) throw new Error('검색칸 탐색 실패');
  await ed.mouse.click(box.x + Math.min(box.w / 2, 40), box.y + box.h / 2);
  await ed.keyboard.press('ControlOrMeta+A'); // 전체선택: Win/Linux→Ctrl+A, Mac→Cmd+A 자동 매핑(OS 무관)
  await ed.keyboard.type(text, { delay: 25 });
  // "다음 찾기" 버튼 ≈ 검색칸 오른쪽(+70, 같은 행)
  const nextBtn = { x: box.x + box.w + 70, y: box.y - 1 };
  await ed.mouse.click(nextBtn.x, nextBtn.y); await ed.waitForTimeout(1600);
  // 찾기 직후 캐럿이 매치로 이동 → 상태바 '현재 쪽'이 매치의 실제 페이지(정확)
  const page = await readCurrentPage(ed);
  // 캐럿(매치) 뷰포트 픽셀 위치 = '텍스트 위치로 바로 확대'의 앵커. 닫기 전에 읽어둔다.
  const caret = await readCaretRect(ed);
  await ed.mouse.click(nextBtn.x, nextBtn.y + 53); await ed.waitForTimeout(700); // 닫기
  await ed.keyboard.press('Escape'); await ed.waitForTimeout(400); // 검색 하이라이트 제거(혼동 방지)
  // 새 세션이라 캐럿이 1쪽에서 시작 → 매치가 2쪽 이상이면 page>1. (1쪽 매치/미발견 구분은 한계)
  return page && page > 0 ? { found: true, page, caret } : { found: false };
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

async function cmdAround(args) {
  if (!args.name || !args.text) throw new Error('--name 과 --text 필요');
  // --zoom: 매치 줄을 확대(고배율 기본). 일반 around 는 페이지 전체(1.5).
  const scale = Number(args.scale) || (args.zoom ? 2.5 : 1.5);
  fs.mkdirSync(CAPDIR, { recursive: true });
  await withEditor(scale, async (ctx, page) => {
    const editor = await openDoc(ctx, page, args.name);
    if (!editor) throw new Error('문서를 못 찾음: ' + args.name);
    const r = await findText(editor, String(args.text));
    if (!r.found) { out({ cmd: 'around', found: false, text: args.text }); return; }

    // --zoom: 격자 읽기 없이 '텍스트 위치로 바로 확대'. 찾기가 이미 매치로 스크롤했으므로
    //   gotoPage 생략하고, 그 스크롤 상태에서 캐럿 줄을 가로 밴드로 잘라낸다.
    if (args.zoom && r.caret) {
      const rect = await detectPageRect(editor);
      if (!rect || rect.width < 100) throw new Error('A4 페이지 영역 검출 실패');
      await hideOverlays(editor);
      const band = Number(args.band) || 180;               // 매치 줄 위아래 포함 높이(페이지 px)
      // 세로 경계는 '문서 캔버스'(캐럿을 항상 포함)로 클램프하고, detectPageRect 는 가로(x/width)에만 쓴다.
      // 찾기가 매치를 뷰포트 하단으로 스크롤하면 뷰포트가 두 페이지에 걸쳐, detectPageRect 가 캐럿이 없는
      // 옆 페이지의 흰 영역(더 큰 쪽)을 잡는다 → 그 rect 바닥이 캐럿보다 위라 height 가 음수로 붕괴(40px)하고
      // 밴드가 매치 위(이전 줄/제목)로 어긋나던 버그. 캐럿은 항상 보이므로 캔버스 세로범위로 클램프하면 안전. (OS 무관)
      const view = await editor.evaluate(() => {
        const cvs = [...document.querySelectorAll('canvas')]; if (!cvs.length) return null;
        let c = cvs[0]; for (const x of cvs) if (x.width * x.height > c.width * c.height) c = x;
        const b = c.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.top + b.height) };
      });
      const vTop = view ? view.top : rect.y;
      const vBot = view ? view.bottom : rect.y + rect.height;
      const top = Math.max(vTop, r.caret.y - Math.round(band / 2));
      const clip = {
        x: rect.x, y: top, width: rect.width,
        height: Math.max(40, Math.min(band, vBot - top)),
      };
      const shot = args.out || path.join(CAPDIR, `${String(args.name).replace(/\.[^.]+$/, '')}_findzoom_${stamp()}.png`);
      await editor.screenshot({ path: shot, clip });
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
    await editor.waitForTimeout(1400);    // 자동저장/OT 동기화 여유

    // 3) regression 캡처 — 의도한 영역만 바뀌었는지 한 장
    await gotoPage(editor, n);
    const rect2 = await detectPageRect(editor);
    await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_insert_p${n}_${stamp()}.png`);
    await editor.screenshot(rect2 ? { path: shot, clip: rect2 } : { path: shot });
    out({ cmd: 'insert-text', applied: true, anchor: args.anchor, text: args.text, page: n,
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
    // 적용: 네이티브 찾아 바꾸기 다이얼로그 (findText 선호출 금지 — 다이얼로그 충돌로 교체 0 됨)
    await openReplaceDialog(editor);
    const ins = await dialogInputs(editor);
    const findBox = ins.find((i) => /찾을/.test(i.al)) || ins[0];
    const replBox = ins.find((i) => /바꿀/.test(i.al)) || ins[1];
    if (!findBox || !replBox) throw new Error('찾아 바꾸기 입력칸 탐색 실패(현재 ' + ins.length + '개)');
    // 찾을 내용
    await editor.mouse.click(findBox.x + Math.min(findBox.w / 2, 40), findBox.y + findBox.h / 2);
    await editor.keyboard.press('ControlOrMeta+A'); await editor.keyboard.press('Delete');
    await editor.keyboard.type(findText0, { delay: 20 });
    // 바꿀 내용 (빈 문자열이면 비워둠 = 삭제)
    await editor.mouse.click(replBox.x + Math.min(replBox.w / 2, 40), replBox.y + replBox.h / 2);
    await editor.keyboard.press('ControlOrMeta+A'); await editor.keyboard.press('Delete');
    if (toText) await editor.keyboard.type(toText, { delay: 20 });
    // '모두 바꾸기'
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
    await editor.mouse.click(allBtn.x, allBtn.y); await editor.waitForTimeout(1400);
    // 결과 팝업 텍스트로 교체 횟수 판정 ("문서의 끝까지 바꾸기를 N번 했습니다" / "찾을 수 없습니다")
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
    // 결과 팝업 '확인' → 다이얼로그 '닫기'(Esc)
    const okBtn = await editor.evaluate(() => {
      for (const el of document.querySelectorAll('a, button, div, span')) {
        const t = (el.textContent || '').trim();
        if (t === '확인' && el.offsetParent !== null && el.childElementCount === 0) { const r = el.getBoundingClientRect(); if (r.width > 15 && r.height > 10) return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }
      }
      return null;
    });
    if (okBtn) await editor.mouse.click(okBtn.x, okBtn.y); else await editor.keyboard.press('Enter').catch(() => {});
    await editor.waitForTimeout(500);
    await editor.keyboard.press('Escape').catch(() => {}); await editor.waitForTimeout(1300); // 다이얼로그 닫기 + 자동저장 여유

    // regression 캡처 (교체 후 현재 쪽)
    const n = (await readCurrentPage(editor)) || 1;
    await gotoPage(editor, n);
    const rect2 = await detectPageRect(editor);
    await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_replace_p${n}_${stamp()}.png`);
    await editor.screenshot(rect2 ? { path: shot, clip: rect2 } : { path: shot });
    out({ cmd: 'replace-text', applied: true, find: findText0, to: toText, replaced, page: n, docId: editor.__docId || null, shot });
  });
}

// set-cell-text: 표 셀 채우기. 본문 canvas라 셀 위치를 셀렉터로 못 짚으므로, 기준 셀의 기존
// 텍스트(--cell)를 찾기로 찾아 캐럿을 그 셀에 두고 → Tab 으로 대상 셀 이동 → 입력.
// 안전: 찾기(읽기전용)로만 캐럿 이동, 캐럿이 본문 영역 밖이면 중단, dry-run 기본, headless 전용.
async function cmdSetCellText(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  if (args.cell == null || args.cell === true) throw new Error('--cell 필요 (기준 셀의 기존 텍스트)');
  if (args.text == null || args.text === true) throw new Error('--text 필요 (채울 값)');
  const apply = !!args.apply;
  if (apply && HEADED) throw new Error('편집(--apply)은 headless 전용입니다. --headed 는 보기 전용 — 편집 금지.');
  const tabN = args.tab !== undefined ? Math.max(0, Number(args.tab)) : 1; // 기준 셀에서 Tab 횟수(1=다음 셀)
  const cellText = String(args.cell).normalize('NFC');
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
            docId: editor.__docId || null, note: '--apply 없으면 read-only. 적용 시: 기준 셀에서 Tab×' + tabN + ' 이동 후 입력.' });
      return;
    }
    // 기준 셀에 캐럿 → Tab×N 으로 대상 셀 이동
    await editor.mouse.click(caret.x, caret.y + Math.round((caret.h || 12) / 2));
    await editor.waitForTimeout(350);
    for (let i = 0; i < tabN; i++) { await editor.keyboard.press('Tab'); await editor.waitForTimeout(180); }
    // 대상 셀의 기존 내용을 선택해 교체 — webhwp Tab 은 셀 내용을 자동 선택하지 않으므로(캐럿만 셀 시작
    // 으로 이동) 명시 선택한다: 줄 시작(Home) → 줄 끝까지(Shift+End) → 타이핑이 선택을 교체. 빈 셀이면
    // 선택 0 → 그냥 입력. (단일 줄 셀 기준; 여러 줄 셀은 첫 줄만 선택되는 한계.)
    await editor.keyboard.press('Home');
    await editor.keyboard.down('Shift'); await editor.keyboard.press('End'); await editor.keyboard.up('Shift');
    await editor.waitForTimeout(120);
    await editor.keyboard.type(value, { delay: 35 });
    await editor.waitForTimeout(1300);
    await gotoPage(editor, n);
    const rect2 = await detectPageRect(editor);
    await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_cell_p${n}_${stamp()}.png`);
    await editor.screenshot(rect2 ? { path: shot, clip: rect2 } : { path: shot });
    out({ cmd: 'set-cell-text', applied: true, cell: cellText, tab: tabN, text: value, page: n, docId: editor.__docId || null, shot });
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
  if (!styles.length) throw new Error('서식 플래그 필요 (--bold / --italic / --underline 중 하나 이상)');
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
      out({ cmd: 'format-text', dryRun: true, text: phrase, styles: styles.map((s) => s[1]), foundPage: r.page,
            docId: editor.__docId || null, note: '--apply 없으면 read-only. 적용 시: 구절 선택 후 키보드 서식.' });
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
    await editor.waitForTimeout(900);
    await editor.keyboard.press('Escape').catch(() => {}); // 선택 해제(깨끗한 캡처)
    await editor.waitForTimeout(300);
    await gotoPage(editor, n);
    const rect2 = await detectPageRect(editor);
    await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_format_p${n}_${stamp()}.png`);
    await editor.screenshot(rect2 ? { path: shot, clip: rect2 } : { path: shot });
    out({ cmd: 'format-text', applied: true, text: phrase, styles: styles.map((s) => s[1]), selChars: r.selChars, page: n, docId: editor.__docId || null, shot });
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

// align: 단락 정렬(왼/가운데/오른/양쪽). 단락 단위라 선택 불필요 — 기준 텍스트(--anchor)로 그 단락에
// 캐럿을 두고, 본문 포커스 후 툴바 정렬 셀렉터 클릭.
async function cmdAlign(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  if (!args.anchor) throw new Error('--anchor 필요 (정렬할 단락 안의 텍스트)');
  const to = String(args.to || '').toLowerCase();
  const SEL = { left: '.align_left', center: '.align_center', right: '.align_right', justify: '.align_justify' };
  if (!SEL[to]) throw new Error('--to 는 left | center | right | justify');
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
    await editor.waitForTimeout(900);
    await gotoPage(editor, n);
    const rect2 = await detectPageRect(editor);
    await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_align_p${n}_${stamp()}.png`);
    await editor.screenshot(rect2 ? { path: shot, clip: rect2 } : { path: shot });
    out({ cmd: 'align', applied: true, anchor, to, page: n, docId: editor.__docId || null, shot });
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
    await editor.waitForTimeout(1000);
    const pc = await readPageCount(editor);
    await gotoPage(editor, n);
    const rect2 = await detectPageRect(editor);
    await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_${cmd}_p${n}_${stamp()}.png`);
    await editor.screenshot(rect2 ? { path: shot, clip: rect2 } : { path: shot });
    out({ cmd, applied: true, anchor, ...extra, page: n, totalPages: pc ? pc.total : null, docId: editor.__docId || null, shot });
  });
}

// list: 단락을 글머리표(bullet) 또는 문단번호(number) 목록으로 토글.
async function cmdList(args) {
  const type = String(args.type || 'bullet').toLowerCase();
  const SEL = { bullet: '.bullet_list', number: '.number_list' };
  if (!SEL[type]) throw new Error('--type 는 bullet | number');
  await caretParagraphOp(args, 'list', SEL[type], { type });
}

// 구절을 마우스 드래그로 정확히 선택. 드래그는 본문 캔버스에서 일어나 포커스를 보장하므로, 이후
// 툴바(글자크기·색) 적용이 안정적이다(찾기 선택은 닫은 뒤 포커스가 풀려 적용이 간헐 실패).
// 찾기로 캐럿(매치 끝쪽)·줄 y 를 얻고, 그 줄을 가로로 드래그하며 selChars==글자수가 되게 폭(W) 보정.
async function dragSelectPhrase(ed, phrase) {
  const r = await findText(ed, phrase);
  if (!r.found || !r.caret) return { found: !!r.found, selChars: 0, page: r.page };
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
      if (!r.found) { out({ cmd: 'font-size', status: 'text_not_found', text: phrase, docId: editor.__docId || null }); return; }
      out({ cmd: 'font-size', dryRun: true, text: phrase, size, foundPage: r.page, docId: editor.__docId || null, note: '--apply 없으면 read-only. 적용 시: 드래그 선택 후 크기 ' + size + 'pt.' });
      return;
    }
    const sel = await dragSelectPhrase(editor, phrase);
    if (!sel.found) { out({ cmd: 'font-size', status: 'text_not_found', text: phrase, docId: editor.__docId || null }); return; }
    if (!sel.selChars) { out({ cmd: 'font-size', status: 'selection_failed', text: phrase, docId: editor.__docId || null, note: '드래그 선택 실패.' }); return; }
    const n = sel.page || 1;
    // 툴바 글자크기 입력칸에 값 입력(선택에 적용)
    const box = await editor.evaluate(() => { const el = document.querySelector('.font_size input'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; });
    if (!box) throw new Error('글자크기 입력칸(.font_size input) 탐색 실패');
    await editor.mouse.click(box.x, box.y);
    await editor.keyboard.press('ControlOrMeta+A');
    await editor.keyboard.type(String(size), { delay: 30 });
    await editor.keyboard.press('Enter');
    await editor.waitForTimeout(1000);
    await gotoPage(editor, n);
    const rect2 = await detectPageRect(editor);
    await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_fontsize_p${n}_${stamp()}.png`);
    await editor.screenshot(rect2 ? { path: shot, clip: rect2 } : { path: shot });
    out({ cmd: 'font-size', applied: true, text: phrase, size, selChars: sel.selChars, page: n, docId: editor.__docId || null, shot });
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
async function cmdFontColor(args) {
  if (!args.name) throw new Error('--name 필요 (드라이브 문서 이름)');
  if (args.text == null || args.text === true) throw new Error('--text 필요 (색 바꿀 구절)');
  const target = parseColor(args.color);
  if (!target) throw new Error('--color 필요 (red|blue|green|black|yellow|... 또는 #RRGGBB)');
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
      if (!r.found) { out({ cmd: 'font-color', status: 'text_not_found', text: phrase, docId: editor.__docId || null }); return; }
      out({ cmd: 'font-color', dryRun: true, text: phrase, color: args.color, foundPage: r.page, docId: editor.__docId || null, note: '--apply 없으면 read-only.' });
      return;
    }
    const sel = await dragSelectPhrase(editor, phrase);
    if (!sel.found) { out({ cmd: 'font-color', status: 'text_not_found', text: phrase, docId: editor.__docId || null }); return; }
    if (!sel.selChars) { out({ cmd: 'font-color', status: 'selection_failed', text: phrase, docId: editor.__docId || null, note: '드래그 선택 실패.' }); return; }
    const n = sel.page || 1;
    // 글자색 드롭다운 화살표 → 팔레트
    const arrow = await editor.evaluate(() => { const el = document.querySelector('.font_color .btn_combo_arrow'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; });
    if (!arrow) throw new Error('글자색 드롭다운(.font_color .btn_combo_arrow) 탐색 실패');
    await editor.mouse.click(arrow.x, arrow.y); await editor.waitForTimeout(900);
    // 팔레트의 솔리드 rgb 스와치 수집(rgba 알파/큰 박스는 UI 노이즈라 제외)
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
    if (!cells.length) throw new Error('글자색 팔레트 스와치 탐색 실패');
    let best = cells[0], bd = Infinity;
    for (const c of cells) { const d = (c.r - target[0]) ** 2 + (c.g - target[1]) ** 2 + (c.b - target[2]) ** 2; if (d < bd) { bd = d; best = c; } }
    await editor.mouse.click(best.x, best.y); await editor.waitForTimeout(1000);
    await gotoPage(editor, n);
    const rect2 = await detectPageRect(editor);
    await hideOverlays(editor);
    const shot = args.out || path.join(CAPDIR, `${name.replace(/\.[^.]+$/, '')}_fontcolor_p${n}_${stamp()}.png`);
    await editor.screenshot(rect2 ? { path: shot, clip: rect2 } : { path: shot });
    out({ cmd: 'font-color', applied: true, text: phrase, color: args.color, picked: { r: best.r, g: best.g, b: best.b }, selChars: sel.selChars, page: n, docId: editor.__docId || null, shot });
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
    else if (args._ === 'locate') await cmdLocate(args);
    else if (args._ === 'insert-text') await cmdInsertText(args);
    else if (args._ === 'replace-text') await cmdReplaceText(args);
    else if (args._ === 'set-cell-text') await cmdSetCellText(args);
    else if (args._ === 'format-text') await cmdFormatText(args);
    else if (args._ === 'align') await cmdAlign(args);
    else if (args._ === 'list') await cmdList(args);
    else if (args._ === 'font-size') await cmdFontSize(args);
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
