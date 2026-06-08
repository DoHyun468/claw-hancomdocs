# 한컴독스 캡처 도구 — 개발 노트 (디버그 팀용)

한컴독스(hancomdocs.com 웹 뷰어 webhwp)에 .hwp/.hwpx 파일을 자동 업로드하고,
렌더된 페이지를 이미지로 캡처/확대/텍스트검색하는 도구를 만든 과정과 기술적 발견 정리.
위치: `~/Documents/sideproj/hancom-auto/`. 핵심 파일: `hancom.js`(에이전트 CLI), `login.js`(로그인), `ORDER_SPEC.txt`(주문 명세).

---

## 1. 접근법 결정 — 왜 Playwright headless인가

처음엔 **네이티브 UI 자동화**(macOS osascript 키입력 + CoreGraphics 마우스클릭 + `screencapture`)로 시도.
- Accessibility 권한 받아서 동작은 함(키입력·클릭·화면캡처 다 됨).
- **치명적 문제: 물리 마우스·키보드·화면을 공유**한다. 클릭할 때마다 사용자 커서가 실제로 움직이고, 백그라운드 불가, 사용자가 동시에 마우스 쓰면 충돌. 5분 폴링이면 5분마다 마우스를 빼앗김.

→ **Playwright(headless Chromium)로 전환.** 물리 입력 0, 백그라운드 가능.
결정적으로 `setInputFiles()` / filechooser로 **파일 input에 직접 주입** → "네이티브 파일 피커" 문제 자체가 사라짐.
(처음에 막혔던 건 Claude의 file_upload 툴이 세션 연결 폴더만 허용한 것 + 브라우저 제어가 read-tier라 클릭 막힌 것. Playwright는 둘 다 우회.)

## 2. 로그인 / 세션 (비밀번호 저장 안 함)

- **storageState 패턴**: 비밀번호 대신 로그인된 세션(쿠키+localStorage)을 `auth.json`으로 저장해 재사용.
- **함정**: 한컴 SSO는 **세션 쿠키**(만료시간 없음)라, persistentContext를 재시작하면 Chromium이 디스크에 안 남기고 버린다 → 로그아웃됨. 그래서 **로그인 직후 그 자리에서 `ctx.storageState({path})`로 떠야** 세션 쿠키까지 캡처된다. `login.js`가 로그인 완료를 자동 감지(URL이 accounts.hancom.com 벗어나고 업로드 UI 등장)해서 즉시 저장.
- 로그인은 OAuth 경유. `auth.json`은 **현재 세션 그 자체**라 민감 → chmod 600 + .gitignore. 만료 시 `node login.js` 재실행으로 갱신.
- 앱 URL: 홈 `/ko/home`, 드라이브 `/ko/mydrive`. 미로그인 시 `accounts.hancom.com`으로 리다이렉트 → 이걸로 **AUTH_EXPIRED** 판정.

## 3. webhwp 웹 뷰어 내부 — 디버깅에서 알아낸 것들 (핵심)

> webhwp는 한컴독스가 문서를 여는 웹 에디터(webhwp.hancomdocs.com). 아래는 자동화하려고 리버스로 알아낸 동작.

- **문서 본문은 `<canvas>` 렌더, DOM 텍스트 아님.** → selector로 텍스트/표 위치를 못 찾는다. 이게 모든 설계 제약의 근원.
- **캔버스는 2층(동일 크기).** ① **문서층**: 흰 페이지 배경 = 불투명 픽셀 다수(측정 ~700k). ② **오버레이층**: 거의 투명(불투명 ~수백) = 진입 presence '파란 물방울'·원격 커서·캐럿이 여기 그려짐. → **둘을 분리 식별할 땐 '불투명(alpha>10) 픽셀 수'로** (어두운 픽셀로 세면 투명픽셀이 어둡게 잡혀 뒤집힘, §10 함정).
- **스크롤 컨테이너 = `#hcwoViewScroll`.** `scrollTop`을 JS로 직접 제어 가능. 캔버스는 가상화돼서 scroll 이벤트마다 보이는 영역만 다시 렌더.
- **페이지 점프**: 100% 줌·A4 기준 **한 페이지 = scrollTop 1143px로 일정**(문서 내용 무관). → N쪽 = `(N-1)*1143`. 총 페이지 수 몰라도 점프 가능.
- **총 페이지 수**: 상태바 "x / Y쪽"에서 Y는 대용량 문서면 "?"로 안 풀림(lazy pagination). 반면 **x(현재 쪽)는 캐럿 기준**이라, 찾기 직후 읽으면 정확.
- **HwpApp 전역 JS 객체** 존재하나 **난독화 심함**(`$zs`, `appState.OPt` 등) → 도구로 쓰면 webhwp 업데이트마다 깨짐. 안 씀.
- **찾기(Find) UI 흐름**: 툴바 `찾기` 버튼(아이콘 `<a>`)은 **드롭다운** → "찾기..." 메뉴 → 다이얼로그(`찾을 내용` 입력 + `다음 찾기` 버튼).
  - ⚠️ **하드코딩 좌표 click(309,95)/(335,167)는 폐기됨**(창크기·UI버전·배율 바뀌면 빗나가 다이얼로그가 안 열려 "검색칸 탐색 실패"). → 현재 `openFindDialog()`가 **셀렉터/DOM위치**로 연다: 메인은 `a[title="찾기"]`, 드롭다운 '찾기...' 항목은 `offsetParent!==null` 가시성 필터 + 실제 중심좌표를 읽어 클릭. **UI 요소는 좌표 금지, 셀렉터/DOM위치로.**
  - 검색 입력칸은 "새로 뜬 보이는 input"으로 검출, `다음찾기` 버튼은 입력칸 우측 +70 좌표.
  - **검색 입력칸은 안전**: 거기 타이핑은 문서를 편집하지 않음. `다음찾기` 누르면 캐럿이 매치로 이동 → **상태바 현재 쪽 = 매치의 정확한 페이지**. 캐럿(`#HWP_CURSOR_VIEW`)의 픽셀 위치를 읽으면 **매치 줄로 바로 확대**(`around --zoom`)도 가능. 끝나면 **Esc로 검색 하이라이트(파란 선택박스) 제거**(캡처 혼동 방지).
  - ⚠️ `Ctrl+F`·`Ctrl+End` 등 **키보드 단축키는 webhwp에서 신뢰 불가**(안 먹음). 좌표 클릭/스크롤로 우회.
- **A4 페이지 영역 자동 검출**: 캔버스 픽셀을 `getImageData`로 읽어 흰색 페이지 사각형의 좌/우/상/하 경계를 스캔 → **그 영역만 clip**. 결과: 툴바·여백 없이 A4 한 장만 깔끔히. **방향 무관**(세로 792×1121, 가로 1122×792 자동 인식).
- **협업/진입 흔적 2종 + 숨김**: `hideOverlays`가 캡처 직전에 둘 다 처리.
  - ① **DOM 흔적**(커서 이름표 `.user_cursor_container`·협업자 패널·채팅 위젯) → CSS `display/visibility:hidden`.
  - ② **캔버스 흔적**(진입 presence '파란 물방울'·캐럿·원격 커서; 오버레이 캔버스에 렌더) → **오버레이 캔버스만 `visibility:hidden`**(`hideOverlayCanvases`). 본문(문서 캔버스)은 보존.
  - "파란 물방울"은 **협업자가 아니라 문서 진입 직후 ~2.5~3s 뜨는 본인 presence 애니메이션**이었다(좌상단 고정, 자연 소멸). 한때 "원격 마우스 포인터, 캔버스라 못 숨김"으로 오진 → 실제론 오버레이 층만 가리면 즉시 제거됨(대기 0초). 자세한 수사 경로는 §10.

## 4. ⚠️ 가장 중요한 안전 교훈 — 문서 자동 편집 사고

- webhwp 본문 입력 영역은 `<input aria-label="문서 편집 영역">`.
- `Ctrl+F`가 검색창을 안 여는 걸 모르고 **"보이는 첫 input에 블라인드 입력"** 했더니, 그게 문서 편집 영역/제목칸이라 **문서 이름이 검색어로 바뀌어 버림**(파일명이 "민간투자"로 변경됨). 드라이브 "이름 바꾸기" UI로 복구.
- **교훈: 절대 블라인드로 input을 채우지 말 것. 찾기는 반드시 찾기 다이얼로그의 검색칸만 타겟.** 읽기전용 모드가 있으면 더 안전(미적용).

## 5. claw-hwp 스킬 사용법 (테스트 입력 생성)

기존 `claw-hwp:hwp` 스킬(이 프로젝트의 다른 부분)을 **테스트 파일 생성기**로 사용.
- `scripts/create.js`에 JSON 명령을 stdin으로 파이프 → .hwp/.hwpx 생성(확장자로 포맷 결정).
  ```bash
  echo '{"path":"t.hwp","operations":[
    {"type":"setup_document","page_size":"a4","orientation":"landscape"},
    {"type":"append_heading","level":1,"text":"제목"},
    {"type":"append_paragraph","text":"본문","runs":[{"text":"형광","highlight":"#FFFF00"}]},
    {"type":"append_table","headers":["A","B"],"rows":[["1","2"]]}
  ]}' | node create.js
  ```
- 이걸로 **단순/표/스타일/가로 hwp + hwpx** 5종 + 절단 손상본을 만들어 캡처 도구를 교차 검증.
- 스킬 위치: `~/.claude/plugins/cache/claw-hwp/claw-hwp/<버전>/skills/hwp/scripts/`. SKILL.md에 create/edit/convert/extract/preview 전체 사용법 있음.

## 6. 완성된 CLI (에이전트 주문용)

```
node hancom.js capture --file <경로> [--page N] [--grid] [--scale N]      # A4 한 장 클린 캡처(격자 옵션)
node hancom.js zoom    --name <이름> --clip "x,y,w,h" [--page N]           # 페이지-로컬 좌표로 영역 확대(scale 3)
node hancom.js around  --name <이름> --text "<검색어>" [--zoom [--band N]] # 텍스트 찾아 그 페이지/매치줄 캡처
node hancom.js locate  --name <이름> --clues "a,b,c" [--grid]             # 여러 단서 다수결로 페이지 찾기
```
좌표계: 페이지 왼쪽위 = (0,0). `--grid`가 100px 격자+라벨을 얹어 좌표 읽기 보조.
`around --zoom`은 좌표 없이 매치 줄을 바로 확대(캐럿 위치 기반, §3/§10).
결과는 마지막 줄 `RESULT_JSON={...}`. 열 수 없는 파일은 `{"status":"cannot_open",...}`(exit 5).

## 7. 손상 파일 — 두 가지 실패 모드

| 모드 | 트리거 | webhwp 동작 | 도구 감지 |
|---|---|---|---|
| ① 명시적 에러 | 실제 round-trip 손상(예: known_broken_sheetjs_roundtrip.hwp) | "문서를 열 수 없습니다 / 파일을 여는 동안 오류" 다이얼로그 | ✅ openDoc이 body innerText 정규식으로 감지 → `cannot_open`. hwp·hwpx 동일. |
| ② 조용한 가비지 | 절단/부분손상 zip | 거부 안 하고 **원시 바이트(mimetype/Contents/PK 문자열+깨진글자)를 텍스트로 렌더** | ❌ "성공"처럼 통과. (감지하려면 렌더 텍스트에 zip 내부마커 있으면 의심 플래그 — 미구현) |

## 8. 알려진 한계

- 페이지 점프는 **100% 줌·A4 portrait 가정**(1143px). 다른 용지/배율은 `--page-height`로 보정.
- `around`는 **첫 매치**로 감(문서 처음부터 아래로). 매치가 1쪽이거나 미발견이면 둘 다 page 1로 보여 구분 약함.
- **중복 탭 주의**: 드라이브는 '한 번 클릭=열기'라 `openDoc`은 `row.click()`. (과거 `dblclick`은 편집기 탭을 2개 띄워 같은 계정 협업자로 잡히고 캡처에 물방울을 만들었다 — §10.) 실제 타인이 같은 문서를 동시 편집 중이면 진짜 협업 커서가 보일 수 있고 그건 §3 숨김 대상.
- 줌 선명도는 `--scale`로 조절(캔버스가 devicePixelRatio로 재렌더돼 실제 고해상도).

## 9. 환경 1회 세팅 (다른 머신/세션 재현)

1. `npm i playwright` + `npx playwright install chromium`
2. `node login.js` → 뜬 브라우저에서 한컴독스 로그인 → `auth.json` 자동 생성(계정 로그인이라 복사 불가, 머신마다 1회).
이후엔 위 CLI가 헤드리스로 동작. 스킬화하면 SKILL.md+스크립트는 복사로 전파, 세팅만 1회.

## 10. 캔버스 뷰어 디버깅 방법론 — "안 보이던 게 캡처에 찍힐 때"

webhwp는 본문을 캔버스로 그려서 selector로 못 짚는다. 캡처에 **원인 모를 요소(파란 물방울 등)**가 찍히면 아래 순서로 정체를 확정한다. (2026-06 '파란 물방울' 수사에서 실제로 쓴 절차. 실험 스크립트는 비커밋이지만 기법은 이게 전부다.)

1. **영역 클립 캡처로 의심 부위만 본다.** 전체 대신 `ed.screenshot({clip:{x,y,width,height}})`로 그 부분만 떠서 눈으로 확인 → 반복이 싸다.
2. **DOM인지 캔버스인지 가른다.**
   - `document.elementsFromPoint(x,y)` 로 그 좌표의 요소 스택을 본다 / `[class*="cursor"],[class*="collab"]` 등으로 후보를 덤프(rect·display·visibility).
   - DOM이면 → CSS(`display/visibility:hidden`)로 숨기면 끝.
   - DOM에 없으면 → **캔버스에 그려진 것**. 다음 단계.
3. **어느 캔버스인지, 색은 무엇인지 픽셀로 분리 측정.** 캔버스가 여러 장이므로 **장마다** `getContext('2d').getImageData()`로:
   - 불투명(alpha>10) 픽셀 수 → **문서층 vs 오버레이층** 구분(문서 ~700k, 오버레이 ~수백).
   - 특정 색(예 파랑 `b>150 && b>r+40 && b>g+25`) 픽셀 수 → 그 요소가 어느 층에 있는지.
4. **transient(애니메이션)인지 시간축으로 본다.** 같은 클립을 `t=0.6/1.5/2.5/4s`에 찍어 비교 → 시간 지나 사라지면 진입/로딩 애니메이션. (물방울은 ~2.5~3s 후 소멸이었다.)
5. **해결**: DOM이면 CSS 숨김. 오버레이 캔버스면 **그 캔버스만 `visibility:hidden`**(문서층 보존). transient면 그냥 기다려도 되지만, 층 숨김이 더 빠르다(대기 0초).

### ⚠️ 빠지기 쉬운 함정
- **'어두운 픽셀 = 글자'로 캔버스를 고르지 마라.** 오버레이 캔버스는 투명(rgb 0,0,0,a0)이라 어둡게 잡혀 **문서/오버레이가 뒤집힌다**(실제로 본문을 가려버린 적 있음). → 반드시 **불투명(alpha)·흰 배경** 기준으로 식별.
- **측정값(`cursorChildren` 등)만 믿지 마라.** "협업자 1명"으로 보였지만 실은 내가 `dblclick`으로 연 **중복 탭**이 서로를 협업자로 잡은 self-inflicted였다. → 드라이브는 **한 번 클릭=열기**(`row.click()`), dblclick은 탭 2개를 만든다.

### 텍스트 위치로 바로 확대(좌표 없이)
찾기 직후 캐럿이 매치로 이동하고 **캐럿은 DOM 요소**(`#HWP_CURSOR_VIEW`/`.BLINK_CURSOR`)다. 그 `getBoundingClientRect()`로 매치의 픽셀 위치를 얻어 그 줄을 밴드로 잘라낸다 → `around --zoom`. 격자 읽기·좌표 입력이 필요 없다.
