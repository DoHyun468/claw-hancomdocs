# Phase 2 — 한컴독스 직접 편집 (인수인계)

Phase 1 = 캡처/검색 작동 검증됨. Phase 2 = 한컴독스 web UI 를 Playwright 로 클릭/타이핑해서 **직접 편집** 자동화.

> **읽을 순서**: 이 문서 → `DEBUG_NOTES.md` (특히 §3, §4) → `SKILL.md` → `scripts/hancom.js` (capture path 가 어떻게 짜여 있는지)

---

## 0. Phase 2 의 의도

한컴독스가 webhwp 에서 자체 에디터를 제공함. 자동화하면:
- 사용자가 자연어로 "표 한 셀 채워줘 / 단락 삽입해 / 페이지 나눠줘" → 우리가 webhwp UI 를 자동 조작 → 사용자 머신에 .hwp/.hwpx 다운로드
- 한컴이 자기 포맷을 만드니까 — 포맷 spec 가설 / reject 사이클이 0
- 캡처/렌더 가공이 이미 있으니 같은 인프라 재사용

---

## 1. 알려진 webhwp 제약 (DEBUG_NOTES §3 요약)

**자동화 짤 때 첫날 알아야 하는 것들:**

- **본문 = `<canvas>` 렌더**. DOM 텍스트 없음 → selector 로 "이 글자 위치" 못 찾음. 좌표 클릭 / 검색 다이얼로그 우회만 가능
- **스크롤 = `#hcwoViewScroll` scrollTop**. JS 직접 제어. 100% 줌 A4 = 1143 px/페이지
- **페이지 수** = 상태바 "x / Y쪽" — 대용량은 Y 가 "?" 로 lazy. x (현재 쪽) 는 캐럿 기준이라 정확
- **HwpApp 전역 객체** 난독화 심함 → 도구로 안 씀 (업데이트 깨짐)
- **키보드 단축키 (Ctrl+F / Ctrl+End)** 신뢰 불가. 좌표 클릭/스크롤 우회
- **찾기 UI 흐름**: 툴바 찾기 버튼 좌표 ≈ (309,95) → 드롭다운 (335,167) → 다이얼로그. 라벨이 0-size span 이라 Playwright 텍스트 click 불가
- **검색 입력칸은 안전** (문서 편집 안 됨), **본문 input 은 위험** (블라인드 입력 = 문서 망가짐)

---

## 2. ⚠️ 안전 가드 우선 (DEBUG_NOTES §4 사고 재발 방지)

이전에 `Ctrl+F` 안 먹는 걸 모르고 "보이는 첫 input 에 블라인드 입력" → 그게 **문서 제목 input** 이었음 → 문서 이름이 검색어로 바뀌어 버림. 드라이브 "이름 바꾸기" 로 복구.

**Phase 2 의 모든 op 에 적용:**
1. 어떤 input 에 입력하기 전에 — `aria-label`, placeholder, 좌표 범위 셋 다 확인 (블라인드 첫 input 금지)
2. 본문 편집 영역 (`<input aria-label="문서 편집 영역">`) 에 직접 타이핑 금지 — 셀/표 채우기는 셀 영역 클릭 + 표시된 캐럿 위치 확인 후
3. 매 op 끝나면 — 의도된 영역만 바뀌었는지 캡처 한 장 자동 찍어 (`hancom.js capture --page <대상페이지>`) regression 비교
4. Dry-run 모드 — 실제 타이핑 전에 어디를 어떻게 바꿀지 JSON 으로 print 만. `--apply` 플래그 없으면 read-only

---

## 3. 첫 op 후보 (난이도 낮은 순)

### `insert_text` — 페이지 끝에 단락 한 줄 추가
- Find ("문서 끝 표시" 또는 마지막 단락 키워드) 로 캐럿 위치 → End 키 또는 좌표 클릭 으로 단락 끝 → Enter → 타이핑
- 안전: 본문 input 에 직접 타이핑 = 위험. 캐럿 이동 후 타이핑은 OK (사용자 한컴독스 실험으로 확인 후 미러)

### `set_cell_text` — 특정 셀에 텍스트 채우기
- 표 셀은 canvas 위 좌표 클릭 → 캐럿 위치 → 타이핑
- 어려운 점: 셀 좌표 자동 추출 X (canvas 라). 사용자가 셀 좌표 명시하거나 표 첫 셀 검색 + offset 계산
- DEBUG_NOTES §3 의 캔버스 픽셀 스캔 (`getImageData`) 응용 — 셀 경계 자동 검출 가능할 수도

### `save_as_download` — 현재 문서 .hwp / .hwpx 로 다운로드
- 파일 메뉴 → 다운로드 → 형식 선택. Playwright 의 `page.waitForEvent('download')` 패턴
- 안전: 다운로드 위치 명시 (`page.context().on('download', ...)`)

이 셋만 되면 "한컴독스 열어서 — 셀 채우고 — 다운로드" 의 최소 루프가 완성. 나머지 op (표 삽입, 페이지 나누기, 스타일) 는 이 패턴 확장.

---

## 4. 구현 원칙

**원칙: 한컴독스 UI가 실제로 어떻게 동작하는지 먼저 관찰하고 그 flow를 그대로 미러한다 (spec 추측 금지).**
> ⚠️ Hop(맥 네이티브 HWP 앱) 등 외부 뷰어는 claw-hancomdocs와 무관 — 우리는 한컴독스 web UI 위에서만 편집하고 캡처로 검증한다. (claw-hwp 의 "Hop 동작 먼저 확인"은 byte-patch 전용 원칙이라 용어만 닮았을 뿐 별개.)

1. **한컴독스에서 사용자가 직접 같은 동작 수행** (insert text / set cell / save). 어떤 메뉴를 클릭하는지 / 어떤 dialog 가 뜨는지 / 어떤 키를 누르는지 직접 관찰
2. **그 UI flow 를 Playwright 로 그대로 미러**
3. 절대 spec 추측 금지. 한컴이 보여주는 동작만 자동화

이게 capture path 가 작동한 이유이기도 함 (DEBUG_NOTES §3 의 webhwp 내부 발견들이 다 "실제 동작 보고 알아낸 것").

---

## 5. brittleness — 영원한 상수 비용

webhwp 가 web UI 라 좌표 / DOM 구조가 바뀌면 자동화 깨짐. 대응:
- 좌표 / selector 는 한 곳에 모음 (`scripts/webhwp-selectors.js` 같은)
- 한컴 web 갱신 발견되면 그 파일만 수정
- CI 에 "alive check" — 매일 한 번 capture 시도 → 실패 시 알림 (한컴 변경 조기 감지)

---

## 6. 환경

- **Local-machine 전용**. Cowork sandbox 에서는 `www.hancomdocs.com` proxy 차단 + auth.json 머신 종속으로 실행 불가
- Mac / Windows / Linux 다 작동 (Playwright 가 cross-platform)
- 첫 실행 세팅: `cd scripts && npm install && npx playwright install chromium && node login.js`

---

## 7. 다음 step 제안

1. **사용자와 함께 한컴독스에서 한 op 직접 수행** (예: insert_text)
2. Playwright codegen 으로 그 flow 녹음 (`npx playwright codegen webhwp.hancomdocs.com`)
3. 녹음 코드 → 안전 가드 입혀 `hancom.js insert-text` 명령 작성
4. dry-run 모드 작동 확인 → `--apply` 추가
5. 매 op 끝 자동 capture regression 추가
6. 다음 op (set_cell_text) 같은 패턴 반복

---

## 8. 기존 자산 (재사용)

- `scripts/hancom.js` — 4개 명령 (capture/zoom/around/locate) + Playwright 세팅 + 캐릭 영역 검출 + 협업 커서 hide
- `scripts/login.js` — Kakao OAuth → auth.json (storageState 패턴)
- `SKILL.md` — Claude Code 스킬 정의, 첫 실행 자동 점검
- `DEBUG_NOTES.md` — webhwp 리버스 결과 / 안전 교훈 (반드시 읽기)
- `ORDER_SPEC.txt` — 에이전트 주문 명세
