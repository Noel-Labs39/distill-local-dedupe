// Windows のリリース版で黒い画面（コンソール）を出さない
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    distill_local_dedupe_lib::run()
}
