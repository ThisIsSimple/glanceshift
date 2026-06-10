# GlanceShift 파일럿 사용자 실험 구현 계획

## 2026-06-10 구현 업데이트

- Runner 체감 속도를 높이되, 목표 도달 시간은 약 60초로 유지한다.
- 충돌 시 runner 화면에 즉각적인 hit feedback을 표시한다.
- Baseline은 mouse/slider 조작을 제거하고 keyboard-only로 운영한다.
- GlanceShift side UI는 runner 시야와 겹침이 적은 bottom edge를 기본 호출 위치로 사용한다.
- Bottom edge 전체를 크게 3등분해서 `game`, `voice`, `master` target을 구분한다.
- Baseline도 GlanceShift와 같은 bottom mixer UI를 사용한다.
- Prompt가 없을 때도 baseline은 `Tab`/`Space`, GlanceShift는 bottom edge gaze로 mixer를 열 수 있다.
- GlanceShift 조정 완료 release time은 2초로 설정한다.
- 로그 출력은 condition/prompt별 핵심 지표만 담은 단일 summary CSV 하나로 저장한다.
- `control_time_ms`와 `total_command_time_ms`는 마지막 실제 음량 조절 시점까지로 계산하고, 완료 확인/release 대기시간은 제외한다.

> 작성일: 2026-06-10
> 기준 문서: `GlanceShift 사용자 실험 계획안 (파일럿).pdf`
> 작업 브랜치: `codex/pilot-experiment-plan`
> 상태: 사용자 결정 반영 완료. 이 문서는 구현 기준으로 사용한다.

---

## 1. 확정된 실험 방향

원 PDF는 gamepad menu baseline을 상정했지만, 현재 파일럿은 게임패드가 없으므로 **키보드/마우스 baseline**으로 구현한다. 비교의 핵심은 그대로 유지한다.

- **Baseline**: 키보드/마우스로 메뉴 UI를 열고 슬라이더를 직접 조작한다.
- **GlanceShift**: edge gaze로 같은 UI를 호출하고, edge menu에서 마지막으로 보고 나온 target을 자동 선택한 뒤, 시선을 runner로 돌려 head tilt로 조절한다.
- **Main task**: 2D 3-lane runner.
- **플랫폼**: Windows 기준.
- **참가자 목표**: 10명.
- **조건 순서**: 편의상 모든 참가자 동일 순서로 진행한다. Counterbalancing은 이번 MVP 범위에서 제외한다.
- **장애물/prompt sequence**: 모든 참가자, 모든 조건에서 동일하게 고정한다.
- **설문**: 앱에서 구현하지 않는다. 설문은 별도로 작성하고, 앱은 보고서용 로그를 충실히 저장하는 데 집중한다.

용어를 명확히 나눈다.

- **입력 조건(input condition)**: `mouse-menu`, `glanceshift`
- **조절 target(command target)**: `game`, `voice`, `master`

각 입력 조건 run 안에서 세 target prompt가 한 번씩 나온다.

| Prompt 시점 | Command target | 예시 prompt |
| --- | --- | --- |
| 10초 | game | 게임 소리를 낮추세요 / 올리세요 |
| 30초 | voice | 음성채팅 소리를 낮추세요 / 올리세요 |
| 50초 | master | 전체 소리를 낮추세요 / 올리세요 |

방향(up/down)은 고정 sequence 또는 seed로 결정하되, 두 입력 조건에서 반드시 동일해야 한다.

---

## 2. 현재 구현 현황

현재 구현의 권위 문서는 `docs/ARCHITECTURE.md`다.

| 영역 | 현재 구현 | 관련 파일 | 파일럿 실험 관점 |
| --- | --- | --- | --- |
| Electron overlay | 투명, 항상 위, click-through 제어, 전역 단축키 | `src/main/index.ts` | 실험 모드 진입 시 click-through를 끄고 키마 입력을 받을 수 있음 |
| 캘리브레이션 | 3-phase WebGazer 캘리브레이션, edge 보강 포함 | `Calibration.tsx` | GlanceShift 조건 전에 그대로 사용 |
| GazeBar 호출 | edge gaze intent score + rail lock | `App.tsx`, `edge-detector.ts`, `intent-score.ts` | GlanceShift 조건의 호출 메커니즘으로 재사용 |
| 항목 선택 | 현재는 항목 위 1초 dwell 후 선택 | `App.tsx` | 실험용으로 dwell을 제거하고 "마지막으로 본 항목 자동 선택"으로 변경 필요 |
| head tilt 조절 | roll 기반 rate-control joystick | `slider-mapper.ts` | GlanceShift 조절 로직으로 재사용 |
| OS volume bridge | 실제 OS 볼륨 읽기/쓰기 | `src/main/index.ts` | 이번 실험에서는 사용하지 않음 |
| 평가 CSV 저장 | `userData/eval-logs/*.csv` 저장 IPC | `src/main/index.ts`, `Evaluation.tsx` | 실험 로그 저장에 재사용 |
| 기존 평가 | gaze accuracy, trigger accuracy | `Evaluation.tsx` | runner 사용자 실험은 별도 구현 |
| 키마 baseline | 없음 | 없음 | 신규 구현 |
| runner game | 없음 | 없음 | 신규 구현 |
| 실험 오디오 믹서 | 없음 | 없음 | 신규 구현 |

---

## 3. 핵심 구현 요구사항

### 3.1 Runner

2D 3-lane runner로 구현한다.

- 세 lane: left / center / right
- 사용자는 키보드로 좌우 lane 변경
- 앞으로 보이는 구간을 길게 설계해 약 1초 정도의 visual buffer를 활용할 수 있게 한다.
- 장애물은 너무 빽빽하지 않게 배치한다.
- 충돌 시 즉사가 아니라 감속 penalty를 준다.
- 최종 goal 지점까지 정상적으로 가면 약 60초가 걸리도록 한다.

주요 측정은 최종 도달 시간이다.

- `finish_time_ms`: 시작부터 goal 도달까지 걸린 시간
- `finish_delay_ms`: 이상적 60초 대비 지연 시간
- `distance_at_end`: timeout이 생길 경우를 대비한 실제 진행 거리
- `collisions_total`
- `collisions_after_prompt_5s`: 각 prompt 이후 5초 window 내 충돌 수
- `speed_loss_after_prompt_5s`: 각 prompt 이후 5초 window 내 감속량 적분

### 3.2 Prompt schedule

한 run은 약 60초이고 prompt는 3회다.

- 10초: `game`
- 30초: `voice`
- 50초: `master`

각 prompt 이후 5초 window를 분석한다.

```ts
analysisWindowStart = promptAtMs
analysisWindowEnd = promptAtMs + 5000
```

장애물은 모든 조건에서 동일해야 한다. prompt 직후 window 안에 최소 하나의 의미 있는 회피 상황이 들어오도록 배치한다.

### 3.3 오디오 믹서

실제 OS 볼륨 변경은 하지 않는다. 대신 실험 안에서 두 음원을 동시에 재생하고, 세 target을 조절한다.

- `gameVolume`: 게임 음원 gain
- `voiceVolume`: 음성채팅 음원 gain
- `masterVolume`: game + voice 전체에 곱해지는 master gain

최종 실제 출력은 다음처럼 계산한다.

```ts
gameOutput = gameSource * gameVolume * masterVolume
voiceOutput = voiceSource * voiceVolume * masterVolume
```

구현은 Web Audio API 기준으로 한다.

- game source: looped game-like tone/noise 또는 bundled sample
- voice source: looped voice-chat-like sample 또는 speech-like generated tone
- gain node: game / voice / master 각각 분리
- 조절 중 tick/pitch feedback을 줄 수 있으나, metric logging이 우선이다.

### 3.4 Baseline: keyboard/mouse menu

Baseline은 키마로 조작한다. runner 조작과 보조명령 조작이 같은 손/주의 자원을 경쟁하도록 만든다.

권장 기본 조작:

| 동작 | 입력 |
| --- | --- |
| lane left/right | `A` / `D` 또는 `ArrowLeft` / `ArrowRight` |
| menu 열기/닫기 | `Tab` 또는 `Space` |
| target 선택 | 마우스 클릭 또는 `1`/`2`/`3` |
| slider 조절 | 마우스 drag 또는 `Q`/`E`, `ArrowUp`/`ArrowDown` |
| 완료 | `Enter` 또는 완료 버튼 |

UI는 GlanceShift와 거의 동일한 레이아웃을 쓰되, baseline에는 마우스로 조절 가능한 명시적 slider가 있어야 한다.
Baseline도 target delta는 완료 조건이 아니라 성공/불완전 여부를 판정하는 분석 기준으로 기록한다.

### 3.5 GlanceShift condition

GlanceShift는 기존 edge gaze + GazeBar + head tilt 흐름을 실험 target 3개에 맞게 연결하되, **선택 dwell은 제거한다**.

- edge gaze로 mixer overlay 호출
- edge menu 위에서 gaze가 지나간 마지막 target을 `hoveredTarget`으로 기록
- gaze가 edge/menu 영역을 벗어나 runner play area로 돌아오면 `hoveredTarget`을 자동 선택
- 선택 직후부터 head tilt로 해당 target gain 조절
- 조절 완료는 기존 GlanceShift 방식과 동일하게 처리한다. 머리가 upright 상태로 돌아온 뒤 release timer가 끝나면 command를 완료/commit으로 기록한다.
- target delta는 완료 조건이 아니라 성공/불완전 여부를 판정하는 분석 기준으로만 사용한다.
- 완료 후 overlay/selection은 자동 해제하고, 다음 prompt까지 일반 runner 상태로 복귀

실험 중 target이 3개이므로 기존 `volume/brightness` 항목 대신 다음 항목을 사용한다.

- `game`
- `voice`
- `master`

이 방식의 목적은 GlanceShift 조건에서 시선을 오래 붙잡지 않는 것이다. 사용자는 edge로 가서 target을 스치듯 지정하고, 곧바로 runner를 다시 보면서 head tilt로 조절한다. 따라서 trial 로그에는 dwell time 대신 다음 값을 남긴다.

- `edge_enter_at_ms`
- `last_target_hover_at_ms`
- `auto_selected_at_ms`
- `returned_to_play_area_at_ms`
- `gaze_off_ms_during_selection`
- `gaze_off_ms_during_adjustment`
- `glanceshift_release_reason`

---

## 4. 메트릭과 로깅

보고서에 쓸 수 있도록 모든 핵심 메트릭은 CSV로 저장한다. 설문은 앱 밖에서 처리하므로 survey CSV는 만들지 않는다.

### 4.1 Session CSV

```csv
session_id,participant_id,started_at,platform,condition_order,participant_target_n,viewport_w,viewport_h
```

값:

- `platform`: `windows`
- `condition_order`: 예: `mouse-menu>glanceshift`
- `participant_target_n`: `10`

### 4.2 Run CSV

입력 조건 1회 run 단위 요약.

```csv
session_id,participant_id,condition,run_idx,
started_at_ms,finished_at_ms,finish_time_ms,finish_delay_ms,
distance_at_end,collisions_total,obstacle_seed,prompt_seed,
completed,abort_reason
```

### 4.3 Prompt Trial CSV

prompt 하나가 trial 하나다. 각 condition마다 3줄이 생긴다.

```csv
session_id,participant_id,condition,run_idx,trial_idx,
prompt_target,prompt_direction,prompt_at_ms,analysis_window_ms,
command_started_at_ms,target_selected_at_ms,first_adjustment_at_ms,command_completed_at_ms,
edge_enter_at_ms,last_target_hover_at_ms,returned_to_play_area_at_ms,
selection_time_ms,control_time_ms,total_command_time_ms,incomplete,
value_start,value_end,value_delta,target_delta,
collisions_5s,speed_loss_area_5s,finish_time_ms_at_export,
gaze_off_ms_during_selection,gaze_off_ms_during_adjustment,gaze_off_ms_during_command,
gaze_missing_ms_during_command
```

`prompt_target` 값:

- `game`
- `voice`
- `master`

`prompt_direction` 값:

- `up`
- `down`

### 4.4 Event CSV

분석 재구성을 위해 event log를 남긴다.

```csv
session_id,participant_id,condition,t_ms,event_type,payload_json
```

필수 event:

- `run_start`
- `run_finish`
- `prompt_show`
- `menu_open`
- `target_hover`
- `target_auto_select`
- `target_select`
- `adjust_start`
- `adjust_tick`
- `command_complete`
- `command_timeout`
- `collision`
- `lane_change`
- `audio_value_change`
- `gaze_off_start`
- `gaze_off_end`
- `gaze_missing_start`
- `gaze_missing_end`

### 4.5 Frame Sample CSV

모든 메트릭을 재계산할 수 있도록 저주기 sample도 남긴다. 용량을 줄이기 위해 10Hz면 충분하다.

```csv
session_id,participant_id,condition,t_ms,
distance,speed,lane,target_lane,
game_volume,voice_volume,master_volume,
active_prompt_id,active_command_target,
gaze_x,gaze_y,gaze_in_play_area,head_roll,head_yaw,
menu_open,overlay_visible
```

이 파일이 있으면 나중에 보고서에서 다음을 재계산할 수 있다.

- prompt 이후 임의 window의 충돌/감속
- gaze-off 정의 변경에 따른 재분석
- 조작 중 runner 통제 유지 여부
- volume 변화 곡선

---

## 5. 실험 절차

앱 안에서는 실험 실행과 로그 저장까지만 담당한다.

1. participant id 입력
2. WebGazer calibration
3. keyboard/mouse baseline practice
4. keyboard/mouse baseline run
5. GlanceShift practice
6. GlanceShift run
7. export/debrief

설문은 각 조건 직후 외부 양식으로 진행한다. 앱에는 조건 종료 시 “설문 진행 후 계속” 정도의 진행 버튼만 둔다.

---

## 6. 구현 구조

기존 `Evaluation.tsx`에 억지로 넣지 않고 별도 실험 모듈로 분리한다.

```text
src/renderer/src/experiment/
  pilot-types.ts
  pilot-config.ts
  useKeyboardMouseControls.ts
  audio-mixer.ts
  runner-sim.ts
  experiment-logger.ts
  PilotExperiment.tsx
  RunnerGame.tsx
  MixerOverlay.tsx
  ConditionIntro.tsx
  ConditionBreak.tsx
  ExportSummary.tsx
```

`App.tsx` 변경:

- 실험 모드 state 추가
- 전역 단축키 또는 UI에서 `PilotExperiment` 진입
- 실험 중 click-through off
- `gaze`, `head`, `edgeSnapshot`을 `PilotExperiment`에 전달
- 기존 일반 GazeBar와 실험 GazeBar가 동시에 뜨지 않도록 guard

---

## 7. 구현 단계

### Phase 0. Config와 타입

- `pilot-config.ts`에 확정값을 정의한다.
- run duration: 60초
- target finish time: 60초
- prompt schedule: 10초 / 30초 / 50초
- analysis window: 5초
- participant target: 10명
- input condition order: `mouse-menu`, `glanceshift`
- command targets: `game`, `voice`, `master`

완료 기준:

- 모든 실험 상수가 한 파일에서 확인 가능
- prompt/obstacle sequence가 deterministic하게 생성됨

### Phase 1. Runner simulation

- 3-lane runner simulation 작성
- deterministic obstacle schedule 작성
- 충돌 감속과 finish time 계산 작성
- 10Hz frame sample 추출

완료 기준:

- 키보드로 60초 run 가능
- 동일 seed에서 동일 obstacle/prompt 재현
- finish time, collision, speed loss가 계산됨

### Phase 2. Web Audio mixer

- game/voice/master gain graph 작성
- Windows/Electron renderer에서 재생 가능하게 구현
- 실험 시작 시 audio context unlock 처리
- 각 gain 변화 event logging

완료 기준:

- game/voice 음원이 동시에 재생됨
- 세 target이 독립적으로 조절됨
- master가 두 음원에 동시에 영향을 줌

### Phase 3. Keyboard/mouse baseline

- runner lane 조작
- menu open/close
- target 선택 UI
- mouse/keyboard slider 조절
- prompt별 command metric logging

완료 기준:

- 10/30/50초 prompt를 baseline으로 모두 완료 가능
- run/prompt/event/frame CSV가 채워짐

### Phase 4. GlanceShift 실험 overlay

- 기존 edge gaze 흐름을 실험 overlay와 연결
- target 3개 항목으로 GazeBar 대체
- dwell 선택 제거
- edge/menu에서 마지막으로 본 target을 기록
- play area 복귀 시 마지막 target 자동 선택
- head tilt로 game/voice/master gain 조절
- 머리가 upright로 돌아온 뒤 release timer가 끝나면 command 완료
- target delta 도달 여부는 trial success/incomplete 분석 기준으로 기록
- gaze-off/missing 측정

완료 기준:

- GlanceShift로 세 prompt 모두 완료 가능
- baseline과 같은 target delta/success 기준을 사용
- 선택 과정에 dwell timer가 없음
- 메인 화면을 다시 보면서 head tilt 조절 가능
- GlanceShift 완료 방식은 기존 upright-release 방식을 유지
- gaze-off와 head/gaze sample이 로그에 남음

### Phase 5. Orchestration/export

- participant id 입력
- calibration -> practice -> run -> break -> practice -> run -> export 흐름
- CSV 4종 저장: session/run/trial/event/frame
- export summary 화면

완료 기준:

- 참가자 1명이 앱 안에서 절차를 끝까지 완료 가능
- 저장된 CSV만으로 보고서 표/그래프 작성 가능

### Phase 6. 검증

- `npm run typecheck`
- keyboard-only dry run
- GlanceShift dry run
- CSV 스키마 확인
- Windows에서 audio playback 확인

완료 기준:

- typecheck 통과
- 두 조건 run이 모두 종료되고 CSV 저장됨
- prompt 이후 5초 metric과 finish time이 정상 값으로 들어감

---

## 8. 남은 세부 결정은 구현 기본값으로 처리

사용자가 따로 지정하지 않은 항목은 다음 기본값으로 구현한다.

- input condition order: `mouse-menu` 먼저, `glanceshift` 다음
- command target order: `game`, `voice`, `master`
- prompt directions: `down`, `up`, `down`로 고정
- target delta: 20%p
- command timeout: 8초
- GlanceShift selection: dwell 없음, 마지막 hover target 자동 선택
- GlanceShift completion: 기존 upright-release 완료 방식 유지
- collision penalty: speed 35% 감소, 1.2초 회복
- lane change: 180ms interpolation
- frame sampling: 10Hz
- gaze play area: runner viewport 중앙 80% 영역
- gaze-off: command 진행 중 gaze가 play area 밖에 있는 누적 시간
- gaze missing: WebGazer 좌표가 없거나 음수인 시간
- practice duration: 조건별 20초

이 기본값은 예비 실행 후 조정할 수 있지만, 구현을 막는 추가 질문은 아니다.
