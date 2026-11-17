//! Theme discovery, custom theme storage, and hot reload.
//!
//! Built-in themes: `public/themes/*.css` (compiled into the binary)
//! Custom themes:   `custom-themes/*.css` in the data folder (made with the
//!                  editor at /editor.html, or dropped in by hand)
//!
//! Each theme file may start with a `/* @name: Display Name */` comment.
//! Theme ids: built-in = file name ("dark-pill"), custom = "custom-<file name>".

use crate::assets;
use crate::hub::Hub;
use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

pub const CUSTOM_PREFIX: &str = "custom-";
pub const MAX_THEME_BYTES: usize = 200 * 1024;

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct ThemeInfo {
    pub id: String,
    pub name: String,
    pub url: String,
    pub custom: bool,
}

/// Reads `/* @name: ... */`, falling back to "retro-arcade" -> "Retro Arcade".
pub fn read_name(css: &str, fallback_slug: &str) -> String {
    let head: String = css.chars().take(2000).collect();
    if let Some(start) = head.find("@name:") {
        let rest = &head[start + "@name:".len()..];
        if let Some(end) = rest.find("*/") {
            let name = rest[..end].trim();
            if !name.is_empty() {
                return name.to_string();
            }
        }
    }
    fallback_slug
        .split(['-', '_'])
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn slugify(name: &str) -> String {
    let mut slug = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug: String = slug.trim_matches('-').chars().take(40).collect();
    let slug = slug.trim_end_matches('-').to_string();
    if slug.is_empty() { "my-theme".into() } else { slug }
}

pub struct Themes {
    pub custom_dir: PathBuf,
}

impl Themes {
    pub fn new(custom_dir: PathBuf) -> Themes {
        let _ = std::fs::create_dir_all(&custom_dir);
        Themes { custom_dir }
    }

    pub fn list(&self) -> Vec<ThemeInfo> {
        let mut builtin: Vec<ThemeInfo> = assets::list("themes/")
            .into_iter()
            .filter(|p| p.ends_with(".css"))
            .filter_map(|path| {
                let file = path.strip_prefix("themes/")?.to_string();
                let slug = file.trim_end_matches(".css").to_string();
                let css = assets::get(&path).map(|(b, _)| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
                Some(ThemeInfo { name: read_name(&css, &slug), url: format!("/themes/{file}"), id: slug, custom: false })
            })
            .collect();
        builtin.sort_by_key(|t| t.name.to_lowercase());

        let mut custom: Vec<ThemeInfo> = std::fs::read_dir(&self.custom_dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|entry| {
                let file = entry.file_name().to_string_lossy().into_owned();
                let slug = file.strip_suffix(".css")?.to_string();
                let css = std::fs::read_to_string(entry.path()).unwrap_or_default();
                Some(ThemeInfo {
                    id: format!("{CUSTOM_PREFIX}{slug}"),
                    name: read_name(&css, &slug),
                    url: format!("/custom-themes/{}", encode_path_segment(&file)),
                    custom: true,
                })
            })
            .collect();
        custom.sort_by_key(|t| t.name.to_lowercase());

        builtin.extend(custom);
        builtin
    }

    /// Writes `custom-themes/<slug>.css` with a fresh `@name` header.
    pub fn save(&self, name: &str, css: &str) -> std::io::Result<ThemeInfo> {
        let display: String = name.replace("*/", "").trim().chars().take(60).collect();
        let display = if display.is_empty() { "My Theme".to_string() } else { display };
        let body = strip_name_header(css);
        let slug = slugify(&display);
        let file = format!("{slug}.css");
        std::fs::write(self.custom_dir.join(&file), format!("/* @name: {display} */\n{body}"))?;
        Ok(ThemeInfo { id: format!("{CUSTOM_PREFIX}{slug}"), name: display, url: format!("/custom-themes/{file}"), custom: true })
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let slug = id.strip_prefix(CUSTOM_PREFIX).ok_or("Only custom themes can be deleted")?;
        let path = self.custom_dir.join(format!("{}.css", slugify(slug)));
        std::fs::remove_file(path).map_err(|e| e.to_string())
    }

    /// Resolves `/custom-themes/<file>` safely (no path traversal).
    pub fn custom_file(&self, file: &str) -> Option<PathBuf> {
        let ok = file.ends_with(".css") && !file.contains(['/', '\\']) && !file.starts_with('.') && !file.contains("..");
        ok.then(|| self.custom_dir.join(file)).filter(|p| p.is_file())
    }

    /// Emits `themesChanged` whenever a theme file is added, edited or removed.
    /// Watches the custom folder, plus `public/themes` in debug builds.
    pub fn watch(self: &Arc<Self>, hub: Arc<Hub>) -> Option<notify::RecommendedWatcher> {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if res.is_ok() {
                let _ = tx.send(());
            }
        })
        .map_err(|e| eprintln!("Theme hot reload unavailable: {e}"))
        .ok()?;

        let mut dirs = vec![self.custom_dir.clone()];
        if cfg!(debug_assertions) {
            dirs.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../public/themes"));
        }
        for dir in dirs {
            if let Err(e) = watcher.watch(&dir, RecursiveMode::NonRecursive) {
                eprintln!("Theme hot reload unavailable for {}: {e}", dir.display());
            }
        }

        let themes = self.clone();
        tokio::spawn(async move {
            while rx.recv().await.is_some() {
                // Editors often write a file in several steps; wait for things to settle.
                tokio::time::sleep(Duration::from_millis(250)).await;
                while rx.try_recv().is_ok() {}
                let version = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or_default();
                hub.emit("themesChanged", serde_json::json!({ "themes": themes.list(), "version": version }));
            }
        });
        Some(watcher)
    }
}

fn strip_name_header(css: &str) -> &str {
    let trimmed = css.trim_start();
    if trimmed.starts_with("/*") {
        if let Some(end) = trimmed.find("*/") {
            if trimmed[..end].contains("@name:") {
                return trimmed[end + 2..].trim_start();
            }
        }
    }
    css
}

fn encode_path_segment(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_slugs() {
        assert_eq!(read_name("/* @name: RPG Dialog (Typewriter) */\nbody{}", "rpg-dialog"), "RPG Dialog (Typewriter)");
        assert_eq!(read_name("body{}", "retro-arcade"), "Retro Arcade");
        assert_eq!(slugify("Test Theme ✨"), "test-theme");
        assert_eq!(slugify("***"), "my-theme");
        assert_eq!(strip_name_header("/* @name: Old */\n.a{}"), ".a{}");
        assert_eq!(strip_name_header("/* other */\n.a{}"), "/* other */\n.a{}");
    }

    #[test]
    fn lists_builtins_with_names() {
        let dir = std::env::temp_dir().join(format!("mc-themes-{}", fastrand::u64(..)));
        let themes = Themes::new(dir.clone());
        let list = themes.list();
        assert!(list.iter().any(|t| t.id == "rpg-dialog" && t.name == "RPG Dialog (Typewriter)" && !t.custom));
        let saved = themes.save("My */ Theme", "/* @name: x */\n.message{}").unwrap();
        assert_eq!(saved.id, "custom-my-theme");
        assert!(std::fs::read_to_string(dir.join("my-theme.css")).unwrap().starts_with("/* @name: My  Theme */\n.message{}"));
        assert!(themes.custom_file("../config.json").is_none());
        assert!(themes.custom_file("my-theme.css").is_some());
        themes.delete("custom-my-theme").unwrap();
        assert!(themes.delete("dark-pill").is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
