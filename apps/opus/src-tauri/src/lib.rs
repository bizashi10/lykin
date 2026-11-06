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

/// Finds the bundled Ghostscript (Windows) or a system one (development).
fn ghostscript_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(res) = app.path().resource_dir() {
        for name in ["gs/gswin64c.exe", "gs/bin/gswin64c.exe", "gs/gs"] {
            let p = res.join(name);
            if p.exists() {
                return Some(p);
            }
        }
    }
    for name in ["gswin64c", "gs"] {
        let probe = std::process::Command::new(name).arg("--version").output();
        if probe.map(|o| o.status.success()).unwrap_or(false) {
            return Some(PathBuf::from(name));
        }
    }
    None
}

#[tauri::command(async)]
fn has_ghostscript(app: tauri::AppHandle) -> bool {
    ghostscript_path(&app).is_some()
}

/// Runs Ghostscript on a PDF (sent as the raw request body) and returns the result.
/// The `x-args` header holds a URL-encoded JSON list of extra arguments.
/// `{in}`, `{out}` and `{dir}` in arguments are replaced with temp paths.
/// `x-files` may hold a JSON object of extra text files to write into `{dir}`.
#[tauri::command(async)]
fn run_ghostscript(app: tauri::AppHandle, request: Request<'_>) -> Result<Response, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("No file data received".into());
    };
    let header = |name: &str| -> Result<Option<String>, String> {
        match request.headers().get(name) {
            None => Ok(None),
            Some(v) => {
                let raw = v.to_str().map_err(|e| e.to_string())?;
                Ok(Some(
                    percent_encoding::percent_decode_str(raw)
                        .decode_utf8()
                        .map_err(|e| e.to_string())?
                        .to_string(),
                ))
            }
        }
    };
    let args: Vec<String> = serde_json::from_str(&header("x-args")?.unwrap_or_else(|| "[]".into()))
        .map_err(|e| format!("Bad arguments: {e}"))?;
    let files: std::collections::HashMap<String, String> =
        serde_json::from_str(&header("x-files")?.unwrap_or_else(|| "{}".into()))
            .map_err(|e| format!("Bad files: {e}"))?;

    let gs = ghostscript_path(&app).ok_or("The PDF engine (Ghostscript) is missing. Reinstall Opus.")?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("opus-gs-{stamp}"));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let cleanup = |d: &Path| {
        let _ = std::fs::remove_dir_all(d);
    };
    let input = dir.join("in.pdf");
    let output = dir.join("out.pdf");
    if let Err(e) = std::fs::write(&input, bytes) {
        cleanup(&dir);
        return Err(e.to_string());
    }
    // Ghostscript accepts forward slashes on Windows, and they need no escaping
    // inside PostScript strings.
    let slash = |p: &Path| p.to_string_lossy().replace('\\', "/");
    let icc = app
        .path()
        .resource_dir()
        .map(|r| r.join("srgb.icc"))
        .ok()
        .filter(|p| p.exists())
        .or_else(|| {
            let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/srgb.icc");
            dev.exists().then_some(dev)
        });
    let icc_path = icc.as_deref().map(slash).unwrap_or_default();
    let icc_dir = icc
        .as_deref()
        .and_then(Path::parent)
        .map(|p| format!("{}/", slash(p)))
        .unwrap_or_default();
    let fix = |a: &str| {
        a.replace("{in}", &slash(&input))
            .replace("{out}", &slash(&output))
            .replace("{dir}", &slash(&dir))
            .replace("{icc}", &icc_path)
            .replace("{iccdir}", &icc_dir)
    };
    for (name, content) in &files {
        // Only plain file names, never paths.
        if name.contains(['/', '\\']) || name.contains("..") {
            cleanup(&dir);
            return Err("Bad file name".into());
        }
        let _ = std::fs::write(dir.join(name), fix(content));
    }
    let mut cmd = std::process::Command::new(&gs);
    cmd.current_dir(&dir)
        .args(["-dSAFER", "-dBATCH", "-dNOPAUSE", "-dQUIET", "-sDEVICE=pdfwrite"])
        .args(args.iter().map(|a| fix(a)))
        .arg(format!("-sOutputFile={}", slash(&output)));
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no black console flash
    }
    // Input file goes last.
    cmd.arg(&input);
    let result = cmd.output();
    let out = match result {
        Ok(o) if o.status.success() && output.exists() => std::fs::read(&output).map_err(|e| e.to_string()),
        Ok(o) => {
            let msg = String::from_utf8_lossy(&o.stderr).lines().take(4).collect::<Vec<_>>().join(" ");
            Err(format!("The PDF engine could not process this file. {msg}"))
        }
        Err(e) => Err(format!("Could not start the PDF engine: {e}")),
    };
    cleanup(&dir);
    out.map(Response::new)
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
            show_in_folder,
            has_ghostscript,
            run_ghostscript
        ])
        .run(tauri::generate_context!())
        .expect("error while running Opus");
}
