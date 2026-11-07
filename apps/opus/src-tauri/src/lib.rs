//! Opus backend: the small part of the app that touches the disk.
//! All PDF work happens in the app itself; this only reads and writes files.

mod ai;

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

fn quiet(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no black console flash
    }
    cmd
}

/// The app's resource folder, as a normal path (no `\\?\` prefix on Windows,
/// which Ghostscript can't read).
fn resources(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().resource_dir().ok().map(|p| dunce::simplified(&p).to_path_buf())
}

static GS_PATH: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();

/// Finds the bundled Ghostscript (Windows) or a system one (development).
fn ghostscript_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    GS_PATH.get_or_init(|| find_ghostscript(app)).clone()
}

fn find_ghostscript(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Some(res) = resources(app) {
        for name in ["gs/gswin64c.exe", "gs/bin/gswin64c.exe", "gs/gs"] {
            let p = res.join(name);
            if p.exists() {
                return Some(p);
            }
        }
    }
    for name in ["gswin64c", "gs"] {
        let probe = quiet(std::process::Command::new(name).arg("--version")).output();
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
    let icc = resources(&app)
        .map(|r| r.join("srgb.icc"))
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
    // Paths inside PostScript are written as hex strings, so any character
    // (brackets, accents, spaces) in a folder name is safe.
    let icc_hex: String = icc_path.bytes().map(|b| format!("{b:02x}")).collect();
    let fix = |a: &str| {
        a.replace("{icchex}", &icc_hex)
            .replace("{in}", &slash(&input))
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
        if let Err(e) = std::fs::write(dir.join(name), fix(content)) {
            cleanup(&dir);
            return Err(e.to_string());
        }
    }
    let mut cmd = std::process::Command::new(&gs);
    // The output file must be set before any PostScript (like the PDF/A
    // definition) runs, so it comes first; the input PDF goes last.
    quiet(&mut cmd)
        .current_dir(&dir)
        .args(["-dSAFER", "-dBATCH", "-dNOPAUSE", "-dQUIET", "-sDEVICE=pdfwrite"])
        .arg(format!("-sOutputFile={}", slash(&output)))
        .args(args.iter().map(|a| fix(a)))
        .arg(&input)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    let out = match cmd.spawn() {
        Err(e) => Err(format!("Could not start the PDF engine: {e}")),
        Ok(mut child) => {
            // Drain error output on a side thread so a chatty run can't block
            // on a full pipe.
            let reader = child.stderr.take().map(|mut e| {
                std::thread::spawn(move || {
                    use std::io::Read;
                    let mut buf = String::new();
                    let _ = e.read_to_string(&mut buf);
                    buf
                })
            });
            // Never hang forever on a pathological file: give up after 10 minutes.
            let started = std::time::Instant::now();
            let status = loop {
                match child.try_wait() {
                    Ok(Some(s)) => break Some(s),
                    Ok(None) if started.elapsed() > std::time::Duration::from_secs(600) => {
                        let _ = child.kill();
                        let _ = child.wait();
                        break None;
                    }
                    Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
                    Err(_) => break None,
                }
            };
            let stderr = reader.and_then(|h| h.join().ok()).unwrap_or_default();
            match status {
                Some(s) if s.success() && output.exists() => std::fs::read(&output).map_err(|e| e.to_string()),
                Some(_) => {
                    let msg = stderr.lines().filter(|l| !l.trim().is_empty()).take(3).collect::<Vec<_>>().join(" ");
                    Err(format!("The PDF engine couldn't process this file. {msg}").trim().to_string())
                }
                None => Err("The PDF engine took too long and was stopped.".into()),
            }
        }
    };
    cleanup(&dir);
    out.map(Response::new)
}

/// Finds the bundled LibreOffice (Windows) or a system one (development/Linux).
static SOFFICE_PATH: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
fn soffice_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    SOFFICE_PATH.get_or_init(|| find_soffice(app)).clone()
}
fn find_soffice(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Some(res) = resources(app) {
        for rel in [
            "libreoffice/program/soffice.exe",
            "libreoffice/program/soffice.bin",
            "libreoffice/program/soffice",
        ] {
            let p = res.join(rel);
            if p.exists() {
                return Some(p);
            }
        }
    }
    // Standard install locations (Windows, macOS, Linux).
    #[cfg(target_os = "windows")]
    let candidates: Vec<PathBuf> = {
        let mut v = Vec::new();
        for env_key in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
            if let Ok(base) = std::env::var(env_key) {
                v.push(PathBuf::from(base).join("LibreOffice/program/soffice.exe"));
            }
        }
        v.push(PathBuf::from("C:/Program Files/LibreOffice/program/soffice.exe"));
        v
    };
    #[cfg(not(target_os = "windows"))]
    let candidates: Vec<PathBuf> = vec![
        PathBuf::from("/usr/bin/soffice"),
        PathBuf::from("/usr/local/bin/soffice"),
        PathBuf::from("/Applications/LibreOffice.app/Contents/MacOS/soffice"),
        PathBuf::from("/opt/libreoffice/program/soffice"),
    ];
    for p in candidates {
        if p.exists() {
            return Some(p);
        }
    }
    for name in ["soffice", "libreoffice"] {
        if quiet(std::process::Command::new(name).arg("--version")).output().map(|o| o.status.success()).unwrap_or(false) {
            return Some(PathBuf::from(name));
        }
    }
    None
}

#[tauri::command(async)]
fn has_soffice(app: tauri::AppHandle) -> bool {
    soffice_path(&app).is_some()
}

/// Converts a document with LibreOffice. The `x-op` header holds a JSON object:
/// { "in_ext": "docx", "out_ext": "pdf", "convert_to": "pdf", "infilter": "..." }.
#[tauri::command(async)]
fn run_soffice(app: tauri::AppHandle, request: Request<'_>) -> Result<Response, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("No file data received".into());
    };
    let header = request
        .headers()
        .get("x-op")
        .ok_or("No conversion details given")?
        .to_str()
        .map_err(|e| e.to_string())?;
    let spec: serde_json::Value = serde_json::from_str(header).map_err(|e| format!("Bad conversion details: {e}"))?;
    let in_ext = spec.get("in_ext").and_then(|v| v.as_str()).unwrap_or("pdf");
    let out_ext = spec.get("out_ext").and_then(|v| v.as_str()).unwrap_or("pdf");
    let convert_to = spec.get("convert_to").and_then(|v| v.as_str()).unwrap_or("pdf");
    let infilter = spec.get("infilter").and_then(|v| v.as_str());

    let soffice = soffice_path(&app).ok_or("The document converter (LibreOffice) is not installed. Reinstall Opus, or install LibreOffice.")?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("opus-lo-{stamp}"));
    let outdir = dir.join("out");
    let profile = dir.join("profile");
    std::fs::create_dir_all(&outdir).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
    let cleanup = |d: &Path| { let _ = std::fs::remove_dir_all(d); };
    let input = dir.join(format!("input.{in_ext}"));
    if let Err(e) = std::fs::write(&input, bytes) {
        cleanup(&dir);
        return Err(e.to_string());
    }

    // LibreOffice wants the profile path as a file:// URL.
    let profile_url = {
        let p = profile.to_string_lossy().replace('\\', "/");
        if p.starts_with('/') { format!("file://{p}") } else { format!("file:///{p}") }
    };
    let mut cmd = std::process::Command::new(&soffice);
    quiet(&mut cmd)
        .arg("--headless").arg("--norestore").arg("--nolockcheck").arg("--nodefault")
        .arg(format!("-env:UserInstallation={profile_url}"));
    if let Some(f) = infilter {
        cmd.arg(format!("--infilter={f}"));
    }
    cmd.arg("--convert-to").arg(convert_to)
        .arg("--outdir").arg(&outdir)
        .arg(&input)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let result = (|| -> Result<Vec<u8>, String> {
        let mut child = cmd.spawn().map_err(|e| format!("Could not start the converter: {e}"))?;
        let started = std::time::Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if started.elapsed() > std::time::Duration::from_secs(300) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("The converter took too long and was stopped.".into());
                }
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(60)),
                Err(e) => return Err(e.to_string()),
            }
        }
        let expected = outdir.join(format!("input.{out_ext}"));
        if expected.exists() {
            std::fs::read(&expected).map_err(|e| e.to_string())
        } else {
            // Find any produced file as a fallback.
            let produced = std::fs::read_dir(&outdir).ok().and_then(|rd| rd.filter_map(|e| e.ok()).map(|e| e.path()).find(|p| p.is_file()));
            match produced {
                Some(p) => std::fs::read(&p).map_err(|e| e.to_string()),
                None => Err("The converter could not read this file. It may be password-protected or in an unsupported layout.".into()),
            }
        }
    })();
    cleanup(&dir);
    result.map(Response::new)
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
            run_ghostscript,
            has_soffice,
            run_soffice,
            ai::ai_info,
            ai::ai_setup,
            ai::ai_cancel_setup,
            ai::ai_start,
            ai::ai_stop
        ])
        .build(tauri::generate_context!())
        .expect("error while running Opus")
        .run(|_app, event| {
            // Never leave the AI server running after Opus closes.
            if let tauri::RunEvent::Exit = event {
                ai::shutdown();
            }
        });
}
