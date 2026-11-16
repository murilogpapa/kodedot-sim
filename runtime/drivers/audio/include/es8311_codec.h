/* SPDX-License-Identifier: GPL-3.0-or-later
 * The ES8311 chip driver's configuration, as kdrv_es8311.c fills it. */
#ifndef DOTBENCH_ES8311_CODEC_H
#define DOTBENCH_ES8311_CODEC_H
#include <stdbool.h>
#include <stdint.h>
#include "esp_codec_dev.h"
#ifdef __cplusplus
extern "C" {
#endif
typedef struct { float pa_voltage; float codec_dac_voltage; float pa_gain; } esp_codec_dev_hw_gain_t;
typedef struct {
    const audio_codec_ctrl_if_t *ctrl_if;
    const audio_codec_gpio_if_t *gpio_if;
    int                          codec_mode;
    int16_t                      pa_pin;
    bool                         pa_reverted;
    bool                         master_mode;
    bool                         use_mclk;
    bool                         digital_mic;
    bool                         invert_mclk;
    bool                         invert_sclk;
    esp_codec_dev_hw_gain_t      hw_gain;
    bool                         no_dac_ref;
    uint16_t                     mclk_div;
} es8311_codec_cfg_t;
const audio_codec_if_t *es8311_codec_new(es8311_codec_cfg_t *cfg);
#ifdef __cplusplus
}
#endif
#endif
