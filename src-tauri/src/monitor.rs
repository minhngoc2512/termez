//! Giám sát host qua SSH: đọc /proc + df mỗi 2 giây, tính CPU%/RAM/net/disk,
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
    loop {
        let now = Instant::now();
        let raw = match run_command(&conn.handle, METRICS_CMD).await {
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
        };
        let _ = app.emit("monitor:data", serde_json::json!({ "id": id, "metrics": metrics }));

        prev = Some((raw, now));
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
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
            _ => {}
        }
    }
    r
}
