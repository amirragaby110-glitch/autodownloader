/* ════════════════════════════════════════════════════════════════════
 * pe/build.js — build a native Windows x64 console executable from
 * autodl.c WITHOUT a Windows toolchain:
 *
 *   gcc (Linux, SysV codegen) → ELF .o  →  relocate  →  PE32+ .exe
 *
 * How it works:
 *  1. compile autodl.c freestanding (-DAD_WIN -DAD_PE, no CRT, no PIC)
 *  2. parse the ELF: sections / symbols / relocations
 *  3. generate a 76-byte SysV→Win64 ABI shim for every imported API
 *     (moves rdi,rsi,rdx,rcx → rcx,rdx,r8,r9 + stack args, then calls
 *      through the IAT)
 *  4. lay out .text (code+rodata+shims+thread thunk) and .data
 *     (data + import directory + IAT + bss)
 *  5. apply relocations with final VAs
 *  6. emit a PE32+ file (console subsystem, fixed ImageBase 0x400000)
 *
 * Usage:  node pe/build.js   →  ../release/autodl.exe
 * ════════════════════════════════════════════════════════════════════ */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NATIVE = path.resolve(HERE, '..');
const OUT = path.resolve(NATIVE, '..', 'release', 'autodl.exe');

/* ── imports (must match the extern declarations in autodl.c) ── */
const DLLS = [
  ['kernel32.dll', [
    'CreateFileW', 'ReadFile', 'WriteFile', 'CloseHandle', 'GetFileAttributesW',
    'GetFileSizeEx', 'SetFilePointerEx', 'SetEndOfFile', 'MoveFileExW', 'DeleteFileW',
    'CreateDirectoryW', 'CreateThread', 'WaitForSingleObject', 'Sleep', 'ExitProcess',
    'GetCommandLineW', 'GetSystemTimeAsFileTime', 'GetStdHandle', 'GetFileType',
    'SetConsoleOutputCP', 'MultiByteToWideChar', 'WideCharToMultiByte',
    'AcquireSRWLockExclusive', 'ReleaseSRWLockExclusive',
    'SleepConditionVariableSRW', 'WakeAllConditionVariable',
  ]],
  ['winhttp.dll', [
    'WinHttpOpen', 'WinHttpConnect', 'WinHttpOpenRequest', 'WinHttpAddRequestHeaders',
    'WinHttpSetTimeouts', 'WinHttpSendRequest', 'WinHttpReceiveResponse',
    'WinHttpQueryHeaders', 'WinHttpQueryDataAvailable', 'WinHttpRead',
    'WinHttpCloseHandle', 'WinHttpCrackUrl',
  ]],
];

const IMAGE_BASE = 0x400000n;
const SEC_ALIGN = 0x1000;
const FILE_ALIGN = 0x200;
const HEADERS_SIZE = 0x200;

/* ── 1. compile ─────────────────────────────────────────────── */
const objPath = path.join(HERE, 'tmp', 'autodl.o');
fs.mkdirSync(path.dirname(objPath), { recursive: true });
const CC = process.env.CC || 'gcc';
const CFLAGS = [
  '-c', '-O2', '-std=c11',
  '-fno-pic', '-fno-pie', '-fno-stack-protector', '-mno-red-zone',
  '-ffreestanding', '-fno-builtin', '-fno-asynchronous-unwind-tables',
  '-DAD_WIN', '-DAD_PE',
];
execFileSync(CC, [...CFLAGS, '-o', objPath, path.join(NATIVE, 'autodl.c')], { stdio: 'inherit' });
console.log(`▸ compiled ${objPath}`);

/* ── 2. parse ELF64 ─────────────────────────────────────────── */
const elf = fs.readFileSync(objPath);
const dv = (off) => new DataView(elf.buffer, elf.byteOffset + off, elf.byteLength - off);
if (elf.readUInt32LE(0) !== 0x464c457f) throw new Error('not ELF');
const e_shoff = Number(elf.readBigUInt64LE(0x28));
const e_shentsize = elf.readUInt16LE(0x3a);
const e_shnum = elf.readUInt16LE(0x3c);
const e_shstrndx = elf.readUInt16LE(0x3e);

function sh(i) {
  const o = e_shoff + i * e_shentsize;
  return {
    name: elf.readUInt32LE(o),
    type: elf.readUInt32LE(o + 4),
    flags: Number(elf.readBigUInt64LE(o + 8)),
    offset: Number(elf.readBigUInt64LE(o + 0x18)),
    size: Number(elf.readBigUInt64LE(o + 0x20)),
    link: elf.readUInt32LE(o + 0x28),
    info: elf.readUInt32LE(o + 0x2c),
    align: Number(elf.readBigUInt64LE(o + 0x30)),
    entsize: Number(elf.readBigUInt64LE(o + 0x38)),
  };
}
const shstrtab = sh(e_shstrndx);
function secName(s) {
  let o = shstrtab.offset + s.name;
  let end = elf.indexOf(0, o);
  return elf.toString('utf8', o, end);
}
const sections = [];
for (let i = 0; i < e_shnum; i++) sections.push({ ...sh(i), idx: i, sname: secName(sh(i)) });

/* symbols */
const symtabs = sections.filter((s) => s.type === 2); /* SHT_SYMTAB */
const symbols = new Map(); /* name → { value, shndx } */
for (const st of symtabs) {
  const strtab = sections[st.link];
  const n = Math.floor(st.size / st.entsize);
  for (let i = 0; i < n; i++) {
    const o = st.offset + i * st.entsize;
    const nameOff = elf.readUInt32LE(o);
    const info = elf.readUInt8(o + 4);
    const shndx = elf.readUInt16LE(o + 6);
    const value = elf.readBigUInt64LE(o + 8);
    let so = strtab.offset + nameOff;
    let send = elf.indexOf(0, so);
    const name = elf.toString('utf8', so, send);
    if (!name) continue;
    const bind = info >> 4; /* 0 LOCAL, 1 GLOBAL, 2 WEAK */
    if (bind === 0 && !symbols.has(name)) symbols.set(name, { local: true, value, shndx });
    else if (bind !== 0) symbols.set(name, { local: false, value, shndx });
  }
}

/* relocations per target-section-index */
const relas = new Map(); /* target shndx → [{offset, type, symName, addend}] */
for (const s of sections) {
  if (s.type !== 4) continue; /* SHT_RELA */
  const list = relas.get(s.info) || [];
  const n = Math.floor(s.size / s.entsize);
  const symtabSec = sections[s.link];
  for (let i = 0; i < n; i++) {
    const o = s.offset + i * s.entsize;
    const offset = Number(elf.readBigUInt64LE(o));
    const info = elf.readBigUInt64LE(o + 8);
    const addend = Number(elf.readBigInt64LE(o + 0x10));
    const symIdx = Number(info >> 32n);
    const type = Number(info & 0xffffffffn);
    /* resolve symbol name */
    const so = symtabSec.offset + symIdx * symtabSec.entsize;
    const nameOff = elf.readUInt32LE(so);
    const strtab = sections[symtabSec.link];
    let stro = strtab.offset + nameOff;
    let strend = elf.indexOf(0, stro);
    const symName = elf.toString('utf8', stro, strend);
    list.push({ offset, type, symName, symIdx, addend });
  }
  relas.set(s.info, list);
}

/* ── 3. layout ──────────────────────────────────────────────── */
/* pick allocatable sections */
const code = sections.filter((s) => (s.flags & 0x2) && s.type === 1 && (s.flags & 0x4) && s.sname !== '.comment'); /* ALLOC|EXEC|PROGBITS */
const ro = sections.filter((s) => (s.flags & 0x2) && s.type === 1 && !(s.flags & 0x4) && !(s.flags & 0x1)); /* ALLOC|PROGBITS read-only */
const data = sections.filter((s) => (s.flags & 0x2) && s.type === 1 && (s.flags & 0x1) && !(s.flags & 0x4)); /* writable */
const bss = sections.filter((s) => (s.flags & 0x2) && s.type === 8); /* NOBITS */
if (!code.length) throw new Error('no .text found');
for (const s of [...code, ...ro, ...data, ...bss]) {
  if (s.sname.startsWith('.comment') || s.sname.startsWith('.note')) continue;
}
console.log(`▸ sections: ${code.map((s) => s.sname).join(', ')} | ro: ${ro.map((s) => s.sname).join(', ')} | data: ${data.map((s) => s.sname).join(', ')} | bss: ${bss.map((s) => s.sname).join(', ')}`);

/* .text image */
const TEXT_RVA = SEC_ALIGN;
let text = Buffer.alloc(1 << 20);
let textLen = 0;
const secPlaced = new Map(); /* shndx → { rva, placed } */
function place(buf, align) {
  if (align > 1) {
    const pad = (align - (textLen % align)) % align;
    textLen += pad;
  }
  const rva = TEXT_RVA + textLen;
  if (textLen + buf.length > text.length) {
    const grown = Buffer.alloc(Math.max(text.length * 2, textLen + buf.length));
    text.copy(grown, 0, 0, textLen);
    text = grown;
  }
  buf.copy(text, textLen);
  textLen += buf.length;
  return rva;
}
for (const s of [...code, ...ro]) {
  const rva = place(elf.subarray(s.offset, s.offset + s.size), Math.max(1, s.align));
  secPlaced.set(s.idx, rva);
}

/* shims: one per imported API */
const nImports = DLLS.reduce((a, [, names]) => a + names.length, 0);
const SHIM_SIZE = 80; /* 76 bytes + alignment padding */
const shimRva = new Map(); /* api name → shim rva */
let iatSlotRva = new Map(); /* api name → IAT slot rva (filled after .data layout) */
{
  const total = nImports * SHIM_SIZE;
  if (textLen + total > text.length) {
    const grown = Buffer.alloc(textLen + total + 4096);
    text.copy(grown, 0, 0, textLen);
    text = grown;
  }
}
let shimCursor = textLen;
for (const [, names] of DLLS) for (const name of names) {
  const pad = (16 - (shimCursor % 16)) % 16;
  shimCursor += pad;
  shimRva.set(name, TEXT_RVA + shimCursor);
  shimCursor += SHIM_SIZE;
}
/* thread thunk (Win64 → SysV) — placed right after the shims */
{
  const pad = (16 - (shimCursor % 16)) % 16;
  shimCursor += pad;
  shimRva.set('ad_pe_thread_thunk', TEXT_RVA + shimCursor);
  const thunk = Buffer.from([
    0x57,                                       /* push rdi              */
    0x48, 0x8b, 0x01,                           /* mov  rax, [rcx]       (fn)  */
    0x48, 0x8b, 0x79, 0x08,                     /* mov  rdi, [rcx+8]     (arg) */
    0xff, 0xd0,                                 /* call rax              */
    0x5f,                                       /* pop  rdi              */
    0xc3,                                       /* ret                   */
  ]);
  thunk.copy(text, shimCursor);
  shimCursor += thunk.length;
}
textLen = shimCursor;
const TEXT_VSIZE = textLen;

/* .data image */
const DATA_RVA = Math.ceil((TEXT_RVA + textLen) / SEC_ALIGN) * SEC_ALIGN;
let dataBuf = Buffer.alloc(1 << 16);
let dataLen = 0;
function placeData(buf, align = 1) {
  if (align > 1) {
    const pad = (align - (dataLen % align)) % align;
    dataLen += pad;
  }
  const rva = DATA_RVA + dataLen;
  if (dataLen + buf.length > dataBuf.length) {
    const grown = Buffer.alloc(Math.max(dataBuf.length * 2, dataLen + buf.length));
    dataBuf.copy(grown, 0, 0, dataLen);
    dataBuf = grown;
  }
  buf.copy(dataBuf, dataLen);
  dataLen += buf.length;
  return rva;
}
for (const s of data) {
  const rva = placeData(elf.subarray(s.offset, s.offset + s.size), Math.max(1, s.align));
  secPlaced.set(s.idx, rva);
}

/* import blob inside .data */
const DESCRIPTOR_OFF = dataLen; /* (ndll+1) × 20 */
for (let i = 0; i <= DLLS.length; i++) placeData(Buffer.alloc(20), 1);
/* dll name strings */
const dllNameRva = DLLS.map(([dll]) => placeData(Buffer.from(dll + '\0', 'ascii'), 1));
/* IAT + ILT + hint/name arrays per dll */
const iatRvaPerDll = [];
const iltRvaPerDll = [];
for (const [, names] of DLLS) {
  /* IAT first (loader writes here), then ILT copy, then BY_NAME entries.
     Both arrays are NULL-terminated (extra zero slot). */
  const iat = Buffer.alloc((names.length + 1) * 8);
  const iatRva = placeData(iat, 8);
  iatRvaPerDll.push(iatRva);
  const ilt = Buffer.alloc((names.length + 1) * 8);
  const iltRva = placeData(ilt, 8);
  iltRvaPerDll.push(iltRva);
  names.forEach((name, i) => {
    let byName = Buffer.alloc(2 + name.length + 1);
    byName.write(name, 2, 'ascii');
    if (byName.length % 2) {
      const padded = Buffer.alloc(byName.length + 1);
      byName.copy(padded);
      byName = padded;
    }
    const bnRva = placeData(byName, 2);
    /* both IAT and ILT get the BY_NAME rva (hint/name) with high bit clear */
    dataBuf.writeUInt32LE(bnRva & 0xffffffff, (iatRva - DATA_RVA) + i * 8);
    dataBuf.writeUInt32LE(0, (iatRva - DATA_RVA) + i * 8 + 4);
    dataBuf.writeUInt32LE(bnRva & 0xffffffff, (iltRva - DATA_RVA) + i * 8);
    dataBuf.writeUInt32LE(0, (iltRva - DATA_RVA) + i * 8 + 4);
    iatSlotRva.set(name, iatRva + i * 8);
  });
}
/* fill descriptors */
DLLS.forEach(([dll], i) => {
  const o = DESCRIPTOR_OFF + i * 20;
  dataBuf.writeUInt32LE(iltRvaPerDll[i], o);            /* OriginalFirstThunk */
  dataBuf.writeUInt32LE(0, o + 4);                       /* TimeDateStamp      */
  dataBuf.writeUInt32LE(0, o + 8);                       /* ForwarderChain     */
  dataBuf.writeUInt32LE(dllNameRva[i], o + 12);          /* Name               */
  dataBuf.writeUInt32LE(iatRvaPerDll[i], o + 16);        /* FirstThunk         */
});
const IMPORT_RVA = DATA_RVA + DESCRIPTOR_OFF;
const IMPORT_SIZE = (DLLS.length + 1) * 20;

/* bss (uninitialized) — extends .data VirtualSize beyond raw size */
let bssSize = 0;
for (const s of bss) {
  if (s.align > 1) {
    const pad = (s.align - ((dataLen + bssSize) % s.align)) % s.align;
    bssSize += pad;
  }
  secPlaced.set(s.idx, DATA_RVA + dataLen + bssSize);
  bssSize += s.size;
}
const DATA_VSIZE = dataLen + bssSize;

/* symbol VA resolution */
const primarySymtab = symtabs[0];
function readSymEntry(idx) {
  const st = primarySymtab;
  const o = st.offset + idx * st.entsize;
  const nameOff = elf.readUInt32LE(o);
  const info = elf.readUInt8(o + 4);
  const shndx = elf.readUInt16LE(o + 6);
  const value = elf.readBigUInt64LE(o + 8);
  const strtab = sections[st.link];
  let so = strtab.offset + nameOff;
  let send = elf.indexOf(0, so);
  const name = elf.toString('utf8', so, send);
  return { name, bind: info >> 4, shndx, value };
}
function symVA(rel) {
  if (rel.symName) {
    const sym = symbols.get(rel.symName);
    if (sym && sym.shndx !== 0) {
      const rva = secPlaced.get(sym.shndx);
      if (rva === undefined) throw new Error(`symbol section not placed: ${rel.symName} (shndx ${sym.shndx})`);
      return BigInt(rva) + sym.value;
    }
    const r = shimRva.get(rel.symName);
    if (r === undefined) throw new Error(`unresolved symbol: ${rel.symName}`);
    return BigInt(r);
  }
  /* unnamed = section symbol: S = section RVA */
  const ent = readSymEntry(rel.symIdx);
  const rva = secPlaced.get(ent.shndx);
  if (rva === undefined) throw new Error(`section symbol not placed (shndx ${ent.shndx})`);
  return BigInt(rva) + ent.value;
}

/* ── 4. generate ABI shims (now that IAT RVAs are known) ────── */
/*  mov r9,rcx; mov rcx,rdi; mov r8,rdx; mov rdx,rsi;
    5× stack-arg copies; call [rip+iat]; leave; ret          */
for (const [, names] of DLLS) for (const name of names) {
  const rva = shimRva.get(name);
  const off = rva - TEXT_RVA;
  const b = Buffer.alloc(SHIM_SIZE, 0x90); /* nop padding */
  let p = 0;
  const emit = (...bytes) => { bytes.forEach((x) => (b[p++] = x)); };
  emit(0x55);                                  /* push rbp                 */
  emit(0x48, 0x89, 0xe5);                      /* mov  rbp, rsp            */
  emit(0x48, 0x81, 0xec, 0x50, 0x00, 0x00, 0x00); /* sub  rsp, 0x50         */
  emit(0x4c, 0x89, 0xc9);                      /* mov  r9, rcx             */
  emit(0x48, 0x89, 0xf9);                      /* mov  rcx, rdi            */
  emit(0x48, 0x89, 0xd0);                      /* mov  r8, rdx             */
  emit(0x48, 0x89, 0xf2);                      /* mov  rdx, rsi            */
  const stackArgs = [0x10, 0x18, 0x20, 0x28, 0x30]; /* rbp+X (sysv 5..9)   */
  const winSlots = [0x20, 0x28, 0x30, 0x38, 0x40]; /* rsp+Y (win 5..9)    */
  for (let k = 0; k < 5; k++) {
    emit(0x48, 0x8b, 0x45, stackArgs[k]);      /* mov rax, [rbp+X]         */
    emit(0x48, 0x89, 0x44, 0x24, winSlots[k]); /* mov [rsp+Y], rax         */
  }
  /* call [rip+disp32] → IAT slot */
  const iat = iatSlotRva.get(name);
  const callInsnAt = rva + p; /* VA of the call instruction (RIP before disp) */
  const nextInsnRva = rva + p + 6;
  const disp = iat - nextInsnRva;
  if (disp < -0x80000000 || disp > 0x7fffffff) throw new Error('IAT too far');
  emit(0xff, 0x15, disp & 0xff, (disp >> 8) & 0xff, (disp >> 16) & 0xff, (disp >> 24) & 0xff);
  emit(0xc9);                                  /* leave                    */
  emit(0xc3);                                  /* ret                      */
  if (p > SHIM_SIZE) throw new Error('shim too big');
  b.copy(text, off);
}

/* ── 5. apply relocations ───────────────────────────────────── */
let nApplied = 0;
const R = { PC32: 2, PLT32: 4, '32': 10, '32S': 11, '64': 1 };
for (const [targetIdx, list] of relas) {
  const rva = secPlaced.get(targetIdx);
  if (rva === undefined) continue; /* relocations for non-alloc sections */
  const isText = rva >= TEXT_RVA && rva < TEXT_RVA + TEXT_VSIZE;
  const buf = isText ? text : dataBuf;
  const base = isText ? TEXT_RVA : DATA_RVA;
  for (const r of list) {
    const S = symVA(r);
    const A = BigInt(r.addend);
    const P = BigInt(rva + r.offset);
    const off = rva - base + r.offset;
    let val;
    switch (r.type) {
      case R.PC32:
      case R.PLT32:
        val = S + A - P;
        buf.writeInt32LE(Number(BigInt.asIntN(32, val)), off);
        break;
      case R['32']:
      case R['32S']:
        val = S + A;
        if (val > 0xffffffffn) throw new Error(`rel32 overflow for ${r.symName} (VA ${val})`);
        buf.writeUInt32LE(Number(BigInt.asUintN(32, val)), off);
        break;
      case R['64']:
        val = S + A;
        buf.writeBigUInt64LE(BigInt.asUintN(64, val), off);
        break;
      default:
        throw new Error(`unsupported reloc type ${r.type} on ${r.symName}`);
    }
    nApplied++;
  }
}

/* ── 6. emit the PE ─────────────────────────────────────────── */
const textRaw = Buffer.alloc(Math.ceil(textLen / FILE_ALIGN) * FILE_ALIGN);
text.copy(textRaw, 0, 0, textLen);
const dataRaw = Buffer.alloc(Math.ceil(dataLen / FILE_ALIGN) * FILE_ALIGN);
dataBuf.copy(dataRaw, 0, 0, dataLen);

const entry = symVA({ symName: 'ad_entry', symIdx: 0 });
const textSize = SEC_ALIGN + Math.ceil(textLen / SEC_ALIGN) * SEC_ALIGN; /* page for text */
const dataSize = Math.ceil(DATA_VSIZE / SEC_ALIGN) * SEC_ALIGN;
const sizeOfImage = SEC_ALIGN /* headers page */ + textSize + dataSize;

const pe = Buffer.alloc(HEADERS_SIZE + textRaw.length + dataRaw.length);
/* DOS header */
pe.write('MZ', 0, 'ascii');
pe.writeUInt32LE(0x80, 0x3c); /* e_lfanew */
/* PE\0\0 + COFF */
const coff = 0x80;
pe.write('PE\0\0', coff, 'ascii');
pe.writeUInt16LE(0x8664, coff + 4);        /* Machine AMD64          */
pe.writeUInt16LE(2, coff + 6);             /* NumberOfSections       */
pe.writeUInt32LE(0, coff + 8);             /* TimeDateStamp          */
pe.writeUInt32LE(0, coff + 12);            /* PtrSymbolTable         */
pe.writeUInt32LE(0, coff + 16);            /* NumberOfSymbols        */
pe.writeUInt16LE(240, coff + 20);          /* SizeOfOptionalHeader   */
pe.writeUInt16LE(0x0022, coff + 22);       /* EXECUTABLE_IMAGE|LARGE_ADDRESS_AWARE */
/* Optional header PE32+ */
const opt = coff + 24;
pe.writeUInt16LE(0x20b, opt);              /* PE32+ magic            */
pe.writeUInt8(2, opt + 2); pe.writeUInt8(0, opt + 3); /* linker ver */
pe.writeUInt32LE(textRaw.length, opt + 4); /* SizeOfCode             */
pe.writeUInt32LE(dataRaw.length, opt + 8); /* SizeOfInitializedData  */
pe.writeUInt32LE(bssSize, opt + 12);       /* SizeOfUninitializedData*/
pe.writeUInt32LE(Number(entry), opt + 16); /* AddressOfEntryPoint    */
pe.writeUInt32LE(TEXT_RVA, opt + 20);      /* BaseOfCode             */
pe.writeBigUInt64LE(IMAGE_BASE, opt + 24); /* ImageBase              */
pe.writeUInt32LE(SEC_ALIGN, opt + 32);     /* SectionAlignment       */
pe.writeUInt32LE(FILE_ALIGN, opt + 36);    /* FileAlignment          */
pe.writeUInt16LE(6, opt + 40); pe.writeUInt16LE(0, opt + 42);  /* OS 6.0 */
pe.writeUInt16LE(1, opt + 44); pe.writeUInt16LE(0, opt + 46);  /* image ver */
pe.writeUInt16LE(6, opt + 48); pe.writeUInt16LE(0, opt + 50);  /* subsystem ver */
pe.writeUInt32LE(0, opt + 52);             /* Win32VersionValue      */
pe.writeUInt32LE(sizeOfImage, opt + 56);   /* SizeOfImage            */
pe.writeUInt32LE(HEADERS_SIZE, opt + 60);  /* SizeOfHeaders          */
pe.writeUInt32LE(0, opt + 64);             /* CheckSum               */
pe.writeUInt16LE(3, opt + 68);             /* Subsystem: CONSOLE     */
pe.writeUInt16LE(0, opt + 70);             /* DllCharacteristics     */
pe.writeBigUInt64LE(0x100000n, opt + 72);  /* StackReserve 1MB       */
pe.writeBigUInt64LE(0x4000n, opt + 80);    /* StackCommit            */
pe.writeBigUInt64LE(0x100000n, opt + 88);  /* HeapReserve            */
pe.writeBigUInt64LE(0x1000n, opt + 96);    /* HeapCommit             */
pe.writeUInt32LE(0, opt + 104);            /* LoaderFlags            */
pe.writeUInt32LE(16, opt + 108);           /* NumberOfRvaAndSizes    */
/* data directories: [1] = import table */
pe.writeUInt32LE(IMPORT_RVA, opt + 112 + 1 * 8);
pe.writeUInt32LE(IMPORT_SIZE, opt + 112 + 1 * 8 + 4);

/* section headers */
const shdr = opt + 240;
function writeSection(i, name, vsize, rva, rawSize, rawPtr, flags) {
  const o = shdr + i * 40;
  pe.write(name, o, 8, 'ascii');
  pe.writeUInt32LE(vsize, o + 8);
  pe.writeUInt32LE(rva, o + 12);
  pe.writeUInt32LE(rawSize, o + 16);
  pe.writeUInt32LE(rawPtr, o + 20);
  pe.writeUInt32LE(0, o + 24); /* relocs   */
  pe.writeUInt32LE(0, o + 28); /* linenum  */
  pe.writeUInt16LE(0, o + 32); /* reloccnt */
  pe.writeUInt16LE(0, o + 34); /* linocnt  */
  pe.writeUInt32LE(flags, o + 36);
}
const textPtr = HEADERS_SIZE;
const dataPtr = textPtr + textRaw.length;
writeSection(0, '.text', TEXT_VSIZE, TEXT_RVA, textRaw.length, textPtr, 0x60000020);
writeSection(1, '.data', DATA_VSIZE, DATA_RVA, dataRaw.length, dataPtr, 0xC0000040);

textRaw.copy(pe, textPtr);
dataRaw.copy(pe, dataPtr);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, pe);
console.log(`▸ applied ${nApplied} relocations, ${nImports} imports from ${DLLS.length} DLLs`);
console.log(`✓ wrote ${OUT} (${(pe.length / 1024).toFixed(1)} KB, entry RVA 0x${entry.toString(16)}, image ${(sizeOfImage / 1024).toFixed(0)} KB)`);
