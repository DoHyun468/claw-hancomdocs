# 셀 대각선(diagonal) 옵션 레퍼런스

`cell-style` 의 `--diagonal` 에 쓰는 셀 대각선 방향과, 색·굵기·종류 지정법.

```bash
node hancom.js cell-style --name <문서> --cell "<셀 텍스트>" --diagonal <방향> [--diagonal-color <색>] --apply
```

## ⚠️ 가장 중요한 주의 — webhwp 화면엔 안 그려짐
대각선은 **파일(.hwp/.hwpx)에는 정확히 저장**되지만 **한컴독스 web 편집기 캔버스에는 렌더되지 않는다**. 그래서:
- 우리 `capture`/`zoom` 으로는 **대각선이 안 보인다**(적용 실패가 아님).
- 확인하려면 ① **데스크톱 한글**(또는 다른 뷰어)로 그 파일을 열거나, ② `.hwpx` 를 `download` 후 압축 해제해 `Contents/header.xml` 의 `<hh:backSlash type="CENTER">` / `<hh:slash type="CENTER">` 존재를 본다.
- (.hwp 차트 과소렌더와 같은 부류의 webhwp 렌더 한계.)

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
대각선 선 색. 이름(`red`·`blue`·`green`…) 또는 `#RRGGBB`. 생략 시 검정.

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
