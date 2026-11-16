/* SPDX-License-Identifier: GPL-3.0-or-later
 * The microphone side of the bench: what the ES8311's ADC would hand the I2S receiver, from one of four sources
 * chosen by the page: silence (default), a synthetic tone or noise, a file the developer supplied (decoded on the host,
 * stored as int16 mono 48 kHz in a buffer C owns) or the host's microphone (frames pushed by the page's capture
 * worklet into the input ring of audio_shared.h). The source is sampled by position, so what a recording contains
 * depends only on how many frames were read, never on timing; the pacing is audio_codec_web.c's.
 *
 * Level convention: a source's level is the level the firmware sees at the nominal microphone gain (24 dB, the SDK's
 * default); the codec's gain registers move it from there in 6 dB steps (0..42 dB) and the ADC mute silences it. */
#include <emscripten.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include "audio_internal.h"

#define PRIME_FRAMES   1200u     /* mic: start this far (25 ms) behind the newest frame: a cushion against jitter */
#define MIC_MAX_FRAMES 9600u     /* mic: more than 200 ms queued: skip ahead to ... */
#define MIC_KEEP_FRAMES 2400u    /* ... 50 ms */

typedef struct { int16_t *data; uint32_t frames; } file_t;
static file_t *volatile g_file;       /* the committed file, or NULL */
static file_t *g_file_pending;        /* between begin and commit */
static file_t *g_file_retired;        /* freed at the NEXT commit/clear: a reader may still hold it for one block */

static uint64_t g_pos;                /* frames since the session started */
static uint64_t g_fpos;               /* file position, frames */
static uint32_t g_noise;

void kaud_in_session_start(void)
{
    KAUD_ADD(&g_kaud.in_sessions, 1);
    g_pos = 0;
    g_noise = 0x9E3779B9u;
    if (KAUD_LD(&g_kaud.in_rewind_auto) || KAUD_LD(&g_kaud.in_rewind)) g_fpos = 0;
    KAUD_ST(&g_kaud.in_rewind, 0);
    uint32_t wr = KAUD_LD(&g_kaud.in_wr);
    KAUD_ST(&g_kaud.in_rd, wr > PRIME_FRAMES ? wr - PRIME_FRAMES : 0u);
}

static inline int16_t clip16(int64_t v, bool *clipped)
{
    if (v > 32767) { *clipped = true; return 32767; }
    if (v < -32768) { *clipped = true; return -32768; }
    return (int16_t)v;
}

void kaud_in_fill(int16_t *m, uint32_t n, uint32_t gq16)
{
    uint32_t src = KAUD_LD(&g_kaud.in_source);
    uint32_t clip = 0;
    if (src == KAUD_SRC_SYNTH) {
        uint32_t hz = KAUD_LD(&g_kaud.in_synth_hz), amp = KAUD_LD(&g_kaud.in_synth_level);
        if (KAUD_LD(&g_kaud.in_synth_kind) == KAUD_SYNTH_NOISE) {
            for (uint32_t i = 0; i < n; i++) {
                g_noise ^= g_noise << 13; g_noise ^= g_noise >> 17; g_noise ^= g_noise << 5;
                m[i] = (int16_t)((int64_t)((int32_t)g_noise >> 16) * (int64_t)amp / 32768);
            }
        } else {
            for (uint32_t i = 0; i < n; i++) {
                uint64_t ph = ((g_pos + i) * (uint64_t)hz) % KAUD_RATE_HZ;
                m[i] = (int16_t)lrint((double)amp * sin(6.283185307179586 * (double)ph / (double)KAUD_RATE_HZ));
            }
        }
    } else if (src == KAUD_SRC_FILE) {
        file_t *f = g_file;
        uint32_t loop = KAUD_LD(&g_kaud.in_file_loop);
        for (uint32_t i = 0; i < n; i++) {
            if (f && f->frames) {
                if (g_fpos >= f->frames && loop) g_fpos %= f->frames;
                m[i] = g_fpos < f->frames ? f->data[g_fpos] : 0;
                g_fpos++;
            } else m[i] = 0;
        }
    } else if (src == KAUD_SRC_MIC) {
        uint32_t wr = KAUD_LD(&g_kaud.in_wr), rd = KAUD_LD(&g_kaud.in_rd);
        uint32_t avail = wr - rd;
        if (avail > KAUD_IN_FRAMES || avail > MIC_MAX_FRAMES) {      /* lapped, or too much latency */
            uint32_t keep = MIC_KEEP_FRAMES;
            KAUD_ADD(&g_kaud.in_dropped, avail - keep);
            rd = wr - keep; avail = keep;
        }
        uint32_t take = avail < n ? avail : n;
        for (uint32_t i = 0; i < take; i++) m[i] = g_kaud.in[(rd + i) & (KAUD_IN_FRAMES - 1u)];
        for (uint32_t i = take; i < n; i++) m[i] = 0;
        if (take < n) KAUD_ADD(&g_kaud.in_underruns, 1);
        KAUD_ST(&g_kaud.in_rd, rd + take);
    } else {
        memset(m, 0, n * sizeof(int16_t));
    }
    g_pos += n;

    uint32_t peak = 0; double sum = 0;
    if (src != KAUD_SRC_SILENCE) {
        bool clipped;
        for (uint32_t i = 0; i < n; i++) {
            clipped = false;
            int64_t v = ((int64_t)m[i] * (int64_t)gq16) >> 16;
            m[i] = clip16(v, &clipped);
            if (clipped) clip++;
            uint32_t a = (uint32_t)(m[i] < 0 ? -(int32_t)m[i] : m[i]);
            if (a > peak) peak = a;
            sum += (double)a * a;
        }
    }
    KAUD_ST(&g_kaud.in_level_peak, peak > 32768 ? 32768 : peak);
    KAUD_ST(&g_kaud.in_level_rms, n ? (uint32_t)sqrt(sum / n) : 0u);
    if (clip) KAUD_ADD(&g_kaud.in_clip, clip);
    KAUD_ADD(&g_kaud.in_frames, n);
    KAUD_ST(&g_kaud.in_pos, (uint32_t)g_pos);
}

/* ---- page side (called from the page's thread: never blocks, one short allocation at most) ---- */
static void retire(file_t *f)
{
    if (g_file_retired) { free(g_file_retired->data); free(g_file_retired); }
    g_file_retired = f;
}
/* Allocate room for a file of `frames` mono int16 frames; the page fills it through the heap view, then commits. */
EMSCRIPTEN_KEEPALIVE int16_t *audio_in_file_begin(uint32_t frames)
{
    if (g_file_pending) { free(g_file_pending->data); free(g_file_pending); g_file_pending = NULL; }
    file_t *f = calloc(1, sizeof *f);
    if (!f) return NULL;
    f->data = calloc(frames ? frames : 1, sizeof(int16_t));
    if (!f->data) { free(f); return NULL; }
    f->frames = frames;
    g_file_pending = f;
    return f->data;
}
EMSCRIPTEN_KEEPALIVE void audio_in_file_commit(uint32_t loop)
{
    file_t *f = g_file_pending, *old = g_file;
    if (!f) return;
    g_file_pending = NULL;
    KAUD_ST(&g_kaud.in_file_loop, loop ? 1u : 0u);
    KAUD_ST(&g_kaud.in_file_frames, f->frames);
    KAUD_ST(&g_kaud.in_file_ptr, (uint32_t)(uintptr_t)f->data);
    KAUD_ST(&g_kaud.in_rewind, 1u);
    __atomic_store_n(&g_file, f, __ATOMIC_RELEASE);
    retire(old);
}
EMSCRIPTEN_KEEPALIVE void audio_in_file_clear(void)
{
    file_t *old = g_file;
    __atomic_store_n(&g_file, (file_t *)NULL, __ATOMIC_RELEASE);
    KAUD_ST(&g_kaud.in_file_frames, 0);
    KAUD_ST(&g_kaud.in_file_ptr, 0);
    if (old) retire(old);
}
