# GlanceShift — Project Page

`ThisIsSimple/glanceshift` 의 GitHub Pages 랜딩 사이트 (orphan `gh-pages` 브랜치).
순수 정적 HTML + [Bulma](https://bulma.io/) — 빌드 과정 없음.

## 로컬 미리보기

```bash
cd <this-folder>
python3 -m http.server 8000
# http://localhost:8000
```

## 배포

1. `gh-pages` 브랜치를 origin 에 push:
   ```bash
   git push -u origin gh-pages
   ```
2. GitHub → repo Settings → Pages → Source = **Deploy from a branch** → Branch = `gh-pages` / `(root)` → Save.
3. 몇 분 뒤 `https://thisissimple.github.io/glanceshift/` 에 게시됨.

## 영상 임베드

`index.html` 의 `id="video"` 섹션에 placeholder 가 있다.
YouTube 업로드 후 `VIDEO_ID` 를 채운 `<iframe>` 으로 교체하면 된다.

## 구조

```
index.html              ← 단일 페이지
static/images/*.png     ← 보고서 figure (concept/conditions/behavioral/survey)
static/pdfs/*.pdf       ← 최종 보고서
static/css/index.css    ← 커스텀 스타일
.nojekyll               ← Jekyll 처리 비활성 (정적 파일 그대로 서빙)
```
