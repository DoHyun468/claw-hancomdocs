# 한컴 수식 스크립트 문법 레퍼런스

`equation` 명령의 `--script`에 쓰는 한컴 수식 스크립트 토큰 전체 목록.
(수식 편집기 팔레트에서 직접 추출 — 토큰을 그대로 스크립트에 쓰면 됨. 대소문자 구분.)

```bash
node hancom.js equation --name <문서이름> --anchor "<단락 안 텍스트>" --script "<아래 토큰 조합>" --apply
```

## 기본 규칙
- 위첨자 `a^b` · 아래첨자 `a_b` · 묶음은 중괄호 `{ }` (예: `e^{-x}`)
- 공백 `~` (넓게 `~~`) · 줄 맞춤 `&` · 줄 바꿈 `#`
- 예: `x = {-b +- sqrt{b^2 -4ac}} over {2a}` → 근의 공식

## 구조 템플릿

| 분류 | 토큰 | 비고 |
|---|---|---|
| 첨자 | `^{ }` 위 · `_{ }` 아래 · `{ } LSUP { }` 왼쪽 위 · `{ } LSUB { }` 왼쪽 아래 · `UNDEROVER { } _{ } ^{ }` 위아래 동시 | |
| 분수 | `{ } over { }` | |
| 근호 | `sqrt { }` · `root n of x` (n제곱근) | |
| 합(큰 연산자) | `sum` `PROD` `COPROD` `INTER` `UNION` `BIGSQCAP` `BIGSQCUP` `BIGOPLUS` `BIGOMINUS` `BIGOTIMES` `BIGODIV` `BIGODOT` `BIGVEE` `BIGWEDGE` `BIGUPLUS` — 모두 `_{ } ^{ }` 한계 붙임 | 예: `sum from {i=1} to n` 또는 `sum _{i=1} ^n` |
| 적분 | `int` `dint`(이중) `tint`(삼중) `oint`(폐곡선) `odint` `otint` — `_{ } ^{ } { }` | |
| 극한 | `lim _{ } { }` · `lim _{x -> 0}` · `lim _{ ->inf}` · `Lim`(대문자 변형) | `rightarrow`도 → 로 동작 |
| 괄호(자동 크기) | `LEFT ( RIGHT )` · `LEFT [ RIGHT ]` · `LEFT { RIGHT }` · `LEFT < RIGHT >` · `LEFT \| RIGHT \|` · `LEFT DLINE RIGHT DLINE` · `LCEIL RCEIL` · `LFLOOR RFLOOR` · `OVERBRACE { } { }` · `UNDERBRACE { } { }` | 소문자 `left( right)`도 동작 |
| 행렬 | `matrix { & # & }`(괄호 없음) · `pmatrix`(소괄호) · `bmatrix`(대괄호) · `dmatrix`(행렬식 세로줄) | `&`=칸 구분, `#`=줄 구분 |
| 경우 | `cases { & # & }` | |
| 세로 쌓기 | `pile { # }` | |
| 세로 나눗셈 | `LONGDIV { } { } { }` | |
| 최소공배수/최대공약수 | `LADDER { & & # & & }` | |
| 상호 관계(화살표 위/아래 글) | `REL <화살표> { } { }` · `BUILDREL <화살표> { } { }` | 화살표 = `LRARROW` `lrarrow` `RARROW` `rarrow` `LARROW` `larrow` `EXARROW` |
| 장식 기호 | `vec { }` `dyad { }` `acute { }` `grave { }` `dot { }` `ddot { }` `under { }` `bar { }` `hat { }` `check { }` `arch { }` `tilde { }` `box { }` | 예: `vec{a}` → →a |

## 기호

### 그리스 소문자
`alpha` `beta` `gamma` `delta` `epsilon` `zeta` `eta` `theta` `iota` `kappa` `lambda` `mu` `nu` `xi` `omicron` `pi` `rho` `sigma` `tau` `upsilon` `phi` `chi` `psi` `omega`

### 그리스 대문자
`ALPHA` `BETA` `GAMMA` `DELTA` `EPSILON` `ZETA` `ETA` `THETA` `IOTA` `KAPPA` `LAMBDA` `MU` `NU` `XI` `OMICRON` `PI` `RHO` `SIGMA` `TAU` `UPSILON` `PHI` `CHI` `PSI` `OMEGA`

### 그리스/특수 문자
`ALEPH`(ℵ) `hbar`(ℏ) `imath` `jmath` `ohm` `LITER`(ℓ) `WP`(℘) `IMAG`(ℑ) `ANGSTROM`(Å) `vartheta` `varpi` `varsigma` `varupsilon` `varphi` `varepsilon`

### 합·집합 기호
`SMALLSUM` `SMALLPROD` `SMCOPROD` `SMALLINTER`(∩) `CUP`(∪) `SQCAP` `SQCUP` `OPLUS`(⊕) `OMINUS`(⊖) `OTIMES`(⊗) `ODIV` `ODOT`(⊙) `LOR`(∨) `WEDGE`(∧) `SUBSET`(⊂) `SUPERSET`(⊃) `SUBSETEQ`(⊆) `SUPSETEQ`(⊇) `IN`(∈) `OWNS`(∋) `NOTIN`(∉) `LEQ`(≤) `GEQ`(≥) `SQSUBSET` `SQSUPSET` `SQSUBSETEQ` `SQSUPSETEQ` `<<` `>>` `<<<` `>>>` `PREC`(≺) `SUCC`(≻) `UPLUS`

### 연산·논리 기호
`+-`(±) `-+`(∓) `TIMES`(×) `DIVIDE`(÷) `CIRC`(∘) `BULLET`(•) `DEG`(°) `AST`(∗) `STAR`(⋆) `BIGCIRC`(○) `EMPTYSET`(∅) `THEREFORE`(∴) `BECAUSE`(∵) `IDENTICAL`(≡) `EXIST`(∃) `!=`(≠) `DOTEQ`(≐) `image` `REIMAGE` `SIM`(∼) `APPROX`(≈) `SIMEQ`(≃) `CONG`(≅) `==` `ASYMP`(≍) `ISO` `DIAMOND`(◇) `DSUM` `FORALL`(∀) `prime`(′) `PARTIAL`(∂) `INF`(∞, 소문자 `inf`도 동작) `LNOT`(¬) `PROPTO`(∝) `XOR` `NABLA`(∇) `DAGGER`(†) `DDAGGER`(‡)

### 화살표
`larrow`(←) `rarrow`(→, `rightarrow`도 동작) `uparrow`(↑) `downarrow`(↓) `LARROW`(⇐) `RARROW`(⇒) `UPARROW`(⇑) `DOWNARROW`(⇓) `udarrow`(↕) `lrarrow`(↔, `<=>` 도 ⇔) `UDARROW`(⇕) `LRARROW`(⇔) `NWARROW`(↖) `SEARROW`(↘) `NEARROW`(↗) `SWARROW`(↙) `HOOKLEFT`(↩) `HOOKRIGHT`(↪) `MAPSTO`(↦) `vert`(|) `DLINE`(‖)

### 기타 기호
`CDOTS`(⋯) `LDOTS`(…) `VDOTS`(⋮) `DDOTS`(⋱) `TRIANGLE`(△) `NABLA`(∇) `ANGLE`(∠) `MSANGLE` `SANGLE` `RTANGLE` `VDASH`(⊢) `DASHV`(⊣) `BOT`(⊥) `TOP`(⊤) `MODELS`(⊨) `LAPLACE` `CENTIGRADE`(℃) `FAHRENHEIT`(℉) `LSLANT` `RSLANT` `ATT` `HUND` `THOU` `WELL`(#) `BASE` `BENZENE`

## 예시 모음
```
x = {-b +- sqrt{b^2 -4ac}} over {2a}            → 근의 공식
sum from {i=1} to n i^2 = {n(n+1)(2n+1)} over 6 → 시그마 합
int _0 ^inf e^{-x} dx = GAMMA (1)               → 적분·감마
lim _{x rightarrow 0} {sin x} over x = 1        → 극한
A = left [ matrix{1 & 0 # 0 & 1} right ]        → 행렬
root 3 of x ~ oint _0 ^1 x dx                   → 세제곱근·폐곡선 적분
vec{a} cdot bar{b} ~ THEREFORE ~ alpha != OMEGA → 장식·기호
```
