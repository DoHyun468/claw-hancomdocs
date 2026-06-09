---
name: claw-hancomdocs
description: Drive 한컴독스(Hancom Docs) web viewer/editor (webhwp) via Playwright to upload .hwp/.hwpx files, capture rendered pages (A4 screenshots / zoomed regions / find-by-text), and directly edit documents through Hancom's own web UI. Use when the user wants to SEE how a Korean document renders in 한컴독스, screenshot a hwp/hwpx page, "한컴독스에 올려서 보여줘", check styling/tables/layout as the web viewer shows them, detect that a file won't open, or create/edit a document through Hancom's native web editor. Headless, reuses saved login. **Local-machine only** — does not run in Cowork sandbox (proxy blocks webhwp.hancomdocs.com).
license: MIT
---

# claw-hancomdocs

한컴독스 web (webhwp) 을 Playwright 로 드라이브 — 업로드 / 페이지 캡처 / 영역 확대 / 텍스트 검색 / 문서에 한 줄 추가.

Playwright headless로 동작 — **보이는 창 없음**, 물리 마우스/키보드 안 건드림, 백그라운드 가능.
스크립트는 `scripts/`에 있고 `capture` / `zoom` / `around` / `locate` / `insert-text` / `replace-text` / `set-cell-text` / `format-text` / `align` / `list` / `font-size` 명령을 제공한다.

> **Local-machine 전용.** Cowork sandbox 에서는 `www.hancomdocs.com` proxy 차단 + `auth.json` 머신 종속으로 실행 불가. 사용자 Mac / Windows / Linux 머신에서 직접 실행.

## ⚙️ 첫 실행 — 무조건 `doctor.js` 부터 (매 캡처 전 1회)

캡처/줌/검색을 돌리기 전에 **항상 먼저** 자가진단을 돌린다. 무엇이 준비됐고 다음에 뭘 할지 doctor가 한 번에 알려준다 — 너는 직접 점검하지 말고 doctor가 시키는 대로만 하면 된다.

> **OS 무관**: 이 스킬은 Windows·macOS·Linux에서 같은 코드로 동작한다. 모든 명령은 `node`로만 실행하므로 셸(bash/PowerShell) 종류와 무관하다. **`&&` 체이닝은 쓰지 말 것**(PowerShell 파싱 오류) — 한 줄에 하나씩. 결과 `RESULT_JSON`은 ASCII-safe라 한글 코드페이지(CP949 등)에서도 안 깨진다.

```bash
cd <이 스킬 폴더>/scripts     # SKILL.md가 있는 디렉토리의 scripts/ (구분자는 / 로 써도 양 OS 동작)
node doctor.js
```

> **`node` 명령이 안 먹으면**(command not found): node가 설치돼 있어도 PATH에 없을 수 있다(특히 Windows). 설치돼 있으면 절대경로로 실행하라 — Windows 기본은 `C:\Program Files\nodejs\node.exe`, macOS(homebrew)는 `/opt/homebrew/bin/node` 또는 `/usr/local/bin/node`. 한 번 풀경로로 doctor를 돌리면 이후엔 doctor가 알려주는 `node.path`를 그대로 쓰면 된다. node 자체가 없으면 사용자에게 Node.js 설치를 요청하라.

doctor는 node(풀경로)·playwright·chromium·auth.json·프로파일잠금을 점검하고 마지막 줄에
`RESULT_JSON={ ok, status, checks, node:{path}, next:{ who, commands, note } }` 를 찍는다.

**판단 규칙은 단 하나: `next.who` 를 보고 행동한다.**
- `who:"agent"` → `next.commands` 를 **네가 직접 실행**한다.
- `who:"user"` → **절대 네가 실행하지 말고**, 사용자에게 그 명령을 직접 돌리라고 안내한다.

`status` 별 대응:

| status | 뜻 | 행동 |
|---|---|---|
| `READY` (exit 0) | 다 준비됨 | 바로 캡처(아래 "명령")로 진행 |
| `DEPS_MISSING` (10) | 의존성 없음 | **에이전트가** `npm install` → `npx playwright install chromium` (수백 MB·1~2분, "최초 1회 설치 중" 안내) |
| `CHROMIUM_MISSING` (11) | chromium만 없음 | **에이전트가** `npx playwright install chromium` |
| `AUTH_MISSING` (12) | 로그인 세션 없음 | **에이전트가** `node login.js` 실행(창 띄움). 단 창이 사용자에게 안 보이는 원격/SSH면 사용자에게 넘겨라 (아래 ↓) |
| `AUTH_EXPIRED` (4) | 세션 만료 (`--deep`에서만) | AUTH_MISSING과 동일 |

조치를 한 뒤에는 **`node doctor.js`를 다시 돌려 `READY`(exit 0)가 될 때까지 반복**한다. READY가 아니면 캡처를 시도하지 마라.

> **빠른 점검 vs `--deep`**: 기본 `node doctor.js`는 파일·설치 존재만 본다(빠름, ~0.3초). `auth.json`이 **있어도 세션은 만료**됐을 수 있는데, 이건 캡처 때 `AUTH_EXPIRED`(exit 4)로 잡힌다. 미리 확실히 하려면 **`node doctor.js --deep`** — 실제 한컴독스에 접속해 세션 생존까지 확인(~2초). 만료면 그 자리에서 AUTH_EXPIRED를 돌려준다.

> **node 가 PATH에 없을 때**: doctor 출력의 `node.path`(예: `C:\Program Files\nodejs\node.exe`)를 그대로 써서 이후 명령을 절대경로로 실행하면 된다. OS 분기 불필요.

### AUTH_MISSING / AUTH_EXPIRED — 로그인 (1회)
로그인은 사람만 할 수 있고(OAuth) **창이 화면에 보여야** 한다. **기본은 에이전트가 직접 `node login.js`를 실행해 창을 띄우는 것** — 보통 사용자의 데스크톱(콘솔/원격데스크톱 등)에서 도니 창이 바로 보인다. 뜬 창에서 사용자가 **한컴독스에 로그인**(평소 쓰는 방식대로)하면 login.js가 자동 감지해 `auth.json`을 저장하고 종료한다(최대 5분, 창 닫을 필요 없음). 끝나면 `node doctor.js`로 `READY` 확인 후 캡처로 진행.

> **예외 — 네가 창을 보여줄 수 없는 환경이면 사용자에게 넘겨라.** 네가 SSH/원격 비대화형 셸이면(대표적으로 Windows OpenSSH = Session 0, 보이는 데스크톱이 없음 — 힌트: 환경변수 `SSH_CONNECTION` 존재) 띄운 창이 사용자 화면에 **안 보인다**. 이때만 직접 실행하지 말고 이렇게 부탁한다:
> "한컴독스 로그인이 1회 필요해요. **당신 세션에서 직접** `! node login.js` 를 실행하고(`!`로 시작하면 이 세션에서 실행돼 결과가 여기로 들어와요), 뜬 창에서 로그인만 해주세요."
> 애매하면 일단 띄워 보고, 사용자가 "창이 안 보인다"고 하면 그때 위로 전환하면 된다.

**비밀번호는 어디에도 저장 안 한다** — 세션 토큰만 `auth.json`에.

### 캡처 중 `{"status":"...AUTH_EXPIRED..."}` (exit 4) 가 나오면
세션 만료다. 위 AUTH_MISSING/AUTH_EXPIRED 절차대로 재로그인(기본 에이전트가 `node login.js`, SSH면 사용자) 후 다시 시도.

> `auth.json`은 현재 로그인 세션 그 자체라 민감. git에 올리지 말 것(이미 .gitignore됨). 머신마다 각자 1회 로그인이 필요(세션 공유 안 함).

## 🎯 명령 (에이전트 주문용)

모든 명령은 `scripts/`에서 `node hancom.js <subcommand> ...`. 결과는 마지막 줄 `RESULT_JSON={...}`.

```
node hancom.js capture --file <절대경로> [--page N] [--grid] [--scale N] [--page-height N] [--out <png>]
node hancom.js zoom    --name <문서이름>  --clip "x,y,w,h" [--page N] [--scale N] [--out <png>]
node hancom.js around  --name <문서이름>  --text "<검색어>" [--zoom [--band N]] [--grid] [--out <png>]
node hancom.js locate  --name <문서이름>  --clues "a,b,c" [--grid] [--out <png>]
node hancom.js insert-text  --name <문서이름> --anchor "<기준 텍스트>" --text "<추가할 한 줄>" [--apply]
node hancom.js replace-text --name <문서이름> --find "<바꿀 대상>" --to "<바꿀 결과>" [--apply]
node hancom.js set-cell-text --name <문서이름> --cell "<기준 셀 텍스트>" --text "<채울 값>" [--tab N] [--apply]
node hancom.js format-text  --name <문서이름> --text "<구절>" --bold|--italic|--underline [--apply]
node hancom.js align        --name <문서이름> --anchor "<단락 안 텍스트>" --to left|center|right|justify [--apply]
node hancom.js list         --name <문서이름> --anchor "<단락 안 텍스트>" --type bullet|number [--apply]
node hancom.js font-size    --name <문서이름> --text "<구절>" --size <pt> [--apply]
```

- **capture**: 파일을 (필요시) 업로드하고 N쪽(기본 1)을 **A4 한 장 깔끔히** 캡처(툴바·여백 없음, 잘림 없음). 반환 `{shot, docName, page, totalPages, estTotalPages, pageWidth, pageHeight}`.
  - **`totalPages`**: 상태바에서 읽은 **정확한 총 쪽수**(페이지1에서도 나옴). 못 읽으면 `null`이고 `estTotalPages`가 스크롤 기반 추정으로 폴백.
  - **페이지 점프 한계**: `page N`은 쪽당 높이가 균일(A4 100%)하다고 보고 비례 점프한다 — 표준 세로 문서는 정확(검증됨). **비표준 크기(가로/혼합 방향 등) 문서에서 엉뚱한 쪽이 잡히면 `--page-height N`**(쪽당 스크롤 px)으로 보정해 다시 캡처. (캡처 이미지를 직접 보고 맞는 쪽인지 확인 — **상태바 쪽번호는 캐럿 기준이라 캡처된 쪽 판별엔 못 쓴다**.)
- **zoom**: 이미 올라간 문서의 특정 영역 확대. 좌표는 **페이지 왼쪽위=(0,0)** 기준 CSS px. 기본 scale 3.
- **around**: 한컴독스 "찾기"로 텍스트를 찾아 **그 매치가 있는 페이지**를 캡처(정확). 검색칸에만 입력해 문서는 편집 안 됨.
  - **`--zoom`**: 페이지 전체 대신 **매치 줄을 그 자리에서 확대**해 잘라낸다(가로 밴드, 기본 높이 180px·`--band`로 조절, 기본 scale 2.5). **격자 읽기·좌표 입력 없이** "이 텍스트를 가까이 보여줘"가 한 번에 됨.
- **locate**: 여러 단서를 각각 검색해 **가장 많이 모이는(최빈) 페이지**를 찾아 캡처. 한 단어가 TOC/반복에 걸려도 다수결로 버팀.

> **`--file` vs `--name`:** `capture`의 `--file`은 **절대경로**(없으면 업로드). `zoom`/`around`/`locate`의 `--name`은 **이미 올라간 문서의 파일명**(= capture 결과 `RESULT_JSON.docName`, 보통 파일 basename 예: `test_win.hwp`).

> **어느 걸 쓰나:** 쪽 번호 알면 `capture --page`(가장 쌈·정확). 고유한 구절 있으면 `around`(검색 1회). 흔한 단어만 있으면 `locate`(N회 검색이라 느리지만 다수결로 정확). 한 단어는 TOC·반복에 약하니 **구체적 구절 > 단어**.

### 원하는 부분만 확대 — 두 가지 길
**A) 텍스트가 보이면 → `around --zoom` (제일 쉬움, 격자 불필요).**
- `around --name X --text "보고 싶은 구절" --zoom [--band 220]` → 그 구절이 있는 줄을 바로 확대 캡처.
- 내부적으로 찾기 후 **캐럿(매치) 픽셀 위치**를 읽어 그 줄을 밴드로 자른다. 좌표를 직접 셀 필요가 없다.
- 더 넓게 보려면 `--band`(밴드 높이) ↑, 더 선명히는 `--scale` ↑.

**B) 텍스트로 못 짚는 대상(그림·표 레이아웃·여백) → 격자 흐름.** (캔버스 렌더라 위치 자동탐색 불가)
1. `capture --file X --page N --grid` → 100px 좌표 격자+라벨이 얹힌 이미지.
2. 이미지를 보고 `x,y / 오른쪽끝 / 아래끝`을 읽는다 (`width=오른쪽끝-x`, `height=아래끝-y`, 경계보다 10~20px 여유).
3. `zoom --name X --page N --clip "x,y,width,height" --scale 3` → 선명한 확대본.
   - 좌표계는 **페이지 왼쪽위=(0,0)** 으로 격자 라벨과 동일. 어긋나면 격자 이미지를 다시 띄워 라벨 숫자를 그대로 읽을 것.

자세한 명세: `ORDER_SPEC.txt`.

## ✏️ 편집 — 한 줄 추가 (`insert-text`)

문서 본문에 **한 줄을 추가**한다. 본문은 `<canvas>`라 좌표로 글자를 직접 못 짚으므로, **기준이 되는 기존 텍스트(앵커)를 찾아 그 줄 끝에 새 줄을 삽입**한다.

```bash
node hancom.js insert-text --name <문서이름> --anchor "<기준 텍스트>" --text "<추가할 한 줄>" [--apply]
```

- **동작**: `--anchor` 텍스트를 한컴독스 찾기로 찾아 그 줄 끝으로 이동 → 새 줄 → `--text` 입력. 결과적으로 **앵커가 있는 단락 바로 다음 줄**에 한 줄이 추가된다.
- **`--apply` 없으면 dry-run(read-only)**: 문서를 바꾸지 않고 "어디에(앵커 위치·페이지) 무엇을 넣을지"만 `RESULT_JSON`으로 보여준다. **먼저 dry-run으로 앵커가 잘 잡히는지 확인**하고, 맞으면 `--apply`로 적용을 권장.
- **반환**: 적용 시 `{applied:true, anchor, text, page, docId, shot}` — `shot`은 적용 후 그 페이지 캡처(바뀐 결과 눈으로 확인용). dry-run은 `{dryRun:true, foundPage, caret, plannedText}`. 앵커를 못 찾으면 `{status:"anchor_not_found"}`.
- **앵커 고르기**: 문서에 **한 번만 나오는 구체적 구절**로(흔한 단어는 엉뚱한 곳에 잡힐 수 있음). 어디 들어가는지 헷갈리면 dry-run의 `foundPage`/`caret`로 확인.
- **문서 맨 끝에 추가하려면**: 먼저 `capture`로 **마지막 줄 텍스트**를 확인하고, 그 줄을 `--anchor`로 준다.

> ⚠️ **편집은 headless 전용.** `--headed`로는 편집할 수 없다(보기/캡처 전용) — 편집 중 창을 보면 스크롤·상호작용으로 캐럿 위치가 어긋난다. 결과를 보고 싶으면 적용 뒤 `shot`(또는 `capture --page`)으로 확인.
> ⚠️ **안전**: 본문/제목 input에 **블라인드로 직접 입력하지 않는다**. 캐럿은 항상 찾기(앵커)로 본문에 위치시킨 뒤에만 타이핑하며, 캐럿이 본문 영역을 벗어나면 `{status:"caret_out_of_body"}`로 중단한다(오편집 방지).

## 🔁 편집 — 텍스트 교체 (`replace-text`)

문서에서 **특정 텍스트를 찾아 다른 텍스트로 모두 바꾼다**(한컴독스 "찾아 바꾸기"). `--to ""`이면 그 텍스트를 **삭제**한다.

```bash
node hancom.js replace-text --name <문서이름> --find "<바꿀 대상>" --to "<바꿀 결과>" [--apply]
```

- **동작**: `--find` 텍스트를 문서 전체에서 찾아 `--to`로 모두 교체. `--to ""`(빈 문자열)이면 `--find`를 삭제.
- **`--apply` 없으면 dry-run(read-only)**: 대상이 문서에 있는지(`foundPage`)만 확인하고 바꾸지 않는다. 먼저 dry-run으로 대상 확인 후 `--apply` 권장.
- **반환**: 적용 시 `{applied:true, find, to, replaced:<교체된 개수>, page, docId, shot}`. dry-run은 `{dryRun:true, foundPage}`. 대상이 없으면 `{status:"find_not_found"}`.
- **find 고르기**: 의도한 곳만 바뀌도록 **충분히 구체적인 문자열**로(너무 짧으면 여러 곳이 바뀐다 — 반환 `replaced` 개수로 확인).

> ⚠️ `insert-text`와 동일: **편집은 headless 전용**(`--headed`는 보기 전용), 다이얼로그 입력칸에만 입력하고 본문에 블라인드 입력하지 않는다.

## ▦ 편집 — 표 셀 채우기 (`set-cell-text`)

표의 셀 값을 채우거나 바꾼다. 본문이 `<canvas>`라 셀을 좌표로 직접 못 짚으므로, **기준 셀의 기존 텍스트(`--cell`)를 찾아** 거기서 **Tab으로 대상 셀까지 이동**해 입력한다.

```bash
node hancom.js set-cell-text --name <문서이름> --cell "<기준 셀 텍스트>" --text "<채울 값>" [--tab N] [--apply]
```

- **동작**: `--cell` 텍스트가 있는 셀을 찾아 캐럿을 두고, **Tab을 N번**(기본 1 = 바로 다음 셀) 눌러 대상 셀로 이동 → 그 셀의 기존 내용을 선택해 `--text`로 교체(빈 셀이면 그냥 채움). `--tab 0`이면 기준 셀 자체를 바꾼다.
- **`--apply` 없으면 dry-run(read-only)**: 기준 셀을 찾았는지(`foundPage`)만 확인.
- **반환**: 적용 시 `{applied:true, cell, tab, text, page, docId, shot}`. 기준 셀이 없으면 `{status:"cell_not_found"}`.
- **셀 지정 팁**: 같은 행에서 **고유한 라벨 셀**을 `--cell`로(예: `"매출"`), 그 오른쪽 칸이면 `--tab 1`, 두 칸 뒤면 `--tab 2`. 어디로 가는지 헷갈리면 먼저 `capture`로 표를 보고 칸 수를 센다. (셀이 한 줄일 때 정확 — 여러 줄 셀은 첫 줄만 교체.)

> ⚠️ 편집은 headless 전용(`--headed`는 보기 전용), 캐럿은 찾기로만 이동하고 본문에 블라인드 입력하지 않는다.

## 𝐁 편집 — 글자 서식 (`format-text`)

문서에서 **특정 구절을 찾아 글자 서식**(굵게/기울임/밑줄)을 적용한다.

```bash
node hancom.js format-text --name <문서이름> --text "<구절>" --bold [--italic] [--underline] [--apply]
```

- **동작**: `--text` 구절을 찾아 그 구절만 선택한 뒤 준 서식을 토글(이미 적용돼 있으면 해제). 여러 서식 동시 지정 가능.
- **서식 플래그**: `--bold`(굵게) · `--italic`(기울임) · `--underline`(밑줄). **하나 이상** 필요.
- **`--apply` 없으면 dry-run(read-only)**: 구절이 문서에 있는지(`foundPage`)만 확인.
- **반환**: 적용 시 `{applied:true, text, styles, selChars, page, docId, shot}`. 구절이 없으면 `{status:"text_not_found"}`, 선택에 실패하면 `{status:"selection_failed"}`(더 고유한 구절로 재시도).
- **구절 고르기**: 문서에 **한 번만 나오는 구체적 구절**로(여러 번 나오면 첫 매치에만 적용).

> ⚠️ 편집은 headless 전용(`--headed`는 보기 전용). **토글**이라 이미 그 서식이 걸린 구절에 다시 적용하면 해제된다 — 결과를 `shot`(또는 `capture`)으로 확인.

## 🔠 편집 — 글자 크기 (`font-size`)

구절의 **글자 크기(pt)** 를 바꾼다.

```bash
node hancom.js font-size --name <문서이름> --text "<구절>" --size <pt> [--apply]
```

- **동작**: `--text` 구절을 (드래그로) 정확히 선택해 `--size` pt 로 변경.
- **`--apply` 없으면 dry-run(read-only)**. 반환 `{applied:true, text, size, selChars, page, docId, shot}`. 구절을 못 찾으면 `{status:"text_not_found"}`, 선택에 실패하면 `{status:"selection_failed"}`.

> ⚠️ 편집은 headless 전용(`--headed`는 보기 전용). 결과 확인은 `around --zoom`으로 크게.

## • 편집 — 목록 (`list`)

기준 텍스트가 있는 **단락을 글머리표/문단번호 목록**으로 만든다(토글).

```bash
node hancom.js list --name <문서이름> --anchor "<단락 안 텍스트>" --type bullet|number [--apply]
```

- **동작**: `--anchor` 단락에 캐럿을 두고 `--type bullet`(글머리표 ●) 또는 `number`(문단번호)를 토글. **단락 단위**.
- **`--apply` 없으면 dry-run(read-only)**. 반환 `{applied:true, anchor, type, page, docId, shot}`. 단락을 못 찾으면 `{status:"anchor_not_found"}`.

> ⚠️ 편집은 headless 전용(`--headed`는 보기 전용).

## ⬌ 편집 — 단락 정렬 (`align`)

기준 텍스트가 있는 **단락의 정렬**을 바꾼다(왼쪽/가운데/오른쪽/양쪽).

```bash
node hancom.js align --name <문서이름> --anchor "<단락 안 텍스트>" --to left|center|right|justify [--apply]
```

- **동작**: `--anchor` 텍스트가 있는 단락에 캐럿을 두고 정렬을 적용. **단락 단위**(선택 불필요).
- **`--to`**: `left`(왼쪽) · `center`(가운데) · `right`(오른쪽) · `justify`(양쪽).
- **`--apply` 없으면 dry-run(read-only)**. 반환 `{applied:true, anchor, to, page, docId, shot}`. 단락을 못 찾으면 `{status:"anchor_not_found"}`.

> ⚠️ 편집은 headless 전용(`--headed`는 보기 전용).

## 🚫 열 수 없는 파일

손상/형식오류로 webhwp가 못 여는 파일은 캡처 대신 `{"status":"cannot_open","docName":"...","reason":"..."}` 반환(exit 5, hwp·hwpx 동일).
→ 사용자에게 "이 파일은 열 수 없습니다(손상/형식 오류)"라고 그대로 전달.
(한계: 절단/부분손상 일부는 에러 없이 깨진 바이트가 렌더되는 '조용한 가비지' 모드가 있어 이건 미감지.)

## 동작 메모 (수정/디버깅 시)
- 본문은 `<canvas>` 렌더 → DOM 텍스트 없음. 페이지 점프는 `#hcwoViewScroll` scrollTop 제어(100%줌·A4 = 1143px/쪽).
- 페이지 경계는 캔버스 픽셀 스캔으로 자동 검출(방향 무관: 세로 792×1121, 가로 1122×792).
- **캔버스가 2층**: 문서층(흰 배경=불투명 픽셀 다수) + **오버레이층**(거의 투명; 진입 presence '파란 물방울'·커서·캐럿). `hideOverlays`가 ① DOM 협업 흔적(`.user_cursor_container` 등)을 CSS로, ② **오버레이 캔버스를 `visibility:hidden`**(불투명 픽셀이 최대치의 5% 미만인 캔버스)으로 숨겨 **캡처에 물방울/커서가 안 박힌다**. 캡처에 파란 물방울이 보이면 이 오버레이 숨김이 안 먹은 것(또는 실제 타인이 동시 편집 중).
- **찾기 UI는 셀렉터 기반**(좌표 아님): `openFindDialog`가 `a[title="찾기"]` + '찾기...' 메뉴의 DOM 위치를 읽어 연다. `around --zoom`은 찾기 후 캐럿(`#HWP_CURSOR_VIEW`) 픽셀 위치로 매치 줄을 확대.
- 키보드 단축키(Ctrl+F/End)는 webhwp에서 신뢰 불가 — 좌표/스크롤/셀렉터로만.
- ⚠️ **본문/툴바 input에 블라인드 입력 금지**(문서가 편집됨). 검색은 찾기 다이얼로그 검색칸만.
- 전체 개발 노트 + 캔버스 뷰어 디버깅 방법론: `./DEBUG_NOTES.md`.
