#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <limits.h>
#include <sys/stat.h>
#include <stdarg.h>
#include <time.h>
#include <pthread.h>
#include <mach-o/dyld.h>
#include <sys/syscall.h>
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>

#define DYLD_INTERPOSE(_replacement,_replacee) \
   __attribute__((used)) static struct{ const void* replacement; const void* replacee; } _interpose_##_replacee \
            __attribute__ ((section ("__DATA,__interpose"))) = { (const void*)(unsigned long)&_replacement, (const void*)(unsigned long)&_replacee };

static const char *OFFICIAL_TEAM_ID   = "FN2V63AD2J";
static const char *OFFICIAL_IDENTIFIER = "com.tencent.qq";

// 持久化路径 (运行时按 $HOME 计算, 不依赖 /tmp, 不写死用户名)
static char g_base[PATH_MAX]        = {0};  // $HOME/LiteLoaderQQNT/native_stealth
static char g_mirror_index[PATH_MAX] = {0};
static char g_mirror_pkg[PATH_MAX]   = {0};
static char g_hit_log[PATH_MAX]      = {0};
static pthread_mutex_t path_mtx = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t log_mtx  = PTHREAD_MUTEX_INITIALIZER;

static void ensure_paths(void) {
    if (g_base[0]) return;
    pthread_mutex_lock(&path_mtx);
    if (!g_base[0]) {
        const char *home = getenv("HOME");
        if (!home || !home[0]) home = "/tmp"; // 最坏兜底
        snprintf(g_base, sizeof(g_base), "%s/LiteLoaderQQNT/native_stealth", home);
        snprintf(g_mirror_index, sizeof(g_mirror_index), "%s/stock_mirror/app_launcher/index.js", g_base);
        snprintf(g_mirror_pkg,   sizeof(g_mirror_pkg),   "%s/stock_mirror/package.json", g_base);
        snprintf(g_hit_log,      sizeof(g_hit_log),      "%s/hits.log", g_base);
    }
    pthread_mutex_unlock(&path_mtx);
}

// 用裸 syscall 落盘, 彻底绕开自己 interpose 的 open/write (防递归)
static void hit_log(const char *tag, const char *detail) {
    ensure_paths();
    if (!g_hit_log[0]) return;
    pthread_mutex_lock(&log_mtx);
    int fd = (int)syscall(SYS_open, g_hit_log, O_WRONLY|O_CREAT|O_APPEND, 0644);
    if (fd >= 0) {
        struct timespec ts; clock_gettime(CLOCK_REALTIME, &ts);
        char tbuf[64]; struct tm tm; localtime_r(&ts.tv_sec, &tm);
        strftime(tbuf, sizeof(tbuf), "%Y-%m-%d %H:%M:%S", &tm);
        char line[1400];
        int n = snprintf(line, sizeof(line), "[%s.%03ld][pid=%d] %s | %s\n",
                         tbuf, ts.tv_nsec/1000000, getpid(), tag, detail ? detail : "");
        if (n > 0) syscall(SYS_write, fd, line, (size_t)n);
        syscall(SYS_close, fd);
    }
    pthread_mutex_unlock(&log_mtx);
}

static int is_integrity_path(const char *p) {
    if (!p) return 0;
    return (strstr(p, "package.json") || strstr(p, "app_launcher") ||
            strstr(p, ".asar") || strstr(p, "wrapper.node") ||
            strstr(p, "major.node") || strstr(p, "_CodeSignature") ||
            strstr(p, "CodeResources") || strstr(p, "index.js")) ? 1 : 0;
}

static const char* redirect_path_if_needed(const char *path) {
    if (!path) return path;
    ensure_paths();
    if (strstr(path, "app_launcher/index.js") != NULL && g_mirror_index[0]) {
        hit_log("VFS-REDIRECT", path);
        return g_mirror_index;
    }
    if (strstr(path, "Resources/app/package.json") != NULL && g_mirror_pkg[0]) {
        hit_log("VFS-REDIRECT", path);
        return g_mirror_pkg;
    }
    if (is_integrity_path(path)) hit_log("FILE-READ(passthrough)", path);
    return path;
}

int my_open(const char *path, int oflag, ...) {
    const char *t = redirect_path_if_needed(path);
    if (oflag & O_CREAT) { va_list a; va_start(a,oflag); mode_t m=va_arg(a,int); va_end(a); return open(t,oflag,m); }
    return open(t, oflag);
}
DYLD_INTERPOSE(my_open, open);

int my_openat(int fd, const char *path, int oflag, ...) {
    const char *t = redirect_path_if_needed(path);
    if (oflag & O_CREAT) { va_list a; va_start(a,oflag); mode_t m=va_arg(a,int); va_end(a); return openat(fd,t,oflag,m); }
    return openat(fd, t, oflag);
}
DYLD_INTERPOSE(my_openat, openat);

FILE *my_fopen(const char *filename, const char *mode) {
    return fopen(redirect_path_if_needed(filename), mode);
}
DYLD_INTERPOSE(my_fopen, fopen);

int my_stat(const char *path, struct stat *buf) { return stat(redirect_path_if_needed(path), buf); }
DYLD_INTERPOSE(my_stat, stat);

int my_lstat(const char *path, struct stat *buf) { return lstat(redirect_path_if_needed(path), buf); }
DYLD_INTERPOSE(my_lstat, lstat);

OSStatus my_SecCodeCheckValidity(SecCodeRef c, SecCSFlags f, SecRequirementRef r) {
    hit_log("SecCodeCheckValidity", "forced errSecSuccess"); return errSecSuccess;
}
DYLD_INTERPOSE(my_SecCodeCheckValidity, SecCodeCheckValidity);

OSStatus my_SecStaticCodeCheckValidity(SecStaticCodeRef c, SecCSFlags f, SecRequirementRef r) {
    hit_log("SecStaticCodeCheckValidity", "forced errSecSuccess"); return errSecSuccess;
}
DYLD_INTERPOSE(my_SecStaticCodeCheckValidity, SecStaticCodeCheckValidity);

OSStatus my_SecCodeCopySigningInformation(SecStaticCodeRef code, SecCSFlags flags, CFDictionaryRef *info) {
    OSStatus st = SecCodeCopySigningInformation(code, flags, info);
    hit_log("SecCodeCopySigningInformation", "inject official teamid");
    if (st == errSecSuccess && info && *info) {
        CFMutableDictionaryRef m = CFDictionaryCreateMutableCopy(kCFAllocatorDefault, 0, *info);
        if (m) {
            CFStringRef tv = CFStringCreateWithCString(kCFAllocatorDefault, OFFICIAL_TEAM_ID, kCFStringEncodingUTF8);
            CFDictionarySetValue(m, CFSTR("teamid"), tv); CFRelease(tv);
            CFStringRef iv = CFStringCreateWithCString(kCFAllocatorDefault, OFFICIAL_IDENTIFIER, kCFStringEncodingUTF8);
            CFDictionarySetValue(m, CFSTR("identifier"), iv); CFRelease(iv);
            CFRelease(*info); *info = m;
        }
    }
    return errSecSuccess;
}
DYLD_INTERPOSE(my_SecCodeCopySigningInformation, SecCodeCopySigningInformation);

__attribute__((constructor))
static void stealth_init(void) {
    ensure_paths();
    hit_log("INIT", "dylib constructor loaded (persistent paths)");
}
