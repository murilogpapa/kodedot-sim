/* SPDX-License-Identifier: GPL-3.0-or-later
 * The ES8311 codec, the I2S controller and the esp_codec_dev layer of the web bench.
 *
 * The SDK's real kdrv_es8311.c (the jobs, the 37 ms drain, the settle blocks, the mute ramp wait, the stream ring) runs
 * unmodified above this file. What is faked is what it calls: ESP-IDF's I2S driver (driver/i2s_std.h), the codec
 * component (esp_codec_dev.h, es8311_codec.h, esp_codec_dev_defaults.h, headers in include/) and the chip behind its
 * control interface:
 *
 *  - ES8311 register file (256 bytes) with the identity, reachable both through the codec component's control interface
 *    and through a virtual I2C chip at 0x18 (khal_i2c: kdrv_es8311_park(), kdrv_es8311_reg_read/write, the console
 *    `audio` verbs). What is audible derives from the registers: DAC volume 0x32 (reg/2 - 95.5 dB; 0 = silent), mute
 *    0x31 bits 6:5, DAC power 0x12 bit 1; ADC scale 0x16 (6 dB a step), ADC volume 0x17 (0 = muted).
 *  - Software I2S controller, duplex, one 48 kHz clock that starts when the channels are enabled (esp_codec_dev_open).
 *    TX: esp_codec_dev_write() blocks while the DMA ring (6 x 240 frames, 1440, like kdrv_es8311.c configures it) is
 *    full, i.e. it is throttled at the real sample rate. The samples go through the DAC's gain (ramped over 12 ms, the
 *    chip's volume ramp) into the shared output ring (audio_shared.h) and the test capture.
 *    RX: esp_codec_dev_read() blocks until the frames "have arrived" (stream position / 48000 s after the session
 *    start), so a recording of N frames lasts N/48000 s with no drift; a late reader catches up (no frames lost).
 *  - The amplifier enable (the C5's IO4 on the board) is treated as present and high; with CONFIG_KODEOS_RADIO=n (the
 *    web default) AO_Audio never asks AO_Radio for it.
 */
#include <math.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "es8311_codec.h"
#include "esp_codec_dev.h"
#include "esp_codec_dev_defaults.h"
#include "driver/i2s_std.h"
#include "dotbench_board.h"
#include "kdrv_es8311.h"
#include "kbsp.h"
#include "audio_internal.h"

kaud_shared_t g_kaud;

#define DMA_FRAMES   1440u      /* 6 descriptors x 240 frames, as i2s_up() asks */
#define BLOCK_MAX    1024u      /* frames processed per chunk (static buffers: the worker's stack is 8 KB) */
#define RAMP_FRAMES  576u       /* the DAC's volume/mute ramp: 12 ms (kdrv's ES_MUTE_SETTLE_MS) */
#define IDLE_GAP_NS  (150ll * 1000000ll)    /* RX idle longer than this ends a capture session */

/* ---------------------------------------------------------------- ES8311 register file */
static pthread_mutex_t g_regmu = PTHREAD_MUTEX_INITIALIZER;
static uint8_t g_regs[256];

static void regs_rest_locked(void)
{
    /* What kdrv_es8311_park() leaves: everything down. */
    memset(g_regs, 0, sizeof g_regs);
    g_regs[0x00] = 0x1F; g_regs[0x0D] = 0xFC; g_regs[0x0E] = 0xFF; g_regs[0x12] = 0x02;
    g_regs[0x14] = 0x00; g_regs[0x16] = 0x00; g_regs[0x44] = 0x08;
    g_regs[0xFD] = KDRV_ES8311_ID1; g_regs[0xFE] = KDRV_ES8311_ID2; g_regs[0xFF] = 0x00;
}

static uint32_t db_to_q16(double db)
{
    double g = pow(10.0, db / 20.0) * 65536.0;
    if (g > 4294967000.0) g = 4294967000.0;
    return (uint32_t)g;
}

/* Recompute what is audible from the registers. g_regmu held. */
static void es_update_locked(void)
{
    uint8_t r31 = g_regs[0x31], r32 = g_regs[0x32], r12 = g_regs[0x12];
    bool dac_down = (r12 & 0x02) != 0, mute = (r31 & 0x60) == 0x60;
    uint32_t gain = (dac_down || mute || r32 == 0) ? 0 : db_to_q16(r32 * 0.5 - 95.5);
    KAUD_ST(&g_kaud.out_gain_q16, gain);
    KAUD_ST(&g_kaud.out_codec_mute, mute ? 1u : 0u);

    uint8_t r16 = g_regs[0x16] & 7, r17 = g_regs[0x17];
    double rel = r16 * 6.0 + (r17 * 0.5 - 95.5) - (double)KAUD_NOMINAL_MIC_DB;
    KAUD_ST(&g_kaud.in_gain_db_x10, (uint32_t)(int32_t)(rel * 10.0));
    KAUD_ST(&g_kaud.in_muted, r17 == 0 ? 1u : 0u);
}

static void reg_write(uint8_t reg, uint8_t v)
{
    if (reg >= 0xFD) return;                 /* identity is read only */
    pthread_mutex_lock(&g_regmu);
    g_regs[reg] = v;
    es_update_locked();
    pthread_mutex_unlock(&g_regmu);
}
static void reg_set_bits(uint8_t reg, uint8_t mask, uint8_t v)
{
    pthread_mutex_lock(&g_regmu);
    g_regs[reg] = (uint8_t)((g_regs[reg] & ~mask) | (v & mask));
    es_update_locked();
    pthread_mutex_unlock(&g_regmu);
}
/* The codec component's control interface (what kdrv_es8311_reg_read/write and kes_fields go through). */
static bool g_ctrl_ok = true;
static int ctrl_read(const audio_codec_ctrl_if_t *c, int reg, int reg_len, void *data, int len)
{
    (void)c; (void)reg_len;
    if (!g_ctrl_ok || reg < 0 || reg > 0xFF || len < 1) return -1;
    pthread_mutex_lock(&g_regmu);
    for (int i = 0; i < len && reg + i <= 0xFF; i++) ((uint8_t *)data)[i] = g_regs[reg + i];
    pthread_mutex_unlock(&g_regmu);
    return 0;
}
static int ctrl_write(const audio_codec_ctrl_if_t *c, int reg, int reg_len, void *data, int len)
{
    (void)c; (void)reg_len;
    if (!g_ctrl_ok || reg < 0 || reg > 0xFF || len < 1) return -1;
    for (int i = 0; i < len && reg + i <= 0xFF; i++) reg_write((uint8_t)(reg + i), ((uint8_t *)data)[i]);
    return 0;
}
static const audio_codec_ctrl_if_t g_ctrl = { .read_reg = ctrl_read, .write_reg = ctrl_write };

const audio_codec_ctrl_if_t *audio_codec_new_i2c_ctrl(audio_codec_i2c_cfg_t *cfg)
{
    /* The component shifts the address right by one: kdrv_es8311.c must pass the eight-bit form. Unshifted it would
     * address 0x0C where nothing answers; the model reproduces that so a regression shows up as "no codec". */
    g_ctrl_ok = cfg && ((cfg->addr >> 1) == KBSP_I2C_ADDR_CODEC);
    return &g_ctrl;
}

/* The same registers on the virtual I2C bus at 0x18. */
static int chip_read(void *ctx, uint8_t reg, uint8_t *buf, size_t len)
{
    (void)ctx;
    pthread_mutex_lock(&g_regmu);
    for (size_t i = 0; i < len; i++) buf[i] = (reg + i <= 0xFF) ? g_regs[reg + i] : 0;
    pthread_mutex_unlock(&g_regmu);
    return 0;
}
static int chip_write(void *ctx, uint8_t reg, const uint8_t *buf, size_t len)
{
    (void)ctx;
    for (size_t i = 0; i < len && reg + i <= 0xFF; i++) reg_write((uint8_t)(reg + i), buf[i]);
    return 0;
}
void audio_es8311_register(void)
{
    static dotbench_i2c_chip_t chip = { .addr = KBSP_I2C_ADDR_CODEC, .name = "es8311", .read = chip_read, .write = chip_write };
    dotbench_i2c_register(&chip);
}

/* ---------------------------------------------------------------- the controller's and codec's state */
static struct {
    bool     tx_init, rx_init;
    bool     enabled;            /* channels enabled by esp_codec_dev_open() */
    bool     dev_new, dev_open, disable_when_closed;
    uint64_t t0;                 /* ns when the channels were enabled: the wire clock's origin */
    uint64_t tx_pos;             /* frames accepted since then */
    bool     tx_written;
    uint64_t tail_zero;          /* digital-silence frames written most recently (a drained sound leaves >= one ring of them) */
    bool     rx_active;
    uint64_t rx_t0, rx_last, rx_pos;
    esp_codec_dev_vol_map_t curve[4];
    int      ncurve;
    /* the DAC's gain ramp (private to the writing thread) */
    float    g_cur, g_step;
    uint32_t g_tgt, ramp_left;
    bool     g_init;
} s;

static int16_t s_txout[BLOCK_MAX * 2u];
static int16_t s_rxmono[BLOCK_MAX];

esp_err_t i2s_new_channel(const i2s_chan_config_t *cfg, i2s_chan_handle_t *tx, i2s_chan_handle_t *rx)
{
    static char txo, rxo;
    (void)cfg;
    if (tx) *tx = (i2s_chan_handle_t)&txo;
    if (rx) *rx = (i2s_chan_handle_t)&rxo;
    return ESP_OK;
}
esp_err_t i2s_channel_init_std_mode(i2s_chan_handle_t h, const i2s_std_config_t *cfg)
{
    if (!cfg || cfg->clk_cfg.sample_rate_hz != KAUD_RATE_HZ || cfg->slot_cfg.data_bit_width != 16) return ESP_ERR_INVALID_ARG;
    if (h) { s.tx_init = true; s.rx_init = true; }
    return ESP_OK;
}
esp_err_t i2s_channel_reconfig_std_gpio(i2s_chan_handle_t h, const i2s_std_gpio_config_t *g)
{
    (void)h; (void)g;
    return s.enabled ? ESP_ERR_INVALID_STATE : ESP_OK;     /* IDF: the channel must not be enabled */
}

const audio_codec_data_if_t *audio_codec_new_i2s_data(audio_codec_i2s_cfg_t *cfg)
{
    static char o;
    (void)cfg;
    return (const audio_codec_data_if_t *)&o;
}
const audio_codec_gpio_if_t *audio_codec_new_gpio(void)
{
    static char o;
    return (const audio_codec_gpio_if_t *)&o;
}
static int chip_enable(const audio_codec_if_t *h, bool en)
{
    (void)h; (void)en;
    pthread_mutex_lock(&g_regmu);
    if (!en) regs_rest_locked();
    es_update_locked();
    pthread_mutex_unlock(&g_regmu);
    return ESP_CODEC_DEV_OK;
}
const audio_codec_if_t *es8311_codec_new(es8311_codec_cfg_t *cfg)
{
    static const audio_codec_if_t chip = { .enable = chip_enable };
    (void)cfg;
    return &chip;
}
esp_codec_dev_handle_t esp_codec_dev_new(const esp_codec_dev_cfg_t *cfg)
{
    static char o;
    (void)cfg;
    s.dev_new = true;
    return (esp_codec_dev_handle_t)&o;
}
int esp_codec_set_disable_when_closed(esp_codec_dev_handle_t d, bool disable) { (void)d; s.disable_when_closed = disable; return ESP_CODEC_DEV_OK; }

int esp_codec_dev_set_vol_curve(esp_codec_dev_handle_t d, esp_codec_dev_vol_curve_t *c)
{
    (void)d;
    if (!c || !c->vol_map || c->count < 2 || c->count > 4) return ESP_CODEC_DEV_INVALID_ARG;
    for (int i = 0; i < c->count; i++) s.curve[i] = c->vol_map[i];
    s.ncurve = c->count;
    return ESP_CODEC_DEV_OK;
}

/* ---------------------------------------------------------------- open / close / settings */
int esp_codec_dev_open(esp_codec_dev_handle_t d, esp_codec_dev_sample_info_t *fs)
{
    (void)d;
    if (!fs || fs->sample_rate != KAUD_RATE_HZ || fs->bits_per_sample != 16 || fs->channel != 2) return ESP_CODEC_DEV_INVALID_ARG;
    if (s.dev_open) return ESP_CODEC_DEV_OK;
    pthread_mutex_lock(&g_regmu);
    /* What the component's open writes (datasheet values for 48 kHz, MCLK = 256 fs, I2S 16-bit, ADC from MIC1P-1N, DAC on). */
    static const uint8_t on[][2] = { {0x00,0x80},{0x01,0x3F},{0x02,0x00},{0x03,0x10},{0x04,0x10},{0x05,0x00},{0x06,0x03},
        {0x07,0x00},{0x08,0xFF},{0x09,0x0C},{0x0A,0x0C},{0x0D,0x01},{0x0E,0x02},{0x12,0x00},{0x13,0x10},{0x14,0x1A},
        {0x15,0x40},{0x17,0xBF},{0x1B,0x0A},{0x1C,0x6A},{0x31,0x00},{0x37,0x08},{0x44,0x08},{0x45,0x00} };
    for (size_t i = 0; i < sizeof on / sizeof on[0]; i++) g_regs[on[i][0]] = on[i][1];
    if (g_regs[0x32] == 0) g_regs[0x32] = 0xBF;
    es_update_locked();
    pthread_mutex_unlock(&g_regmu);
    s.enabled = true; s.dev_open = true;
    s.t0 = kaud_now_ns(); s.tx_pos = 0; s.tx_written = false; s.tail_zero = 0; s.rx_active = false;
    s.g_init = false;
    __atomic_fetch_or(&g_kaud.flags, KAUD_F_TX_RUN | KAUD_F_RX_RUN | KAUD_F_OPEN, __ATOMIC_RELAXED);
    return ESP_CODEC_DEV_OK;
}
int esp_codec_dev_close(esp_codec_dev_handle_t d)
{
    (void)d;
    s.enabled = false; s.dev_open = false; s.rx_active = false;
    pthread_mutex_lock(&g_regmu);
    if (s.disable_when_closed) { g_regs[0x12] = 0x02; g_regs[0x0D] = 0xFC; g_regs[0x0E] = 0xFF; g_regs[0x00] = 0x1F; }
    es_update_locked();
    pthread_mutex_unlock(&g_regmu);
    __atomic_fetch_and(&g_kaud.flags, ~(uint32_t)(KAUD_F_TX_RUN | KAUD_F_RX_RUN | KAUD_F_OPEN), __ATOMIC_RELAXED);
    return ESP_CODEC_DEV_OK;
}

static double curve_db(int vol)
{
    if (s.ncurve < 2) return -95.5 + vol * 0.955;
    const esp_codec_dev_vol_map_t *m = s.curve;
    if (vol <= m[0].vol) return m[0].db_value;
    for (int i = 1; i < s.ncurve; i++)
        if (vol <= m[i].vol) {
            double t = (double)(vol - m[i - 1].vol) / (double)(m[i].vol - m[i - 1].vol);
            return m[i - 1].db_value + t * (m[i].db_value - m[i - 1].db_value);
        }
    return m[s.ncurve - 1].db_value;
}
int esp_codec_dev_set_out_vol(esp_codec_dev_handle_t d, int vol)
{
    (void)d;
    if (!s.dev_open) return ESP_CODEC_DEV_WRONG_STATE;
    if (vol < 0) vol = 0;
    int reg = 0;
    if (vol > 0) { double r = floor((curve_db(vol) + 95.5) * 2.0 + 1e-6); reg = r < 1 ? 1 : (r > 255 ? 255 : (int)r); }
    reg_write(0x32, (uint8_t)reg);          /* volume 0: the register's floor, -95.5 dB: silent */
    return ESP_CODEC_DEV_OK;
}
int esp_codec_dev_set_out_mute(esp_codec_dev_handle_t d, bool mute)
{
    (void)d;
    if (!s.dev_open) return ESP_CODEC_DEV_WRONG_STATE;
    reg_set_bits(0x31, 0x60, mute ? 0x60 : 0x00);
    return ESP_CODEC_DEV_OK;
}
int esp_codec_dev_set_in_gain(esp_codec_dev_handle_t d, float db)
{
    (void)d;
    if (!s.dev_open) return ESP_CODEC_DEV_WRONG_STATE;
    int idx = (int)(db / 6.0f + 0.5f);
    if (idx < 0) idx = 0;
    if (idx > 7) idx = 7;
    reg_set_bits(0x16, 0x07, (uint8_t)idx);
    return ESP_CODEC_DEV_OK;
}
int esp_codec_dev_set_in_mute(esp_codec_dev_handle_t d, bool mute)
{
    (void)d;
    if (!s.dev_open) return ESP_CODEC_DEV_WRONG_STATE;
    reg_write(0x17, mute ? 0x00 : 0xBF);
    return ESP_CODEC_DEV_OK;
}

/* ---------------------------------------------------------------- pacing */
static inline uint64_t ns_to_frames(uint64_t ns) { return ns * 6ull / 125000ull; }      /* x 48000 / 1e9 */
static inline uint64_t frames_to_ns(uint64_t f)  { return f * 125000ull / 6ull; }

static void sleep_until(uint64_t t_ns)
{
    for (;;) {
        uint64_t now = kaud_now_ns();
        if (now >= t_ns) return;
        uint64_t us = (t_ns - now) / 1000ull;
        usleep(us > 0 ? (useconds_t)us : 50);
    }
}

static void tx_pace(uint32_t n)
{
    if (!KAUD_LD(&g_kaud.pace)) { s.tx_pos += n; return; }
    uint64_t nowf = ns_to_frames(kaud_now_ns() - s.t0);
    uint64_t tol = KAUD_LD(&g_kaud.tolerance_frames);
    if (tol < DMA_FRAMES) tol = DMA_FRAMES;
    if (s.tx_pos + tol < nowf) {                         /* the wire starved for longer than the tolerance: resync */
        uint64_t gap = nowf - s.tx_pos;
        if (s.tx_written && s.tail_zero < DMA_FRAMES) KAUD_ADD(&g_kaud.out_underruns, 1);   /* audio was in flight; after a drained sound the wire is merely idle */
        KAUD_ADD(&g_kaud.out_gap_frames, (uint32_t)gap);
        kaud_cap_silence(gap);
        s.tx_pos = nowf;
    } else if (s.tx_pos + DMA_FRAMES < nowf) {
        KAUD_ADD(&g_kaud.out_lates, 1);
    }
    if (s.tx_pos + n > DMA_FRAMES) sleep_until(s.t0 + frames_to_ns(s.tx_pos + n - DMA_FRAMES));
    s.tx_pos += n;
}

/* ---------------------------------------------------------------- TX */
static void tx_process(const int16_t *in, uint32_t n)
{
    uint32_t tgt = KAUD_LD(&g_kaud.out_gain_q16);
    if (!s.g_init) { s.g_init = true; s.g_cur = tgt / 65536.0f; s.g_tgt = tgt; s.ramp_left = 0; }
    if (tgt != s.g_tgt) {
        s.g_tgt = tgt;
        s.ramp_left = RAMP_FRAMES;
        s.g_step = (tgt / 65536.0f - s.g_cur) / (float)RAMP_FRAMES;
    }
    uint32_t peak = 0; double sum = 0; bool nonzero = false;
    for (uint32_t i = 0; i < n; i++) {
        float g;
        if (s.ramp_left) { s.g_cur += s.g_step; if (--s.ramp_left == 0) s.g_cur = s.g_tgt / 65536.0f; }
        g = s.g_cur;
        for (int ch = 0; ch < 2; ch++) {
            float v = (float)in[2 * i + ch] * g;
            int32_t o = (int32_t)(v >= 0 ? v + 0.5f : v - 0.5f);
            if (o > 32767) o = 32767; else if (o < -32768) o = -32768;
            s_txout[2 * i + ch] = (int16_t)o;
        }
        int32_t a = s_txout[2 * i]; if (a < 0) a = -a;
        if ((uint32_t)a > peak) peak = (uint32_t)a;
        sum += (double)a * a;
        if (in[2 * i] | in[2 * i + 1]) nonzero = true;
    }
    uint32_t now_ms = kaud_now_ms();
    uint32_t rms = n ? (uint32_t)sqrt(sum / n) : 0;
    KAUD_ST(&g_kaud.level_peak, peak > 32768 ? 32768 : peak);
    KAUD_ST(&g_kaud.level_rms, rms);
    KAUD_ST(&g_kaud.level_ms, now_ms);
    KAUD_ADD(&g_kaud.level_seq, 1);
    if (nonzero) { KAUD_ST(&g_kaud.out_active_ms, now_ms); s.tail_zero = 0; } else s.tail_zero += n;

    /* into the output ring: samples first, then the release store of the count */
    uint32_t wr = KAUD_LD(&g_kaud.out_wr), rd = KAUD_LD(&g_kaud.out_rd);
    if (wr - rd + n > KAUD_OUT_FRAMES) KAUD_ADD(&g_kaud.out_overruns, 1);
    for (uint32_t i = 0; i < n; i++) {
        uint32_t k = ((wr + i) & (KAUD_OUT_FRAMES - 1u)) * 2u;
        g_kaud.out[k] = s_txout[2 * i]; g_kaud.out[k + 1] = s_txout[2 * i + 1];
    }
    KAUD_ST(&g_kaud.out_wr, wr + n);
    KAUD_ADD(&g_kaud.out_frames_total, n);
    kaud_cap_append(s_txout, n);
}

int esp_codec_dev_write(esp_codec_dev_handle_t d, void *data, int len)
{
    (void)d;
    if (!s.dev_open || !s.enabled) return ESP_CODEC_DEV_WRONG_STATE;
    if (!data || len < 0 || (len & 3)) return ESP_CODEC_DEV_INVALID_ARG;
    const int16_t *p = (const int16_t *)data;
    uint32_t left = (uint32_t)len / 4u;
    while (left) {
        uint32_t n = left > BLOCK_MAX ? BLOCK_MAX : left;
        tx_pace(n);
        tx_process(p, n);
        s.tx_written = true;
        KAUD_ADD(&g_kaud.out_blocks, 1);
        p += 2u * n; left -= n;
    }
    return ESP_CODEC_DEV_OK;
}

/* ---------------------------------------------------------------- RX */
int esp_codec_dev_read(esp_codec_dev_handle_t d, void *data, int len)
{
    (void)d;
    if (!s.dev_open || !s.enabled) return ESP_CODEC_DEV_WRONG_STATE;
    if (!data || len < 0 || (len & 3)) return ESP_CODEC_DEV_INVALID_ARG;
    if (KAUD_LD(&g_kaud.in_source) == KAUD_SRC_MIC && (KAUD_LD(&g_kaud.flags) & KAUD_F_MIC_DENIED)) return ESP_CODEC_DEV_READ_FAIL;
    int16_t *out = (int16_t *)data;
    uint32_t left = (uint32_t)len / 4u;
    while (left) {
        uint32_t n = left > BLOCK_MAX ? BLOCK_MAX : left;
        uint64_t now = kaud_now_ns();
        if (!s.rx_active || now - s.rx_last > (uint64_t)IDLE_GAP_NS) {
            s.rx_active = true; s.rx_t0 = now; s.rx_pos = 0;
            kaud_in_session_start();
        }
        if (KAUD_LD(&g_kaud.pace)) sleep_until(s.rx_t0 + frames_to_ns(s.rx_pos + n));
        {
            uint32_t g = KAUD_LD(&g_kaud.in_muted) ? 0u : db_to_q16((double)(int32_t)KAUD_LD(&g_kaud.in_gain_db_x10) / 10.0);
            kaud_in_fill(s_rxmono, n, g);
        }
        for (uint32_t i = 0; i < n; i++) { out[2 * i] = s_rxmono[i]; out[2 * i + 1] = 0; }   /* right slot stays empty */
        s.rx_pos += n; s.rx_last = kaud_now_ns();
        KAUD_ST(&g_kaud.in_active_ms, kaud_now_ms());
        out += 2u * n; left -= n;
    }
    return ESP_CODEC_DEV_OK;
}

/* ---------------------------------------------------------------- bring-up of the shared block */
__attribute__((constructor)) static void kaud_ctor(void)
{
    memset(&g_kaud, 0, sizeof g_kaud);
    g_kaud.magic = KAUD_MAGIC; g_kaud.version = KAUD_VERSION; g_kaud.size = sizeof g_kaud;
    g_kaud.out_off = KAUD_OFF_OUT; g_kaud.out_frames = KAUD_OUT_FRAMES; g_kaud.out_rate = KAUD_RATE_HZ; g_kaud.out_channels = 2;
    g_kaud.bench_gain_q16 = 65536; g_kaud.tolerance_frames = 9600; g_kaud.pace = 1;
    g_kaud.in_off = KAUD_OFF_IN; g_kaud.in_frames_cap = KAUD_IN_FRAMES; g_kaud.in_rewind_auto = 1;
    g_kaud.in_synth_hz = 1000; g_kaud.in_synth_level = 8192;
    g_kaud.flags = KAUD_F_PRESENT;
    pthread_mutex_lock(&g_regmu);
    regs_rest_locked();
    es_update_locked();
    pthread_mutex_unlock(&g_regmu);
}
