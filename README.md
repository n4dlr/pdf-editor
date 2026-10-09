# Super PDF Studio

An offline-first Windows desktop PDF workspace built with Tauri 2, PDF.js, Fabric.js, Tesseract.js, and pdf-lib.

## Features

- Render PDF pages locally and navigate via lazy-loaded thumbnails.
- Search text across the PDF with page-jump results and on-page match highlights.
- Add editable text, shapes, images, watermarks, pen strokes, highlighter marks, lines, ellipses, sticky notes, typed signatures, and page numbers.
- Use object selection, keyboard nudging, color/opacity/font/alignment controls, layer order, undo/redo, and multi-select.
- Reorder pages by dragging thumbnails, duplicate or insert pages, rotate or delete pages, export one page, or merge PDFs.
- Copy the selectable text from the current page and pan/zoom around large pages.
- Run English OCR against the visible page using bundled Tesseract.js worker, WASM, and language data.
- Import TTF/OTF fonts for the current application session using the browser FontFace API.
- Export annotations as raster overlays while retaining the original PDF page content.
- Toggle dark/light appearance. PDF input and OCR do not require network access.
- Keep the last 12 opened PDFs in local browser storage and reopen them from the Recent documents list.

## Development

### Linux (Debian / Ubuntu)

Install the system and frontend prerequisites once:

```sh
./setup-linux.sh
```

Then start the Tauri desktop app:

```sh
./start-linux.sh
```

The setup script installs Tauri's Debian/Ubuntu build libraries with `apt` and runs `npm ci`. It requires Node.js 20 or newer, Rust stable via rustup, and `sudo` access. Other Linux distributions need the equivalent Tauri v2 prerequisites installed with their package manager.

### Windows

Run setup from a Visual Studio Developer PowerShell. The script uses `winget` to install Node.js LTS, Rustup, and Visual Studio 2022 C++ Build Tools if missing; after installing tools, close and reopen Developer PowerShell and rerun setup:

```powershell
.\setup-windows.ps1
```

Start the desktop app:

```powershell
.\start-windows.ps1
```

The setup script also installs the Windows Rust target and npm dependencies. To build the Windows installer instead, use `.\build-win.ps1` on Windows after setup.

### Browser development

The desktop start scripts launch Tauri. To run only the local Vite development server in a browser:

```sh
npm ci
npm run dev
```

Before building, `scripts/prepare-offline-assets.mjs` copies Tesseract.js worker, WASM, and English model files into the app's local public assets.

```sh
npm run check
npm run build
```

To package the Windows NSIS installer, use a Windows machine with Node.js LTS, Rust/MSVC, and the Tauri prerequisites installed:

```powershell
.\build-win.ps1
```

The installer bundles the application and offline WebView2 runtime. It does not install Office or make changes to Windows font registries. Fonts imported in the app are session-only.

The app UI supports Azerbaijani, Russian, and English, remembers the selected language on this device, and initially follows the operating-system language where possible. The stock Tauri NSIS bundle offers its language selector in English and Russian; Azerbaijani is available inside the app but is not a built-in NSIS installer language.

## Editing model

PDF.js renders each original PDF page into a high-resolution canvas for viewing. The editable canvas above it is an annotation layer: text boxes, shapes, images, signatures, and marks added in the app can be selected and changed. Existing text and images inside the original PDF are not directly editable in this version. The **Copy text** and search actions read the PDF's text layer; OCR recognizes scanned page text and can add its result as a separate annotation, but does not replace the scanned/original content.

## Local document history

The app keeps copies of up to 12 recently opened PDFs in this browser profile using IndexedDB, so they can be reopened after restarting the app or refreshing the page. Use the clock button to open history, remove one entry, or clear all saved copies. This storage stays on the device; browser storage can still be removed by clearing site data.

## Notes and limits

- OCR currently supports the bundled English model and runs on the current page.
- The Optimize action rewrites PDF object streams without lossy image recompression; it may not reduce every file's size.
- Annotations are exported as page-sized PNG overlays, so their appearance is preserved but they are not native PDF text objects.
- The application keeps document data on the device. No specific RAM footprint is guaranteed; memory use depends on document size and page complexity.
- Microsoft Office requires separately licensed installation media and is not bundled or activated by this project.
- The typed signature tool adds a visual signature annotation only; it is not a cryptographic PDF signature.
- Search reads the PDF text layer; use OCR first on scanned pages.
