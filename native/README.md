# AutoDownloader — native CLI (`autodl`)

A single-file, dependency-free C downloader: **multi-connection HTTP(S) with
dynamic chunk claiming, resume, and speed limiting** — the same engine ideas
as the web app, in one portable `autodl.c`.

```
AutoDownloader 1.0 ⚡ multi-connection downloader
  url: http://host/file.bin
  file: file.bin  (16.0 MB)
  range: yes (multi-connection)  connections: 8
[########################] 100.0%  16.0 MB/16.0 MB  18.2 MB/s  32/32  0/8c
  ✓ downloaded file.bin  (16.0 MB) in 1s
```

## Usage

```
autodl [options] URL

  -n N     connections 1..32        (default 8)
  -o FILE  output file name         (default: from URL / Content-Disposition)
  -d DIR   output directory         (default .)
  -s RATE  speed limit, e.g. 500k, 2M (default unlimited)
  -r N     retries per chunk        (default 5)
  -a UA    User-Agent header
  -e URL   Referer header
  -f       overwrite existing file
  --no-resume   start fresh, ignore saved progress
  -q       quiet (errors only)
  -h       help
```

Interrupt with Ctrl+C — progress is kept in `<file>.part` + `<file>.part.meta`
and the same command resumes where it stopped (exit code 130 = paused).

## How it is fast

* probes the server: total size, Range support, ETag/Last-Modified, filename
* splits the file into `connections × 8` chunks (512 KiB – 2 MiB each)
* workers **dynamically claim** the next unfinished chunk — no static
  per-connection assignment, so one slow connection never stalls the tail
* retries with exponential backoff; HTTP 416/404/401 are fatal, 5xx/429 retry
* servers without Range support fall back to a single stream automatically
* progress + chunk table saved every ~100 ms to `.part.meta` (binary format)

## Build

### Linux (raw sockets, no TLS — http only)

```sh
gcc -O2 -std=c11 -Wall -Wextra -o autodl native/autodl.c -lpthread
```

### Windows with MinGW-w64 (WinHTTP backend, http + https)

```sh
x86_64-w64-mingw32-gcc -O2 -std=c11 -Wall -Wextra -o autodl.exe native/autodl.c -lwinhttp -s
```

### Windows exe without any Windows toolchain

`pe/build.js` compiles `autodl.c` with the host (Linux) gcc in freestanding
mode, then relocates the object and emits a PE32+ console executable by hand —
ABI shims (SysV → Win64) and the import table (kernel32 + winhttp) are
generated in JS:

```sh
node native/pe/build.js     # → release/autodl.exe
```

## Verified on Linux (throttled test origin, 16 MiB file)

| scenario                     | result                                    |
|------------------------------|-------------------------------------------|
| single connection            | 3.83 s, 5.3 MB/s, sha256 ✓                |
| 8 connections                | 0.44 s — **8.6× faster**, sha256 ✓        |
| Ctrl+C → resume              | exit 130, “resuming — 37.1%”, sha256 ✓    |
| speed limit `-s 2M`          | 7.5 s ≈ 2.2 MB/s ✓                        |
| no-Range server              | single-stream fallback ✓                  |
| 404 / bad URL                | clean error, exit 1 ✓                     |
