use exif::Reader as ExifReader;
use serde::{Deserialize, Serialize};
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    fs::File,
    hash::{Hash, Hasher},
    io::BufReader,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PhotoMetadataValue {
    label: String,
    value: String,
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
    decisions: Vec<ExportDecision>,
) -> Result<ExportSummary, String> {
    if decisions.is_empty() {
        return Err("There are no photos to organize.".into());
    }

    let canonical_source_root = PathBuf::from(&source_root)
        .canonicalize()
        .map_err(|error| format!("Could not read the source folder: {error}"))?;
    let destination_root = canonical_source_root.clone();

    fs::create_dir_all(&destination_root)
        .map_err(|error| format!("Could not prepare the rating folders: {error}"))?;
    let total_count = decisions.len();
    let mut moved_photos = Vec::with_capacity(total_count);

    for (index, decision) in decisions.iter().enumerate() {
        let source_path = PathBuf::from(&decision.path);

        if !source_path.is_file() {
            return Err(format!(
                "Could not organize missing file: {}",
                source_path.display()
            ));
        }

        let decision_folder = decision_folder_name(&decision.decision)?;
        let relative_path = normalize_relative_path(&source_path, &canonical_source_root)
            .or_else(|| source_path.file_name().map(PathBuf::from))
            .ok_or_else(|| {
                format!(
                    "Could not determine organization path for {}",
                    source_path.display()
                )
            })?;
        let target_path = destination_root.join(decision_folder).join(relative_path);

        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "Could not create rating folders for {}: {error}",
                    target_path.display()
                )
            })?;
        }

        if source_path == target_path {
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
            continue;
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

#[tauri::command]
fn read_photo_metadata(path: String) -> Result<Vec<PhotoMetadataValue>, String> {
    let photo_path = PathBuf::from(&path);

    if !photo_path.is_file() {
        return Err("The selected photo is no longer available.".into());
    }

    Ok(extract_photo_metadata(&photo_path))
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

fn normalize_relative_path(path: &Path, source_root: &Path) -> Option<PathBuf> {
    let relative_path = path.strip_prefix(source_root).ok()?;
    let mut components = relative_path.components();
    let first = components.next();

    match first.and_then(|component| component.as_os_str().to_str()) {
        Some(folder) if is_decision_folder_name(folder) => {
            let remainder = components.as_path();
            if remainder.as_os_str().is_empty() {
                path.file_name().map(PathBuf::from)
            } else {
                Some(remainder.to_path_buf())
            }
        }
        _ => Some(relative_path.to_path_buf()),
    }
}

fn is_decision_folder_name(value: &str) -> bool {
    matches!(value, "pick" | "hold" | "reject" | "unrated")
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

fn extract_photo_metadata(path: &Path) -> Vec<PhotoMetadataValue> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return Vec::new(),
    };
    let mut reader = BufReader::new(file);
    let exif = match ExifReader::new().read_from_container(&mut reader) {
        Ok(exif) => exif,
        Err(_) => return Vec::new(),
    };

    let mut values = Vec::new();

    push_metadata_value(
        &mut values,
        "ISO",
        find_exif_value(&exif, &["PhotographicSensitivity", "ISOSpeedRatings"]),
    );
    push_metadata_value(
        &mut values,
        "Aperture",
        find_exif_value(&exif, &["FNumber"]).map(format_aperture),
    );
    push_metadata_value(
        &mut values,
        "Shutter",
        find_exif_value(&exif, &["ExposureTime"]),
    );
    push_metadata_value(
        &mut values,
        "Focal Length",
        find_exif_value(&exif, &["FocalLength"]),
    );
    push_metadata_value(
        &mut values,
        "Lens",
        find_exif_value(&exif, &["LensModel", "LensSpecification"]),
    );
    push_metadata_value(
        &mut values,
        "Camera",
        format_camera(
            find_exif_value(&exif, &["Make"]),
            find_exif_value(&exif, &["Model"]),
        ),
    );
    push_metadata_value(
        &mut values,
        "Captured",
        find_exif_value(&exif, &["DateTimeOriginal"]).map(format_capture_time),
    );

    values
}

fn push_metadata_value(
    values: &mut Vec<PhotoMetadataValue>,
    label: &str,
    value: Option<String>,
) {
    if let Some(value) = value.filter(|value| !value.is_empty()) {
        values.push(PhotoMetadataValue {
            label: label.to_string(),
            value,
        });
    }
}

fn find_exif_value(exif: &exif::Exif, tags: &[&str]) -> Option<String> {
    tags.iter().find_map(|tag| {
        exif.fields()
            .find(|field| field.tag.to_string() == *tag)
            .map(|field| field.display_value().with_unit(exif).to_string())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

fn format_aperture(value: String) -> String {
    if value.starts_with("f/") {
        value
    } else {
        format!("f/{value}")
    }
}

fn format_capture_time(value: String) -> String {
    value.replacen(':', "-", 2)
}

fn format_camera(make: Option<String>, model: Option<String>) -> Option<String> {
    match (make, model) {
        (Some(make), Some(model)) => {
            let normalized_make = make.to_ascii_lowercase();
            let normalized_model = model.to_ascii_lowercase();

            if normalized_model.starts_with(&normalized_make) {
                Some(model)
            } else {
                Some(format!("{make} {model}"))
            }
        }
        (Some(make), None) => Some(make),
        (None, Some(model)) => Some(model),
        (None, None) => None,
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
            export_photos_by_decision,
            read_photo_metadata
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
