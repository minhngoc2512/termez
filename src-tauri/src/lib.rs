mod applock;
mod cloudflare;
mod commands;
mod conn;
mod db;
mod keychain;
mod keys;
mod monitor;
mod s3;
mod scan;
mod sftp;
mod ssh;
mod sync;
mod totp;
mod tunnel;

use commands::AppState;
use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Màn hình đen trên một số máy Linux là do bộ render DMABUF của WebKitGTK
    // không tương thích GPU/driver. Tắt nó để WebView vẽ được ở mọi máy.
    // Phải set TRƯỚC khi WebView khởi tạo. Tôn trọng nếu user đã tự cấu hình.
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("không lấy được app_data_dir");
            std::fs::create_dir_all(&data_dir).ok();
            let db_path = data_dir.join("termez.db");
            let pool = tauri::async_runtime::block_on(db::init_pool(&db_path))
                .expect("khởi tạo database thất bại");
            app.manage(AppState {
                db: pool,
                ssh: ssh::SshManager::new(),
                sftp: Arc::new(sftp::SftpManager::new()),
                tunnels: Arc::new(tunnel::TunnelManager::new()),
                autosync: std::sync::Mutex::new(None),
                dirty: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                monitor: Arc::new(monitor::MonitorManager::new()),
                sync_base_path: data_dir.join("sync-base.enc"),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_groups,
            commands::create_group,
            commands::delete_group,
            commands::get_hosts,
            commands::upsert_host,
            commands::delete_host,
            commands::import_ssh_config,
            commands::monitor_start,
            commands::monitor_stop,
            commands::get_keys,
            commands::generate_key,
            commands::import_key,
            commands::delete_key,
            commands::ssh_connect,
            commands::ssh_test,
            commands::ssh_send,
            commands::ssh_resize,
            commands::ssh_disconnect,
            commands::sftp_open,
            commands::sftp_close,
            commands::fs_list,
            commands::fs_home,
            commands::fs_mkdir,
            commands::fs_rename,
            commands::fs_delete,
            commands::sftp_transfer,
            commands::get_tunnels,
            commands::upsert_tunnel,
            commands::delete_tunnel,
            commands::tunnel_active,
            commands::tunnel_start,
            commands::tunnel_stop,
            commands::get_entries,
            commands::upsert_entry,
            commands::delete_entry,
            commands::entry_password,
            commands::entry_totp_code,
            commands::get_vault_folders,
            commands::create_vault_folder,
            commands::delete_vault_folder,
            commands::rename_vault_folder,
            commands::applock_status,
            commands::applock_enable,
            commands::applock_disable,
            commands::applock_verify,
            commands::applock_set_timeout,
            commands::applock_totp_setup,
            commands::applock_totp_enable,
            commands::applock_totp_disable,
            commands::applock_set_reauth,
            commands::applock_unlock,
            commands::app_version,
            commands::check_update,
            commands::update_apply,
            commands::release_notes,
            commands::app_relaunch,
            commands::scan_hosts,
            commands::scan_ports,
            commands::scan_lan,
            commands::local_cidr,
            commands::cf_get_config,
            commands::cf_save_config,
            commands::cf_clear_config,
            commands::cf_verify,
            commands::cf_list_zones,
            commands::cf_list_records,
            commands::cf_create_record,
            commands::cf_update_record,
            commands::cf_delete_record,
            commands::get_buckets,
            commands::upsert_bucket,
            commands::delete_bucket,
            commands::s3_list,
            commands::s3_upload,
            commands::s3_delete,
            commands::s3_presign,
            commands::s3_copy,
            commands::s3_copy_prefix,
            commands::s3_download,
            commands::s3_delete_prefix,
            commands::s3_upload_plan,
            commands::s3_upload_run,
            commands::s3_create_folder,
            commands::s3_transfer,
            commands::s3_transfer_prefix,
            commands::known_hosts_list,
            commands::known_hosts_add,
            commands::known_hosts_delete,
            commands::import_kdbx,
            commands::sync_get_config,
            commands::sync_save_config,
            commands::sync_set_auto,
            commands::sync_push,
            commands::sync_pull,
            commands::sync_auto_pull,
            commands::sync_resolve_conflict,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
