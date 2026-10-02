//! Mã nguồn backend Rust của Termez (SSH, SFTP, vault, sync…).
//!
//! App thật build ở `native/` (module Node cho Electron): nó nạp NGUYÊN VĂN các
//! file này qua `#[path]`. Crate này chỉ để `cargo test` / `cargo check` backend
//! độc lập — `tauri::…` ở đây là crate giả `native/tauri-shim`, không có Tauri thật.

#![allow(dead_code)]

mod applock;
mod cloudflare;
mod commands;
mod conn;
mod db;
mod dbclient;
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
