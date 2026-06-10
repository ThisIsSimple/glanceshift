# Tobii Eye Tracker 5 Bridge

This helper streams Tobii gaze/head-pose samples to the Electron main process as newline-delimited JSON.

## Target Machine Setup

1. Install Tobii Eye Tracker 5 runtime and calibrate the tracker with Tobii's app.
2. Download and unpack the Tobii Game Integration API SDK.
3. Install Visual Studio Build Tools with "Desktop development with C++".
4. In PowerShell from the repository root:

```powershell
$env:TOBII_TGI_SDK_DIR="C:\path\to\TobiiGameIntegrationAPI"
npm install
npm run build:tobii
npm run dev
```

The app looks for `tools/tobii-bridge/bin/tobii-bridge.exe` automatically.

If the helper lives elsewhere, set:

```powershell
$env:GLANCESHIFT_TOBII_BRIDGE="C:\path\to\tobii-bridge.exe"
```

## Behavior

- If the Tobii bridge starts and emits samples, GlanceShift uses Tobii gaze and Tobii head pose.
- If the helper is missing or fails, GlanceShift reports a Tobii error and leaves only mouse fallback for debugging.
- Tobii coordinates are sent as window coordinates. On a normal single-display demo setup, this maps directly to the full-screen overlay.

## Protocol

The helper writes one JSON object per line:

```json
{"type":"status","status":"ready"}
{"type":"sample","valid":true,"present":true,"space":"window","x":1024,"y":720,"yaw":1.2,"pitch":-0.3,"roll":4.5,"t":12345}
```

Valid status values are `starting`, `ready`, `error`, and `stopped`.
