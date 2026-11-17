//! The web front end (`public/`), compiled into the binary.
//! In debug builds rust-embed reads straight from disk, so edits show up on reload.

use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../../public/"]
pub struct Assets;

/// Returns the embedded file and its MIME type.
pub fn get(path: &str) -> Option<(Vec<u8>, String)> {
    let file = Assets::get(path)?;
    let mime = mime_guess::from_path(path).first_or_octet_stream().to_string();
    Some((file.data.into_owned(), mime))
}

/// Embedded files below a folder, e.g. `themes/`.
pub fn list(prefix: &str) -> Vec<String> {
    Assets::iter().filter(|p| p.starts_with(prefix)).map(|p| p.into_owned()).collect()
}
