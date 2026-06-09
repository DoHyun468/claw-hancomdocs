# Phase 2 START — 편집 op 시작 핸드오프 (검증 하네스 준비 완료)

> **대상**: claw-hancomdocs를 깊게 아는 개발자 세션(컨텍스트 보유 = fixer A).
> **한 줄**: cold-verify가 hancomdocs를 지원하게 됐다(1c 완료). **이제 네 편집 op을 "콜드 사용자가 SKILL만 보고 성공하나"로 한 줄에 검증**할 수 있다. Phase 2 편집 op을 시작해라.
> **읽을 순서**: 이 문서 → `HANDOFF_PHASE2_EDIT.md`(설계·안전원칙) → `DEBUG_NOTES.md §3·§4` → `ui-map/MENU_MAP.md`(op 목록).

---

## ⚠️ 가장 중요한 규칙 — 스킬엔 내부 컨텍스트 0 (먼저 읽어라)

**claw-hancomdocs는 public 스킬로 배포된다.** 그래서 `SKILL.md`를 포함한 **모든 스킬 콘텐츠는 처음 쓰는 콜드스타트 외부 사용자 기준으로만** 작성한다. **우리만 아는 내부 컨텍스트는 한 글자도 넣지 마라:**

- ❌ **자동화 전략·내부 단계 framing**: `Phase 1/2`, `cold-verify`, A/B 검증, fixer/stag, MISSION_QUEUE, "구현 중"식 로드맵 상태.
- ❌ **내부 문서 참조**(`handoff/...`, `HANDOFF_PHASE2_*`), **우리만 아는 일반화**.
- ✅ 기능을 **콜드 사용자 언어로 평범하게**. 예: `"## 편집 — insert-text (Phase 2, 작동)"` ❌ → `"## 편집 — 문서에 한 줄 추가"` ✅.

> **이게 방금 실제로 난 실수다** — SKILL.md에 `(Phase 2, 작동)`을 붙였다. 외부 사용자는 "Phase 2"가 뭔지 모른다. 떼라.
> 일반화·검증·단계 얘기는 **CLAUDE.md(로컬)나 `handoff/`에만**. 스킬 파일에 `Phase·cold-verify·op·우리` 같은 내부 용어가 들어가려 하면 **멈추고** 콜드 사용자 표현으로 바꿔라.
> (이 핸드오프 문서 자체는 내부용이라 위 용어를 쓰지만, **네가 만지는 스킬 결과물엔 절대 금지**다.)

---

## 0. 뭐가 새로 준비됐나 (이게 너를 unblock)

`claw-hwp-automation/scripts/cold-verify.mjs`가 **hancomdocs를 지원**한다 (Phase 1c, 검증 2회 통과):

- **1c-1**: 콜드스타트 `claude -p`(B = 실사용자 시뮬)가 **`--add-dir`로 claw-hancomdocs 스킬을 물고** doctor→문서 열기→캡처까지 마찰 0 완주. auth.json은 자동 동행(= 한 번 로그인한 실사용자와 동일).
- **1c-2**: 캡처를 **별도 vision judge(claude -p)가 직접 보고** "기대결과 만족?"을 `{match,reason}`으로 자동 판정 → `pass` 결정. (참/거짓 양방향 + 사람 눈 확인 완료 = rubber-stamp 아님.)

→ 즉 네가 편집 op을 짜면, **콜드 사용자가 진짜로 되는지**를 cold-verify 한 줄로 검증한다. (네가 옆에서 봐줘야만 되는 fix는 가짜다.)

## 1. cold-verify 사용법 (네가 op 검증할 때)

```bash
# base: Mac ~/Documents/sideproj/sideproj  /  Win /c/Users/Reconlabs/ian/sideproj
node <base>/claw-hwp-automation/scripts/cold-verify.mjs \
  --format hancomdocs \
  --plugin <base>/claw-hancomdocs \
  --request "<자연어 편집 주문 — B가 받을 것>" \
  --expect  "<기대 렌더 — judge가 캡처로 확인할 한 줄>" \
  [--keep]
```

- 출력 verdict JSON 주요 필드: `pass`(true/false) · `judge:{match,reason}` · `captures`(PNG 경로) · `bStdoutTail`(B가 한 일).
- **`--expect` 있으면** vision judge가 자동 판정(`pass`=judge.match). **없으면** `pass:null` = 캡처만 산출(사람 수동 비교).
- **capture-only**: 다운로드/byte 구조검증 안 한다(캡처가 검증). 캡처는 `<workdir>-captures/`로 빠지고 temp(토큰)는 자동 삭제(`--keep`면 남김).
- 픽스처 = 한컴독스 드라이브의 문서(이름으로 열림). 테스트용 `case01-memo.hwpx`가 이미 드라이브에 있음.

## 2. 첫 op 추천 (난이도 낮은 순 — `HANDOFF_PHASE2_EDIT.md §3`)

1. **`insert_text`** — 단락 끝에 한 줄 추가. **이걸 첫 op로.** (캐럿 이동 후 타이핑, 본문 input 블라인드 금지 — §3 참고)
2. `set_cell_text` — 표 셀 채우기 (좌표 클릭 → 캐럿 → 타이핑)
3. `save_as_download` — .hwp/.hwpx 다운로드

각 op의 셀렉터는 `ui-map/MENU_MAP.md`의 **P1**부터(예: `찾기`로 캐럿 이동, `.char_shape`·`.para_shape`·`.p_bullet_list` 등).

## 3. ⚠️ 안전 (DEBUG_NOTES §4 — 사고 재발 방지, 무조건 지켜라)

이전에 `Ctrl+F`가 안 먹는 걸 모르고 "보이는 첫 input에 블라인드 입력"했더니 그게 **문서 제목 input**이라 문서 이름이 검색어로 바뀌어 망가졌다(드라이브 복구). 그래서:

1. **어떤 input에 입력 전 — aria-label/placeholder/좌표 셋 다 확인.** 블라인드 첫 input 절대 금지.
2. **본문 편집 영역(`<input aria-label="문서 편집 영역">`)에 직접 타이핑 금지.** 셀/캐럿 위치 클릭 → 표시된 캐럿 확인 후.
3. **매 op 끝 = 캡처 한 장**(`hancom.js capture --page <대상>`) 자동 regression.
4. **dry-run 먼저** — `--apply` 없으면 read-only로 "어디를 어떻게 바꿀지" JSON print만.
5. **원본 픽스처 보존** — 이슈마다 픽스처 지정됨. B는 기존 문서를 열거나 복사본에서 작업, 원본 안 건드림.

## 4. 워크플로 (HANDOFF_PHASE2_EDIT §4 원칙 + 새 검증)

```
1. 한컴독스 web UI에서 사용자가 직접 그 op 수행 → 메뉴/다이얼로그/키 직접 관찰 (spec 추측 금지)
2. 그 flow를 Playwright로 그대로 미러 (좌표 아닌 .셀렉터 우선 — ui-map)
3. dry-run 작동 확인 → --apply 추가
4. cold-verify --format hancomdocs --expect "..." 로 콜드 검증 (1c-2 자동 판정)
5. 통과 → 다음 op 같은 패턴 반복
```

## 5. 브랜치 / 제출 (handoff/REPO_MAP §3·§4)

- 작업/커밋 = **`feat/{mac|win}-hancomdocs-compat`** 트랙 브랜치.
- **Claude는 PR까지** 만든다(gh active=`DoHyun468`) → **머지 버튼은 사용자**. main 자동 머지 금지.
- 공용 파일·정상화 규칙 = `handoff/REPO_MAP.md §4`.

## 6. 검증 모델 인지 (중요 — 오염 금지)

- cold-verify의 본질 = **콜드스타트(B) 검증**. Tier1/Tier2/judge는 B 산출물 채점. 그 위에 **검증②**(judge가 기대결과/원본 픽스처 vs 콜드 산출 캡처 비교).
- **SKILL.md에는 cold-verify·A/B·automation을 0 mention 유지** — B(콜드)가 자기가 검증당하는지 모르게(시뮬 보호, `AUTOMATION_DESIGN.md §16.1`). 자동화 얘기는 CLAUDE.md(worktree local)나 handoff에만.

## 7. 단일 출처

- 검증 하네스 = `claw-hwp-automation/scripts/cold-verify.mjs` + `README.md` + `fixtures/hancomdocs/README.md`.
- 설계 = `handoff/AUTOMATION_DESIGN_6TRACK.md §1`(A/B)·`§8`(cold-verify 일반화·미결). op 목록 = `ui-map/MENU_MAP.md`. Phase 2 원칙·안전 = `HANDOFF_PHASE2_EDIT.md`·`DEBUG_NOTES.md`.
