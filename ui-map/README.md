# ui-map/ — 한컴독스(webhwp) 메뉴바 편집 맵 = Phase 2 op 스펙의 기반

claw-hancomdocs "메뉴바 클릭 편집" 스킬(Phase 2)의 **목표 단위(op) 목록**. 한컴독스 web UI에서
"정말 불필요한 것만 빼고" 전부 클릭/편집 가능하게 만드는 게 목표. 2026-06-09 라이브 조사 산출.

## 파일

| 파일 | 무엇 | 비고 |
|---|---|---|
| `MENU_MAP.md` | 9개 메뉴(파일·편집·보기·입력·서식·쪽·표·검토·도구) 항목 + **CSS 셀렉터** + 우선순위 | 사람 읽기용 op 맵 |
| `menu-inventory.json` | 라이브 sweep 산출(머신리더블) | 스킬이 런타임에 셀렉터 resolve |
| `screenshots/` | 조사 증거(메뉴·서브메뉴·우클릭 스샷) | 재생성: `scripts/menu-explore.js --sweep` |
| `SHORTCUTS.md` | 공식 단축키 일람(Win/macOS) | 출처: 공식 도움말 `shortcut/shortcut.htm` (2026-06-11). ⚠️ 단축키 신뢰불가 원칙 그대로 — 참고/보조용. 단 F5 셀블록·개체선택 P/L/C 등 메뉴에 없는 키는 op 핵심 수단 |
| `help/` | **공식 도움말 전체 미러**(160페이지, RoboHelp) | `help/INDEX.md`=목차, 재생성: `node ui-map/help/fetch_help.mjs`. 출처: webhwp.hancomdocs.com/cloud-hwp/help/Hwp/ko_kr/ |

## 핵심 원칙 — 좌표 아닌 셀렉터

webhwp 메뉴 항목은 **의미있는 CSS class**(`.d_download`, `.e_undo` 등)를 가짐 → 좌표 하드코딩이
아니라 **`.셀렉터` 클릭**으로 brittleness 회피. (capture 경로가 안정적인 이유와 같은 설계철학.)
⚠️ webhwp 단축키는 신뢰 불가 → 클릭이 정석, 단축키는 참고.

## 단계(stage) = 우선순위

`MENU_MAP.md`의 **P1 → P2 → P3**가 곧 Phase 2 op 착수 순서:
- **P1(핵심편집)** = 첫 미션 묶음 (예: 다운로드 `.d_download`, 찾기, 되돌리기/다시실행).
- P2(유용) → P3(낮음·제외) 순으로 확장.

읽을 순서: 이 README → `MENU_MAP.md` → `../HANDOFF_PHASE2_EDIT.md`(편집 op 구현 원칙·안전가드).

## 관리

- 스크린샷이 커지면 **Git LFS 전환**(현재 일반 git). `screenshots/`는 `captures/`(gitignore)와 다른 이름 — 의도적(추적 대상).
- sweep 툴 = `../scripts/menu-explore.js`. 한컴 web UI가 갱신되면 재sweep → 이 맵·inventory 갱신.
