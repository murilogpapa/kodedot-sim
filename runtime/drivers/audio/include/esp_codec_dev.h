/* SPDX-License-Identifier: GPL-3.0-or-later
 * The part of the esp_codec_dev component that kdrv_es8311.c uses (names, fields and signatures are the component's).
 * Implemented in audio_codec_web.c over the software I2S controller and the ES8311 register model. */
#ifndef DOTBENCH_ESP_CODEC_DEV_H
#define DOTBENCH_ESP_CODEC_DEV_H
#include <stdbool.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
#define ESP_CODEC_DEV_OK              0
#define ESP_CODEC_DEV_WRITE_FAIL     -2
#define ESP_CODEC_DEV_READ_FAIL      -3
#define ESP_CODEC_DEV_WRONG_STATE    -4
#define ESP_CODEC_DEV_INVALID_ARG    -5
#define ESP_CODEC_DEV_WORK_MODE_BOTH  3
#define ESP_CODEC_DEV_TYPE_IN_OUT     3

typedef struct audio_codec_ctrl_if_t audio_codec_ctrl_if_t;
typedef struct audio_codec_data_if_t audio_codec_data_if_t;
typedef struct audio_codec_gpio_if_t audio_codec_gpio_if_t;
typedef struct audio_codec_if_t      audio_codec_if_t;
typedef struct codec_dev_t          *esp_codec_dev_handle_t;

struct audio_codec_ctrl_if_t {
    int (*read_reg)(const audio_codec_ctrl_if_t *ctrl, int reg, int reg_len, void *data, int data_len);
    int (*write_reg)(const audio_codec_ctrl_if_t *ctrl, int reg, int reg_len, void *data, int data_len);
};
struct audio_codec_if_t {
    int (*enable)(const audio_codec_if_t *h, bool enable);
};
typedef struct {
    uint8_t  bits_per_sample;
    uint8_t  channel;
    uint16_t channel_mask;
    uint32_t sample_rate;
    int      mclk_multiple;
} esp_codec_dev_sample_info_t;
typedef struct { int vol; float db_value; } esp_codec_dev_vol_map_t;
typedef struct { esp_codec_dev_vol_map_t *vol_map; int count; } esp_codec_dev_vol_curve_t;
typedef struct {
    int                          dev_type;
    const audio_codec_if_t      *codec_if;
    const audio_codec_data_if_t *data_if;
} esp_codec_dev_cfg_t;

esp_codec_dev_handle_t esp_codec_dev_new(const esp_codec_dev_cfg_t *cfg);
int esp_codec_dev_open(esp_codec_dev_handle_t dev, esp_codec_dev_sample_info_t *fs);
int esp_codec_dev_close(esp_codec_dev_handle_t dev);
int esp_codec_dev_write(esp_codec_dev_handle_t dev, void *data, int len);
int esp_codec_dev_read(esp_codec_dev_handle_t dev, void *data, int len);
int esp_codec_dev_set_out_vol(esp_codec_dev_handle_t dev, int volume);
int esp_codec_dev_set_in_gain(esp_codec_dev_handle_t dev, float db);
int esp_codec_dev_set_out_mute(esp_codec_dev_handle_t dev, bool mute);
int esp_codec_dev_set_in_mute(esp_codec_dev_handle_t dev, bool mute);
int esp_codec_dev_set_vol_curve(esp_codec_dev_handle_t dev, esp_codec_dev_vol_curve_t *curve);
int esp_codec_set_disable_when_closed(esp_codec_dev_handle_t dev, bool disable);
#ifdef __cplusplus
}
#endif
#endif
