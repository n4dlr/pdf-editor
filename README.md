# Super PDF Studio

Super PDF Studio is an offline native PDF viewer and editor for Linux and Windows. The desktop interface is written in Rust with egui/eframe and uses MuPDF for PDF rendering and editing; it does not require a browser or WebView.

## Features

- Open and view PDFs, navigate pages, zoom, and access recently opened documents after restarting.
- Search page text, copy the current page's text, and replace unique text matches in the PDF content.
- Insert page text, lines, rectangles, ellipses, and images.
- Rotate, reorder, duplicate, delete, and add blank pages; export a page or merge another PDF.
- Undo and redo document edits, then save to a new PDF file.
- Azerbaijani, Russian, and English interface with the selected language saved locally.
- Work offline; documents and preferences remain on the local device.

The current native release does not include OCR, custom font installation, or editing of existing embedded images/text other than the unique text replacement tool. Annotations and inserted content are committed to the PDF by MuPDF. Memory use varies with document size and page complexity; a fixed RAM footprint is not guaranteed.

## Requirements

- Rust stable and Cargo.
- Linux: Debian/Ubuntu development libraries for egui, FreeType, fontconfig, X11/Wayland, and MuPDF's bundled native build (see setup script).
- Windows: Visual Studio 2022 Build Tools with the **Desktop development with C++** workload and Windows SDK, plus Rust's MSVC toolchain.

## Linux

On Debian or Ubuntu, install build prerequisites:

```sh
./setup-linux.sh
```

Run the native application:

```sh
./start-linux.sh
```

Build the release binary and Debian package:

```sh
./build-linux.sh
```

The outputs are `native/target/release/super-pdf-studio` and `artifacts/SuperPDFStudio_Linux.deb`. `cargo-deb` is installed by the setup script.
The current x86_64 Debian package requires `libc6` 2.39 or newer, matching the build environment.

## Windows

Run setup from PowerShell after installing Visual Studio 2022 Build Tools with its C++ workload:

```powershell
.\setup-windows.ps1
```

Run the desktop app:

```powershell
.\start-windows.ps1
```

Build the standalone release executable:

```powershell
.\build-win.ps1
```

The executable is copied to `artifacts\SuperPDFStudio.exe`. Windows builds must be compiled on Windows using the MSVC toolchain; the Linux script does not cross-compile it.

Both launch scripts accept an optional PDF path, for example `./start-linux.sh ./document.pdf` or `.\start-windows.ps1 .\document.pdf`.

## Local preferences and recent documents

The application stores its language selection and up to 16 recent PDF file paths in the operating system's standard per-user configuration directory. It stores paths, not copies of PDF documents. A recent item can no longer be opened if its original file was moved or deleted.

## Licensing

This application links MuPDF, which is licensed under AGPL-3.0. See [LICENSE](./LICENSE) and ensure your distribution complies with the licenses of all bundled dependencies.
