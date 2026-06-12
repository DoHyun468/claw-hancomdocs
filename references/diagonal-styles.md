# 셀 대각선(diagonal) 옵션 레퍼런스

`cell-style` 의 `--diagonal` 에 쓰는 셀 대각선 방향과, 색·굵기·종류 지정법.

```bash
node hancom.js cell-style --name <문서> --cell "<셀 텍스트>" --diagonal <방향> [--diagonal-color <색>] --apply
```

## ⚠️ 가장 중요한 주의 — webhwp 화면엔 안 그려짐
대각선은 **한컴독스 web 편집기 캔버스에 렌더되지 않는다**(`capture`/`zoom`으로 안 보임 — 적용 실패 아님, 실측 확인). 그리고 webhwp 가 저장하는 건 **방향뿐**이다:
- `.hwpx` `Contents/header.xml` 에 `<hh:slash type="CENTER">` / `<hh:backSlash type="CENTER">`(방향)만 들어가고, **선 굵기·색·종류는 그 요소에 안 들어간다**(테두리의 `type="SOLID" width color` 와 달리). 즉 `--diagonal-color` 도 파일엔 반영 안 될 수 있음.
- 따라서 **대각선이 실제로 어떻게 그려지는지(또는 그려지긴 하는지)는 이 도구로 검증 불가** — `download` 후 **데스크톱 한글로 열어 직접 확인**해야 한다. 안 보이면 webhwp 의 대각선 저장이 불완전한 것(방향만 기록).
- 정리: **방향은 파일에 기록됨이 확인됨. 시각 렌더는 미검증(webhwp 미렌더 + 외부 렌더러 없음).** 중요한 대각선이면 데스크톱 한글에서 반드시 확인할 것.

## 방향 (`--diagonal <값>`)
| 값 | 뜻 | 저장 결과(hwpx) |
|---|---|---|
| `backslash` (= `\`) | ＼ 대각선(좌상→우하) | `<hh:backSlash type="CENTER">` |
| `slash` (= `/`) | ／ 대각선(좌하→우상) | `<hh:slash type="CENTER">` |
| `x` (= `both`) | ╳ 양 대각선(＼+／ 둘 다) | backSlash + slash 둘 다 CENTER |
| `center-h` | ─ 가로 중심선 | 중심선(가로) |
| `center-v` | │ 세로 중심선 | 중심선(세로) |
| `cross` | ＋ 십자 중심선(가로+세로) | 중심선(가로+세로) |
| `none` | 대각선 제거(없음) | backSlash/slash NONE |

## 색 (`--diagonal-color <색>`)
대각선 선 색. 이름(`red`·`blue`·`green`…) 또는 `#RRGGBB`. ⚠️ **다이얼로그엔 색이 들어가지만 파일엔 반영 안 될 수 있음**(위 주의 참고) — 데스크톱 한글에서 확인.

```bash
# ＼ 빨강 대각선
node hancom.js cell-style --name <문서> --cell "합계" --diagonal backslash --diagonal-color red --apply
# ╳ 양 대각선(빈칸 표시용으로 흔함)
node hancom.js cell-style --name <문서> --cell "구분" --diagonal x --apply
```

## 다이얼로그 구조(내부 참고 — 콜드 사용자는 위 표만 보면 됨)
셀 테두리/배경 다이얼로그 `대각선` 탭에는 줄 스타일 변형 아이콘이 더 있다:
`\대각선` 9종 · `/대각선` 9종 · `+중심선` 4종 (각 첫 칸 = 없음, 둘째 칸 = 기본 실선). 위 `--diagonal` 값은 각 줄의 **기본 실선(둘째 칸)** 을 쓴다 — 일반적인 대각선은 이걸로 충분. 굵기·점선 등 세부는 같은 탭의 종류/굵기 콤보로 바뀌지만, 어차피 web 화면엔 안 보이니 데스크톱 한글에서 확인할 것.

## 셀 지정 시 주의(중복 텍스트)
대각선을 넣을 셀의 텍스트가 본문/다른 셀/다른 쪽에도 있으면 `--nth N`(문서순 N번째)·`--page N`(그 쪽만)으로 정확히 겨냥한다. (모든 셀 op 공통 — `SKILL.md` 표 편집 절 참고.)
