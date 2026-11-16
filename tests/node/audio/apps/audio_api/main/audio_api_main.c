/* SPDX-License-Identifier: GPL-3.0-or-later
 * audio_api: a bench-test app exposing every call of the public audio API as a console function. A function only records
 * its request (console functions must not block); a task runs it and logs ONE line "RES <name> ..." with the outcome.
 * Arguments are one string, fields separated by ';'.
 *   kode.h:     tone "hz;ms" | samples "hz;ms;amp_pct" | play "path" | playstart "path" | isplaying | playstop
 *               streamopen "ch" | streamwrite "hz;ms;chunk;wait_ms;ch" | streamclose | set "name;value" | get "name"
 *               recfile "path;ms" | recsamples "ms" | recstart "ms" | recstatus | recstop | recsave "path"
 *               wavwrite "path;hz;ms" (writes a 48 kHz mono WAV with kode_file_write_bytes: a file for play/playstart)
 *   kode_sys.h: atone "hz;ms;amp" | avol "pct" | amic "db" | amute "0|1" | astop | ainfo | aplay "hz;ms" | arec "ms" |
 *               arecfile "path;ms" | aopen | awrite "hz;ms" | aclose
 * Answers of the AO calls are logged as RES lines too (RES a<kind> ...). */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "kode.h"
#include "kode_functions.h"
#include "kode_log.h"
#include "kode_sys.h"
#include "kqp.h"

KODE_APP_MANIFEST("Audio API", "test");
#define TAG "audio_api"
#define RATE 48000u

static uint32_t now_ms(void) { return (uint32_t)(esp_timer_get_time() / 1000); }

/* ---- sound helpers ---- */
static int16_t *make_sine(uint32_t hz, uint32_t ms, uint32_t amp_pct, uint32_t *frames_out)
{
    uint32_t n = (uint64_t)ms * RATE / 1000u;
    int16_t *b = malloc((size_t)(n ? n : 1) * sizeof(int16_t));
    if (!b) return NULL;
    for (uint32_t i = 0; i < n; i++)
        b[i] = (int16_t)lrint(32767.0 * amp_pct / 100.0 * sin(2.0 * M_PI * (double)((uint64_t)i * hz % RATE) / RATE));
    *frames_out = n;
    return b;
}
static double g_phase;            /* the stream writer's phase, continuous across writes */
static uint32_t g_wr_hz = 1000;

/* ---- the task side: one pending request ---- */
typedef struct { volatile int cmd; char text[96]; } slot_t;
static slot_t g_slot[2];   /* [0] the calls that block for long, [1] those that take no turn (stop, set, get, status): usable while [0] is busy */
enum { C_NONE = 0, C_TONE, C_SAMPLES, C_PLAY, C_PLAYSTART, C_ISPLAYING, C_PLAYSTOP, C_SOPEN, C_SWRITE, C_SCLOSE, C_SET, C_GET,
       C_RECFILE, C_RECSAMPLES, C_RECSTART, C_RECSTATUS, C_RECSTOP, C_RECSAVE, C_WAVWRITE };

static int16_t *g_rec; static uint32_t g_rec_frames;

static int split(char *t, char **f, int max)
{
    int n = 0; char *sv = NULL;
    for (char *p = strtok_r(t, ";", &sv); p && n < max; p = strtok_r(NULL, ";", &sv)) f[n++] = p;
    return n;
}

static void put_le(uint8_t *p, uint32_t v, int bytes) { for (int i = 0; i < bytes; i++) p[i] = (uint8_t)(v >> (8 * i)); }

static void run_cmd(int cmd, char *text)
{
    char *f[6] = { "", "", "", "", "", "" };
    int nf = split(text, f, 6); (void)nf;
    uint32_t t0 = now_ms();
    bool ok;
    switch (cmd) {
    case C_TONE:
        ok = kode_audio_tone((uint16_t)atoi(f[0]), (uint32_t)atoi(f[1]));
        KLOG_N(TAG, "RES tone ok=%d took=%u err=%s", ok, (unsigned)(now_ms() - t0), ok ? "" : kode_error());
        break;
    case C_SAMPLES: {
        uint32_t n; int16_t *b = make_sine((uint32_t)atoi(f[0]), (uint32_t)atoi(f[1]), (uint32_t)atoi(f[2]), &n);
        ok = b && kode_audio_play_samples(b, n);
        KLOG_N(TAG, "RES samples ok=%d frames=%u took=%u err=%s", ok, (unsigned)n, (unsigned)(now_ms() - t0), ok ? "" : kode_error());
        free(b);
        break; }
    case C_PLAY:
        ok = kode_audio_play(f[0]);
        KLOG_N(TAG, "RES play ok=%d took=%u err=%s", ok, (unsigned)(now_ms() - t0), ok ? "" : kode_error());
        break;
    case C_PLAYSTART:
        ok = kode_audio_play_start(f[0]);
        KLOG_N(TAG, "RES playstart ok=%d playing=%d err=%s", ok, (int)kode_audio_is_playing(), ok ? "" : kode_error());
        break;
    case C_ISPLAYING:
        KLOG_N(TAG, "RES isplaying %d", (int)kode_audio_is_playing());
        break;
    case C_PLAYSTOP:
        ok = kode_audio_play_stop();
        KLOG_N(TAG, "RES playstop ok=%d took=%u playing=%d err=%s", ok, (unsigned)(now_ms() - t0), (int)kode_audio_is_playing(), ok ? "" : kode_error());
        break;
    case C_SOPEN:
        ok = kode_audio_stream_open((uint8_t)atoi(f[0]));
        g_phase = 0;
        KLOG_N(TAG, "RES streamopen ok=%d took=%u err=%s", ok, (unsigned)(now_ms() - t0), ok ? "" : kode_error());
        break;
    case C_SWRITE: {   /* hz;ms;chunk;wait_ms;ch */
        uint32_t hz = (uint32_t)atoi(f[0]), total = (uint64_t)atoi(f[1]) * RATE / 1000u, chunk = (uint32_t)atoi(f[2]);
        uint32_t wait = (uint32_t)atoi(f[3]), ch = nf > 4 ? (uint32_t)atoi(f[4]) : 1u, sent = 0, taken_all = 0;
        if (chunk < 1) chunk = 480;
        int16_t *b = malloc((size_t)chunk * 2 * sizeof(int16_t));
        ok = b != NULL;
        while (ok && sent < total) {
            uint32_t n = total - sent < chunk ? total - sent : chunk, taken = 0;
            for (uint32_t i = 0; i < n; i++) {
                int16_t v = (int16_t)lrint(16000.0 * sin(g_phase));
                g_phase += 2.0 * M_PI * hz / RATE; if (g_phase > 2.0 * M_PI) g_phase -= 2.0 * M_PI;
                b[i * ch] = v; if (ch == 2) b[i * 2 + 1] = v;
            }
            ok = kode_audio_stream_write(b, n, wait, &taken);
            taken_all += taken; sent += taken;
            if (taken < n) break;
        }
        free(b);
        KLOG_N(TAG, "RES streamwrite ok=%d taken=%u took=%u err=%s", ok, (unsigned)taken_all, (unsigned)(now_ms() - t0), ok ? "" : kode_error());
        break; }
    case C_SCLOSE:
        ok = kode_audio_stream_close();
        KLOG_N(TAG, "RES streamclose ok=%d took=%u err=%s", ok, (unsigned)(now_ms() - t0), ok ? "" : kode_error());
        break;
    case C_SET:
        ok = kode_audio_set(f[0], (uint32_t)atoi(f[1]));
        KLOG_N(TAG, "RES set ok=%d err=%s", ok, ok ? "" : kode_error());
        break;
    case C_GET: {
        uint32_t v = kode_audio_get(f[0]);
        KLOG_N(TAG, "RES get %s=%u err=%s", f[0], (unsigned)v, kode_error());
        break; }
    case C_RECFILE:
        ok = kode_audio_record_file(f[0], (uint32_t)atoi(f[1]));
        KLOG_N(TAG, "RES recfile ok=%d took=%u err=%s", ok, (unsigned)(now_ms() - t0), ok ? "" : kode_error());
        break;
    case C_RECSAMPLES: {
        uint32_t ms = (uint32_t)atoi(f[0]), frames = 0, cap = (uint64_t)ms * RATE / 1000u;
        free(g_rec); g_rec = malloc((size_t)(cap ? cap : 1) * sizeof(int16_t)); g_rec_frames = 0;
        ok = g_rec && kode_audio_record_samples(g_rec, cap, ms, &frames);
        g_rec_frames = ok ? frames : 0;
        KLOG_N(TAG, "RES recsamples ok=%d frames=%u addr=%u took=%u err=%s", ok, (unsigned)frames, (unsigned)(uintptr_t)g_rec, (unsigned)(now_ms() - t0), ok ? "" : kode_error());
        break; }
    case C_RECSTART:
        ok = kode_audio_record_start((uint32_t)atoi(f[0]));
        KLOG_N(TAG, "RES recstart ok=%d err=%s", ok, ok ? "" : kode_error());
        break;
    case C_RECSTATUS: {
        kode_audio_record_status_t st = kode_audio_record_status();
        KLOG_N(TAG, "RES recstatus recording=%d ms=%u frames=%u", (int)st.recording, (unsigned)st.ms, (unsigned)st.frames);
        break; }
    case C_RECSTOP:
        ok = kode_audio_record_stop();
        KLOG_N(TAG, "RES recstop ok=%d took=%u err=%s", ok, (unsigned)(now_ms() - t0), ok ? "" : kode_error());
        break;
    case C_RECSAVE:
        ok = kode_audio_record_save(f[0]);
        KLOG_N(TAG, "RES recsave ok=%d err=%s", ok, ok ? "" : kode_error());
        break;
    case C_WAVWRITE: {   /* path;hz;ms : a WAV of a sine, written in 2 KB pieces */
        uint32_t n; int16_t *b = make_sine((uint32_t)atoi(f[1]), (uint32_t)atoi(f[2]), 50, &n);
        uint8_t h[44]; uint32_t bytes = n * 2;
        memcpy(h, "RIFF", 4); put_le(h + 4, 36 + bytes, 4); memcpy(h + 8, "WAVEfmt ", 8); put_le(h + 16, 16, 4); put_le(h + 20, 1, 2);
        put_le(h + 22, 1, 2); put_le(h + 24, RATE, 4); put_le(h + 28, RATE * 2, 4); put_le(h + 32, 2, 2); put_le(h + 34, 16, 2);
        memcpy(h + 36, "data", 4); put_le(h + 40, bytes, 4);
        ok = b && kode_file_write_bytes(f[0], h, 44);
        for (uint32_t off = 0; ok && off < bytes; off += 2048) {
            uint32_t k = bytes - off < 2048 ? bytes - off : 2048;
            ok = kode_file_append_bytes(f[0], (const uint8_t *)b + off, k);
        }
        KLOG_N(TAG, "RES wavwrite ok=%d bytes=%u err=%s", ok, (unsigned)(bytes + 44), ok ? "" : kode_error());
        free(b);
        break; }
    default: break;
    }
}

static void task_main(void *arg)
{
    slot_t *s = (slot_t *)arg;
    for (;;) {
        int cmd = s->cmd;
        if (cmd == C_NONE) { vTaskDelay(2); continue; }
        char text[sizeof s->text];
        memcpy(text, s->text, sizeof text);
        run_cmd(cmd, text);
        s->cmd = C_NONE;
    }
}

static kode_status_t post(int cmd, const kode_value_t *a)
{
    bool aux = cmd == C_ISPLAYING || cmd == C_PLAYSTOP || cmd == C_SET || cmd == C_GET || cmd == C_RECSTATUS || cmd == C_RECSTOP;
    slot_t *s = &g_slot[aux ? 1 : 0];
    if (s->cmd != C_NONE) { KLOG_N(TAG, "RES busy"); return KODE_DENIED; }
    snprintf(s->text, sizeof s->text, "%s", (a && a->s) ? a->s : "");
    s->cmd = cmd;
    return KODE_OK;
}
#define TASKFN(fn, c) static kode_status_t fn(const kode_value_t *a) { return post(c, a); }
TASKFN(f_tone, C_TONE) TASKFN(f_samples, C_SAMPLES) TASKFN(f_play, C_PLAY) TASKFN(f_playstart, C_PLAYSTART)
TASKFN(f_isplaying, C_ISPLAYING) TASKFN(f_playstop, C_PLAYSTOP) TASKFN(f_streamopen, C_SOPEN) TASKFN(f_streamwrite, C_SWRITE)
TASKFN(f_streamclose, C_SCLOSE) TASKFN(f_set, C_SET) TASKFN(f_get, C_GET) TASKFN(f_recfile, C_RECFILE)
TASKFN(f_recsamples, C_RECSAMPLES) TASKFN(f_recstart, C_RECSTART) TASKFN(f_recstatus, C_RECSTATUS) TASKFN(f_recstop, C_RECSTOP)
TASKFN(f_recsave, C_RECSAVE) TASKFN(f_wavwrite, C_WAVWRITE)

/* ---- the AO side ---- */
enum { A_CMD_SIG = MAX_SIG, A_DUMMY_SIG };
typedef struct { QEvt super; int kind; char text[96]; } CmdEvt;
typedef struct { QActive super; } Api;
static QEvtPtr l_queue[KQP_AO_QUEUE_LEN];
static StackType_t l_stack[KQP_AO_STACK_BYTES / sizeof(StackType_t)];
static Api l_ao;
QActive *const AO_Api = &l_ao.super;
static QState Api_initial(Api *const me, void const *const par);
static QState Api_running(Api *const me, QEvt const *const e);
static int16_t *g_aplay, *g_arec; static uint32_t g_arec_cap;

enum { K_TONE = 1, K_VOL, K_MIC, K_MUTE, K_STOP, K_INFO, K_PLAY, K_REC, K_RECFILE, K_OPEN, K_WRITE, K_CLOSE };
static kode_status_t post_ao(int kind, const kode_value_t *a)
{
    CmdEvt *e = Q_NEW_X(CmdEvt, 0U, A_CMD_SIG);
    if (!e) return KODE_NO_RESOURCES;
    e->kind = kind; snprintf(e->text, sizeof e->text, "%s", (a && a->s) ? a->s : "");
    if (!QACTIVE_POST_X(AO_Api, &e->super, 1U, (void *)0)) return KODE_NO_RESOURCES;
    return KODE_OK;
}
#define AOFN(fn, k) static kode_status_t fn(const kode_value_t *a) { return post_ao(k, a); }
AOFN(f_atone, K_TONE) AOFN(f_avol, K_VOL) AOFN(f_amic, K_MIC) AOFN(f_amute, K_MUTE) AOFN(f_astop, K_STOP) AOFN(f_ainfo, K_INFO)
AOFN(f_aplay, K_PLAY) AOFN(f_arec, K_REC) AOFN(f_arecfile, K_RECFILE) AOFN(f_aopen, K_OPEN) AOFN(f_awrite, K_WRITE) AOFN(f_aclose, K_CLOSE)

#define STR(nm, fn, d) { .name = nm, .arg = KODE_TYPE_STRING, .run = fn, .desc = d }
#define NOARG(nm, fn, d) { .name = nm, .run = fn, .desc = d }
static const kode_function_t FUNCTIONS[] = {
    STR("tone", f_tone, "kode_audio_tone(hz;ms)"), STR("samples", f_samples, "kode_audio_play_samples(hz;ms;amp)"),
    STR("play", f_play, "kode_audio_play(path)"), STR("playstart", f_playstart, "kode_audio_play_start(path)"),
    NOARG("isplaying", f_isplaying, "kode_audio_is_playing()"), NOARG("playstop", f_playstop, "kode_audio_play_stop()"),
    STR("streamopen", f_streamopen, "kode_audio_stream_open(ch)"), STR("streamwrite", f_streamwrite, "kode_audio_stream_write(hz;ms;chunk;wait;ch)"),
    NOARG("streamclose", f_streamclose, "kode_audio_stream_close()"), STR("set", f_set, "kode_audio_set(name;value)"),
    STR("get", f_get, "kode_audio_get(name)"), STR("recfile", f_recfile, "kode_audio_record_file(path;ms)"),
    STR("recsamples", f_recsamples, "kode_audio_record_samples(ms)"), STR("recstart", f_recstart, "kode_audio_record_start(ms)"),
    NOARG("recstatus", f_recstatus, "kode_audio_record_status()"), NOARG("recstop", f_recstop, "kode_audio_record_stop()"),
    STR("recsave", f_recsave, "kode_audio_record_save(path)"), STR("wavwrite", f_wavwrite, "write a WAV file (path;hz;ms)"),
    STR("atone", f_atone, "kode_sys_audio_tone(hz;ms;amp)"), STR("avol", f_avol, "kode_sys_audio_volume(pct)"),
    STR("amic", f_amic, "kode_sys_audio_mic_gain(db)"), STR("amute", f_amute, "kode_sys_audio_mute(on)"),
    NOARG("astop", f_astop, "kode_sys_audio_record_stop()"), NOARG("ainfo", f_ainfo, "kode_sys_audio_info_read(me)"),
    STR("aplay", f_aplay, "kode_sys_audio_play(me, hz;ms)"), STR("arec", f_arec, "kode_sys_audio_record(me, ms)"),
    STR("arecfile", f_arecfile, "kode_sys_audio_record_file(me, path;ms)"), NOARG("aopen", f_aopen, "kode_sys_audio_stream_open(me)"),
    STR("awrite", f_awrite, "kode_sys_audio_stream_write(me, hz;ms)"), NOARG("aclose", f_aclose, "kode_sys_audio_stream_close(me)"),
};

static QState Api_initial(Api *const me, void const *const par) { (void)par; (void)me; return Q_TRAN(&Api_running); }

static QState Api_running(Api *const me, QEvt const *const e)
{
    QState status = Q_SUPER(&QHsm_top);
    switch (e->sig) {
    case A_CMD_SIG: {
        CmdEvt const *c = (CmdEvt const *)e;
        char t[96]; char *f[4] = { "", "", "", "" };
        snprintf(t, sizeof t, "%s", c->text); split(t, f, 4);
        kode_status_t rc = KODE_ERROR;
        switch (c->kind) {
        case K_TONE: rc = kode_sys_audio_tone((uint16_t)atoi(f[0]), (uint16_t)atoi(f[1]), (uint8_t)atoi(f[2])); break;
        case K_VOL: rc = kode_sys_audio_volume((uint8_t)atoi(f[0])); break;
        case K_MIC: rc = kode_sys_audio_mic_gain((uint8_t)atoi(f[0])); break;
        case K_MUTE: rc = kode_sys_audio_mute(atoi(f[0]) != 0); break;
        case K_STOP: kode_sys_audio_record_stop(); rc = KODE_OK; break;
        case K_INFO: rc = kode_sys_audio_info_read(&me->super); break;
        case K_PLAY: { uint32_t n; free(g_aplay); g_aplay = make_sine((uint32_t)atoi(f[0]), (uint32_t)atoi(f[1]), 50, &n);
                       rc = g_aplay ? kode_sys_audio_play(&me->super, g_aplay, n) : KODE_NO_RESOURCES; break; }
        case K_REC: { uint32_t ms = (uint32_t)atoi(f[0]); free(g_arec); g_arec_cap = (uint64_t)ms * RATE / 1000u;
                      g_arec = calloc(g_arec_cap ? g_arec_cap : 1, sizeof(int16_t));
                      rc = g_arec ? kode_sys_audio_record(&me->super, g_arec, g_arec_cap, ms) : KODE_NO_RESOURCES; break; }
        case K_RECFILE: rc = kode_sys_audio_record_file(&me->super, f[0], (uint32_t)atoi(f[1])); break;
        case K_OPEN: g_phase = 0; rc = kode_sys_audio_stream_open(&me->super); break;
        case K_WRITE: {   /* hz;ms : one write of everything (the ring holds 200 ms: the rest is reported as taken) */
            uint32_t n; int16_t *b = make_sine((uint32_t)atoi(f[0]), (uint32_t)atoi(f[1]), 50, &n); size_t taken = 0;
            rc = b ? kode_sys_audio_stream_write(&me->super, b, n, 1, &taken) : KODE_NO_RESOURCES;
            KLOG_N(TAG, "RES awrite rc=%d asked=%u taken=%u", (int)rc, (unsigned)n, (unsigned)taken);
            free(b);
            break; }
        case K_CLOSE: rc = kode_sys_audio_stream_close(&me->super); break;
        default: break;
        }
        KLOG_N(TAG, "RES ask kind=%d taken=%d", c->kind, (int)rc);
        status = Q_HANDLED();
        break; }
    case AUDIO_INFO_RSP_SIG: {
        kode_sys_audio_info_answer_t const *a = (kode_sys_audio_info_answer_t const *)e;
        KLOG_N(TAG, "RES ainfo rc=%u rate=%u present=%d open=%d busy=%d bits=%u volume=%u mic_db=%u mute=%d", (unsigned)a->rc,
               (unsigned)a->info.rate, (int)a->info.present, (int)a->info.open, (int)a->info.busy, (unsigned)a->info.bits,
               (unsigned)a->info.volume, (unsigned)a->info.mic_db, (int)a->info.mute);
        status = Q_HANDLED(); break; }
    case AUDIO_DONE_SIG: case AUDIO_REC_RSP_SIG: case AUDIO_STREAM_OPEN_RSP_SIG: case AUDIO_STREAM_CLOSE_RSP_SIG: {
        kode_sys_audio_answer_t const *a = (kode_sys_audio_answer_t const *)e;
        const char *nm = e->sig == AUDIO_DONE_SIG ? "done" : e->sig == AUDIO_REC_RSP_SIG ? "rec" : e->sig == AUDIO_STREAM_OPEN_RSP_SIG ? "open" : "close";
        KLOG_N(TAG, "RES a%s rc=%u frames=%u", nm, (unsigned)a->rc, (unsigned)a->frames);
        if (e->sig == AUDIO_REC_RSP_SIG) { int64_t s = 0; uint32_t pk = 0; for (uint32_t i = 0; i < a->frames && i < g_arec_cap; i++) { int v = g_arec[i]; s += (int64_t)v * v; if ((uint32_t)abs(v) > pk) pk = (uint32_t)abs(v); }
            KLOG_N(TAG, "RES arecdata addr=%u frames=%u peak=%u", (unsigned)(uintptr_t)g_arec, (unsigned)a->frames, (unsigned)pk); (void)s; }
        status = Q_HANDLED(); break; }
    case AUDIO_FILE_RSP_SIG: {
        kode_sys_audio_file_answer_t const *a = (kode_sys_audio_file_answer_t const *)e;
        KLOG_N(TAG, "RES afile rc=%u bytes=%u ms=%u path=%s", (unsigned)a->rc, (unsigned)a->bytes, (unsigned)a->ms, a->path);
        status = Q_HANDLED(); break; }
    default: break;
    }
    return status;
}

void app_main(void)
{
    kode_init();
    QActive_ctor(&l_ao.super, Q_STATE_CAST(&Api_initial));
    QActive_setAttr(AO_Api, TASK_NAME_ATTR, "audio_api");
    QACTIVE_START(AO_Api, KODE_PRIO_USER_LOW, l_queue, Q_DIM(l_queue), l_stack, sizeof(l_stack), (void *)0);
    (void)KODE_FUNCTIONS_ADD(FUNCTIONS);
    xTaskCreate(&task_main, "audio_api_t", 6144, &g_slot[0], 5, NULL);
    xTaskCreate(&task_main, "audio_api_a", 4096, &g_slot[1], 5, NULL);
    KLOG_N(TAG, "audio_api up");
}
