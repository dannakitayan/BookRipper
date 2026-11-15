use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;

// Бинарник лежит в Source/src-tauri/target/{debug,release}/app.exe — репозиторий
// на 5 уровней выше. BOOKRIPPER_ROOT переопределяет это для нестандартной
// раскладки (см. Server/bookripper/settings.py, тот же принцип).
fn project_root() -> PathBuf {
    if let Ok(root) = std::env::var("BOOKRIPPER_ROOT") {
        return PathBuf::from(root);
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.ancestors().nth(5).map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

struct ApiServer(Mutex<Option<Child>>);

fn spawn_api_server() -> Option<Child> {
    let server_dir = project_root().join("Server");
    let python_exe = if cfg!(windows) {
        server_dir.join(".venv").join("Scripts").join("python.exe")
    } else {
        server_dir.join(".venv").join("bin").join("python")
    };
    Command::new(python_exe)
        .args([
            "-m", "uvicorn", "bookripper.app:app",
            "--host", "127.0.0.1", "--port", "8008",
            "--app-dir", ".",
        ])
        .current_dir(server_dir)
        .spawn()
        .map_err(|e| log::error!("failed to start API server: {e}"))
        .ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      app.manage(ApiServer(Mutex::new(spawn_api_server())));
      Ok(())
    })
    .on_window_event(|window, event| {
      // Окно одно — закрыли его, значит пора гасить и бэкенд за ним.
      if let tauri::WindowEvent::Destroyed = event {
        if let Some(state) = window.app_handle().try_state::<ApiServer>() {
          if let Some(mut child) = state.0.lock().unwrap().take() {
            let _: std::io::Result<()> = child.kill();
          }
        }
      }
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
