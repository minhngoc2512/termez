<script setup>
import { ref } from "vue";

const GITHUB = "https://github.com/minhngoc2512/termez";
const RELEASES = "https://github.com/minhngoc2512/termez/releases/latest";
const APT_URL = "https://minhngoc2512.github.io/termez/apt";

const aptCmd =
  `curl -fsSL ${APT_URL}/termez-archive-keyring.gpg | sudo tee /usr/share/keyrings/termez.gpg >/dev/null\n` +
  `echo "deb [signed-by=/usr/share/keyrings/termez.gpg] ${APT_URL} ./" | sudo tee /etc/apt/sources.list.d/termez.list\n` +
  `sudo apt update && sudo apt install termez`;
const debCmd = "sudo apt install ./Termez_*_amd64.deb";
const updateCmd = "sudo apt update && sudo apt install --only-upgrade termez";

const tab = ref("apt");
const copied = ref("");
function copy(text, key) {
  navigator.clipboard?.writeText(text).then(() => {
    copied.value = key;
    setTimeout(() => (copied.value = ""), 1500);
  });
}

const features = [
  { icon: "M4 17l6-6-6-6M12 19h8", title: "Terminal đa phiên", desc: "SSH terminal thật (PTY), split nhiều pane, Broadcast gõ một lần gửi mọi pane." },
  { icon: "M3 7h18M3 12h18M3 17h10", title: "Workspaces", desc: "Mỗi host là một task; kéo-thả gộp thành Workspace chia đôi/ba/tư, chuyển qua lại không rớt phiên." },
  { icon: "M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zM16 11V7a4 4 0 10-8 0v4", title: "Quản lý mật khẩu", desc: "Kho kiểu KeePassXC: cây thư mục, import .kdbx, 2FA, tự xoá clipboard sau 10s." },
  { icon: "M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8", title: "Storage S3 / R2 / GCS / MinIO", desc: "Duyệt bucket, upload/download, kéo-thả, chuyển file giữa 2 bucket kiểu SFTP." },
  { icon: "M3 3v18h18M9 17V9m4 8V5m4 12v-6", title: "Giám sát host", desc: "Biểu đồ CPU / RAM / ổ đĩa / mạng theo thời gian thực, mở thành tab riêng." },
  { icon: "M12 2a10 10 0 100 20 10 10 0 000-20zM2 12h20M12 2a15 15 0 010 20M12 2a15 15 0 000 20", title: "Network Scan", desc: "Quét thiết bị LAN (IP/MAC/hãng), dò host & cổng, thêm host bằng một cú nhấp." },
  { icon: "M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4z", title: "Bảo mật", desc: "Secret trong OS keychain, App Lock + 2FA (TOTP), xác minh host key (TOFU)." },
  { icon: "M3 15a4 4 0 004 4h9a5 5 0 001-9.9A6 6 0 006.34 8 4 4 0 003 15z", title: "Cloud Sync E2E", desc: "Sao lưu vault mã hoá đầu-cuối lên GitHub riêng tư; tự pull, xử lý xung đột." },
  { icon: "M13 2L3 14h7l-1 8 10-12h-7l1-8z", title: "Cloudflare Tunnel & DNS", desc: "SSH qua ProxyCommand, import ~/.ssh/config, quản lý DNS qua Cloudflare API." },
];
</script>

<template>
  <div class="min-h-screen antialiased">
    <!-- glow nền -->
    <div class="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div class="absolute -top-40 left-1/2 h-[36rem] w-[36rem] -translate-x-1/2 rounded-full bg-green-500/10 blur-[120px]"></div>
      <div class="absolute bottom-0 right-0 h-[28rem] w-[28rem] rounded-full bg-emerald-600/10 blur-[120px]"></div>
    </div>

    <!-- Nav -->
    <header class="sticky top-0 z-30 border-b border-white/5 bg-[#090d14]/80 backdrop-blur">
      <div class="mx-auto flex max-w-6xl items-center gap-3 px-5 py-3.5">
        <span class="grid size-8 place-items-center rounded-lg bg-green-500/15 text-green-400">⌘</span>
        <span class="text-lg font-semibold tracking-tight">Termez</span>
        <nav class="ml-auto hidden items-center gap-6 text-sm text-slate-400 sm:flex">
          <a href="#features" class="hover:text-white">Tính năng</a>
          <a href="#install" class="hover:text-white">Cài đặt</a>
          <a :href="GITHUB" target="_blank" class="hover:text-white">GitHub</a>
        </nav>
        <a :href="RELEASES" target="_blank"
           class="ml-auto rounded-lg bg-green-500 px-3.5 py-1.5 text-sm font-medium text-green-950 hover:bg-green-400 sm:ml-0">
          Tải về
        </a>
      </div>
    </header>

    <!-- Hero -->
    <section class="mx-auto max-w-6xl px-5 pt-20 pb-16 text-center">
      <span class="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300">
        <span class="size-1.5 rounded-full bg-green-400"></span> Mã nguồn mở · Tauri + Rust · dành cho Linux
      </span>
      <h1 class="mx-auto mt-6 max-w-3xl text-4xl font-bold leading-[1.1] tracking-tight sm:text-6xl">
        Quản lý <span class="bg-gradient-to-r from-green-400 to-emerald-300 bg-clip-text text-transparent">SSH & SFTP</span>
        mượt như Termius
      </h1>
      <p class="mx-auto mt-5 max-w-2xl text-lg text-slate-400">
        Terminal split, kho mật khẩu, storage S3, giám sát host thời gian thực và đồng bộ mã hoá đầu-cuối —
        gói gọn trong một app gốc, nhẹ, riêng tư.
      </p>
      <div class="mt-8 flex flex-wrap items-center justify-center gap-3">
        <a href="#install" class="rounded-xl bg-green-500 px-5 py-3 font-medium text-green-950 hover:bg-green-400">Cài qua apt</a>
        <a :href="RELEASES" target="_blank" class="rounded-xl border border-white/10 bg-white/5 px-5 py-3 font-medium hover:bg-white/10">Tải .deb / AppImage</a>
      </div>

      <!-- terminal mockup -->
      <div class="mx-auto mt-14 max-w-3xl overflow-hidden rounded-2xl border border-white/10 bg-[#0b0f16] text-left shadow-2xl">
        <div class="flex items-center gap-1.5 border-b border-white/5 px-4 py-3">
          <span class="size-3 rounded-full bg-red-400/70"></span>
          <span class="size-3 rounded-full bg-yellow-400/70"></span>
          <span class="size-3 rounded-full bg-green-400/70"></span>
          <span class="ml-3 text-xs text-slate-500">⌘ Termez — ez_craft_3_cluster</span>
        </div>
        <pre class="overflow-x-auto p-5 font-mono text-[13px] leading-relaxed text-slate-300"><span class="text-green-400">ubuntu@we-craft-3</span>:<span class="text-sky-400">~</span>$ df -h
Filesystem      Size  Used Avail Use% Mounted on
/dev/vda1        77G   18G   60G  <span class="text-yellow-300">23%</span> /
IPv4 address for eth0: <span class="text-fuchsia-400">167.172.74.61</span>
<span class="text-green-400">ubuntu@we-craft-3</span>:<span class="text-sky-400">~</span>$ <span class="animate-pulse">▋</span></pre>
      </div>
    </section>

    <!-- Features -->
    <section id="features" class="mx-auto max-w-6xl px-5 py-16">
      <h2 class="text-center text-3xl font-bold tracking-tight">Mọi thứ cho một phiên làm việc</h2>
      <p class="mx-auto mt-3 max-w-xl text-center text-slate-400">Không cần chuyển qua lại nhiều công cụ.</p>
      <div class="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        <div v-for="f in features" :key="f.title"
             class="group rounded-2xl border border-white/10 bg-white/[0.03] p-6 transition hover:border-green-500/40 hover:bg-white/[0.06]">
          <div class="grid size-11 place-items-center rounded-xl bg-green-500/15 text-green-400">
            <svg class="size-6" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
              <path :d="f.icon" />
            </svg>
          </div>
          <h3 class="mt-4 font-semibold">{{ f.title }}</h3>
          <p class="mt-1.5 text-sm leading-relaxed text-slate-400">{{ f.desc }}</p>
        </div>
      </div>
    </section>

    <!-- Install -->
    <section id="install" class="mx-auto max-w-3xl px-5 py-16">
      <h2 class="text-center text-3xl font-bold tracking-tight">Cài đặt trên Linux</h2>
      <p class="mt-3 text-center text-slate-400">Ubuntu / Debian. Tự cập nhật qua <code class="text-green-400">apt</code>.</p>

      <div class="mx-auto mt-8 flex w-fit gap-1 rounded-xl border border-white/10 bg-white/5 p-1 text-sm">
        <button @click="tab = 'apt'" :class="tab === 'apt' ? 'bg-green-500 text-green-950' : 'text-slate-300 hover:text-white'" class="rounded-lg px-4 py-1.5 font-medium">apt (khuyến nghị)</button>
        <button @click="tab = 'deb'" :class="tab === 'deb' ? 'bg-green-500 text-green-950' : 'text-slate-300 hover:text-white'" class="rounded-lg px-4 py-1.5 font-medium">.deb</button>
      </div>

      <div class="relative mt-6 rounded-2xl border border-white/10 bg-[#0b0f16]">
        <button @click="copy(tab === 'apt' ? aptCmd : debCmd, tab)"
                class="absolute right-3 top-3 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-300 hover:bg-white/10">
          {{ copied === tab ? "Đã chép ✓" : "Copy" }}
        </button>
        <pre v-if="tab === 'apt'" class="overflow-x-auto whitespace-pre-wrap p-5 pr-20 font-mono text-[13px] leading-relaxed text-slate-300">{{ aptCmd }}</pre>
        <pre v-else class="overflow-x-auto p-5 pr-20 font-mono text-[13px] leading-relaxed text-slate-300">Tải Termez_*_amd64.deb từ trang Releases, rồi:
{{ debCmd }}</pre>
      </div>

      <div class="mt-6 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <div class="text-sm font-medium">Cập nhật về sau</div>
        <p class="mt-1 text-sm text-slate-400">Chỉ nâng riêng Termez — hoặc để app tự nhắc trong Settings → About:</p>
        <code class="mt-3 block overflow-x-auto rounded-lg bg-black/40 px-3 py-2 font-mono text-xs text-green-300">{{ updateCmd }}</code>
      </div>

      <p class="mt-6 text-center text-sm text-slate-500">
        Cũng có bản <b class="text-slate-300">.AppImage</b> (portable) và <b class="text-slate-300">.rpm</b> trong mỗi
        <a :href="RELEASES" target="_blank" class="text-green-400 hover:underline">bản phát hành</a>.
      </p>
    </section>

    <!-- Footer -->
    <footer class="border-t border-white/5">
      <div class="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-5 py-8 text-sm text-slate-500 sm:flex-row">
        <div class="flex items-center gap-2">
          <span class="grid size-6 place-items-center rounded-md bg-green-500/15 text-green-400">⌘</span>
          Termez — SSH / SFTP manager
        </div>
        <div class="flex items-center gap-5">
          <a :href="GITHUB" target="_blank" class="hover:text-white">GitHub</a>
          <a :href="RELEASES" target="_blank" class="hover:text-white">Releases</a>
        </div>
      </div>
    </footer>
  </div>
</template>
