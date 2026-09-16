//! Quét mạng bằng TCP connect (không cần quyền root như SYN scan).
//! - `scan_hosts`: dò các IP còn sống trong một dải CIDR (mở một cổng nào đó, vd 22).
//! - `scan_ports`: quét danh sách cổng trên một máy → cổng nào đang mở.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tokio::net::TcpStream;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tokio::time::timeout;

/// Thử mở kết nối TCP tới `addr` trong `ms` mili-giây.
async fn is_open(addr: SocketAddr, ms: u64) -> bool {
    matches!(
        timeout(Duration::from_millis(ms), TcpStream::connect(addr)).await,
        Ok(Ok(_))
    )
}

/// Liệt kê các host trong một dải CIDR IPv4 (bỏ địa chỉ network/broadcast với /≤30).
fn cidr_hosts(cidr: &str) -> anyhow::Result<Vec<Ipv4Addr>> {
    let (ip, prefix) = cidr
        .split_once('/')
        .ok_or_else(|| anyhow::anyhow!("Cần dạng CIDR, ví dụ 192.168.1.0/24"))?;
    let base: Ipv4Addr = ip.trim().parse()?;
    let prefix: u32 = prefix.trim().parse()?;
    if prefix > 32 {
        anyhow::bail!("Prefix không hợp lệ");
    }
    let base_u = u32::from(base);
    let mask = if prefix == 0 { 0 } else { u32::MAX << (32 - prefix) };
    let network = base_u & mask;
    let total = 1u64 << (32 - prefix);
    if total > 65_536 {
        anyhow::bail!("Dải quá lớn (tối đa /16)");
    }

    let mut out = Vec::new();
    if prefix >= 31 {
        for i in 0..total {
            out.push(Ipv4Addr::from(network + i as u32));
        }
    } else {
        for i in 1..(total - 1) {
            out.push(Ipv4Addr::from(network + i as u32));
        }
    }
    Ok(out)
}

/// Phân giải hostname → IP (chấp nhận sẵn IP).
async fn resolve_ip(host: &str) -> anyhow::Result<IpAddr> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(ip);
    }
    tokio::net::lookup_host((host, 0))
        .await?
        .next()
        .map(|s| s.ip())
        .ok_or_else(|| anyhow::anyhow!("Không phân giải được {host}"))
}

pub async fn scan_hosts(
    cidr: &str,
    port: u16,
    timeout_ms: u64,
    concurrency: usize,
) -> anyhow::Result<Vec<String>> {
    let hosts = cidr_hosts(cidr)?;
    let sem = Arc::new(Semaphore::new(concurrency.max(1)));
    let mut set = JoinSet::new();
    for ip in hosts {
        let permit = sem.clone().acquire_owned().await.unwrap();
        let addr = SocketAddr::new(IpAddr::V4(ip), port);
        set.spawn(async move {
            let _permit = permit;
            if is_open(addr, timeout_ms).await {
                Some(ip)
            } else {
                None
            }
        });
    }
    let mut open = Vec::new();
    while let Some(res) = set.join_next().await {
        if let Ok(Some(ip)) = res {
            open.push(ip);
        }
    }
    open.sort();
    Ok(open.into_iter().map(|ip| ip.to_string()).collect())
}

pub async fn scan_ports(
    host: &str,
    ports: Vec<u16>,
    timeout_ms: u64,
    concurrency: usize,
) -> anyhow::Result<Vec<u16>> {
    let ip = resolve_ip(host).await?;
    let sem = Arc::new(Semaphore::new(concurrency.max(1)));
    let mut set = JoinSet::new();
    for p in ports {
        let permit = sem.clone().acquire_owned().await.unwrap();
        let addr = SocketAddr::new(ip, p);
        set.spawn(async move {
            let _permit = permit;
            if is_open(addr, timeout_ms).await {
                Some(p)
            } else {
                None
            }
        });
    }
    let mut open = Vec::new();
    while let Some(res) = set.join_next().await {
        if let Ok(Some(p)) = res {
            open.push(p);
        }
    }
    open.sort_unstable();
    Ok(open)
}

// ----- Dò thiết bị LAN qua bảng ARP (không cần root) -----

#[derive(Serialize)]
pub struct LanDevice {
    pub ip: String,
    pub mac: String,
    pub vendor: Option<String>,
    pub hostname: Option<String>,
    pub is_gateway: bool,
    pub is_self: bool,
}

/// IP nội bộ chính của máy (mẹo UDP connect, không gửi gói thật).
fn local_ipv4() -> Option<Ipv4Addr> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    match sock.local_addr().ok()?.ip() {
        IpAddr::V4(v4) if !v4.is_loopback() => Some(v4),
        _ => None,
    }
}

/// CIDR /24 của mạng nội bộ hiện tại (điền sẵn cho người dùng).
pub fn local_cidr() -> Option<String> {
    let o = local_ipv4()?.octets();
    Some(format!("{}.{}.{}.0/24", o[0], o[1], o[2]))
}

/// Router (gateway mặc định) từ /proc/net/route (hex little-endian).
fn default_gateway() -> Option<Ipv4Addr> {
    let content = std::fs::read_to_string("/proc/net/route").ok()?;
    for line in content.lines().skip(1) {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() >= 3 && f[1] == "00000000" {
            if let Ok(g) = u32::from_str_radix(f[2], 16) {
                return Some(Ipv4Addr::from(g.swap_bytes()));
            }
        }
    }
    None
}

/// Bảng ARP của HĐH: (IP, MAC) các mục đã phân giải xong (flag 0x2).
fn read_arp_table() -> Vec<(Ipv4Addr, String)> {
    let mut out = Vec::new();
    let Ok(content) = std::fs::read_to_string("/proc/net/arp") else {
        return out;
    };
    for line in content.lines().skip(1) {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 4 {
            continue;
        }
        let Ok(ip) = f[0].parse::<Ipv4Addr>() else { continue };
        let flags = u32::from_str_radix(f[2].trim_start_matches("0x"), 16).unwrap_or(0);
        let mac = f[3].to_uppercase();
        if flags & 0x2 == 0 || mac == "00:00:00:00:00:00" {
            continue;
        }
        out.push((ip, mac));
    }
    out
}

fn valid_name(n: &str, ip: &str) -> Option<String> {
    let n = n.trim().trim_end_matches('.');
    if n.is_empty() || n == ip {
        None
    } else {
        Some(n.to_string())
    }
}

/// Reverse DNS qua `getent hosts` (thường trống trên LAN gia đình).
fn getent_host(ip: &str) -> Option<String> {
    let out = std::process::Command::new("getent").arg("hosts").arg(ip).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    valid_name(s.split_whitespace().nth(1)?, ip)
}

/// Tên .local qua mDNS/Avahi (Apple, Chromecast, máy in, IoT, Linux). Cần avahi-utils.
fn avahi_name(ip: &str) -> Option<String> {
    let out = std::process::Command::new("timeout")
        .args(["1", "avahi-resolve", "-a", ip])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    // Định dạng: "IP\tname.local"
    valid_name(s.split_whitespace().nth(1)?, ip)
}

/// Tên NetBIOS (Windows/Samba/NAS) qua `nmblookup -A`. Cần samba-common-bin.
fn netbios_name(ip: &str) -> Option<String> {
    let out = std::process::Command::new("timeout")
        .args(["2", "nmblookup", "-A", ip])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    for line in s.lines() {
        let t = line.trim();
        if t.contains("<00>") && !t.contains("<GROUP>") {
            if let Some(name) = t.split_whitespace().next() {
                return valid_name(name, ip);
            }
        }
    }
    None
}

/// Phân giải tên thiết bị best-effort: reverse DNS → mDNS → NetBIOS.
fn hostname_of(ip: &str) -> Option<String> {
    getent_host(ip)
        .or_else(|| avahi_name(ip))
        .or_else(|| netbios_name(ip))
}

/// Đoán hãng từ 3 byte đầu của MAC (OUI) — tập phổ biến; còn lại trả None.
fn oui_vendor(mac: &str) -> Option<String> {
    let p = mac.get(0..8)?;
    let name = match p {
        "B8:27:EB" | "DC:A6:32" | "E4:5F:01" | "28:CD:C1" | "D8:3A:DD" => "Raspberry Pi",
        "3C:5A:B4" | "F4:F5:E8" | "DA:A1:19" | "F8:8F:CA" | "54:60:09" => "Google",
        "AC:DE:48" | "F0:18:98" | "A4:83:E7" | "3C:07:54" | "F0:99:BF" | "88:66:5A" => "Apple",
        "FC:FB:FB" | "00:1A:11" => "Cisco",
        "50:C7:BF" | "AC:84:C6" | "C0:06:C3" | "14:CC:20" | "98:DA:C4" => "TP-Link",
        "B0:BE:76" | "F4:EC:38" | "34:CE:00" => "TP-Link",
        "5C:CF:7F" | "84:F3:EB" | "18:FE:34" | "DC:4F:22" | "A0:20:A6" => "Espressif/IoT",
        "FC:65:DE" | "50:EC:50" | "18:FF:2E" | "28:6C:07" | "64:09:80" => "Xiaomi",
        "F0:79:59" | "00:12:FB" | "78:BD:BC" | "E4:E0:C5" | "8C:77:12" => "Samsung",
        "00:1D:0F" | "00:24:01" | "D8:5D:4C" | "44:D9:E7" => "D-Link/Ubiquiti",
        "44:65:0D" | "FC:A6:67" | "68:37:E9" | "00:BB:3A" => "Amazon",
        "00:50:56" | "00:0C:29" | "08:00:27" => "Virtual Machine",
        _ => return None,
    };
    Some(name.to_string())
}

/// Quét quanh subnet để buộc HĐH phân giải ARP (mọi cổng đều kích hoạt ARP).
async fn arp_warmup(hosts: &[Ipv4Addr], timeout_ms: u64, concurrency: usize) {
    let sem = Arc::new(Semaphore::new(concurrency.max(1)));
    let mut set = JoinSet::new();
    for &ip in hosts {
        let permit = sem.clone().acquire_owned().await.unwrap();
        let addr = SocketAddr::new(IpAddr::V4(ip), 80);
        set.spawn(async move {
            let _permit = permit;
            let _ = is_open(addr, timeout_ms).await;
        });
    }
    while set.join_next().await.is_some() {}
}

pub async fn scan_lan(cidr: &str, timeout_ms: u64, concurrency: usize) -> anyhow::Result<Vec<LanDevice>> {
    let hosts = cidr_hosts(cidr)?;
    let in_net: std::collections::HashSet<Ipv4Addr> = hosts.iter().copied().collect();

    arp_warmup(&hosts, timeout_ms, concurrency).await;
    tokio::time::sleep(Duration::from_millis(250)).await;

    let gw = default_gateway();
    let me = local_ipv4();

    let mut devices: Vec<(Ipv4Addr, String)> = read_arp_table()
        .into_iter()
        .filter(|(ip, _)| in_net.contains(ip) || Some(*ip) == gw)
        .collect();
    if let Some(meip) = me {
        if in_net.contains(&meip) && !devices.iter().any(|(ip, _)| *ip == meip) {
            devices.push((meip, String::new()));
        }
    }
    devices.sort_by_key(|(ip, _)| u32::from(*ip));
    devices.dedup_by_key(|(ip, _)| *ip);

    // Reverse DNS song song (best-effort).
    let mut set = JoinSet::new();
    for (ip, mac) in devices {
        set.spawn(async move {
            let ips = ip.to_string();
            let hostname = tokio::task::spawn_blocking(move || hostname_of(&ips))
                .await
                .ok()
                .flatten();
            (ip, mac, hostname)
        });
    }
    let mut out = Vec::new();
    while let Some(r) = set.join_next().await {
        if let Ok((ip, mac, hostname)) = r {
            out.push(LanDevice {
                vendor: oui_vendor(&mac),
                is_gateway: Some(ip) == gw,
                is_self: Some(ip) == me,
                ip: ip.to_string(),
                mac,
                hostname,
            });
        }
    }
    out.sort_by_key(|d| u32::from(d.ip.parse::<Ipv4Addr>().unwrap_or(Ipv4Addr::UNSPECIFIED)));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cidr_24() {
        let h = cidr_hosts("192.168.1.0/24").unwrap();
        assert_eq!(h.len(), 254);
        assert_eq!(h[0], Ipv4Addr::new(192, 168, 1, 1));
        assert_eq!(h[253], Ipv4Addr::new(192, 168, 1, 254));
    }

    #[test]
    fn cidr_32_single() {
        let h = cidr_hosts("10.0.0.5/32").unwrap();
        assert_eq!(h, vec![Ipv4Addr::new(10, 0, 0, 5)]);
    }

    #[test]
    fn cidr_too_big() {
        assert!(cidr_hosts("10.0.0.0/8").is_err());
    }
}
