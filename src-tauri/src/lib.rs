mod applock;
mod commands;
mod conn;
mod db;
mod keychain;
mod keys;
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
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
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
            commands::get_keys,
            commands::generate_key,
            commands::import_key,
            commands::delete_key,
            commands::ssh_connect,
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
            commands::scan_hosts,
            commands::scan_ports,
            commands::scan_lan,
            commands::local_cidr,
            commands::import_kdbx,
            commands::sync_get_config,
            commands::sync_save_config,
            commands::sync_set_auto,
            commands::sync_push,
            commands::sync_pull,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
