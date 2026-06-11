# GlanceShift Tobii Pilot

This branch is the Tobii Eye Tracker 5 version of the GlanceShift pilot experiment.

Read [TOBII_DEMO_CONTEXT.md](TOBII_DEMO_CONTEXT.md) first for the full demo-machine setup and experiment flow.

## Quick Start

```powershell
git fetch --all
git switch codex/tobii-pilot-experiment
npm install

$env:TOBII_TGI_SDK_DIR="C:\path\to\TobiiGameIntegrationAPI"
npm run build:tobii
npm run dev
```

## Runtime Assumptions

- Windows demo machine
- Tobii Eye Tracker 5 installed and calibrated in Tobii's app before running GlanceShift
- Tobii Game Integration API SDK available locally
- Visual Studio Build Tools with `Desktop development with C++`

## Input Path

The app uses Tobii gaze/head-pose samples through `tools/tobii-bridge`. Webcam tracking, in-app gaze calibration, and WebGazer fallback are not part of this branch.

If the Tobii helper cannot start, the app reports a Tobii error and leaves mouse fallback only for debugging.

## Logs

Experiment CSV files are saved under the project folder:

```text
.\eval-logs\
```

Override with:

```powershell
$env:GLANCESHIFT_EVAL_LOG_DIR="D:\GlanceShiftLogs"
npm run dev
```
