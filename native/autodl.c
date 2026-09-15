/*
 * ════════════════════════════════════════════════════════════════════
 *  AutoDownloader — autodl.c  (native multi-connection downloader)
 * ════════════════════════════════════════════════════════════════════
 *  - Windows : WinHTTP backend → full HTTP + HTTPS support
 *  - Linux   : raw-socket backend (HTTP) — reference / test build
 *
 *  BUILD with MinGW-w64 x64  →  autodl.exe :
 *      x86_64-w64-mingw32-gcc -O2 -o autodl.exe autodl.c -lwinhttp -s
 *    (or inside MSYS2 MinGW64 shell:)
 *      gcc -O2 -o autodl.exe autodl.c -lwinhttp -s
 *
 *  BUILD on Linux (test build):
 *      gcc -O2 -o autodl autodl.c -lpthread
 *
 *  Zero dependencies · single translation unit · no CRT needed on Windows.
 * ════════════════════════════════════════════════════════════════════
 */
#ifndef AD_WIN
#  define _DEFAULT_SOURCE 1
#  define _POSIX_C_SOURCE 200809L
#endif

#include <stdint.h>
#include <stddef.h>

#if defined(AD_WIN)
#  define AD_WIN 1
#  include <uchar.h>   /* char16_t — 16-bit on every supported target */
#endif

#define AD_MAX_CONN     32
#define AD_MAX_CHUNKS   2048
#define AD_MIN_CHUNK    (512u * 1024u)
#define AD_RBUF         (256u * 1024u)
#define AD_MAX_URL      4096
#define AD_UNKNOWN_LEN  UINT64_MAX

#if defined(AD_WIN)
/* ═══════════════ minimal Win32 / WinHTTP declarations ═══════════════
 * Only what we use. This file compiles with or without the Windows SDK
 * (and even on a Linux host, for the PE-builder path).                  */

typedef unsigned long  DWORD;
typedef unsigned short WORD;
typedef int            BOOL;
typedef unsigned int   UINT;
typedef void          *HANDLE;
typedef void          *HINTERNET;
typedef void          *LPVOID;
typedef unsigned long long AD_QWORD;

typedef struct { DWORD dwLowDateTime; DWORD dwHighDateTime; } AD_FILETIME;
typedef struct { long long QuadPart; } AD_LARGE;
typedef struct { unsigned long long a, b; uint64_t off; void* ev; } AD_OVERLAPPED;

#define AD_INVALID_HANDLE  ((HANDLE)(long long)-1)
#define AD_INFINITE        0xFFFFFFFFu
#define AD_GENERIC_WRITE   0x40000000u
#define AD_GENERIC_READ    0x80000000u
#define AD_SHARE_READ      0x00000001u
#define AD_OPEN_ALWAYS     4u
#define AD_OPEN_EXISTING   3u
#define AD_CREATE_ALWAYS   2u
#define AD_FILE_NORMAL     0x00000080u
#define AD_INVALID_ATTRS   0xFFFFFFFFu
#define AD_FILE_DIR        0x00000010u
#define AD_FILE_BEGIN      0u
#define AD_MOVE_REPLACE    0x00000001u
#define AD_STD_OUTPUT      ((DWORD)-11)
#define AD_FILE_TYPE_CHAR  2u
#define AD_CP_UTF8         65001u
#define AD_ENABLE_VT       0x0004u

/* kernel32 */
extern HANDLE    CreateFileW(const char16_t*, DWORD, DWORD, LPVOID, DWORD, DWORD, HANDLE);
extern BOOL      ReadFile(HANDLE, LPVOID, DWORD, DWORD*, LPVOID);
extern BOOL      WriteFile(HANDLE, const void*, DWORD, DWORD*, LPVOID);
extern BOOL      CloseHandle(HANDLE);
extern DWORD     GetFileAttributesW(const char16_t*);
extern BOOL      GetFileSizeEx(HANDLE, AD_LARGE*);
extern BOOL      SetFilePointerEx(HANDLE, AD_LARGE, AD_LARGE*, DWORD);
extern BOOL      SetEndOfFile(HANDLE);
extern BOOL      MoveFileExW(const char16_t*, const char16_t*, DWORD);
extern BOOL      DeleteFileW(const char16_t*);
extern BOOL      CreateDirectoryW(const char16_t*, LPVOID);
extern HANDLE    CreateThread(LPVOID, unsigned long long, unsigned long (*fn)(LPVOID), LPVOID, DWORD, DWORD*);
extern DWORD     WaitForSingleObject(HANDLE, DWORD);
extern void      Sleep(DWORD);
extern void      ExitProcess(UINT);
extern char16_t* GetCommandLineW(void);
extern void      GetSystemTimeAsFileTime(AD_FILETIME*);
extern HANDLE    GetStdHandle(DWORD);
extern DWORD     GetFileType(HANDLE);
extern BOOL      SetConsoleOutputCP(UINT);
extern int       MultiByteToWideChar(UINT, DWORD, const char*, int, char16_t*, int);
extern int       WideCharToMultiByte(UINT, DWORD, const char16_t*, int, char*, int, const char*, int*);
extern void      AcquireSRWLockExclusive(void*);
extern void      ReleaseSRWLockExclusive(void*);
extern BOOL      SleepConditionVariableSRW(void*, void*, DWORD, DWORD);
extern void      WakeAllConditionVariable(void*);

/* winhttp (the API is Unicode-only; exported names carry no W suffix) */
extern HINTERNET WinHttpOpen(const char16_t*, DWORD, const char16_t*, const char16_t*, DWORD);
extern HINTERNET WinHttpConnect(HINTERNET, const char16_t*, WORD, DWORD);
extern HINTERNET WinHttpOpenRequest(HINTERNET, const char16_t*, const char16_t*, const char16_t*,
                                    const char16_t*, const char16_t**, DWORD);
extern BOOL      WinHttpAddRequestHeaders(HINTERNET, const char16_t*, DWORD, DWORD);
extern BOOL      WinHttpSetTimeouts(HINTERNET, int, int, int, int);
extern BOOL      WinHttpSendRequest(HINTERNET, const char16_t*, DWORD, LPVOID, DWORD, DWORD, AD_QWORD);
extern BOOL      WinHttpReceiveResponse(HINTERNET, LPVOID);
extern BOOL      WinHttpQueryHeaders(HINTERNET, DWORD, const char16_t*, LPVOID, DWORD*, DWORD*);
extern BOOL      WinHttpQueryDataAvailable(HINTERNET, DWORD*);
extern BOOL      WinHttpRead(HINTERNET, LPVOID, DWORD, DWORD*);
extern BOOL      WinHttpCloseHandle(HINTERNET);
extern BOOL      WinHttpCrackUrl(const char16_t*, DWORD, DWORD, void*);

#define AD_WH_ACCESS_DEFAULT 0u
#define AD_WH_FLAG_SECURE    0x00800000u
#define AD_WH_ADDREQ_ADD     0x20000000u
#define AD_WH_QUERY_CUSTOM   0xFFFFu
#define AD_WH_QUERY_NUMBER   0x20000000u
#define AD_WH_QUERY_STATUS   19u

typedef struct {
  DWORD     dwStructSize;          /* 0  */
  char16_t* lpszScheme;            /* 8  */
  DWORD     dwSchemeLength;        /* 16 */
  unsigned  nScheme;               /* 20 */
  char16_t* lpszHostName;          /* 24 */
  DWORD     dwHostNameLength;      /* 32 */
  WORD      nPort;                 /* 36 */
  char16_t* lpszUserName;          /* 40 */
  DWORD     dwUserNameLength;      /* 48 */
  char16_t* lpszPassword;          /* 56 */
  DWORD     dwPasswordLength;      /* 64 */
  char16_t* lpszUrlPath;           /* 72 */
  DWORD     dwUrlPathLength;       /* 80 */
  char16_t* lpszExtraInfo;         /* 88 */
  DWORD     dwExtraInfoLength;     /* 96 */
} AD_URL_COMPONENTS;               /* sizeof == 104 */

#else /* Linux test build */
#  include <stdio.h>
#  include <stdlib.h>
#  include <string.h>
#  include <unistd.h>
#  include <errno.h>
#  include <fcntl.h>
#  include <signal.h>
#  include <time.h>
#  include <pthread.h>
#  include <sys/stat.h>
#  include <sys/types.h>
#  include <sys/socket.h>
#  include <netdb.h>
#  include <netinet/in.h>
#  include <arpa/inet.h>
#endif

/* ═════════════════ tiny string helpers (used on every platform) ═════════════════ */
static void ad_strcpy(char* d, size_t cap, const char* s) {
  size_t i = 0;
  if (!cap) return;
  while (s[i] && i + 1 < cap) { d[i] = s[i]; i++; }
  d[i] = 0;
}
static void ad_strcat(char* d, size_t cap, const char* s) {
  size_t n = 0;
  while (n < cap && d[n]) n++;
  if (n < cap) ad_strcpy(d + n, cap - n, s);
}
static int ad_ci_eq(const char* a, const char* b) {
  while (*a && *b) {
    char x = *a, y = *b;
    if (x >= 'A' && x <= 'Z') x = (char)(x - 'A' + 'a');
    if (y >= 'A' && y <= 'Z') y = (char)(y - 'A' + 'a');
    if (x != y) return 0;
    a++; b++;
  }
  return *a == 0 && *b == 0;
}
static int ad_ci_starts(const char* s, const char* pre) {
  while (*pre) {
    char x = *s, y = *pre;
    if (x >= 'A' && x <= 'Z') x = (char)(x - 'A' + 'a');
    if (y >= 'A' && y <= 'Z') y = (char)(y - 'A' + 'a');
    if (x != y) return 0;
    s++; pre++;
  }
  return 1;
}
static int ad_hexval(int c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}
static void ad_pct_decode(char* s) {  /* in place */
  char* o = s;
  while (*s) {
    if (*s == '%' && ad_hexval(s[1]) >= 0 && ad_hexval(s[2]) >= 0) {
      *o++ = (char)(ad_hexval(s[1]) * 16 + ad_hexval(s[2]));
      s += 3;
    } else *o++ = *s++;
  }
  *o = 0;
}

#ifdef AD_WIN
static void* ad_memset(void* d, int c, size_t n) {
  unsigned char* p = (unsigned char*)d;
  while (n--) *p++ = (unsigned char)c;
  return d;
}
static void* ad_memcpy(void* d, const void* s, size_t n) {
  unsigned char* p = (unsigned char*)d; const unsigned char* q = (const unsigned char*)s;
  while (n--) *p++ = *q++;
  return d;
}
static int ad_memcmp(const void* a, const void* b, size_t n) {
  const unsigned char* p = (const unsigned char*)a, *q = (const unsigned char*)b;
  for (; n--; p++, q++) if (*p != *q) return *p - *q;
  return 0;
}
static size_t ad_strlen(const char* s) { size_t n = 0; while (s[n]) n++; return n; }
static int ad_strcmp(const char* a, const char* b) {
  while (*a && *a == *b) { a++; b++; }
  return (int)(unsigned char)*a - (int)(unsigned char)*b;
}
static char* ad_strchr(const char* s, int c) {
  for (; *s; s++) if (*s == (char)c) return (char*)s;
  return 0;
}
static char* ad_strrchr(const char* s, int c) {
  const char* last = 0;
  for (; *s; s++) if (*s == (char)c) last = s;
  return (char*)last;
}
static uint64_t ad_strtou64(const char* s) {
  uint64_t v = 0;
  while (*s == ' ' || (*s >= 9 && *s <= 13)) s++;
  while (*s >= '0' && *s <= '9') { v = v * 10u + (uint64_t)(*s - '0'); s++; }
  return v;
}
static char* ad_strstr(const char* h, const char* n) {
  if (!*n) return (char*)h;
  for (; *h; h++) {
    const char* a = h; const char* b = n;
    while (*a && *b && *a == *b) { a++; b++; }
    if (!*b) return (char*)h;
  }
  return 0;
}
/* the shared engine code uses libc names — alias them to our freestanding impls */
#  define strstr   ad_strstr
#  define strchr   ad_strchr
#  define strrchr  ad_strrchr
#  define strlen   ad_strlen
#  define strcmp   ad_strcmp
#  define memcmp   ad_memcmp
#  define memcpy   ad_memcpy
#  define memset   ad_memset
#else
#  define ad_memset   memset
#  define ad_memcpy   memcpy
#  define ad_memcmp   memcmp
#  define ad_strlen   strlen
#  define ad_strcmp   strcmp
#  define ad_strchr   strchr
#  define ad_strrchr  strrchr
#  define ad_strtou64(S) ((uint64_t)strtoull((S), 0, 10))
#endif

/* ═════════════════ string builder ═════════════════ */
typedef struct { char* p; size_t cap, n; } sbuf;
static void sb_init(sbuf* b, char* buf, size_t cap) { b->p = buf; b->cap = cap; b->n = 0; if (cap) buf[0] = 0; }
static void sb_putc(sbuf* b, char c) { if (b->n + 1 < b->cap) { b->p[b->n++] = c; b->p[b->n] = 0; } }
static void sb_puts(sbuf* b, const char* s) { while (*s) sb_putc(b, *s++); }
static void sb_putu(sbuf* b, uint64_t v) {
  char t[24]; int i = 0;
  if (!v) { sb_putc(b, '0'); return; }
  while (v) { t[i++] = (char)('0' + (v % 10u)); v /= 10u; }
  while (i) sb_putc(b, t[--i]);
}
static void sb_putd1(sbuf* b, uint64_t tenths) {
  sb_putu(b, tenths / 10u);
  sb_putc(b, '.');
  sb_putc(b, (char)('0' + (tenths % 10u)));
}
static void sb_fmt_size(sbuf* b, uint64_t bytes) {
  static const char* u[] = { "B", "KB", "MB", "GB", "TB" };
  int ui;
  uint64_t tenths;
  if (bytes < 1024u) { sb_putu(b, bytes); sb_puts(b, " B"); return; }
  ui = 1;
  while (ui < 4 && bytes >= (1ull << (10u * (unsigned)(ui + 1)))) ui++;
  tenths = (bytes * 10ull) >> (10u * (unsigned)ui);
  sb_putd1(b, tenths);
  sb_putc(b, ' ');
  sb_puts(b, u[ui]);
}
static void sb_fmt_eta(sbuf* b, uint64_t sec) {
  if (sec >= 3600u) { sb_putu(b, sec / 3600u); sb_putc(b, ':'); if ((sec % 3600u) < 600u) sb_putc(b, '0'); }
  if (sec >= 60u)  { sb_putu(b, (sec % 3600u) / 60u); sb_putc(b, ':'); }
  else sb_puts(b, "0:");
  if ((sec % 60u) < 10u) sb_putc(b, '0');
  sb_putu(b, sec % 60u);
}

/* ═════════════════ platform layer ═════════════════ */
#ifdef AD_WIN

typedef HANDLE ad_fd_t;
#define AD_BAD_FD ((ad_fd_t)AD_INVALID_HANDLE)

static int ad_u8_to_u16(const char* s, char16_t* out, int cap) {
  int n = MultiByteToWideChar(AD_CP_UTF8, 0, s, -1, out, cap);
  return n > 0 ? n : 0;
}
static int ad_u16_to_u8(const char16_t* s, char* out, int cap) {
  int n = WideCharToMultiByte(AD_CP_UTF8, 0, s, -1, out, cap, 0, 0);
  return n > 0 ? n : 0;
}
static uint64_t ad_ms(void) {
  AD_FILETIME ft;
  uint64_t v;
  GetSystemTimeAsFileTime(&ft);
  v = ((uint64_t)ft.dwHighDateTime << 32) | ft.dwLowDateTime;
  return v / 10000u - 11644473600000ull;
}
static void ad_sleep_ms(uint64_t ms) { Sleep((DWORD)ms); }

typedef struct { void* srw; } ad_mutex_t;   /* zero-initialized */
typedef struct { void* cv;  } ad_cond_t;    /* zero-initialized */
#define AD_MUTEX_INIT { 0 }
#define AD_COND_INIT  { 0 }
static void ad_mu_lock(ad_mutex_t* m)   { AcquireSRWLockExclusive(&m->srw); }
static void ad_mu_unlock(ad_mutex_t* m) { ReleaseSRWLockExclusive(&m->srw); }
static void ad_cv_wait(ad_cond_t* c, ad_mutex_t* m, uint64_t ms) { SleepConditionVariableSRW(&c->cv, &m->srw, (DWORD)ms, 0); }
static void ad_cv_wake(ad_cond_t* c) { WakeAllConditionVariable(&c->cv); }

typedef HANDLE ad_thread_t;
typedef unsigned long ad_thread_ret_t;
typedef unsigned long (*ad_thread_fn_t)(void*);

#ifdef AD_PE
/* PE build (SysV codegen) — route through a tiny trampoline injected by the builder */
extern void ad_pe_thread_thunk(void);
typedef struct { ad_thread_fn_t fn; void* arg; } ad_thunk_ctx;
static ad_thunk_ctx g_thunk_ctx[AD_MAX_CONN];
static int ad_thread_start(ad_thread_t* out, ad_thread_fn_t fn, void* arg, int slot) {
  if (slot < 0 || slot >= AD_MAX_CONN) return -1;
  g_thunk_ctx[slot].fn = fn;
  g_thunk_ctx[slot].arg = arg;
  *out = CreateThread(0, 0, (ad_thread_fn_t)ad_pe_thread_thunk, &g_thunk_ctx[slot], 0, 0);
  return *out ? 0 : -1;
}
#else
static int ad_thread_start(ad_thread_t* out, ad_thread_fn_t fn, void* arg, int slot) {
  (void)slot;
  *out = CreateThread(0, 0, fn, arg, 0, 0);
  return *out ? 0 : -1;
}
#endif
static void ad_thread_join(ad_thread_t t) { WaitForSingleObject(t, AD_INFINITE); CloseHandle(t); }

static ad_fd_t ad_file_open_rw(const char* path, int trunc) {
  char16_t w[1400];
  if (!ad_u8_to_u16(path, w, 1400)) return AD_BAD_FD;
  return CreateFileW(w, AD_GENERIC_READ | AD_GENERIC_WRITE, AD_SHARE_READ, 0,
                     trunc ? AD_CREATE_ALWAYS : AD_OPEN_ALWAYS, AD_FILE_NORMAL, 0);
}
static int ad_file_write_at(ad_fd_t f, const void* buf, size_t len, uint64_t off) {
  const unsigned char* p = (const unsigned char*)buf;
  while (len) {
    DWORD chunk = (len > (32u * 1024u * 1024u)) ? (32u * 1024u * 1024u) : (DWORD)len;
    DWORD wrote = 0;
    AD_OVERLAPPED ov;
    ov.a = 0; ov.b = 0; ov.off = off; ov.ev = 0;
    if (!WriteFile(f, p, chunk, &wrote, (LPVOID)&ov) || wrote != chunk) return -1;
    p += chunk; off += chunk; len -= chunk;
  }
  return 0;
}
static int ad_file_truncate(ad_fd_t f, uint64_t size) {
  AD_LARGE li; AD_LARGE out;
  li.QuadPart = (long long)size;
  if (!SetFilePointerEx(f, li, &out, AD_FILE_BEGIN)) return -1;
  return SetEndOfFile(f) ? 0 : -1;
}
static void ad_file_close(ad_fd_t f) { if (f != AD_BAD_FD) CloseHandle(f); }
static int ad_file_read_all(const char* path, unsigned char* buf, size_t cap, size_t* out_len) {
  char16_t w[1400];
  HANDLE h;
  DWORD got = 0;
  if (!ad_u8_to_u16(path, w, 1400)) return -1;
  h = CreateFileW(w, AD_GENERIC_READ, AD_SHARE_READ, 0, AD_OPEN_EXISTING, AD_FILE_NORMAL, 0);
  if (h == AD_INVALID_HANDLE) return -1;
  *out_len = 0;
  while (*out_len < cap && ReadFile(h, buf + *out_len, (DWORD)(cap - *out_len), &got, 0) && got) *out_len += got;
  CloseHandle(h);
  return 0;
}
static int ad_file_size(const char* path, uint64_t* out) {
  char16_t w[1400];
  HANDLE h;
  AD_LARGE li;
  BOOL ok;
  if (!ad_u8_to_u16(path, w, 1400)) return -1;
  h = CreateFileW(w, AD_GENERIC_READ, AD_SHARE_READ, 0, AD_OPEN_EXISTING, AD_FILE_NORMAL, 0);
  if (h == AD_INVALID_HANDLE) return -1;
  ok = GetFileSizeEx(h, &li);
  CloseHandle(h);
  if (ok) *out = (uint64_t)li.QuadPart;
  return ok ? 0 : -1;
}
static int ad_file_exists(const char* path) {
  char16_t w[1400];
  DWORD a;
  if (!ad_u8_to_u16(path, w, 1400)) return 0;
  a = GetFileAttributesW(w);
  return a != AD_INVALID_ATTRS && !(a & AD_FILE_DIR);
}
static int ad_file_rename(const char* a, const char* b) {
  char16_t wa[1400], wb[1400];
  if (!ad_u8_to_u16(a, wa, 1400) || !ad_u8_to_u16(b, wb, 1400)) return -1;
  return MoveFileExW(wa, wb, AD_MOVE_REPLACE) ? 0 : -1;
}
static int ad_file_remove(const char* p) {
  char16_t w[1400];
  if (!ad_u8_to_u16(p, w, 1400)) return -1;
  return DeleteFileW(w) ? 0 : -1;
}
static int ad_mkdir_one(const char* path) {
  char16_t w[1400];
  if (!ad_u8_to_u16(path, w, 1400)) return -1;
  if (CreateDirectoryW(w, 0)) return 0;
  return ad_file_exists(path) ? 0 : -1;
}

#else /* ── Linux ── */

typedef int ad_fd_t;
#define AD_BAD_FD (-1)

static uint64_t ad_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_REALTIME, &ts);
  return (uint64_t)ts.tv_sec * 1000u + (uint64_t)ts.tv_nsec / 1000000u;
}
static void ad_sleep_ms(uint64_t ms) {
  struct timespec ts;
  ts.tv_sec = (time_t)(ms / 1000u);
  ts.tv_nsec = (long)((ms % 1000u) * 1000000u);
  nanosleep(&ts, 0);
}

typedef pthread_mutex_t ad_mutex_t;
typedef pthread_cond_t  ad_cond_t;
#define AD_MUTEX_INIT PTHREAD_MUTEX_INITIALIZER
#define AD_COND_INIT  PTHREAD_COND_INITIALIZER
static void ad_mu_lock(ad_mutex_t* m)   { pthread_mutex_lock(m); }
static void ad_mu_unlock(ad_mutex_t* m) { pthread_mutex_unlock(m); }
static void ad_cv_wait(ad_cond_t* c, ad_mutex_t* m, uint64_t ms) {
  struct timespec ts;
  clock_gettime(CLOCK_REALTIME, &ts);
  ts.tv_sec += (time_t)(ms / 1000u);
  ts.tv_nsec += (long)((ms % 1000u) * 1000000u);
  if (ts.tv_nsec >= 1000000000L) { ts.tv_sec++; ts.tv_nsec -= 1000000000L; }
  pthread_cond_timedwait(c, m, &ts);
}
static void ad_cv_wake(ad_cond_t* c) { pthread_cond_broadcast(c); }

typedef pthread_t ad_thread_t;
typedef void* ad_thread_ret_t;
typedef void* (*ad_thread_fn_t)(void*);
static int ad_thread_start(ad_thread_t* out, ad_thread_fn_t fn, void* arg, int slot) {
  (void)slot;
  return pthread_create(out, 0, fn, arg);
}
static void ad_thread_join(ad_thread_t t) { pthread_join(t, 0); }

static ad_fd_t ad_file_open_rw(const char* path, int trunc) {
  return open(path, O_RDWR | O_CREAT | (trunc ? O_TRUNC : 0), 0644);
}
static int ad_file_write_at(ad_fd_t f, const void* buf, size_t len, uint64_t off) {
  const unsigned char* p = (const unsigned char*)buf;
  while (len) {
    ssize_t n = pwrite(f, p, len, (off_t)off);
    if (n <= 0) return -1;
    p += n; off += (uint64_t)n; len -= (size_t)n;
  }
  return 0;
}
static int ad_file_truncate(ad_fd_t f, uint64_t size) { return ftruncate(f, (off_t)size); }
static void ad_file_close(ad_fd_t f) { if (f != AD_BAD_FD) close(f); }
static int ad_file_read_all(const char* path, unsigned char* buf, size_t cap, size_t* out_len) {
  int fd = open(path, O_RDONLY);
  size_t got = 0;
  ssize_t n;
  if (fd < 0) return -1;
  while (got < cap && (n = read(fd, buf + got, cap - got)) > 0) got += (size_t)n;
  close(fd);
  *out_len = got;
  return 0;
}
static int ad_file_size(const char* path, uint64_t* out) {
  struct stat st;
  if (stat(path, &st)) return -1;
  *out = (uint64_t)st.st_size;
  return 0;
}
static int ad_file_exists(const char* path) {
  struct stat st;
  return stat(path, &st) == 0 && S_ISREG(st.st_mode);
}
static int ad_file_rename(const char* a, const char* b) { return rename(a, b); }
static int ad_file_remove(const char* p) { return unlink(p); }
static int ad_mkdir_one(const char* path) {
  if (mkdir(path, 0755) == 0) return 0;
  return errno == EEXIST ? 0 : -1;
}

static volatile int g_interrupt = 0;
static void ad_on_sig(int s) { (void)s; g_interrupt = 1; }
static void ad_install_signals(void) {
  struct sigaction sa;
  ad_memset(&sa, 0, sizeof sa);
  sa.sa_handler = ad_on_sig;
  sigaction(SIGINT, &sa, 0);
  sigaction(SIGTERM, &sa, 0);
}
#endif

/* recursive mkdir over a utf8 path with '/' (or '\\') separators */
static void ad_mkdir_p(const char* path) {
  char tmp[1400];
  size_t len = ad_strlen(path), i;
  if (!len || len >= sizeof tmp) return;
  ad_memcpy(tmp, path, len + 1);
  for (i = 1; i <= len; i++) {
    char c = tmp[i];
    size_t l;
    if (c != '/' && c != '\\' && i != len) continue;
    tmp[i] = 0;
    l = ad_strlen(tmp);
    if (l && ad_strcmp(tmp, "/") && ad_strcmp(tmp, "\\") && tmp[l - 1] != ':')
      ad_mkdir_one(tmp);
    tmp[i] = c;
  }
}

/* ═════════════════ console ═════════════════ */
#ifdef AD_WIN
static HANDLE g_stdout = 0;
static int g_color = 0, g_is_tty = 0;
static void con_init(void) {
  g_stdout = GetStdHandle(AD_STD_OUTPUT);
  g_is_tty = (GetFileType(g_stdout) == AD_FILE_TYPE_CHAR);
  SetConsoleOutputCP(AD_CP_UTF8);
}
static void con_write(const char* s) {
  DWORD wrote = 0;
  size_t len = ad_strlen(s);
  while (len) {
    DWORD part = (DWORD)(len > 65536u ? 65536u : len);
    if (!WriteFile(g_stdout, s, part, &wrote, 0) || !wrote) break;
    s += wrote; len -= wrote;
  }
}
#else
static int g_color = 0, g_is_tty = 0;
static void con_init(void) {
  g_is_tty = isatty(1);
  g_color = g_is_tty;
  setvbuf(stdout, 0, _IONBF, 0);
}
static void con_write(const char* s) { (void)!write(1, s, strlen(s)); }
#endif

#define C_CYAN   "\x1b[36m"
#define C_GREEN  "\x1b[32m"
#define C_YELLOW "\x1b[33m"
#define C_RED    "\x1b[31m"
#define C_DIM    "\x1b[90m"
#define C_RESET  "\x1b[0m"
static void say(const char* s) { con_write(s); }

/* ═════════════════ HTTP layer ═════════════════ */
typedef struct {
  int      status;
  uint64_t content_length;   /* entity length of this response (0 = unknown) */
  uint64_t remaining;        /* body bytes left (AD_UNKNOWN_LEN = until EOF)  */
  char     hdr_etag[160];
  char     hdr_last_modified[96];
  char     hdr_content_disposition[512];
  char     hdr_accept_ranges[24];
  char     hdr_content_range[96];
  char     hdr_location[1024];
#ifdef AD_WIN
  HINTERNET hreq, hconn;
#else
  int      fd;
  unsigned char pre[16384];
  size_t   pre_len, pre_pos;
#endif
} http_stream;

static uint64_t content_range_total(const char* cr) {
  const char* slash = ad_strchr(cr, '/');
  if (!slash) return 0;
  if (slash[1] == '*' || slash[1] == 0) return 0;
  return ad_strtou64(slash + 1);
}

#ifdef AD_WIN
/* ═══════════ WinHTTP backend (http + https) ═══════════ */
static HINTERNET g_wh_session = 0;

static int wh_hdr(HINTERNET req, const char* name, char* out, size_t outlen) {
  char16_t wname[48], wbuf[600];
  DWORD sz;
  out[0] = 0;
  if (!ad_u8_to_u16(name, wname, 48)) return 0;
  sz = (DWORD)sizeof wbuf;
  if (WinHttpQueryHeaders(req, AD_WH_QUERY_CUSTOM, wname, wbuf, &sz, 0) && sz >= 2)
    return ad_u16_to_u8(wbuf, out, (int)outlen);
  return 0;
}

static int http_open(http_stream* s, const char* url, const char* method,
                     uint64_t rstart, int has_range, uint64_t rend,
                     const char* ua, const char* referer,
                     char* err, size_t errlen) {
  char16_t agent[24], wurl[2100];
  char16_t wscheme[16], whost[300], wuser[300], wpass[300], wpath[2048], wextra[1024];
  char16_t wmethod[8], fullpath[3072];
  char scheme[16], hs[2048];
  AD_URL_COMPONENTS uc;
  HINTERNET conn, req;
  sbuf b;
  DWORD st = 0, szst = sizeof st;
  size_t n = 0;
  int secure;

  s->hreq = s->hconn = 0;
  if (err) err[0] = 0;
  if (!g_wh_session) {
    ad_u8_to_u16("autodl/1.0", agent, 24);
    g_wh_session = WinHttpOpen(agent, AD_WH_ACCESS_DEFAULT, 0, 0, 0);
  }
  if (!g_wh_session) { if (err) ad_strcpy(err, errlen, "cannot start WinHTTP"); return -1; }
  if (ad_strlen(url) > 2000 || !ad_u8_to_u16(url, wurl, 2100)) {
    if (err) ad_strcpy(err, errlen, "URL too long");
    return -1;
  }

  ad_memset(&uc, 0, sizeof uc);
  uc.dwStructSize = (DWORD)sizeof(AD_URL_COMPONENTS);
  uc.lpszScheme = wscheme;     uc.dwSchemeLength = 15;
  uc.lpszHostName = whost;     uc.dwHostNameLength = 299;
  uc.lpszUserName = wuser;     uc.dwUserNameLength = 299;
  uc.lpszPassword = wpass;     uc.dwPasswordLength = 299;
  uc.lpszUrlPath = wpath;      uc.dwUrlPathLength = 2047;
  uc.lpszExtraInfo = wextra;   uc.dwExtraInfoLength = 1023;
  if (!WinHttpCrackUrl(wurl, 0, 0, &uc)) {
    if (err) ad_strcpy(err, errlen, "invalid URL");
    return -1;
  }
  wscheme[uc.dwSchemeLength < 16 ? uc.dwSchemeLength : 15] = 0;
  whost[uc.dwHostNameLength < 300 ? uc.dwHostNameLength : 299] = 0;
  wpath[uc.dwUrlPathLength < 2048 ? uc.dwUrlPathLength : 2047] = 0;
  wextra[uc.dwExtraInfoLength < 1024 ? uc.dwExtraInfoLength : 1023] = 0;
  ad_u16_to_u8(wscheme, scheme, sizeof scheme);
  secure = ad_ci_eq(scheme, "https");

  n = 0;
  if (!wpath[0]) fullpath[n++] = (char16_t)'/';
  for (size_t i = 0; wpath[i] && n < 3070; i++) fullpath[n++] = wpath[i];
  for (size_t i = 0; wextra[i] && n < 3070; i++) fullpath[n++] = wextra[i];
  fullpath[n] = 0;

  conn = WinHttpConnect(g_wh_session, whost, uc.nPort, 0);
  if (!conn) { if (err) ad_strcpy(err, errlen, "connect failed"); return -1; }
  ad_u8_to_u16(method, wmethod, 8);
  req = WinHttpOpenRequest(conn, wmethod, fullpath, 0, 0, 0, secure ? AD_WH_FLAG_SECURE : 0);
  if (!req) {
    WinHttpCloseHandle(conn);
    if (err) ad_strcpy(err, errlen, "request failed");
    return -1;
  }
  WinHttpSetTimeouts(req, 15000, 15000, 30000, 30000);

  sb_init(&b, hs, sizeof hs);
  if (ua && *ua)      { sb_puts(&b, "User-Agent: "); sb_puts(&b, ua); sb_puts(&b, "\r\n"); }
  if (referer && *referer) { sb_puts(&b, "Referer: "); sb_puts(&b, referer); sb_puts(&b, "\r\n"); }
  if (has_range) {
    sb_puts(&b, "Range: bytes=");
    sb_putu(&b, rstart); sb_putc(&b, '-');
    if (rend) sb_putu(&b, rend);
    sb_puts(&b, "\r\n");
  }
  if (b.n) {
    char16_t whdrs[2100];
    ad_u8_to_u16(hs, whdrs, 2100);
    WinHttpAddRequestHeaders(req, whdrs, (DWORD)-1, AD_WH_ADDREQ_ADD);
  }

  if (!WinHttpSendRequest(req, 0, 0, 0, 0, 0, 0) || !WinHttpReceiveResponse(req, 0)) {
    if (err) ad_strcpy(err, errlen, "network error");
    WinHttpCloseHandle(req); WinHttpCloseHandle(conn);
    return -1;
  }

  WinHttpQueryHeaders(req, AD_WH_QUERY_STATUS | AD_WH_QUERY_NUMBER, 0, &st, &szst, 0);
  s->status = (int)st;
  {
    char v[32];
    if (wh_hdr(req, "Content-Length", v, sizeof v)) s->content_length = ad_strtou64(v);
  }
  wh_hdr(req, "ETag", s->hdr_etag, sizeof s->hdr_etag);
  wh_hdr(req, "Last-Modified", s->hdr_last_modified, sizeof s->hdr_last_modified);
  wh_hdr(req, "Content-Disposition", s->hdr_content_disposition, sizeof s->hdr_content_disposition);
  wh_hdr(req, "Accept-Ranges", s->hdr_accept_ranges, sizeof s->hdr_accept_ranges);
  wh_hdr(req, "Content-Range", s->hdr_content_range, sizeof s->hdr_content_range);
  s->remaining = s->content_length ? s->content_length : AD_UNKNOWN_LEN;
  s->hreq = req;
  s->hconn = conn;
  return 0;
}

static size_t http_read(http_stream* s, void* buf, size_t cap) {
  DWORD avail = 0, got = 0;
  if (s->remaining == 0) return 0;
  if (!WinHttpQueryDataAvailable(s->hreq, &avail)) return (size_t)-1;
  if (avail == 0) { s->remaining = 0; return 0; }
  if (s->remaining != AD_UNKNOWN_LEN && (uint64_t)avail > s->remaining) avail = (DWORD)s->remaining;
  if ((size_t)avail > cap) avail = (DWORD)cap;
  if (!WinHttpRead(s->hreq, buf, avail, &got)) return (size_t)-1;
  if (s->remaining != AD_UNKNOWN_LEN) s->remaining -= got;
  return got;
}
static void http_close(http_stream* s) {
  if (s->hreq) WinHttpCloseHandle(s->hreq);
  if (s->hconn) WinHttpCloseHandle(s->hconn);
  s->hreq = s->hconn = 0;
}

#else
/* ═══════════ raw-socket backend (http:// only — test build) ═══════════ */
typedef struct { char scheme[12]; char host[300]; char path[2100]; int port; } urlparts_t;

static int split_url(const char* url, urlparts_t* up) {
  const char* sep, *rest, *slash;
  size_t slen;
  ad_memset(up, 0, sizeof *up);
  sep = strstr(url, "://");
  if (!sep) return -1;
  slen = (size_t)(sep - url);
  if (!slen || slen >= sizeof up->scheme) return -1;
  ad_memcpy(up->scheme, url, slen); up->scheme[slen] = 0;
  rest = sep + 3;
  if (!*rest) return -1;
  slash = strchr(rest, '/');
  {
    size_t hl = slash ? (size_t)(slash - rest) : strlen(rest);
    char hostp[320];
    const char* at;
    if (!hl || hl >= sizeof hostp) return -1;
    ad_memcpy(hostp, rest, hl); hostp[hl] = 0;
    at = strchr(hostp, '@');
    if (at) ad_strcpy(up->host, sizeof up->host, at + 1);
    else    ad_strcpy(up->host, sizeof up->host, hostp);
  }
  up->port = ad_ci_eq(up->scheme, "https") ? 443 : 80;
  {
    char* c2 = strrchr(up->host, ':');
    if (c2 && !strchr(c2 + 1, ']')) {
      up->port = (int)strtol(c2 + 1, 0, 10);
      *c2 = 0;
    }
  }
  if (!up->host[0]) return -1;
  if (slash) ad_strcpy(up->path, sizeof up->path, slash);
  else ad_strcpy(up->path, sizeof up->path, "/");
  return 0;
}

static int tcp_connect(const char* host, int port) {
  char ports[8];
  struct addrinfo hints, *res = 0, *rp;
  int fd = -1;
  snprintf(ports, sizeof ports, "%d", port);
  ad_memset(&hints, 0, sizeof hints);
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  if (getaddrinfo(host, ports, &hints, &res) != 0 || !res) return -1;
  for (rp = res; rp; rp = rp->ai_next) {
    struct timeval tv = { 30, 0 };
    fd = socket(rp->ai_family, rp->ai_socktype, rp->ai_protocol);
    if (fd < 0) continue;
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
    if (connect(fd, rp->ai_addr, rp->ai_addrlen) == 0) break;
    close(fd); fd = -1;
  }
  freeaddrinfo(res);
  return fd;
}

static void resolve_location(const char* base, const char* loc, char* out, size_t cap) {
  urlparts_t up;
  if (ad_ci_starts(loc, "http://") || ad_ci_starts(loc, "https://")) {
    ad_strcpy(out, cap, loc);
    return;
  }
  if (split_url(base, &up)) { ad_strcpy(out, cap, loc); return; }
  if (loc[0] == '/') {
    snprintf(out, cap, "%s://%s%s", up.scheme, up.host, loc);
  } else {
    char* last = strrchr(up.path, '/');
    if (last) *(last + 1) = 0;
    snprintf(out, cap, "%s://%s%s%s", up.scheme, up.host, up.path, loc);
  }
}

static int http_open(http_stream* s, const char* url, const char* method,
                     uint64_t rstart, int has_range, uint64_t rend,
                     const char* ua, const char* referer,
                     char* err, size_t errlen) {
  char current[AD_MAX_URL], hs[3072];
  int fd = -1;
  s->fd = -1;
  if (err) err[0] = 0;
  ad_strcpy(current, sizeof current, url);

  for (int hop = 0; hop < 6; hop++) {
    urlparts_t up;
    sbuf b;
    size_t sent = 0;
    size_t have = 0;
    long hdr_end = -1;

    if (split_url(current, &up)) { if (err) ad_strcpy(err, errlen, "invalid URL"); return -1; }
    if (ad_ci_eq(up.scheme, "https")) {
      if (err) ad_strcpy(err, errlen, "Linux test build supports http:// only (use the Windows exe for https)");
      return -1;
    }
    fd = tcp_connect(up.host, up.port);
    if (fd < 0) { if (err) ad_strcpy(err, errlen, "connect failed"); return -1; }

    sb_init(&b, hs, sizeof hs);
    sb_puts(&b, method); sb_putc(&b, ' ');
    sb_puts(&b, up.path);
    sb_puts(&b, " HTTP/1.1\r\nHost: ");
    sb_puts(&b, up.host);
    if (up.port != 80) { sb_putc(&b, ':'); sb_putu(&b, (uint64_t)up.port); }
    sb_puts(&b, "\r\nUser-Agent: ");
    sb_puts(&b, (ua && *ua) ? ua : "autodl/1.0");
    sb_puts(&b, "\r\nAccept: */*\r\nConnection: close\r\n");
    if (referer && *referer) { sb_puts(&b, "Referer: "); sb_puts(&b, referer); sb_puts(&b, "\r\n"); }
    if (has_range) {
      sb_puts(&b, "Range: bytes=");
      sb_putu(&b, rstart); sb_putc(&b, '-');
      if (rend) sb_putu(&b, rend);
      sb_puts(&b, "\r\n");
    }
    sb_puts(&b, "\r\n");

    sent = 0;
    while (sent < b.n) {
      ssize_t n = send(fd, hs + sent, b.n - sent, 0);
      if (n <= 0) { close(fd); if (err) ad_strcpy(err, errlen, "send failed"); return -1; }
      sent += (size_t)n;
    }

    /* read headers */
    have = 0; hdr_end = -1;
    while (hdr_end < 0) {
      if (have >= sizeof s->pre) { close(fd); if (err) ad_strcpy(err, errlen, "headers too large"); return -1; }
      ssize_t n = recv(fd, s->pre + have, sizeof s->pre - have, 0);
      if (n <= 0) { close(fd); if (err) ad_strcpy(err, errlen, "connection closed"); return -1; }
      have += (size_t)n;
      for (size_t i = 0; i + 3 < have; i++) {
        if (s->pre[i] == '\r' && s->pre[i + 1] == '\n' && s->pre[i + 2] == '\r' && s->pre[i + 3] == '\n') {
          hdr_end = (long)i;
          break;
        }
      }
    }
    s->pre_len = have;
    s->pre_pos = (size_t)hdr_end + 4;
    s->pre[hdr_end] = 0; /* NUL-terminate the header block (overwrites '\r') */

    /* status line */
    {
      int st = 0;
      char line0[64];
      char* sp = strchr((char*)s->pre, ' ');
      if (sp) st = (int)strtol(sp + 1, 0, 10);
      s->status = st;
      (void)line0;
    }

    /* headers — parse without mutating the buffer before advancing */
    s->content_length = 0;
    s->hdr_etag[0] = s->hdr_last_modified[0] = s->hdr_content_disposition[0] = 0;
    s->hdr_accept_ranges[0] = s->hdr_content_range[0] = s->hdr_location[0] = 0;
    {
      char* hp = strstr((char*)s->pre, "\r\n");   /* end of status line */
      hp = hp ? hp + 2 : (char*)s->pre;
      while (hp && *hp) {
        char* eol = strstr(hp, "\r\n");
        size_t linelen = eol ? (size_t)(eol - hp) : strlen(hp);
        char* colon = 0;
        size_t k;
        for (k = 0; k < linelen; k++) { if (hp[k] == ':') { colon = hp + k; break; } }
        if (colon && colon != hp) {
          char name[48], val[512];
          size_t namelen = (size_t)(colon - hp);
          const char* v = colon + 1;
          size_t vlen;
          if (namelen >= sizeof name) namelen = sizeof name - 1;
          memcpy(name, hp, namelen); name[namelen] = 0;
          vlen = linelen - namelen - 1;
          while (vlen && (*v == ' ' || *v == '\t')) { v++; vlen--; }
          while (vlen && (v[vlen - 1] == ' ' || v[vlen - 1] == '\t')) vlen--;
          if (vlen >= sizeof val) vlen = sizeof val - 1;
          memcpy(val, v, vlen); val[vlen] = 0;
          if (ad_ci_eq(name, "Content-Length"))          s->content_length = ad_strtou64(val);
          else if (ad_ci_eq(name, "Content-Range"))      ad_strcpy(s->hdr_content_range, sizeof s->hdr_content_range, val);
          else if (ad_ci_eq(name, "ETag"))               ad_strcpy(s->hdr_etag, sizeof s->hdr_etag, val);
          else if (ad_ci_eq(name, "Last-Modified"))      ad_strcpy(s->hdr_last_modified, sizeof s->hdr_last_modified, val);
          else if (ad_ci_eq(name, "Accept-Ranges"))      ad_strcpy(s->hdr_accept_ranges, sizeof s->hdr_accept_ranges, val);
          else if (ad_ci_eq(name, "Content-Disposition")) ad_strcpy(s->hdr_content_disposition, sizeof s->hdr_content_disposition, val);
          else if (ad_ci_eq(name, "Location"))           ad_strcpy(s->hdr_location, sizeof s->hdr_location, val);
        }
        if (!eol) break;
        hp = eol + 2;
      }
    }

    /* redirect? */
    if (s->status >= 300 && s->status < 400 && s->hdr_location[0]) {
      char next[AD_MAX_URL];
      resolve_location(current, s->hdr_location, next, sizeof next);
      ad_strcpy(current, sizeof current, next);
      close(fd);
      fd = -1;
      continue;
    }
    break;
  }

  s->fd = fd;
  s->remaining = s->content_length ? s->content_length : AD_UNKNOWN_LEN;
  return 0;
}

static size_t http_read(http_stream* s, void* buf, size_t cap) {
  size_t want;
  ssize_t n;
  if (s->pre_pos < s->pre_len) {
    size_t avail = s->pre_len - s->pre_pos;
    if (avail > cap) avail = cap;
    ad_memcpy(buf, s->pre + s->pre_pos, avail);
    s->pre_pos += avail;
    return avail;
  }
  if (s->remaining == 0) return 0;
  want = cap;
  if (s->remaining != AD_UNKNOWN_LEN && (uint64_t)want > s->remaining) want = (size_t)s->remaining;
  n = recv(s->fd, buf, want, 0);
  if (n < 0) return (size_t)-1;      /* error            */
  if (n == 0) return 0;              /* clean EOF        */
  if (s->remaining != AD_UNKNOWN_LEN) s->remaining -= (uint64_t)n;
  return (size_t)n;
}
static void http_close(http_stream* s) {
  if (s->fd >= 0) close(s->fd);
  s->fd = -1;
}
#endif

/* ═════════════════ filename helpers ═════════════════ */
static int sanitize_filename(const char* in, char* out, size_t cap) {
  size_t n = 0;
  const char* p = in;
  if (!in || !*in) return 0;
  while (*p == '.' || *p == ' ') p++;             /* no leading dots */
  for (; *p && n + 1 < cap; p++) {
    char c = *p;
    if (c == '/' || c == '\\' || (c >= 0 && c < 32)) continue;
    out[n++] = c;
  }
  out[n] = 0;
  if (n > 200) { out[197] = 0; } /* crude cap */
  return out[0] != 0;
}

static int cd_get_filename(const char* cd, char* out, size_t cap) {
  const char* p;
  char tmp[512];
  if (!cd || !*cd) return 0;
  /* filename*=UTF-8''%xx */
  for (p = cd; (p = strstr(p, "filename")) != 0; p += 8) {
    if (p[8] == '*') {
      const char* v = p + 9;
      while (*v == ' ' || *v == '=') v++;
      if (ad_ci_starts(v, "UTF-8''") || ad_ci_starts(v, "utf-8''")) v += 7;
      ad_strcpy(tmp, sizeof tmp, v);
      {
        char* semi = strchr(tmp, ';');
        if (semi) *semi = 0;
      }
      ad_pct_decode(tmp);
      return sanitize_filename(tmp, out, cap);
    }
  }
  /* filename="..." */
  for (p = cd; (p = strstr(p, "filename")) != 0; p += 8) {
    if (p[8] == '=') {
      const char* v = p + 9;
      while (*v == ' ') v++;
      ad_strcpy(tmp, sizeof tmp, v);
      {
        char* semi = strchr(tmp, ';');
        char* q = tmp;
        if (semi) *semi = 0;
        if (*q == '"') {
          q++;
          {
            char* endq = strchr(q, '"');
            if (endq) *endq = 0;
          }
          ad_strcpy(tmp, sizeof tmp, q);
        }
      }
      return sanitize_filename(tmp, out, cap);
    }
  }
  return 0;
}

static int url_get_filename(const char* url, char* out, size_t cap) {
  const char* path, *base;
  char tmp[1024];
  if (!url) return 0;
  path = strstr(url, "://");
  path = path ? (path + 3) : url;
  base = strrchr(path, '/');
  if (!base || !base[1]) return 0;
  base++;
  ad_strcpy(tmp, sizeof tmp, base);
  {
    char* qm = strchr(tmp, '?');
    if (qm) *qm = 0;
  }
  ad_pct_decode(tmp);
  return sanitize_filename(tmp, out, cap);
}

/* ═════════════════ engine ═════════════════ */
typedef struct {
  uint64_t start, end, progress;   /* end == AD_UNKNOWN_LEN → single stream */
  uint8_t  done, claimed;
  int      attempts;
} chunk_t;

typedef struct {
  /* request */
  char     url[AD_MAX_URL];
  char     ua[256], referer[512];
  int      n_conn, retries;
  uint64_t limit_bps;
  int      force, quiet, no_resume;
  char     out_dir[1024];
  char     override_name[256];
  /* probe */
  uint64_t total;
  int      supports_ranges;
  char     etag[160], last_modified[96];
  char     hdr_cd[512];
  /* paths */
  char     filename[256];
  char     final_path[1400], part_path[1440], meta_path[1460];
  /* chunks */
  chunk_t  chunks[AD_MAX_CHUNKS];
  int      n_chunks;
  /* runtime */
  ad_mutex_t mu;
  ad_cond_t  cv;
  int      stop, fatal, dirty, workers_running;
  char     err[256];
  ad_fd_t  part_fd;
  double   bucket_tokens;
  uint64_t bucket_last_ms;
  double   speed;
  uint64_t peak, last_bytes, last_ms, started_ms;
} job_t;

static job_t g_job;
static unsigned char g_rbuf[AD_MAX_CONN][AD_RBUF];
static unsigned char g_meta_buf[160 * 1024];

typedef struct { job_t* j; int idx; ad_thread_t th; int started; } worker_t;
static worker_t g_workers[AD_MAX_CONN];

static uint64_t job_received(job_t* j) {
  uint64_t n = 0;
  int i;
  for (i = 0; i < j->n_chunks; i++) n += j->chunks[i].progress;
  return n;
}

static void plan_chunks(job_t* j) {
  int count, n = 0;
  uint64_t csize;
  if (!j->total || !j->supports_ranges) {
    j->chunks[0].start = 0;
    j->chunks[0].end = AD_UNKNOWN_LEN;
    j->chunks[0].progress = 0;
    j->chunks[0].done = 0;
    j->n_chunks = 1;
    return;
  }
  count = j->n_conn * 8;
  if (count < 1) count = 1;
  if (count > AD_MAX_CHUNKS) count = AD_MAX_CHUNKS;
  while (count > 1 && j->total / (uint64_t)count < AD_MIN_CHUNK) count--;
  csize = (j->total + (uint64_t)count - 1) / (uint64_t)count;
  {
    uint64_t off;
    for (off = 0; off < j->total && n < AD_MAX_CHUNKS; off += csize) {
      j->chunks[n].start = off;
      j->chunks[n].end = (off + csize < j->total) ? (off + csize - 1) : (j->total - 1);
      j->chunks[n].progress = 0;
      j->chunks[n].done = 0;
      j->chunks[n].claimed = 0;
      j->chunks[n].attempts = 0;
      n++;
    }
  }
  j->n_chunks = n;
}

static void bucket_acquire(job_t* j, size_t n) {
  if (!j->limit_bps) return;
  for (;;) {
    uint64_t now = ad_ms();
    double wait_s = 0;
    int ok;
    ad_mu_lock(&j->mu);
    if (j->bucket_last_ms) {
      j->bucket_tokens += (double)(now - j->bucket_last_ms) / 1000.0 * (double)j->limit_bps;
      if (j->bucket_tokens > (double)j->limit_bps) j->bucket_tokens = (double)j->limit_bps;
    } else {
      j->bucket_tokens = (double)j->limit_bps / 2.0;
    }
    j->bucket_last_ms = now;
    ok = j->bucket_tokens >= (double)n;
    if (ok) j->bucket_tokens -= (double)n;
    else wait_s = ((double)n - j->bucket_tokens) / (double)j->limit_bps;
    ad_mu_unlock(&j->mu);
    if (ok) return;
    {
      uint64_t ms = (uint64_t)(wait_s * 900.0) + 1;
      if (ms > 100) ms = 100;
      ad_sleep_ms(ms);
    }
  }
}

/* ── meta (.part.meta) — binary chunk table for byte-exact resume ── */
static void wr8(int* o, unsigned v)  { g_meta_buf[(*o)++] = (unsigned char)v; }
static void wr32(int* o, uint32_t v) { ad_memcpy(g_meta_buf + *o, &v, 4); *o += 4; }
static void wr64(int* o, uint64_t v) { ad_memcpy(g_meta_buf + *o, &v, 8); *o += 8; }
static void wrstr(int* o, const char* s, size_t fixed) {
  size_t n = s ? strlen(s) : 0;
  if (n >= fixed) n = fixed - 1;
  ad_memset(g_meta_buf + *o, 0, fixed);
  if (n) ad_memcpy(g_meta_buf + *o, s, n);
  *o += (int)fixed;
}

static int meta_save(job_t* j) {
  char tmp[1500];
  int o, i;
  ad_fd_t f;
  ad_mu_lock(&j->mu);
  if (!j->dirty || !j->supports_ranges) { ad_mu_unlock(&j->mu); return 0; }
  o = 0;
  ad_memcpy(g_meta_buf + o, "ADLM", 4); o += 4;
  wr32(&o, 1);
  wr64(&o, j->total);
  wr32(&o, (uint32_t)j->n_chunks);
  wrstr(&o, j->filename, sizeof j->filename);
  wrstr(&o, j->final_path, sizeof j->final_path);
  wrstr(&o, j->etag, sizeof j->etag);
  wrstr(&o, j->last_modified, sizeof j->last_modified);
  wr32(&o, (uint32_t)strlen(j->url));
  ad_memcpy(g_meta_buf + o, j->url, strlen(j->url)); o += (int)strlen(j->url);
  for (i = 0; i < j->n_chunks; i++) {
    wr64(&o, j->chunks[i].start);
    wr64(&o, j->chunks[i].end);
    wr64(&o, j->chunks[i].progress);
    wr8(&o, j->chunks[i].done);
  }
  j->dirty = 0;
  ad_mu_unlock(&j->mu);

  ad_strcpy(tmp, sizeof tmp, j->meta_path);
  ad_strcat(tmp, sizeof tmp, ".tmp");
  f = ad_file_open_rw(tmp, 1);
  if (f == AD_BAD_FD) return -1;
  if (ad_file_write_at(f, g_meta_buf, (size_t)o, 0)) { ad_file_close(f); return -1; }
  ad_file_close(f);
  return ad_file_rename(tmp, j->meta_path);
}

static int rd8(const unsigned char* b, size_t* o) { unsigned v = b[(*o)++]; return (int)v; }
static uint32_t rd32(const unsigned char* b, size_t* o) { uint32_t v; ad_memcpy(&v, b + *o, 4); *o += 4; return v; }
static uint64_t rd64(const unsigned char* b, size_t* o) { uint64_t v; ad_memcpy(&v, b + *o, 8); *o += 8; return v; }
static void rdstr(const unsigned char* b, size_t* o, char* out, size_t cap) {
  size_t fixed = cap;
  size_t n = 0;
  while (n < fixed && b[*o + n]) n++;
  if (n >= cap) n = cap - 1;
  ad_memcpy(out, b + *o, n); out[n] = 0;
  *o += fixed;
}

static int meta_load(job_t* j, size_t len) {
  size_t o = 0;
  uint32_t ver, nch, ulen;
  uint64_t total;
  char fname[256], fpath[1400], etag[160], lm[96];
  if (len < 32 || ad_memcmp(g_meta_buf, "ADLM", 4)) return -1;
  o = 4;
  ver = rd32(g_meta_buf, &o);
  if (ver != 1) return -1;
  total = rd64(g_meta_buf, &o);
  nch = rd32(g_meta_buf, &o);
  rdstr(g_meta_buf, &o, fname, sizeof fname);
  rdstr(g_meta_buf, &o, fpath, sizeof fpath);
  rdstr(g_meta_buf, &o, etag, sizeof etag);
  rdstr(g_meta_buf, &o, lm, sizeof lm);
  ulen = rd32(g_meta_buf, &o);
  if (ulen != strlen(j->url) || o + ulen > len) return -1;
  if (ad_memcmp(g_meta_buf + o, j->url, ulen)) return -1;
  o += ulen;
  if (nch < 1 || nch > AD_MAX_CHUNKS) return -1;
  if (o + (size_t)nch * 25u > len) return -1;
  /* validate against fresh probe */
  if (total != j->total) return -1;
  if (etag[0] && j->etag[0] && ad_strcmp(etag, j->etag) != 0) {
    /* etag differs → remote changed */
    return -2;
  }
  (void)fname; (void)lm;
  ad_strcpy(j->final_path, sizeof j->final_path, fpath);
  ad_strcpy(j->part_path, sizeof j->part_path, fpath);
  ad_strcat(j->part_path, sizeof j->part_path, ".part");
  ad_strcpy(j->meta_path, sizeof j->meta_path, fpath);
  ad_strcat(j->meta_path, sizeof j->meta_path, ".part.meta");
  j->n_chunks = (int)nch;
  for (int i = 0; i < (int)nch; i++) {
    j->chunks[i].start = rd64(g_meta_buf, &o);
    j->chunks[i].end = rd64(g_meta_buf, &o);
    j->chunks[i].progress = rd64(g_meta_buf, &o);
    j->chunks[i].done = (uint8_t)rd8(g_meta_buf, &o);
    j->chunks[i].claimed = 0;
    j->chunks[i].attempts = 0;
    if (j->chunks[i].done) j->chunks[i].progress = j->chunks[i].end - j->chunks[i].start + 1;
  }
  return 0;
}

/* ═════════════════ probe ═════════════════ */
static int probe_job(job_t* j, char* err, size_t errlen) {
  http_stream s;
  int have = 0;
  ad_memset(&s, 0, sizeof s);
  if (!http_open(&s, j->url, "HEAD", 0, 0, 0, j->ua, j->referer, err, errlen) && s.status == 200) {
    j->total = s.content_length;
    j->supports_ranges = ad_ci_starts(s.hdr_accept_ranges, "bytes");
    ad_strcpy(j->etag, sizeof j->etag, s.hdr_etag);
    ad_strcpy(j->last_modified, sizeof j->last_modified, s.hdr_last_modified);
    ad_strcpy(j->hdr_cd, sizeof j->hdr_cd, s.hdr_content_disposition);
    have = (j->total && j->supports_ranges) ? 1 : 0;
  }
  http_close(&s);
  if (have) return 0;

  ad_memset(&s, 0, sizeof s);
  if (http_open(&s, j->url, "GET", 0, 1, 0, j->ua, j->referer, err, errlen)) return -1;
  if (s.status == 206) {
    j->supports_ranges = 1;
    j->total = content_range_total(s.hdr_content_range);
  } else if (s.status == 200) {
    j->supports_ranges = 0;
    j->total = s.content_length;
  } else {
    if (err) {
      char t[32]; sbuf b;
      sb_init(&b, t, sizeof t);
      sb_puts(&b, "server returned HTTP ");
      sb_putu(&b, (uint64_t)s.status);
      ad_strcpy(err, errlen, t);
    }
    http_close(&s);
    return -1;
  }
  if (!j->etag[0]) ad_strcpy(j->etag, sizeof j->etag, s.hdr_etag);
  if (!j->last_modified[0]) ad_strcpy(j->last_modified, sizeof j->last_modified, s.hdr_last_modified);
  if (!j->hdr_cd[0]) ad_strcpy(j->hdr_cd, sizeof j->hdr_cd, s.hdr_content_disposition);
  http_close(&s);
  return 0;
}

/* ═════════════════ workers ═════════════════ */
static void set_fatal(job_t* j, const char* msg) {
  if (!j->err[0]) ad_strcpy(j->err, sizeof j->err, msg);
  j->fatal = 1;
}

static int fetch_chunk(job_t* j, chunk_t* c, int widx) {
  uint64_t start = c->start + c->progress;
#ifndef AD_WIN
  if (getenv("AD_DEBUG")) fprintf(stderr, "[fetch] chunk#%ld start=%llu end=%llu progress=%llu\n", (long)(c - j->chunks), (unsigned long long)c->start, (unsigned long long)c->end, (unsigned long long)c->progress);
#endif
  uint64_t end = c->end;
  uint64_t expected = (end == AD_UNKNOWN_LEN) ? AD_UNKNOWN_LEN : (end - start + 1);
  http_stream s;
  char err[160] = "";
  int ok = -1;

  if (j->stop || j->fatal) return -1;
  if (expected != AD_UNKNOWN_LEN && expected == 0) { c->done = 1; return 0; }

  ad_memset(&s, 0, sizeof s);
  if (http_open(&s, j->url, "GET", start, j->supports_ranges, j->supports_ranges ? end : 0,
                j->ua, j->referer, err, sizeof err)) {
#ifndef AD_WIN
    if (getenv("AD_DEBUG")) fprintf(stderr, "[fetch] open FAILED: %s\n", err);
#endif
    return -1; /* transport error → retryable */
  }
#ifndef AD_WIN
  if (getenv("AD_DEBUG")) fprintf(stderr, "[fetch] status=%d clen=%llu remaining=%llu\n", s.status, (unsigned long long)s.content_length, (unsigned long long)s.remaining);
#endif

  {
    int whole_file_single = (start == 0 && expected != AD_UNKNOWN_LEN && j->total && expected == j->total);
    int single_stream_ok = (expected == AD_UNKNOWN_LEN && start == 0);   /* open-ended from 0: 200 is usable */
    if (s.status == 200 && j->supports_ranges && !whole_file_single && !single_stream_ok) {
      ad_mu_lock(&j->mu);
      set_fatal(j, "server ignored the Range header (cannot resume)");
      ad_mu_unlock(&j->mu);
    } else if (s.status == 206 || s.status == 200) {
    uint64_t got = 0;
    ok = 0;
    for (;;) {
      size_t cap = AD_RBUF;
      size_t n;
      if (j->stop || j->fatal) { ok = -1; break; }
      if (expected != AD_UNKNOWN_LEN && expected - got < cap) cap = (size_t)(expected - got);
      n = http_read(&s, g_rbuf[widx], cap);
      if (n == (size_t)-1) { ok = -1; break; }
      if (n == 0) break; /* EOF */
#ifndef AD_WIN
      if (getenv("AD_DEBUG") && ((got >> 16) != ((got + n) >> 16))) fprintf(stderr, "[read] got=%llu/%llu\n", (unsigned long long)(got+n), (unsigned long long)expected);
#endif
      bucket_acquire(j, n);
      if (ad_file_write_at(j->part_fd, g_rbuf[widx], n, start + got)) {
        ad_mu_lock(&j->mu);
        set_fatal(j, "disk write failed");
        ad_mu_unlock(&j->mu);
        ok = -1;
        break;
      }
      got += (uint64_t)n;
      ad_mu_lock(&j->mu);
      c->progress = got;
      j->dirty = 1;
      ad_mu_unlock(&j->mu);
      if (expected != AD_UNKNOWN_LEN && got >= expected) break;
    }
    if (ok == 0) {
      if (expected != AD_UNKNOWN_LEN) {
        if (got != expected) { ok = -1;
#ifndef AD_WIN
          if (getenv("AD_DEBUG")) fprintf(stderr, "[fetch] SHORT: got=%llu expected=%llu\n", (unsigned long long)got, (unsigned long long)expected);
#endif
        }
      } else {
        ad_mu_lock(&j->mu);
        c->progress = got;
        if (!j->total) j->total = got;
        else if (got < j->total) ok = -1;           /* truncated */
        ad_mu_unlock(&j->mu);
      }
    }
  } else {
    /* HTTP error status */
    if (s.status == 404 || s.status == 403 || s.status == 401 || s.status == 400 ||
        s.status == 410 || s.status == 416) {
      char msg[96]; sbuf b;
      sb_init(&b, msg, sizeof msg);
      sb_puts(&b, "server returned HTTP ");
      sb_putu(&b, (uint64_t)s.status);
      ad_mu_lock(&j->mu);
      set_fatal(j, msg);
      ad_mu_unlock(&j->mu);
    }
    /* 5xx / 429 → retryable */
  }
  } /* end status-dispatch block */
  http_close(&s);
  return ok;
}

static ad_thread_ret_t worker_fn(void* arg) {
  worker_t* w = (worker_t*)arg;
  job_t* j = w->j;
  for (;;) {
    chunk_t* c = 0;
    ad_mu_lock(&j->mu);
    if (!j->stop && !j->fatal) {
      for (int i = 0; i < j->n_chunks; i++) {
        if (!j->chunks[i].done && !j->chunks[i].claimed) {
          j->chunks[i].claimed = 1;
          c = &j->chunks[i];
          break;
        }
      }
    }
    ad_mu_unlock(&j->mu);
    if (!c) break;

    if (fetch_chunk(j, c, w->idx) == 0) {
      ad_mu_lock(&j->mu);
      c->claimed = 0;
      c->done = 1;
      c->progress = (c->end == AD_UNKNOWN_LEN) ? c->progress : (c->end - c->start + 1);
      j->dirty = 1;
      ad_mu_unlock(&j->mu);
    } else {
      uint64_t backoff;
      int give_up;
      ad_mu_lock(&j->mu);
      c->claimed = 0;
      c->attempts++;
      give_up = c->attempts > j->retries;
#ifndef AD_WIN
      if (getenv("AD_DEBUG")) fprintf(stderr, "[worker] chunk#%ld attempt %d/%d fatal=%d stop=%d\n", (long)(c - j->chunks), c->attempts, j->retries, j->fatal, j->stop);
#endif
      if (give_up && !j->err[0]) {
        char msg[128]; sbuf b;
        sb_init(&b, msg, sizeof msg);
        sb_puts(&b, "chunk #");
        sb_putu(&b, (uint64_t)(c - j->chunks));
        sb_puts(&b, " failed after ");
        sb_putu(&b, (uint64_t)j->retries);
        sb_puts(&b, " attempts");
        ad_strcpy(j->err, sizeof j->err, msg);
      }
      if (give_up) j->fatal = 1;
      ad_mu_unlock(&j->mu);
      if (j->stop || j->fatal) break;
      backoff = 400u << (c->attempts > 4 ? 4 : c->attempts);
      if (backoff > 6400u) backoff = 6400u;
      for (uint64_t left = backoff; left && !j->stop && !j->fatal; ) {
        uint64_t d = left > 50 ? 50 : left;
        ad_sleep_ms(d);
        left -= d;
      }
    }
  }
  ad_mu_lock(&j->mu);
  j->workers_running--;
  ad_cv_wake(&j->cv);
  ad_mu_unlock(&j->mu);
  return (ad_thread_ret_t)0;
}

/* ═════════════════ progress UI ═════════════════ */
static void render_progress(job_t* j, int final) {
  uint64_t recv, total, eta = 0;
  int running, done_chunks = 0, nconn;
  char line[320];
  sbuf b;
  uint64_t now = ad_ms();

  ad_mu_lock(&j->mu);
  recv = job_received(j);
  total = j->total;
  running = j->workers_running;
  nconn = j->n_conn;
  for (int i = 0; i < j->n_chunks; i++) if (j->chunks[i].done) done_chunks++;
  ad_mu_unlock(&j->mu);

  if (j->last_ms && now > j->last_ms) {
    double inst = (double)(recv - j->last_bytes) * 1000.0 / (double)(now - j->last_ms);
    j->speed = j->speed ? (j->speed * 0.65 + inst * 0.35) : inst;
  }
  j->last_bytes = recv;
  j->last_ms = now;
  if ((uint64_t)j->speed > j->peak) j->peak = (uint64_t)j->speed;

  if (!g_is_tty && !final) return;

  sb_init(&b, line, sizeof line);
  if (!final) sb_puts(&b, "\r  ");
  if (total) {
    double frac = (double)recv / (double)total;
    unsigned cells;
    if (frac > 1.0) frac = 1.0;
    cells = (unsigned)(frac * 24.0 + 0.5);
    if (g_color) sb_puts(&b, C_CYAN);
    sb_putc(&b, '[');
    for (unsigned i = 0; i < 24; i++) sb_putc(&b, i < cells ? '#' : '-');
    sb_putc(&b, ']');
    if (g_color) sb_puts(&b, C_RESET);
    sb_putc(&b, ' ');
    sb_putd1(&b, (uint64_t)(frac * 1000.0 + 0.5));
    sb_puts(&b, "%  ");
    if (j->speed > 1.0) eta = (uint64_t)(((double)total - (double)recv) / j->speed);
  } else {
    if (g_color) sb_puts(&b, C_CYAN);
    sb_puts(&b, "[>> downloading ]  ");
    if (g_color) sb_puts(&b, C_RESET);
  }
  sb_fmt_size(&b, recv);
  if (total) { sb_putc(&b, '/'); sb_fmt_size(&b, total); }
  sb_puts(&b, "  ");
  sb_fmt_size(&b, (uint64_t)j->speed);
  sb_puts(&b, "/s");
  if (eta) { sb_puts(&b, "  ETA "); sb_fmt_eta(&b, eta); }
  if (j->n_chunks > 1) {
    sb_puts(&b, "  ");
    sb_putu(&b, (uint64_t)done_chunks);
    sb_putc(&b, '/');
    sb_putu(&b, (uint64_t)j->n_chunks);
  }
  sb_puts(&b, "  ");
  sb_putu(&b, (uint64_t)(running > 0 ? running : 0));
  sb_putc(&b, '/');
  sb_putu(&b, (uint64_t)nconn);
  sb_puts(&b, "c");
  if (final) sb_putc(&b, '\n');
  say(line);
}

/* ═════════════════ run loop ═════════════════ */
static int job_run(job_t* j) {
  int n, i;
  j->started_ms = ad_ms();
  n = j->n_conn;
  if (j->n_chunks == 1) n = 1;
  if (n > j->n_chunks) n = j->n_chunks;
  j->workers_running = 0;
  for (i = 0; i < n; i++) {
    g_workers[i].j = j;
    g_workers[i].idx = i;
    g_workers[i].started = 0;
    if (ad_thread_start(&g_workers[i].th, worker_fn, &g_workers[i], i) == 0) {
      g_workers[i].started = 1;
      j->workers_running++;
    }
  }
  if (!j->workers_running) return -1;

  for (;;) {
    int running;
    uint64_t now;
    ad_mu_lock(&j->mu);
    running = j->workers_running;
    ad_mu_unlock(&j->mu);
    if (!running) break;
    now = ad_ms();
#ifndef AD_WIN
    if (getenv("AD_DEBUG2")) fprintf(stderr, "[loop] t=%llu running=%d gint=%d stop=%d\n", (unsigned long long)(now - j->started_ms), running, g_interrupt, j->stop);
    if (g_interrupt && !j->stop) { ad_mu_lock(&j->mu); j->stop = 1; ad_mu_unlock(&j->mu); }
#endif
    if (now - 200 >= j->last_ms || !j->last_ms) {
      if (!j->quiet) render_progress(j, 0);
    }
    meta_save(j);
    ad_mu_lock(&j->mu);
    if (j->workers_running) ad_cv_wait(&j->cv, &j->mu, 100);
    ad_mu_unlock(&j->mu);
  }
  for (i = 0; i < n; i++) if (g_workers[i].started) ad_thread_join(g_workers[i].th);
  meta_save(j);
  if (!j->quiet) render_progress(j, 1);
  return 0;
}

/* ═════════════════ CLI ═════════════════ */
static const char* USAGE =
  "AutoDownloader 1.0 — multi-connection CLI downloader (http/https)\n"
  "\n"
  "Usage: autodl [options] URL\n"
  "\n"
  "Options:\n"
  "  -n, --connections N    parallel connections 1..32 (default 8)\n"
  "  -o, --output NAME      output file name\n"
  "  -d, --dir DIR          output directory (created if missing)\n"
  "  -s, --speed-limit V    cap speed: -s 500 (KB/s)  or  -s 2M (MB/s)\n"
  "  -r, --retries N        per-chunk retries (default 5)\n"
  "  -a, --user-agent UA    custom User-Agent\n"
  "  -e, --referer URL      custom Referer\n"
  "  -f, --force            overwrite existing file\n"
  "      --no-resume        start fresh, ignore saved progress\n"
  "  -q, --quiet            no live progress bar\n"
  "  -h, --help             this help\n"
  "\n"
  "Resume: run the same command again — progress is kept in <file>.part.meta\n"
  "Multi-connection needs server Range support (checked automatically).\n";

static uint64_t parse_speed(const char* v) {
  /* plain number = KB/s; 500K = KB/s; 2M = MB/s */
  uint64_t n = ad_strtou64(v);
  const char* p = v;
  while (*p == ' ' || (*p >= '0' && *p <= '9') || *p == '.') p++;
  if (*p == 'g' || *p == 'G') n *= 1024ull * 1024ull * 1024ull / 1024ull; /* G → bytes from KB base */
  else if (*p == 'm' || *p == 'M') n *= 1024ull;
  /* K or default already KB */
  return n * 1024ull;
}

static int ad_main(int argc, char** argv) {
  job_t* j = &g_job;
  char err[256] = "";
  const char* url = 0;
  int i, exit_code = 0;
  uint64_t t0;
  size_t meta_len = 0;
  int meta_loaded = 0;

  con_init();
#ifdef AD_WIN
  /* nothing (Ctrl+C default kill; progress saved every second) */
#else
  ad_install_signals();
#endif

  /* defaults (overridable by flags) */
  j->n_conn = 8;
  j->retries = 5;

  /* parse args */
  for (i = 1; i < argc; i++) {
    const char* a = argv[i];
    if (a[0] == '-' && a[1]) {
      if (!strcmp(a, "-h") || !strcmp(a, "--help")) { say(USAGE); return 0; }
      else if (!strcmp(a, "-n") || !strcmp(a, "--connections")) { if (++i < argc) j->n_conn = (int)ad_strtou64(argv[i]); }
      else if (!strcmp(a, "-o") || !strcmp(a, "--output")) { if (++i < argc) ad_strcpy(j->override_name, sizeof j->override_name, argv[i]); }
      else if (!strcmp(a, "-d") || !strcmp(a, "--dir")) { if (++i < argc) ad_strcpy(j->out_dir, sizeof j->out_dir, argv[i]); }
      else if (!strcmp(a, "-s") || !strcmp(a, "--speed-limit")) { if (++i < argc) j->limit_bps = parse_speed(argv[i]); }
      else if (!strcmp(a, "-r") || !strcmp(a, "--retries")) { if (++i < argc) j->retries = (int)ad_strtou64(argv[i]); }
      else if (!strcmp(a, "-a") || !strcmp(a, "--user-agent")) { if (++i < argc) ad_strcpy(j->ua, sizeof j->ua, argv[i]); }
      else if (!strcmp(a, "-e") || !strcmp(a, "--referer")) { if (++i < argc) ad_strcpy(j->referer, sizeof j->referer, argv[i]); }
      else if (!strcmp(a, "-f") || !strcmp(a, "--force")) j->force = 1;
      else if (!strcmp(a, "--no-resume")) j->no_resume = 1;
      else if (!strcmp(a, "-q") || !strcmp(a, "--quiet")) j->quiet = 1;
      else {
        char t[128]; sbuf b;
        sb_init(&b, t, sizeof t);
        sb_puts(&b, "unknown option: ");
        sb_puts(&b, a);
        sb_puts(&b, "\n");
        say(t);
        say(USAGE);
        return 2;
      }
    } else if (!url) {
      url = a;
    } else {
      say("error: multiple URLs given (one per run)\n");
      return 2;
    }
  }
  if (!url) { say(USAGE); return 2; }
  if (j->n_conn < 1) j->n_conn = 1;
  if (j->n_conn > AD_MAX_CONN) j->n_conn = AD_MAX_CONN;
  if (!j->out_dir[0]) ad_strcpy(j->out_dir, sizeof j->out_dir, ".");
  ad_strcpy(j->url, sizeof j->url, url);
  if (!ad_ci_starts(j->url, "http://") && !ad_ci_starts(j->url, "https://")) {
    say("error: URL must start with http:// or https://\n");
    return 2;
  }

  say("AutoDownloader 1.0 \xe2\x9a\xa1 multi-connection downloader\n");
  {
    char t[4400]; sbuf b;
    sb_init(&b, t, sizeof t);
    sb_puts(&b, "  url: ");
    sb_puts(&b, j->url);
    sb_puts(&b, "\n");
    say(t);
  }

  /* probe */
  if (probe_job(j, err, sizeof err)) {
    char t[400]; sbuf b;
    sb_init(&b, t, sizeof t);
    if (g_color) sb_puts(&b, C_RED);
    sb_puts(&b, "  error: ");
    sb_puts(&b, err[0] ? err : "probe failed");
    sb_puts(&b, "\n");
    if (g_color) sb_puts(&b, C_RESET);
    say(t);
    return 1;
  }

  /* filename */
  if (j->override_name[0]) {
    char t[256];
    if (!sanitize_filename(j->override_name, t, sizeof t)) ad_strcpy(t, sizeof t, "download.bin");
    ad_strcpy(j->filename, sizeof j->filename, t);
  } else if (!cd_get_filename(j->hdr_cd, j->filename, sizeof j->filename)) {
    if (!url_get_filename(j->url, j->filename, sizeof j->filename))
      ad_strcpy(j->filename, sizeof j->filename, "download.bin");
  }

  /* show probe info */
  {
    char t[700]; sbuf b;
    sb_init(&b, t, sizeof t);
    sb_puts(&b, "  file: ");
    sb_puts(&b, j->filename);
    if (j->total) { sb_puts(&b, "  ("); sb_fmt_size(&b, j->total); sb_puts(&b, ")"); }
    sb_puts(&b, "\n  range: ");
    sb_puts(&b, j->supports_ranges ? "yes (multi-connection)" : "no (single stream)");
    sb_puts(&b, "  connections: ");
    sb_putu(&b, (uint64_t)j->n_conn);
    if (j->limit_bps) { sb_puts(&b, "  speed limit: "); sb_fmt_size(&b, j->limit_bps); sb_puts(&b, "/s"); }
    sb_puts(&b, "\n");
    say(t);
  }

  /* output paths */
  ad_mkdir_p(j->out_dir);
  {
    char dir[1100];
    ad_strcpy(dir, sizeof dir, j->out_dir);
    if (dir[0] && dir[strlen(dir) - 1] != '/' && dir[strlen(dir) - 1] != '\\')
      ad_strcat(dir, sizeof dir, "/");
    ad_strcpy(j->final_path, sizeof j->final_path, dir);
    ad_strcat(j->final_path, sizeof j->final_path, j->filename);
  }

  /* resume? */
  ad_strcpy(j->part_path, sizeof j->part_path, j->final_path);
  ad_strcat(j->part_path, sizeof j->part_path, ".part");
  ad_strcpy(j->meta_path, sizeof j->meta_path, j->part_path);
  ad_strcat(j->meta_path, sizeof j->meta_path, ".meta");

  if (!j->no_resume && j->supports_ranges) {
    if (ad_file_read_all(j->meta_path, g_meta_buf, sizeof g_meta_buf, &meta_len) == 0) {
      int rc = meta_load(j, meta_len);
      uint64_t psz = 0;
      if (rc == 0 && ad_file_size(j->part_path, &psz) == 0 && psz == j->total) {
        meta_loaded = 1;
      } else if (rc == -2) {
        say("  remote file changed — restarting from scratch\n");
        ad_file_remove(j->meta_path);
        ad_file_remove(j->part_path);
      } else {
        ad_file_remove(j->meta_path);
        ad_file_remove(j->part_path);
      }
    }
  }

  if (!meta_loaded) {
    /* fresh plan + unique name */
    if (!j->force) {
      int n = 1;
      while (ad_file_exists(j->final_path)) {
        char stem[256], ext[64];
        size_t el = 0;
        char* dot = strrchr(j->filename, '.');
        if (dot && dot != j->filename) {
          el = strlen(dot);
          if (el >= sizeof ext) el = sizeof ext - 1;
          ad_memcpy(ext, dot, el); ext[el] = 0;
          *dot = 0;
        } else ext[0] = 0;
        ad_strcpy(stem, sizeof stem, j->filename);
        {
          char t[320]; sbuf b;
          sb_init(&b, t, sizeof t);
          sb_puts(&b, stem);
          sb_puts(&b, " (");
          sb_putu(&b, (uint64_t)n++);
          sb_puts(&b, ")");
          sb_puts(&b, ext);
          ad_strcpy(j->filename, sizeof j->filename, t);
        }
        ad_strcpy(j->final_path, sizeof j->final_path, j->out_dir);
        if (j->out_dir[0] && j->out_dir[strlen(j->out_dir) - 1] != '/' && j->out_dir[strlen(j->out_dir) - 1] != '\\')
          ad_strcat(j->final_path, sizeof j->final_path, "/");
        ad_strcat(j->final_path, sizeof j->final_path, j->filename);
        ad_strcpy(j->part_path, sizeof j->part_path, j->final_path);
        ad_strcat(j->part_path, sizeof j->part_path, ".part");
        ad_strcpy(j->meta_path, sizeof j->meta_path, j->part_path);
        ad_strcat(j->meta_path, sizeof j->meta_path, ".meta");
        if (n > 999) break;
      }
    }
    plan_chunks(j);
    ad_file_remove(j->meta_path);
    j->part_fd = ad_file_open_rw(j->part_path, 1);
    if (j->part_fd == AD_BAD_FD) { say("error: cannot create output file\n"); return 1; }
    if (j->total) ad_file_truncate(j->part_fd, j->total);
    j->dirty = 1;
  } else {
    char t[300]; sbuf b;
    double frac = j->total ? (double)job_received(j) / (double)j->total : 0.0;
    sb_init(&b, t, sizeof t);
    sb_puts(&b, "  resuming — ");
    sb_putd1(&b, (uint64_t)(frac * 1000.0 + 0.5));
    sb_puts(&b, "% (");
    sb_fmt_size(&b, job_received(j));
    sb_puts(&b, ") already on disk\n");
    say(t);
    j->part_fd = ad_file_open_rw(j->part_path, 0);
    if (j->part_fd == AD_BAD_FD) { say("error: cannot open .part file\n"); return 1; }
  }

  t0 = ad_ms();
  if (job_run(j) != 0) { say("error: cannot start workers\n"); ad_file_close(j->part_fd); return 1; }

    /* finish */
  {
    int all_done = 1;
    ad_mu_lock(&j->mu);
    for (i = 0; i < j->n_chunks; i++) if (!j->chunks[i].done) all_done = 0;
    ad_mu_unlock(&j->mu);
    if (j->stop && !all_done && !j->fatal) {
      char t[420]; sbuf b;
      sb_init(&b, t, sizeof t);
      if (g_color) sb_puts(&b, C_YELLOW);
      sb_puts(&b, "  ⏸ paused — progress saved");
      if (g_color) sb_puts(&b, C_RESET);
      sb_puts(&b, "\n  run the same command again to resume.\n");
      say(t);
      ad_file_close(j->part_fd);
      exit_code = 130;
    } else if (j->fatal || !all_done) {
      char t[420]; sbuf b;
      sb_init(&b, t, sizeof t);
      if (g_color) sb_puts(&b, C_RED);
      sb_puts(&b, "  ✗ failed: ");
      sb_puts(&b, j->err[0] ? j->err : "incomplete");
      sb_puts(&b, "\n");
      if (g_color) sb_puts(&b, C_RESET);
      sb_puts(&b, "  partial data kept in ");
      sb_puts(&b, j->part_path);
      sb_puts(&b, "\n  run the same command again to resume.\n");
      say(t);
      ad_file_close(j->part_fd);
      exit_code = 1;
    } else {
      uint64_t secs = (ad_ms() - t0) / 1000u;
      char t[600]; sbuf b;
      uint64_t got = job_received(j);
      ad_file_close(j->part_fd);
      if (ad_file_rename(j->part_path, j->final_path)) {
        say("error: cannot finalize file\n");
        return 1;
      }
      ad_file_remove(j->meta_path);
      sb_init(&b, t, sizeof t);
      if (g_color) sb_puts(&b, C_GREEN);
      sb_puts(&b, "  ✓ downloaded ");
      sb_puts(&b, j->filename);
      sb_puts(&b, "  (");
      sb_fmt_size(&b, got);
      sb_puts(&b, ") in ");
      sb_putu(&b, secs ? secs : 1);
      sb_puts(&b, "s");
      if (secs > 1) { sb_puts(&b, " — avg "); sb_fmt_size(&b, got / secs); sb_puts(&b, "/s"); }
      sb_puts(&b, "\n");
      if (g_color) sb_puts(&b, C_RESET);
      sb_puts(&b, "  saved to: ");
      sb_puts(&b, j->final_path);
      sb_puts(&b, "\n");
      say(t);
      exit_code = 0;
    }
  }
  return exit_code;
}

#ifdef AD_WIN
/* wide command line → utf8 argv (shared by MinGW and PE builds) */
static int ad_main_w(void) {
  char16_t* wcmd = GetCommandLineW();
  char cmd[8192];
  char* argv[160];
  int argc = 0;
  char* p;
  if (!wcmd || !ad_u16_to_u8(wcmd, cmd, sizeof cmd)) return 2;
  p = cmd;
  while (*p && argc < 158) {
    char* start;
    int quoted = 0;
    while (*p == ' ' || *p == '\t') p++;
    if (!*p) break;
    start = p;
    {
      char* out = p;
      while (*p) {
        if (*p == '"') { quoted = !quoted; p++; continue; }
        if (!quoted && (*p == ' ' || *p == '\t')) break;
        *out++ = *p++;
      }
      *out = 0;
    }
    argv[argc++] = start;
  }
  argv[argc] = 0;
  return ad_main(argc, argv);
}

#  ifdef AD_PE
void ad_entry(void) { ExitProcess((UINT)ad_main_w()); }
#  else
int main(int argc, char** argv) { (void)argc; (void)argv; return ad_main_w(); }
#  endif

#else
int main(int argc, char** argv) { return ad_main(argc, argv); }
#endif

