#include "tobii_gameintegration.h"

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
    if (hwnd) {
      api->GetTrackerController()->TrackWindow(hwnd);
    } else {
      api->GetTrackerController()->TrackWindow(GetConsoleWindow());
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
        std::cout << ",\"x\":" << gazePoint.X
                  << ",\"y\":" << gazePoint.Y;
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
