//! `#[tauri::command]` giả: giữ nguyên hàm. Trong Electron, lệnh được gọi trực
//! tiếp bởi bộ định tuyến sinh ra trong native/build.rs.
use proc_macro::TokenStream;

#[proc_macro_attribute]
pub fn command(_attr: TokenStream, item: TokenStream) -> TokenStream {
    item
}
