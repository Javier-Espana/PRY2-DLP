use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileNode {
    name: String,
    path: String,
    is_dir: bool,
}

fn detect_workspace_root() -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));

    let mut probe = cwd.as_path();
    loop {
        let has_bridge = probe.join("src").join("bridge_cli.py").exists();
        let has_desktop_app = probe.join("desktop-app").exists();
        if has_bridge && has_desktop_app {
            return probe.to_path_buf();
        }

        let is_desktop_app = probe
            .file_name()
            .map(|v| v.to_string_lossy() == "desktop-app")
            .unwrap_or(false);
        if is_desktop_app {
            return probe
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| probe.to_path_buf());
        }

        match probe.parent() {
            Some(parent) => probe = parent,
            None => break,
        }
    }

    cwd
}

fn strip_windows_extended_prefix(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy().to_string();
    if let Some(stripped) = text.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        path
    }
}

#[tauri::command]
fn ping() -> String {
    "pong".to_string()
}

#[tauri::command]
fn get_workspace_root(_app: tauri::AppHandle) -> Result<String, String> {
    let root = detect_workspace_root();
    let normalized = root.canonicalize().unwrap_or(root);
    let clean = strip_windows_extended_prefix(normalized);
    Ok(clean.to_string_lossy().to_string())
}

#[tauri::command]
fn list_entries(path: String) -> Result<Vec<FileNode>, String> {
    let mut nodes: Vec<FileNode> = fs::read_dir(Path::new(&path))
        .map_err(|e| format!("No se pudo abrir directorio: {e}"))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            Some(FileNode {
                name: entry.file_name().to_string_lossy().to_string(),
                path: entry.path().to_string_lossy().to_string(),
                is_dir: file_type.is_dir(),
            })
        })
        .collect();

    nodes.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(nodes)
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(Path::new(&path)).map_err(|e| format!("Error leyendo archivo: {e}"))
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    fs::write(Path::new(&path), content).map_err(|e| format!("Error escribiendo archivo: {e}"))
}

#[tauri::command]
fn create_directory(path: String) -> Result<(), String> {
    fs::create_dir_all(Path::new(&path))
        .map_err(|e| format!("Error creando directorio: {e}"))
}

#[tauri::command]
fn pick_directory() -> Option<String> {
    rfd::FileDialog::new()
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
fn pick_file() -> Option<String> {
    rfd::FileDialog::new()
        .pick_file()
        .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
fn copy_file(src: String, dest: String) -> Result<(), String> {
    let src_path = Path::new(&src);
    let dest_path = Path::new(&dest);

    if !src_path.exists() {
        return Err(format!("Archivo origen no existe: {src}"));
    }

    if src_path.is_dir() {
        copy_dir_recursive(src_path, dest_path)
            .map_err(|e| format!("Error copiando directorio: {e}"))
    } else {
        fs::copy(src_path, dest_path)
            .map_err(|e| format!("Error copiando archivo: {e}"))?;
        Ok(())
    }
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let path = entry.path();
        let file_name = entry.file_name();
        let dest_path = dest.join(&file_name);

        if path.is_dir() {
            copy_dir_recursive(&path, &dest_path)?;
        } else {
            fs::copy(&path, &dest_path)?;
        }
    }
    Ok(())
}

#[tauri::command]
fn move_file(src: String, dest: String) -> Result<(), String> {
    let src_path = Path::new(&src);
    let dest_path = Path::new(&dest);

    if !src_path.exists() {
        return Err(format!("Archivo/carpeta origen no existe: {src}"));
    }

    let final_dest = if dest_path.is_dir() && dest_path.exists() {
        let file_name = src_path
            .file_name()
            .ok_or_else(|| "No se pudo obtener nombre del archivo".to_string())?;
        dest_path.join(file_name)
    } else {
        dest_path.to_path_buf()
    };

    fs::rename(src_path, &final_dest)
        .map_err(|e| format!("Error moviendo archivo: {e}"))
}

#[tauri::command]
fn delete_file(path: String) -> Result<(), String> {
    let file_path = Path::new(&path);

    if !file_path.exists() {
        return Err(format!("Archivo/carpeta no existe: {path}"));
    }

    if file_path.is_dir() {
        fs::remove_dir_all(file_path)
            .map_err(|e| format!("Error eliminando directorio: {e}"))
    } else {
        fs::remove_file(file_path)
            .map_err(|e| format!("Error eliminando archivo: {e}"))
    }
}

enum BridgeCommandError {
    ProgramNotFound(String),
    ExecutionFailed(String),
}

fn run_python_command(program: &str, args: &[&str], payload: &str) -> Result<String, BridgeCommandError> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                BridgeCommandError::ProgramNotFound(format!("No se encontró ejecutable '{program}'"))
            } else {
                BridgeCommandError::ExecutionFailed(format!("No se pudo iniciar {program}: {e}"))
            }
        })?;

    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(payload.as_bytes())
            .map_err(|e| BridgeCommandError::ExecutionFailed(format!("No se pudo escribir en stdin: {e}")))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| BridgeCommandError::ExecutionFailed(format!("Error esperando proceso Python: {e}")))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();

        if let Ok(parsed) = serde_json::from_str::<Value>(&stdout) {
            if let Some(error_msg) = parsed
                .get("error")
                .and_then(|v| v.as_str())
            {
                return Err(BridgeCommandError::ExecutionFailed(error_msg.to_string()));
            }
        }

        Err(BridgeCommandError::ExecutionFailed(format!(
            "Bridge Python falló (status {:?}): {} {}",
            output.status.code(),
            stderr,
            stdout
        )))
    }
}

fn normalize_payload_json(payload_json: &str) -> Result<String, String> {
    let parsed: Value = serde_json::from_str(payload_json)
        .map_err(|e| format!("Payload JSON inválido: {e}"))?;

    // If payload arrived as a JSON-encoded string, decode one extra layer.
    let normalized = match parsed {
        Value::String(inner) => serde_json::from_str::<Value>(&inner).unwrap_or(Value::String(inner)),
        other => other,
    };

    serde_json::to_string(&normalized)
        .map_err(|e| format!("No se pudo serializar payload normalizado: {e}"))
}

fn resolve_bridge_script(workspace_root: &str) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    let provided_root = PathBuf::from(workspace_root);
    candidates.push(provided_root.clone());

    let mut ancestor = provided_root.parent();
    while let Some(parent) = ancestor {
        candidates.push(parent.to_path_buf());
        ancestor = parent.parent();
    }

    candidates.push(detect_workspace_root());

    let mut tried: Vec<String> = Vec::new();
    for base in candidates {
        let script = base.join("src").join("bridge_cli.py");
        tried.push(script.to_string_lossy().to_string());
        if script.exists() {
            let canonical = script.canonicalize().unwrap_or(script);
            return Ok(strip_windows_extended_prefix(canonical));
        }
    }

    Err(format!(
        "No se encontró bridge_cli.py. Rutas intentadas: {}",
        tried.join(" | ")
    ))
}

fn find_in_path(program: &str) -> Option<PathBuf> {
    let program_path = Path::new(program);
    if program_path.is_absolute() || program_path.components().count() > 1 {
        if program_path.exists() {
            return Some(program_path.to_path_buf());
        }
        return None;
    }

    let path_env = std::env::var_os("PATH")?;
    let mut candidates: Vec<PathBuf> = std::env::split_paths(&path_env)
        .map(|dir| dir.join(program))
        .collect();

    #[cfg(windows)]
    {
        if program_path.extension().is_none() {
            let pathexts = std::env::var_os("PATHEXT")
                .map(|v| v.to_string_lossy().to_string())
                .unwrap_or_else(|| ".EXE;.BAT;.CMD;.COM".to_string());
            let extensions: Vec<String> = pathexts
                .split(';')
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect();

            for dir in std::env::split_paths(&path_env) {
                for ext in &extensions {
                    candidates.push(dir.join(format!("{program}{ext}")));
                }
            }
        }
    }

    for candidate in candidates {
        if candidate.exists() {
            return Some(candidate);
        }
    }

    None
}

fn resolve_python_executable(workspace_root: &str) -> Result<(String, Vec<String>), String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    let workspace_root_path = PathBuf::from(workspace_root);
    candidates.push(workspace_root_path.join(".venv").join("Scripts").join("python.exe"));
    candidates.push(workspace_root_path.join(".venv").join("Scripts").join("python3.exe"));
    candidates.push(workspace_root_path.join(".venv").join("bin").join("python3"));
    candidates.push(workspace_root_path.join(".venv").join("bin").join("python"));

    if let Ok(virtual_env) = std::env::var("VIRTUAL_ENV") {
        let venv_path = PathBuf::from(virtual_env);
        candidates.push(venv_path.join("Scripts").join("python.exe"));
        candidates.push(venv_path.join("Scripts").join("python3.exe"));
        candidates.push(venv_path.join("bin").join("python3"));
        candidates.push(venv_path.join("bin").join("python"));
    }

    let mut tried: Vec<String> = Vec::new();
    for candidate in candidates {
        tried.push(candidate.to_string_lossy().to_string());
        if candidate.exists() {
          let canonical = candidate.canonicalize().unwrap_or(candidate);
          return Ok((strip_windows_extended_prefix(canonical).to_string_lossy().to_string(), tried));
        }
    }

    let fallback_names = ["python3", "python", "/usr/bin/python3", "py"];
    for program in fallback_names {
        tried.push(program.to_string());
        if let Some(found) = find_in_path(program) {
            let canonical = found.canonicalize().unwrap_or(found);
            return Ok((
                strip_windows_extended_prefix(canonical)
                    .to_string_lossy()
                    .to_string(),
                tried,
            ));
        }
    }

    Err(format!("No se encontró un intérprete de Python válido. Rutas/alias intentados: {}", tried.join(" | ")))
}

#[tauri::command]
fn run_yalex_bridge(workspace_root: String, payload_json: String) -> Result<String, String> {
    let script = resolve_bridge_script(&workspace_root)?;
    let script_str = script
        .to_str()
        .ok_or_else(|| "Ruta de bridge inválida".to_string())?;
    let normalized_payload = normalize_payload_json(&payload_json)?;

    let (python_path, tried) = resolve_python_executable(&workspace_root)?;

    match run_python_command(&python_path, &[script_str], &normalized_payload) {
        Ok(output) => Ok(output),
        Err(BridgeCommandError::ProgramNotFound(error)) => Err(format!(
            "No se pudo iniciar Python para el bridge. Intentados: {}. Detalle: {}",
            tried.join(" | "),
            error
        )),
        Err(BridgeCommandError::ExecutionFailed(error)) => Err(error),
    }
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            ping,
            get_workspace_root,
            list_entries,
            read_text_file,
            write_text_file,
            create_directory,
            pick_directory,
            pick_file,
            copy_file,
            move_file,
            delete_file,
            run_yalex_bridge
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
