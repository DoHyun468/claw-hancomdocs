# 셀 대각선(diagonal) 옵션 레퍼런스

`cell-style` 의 `--diagonal` 로 셀에 대각선/중심선을 긋는다. 화면(webhwp)에 그려지고 파일에도 저장된다(렌더·저장 모두 검증됨).

```bash
node hancom.js cell-style --name <문서> --cell "<셀 텍스트>" --diagonal <방향> \
  [--diagonal-type <선 종류>] [--diagonal-width <mm>] [--diagonal-color <색>] [--diagonal-style N] --apply
```

## 방향 (`--diagonal <값>`)
| 값 | 뜻 |
|---|---|
| `backslash` (= `\`) | ＼ 대각선(좌상→우하) |
| `slash` (= `/`) | ／ 대각선(좌하→우상) |
| `x` (= `both`) | ╳ 양 대각선(＼+／ 둘 다) |
| `center-h` | ─ 가로 중심선 |
| `center-v` | │ 세로 중심선 |
| `cross` | ＋ 십자 중심선(가로+세로) |
| `none` | 대각선 제거 |

## 선 종류 (`--diagonal-type`, 생략 시 `solid`)
`solid`(실선) · `dashed`(파선) · `dotted`(점선) · `double`(이중선) · `long-dash`(긴 파선) · `circle`(원점선) · `slim-thick` · `thick-slim` · `slim-thick-slim`

## 굵기 (`--diagonal-width <mm>`)
프리셋 중에서: `0.1 0.12 0.15 0.2 0.25 0.3 0.4 0.5 0.6 0.7 1 1.5 2 3 4 5` (생략 시 기본 0.12)

## 색 (`--diagonal-color <색>`)
이름(`red`·`blue`·`green`…) 또는 `#RRGGBB`. 생략 시 검정.

## 모양 변형 (`--diagonal-style N`)
방향마다 변형 모양이 있다(꺾임/이중 대각선 등): `\`·`/` 는 `1`~`8`(1=기본 직선), 중심선은 `1`~`3`(1=가로, 2=세로, 3=십자). 보통은 생략(기본 직선)하면 된다.

```bash
# ＼ 기본 실선 대각선
node hancom.js cell-style --name <문서> --cell "합계" --diagonal backslash --apply
# ╳ 양 대각선(빈칸 표시용으로 흔함), 빨강 0.5mm
node hancom.js cell-style --name <문서> --cell "구분" --diagonal x --diagonal-color red --diagonal-width 0.5 --apply
# ／ 점선 초록 1mm
node hancom.js cell-style --name <문서> --cell "비고" --diagonal slash --diagonal-type dotted --diagonal-width 1 --diagonal-color green --apply
```

## 확인 방법
적용 후 `zoom`/`around --zoom` 으로 그 셀을 확대해 보면 대각선이 보인다. 파일(.hwpx)에는 `Contents/header.xml` 의 `<hh:diagonal type=… width=… color=…/>` + `<hh:slash|backSlash type="CENTER">` 로 저장된다.

## 셀 지정 시 주의(중복 텍스트)
대각선을 넣을 셀의 텍스트가 본문/다른 셀/다른 쪽에도 있으면 `--nth N`(문서순 N번째)·`--page N`(그 쪽만)으로 정확히 겨냥한다. (모든 셀 op 공통 — `SKILL.md` 표 편집 절 참고.)
