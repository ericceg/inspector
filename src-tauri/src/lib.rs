use exif::Reader as ExifReader;
use serde::{Deserialize, Serialize};
use std::{
    collections::{hash_map::DefaultHasher, BTreeMap},
    fs,
    fs::File,
    hash::{Hash, Hasher},
    io::{self, BufReader},
    path::{Path, PathBuf},
    process::Command,
    time::UNIX_EPOCH,
};
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
    preview_ready: bool,
    is_raw: bool,
    formats: Vec<String>,
    decision: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewEntry {
    path: String,
    preview_path: String,
    preview_ready: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PhotoMetadataValue {
    label: String,
    value: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoveDecision {
    path: String,
    decision: String,
}

#[derive(Debug)]
struct PhotoCandidate {
    id: String,
    path: PathBuf,
    name: String,
    extension: String,
    directory: String,
    preview_path: PathBuf,
    preview_ready: bool,
    is_raw: bool,
    decision: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MoveSummary {
    destination_root: String,
    moved_count: usize,
    moved_photos: Vec<MovedPhoto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MovedPhoto {
    source_path: String,
    requested_source_path: String,
    destination_path: String,
    decision: String,
    companions: Vec<MovedCompanion>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MovedCompanion {
    source_path: String,
    destination_path: String,
}

#[tauri::command]
async fn scan_photo_directory(path: String) -> Result<Vec<PhotoEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || scan_photo_directory_blocking(path))
        .await
        .map_err(|error| format!("Could not scan the selected folder: {error}"))?
}

fn scan_photo_directory_blocking(path: String) -> Result<Vec<PhotoEntry>, String> {
    let root = PathBuf::from(&path);

    if !root.is_dir() {
        return Err("The selected path is not a readable folder.".into());
    }

    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Could not read the selected folder: {error}"))?;

    let candidates: Vec<PhotoCandidate> = WalkDir::new(&canonical_root)
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

            let directory = canonical_path
                .parent()
                .unwrap_or(canonical_root.as_path())
                .to_string_lossy()
                .to_string();

            let extension = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();

            let preview = match resolve_preview_path(&canonical_path, &extension, false) {
                Ok(preview) => preview,
                Err(error) => {
                    eprintln!("Skipping {}: {}", canonical_path.display(), error);
                    return None;
                }
            };
            let decision = resolve_decision(&canonical_path, &canonical_root).to_string();

            Some(PhotoCandidate {
                id: canonical.clone(),
                path: canonical_path,
                name: file_name,
                extension,
                directory,
                preview_path: preview.preview_path,
                preview_ready: preview.preview_ready,
                is_raw: preview.is_raw,
                decision,
            })
        })
        .collect();

    let mut grouped_candidates: BTreeMap<PathBuf, Vec<PhotoCandidate>> = BTreeMap::new();

    for candidate in candidates {
        grouped_candidates
            .entry(build_photo_group_key(&candidate.path))
            .or_default()
            .push(candidate);
    }

    let mut photos: Vec<PhotoEntry> = grouped_candidates
        .into_values()
        .filter_map(build_grouped_photo_entry)
        .collect();

    photos.sort_by(|left, right| {
        left.path
            .to_ascii_lowercase()
            .cmp(&right.path.to_ascii_lowercase())
    });

    Ok(photos)
}

fn build_photo_group_key(path: &Path) -> PathBuf {
    let mut key = path.parent().map(Path::to_path_buf).unwrap_or_default();

    if let Some(stem) = path.file_stem() {
        key.push(stem);
    } else if let Some(name) = path.file_name() {
        key.push(name);
    }

    key
}

fn build_grouped_photo_entry(mut candidates: Vec<PhotoCandidate>) -> Option<PhotoEntry> {
    candidates.sort_by(|left, right| {
        photo_candidate_rank(left)
            .cmp(&photo_candidate_rank(right))
            .then_with(|| {
                left.path
                    .to_string_lossy()
                    .to_ascii_lowercase()
                    .cmp(&right.path.to_string_lossy().to_ascii_lowercase())
            })
    });

    let preview_candidate = candidates
        .iter()
        .filter(|candidate| is_browser_viewable_extension(&candidate.extension))
        .min_by_key(|candidate| browser_preview_rank(&candidate.extension))
        .unwrap_or_else(|| &candidates[0]);
    let preview_path = preview_candidate.preview_path.clone();
    let preview_ready = preview_candidate.preview_ready;
    let formats = collect_photo_formats(&candidates);
    let representative = candidates.into_iter().next()?;

    Some(PhotoEntry {
        id: representative.id,
        path: representative.path.to_string_lossy().to_string(),
        name: representative.name,
        extension: representative.extension,
        directory: representative.directory,
        preview_path: preview_path.to_string_lossy().to_string(),
        preview_ready,
        is_raw: representative.is_raw,
        formats,
        decision: representative.decision,
    })
}

fn photo_candidate_rank(candidate: &PhotoCandidate) -> (u8, u8) {
    if is_raw_extension(&candidate.extension) {
        return (0, raw_extension_rank(&candidate.extension));
    }

    if is_browser_viewable_extension(&candidate.extension) {
        return (1, browser_preview_rank(&candidate.extension));
    }

    (2, u8::MAX)
}

fn raw_extension_rank(extension: &str) -> u8 {
    match extension {
        "cr2" | "cr3" | "nef" | "nrw" | "arw" | "sr2" | "orf" | "rw2" | "raf" | "dng" | "pef"
        | "raw" => 0,
        _ => u8::MAX,
    }
}

fn browser_preview_rank(extension: &str) -> u8 {
    match extension {
        "jpg" | "jpeg" => 0,
        "png" => 1,
        "tif" | "tiff" => 2,
        "webp" => 3,
        "heic" | "heif" => 4,
        "bmp" => 5,
        "gif" => 6,
        "avif" => 7,
        _ => u8::MAX,
    }
}

fn collect_photo_formats(candidates: &[PhotoCandidate]) -> Vec<String> {
    let mut formats: Vec<String> = candidates
        .iter()
        .map(|candidate| candidate.extension.to_ascii_uppercase())
        .collect();

    formats.sort();
    formats.dedup();
    formats
}

#[tauri::command]
async fn render_photo_preview(path: String) -> Result<PreviewEntry, String> {
    tauri::async_runtime::spawn_blocking(move || render_photo_preview_blocking(path))
        .await
        .map_err(|error| format!("Could not render the preview: {error}"))?
}

fn render_photo_preview_blocking(path: String) -> Result<PreviewEntry, String> {
    let photo_path = PathBuf::from(&path);

    if !photo_path.is_file() {
        return Err("The selected photo is no longer available.".into());
    }

    let canonical_path = photo_path
        .canonicalize()
        .map_err(|error| format!("Could not read the selected photo: {error}"))?;
    let extension = canonical_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    let preview = resolve_preview_path(&canonical_path, &extension, true)?;

    Ok(PreviewEntry {
        path: canonical_path.to_string_lossy().to_string(),
        preview_path: preview.preview_path.to_string_lossy().to_string(),
        preview_ready: preview.preview_ready,
    })
}

#[tauri::command]
fn move_photos_by_decision(
    source_root: String,
    decisions: Vec<MoveDecision>,
) -> Result<MoveSummary, String> {
    if decisions.is_empty() {
        return Err("There are no photos to move.".into());
    }

    let canonical_source_root = PathBuf::from(&source_root)
        .canonicalize()
        .map_err(|error| format!("Could not read the source folder: {error}"))?;
    let destination_root = canonical_source_root.clone();
    let total_count = decisions.len();
    let mut moved_photos = Vec::with_capacity(total_count);
    let mut pending_moves = Vec::with_capacity(total_count);

    for decision in decisions.iter() {
        let requested_source_path = PathBuf::from(&decision.path);
        let normalized_decision = normalize_decision(&decision.decision)?;
        let source_path =
            resolve_existing_photo_path(&canonical_source_root, &requested_source_path)?;

        let target_path =
            build_target_path(&canonical_source_root, &source_path, normalized_decision)?;
        let companions = discover_companion_paths(&canonical_source_root, &source_path)?
            .into_iter()
            .map(|companion_source| {
                let companion_target = build_target_path(
                    &canonical_source_root,
                    &companion_source,
                    normalized_decision,
                )?;

                Ok(PendingFileMove {
                    source_path: companion_source,
                    target_path: companion_target,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;

        pending_moves.push(PendingPhotoMove {
            source_path,
            target_path,
            companions,
        });
    }

    for pending_move in &pending_moves {
        ensure_destination_available(&pending_move.source_path, &pending_move.target_path)?;

        for companion in &pending_move.companions {
            ensure_destination_available(&companion.source_path, &companion.target_path)?;
        }
    }

    for (decision, pending_move) in decisions.iter().zip(pending_moves.iter()) {
        let requested_source_path = PathBuf::from(&decision.path);
        let normalized_decision = normalize_decision(&decision.decision)?;
        let source_path = &pending_move.source_path;
        let target_path = &pending_move.target_path;

        if source_path != target_path {
            move_file(source_path, target_path).map_err(|error| {
                format!(
                    "Could not move {} to {}: {error}",
                    source_path.display(),
                    target_path.display()
                )
            })?;
            prune_empty_directories(source_path.parent(), &canonical_source_root);
        }

        for companion in &pending_move.companions {
            if companion.source_path == companion.target_path {
                continue;
            }

            move_file(&companion.source_path, &companion.target_path).map_err(|error| {
                format!(
                    "Could not move companion {} to {}: {error}",
                    companion.source_path.display(),
                    companion.target_path.display()
                )
            })?;
            prune_empty_directories(companion.source_path.parent(), &canonical_source_root);
        }

        moved_photos.push(MovedPhoto {
            source_path: source_path.to_string_lossy().to_string(),
            requested_source_path: requested_source_path.to_string_lossy().to_string(),
            destination_path: target_path.to_string_lossy().to_string(),
            decision: normalized_decision.to_string(),
            companions: pending_move
                .companions
                .iter()
                .map(|companion| MovedCompanion {
                    source_path: companion.source_path.to_string_lossy().to_string(),
                    destination_path: companion.target_path.to_string_lossy().to_string(),
                })
                .collect(),
        });
    }

    Ok(MoveSummary {
        destination_root: destination_root.to_string_lossy().to_string(),
        moved_count: total_count,
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

#[derive(Debug)]
struct PendingPhotoMove {
    source_path: PathBuf,
    target_path: PathBuf,
    companions: Vec<PendingFileMove>,
}

#[derive(Debug)]
struct PendingFileMove {
    source_path: PathBuf,
    target_path: PathBuf,
}

fn is_supported_photo(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .is_some_and(|extension| {
            is_browser_viewable_extension(&extension) || is_raw_extension(&extension)
        })
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
    matches!(value, "pick" | "hold" | "reject")
}

fn resolve_decision(path: &Path, source_root: &Path) -> &'static str {
    let relative_path = match path.strip_prefix(source_root) {
        Ok(relative_path) => relative_path,
        Err(_) => return "unrated",
    };

    match relative_path
        .components()
        .next()
        .and_then(|component| component.as_os_str().to_str())
    {
        Some("pick") => "pick",
        Some("hold") => "hold",
        Some("reject") => "reject",
        _ => "unrated",
    }
}

fn normalize_decision(decision: &str) -> Result<&'static str, String> {
    match decision {
        "pick" => Ok("pick"),
        "hold" => Ok("hold"),
        "reject" => Ok("reject"),
        "unrated" => Ok("unrated"),
        other => Err(format!("Unsupported decision '{other}'.")),
    }
}

fn resolve_existing_photo_path(
    source_root: &Path,
    requested_path: &Path,
) -> Result<PathBuf, String> {
    if requested_path.is_file() {
        return requested_path
            .canonicalize()
            .map_err(|error| format!("Could not read {}: {error}", requested_path.display()));
    }

    let relative_path = normalize_relative_path(requested_path, source_root)
        .or_else(|| requested_path.file_name().map(PathBuf::from))
        .ok_or_else(|| {
            format!(
                "Could not determine organization path for {}",
                requested_path.display()
            )
        })?;

    let mut candidates = Vec::with_capacity(4);
    candidates.push(source_root.join(&relative_path));
    candidates.extend(
        ["pick", "hold", "reject"]
            .iter()
            .map(|folder| source_root.join(folder).join(&relative_path)),
    );

    for candidate in candidates {
        if candidate.is_file() {
            return candidate
                .canonicalize()
                .map_err(|error| format!("Could not read {}: {error}", candidate.display()));
        }
    }

    Err(format!(
        "Could not move missing file: {}",
        requested_path.display()
    ))
}

fn build_target_path(
    source_root: &Path,
    source_path: &Path,
    normalized_decision: &str,
) -> Result<PathBuf, String> {
    let relative_path = normalize_relative_path(source_path, source_root)
        .or_else(|| source_path.file_name().map(PathBuf::from))
        .ok_or_else(|| {
            format!(
                "Could not determine organization path for {}",
                source_path.display()
            )
        })?;

    let target_path = match normalized_decision {
        "unrated" => source_root.join(relative_path),
        folder => source_root.join(folder).join(relative_path),
    };

    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Could not create rating folders for {}: {error}",
                target_path.display()
            )
        })?;
    }

    Ok(target_path)
}

fn prune_empty_directories(start: Option<&Path>, stop_at: &Path) {
    let mut current = start.map(Path::to_path_buf);

    while let Some(path) = current {
        if path == stop_at {
            break;
        }

        match fs::remove_dir(&path) {
            Ok(()) => current = path.parent().map(Path::to_path_buf),
            Err(_) => break,
        }
    }
}

fn discover_companion_paths(
    source_root: &Path,
    source_path: &Path,
) -> Result<Vec<PathBuf>, String> {
    let stem = match source_path.file_stem() {
        Some(stem) => stem,
        None => return Ok(Vec::new()),
    };
    let relative_path = normalize_relative_path(source_path, source_root)
        .or_else(|| source_path.file_name().map(PathBuf::from));
    let relative_parent = relative_path
        .as_deref()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let mut search_dirs = Vec::new();

    if let Some(parent) = source_path.parent() {
        search_dirs.push(parent.to_path_buf());
    }

    search_dirs.push(source_root.join(&relative_parent));
    search_dirs.extend(
        ["pick", "hold", "reject"]
            .iter()
            .map(|folder| source_root.join(folder).join(&relative_parent)),
    );

    search_dirs.sort();
    search_dirs.dedup();
    let mut companions = Vec::new();

    for search_dir in search_dirs {
        if !search_dir.is_dir() {
            continue;
        }

        let entries = fs::read_dir(&search_dir).map_err(|error| {
            format!(
                "Could not read companions for {}: {error}",
                search_dir.display()
            )
        })?;

        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();

            if !path.is_file() || path == source_path {
                continue;
            }

            if path.file_stem() != Some(stem) {
                continue;
            }

            let extension = path
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| value.to_ascii_lowercase());

            if !extension.as_deref().map_or(true, is_companion_extension) {
                continue;
            }

            let canonical_path = path
                .canonicalize()
                .map_err(|error| format!("Could not read companion {}: {error}", path.display()))?;

            if canonical_path != source_path && !companions.contains(&canonical_path) {
                companions.push(canonical_path);
            }
        }
    }

    companions.sort_by(|left, right| {
        left.to_string_lossy()
            .to_ascii_lowercase()
            .cmp(&right.to_string_lossy().to_ascii_lowercase())
    });

    Ok(companions)
}

fn is_companion_extension(extension: &str) -> bool {
    matches!(
        extension,
        "xmp" | "dop" | "pp3" | "aae" | "on1" | "cos" | "json"
    ) || is_paired_photo_extension(extension)
}

fn is_paired_photo_extension(extension: &str) -> bool {
    matches!(
        extension,
        "jpg" | "jpeg" | "png" | "tif" | "tiff" | "webp" | "heic" | "heif" | "bmp"
    ) || is_raw_extension(extension)
}

fn ensure_destination_available(source: &Path, destination: &Path) -> Result<(), String> {
    if source == destination || !destination.exists() {
        return Ok(());
    }

    let source_canonical = source
        .canonicalize()
        .map_err(|error| format!("Could not read {}: {error}", source.display()))?;
    let destination_canonical = destination
        .canonicalize()
        .map_err(|error| format!("Could not read {}: {error}", destination.display()))?;

    if source_canonical == destination_canonical {
        return Ok(());
    }

    Err(format!(
        "Destination already exists: {}. Move or remove that file before rating this photo.",
        destination.display()
    ))
}

fn move_file(source: &Path, destination: &Path) -> Result<(), std::io::Error> {
    if source == destination {
        return Ok(());
    }

    if !source.exists() && destination.is_file() {
        return Ok(());
    }

    if destination.exists() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("destination already exists: {}", destination.display()),
        ));
    }

    match fs::hard_link(source, destination) {
        Ok(()) => {
            fs::remove_file(source)?;
            Ok(())
        }
        Err(_) => {
            copy_file_no_overwrite(source, destination)?;
            fs::remove_file(source)?;
            Ok(())
        }
    }
}

fn copy_file_no_overwrite(source: &Path, destination: &Path) -> Result<(), std::io::Error> {
    let mut reader = File::open(source)?;
    let mut writer = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;

    if let Err(error) = io::copy(&mut reader, &mut writer) {
        let _ = fs::remove_file(destination);
        return Err(error);
    }

    if let Ok(metadata) = fs::metadata(source) {
        let _ = fs::set_permissions(destination, metadata.permissions());
    }

    Ok(())
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

fn push_metadata_value(values: &mut Vec<PhotoMetadataValue>, label: &str, value: Option<String>) {
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

struct PreviewResolution {
    preview_path: PathBuf,
    preview_ready: bool,
    is_raw: bool,
}

fn resolve_preview_path(
    path: &Path,
    extension: &str,
    render_missing_raw: bool,
) -> Result<PreviewResolution, String> {
    if is_browser_viewable_extension(extension) {
        return Ok(PreviewResolution {
            preview_path: path.to_path_buf(),
            preview_ready: true,
            is_raw: false,
        });
    }

    if !is_raw_extension(extension) {
        return Err("The selected file format is not supported.".into());
    }

    let preview_path = build_preview_cache_path(path, extension)?;

    if render_missing_raw && !preview_path.is_file() {
        generate_raw_preview(path, &preview_path)?;
    }

    Ok(PreviewResolution {
        preview_ready: preview_path.is_file(),
        preview_path,
        is_raw: true,
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        ffi::OsStr,
        time::{SystemTime, UNIX_EPOCH},
    };

    struct TestRoot {
        path: PathBuf,
    }

    impl TestRoot {
        fn new(name: &str) -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("test clock should be after unix epoch")
                .as_nanos();
            let path = std::env::temp_dir()
                .join(format!("inspector-{name}-{}-{unique}", std::process::id()));
            fs::create_dir_all(&path).expect("test root should be created");
            let path = path
                .canonicalize()
                .expect("test root should be canonicalized");

            Self { path }
        }

        fn join(&self, path: impl AsRef<Path>) -> PathBuf {
            self.path.join(path)
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn write_file(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("test parent should be created");
        }

        fs::write(path, contents).expect("test file should be written");
    }

    fn move_one(root: &TestRoot, path: &Path, decision: &str) -> Result<MoveSummary, String> {
        move_photos_by_decision(
            root.path.to_string_lossy().to_string(),
            vec![MoveDecision {
                path: path.to_string_lossy().to_string(),
                decision: decision.to_string(),
            }],
        )
    }

    fn companion_names(paths: &[PathBuf]) -> Vec<String> {
        paths
            .iter()
            .map(|path| {
                path.file_name()
                    .and_then(OsStr::to_str)
                    .expect("test file name should be utf-8")
                    .to_string()
            })
            .collect()
    }

    #[test]
    fn discovers_known_sidecars_and_paired_photos() {
        let root = TestRoot::new("companions");
        let selected = root.join("nested/frame.nef");
        write_file(&selected, "raw");
        write_file(&root.join("nested/frame.xmp"), "xmp");
        write_file(&root.join("nested/frame.json"), "json");
        write_file(&root.join("nested/frame.jpg"), "jpg");
        write_file(&root.join("nested/frame.CR3"), "cr3");
        write_file(&root.join("nested/frame.txt"), "notes");
        write_file(&root.join("nested/other.xmp"), "other");

        let companions =
            discover_companion_paths(&root.path, &selected).expect("companions should resolve");
        let names = companion_names(&companions);

        assert_eq!(
            names,
            vec!["frame.CR3", "frame.jpg", "frame.json", "frame.xmp"]
        );
    }

    #[test]
    fn scan_groups_raw_and_browser_pairs_into_one_review_photo() {
        let root = TestRoot::new("scan-grouped-pairs");
        let raw = root.join("IMG_8907.CR2");
        let jpeg = root.join("IMG_8907.jpg");
        let sidecar = root.join("IMG_8907.xmp");
        write_file(&raw, "raw");
        write_file(&jpeg, "jpg");
        write_file(&sidecar, "xmp");

        let photos = scan_photo_directory_blocking(root.path.to_string_lossy().to_string())
            .expect("scan should succeed");

        assert_eq!(photos.len(), 1);
        assert_eq!(photos[0].name, "IMG_8907.CR2");
        assert_eq!(photos[0].path, raw.to_string_lossy().to_string());
        assert_eq!(photos[0].preview_path, jpeg.to_string_lossy().to_string());
        assert!(photos[0].preview_ready);
        assert!(photos[0].is_raw);
        assert_eq!(photos[0].formats, vec!["CR2", "JPG"]);
    }

    #[test]
    fn moves_selected_photo_into_each_decision_folder() {
        for decision in ["pick", "hold", "reject"] {
            let root = TestRoot::new(decision);
            let selected = root.join("frame.jpg");
            write_file(&selected, decision);

            let summary = move_one(&root, &selected, decision).expect("photo should move");
            let destination = root.join(format!("{decision}/frame.jpg"));

            assert_eq!(summary.moved_count, 1);
            assert_eq!(summary.moved_photos.len(), 1);
            assert_eq!(summary.moved_photos[0].decision, decision);
            assert_eq!(
                summary.moved_photos[0].destination_path,
                destination.to_string_lossy().to_string()
            );
            assert!(!selected.exists());
            assert_eq!(
                fs::read_to_string(destination).expect("destination should be readable"),
                decision
            );
        }
    }

    #[test]
    fn clearing_rated_photo_moves_back_to_unrated_and_preserves_nested_path() {
        let root = TestRoot::new("clear");
        let rated = root.join("pick/event/day/frame.jpg");
        let sidecar = root.join("pick/event/day/frame.xmp");
        write_file(&rated, "rated");
        write_file(&sidecar, "sidecar");

        let summary = move_one(&root, &rated, "unrated").expect("photo should clear");
        let destination = root.join("event/day/frame.jpg");
        let sidecar_destination = root.join("event/day/frame.xmp");

        assert_eq!(
            summary.moved_photos[0].destination_path,
            destination.to_string_lossy().to_string()
        );
        assert!(!rated.exists());
        assert!(!sidecar.exists());
        assert_eq!(
            fs::read_to_string(destination).expect("destination should be readable"),
            "rated"
        );
        assert_eq!(
            fs::read_to_string(sidecar_destination).expect("sidecar should be readable"),
            "sidecar"
        );
    }

    #[test]
    fn moves_companion_sidecars_and_paired_photos_with_selected_photo() {
        let root = TestRoot::new("move-companions");
        let selected = root.join("shoot/frame.nef");
        write_file(&selected, "raw");
        write_file(&root.join("shoot/frame.xmp"), "xmp");
        write_file(&root.join("shoot/frame.dop"), "dop");
        write_file(&root.join("shoot/frame.jpg"), "jpg");
        write_file(&root.join("shoot/frame.txt"), "notes");

        let summary = move_one(&root, &selected, "pick").expect("photo should move");
        let moved = &summary.moved_photos[0];

        assert_eq!(moved.companions.len(), 3);
        assert!(root.join("pick/shoot/frame.nef").is_file());
        assert!(root.join("pick/shoot/frame.xmp").is_file());
        assert!(root.join("pick/shoot/frame.dop").is_file());
        assert!(root.join("pick/shoot/frame.jpg").is_file());
        assert!(root.join("shoot/frame.txt").is_file());
        assert!(!root.join("shoot/frame.nef").exists());
        assert!(!root.join("shoot/frame.xmp").exists());
    }

    #[test]
    fn moves_extensionless_same_basename_sidecars_with_selected_photo() {
        let root = TestRoot::new("extensionless-companion");
        let selected = root.join("IMG_8907.CR2");
        let sidecar = root.join("IMG_8907");
        write_file(&selected, "raw");
        write_file(&sidecar, "sidecar");

        let summary = move_one(&root, &selected, "pick").expect("photo should move");
        let moved = &summary.moved_photos[0];

        assert_eq!(moved.companions.len(), 1);
        assert!(root.join("pick/IMG_8907.CR2").is_file());
        assert!(root.join("pick/IMG_8907").is_file());
        assert!(!selected.exists());
        assert!(!sidecar.exists());
    }

    #[test]
    fn moves_leftover_root_sidecar_when_selected_photo_is_already_rated() {
        let root = TestRoot::new("leftover-root-sidecar");
        let selected = root.join("pick/IMG_8907.CR2");
        let sidecar = root.join("IMG_8907");
        write_file(&selected, "raw");
        write_file(&sidecar, "sidecar");

        let summary = move_one(&root, &selected, "pick").expect("sidecar should move");
        let moved = &summary.moved_photos[0];

        assert_eq!(
            moved.destination_path,
            selected.to_string_lossy().to_string()
        );
        assert_eq!(moved.companions.len(), 1);
        assert!(selected.is_file());
        assert!(root.join("pick/IMG_8907").is_file());
        assert!(!sidecar.exists());
    }

    #[test]
    fn rejects_move_when_selected_destination_already_exists() {
        let root = TestRoot::new("selected-conflict");
        let selected = root.join("frame.jpg");
        let existing = root.join("pick/frame.jpg");
        write_file(&selected, "source");
        write_file(&existing, "existing");

        let error = move_one(&root, &selected, "pick").expect_err("move should fail");

        assert!(error.contains("Destination already exists"));
        assert_eq!(
            fs::read_to_string(&selected).expect("source should remain"),
            "source"
        );
        assert_eq!(
            fs::read_to_string(&existing).expect("existing destination should remain"),
            "existing"
        );
    }

    #[test]
    fn rejects_move_when_companion_destination_already_exists() {
        let root = TestRoot::new("companion-conflict");
        let selected = root.join("frame.jpg");
        let companion = root.join("frame.xmp");
        let existing_companion = root.join("pick/frame.xmp");
        write_file(&selected, "source");
        write_file(&companion, "sidecar");
        write_file(&existing_companion, "existing");

        let error = move_one(&root, &selected, "pick").expect_err("move should fail");

        assert!(error.contains("Destination already exists"));
        assert!(selected.is_file());
        assert_eq!(
            fs::read_to_string(&companion).expect("companion should remain"),
            "sidecar"
        );
        assert!(!root.join("pick/frame.jpg").exists());
        assert_eq!(
            fs::read_to_string(existing_companion)
                .expect("existing companion destination should remain"),
            "existing"
        );
    }

    #[test]
    fn resolves_already_moved_requested_path_from_decision_folders() {
        let root = TestRoot::new("resolve-moved");
        let requested = root.join("event/frame.jpg");
        let actual = root.join("pick/event/frame.jpg");
        write_file(&actual, "picked");

        let summary = move_one(&root, &requested, "reject").expect("photo should move");
        let destination = root.join("reject/event/frame.jpg");

        assert_eq!(
            summary.moved_photos[0].source_path,
            actual.to_string_lossy().to_string()
        );
        assert_eq!(
            summary.moved_photos[0].requested_source_path,
            requested.to_string_lossy().to_string()
        );
        assert_eq!(
            summary.moved_photos[0].destination_path,
            destination.to_string_lossy().to_string()
        );
        assert!(!actual.exists());
        assert_eq!(
            fs::read_to_string(destination).expect("destination should be readable"),
            "picked"
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            scan_photo_directory,
            render_photo_preview,
            move_photos_by_decision,
            read_photo_metadata
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
