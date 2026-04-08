use serde::{Deserialize, Serialize};
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    process::Command,
    time::UNIX_EPOCH,
};
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PhotoEntry {
    id: String,
    path: String,
    name: String,
    extension: String,
    directory: String,
    preview_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportDecision {
    path: String,
    decision: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportSummary {
    destination_root: String,
    exported_count: usize,
    moved_photos: Vec<MovedPhoto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MovedPhoto {
    source_path: String,
    destination_path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportProgress {
    processed_count: usize,
    total_count: usize,
    current_name: String,
    current_decision: String,
}

#[tauri::command]
fn scan_photo_directory(path: String) -> Result<Vec<PhotoEntry>, String> {
    let root = PathBuf::from(&path);

    if !root.is_dir() {
        return Err("The selected path is not a readable folder.".into());
    }

    let mut photos: Vec<PhotoEntry> = WalkDir::new(&root)
        .sort_by_file_name()
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .filter_map(|entry| {
            let path = entry.path();
            let file_name = path.file_name()?.to_str()?.to_string();

            if file_name.starts_with('.') || file_name.starts_with("._") {
                return None;
            }

            if !is_supported_photo(path) {
                return None;
            }

            let canonical_path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
            let canonical = canonical_path.to_string_lossy().to_string();

            let directory = path
                .parent()
                .unwrap_or(root.as_path())
                .to_string_lossy()
                .to_string();

            let extension = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();

            let preview_path = match resolve_preview_path(&canonical_path, &extension) {
                Ok(preview_path) => preview_path,
                Err(error) => {
                    eprintln!("Skipping {}: {}", canonical_path.display(), error);
                    return None;
                }
            };

            Some(PhotoEntry {
                id: canonical.clone(),
                path: canonical,
                name: file_name,
                extension,
                directory,
                preview_path,
            })
        })
        .collect();

    photos.sort_by(|left, right| {
        left.path
            .to_ascii_lowercase()
            .cmp(&right.path.to_ascii_lowercase())
    });

    Ok(photos)
}

#[tauri::command]
fn export_photos_by_decision(
    app: AppHandle,
    source_root: String,
    destination_root: String,
    decisions: Vec<ExportDecision>,
) -> Result<ExportSummary, String> {
    if decisions.is_empty() {
        return Err("There are no photos to export.".into());
    }

    let canonical_source_root = PathBuf::from(&source_root)
        .canonicalize()
        .map_err(|error| format!("Could not read the source folder: {error}"))?;
    let destination_root = PathBuf::from(&destination_root);

    fs::create_dir_all(&destination_root)
        .map_err(|error| format!("Could not create the export folder: {error}"))?;
    let total_count = decisions.len();
    let mut moved_photos = Vec::with_capacity(total_count);

    for (index, decision) in decisions.iter().enumerate() {
        let source_path = PathBuf::from(&decision.path);

        if !source_path.is_file() {
            return Err(format!(
                "Could not export missing file: {}",
                source_path.display()
            ));
        }

        let decision_folder = decision_folder_name(&decision.decision)?;
        let relative_path = source_path
            .strip_prefix(&canonical_source_root)
            .ok()
            .map(Path::to_path_buf)
            .or_else(|| source_path.file_name().map(PathBuf::from))
            .ok_or_else(|| {
                format!(
                    "Could not determine export path for {}",
                    source_path.display()
                )
            })?;
        let target_path = destination_root.join(decision_folder).join(relative_path);

        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "Could not create export folders for {}: {error}",
                    target_path.display()
                )
            })?;
        }

        move_file(&source_path, &target_path).map_err(|error| {
            format!(
                "Could not move {} to {}: {error}",
                source_path.display(),
                target_path.display()
            )
        })?;
        moved_photos.push(MovedPhoto {
            source_path: source_path.to_string_lossy().to_string(),
            destination_path: target_path.to_string_lossy().to_string(),
        });

        let current_name = source_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string();
        let _ = app.emit(
            "export-progress",
            ExportProgress {
                processed_count: index + 1,
                total_count,
                current_name,
                current_decision: decision.decision.clone(),
            },
        );
    }

    Ok(ExportSummary {
        destination_root: destination_root.to_string_lossy().to_string(),
        exported_count: total_count,
        moved_photos,
    })
}

fn is_supported_photo(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .is_some_and(|extension| {
            is_browser_viewable_extension(&extension) || is_raw_extension(&extension)
        })
}

fn decision_folder_name(decision: &str) -> Result<&'static str, String> {
    match decision {
        "pick" => Ok("pick"),
        "hold" => Ok("hold"),
        "reject" => Ok("reject"),
        "unrated" => Ok("unrated"),
        other => Err(format!("Unsupported decision '{other}'.")),
    }
}

fn move_file(source: &Path, destination: &Path) -> Result<(), std::io::Error> {
    if destination.exists() {
        fs::remove_file(destination)?;
    }

    match fs::rename(source, destination) {
        Ok(()) => Ok(()),
        Err(_) => {
            fs::copy(source, destination)?;
            fs::remove_file(source)?;
            Ok(())
        }
    }
}

fn is_browser_viewable_extension(extension: &str) -> bool {
    matches!(
        extension,
        "jpg" | "jpeg" | "png" | "tif" | "tiff" | "webp" | "gif" | "avif" | "heic" | "heif" | "bmp"
    )
}

fn is_raw_extension(extension: &str) -> bool {
    matches!(
        extension,
        "cr2"
            | "cr3"
            | "nef"
            | "nrw"
            | "arw"
            | "sr2"
            | "orf"
            | "rw2"
            | "raf"
            | "dng"
            | "pef"
            | "raw"
    )
}

fn resolve_preview_path(path: &Path, extension: &str) -> Result<String, String> {
    if is_browser_viewable_extension(extension) {
        return Ok(path.to_string_lossy().to_string());
    }

    let preview_path = build_preview_cache_path(path, extension)?;

    if !preview_path.is_file() {
        generate_raw_preview(path, &preview_path)?;
    }

    Ok(preview_path.to_string_lossy().to_string())
}

fn build_preview_cache_path(path: &Path, extension: &str) -> Result<PathBuf, String> {
    let metadata =
        fs::metadata(path).map_err(|error| format!("Could not inspect the file: {error}"))?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or_default();

    let mut hasher = DefaultHasher::new();
    path.to_string_lossy().hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    modified.hash(&mut hasher);
    extension.hash(&mut hasher);

    let cache_root = std::env::temp_dir().join("inspector-raw-previews");
    fs::create_dir_all(&cache_root)
        .map_err(|error| format!("Could not create the RAW preview cache: {error}"))?;

    Ok(cache_root.join(format!("{:016x}.jpg", hasher.finish())))
}

#[cfg(target_os = "macos")]
fn generate_raw_preview(path: &Path, preview_path: &Path) -> Result<(), String> {
    if render_raw_with_sips(path, preview_path) || render_raw_with_quicklook(path, preview_path) {
        return Ok(());
    }

    Err("No macOS RAW preview renderer could decode this file.".into())
}

#[cfg(not(target_os = "macos"))]
fn generate_raw_preview(_path: &Path, _preview_path: &Path) -> Result<(), String> {
    Err(format!(
        "RAW preview generation is not implemented on {} yet.",
        std::env::consts::OS
    ))
}

#[cfg(target_os = "macos")]
fn render_raw_with_sips(path: &Path, preview_path: &Path) -> bool {
    matches!(
        Command::new("sips")
            .args(["-s", "format", "jpeg"])
            .arg(path)
            .args(["--out"])
            .arg(preview_path)
            .status(),
        Ok(status) if status.success() && preview_path.is_file()
    )
}

#[cfg(target_os = "macos")]
fn render_raw_with_quicklook(path: &Path, preview_path: &Path) -> bool {
    let render_dir = preview_path.with_extension("quicklook");

    if render_dir.exists() && fs::remove_dir_all(&render_dir).is_err() {
        return false;
    }

    if fs::create_dir_all(&render_dir).is_err() {
        return false;
    }

    let rendered = Command::new("qlmanage")
        .args(["-t", "-s", "4096", "-o"])
        .arg(&render_dir)
        .arg(path)
        .status()
        .ok()
        .filter(|status| status.success())
        .and_then(|_| {
            fs::read_dir(&render_dir)
                .ok()?
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .find(|candidate| candidate.is_file())
        });

    let success = rendered
        .as_ref()
        .is_some_and(|rendered_file| copy_preview_into_place(rendered_file, preview_path).is_ok());

    let _ = fs::remove_dir_all(&render_dir);

    success
}

#[cfg(target_os = "macos")]
fn copy_preview_into_place(source: &Path, destination: &Path) -> Result<(), std::io::Error> {
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase());

    if matches!(extension.as_deref(), Some("jpg" | "jpeg")) {
        fs::copy(source, destination)?;
        return Ok(());
    }

    let converted = Command::new("sips")
        .args(["-s", "format", "jpeg"])
        .arg(source)
        .args(["--out"])
        .arg(destination)
        .status()?;

    if converted.success() && destination.is_file() {
        return Ok(());
    }

    fs::copy(source, destination)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            scan_photo_directory,
            export_photos_by_decision
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
