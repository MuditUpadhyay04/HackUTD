/*
 * eog_sd.c — board-only HAL hook hal_read_file() for eog_proto's SD boot load (FPGA/docs/SD_BOOT_WEIGHTS.md):
 * reads one file from the root directory of the microSD card (SD0) with FatFs (Xilinx xilffs).
 *
 * Needs the xilffs library in the BSP (deploy/vitis_build.py adds it to the eog build; the defaults
 * fs_interface = 1 (SD/eMMC) are what this uses; read-only is enough). Compiled as part of the eog_app.c unity
 * build (copied to src/eog_inc/eog_sd_c.h by vitis_build.py). Host tests use their own hal_read_file instead
 * (ps/test/test_proto.c, ps/test/simboard.c).
 *
 * The card is mounted, the file read, and the card unmounted again: the board never writes to it.
 */
#include <stdint.h>
#include <string.h>

#include "ff.h"
#include "xil_printf.h"

#include "eog_proto.h"

#ifndef EOG_SD_DRIVE
#define EOG_SD_DRIVE "0:/"          /* logical drive 0 = SD0 */
#endif

static FATFS eog_fatfs;

int hal_read_file(const char *name, uint8_t *buf, uint32_t maxlen)
{
    TCHAR path[64];
    FIL fil;
    FRESULT r;
    if (strlen(EOG_SD_DRIVE) + strlen(name) >= sizeof path) return EOG_FILE_IO;
    strcpy(path, EOG_SD_DRIVE);
    strcat(path, name);

    r = f_mount(&eog_fatfs, EOG_SD_DRIVE, 1);             /* 1 = mount now: fails here if there is no card */
    if (r != FR_OK) {
        xil_printf("eog_sd: f_mount(%s) failed, FRESULT %d\r\n", EOG_SD_DRIVE, (int)r);
        f_mount(NULL, EOG_SD_DRIVE, 0);
        return EOG_FILE_NO_CARD;
    }
    r = f_open(&fil, path, FA_READ);
    if (r != FR_OK) {
        f_mount(NULL, EOG_SD_DRIVE, 0);
        if (r == FR_NO_FILE || r == FR_NO_PATH) return EOG_FILE_MISSING;
        xil_printf("eog_sd: f_open(%s) failed, FRESULT %d\r\n", path, (int)r);
        return EOG_FILE_IO;
    }
    uint32_t total = 0;
    while (total < maxlen) {
        UINT got = 0;
        r = f_read(&fil, buf + total, (UINT)(maxlen - total), &got);
        if (r != FR_OK) {
            xil_printf("eog_sd: f_read(%s) failed after %d B, FRESULT %d\r\n", path, (int)total, (int)r);
            f_close(&fil);
            f_mount(NULL, EOG_SD_DRIVE, 0);
            return EOG_FILE_IO;
        }
        if (got == 0) break;                                /* end of file */
        total += got;
    }
    f_close(&fil);
    f_mount(NULL, EOG_SD_DRIVE, 0);                         /* unmount: the card is read-only for the board */
    return (int)total;
}
