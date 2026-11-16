/* SPDX-License-Identifier: GPL-3.0-or-later
 * The audio area's shared-memory block: everything the page (glue, AudioWorklet) and the firmware exchange about
 * sound lives in ONE struct, kaud_shared_t, in the module's shared linear memory. The page asks for its address once
 * with the exported audio_shared_ptr(). All fields are 32-bit, little-endian, 4-byte aligned; offsets are pinned by
 * _Static_assert below and mirrored by LAYOUT in audio.js (checked by tests/node/audio/layout.test.mjs).
 *
 * Output ring (firmware -> host): interleaved stereo int16 (the two I2S slots of the codec's one format, a mono sound
 * is duplicated into both), 48000 Hz. Lock-free single-producer/single-consumer. out_wr is the TOTAL number of frames
 * ever written (wraps at 2^32), written by the firmware thread with a release store AFTER the samples; out_rd is the
 * total ever consumed, written only by the consumer. Slot of frame k = k & (out_frames-1). The producer never waits
 * for and never looks at the consumer except to count an advisory overrun: a consumer that finds
 * out_wr - out_rd > out_frames has been lapped; it must skip forward (out_rd = out_wr - target), count the loss in
 * out_dropped, and treat a chunk whose lag grew past out_frames while it was reading as torn (discard it).
 * Only DATA is queued: stretches where the firmware wrote nothing (idle, an I2S underrun) are not padded with zeros;
 * the consumer is empty then and plays silence of its own, in real time, which is exactly the wire's silence.
 *
 * Input ring (host -> firmware, only for the host-microphone source): mono int16, out of the page's capture
 * worklet; in_wr is the producer's (page), in_rd the firmware's. Same total-count convention. */
#ifndef AUDIO_SHARED_H
#define AUDIO_SHARED_H
#include <stdint.h>

#define KAUD_MAGIC       0x4455414Bu     /* bytes "KAUD" */
#define KAUD_VERSION     1u
#define KAUD_RATE_HZ     48000u
#define KAUD_OUT_FRAMES  32768u          /* power of two: 0.68 s of stereo */
#define KAUD_IN_FRAMES   16384u          /* power of two: 0.34 s of mono */
#define KAUD_NOMINAL_MIC_DB 24u          /* mic gain at which a bench source's level is the level the firmware sees */

enum { KAUD_SRC_SILENCE = 0, KAUD_SRC_SYNTH = 1, KAUD_SRC_FILE = 2, KAUD_SRC_MIC = 3 };
enum { KAUD_SYNTH_TONE = 0, KAUD_SYNTH_NOISE = 1 };
/* flags (offset 0x0C), set/cleared by the firmware side */
enum { KAUD_F_TX_RUN = 1u << 0, KAUD_F_RX_RUN = 1u << 1, KAUD_F_OPEN = 1u << 2, KAUD_F_PRESENT = 1u << 3, KAUD_F_MIC_DENIED = 1u << 4 };
/* KAUD_F_MIC_DENIED: set by the page while the source is KAUD_SRC_MIC and the browser refused the microphone: the receiver then
 * fails every read (ESP_CODEC_DEV_READ_FAIL -> KODE_IO_ERROR in the SDK's recording job), as bench-spec scenario 7 asks. */
/* sink_state (offset 0x70), written by the glue/worklet: 0 no sink, 1 running, 2 starved, 3 blocked (needs a gesture) */
enum { KAUD_SINK_NONE = 0, KAUD_SINK_RUNNING = 1, KAUD_SINK_STARVED = 2, KAUD_SINK_BLOCKED = 3 };

typedef struct {
    /* 0x000 identity */
    uint32_t magic;            /* 0x00 */
    uint32_t version;          /* 0x04 */
    uint32_t size;             /* 0x08 sizeof(kaud_shared_t) */
    uint32_t flags;            /* 0x0C KAUD_F_* */
    /* 0x010 output ring */
    uint32_t out_off;          /* 0x10 byte offset of out[] from the struct base */
    uint32_t out_frames;       /* 0x14 capacity, frames */
    uint32_t out_rate;         /* 0x18 48000 */
    uint32_t out_channels;     /* 0x1C 2 */
    uint32_t out_wr;           /* 0x20 producer: frames ever written */
    uint32_t out_rd;           /* 0x24 consumer: frames ever consumed */
    uint32_t out_dropped;      /* 0x28 consumer: frames skipped because it was lapped */
    uint32_t out_overruns;     /* 0x2C producer: writes that found the ring more than full (advisory) */
    /* 0x030 firmware-side output state */
    uint32_t out_active_ms;    /* 0x30 mod-2^32 ms clock of the last block that was not digital silence */
    uint32_t out_blocks;       /* 0x34 write calls (one per I2S block) */
    uint32_t out_frames_total; /* 0x38 frames written (mod 2^32), data only */
    uint32_t out_underruns;    /* 0x3C writes that found the wire starved by more than the tolerance while audio was in flight (a gap after a drained sound is idle, not an underrun) */
    uint32_t out_gap_frames;   /* 0x40 frames of wire silence between writes: underruns and idle gaps alike */
    uint32_t out_lates;        /* 0x44 writes later than the DMA depth (30 ms) but inside the tolerance */
    uint32_t out_gain_q16;     /* 0x48 gain the codec applies now (65536 = unity, 0 when muted or powered down) */
    uint32_t out_codec_mute;   /* 0x4C 1 when the DAC is muted by register 0x31 */
    uint32_t level_peak;       /* 0x50 peak of the last block after the codec's gain, Q15 (0..32768) */
    uint32_t level_rms;        /* 0x54 RMS of the last block, Q15 */
    uint32_t level_seq;        /* 0x58 +1 per block */
    uint32_t level_ms;         /* 0x5C ms clock of that block */
    /* 0x060 page-owned output controls (read by the worklet; the page's own volume and mute) */
    uint32_t bench_gain_q16;   /* 0x60 default 65536 */
    uint32_t bench_mute;       /* 0x64 */
    uint32_t tolerance_frames; /* 0x68 how far behind the wire a write may be before it counts as an underrun */
    uint32_t pace;             /* 0x6C 1 (default) = throttle at the sample rate, 0 = free-running (tests only) */
    /* 0x070 consumer reporting (written by glue / worklet) */
    uint32_t sink_state;       /* 0x70 KAUD_SINK_* */
    uint32_t sink_peak;        /* 0x74 Q15 peak of what was actually played (after the bench's gain) */
    uint32_t sink_rms;         /* 0x78 */
    uint32_t sink_underruns;   /* 0x7C times the sink ran dry while playing */
    /* 0x080 input */
    uint32_t in_source;        /* 0x80 KAUD_SRC_* */
    uint32_t in_synth_kind;    /* 0x84 KAUD_SYNTH_* */
    uint32_t in_synth_hz;      /* 0x88 */
    uint32_t in_synth_level;   /* 0x8C Q15 amplitude (peak) at the nominal mic gain */
    uint32_t in_file_frames;   /* 0x90 */
    uint32_t in_file_loop;     /* 0x94 */
    uint32_t in_file_ptr;      /* 0x98 address of the file's int16 mono 48 kHz samples in wasm memory */
    uint32_t in_rewind;        /* 0x9C 1 = restart the source at the next capture session (consumed by the firmware) */
    uint32_t in_rewind_auto;   /* 0xA0 default 1: every capture session restarts the source */
    uint32_t in_off;           /* 0xA4 byte offset of in[] */
    uint32_t in_frames_cap;    /* 0xA8 KAUD_IN_FRAMES */
    uint32_t in_wr;            /* 0xAC producer (page) */
    uint32_t in_rd;            /* 0xB0 consumer (firmware) */
    uint32_t in_underruns;     /* 0xB4 firmware read found the mic ring short (zero padded) */
    uint32_t in_dropped;       /* 0xB8 mic frames discarded to keep latency low */
    uint32_t in_frames;        /* 0xBC frames delivered to the firmware (mod 2^32) */
    uint32_t in_gain_db_x10;   /* 0xC0 mic gain relative to nominal, dB*10, as int32 (codec registers 0x16, 0x17) */
    uint32_t in_muted;         /* 0xC4 1 when the ADC volume register is 0 */
    uint32_t in_sessions;      /* 0xC8 capture sessions started */
    uint32_t in_level_peak;    /* 0xCC Q15 of the last block delivered */
    uint32_t in_level_rms;     /* 0xD0 */
    uint32_t in_clip;          /* 0xD4 samples clipped by the gain */
    uint32_t in_pos;           /* 0xD8 position of the source in the current session, frames */
    uint32_t in_active_ms;     /* 0xDC ms clock of the last read */
    uint32_t reserved[8];      /* 0xE0..0xFF */
    /* 0x100 data */
    int16_t  out[KAUD_OUT_FRAMES * 2u];
    int16_t  in[KAUD_IN_FRAMES];
} kaud_shared_t;

#define KAUD_OFF_OUT  0x100u
#define KAUD_OFF_IN   (0x100u + KAUD_OUT_FRAMES * 4u)
_Static_assert(__builtin_offsetof(kaud_shared_t, out_off) == 0x10, "out_off");
_Static_assert(__builtin_offsetof(kaud_shared_t, out_wr) == 0x20, "out_wr");
_Static_assert(__builtin_offsetof(kaud_shared_t, out_active_ms) == 0x30, "out_active_ms");
_Static_assert(__builtin_offsetof(kaud_shared_t, level_peak) == 0x50, "level_peak");
_Static_assert(__builtin_offsetof(kaud_shared_t, bench_gain_q16) == 0x60, "bench_gain_q16");
_Static_assert(__builtin_offsetof(kaud_shared_t, sink_state) == 0x70, "sink_state");
_Static_assert(__builtin_offsetof(kaud_shared_t, in_source) == 0x80, "in_source");
_Static_assert(__builtin_offsetof(kaud_shared_t, in_wr) == 0xAC, "in_wr");
_Static_assert(__builtin_offsetof(kaud_shared_t, in_pos) == 0xD8, "in_pos");
_Static_assert(__builtin_offsetof(kaud_shared_t, out) == KAUD_OFF_OUT, "out[]");
_Static_assert(__builtin_offsetof(kaud_shared_t, in) == KAUD_OFF_IN, "in[]");

extern kaud_shared_t g_kaud;
#endif
