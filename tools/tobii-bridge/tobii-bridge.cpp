#include "tobii_gameintegration.h"

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <Windows.h>
#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <exception>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>

using namespace TobiiGameIntegration;

namespace {

uint64_t parse_uint64(const char* value) {
  if (!value) return 0;
  return static_cast<uint64_t>(_strtoui64(value, nullptr, 10));
}

int parse_int(const char* value, int fallback) {
  if (!value) return fallback;
  const int parsed = std::atoi(value);
  return parsed > 0 ? parsed : fallback;
}

std::string json_escape(const std::string& value) {
  std::ostringstream out;
  for (const char c : value) {
    switch (c) {
      case '"': out << "\\\""; break;
      case '\\': out << "\\\\"; break;
      case '\n': out << "\\n"; break;
      case '\r': out << "\\r"; break;
      case '\t': out << "\\t"; break;
      default: out << c; break;
    }
  }
  return out.str();
}

void status(const std::string& state, const std::string& error = "") {
  std::cout << "{\"type\":\"status\",\"status\":\"" << state << "\"";
  if (!error.empty()) std::cout << ",\"error\":\"" << json_escape(error) << "\"";
  std::cout << "}" << std::endl;
}

int64_t now_ms() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

bool track_window_rectangle(ITobiiGameIntegrationApi* api, HWND hwnd, int& width, int& height) {
  RECT clientRect{};
  if (!hwnd || !GetClientRect(hwnd, &clientRect)) return false;

  width = static_cast<int>(std::max(1L, clientRect.right - clientRect.left));
  height = static_cast<int>(std::max(1L, clientRect.bottom - clientRect.top));
  return api->GetTrackerController()->TrackRectangle({0, 0, width, height});
}

} // namespace

int main(int argc, char** argv) {
  uint64_t hwndValue = 0;
  int fps = 60;

  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--hwnd" && i + 1 < argc) {
      hwndValue = parse_uint64(argv[++i]);
    } else if (arg == "--fps" && i + 1 < argc) {
      fps = parse_int(argv[++i], 60);
    }
  }

  try {
    ITobiiGameIntegrationApi* api = GetApi("GlanceShift");
    if (!api) {
      status("error", "GetApi returned null.");
      return 2;
    }

    IStreamsProvider* streams = api->GetStreamsProvider();
    if (!streams) {
      status("error", "GetStreamsProvider returned null.");
      api->Shutdown();
      return 3;
    }

    HWND hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(hwndValue));
    bool trackingStarted = false;
    int trackingWidth = GetSystemMetrics(SM_CXSCREEN);
    int trackingHeight = GetSystemMetrics(SM_CYSCREEN);
    if (hwnd) {
      trackingStarted = track_window_rectangle(api, hwnd, trackingWidth, trackingHeight);
      if (!trackingStarted) {
        trackingStarted = api->GetTrackerController()->TrackWindow(hwnd);
      }
    }
    if (!trackingStarted) {
      trackingStarted = api->GetTrackerController()->TrackRectangle({
        0,
        0,
        trackingWidth,
        trackingHeight
      });
    }
    if (!trackingStarted) {
      status("error", "Could not start Tobii window/rectangle tracking.");
      api->Shutdown();
      return 4;
    }

    status("ready");

    const int frameMs = std::max(1, 1000 / fps);
    while (true) {
      api->Update();

      GazePoint gazePoint;
      HeadPose headPose;
      const bool hasGaze = streams->GetLatestGazePoint(gazePoint);
      const bool hasHead = streams->GetLatestHeadPose(headPose);
      const bool present = streams->IsPresent();

      std::cout << "{\"type\":\"sample\""
                << ",\"valid\":" << (hasGaze ? "true" : "false")
                << ",\"present\":" << (present ? "true" : "false")
                << ",\"space\":\"window\""
                << ",\"t\":" << now_ms();

      if (hasGaze) {
        const double rawX = (static_cast<double>(gazePoint.X) + 1.0) * 0.5 * trackingWidth;
        const double rawY = (1.0 - ((static_cast<double>(gazePoint.Y) + 1.0) * 0.5)) * trackingHeight;
        const double x = std::clamp(rawX, 0.0, static_cast<double>(trackingWidth));
        const double y = std::clamp(rawY, 0.0, static_cast<double>(trackingHeight));
        std::cout << ",\"x\":" << x
                  << ",\"y\":" << y;
      }
      if (hasHead) {
        std::cout << ",\"yaw\":" << headPose.Rotation.YawDegrees
                  << ",\"pitch\":" << headPose.Rotation.PitchDegrees
                  << ",\"roll\":" << headPose.Rotation.RollDegrees;
      }
      std::cout << "}" << std::endl;

      std::this_thread::sleep_for(std::chrono::milliseconds(frameMs));
    }
  } catch (const std::exception& e) {
    status("error", e.what());
    return 1;
  } catch (...) {
    status("error", "Unknown Tobii bridge error.");
    return 1;
  }
}
