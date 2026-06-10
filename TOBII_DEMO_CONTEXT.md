# GlanceShift Tobii Demo Context

이 파일은 Tobii Eye Tracker 5가 설치된 Windows 노트북에서 데모를 바로 실행하기 위한 작업 메모입니다.

## Branch

- 웹캠/WebGazer 실험 브랜치: `codex/pilot-experiment-plan`
- Tobii Eye Tracker 5 실험 브랜치: `codex/tobii-pilot-experiment`

내일 데모에서 Tobii를 쓸 경우 `codex/tobii-pilot-experiment` 브랜치를 pull해서 사용합니다.

## Demo Machine Requirements

1. Windows 노트북
2. Tobii Eye Tracker 5
3. Tobii Experience 또는 Tobii 설정 앱에서 시선 보정 완료
4. Node.js LTS와 npm
5. Visual Studio Build Tools
   - Workload: `Desktop development with C++`
6. Tobii Game Integration API SDK

현재 저장소에는 Tobii SDK 자체를 포함하지 않습니다. 라이선스와 배포 조건 때문에 SDK는 데모 노트북에 따로 설치되어 있어야 합니다.

## First Setup

PowerShell에서 저장소 루트로 이동합니다.

```powershell
cd C:\path\to\glanceshift
git fetch --all
git switch codex/tobii-pilot-experiment
npm install
```

Tobii Game Integration API SDK 경로를 지정한 뒤 bridge helper를 빌드합니다.

```powershell
$env:TOBII_TGI_SDK_DIR="C:\path\to\TobiiGameIntegrationAPI"
npm run build:tobii
```

빌드가 성공하면 다음 파일이 생성되어야 합니다.

```text
tools\tobii-bridge\bin\tobii-bridge.exe
```

## Run

```powershell
npm run dev
```

앱 실행 후 기본 단축키는 다음과 같습니다.

- `Ctrl+Shift+E`: 파일럿 실험 모드 열기/닫기
- `Ctrl+Shift+D`: 디버그 HUD 열기/닫기
- `Ctrl+Shift+I`: DevTools 열기/닫기
- `Ctrl+Shift+Q`: 앱 종료

Tobii bridge가 정상적으로 시작되면 앱은 Tobii gaze/head-pose 샘플만 사용합니다. bridge가 없거나 실행에 실패하면 gaze tracker가 error 상태가 되고, 디버그/조작 확인용 mouse fallback만 남습니다. WebGazer/webcam fallback은 Tobii 브랜치에서 제거했습니다.

## Experiment Flow

1. Tobii 설정 앱에서 참가자 시선 보정을 먼저 끝냅니다. 앱 내부 WebGazer 보정 단계는 없습니다.
2. `npm run dev`로 GlanceShift를 실행합니다.
3. `Ctrl+Shift+D`로 디버그 HUD를 켜서 `gaze tracker` 상태와 gaze 좌표가 움직이는지 확인합니다.
4. `Ctrl+Shift+E`로 실험 화면을 엽니다.
5. 참가자 ID를 입력하고 practice를 진행합니다.
6. 조건별 본 실험을 진행합니다.
7. 실험 종료 후 CSV 저장 경로를 확인합니다.

## Log Location

CSV는 프로젝트 폴더 아래에 저장됩니다.

```text
.\eval-logs\
```

예시:

```text
C:\path\to\glanceshift\eval-logs\pilot_P01_2026-06-11T12-34-56.csv
```

필요하면 실행 전에 저장 경로를 직접 지정할 수 있습니다.

```powershell
$env:GLANCESHIFT_EVAL_LOG_DIR="D:\GlanceShiftLogs"
npm run dev
```

## Tobii Troubleshooting

- `tools\tobii-bridge\bin\tobii-bridge.exe`가 없으면 `npm run build:tobii`를 먼저 실행합니다.
- `TOBII_TGI_SDK_DIR`가 SDK 루트를 가리키는지 확인합니다.
- Tobii Experience/설정 앱에서 Eye Tracker 5가 인식되고 보정이 끝났는지 확인합니다.
- 다른 앱이 Tobii 장치를 독점하고 있으면 종료합니다.
- 가능하면 단일 디스플레이와 100-125% Windows 배율에서 데모합니다.
- helper를 다른 위치에 둘 경우:

```powershell
$env:GLANCESHIFT_TOBII_BRIDGE="C:\path\to\tobii-bridge.exe"
npm run dev
```

## Notes For Demo

- 실제 음량은 OS 볼륨을 직접 바꾸지 않고, 앱 안의 게임 음원/음성채팅 음원/마스터 음량으로 실험합니다.
- CSV는 조건별 prompt 결과를 한 파일에 저장합니다.
- control time은 GlanceShift 완료 대기 시간을 제외하고 실제 조정 구간만 계산합니다.
- practice와 본 실험 시작 시 game/chat/master volume은 모두 50%로 초기화됩니다.
- 하단 sidebar는 prompt가 없어도 열 수 있습니다.
