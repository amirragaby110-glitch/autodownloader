# ⚡ دانلودر خودکار — AutoDownloader

دانلودر خودکار با موتور **چنداتصاله** (مشابه IDM / aria2c) — در دو نسخه:

## 🖥️ نسخه CLI بومی (C + خروجی ویندوزی)

یک فایل C بدون وابستگی: `native/autodl.c` — با WinHTTP (http **و https**) روی ویندوز و raw socket روی لینوکس.

* **خروجی آماده ویندوز x64:** [`release/autodl.exe`](release/autodl.exe) (۳۵KB) — دانلود و اجرا، بدون نصب.
* کامپایل با MinGW-w64:
  ```sh
  x86_64-w64-mingw32-gcc -O2 -std=c11 -Wall -Wextra -o autodl.exe native/autodl.c -lwinhttp -s
  ```
* یا حتی **بدون هیچ ابزار ویندوز**، با گِرِک لینوکس + بیلدر PE دست‌ساز:
  ```sh
  node native/pe/build.js   # → release/autodl.exe
  ```
* دانلود سریع: `autodl -n 8 -d D:\Downloads URL` — Ctrl+C → ادامه‌ی خودکار با همان دستور.
* جزئیات کامل و فلگ‌ها: [native/README.md](native/README.md)

**نتیجه تست:** فایل ۱۶MB با ۸ اتصال در **۰.۴۴ ثانیه** (۸.۶× سریع‌تر از تک‌اتصالی)، resume بعد از قطع ✓، محدودیت سرعت ✓.

## 🌐 نسخه وب (Node.js)

دانلودر **تحت وب** با همان موتور — لینک را می‌دهید، تنظیم می‌کنید چطور دانلود شود و کجا ذخیره شود؛ بقیه‌اش با اوست.

> **صفر وابستگی!** کل پروژه فقط با Node.js خالص (نسخه ۱۸+) کار می‌کند — نه `npm install`، نه فریم‌ورک، نه build step. یک فایل اجرا و تمام.

---

## 🚀 چرا سریع‌تر از بقیه است؟

| تکنیک | توضیح |
|---|---|
| **چند اتصال موازی (تا ۳۲×)** | فایل به ده‌ها chunk تقسیم و با اتصال‌های همزمان (HTTP Range) دانلود می‌شود — سرورهایی که هر اتصال را محدود می‌کنند را دور می‌زند |
| **تقسیم هوشمند chunk** | فایل به `اتصال×۸` بخش تقسیم می‌شود؛ هر worker هرچه زودتر تمام کرد، بخش بعدی را می‌گیرد (load-balancing پویا) |
| **نوشتن مستقیم positional** | هر worker مستقیم در آفست خودش روی دیسک می‌نویسد (`pwrite`) — **هیچ مرحله ادغام/کپی وجود ندارد**، حتی یک بایت اضافه روی دیسک نوشته نمی‌شود |
| **بافر نوشتن ۱MB** | بافرهای کوچک شبکه در بافرهای ۱ مگابایتی ادغام و یک‌جا نوشته می‌شوند (کاهش شدید syscall) |
| **تابع بازگشتی هوشمند** | هر chunk جداگانه retry با backoff نمایی دارد؛ خطای شبکه کل دانلود را نمی‌سوزاند |

**نتیجه تست واقعی** (سروری که هر اتصال را به ۶MB/s محدود می‌کرد، فایل ۳۲MB):

```
۱ اتصال  →  5.24s  (6.1 MB/s)
۸ اتصال  →  0.66s  (48.3 MB/s)  ← ۷.۹ برابر سریع‌تر ✅
```

## ✨ امکانات

- 🌐 **رابط وب فارسی (RTL)** با طراحی مدرن گلس/دارک و آپدیت زنده با **SSE**
- 🔗 **لینک بده، دانلود کن** — حتی چند لینک با هم (هر خط یک لینک)
- 🎛 **تنظیم نحوه دانلود**: تعداد اتصال (۱–۳۲)، محدودیت سرعت، تعداد تلاش مجدد، User-Agent و Referer سفارشی
- 📁 **تنظیم محل ذخیره**: انتخاب پوشه با مرورگر فایل داخلی + ساخت پوشه جدید + پوشه پیش‌فرض
- ⏯ **توقف / ادامه / لغو / شروع دوباره** برای هر دانلود
- 🔄 **ادامه دانلود (Resume)** در سطح بایت — حتی بعد از ری‌استارت سرور (state روی دیسک ذخیره می‌شود)
- 🛡 **اعتبارسنجی یکپارچگی**: هنگام ادامه، ETag/Last-Modified با سرور مقایسه می‌شود؛ اگر فایل عوض شده بود از اول شروع می‌کند
- 📊 نمایش زنده: سرعت، زمان باقی‌مانده، درصد، و **نمودار تک‌تک اتصال‌ها**
- 🖼 تشخیص خودکار نام فایل (Content-Disposition / URL)، آیکون بر اساس نوع فایل، دانلود/پیش‌نمایش فایل کامل‌شده در مرورگر
- 🔂 صف دانلود با حداکثر دانلود همزمان قابل تنظیم
- 🐴 **fallback خودکار**: اگر سرور Range نداشت، تک‌اتصاله دانلود می‌کند (هیچ سروری جا نمی‌ماند)
- ⏱ watchdog اتصال‌های قفل‌شده (stall detection) + تایم‌اوت اتصال

## 🏃 اجرا

```bash
node server/index.js          # یا: npm start
# ⚡ AutoDownloader v1.0
# ▸ listening: http://0.0.0.0:3000
```

سپس مرورگر را باز کنید: `http://localhost:3000`

متغیرهای محیطی: `PORT` (پیش‌فرض 3000) و `HOST` (پیش‌فرض 0.0.0.0)

> حداقل Node.js نسخه **18.11** (به‌خاطر `fetch` داخلی). برای امکانات کامل (AbortSignal.any) **Node 20+** توصیه می‌شود.

## 🗂 محل ذخیره فایل‌ها

- پیش‌فرض: پوشه `downloads/` کنار پروژه
- از **تنظیمات** یا پنل «تنظیمات دانلود» قابل تغییر است (مرورگر پوشه داخلی)
- وضعیت دانلودها در `data/jobs.json` و `data/settings.json` ذخیره می‌شود (پس از ری‌استارت، دانلودهای نیمه‌کاره به‌صورت «متوقف» برمی‌گردند و قابل ادامه‌اند)

## ⚙️ ساختار پروژه

```
├── server/
│   ├── index.js    ← سرور HTTP، REST API، SSE، سرو فایل و استاتیک
│   ├── engine.js   ← مدیریت صف، زمان‌بند، persist وضعیت
│   ├── job.js      ← هسته دانلود چنداتصاله (probe، chunk، worker، limiter)
│   ├── settings.js ← تنظیمات ماندگار
│   └── utils.js    ← ابزارها (نام فایل، mime، …)
├── public/         ← فرانت‌اند (بدون build step — ES2023 خالص)
├── test/
│   ├── rangeserver.js ← سرور تست با Range و throttle قابل‌تنظیم
│   └── run.mjs        ← ۲۴ تست end-to-end موتور
└── downloads/ data/   ← خروجی و وضعیت (gitignore شده)
```

## 🔌 REST API

| متد | مسیر | توضیح |
|---|---|---|
| `POST` | `/api/downloads` | افزودن `{url \| urls[], options:{connections,speedLimit,filename,dir,retries,headers}}` |
| `GET` | `/api/downloads` | فهرست + آمار |
| `POST` | `/api/downloads/:id?action=pause\|resume\|cancel\|restart` | کنترل دانلود |
| `DELETE` | `/api/downloads/:id[?file=1]` | حذف از فهرست (و اختیاراً پاک‌کردن فایل) |
| `GET` | `/api/downloads/:id/file[?inline=1]` | دریافت/پیش‌نمایش فایل (با Range) |
| `POST` | `/api/probe` | بررسی لینک: حجم، نام، پشتیبانی چنداتصاله |
| `GET` | `/api/events` | استریم SSE وضعیت زنده |
| `GET/PUT` | `/api/settings` | تنظیمات |
| `GET` | `/api/fs?path=…` + `POST /api/fs/mkdir` | مرورگر پوشه |

نمونه:

```bash
curl -X POST localhost:3000/api/downloads \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/big.iso","options":{"connections":16}}'
```

## 🧪 تست‌ها

```bash
npm test    # ۲۴ تست: سرعت چنداتصاله، checksum، pause/resume،
            # restart-resume، fallback بدون Range، محدودیت سرعت، خطاها
```

## 🔒 نکات

- این ابزار برای میزبانی **شخصی/داخلی** طراحی شده؛ مسیر پوشه‌ها به فضای کاربر (`~`) محدود است.
- لینک‌های `http/https` مستقیم پشتیبانی می‌شوند (فایل/ایمیج/آرشیو…). صفحات وبی که لینک مستقیم نمی‌دهند خارج از scope هستند.

---

## English Summary

A **zero-dependency** (pure Node.js ≥18.11) web-based multi-connection download accelerator, IDM/aria2-style: parallel HTTP-range chunked downloads (up to 32 connections) written directly at file offsets (no merge phase), per-chunk retry with backoff, byte-level resume that survives server restarts, ETag/Last-Modified revalidation, token-bucket rate limiting, queue scheduler, live SSE progress with per-connection visualization, and a modern Persian/RTL glass-dark UI with no build step. `npm test` runs 24 end-to-end tests against a built-in throttled origin server (measured **7.9× speedup at 8 connections**).
