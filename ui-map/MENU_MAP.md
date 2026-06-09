# 한컴독스(webhwp) 메뉴바 전체 맵 — 클릭 편집 스킬 기반

> **출처**: `*.png` 9개 메뉴 스크린샷 + **라이브 sweep**(`menu-explore.js --sweep` → `menu-inventory.json`, 2026-06-09).
> **용도**: claw-hancomdocs "메뉴바 클릭 편집" 스킬의 기반 = **목표 단위(op) 목록**. "정말 불필요한 것만 빼고" 전부 클릭/편집 가능하게.
> **핵심**: webhwp 메뉴 항목은 **의미있는 CSS class 셀렉터**를 가짐 → 좌표 아닌 **`.셀렉터` 클릭**(brittle 회피). 아래 `sel` 칸.
>
> **표기**: `…`다이얼로그 / `>`서브메뉴 / `(단축키)` / `[회색]`문맥의존(커서/선택 필요) / `☑`토글.
> **우선순위**: **P1** 핵심편집 / **P2** 유용 / **P3** 낮음·제외. ⚠️ webhwp 단축키 신뢰불가 → 클릭이 정석, 단축키는 참고.

메뉴바 순서: **파일 · 편집 · 보기 · 입력 · 서식 · 쪽 · 표 · 검토 · 도구**

---

## A. 메뉴별 항목 + 셀렉터 (라이브 sweep 확인)

### 파일
| 항목 | sel | 단축키 | 유형 | 우선 |
|---|---|---|---|---|
| 저장하기 | `.d_save` | Cmd+S | action[회색] | P2 |
| 다른 이름으로 저장하기 | `.d_save_as_button` | | action | P3 |
| 공유 | `.share` | | action | P3 |
| 이름 바꾸기 | `.rename` | | action | P3 |
| 다운로드 | `.d_download` | | action | **P1** |
| PDF로 다운로드 | `.d_pdf_download` | | action | P2 |
| 편집 용지… | `.d_page_setup` | F7 | dialog | P2 |
| 인쇄 | `.d_print` | Cmd+P | dialog | P3 |
| 문서 정보… | `.d_info` | | dialog | P3 |

### 편집
| 항목 | sel | 단축키 | 유형 | 우선 |
|---|---|---|---|---|
| 되돌리기 | `.e_undo` | Cmd+Z | action[회색] | **P1** |
| 다시 실행 | `.e_redo` | Cmd+Shift+Z | action[회색] | **P1** |
| 오려 두기 | `.e_cut` | Cmd+X | action[회색] | P2 |
| 복사하기 | `.e_copy` | Cmd+C | action[회색] | P2 |
| 붙이기 | `.e_paste` | Cmd+V | action | P2 |
| 모양 복사… | `.e_format_copy` | Opt+C | dialog | P2 |
| 지우기 | `.e_delete` | Cmd+E | action[회색] | P2 |
| 조판 부호 지우기 | `.d_delete_ctrls` | | action | P3 |
| 모두 선택 | `.e_select` | Cmd+A | action | P2 |
| 찾기 | `.sub_group_title` | | **>** | **P1** | → §B |

### 보기
| 항목 | sel | 단축키 | 유형 | 우선 |
|---|---|---|---|---|
| 확대/축소 | (sub) | | **>** | P2 | → §B |
| 쪽 모양 | (sub) | | **>** | P3 | → §B |
| 쪽 윤곽 | `.e_view_option_paper` | Ctrl+G+L | ☑ | P3 |
| 표시/숨기기 | (sub) | | **>** | P2 | → §B |
| 격자 보기 | `.d_grid` | | action | P3 |
| 도구 상자 | (sub) | | **>** | P3 | → §B |
| 문서 창 | (sub) | | **>** | P3 | → §B |
| 메모 | (sub) | | **>** | P2 | → §B |

### 입력
| 항목 | sel | 단축키 | 유형 | 우선 |
|---|---|---|---|---|
| 도형 | `.insert_shape` | | **>** | P2 | → §B(부분) |
| 그림… | `.insert_image` | Ctrl+N+I | dialog | **P1** |
| 표… | `.insert_table` | | dialog | **P1** |
| 차트… | `.chart` | | dialog | P2 |
| 글상자 | `.s_insert_textbox` | Ctrl+N+B | action | P2 |
| 웹 동영상… | `.insert_web_video` | | dialog | P3 |
| 수식… | `.show_eqeditor` | | dialog | P3 |
| 문자표… | `.symbols` | Cmd+F10 | dialog | P2 |
| 필드 입력… | `.field` | Ctrl+K+E | dialog | P3 |
| 문단 띠 | `.s_insert_line` | Ctrl+N+L | action | P3 |
| 주석 | `.insert_notes` | | **>** | P2 | → §B (각주/미주) |
| 캡션 넣기 | `.sub_group_title` | | **>**[회색] | P3 |
| 메모 | `.e_menu_insert_memo` | | action | P2 |
| 하이퍼링크… | `.hyperlink` | Ctrl+K+H | dialog | P2 |
| 책갈피… | `.bookmark` | Ctrl+K+B | dialog | P3 |

### 서식
| 항목 | sel | 단축키 | 유형 | 우선 |
|---|---|---|---|---|
| 글자 모양… | `.char_shape` | Cmd+L | dialog | **P1** |
| 문단 모양… | `.para_shape` | Cmd+T | dialog | **P1** |
| 글머리표 모양… | `.p_bullet_list` | | dialog | **P1** |
| 문단 번호 모양… | `.p_number_list` | Ctrl+K+N | dialog | **P1** |
| 한 수준 증가 | `.p_level_increase` | Ctrl+Num - | action | P2 |
| 한 수준 감소 | `.p_level_decrease` | Ctrl+Num + | action | P2 |
| 스타일… | `.paragraph_style` | F6 | dialog | P2 |
| 개체 속성… | `.modify_object_properties` | P | dialog[회색] | P2 |

### 쪽
| 항목 | sel | 단축키 | 유형 | 우선 |
|---|---|---|---|---|
| 편집 용지… | `.d_page_setup` | F7 | dialog | P2 |
| 머리말 | `.e_header` | | **>** | **P1** | → §B |
| 꼬리말 | `.e_footer` | | **>** | **P1** | → §B |
| 새 번호로 시작… | `.p_new_number` | | dialog | P3 |
| 현재 쪽만 감추기… | `.p_page_hiding` | Ctrl+N+S | dialog | P3 |
| 쪽 나누기 | `.p_page_break` | Ctrl+Return | action | **P1** |
| 단 나누기 | `.p_column_break` | Ctrl+Shift+Return | action | P2 |
| 단 | `.p_columns` | | **>** | P2 | → §B |
| 다단 설정 나누기 | `.p_break_new_column` | Ctrl+Opt+Return | action | P3 |

### 표 ⚠️ 표/셀 드래그 선택 전엔 대부분 [회색]
| 항목 | sel | 단축키 | 유형 | 우선 |
|---|---|---|---|---|
| 표 만들기… | `.insert_table` | Ctrl+N+T | dialog | **P1** |
| 표/셀 속성… | `.table_cell_properties` | | dialog[회색] | **P1** |
| 셀 테두리/배경 | `.cell_border_background` | | **>**[회색] | **P1** | 각 셀마다 적용… / 하나의 셀처럼 적용… |
| 줄/칸 추가하기 | `.sub_group_title` | | **>**[회색] | **P1** | (서브 미캡처 — 표 선택 후) |
| 줄/칸 지우기 | `.c_remove_row_col` | | **>**[회색] | **P1** | 줄 지우기 / 칸 지우기(Ctrl+D) |
| 셀 나누기… | `.c_unmerge` | S | dialog[회색] | **P1** |
| 셀 합치기 | `.c_merge` | M | action[회색] | **P1** |
| 셀 높이를 같게 | `.c_height_distribute` | H | action[회색] | P2 |
| 셀 너비를 같게 | `.c_width_distribute` | W | action[회색] | P2 |
| 블록 계산식 | `.sub_group_title` | | **>**[회색] | P2 |
| 1,000 단위 구분 쉼표 | `.c_cell_thousands_sep` | | **>**[회색] | P3 | 자릿점 넣기 / 빼기 |

### 검토 (메뉴 = 변경 내용 추적 하나뿐 — `--raw` 덤프로 확인됨, 누락 아님)
| 항목 | sel | 유형 | 우선 |
|---|---|---|---|
| 변경 내용 추적 | `.sub_group_title` | **>** | P2 | → §B (이 메뉴의 유일 top 항목) |

### 도구
| 항목 | sel | 단축키 | 유형 | 우선 |
|---|---|---|---|---|
| 빠른 교정 | `.sub_group` | | **>** | P3 | 곧은→둥근 따옴표 자동 바꾸기 |
| 접근성 설정 | `.sub_group` | Ctrl+Opt+F1 | **>** | P3 | 스크린 리더 지원 |
| 채팅 | `.g_chat` | | action | **P3 제외** |

---

## B. 서브메뉴 내용 (라이브 호버 캡처 — 노이즈 제거본)

- **편집 › 찾기**: 찾기… `.find` (Cmd+F) · 찾아 바꾸기… `.find_replace` (Cmd+Shift+H) · 찾아가기 `.goto` (Opt+G)
- **보기 › 확대/축소** `.e_view_scale`: 50 · 75 · 100(✓) · 125 · 150 · 200 · 300% · 쪽 맞춤 · 폭 맞춤
- **보기 › 쪽 모양**: 한 쪽 `.e_view_zoom_page_one` · 두 쪽 `.e_view_zoom_page_two` · 세 쪽 `.e_view_zoom_page_three`
- **보기 › 표시/숨기기**: 조판 부호 `.e_ctrl_mark` (Ctrl+G+C) · 문단 부호 `.e_para_mark` (Ctrl+G+T) · 투명 선 `.t_border_transparent`
- **보기 › 도구 상자**: 기본 `.view_basic` · 서식 `.view_format`
- **보기 › 문서 창**: 눈금자 `.document_window`
- **보기 › 메모**: 모든 메모 표시 `.e_menu_view_memo` · 메모 안내선 표시 `.e_menu_view_memo_guide`
- **입력 › 주석**: 각주 · 미주 (둘 다 `.e_insert_notes`, 텍스트로 구분)
- **입력 › 도형**: 그리기 개체… (도형 팔레트 — 세부 미캡처, 표 없는 문서 한계 무관·재호버로 보강)
- **쪽 › 머리말** `.e_insert_header`: (모양 없음) · 왼쪽 쪽 번호 · 가운데 쪽 번호 · 오른쪽 쪽 번호
- **쪽 › 꼬리말** `.e_insert_footer`: (모양 없음) · 왼쪽 쪽 번호 · 가운데 쪽 번호 · 오른쪽 쪽 번호
- **쪽 › 단** `.p_columns`: 하나 · 둘 · 셋 · 왼쪽 · 오른쪽 (top 항목 인라인 텍스트 기준; 개별 sel 재호버로 보강)
- **표 › 셀 테두리/배경**: 각 셀마다 적용… · 하나의 셀처럼 적용… *(표 선택 후 활성)*
- **표 › 줄/칸 지우기** `.c_remove_row_col`: 줄 지우기 · 칸 지우기 (Ctrl+D) *(표 선택 후)*
- **표 › 1,000 단위 구분 쉼표** `.c_cell_thousands_sep`: 자릿점 넣기 · 자릿점 빼기 *(표 선택 후)*
- **검토 › 변경 내용 추적**: 추적 토글 `.trackchange_on` · 적용 후 다음 `.trackchange_apply_next` · 취소 후 다음 `.trackchange_cancel_next` · 다음 `.trackchange_next` · 이전 `.trackchange_prev` · 변경 내용 보기 `.trackchange_view`(삽입 및 삭제/서식) · 최종본 및 변경 내용 `.trackchange_final_info`(✓) · 최종본 `.trackchange_final`
- **도구 › 빠른 교정**: '곧은 따옴표'를 '둥근 따옴표'로 자동 바꾸기 (토글)
- **도구 › 접근성 설정**: 스크린 리더 지원 사용 (Ctrl+Opt+F1)

### 남은 보강 (한컴독스에서 열리는 실제 문서로 — rhwp 생성물은 열림 미보장이라 지양)
- ✅ 검토 = 변경 내용 추적 하나뿐 (`--raw` 확인, 누락 아님)
- ✅ 표 서브메뉴 (R&D 실제 표 셀 선택 후 호버, `--table` 2026-06-09):
  - **셀 테두리/배경**: 각 셀마다 적용… `.c_div_border_fill` · 하나의 셀처럼 적용… `.c_zone_border_fill`
  - **줄/칸 추가하기** `.c_insert_row_col_list`: 위쪽에 줄 · 아래쪽에 줄(Ctrl+Return) · 왼쪽에 칸(Ctrl+I) · 오른쪽에 칸
  - **줄/칸 지우기** `.c_remove_row_col`: 줄 지우기(Delete) · 칸 지우기(Ctrl+D)
  - **1,000 단위 구분 쉼표** `.c_cell_thousands_sep`: 자릿점 넣기 · 자릿점 빼기
  - 🔶 **블록 계산식** = 셀에 커서만으론 일부 [회색](grayCount 4) — 숫자 셀/블록 선택 후 재호버 권장 (G4 잔여).
- [ ] 입력 › 도형 팔레트 · 쪽 › 단 개별 sel

---

## C. 클릭 편집 스킬 우선순위
- **P1 (먼저)**: 입력(그림 `.insert_image`·표 `.insert_table`) · 서식(글자 `.char_shape`·문단 `.para_shape`·글머리표 `.p_bullet_list`·문단번호 `.p_number_list`) · 표 전체(드래그 선택 후) · 쪽(머리말 `.e_header`·꼬리말 `.e_footer`·쪽 나누기 `.p_page_break`) · 편집(undo `.e_undo`/redo `.e_redo`) · 파일(다운로드 `.d_download`).
- **P2**: 입력(차트·문자표 `.symbols`·하이퍼링크 `.hyperlink`·메모·주석) · 서식(수준 증감·스타일) · 보기(표시/숨기기·메모) · 단 · 모양 복사 · 검토.
- **P3/제외**: 채팅(`.g_chat` 제외), 접근성·빠른 교정, 공유·이름바꾸기·인쇄·문서정보, 보기 토글 다수, 웹동영상·수식·필드·책갈피.

## D. 구현 메모
- **클릭 = `.셀렉터`** (sweep 확인). 메뉴 열기: 탭 클릭(텍스트 좌표) → 항목 `.sel` 클릭. 서브메뉴: 부모 호버 → 플라이아웃 `.sel` 클릭.
- 찾기 다이얼로그는 `.find` / `.find_replace` 로 바로 (기존 `openFindDialog` 좌표 우회 대체 가능).
- **표 op은 셀/표 드래그 선택 후 활성** ([회색] 해제). "표 만들기 → 셀 영역 좌표 드래그 → op" 순서. canvas라 셀 좌표는 픽셀 스캔(DEBUG_NOTES §3) 응용.
- 매 op 후 **capture self-check** = 이 스킬의 검증.
- 셀렉터는 `webhwp-selectors.js` 한 곳 집약(HANDOFF_PHASE2_EDIT §5) — `menu-inventory.json`이 그 소스.

## E. 목록 구성 도구 — `claw-hancomdocs/scripts/menu-explore.js` (런타임 스킬 아님)
- **목적 = 이 MENU_MAP(목록) 구성/갱신용 recon 도구.** 런타임 클릭 스킬 아님.
- `node menu-explore.js <메뉴> [호버대상]` 단일 / `node menu-explore.js --sweep` 전체(→ `menu-inventory.json`).
- **발견**: 메뉴 항목 = semantic class DIV(`.insert_image`·`.char_shape`·`.e_header` …), 서브 부모 = `…sub_group`(+`.sub_group_title`). 호버는 인벤토리엔 선택(필요시만).
- sweep 노이즈(타 메뉴/툴바 leak)는 **의미있는 sel 가진 항목만 채택**으로 §B에서 정리함.
- 모드 추가: `--raw <메뉴>`(시그니처 무시 permissive 덤프 — 검토처럼 항목 누락 확인용), `--table <doc> <page-local-x> <page-local-y>`(표 셀 클릭 후 표 메뉴 활성 덤프; canvas 셀 좌표는 `detectPageRect`로 page-local→viewport 변환).

---

## (툴바) 2·3행 — 빠른 서식/단축 바 (라이브 실측 2026-06-09)

> ⚠️ **툴바 ▼ 드롭다운은 호버 아니라 클릭으로 펼쳐짐** (메뉴 `>` 서브는 호버, **툴바 ▼는 클릭** — 구분).
> 도구: `node menu-explore.js --toolbar`(영역 열거). 드롭다운 *내용*은 클릭-투-오픈 캡처 별도(아래 TODO).

### 2행 (아이콘 단축) — 대부분 §A 메뉴 op 중복(동일 sel)
`.d_save` 저장 · `.e_cut` 오려두기 · `.e_copy` 복사 · `.e_paste` 붙이기 · `.e_format_copy` 모양복사 · `.find`▼ 찾기 · `.insert_shape`▼ 도형 · `.insert_image` 그림 · `.insert_table`▼ 표 · `.chart`▼ 차트 · `.insert_web_video` 웹동영상 · **`.e_foot_note` 각주 · `.e_end_note` 미주** · `.hyperlink` 하이퍼링크 · `.symbols` 문자표 · `.char_shape` 글자모양 · `.para_shape` 문단모양 · `.modify_object_properties` 개체속성 · `.e_header`▼ 머리말 · `.e_footer`▼ 꼬리말 · `.e_ctrl_mark` 조판부호 · `.e_para_mark` 문단부호 · `.d_grid` 격자보기 · (우상단) `.share` 공유 · `.e_desktop_confirm` 데스크톱에서 편집
> 각주/미주는 메뉴 입력›주석의 직접 버튼 버전. 나머지는 §A와 같은 sel.

### 3행 (서식 직접 컨트롤) — ★ 메뉴엔 없는 빠른 서식 (다이얼로그 없이 1클릭)
| 컨트롤 | sel | ▼클릭드롭 | op |
|---|---|---|---|
| 되돌리기/다시실행 | `.e_undo` / `.e_redo` | | undo/redo |
| 스타일 | `.e_style_item` | ✓ (바탕글…) | 문단 스타일 |
| 언어 | `.p_language` | ✓ (대표/한글/영문/한자…) | |
| **글꼴** | `.font_name` | ✓ (함초롬바탕/맑은고딕…) | font_family |
| **글자 크기** | `.font_size` | ✓ (8~72pt) | font_size |
| **진하게** | `.bold` | | bold |
| **기울임** | `.italic` | | italic |
| **밑줄** | `.underline` | ✓ (색/모양) | underline |
| **취소선** | `.strikethrough` | ✓ | strikethrough |
| **글자색** | `.font_color` | ✓ (색 팔레트) | color |
| **형광펜** | `.font_highlight_color` | ✓ (색 팔레트) | highlight |
| 정렬 6 | `.align_justify` · `.align_left` · `.align_center` · `.align_right` · `.align_distribute` · `.align_divide` | | 양쪽/왼/가운데/오른/배분/나눔 |
| **줄간격** | `.p_line_spacing` | ✓ (100~300%) | line_spacing |
| 글머리표 | `.bullet_list` | ✓ | bullet |
| 문단번호 | `.number_list` | ✓ | number |
| 수준 증가/감소 | `.p_level_increase` / `.p_level_decrease` | | level |

> **3행 = 문자/문단 스타일 op의 최단 경로** — 서식›글자모양 다이얼로그 대신 `.bold`·`.font_color`·`.align_center` 직접 클릭. **G5(문자 스타일) 1순위 셀렉터.**

### 툴바 드롭다운 내용 (클릭-투-오픈 `--toolbar-open <sel>` 캡처 완료 2026-06-09)
- **`.font_name` 글꼴**: 함초롬바탕 · 맑은 고딕 · 해피니스 산스(볼드/레귤러/타이틀/VF) · Pretendard(Black/Bold/ExtraBold/ExtraLight/Light/Medium/SemiBold/Thin) · Apple SD 산돌고딕 Neo · HY견고딕/견명조/그래픽/헤드라인M · SpoqaHanSans · Cafe24 Ssurround · 카페24 슈퍼매직 (각 sel `.font_name`, 텍스트로 구분 / 입력칸에 직접 타이핑도 가능)
- **`.font_size` 크기**: 8·9·10·11·12·14·16·18·20·22·24·26·36·48·72 (+ 직접 입력)
- **`.p_line_spacing` 줄간격**: 100·130·160·180·200·300 % (+ 직접 입력)
- **`.e_style_item` 스타일**: 바탕글 등 문단 스타일 목록
- **`.p_language` 언어**: 대표·한글·영문·한자·일어·외국어·기호·사용자
- **`.font_color` 글자색 / `.font_highlight_color` 형광펜**: 팝업 = **[테마 색]** 프리셋 swatch 그리드 + 표준색 행(검/빨/주황/노랑/연두/초록/파랑/하늘/남색/보라) + **[스펙트럼]** 탭(커스텀 hex/RGB). → 프리셋 클릭 또는 스펙트럼으로 정확 색.
- **`.bullet_list` 글머리표 / `.number_list` 문단번호**: 스타일 swatch 그리드(시각, 텍스트 없음 — 스크린샷으로만).

---

## (우클릭) 컨텍스트 메뉴 — 선택 후 오른쪽 클릭 (사용자 캡처 2026-06-09)

> 표/글/그림/그래프를 **선택(드래그) 후 우클릭** 시 메뉴. **대부분 메뉴바/툴바 op 중복**(= 우클릭은 빠른 접근 경로). 선택 대상(컨텍스트)에 따라 항목 달라짐. 겹치면 스킬에서 메뉴바 sel 재사용하면 됨(사용자: "기능 겹치면 빼면 됨").

- **A) 본문 텍스트 선택** (rc_3): 오려두기(Cmd+X) · 복사하기(Cmd+C) · 붙이기(Cmd+V) · 지우기 · │ · 글자 모양…(Cmd+L) · 문단 모양…(Cmd+T) · 하이퍼링크…(Ctrl+K+H) · 메모
- **B) 표 셀 — 커서만(선택 없음)** (rc_1): 붙이기 · 글자 모양… · 문단 모양… · │ · 표/셀 속성… · 셀 테두리/배경› · │ · 셀 나누기…(S) · 줄/칸 추가하기› · 줄/칸 지우기› · │ · 메모 · 채팅 창에 현재 위치 공유
- **C) 표 셀 — 선택됨** (rc_2, 표 op 전부 활성): 오려두기 · 복사하기 · 셀 지우기 · │ · 글자 모양… · 문단 모양… · │ · 표/셀 속성… · 셀 테두리/배경 · │ · 셀 높이를 같게(H) · 셀 너비를 같게(W) · 셀 합치기(M) · 셀 나누기…(S) · │ · 줄/칸 추가하기 · 줄/칸 지우기 · 블록 계산식› · 1,000 단위 구분 쉼표

**정리:**
- 중복 op(글자/문단 모양, 표/셀 속성, 셀 테두리/배경, 셀 합치기/나누기/높이·너비, 줄칸 추가/지우기, 블록계산식, 천단위, 하이퍼링크, 메모) = §A/표 sel 그대로. 클립보드 = `.e_cut`/`.e_copy`/`.e_paste`/`.e_delete`.
- **우클릭이 표 셀 op엔 메뉴 내비보다 빠른 경로**(셀 선택 상태에서 바로). 스킬 구현 시 표 편집은 우클릭 우선 고려.
- 우클릭 **고유**: `채팅 창에 현재 위치 공유`(협업, P3 제외).
- ⚠️ 우클릭 항목의 **자체 sel은 미캡처**(메뉴바와 다른 DOM 가능) → 우클릭 경로 쓰려면 별도 캡처(G15). 단 겹치니 우선은 메뉴바 sel로 충분.

원본 스크린샷: `rightclick/rc_1.png`(표 커서)·`rc_2.png`(표 선택)·`rc_3.png`(텍스트 선택).

---

## F. 인수인계 — 깨우친 점 · 사용 fixture · 미래 실험 목표 (이슈 후보)

> claw-hancomdocs "메뉴바 클릭 편집" 스킬을 이어받는 세션/자동화 파이프라인용 **단일 인수인계**. 산발 기록 대신 여기 모음. (작성 2026-06-09.)

### F.1 한 줄
- `MENU_MAP.md`(이 파일) = **목표 단위(op) 목록** = 클릭 편집 스킬이 구현할 대상. `menu-explore.js` = 그 목록을 뽑는 **recon 도구**(런타임 스킬 아님). 모드 = `<메뉴> [호버]` / `--sweep`(→`menu-inventory.json`) / `--raw <메뉴>` / `--table <doc> <px> <py>`.

### F.2 깨우친 점 (핵심)
1. **메뉴 항목 = 의미있는 CSS class 셀렉터.** 좌표 아니라 `.insert_image`·`.char_shape`·`.e_header`·`.trackchange_on` 로 클릭 → brittle 좌표 회피. 찾기도 `.find`/`.find_replace`/`.goto` 직접 → `hancom.js openFindDialog`의 좌표 우회보다 견고.
2. **서브메뉴**: 부모 = `…sub_group`(+`.sub_group_title`), 호버 시 오른쪽 플라이아웃. 서브 항목도 자기 셀렉터(`.e_view_scale`·`.e_insert_header`·`.trackchange_*`). + top 항목 **인라인 텍스트가 서브 내용을 이어붙여** 보여줌(예 "줄/칸 지우기줄 지우기칸 지우기") → 2차 출처.
3. **표 op은 셀에 커서 있어야 활성**([회색] 해제). canvas라 셀 좌표 = `detectPageRect`(페이지 흰영역) + page-local 오프셋. 표 없는 문서론 표 서브 못 폄 → **실제 표 문서 필요**.
4. **메뉴 크기 제각각**: 검토 = 변경 내용 추적 하나뿐 / 입력·표 = 큼.
5. **fixture는 반드시 한컴독스에서 열리는 파일이어야 한다.** 이 스킬은 한컴독스 *안에서* 동작하므로 — 어떻게 만들었든(rhwp든 뭐든) **한컴독스가 못 여는 파일은 못 씀**(open-compat 한계 → `cannot_open`). rhwp 생성물은 **열림이 보장 안 되고**(round-trip reject 등) rhwp 컨텍스트도 끌어옴 → **열림 검증된 실제 문서 권장**. 채택 전 `hancom.js capture`로 열림 확인(=`cannot_open` 아님).
6. **검증 = 캡처 self-check** (이 스킬의 본질). 매 op 후 캡처로 의도 영역만 바뀜 확인.
7. **툴바 3행 = 다이얼로그 없는 직접 서식 컨트롤**(`.bold`·`.italic`·`.font_color`·`.font_highlight_color`·`.align_center`·`.font_name`·`.font_size`·`.p_line_spacing`·`.bullet_list`/`.number_list`). 스타일 op의 최단 경로. ⚠️ **툴바 ▼ 드롭다운은 메뉴 `>`와 달리 호버 아니라 클릭으로 펼쳐짐.** (위 "툴바" 섹션.)
8. **협업 감지 = "편집 (N)" 카운트** (실측 `--collab` 2026-06-09). 사용자가 같은 문서를 열어두면(협업 모드) **"편집 (N)" 인디케이터가 뜨고 N≥2** (우리만=없음/null → 사용자 열자 "편집 (2)"). `.user_cursor_container`(cursors:1)·user_list는 **우리 세션 자체 노이즈라 신뢰 불가 — 카운트만 신뢰.** → **편집 전 안전 게이트**: N≥2면 사용자가 작업 중 → 자동 편집 금지/경고/확인(과거 블라인드 입력 사고 §2 재발 방지).
9. **협업 중 편집 충돌** (실측 `--collab-edit`, 2세션). 협업 중에도 우리 편집 작동+동기화 O. 단 **같은 줄/위치 동시 편집 = 한쪽 입력이 조용히 유실**(빨간 🚫, 글자수 미반영). 다른 영역은 머지 OK(구글독스식). **협업 모드는 차트/수식 비활성**. 원격 커서 위치 보임. → 안전 게이트(G16) 정당화.
10. **편집은 headless 전용 — headed = 편집 불가(보기 전용)** (실측 `--edit-demo`). 위치 클릭·캡처는 *현재 스크롤 기준*이라 **사용자가 만지면(스크롤/클릭) 어긋남.** → **하드 룰: 편집 op은 headless 세션에서만. headed로 띄우면 보기/캡처 전용이고 편집 명령은 거부(가드).** "보고 싶다"면 headed 관전 또는 **headless 편집 후 결과 capture**. **"사용자 만지는 세션 ≠ 편집 세션."** 캡처는 그 위치로 scroll(gotoPage) 후 찍음(headed면 사용자 눈에 보임). 단일 headed 세션 = 협업 아님(count 1).
11. **파일 식별 = docId** (실측 `--whoami`). 에디터 URL `webhwp.hancomdocs.com/webhwp/?mode=HWP_EDITOR&docId=<id>&lang=ko_KR` 에 **고유 docId**(+ `document.title`/헤더에 파일명). → **위치 편집 전 docId/제목 == 의도 확인 필수**(아니면 abort). **docId URL로 직접 열면 드라이브 목록 안 거쳐 업로드 race·오행 차단**(다른 세션이 행 밀어도 무관).
12. **OT sync 에러**: 편집 중 *"동기화가 필요합니다 / `OT_ERROR_CODE_SERVER_ACTION_SAVE_ERROR`"* 다이얼로그 가능(문서 OT 상태 꼬임 — 충돌 누적 시). 에러코드 = docId. → 스킬은 이 다이얼로그 **감지 + '확인' 눌러 복원** 처리 필요.

### F.3 사용한 fixture & 방법
- `case01-memo.hwpx` (test-hwp-cases) — 단순 메모(표 없음). 메뉴/서브 sweep 기본 문서.
- ~~생성 `tabletest.hwpx`(rhwp)~~ — 표 얻으려 만들었으나, **fixture 기준 = 한컴독스 열림**이라(+rhwp 컨텍스트 우려) 열림 검증된 실제 문서로 대체·삭제. (이 생성물은 우연히 열렸지만 일반적으로 보장 X.)
- **`연구개발계획서_v2_stepH.hwp`** (사용자 제공, `~/Downloads/`) — 정부 양식, **중첩 표 빽빽**. 표 셀 op 실전 타깃. pageWidth 978(넓음).
- **`coldstart_result.hwpx`** (사용자 제공) — 월간 보고서: 이미지·차트 + 표 + 리치 스타일(색/형광/취소선/각주). insert·format·review 카테고리 커버. (claw-hwp cold-verify 산출물로 보임.)
- 방법: `hancom.js capture --grid` 로 page-local 좌표 읽기 → `menu-explore.js --sweep/--raw/--table` 로 메뉴 덤프 → MENU_MAP 정리.

### F.4 미래 실험 목표 (이슈 후보 — 단계별 · 다양)
> 각 항목 = 자동화 파이프라인 미션 후보(난이도·검증 포함). claw-hancomdocs 트랙(6TRACK #3·#6) op 카테고리로 큐잉하면 좋음.

**[인프라/셀렉터]**
- **G1. 셀렉터 인벤토리 완성 → `webhwp-selectors.js`**: 9메뉴 + 모든 서브 + 다이얼로그 필드 셀렉터를 한 곳 집약. 표 서브 개별 sel 은 실제 표 문서로. 각 셀렉터 존재 alive-check 포함.
- **G10. brittleness / alive-check**: 매일 1회 sweep → 인벤토리 diff → 한컴 web 업데이트로 셀렉터 깨지면 알림(HANDOFF_PHASE2_EDIT §5). 한컴 변경 조기감지.
- **G15. 우클릭 컨텍스트 메뉴 sel 캡처**: 선택(드래그)→우클릭→덤프로 컨텍스트 메뉴 항목 자체 sel 확보(메뉴바와 다른 DOM 가능). op이 겹쳐 우선순위는 낮으나, **표 셀 편집은 우클릭이 더 빠른 경로**라 그때 캡처. `menu-explore --rightclick <doc> <px> <py>` 모드 후보.
- **G16. 협업 안전 게이트** (★ 편집 전 필수): 편집 직전 **"편집 (N)" 카운트 확인 → N≥2면 협업 모드** → **영역 회피 같은 영리한 짓 X. 그냥 편집 중단 + "문서가 열려있으니 닫아주세요" 안내**(실측: 같은 위치 동시 편집 = 한쪽 유실, F.2 #9). 카운트만 신뢰. 협업자 id도 보임.
- **G17. docId 기반 open/verify** (★ 위치 편집 안전): `openDoc`을 **docId URL 직접 열기**로(드라이브 목록 race·오행 차단) + **편집 직전 URL docId/제목 == 의도 확인 게이트**(아니면 abort). 첫 열기(이름→행 클릭) 후 docId 추출·저장. (F.2 #11)
- **G18. OT sync 에러 처리**: 편집 중 "동기화 필요/`OT_ERROR_...SAVE_ERROR`" 다이얼로그 **감지 + '확인' 클릭 복원** + 재시도/needs-human. (F.2 #12)
- **G19. 편집 = headless 전용 (headed = 편집 불가 가드)**: 위치 클릭·캡처 통제 위해 **편집 op은 headless 세션에서만 실행. headed로 띄우면 보기/캡처 전용 — 편집 명령은 거부(가드).** "보고 싶다"면 headed 관전 또는 headless 편집 후 결과 capture. 사용자 만지는 세션과 편집 세션 분리. (F.2 #10)

**[op PoC — 쉬운 것부터]**
- **G2. 다이얼로그 열기 PoC**: `.char_shape`/`.insert_image`/`.insert_table` 클릭 → 다이얼로그 뜸 캡처 → 취소로 닫기. **dry-run/`--apply` 가드**(HANDOFF_PHASE2 §2).
- **G3. 다이얼로그 인터랙션**: 입력›표 만들기 다이얼로그 행/열 입력→확인→표 생성→캡처. (다이얼로그 DOM 2차 sweep 필요.)
- **G6. 이미지 삽입**: 입력›그림 → `filechooser`로 파일 → 삽입 → 캡처.
- **G7. 머리말/꼬리말 + 쪽 번호**: 쪽›머리말›오른쪽 쪽 번호 → 캡처(머리말 영역).

**[실전 편집 — 어려움]**
- **G4. 표 셀 `set_cell_text` (R&D 양식)**: 라벨 셀("총괄책임자") 옆 입력칸 찾아 클릭→타이핑→캡처. 난점=canvas 셀 좌표 자동검출(픽셀 스캔으로 셀 경계, 또는 찾기로 라벨 앵커 후 offset). 안전=블라인드 입력 금지·캐럿 확인.
- **G5. 문자 스타일 (보고서류)**: 텍스트 드래그 선택→서식›글자모양→색/형광/취소선 적용→캡처. 드래그 선택 = canvas 좌표 드래그 + 선택영역 확인.

**[루프 완성]**
- **G8. `save_as_download`**: 파일›다운로드 → .hwp/.hwpx 다운로드(Playwright `waitForEvent('download')`)→로컬 검증. **"열어서 편집하고 다운로드"의 최소 루프 완성**.
- **G9. capture regression**: 매 op 전/후 캡처 diff로 의도 영역만 변경 검증. op별 reference 캡처 축적.

**[통합/흡수]**
- **G11. cold-verify hancomdocs 일반화**: `cold-verify.mjs`를 claw-hancomdocs로 확장 — 콜드 클로드가 "이 op 해줘"→캡처 검증(AUTOMATION_DESIGN §8 / 6TRACK §8, 현재 hwp/hwpx만).
- **G12. STABLE_OPS → claw-hwp 흡수**: op 카테고리 experimental→stable→internalized. stable 시 claw-hwp가 패턴 흡수(§16 지식흡수).
- **G13. capture 능력 양방향 흡수(아침 배치)**: `SHARED_integration-capture.md` "capture 능력 흡수" 참고 — 이 스킬이 발전시킨 capture 개선을 hancomdocs-capture가 흡수.

**[fixture 코퍼스]**
- **G14. 실제 문서 코퍼스 유지**: R&D 양식(표 빽빽)·보고서(이미지/스타일)·단순 메모. **fixture 채택 기준 = `hancom.js capture`로 한컴독스 열림 검증**(`cannot_open` 아님) — 스킬이 한컴독스 안에서 도니 못 여는 파일은 무의미. rhwp 생성물은 열림 미보장이라 지양. 저장 위치·민감정보(정부/기업 양식) 처리 결정 필요(MISSION_QUEUE §8 / §4 프라이버시).

---

## G. 단계별 구현 + 검증 계획 (Phase 2 편집 빌드 — 순수 UI)

> §F의 목표(G1~G15)를 **빌드 순서**로 구체화. 각 단계 = 구현 + 검증(capture) + fixture.
> **순수 한컴독스 UI만**(rhwp 0). 읽기 fallback(claw-hwp read 차용)은 **나중에** — 지금은 UI 네이티브만.

### 공통 (모든 단계)
- 편집 루프 = **locate → (select) → apply → verify(capture)**. apply sel = 위 인벤토리(§A·툴바·우클릭).
- 안전: **dry-run 기본 / `--apply`로만 실제 변경**, 블라인드 input 금지, 매 op 후 capture regression (`HANDOFF_PHASE2_EDIT.md` §2).
- fixture = `hancom.js capture`로 **한컴독스 열림 검증된 것만**.
- **편집은 headless 전용** (하드 룰): 위치 클릭이 사용자 스크롤/클릭에 깨지므로 **편집 op은 headless 세션에서만**. **headed는 보기/캡처 전용 — 편집 명령 거부 가드.** 관전 원하면 headed 관전 또는 headless 편집 후 결과 capture. (F.2 #10 / G19)
- 편집 직전 **docId/제목 == 의도 확인**(엉뚱한 문서 방지, G17) + **협업(편집 N≥2) 감지 시 중단**(G16).

### ★ 전 기능 커버리지 — 모든 메뉴·툴바 3행·우클릭 = 지원 대상
> **목표 = 인벤토리(§A 9메뉴 + 툴바 2·3행 + 우클릭) 전부 지원**(P3 제외만). 100개를 따로 만드는 게 아니라 **~5개 상호작용 메커니즘 × sel/값**. 메커니즘 만들면 각 기능 = (메커니즘, sel, 값) 꽂기 → **자동으로 전부 커버**.

| 메커니즘 | 방식 | 해당 기능 (예) | Stage |
|---|---|---|---|
| **M1 직접 클릭** | sel 1클릭 | undo/redo · 붙이기 · 정렬6 · bold/italic · 수준± · 쪽/단 나누기 · 격자/쪽윤곽 · 조판/문단부호 · 모두선택 · 메모 · 각주/미주 | S2 |
| **M2 다이얼로그** | sel→다이얼로그→입력→확인 | 글자/문단/글머리표/문단번호 모양 · 표 만들기 · 편집용지 · 그림 · 차트 · 문자표 · 하이퍼링크 · 책갈피 · 표/셀 속성 · 셀 나누기 · 스타일 · 찾기/바꾸기 · 새 번호 | S2 |
| **M3 드롭다운 픽** | 툴바 ▼클릭 / 메뉴 호버 → 항목 픽 | 글꼴 · 크기 · 줄간격 · 글자색 · 형광 · 스타일 · 확대축소 · 쪽모양 · 머리/꼬리말 · 단 · 글머리표/번호 스타일 · 표시숨기기 · 변경내용추적 | S2 |
| **M4 선택 후 적용** | locate→select(단어/셀)→M1~M3 | 문자스타일(특정 단어) · 표 셀 set_cell_text · 셀 op · 오려두기/복사/지우기 | S3·S4 |
| **M5 우클릭** | select→우클릭→항목 | 위 op들의 빠른 경로 (특히 표 셀) | S4 |
| **특수** | filechooser / download | 이미지 삽입 · save_as_download | S5·S6 |

- **제외(지원 안 함)**: `채팅`(.g_chat)·공유·접근성·데스크톱에서 편집 = 협업/계정/외부전환(콘텐츠 편집 무관). 나머지 **전부 지원**.
- **이름바꾸기(`.rename`)** = 제외 아님(잘못 분류 정정). 콘텐츠 편집은 아니나 **정당한 문서 op → M2로 쉽게 지원**(다이얼로그→새 이름). 단 "다른 이름으로" 니즈는 **S6 다운로드 시 파일명 지정**으로도 커버 → 흔한 케이스는 다운로드가 더 자연스러움.
- **중복(우클릭=메뉴/툴바)**: 같은 sel 재사용 → 따로 안 만듦. M5는 표 셀 등 우클릭이 빠른 곳만.
- 즉 **S0(셀렉터 전부 집약) + 메커니즘 M1~M5/특수(S2~S6) = 인벤토리 100% 지원**. 아래 단계는 그 메커니즘을 난이도순으로 빌드/검증하는 순서.

### S0. 인프라 — 셀렉터 집약 + dry-run 프레임
- 구현: `webhwp-selectors.js`(MENU_MAP→sel 한 곳), `hancom.js edit` 스캐폴드(dry-run 기본, `--apply` 게이트).
- 검증: 전 P1 sel **alive 체크**(에디터에 실제 존재). (G1·G10)
- fixture: `case01-memo.hwpx`(단순·빠른 열림).

### S1. locate 실증 — 찾기→캐럿 (+ 표 셀 텍스트 실측)
- 구현: `around` 재사용(캐럿 쪽/위치). **webhwp 찾기가 표 셀 안 텍스트를 잡는지 실측** (rhwp로 단정 금지 — 실제로 돌려 확인).
- 검증: 찾은 위치를 `zoom`으로 캡처 → 의도 단어/셀이 맞는지 시각 확인.
- fixture: `coldstart_result.hwpx`(본문 단어 "답례품"), `연구개발계획서.hwp`(표 셀 라벨 "총괄책임자").
- ★ 이 결과로 **S4 셀 타겟팅 경로 결정** (셀 텍스트 찾기 되면 셀 타겟팅 쉬움 / 안 되면 좌표 경로).

### S2. 다이얼로그 op (select 불필요 — 가장 쉬움)
- 구현: 메뉴/툴바 sel 클릭 → 다이얼로그 → 행/열·값 입력 → 확인. dry-run 먼저.
- 첫 op: **표 만들기**(`.insert_table`) → 그다음 글자모양(`.char_shape`).
- 검증: capture로 생성/적용 + 타 영역 미변경.
- fixture: `case01-memo.hwpx`(빈 메모에 표 추가).

### S3. 문자 스타일 (select 필요)
- 구현: locate(찾기) → **단어 선택**(더블클릭/Shift 확장; 선택영역 capture 확인) → 툴바 직접 sel(`.bold`·`.font_color`·`.align_center`) 또는 우클릭›글자모양.
- 검증: `zoom`으로 그 단어만 스타일 + 인접 미변경.
- fixture: `coldstart_result.hwpx`(이미 색/형광/취소선 있는 단어 — 비교 검증 쉬움).

### S4. 표 셀 편집 (★ 승부처 — 가장 어려움)
- 셀 locate 3경로: (a) 라벨 `around` 앵커 + offset으로 옆 칸, (b) **픽셀스캔 셀경계**(`detectPageRect`+`getImageData`, DEBUG_NOTES §3), (c) 사용자 명시 좌표.
- 구현: 셀 클릭(커서) → `set_cell_text` 타이핑 / **우클릭›셀 op**(셀 편집은 우클릭이 빠른 경로). 다페이지 표 = 스크롤(`#hcwoViewScroll`)+좌표 재계산.
- 검증: `zoom`으로 그 셀만 바뀜.
- fixture: `연구개발계획서.hwp`(중첩 표 실전) + (필요) 단순 표 1개 + (필요) 다페이지 긴 표.

### S5. 머리/꼬리말 · 이미지 · 표 op 확장
- 머리말 `.e_header`›쪽번호 · 이미지 `.insert_image`›filechooser · 셀 합치기/나누기/줄칸(우클릭 or 메뉴 sel).
- 검증/fixture: op별 capture.

### S6. save_as_download — 루프 완성
- 구현: `.d_download` → 형식 선택 → `page.waitForEvent('download')` → 로컬 저장.
- 검증: **다운로드본 재업로드 + capture**(UI 네이티브로 검증, claw-hwp 안 씀).
- fixture: S2~S5에서 편집한 문서.
- 완료 = **"열기 → 편집 → 다운로드" 최소 루프** 완성.

### S7. 자동 검증 / regression
- op별 reference 캡처 diff(G9) + cold-verify hancomdocs 일반화(G11).

### fixture 코퍼스 매칭
| fixture | 특성 | 열림 | Stage |
|---|---|---|---|
| `case01-memo.hwpx` | 단순 1쪽, 표X | ✓ | S0·S2·S3 |
| `coldstart_result.hwpx` | 이미지·차트+표+스타일 | ✓ | S1·S3·S5 |
| `연구개발계획서_v2_stepH.hwp` | 중첩 표 빽빽·넓은 폭 | ✓ | S1·S4 |
| (필요) 단순 표 1개 | 표 기본 op | 검증요 | S4 |
| (필요) 다페이지 긴 표 | 스크롤+좌표 | 검증요 | S4 |
| (필요) cannot_open 케이스 | 열림 거부 처리 | (의도) | S0 |
> 전부 `capture`로 열림 검증 후 채택. **rhwp 생성 금지.**
