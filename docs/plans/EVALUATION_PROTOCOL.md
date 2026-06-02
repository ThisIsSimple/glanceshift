# GlanceShift — 측정 & 시연 프로토콜

> 보고서 §5/6 의 정량 근거를 만들기 위한 명시적 절차. 이 문서를 따라가면 끝.

> **Status (2026-06-02 갱신)**: ⚠️ 일부 **historical**. 비교용 `filtered`/`raw` 모드가
> 제거되어 단일 `snapping` 모드만 남았다. 따라서:
> - **§1 의 "3 mode × 3 pose = 9 CSV" 매트릭스는 더 이상 유효하지 않다.** 모드 축은 사라지고
>   **pose 축만** 남는다 (gaze accuracy 는 pose 별 N회).
> - **§2 Step B 의 `⌘⇧1/2/3` 모드 전환 단계는 삭제.** 모드 전환 단축키 자체가 없다.
> - trigger 평가의 condition 라벨은 항상 `snapping__{pose}` 로 고정 저장된다.
> - 그 외 평가 절차(캘리브, `⌘⇧E` eval 진입, gaze/trigger eval, CSV 저장)는 현재도 유효.
>
> 권위 있는 현재 상태: [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

---

## 0. 사전 조건

- `app/` 에서 `npm run dev` 가 정상 실행되고 시선 추적이 작동
- macOS 카메라 권한 허용
- 캘리브레이션 한 번 완료 (`⌘⇧K` 의 3-phase wizard)

## 1. 측정 설계 — 3 mode × 3 pose = 9 CSV (gaze accuracy)

| | filtered | raw | snapping |
| --- | --- | --- | --- |
| **정면 baseline** | run | run | run |
| **좌/우 15° 회전** | run | run | run |
| **거리 +20cm** | run | run | run |

각 cell 이 25-target gaze accuracy 측정 1회. 총 9 회 × 50 초 ≈ **8 분**.

### 왜 이 매트릭스?

- **세로축 (mode)**: 보고서 §5.1 의 *interruption resilience* 주장을 정량화. **filtered vs raw** 의 차이 = OneEuro 필터의 기여도. **filtered vs snapping** 의 mean error 차이는 *기대상 0* (snapping 도 같은 필터된 좌표 사용) — 즉 snapping 의 가치는 정확도가 아니라 *결정성/안정성*. 보고서의 핵심 주장: Coarse target designation 으로 충분하다.
- **가로축 (pose)**: 보고서 §4.5 의 *Boundary Conditions* 직접 측정. 자세 변화에 따른 정확도 열화 곡선.
- 9 cell 매트릭스가 채워지면 보고서에 **table 1 (3×3)** 으로 그대로 들어감.

추가로 **trigger accuracy** 평가 (§3) 가 mode 별 TSR / MTT / WER / FTR 을 제공 (보고서 §5.1 표 2). 정확도 와 trigger 결정성 두 축을 모두 측정.

## 2. 측정 순서 — 실행 단계

### Step A — 캘리브레이션 안정화 (1회)

1. 앱 시작
2. `⌘⇧K` → 3-phase 캘리브 완주
3. 캘리브 직후 시선이 일관되게 추적되는지 1분 확인

### Step B — 9 회 측정

각 cell 마다:

1. `⌘⇧1` (filtered) / `⌘⇧2` (raw) / `⌘⇧3` (snapping) 로 **mode 전환**
2. `⌘⇧E` 로 평가 진입
3. **eval type** 으로 `gaze accuracy (5×5)` 선택 (trigger 평가는 §3 참고)
4. **pose preset** 선택 — `정면 baseline` / `좌/우 15° 회전` / `거리 +20cm` 중 하나
5. (선택) 화면 가로(cm) + 거리(cm) 입력 — 도(°) 환산용. 한 번 입력하면 이후도 같은 값 유지 권장
6. *현재 condition* 이 화면에 `snapping__yaw-15deg` 같은 형식으로 자동 표시됨 — 확인
7. *지정한 자세* 를 유지한 채 "시작" → 25 점 응시 (50 초)
8. 완료 후 **CSV 저장** → `~/Library/Application Support/glanceshift/eval-logs/` 에 저장됨
9. "완료" → 다음 cell

이 9회를 *같은 캘리브로 연속* 수행하는 게 중요. 캘리브 한 번 후 fresh 한 모델로 9 condition 을 측정해야 mode 비교가 fair.

### Step C — 분석 (자동)

```bash
cd app
npm run compare:evals -- --out ../EVAL_RESULTS.md
```

`EVAL_RESULTS.md` 가 프로젝트 루트에 생성됨. 9 condition 의 mean error (px + °), max error, within-target σ 가 markdown 표로 정리되어 있어 보고서에 그대로 복사 붙여 넣기 가능.

## 3. Trigger Accuracy 평가 (mode 별, 권장)

SNAPPING_MODE_PLAN §13. 각 mode 의 *의도된 lock* 이 얼마나 정확하고 빠른지, 그리고 *우연한 false trigger* 가 얼마나 자주 일어나는지 측정.

각 mode 마다:

1. `⌘⇧1` / `⌘⇧2` / `⌘⇧3` 로 mode 전환
2. `⌘⇧E` → eval type 으로 `trigger accuracy (20)` 선택
3. pose preset (보통 `정면 baseline`) 선택 → "시작"
4. 20 trials: 각 trial 마다 fixation cross 0.5s → 화살표 cue 0.3s (↑ ↓ ← →) → 가리키는 방향의 가장자리를 응시 → 최대 2초 안에 lock 되면 성공
5. 20 trials 끝나면 자동으로 30초 자유 시선 단계 (FTR 측정) — 평소처럼 화면을 둘러봄, 가장자리는 의식적으로 피함
6. 완료 후 TSR / mean trigger time / wrong-edge / FTR 표시 → CSV 저장
7. CSV 파일: `trigger_<mode>_<ts>.csv` (gaze accuracy 와 같은 폴더)

### 목표 수치

| Mode | TSR | MTT | WER | FTR (per 30s) |
| --- | --- | --- | --- | --- |
| filtered | ≥ 80% | ≤ 500 ms | ≤ 10% | ≤ 1 |
| raw | (필터 off 영향 측정용 — 기준 없음) | | | |
| snapping | ≥ 95% | ≤ 300 ms | ≤ 2% | ≤ 0.5 |

이 표가 보고서 §5.1 의 표 2 가 됨.

## 4. 시연 영상 (1 분)

### 촬영 환경

- 메인 화면: GlanceShift 앱 + 메뉴바가 보이는 풀스크린
- 보조 화면 또는 노트북 카메라 위쪽에 작은 미러: 사용자 얼굴 (시선·머리 갸웃이 보이도록)
- 음악 재생 중 (볼륨 변화가 청각·시각 모두로 확인되도록)
- mode 는 **snapping** (`⌘⇧3`) — 가장 견고한 동작 + cursor rail lock

### 1분 시나리오 (이상적)

**0:00–0:10 (10초) — 문제 제시 (visual cue)**
- 사용자가 키보드 양손에 두고 작업 중 (코딩, 문서 작성, 게임 등)
- caption: *"손은 메인 작업에. 보조 명령은?"*

**0:10–0:25 (15초) — 기존 방식의 비용**
- 손을 키보드에서 떼고 메뉴바 클릭으로 볼륨 조절
- 마우스 이동 시간, 메뉴 펼치는 시간이 보이도록
- caption: *"손이 떨어진 순간 — efference copy 단절 (Wolpert & Ghahramani, 2000)"*

**0:25–0:50 (25초) — GlanceShift**
- 다시 메인 작업으로 돌아옴 (손은 키보드)
- 시선을 화면 우측 가장자리로 → GazeBar slide-in
- 시선이 🔊 volume 위에서 머무름
- **머리만** 어깨 쪽으로 갸웃 → 볼륨 슬라이더 값이 변함 + 메뉴바 볼륨 인디케이터 동기 변화 + 음악 볼륨 청각 변화
- 시선 떼면 commit (콘솔 로그 살짝 보이게)
- caption: *"손은 그대로. 시선·머리만으로."*

**0:50–1:00 (10초) — 한 줄 정의**
- 화면 페이드 + text: *"GlanceShift — Hard interruption (손 차용) 을 Soft interruption (시선·머리 차용) 으로 변환"*
- 보고서 §1.2 의 한 문장 그대로

### 촬영 팁

- 디버그 HUD 끄기 (`⌘⇧D`) — clean shot
- 카메라 미러 영상은 작은 PIP로 합성 (편집 단계)
- 메뉴바 볼륨 인디케이터를 줌인 cut 한 번 넣으면 visual evidence 강력
- 자막 (caption) 은 보고서의 문구 그대로 사용 — 시연과 보고서의 일관성 ↑

### 권장 도구

- macOS QuickTime Player 으로 화면 + 시스템 오디오 동시 캡처
- 카메라는 별도 영상으로 찍고 후편집 PIP 합성 (iMovie 또는 Final Cut)
- 또는 OBS Studio 로 한 번에 (씬 layout 미리 만들어두면 편함)

## 5. 보고서 반영 체크리스트

측정·시연 후 보고서 갱신 항목:

- [ ] §5.1 — 표 1 (3 mode × 3 pose 의 mean error) 추가. filtered vs raw 차이 = OneEuro 필터 기여
- [ ] §5.1 — 표 2 (mode 별 TSR / MTT / WER / FTR) 추가. trigger accuracy 평가에서 도출
- [ ] §5.1 — "Coarse target designation 으로 충분한 이유": filtered 의 baseline 오차가 X° 인데도 snapping 의 TSR 이 Y% — 정확도 그 자체가 아닌 *알고리즘적 보강* 으로 인터랙션이 작동함을 보임
- [ ] §4.5 — Boundary Conditions: pose 변화에 따른 열화 곡선 (3-pose × 3-mode), filtered 는 회전에 민감, snapping 은 lock 후 안정
- [ ] §5.2 — 시연 영상 thumbnail + URL/QR
- [ ] §7 결론 — 측정 결과로 검증된 핵심 기여 요약
- [ ] §6.3 향후 방향 — GAZE_ACCURACY_PLAN.md 의 Phase 3.5b (NIC-EC) 가 future work

## 6. 그래프 만들기 (선택)

`EVAL_RESULTS.md` 의 표를 Excel/Google Sheets 로 옮기면 다음 차트가 쉽게 나옵니다:

- **bar chart (mode × pose)**: x축 pose, 막대 그룹 mode. 시각적으로 *"snapping 이 모든 pose 에서 trigger 안정"* 이 한 컷
- **line chart**: x축 pose 변화량, y축 mean error. 3 mode 의 곡선 기울기 비교

보고서 figure 로 직접 사용 가능.

---

## 빠른 참조 — 단축키

| key | 동작 |
| --- | --- |
| `⌘⇧D` | 디버그 HUD 토글 |
| `⌘⇧K` | 시선 캘리브레이션 (3-phase) |
| `⌘⇧E` | 평가 진입 (gaze accuracy 5×5 / trigger accuracy 20 선택) |
| `⌘⇧1` | Edge Mode: filtered (baseline) |
| `⌘⇧2` | Edge Mode: raw (필터 off, control) |
| `⌘⇧3` | Edge Mode: snapping (intent + rail lock) |
| `⌘⇧I` | DevTools |
| `⌘⇧Q` | 종료 |
