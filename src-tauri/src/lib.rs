use serde::Serialize;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PhotoEntry {
    id: String,
    path: String,
    name: String,
    extension: String,
    directory: String,
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

            let canonical = path
                .canonicalize()
                .unwrap_or_else(|_| path.to_path_buf())
                .to_string_lossy()
                .to_string();

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

            Some(PhotoEntry {
                id: canonical.clone(),
                path: canonical,
                name: file_name,
                extension,
                directory,
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

fn is_supported_photo(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase()),
        Some(extension)
            if matches!(
                extension.as_str(),
                "jpg"
                    | "jpeg"
                    | "png"
                    | "tif"
                    | "tiff"
                    | "webp"
                    | "gif"
                    | "avif"
                    | "heic"
                    | "heif"
                    | "bmp"
            )
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![scan_photo_directory])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
