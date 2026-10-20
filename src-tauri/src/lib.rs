// Distill Local Dedupe：パソコンのフォルダを読み込み、重複を見比べてゴミ箱へ移す
use serde::Serialize;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

#[derive(Serialize)]
struct Entry {
    path: String,
    name: String,
    dir: String,
    size: u64,
    mtime: u64,
}

#[derive(Serialize)]
struct ScanResult {
    files: Vec<Entry>,
    folders: usize,
    skipped: usize,
}

// 隠しファイル・OS の管理用フォルダは読まない
fn skip_name(n: &str) -> bool {
    n.starts_with('.')
        || matches!(
            n,
            "$RECYCLE.BIN" | "System Volume Information" | "node_modules" | "@eaDir" | "#recycle"
        )
}

// フォルダを読み込む（中身は変更しない）。min_size 未満のファイルは数えない
#[tauri::command]
async fn scan(paths: Vec<String>, min_size: u64) -> Result<ScanResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut files = Vec::new();
        let (mut folders, mut skipped) = (0usize, 0usize);
        for root in paths {
            let walker = WalkDir::new(&root)
                .follow_links(false)
                .into_iter()
                .filter_entry(|e| e.depth() == 0 || !skip_name(&e.file_name().to_string_lossy()));
            for e in walker {
                let e = match e {
                    Ok(e) => e,
                    Err(_) => {
                        skipped += 1;
                        continue;
                    }
                };
                if e.file_type().is_dir() {
                    folders += 1;
                    continue;
                }
                if !e.file_type().is_file() {
                    continue;
                }
                let md = match e.metadata() {
                    Ok(m) => m,
                    Err(_) => {
                        skipped += 1;
                        continue;
                    }
                };
                if md.len() < min_size {
                    continue;
                }
                let mtime = md
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let p = e.path();
                files.push(Entry {
                    path: p.to_string_lossy().into_owned(),
                    name: e.file_name().to_string_lossy().into_owned(),
                    dir: p.parent().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default(),
                    size: md.len(),
                    mtime,
                });
            }
        }
        Ok(ScanResult { files, folders, skipped })
    })
    .await
    .map_err(|e| e.to_string())?
}

// 中身の目印：サイズ＋先頭 4MB＋末尾 4MB のハッシュ（大きな動画でもすぐ終わる）
#[tauri::command]
async fn quick_hash(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        const CH: u64 = 4 * 1024 * 1024;
        let mut f = File::open(&path).map_err(|e| e.to_string())?;
        let len = f.metadata().map_err(|e| e.to_string())?.len();
        let mut h = blake3::Hasher::new();
        h.update(&len.to_le_bytes());
        let mut buf = vec![0u8; CH as usize];
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        h.update(&buf[..n]);
        if len > CH * 2 {
            f.seek(SeekFrom::End(-(CH as i64))).map_err(|e| e.to_string())?;
            let mut tail = Vec::with_capacity(CH as usize);
            f.take(CH).read_to_end(&mut tail).map_err(|e| e.to_string())?;
            h.update(&tail);
        }
        Ok(h.finalize().to_hex().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
struct TrashResult {
    ok: Vec<String>,
    failed: Vec<(String, String)>,
}

// OS のゴミ箱（ごみ箱）へ移す。完全には削除しない
#[tauri::command]
async fn move_to_trash(paths: Vec<String>) -> Result<TrashResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (mut ok, mut failed) = (Vec::new(), Vec::new());
        for p in paths {
            if !Path::new(&p).exists() {
                failed.push((p, "見つかりません（すでに移動・削除されています）".into()));
                continue;
            }
            match trash::delete(&p) {
                Ok(_) => ok.push(p),
                Err(e) => failed.push((p, e.to_string())),
            }
        }
        Ok(TrashResult { ok, failed })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![scan, quick_hash, move_to_trash])
        .run(tauri::generate_context!())
        .expect("Distill Local Dedupe を起動できませんでした");
}
