//! Giám sát host qua SSH: đọc /proc + df (và nvidia-smi nếu có GPU) mỗi 2 giây, tính CPU%/RAM/net/disk/GPU,
//! phát event "monitor:data" cho frontend vẽ chart.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use russh::client::Handle;
use russh::ChannelMsg;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tokio::task::AbortHandle;

use crate::conn::{ClientHandler, Connection};

const METRICS_CMD: &str = "echo @@stat; head -1 /proc/stat; echo @@mem; cat /proc/meminfo; echo @@net; cat /proc/net/dev; echo @@load; cat /proc/loadavg; echo @@up; head -1 /proc/uptime; echo @@df; df -PkT 2>/dev/null";

#[derive(Serialize)]
pub struct Disk {
    pub mount: String,
    pub device: String,
    pub used_kb: u64,
    pub total_kb: u64,
}

#[derive(Serialize)]
pub struct Metrics {
    pub cpu_percent: f64,
    pub mem_used_kb: u64,
    pub mem_total_kb: u64,
    pub load1: f64,
    pub uptime_secs: f64,
    pub net_rx_bps: f64,
    pub net_tx_bps: f64,
    pub disks: Vec<Disk>,
    /// Trống nếu máy không có GPU NVIDIA.
    pub gpus: Vec<Gpu>,
    pub gpu_procs: Vec<GpuProc>,
}

#[derive(Default, Clone)]
struct Raw {
    cpu_total: u64,
    cpu_idle: u64,
    mem_total: u64,
    mem_avail: u64,
    net_rx: u64,
    net_tx: u64,
    load1: f64,
    uptime: f64,
    disks: Vec<(String, String, u64, u64)>, // mount, device, used, total
    gpu: GpuRaw,
}

pub struct MonitorManager {
    sessions: Mutex<HashMap<String, AbortHandle>>,
}

impl MonitorManager {
    pub fn new() -> Self {
        Self { sessions: Mutex::new(HashMap::new()) }
    }

    /// Bắt đầu giám sát host (id = host_id). Nếu đang chạy thì thay thế.
    pub async fn start(&self, app: AppHandle, id: String, conn: Arc<Connection>) {
        let mut map = self.sessions.lock().await;
        if let Some(h) = map.remove(&id) {
            h.abort();
        }
        let handle = tokio::spawn(monitor_loop(app, id.clone(), conn));
        map.insert(id, handle.abort_handle());
    }

    pub async fn stop(&self, id: &str) {
        if let Some(h) = self.sessions.lock().await.remove(id) {
            h.abort();
        }
    }
}

impl Default for MonitorManager {
    fn default() -> Self {
        Self::new()
    }
}

async fn monitor_loop(app: AppHandle, id: String, conn: Arc<Connection>) {
    let mut prev: Option<(Raw, Instant)> = None;
    let cmd = metrics_cmd();
    loop {
        let now = Instant::now();
        let raw = match run_command(&conn.handle, &cmd).await {
            Ok(out) => parse(&out),
            Err(err) => {
                let _ = app.emit(
                    "monitor:data",
                    serde_json::json!({ "id": id, "error": err.to_string() }),
                );
                break;
            }
        };

        let (cpu_percent, net_rx_bps, net_tx_bps) = if let Some((p, t)) = &prev {
            let dt = now.duration_since(*t).as_secs_f64().max(0.1);
            let dtot = raw.cpu_total.saturating_sub(p.cpu_total) as f64;
            let didle = raw.cpu_idle.saturating_sub(p.cpu_idle) as f64;
            let cpu = if dtot > 0.0 { ((1.0 - didle / dtot) * 100.0).clamp(0.0, 100.0) } else { 0.0 };
            let rx = raw.net_rx.saturating_sub(p.net_rx) as f64 / dt;
            let tx = raw.net_tx.saturating_sub(p.net_tx) as f64 / dt;
            (cpu, rx, tx)
        } else {
            (0.0, 0.0, 0.0)
        };

        let (gpus, gpu_procs) = parse_gpus(&raw.gpu);
        let metrics = Metrics {
            cpu_percent,
            mem_used_kb: raw.mem_total.saturating_sub(raw.mem_avail),
            mem_total_kb: raw.mem_total,
            load1: raw.load1,
            uptime_secs: raw.uptime,
            net_rx_bps,
            net_tx_bps,
            disks: raw
                .disks
                .iter()
                .map(|(mount, device, used, total)| Disk {
                    mount: mount.clone(),
                    device: device.clone(),
                    used_kb: *used,
                    total_kb: *total,
                })
                .collect(),
            gpus,
            gpu_procs,
        };
        let _ = app.emit("monitor:data", serde_json::json!({ "id": id, "metrics": metrics }));

        prev = Some((raw, now));
        // Giữ nhịp ~2 giây kể cả khi lệnh chạy lâu (nvidia-smi trên máy nhiều GPU).
        let wait = std::time::Duration::from_secs(2).saturating_sub(now.elapsed());
        tokio::time::sleep(wait.max(std::time::Duration::from_millis(500))).await;
    }
}

async fn run_command(handle: &Handle<ClientHandler>, cmd: &str) -> anyhow::Result<String> {
    let mut channel = handle.channel_open_session().await?;
    channel.exec(true, cmd).await?;
    let mut out = Vec::new();
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Data { data }) => out.extend_from_slice(&data),
            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
            _ => {}
        }
    }
    Ok(String::from_utf8_lossy(&out).to_string())
}

fn parse(raw: &str) -> Raw {
    let mut r = Raw::default();
    let mut section = "";
    for line in raw.lines() {
        if let Some(s) = line.strip_prefix("@@") {
            section = s;
            continue;
        }
        match section {
            "stat" if line.starts_with("cpu ") => {
                let n: Vec<u64> = line.split_whitespace().skip(1).filter_map(|x| x.parse().ok()).collect();
                r.cpu_total = n.iter().sum();
                r.cpu_idle = n.get(3).copied().unwrap_or(0) + n.get(4).copied().unwrap_or(0);
            }
            "mem" => {
                if let Some(v) = line.strip_prefix("MemTotal:") {
                    r.mem_total = v.split_whitespace().next().and_then(|x| x.parse().ok()).unwrap_or(0);
                } else if let Some(v) = line.strip_prefix("MemAvailable:") {
                    r.mem_avail = v.split_whitespace().next().and_then(|x| x.parse().ok()).unwrap_or(0);
                }
            }
            "net" => {
                if let Some((name, rest)) = line.split_once(':') {
                    let name = name.trim();
                    if name != "lo" && !name.is_empty() {
                        let nums: Vec<u64> = rest.split_whitespace().filter_map(|x| x.parse().ok()).collect();
                        r.net_rx += nums.first().copied().unwrap_or(0);
                        r.net_tx += nums.get(8).copied().unwrap_or(0);
                    }
                }
            }
            "load" => {
                r.load1 = line.split_whitespace().next().and_then(|x| x.parse().ok()).unwrap_or(0.0);
            }
            "up" => {
                r.uptime = line.split_whitespace().next().and_then(|x| x.parse().ok()).unwrap_or(0.0);
            }
            "df" => {
                let f: Vec<&str> = line.split_whitespace().collect();
                // Filesystem Type 1024-blocks Used Available Capacity Mounted-on
                if f.len() >= 7 && f[2] != "1024-blocks" {
                    let ty = f[1];
                    let skip = matches!(ty, "tmpfs" | "devtmpfs" | "squashfs" | "overlay" | "none" | "proc" | "sysfs" | "devpts" | "cgroup" | "cgroup2");
                    let total: u64 = f[2].parse().unwrap_or(0);
                    let used: u64 = f[3].parse().unwrap_or(0);
                    if !skip && total > 0 {
                        r.disks.push((f[6..].join(" "), f[0].to_string(), used, total));
                    }
                }
            }
            "gpu" => r.gpu.gpu.push(line.to_string()),
            "gpuapps" => r.gpu.apps.push(line.to_string()),
            "gpupmon" => r.gpu.pmon.push(line.to_string()),
            "gpudmon" => r.gpu.dmon.push(line.to_string()),
            "gpups" => r.gpu.ps.push(line.to_string()),
            _ => {}
        }
    }
    r
}

// ----- GPU (NVIDIA) -----

/// Chỉ chạy khi máy có nvidia-smi, nên VPS không GPU không tốn gì. Chạy qua `sh -c '…'` để không
/// phụ thuộc shell đăng nhập (fish…); vì vậy script KHÔNG được chứa dấu nháy đơn.
const GPU_SCRIPT: &str = r#"command -v nvidia-smi >/dev/null 2>&1 || exit 0
echo @@gpu
nvidia-smi --query-gpu=index,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,fan.speed,clocks.gr,clocks.mem,pcie.link.gen.current,pcie.link.width.current --format=csv,noheader,nounits 2>/dev/null
echo @@gpuapps
APPS=$(nvidia-smi --query-compute-apps=gpu_uuid,pid,used_memory --format=csv,noheader,nounits 2>/dev/null)
printf "%s\n" "$APPS"
echo @@gpupmon
PM=$(nvidia-smi pmon -c 1 -s um 2>/dev/null)
printf "%s\n" "$PM"
echo @@gpudmon
nvidia-smi dmon -c 1 -s t 2>/dev/null
echo @@gpups
PIDS=$( { printf "%s\n" "$PM" | awk "\$1 !~ /^#/ {print \$2}"; printf "%s\n" "$APPS" | cut -d, -f2; } | tr -d " " | grep -E "^[0-9]+$" | sort -u | paste -sd, -)
[ -n "$PIDS" ] && ps -o pid=,user=,pcpu=,rss=,args= -p "$PIDS" 2>/dev/null
exit 0"#;

/// Lệnh đầy đủ mỗi chu kỳ: số liệu hệ thống + GPU.
fn metrics_cmd() -> String {
    format!("{METRICS_CMD}; sh -c '{GPU_SCRIPT}'")
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Gpu {
    pub index: u32,
    pub name: String,
    pub util: Option<f64>,
    pub mem_used_mb: Option<f64>,
    pub mem_total_mb: Option<f64>,
    pub temp: Option<f64>,
    pub power_w: Option<f64>,
    pub power_limit_w: Option<f64>,
    pub fan: Option<f64>,
    pub clock_gr: Option<f64>,
    pub clock_mem: Option<f64>,
    pub pcie_gen: Option<f64>,
    pub pcie_width: Option<f64>,
    /// Băng thông PCIe (MB/s) từ `nvidia-smi dmon -s t`.
    pub rx_mbps: Option<f64>,
    pub tx_mbps: Option<f64>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct GpuProc {
    pub gpu: u32,
    pub pid: u32,
    /// C (compute), G (graphics), C+G
    pub kind: String,
    /// % SM đang dùng (pmon); None khi driver không đo được.
    pub sm: Option<f64>,
    pub mem_used_mb: Option<f64>,
    pub user: Option<String>,
    pub cpu: Option<f64>,
    pub host_mem_kb: Option<u64>,
    pub command: String,
}

/// Các dòng thô của phần GPU, ghép lại sau khi đọc hết output.
#[derive(Default, Clone)]
struct GpuRaw {
    gpu: Vec<String>,
    apps: Vec<String>,
    pmon: Vec<String>,
    dmon: Vec<String>,
    ps: Vec<String>,
}

/// "42", "1.26" → số; "[N/A]", "[Not Supported]", "-" → None.
fn num(s: &str) -> Option<f64> {
    s.trim().parse::<f64>().ok().filter(|v| v.is_finite())
}

/// Bảng kiểu pmon/dmon: dòng "# a b c" đầu tiên là tên cột, dòng "#" thứ hai là đơn vị.
/// Cột cuối được nối phần còn lại (tên lệnh có thể chứa dấu cách).
fn table(lines: &[String]) -> Vec<HashMap<String, String>> {
    let mut cols: Option<Vec<String>> = None;
    let mut rows = Vec::new();
    for line in lines {
        if let Some(h) = line.trim_start().strip_prefix('#') {
            if cols.is_none() {
                cols = Some(h.split_whitespace().map(str::to_string).collect());
            }
            continue;
        }
        let Some(cols) = &cols else { continue };
        let t: Vec<&str> = line.split_whitespace().collect();
        if t.len() < cols.len() || cols.is_empty() {
            continue;
        }
        let mut row = HashMap::new();
        for (i, c) in cols.iter().enumerate() {
            let v = if i + 1 == cols.len() { t[i..].join(" ") } else { t[i].to_string() };
            row.insert(c.clone(), v);
        }
        rows.push(row);
    }
    rows
}

fn parse_gpus(raw: &GpuRaw) -> (Vec<Gpu>, Vec<GpuProc>) {
    let mut gpus = Vec::new();
    let mut uuid_to_index = HashMap::new();
    for line in &raw.gpu {
        let f: Vec<&str> = line.split(',').map(str::trim).collect();
        if f.len() < 14 {
            continue;
        }
        let Ok(index) = f[0].parse::<u32>() else { continue };
        uuid_to_index.insert(f[1].to_string(), index);
        gpus.push(Gpu {
            index,
            name: f[2].to_string(),
            util: num(f[3]),
            mem_used_mb: num(f[4]),
            mem_total_mb: num(f[5]),
            temp: num(f[6]),
            power_w: num(f[7]),
            power_limit_w: num(f[8]),
            fan: num(f[9]),
            clock_gr: num(f[10]),
            clock_mem: num(f[11]),
            pcie_gen: num(f[12]),
            pcie_width: num(f[13]),
            rx_mbps: None,
            tx_mbps: None,
        });
    }
    for row in table(&raw.dmon) {
        let Some(i) = row.get("gpu").and_then(|v| v.parse::<u32>().ok()) else { continue };
        if let Some(g) = gpus.iter_mut().find(|g| g.index == i) {
            g.rx_mbps = row.get("rxpci").and_then(|v| num(v));
            g.tx_mbps = row.get("txpci").and_then(|v| num(v));
        }
    }

    // pid → (user, %cpu, rss KB, lệnh đầy đủ)
    let mut ps = HashMap::new();
    for line in &raw.ps {
        let t: Vec<&str> = line.split_whitespace().collect();
        if t.len() < 5 {
            continue;
        }
        let Ok(pid) = t[0].parse::<u32>() else { continue };
        let mut cmd = t[4..].join(" ");
        if cmd.len() > 400 {
            let mut cut = 400;
            while !cmd.is_char_boundary(cut) {
                cut -= 1;
            }
            cmd.truncate(cut);
        }
        ps.insert(pid, (t[1].to_string(), num(t[2]), t[3].parse::<u64>().ok(), cmd));
    }

    let mut procs: Vec<GpuProc> = Vec::new();
    for row in table(&raw.pmon) {
        let (Some(gpu), Some(pid)) = (
            row.get("gpu").and_then(|v| v.parse::<u32>().ok()),
            row.get("pid").and_then(|v| v.parse::<u32>().ok()),
        ) else {
            continue;
        };
        procs.push(GpuProc {
            gpu,
            pid,
            kind: row.get("type").cloned().unwrap_or_default(),
            sm: row.get("sm").and_then(|v| num(v)),
            mem_used_mb: row.get("fb").and_then(|v| num(v)),
            user: None,
            cpu: None,
            host_mem_kb: None,
            command: row.get("command").cloned().unwrap_or_default(),
        });
    }
    // query-compute-apps: số MiB chính xác; bổ sung tiến trình pmon không thấy (MIG, driver cũ).
    for line in &raw.apps {
        let f: Vec<&str> = line.split(',').map(str::trim).collect();
        if f.len() < 3 {
            continue;
        }
        let (Some(&gpu), Ok(pid)) = (uuid_to_index.get(f[0]), f[1].parse::<u32>()) else { continue };
        let used = num(f[2]);
        match procs.iter_mut().find(|p| p.gpu == gpu && p.pid == pid) {
            Some(p) => {
                if used.is_some() {
                    p.mem_used_mb = used;
                }
            }
            None => procs.push(GpuProc {
                gpu,
                pid,
                kind: "C".into(),
                sm: None,
                mem_used_mb: used,
                user: None,
                cpu: None,
                host_mem_kb: None,
                command: String::new(),
            }),
        }
    }
    for p in &mut procs {
        if let Some((user, cpu, rss, cmd)) = ps.get(&p.pid) {
            p.user = Some(user.clone());
            p.cpu = *cpu;
            p.host_mem_kb = *rss;
            p.command = cmd.clone();
        }
    }
    procs.sort_by(|a, b| b.mem_used_mb.unwrap_or(0.0).total_cmp(&a.mem_used_mb.unwrap_or(0.0)));
    (gpus, procs)
}

#[cfg(test)]
mod tests {
    use super::*;

    const H20: &str = "\
@@gpu
0, GPU-aaaa, NVIDIA H20, 0, 66252, 97871, 33, 131.04, 500.00, [N/A], 1980, 2619, 5, 16
1, GPU-bbbb, NVIDIA H20, 100, 83740, 97871, 48, 340.10, 500.00, [N/A], 1980, 2619, 5, 16
@@gpuapps
GPU-bbbb, 17361, 45196
GPU-aaaa, 25612, 35076
GPU-aaaa, 777, 100
@@gpupmon
# gpu         pid   type     sm    mem    enc    dec    jpg    ofa     fb   ccpm    command 
# Idx           #    C/G      %      %      %      %      %      %     MB     MB    name 
    1      17361     C     33     20      -      -      -      -  45196      0    VLLM::EngineCor
    0      25612     C      -      -      -      -      -      -  35076      0    chrome --type=g
@@gpudmon
# gpu  rxpci  txpci 
# Idx   MB/s   MB/s 
    0      0      3 
    1     38     12 
@@gpups
17361 ubuntu  137  3271000 VLLM::EngineCore
25612 root      1.5 12000000 /usr/bin/python3 -m vllm.entrypoints.openai.api_server --port 8000
";

    #[test]
    fn parses_gpus_and_processes() {
        let r = parse(H20);
        let (gpus, procs) = parse_gpus(&r.gpu);
        assert_eq!(gpus.len(), 2);
        let g = &gpus[0];
        assert_eq!((g.index, g.name.as_str()), (0, "NVIDIA H20"));
        assert_eq!((g.util, g.mem_used_mb, g.mem_total_mb), (Some(0.0), Some(66252.0), Some(97871.0)));
        assert_eq!((g.power_w, g.power_limit_w, g.fan), (Some(131.04), Some(500.0), None));
        assert_eq!((g.pcie_gen, g.pcie_width, g.rx_mbps, g.tx_mbps), (Some(5.0), Some(16.0), Some(0.0), Some(3.0)));
        assert_eq!(gpus[1].rx_mbps, Some(38.0));

        assert_eq!(procs.len(), 3);
        // Sắp theo bộ nhớ GPU giảm dần.
        assert_eq!(procs[0].pid, 17361);
        assert_eq!((procs[0].sm, procs[0].user.as_deref(), procs[0].cpu), (Some(33.0), Some("ubuntu"), Some(137.0)));
        assert_eq!(procs[0].host_mem_kb, Some(3271000));
        let py = procs.iter().find(|p| p.pid == 25612).unwrap();
        assert_eq!(py.sm, None);
        assert!(py.command.starts_with("/usr/bin/python3 -m vllm"));
        // Chỉ có trong compute-apps, không có trong ps (vd tiến trình trong container khác).
        let only = procs.iter().find(|p| p.pid == 777).unwrap();
        assert_eq!((only.gpu, only.mem_used_mb, only.user.as_ref()), (0, Some(100.0), None));
    }

    #[test]
    fn no_gpu_means_empty() {
        let (gpus, procs) = parse_gpus(&parse("@@stat\ncpu  1 2 3 4 5\n").gpu);
        assert!(gpus.is_empty() && procs.is_empty());
    }

    #[test]
    fn gpu_script_has_no_single_quote() {
        assert!(!GPU_SCRIPT.contains('\''));
    }

    /// Chạy script thật trên máy có NVIDIA (bỏ qua nếu không có nvidia-smi).
    #[test]
    fn real_nvidia_smi_if_present() {
        if std::process::Command::new("nvidia-smi").arg("-L").output().map(|o| !o.status.success()).unwrap_or(true) {
            return;
        }
        // Đúng lệnh app gửi qua SSH, chạy trong một shell đăng nhập kiểu bash.
        let out = std::process::Command::new("bash").arg("-c").arg(metrics_cmd()).output().unwrap();
        let (gpus, procs) = parse_gpus(&parse(&String::from_utf8_lossy(&out.stdout)).gpu);
        assert!(!gpus.is_empty(), "{}", String::from_utf8_lossy(&out.stdout));
        assert!(gpus[0].mem_total_mb.unwrap_or(0.0) > 0.0);
        eprintln!("{gpus:#?}\n{procs:#?}");
    }
}
