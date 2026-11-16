/* SPDX-License-Identifier: GPL-3.0-or-later
 * Internal to runtime/drivers/audio: what the codec/I2S model, the input sources and the bench exports share. */
#ifndef AUDIO_INTERNAL_H
#define AUDIO_INTERNAL_H
#include <stdbool.h>
#include <stdint.h>
#include <time.h>
#include "audio_shared.h"

static inline uint64_t kaud_now_ns(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
}
static inline uint32_t kaud_now_ms(void) { return (uint32_t)(kaud_now_ns() / 1000000ull); }
#define KAUD_LD(p)     __atomic_load_n((p), __ATOMIC_ACQUIRE)
#define KAUD_ST(p, v)  __atomic_store_n((p), (v), __ATOMIC_RELEASE)
#define KAUD_ADD(p, v) ((void)__atomic_fetch_add((p), (v), __ATOMIC_RELAXED))

/* audio_input.c: the microphone side. A capture session starts at the first read after the channels were enabled or
 * after >150 ms without a read; the source restarts (tone phase 0, noise seed, file position 0 unless disabled, mic
 * ring primed). kaud_in_fill() produces n mono frames of the source at the nominal gain, then applies the codec's
 * microphone gain (registers 0x16/0x17, passed in as Q16) and mute. */
void kaud_in_session_start(void);
void kaud_in_fill(int16_t *mono, uint32_t n, uint32_t rx_gain_q16);

/* audio_bench.c: capture of the wire (what the I2S TX would have clocked out, gaps as zeros) for tests. */
void kaud_cap_append(const int16_t *stereo, uint32_t frames);
void kaud_cap_silence(uint64_t frames);
#endif
