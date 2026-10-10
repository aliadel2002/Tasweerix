// VST3 hosting on the VST3 SDK's hosting helpers: loads a .vst3, applies parameters and a
// .vstpreset, and renders a buffer offline.
#include "public.sdk/source/common/memorystream.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"
#include "public.sdk/source/vst/hosting/plugprovider.h"
#include "public.sdk/source/vst/hosting/processdata.h"
#include "public.sdk/source/vst/utility/stringconvert.h"
#include "public.sdk/source/vst/vstpresetfile.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"

#include <algorithm>
#include <stdexcept>

#include "host.hpp"

using namespace Steinberg;
using namespace Steinberg::Vst;

namespace host {
namespace {

constexpr int32 BLOCK = 512;

SpeakerArrangement arrangementFor(uint32_t channels) {
  switch (channels) {
    case 1: return SpeakerArr::kMono;
    case 2: return SpeakerArr::kStereo;
    case 6: return SpeakerArr::k51;
    default: return SpeakerArr::kEmpty;
  }
}

class Vst3Plugin : public Plugin {
 public:
  explicit Vst3Plugin(const Request &req) {
    PluginContextFactory::instance().setPluginContext(hostApp);
    std::string err;
    module = VST3::Hosting::Module::create(req.path, err);
    if (!module) throw std::runtime_error("cannot load " + req.path + ": " + err);
    const auto &factory = module->getFactory();
    // Pick the class the request names (by id, name or UID), else the first audio effect.
    const std::string want = !req.id.empty() ? req.id : hasClassNamed(factory, req.name) ? req.name : "";
    for (auto &ci : factory.classInfos()) {
      if (ci.category() != kVstAudioEffectClass) continue;
      if (want.empty() || iequals(want, ci.name()) || iequals(want, ci.ID().toString())) {
        info = ci;
        found = true;
        break;
      }
    }
    if (!found) throw std::runtime_error("no audio effect " + (req.id.empty() ? std::string() : "\"" + req.id + "\" ") + "in " + req.path);
    provider = owned(new PlugProvider(factory, info, true));
    if (!provider->initialize()) throw std::runtime_error("cannot instantiate " + info.name());
    component = provider->getComponentPtr();
    controller = provider->getControllerPtr();
    processor = U::cast<IAudioProcessor>(component);
    if (!processor) throw std::runtime_error(info.name() + " has no audio processor");
  }

  ~Vst3Plugin() override {
    if (processing) processor->setProcessing(false);
    if (active) component->setActive(false);
    processData.unprepare();
    processor = nullptr;
    controller = nullptr;
    component = nullptr;
    provider = nullptr;
    PluginContextFactory::instance().setPluginContext(nullptr);
  }

  PluginDescription describe() override {
    PluginDescription d;
    d.name = info.name();
    d.vendor = info.vendor();
    d.version = info.version();
    d.id = info.ID().toString();
    d.inputs = mainChannels(kInput);
    d.outputs = mainChannels(kOutput);
    if (controller)
      for (int32 i = 0; i < controller->getParameterCount(); i++) {
        ParameterInfo pi{};
        if (controller->getParameterInfo(i, pi) != kResultOk) continue;
        ParamInfo p;
        p.id = std::to_string(pi.id);
        p.name = Steinberg::Vst::StringConvert::convert(pi.title);
        p.min = controller->normalizedParamToPlain(pi.id, 0);
        p.max = controller->normalizedParamToPlain(pi.id, 1);
        p.def = controller->normalizedParamToPlain(pi.id, pi.defaultNormalizedValue);
        d.params.push_back(p);
      }
    return d;
  }

  void process(std::vector<std::vector<float>> &audio, const Request &req) override {
    const uint32_t rc = (uint32_t)audio.size();
    if (!req.state.empty()) loadPreset(req.state);

    ProcessSetup setup{kOffline, kSample32, BLOCK, req.sampleRate};
    if (processor->setupProcessing(setup) != kResultOk) throw std::runtime_error(info.name() + " rejected the processing setup");
    // Ask for the requested layout on the main buses; keep the plugin's own layout if it refuses.
    if (auto arr = arrangementFor(rc); arr != SpeakerArr::kEmpty) {
      std::vector<SpeakerArrangement> ins(component->getBusCount(kAudio, kInput), arr), outs(component->getBusCount(kAudio, kOutput), arr);
      for (size_t i = 1; i < ins.size(); i++) processor->getBusArrangement(kInput, (int32)i, ins[i]);
      for (size_t i = 1; i < outs.size(); i++) processor->getBusArrangement(kOutput, (int32)i, outs[i]);
      processor->setBusArrangements(ins.data(), (int32)ins.size(), outs.data(), (int32)outs.size());
    }
    for (auto dir : {kInput, kOutput})
      for (int32 i = 0; i < component->getBusCount(kAudio, dir); i++) component->activateBus(kAudio, dir, i, true);
    if (component->setActive(true) != kResultOk) throw std::runtime_error(info.name() + " failed to activate");
    active = true;
    processing = true;
    processor->setProcessing(true);  // many plugins return kNotImplemented here; that is fine
    const uint64_t lat = processor->getLatencySamples();

    if (!processData.prepare(*component, BLOCK, kSample32)) throw std::runtime_error("cannot allocate buffers for " + info.name());
    if (processData.numOutputs == 0) throw std::runtime_error(info.name() + " has no audio output");
    ParameterChanges changes;
    applyParams(req, changes);
    processData.inputParameterChanges = &changes;
    processData.processMode = kOffline;

    const uint64_t n = audio.empty() ? 0 : audio[0].size();
    std::vector<std::vector<float>> result(rc, std::vector<float>(n));
    for (uint64_t pos = 0; pos < n + lat; pos += BLOCK) {
      const int32 len = (int32)std::min<uint64_t>(BLOCK, n + lat - pos);
      auto sample = [&](uint32_t c, int32 i) { return pos + i < n ? audio[c][pos + i] : 0.0f; };
      for (int32 b = 0; b < processData.numInputs; b++) {
        AudioBusBuffers &bus = processData.inputs[b];
        const uint32_t pc = (uint32_t)bus.numChannels;
        for (uint32_t c = 0; c < pc; c++)
          for (int32 i = 0; i < len; i++) {
            float v = 0;
            if (b == 0) {  // sidechains stay silent
              if (pc == 1 && rc > 1) {
                for (uint32_t k = 0; k < rc; k++) v += sample(k, i);
                v /= rc;
              } else v = sample(c % rc, i);
            }
            bus.channelBuffers32[c][i] = v;
          }
        bus.silenceFlags = 0;
      }
      processData.numSamples = len;
      if (processor->process(processData) != kResultOk) throw std::runtime_error(info.name() + " reported a processing error");
      if (pos == 0) changes.clearQueue();  // parameters go in with the first block only
      AudioBusBuffers &out = processData.outputs[0];
      const uint32_t pc = (uint32_t)out.numChannels;
      for (int32 i = 0; i < len; i++) {
        if (pos + i < lat) continue;
        const uint64_t o = pos + i - lat;
        if (o >= n) break;
        for (uint32_t c = 0; c < rc; c++) {
          if (pc == 0) result[c][o] = 0;
          else if (rc == 1 && pc > 1) {
            float s = 0;
            for (uint32_t k = 0; k < pc; k++) s += out.channelBuffers32[k][i];
            result[c][o] = s / pc;
          } else result[c][o] = out.channelBuffers32[c % pc][i];
        }
      }
    }
    processData.inputParameterChanges = nullptr;
    audio.swap(result);
  }

 private:
  IPtr<HostApplication> hostApp = owned(new HostApplication);
  VST3::Hosting::Module::Ptr module;
  VST3::Hosting::ClassInfo info;
  bool found = false, active = false, processing = false;
  IPtr<PlugProvider> provider;
  IPtr<IComponent> component;
  IPtr<IEditController> controller;
  IPtr<IAudioProcessor> processor;
  HostProcessData processData;

  static bool hasClassNamed(const VST3::Hosting::PluginFactory &f, const std::string &name) {
    for (auto &ci : f.classInfos())
      if (ci.category() == kVstAudioEffectClass && iequals(ci.name(), name)) return true;
    return false;
  }

  uint32_t mainChannels(BusDirection dir) const {
    if (component->getBusCount(kAudio, dir) == 0) return 0;
    BusInfo bi{};
    component->getBusInfo(kAudio, dir, 0, bi);
    return (uint32_t)bi.channelCount;
  }

  void loadPreset(const std::string &file) {
    auto bytes = readFile(file);
    IPtr<MemoryStream> stream = owned(new MemoryStream(bytes.data(), (TSize)bytes.size()));
    if (!PresetFile::loadPreset(stream, FUID::fromTUID(info.ID().data()), component, controller))
      throw std::runtime_error("cannot load preset " + file + " into " + info.name());
  }

  /** Matches each requested parameter by id, then by title; values are plain (in the parameter's units). */
  void applyParams(const Request &req, ParameterChanges &changes) {
    if (req.params.empty()) return;
    if (!controller) throw std::runtime_error(info.name() + " has no parameters");
    std::vector<ParameterInfo> list;
    for (int32 i = 0; i < controller->getParameterCount(); i++) {
      ParameterInfo pi{};
      if (controller->getParameterInfo(i, pi) == kResultOk) list.push_back(pi);
    }
    for (auto &[key, value] : req.params) {
      const ParameterInfo *hit = nullptr;
      for (auto &pi : list)
        if (std::to_string(pi.id) == key || iequals(key, Steinberg::Vst::StringConvert::convert(pi.title))) {
          hit = &pi;
          break;
        }
      if (!hit) {
        std::string names;
        for (auto &pi : list) names += (names.empty() ? "" : ", ") + Steinberg::Vst::StringConvert::convert(pi.title);
        throw std::runtime_error("unknown parameter \"" + key + "\" for " + info.name() + (names.empty() ? "" : " (has: " + names + ")"));
      }
      ParamValue norm = std::clamp(controller->plainParamToNormalized(hit->id, value), 0.0, 1.0);
      controller->setParamNormalized(hit->id, norm);
      int32 index = 0;
      if (auto q = changes.addParameterData(hit->id, index)) q->addPoint(0, norm, index);
    }
  }
};

}  // namespace

std::unique_ptr<Plugin> openVst3(const Request &req) { return std::make_unique<Vst3Plugin>(req); }

}  // namespace host
