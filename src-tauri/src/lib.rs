use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const DESKTOP_URL: &str = "http://127.0.0.1:8787";

fn copy_dir(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination)
        .map_err(|error| format!("Unable to create {}: {}", destination.display(), error))?;

    for entry in fs::read_dir(source)
        .map_err(|error| format!("Unable to read {}: {}", source.display(), error))?
    {
        let entry = entry.map_err(|error| format!("Unable to read directory entry: {}", error))?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());

        if source_path.is_dir() {
            copy_dir(&source_path, &destination_path)?;
        } else if !destination_path.exists() {
            fs::copy(&source_path, &destination_path).map_err(|error| {
                format!(
                    "Unable to copy {} to {}: {}",
                    source_path.display(),
                    destination_path.display(),
                    error
                )
            })?;
        }
    }

    Ok(())
}

fn project_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(root) = std::env::var("WALLOS_APP_ROOT") {
        return Ok(PathBuf::from(root));
    }

    if let Ok(current_dir) = std::env::current_dir() {
        if current_dir.join("index.php").exists() {
            return Ok(current_dir);
        }
    }

    let resource_root = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Unable to resolve resource directory: {}", error))?
        .join("wallos");
    let data_root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Unable to resolve app data directory: {}", error))?
        .join("wallos-app");

    if !data_root.join("index.php").exists() {
        copy_dir(&resource_root, &data_root)?;
    }

    Ok(data_root)
}

fn database_file(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Unable to resolve app data directory: {}", error))?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|error| format!("Unable to create app data directory: {}", error))?;

    Ok(data_dir.join("wallos.db"))
}

fn php_binary() -> PathBuf {
    if let Ok(path) = std::env::var("WALLOS_PHP_BIN") {
        let php = PathBuf::from(path);
        if php.exists() {
            return php;
        }
    }

    for path in [
        "/opt/homebrew/bin/php",
        "/opt/homebrew/opt/php/bin/php",
        "/usr/local/bin/php",
        "/usr/local/opt/php/bin/php",
        "/usr/bin/php",
    ] {
        let php = PathBuf::from(path);
        if php.exists() {
            return php;
        }
    }

    PathBuf::from("php")
}

fn run_php_script(root: &Path, db_file: &Path, script: &str) -> Result<(), String> {
    let php = php_binary();
    let status = Command::new(&php)
        .arg(script)
        .current_dir(root)
        .env("WALLOS_DESKTOP_APP", "1")
        .env("WALLOS_DB_FILE", db_file)
        .status()
        .map_err(|error| {
            format!(
                "Unable to run {} {}: {}",
                php.display(),
                script,
                error
            )
        })?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("php {} exited with {}", script, status))
    }
}

fn start_php_server(root: &Path, db_file: &Path) -> Result<Child, String> {
    run_php_script(root, db_file, "endpoints/cronjobs/createdatabase.php")?;
    run_php_script(root, db_file, "endpoints/db/migrate.php")?;

    let php = php_binary();
    Command::new(&php)
        .args(["-S", "127.0.0.1:8787", "-t"])
        .arg(root)
        .current_dir(root)
        .env("WALLOS_DESKTOP_APP", "1")
        .env("WALLOS_DB_FILE", db_file)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            format!(
                "Unable to start Wallos PHP server with {}: {}",
                php.display(),
                error
            )
        })
}

fn open_main_window(app: &AppHandle) -> Result<(), String> {
    let url = DESKTOP_URL
        .parse()
        .map_err(|error| format!("Invalid desktop URL: {}", error))?;

    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("Wallos")
        .inner_size(1280.0, 820.0)
        .min_inner_size(900.0, 620.0)
        .center()
        .build()
        .map(|_| ())
        .map_err(|error| format!("Unable to create Wallos window: {}", error))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let server: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let server_for_setup = Arc::clone(&server);
    let server_for_exit = Arc::clone(&server);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            let root = project_root(app.handle())
                .map_err(|error| Box::<dyn std::error::Error>::from(error))?;
            let db_file = database_file(app.handle())
                .map_err(|error| Box::<dyn std::error::Error>::from(error))?;
            let child = start_php_server(&root, &db_file)
                .map_err(|error| Box::<dyn std::error::Error>::from(error))?;
            *server_for_setup.lock().expect("server lock poisoned") = Some(child);

            std::thread::sleep(Duration::from_millis(500));
            open_main_window(app.handle())
                .map_err(|error| Box::<dyn std::error::Error>::from(error))?;

            Ok(())
        })
        .on_window_event(move |_window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                if let Some(mut child) = server_for_exit.lock().expect("server lock poisoned").take() {
                    let _ = child.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Wallos desktop");
}
