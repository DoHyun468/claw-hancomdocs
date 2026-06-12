---
name: claw-hancomdocs
description: Drive 한컴독스(Hancom Docs) web viewer/editor (webhwp) via Playwright to upload .hwp/.hwpx files, capture rendered pages (A4 screenshots / zoomed regions / find-by-text), and directly edit documents through Hancom's own web UI. Use when the user wants to SEE how a Korean document renders in 한컴독스, screenshot a hwp/hwpx page, "한컴독스에 올려서 보여줘", check styling/tables/layout as the web viewer shows them, detect that a file won't open, or create/edit a document through Hancom's native web editor. Headless, reuses saved login. **Local-machine only** — does not run in Cowork sandbox (proxy blocks webhwp.hancomdocs.com).
license: MIT
---

# claw-hancomdocs

한컴독스 web (webhwp) 을 Playwright 로 드라이브 — 업로드 / 페이지 캡처 / 영역 확대 / 텍스트 검색 / 문서에 한 줄 추가.

Playwright headless로 동작 — **보이는 창 없음**, 물리 마우스/키보드 안 건드림, 백그라운드 가능.
스크립트는 `scripts/`에 있고 `capture` / `zoom` / `around` / `locate` / `insert-text` / `replace-text` / `set-cell-text` / `format-text` / `align` / `line-spacing` / `list` / `font-size` / `font-color` 명령을 제공한다.

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
node hancom.js find    --name <문서이름>  --text "<구절>"
node hancom.js pinpoint --file <로컬 .hwp/.hwpx> --text "<구절>" [--nth N] [--name <문서이름>] [--replace "<새 텍스트>" [--apply]] [--band N] [--scale N] [--out <png>]
node hancom.js download --name <문서이름>  [--pdf] [--out <로컬경로>]
node hancom.js upload   --file <로컬경로>
node hancom.js resize-object --name <문서이름> --at "x,y" [--width <mm>] [--height <mm>] [--apply]
node hancom.js object-prop   --name <문서이름> --at "x,y" [--pos "x,y"] [--width <mm>] [--height <mm>] [--wrap <배치>] [--fill <색|none>] [--border <색>] [--border-width <mm>] [--apply]
node hancom.js chart-data    --name <문서이름> --at "x,y" --set "B2=9.9,C3=4" [--apply]
node hancom.js insert-table  --name <문서이름> --rows R --cols C [--anchor "<텍스트>"] [--apply]
node hancom.js insert-image  --name <문서이름> --file <이미지경로> [--anchor "<텍스트>"] [--apply]
node hancom.js insert-chart  --name <문서이름> [--type N] [--anchor "<텍스트>"] [--apply]
node hancom.js table-op      --name <문서이름> --cell "<셀 텍스트>" [--to "<끝 셀>"] [--tab N] --op <op> [--apply]
node hancom.js cell-style    --name <문서이름> --cell "<셀 텍스트>" [--fill <색|none>] [--border <색> --border-where <위치>] [--diagonal <방향>] [--apply]
node hancom.js table-cell-prop --name <문서이름> --cell "<셀 텍스트>" [--cell-width <mm>] [--cell-height <mm>] [--valign top|middle|bottom] [--cell-margin "왼,오,위,아래"] [--apply]
node hancom.js page-number   --name <문서이름> --where header|footer --align left|center|right [--apply]
node hancom.js page-setup    --name <문서이름> [--orientation portrait|landscape] [--width <mm>] [--height <mm>] [--top/--bottom/--left/--right/--header/--footer <mm>] [--apply]
node hancom.js page-break    --name <문서이름> --anchor "<단락 안 텍스트>" [--apply]
node hancom.js para-line     --name <문서이름> --anchor "<단락 안 텍스트>" [--apply]
node hancom.js field         --name <문서이름> --anchor "<단락 안 텍스트>" --guide "<안내문>" [--field-name "<이름>"] [--apply]
node hancom.js bookmark      --name <문서이름> --anchor "<단락 안 텍스트>" --mark-name "<책갈피 이름>" [--apply]
node hancom.js shape         --name <문서이름> --anchor "<근처 텍스트>" --shape rect|ellipse|line|arc [--wrap <배치>] [--apply]
node hancom.js caption       --name <문서이름> --at "x,y" --text "<캡션>" [--position below|above|left|right] [--apply]
node hancom.js equation      --name <문서이름> --anchor "<단락 안 텍스트>" --script "<한컴 수식 스크립트>" [--apply]
node hancom.js char-shape    --name <문서이름> --text "<구절>" [--spacing N] [--width N] [--apply]
node hancom.js para-shape    --name <문서이름> --anchor "<단락 안 텍스트>" [--left N] [--right N] [--before N] [--after N] [--apply]
node hancom.js footnote      --name <문서이름> --anchor "<단락 안 텍스트>" --text "<각주 내용>" [--apply]
node hancom.js endnote       --name <문서이름> --anchor "<단락 안 텍스트>" --text "<미주 내용>" [--apply]
node hancom.js hyperlink     --name <문서이름> --text "<구절>" --url "<주소>" [--apply]
node hancom.js memo          --name <문서이름> --anchor "<단락 안 텍스트>" --text "<메모 내용>" [--apply]
node hancom.js textbox       --name <문서이름> --anchor "<근처 텍스트>" --text "<내용>" [--wrap inline|square|behind|front|topbottom] [--apply]
node read.mjs <로컬 .hwp/.hwpx> [--text "<구절>"] [--locate --nth N] [--inspect] [--objects] [--bookmarks]
node hancom.js insert-text  --name <문서이름> --anchor "<기준 텍스트>" --text "<추가할 한 줄>" [--apply]
node hancom.js replace-text --name <문서이름> --find "<바꿀 대상>" --to "<바꿀 결과>" [--apply]
node hancom.js set-cell-text --name <문서이름> --cell "<기준 셀 텍스트>" --text "<채울 값>" [--tab N] [--apply]
node hancom.js format-text  --name <문서이름> --text "<구절>" --bold|--italic|--underline|--strike [--apply]
node hancom.js font-family  --name <문서이름> --text "<구절>" --font "<글꼴명>" [--nth N] [--apply]
node hancom.js align        --name <문서이름> --anchor "<단락 안 텍스트>" --to left|center|right|justify|distribute|divide [--apply]
node hancom.js line-spacing  --name <문서이름> --anchor "<단락 안 텍스트>" --to 200 [--apply]
node hancom.js list         --name <문서이름> --anchor "<단락 안 텍스트>" --type bullet|number [--shape N] [--apply]
node hancom.js level        --name <문서이름> --anchor "<단락 안 텍스트>" --to increase|decrease [--by N] [--apply]
node hancom.js style        --name <문서이름> --anchor "<단락 안 텍스트>" --style "<스타일명>" [--apply]
node hancom.js font-size    --name <문서이름> --text "<구절>" --size <pt> [--apply]
node hancom.js font-color   --name <문서이름> --text "<구절>" --color red|blue|#RRGGBB|... [--apply]
node hancom.js highlight    --name <문서이름> --text "<구절>" --color yellow|green|#RRGGBB|... [--apply]
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

### 긴/복잡 문서에서 "그 위치"를 정확히 — `read.mjs` · `find` · `pinpoint`
본문은 캔버스라 캡처(비전)만으론 "같은 구절이 여러 곳인데 그중 어디"를 정밀히 못 짚는다. **원본 파일을 직접 읽어** 보완한다.

- **`read.mjs`** (로컬 파일 읽기): `.hwp/.hwpx` 원본을 파싱해 정확한 텍스트와 구절의 **occurrence-맵**을 만든다.
  - `node read.mjs <파일>` → 전체 텍스트 / `--inspect` → 단위 수·표 수
  - `node read.mjs <파일> --text "<구절>"` → 모든 occurrence를 **문서순 nth + 논리주소(표 `tableIdx`·`row`·`col` 또는 `section`·`para`) + 앞뒤 맥락**으로
  - `node read.mjs <파일> --text "<구절>" --locate --nth N` → 그 N번째를 **UI에서 한 번에 집을 최단 유니크 문자열(anchor)** + 유일성 여부
  - ⚠️ **로컬 파일 필요**(클라우드 문서만이면 먼저 내려받아야). 주는 위치는 화면 픽셀이 아니라 **논리주소**다. 머리말/꼬리말 텍스트는 못 읽을 수 있다.

- **`find`** (드라이브 문서): 같은 구절이 **몇 곳**인지 열거(`{matchCount, occurrences:[{nth, page, docY}]}`). "문서 전체"로 한 바퀴 훑어 끝 메시지로 정확히 멈춘다. `page`는 복잡(비표준 크기) 문서에선 부정확할 수 있다.

- **`pinpoint`** (둘을 잇기): 로컬 파일을 맵으로 읽어 **문서순 N번째** 그 칸에 정확히 착지·캡처.
  - `node hancom.js pinpoint --file <로컬> --text "<구절>" --nth <N>` (`--name` 생략 시 파일명에서 유추)
  - 같은 텍스트가 여러 곳(예: 여러 표의 동일 컬럼헤더)이거나 옆에 맥락이 없어도 **문서순으로 그 N번째**를 집는다(유니크 문자열이 되면 검색 1회로 빠르게, 안 되면 전체를 훑어 문서 위치순으로 그 자리에 착지).
  - 반환: `{found, nth, address(표·행·열), context, page, shot, method}`. 못 집으면 `status`로 정직하게 알린다(예: 구절 자체가 파일에 없음, UI 매치 수가 파일과 달라 순서 정합이 안 됨).
  - **`--replace "<새 텍스트>"` (핀포인트 편집)**: 그 N번째 occurrence **한 곳만** 새 텍스트로 교체. `--apply` 없으면 dry-run(교체할 내용만 보여줌). 편집은 **headless 전용**(`--headed` 금지). 두 경로 자동 선택:
    - **유니크 앵커**(그 칸 맥락이 문서에서 유일)면 → 네이티브 '모두 바꾸기'로 그 1곳(`mode:"replace"`). 이웃 텍스트 보존.
    - **동일/반복 텍스트**(여러 표의 같은 헤더 등)라 유니크 앵커가 없으면 → 찾아바꾸기에서 **문서순 N번째 매치만 단일 '바꾸기'**(`mode:"replace-nth"`). 그 한 곳만 바뀐다.
    - (서식은 평문화될 수 있음.)
  - **`--format "<토큰들>"` (핀포인트 서식)**: 그 N번째 매치에만 서식 적용. 토큰(쉼표 구분): `bold`·`italic`·`underline`·`color:<색>`·`highlight:<색>` (예: `--format "bold,color:red"`). `--apply` 필요, headless 전용.
  - **`--insert "<텍스트>"` (핀포인트 삽입)**: 그 N번째 매치 **바로 뒤**에 텍스트 삽입. `--apply` 필요, headless 전용.
  - **`--object <image|chart|shape> [--nth N]` (글자 없는 객체 찾기)**: 그림·차트·도형은 글자가 없어 텍스트로 못 찾는다 → read.mjs가 XML에서 **문서순으로 객체를 열거**하고, 그 N번째 객체의 **옆 텍스트(랜드마크)**를 찾아 그 자리를 넓게(`--band`, 기본 400) 캡처한다. 읽기 전용. 반환에 `landmark`·`objectCount`·`available`(타입별 개수). 예: `pinpoint --file <로컬> --object image --nth 2` → 2번째 그림 옆을 캡처. (객체 옆에 텍스트가 전혀 없으면 `no_landmark` — 그땐 `capture --grid`로 좌표 캡처.)

- **`download` / `upload`** (로컬 ↔ 드라이브): read.mjs/pinpoint 의 `--file` 은 **로컬 원본**이 필요하다.
  - `node hancom.js download --name <문서이름> [--out <경로>]` → 드라이브 문서의 **현재 상태**를 로컬 `.hwp/.hwpx`로(원본 형식 그대로, 변환 없음). 기본 저장 위치 `scripts/downloads/`. 반환 `{saved, suggestedFilename, bytes, docId}`.
    - **`--pdf`**: 원본 형식 대신 **PDF로 내보내기**(파일›PDF로 다운로드). 변환이라 조금 더 걸릴 수 있음(반환 `pdf:true`). read.mjs는 PDF를 못 읽으니, 내용 확인용이 아니라 **최종 산출물(공유·인쇄용)** 일 때 쓴다.
  - `node hancom.js upload --file <로컬경로>` → 로컬 파일을 드라이브에 **새 문서**로 올림(같은 이름이어도 교체 아님 → 중복 생성 주의).
  - **루프**: `download` 로 현재 상태를 받아 → `read.mjs` 로 occurrence-맵 → `pinpoint`/편집은 한컴독스 UI(자동저장). 편집 뒤 다시 읽어야 하면 **재 `download`**(로컬은 편집하면 stale). 편집 자체는 UI 에서 하므로 보통 재업로드는 불필요.

### 🖼 그림·차트 객체 — `resize-object` · `object-prop` · `chart-data`
객체(그림/차트)는 본문 **canvas에 픽셀로** 그려져 DOM으로 못 짚는다 → **페이지 좌표 `--at "x,y"`** 로 클릭(객체 안 한 점이면 됨, `capture --grid`로 좌표 확인). 위치 자동탐색은 안 됨.
- **`resize-object`**: 객체 크기를 **개체 속성 다이얼로그의 너비/높이(mm 숫자)** 로 설정 — 드래그보다 정밀.
  - `--apply` 없으면 현재 크기만 읽음(`currentSize`). `--width`/`--height` 중 하나만도 가능. 그 좌표에 객체 없으면 `object_not_found`.
- **`object-prop`** (통합 — 크기+위치+배치+도형 스타일을 한 번에): `--pos "x,y"`(mm, **종이 왼쪽/위쪽 기준** 절대 위치) · `--width`/`--height`(mm) · `--wrap`(배치, textbox와 동일 모드) · **`--fill <색|none>`**(도형 채우기 면 색, `none`=채우기 없음) · **`--border <색>`**(선/테두리 색) · **`--border-width <mm>`**(선 굵기).
  - `--apply` 없으면 현재 값(`current`: 크기+위치)만 읽음 — **객체 위치/크기 조회용으로도 유용**.
  - 색은 이름(`red`·`빨강`)·`#RRGGBB` 둘 다. 팔레트에서 **가장 가까운 색**을 고르므로 임의 hex도 근사 적용된다(`styled`에 실제 적용된 rgb 반환).
  - **도형(사각형·타원 등)에 채우기/테두리** — 그림·차트엔 채우기 개념이 없을 수 있다. 선 객체(직선·호)는 `--fill`이 `fill_unavailable`(채우기 탭 없음) → `--border`만 가능.
  - 위치는 **떠 있는 객체만** 가능 — 글자처럼 취급(인라인) 객체면 `pos_unavailable`(그땐 `--wrap square`를 같이 줘서 떠 있는 배치로 바꾸면서 위치 지정).
  - 선(직선·호) 객체는 획이 가늘어 `--at`이 빗나가기 쉬움 — 획 위의 한 점을 줄 것(빗나가면 `object_not_found`).
- **`chart-data`**: 차트의 **데이터 편집 그리드** 셀 값을 바꿔 차트를 갱신. `--set "B2=9.9,C3=4"`(엑셀식 열문자+행번호=값). 셀=열헤더∩행헤더 교차 → 더블클릭 입력. 그 좌표에 차트 없으면 `chart_not_found`.
  - ⚠️ **그리드 구조는 차트 종류마다 다르다**(어느 셀이 무슨 뜻인지 먼저 알아야 함). 세 갈래:
    - **표준(항목×계열)** — 막대·꺾은선·영역·방사형 등 대부분: **A열 = 항목(범주) 이름**, **1행 = 계열 이름**, 그 교차셀(B2~)= 값. 예: 첫 계열 둘째 항목 값 = `B3`.
    - **원형 계열(단일 계열)** — 원형·쪼개진 원형·도넛형·3차원 원형/쪼개진 원형: **A열 = 항목 이름**, **B열 = 값 한 줄**(계열 하나). 예: 셋째 항목 값 = `B4`.
    - **분산형** — **A열 = X값**, **B·C…열 = 각 계열의 Y값**(A1 헤더는 비어 있음). 예: 둘째 점의 X = `A3`, 그 Y1 = `B3`.
  - 기본 그리드는 4항목(막대류는 3계열×4항목). `chart-data`는 **이미 있는 셀만** 짚는다(없는 셀은 `cell_not_located`) — 종류를 모르면 먼저 `--at` 좌표의 차트를 캡처해 그리드를 확인하고 값을 바꿀 것.
- **`caption --at "x,y" --text "<캡션>" [--position below|above|left|right]`**: 그 좌표의 **객체(그림/표/차트/도형)에 캡션**을 단다(예: "그림 1. …"). `--position` 기본 `below`(아래). 그 좌표에 객체 없으면 `object_not_selected`. 한글 위치(`"오른쪽 위"` 등)도 그대로 받음.
- ⚠️ 편집은 **headless 전용**. 표 셀은 작아 좌표클릭이 빗나가니 셀은 `set-cell-text`(셀 텍스트로 찾기)가 정확.

### ➕ 삽입 — `insert-table` · `insert-image` · `insert-chart`
입력 메뉴로 새 표/그림/차트를 삽입. `--anchor` 있으면 **그 텍스트 줄 다음에**, 없으면 문서(본문 흐름) 시작에.
- **`insert-table --rows R --cols C`**: 입력›표 다이얼로그(줄/칸 개수)로 R×C 표 생성.
- **`insert-image --file <이미지>`**: 입력›그림(장치) 다이얼로그에 로컬 이미지 파일을 넣어 삽입.
- **`insert-chart [--type N]`**: 입력›차트의 **종류 그리드**에서 N번째 차트를 삽입(기본 데이터로 생성 — 값은 이후 `chart-data`로 수정). `--type` 0~19(생략=0). 무엇인지 모르면 0으로 두고 삽입 후 캡처로 확인. **종류 인덱스**:
  - 0 세로 막대형 · 1 누적 세로 막대형 · 2 꺾은선형 · 3 가로 막대형 · 4 누적 가로 막대형 · 5 분산형 · 6 원형 · 7 쪼개진 원형 · 8 도넛형 · 9 영역형 · 10 누적 영역형 · 11 방사형 · 12~19 3차원(세로막대/누적세로막대/가로막대/누적가로막대/원형/쪼개진원형/영역/누적영역)
- ⚠️ 편집 **headless 전용**. 떠다니는 객체가 많은 문서는 삽입 위치가 본문 흐름 기준이라 시각적 최상단과 다를 수 있음(`--anchor`로 위치 지정 권장).

### ▦ 표 줄/칸·나누기·합치기·셀크기·계산 — `table-op`
대상 셀에 캐럿(`--cell` 텍스트로 찾기, 필요시 `--tab N`으로 인접 셀)을 두면 **표 메뉴**가 활성. `--op`:
`insert-row-above` · `insert-row-below` · `insert-col-left` · `insert-col-right` · `delete-row` · `delete-col` · `split` · `merge` · `equal-width` · `equal-height` · `block-calc` · `thousands` · `clear-cell`. dry-run 기본, `--apply`로 실행, **headless 전용**.
- **단일 셀 op**(줄/칸 추가·삭제, split, clear-cell): `--cell` 한 곳이면 됨.
- **다중 셀 op**(`merge`·`equal-width`·`equal-height`·`block-calc`): 범위가 필요 → **`--to "<끝 셀 텍스트>"`** 로 시작 셀(`--cell`)부터 끝 셀까지를 잡는다(예: `--cell 가 --to 나`). 직사각형 블록.
- **`split`** (셀 나누기): 한 셀을 여러 칸으로 분할. `--split-rows N --split-cols M` (기본 1×1).
- **`merge`** (셀 합치기): `--cell`~`--to` 블록을 한 셀로 합침.
- **`equal-width` / `equal-height`** (셀 너비/높이를 같게): 블록 안 셀들의 너비/높이를 균등하게.
- **`clear-cell`** (셀 지우기): 셀 **내용**을 비움(셀 자체는 유지).
- **`block-calc --calc sum|avg|product`** (블록 계산식): 선택한 숫자 셀들의 합계/평균/곱. 결과를 넣을 빈 셀을 블록에 포함해야 함.
- **`thousands --comma on|off`** (1,000 단위 구분 쉼표): 숫자에 자릿점 넣기(`on`)/빼기(`off`). 단일 셀이면 `--to` 없이도 됨.
- 셀 값 채우기는 `set-cell-text`.

```bash
node hancom.js table-op --name <문서이름> --cell "<셀 텍스트>" --op split --split-rows 2 --split-cols 2 --apply
node hancom.js table-op --name <문서이름> --cell "가" --to "나" --op merge --apply
node hancom.js table-op --name <문서이름> --cell "1" --to "2" --op equal-width --apply
```

### ▦ 표 셀 배경·테두리·대각선 — `cell-style`
`--cell "<셀 텍스트>"`로 셀을 잡아 **셀 테두리/배경** 다이얼로그를 적용. dry-run 기본, `--apply`, **headless 전용**.
- **`--fill <색|none>`**: 셀 배경 면 색(`none`=색 없음). 색은 이름(`red`·`blue`…) 또는 `#RRGGBB`.
- **`--border <색>`** + **`--border-where <위치>`**: 테두리 색과 적용 위치. 위치는 `outer`(전체 바깥=상하좌우, 기본) · `top` · `bottom` · `left` · `right`, **콤마 조합 가능**(예: `top,left` · `top,bottom,right`). `--border-width <mm>`로 굵기.
- **`--diagonal <backslash|slash|x|center-h|center-v|cross|none>`** (+`--diagonal-color <색>`): 셀 대각선(`\`·`/`·`X`·가로중심선·세로중심선·십자). ⚠️ 대각선은 **파일엔 저장되지만 webhwp 화면엔 안 그려진다**(시각으로는 확인 불가 — 다른 뷰어/데스크톱 한글에서 보임).
```bash
node hancom.js cell-style --name <문서이름> --cell "<셀 텍스트>" --fill yellow --apply
node hancom.js cell-style --name <문서이름> --cell "<셀 텍스트>" --border red --border-where "top,left" --apply
```

### ▦ 표/셀 속성 — `table-cell-prop`
우클릭 **표/셀 속성** 다이얼로그. `--cell`(+`--to`로 여러 셀)로 잡아 적용. dry-run 기본, `--apply`, **headless 전용**.
- **셀 크기**: `--cell-width <mm>` · `--cell-height <mm>`('셀 크기 적용' 자동 체크 후 설정).
- **세로 정렬**: `--valign top|middle|bottom` (셀 안 글의 위/가운데/아래).
- **셀 안 여백**: `--cell-margin "왼,오,위,아래"` (mm).
- **제목 셀**: `--title-cell` (쪽 넘어갈 때 자동 반복되는 머리 셀).
- **표 전체 크기**: `--table-width <mm>` · `--table-height <mm>`.
```bash
node hancom.js table-cell-prop --name <문서이름> --cell "<셀 텍스트>" --cell-height 30 --valign bottom --apply
```

### 🔢 쪽 번호 · 쪽 나누기 — `page-number` / `page-break`
- **`page-number --where header|footer --align left|center|right`**: 머리말/꼬리말에 쪽 번호 삽입(모든 쪽에 자동). dry-run 기본, `--apply`로 실행, **headless 전용**.
- **`page-setup`** (편집 용지 — 문서 전체 레이아웃): `--orientation portrait`(세로)`|landscape`(가로) · `--width`/`--height`(용지 크기 mm) · 여백 `--top`/`--bottom`/`--left`/`--right`/`--header`/`--footer`(mm).
  - `--apply` 없으면 **현재 용지값(`current`: 폭·길이·여백)만 읽음** — 조회용으로도 유용. `--apply`, **headless 전용**.
- **`page-break --anchor "<단락 안 텍스트>"`**: 그 줄 **끝에서 쪽을 나눠** 뒤 내용을 새 쪽으로. `--apply`, **headless 전용**.
- **`para-line --anchor "<단락 안 텍스트>"`**: 그 줄 **다음에 가로 구분선(문단 띠)**을 새 단락으로 삽입. `--apply`, **headless 전용**.
- **`field --anchor "<단락 안 텍스트>" --guide "<안내문>" [--field-name "<이름>"]`**: 그 줄 **끝에 누름틀(양식 자리)**을 삽입 — `--guide`가 자리에 표시될 안내문(예: "이름을 입력하세요"), `--field-name`은 양식 식별용 이름(선택). 채우는 양식 템플릿용. `--apply`, **headless 전용**.
- **`bookmark --anchor "<단락 안 텍스트>" --mark-name "<책갈피 이름>"`**: 그 위치에 **책갈피(이름표)**를 단다 — 본문엔 안 보이는 이동/참조용 표식. `--apply`, **headless 전용**. 확인: `download` 후 `read.mjs <파일> --bookmarks`로 이름 목록 조회(**`.hwpx`만 읽힘** — `.hwp`는 read.mjs가 못 읽어 0으로 나올 수 있으나 삽입은 됨).
- **`shape --anchor "<근처 텍스트>" --shape rect|ellipse|line|arc`**: 그 근처 본문에 **도형**(직사각형·타원·직선·호)을 그린다. `--wrap`으로 본문과의 배치(`inline`/`square`/`behind`/`front`/`topbottom`, 생략 시 떠 있음 — textbox와 동일). `--apply`, **headless 전용**.
- **`equation --anchor "<단락 안 텍스트>" --script "<수식 스크립트>"`**: 그 줄 **다음에 수식**을 삽입. `--script`는 **한컴 수식 스크립트**(아래 문법). `--apply`, **headless 전용**.
  - **수식 스크립트 문법** (검증됨 — 렌더 확인):
    - 위/아래 첨자: `a^b`(위) · `a_b`(아래) · `a^b _c`(둘 다). 묶음은 중괄호: `e^{-x}`
    - 분수: `a over b` (예 `{n+1} over 2`) · 근호: `sqrt{x}` · n제곱근: `root n of x`
    - 합/적분/극한: `sum from {i=1} to n` · `int _a ^b` · `lim _{x rightarrow 0}` (`inf`=∞)
    - 괄호(내용 크기 자동): `left( ... right)` · `left[ ... right]` · `left{ ... right}`
    - 행렬: `matrix{ a & b # c & d }` (`&`=칸 구분, `#`=줄 구분) · 경우: `cases{ ... }` · 세로 쌓기: `pile{ ... }`
    - 장식: `vec{a}`(→) · `bar{a}`(¯) · `hat{a}`(^) · `dot{a}` · `tilde{a}`
    - 그리스: `alpha beta gamma theta lambda pi ...`(소문자) · `GAMMA SIGMA OMEGA ...`(대문자)
    - 기호: `+-`(±) · `times`(×) · `cdot`(·) · `div`(÷) · `<=` `>=` `!=` · `rightarrow`(→) · `<=>`(⇔) · 공백 `~`(`~~`=넓게)
    - 예: `x = {-b +- sqrt{b^2 -4ac}} over {2a}` → 근의 공식
    - **전체 토큰 목록**(그리스/집합/연산·논리/화살표/기타 기호 + 템플릿 변형 전부): `references/equation-syntax.md`

### 🔡 글자 모양 · 문단 모양 다이얼로그 — `char-shape` / `para-shape`
- **`char-shape --text "<구절>" [--spacing N] [--width N]`**: 구절을 선택해 글자 모양 적용 — `--spacing`(자간 %)·`--width`(장평 %). `--apply`, **headless 전용**.
- **`para-shape --anchor "<단락 안 텍스트>" [--left N] [--right N] [--before N] [--after N]`**: 그 단락의 여백/간격(mm) — `--left`/`--right`(좌우 여백)·`--before`/`--after`(문단 위/아래 간격). 단락 단위. `--apply`, **headless 전용**.

### 🔗 각주 · 미주 · 메모 · 하이퍼링크 · 글상자
- **`footnote --anchor "<텍스트>" --text "<내용>"`**: 그 위치에 각주(쪽 하단). · **`endnote …`**: 미주(문서 끝).
- **`memo --anchor "<텍스트>" --text "<내용>"`**: 그 위치에 메모(우측 여백 댓글).
- **`hyperlink --text "<구절>" --url "<주소>"`**: 구절에 링크(파란 밑줄).
- **`textbox --anchor "<근처 텍스트>" --text "<내용>" [--wrap <배치>]`**: 글상자 삽입. `--wrap`으로 **본문과의 배치**: `inline`(글자처럼 취급 — 텍스트 흐름 안 인라인) · `square`(어울림) · `behind`(글 뒤로) · `front`(글 앞으로) · `topbottom`(자리 차지). 생략하면 떠 있는(floating) 글상자.
- 모두 `--apply`, **headless 전용**.

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
node hancom.js set-cell-text --name <문서이름> --file <로컬 .hwp/.hwpx> --table T --row R --col C --text "<값>" [--apply]
```

- **동작**: `--cell` 텍스트가 있는 셀을 찾아 캐럿을 두고, **Tab을 N번**(기본 1 = 바로 다음 셀) 눌러 대상 셀로 이동 → 그 셀의 기존 내용을 선택해 `--text`로 교체(빈 셀이면 그냥 채움). `--tab 0`이면 기준 셀 자체를 바꾼다.
- **빈 셀을 행/열로 지정**(`--file --table --row --col`): 로컬 파일(read.mjs)로 그 표의 **첫 텍스트 셀(앵커)+colCnt** 를 읽어 **(row,col)까지 Tab 횟수를 자동 계산** → 텍스트 없는 셀도 도달. (병합 셀 없는 단순 격자 기준. 표에 텍스트 셀이 하나도 없으면 `cellnav_failed`.)
- **`--apply` 없으면 dry-run(read-only)**: 기준 셀을 찾았는지(`foundPage`)만 확인.
- **반환**: 적용 시 `{applied:true, cell, tab, text, page, docId, shot}`. 기준 셀이 없으면 `{status:"cell_not_found"}`.
- **셀 지정 팁**: 같은 행에서 **고유한 라벨 셀**을 `--cell`로(예: `"매출"`), 그 오른쪽 칸이면 `--tab 1`, 두 칸 뒤면 `--tab 2`. 어디로 가는지 헷갈리면 먼저 `capture`로 표를 보고 칸 수를 센다. (셀이 한 줄일 때 정확 — 여러 줄 셀은 첫 줄만 교체.)

> ⚠️ 편집은 headless 전용(`--headed`는 보기 전용), 캐럿은 찾기로만 이동하고 본문에 블라인드 입력하지 않는다.

## 𝐁 편집 — 글자 서식 (`format-text`)

문서에서 **특정 구절을 찾아 글자 서식**(굵게/기울임/밑줄/취소선)을 적용한다. **글꼴(font-family)**은 별도 명령.

```bash
node hancom.js format-text --name <문서이름> --text "<구절>" --bold [--italic] [--underline] [--strike] [--apply]
node hancom.js font-family --name <문서이름> --text "<구절>" --font "<글꼴명>" [--nth N] [--apply]
```

- **동작**: `--text` 구절을 찾아 그 구절만 선택한 뒤 준 서식을 토글(이미 적용돼 있으면 해제). 여러 서식 동시 지정 가능.
- **서식 플래그**: `--bold`(굵게·Cmd+B) · `--italic`(기울임·Cmd+I) · `--underline`(밑줄·Cmd+U) · `--strike`(취소선·툴바). **하나 이상** 필요.
- **`font-family`**: 구절 선택 후 툴바 글꼴 목록에서 `--font` 글꼴을 골라 적용(예: `"맑은 고딕"`·`"HY견고딕"`·`"Arial"`). 같은 구절 여럿이면 `--nth N`. ⚠️ `--font`은 **문서 글꼴 목록에 있는 정확한 이름**이어야 함 — 없으면 `{status:"font_not_available", available:[...]}` 로 사용 가능한 글꼴 목록을 돌려준다.
- **`--apply` 없으면 dry-run(read-only)**: 구절이 문서에 있는지(`foundPage`)만 확인.
- **반환**: 적용 시 `{applied:true, text, styles, selChars, page, docId, shot}`. 구절이 없으면 `{status:"text_not_found"}`, 선택에 실패하면 `{status:"selection_failed"}`(더 고유한 구절로 재시도).
- **구절 고르기**: 문서에 **한 번만 나오는 구체적 구절**로(여러 번 나오면 첫 매치에만 적용).

> ⚠️ 편집은 headless 전용(`--headed`는 보기 전용). **토글**이라 이미 그 서식이 걸린 구절에 다시 적용하면 해제된다 — 결과를 `shot`(또는 `capture`)으로 확인.

## 🎨 편집 — 글자 색 (`font-color`)

구절의 **글자 색**을 바꾼다.

```bash
node hancom.js font-color --name <문서이름> --text "<구절>" --color <색> [--apply]
node hancom.js highlight  --name <문서이름> --text "<구절>" --color <색> [--apply]
```

- **`--color`**: 이름(`red`·`blue`·`green`·`black`·`yellow`·`orange`·`purple`·`gray`·`navy`·`pink` / 빨강·파랑·초록·검정 …) 또는 **`#RRGGBB`** hex. 한컴 팔레트에서 **가장 가까운 색**을 골라 적용(`picked` rgb로 확인).
- **동작**: `--text` 구절을 (드래그로) 선택 → 글자색(font-color) 또는 **형광펜(highlight, 배경색)** 팔레트에서 최근접 색 클릭.
- **`highlight`**: font-color 와 동일 사용법 — 글자가 아니라 **배경(형광펜)** 색. 노랑/초록 등.
- **`--apply` 없으면 dry-run(read-only)**. 반환 `{applied:true, text, color, picked, selChars, page, docId, shot}`. 못 찾으면 `{status:"text_not_found"}`.

> ⚠️ 편집은 headless 전용. 결과 확인은 `around --zoom`으로 크게.

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
node hancom.js list --name <문서이름> --anchor "<단락 안 텍스트>" --type bullet|number [--shape N] [--apply]
```

- **동작**: `--anchor` 단락에 캐럿을 두고 `--type bullet`(글머리표 ●) 또는 `number`(문단번호 1.)를 토글. **단락 단위**.
- **`--shape N` (모양 선택)**: ▼ 드롭다운의 N번째 모양 적용(생략 시 기본 1). 범위를 벗어나면 `{status:"shape_not_found"}`.
  - **번호 1~10**: `1` 1.가.1) · `2` (1)(가) · `3` 1)가) · `4` ①(ㄱ) · `5` 가)a) · `6` (ㄱ)(1) · `7` I.A. · `8` i.a. · `9` A.1. · `10` 1.1.1.(다단계)
  - **글머리표 1~17**: `1` ● · `2` ·(점) · `3` ■ · `4` ▪ · `5` ◆ · `6` ◆(작은) · `7` ▶ · `8` ○ · `9` □ · `10` ◇ · `11` ▷ · `12` ◉ · `13` ☑ · `14` ✓ · `15` ★ · `16` ❖ · `17` ☞
- **`--apply` 없으면 dry-run(read-only)**. 반환 `{applied:true, anchor, type, shape, page, docId, shot}`. 단락을 못 찾으면 `{status:"anchor_not_found"}`.

### 목록 수준 (`level`) — 한 수준 증가/감소
문단번호/개요 단락의 **수준**을 바꾼다. 기본 문단번호 형식은 수준별로 `1.`→`가.`→`1)`→`가)` 로 마커가 달라진다.
```bash
node hancom.js level --name <문서이름> --anchor "<단락 안 텍스트>" --to increase|decrease [--by N] [--apply]
```
- **`--to decrease`**: 한 수준 **아래로**(하위, 들여쓰기) — `1.`→`가.`→`1)`. **`--to increase`**: 한 수준 **위로**(상위) — `가.`→`1.`.
- **`--by N`**: N단계(기본 1). 1수준에서 `increase`는 더 올라갈 데가 없어 변화 없음(정상).
- 번호/글머리표 목록(`list`)을 먼저 적용한 단락에 쓴다. `--apply` 없으면 dry-run.

### 스타일 (`style`) — 단락 스타일 적용
단락에 **스타일**(바탕글·본문·개요 1~10·쪽 번호·머리말 등)을 적용한다.
```bash
node hancom.js style --name <문서이름> --anchor "<단락 안 텍스트>" --style "<스타일명>" [--apply]
```
- `--style`은 서식 스타일 콤보의 이름과 정확히 일치해야(예: `"개요 1"`·`"본문"`). 목록에 없으면 `{status:"style_not_available", available:[...]}`.

> ⚠️ 편집은 headless 전용(`--headed`는 보기 전용).

## ⬌ 편집 — 단락 정렬 (`align`)

기준 텍스트가 있는 **단락의 정렬**을 바꾼다.

```bash
node hancom.js align --name <문서이름> --anchor "<단락 안 텍스트>" --to left|center|right|justify|distribute|divide [--apply]
```

- **동작**: `--anchor` 텍스트가 있는 단락에 캐럿을 두고 정렬을 적용. **단락 단위**(선택 불필요).
- **`--to`**: `left`(왼쪽) · `center`(가운데) · `right`(오른쪽) · `justify`(양쪽) · `distribute`(배분) · `divide`(나눔).
- **`--apply` 없으면 dry-run(read-only)**. 반환 `{applied:true, anchor, to, page, docId, shot}`. 단락을 못 찾으면 `{status:"anchor_not_found"}`.

## ↕ 편집 — 줄간격 (`line-spacing`)

기준 텍스트가 있는 **단락의 줄간격(%)** 을 바꾼다.

```bash
node hancom.js line-spacing --name <문서이름> --anchor "<단락 안 텍스트>" --to 200 [--apply]
```

- **동작**: `--anchor` 단락에 캐럿을 두고 줄간격을 적용. **단락 단위**(선택 불필요).
- **`--to`**: 줄간격 %. 프리셋 `100·130·160·180·200·300` 은 드롭다운에서 바로, 그 외 값은 입력칸에 직접 입력.
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
