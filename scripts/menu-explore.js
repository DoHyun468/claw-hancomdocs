// 메뉴바 탐색기 — 라이브 한컴독스 에디터에서 메뉴 구조(항목+셀렉터+서브메뉴)를 덤프.
// 이 코드의 목적 = MENU_MAP(목록) 구성/갱신용 recon 도구. 런타임 클릭 편집 스킬이 아님.
//   node menu-explore.js <메뉴> [호버대상]   단일 메뉴/서브메뉴 (예: 보기 확대/축소)
//   node menu-explore.js --sweep             9개 메뉴 + 알려진 서브메뉴 전체 → menu-inventory.json
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const AUTH = path.join(DIR, 'auth.json');
const UIMAP = path.join(DIR, '..', 'ui-map');            // recon 산출물 = repo 안 ui-map/ (절대경로 금지)
const OUTDIR = path.join(UIMAP, 'screenshots');          // 스크린샷
const INVJSON = path.join(UIMAP, 'menu-inventory.json'); // sweep 인벤토리
const MYDRIVE = 'https://www.hancomdocs.com/ko/mydrive';
const DOC = 'case01-memo.hwpx';
const VIEW = { width: 1440, height: 1000 };

// 알려진 `>` 서브메뉴 부모 (MENU_MAP §B). 표는 표 선택 필요 → 별도.
const SUBMENUS = {
  '파일': [], '편집': ['찾기'], '보기': ['확대/축소', '쪽 모양', '표시/숨기기', '도구 상자', '문서 창', '메모'],
  '입력': ['도형', '주석'], '서식': [], '쪽': ['머리말', '꼬리말', '단'],
  '표': [], '검토': ['변경 내용 추적'], '도구': ['빠른 교정', '접근성 설정'],
};
const ORDER = ['파일', '편집', '보기', '입력', '서식', '쪽', '표', '검토', '도구'];

const log = (...x) => console.log(...x);
const asciiSafe = (s) => Array.from(s).map((c) => c.charCodeAt(0) > 126 ? '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0') : c).join('');
const out = (o) => log('RESULT_JSON=' + asciiSafe(JSON.stringify(o)));

async function openEditor(ctx, page, docName) {
  await page.goto(MYDRIVE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  if (page.url().includes('accounts.hancom.com') || page.url().includes('/login')) throw new Error('AUTH_EXPIRED');
  const row = page.getByText(docName || DOC, { exact: false }).first();
  await row.waitFor({ timeout: 8000 });
  const [editor] = await Promise.all([ctx.waitForEvent('page', { timeout: 15000 }), row.click()]);
  await editor.waitForLoadState('networkidle').catch(() => {});
  await editor.waitForTimeout(3500);
  return editor;
}

async function getTabs(editor) {
  return editor.evaluate(() => {
    const names = ['파일', '편집', '보기', '입력', '서식', '쪽', '표', '검토', '도구'];
    const res = [];
    for (const el of document.querySelectorAll('*')) {
      const t = (el.textContent || '').trim();
      if (names.includes(t) && el.childElementCount === 0) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.top < 140) res.push({ name: t, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
      }
    }
    const seen = {}, uniq = [];
    for (const t of res.sort((a, b) => a.y - b.y)) if (!seen[t.name]) { seen[t.name] = 1; uniq.push(t); }
    return uniq;
  });
}

// 드롭다운 항목(메뉴 아이템) 덤프 — 메뉴 아이템 시그니처 class(btn_icon/sub_group) + 위치로 거름
async function dumpItems(editor, tab) {
  return editor.evaluate((t) => {
    const res = [];
    for (const el of document.querySelectorAll('div, a, li')) {
      const cls = (el.className || '').toString();
      const txt = (el.textContent || '').trim();
      if (!txt || txt.length > 36) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 70 || r.height < 16 || r.height > 40) continue;
      if (r.top < t.y + 6) continue;                       // 탭 아래
      if (Math.abs((r.left) - (t.x - 110)) > 340) continue; // 그 메뉴 컬럼 근처
      const menuish = /btn_icon|sub_group/.test(cls);       // 메뉴 아이템 시그니처
      if (!menuish) continue;
      const sc = (txt.match(/(Ctrl|Cmd|Opt|Shift|Return|Num)[A-Za-z0-9+\- ]*$|F\d+$/) || [''])[0];
      const label = txt.replace(sc, '').trim();
      res.push({
        text: label, sel: '.' + (cls.split(/\s+/)[0] || ''), group: /sub_group/.test(cls), shortcut: sc.trim(),
        gray: parseFloat(getComputedStyle(el).opacity) < 0.6 || /disable/.test(cls),
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      });
    }
    res.sort((a, b) => a.y - b.y);
    const seen = {}, uniq = [];
    for (const it of res) if (it.text && !seen[it.text]) { seen[it.text] = 1; uniq.push(it); }
    return uniq;
  }, tab);
}

// 툴바(2·3행) 버튼 열거 — 메뉴바 아래 영역의 class 가진 버튼/컨트롤 + 드롭다운(▼) 여부
async function dumpToolbar(editor) {
  return editor.evaluate(() => {
    const res = [];
    for (const el of document.querySelectorAll('div, a, button')) {
      const cls = (el.className || '').toString();
      if (!cls || el.childElementCount > 5) continue;
      const r = el.getBoundingClientRect();
      if (r.top < 28 || r.top > 165) continue;                 // 메뉴바 아래 ~ 룰러 위 (툴바 2·3행)
      if (r.width < 18 || r.width > 240 || r.height < 16 || r.height > 46) continue;
      const sel = cls.split(/\s+/)[0];
      if (!sel) continue;
      const arrow = /btn_dropdown|btn_combo|_arrow|has_arrow|arrow_/.test(cls)
        || [...el.querySelectorAll('*')].some((c) => /arrow|dropdown/.test((c.className || '').toString()));
      res.push({ sel: '.' + sel, text: (el.textContent || '').trim().slice(0, 22), title: el.getAttribute('title') || '', arrow, x: Math.round(r.x), y: Math.round(r.y), row: r.top < 105 ? 2 : 3, w: Math.round(r.width) });
    }
    res.sort((a, b) => a.row - b.row || a.x - b.x);
    const seen = {}, uniq = [];
    for (const it of res) { const k = it.sel + '@' + it.row + '_' + Math.round(it.x / 12); if (!seen[k]) { seen[k] = 1; uniq.push(it); } }
    return uniq;
  });
}

// permissive: 드롭다운 컬럼의 모든 항목(class 시그니처 무시) — 누락 메뉴(검토 등) 확인용
async function dumpRaw(editor, tab) {
  return editor.evaluate((t) => {
    const res = [];
    for (const el of document.querySelectorAll('div, a, li')) {
      const txt = (el.textContent || '').trim();
      if (!txt || txt.length > 44) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 60 || r.height < 16 || r.height > 44) continue;
      if (r.top < t.y + 6) continue;
      if (Math.abs(r.left - (t.x - 110)) > 300) continue;
      res.push({ text: txt, sel: '.' + ((el.className || '').toString().split(/\s+/)[0] || ''), cls: (el.className || '').toString().slice(0, 44), gray: parseFloat(getComputedStyle(el).opacity) < 0.6 });
    }
    res.sort((a, b) => 0);
    const seen = {}, uniq = [];
    for (const it of res) if (!seen[it.text]) { seen[it.text] = 1; uniq.push(it); }
    return uniq;
  }, tab);
}

// 서브메뉴 부모 호버 → 오른쪽 플라이아웃을 '가장 왼쪽 컬럼'으로 좁혀 덤프
async function dumpFlyout(editor, parent) {
  await editor.mouse.move(parent.x + Math.min(parent.w / 2, 100), parent.y + parent.h / 2);
  await editor.waitForTimeout(1000);
  return editor.evaluate((p) => {
    const cand = [];
    for (const el of document.querySelectorAll('div, a, li')) {
      const txt = (el.textContent || '').trim();
      if (!txt || txt.length > 34 || el.childElementCount > 2) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 30 || r.height < 14 || r.height > 44) continue;
      if (r.left < p.x + p.w - 30) continue;                // 부모 오른쪽
      if (getComputedStyle(el).visibility === 'hidden' || el.offsetParent === null) continue;
      cand.push({ text: txt, sel: '.' + ((el.className || '').toString().split(/\s+/)[0] || ''), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) });
    }
    if (!cand.length) return [];
    const minx = Math.min(...cand.map((c) => c.x));         // 플라이아웃 = 가장 왼쪽 컬럼
    const col = cand.filter((c) => c.x <= minx + 130).sort((a, b) => a.y - b.y);
    const seen = {}, uniq = [];
    for (const it of col) if (it.text && !seen[it.text]) { seen[it.text] = 1; uniq.push({ text: it.text, sel: it.sel }); }
    return uniq;
  }, p = parent);
}

async function clickTab(editor, tabs, name) {
  const tab = tabs.find((t) => t.name === name);
  if (!tab) return null;
  await editor.mouse.click(tab.x, tab.y);
  await editor.waitForTimeout(800);
  return tab;
}

// 흰 A4 페이지 사각형(뷰포트 CSS px) — page-local 좌표를 뷰포트로 변환하려고
async function detectPageRect(ed) {
  return ed.evaluate(() => {
    const cvs = [...document.querySelectorAll('canvas')];
    if (!cvs.length) return null;
    let c = cvs[0]; for (const x of cvs) if (x.width * x.height > c.width * c.height) c = x;
    const r = c.getBoundingClientRect(), W = c.width, H = c.height, sx = W / r.width, sy = H / r.height;
    const img = c.getContext('2d').getImageData(0, 0, W, H).data;
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
    let top = -1, runStart = -1, bestLen = 0;
    const colX = Math.min(W - 1, pl + 3);
    for (let py = 0; py < H; py++) {
      if (white(colX, py)) { if (runStart < 0) runStart = py; }
      else if (runStart >= 0) { const len = py - runStart; if (len > bestLen) { bestLen = len; top = runStart; } runStart = -1; }
    }
    if (runStart >= 0 && H - runStart > bestLen) top = runStart;
    return { x: Math.round(r.left + pl / sx), y: Math.round(r.top + top / sy), width: Math.round((pr - pl) / sx) };
  });
}

(async () => {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const SWEEP = process.argv[2] === '--sweep';
  const RAW = process.argv[2] === '--raw';
  const TOOLBAR = process.argv[2] === '--toolbar';
  const TBOPEN = process.argv[2] === '--toolbar-open';
  const TBSEL = TBOPEN ? (process.argv[3] || '').replace(/^\./, '') : null; // 예: font_color
  const TABLE = process.argv[2] === '--table';
  const COLLAB = process.argv[2] === '--collab'; // 협업(사용자가 같이 열어둠) 감지 실측
  const COLLABEDIT = process.argv[2] === '--collab-edit'; // 2세션 열어 협업 유발 후 편집 실측
  const EDITDEMO = process.argv[2] === '--edit-demo';     // 단일 세션 headed 편집 데모(사용자가 봄)
  const HEADED = process.argv.includes('--headed');       // 강제 headed(사용자가 보고 싶을 때)
  const WHOAMI = process.argv[2] === '--whoami';          // 연 에디터의 URL/제목 = 어떤 파일인지 식별 검증
  const TABLEDOC = (TABLE && process.argv[3]) || 'tabletest.hwpx';
  const TPX = TABLE ? Number(process.argv[4] || 250) : 0;
  const TPY = TABLE ? Number(process.argv[5] || 285) : 0;
  const MENU = RAW ? process.argv[3] : ((SWEEP || TABLE) ? null : (process.argv[2] || '입력'));
  const HOVER = (RAW || SWEEP || TABLE) ? null : (process.argv[3] || null);

  const headed = HEADED || EDITDEMO; // 사용자가 볼 때만 보이는 창 + 천천히
  const browser = await chromium.launch({ headless: !headed, slowMo: headed ? 300 : 0 });
  const ctx = await browser.newContext({ storageState: AUTH, viewport: VIEW, deviceScaleFactor: 1.5 });
  try {
    const page = await ctx.newPage();
    const editor = await openEditor(ctx, page, TABLE ? TABLEDOC : null);
    const tabs = await getTabs(editor);

    if (TABLE) {
      const rect = await detectPageRect(editor);
      if (!rect) throw new Error('페이지 영역 검출 실패');
      await editor.mouse.click(rect.x + TPX, rect.y + TPY);   // 표 셀에 커서 → 표 op 활성
      await editor.waitForTimeout(900);
      const tab = await clickTab(editor, tabs, '표');
      if (!tab) throw new Error('표 탭 못 찾음');
      const items = await dumpItems(editor, tab);
      const subs = {};
      for (const parentText of ['셀 테두리/배경', '줄/칸 추가하기', '줄/칸 지우기', '블록 계산식', '1,000 단위 구분 쉼표']) {
        const parent = items.find((it) => it.text.includes(parentText.split('/')[0]));
        if (!parent) { subs[parentText] = { error: 'not found' }; continue; }
        try { subs[parentText] = await dumpFlyout(editor, parent); } catch (e) { subs[parentText] = { error: e.message }; }
        await editor.keyboard.press('Escape').catch(() => {});
        await editor.mouse.click(rect.x + TPX, rect.y + TPY); await editor.waitForTimeout(300);
        await clickTab(editor, tabs, '표');
      }
      const shot = path.join(OUTDIR, 'table_menu_active.png');
      await editor.screenshot({ path: shot });
      out({ table: true, cell: { x: rect.x + TPX, y: rect.y + TPY }, grayCount: items.filter((i) => i.gray).length, items: items.map(({ text, sel, group, gray }) => ({ text, sel, group, gray })), submenus: subs, shot });
    } else if (SWEEP) {
      const inventory = { doc: DOC, capturedAt: 'sweep', menus: [] };
      for (const name of ORDER) {
        const tab = await clickTab(editor, tabs, name);
        if (!tab) { inventory.menus.push({ name, error: 'tab not found' }); continue; }
        const items = await dumpItems(editor, tab);
        const submenus = {};
        for (const parentText of SUBMENUS[name]) {
          const parent = items.find((it) => it.text.includes(parentText.split('/')[0]));
          if (!parent) { submenus[parentText] = { error: 'parent not found' }; continue; }
          try { submenus[parentText] = await dumpFlyout(editor, parent); } catch (e) { submenus[parentText] = { error: e.message }; }
          await editor.keyboard.press('Escape').catch(() => {});
          await clickTab(editor, tabs, name); // 메뉴 재오픈(플라이아웃 닫고 다음 부모)
        }
        inventory.menus.push({ name, items: items.map(({ text, sel, group, shortcut, gray }) => ({ text, sel, group, shortcut, gray })), submenus });
        await editor.keyboard.press('Escape').catch(() => {});
        await editor.waitForTimeout(300);
      }
      fs.writeFileSync(INVJSON, JSON.stringify(inventory, null, 2));
      const summary = inventory.menus.map((m) => `${m.name}: ${m.items ? m.items.length : '?'}항목, 서브 ${Object.keys(m.submenus || {}).length}`);
      out({ sweep: true, file: INVJSON, summary });
    } else if (RAW) {
      const tab = await clickTab(editor, tabs, MENU);
      if (!tab) throw new Error('탭 못 찾음: ' + MENU);
      const raw = await dumpRaw(editor, tab);
      const shot = path.join(OUTDIR, `raw_${MENU}.png`);
      await editor.screenshot({ path: shot });
      out({ raw: MENU, count: raw.length, items: raw, shot });
    } else if (COLLAB) {
      // 편집 전 안전게이트용 단발 체크 — 신뢰 신호 = "편집 (N)" 카운트. N>=2 = 사용자가 같은 문서 열어둔 협업 모드.
      const s = await editor.evaluate(() => {
        let count = null;
        for (const el of document.querySelectorAll('*')) {
          const t = (el.textContent || '').trim();
          const m = t.match(/편집\s*\((\d+)\)/);
          if (m && t.length < 40) { count = Number(m[1]); break; }
        }
        const collaborators = [...document.querySelectorAll('.user_list, .collaborationusers')].map((e) => (e.textContent || '').trim().slice(0, 40)).filter(Boolean);
        return { count, collaborators };
      });
      out({ collab: true, doc: DOC, collabActive: s.count >= 2, editorCount: s.count, collaborators: s.collaborators });
    } else if (COLLABEDIT) {
      // 내가 직접 2번째 세션(같은 auth=같은 계정) 띄워 협업 유발 → 두 세션이 같은 본문 자리를 동시 타이핑(방해).
      const ctx2 = await browser.newContext({ storageState: AUTH, viewport: VIEW, deviceScaleFactor: 1.5, acceptDownloads: true });
      const editor2 = await openEditor(ctx2, await ctx2.newPage());
      await editor.waitForTimeout(3000); // 협업 등록 여유
      const countOf = (ed) => ed.evaluate(() => { let c = null; for (const el of document.querySelectorAll('*')) { const t = (el.textContent || '').trim(); const m = t.match(/편집\s*\((\d+)\)/); if (m && t.length < 40) { c = Number(m[1]); break; } } return c; });
      const caretOf = (ed) => ed.evaluate(() => { const el = document.querySelector('#HWP_CURSOR_VIEW, .BLINK_CURSOR'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; });
      const rect = await detectPageRect(editor);
      const rectB = await detectPageRect(editor2);
      const countA = await countOf(editor);
      // 두 세션이 같은 본문 영역 클릭 후 교대로 타이핑 (A=A들, B=B들)
      await editor.mouse.click(rect.x + 160, rect.y + 190);
      await editor2.mouse.click(rectB.x + 160, rectB.y + 190);
      await editor.waitForTimeout(500);
      for (let i = 0; i < 6; i++) {
        await editor.keyboard.type('A', { delay: 0 });
        await editor2.keyboard.type('B', { delay: 0 });
        await editor.waitForTimeout(180);
      }
      await editor.waitForTimeout(2500);
      const caretA = await caretOf(editor);
      const cursorCountA = await editor.evaluate(() => document.querySelectorAll('#HWP_CURSOR_VIEW, .BLINK_CURSOR, .user_cursor_container').length);
      const shotA = path.join(OUTDIR, 'collab_edit_A.png');
      const shotB = path.join(OUTDIR, 'collab_edit_B.png');
      await editor.screenshot({ path: shotA });
      await editor2.screenshot({ path: shotB });
      await ctx2.close();
      out({ collabEdit: true, collabActive: countA >= 2, countA, cursorCountA, caretA, note: 'A=AAAAAA / B=BBBBBB 같은 자리 동시 타이핑', shotA, shotB });
    } else if (EDITDEMO) {
      // 단일 세션(headed) 편집 데모 — 사용자가 봄. 1세션이라 협업 아님(count 1).
      await editor.bringToFront().catch(() => {});
      // 기존 동기화/오류 다이얼로그 있으면 '확인' 눌러 복원
      await editor.getByText('확인', { exact: true }).first().click({ timeout: 2500 }).catch(() => {});
      await editor.waitForTimeout(1000);
      const count = await editor.evaluate(() => { let c = null; for (const el of document.querySelectorAll('*')) { const t = (el.textContent || '').trim(); const m = t.match(/편집\s*\((\d+)\)/); if (m && t.length < 40) { c = Number(m[1]); break; } } return c; });
      const rect = await detectPageRect(editor);
      log('단일 세션 편집 데모(headed) — 협업 카운트: ' + (count === null ? '없음(1세션 = 협업 아님)' : count) + ' / 18초간 보세요.');
      await editor.mouse.click(rect.x + 160, rect.y + 190); // 본문 텍스트 클릭
      await editor.waitForTimeout(1000);
      await editor.keyboard.type(' [편집데모] ', { delay: 260 }); // 천천히(사용자가 봄)
      await editor.waitForTimeout(18000); // 충분히 보게
      const shot = path.join(OUTDIR, 'edit_demo.png');
      await editor.screenshot({ path: shot });
      out({ editDemo: true, collabActive: count >= 2, editorCount: count, note: '1세션이면 count null/1 = 협업 아님 = 충돌 없음', shot });
    } else if (WHOAMI) {
      // 연 에디터가 어떤 파일인지 식별 — URL(doc id 있나) + 제목
      const url = editor.url();
      const info = await editor.evaluate(() => {
        let header = null, headerCls = null;
        for (const el of document.querySelectorAll('a, span, div, input')) {
          const t = (el.value || el.textContent || '').trim();
          const r = el.getBoundingClientRect();
          if (t && t.length < 60 && r.top < 30 && r.left < 420 && r.width > 20 && el.childElementCount === 0) { header = t; headerCls = (el.className || '').toString().slice(0, 44); break; }
        }
        return { documentTitle: document.title, headerTitle: header, headerCls };
      });
      out({ whoami: true, expected: DOC, url, ...info });
    } else if (TOOLBAR) {
      const tb = await dumpToolbar(editor);
      out({ toolbar: true, count: tb.length, row2: tb.filter((t) => t.row === 2), row3: tb.filter((t) => t.row === 3) });
    } else if (TBOPEN) {
      // 툴바 버튼의 드롭다운 화살표(오른쪽 끝) 클릭 → 아래로 뜨는 플라이아웃 덤프 (호버 아님)
      const btn = await editor.evaluate((sel) => {
        for (const el of document.querySelectorAll('div, a, button')) {
          if (((el.className || '').toString().split(/\s+/)[0]) !== sel) continue;
          const r = el.getBoundingClientRect();
          if (r.top < 28 || r.top > 165 || r.width < 18) continue;
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
        }
        return null;
      }, TBSEL);
      if (!btn) throw new Error('툴바 버튼 못 찾음: .' + TBSEL);
      await editor.mouse.click(btn.x + btn.w - 7, btn.y + btn.h / 2);  // 오른쪽 끝 = 화살표
      await editor.waitForTimeout(1000);
      const items = await editor.evaluate((b) => {
        const res = [];
        for (const el of document.querySelectorAll('div, a, li')) {
          const t = (el.textContent || '').trim();
          if (t.length > 30 || el.childElementCount > 2) continue;
          const r = el.getBoundingClientRect();
          if (r.top < b.y + b.h - 4) continue;                 // 버튼 아래(드롭다운은 아래로 뜸)
          if (r.left < b.x - 130 || r.left > b.x + 200) continue;
          if (r.width < 16 || r.height < 12 || r.height > 46) continue;
          if (getComputedStyle(el).visibility === 'hidden' || el.offsetParent === null) continue;
          res.push({ text: t || '(빈/색상)', sel: '.' + ((el.className || '').toString().split(/\s+/)[0] || ''), x: Math.round(r.x), y: Math.round(r.y) });
        }
        res.sort((a, b2) => a.y - b2.y || a.x - b2.x);
        const seen = {}, uniq = [];
        for (const it of res) { const k = it.text + '@' + Math.round(it.y / 8) + '_' + Math.round(it.x / 30); if (!seen[k]) { seen[k] = 1; uniq.push(it); } }
        return uniq;
      }, btn);
      const shot = path.join(OUTDIR, `toolbar_${TBSEL}.png`);
      await editor.screenshot({ path: shot });
      out({ toolbarOpen: TBSEL, count: items.length, items, shot });
    } else {
      const tab = await clickTab(editor, tabs, MENU);
      if (!tab) throw new Error('메뉴 탭 못 찾음: ' + MENU);
      const items = await dumpItems(editor, tab);
      let submenu = null, shot2 = null;
      if (HOVER) {
        const parent = items.find((it) => it.text.includes(HOVER.split('/')[0]));
        if (!parent) throw new Error('호버 대상 못 찾음: ' + HOVER + ' / ' + items.map((i) => i.text).join('|'));
        submenu = await dumpFlyout(editor, parent);
        shot2 = path.join(OUTDIR, `submenu_${MENU}_${HOVER.replace(/[\/\\]/g, '')}.png`);
        await editor.screenshot({ path: shot2 });
      }
      const shot = path.join(OUTDIR, `menu_${MENU}.png`);
      await editor.screenshot({ path: shot });
      out({ menu: MENU, hover: HOVER, items, submenu, shot, shot2 });
    }
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error('ERR', e.message); out({ error: e.message }); process.exit(1); });
