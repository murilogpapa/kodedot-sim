/* SPDX-License-Identifier: GPL-3.0-or-later
 * The part of ESP-IDF's I2S standard-mode driver that kdrv_es8311.c uses (names, fields and signatures are IDF's).
 * The implementation is audio_i2s_web.c: a software I2S controller paced by the wall clock. */
#ifndef DOTBENCH_AUDIO_I2S_STD_H
#define DOTBENCH_AUDIO_I2S_STD_H
#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

#ifndef CONFIG_LOG_DEFAULT_LEVEL
#define CONFIG_LOG_DEFAULT_LEVEL 3          /* ESP_LOG_INFO; the web idf layer ignores per-tag levels */
#endif

#ifdef __cplusplus
extern "C" {
#endif
typedef int gpio_num_t;
#define I2S_NUM_0  0
#define I2S_NUM_1  1
#define I2S_NUM_2  2
typedef struct i2s_channel_obj_t *i2s_chan_handle_t;
typedef enum { I2S_ROLE_MASTER = 0, I2S_ROLE_SLAVE } i2s_role_t;
typedef struct {
    int        id;
    i2s_role_t role;
    uint32_t   dma_desc_num;
    uint32_t   dma_frame_num;
    bool       auto_clear;
} i2s_chan_config_t;
#define I2S_CHANNEL_DEFAULT_CONFIG(i2s_num, i2s_role) \
    { .id = (i2s_num), .role = (i2s_role), .dma_desc_num = 6, .dma_frame_num = 240, .auto_clear = false }
typedef int i2s_mclk_multiple_t;
typedef struct { uint32_t sample_rate_hz; i2s_mclk_multiple_t mclk_multiple; } i2s_std_clk_config_t;
#define I2S_STD_CLK_DEFAULT_CONFIG(rate) { .sample_rate_hz = (rate), .mclk_multiple = 256 }
#define I2S_DATA_BIT_WIDTH_16BIT  16
#define I2S_SLOT_MODE_STEREO       2
typedef struct { int data_bit_width; int slot_mode; } i2s_std_slot_config_t;
#define I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(bits, mode) { .data_bit_width = (bits), .slot_mode = (mode) }
typedef struct { bool mclk_inv; bool bclk_inv; bool ws_inv; } i2s_gpio_invert_t;
typedef struct {
    gpio_num_t mclk, bclk, ws, dout, din;
    i2s_gpio_invert_t invert_flags;
} i2s_std_gpio_config_t;
typedef struct {
    i2s_std_clk_config_t  clk_cfg;
    i2s_std_slot_config_t slot_cfg;
    i2s_std_gpio_config_t gpio_cfg;
} i2s_std_config_t;

esp_err_t i2s_new_channel(const i2s_chan_config_t *chan_cfg, i2s_chan_handle_t *tx_handle, i2s_chan_handle_t *rx_handle);
esp_err_t i2s_channel_init_std_mode(i2s_chan_handle_t handle, const i2s_std_config_t *std_cfg);
esp_err_t i2s_channel_reconfig_std_gpio(i2s_chan_handle_t handle, const i2s_std_gpio_config_t *gpio_cfg);
#ifdef __cplusplus
}
#endif
#endif
