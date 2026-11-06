//! Opus backend: the small part of the app that touches the disk.
//! All PDF work happens in the app itself; this only reads and writes files.

use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Emitter, Manager};

/// Reads a whole file and returns its raw bytes.
/// (`async` keeps the window responsive while large files load.)
#[tauri::command(async)]
fn read_file(path: String) -> Result<Response, String> {
    std::fs::read(&path)
        .map(Response::new)
        .map_err(|e| format!("Could not open {path}: {e}"))
}

/// Writes raw bytes to the path given in the `x-path` header.
/// Writes to a temporary file first, then swaps it in, so a crash
/// mid-save never leaves a half-written PDF behind.
#[tauri::command(async)]
fn write_file(request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("No file data received".into());
    };
    let header = request
        .headers()
        .get("x-path")
        .ok_or("No destination path given")?
        .to_str()
        .map_err(|e| e.to_string())?;
    let path = percent_encoding::percent_decode_str(header)
        .decode_utf8()
        .map_err(|e| e.to_string())?
        .to_string();
    let target = PathBuf::from(&path);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = target.with_extension(format!("opus-{stamp}.tmp"));

    // Write and flush to disk before replacing the original.
    let write = || -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()
    };
    if let Err(e) = write() {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Could not save {path}: {e}"));
    }

    // Antivirus or cloud sync (OneDrive) can briefly lock files; retry a few times.
    let mut last_err = None;
    for attempt in 0..6 {
        match std::fs::rename(&tmp, &target) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(150 * (attempt + 1)));
            }
        }
    }
    let _ = std::fs::remove_file(&tmp);
    let e = last_err.unwrap();
    let hint = match e.kind() {
        std::io::ErrorKind::PermissionDenied => {
            " The file may be read-only, open in another program, or in a folder you can't write to. Try Save as."
        }
        _ => " Try Save as to choose another location.",
    };
    Err(format!("Could not save {path}: {e}.{hint}"))
}

/// Returns `folder/name`, or `folder/name (2).pdf` etc. if that already exists.
#[tauri::command]
fn unique_path(folder: String, name: String) -> String {
    let folder = Path::new(&folder);
    let first = folder.join(&name);
    if !first.exists() {
        return first.to_string_lossy().into_owned();
    }
    let p = Path::new(&name);
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = p.extension().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "pdf".into());
    for n in 2.. {
        let candidate = folder.join(format!("{stem} ({n}).{ext}"));
        if !candidate.exists() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    unreachable!()
}

fn pdf_args<S: AsRef<std::ffi::OsStr>>(args: &[S]) -> Vec<String> {
    args.iter()
        .skip(1)
        .filter_map(|a| a.as_ref().to_str().map(str::to_owned))
        .filter(|a| a.to_lowercase().ends_with(".pdf") && Path::new(a).exists())
        .collect()
}

/// PDFs passed on the command line, e.g. when double-clicking a PDF in Explorer.
#[tauri::command]
fn startup_files() -> Vec<String> {
    // args_os never panics on unusual (non-Unicode) file names.
    pdf_args(&std::env::args_os().collect::<Vec<_>>())
}

/// Opens Windows Explorer with the file selected.
#[tauri::command]
fn show_in_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{path}"))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // If Opus is already open and the person double-clicks another PDF,
        // send it to the open window instead of starting a second copy.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let files = pdf_args(&args);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            if !files.is_empty() {
                let _ = app.emit("open-files", files);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            unique_path,
            startup_files,
            show_in_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running Opus");
}
