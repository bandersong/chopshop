/* eft_api.c - a small read-only identify call over elektron-firmware-tool.
 *
 * Part of the browser installer (working name "web"). Copyright (C) 2026
 * bandersong. SPDX-FileCopyrightText: 2026 Jesus Triana. SPDX-License-Identifier: GPL-3.0-or-later.
 *
 * The installer runs elektron-firmware-tool's own main() (MIT, Marcel Bierling)
 * for every extract, rebuild and repack, with the same arguments the project's
 * build.py passes, so the browser and the build use the same packer. This file
 * only adds one thing main() does not offer in a machine-readable form: what a
 * dropped .syx says it is (device byte, container, version text), so the page can
 * explain a file it does not know. It never writes anything.
 */
#include "firmware.h"
#include "report.h"
#include "device.h"
#include <stdio.h>
#include <string.h>

/* Printable copy of a header field: letters, digits and dots only, so the JSON
 * below never needs escaping. */
static void copy_field(char *dst, size_t cap, const uint8_t *c, int from, int to) {
    size_t n = 0;
    for (int i = from; i < to && n + 1 < cap; i++) {
        uint8_t ch = c[i];
        int ok = (ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'Z') ||
                 (ch >= 'a' && ch <= 'z') || ch == '.';
        if (!ok)
            break;
        dst[n++] = (char)ch;
    }
    dst[n] = 0;
}

static int build_offset(container_type ct) {
    return ct == CT_ELE2 ? ELE2_BUILD_OFF : ct == CT_ELEK ? ELEK_BUILD_OFF
                          : ct == CT_ELE3 ? ELE3_BUILD_OFF : -1;
}

/* Writes one JSON object into out (cap bytes) and returns 0, or -1 when out is
 * too small. Fields: load (fw_load's return code), sysex (the transport decoded),
 * device (product byte), device_name, container, version, model, all_ok (every
 * integrity gate the file carries passed), sections ([ids]). */
int eft_identify(const char *path, char *out, int cap) {
    firmware fw;
    int rc = fw_load(path, &fw);
    char version[24] = "", model[24] = "";
    const char *ctype = "none";
    int all_ok = 0;
    char secs[64 * 12] = "";
    if (rc == 0) {
        verify_result vr;
        fw_verify(&fw, &vr);
        all_ok = vr.all_ok;
        ctype  = container_type_name(fw.bin.type);
        int boff = build_offset(fw.bin.type);
        int lim  = container_header_end(fw.bin.type);
        if (boff >= 0) {
            if (fw.bin.len < (size_t)lim)
                lim = (int)fw.bin.len;
            int voff = container_find_version_pattern(fw.bin.data, boff, lim);
            if (voff >= 0)
                copy_field(version, sizeof version, fw.bin.data, voff, lim);
            int m = boff;
            while (m < lim && !((fw.bin.data[m] >= '0' && fw.bin.data[m] <= '9') ||
                                (fw.bin.data[m] >= 'A' && fw.bin.data[m] <= 'Z') ||
                                (fw.bin.data[m] >= 'a' && fw.bin.data[m] <= 'z')))
                m++;
            copy_field(model, sizeof model, fw.bin.data, m, voff >= 0 ? voff : lim);
        }
        size_t used = 0;
        for (uint32_t s = 0; s < fw.bin.nsections && used + 12 < sizeof secs; s++)
            used += (size_t)snprintf(secs + used, sizeof secs - used, "%s%u", s ? "," : "",
                                     fw.bin.sections[s].id);
    }
    int n = snprintf(out, (size_t)cap,
                     "{\"load\":%d,\"sysex\":%d,\"device\":%d,\"device_name\":\"%s\","
                     "\"container\":\"%s\",\"version\":\"%s\",\"model\":\"%s\","
                     "\"all_ok\":%d,\"sections\":[%s]}",
                     rc, fw.sysex_ok, fw.sysex_ok ? fw.sysex.device : -1,
                     fw.sysex_ok ? elektron_device_name(fw.sysex.device) : "", ctype, version,
                     model, all_ok, secs);
    fw_free(&fw);
    return (n < 0 || n >= cap) ? -1 : 0;
}
