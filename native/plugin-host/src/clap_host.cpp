// CLAP hosting: loads a .clap, applies parameters and state, and renders a buffer offline.
#include <clap/clap.h>

#include <algorithm>
#include <cstring>
#include <iostream>
#include <stdexcept>

#include "dylib.hpp"
#include "host.hpp"

namespace host {
namespace {

constexpr uint32_t BLOCK = 512;

// Host callbacks. Rendering is offline and single-threaded, so most requests need no action.
const void *hostExtension(const clap_host_t *, const char *id);
void hostNoop(const clap_host_t *) {}

const clap_host_t HOST = {
    CLAP_VERSION, nullptr, "Tasweerix", "Tasweerix", "https://github.com/aliadel2002/Tasweerix", "0.1.0",
    hostExtension, hostNoop, hostNoop, hostNoop,
};

void logMessage(const clap_host_t *, clap_log_severity severity, const char *msg) {
  if (severity >= CLAP_LOG_WARNING) std::cerr << "[plugin] " << msg << "\n";
}
const clap_host_log_t HOST_LOG = {logMessage};
// The host renders on one thread, which is both the main and the audio thread.
bool yes(const clap_host_t *) { return true; }
const clap_host_thread_check_t HOST_THREAD_CHECK = {yes, yes};
void paramsRescan(const clap_host_t *, clap_param_rescan_flags) {}
void paramsClear(const clap_host_t *, clap_id, clap_param_clear_flags) {}
const clap_host_params_t HOST_PARAMS = {paramsRescan, paramsClear, hostNoop};
const clap_host_latency_t HOST_LATENCY = {hostNoop};
const clap_host_state_t HOST_STATE = {hostNoop};

const void *hostExtension(const clap_host_t *, const char *id) {
  if (!std::strcmp(id, CLAP_EXT_LOG)) return &HOST_LOG;
  if (!std::strcmp(id, CLAP_EXT_THREAD_CHECK)) return &HOST_THREAD_CHECK;
  if (!std::strcmp(id, CLAP_EXT_PARAMS)) return &HOST_PARAMS;
  if (!std::strcmp(id, CLAP_EXT_LATENCY)) return &HOST_LATENCY;
  if (!std::strcmp(id, CLAP_EXT_STATE)) return &HOST_STATE;
  return nullptr;
}

struct EventList {
  std::vector<clap_event_param_value_t> events;
  clap_input_events_t in{nullptr, size, get};
  const clap_input_events_t *list() {
    in.ctx = this;  // set on use: the list may have been moved since construction
    return &in;
  }
  static uint32_t size(const clap_input_events_t *l) { return (uint32_t) static_cast<const EventList *>(l->ctx)->events.size(); }
  static const clap_event_header_t *get(const clap_input_events_t *l, uint32_t i) {
    return &static_cast<const EventList *>(l->ctx)->events[i].header;
  }
};

bool dropEvent(const clap_output_events_t *, const clap_event_header_t *) { return true; }
const clap_output_events_t NO_OUTPUT_EVENTS = {nullptr, dropEvent};

struct ReadStream {
  const std::vector<uint8_t> *data;
  size_t pos = 0;
  clap_istream_t stream{this, read};
  static int64_t read(const clap_istream_t *s, void *buf, uint64_t size) {
    auto self = static_cast<ReadStream *>(s->ctx);
    uint64_t n = std::min<uint64_t>(size, self->data->size() - self->pos);
    std::memcpy(buf, self->data->data() + self->pos, n);
    self->pos += n;
    return (int64_t)n;
  }
};

class ClapPlugin : public Plugin {
 public:
  explicit ClapPlugin(const Request &req) : lib(pluginBinary(req.path)) {
    entry = static_cast<const clap_plugin_entry_t *>(lib.symbol("clap_entry"));
    if (!entry) throw std::runtime_error(req.path + " is not a CLAP plugin (no clap_entry)");
    if (!clap_version_is_compatible(entry->clap_version)) throw std::runtime_error(req.path + " uses an incompatible CLAP version");
    if (!entry->init(req.path.c_str())) throw std::runtime_error(req.path + ": clap_entry init failed");
    inited = true;
    auto factory = static_cast<const clap_plugin_factory_t *>(entry->get_factory(CLAP_PLUGIN_FACTORY_ID));
    if (!factory || factory->get_plugin_count(factory) == 0) throw std::runtime_error(req.path + " contains no plugins");
    for (uint32_t i = 0; i < factory->get_plugin_count(factory) && !desc; i++) {
      auto d = factory->get_plugin_descriptor(factory, i);
      if (!d) continue;
      bool match = req.id.empty() && req.name.empty();
      if (!req.id.empty()) match = req.id == d->id || iequals(req.id, d->name);
      else if (!req.name.empty()) match = iequals(req.name, d->name) || req.name == d->id;
      if (match) desc = d;
    }
    if (!desc && req.id.empty()) desc = factory->get_plugin_descriptor(factory, 0);
    if (!desc) throw std::runtime_error("no plugin with id \"" + req.id + "\" in " + req.path);
    plugin = factory->create_plugin(factory, &HOST, desc->id);
    if (!plugin || !plugin->init(plugin)) throw std::runtime_error(std::string("cannot create ") + desc->id);
    params = static_cast<const clap_plugin_params_t *>(plugin->get_extension(plugin, CLAP_EXT_PARAMS));
    latency = static_cast<const clap_plugin_latency_t *>(plugin->get_extension(plugin, CLAP_EXT_LATENCY));
    ports = static_cast<const clap_plugin_audio_ports_t *>(plugin->get_extension(plugin, CLAP_EXT_AUDIO_PORTS));
    state = static_cast<const clap_plugin_state_t *>(plugin->get_extension(plugin, CLAP_EXT_STATE));
  }

  ~ClapPlugin() override {
    if (plugin) {
      if (processing) plugin->stop_processing(plugin);
      if (active) plugin->deactivate(plugin);
      plugin->destroy(plugin);
    }
    if (inited) entry->deinit();
  }

  PluginDescription describe() override {
    PluginDescription d;
    d.name = desc->name ? desc->name : "";
    d.vendor = desc->vendor ? desc->vendor : "";
    d.version = desc->version ? desc->version : "";
    d.id = desc->id;
    d.inputs = mainChannels(true);
    d.outputs = mainChannels(false);
    for (auto &p : paramList()) {
      ParamInfo i;
      i.id = std::to_string(p.id);
      i.name = p.name;
      i.module = p.module;
      i.min = p.min_value, i.max = p.max_value, i.def = p.default_value;
      d.params.push_back(i);
    }
    return d;
  }

  void process(std::vector<std::vector<float>> &audio, const Request &req) override {
    if (!req.state.empty()) {
      if (!state) throw std::runtime_error(std::string(desc->id) + " cannot load state");
      auto bytes = readFile(req.state);
      ReadStream rs{&bytes};
      if (!state->load(plugin, &rs.stream)) throw std::runtime_error("plugin rejected state file " + req.state);
    }
    EventList ev = paramEvents(req);
    if (!ev.events.empty()) params->flush(plugin, ev.list(), &NO_OUTPUT_EVENTS);

    if (!plugin->activate(plugin, req.sampleRate, 1, BLOCK)) throw std::runtime_error("plugin failed to activate");
    active = true;
    if (!plugin->start_processing(plugin)) throw std::runtime_error("plugin failed to start processing");
    processing = true;
    const uint64_t lat = latency ? latency->get(plugin) : 0;

    // One buffer set per port: the main ports carry the signal, the rest (sidechains, aux outs) stay silent.
    auto makePorts = [&](bool input, std::vector<std::vector<std::vector<float>>> &store, std::vector<std::vector<float *>> &ptrs,
                         std::vector<clap_audio_buffer_t> &bufs) {
      uint32_t count = ports ? ports->count(plugin, input) : 0;
      store.resize(count), ptrs.resize(count), bufs.resize(count);
      for (uint32_t i = 0; i < count; i++) {
        clap_audio_port_info_t info{};
        ports->get(plugin, i, input, &info);
        store[i].assign(info.channel_count, std::vector<float>(BLOCK));
        for (auto &ch : store[i]) ptrs[i].push_back(ch.data());
        bufs[i] = {ptrs[i].data(), nullptr, info.channel_count, 0, 0};
      }
    };
    std::vector<std::vector<std::vector<float>>> inStore, outStore;
    std::vector<std::vector<float *>> inPtrs, outPtrs;
    std::vector<clap_audio_buffer_t> inBufs, outBufs;
    makePorts(true, inStore, inPtrs, inBufs);
    makePorts(false, outStore, outPtrs, outBufs);
    if (outBufs.empty()) throw std::runtime_error(std::string(desc->id) + " has no audio output");

    const uint32_t rc = (uint32_t)audio.size();
    const uint64_t n = audio.empty() ? 0 : audio[0].size();
    std::vector<std::vector<float>> result(rc, std::vector<float>(n));
    EventList none;
    clap_process_t proc{};
    proc.audio_inputs = inBufs.data();
    proc.audio_inputs_count = (uint32_t)inBufs.size();
    proc.audio_outputs = outBufs.data();
    proc.audio_outputs_count = (uint32_t)outBufs.size();
    proc.in_events = none.list();
    proc.out_events = &NO_OUTPUT_EVENTS;

    // Render the input plus `lat` frames of silence, then drop the first `lat` output frames.
    for (uint64_t pos = 0; pos < n + lat; pos += BLOCK) {
      const uint32_t len = (uint32_t)std::min<uint64_t>(BLOCK, n + lat - pos);
      auto sample = [&](uint32_t c, uint32_t i) { return pos + i < n ? audio[c][pos + i] : 0.0f; };
      if (!inStore.empty()) {
        auto &main = inStore[0];
        const uint32_t pc = (uint32_t)main.size();
        for (uint32_t c = 0; c < pc; c++)
          for (uint32_t i = 0; i < len; i++) {
            if (pc == 1 && rc > 1) {  // downmix to a mono plugin
              float s = 0;
              for (uint32_t k = 0; k < rc; k++) s += sample(k, i);
              main[c][i] = s / rc;
            } else main[c][i] = sample(c % rc, i);
          }
      }
      proc.frames_count = len;
      proc.steady_time = (int64_t)pos;
      if (plugin->process(plugin, &proc) == CLAP_PROCESS_ERROR) throw std::runtime_error("plugin reported a processing error");
      auto &main = outStore[0];
      const uint32_t pc = (uint32_t)main.size();
      for (uint32_t i = 0; i < len; i++) {
        if (pos + i < lat) continue;
        const uint64_t o = pos + i - lat;
        if (o >= n) break;
        for (uint32_t c = 0; c < rc; c++) {
          if (pc == 0) result[c][o] = 0;
          else if (rc == 1 && pc > 1) {  // downmix a multichannel plugin to mono
            float s = 0;
            for (uint32_t k = 0; k < pc; k++) s += main[k][i];
            result[c][o] = s / pc;
          } else result[c][o] = main[c % pc][i];
        }
      }
    }
    audio.swap(result);
  }

 private:
  Library lib;
  const clap_plugin_entry_t *entry = nullptr;
  const clap_plugin_descriptor_t *desc = nullptr;
  const clap_plugin_t *plugin = nullptr;
  const clap_plugin_params_t *params = nullptr;
  const clap_plugin_latency_t *latency = nullptr;
  const clap_plugin_audio_ports_t *ports = nullptr;
  const clap_plugin_state_t *state = nullptr;
  bool inited = false, active = false, processing = false;

  uint32_t mainChannels(bool input) const {
    if (!ports || ports->count(plugin, input) == 0) return 0;
    clap_audio_port_info_t info{};
    ports->get(plugin, 0, input, &info);
    return info.channel_count;
  }

  std::vector<clap_param_info_t> paramList() const {
    std::vector<clap_param_info_t> out;
    if (!params) return out;
    for (uint32_t i = 0; i < params->count(plugin); i++) {
      clap_param_info_t info{};
      if (params->get_info(plugin, i, &info)) out.push_back(info);
    }
    return out;
  }

  /** Matches each requested parameter by id, then by name (optionally "module/name"). */
  EventList paramEvents(const Request &req) const {
    EventList ev;
    if (req.params.empty()) return ev;
    auto list = paramList();
    for (auto &[key, value] : req.params) {
      const clap_param_info_t *hit = nullptr;
      for (auto &p : list)
        if (std::to_string(p.id) == key || iequals(key, p.name) || iequals(key, std::string(p.module) + "/" + p.name)) {
          hit = &p;
          break;
        }
      if (!hit) {
        std::string names;
        for (auto &p : list) names += (names.empty() ? "" : ", ") + std::string(p.name);
        throw std::runtime_error("unknown parameter \"" + key + "\" for " + desc->id + (names.empty() ? " (it has no parameters)" : " (has: " + names + ")"));
      }
      clap_event_param_value_t e{};
      e.header = {sizeof e, 0, CLAP_CORE_EVENT_SPACE_ID, CLAP_EVENT_PARAM_VALUE, 0};
      e.param_id = hit->id;
      e.cookie = hit->cookie;
      e.note_id = -1, e.port_index = -1, e.channel = -1, e.key = -1;
      e.value = std::clamp(value, hit->min_value, hit->max_value);
      ev.events.push_back(e);
    }
    return ev;
  }
};

}  // namespace

std::unique_ptr<Plugin> openClap(const Request &req) { return std::make_unique<ClapPlugin>(req); }

}  // namespace host
