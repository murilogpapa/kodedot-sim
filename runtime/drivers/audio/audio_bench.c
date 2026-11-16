/* SPDX-License-Identifier: GPL-3.0-or-later
 * Exports of the audio area (area.json "exports") and the wire capture the Node tests assert on.
 * Every export is safe from the page's thread: an atomic store, a pointer read, or one short mutex section. */
#include <emscripten.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include "audio_internal.h"

#define X EMSCRIPTEN_KEEPALIVE

/* ---- capture of what the I2S transmitter clocked out: stereo int16, gaps as zeros, from audio_cap_start() on ---- */
static pthread_mutex_t g_cmu = PTHREAD_MUTEX_INITIALIZER;
static int16_t *g_cap; static uint32_t g_cap_cap, g_cap_n, g_cap_over; static bool g_cap_on;

void kaud_cap_append(const int16_t *st, uint32_t n)
{
    if (!g_cap_on) return;
    pthread_mutex_lock(&g_cmu);
    if (g_cap_on) {
        uint32_t room = g_cap_cap - g_cap_n, k = n < room ? n : room;
        memcpy(g_cap + 2ull * g_cap_n, st, (size_t)k * 4u);
        g_cap_n += k;
        if (k < n) g_cap_over += n - k;
    }
    pthread_mutex_unlock(&g_cmu);
}
void kaud_cap_silence(uint64_t n)
{
    if (!g_cap_on) return;
    pthread_mutex_lock(&g_cmu);
    if (g_cap_on) {
        uint64_t room = g_cap_cap - g_cap_n, k = n < room ? n : room;
        memset(g_cap + 2ull * g_cap_n, 0, (size_t)k * 4u);
        g_cap_n += (uint32_t)k;
        if (k < n) g_cap_over += (uint32_t)(n - k);
    }
    pthread_mutex_unlock(&g_cmu);
}
/* Start capturing at most max_frames (capacity is allocated here); returns 1 on success. Restarting discards the old capture. */
X int audio_cap_start(uint32_t max_frames)
{
    pthread_mutex_lock(&g_cmu);
    g_cap_on = false;
    free(g_cap);
    g_cap = max_frames ? (int16_t *)calloc(max_frames, 4u) : NULL;
    g_cap_cap = g_cap ? max_frames : 0; g_cap_n = 0; g_cap_over = 0;
    g_cap_on = g_cap != NULL;
    pthread_mutex_unlock(&g_cmu);
    return g_cap_on;
}
X void audio_cap_stop(void) { pthread_mutex_lock(&g_cmu); g_cap_on = false; pthread_mutex_unlock(&g_cmu); }
X uint32_t audio_cap_frames(void) { return g_cap_n; }
X uint32_t audio_cap_overflow(void) { return g_cap_over; }
/* Address of the captured stereo frames (valid until the next audio_cap_start). */
X const int16_t *audio_cap_ptr(void) { return g_cap; }

/* ---- shared block ---- */
X kaud_shared_t *audio_shared_ptr(void) { return &g_kaud; }
/* Layout probe for the JS mirror: 0 sizeof, 1 offsetof(out), 2 offsetof(in), 3 rate, 4 out frames, 5 in frames. */
X uint32_t audio_layout(uint32_t what)
{
    switch (what) {
    case 0: return sizeof(kaud_shared_t);
    case 1: return KAUD_OFF_OUT;
    case 2: return KAUD_OFF_IN;
    case 3: return KAUD_RATE_HZ;
    case 4: return KAUD_OUT_FRAMES;
    case 5: return KAUD_IN_FRAMES;
    default: return 0;
    }
}

/* ---- output controls (the page's own volume/mute, the lateness tolerance, pacing) ---- */
X void audio_bench_set(uint32_t gain_q16, uint32_t mute) { KAUD_ST(&g_kaud.bench_gain_q16, gain_q16); KAUD_ST(&g_kaud.bench_mute, mute ? 1u : 0u); }
X void audio_set_tolerance_ms(uint32_t ms) { KAUD_ST(&g_kaud.tolerance_frames, ms * (KAUD_RATE_HZ / 1000u)); }
X void audio_set_pacing(uint32_t on) { KAUD_ST(&g_kaud.pace, on ? 1u : 0u); }
X void audio_stats_reset(void)
{
    KAUD_ST(&g_kaud.out_underruns, 0); KAUD_ST(&g_kaud.out_gap_frames, 0); KAUD_ST(&g_kaud.out_lates, 0);
    KAUD_ST(&g_kaud.out_overruns, 0); KAUD_ST(&g_kaud.in_underruns, 0); KAUD_ST(&g_kaud.in_dropped, 0); KAUD_ST(&g_kaud.in_clip, 0);
}

/* ---- input source ---- */
X void audio_in_source(uint32_t kind) { KAUD_ST(&g_kaud.in_source, kind <= KAUD_SRC_MIC ? kind : 0u); }
X void audio_in_synth(uint32_t kind, uint32_t hz, uint32_t level_q15)
{
    KAUD_ST(&g_kaud.in_synth_kind, kind ? KAUD_SYNTH_NOISE : KAUD_SYNTH_TONE);
    KAUD_ST(&g_kaud.in_synth_hz, hz < 1 ? 1u : (hz > 23999 ? 23999u : hz));
    KAUD_ST(&g_kaud.in_synth_level, level_q15 > 32767 ? 32767u : level_q15);
}
X void audio_in_rewind(void) { KAUD_ST(&g_kaud.in_rewind, 1u); }
X void audio_in_rewind_auto(uint32_t on) { KAUD_ST(&g_kaud.in_rewind_auto, on ? 1u : 0u); }
