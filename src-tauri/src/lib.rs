pub mod archive;
pub mod armor;
pub mod commands;
pub mod container;
pub mod crypto;
pub mod error;
pub mod safepath;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            commands::scan_paths,
            commands::inspect,
            commands::inspect_text,
            commands::pack,
            commands::unpack,
            commands::unpack_text,
            commands::copy_container_to_clipboard,
            commands::pick_files_to_pack,
            commands::pick_folders_to_pack,
            commands::pick_container,
            commands::pick_dest_dir,
            commands::pick_save_path,
            commands::reveal,
        ])
        .run(tauri::generate_context!())
        .expect("Packer 창을 띄우지 못했습니다");
}
