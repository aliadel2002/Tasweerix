// Test plugin for the Tasweerix plugin host: a stereo VST3 gain with 64 samples of latency.
// Parameter 1 "Gain" is -60..24 dB; state stores the normalized gain.
#include "base/source/fstreamer.h"
#include "pluginterfaces/base/ibstream.h"
#include "pluginterfaces/vst/ivstparameterchanges.h"
#include "public.sdk/source/main/pluginfactory.h"
#include "public.sdk/source/vst/vstaudioeffect.h"
#include "public.sdk/source/vst/vsteditcontroller.h"
#include "public.sdk/source/vst/vstparameters.h"

#include <cmath>
#include <cstring>

using namespace Steinberg;
using namespace Steinberg::Vst;

static const FUID ProcessorUID(0x5A1B2C3D, 0x11223344, 0x55667788, 0x99AABBCC);
static const FUID ControllerUID(0x6B2C3D4E, 0x11223344, 0x55667788, 0x99AABBCC);
constexpr ParamID kGain = 1;
constexpr int32 kLatency = 64;
constexpr double kMinDb = -60, kMaxDb = 24;

static double toDb(ParamValue norm) { return kMinDb + norm * (kMaxDb - kMinDb); }

class GainProcessor : public AudioEffect {
 public:
  GainProcessor() { setControllerClass(ControllerUID); }
  static FUnknown *createInstance(void *) { return (IAudioProcessor *)new GainProcessor; }

  tresult PLUGIN_API initialize(FUnknown *context) override {
    tresult r = AudioEffect::initialize(context);
    if (r != kResultOk) return r;
    addAudioInput(STR16("In"), SpeakerArr::kStereo);
    addAudioOutput(STR16("Out"), SpeakerArr::kStereo);
    return kResultOk;
  }
  tresult PLUGIN_API setBusArrangements(SpeakerArrangement *ins, int32 nIn, SpeakerArrangement *outs, int32 nOut) override {
    if (nIn == 1 && nOut == 1 && ins[0] == SpeakerArr::kStereo && outs[0] == SpeakerArr::kStereo)
      return AudioEffect::setBusArrangements(ins, nIn, outs, nOut);
    return kResultFalse;
  }
  uint32 PLUGIN_API getLatencySamples() override { return kLatency; }
  tresult PLUGIN_API setActive(TBool state) override {
    std::memset(delay, 0, sizeof delay);
    pos = 0;
    return AudioEffect::setActive(state);
  }
  tresult PLUGIN_API process(ProcessData &data) override {
    if (auto changes = data.inputParameterChanges)
      for (int32 i = 0; i < changes->getParameterCount(); i++) {
        auto q = changes->getParameterData(i);
        int32 offset;
        ParamValue v;
        if (q && q->getParameterId() == kGain && q->getPoint(q->getPointCount() - 1, offset, v) == kResultTrue) gain = v;
      }
    if (data.numSamples == 0 || data.numInputs == 0 || data.numOutputs == 0) return kResultOk;
    const float k = (float)std::pow(10.0, toDb(gain) / 20.0);
    for (int32 i = 0; i < data.numSamples; i++) {
      for (int c = 0; c < 2; c++) {
        float x = data.inputs[0].channelBuffers32[c][i];
        data.outputs[0].channelBuffers32[c][i] = delay[c][pos] * k;
        delay[c][pos] = x;
      }
      pos = (pos + 1) % kLatency;
    }
    return kResultOk;
  }
  tresult PLUGIN_API setState(IBStream *state) override {
    IBStreamer s(state, kLittleEndian);
    double v;
    if (!s.readDouble(v)) return kResultFalse;
    gain = v;
    return kResultOk;
  }
  tresult PLUGIN_API getState(IBStream *state) override {
    IBStreamer s(state, kLittleEndian);
    s.writeDouble(gain);
    return kResultOk;
  }

 private:
  ParamValue gain = (0 - kMinDb) / (kMaxDb - kMinDb);
  float delay[2][kLatency] = {};
  int32 pos = 0;
};

class GainController : public EditController {
 public:
  static FUnknown *createInstance(void *) { return (IEditController *)new GainController; }
  tresult PLUGIN_API initialize(FUnknown *context) override {
    tresult r = EditController::initialize(context);
    if (r != kResultOk) return r;
    parameters.addParameter(new RangeParameter(STR16("Gain"), kGain, STR16("dB"), kMinDb, kMaxDb, 0));
    return kResultOk;
  }
  tresult PLUGIN_API setComponentState(IBStream *state) override {
    IBStreamer s(state, kLittleEndian);
    double v;
    if (!s.readDouble(v)) return kResultFalse;
    setParamNormalized(kGain, v);
    return kResultOk;
  }
};

BEGIN_FACTORY_DEF("Tasweerix", "https://github.com/aliadel2002/Tasweerix", "")
DEF_CLASS2(INLINE_UID_FROM_FUID(ProcessorUID), PClassInfo::kManyInstances, kVstAudioEffectClass, "Test Gain VST3",
           Vst::kDistributable, "Fx", "1.0.0", kVstVersionString, GainProcessor::createInstance)
DEF_CLASS2(INLINE_UID_FROM_FUID(ControllerUID), PClassInfo::kManyInstances, kVstComponentControllerClass,
           "Test Gain VST3 Controller", 0, "", "1.0.0", kVstVersionString, GainController::createInstance)
END_FACTORY
