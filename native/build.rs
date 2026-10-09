fn main() {
    #[cfg(target_os = "windows")]
    winresource::WindowsResource::new()
        .set("ProductName", "Super PDF Studio")
        .set("FileDescription", "Offline native PDF editor")
        .set("OriginalFilename", "super-pdf-studio.exe")
        .compile()
        .expect("failed to embed Windows application metadata");
}
