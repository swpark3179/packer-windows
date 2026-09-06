pub mod archive;
pub mod armor;
pub mod commands;
pub mod container;
pub mod crypto;
pub mod error;
pub mod qr;
pub mod safepath;

pub fn run() {
    tauri::Builder::default()
        // 마지막 묶기의 QR 나눔을 들고 있는 자리. 그림을 미리 다 그려 응답에 싣지 않고,
        // 뷰어가 장을 넘길 때마다 `qr_piece` 가 여기서 꺼내 한 장씩 그린다.
        .manage(commands::QrSlot::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            commands::scan_paths,
            commands::inspect,
            commands::inspect_text,
            commands::pack,
            commands::qr_piece,
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
