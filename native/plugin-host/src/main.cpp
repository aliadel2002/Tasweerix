// tasweerix-plugin-host: hosts VST3 and CLAP plugins for Tasweerix over stdio.
//
//   tasweerix-plugin-host capabilities   → {"protocol":1,"formats":[...]}
//   tasweerix-plugin-host describe       ← JSON header line → JSON description of the plugin
//   tasweerix-plugin-host process        ← JSON header line + interleaved float32 frames
//                                        → JSON reply line + interleaved float32 frames
//
// See docs/audio.md ("Plugin host protocol").
#include <algorithm>
#include <cctype>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <string>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#define dup _dup
#define dup2 _dup2
#define fdopen _fdopen
#define fileno _fileno
#else
#include <unistd.h>
#endif

#include "host.hpp"
#include "json.hpp"

namespace host {

bool iequals(const std::string &a, const std::string &b) {
  return a.size() == b.size() && std::equal(a.begin(), a.end(), b.begin(), [](char x, char y) {
           return std::tolower((unsigned char)x) == std::tolower((unsigned char)y);
         });
}

std::vector<uint8_t> readFile(const std::string &path) {
  std::ifstream f(path, std::ios::binary);
  if (!f) throw std::runtime_error("cannot read state file " + path);
  return std::vector<uint8_t>(std::istreambuf_iterator<char>(f), {});
}

}  // namespace host

static const int PROTOCOL = 1;

static std::string formats() {
  std::string f = "[\"clap\"";
#ifdef TASWEERIX_HOST_VST3
  f += ",\"vst3\"";
#endif
  return f + "]";
}

static host::Request parseRequest(const std::string &line) {
  json::Value h = json::parse(line);
  if (h.kind != json::Value::Object) throw std::runtime_error("header must be a JSON object");
  if (h.num("protocol", PROTOCOL) != PROTOCOL) throw std::runtime_error("unsupported protocol version");
  host::Request r;
  r.format = h.str("format");
  r.path = h.str("path");
  r.id = h.str("id");
  r.uri = h.str("uri");
  r.name = h.str("name");
  r.state = h.str("state");
  r.sampleRate = h.num("sampleRate", 48000);
  r.channels = (uint32_t)h.num("channels", 2);
  r.frames = (uint64_t)h.num("frames", 0);
  if (auto p = h.get("params"); p && p->kind == json::Value::Object)
    for (auto &kv : p->o) {
      if (kv.second.kind == json::Value::Number) r.params.emplace_back(kv.first, kv.second.n);
      else if (kv.second.kind == json::Value::Bool) r.params.emplace_back(kv.first, kv.second.b ? 1.0 : 0.0);
    }
  if (r.path.empty()) throw std::runtime_error("header has no plugin path");
  if (r.channels == 0 || r.channels > 64) throw std::runtime_error("channels must be between 1 and 64");
  if (r.sampleRate <= 0) throw std::runtime_error("sampleRate must be positive");
  return r;
}

static std::unique_ptr<host::Plugin> open(const host::Request &r) {
  if (r.format == "clap") return host::openClap(r);
#ifdef TASWEERIX_HOST_VST3
  if (r.format == "vst3") return host::openVst3(r);
#endif
  throw std::runtime_error("this host cannot load " + (r.format.empty() ? std::string("unknown") : r.format) + " plugins");
}

static void readExact(char *dst, size_t n) {
  std::cin.read(dst, (std::streamsize)n);
  if ((size_t)std::cin.gcount() != n) throw std::runtime_error("input ended before all frames arrived");
}

static std::string describeJson(const host::PluginDescription &d) {
  std::string out = "{\"protocol\":1,\"name\":" + json::quote(d.name) + ",\"vendor\":" + json::quote(d.vendor) +
                    ",\"version\":" + json::quote(d.version) + ",\"id\":" + json::quote(d.id) +
                    ",\"inputs\":" + std::to_string(d.inputs) + ",\"outputs\":" + std::to_string(d.outputs) +
                    ",\"params\":[";
  for (size_t i = 0; i < d.params.size(); i++) {
    auto &p = d.params[i];
    char nums[128];
    std::snprintf(nums, sizeof nums, ",\"min\":%.9g,\"max\":%.9g,\"default\":%.9g}", p.min, p.max, p.def);
    out += (i ? "," : "") + std::string("{\"id\":") + json::quote(p.id) + ",\"name\":" + json::quote(p.name) +
           ",\"module\":" + json::quote(p.module) + nums;
  }
  return out + "]}";
}

int main(int argc, char **argv) {
#ifdef _WIN32
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
#endif
  // Plugins often print to stdout. Keep the real stdout for the protocol and send everything else to stderr.
  std::fflush(stdout);
  FILE *out = fdopen(dup(fileno(stdout)), "wb");
  dup2(fileno(stderr), fileno(stdout));
  if (!out) {
    std::cerr << "tasweerix-plugin-host: cannot open stdout\n";
    return 1;
  }
  std::string cmd = argc > 1 ? argv[1] : "";
  try {
    if (cmd == "capabilities") {
      std::fprintf(out, "{\"protocol\":%d,\"formats\":%s}\n", PROTOCOL, formats().c_str());
      return std::fclose(out) == 0 ? 0 : 1;
    }
    if (cmd != "process" && cmd != "describe") {
      std::cerr << "usage: tasweerix-plugin-host capabilities|describe|process\n";
      return 2;
    }
    std::string line;
    if (!std::getline(std::cin, line)) throw std::runtime_error("missing header line");
    host::Request req = parseRequest(line);
    auto plugin = open(req);
    if (cmd == "describe") {
      std::fprintf(out, "%s\n", describeJson(plugin->describe()).c_str());
      return std::fclose(out) == 0 ? 0 : 1;
    }
    const uint32_t c = req.channels;
    const uint64_t n = req.frames;
    std::vector<float> interleaved(n * c);
    readExact(reinterpret_cast<char *>(interleaved.data()), interleaved.size() * sizeof(float));
    std::vector<std::vector<float>> audio(c, std::vector<float>(n));
    for (uint64_t i = 0; i < n; i++)
      for (uint32_t ch = 0; ch < c; ch++) audio[ch][i] = interleaved[i * c + ch];
    plugin->process(audio, req);
    for (uint64_t i = 0; i < n; i++)
      for (uint32_t ch = 0; ch < c; ch++) interleaved[i * c + ch] = audio[ch][i];
    std::fprintf(out, "{\"protocol\":%d,\"channels\":%u,\"frames\":%llu}\n", PROTOCOL, c, (unsigned long long)n);
    size_t wrote = std::fwrite(interleaved.data(), sizeof(float), interleaved.size(), out);
    return std::fclose(out) == 0 && wrote == interleaved.size() ? 0 : 1;
  } catch (const std::exception &e) {
    std::cerr << "tasweerix-plugin-host: " << e.what() << "\n";
    return 1;
  }
}
