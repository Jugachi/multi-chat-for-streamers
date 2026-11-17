//! Command line options, the data folder, and config.json.
//!
//! Data folder (config.json, custom-themes/, web/):
//! 1. `--data-dir=<path>` if given
//! 2. the folder next to the executable if it contains `config.json` (portable mode)
//! 3. otherwise the per-user config folder, e.g. `%APPDATA%\multi-chat` on Windows
//!    (the same folder the old Electron version used, so settings carry over)

use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const DEFAULT_PORT: u16 = 41414;

/// Settings the client may change through `updateConfig`.
pub const UI_KEYS: [&str; 5] = ["theme", "background", "mode", "mentions", "activityPos"];

#[derive(Clone, Debug, Default)]
pub struct Options {
    /// Simulate all platforms instead of connecting (`--virtual` or `--dev`).
    pub virtual_mode: bool,
    /// `--port=1234`; `Some(0)` picks a free port (used by tests).
    pub port: Option<u16>,
    /// `--data-dir=<path>`
    pub data_dir: Option<PathBuf>,
}

impl Options {
    /// Parses `--virtual`, `--dev`, `--port=N` / `--port N`, `--data-dir=P` / `--data-dir P`.
    /// The `PORT` environment variable is used when no `--port` is given.
    pub fn from_args<I: IntoIterator<Item = String>>(args: I) -> Options {
        let mut opts = Options::default();
        let mut args = args.into_iter().peekable();
        while let Some(arg) = args.next() {
            let (flag, inline) = match arg.split_once('=') {
                Some((f, v)) => (f.to_string(), Some(v.to_string())),
                None => (arg.clone(), None),
            };
            match flag.as_str() {
                "--virtual" | "--dev" => opts.virtual_mode = true,
                "--port" => {
                    let value = inline.or_else(|| args.next());
                    opts.port = value.and_then(|v| v.parse().ok());
                }
                "--data-dir" => {
                    let value = inline.or_else(|| args.next());
                    opts.data_dir = value.map(PathBuf::from);
                }
                _ => {}
            }
        }
        if opts.port.is_none() {
            opts.port = std::env::var("PORT").ok().and_then(|v| v.parse().ok());
        }
        opts
    }
}

#[derive(Clone, Debug)]
pub struct Paths {
    pub data_dir: PathBuf,
    pub config_file: PathBuf,
    /// Themes made with the editor or dropped in by hand.
    pub custom_themes: PathBuf,
    /// Files here override the built-in web files (e.g. a custom index.html).
    pub web_override: PathBuf,
}

impl Paths {
    pub fn resolve(data_dir: Option<&Path>) -> Paths {
        let data_dir = data_dir.map(Path::to_path_buf).unwrap_or_else(default_data_dir);
        let paths = Paths {
            config_file: data_dir.join("config.json"),
            custom_themes: data_dir.join("custom-themes"),
            web_override: data_dir.join("web"),
            data_dir,
        };
        let _ = std::fs::create_dir_all(&paths.custom_themes);
        paths
    }
}

fn default_data_dir() -> PathBuf {
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf));
    if let Some(dir) = &exe_dir {
        if dir.join("config.json").is_file() {
            return dir.clone(); // portable mode
        }
    }
    dirs::config_dir()
        .map(|d| d.join("multi-chat")) // same folder the Electron version used
        .or(exe_dir)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn default_config() -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("theme".into(), "dark-pill".into());
    m.insert("background".into(), "transparent".into());
    m.insert("mode".into(), "widget".into());
    m.insert("mentions".into(), true.into());
    m
}

/// config.json, kept as a JSON object so unknown keys survive round trips.
pub struct ConfigStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl ConfigStore {
    pub fn new(path: PathBuf) -> ConfigStore {
        ConfigStore { path, lock: Mutex::new(()) }
    }

    pub fn load(&self) -> Map<String, Value> {
        let _guard = self.lock.lock().unwrap();
        self.load_unlocked()
    }

    fn load_unlocked(&self) -> Map<String, Value> {
        let mut cfg = default_config();
        match std::fs::read_to_string(&self.path) {
            Ok(text) => match serde_json::from_str::<Value>(&text) {
                Ok(Value::Object(saved)) => cfg.extend(saved),
                Ok(_) => eprintln!("config.json is not a JSON object, using defaults"),
                Err(e) => eprintln!("config.json is invalid ({e}), using defaults"),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => eprintln!("Could not read config.json: {e}"),
        }
        cfg
    }

    /// Load, change, save — atomically with respect to other updates.
    pub fn update(&self, change: impl FnOnce(&mut Map<String, Value>)) -> Map<String, Value> {
        let _guard = self.lock.lock().unwrap();
        let mut cfg = self.load_unlocked();
        change(&mut cfg);
        let text = serde_json::to_string_pretty(&Value::Object(cfg.clone())).unwrap_or_default();
        if let Err(e) = std::fs::write(&self.path, text) {
            eprintln!("Could not save config.json: {e}");
        }
        cfg
    }

    pub fn port(&self) -> Option<u16> {
        self.load().get("port").and_then(Value::as_u64).and_then(|p| u16::try_from(p).ok())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_flags() {
        let o = Options::from_args(args(&["--virtual", "--port=48213", "--data-dir", "C:/x"]));
        assert!(o.virtual_mode);
        assert_eq!(o.port, Some(48213));
        assert_eq!(o.data_dir, Some(PathBuf::from("C:/x")));

        let o = Options::from_args(args(&["--dev", "--port", "1234"]));
        assert!(o.virtual_mode);
        assert_eq!(o.port, Some(1234));
    }
}
