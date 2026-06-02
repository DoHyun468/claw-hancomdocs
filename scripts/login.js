// 로그인 완료를 자동 감지해 storageState(세션 쿠키+localStorage)를 auth.json으로 저장.
// 사용자는 열린 창에서 한컴독스 로그인만 하면 된다. 창을 닫을 필요 없음.
const { chromium } = require('playwright');
const path = require('path');

const PROFILE = path.join(__dirname, 'pw-profile');
const AUTH = path.join(__dirname, 'auth.json');

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://www.hancomdocs.com/home', { waitUntil: 'domcontentloaded' });
  console.log('LOGIN_OPEN — 창에서 한컴독스에 로그인하세요. 자동으로 감지합니다.');

  const deadline = Date.now() + 5 * 60 * 1000; // 5분
  let saved = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2500);
    let url = '';
    try { url = page.url(); } catch (e) {}
    // 로그인 표지: 한컴독스 도메인 + 업로드/문서 UI 존재, 그리고 accounts.hancom.com 아님
    if (url.includes('hancomdocs.com') && !url.includes('accounts.hancom.com') && !url.includes('/login')) {
      let marker = 0;
      try {
        marker = (await page.getByText('문서 업로드').count())
               + (await page.getByText('Upload', { exact: false }).count())
               + (await page.locator('input[type=file]').count());
      } catch (e) {}
      console.log('poll url=', url, 'marker=', marker);
      if (marker > 0) {
        await ctx.storageState({ path: AUTH });
        console.log('AUTH_SAVED ->', AUTH);
        saved = true;
        break;
      }
    } else {
      console.log('poll url=', url, '(아직 로그인 전)');
    }
  }
  await ctx.close().catch(() => {});
  if (!saved) { console.log('TIMEOUT — 로그인 감지 실패'); process.exit(3); }
  console.log('DONE');
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
