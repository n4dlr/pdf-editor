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
