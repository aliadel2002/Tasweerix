// Shared types for the Tasweerix plugin host. Each format backend implements `Backend`.
#pragma once
#include <cstdint>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace host {

struct Request {
  std::string format, path, id, uri, name, state;
  double sampleRate = 48000;
  uint32_t channels = 2;
  uint64_t frames = 0;
  /** Parameter values keyed by id or name, in header order. */
  std::vector<std::pair<std::string, double>> params;
};

struct ParamInfo {
  std::string id, name, module;
  double min = 0, max = 1, def = 0;
};

struct PluginDescription {
  std::string name, vendor, version, id;
  uint32_t inputs = 0, outputs = 0;
  std::vector<ParamInfo> params;
};

/** A loaded plugin instance. */
class Plugin {
 public:
  virtual ~Plugin() = default;
  virtual PluginDescription describe() = 0;
  /**
   * Processes planar audio in place (`audio[c]` holds `frames` samples per channel). Applies `params`
   * before the first sample, loads `state` when not empty, and compensates the plugin's latency so the
   * output lines up with the input.
   */
  virtual void process(std::vector<std::vector<float>> &audio, const Request &req) = 0;
};

/** Opens the plugin a request names; throws std::runtime_error with a readable message on failure. */
std::unique_ptr<Plugin> openClap(const Request &req);
#ifdef TASWEERIX_HOST_VST3
std::unique_ptr<Plugin> openVst3(const Request &req);
#endif

/** Case-insensitive comparison used for matching parameter names. */
bool iequals(const std::string &a, const std::string &b);

/** Reads a whole file (for plugin state); throws when it cannot. */
std::vector<uint8_t> readFile(const std::string &path);

}  // namespace host
