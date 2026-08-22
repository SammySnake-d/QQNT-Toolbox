#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <stdarg.h>
#include <time.h>
#include <pthread.h>
#include <mach-o/dyld.h>
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>

#define DYLD_INTERPOSE(_replacement,_replacee) \
   __attribute__((used)) static struct{ const void* replacement; const void* replacee; } _interpose_##_replacee \
            __attribute__ ((section ("__DATA,__interpose"))) = { (const void*)(unsigned long)&_replacement, (const void*)(unsigned long)&_replacee };

static const char *OFFICIAL_TEAM_ID = "FN2V63AD2J";
static const char *OFFICIAL_IDENTIFIER = "com.tencent.qq";
static const char *STOCK_MIRROR_INDEX = "/tmp/qq_stock_mirror/app_launcher/index.js";
static const char *STOCK_MIRROR_PKG = "/tmp/qq_stock_mirror/package.json";
static const char *HIT_LOG = "/tmp/native_stealth_hits.log";

static pthread_mutex_t log_mtx = PTHREAD_MUTEX_INITIALIZER;

// Ground-truth instrumentation: log every real hook hit by QQ
#include <sys/syscall.h>
// Use raw syscalls to fully bypass our own interpose (no recursion, no dlsym timing issues)
static void hit_log(const char *tag, const char *detail) {
    pthread_mutex_lock(&log_mtx);
    int fd = (int)syscall(SYS_open, HIT_LOG, O_WRONLY|O_CREAT|O_APPEND, 0644);
    if (fd >= 0) {
        struct timespec ts; clock_gettime(CLOCK_REALTIME, &ts);
        char tbuf[64]; struct tm tm; localtime_r(&ts.tv_sec, &tm);
        strftime(tbuf, sizeof(tbuf), "%Y-%m-%d %H:%M:%S", &tm);
        char line[1200];
        int n = snprintf(line, sizeof(line), "[%s.%03ld][pid=%d] %s | %s\n",
                         tbuf, ts.tv_nsec/1000000, getpid(), tag, detail ? detail : "");
        if (n > 0) syscall(SYS_write, fd, line, (size_t)n);
        syscall(SYS_close, fd);
    }
    pthread_mutex_unlock(&log_mtx);
}

// Determine if path is integrity-relevant (for logging even non-redirected checks)
static int is_integrity_path(const char *p) {
    if (!p) return 0;
    return (strstr(p, "package.json") || strstr(p, "app_launcher") ||
            strstr(p, ".asar") || strstr(p, "wrapper.node") ||
            strstr(p, "major.node") || strstr(p, "_CodeSignature") ||
            strstr(p, "CodeResources") || strstr(p, "index.js")) ? 1 : 0;
}

static const char* redirect_path_if_needed(const char *path) {
    if (!path) return path;
    if (strstr(path, "app_launcher/index.js") != NULL) {
        hit_log("VFS-REDIRECT", path);
        return STOCK_MIRROR_INDEX;
    }
    if (strstr(path, "Resources/app/package.json") != NULL) {
        hit_log("VFS-REDIRECT", path);
        return STOCK_MIRROR_PKG;
    }
    if (is_integrity_path(path)) {
        hit_log("FILE-READ(passthrough)", path);
    }
    return path;
}

int my_open(const char *path, int oflag, ...) {
    const char *target_path = redirect_path_if_needed(path);
    if (oflag & O_CREAT) {
        va_list args; va_start(args, oflag);
        mode_t mode = va_arg(args, int); va_end(args);
        return open(target_path, oflag, mode);
    }
    return open(target_path, oflag);
}
DYLD_INTERPOSE(my_open, open);

int my_openat(int fd, const char *path, int oflag, ...) {
    const char *target_path = redirect_path_if_needed(path);
    if (oflag & O_CREAT) {
        va_list args; va_start(args, oflag);
        mode_t mode = va_arg(args, int); va_end(args);
        return openat(fd, target_path, oflag, mode);
    }
    return openat(fd, target_path, oflag);
}
DYLD_INTERPOSE(my_openat, openat);

FILE *my_fopen(const char *filename, const char *mode) {
    const char *target_path = redirect_path_if_needed(filename);
    return fopen(target_path, mode);
}
DYLD_INTERPOSE(my_fopen, fopen);

int my_stat(const char *path, struct stat *buf) {
    const char *target_path = redirect_path_if_needed(path);
    return stat(target_path, buf);
}
DYLD_INTERPOSE(my_stat, stat);

int my_lstat(const char *path, struct stat *buf) {
    const char *target_path = redirect_path_if_needed(path);
    return lstat(target_path, buf);
}
DYLD_INTERPOSE(my_lstat, lstat);

OSStatus my_SecCodeCheckValidity(SecCodeRef code, SecCSFlags flags, SecRequirementRef requirement) {
    hit_log("SecCodeCheckValidity", "forced errSecSuccess");
    return errSecSuccess;
}
DYLD_INTERPOSE(my_SecCodeCheckValidity, SecCodeCheckValidity);

OSStatus my_SecStaticCodeCheckValidity(SecStaticCodeRef staticCode, SecCSFlags flags, SecRequirementRef requirement) {
    hit_log("SecStaticCodeCheckValidity", "forced errSecSuccess");
    return errSecSuccess;
}
DYLD_INTERPOSE(my_SecStaticCodeCheckValidity, SecStaticCodeCheckValidity);

OSStatus my_SecCodeCopySigningInformation(SecStaticCodeRef code, SecCSFlags flags, CFDictionaryRef *signinginfo) {
    OSStatus status = SecCodeCopySigningInformation(code, flags, signinginfo);
    hit_log("SecCodeCopySigningInformation", "injecting official teamid");
    if (status == errSecSuccess && signinginfo && *signinginfo) {
        CFMutableDictionaryRef mutableInfo = CFDictionaryCreateMutableCopy(kCFAllocatorDefault, 0, *signinginfo);
        if (mutableInfo) {
            CFStringRef teamIdVal = CFStringCreateWithCString(kCFAllocatorDefault, OFFICIAL_TEAM_ID, kCFStringEncodingUTF8);
            CFDictionarySetValue(mutableInfo, CFSTR("teamid"), teamIdVal);
            CFRelease(teamIdVal);
            CFStringRef identVal = CFStringCreateWithCString(kCFAllocatorDefault, OFFICIAL_IDENTIFIER, kCFStringEncodingUTF8);
            CFDictionarySetValue(mutableInfo, CFSTR("identifier"), identVal);
            CFRelease(identVal);
            CFRelease(*signinginfo);
            *signinginfo = mutableInfo;
        }
    }
    return errSecSuccess;
}
DYLD_INTERPOSE(my_SecCodeCopySigningInformation, SecCodeCopySigningInformation);

__attribute__((constructor))
static void stealth_init(void) {
    mkdir("/tmp/qq_stock_mirror", 0755);
    mkdir("/tmp/qq_stock_mirror/app_launcher", 0755);
    hit_log("INIT", "dylib constructor loaded");
}
