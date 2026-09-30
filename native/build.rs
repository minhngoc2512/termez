//! Sinh bộ định tuyến lệnh cho bản Electron từ chữ ký hàm trong
//! `src-tauri/src/commands.rs`: mỗi `#[tauri::command]` thành một nhánh `match`
//! trong `dispatch(cmd, args)`. Nhờ vậy thêm/sửa lệnh ở bản Tauri là bản Electron
//! tự có theo, không phải viết tay 96 nhánh.
//!
//! Quy ước giống Tauri: tên tham số snake_case ↔ khoá camelCase phía JS. Tham số
//! `AppHandle` / `State<…>` / `Channel<…>` do runtime cấp, không lấy từ JS.

use std::fmt::Write as _;

const COMMANDS: &str = "../src-tauri/src/commands.rs";

struct Param {
    name: String,
    ty: String,
}

struct Cmd {
    name: String,
    is_async: bool,
    ret: Option<String>,
    params: Vec<Param>,
}

fn main() {
    napi_build::setup();
    println!("cargo:rerun-if-changed={COMMANDS}");

    let src = std::fs::read_to_string(COMMANDS).expect("đọc commands.rs");
    let cmds = parse(&src);
    assert!(cmds.len() > 50, "chỉ tìm thấy {} lệnh — parser hỏng?", cmds.len());

    let mut out = String::new();
    out.push_str("// TỰ SINH bởi native/build.rs từ src-tauri/src/commands.rs — đừng sửa tay.\n");
    out.push_str(
        "pub async fn dispatch(cmd: &str, a: &serde_json::Value, app: &tauri::AppHandle, \
         state: &'static crate::commands::AppState) -> Result<serde_json::Value, String> {\n",
    );
    out.push_str("    match cmd {\n");
    for c in &cmds {
        let args: Vec<String> = c.params.iter().map(arg_expr).collect();
        let mut call = format!("crate::commands::{}({})", c.name, args.join(", "));
        if c.is_async {
            call.push_str(".await");
        }
        let wrapped = match &c.ret {
            None => format!("{{ {call}; Ok(serde_json::Value::Null) }}"),
            Some(r) if r.starts_with("R<") || r.starts_with("Result<") => format!("ok_json({call})"),
            Some(_) => format!("to_json({call})"),
        };
        let _ = writeln!(out, "        {:?} => {},", c.name, wrapped);
    }
    out.push_str("        _ => Err(format!(\"lệnh không tồn tại: {cmd}\")),\n    }\n}\n");
    let _ = writeln!(out, "pub const COMMAND_COUNT: usize = {};", cmds.len());

    let dest = std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("dispatch.rs");
    std::fs::write(dest, out).expect("ghi dispatch.rs");
}

fn arg_expr(p: &Param) -> String {
    let ty = p.ty.replace(' ', "");
    if ty.contains("AppHandle") {
        "app.clone()".into()
    } else if ty.starts_with("State<") || ty.starts_with("tauri::State<") {
        "tauri::State::new(state)".into()
    } else if ty.contains("Channel<") {
        format!("channel_arg(a, {:?}, app)?", camel(&p.name))
    } else {
        format!("arg(a, {:?})?", camel(&p.name))
    }
}

/// host_id → hostId (quy ước mặc định của Tauri).
fn camel(s: &str) -> String {
    let mut out = String::new();
    let mut up = false;
    for (i, ch) in s.trim_start_matches('_').chars().enumerate() {
        if ch == '_' {
            up = i > 0;
        } else if up {
            out.extend(ch.to_uppercase());
            up = false;
        } else {
            out.push(ch);
        }
    }
    out
}

fn parse(src: &str) -> Vec<Cmd> {
    let mut cmds = Vec::new();
    let mut rest = src;
    while let Some(pos) = rest.find("#[tauri::command]") {
        rest = &rest[pos + "#[tauri::command]".len()..];
        let fn_pos = rest.find("fn ").expect("fn sau #[tauri::command]");
        let head = &rest[..fn_pos];
        let is_async = head.contains("async");
        let after = &rest[fn_pos + 3..];
        let name_end = after.find('(').unwrap();
        let name = after[..name_end].trim().to_string();

        // Tham số: từ '(' tới ')' tương ứng.
        let mut depth = 0i32;
        let mut close = 0;
        for (i, ch) in after[name_end..].char_indices() {
            match ch {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        close = name_end + i;
                        break;
                    }
                }
                _ => {}
            }
        }
        let params_src = &after[name_end + 1..close];
        let tail = &after[close + 1..];
        let body = tail.find('{').unwrap();
        let ret = tail[..body].trim().strip_prefix("->").map(|r| r.trim().to_string());

        let params = split_top(params_src)
            .into_iter()
            .filter(|p| !p.trim().is_empty())
            .map(|p| {
                let p = p.trim().trim_start_matches("mut ").trim();
                let (n, t) = p.split_once(':').expect("tham số dạng name: Type");
                Param { name: n.trim().to_string(), ty: t.trim().to_string() }
            })
            .collect();

        cmds.push(Cmd { name, is_async, ret, params });
    }
    cmds
}

/// Tách theo dấu phẩy ở cấp ngoài cùng (bỏ qua phẩy trong <> () []).
fn split_top(s: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut cur = String::new();
    let mut prev = ' ';
    for ch in s.chars() {
        match ch {
            '<' | '(' | '[' => depth += 1,
            '>' if prev != '-' => depth -= 1,
            ')' | ']' => depth -= 1,
            ',' if depth == 0 => {
                parts.push(std::mem::take(&mut cur));
                prev = ch;
                continue;
            }
            _ => {}
        }
        cur.push(ch);
        prev = ch;
    }
    parts.push(cur);
    parts
}
