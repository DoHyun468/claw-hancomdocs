---
name: claw-hancomdocs
description: Drive 한컴독스(Hancom Docs) web viewer/editor (webhwp) via Playwright to upload .hwp/.hwpx files, capture rendered pages (A4 screenshots / zoomed regions / find-by-text), and (Phase 2 — in progress) directly edit documents through Hancom's own web UI. Use when the user wants to SEE how a Korean document renders in 한컴독스, screenshot a hwp/hwpx page, "한컴독스에 올려서 보여줘", check styling/tables/layout as the web viewer shows them, detect that a file won't open, or create/edit a document through Hancom's native web editor. Headless, reuses saved login. **Local-machine only** — does not run in Cowork sandbox (proxy blocks webhwp.hancomdocs.com).
license: MIT
---

# claw-hancomdocs

한컴독스 web (webhwp) 을 Playwright 로 드라이브 — 업로드 / 페이지 캡처 / 영역 확대 / 텍스트 검색 / **(Phase 2)** 직접 편집.

- Phase 1 (capture) — 작동 검증됨. 아래 명령 참고
- Phase 2 (edit) — 구현 중. `HANDOFF_PHASE2_EDIT.md` 참고

Playwright headless로 동작 — **보이는 창 없음**, 물리 마우스/키보드 안 건드림, 백그라운드 가능.
스크립트는 `scripts/`에 있고 capture/zoom/around/locate 4개 명령 작동 검증됨.

> **Local-machine 전용.** Cowork sandbox 에서는 `www.hancomdocs.com` proxy 차단 + `auth.json` 머신 종속으로 실행 불가. 사용자 Mac / Windows / Linux 머신에서 직접 실행.

## ⚙️ 첫 실행 — 세팅부터 점검 (매 캡처 전에 반드시)

캡처/줌/검색을 돌리기 전에 **두 가지 1회 세팅**이 돼 있는지 먼저 확인한다. 환경(머신)마다 1회 필요.

```bash
cd <이 스킬 폴더>/scripts     # SKILL.md가 있는 디렉토리의 scripts/
# 1) playwright 설치 여부
[ -d node_modules/playwright ] && echo "DEPS_OK" || echo "DEPS_MISSING"
# 2) 로그인 세션 여부
[ -f auth.json ] && echo "AUTH_OK" || echo "AUTH_MISSING"
```

### DEPS_MISSING 이면 (의존성 설치 — 비대화, 에이전트가 바로 실행)
```bash
npm install && npx playwright install chromium
```
(Chromium ~수백 MB 다운로드, 1~2분. 사용자에게 "최초 1회 설치 중"이라고 알려라.)

### AUTH_MISSING 이면 (로그인 — 대화형, 사용자 조작 필요)
```bash
node login.js     # 보이는 브라우저 창이 뜸 (백그라운드로 실행)
```
그리고 **사용자에게 이렇게 안내**한다:
> "한컴독스 로그인 창을 띄웠어요. 그 창에서 **한컴독스에 로그인**만 해주세요(카카오 등 평소대로). 홈 화면이 뜨면 제가 자동으로 세션을 저장합니다 — 창 닫을 필요 없어요."

`login.js`는 로그인 완료를 자동 감지해 `auth.json`을 저장하고 종료한다(최대 5분 대기). 완료되면 캡처로 진행.
**비밀번호는 어디에도 저장 안 한다** — 세션 토큰만 `auth.json`에 저장(세션 만료 시 `node login.js` 재실행으로 갱신).

### 명령 실행 중 `{"status":"...AUTH_EXPIRED..."}` (exit 4) 가 나오면
세션 만료다. `node login.js`로 재로그인 안내 후 다시 시도.

> `auth.json`은 현재 로그인 세션 그 자체라 민감. git에 올리지 말 것(이미 .gitignore됨).

## 🎯 명령 (에이전트 주문용)

모든 명령은 `scripts/`에서 `node hancom.js <subcommand> ...`. 결과는 마지막 줄 `RESULT_JSON={...}`.

```
node hancom.js capture --file <절대경로> [--page N] [--grid] [--scale N] [--out <png>]
node hancom.js zoom    --name <문서이름>  --clip "x,y,w,h" [--page N] [--scale N] [--out <png>]
node hancom.js around  --name <문서이름>  --text "<검색어>" [--grid] [--out <png>]
node hancom.js locate  --name <문서이름>  --clues "a,b,c" [--grid] [--out <png>]
```

- **capture**: 파일을 (필요시) 업로드하고 N쪽(기본 1)을 **A4 한 장 깔끔히** 캡처(툴바·여백 없음, 잘림 없음). 반환 `{shot, docName, page, estTotalPages, pageWidth, pageHeight}`.
- **zoom**: 이미 올라간 문서의 특정 영역 확대. 좌표는 **페이지 왼쪽위=(0,0)** 기준 CSS px. 기본 scale 3.
- **around**: 한컴독스 "찾기"로 텍스트를 찾아 **그 매치가 있는 페이지**를 캡처(정확). 검색칸에만 입력해 문서는 편집 안 됨.
- **locate**: 여러 단서를 각각 검색해 **가장 많이 모이는(최빈) 페이지**를 찾아 캡처. 한 단어가 TOC/반복에 걸려도 다수결로 버팀.

> **어느 걸 쓰나:** 쪽 번호 알면 `capture --page`(가장 쌈·정확). 고유한 구절 있으면 `around`(검색 1회). 흔한 단어만 있으면 `locate`(N회 검색이라 느리지만 다수결로 정확). 한 단어는 TOC·반복에 약하니 **구체적 구절 > 단어**.

### 좌표를 모를 때 — 권장 흐름 (캔버스 렌더라 텍스트 위치 자동탐색 불가)
1. `capture --file X --page N --grid` → 페이지 위에 100px 좌표 격자+라벨이 얹힌 이미지를 받는다.
2. 이미지를 보고 원하는 영역의 `x,y / 오른쪽끝 / 아래끝`을 읽는다 (`width=오른쪽끝-x`, `height=아래끝-y`, 경계보다 10~20px 여유).
3. `zoom --name X --page N --clip "x,y,width,height" --scale 3` → 선명한 확대본.

자세한 명세: `ORDER_SPEC.txt`.

## 🚫 열 수 없는 파일

손상/형식오류로 webhwp가 못 여는 파일은 캡처 대신 `{"status":"cannot_open","docName":"...","reason":"..."}` 반환(exit 5, hwp·hwpx 동일).
→ 사용자에게 "이 파일은 열 수 없습니다(손상/형식 오류)"라고 그대로 전달.
(한계: 절단/부분손상 일부는 에러 없이 깨진 바이트가 렌더되는 '조용한 가비지' 모드가 있어 이건 미감지.)

## 동작 메모 (수정/디버깅 시)
- 본문은 `<canvas>` 렌더 → DOM 텍스트 없음. 페이지 점프는 `#hcwoViewScroll` scrollTop 제어(100%줌·A4 = 1143px/쪽).
- 페이지 경계는 캔버스 픽셀 스캔으로 자동 검출(방향 무관: 세로 792×1121, 가로 1122×792).
- 협업 커서 이름표는 `.user_cursor_container`를 캡처 직전 CSS로 숨김.
- 키보드 단축키(Ctrl+F/End)는 webhwp에서 신뢰 불가 — 좌표/스크롤로만.
- ⚠️ **본문/툴바 input에 블라인드 입력 금지**(문서가 편집됨). 검색은 찾기 다이얼로그 검색칸만.
- 전체 개발 노트: `./DEBUG_NOTES.md`.
