#include "control_page.h"

#include <stdio.h>

#include "esp_log.h"
#include "esp_spiffs.h"

#include "ws_server.h"

static const char *TAG = "control_page";

// Reads one whole file from the mounted SPIFFS partition straight into the
// HTTP response. Pages here are all tiny (a few KB) so a single stack
// buffer + httpd_resp_send_chunk loop is enough — no need for a streaming
// abstraction over something this small.
static esp_err_t send_file(httpd_req_t *req, const char *path, const char *content_type) {
    FILE *f = fopen(path, "r");
    if (!f) {
        ESP_LOGE(TAG, "failed to open %s", path);
        httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "file not found");
        return ESP_FAIL;
    }

    httpd_resp_set_type(req, content_type);
    char buf[512];
    size_t n;
    esp_err_t ret = ESP_OK;
    while ((n = fread(buf, 1, sizeof(buf), f)) > 0) {
        if (httpd_resp_send_chunk(req, buf, n) != ESP_OK) {
            ret = ESP_FAIL;
            break;
        }
    }
    fclose(f);
    if (ret == ESP_OK) {
        httpd_resp_send_chunk(req, NULL, 0); // terminate the chunked response
    }
    return ret;
}

static esp_err_t index_handler(httpd_req_t *req) {
    return send_file(req, "/spiffs/index.html", "text/html");
}

static esp_err_t style_handler(httpd_req_t *req) {
    return send_file(req, "/spiffs/style.css", "text/css");
}

static esp_err_t app_js_handler(httpd_req_t *req) {
    return send_file(req, "/spiffs/app.js", "application/javascript");
}

void control_page_start(void) {
    esp_vfs_spiffs_conf_t conf = {
        .base_path = "/spiffs",
        .partition_label = "storage",
        .max_files = 3,
        .format_if_mount_failed = false,
    };
    esp_err_t ret = esp_vfs_spiffs_register(&conf);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "failed to mount \"storage\" SPIFFS partition (%s) — control page unavailable",
                  esp_err_to_name(ret));
        return;
    }

    httpd_handle_t server = ws_server_get_httpd();
    if (!server) {
        ESP_LOGE(TAG, "ws_server_get_httpd() returned NULL — call control_page_start() after ws_server_start()");
        return;
    }

    httpd_uri_t index_uri = { .uri = "/",          .method = HTTP_GET, .handler = index_handler };
    httpd_uri_t style_uri = { .uri = "/style.css", .method = HTTP_GET, .handler = style_handler };
    httpd_uri_t app_js_uri = { .uri = "/app.js",   .method = HTTP_GET, .handler = app_js_handler };
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &index_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &style_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &app_js_uri));

    size_t total = 0, used = 0;
    esp_spiffs_info(conf.partition_label, &total, &used);
    ESP_LOGI(TAG, "control page ready at GET / (SPIFFS: %u/%u bytes used)", (unsigned)used, (unsigned)total);
}
