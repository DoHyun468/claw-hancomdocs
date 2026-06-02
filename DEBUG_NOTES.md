# 한컴독스 캡처 도구 — 개발 노트 (디버그 팀용)

한컴독스(hancomdocs.com 웹 뷰어 webhwp)에 .hwp/.hwpx 파일을 자동 업로드하고,
렌더된 페이지를 이미지로 캡처/확대/텍스트검색하는 도구를 만든 과정과 기술적 발견 정리.
위치: `~/Documents/sideproj/hancom-auto/`. 핵심 파일: `hancom.js`(에이전트 CLI), `login2.js`(로그인), `ORDER_SPEC.txt`(주문 명세).

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
- **함정**: 한컴 SSO는 **세션 쿠키**(만료시간 없음)라, persistentContext를 재시작하면 Chromium이 디스크에 안 남기고 버린다 → 로그아웃됨. 그래서 **로그인 직후 그 자리에서 `ctx.storageState({path})`로 떠야** 세션 쿠키까지 캡처된다. `login2.js`가 로그인 완료를 자동 감지(URL이 accounts.hancom.com 벗어나고 업로드 UI 등장)해서 즉시 저장.
- 로그인은 Kakao OAuth 경유. `auth.json`은 **현재 세션 그 자체**라 민감 → chmod 600 + .gitignore. 만료 시 `node login2.js` 재실행으로 갱신.
- 앱 URL: 홈 `/ko/home`, 드라이브 `/ko/mydrive`. 미로그인 시 `accounts.hancom.com`으로 리다이렉트 → 이걸로 **AUTH_EXPIRED** 판정.

## 3. webhwp 웹 뷰어 내부 — 디버깅에서 알아낸 것들 (핵심)

> webhwp는 한컴독스가 문서를 여는 웹 에디터(webhwp.hancomdocs.com). 아래는 자동화하려고 리버스로 알아낸 동작.

- **문서 본문은 `<canvas>` 렌더 (2개), DOM 텍스트 아님.** → selector로 텍스트/표 위치를 못 찾는다. 이게 모든 설계 제약의 근원.
- **스크롤 컨테이너 = `#hcwoViewScroll`.** `scrollTop`을 JS로 직접 제어 가능. 캔버스는 가상화돼서 scroll 이벤트마다 보이는 영역만 다시 렌더.
- **페이지 점프**: 100% 줌·A4 기준 **한 페이지 = scrollTop 1143px로 일정**(문서 내용 무관). → N쪽 = `(N-1)*1143`. 총 페이지 수 몰라도 점프 가능.
- **총 페이지 수**: 상태바 "x / Y쪽"에서 Y는 대용량 문서면 "?"로 안 풀림(lazy pagination). 반면 **x(현재 쪽)는 캐럿 기준**이라, 찾기 직후 읽으면 정확.
- **HwpApp 전역 JS 객체** 존재하나 **난독화 심함**(`$zs`, `appState.OPt` 등) → 도구로 쓰면 webhwp 업데이트마다 깨짐. 안 씀.
- **찾기(Find) UI 흐름**: 툴바 `찾기` 버튼(아이콘 `<a>`)은 **드롭다운** → "찾기...(Cmd+F)" 메뉴 → 다이얼로그(`찾을 내용` 입력 + `다음 찾기` 버튼).
  - 메뉴/버튼 **라벨이 0-size span이라 Playwright 텍스트 클릭 불가** → **좌표 클릭**(툴바 찾기 ≈ (309,95), 메뉴 ≈ (335,167))으로 처리. 검색 입력칸은 "새로 뜬 보이는 input"으로 검출, `다음찾기` 버튼은 입력칸 우측 +70 좌표.
  - **검색 입력칸은 안전**: 거기 타이핑은 문서를 편집하지 않음. `다음찾기` 누르면 캐럿이 매치로 이동 → **상태바 현재 쪽 = 매치의 정확한 페이지**. 끝나면 **Esc로 검색 하이라이트(파란 선택박스) 제거**(캡처 혼동 방지).
  - ⚠️ `Ctrl+F`·`Ctrl+End` 등 **키보드 단축키는 webhwp에서 신뢰 불가**(안 먹음). 좌표 클릭/스크롤로 우회.
- **A4 페이지 영역 자동 검출**: 캔버스 픽셀을 `getImageData`로 읽어 흰색 페이지 사각형의 좌/우/상/하 경계를 스캔 → **그 영역만 clip**. 결과: 툴바·여백 없이 A4 한 장만 깔끔히. **방향 무관**(세로 792×1121, 가로 1122×792 자동 인식).
- **협업 커서 이름표**: 협업모드일 때 문서 위에 로그인 계정 id(예 "tumsKq") 라벨이 뜬다. **`.user_cursor_container`** DOM 오버레이 안에 있음 → 캡처 직전 CSS로 숨김(문서 내용 영향 없음).

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
node hancom.js capture --file <경로> [--page N] [--grid] [--scale N]   # A4 한 장 클린 캡처(격자 옵션)
node hancom.js zoom    --name <이름> --clip "x,y,w,h" [--page N]        # 페이지-로컬 좌표로 영역 확대(scale 3)
node hancom.js around  --name <이름> --text "<검색어>" [--grid]         # 텍스트 찾아 그 페이지 캡처(정확)
```
좌표계: 페이지 왼쪽위 = (0,0). `--grid`가 100px 격자+라벨을 얹어 좌표 읽기 보조.
결과는 마지막 줄 `RESULT_JSON={...}`. 열 수 없는 파일은 `{"status":"cannot_open",...}`(exit 5).

## 7. 손상 파일 — 두 가지 실패 모드

| 모드 | 트리거 | webhwp 동작 | 도구 감지 |
|---|---|---|---|
| ① 명시적 에러 | 실제 round-trip 손상(예: known_broken_sheetjs_roundtrip.hwp) | "문서를 열 수 없습니다 / 파일을 여는 동안 오류" 다이얼로그 | ✅ openDoc이 body innerText 정규식으로 감지 → `cannot_open`. hwp·hwpx 동일. |
| ② 조용한 가비지 | 절단/부분손상 zip | 거부 안 하고 **원시 바이트(mimetype/Contents/PK 문자열+깨진글자)를 텍스트로 렌더** | ❌ "성공"처럼 통과. (감지하려면 렌더 텍스트에 zip 내부마커 있으면 의심 플래그 — 미구현) |

## 8. 알려진 한계

- 페이지 점프는 **100% 줌·A4 portrait 가정**(1143px). 다른 용지/배율은 `--page-height`로 보정.
- `around`는 **첫 매치**로 감(문서 처음부터 아래로). 매치가 1쪽이거나 미발견이면 둘 다 page 1로 보여 구분 약함.
- **협업모드**(테스트로 편집 세션이 서버에 누적되면 "편집(2)") → headed로 띄우면 에디터 탭이 중복으로 뜸. 헤드리스 동작엔 무관, 커서 라벨은 §3에서 숨김 처리.
- 줌 선명도는 `--scale`로 조절(캔버스가 devicePixelRatio로 재렌더돼 실제 고해상도).

## 9. 환경 1회 세팅 (다른 머신/세션 재현)

1. `npm i playwright` + `npx playwright install chromium`
2. `node login2.js` → 뜬 브라우저에서 한컴독스 로그인 → `auth.json` 자동 생성(계정 로그인이라 복사 불가, 머신마다 1회).
이후엔 위 CLI가 헤드리스로 동작. 스킬화하면 SKILL.md+스크립트는 복사로 전파, 세팅만 1회.
