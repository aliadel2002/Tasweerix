/*
 * Test plugin for the Tasweerix plugin host: a stereo gain with 64 samples of latency.
 * Parameter 1 "Gain" is in dB; state stores the gain as a 32-bit float.
 */
#include <clap/clap.h>
#include <math.h>
#include <string.h>
#include <stdlib.h>

#define LATENCY 64

typedef struct {
  clap_plugin_t plugin;
  const clap_host_t *host;
  double gain_db;
  float delay[2][LATENCY];
  uint32_t pos;
} gain_t;

static const char *features[] = {CLAP_PLUGIN_FEATURE_AUDIO_EFFECT, CLAP_PLUGIN_FEATURE_UTILITY, NULL};
static const clap_plugin_descriptor_t desc = {
    CLAP_VERSION_INIT, "org.tasweerix.test.gain", "Test Gain", "Tasweerix", "", "", "", "1.0.0", "Gain with latency", features,
};

static void apply_events(gain_t *g, const clap_input_events_t *in) {
  for (uint32_t i = 0; i < in->size(in); i++) {
    const clap_event_header_t *h = in->get(in, i);
    if (h->space_id == CLAP_CORE_EVENT_SPACE_ID && h->type == CLAP_EVENT_PARAM_VALUE) {
      const clap_event_param_value_t *e = (const clap_event_param_value_t *)h;
      if (e->param_id == 1) g->gain_db = e->value;
    }
  }
}

static bool init(const clap_plugin_t *p) { return true; }
static void destroy(const clap_plugin_t *p) { free(p->plugin_data); }
static bool activate(const clap_plugin_t *p, double sr, uint32_t min, uint32_t max) {
  gain_t *g = p->plugin_data;
  memset(g->delay, 0, sizeof g->delay);
  g->pos = 0;
  return true;
}
static void deactivate(const clap_plugin_t *p) {}
static bool start_processing(const clap_plugin_t *p) { return true; }
static void stop_processing(const clap_plugin_t *p) {}
static void reset(const clap_plugin_t *p) {}
static clap_process_status process(const clap_plugin_t *p, const clap_process_t *proc) {
  gain_t *g = p->plugin_data;
  apply_events(g, proc->in_events);
  float k = powf(10.f, (float)g->gain_db / 20.f);
  for (uint32_t i = 0; i < proc->frames_count; i++) {
    for (int c = 0; c < 2; c++) {
      float x = proc->audio_inputs[0].data32[c][i];
      proc->audio_outputs[0].data32[c][i] = g->delay[c][g->pos] * k;
      g->delay[c][g->pos] = x;
    }
    g->pos = (g->pos + 1) % LATENCY;
  }
  return CLAP_PROCESS_CONTINUE;
}

static uint32_t ports_count(const clap_plugin_t *p, bool in) { return 1; }
static bool ports_get(const clap_plugin_t *p, uint32_t i, bool in, clap_audio_port_info_t *info) {
  if (i) return false;
  memset(info, 0, sizeof *info);
  info->id = 0;
  strcpy(info->name, in ? "In" : "Out");
  info->flags = CLAP_AUDIO_PORT_IS_MAIN;
  info->channel_count = 2;
  info->port_type = CLAP_PORT_STEREO;
  info->in_place_pair = CLAP_INVALID_ID;
  return true;
}
static const clap_plugin_audio_ports_t ports = {ports_count, ports_get};

static uint32_t params_count(const clap_plugin_t *p) { return 1; }
static bool params_info(const clap_plugin_t *p, uint32_t i, clap_param_info_t *info) {
  if (i) return false;
  memset(info, 0, sizeof *info);
  info->id = 1;
  info->flags = CLAP_PARAM_IS_AUTOMATABLE;
  strcpy(info->name, "Gain");
  strcpy(info->module, "Main");
  info->min_value = -60, info->max_value = 24, info->default_value = 0;
  return true;
}
static bool params_value(const clap_plugin_t *p, clap_id id, double *v) {
  if (id != 1) return false;
  *v = ((gain_t *)p->plugin_data)->gain_db;
  return true;
}
static bool params_v2t(const clap_plugin_t *p, clap_id id, double v, char *out, uint32_t n) { return false; }
static bool params_t2v(const clap_plugin_t *p, clap_id id, const char *t, double *v) { return false; }
static void params_flush(const clap_plugin_t *p, const clap_input_events_t *in, const clap_output_events_t *out) {
  apply_events(p->plugin_data, in);
}
static const clap_plugin_params_t params = {params_count, params_info, params_value, params_v2t, params_t2v, params_flush};

static uint32_t latency_get(const clap_plugin_t *p) { return LATENCY; }
static const clap_plugin_latency_t latency = {latency_get};

static bool state_save(const clap_plugin_t *p, const clap_ostream_t *s) {
  float v = (float)((gain_t *)p->plugin_data)->gain_db;
  return s->write(s, &v, sizeof v) == sizeof v;
}
static bool state_load(const clap_plugin_t *p, const clap_istream_t *s) {
  float v;
  if (s->read(s, &v, sizeof v) != sizeof v) return false;
  ((gain_t *)p->plugin_data)->gain_db = v;
  return true;
}
static const clap_plugin_state_t state = {state_save, state_load};

static const void *get_extension(const clap_plugin_t *p, const char *id) {
  if (!strcmp(id, CLAP_EXT_AUDIO_PORTS)) return &ports;
  if (!strcmp(id, CLAP_EXT_PARAMS)) return &params;
  if (!strcmp(id, CLAP_EXT_LATENCY)) return &latency;
  if (!strcmp(id, CLAP_EXT_STATE)) return &state;
  return NULL;
}
static void on_main_thread(const clap_plugin_t *p) {}

static uint32_t factory_count(const clap_plugin_factory_t *f) { return 1; }
static const clap_plugin_descriptor_t *factory_desc(const clap_plugin_factory_t *f, uint32_t i) { return i == 0 ? &desc : NULL; }
static const clap_plugin_t *factory_create(const clap_plugin_factory_t *f, const clap_host_t *host, const char *id) {
  if (strcmp(id, desc.id)) return NULL;
  gain_t *g = calloc(1, sizeof *g);
  g->host = host;
  g->plugin = (clap_plugin_t){&desc, g, init, destroy, activate, deactivate, start_processing, stop_processing, reset, process, get_extension, on_main_thread};
  return &g->plugin;
}
static const clap_plugin_factory_t factory = {factory_count, factory_desc, factory_create};

static bool entry_init(const char *path) { return true; }
static void entry_deinit(void) {}
static const void *entry_factory(const char *id) { return !strcmp(id, CLAP_PLUGIN_FACTORY_ID) ? &factory : NULL; }

CLAP_EXPORT const clap_plugin_entry_t clap_entry = {CLAP_VERSION_INIT, entry_init, entry_deinit, entry_factory};
