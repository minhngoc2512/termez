<script setup>
import { ref } from "vue";

const GITHUB = "https://github.com/minhngoc2512/termez";
const RELEASES = "https://github.com/minhngoc2512/termez/releases/latest";
const APT_URL = "https://minhngoc2512.github.io/termez/apt";
const VERSION = "v0.2.10";

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
    setTimeout(() => (copied.value = ""), 1400);
  });
}

// key = a terminal-ish label; dot = ANSI accent, cycled
const features = [
  { key: "terminal", dot: "bg-prompt", title: "Multiplexed terminals", desc: "Real SSH PTYs with split panes and Broadcast — type once, send to every pane at once." },
  { key: "workspaces", dot: "bg-magenta", title: "Workspaces that tile", desc: "Every host is a task. Drag one onto another to split into a workspace, and switch back and forth without dropping a session." },
  { key: "vault", dot: "bg-cyan", title: "Password vault", desc: "A KeePassXC-style vault: folder tree, .kdbx import, TOTP, and a clipboard that clears itself after ten seconds." },
  { key: "storage", dot: "bg-amber", title: "Object storage", desc: "Browse S3, R2, GCS and MinIO — upload, download, and move files between buckets like SFTP." },
  { key: "monitor", dot: "bg-prompt", title: "Live host metrics", desc: "Real-time CPU, memory, disk and network charts, opened as their own tab." },
  { key: "scan", dot: "bg-magenta", title: "Network scan", desc: "Discover LAN devices by IP, MAC and vendor, sweep hosts and ports, and add a host in one click." },
  { key: "secure", dot: "bg-cyan", title: "Locked down", desc: "Secrets live in the OS keychain, an app lock adds TOTP, and host keys are verified on first use." },
  { key: "sync", dot: "bg-amber", title: "Encrypted cloud sync", desc: "Back up your vault to a private GitHub repo, end-to-end encrypted, with automatic pull and conflict handling." },
  { key: "tunnel", dot: "bg-prompt", title: "Tunnels & DNS", desc: "Reach hosts through ProxyCommand, import ~/.ssh/config, and manage Cloudflare DNS from the app." },
];
</script>

<template>
  <div class="min-h-screen">
    <!-- Menu bar (like the app titlebar) -->
    <header class="sticky top-0 z-30 border-b border-line bg-ink/85 backdrop-blur">
      <div class="mx-auto flex max-w-6xl items-center gap-3 px-5 py-2.5 font-mono text-sm">
        <span class="text-prompt">⌘</span>
        <span class="font-semibold tracking-tight">termez</span>
        <span class="rounded border border-line px-1.5 py-0.5 text-[11px] text-muted">{{ VERSION }}</span>
        <nav class="ml-auto hidden items-center gap-6 text-muted sm:flex">
          <a href="#features" class="hover:text-fg">features</a>
          <a href="#install" class="hover:text-fg">install</a>
          <a :href="GITHUB" target="_blank" rel="noopener" class="hover:text-fg">github</a>
        </nav>
        <a :href="RELEASES" target="_blank" rel="noopener"
           class="ml-auto rounded-md bg-prompt px-3 py-1.5 font-medium text-ink hover:brightness-110 sm:ml-0">
          Download
        </a>
      </div>
    </header>

    <!-- Hero -->
    <section class="relative overflow-hidden">
      <div class="grid-bg pointer-events-none absolute inset-0 -z-10"></div>
      <div class="mx-auto grid max-w-6xl items-center gap-12 px-5 pt-20 pb-16 lg:grid-cols-[1.05fr_1fr]">
        <div>
          <p class="font-mono text-xs text-muted">
            <span class="text-prompt">//</span> ssh · sftp · workspaces · linux
          </p>
          <h1 class="mt-5 font-mono text-4xl font-bold leading-[1.08] tracking-tight sm:text-[3.35rem]">
            A terminal manager<br />that thinks in
            <span class="text-magenta">panes<span class="cursor align-middle"></span></span>
          </h1>
          <p class="mt-6 max-w-lg text-lg leading-relaxed text-muted">
            Termez is a native SSH &amp; SFTP client for Linux. Split terminals into workspaces,
            keep every session alive as you switch, and manage keys, passwords and cloud storage
            in one window.
          </p>
          <div class="mt-8 flex flex-wrap items-center gap-3">
            <a href="#install" class="rounded-md bg-prompt px-5 py-2.5 font-medium text-ink hover:brightness-110">Install via apt</a>
            <a :href="RELEASES" target="_blank" rel="noopener"
               class="rounded-md border border-line px-5 py-2.5 font-medium text-fg hover:border-muted hover:bg-panel">
              Download .deb
            </a>
          </div>
          <p class="mt-4 font-mono text-xs text-muted">Open source · built with Tauri + Rust</p>
        </div>

        <!-- Workspace mockup: two tiled panes + a status line (the signature) -->
        <div class="overflow-hidden rounded-xl border border-line bg-panel shadow-2xl shadow-black/50">
          <div class="flex items-center gap-1.5 border-b border-line px-3.5 py-2.5">
            <span class="size-2.5 rounded-full bg-[#e06c75]/70"></span>
            <span class="size-2.5 rounded-full bg-amber/70"></span>
            <span class="size-2.5 rounded-full bg-prompt/70"></span>
            <span class="ml-2 font-mono text-[11px] text-muted">workspace 1 — 2 panes</span>
          </div>
          <div class="grid grid-cols-1 divide-y divide-line font-mono text-[12.5px] leading-relaxed sm:grid-cols-2 sm:divide-x sm:divide-y-0">
            <div>
              <div class="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[11px] text-muted">
                <span class="size-1.5 rounded-full bg-prompt"></span> web-01 · ubuntu
              </div>
              <pre class="overflow-hidden px-3 py-3 text-fg"><span class="text-prompt">ubuntu@web-01</span>:<span class="text-cyan">~</span>$ df -h
Size  Used Avail Use%
 77G   18G   60G  <span class="text-amber">23%</span>
eth0 <span class="text-magenta">167.172.74.61</span>
<span class="text-prompt">ubuntu@web-01</span>:<span class="text-cyan">~</span>$ <span class="cursor"></span></pre>
            </div>
            <div>
              <div class="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[11px] text-muted">
                <span class="size-1.5 rounded-full bg-muted"></span> db-02 · root
              </div>
              <pre class="overflow-hidden px-3 py-3 text-muted"><span class="text-magenta">root@db-02</span>:<span class="text-cyan">/var</span># tail -f log
[<span class="text-prompt">ok</span>] accepted conn
[<span class="text-prompt">ok</span>] query 2.4ms
[<span class="text-amber">warn</span>] slow query
[<span class="text-prompt">ok</span>] flushed wal
</pre>
            </div>
          </div>
          <div class="flex items-center gap-3 border-t border-line bg-panel2 px-3 py-1.5 font-mono text-[11px]">
            <span class="rounded bg-prompt px-1.5 py-0.5 text-ink">WS 1</span>
            <span class="text-muted">broadcast off</span>
            <span class="ml-auto text-muted">⌘K search</span>
          </div>
        </div>
      </div>
    </section>

    <!-- Features: a window tiled into panes -->
    <section id="features" class="mx-auto max-w-6xl px-5 py-16">
      <div class="flex items-end justify-between gap-4">
        <div>
          <p class="font-mono text-xs text-muted"><span class="text-prompt">//</span> everything in one window</p>
          <h2 class="mt-2 font-mono text-3xl font-bold tracking-tight">No more tool-switching</h2>
        </div>
        <span class="hidden font-mono text-xs text-muted sm:block">9 panes</span>
      </div>

      <div class="mt-8 overflow-hidden rounded-xl border border-line bg-panel">
        <div class="grid divide-line sm:grid-cols-2 sm:divide-x lg:grid-cols-3 [&>*]:border-b [&>*]:border-line">
          <article v-for="f in features" :key="f.key" class="p-6 transition-colors hover:bg-panel2">
            <div class="flex items-center gap-2 font-mono text-xs text-muted">
              <span class="size-2 rounded-full" :class="f.dot"></span>
              <span>{{ f.key }}</span>
            </div>
            <h3 class="mt-4 font-mono text-[15px] font-semibold text-fg">{{ f.title }}</h3>
            <p class="mt-2 text-sm leading-relaxed text-muted">{{ f.desc }}</p>
          </article>
        </div>
      </div>
    </section>

    <!-- Install -->
    <section id="install" class="mx-auto max-w-3xl px-5 py-16">
      <p class="text-center font-mono text-xs text-muted"><span class="text-prompt">//</span> ubuntu · debian</p>
      <h2 class="mt-2 text-center font-mono text-3xl font-bold tracking-tight">Install on Linux</h2>
      <p class="mt-3 text-center text-muted">Add the repo once and stay current with <code class="font-mono text-prompt">apt upgrade</code>.</p>

      <div class="mx-auto mt-8 flex w-fit gap-1 rounded-lg border border-line bg-panel p-1 font-mono text-sm">
        <button @click="tab = 'apt'" :class="tab === 'apt' ? 'bg-prompt text-ink' : 'text-muted hover:text-fg'" class="rounded-md px-4 py-1.5 font-medium">apt</button>
        <button @click="tab = 'deb'" :class="tab === 'deb' ? 'bg-prompt text-ink' : 'text-muted hover:text-fg'" class="rounded-md px-4 py-1.5 font-medium">.deb</button>
      </div>

      <div class="mt-6 overflow-hidden rounded-xl border border-line bg-panel">
        <div class="flex items-center gap-2 border-b border-line px-3.5 py-2 font-mono text-[11px] text-muted">
          <span class="size-1.5 rounded-full bg-prompt"></span> install.sh
          <button @click="copy(tab === 'apt' ? aptCmd : debCmd, tab)"
                  class="ml-auto rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:bg-panel2 hover:text-fg">
            {{ copied === tab ? "copied ✓" : "copy" }}
          </button>
        </div>
        <pre v-if="tab === 'apt'" class="overflow-x-auto whitespace-pre-wrap p-5 font-mono text-[12.5px] leading-relaxed text-fg"><span class="text-prompt">$</span> {{ aptCmd }}</pre>
        <pre v-else class="overflow-x-auto p-5 font-mono text-[12.5px] leading-relaxed text-fg"><span class="text-muted"># download Termez_*_amd64.deb from Releases, then</span>
<span class="text-prompt">$</span> {{ debCmd }}</pre>
      </div>

      <div class="mt-6 rounded-xl border border-line bg-panel p-5">
        <div class="font-mono text-sm">Keeping it updated</div>
        <p class="mt-1 text-sm text-muted">Upgrade Termez only — or let it prompt you from Settings → About.</p>
        <code class="mt-3 block overflow-x-auto rounded-md border border-line bg-ink px-3 py-2 font-mono text-xs text-prompt">{{ updateCmd }}</code>
      </div>

      <p class="mt-6 text-center text-sm text-muted">
        Portable <b class="text-fg">.AppImage</b> and <b class="text-fg">.rpm</b> builds are attached to every
        <a :href="RELEASES" target="_blank" rel="noopener" class="text-magenta hover:underline">release</a>.
      </p>
    </section>

    <!-- Footer: tmux-style status line -->
    <footer class="border-t border-line">
      <div class="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3 font-mono text-xs">
        <span class="rounded bg-prompt px-2 py-0.5 text-ink">⌘ termez</span>
        <span class="text-muted">ssh / sftp manager</span>
        <span class="ml-auto text-muted">{{ VERSION }}</span>
        <a :href="GITHUB" target="_blank" rel="noopener" class="text-muted hover:text-fg">github</a>
        <a :href="RELEASES" target="_blank" rel="noopener" class="text-muted hover:text-fg">releases</a>
      </div>
    </footer>
  </div>
</template>
