import { invoke } from "@tauri-apps/api/core";

// Khớp với struct serde phía Rust (snake_case).
export interface Group {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: number;
}

export type AuthType = "password" | "key" | "agent";

export interface Host {
  id: string;
  group_id: string | null;
  label: string;
  address: string;
  port: number;
  username: string;
  auth_type: AuthType;
  password: string | null;
  private_key_path: string | null;
  passphrase: string | null;
  key_id: string | null;
  startup_snippet: string | null;
  keepalive: number;
  term_theme: string | null;
  font_size: number | null;
  proxy_type: string | null;
  proxy_host: string | null;
  proxy_port: number | null;
  proxy_username: string | null;
  jump_host_id: string | null;
  proxy_command: string | null;
  created_at: number;
  updated_at: number;
}

export interface Tunnel {
  id: string;
  name: string;
  host_id: string;
  kind: string; // "local" | "dynamic"
  local_port: number;
  remote_host: string | null;
  remote_port: number | null;
  created_at: number;
}

export interface TunnelInput {
  id?: string | null;
  name: string;
  host_id: string;
  kind: string;
  local_port: number;
  remote_host: string | null;
  remote_port: number | null;
}

export interface TunnelStatus {
  id: string;
  active: boolean;
  error: string | null;
}

export interface VaultEntry {
  id: string;
  title: string;
  username: string | null;
  url: string | null;
  notes: string | null;
  tags: string | null;
  folder: string | null;
  linked_host_id: string | null;
  has_totp: number;
  created_at: number;
  updated_at: number;
}

export interface VaultEntryInput {
  id?: string | null;
  title: string;
  username: string | null;
  url: string | null;
  notes: string | null;
  tags: string | null;
  folder: string | null;
  linked_host_id: string | null;
  password: string | null;
  totp_secret: string | null;
}

export interface SshKey {
  id: string;
  name: string;
  algorithm: string;
  public_key: string;
  fingerprint: string;
  has_passphrase: number;
  created_at: number;
}

export interface HostInput {
  id?: string | null;
  group_id: string | null;
  label: string;
  address: string;
  port: number;
  username: string;
  auth_type: AuthType;
  password: string | null;
  private_key_path: string | null;
  passphrase: string | null;
  key_id: string | null;
  startup_snippet: string | null;
  keepalive: boolean;
  term_theme: string | null;
  font_size: number | null;
  proxy_type: string | null;
  proxy_host: string | null;
  proxy_port: number | null;
  proxy_username: string | null;
  jump_host_id: string | null;
  proxy_command: string | null;
  proxy_password: string | null;
}

export interface FileEntry {
  name: string;
  is_dir: boolean;
  size: number;
  modified: number | null;
}

export interface SftpProgress {
  id: string;
  transferred: number;
  total: number;
}

export interface SshDataPayload {
  id: string;
  data: string; // base64
}
export interface SshClosedPayload {
  id: string;
}

export interface LanDevice {
  ip: string;
  mac: string;
  vendor: string | null;
  hostname: string | null;
  is_gateway: boolean;
  is_self: boolean;
}

export interface MonitorDisk {
  mount: string;
  device: string;
  used_kb: number;
  total_kb: number;
}
export interface Metrics {
  cpu_percent: number;
  mem_used_kb: number;
  mem_total_kb: number;
  load1: number;
  uptime_secs: number;
  net_rx_bps: number;
  net_tx_bps: number;
  disks: MonitorDisk[];
}

export interface KnownHost {
  id: string;
  host: string;
  port: number;
  key_type: string;
  key_b64: string;
  fingerprint: string;
  added_at: number;
}

export interface CfConfig {
  api_url: string;
  account_id: string;
  has_token: boolean;
}
export interface CfZone {
  id: string;
  name: string;
  status: string;
}
export interface CfRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  proxiable: boolean;
  priority: number | null;
  comment: string | null;
}
export interface CfInput {
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  priority?: number | null;
  comment?: string | null;
}

export interface StorageBucket {
  id: string;
  name: string;
  endpoint: string;
  region: string | null;
  access_key: string;
  bucket: string;
  created_at: number;
}
export interface StorageBucketInput {
  id?: string | null;
  name: string;
  endpoint: string;
  region: string | null;
  access_key: string;
  bucket: string;
  secret_key?: string | null;
}
export interface S3Object {
  key: string;
  size: number;
  last_modified: string;
}
export interface S3Listing {
  prefixes: string[];
  objects: S3Object[];
  next_token: string | null;
}

// Tauri tự chuyển camelCase (JS) → snake_case (tham số Rust).
export const api = {
  getGroups: () => invoke<Group[]>("get_groups"),
  createGroup: (name: string, parentId: string | null = null) =>
    invoke<Group>("create_group", { name, parentId }),
  deleteGroup: (id: string) => invoke<void>("delete_group", { id }),

  getHosts: () => invoke<Host[]>("get_hosts"),
  upsertHost: (input: HostInput) => invoke<Host>("upsert_host", { input }),
  deleteHost: (id: string) => invoke<void>("delete_host", { id }),
  importSshConfig: () => invoke<string>("import_ssh_config"),
  monitorStart: (hostId: string) => invoke<void>("monitor_start", { hostId }),
  monitorStop: (hostId: string) => invoke<void>("monitor_stop", { hostId }),

  getKeys: () => invoke<SshKey[]>("get_keys"),
  generateKey: (name: string, algorithm: string, passphrase: string | null) =>
    invoke<SshKey>("generate_key", { name, algorithm, passphrase }),
  importKey: (name: string, privateKey: string, passphrase: string | null) =>
    invoke<SshKey>("import_key", { name, privateKey, passphrase }),
  deleteKey: (id: string) => invoke<void>("delete_key", { id }),

  sshConnect: (hostId: string, cols: number, rows: number) =>
    invoke<string>("ssh_connect", { hostId, cols, rows }),
  sshSend: (id: string, data: string) => invoke<void>("ssh_send", { id, data }),
  sshResize: (id: string, cols: number, rows: number) =>
    invoke<void>("ssh_resize", { id, cols, rows }),
  sshDisconnect: (id: string) => invoke<void>("ssh_disconnect", { id }),

  // SFTP: endpoint = "local" hoặc host id
  sftpOpen: (hostId: string) => invoke<string>("sftp_open", { hostId }),
  sftpClose: (endpoint: string) => invoke<void>("sftp_close", { endpoint }),
  fsList: (endpoint: string, path: string) =>
    invoke<FileEntry[]>("fs_list", { endpoint, path }),
  fsHome: (endpoint: string) => invoke<string>("fs_home", { endpoint }),
  fsMkdir: (endpoint: string, path: string) => invoke<void>("fs_mkdir", { endpoint, path }),
  fsRename: (endpoint: string, from: string, to: string) =>
    invoke<void>("fs_rename", { endpoint, from, to }),
  fsDelete: (endpoint: string, path: string, isDir: boolean) =>
    invoke<void>("fs_delete", { endpoint, path, isDir }),
  sftpTransfer: (srcEndpoint: string, srcPath: string, dstEndpoint: string, dstPath: string) =>
    invoke<string>("sftp_transfer", { srcEndpoint, srcPath, dstEndpoint, dstPath }),

  getEntries: () => invoke<VaultEntry[]>("get_entries"),
  upsertEntry: (input: VaultEntryInput) => invoke<VaultEntry>("upsert_entry", { input }),
  deleteEntry: (id: string) => invoke<void>("delete_entry", { id }),
  entryPassword: (id: string) => invoke<string>("entry_password", { id }),
  entryTotpCode: (id: string) =>
    invoke<{ code: string; remaining: number }>("entry_totp_code", { id }),
  importKdbx: (path: string, password: string) =>
    invoke<string>("import_kdbx", { path, password }),
  getVaultFolders: () => invoke<string[]>("get_vault_folders"),
  createVaultFolder: (path: string) => invoke<void>("create_vault_folder", { path }),
  deleteVaultFolder: (path: string) => invoke<void>("delete_vault_folder", { path }),
  renameVaultFolder: (oldPath: string, newPath: string) =>
    invoke<void>("rename_vault_folder", { old: oldPath, new: newPath }),

  applockStatus: () => invoke<{ enabled: boolean; timeout_mins: number; totp_enabled: boolean; reauth_mins: number }>("applock_status"),
  applockEnable: (password: string, timeoutMins: number) =>
    invoke<void>("applock_enable", { password, timeoutMins }),
  applockDisable: (password: string) => invoke<void>("applock_disable", { password }),
  applockVerify: (password: string) => invoke<boolean>("applock_verify", { password }),
  applockSetTimeout: (timeoutMins: number) => invoke<void>("applock_set_timeout", { timeoutMins }),
  applockUnlock: (password: string, code: string | null) =>
    invoke<boolean>("applock_unlock", { password, code }),
  applockTotpSetup: () => invoke<{ secret: string; uri: string; qr_svg: string }>("applock_totp_setup"),
  applockTotpEnable: (secret: string, code: string) =>
    invoke<void>("applock_totp_enable", { secret, code }),
  applockTotpDisable: (password: string) => invoke<void>("applock_totp_disable", { password }),
  applockSetReauth: (reauthMins: number) => invoke<void>("applock_set_reauth", { reauthMins }),

  appVersion: () => invoke<string>("app_version"),
  checkUpdate: () =>
    invoke<{ current: string; latest: string; has_update: boolean; url: string; notes: string }>("check_update"),

  scanHosts: (cidr: string, port: number) => invoke<string[]>("scan_hosts", { cidr, port }),
  scanPorts: (target: string, ports: number[]) => invoke<number[]>("scan_ports", { target, ports }),
  scanLan: (cidr: string) => invoke<LanDevice[]>("scan_lan", { cidr }),
  localCidr: () => invoke<string | null>("local_cidr"),

  knownHostsList: () => invoke<KnownHost[]>("known_hosts_list"),
  knownHostsAdd: (host: string, port: number, keyType: string, keyB64: string, fingerprint: string) =>
    invoke<void>("known_hosts_add", { host, port, keyType, keyB64, fingerprint }),
  knownHostsDelete: (id: string) => invoke<void>("known_hosts_delete", { id }),

  cfGetConfig: () => invoke<CfConfig>("cf_get_config"),
  cfSaveConfig: (apiUrl: string, accountId: string, token: string | null) =>
    invoke<void>("cf_save_config", { apiUrl, accountId, token }),
  cfClearConfig: () => invoke<void>("cf_clear_config"),
  cfVerify: () => invoke<void>("cf_verify"),
  cfListZones: () => invoke<CfZone[]>("cf_list_zones"),
  cfListRecords: (zoneId: string) => invoke<CfRecord[]>("cf_list_records", { zoneId }),
  cfCreateRecord: (zoneId: string, input: CfInput) =>
    invoke<CfRecord>("cf_create_record", { zoneId, input }),
  cfUpdateRecord: (zoneId: string, id: string, input: CfInput) =>
    invoke<CfRecord>("cf_update_record", { zoneId, id, input }),
  cfDeleteRecord: (zoneId: string, id: string) =>
    invoke<void>("cf_delete_record", { zoneId, id }),

  getBuckets: () => invoke<StorageBucket[]>("get_buckets"),
  upsertBucket: (input: StorageBucketInput) => invoke<StorageBucket>("upsert_bucket", { input }),
  deleteBucket: (id: string) => invoke<void>("delete_bucket", { id }),
  s3List: (bucketId: string, prefix: string) => invoke<S3Listing>("s3_list", { bucketId, prefix }),
  s3Upload: (bucketId: string, key: string, filePath: string) =>
    invoke<void>("s3_upload", { bucketId, key, filePath }),
  s3Delete: (bucketId: string, key: string) => invoke<void>("s3_delete", { bucketId, key }),
  s3Presign: (bucketId: string, key: string, expires: number) =>
    invoke<string>("s3_presign", { bucketId, key, expires }),
  s3Copy: (bucketId: string, srcKey: string, dstKey: string, moveIt: boolean) =>
    invoke<void>("s3_copy", { bucketId, srcKey, dstKey, moveIt }),
  s3CopyPrefix: (bucketId: string, srcPrefix: string, dstPrefix: string, moveIt: boolean) =>
    invoke<number>("s3_copy_prefix", { bucketId, srcPrefix, dstPrefix, moveIt }),
  s3Download: (bucketId: string, key: string, destPath: string) =>
    invoke<void>("s3_download", { bucketId, key, destPath }),
  s3DeletePrefix: (bucketId: string, prefix: string) =>
    invoke<number>("s3_delete_prefix", { bucketId, prefix }),
  s3UploadPlan: (bucketId: string, prefix: string, paths: string[]) =>
    invoke<{ count: number; total: number; conflicts: string[] }>("s3_upload_plan", { bucketId, prefix, paths }),
  s3UploadRun: (bucketId: string, prefix: string, paths: string[], mode: string) =>
    invoke<number>("s3_upload_run", { bucketId, prefix, paths, mode }),
  s3CreateFolder: (bucketId: string, key: string) =>
    invoke<void>("s3_create_folder", { bucketId, key }),
  s3Transfer: (srcBucketId: string, srcKey: string, dstBucketId: string, dstKey: string) =>
    invoke<void>("s3_transfer", { srcBucketId, srcKey, dstBucketId, dstKey }),
  s3TransferPrefix: (srcBucketId: string, srcPrefix: string, dstBucketId: string, dstPrefix: string) =>
    invoke<number>("s3_transfer_prefix", { srcBucketId, srcPrefix, dstBucketId, dstPrefix }),

  syncGetConfig: () =>
    invoke<{ repo: string | null; has_pat: boolean; auto: boolean }>("sync_get_config"),
  syncSaveConfig: (pat: string | null, repo: string) =>
    invoke<void>("sync_save_config", { pat, repo }),
  syncSetAuto: (enabled: boolean, master: string | null) =>
    invoke<void>("sync_set_auto", { enabled, master }),
  syncPush: (master: string) => invoke<string>("sync_push", { master }),
  syncPull: (master: string) => invoke<string>("sync_pull", { master }),
  syncAutoPull: () => invoke<string>("sync_auto_pull"),
  syncResolveConflict: (choice: "local" | "remote") =>
    invoke<string>("sync_resolve_conflict", { choice }),

  getTunnels: () => invoke<Tunnel[]>("get_tunnels"),
  upsertTunnel: (input: TunnelInput) => invoke<Tunnel>("upsert_tunnel", { input }),
  deleteTunnel: (id: string) => invoke<void>("delete_tunnel", { id }),
  tunnelActive: () => invoke<string[]>("tunnel_active"),
  tunnelStart: (id: string) => invoke<void>("tunnel_start", { id }),
  tunnelStop: (id: string) => invoke<void>("tunnel_stop", { id }),
};

/** Nối path kiểu POSIX. */
export function joinPath(dir: string, name: string): string {
  if (dir.endsWith("/")) return dir + name;
  return dir + "/" + name;
}

/** Thư mục cha (POSIX). */
export function parentPath(p: string): string {
  if (p === "/" || p === "") return "/";
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx);
}

/** Giải mã base64 → bytes để ghi vào xterm. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
