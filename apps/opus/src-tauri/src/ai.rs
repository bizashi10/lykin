//! Offline AI for Opus: downloads a llama.cpp server + a local model on first
//! use, runs the server on localhost, and lets the app talk to it. Everything
//! stays on the PC; only the one-time setup download needs the internet.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::Mutex;
use serde::Serialize;
use tauri::{Emitter, Manager};

// Pinned, known-good downloads. CUDA 12.4 suits GeForce RTX 20-series and newer
// with a reasonably recent driver. The model is a 7B instruct model (~4.7 GB)
// that fits an 8 GB card.
const LLAMA_TAG: &str = "b6780";
const LLAMA_ZIP: &str = "llama-b6780-bin-win-cuda-12.4-x64.zip";
const CUDART_ZIP: &str = "cudart-llama-bin-win-cuda-12.4-x64.zip";
const LLAMA_BASE: &str = "https://github.com/ggml-org/llama.cpp/releases/download";
const MODEL_URL: &str =
    "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf?download=true";
const MODEL_FILE: &str = "Qwen2.5-7B-Instruct-Q4_K_M.gguf";

static PORT: AtomicU16 = AtomicU16::new(0);
static CANCEL: AtomicBool = AtomicBool::new(false);
static CHILD: Mutex<Option<Child>> = Mutex::new(None);

fn ai_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let dir = base.join("ai");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn server_exe(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = ai_dir(app).ok()?.join("llama");
    for name in ["llama-server.exe", "llama-server", "server.exe"] {
        let p = dir.join(name);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

fn model_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let p = ai_dir(app).ok()?.join("models").join(MODEL_FILE);
    p.exists().then_some(p)
}

#[derive(Serialize)]
pub struct AiInfo {
    has_server: bool,
    model_present: bool,
    model_name: String,
    model_size_mb: u64,
    running: bool,
    port: u16,
}

#[tauri::command]
pub fn ai_info(app: tauri::AppHandle) -> AiInfo {
    let port = PORT.load(Ordering::SeqCst);
    AiInfo {
        has_server: server_exe(&app).is_some(),
        model_present: model_path(&app).is_some(),
        model_name: "Qwen2.5 7B Instruct".into(),
        model_size_mb: 4700,
        running: port != 0 && CHILD.lock().map(|c| c.is_some()).unwrap_or(false),
        port,
    }
}

#[tauri::command]
pub fn ai_cancel_setup() {
    CANCEL.store(true, Ordering::SeqCst);
}

#[derive(Clone, Serialize)]
struct Progress {
    stage: String,
    received: u64,
    total: u64,
    note: String,
}

fn emit(app: &tauri::AppHandle, stage: &str, received: u64, total: u64, note: &str) {
    let _ = app.emit("ai-setup", Progress { stage: stage.into(), received, total, note: note.into() });
}

/// Streams a download to `dest`, emitting progress. Resumes a partial file.
fn download(app: &tauri::AppHandle, url: &str, dest: &Path, stage: &str, note: &str) -> Result<(), String> {
    if dest.exists() {
        return Ok(());
    }
    let part = dest.with_extension("part");
    let have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    let client = reqwest::blocking::Client::builder()
        .timeout(None)
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.get(url);
    if have > 0 {
        req = req.header("Range", format!("bytes={have}-"));
    }
    let resp = req.send().map_err(|e| format!("Download failed: {e}"))?;
    let resuming = resp.status().as_u16() == 206;
    if !resp.status().is_success() {
        return Err(format!("Download failed ({}). Check your internet connection.", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0) + if resuming { have } else { 0 };
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(resuming)
        .write(true)
        .open(&part)
        .map_err(|e| e.to_string())?;
    if !resuming && have > 0 {
        file.set_len(0).ok();
    }
    let mut received = if resuming { have } else { 0 };
    let mut reader = resp;
    let mut buf = vec![0u8; 256 * 1024];
    emit(app, stage, received, total, note);
    let mut last = std::time::Instant::now();
    loop {
        if CANCEL.load(Ordering::SeqCst) {
            return Err("cancelled".into());
        }
        let n = reader.read(&mut buf).map_err(|e| format!("Download interrupted: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        received += n as u64;
        if last.elapsed().as_millis() > 200 {
            emit(app, stage, received, total, note);
            last = std::time::Instant::now();
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    std::fs::rename(&part, dest).map_err(|e| e.to_string())?;
    emit(app, stage, received, total, note);
    Ok(())
}

/// Unzips `zip` into `dir`, flattening the top-level folder the archive uses.
fn unzip_flat(zip: &Path, dir: &Path) -> Result<(), String> {
    let file = std::fs::File::open(zip).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Bad download: {e}"))?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        // Keep only the file name (binaries live beside the DLLs).
        let name = entry.enclosed_name().and_then(|p| p.file_name().map(|f| f.to_owned()));
        let Some(name) = name else { continue };
        let out = dir.join(name);
        let mut f = std::fs::File::create(&out).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut f).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Downloads the server and the model if they are not already present.
#[tauri::command]
pub fn ai_setup(app: tauri::AppHandle) -> Result<(), String> {
    CANCEL.store(false, Ordering::SeqCst);
    let dir = ai_dir(&app)?;
    let llama_dir = dir.join("llama");

    if server_exe(&app).is_none() {
        let tmp = dir.join("llama.zip");
        let cudart = dir.join("cudart.zip");
        download(&app, &format!("{LLAMA_BASE}/{LLAMA_TAG}/{LLAMA_ZIP}"), &tmp, "engine", "Downloading the AI engine")?;
        // The CUDA runtime is shipped separately; its asset name has varied, so
        // try a few and don't fail setup if none match (the engine zip may carry
        // its own runtime, or the PC may have CUDA installed).
        for name in [
            CUDART_ZIP,
            "cudart-llama-bin-win-cu12.4-x64.zip",
            "cudart-llama-bin-win-cuda-12.8-x64.zip",
        ] {
            if download(&app, &format!("{LLAMA_BASE}/{LLAMA_TAG}/{name}"), &cudart, "engine", "Downloading the GPU runtime").is_ok() {
                break;
            }
            if CANCEL.load(Ordering::SeqCst) {
                return Err("cancelled".into());
            }
        }
        emit(&app, "extract", 0, 0, "Unpacking the AI engine");
        unzip_flat(&tmp, &llama_dir)?;
        if cudart.exists() {
            let _ = unzip_flat(&cudart, &llama_dir);
        }
        let _ = std::fs::remove_file(&tmp);
        let _ = std::fs::remove_file(&cudart);
        #[cfg(not(target_os = "windows"))]
        if let Some(exe) = server_exe(&app) {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755));
        }
    }

    if model_path(&app).is_none() {
        let models = dir.join("models");
        std::fs::create_dir_all(&models).map_err(|e| e.to_string())?;
        download(&app, MODEL_URL, &models.join(MODEL_FILE), "model", "Downloading the AI model (one time)")?;
    }

    emit(&app, "done", 1, 1, "Ready");
    Ok(())
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(8757)
}

/// Starts the local model server (if not already running) and returns its port.
#[tauri::command]
pub fn ai_start(app: tauri::AppHandle) -> Result<u16, String> {
    {
        let guard = CHILD.lock().map_err(|e| e.to_string())?;
        let p = PORT.load(Ordering::SeqCst);
        if guard.is_some() && p != 0 {
            return Ok(p);
        }
    }
    let exe = server_exe(&app).ok_or("The AI engine isn't set up yet.")?;
    let model = model_path(&app).ok_or("The AI model isn't downloaded yet.")?;
    let port = free_port();

    let mut cmd = std::process::Command::new(&exe);
    cmd.arg("--model").arg(&model)
        .args(["--host", "127.0.0.1"])
        .args(["--port", &port.to_string()])
        .args(["--ctx-size", "8192"])
        .args(["-ngl", "999"]) // offload all layers to the GPU; llama.cpp falls back to CPU for what won't fit
        .args(["--flash-attn", "on"])
        .args(["--no-webui"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // no console window
    }
    let child = cmd.spawn().map_err(|e| format!("Could not start the AI engine: {e}"))?;
    *CHILD.lock().map_err(|e| e.to_string())? = Some(child);
    PORT.store(port, Ordering::SeqCst);

    // Wait for the server to answer /health (loading the model takes a while).
    let client = reqwest::blocking::Client::new();
    let url = format!("http://127.0.0.1:{port}/health");
    for _ in 0..240 {
        // If the process died, surface that instead of waiting.
        if let Ok(mut g) = CHILD.lock() {
            if let Some(c) = g.as_mut() {
                if let Ok(Some(status)) = c.try_wait() {
                    *g = None;
                    PORT.store(0, Ordering::SeqCst);
                    return Err(format!("The AI engine stopped unexpectedly (code {status}). Your GPU driver may be out of date."));
                }
            }
        }
        if let Ok(r) = client.get(&url).timeout(std::time::Duration::from_secs(2)).send() {
            if r.status().is_success() {
                return Ok(port);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    let _ = ai_stop();
    Err("The AI engine took too long to start.".into())
}

#[tauri::command]
pub fn ai_stop() -> Result<(), String> {
    if let Ok(mut g) = CHILD.lock() {
        if let Some(mut c) = g.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
    PORT.store(0, Ordering::SeqCst);
    Ok(())
}

/// Called on app exit so we never leave the server running.
pub fn shutdown() {
    let _ = ai_stop();
}
