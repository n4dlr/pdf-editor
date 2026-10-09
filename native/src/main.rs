use eframe::egui::{self, ColorImage, Context, TextureHandle, TextureOptions, Vec2};
use mupdf::{
    pdf::{
        InsertImageOptions, InsertPdfOptions, InsertPosition, PageImageSource, PageSelection,
        PdfDocument, PdfRedactImageMethod, PdfRedactLineArtMethod, PdfRedactOptions,
        PdfRedactTextMethod,
    },
    shape::{FinishOptions, PdfColor, Shape, TextOptions},
    Colorspace, Matrix, Point, Rect,
};
use rfd::FileDialog;
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

const HISTORY_LIMIT: usize = 16;
const ZOOM_MIN: f32 = 0.4;
const ZOOM_MAX: f32 = 3.0;

#[derive(Clone, Copy, PartialEq, Eq)]
enum WorkspaceTab {
    Edit,
    Pages,
    Transform,
    Fonts,
    Settings,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
enum Language {
    Azerbaijani,
    Russian,
    English,
}

#[derive(Serialize, Deserialize)]
struct Preferences {
    language: Language,
    recent_files: Vec<PathBuf>,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            language: Language::Azerbaijani,
            recent_files: Vec::new(),
        }
    }
}

fn preferences_path() -> Option<PathBuf> {
    directories::ProjectDirs::from("org", "Super PDF Studio", "Super PDF Studio")
        .map(|directories| directories.config_dir().join("preferences.json"))
}

fn load_preferences() -> Preferences {
    let Some(path) = preferences_path() else {
        return Preferences::default();
    };
    match fs::read(path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(preferences) => preferences,
            Err(error) => {
                eprintln!("Could not parse local settings; using defaults: {error}");
                Preferences::default()
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Preferences::default(),
        Err(error) => {
            eprintln!("Could not read local settings; using defaults: {error}");
            Preferences::default()
        }
    }
}

impl Language {
    fn label(self) -> &'static str {
        match self {
            Self::Azerbaijani => "Azərbaycan",
            Self::Russian => "Русский",
            Self::English => "English",
        }
    }
}

#[derive(Clone)]
struct SearchHit {
    page: usize,
    quads: Vec<mupdf::Quad>,
}

struct PdfEditorApp {
    document: Option<PdfDocument>,
    bytes: Vec<u8>,
    path: Option<PathBuf>,
    recent_files: Vec<PathBuf>,
    page_count: usize,
    page_index: usize,
    zoom: f32,
    texture: Option<TextureHandle>,
    texture_page: Option<usize>,
    texture_zoom: f32,
    thumbnails: Vec<Option<TextureHandle>>,
    tab: WorkspaceTab,
    language: Language,
    search_query: String,
    search_hits: Vec<SearchHit>,
    search_error: Option<String>,
    source_text: String,
    replacement_text: String,
    new_text: String,
    font_size: f32,
    history: Vec<Vec<u8>>,
    redo: Vec<Vec<u8>>,
    dirty: bool,
    status: String,
    last_error: Option<String>,
}

impl Default for PdfEditorApp {
    fn default() -> Self {
        let preferences = load_preferences();
        Self {
            document: None,
            bytes: Vec::new(),
            path: None,
            recent_files: preferences.recent_files,
            page_count: 0,
            page_index: 0,
            zoom: 1.0,
            texture: None,
            texture_page: None,
            texture_zoom: 0.0,
            thumbnails: Vec::new(),
            tab: WorkspaceTab::Edit,
            language: preferences.language,
            search_query: String::new(),
            search_hits: Vec::new(),
            search_error: None,
            source_text: String::new(),
            replacement_text: String::new(),
            new_text: String::new(),
            font_size: 16.0,
            history: Vec::new(),
            redo: Vec::new(),
            dirty: false,
            status: "Hazır · fayllar cihazdan çıxmır".to_owned(),
            last_error: None,
        }
    }
}

impl PdfEditorApp {
    fn tr(&self, az: &'static str, ru: &'static str, en: &'static str) -> &'static str {
        match self.language {
            Language::Azerbaijani => az,
            Language::Russian => ru,
            Language::English => en,
        }
    }

    fn set_error(&mut self, error: impl ToString) {
        let message = error.to_string();
        self.status = format!("{}: {message}", self.tr("Xəta", "Ошибка", "Error"));
        self.last_error = Some(message);
    }

    fn current_bytes(&self) -> Result<Vec<u8>, String> {
        let doc = self.document.as_ref().ok_or_else(|| {
            self.tr(
                "Əvvəl PDF açın.",
                "Сначала откройте PDF.",
                "Open a PDF first.",
            )
            .to_owned()
        })?;
        let mut output = Vec::new();
        doc.write_to(&mut output)
            .map_err(|error| error.to_string())?;
        Ok(output)
    }

    fn open_path(&mut self, path: PathBuf) -> Result<(), String> {
        let bytes = fs::read(&path).map_err(|error| format!("{}: {error}", path.display()))?;
        self.load_bytes(bytes, Some(path.clone()))?;
        self.recent_files.retain(|recent| recent != &path);
        self.recent_files.insert(0, path);
        self.recent_files.truncate(16);
        self.save_preferences();
        Ok(())
    }

    fn load_bytes(&mut self, bytes: Vec<u8>, path: Option<PathBuf>) -> Result<(), String> {
        let document = PdfDocument::from_bytes(&bytes).map_err(|error| error.to_string())?;
        let page_count = document.page_count().map_err(|error| error.to_string())?;
        if page_count <= 0 {
            return Err(self
                .tr(
                    "PDF-də səhifə yoxdur.",
                    "В PDF нет страниц.",
                    "The PDF has no pages.",
                )
                .to_owned());
        }
        self.document = Some(document);
        self.bytes = bytes;
        self.path = path;
        self.page_count = page_count as usize;
        self.page_index = 0;
        self.zoom = 1.0;
        self.texture = None;
        self.texture_page = None;
        self.thumbnails = (0..self.page_count).map(|_| None).collect();
        self.history.clear();
        self.redo.clear();
        self.dirty = false;
        self.search_hits.clear();
        self.source_text.clear();
        self.replacement_text.clear();
        self.status = self
            .tr(
                "PDF açıldı · redaktəyə hazırdır",
                "PDF открыт · готов к редактированию",
                "PDF opened · ready to edit",
            )
            .to_owned();
        Ok(())
    }

    fn render_image(&self, index: usize, scale: f32) -> Result<ColorImage, String> {
        let document = self
            .document
            .as_ref()
            .ok_or_else(|| "Open a PDF first.".to_owned())?;
        let page = document
            .load_pdf_page(index as i32)
            .map_err(|error| error.to_string())?;
        let pixmap = page
            .to_pixmap(
                &Matrix::new_scale(scale, scale),
                &Colorspace::device_rgb(),
                false,
                true,
            )
            .map_err(|error| error.to_string())?;
        let width = pixmap.width() as usize;
        let height = pixmap.height() as usize;
        let channels = usize::from(pixmap.n());
        let stride = pixmap.stride() as usize;
        let samples = pixmap.samples();
        if channels < 3 || stride < width * channels {
            return Err("MuPDF returned an unsupported page pixel format.".to_owned());
        }
        let mut rgba = Vec::with_capacity(width * height * 4);
        for y in 0..height {
            let row = &samples[y * stride..y * stride + width * channels];
            for pixel in row.chunks_exact(channels) {
                rgba.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 255]);
            }
        }
        Ok(ColorImage::from_rgba_unmultiplied([width, height], &rgba))
    }

    fn ensure_page_texture(
        &mut self,
        ctx: &Context,
        index: usize,
        scale: f32,
    ) -> Result<(), String> {
        let needs_render = if index == self.page_index {
            self.texture.is_none()
                || self.texture_page != Some(index)
                || (self.texture_zoom - scale).abs() > 0.01
        } else {
            self.thumbnails.get(index).is_some_and(Option::is_none)
        };
        if !needs_render {
            return Ok(());
        }
        let image = self.render_image(index, scale)?;
        let texture = ctx.load_texture(
            format!("page-{index}-{scale:.2}"),
            image,
            TextureOptions::LINEAR,
        );
        if index == self.page_index {
            self.texture = Some(texture);
            self.texture_page = Some(index);
            self.texture_zoom = scale;
        } else if let Some(slot) = self.thumbnails.get_mut(index) {
            *slot = Some(texture);
        }
        Ok(())
    }

    fn invalidate_page_textures(&mut self) {
        self.texture = None;
        self.texture_page = None;
        self.thumbnails
            .iter_mut()
            .for_each(|texture| *texture = None);
    }

    fn remember_undo(&mut self) -> Result<(), String> {
        self.history.push(self.current_bytes()?);
        if self.history.len() > HISTORY_LIMIT {
            self.history.remove(0);
        }
        self.redo.clear();
        Ok(())
    }

    fn restore_snapshot(&mut self, bytes: Vec<u8>) -> Result<(), String> {
        let document = PdfDocument::from_bytes(&bytes).map_err(|error| error.to_string())?;
        let page_count = document.page_count().map_err(|error| error.to_string())? as usize;
        self.page_count = page_count;
        self.page_index = self.page_index.min(page_count.saturating_sub(1));
        self.bytes = bytes;
        self.document = Some(document);
        self.thumbnails = (0..page_count).map(|_| None).collect();
        self.invalidate_page_textures();
        self.dirty = true;
        Ok(())
    }

    fn save_as(&mut self) -> Result<(), String> {
        let Some(path) = FileDialog::new()
            .add_filter("PDF", &["pdf"])
            .set_file_name("edited.pdf")
            .save_file()
        else {
            return Ok(());
        };
        let bytes = self.current_bytes()?;
        fs::write(&path, &bytes).map_err(|error| format!("{}: {error}", path.display()))?;
        self.path = Some(path);
        self.bytes = bytes;
        self.dirty = false;
        self.status = self
            .tr("PDF ixrac edildi", "PDF экспортирован", "PDF exported")
            .to_owned();
        Ok(())
    }

    fn save_preferences(&self) {
        let Some(path) = preferences_path() else {
            return;
        };
        if let Some(parent) = path.parent() {
            if let Err(error) = fs::create_dir_all(parent) {
                eprintln!("Could not create local settings directory: {error}");
                return;
            }
        }
        let preferences = Preferences {
            language: self.language,
            recent_files: self.recent_files.clone(),
        };
        match serde_json::to_vec_pretty(&preferences) {
            Ok(bytes) => {
                if let Err(error) = fs::write(path, bytes) {
                    eprintln!("Could not save local settings: {error}");
                }
            }
            Err(error) => eprintln!("Could not encode local settings: {error}"),
        }
    }

    fn go_to_page(&mut self, index: usize) {
        if index < self.page_count && index != self.page_index {
            self.page_index = index;
            self.texture = None;
            self.texture_page = None;
        }
    }

    fn rotate_page(&mut self) -> Result<(), String> {
        self.remember_undo()?;
        let doc = self
            .document
            .as_mut()
            .ok_or_else(|| "Open a PDF first.".to_owned())?;
        let mut page = doc
            .load_pdf_page(self.page_index as i32)
            .map_err(|error| error.to_string())?;
        let rotation = page.rotation().map_err(|error| error.to_string())?;
        page.set_rotation((rotation + 90) % 360)
            .map_err(|error| error.to_string())?;
        drop(page);
        self.dirty = true;
        self.invalidate_page_textures();
        Ok(())
    }

    fn delete_page(&mut self) -> Result<(), String> {
        if self.page_count <= 1 {
            return Err(self
                .tr(
                    "PDF-də ən azı bir səhifə qalmalıdır.",
                    "В PDF должна остаться хотя бы одна страница.",
                    "A PDF must keep at least one page.",
                )
                .to_owned());
        }
        self.remember_undo()?;
        self.document
            .as_mut()
            .ok_or_else(|| "Open a PDF first.".to_owned())?
            .delete_page(self.page_index as i32)
            .map_err(|error| error.to_string())?;
        self.page_count -= 1;
        self.page_index = self.page_index.min(self.page_count - 1);
        self.thumbnails = (0..self.page_count).map(|_| None).collect();
        self.dirty = true;
        self.invalidate_page_textures();
        Ok(())
    }

    fn move_page(&mut self, delta: isize) -> Result<(), String> {
        let target = self.page_index as isize + delta;
        if target < 0 || target >= self.page_count as isize {
            return Ok(());
        }
        self.remember_undo()?;
        self.document
            .as_mut()
            .ok_or_else(|| "Open a PDF first.".to_owned())?
            .move_page(self.page_index, target as usize)
            .map_err(|error| error.to_string())?;
        self.page_index = target as usize;
        self.thumbnails = (0..self.page_count).map(|_| None).collect();
        self.dirty = true;
        self.invalidate_page_textures();
        Ok(())
    }

    fn search(&mut self) -> Result<(), String> {
        let query = self.search_query.trim();
        if query.is_empty() {
            return Err(self
                .tr(
                    "Axtarış üçün mətn yazın.",
                    "Введите текст для поиска.",
                    "Enter text to search for.",
                )
                .to_owned());
        }
        let document = self
            .document
            .as_ref()
            .ok_or_else(|| "Open a PDF first.".to_owned())?;
        let mut hits = Vec::new();
        for page_index in 0..self.page_count {
            let page = document
                .load_pdf_page(page_index as i32)
                .map_err(|error| error.to_string())?;
            let found = page.search(query, 101).map_err(|error| error.to_string())?;
            if !found.is_empty() {
                hits.push(SearchHit {
                    page: page_index,
                    quads: found.into_iter().collect(),
                });
            }
        }
        self.search_hits = hits;
        self.search_error = None;
        self.status = self
            .tr("Axtarış tamamlandı", "Поиск завершён", "Search complete")
            .to_owned();
        Ok(())
    }

    fn replace_text(&mut self) -> Result<(), String> {
        let needle = self.source_text.trim().to_owned();
        let replacement = self.replacement_text.clone();
        if needle.is_empty() {
            return Err(self
                .tr(
                    "Axtarılacaq dəqiq mətni daxil edin.",
                    "Введите точный текст для поиска.",
                    "Enter the exact text to find.",
                )
                .to_owned());
        }
        if replacement.contains(['\n', '\r']) {
            return Err(self
                .tr(
                    "Əvəzedici mətn bir sətirdə olmalıdır.",
                    "Текст замены должен быть в одну строку.",
                    "Replacement text must be a single line.",
                )
                .to_owned());
        }
        let before = self.current_bytes()?;
        let mut staged = PdfDocument::from_bytes(&before).map_err(|error| error.to_string())?;
        replace_pdf_text(&mut staged, self.page_index, &needle, &replacement).map_err(|error| {
            if error == "No matching text was found on the selected page." {
                self.tr(
                    "Bu səhifədə mətn tapılmadı.",
                    "На этой странице текст не найден.",
                    "Text was not found on this page.",
                )
                .to_owned()
            } else if error == "More than one match was found. Search for a longer, unique phrase."
            {
                self.tr(
                    "Bir neçə uyğunluq tapıldı. Daha unikal ifadə axtarın.",
                    "Найдено несколько совпадений. Используйте более уникальную фразу.",
                    "Multiple matches found. Search for a more unique phrase.",
                )
                .to_owned()
            } else {
                error
            }
        })?;
        let mut committed_bytes = Vec::new();
        staged
            .write_to(&mut committed_bytes)
            .map_err(|error| error.to_string())?;
        let page_count = staged.page_count().map_err(|error| error.to_string())? as usize;
        self.history.push(before);
        if self.history.len() > HISTORY_LIMIT {
            self.history.remove(0);
        }
        self.redo.clear();
        self.bytes = committed_bytes;
        self.document = Some(staged);
        self.page_count = page_count;
        self.dirty = true;
        self.invalidate_page_textures();
        self.status = self
            .tr(
                "Orijinal mətn PDF məzmununda dəyişdirildi",
                "Исходный текст заменён в содержимом PDF",
                "Original text replaced in PDF page content",
            )
            .to_owned();
        self.source_text.clear();
        self.replacement_text.clear();
        Ok(())
    }

    fn insert_text(&mut self) -> Result<(), String> {
        let text = self.new_text.trim().to_owned();
        if text.is_empty() {
            return Err(self
                .tr(
                    "Əlavə ediləcək mətni yazın.",
                    "Введите текст для добавления.",
                    "Enter text to add.",
                )
                .to_owned());
        }
        let before = self.current_bytes()?;
        let mut staged = PdfDocument::from_bytes(&before).map_err(|error| error.to_string())?;
        let mut page = staged
            .load_pdf_page(self.page_index as i32)
            .map_err(|error| error.to_string())?;
        let bounds = page.bounds().map_err(|error| error.to_string())?;
        let options = TextOptions {
            fontsize: self.font_size,
            fill: Some(PdfColor::rgb(0.1, 0.1, 0.1)),
            ..TextOptions::default()
        };
        let mut shape = Shape::new(&mut page).map_err(|error| error.to_string())?;
        shape
            .insert_text(
                Point::new(bounds.x0 + 48.0, bounds.y0 + 72.0),
                &text,
                &options,
            )
            .map_err(|error| error.to_string())?;
        shape
            .commit(&mut staged, true)
            .map_err(|error| error.to_string())?;
        drop(page);
        let mut committed_bytes = Vec::new();
        staged
            .write_to(&mut committed_bytes)
            .map_err(|error| error.to_string())?;
        self.history.push(before);
        if self.history.len() > HISTORY_LIMIT {
            self.history.remove(0);
        }
        self.redo.clear();
        self.bytes = committed_bytes;
        self.document = Some(staged);
        self.new_text.clear();
        self.dirty = true;
        self.invalidate_page_textures();
        Ok(())
    }

    fn undo(&mut self) -> Result<(), String> {
        let Some(bytes) = self.history.pop() else {
            return Ok(());
        };
        self.redo.push(self.current_bytes()?);
        self.restore_snapshot(bytes)
    }

    fn redo(&mut self) -> Result<(), String> {
        let Some(bytes) = self.redo.pop() else {
            return Ok(());
        };
        self.history.push(self.current_bytes()?);
        self.restore_snapshot(bytes)
    }

    fn add_blank_page(&mut self) -> Result<(), String> {
        self.remember_undo()?;
        let doc = self
            .document
            .as_mut()
            .ok_or_else(|| "Open a PDF first.".to_owned())?;
        let mut page = doc
            .new_page_at(self.page_index as i32 + 1, (612.0, 792.0))
            .map_err(|error| error.to_string())?;
        page.update().map_err(|error| error.to_string())?;
        drop(page);
        self.page_count += 1;
        self.page_index += 1;
        self.thumbnails = (0..self.page_count).map(|_| None).collect();
        self.dirty = true;
        self.invalidate_page_textures();
        Ok(())
    }

    fn duplicate_page(&mut self) -> Result<(), String> {
        self.remember_undo()?;
        self.document
            .as_mut()
            .ok_or_else(|| "Open a PDF first.".to_owned())?
            .duplicate_page(self.page_index)
            .map_err(|error| error.to_string())?;
        self.page_count += 1;
        self.page_index += 1;
        self.thumbnails = (0..self.page_count).map(|_| None).collect();
        self.dirty = true;
        self.invalidate_page_textures();
        Ok(())
    }

    fn add_shape(&mut self, kind: NativeShape) -> Result<(), String> {
        let before = self.current_bytes()?;
        let mut staged = PdfDocument::from_bytes(&before).map_err(|error| error.to_string())?;
        let mut page = staged
            .load_pdf_page(self.page_index as i32)
            .map_err(|error| error.to_string())?;
        let bounds = page.bounds().map_err(|error| error.to_string())?;
        let center_x = (bounds.x0 + bounds.x1) / 2.0;
        let center_y = (bounds.y0 + bounds.y1) / 2.0;
        let mut shape = Shape::new(&mut page).map_err(|error| error.to_string())?;
        match kind {
            NativeShape::Line => {
                shape
                    .draw_line(
                        Point::new(center_x - 75.0, center_y),
                        Point::new(center_x + 75.0, center_y),
                    )
                    .map_err(|error| error.to_string())?;
                shape
                    .finish(&FinishOptions {
                        color: Some(PdfColor::rgb(0.16, 0.34, 0.72)),
                        width: 2.0,
                        ..FinishOptions::default()
                    })
                    .map_err(|error| error.to_string())?;
            }
            NativeShape::Rectangle => {
                shape
                    .draw_rect(&Rect::new(
                        center_x - 70.0,
                        center_y - 32.0,
                        center_x + 70.0,
                        center_y + 32.0,
                    ))
                    .map_err(|error| error.to_string())?;
                shape
                    .finish(&FinishOptions {
                        color: Some(PdfColor::rgb(0.16, 0.34, 0.72)),
                        width: 2.0,
                        ..FinishOptions::default()
                    })
                    .map_err(|error| error.to_string())?;
            }
            NativeShape::Ellipse => {
                shape
                    .draw_oval(Rect::new(
                        center_x - 68.0,
                        center_y - 32.0,
                        center_x + 68.0,
                        center_y + 32.0,
                    ))
                    .map_err(|error| error.to_string())?;
                shape
                    .finish(&FinishOptions {
                        color: Some(PdfColor::rgb(0.16, 0.34, 0.72)),
                        width: 2.0,
                        ..FinishOptions::default()
                    })
                    .map_err(|error| error.to_string())?;
            }
        }
        shape
            .commit(&mut staged, true)
            .map_err(|error| error.to_string())?;
        drop(page);
        self.commit_staged_document(before, staged)?;
        Ok(())
    }

    fn insert_image(&mut self) -> Result<(), String> {
        let Some(path) = FileDialog::new()
            .add_filter("Images", &["png", "jpg", "jpeg", "bmp"])
            .pick_file()
        else {
            return Ok(());
        };
        let image_bytes =
            fs::read(&path).map_err(|error| format!("{}: {error}", path.display()))?;
        let format = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("png");
        let before = self.current_bytes()?;
        let mut staged = PdfDocument::from_bytes(&before).map_err(|error| error.to_string())?;
        let mut page = staged
            .load_pdf_page(self.page_index as i32)
            .map_err(|error| error.to_string())?;
        let bounds = page.bounds().map_err(|error| error.to_string())?;
        page.insert_image(
            &mut staged,
            Rect::new(
                bounds.x0 + 36.0,
                bounds.y0 + 36.0,
                bounds.x0 + 216.0,
                bounds.y0 + 156.0,
            ),
            PageImageSource::Bytes {
                data: &image_bytes,
                format_hint: Some(format),
            },
            InsertImageOptions::default(),
        )
        .map_err(|error| error.to_string())?;
        drop(page);
        self.commit_staged_document(before, staged)?;
        Ok(())
    }

    fn add_highlight(&mut self) -> Result<(), String> {
        let query = self.search_query.trim().to_owned();
        if query.is_empty() {
            return Err(self
                .tr(
                    "Əvvəlcə vurğulanacaq ifadəni axtarın.",
                    "Сначала введите фразу для выделения.",
                    "Enter the phrase to highlight first.",
                )
                .to_owned());
        }
        let before = self.current_bytes()?;
        let staged = PdfDocument::from_bytes(&before).map_err(|error| error.to_string())?;
        let mut page = staged
            .load_pdf_page(self.page_index as i32)
            .map_err(|error| error.to_string())?;
        let hits = page
            .search(&query, 101)
            .map_err(|error| error.to_string())?;
        if hits.is_empty() {
            return Err(self
                .tr(
                    "Cari səhifədə uyğun mətn tapılmadı.",
                    "На текущей странице совпадений не найдено.",
                    "No matching text found on the current page.",
                )
                .to_owned());
        }
        page.add_highlight_annotation(&hits[..])
            .map_err(|error| error.to_string())?;
        drop(page);
        self.commit_staged_document(before, staged)?;
        Ok(())
    }

    fn merge_pdf(&mut self) -> Result<(), String> {
        let Some(path) = FileDialog::new().add_filter("PDF", &["pdf"]).pick_file() else {
            return Ok(());
        };
        let before = self.current_bytes()?;
        let mut staged = PdfDocument::from_bytes(&before).map_err(|error| error.to_string())?;
        let source = PdfDocument::open(path.as_path()).map_err(|error| error.to_string())?;
        let result = staged
            .insert_pdf(
                &source,
                InsertPdfOptions {
                    target: InsertPosition::Append,
                    ..InsertPdfOptions::default()
                },
            )
            .map_err(|error| error.to_string())?;
        let next_page = result.inserted_pages.start;
        self.commit_staged_document(before, staged)?;
        self.page_index = next_page;
        self.status = self
            .tr("PDF-lər birləşdirildi", "PDF объединены", "PDFs merged")
            .to_owned();
        Ok(())
    }

    fn export_current_page(&mut self) -> Result<(), String> {
        let Some(path) = FileDialog::new()
            .add_filter("PDF", &["pdf"])
            .set_file_name("page.pdf")
            .save_file()
        else {
            return Ok(());
        };
        let source = self
            .document
            .as_ref()
            .ok_or_else(|| "Open a PDF first.".to_owned())?;
        let mut output = PdfDocument::new();
        output
            .insert_pdf(
                source,
                InsertPdfOptions {
                    source_pages: PageSelection::Pages(vec![self.page_index]),
                    target: InsertPosition::Append,
                    ..InsertPdfOptions::default()
                },
            )
            .map_err(|error| error.to_string())?;
        let mut bytes = Vec::new();
        output
            .write_to(&mut bytes)
            .map_err(|error| error.to_string())?;
        fs::write(&path, bytes).map_err(|error| format!("{}: {error}", path.display()))?;
        self.status = self
            .tr(
                "Səhifə ixrac edildi",
                "Страница экспортирована",
                "Page exported",
            )
            .to_owned();
        Ok(())
    }

    fn copy_page_text(&mut self, ctx: &Context) -> Result<(), String> {
        let document = self
            .document
            .as_ref()
            .ok_or_else(|| "Open a PDF first.".to_owned())?;
        let page = document
            .load_pdf_page(self.page_index as i32)
            .map_err(|error| error.to_string())?;
        let text = page
            .text(mupdf::TextExtractOptions::default())
            .map_err(|error| error.to_string())?;
        if text.trim().is_empty() {
            return Err(self
                .tr(
                    "Səhifədə seçilə bilən mətn yoxdur.",
                    "На странице нет извлекаемого текста.",
                    "This page has no selectable text.",
                )
                .to_owned());
        }
        ctx.copy_text(text);
        self.status = self
            .tr(
                "Səhifə mətni panoya köçürüldü",
                "Текст страницы скопирован",
                "Page text copied to clipboard",
            )
            .to_owned();
        Ok(())
    }

    fn commit_staged_document(
        &mut self,
        before: Vec<u8>,
        staged: PdfDocument,
    ) -> Result<(), String> {
        let mut bytes = Vec::new();
        staged
            .write_to(&mut bytes)
            .map_err(|error| error.to_string())?;
        let page_count = staged.page_count().map_err(|error| error.to_string())? as usize;
        self.history.push(before);
        if self.history.len() > HISTORY_LIMIT {
            self.history.remove(0);
        }
        self.redo.clear();
        self.document = Some(staged);
        self.bytes = bytes;
        self.page_count = page_count;
        self.page_index = self.page_index.min(page_count.saturating_sub(1));
        self.dirty = true;
        self.thumbnails = (0..page_count).map(|_| None).collect();
        self.invalidate_page_textures();
        Ok(())
    }

    fn show_toolbar(&mut self, ui: &mut egui::Ui) {
        ui.horizontal_wrapped(|ui| {
            if ui.button(self.tr("Aç", "Открыть", "Open")).clicked() {
                if let Some(path) = FileDialog::new().add_filter("PDF", &["pdf"]).pick_file() {
                    if let Err(error) = self.open_path(path) {
                        self.set_error(error);
                    }
                }
            }
            let open = self.document.is_some();
            if ui
                .add_enabled(
                    open,
                    egui::Button::new(self.tr(
                        "Saxla / ixrac",
                        "Сохранить / экспорт",
                        "Save / export",
                    )),
                )
                .clicked()
            {
                if let Err(error) = self.save_as() {
                    self.set_error(error);
                }
            }
            ui.separator();
            if ui
                .add_enabled(open && self.page_index > 0, egui::Button::new("←"))
                .clicked()
            {
                self.go_to_page(self.page_index - 1);
            }
            ui.label(if open {
                format!("{} / {}", self.page_index + 1, self.page_count)
            } else {
                "— / —".to_owned()
            });
            if ui
                .add_enabled(
                    open && self.page_index + 1 < self.page_count,
                    egui::Button::new("→"),
                )
                .clicked()
            {
                self.go_to_page(self.page_index + 1);
            }
            ui.separator();
            if ui.add_enabled(open, egui::Button::new("−")).clicked() {
                self.zoom = (self.zoom / 1.15).clamp(ZOOM_MIN, ZOOM_MAX);
                self.texture = None;
            }
            ui.label(format!("{:.0}%", self.zoom * 100.0));
            if ui.add_enabled(open, egui::Button::new("+")).clicked() {
                self.zoom = (self.zoom * 1.15).clamp(ZOOM_MIN, ZOOM_MAX);
                self.texture = None;
            }
            ui.separator();
            if ui
                .add_enabled(
                    open,
                    egui::Button::new(self.tr("Geri al", "Отменить", "Undo")),
                )
                .clicked()
            {
                if let Err(error) = self.undo() {
                    self.set_error(error);
                }
            }
            if ui
                .add_enabled(
                    open && !self.redo.is_empty(),
                    egui::Button::new(self.tr("Təkrar et", "Повторить", "Redo")),
                )
                .clicked()
            {
                if let Err(error) = self.redo() {
                    self.set_error(error);
                }
            }
            ui.separator();
            if ui
                .add_enabled(
                    open,
                    egui::Button::new(self.tr("Fırlat", "Повернуть", "Rotate")),
                )
                .clicked()
            {
                if let Err(error) = self.rotate_page() {
                    self.set_error(error);
                }
            }
            if ui
                .add_enabled(
                    open && self.page_count > 1,
                    egui::Button::new(self.tr("Səhifəni sil", "Удалить страницу", "Delete page")),
                )
                .clicked()
            {
                if let Err(error) = self.delete_page() {
                    self.set_error(error);
                }
            }
            if ui
                .add_enabled(
                    open,
                    egui::Button::new(self.tr("Şəkil", "Изображение", "Image")),
                )
                .clicked()
            {
                if let Err(error) = self.insert_image() {
                    self.set_error(error);
                }
            }
            if ui
                .add_enabled(
                    open,
                    egui::Button::new(self.tr(
                        "Səhifəni ixrac et",
                        "Экспорт страницы",
                        "Export page",
                    )),
                )
                .clicked()
            {
                if let Err(error) = self.export_current_page() {
                    self.set_error(error);
                }
            }
            if ui
                .add_enabled(
                    open,
                    egui::Button::new(self.tr("PDF birləşdir", "Объединить PDF", "Merge PDF")),
                )
                .clicked()
            {
                if let Err(error) = self.merge_pdf() {
                    self.set_error(error);
                }
            }
            if ui
                .add_enabled(
                    open,
                    egui::Button::new(self.tr("Mətni köçür", "Копировать текст", "Copy text")),
                )
                .clicked()
            {
                if let Err(error) = self.copy_page_text(ui.ctx()) {
                    self.set_error(error);
                }
            }
        });
    }

    fn show_sidebar(&mut self, ui: &mut egui::Ui, ctx: &Context) {
        ui.heading(self.tr("Səhifələr", "Страницы", "Pages"));
        ui.label(self.path.as_ref().map_or_else(
            || {
                self.tr("Sənəd açılmayıb", "Документ не открыт", "No document open")
                    .to_owned()
            },
            |path| {
                path.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string()
            },
        ));
        ui.separator();
        let tile_height = 176.0;
        egui::ScrollArea::vertical().show_viewport(ui, |ui, viewport| {
            let first = ((viewport.min.y / tile_height).floor() as usize).min(self.page_count);
            let end = (((viewport.max.y / tile_height).ceil() as usize) + 1).min(self.page_count);
            ui.add_space(first as f32 * tile_height);
            for index in first..end {
                if self.thumbnails.get(index).is_some_and(Option::is_none) {
                    if let Err(error) = self.ensure_page_texture(ctx, index, 0.16) {
                        self.set_error(error);
                        break;
                    }
                }
                let selected = index == self.page_index;
                let frame = egui::Frame::group(ui.style()).fill(if selected {
                    egui::Color32::from_rgb(59, 70, 78)
                } else {
                    ui.visuals().window_fill
                });
                let response = frame.show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    if let Some(texture) = &self.thumbnails[index] {
                        let image =
                            egui::Image::new(texture).fit_to_exact_size(Vec2::new(92.0, 118.0));
                        if ui.add(image.sense(egui::Sense::click())).clicked() {
                            self.go_to_page(index);
                        }
                    }
                    if ui
                        .selectable_label(
                            selected,
                            format!("{} {}", self.tr("Səhifə", "Страница", "Page"), index + 1),
                        )
                        .clicked()
                    {
                        self.go_to_page(index);
                    }
                });
                if response.response.clicked() {
                    self.go_to_page(index);
                }
                ui.horizontal(|ui| {
                    ui.add_space(8.0);
                    if ui.add_enabled(index > 0, egui::Button::new("↑")).clicked() {
                        self.page_index = index;
                        if let Err(error) = self.move_page(-1) {
                            self.set_error(error);
                        }
                    }
                    if ui
                        .add_enabled(index + 1 < self.page_count, egui::Button::new("↓"))
                        .clicked()
                    {
                        self.page_index = index;
                        if let Err(error) = self.move_page(1) {
                            self.set_error(error);
                        }
                    }
                });
                ui.separator();
            }
            ui.add_space(self.page_count.saturating_sub(end) as f32 * tile_height);
        });
    }

    fn show_inspector(&mut self, ui: &mut egui::Ui) {
        match self.tab {
            WorkspaceTab::Edit => {
                ui.heading(self.tr("Mətn redaktəsi", "Редактирование текста", "Text editing"));
                ui.label(self.tr("Dəqiq və unikal ifadə axtarılır; MuPDF mətni səhifənin PDF məzmunundan həqiqətən silir.", "Найдите точную уникальную фразу; MuPDF действительно удаляет её из содержимого страницы PDF.", "Find an exact unique phrase; MuPDF removes it from the PDF page content."));
                ui.add_space(8.0);
                ui.label(self.tr("Mövcud mətn", "Исходный текст", "Existing text"));
                ui.text_edit_multiline(&mut self.source_text);
                ui.label(self.tr(
                    "Əvəzləyici (boş saxla = sil)",
                    "Замена (пусто = удалить)",
                    "Replacement (blank = remove)",
                ));
                ui.text_edit_multiline(&mut self.replacement_text);
                if ui
                    .add_enabled(
                        self.document.is_some(),
                        egui::Button::new(self.tr(
                            "Mətni dəyişdir",
                            "Заменить текст",
                            "Replace text",
                        )),
                    )
                    .clicked()
                {
                    if let Err(error) = self.replace_text() {
                        self.set_error(error);
                    }
                }
                ui.separator();
                ui.heading(self.tr("Yeni mətn", "Новый текст", "New text"));
                ui.text_edit_multiline(&mut self.new_text);
                let size_label = self.tr("Ölçü", "Размер", "Size");
                ui.add(egui::Slider::new(&mut self.font_size, 6.0..=72.0).text(size_label));
                if ui
                    .add_enabled(
                        self.document.is_some(),
                        egui::Button::new(self.tr(
                            "Səhifəyə mətn əlavə et",
                            "Добавить текст на страницу",
                            "Add text to page",
                        )),
                    )
                    .clicked()
                {
                    if let Err(error) = self.insert_text() {
                        self.set_error(error);
                    }
                }
            }
            WorkspaceTab::Pages => {
                ui.heading(self.tr("Səhifə alətləri", "Инструменты страниц", "Page tools"));
                ui.label(self.tr(
                    "Səhifələri soldakı oxlarla yenidən sıralayın.",
                    "Меняйте порядок страниц стрелками слева.",
                    "Reorder pages with the arrows on the left.",
                ));
                if ui
                    .add_enabled(
                        self.document.is_some(),
                        egui::Button::new(self.tr("Boş səhifə", "Пустая страница", "Blank page")),
                    )
                    .clicked()
                {
                    if let Err(error) = self.add_blank_page() {
                        self.set_error(error);
                    }
                }
                if ui
                    .add_enabled(
                        self.document.is_some(),
                        egui::Button::new(self.tr(
                            "Səhifəni çoxalt",
                            "Дублировать страницу",
                            "Duplicate page",
                        )),
                    )
                    .clicked()
                {
                    if let Err(error) = self.duplicate_page() {
                        self.set_error(error);
                    }
                }
                if ui
                    .add_enabled(
                        self.document.is_some(),
                        egui::Button::new(self.tr(
                            "Səhifəni yuxarı köçür",
                            "Переместить страницу вверх",
                            "Move page up",
                        )),
                    )
                    .clicked()
                {
                    if let Err(error) = self.move_page(-1) {
                        self.set_error(error);
                    }
                }
                if ui
                    .add_enabled(
                        self.document.is_some(),
                        egui::Button::new(self.tr(
                            "Səhifəni aşağı köçür",
                            "Переместить страницу вниз",
                            "Move page down",
                        )),
                    )
                    .clicked()
                {
                    if let Err(error) = self.move_page(1) {
                        self.set_error(error);
                    }
                }
                for (label, shape) in [
                    (
                        self.tr("Düzbucaqlı", "Прямоугольник", "Rectangle"),
                        NativeShape::Rectangle,
                    ),
                    (self.tr("Ellips", "Эллипс", "Ellipse"), NativeShape::Ellipse),
                    (self.tr("Xətt", "Линия", "Line"), NativeShape::Line),
                ] {
                    if ui
                        .add_enabled(self.document.is_some(), egui::Button::new(label))
                        .clicked()
                    {
                        if let Err(error) = self.add_shape(shape) {
                            self.set_error(error);
                        }
                    }
                }
            }
            WorkspaceTab::Transform => {
                ui.heading(self.tr("Axtarış", "Поиск", "Search"));
                ui.horizontal(|ui| {
                    ui.text_edit_singleline(&mut self.search_query);
                    if ui
                        .add_enabled(
                            self.document.is_some(),
                            egui::Button::new(self.tr("Tap", "Найти", "Find")),
                        )
                        .clicked()
                    {
                        if let Err(error) = self.search() {
                            self.search_error = Some(error);
                        }
                    }
                });
                if let Some(error) = &self.search_error {
                    ui.colored_label(egui::Color32::LIGHT_RED, error);
                }
                if ui
                    .add_enabled(
                        self.document.is_some() && !self.search_query.trim().is_empty(),
                        egui::Button::new(self.tr(
                            "Tapıntını vurğula",
                            "Выделить совпадения",
                            "Highlight matches",
                        )),
                    )
                    .clicked()
                {
                    if let Err(error) = self.add_highlight() {
                        self.search_error = Some(error);
                    }
                }
                ui.label(self.tr(
                    "Səhifələr üzrə tapıntılar",
                    "Результаты по страницам",
                    "Matches by page",
                ));
                let mut goto = None;
                egui::ScrollArea::vertical()
                    .max_height(220.0)
                    .show(ui, |ui| {
                        for hit in &self.search_hits {
                            if ui
                                .button(format!(
                                    "{} · {} {}",
                                    self.tr("Səhifə", "Страница", "Page"),
                                    hit.page + 1,
                                    format!("({})", hit.quads.len())
                                ))
                                .clicked()
                            {
                                goto = Some(hit.page);
                            }
                        }
                    });
                if let Some(index) = goto {
                    self.go_to_page(index);
                }
                ui.separator();
                ui.label(self.tr(
                    "OCR: bu native build-də hələ aktiv deyil.",
                    "OCR: в этой нативной сборке пока недоступен.",
                    "OCR is not enabled in this native build yet.",
                ));
            }
            WorkspaceTab::Fonts => {
                ui.heading(self.tr("Şriftlər", "Шрифты", "Fonts"));
                ui.label(self.tr(
                    "PDF mətn qatına yeni mətn MuPDF-in daxil edilmiş şriftləri ilə yazılır.",
                    "Новый текст страницы создаётся с помощью встроенных шрифтов MuPDF.",
                    "New page text is written with MuPDF's embedded fonts.",
                ));
                ui.label("Helvetica · Times-Roman · Courier");
            }
            WorkspaceTab::Settings => {
                ui.heading(self.tr("Parametrlər", "Настройки", "Settings"));
                let language_before = self.language;
                egui::ComboBox::from_label(self.tr("Dil", "Язык", "Language"))
                    .selected_text(self.language.label())
                    .show_ui(ui, |ui| {
                        for language in
                            [Language::Azerbaijani, Language::Russian, Language::English]
                        {
                            ui.selectable_value(&mut self.language, language, language.label());
                        }
                    });
                if self.language != language_before {
                    self.save_preferences();
                }
                ui.label(self.tr(
                    "Sənədlər lokal emal olunur.",
                    "Документы обрабатываются локально.",
                    "Documents are processed locally.",
                ));
                ui.label("MuPDF AGPL-3.0 · egui");
            }
        }
    }

    fn show_main_page(&mut self, ui: &mut egui::Ui, ctx: &Context) {
        if self.document.is_none() {
            ui.vertical_centered(|ui| {
                ui.add_space(80.0);
                ui.heading(self.tr("Super PDF Studio", "Super PDF Studio", "Super PDF Studio"));
                ui.label(self.tr(
                    "Native, oflayn PDF redaktoru",
                    "Нативный офлайн-редактор PDF",
                    "Native offline PDF editor",
                ));
                if ui
                    .button(self.tr("PDF aç", "Открыть PDF", "Open PDF"))
                    .clicked()
                {
                    if let Some(path) = FileDialog::new().add_filter("PDF", &["pdf"]).pick_file() {
                        if let Err(error) = self.open_path(path) {
                            self.set_error(error);
                        }
                    }
                }
                ui.add_space(18.0);
                ui.heading(self.tr("Son sənədlər", "Недавние документы", "Recent documents"));
                let mut open_recent = None;
                for path in self.recent_files.clone() {
                    let label = path
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string();
                    if ui.button(label).clicked() {
                        open_recent = Some(path);
                    }
                }
                if let Some(path) = open_recent {
                    if let Err(error) = self.open_path(path) {
                        self.set_error(error);
                    }
                }
            });
            return;
        }

        if let Err(error) = self.ensure_page_texture(ctx, self.page_index, self.zoom) {
            self.set_error(error);
            return;
        }
        let Some(texture) = self.texture.as_ref() else {
            return;
        };
        let dimensions = texture.size_vec2();
        let available = ui.available_size();
        let fit = (available.x / dimensions.x)
            .min(available.y / dimensions.y)
            .min(1.0);
        let size = dimensions * fit * self.zoom;
        egui::ScrollArea::both()
            .auto_shrink([false, false])
            .show(ui, |ui| {
                ui.centered_and_justified(|ui| {
                    ui.add(
                        egui::Image::new(texture)
                            .fit_to_exact_size(size)
                            .maintain_aspect_ratio(true),
                    );
                });
            });
    }

    fn open_dropped_files(&mut self, ctx: &Context) {
        if let Some(file) = ctx.input(|input| input.raw.dropped_files.first().cloned()) {
            if let Some(path) = file.path.filter(|path| {
                path.extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
            }) {
                if let Err(error) = self.open_path(path) {
                    self.set_error(error);
                }
            }
        }
    }

    fn shortcut_keys(&mut self, ctx: &Context) {
        let (open, save, undo, redo, left, right, zoom_in, zoom_out) = ctx.input(|input| {
            (
                input.modifiers.command && input.key_pressed(egui::Key::O),
                input.modifiers.command && input.key_pressed(egui::Key::S),
                input.modifiers.command && input.key_pressed(egui::Key::Z),
                input.modifiers.command && input.key_pressed(egui::Key::Y),
                input.key_pressed(egui::Key::ArrowLeft),
                input.key_pressed(egui::Key::ArrowRight),
                input.modifiers.command && input.key_pressed(egui::Key::Plus),
                input.modifiers.command && input.key_pressed(egui::Key::Minus),
            )
        });
        if open {
            if let Some(path) = FileDialog::new().add_filter("PDF", &["pdf"]).pick_file() {
                if let Err(error) = self.open_path(path) {
                    self.set_error(error);
                }
            }
        }
        if save && self.document.is_some() {
            if let Err(error) = self.save_as() {
                self.set_error(error);
            }
        }
        if undo {
            if let Err(error) = self.undo() {
                self.set_error(error);
            }
        }
        if redo {
            if let Err(error) = self.redo() {
                self.set_error(error);
            }
        }
        if left && self.page_index > 0 {
            self.go_to_page(self.page_index - 1);
        }
        if right && self.page_index + 1 < self.page_count {
            self.go_to_page(self.page_index + 1);
        }
        if zoom_in {
            self.zoom = (self.zoom * 1.15).clamp(ZOOM_MIN, ZOOM_MAX);
            self.texture = None;
        }
        if zoom_out {
            self.zoom = (self.zoom / 1.15).clamp(ZOOM_MIN, ZOOM_MAX);
            self.texture = None;
        }
    }
}

#[derive(Clone, Copy)]
enum NativeShape {
    Line,
    Rectangle,
    Ellipse,
}

fn replace_pdf_text(
    doc: &mut PdfDocument,
    page_index: usize,
    search_text: &str,
    replacement: &str,
) -> Result<(), String> {
    let mut page = doc
        .load_pdf_page(page_index as i32)
        .map_err(|error| error.to_string())?;
    let hits = page
        .search(search_text, 2)
        .map_err(|error| error.to_string())?;
    if hits.is_empty() {
        return Err("No matching text was found on the selected page.".to_owned());
    }
    if hits.len() != 1 {
        return Err(
            "More than one match was found. Search for a longer, unique phrase.".to_owned(),
        );
    }

    let quad = hits[0].clone();
    let hit_bounds = Rect::from(quad.clone());
    page.add_redact_annotation(&hits[..])
        .map_err(|error| error.to_string())?;
    page.apply_redactions_with_options(PdfRedactOptions {
        black_boxes: false,
        image_method: PdfRedactImageMethod::None,
        line_art: PdfRedactLineArtMethod::None,
        text: PdfRedactTextMethod::Remove,
    })
    .map_err(|error| error.to_string())?;

    if !replacement.is_empty() {
        let text_height = (hit_bounds.y1 - hit_bounds.y0).max(1.0);
        let font_size = (text_height * 0.82).clamp(4.0, 72.0);
        let baseline = Point::new(quad.ul.x, quad.ll.y - (text_height - font_size) / 2.0);
        let options = TextOptions {
            fontsize: font_size,
            fill: Some(PdfColor::rgb(0.08, 0.08, 0.08)),
            ..TextOptions::default()
        };
        let mut shape = Shape::new(&mut page).map_err(|error| error.to_string())?;
        shape
            .insert_text(baseline, replacement, &options)
            .map_err(|error| error.to_string())?;
        shape.commit(doc, true).map_err(|error| error.to_string())?;
    }
    Ok(())
}

impl eframe::App for PdfEditorApp {
    fn update(&mut self, ctx: &Context, _frame: &mut eframe::Frame) {
        self.open_dropped_files(ctx);
        self.shortcut_keys(ctx);

        egui::TopBottomPanel::top("top-panel").show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.heading("Super PDF Studio");
                ui.separator();
                for (tab, title) in [
                    (WorkspaceTab::Edit, self.tr("Redaktə", "Правка", "Edit")),
                    (
                        WorkspaceTab::Pages,
                        self.tr("Səhifələr", "Страницы", "Pages"),
                    ),
                    (
                        WorkspaceTab::Transform,
                        self.tr("Axtarış / OCR", "Поиск / OCR", "Search / OCR"),
                    ),
                    (WorkspaceTab::Fonts, self.tr("Şriftlər", "Шрифты", "Fonts")),
                    (
                        WorkspaceTab::Settings,
                        self.tr("Parametrlər", "Настройки", "Settings"),
                    ),
                ] {
                    if ui.selectable_label(self.tab == tab, title).clicked() {
                        self.tab = tab;
                    }
                }
            });
            self.show_toolbar(ui);
        });

        egui::TopBottomPanel::bottom("status-panel").show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.label(if self.dirty { "●" } else { "●" });
                ui.label(&self.status);
                if let Some(path) = &self.path {
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        ui.label(path.display().to_string());
                    });
                }
            });
        });

        egui::SidePanel::left("pages-panel")
            .resizable(true)
            .default_width(170.0)
            .show(ctx, |ui| {
                self.show_sidebar(ui, ctx);
            });
        egui::SidePanel::right("inspector-panel")
            .resizable(true)
            .default_width(290.0)
            .show(ctx, |ui| {
                egui::ScrollArea::vertical().show(ui, |ui| self.show_inspector(ui));
            });
        egui::CentralPanel::default()
            .frame(
                egui::Frame::new()
                    .fill(egui::Color32::from_rgb(37, 43, 50))
                    .inner_margin(14.0),
            )
            .show(ctx, |ui| {
                self.show_main_page(ui, ctx);
            });

        if let Some(error) = self.last_error.clone() {
            let mut close_error = false;
            egui::Window::new(self.tr("Xəta", "Ошибка", "Error"))
                .collapsible(false)
                .resizable(true)
                .show(ctx, |ui| {
                    ui.label(&error);
                    if ui.button(self.tr("Bağla", "Закрыть", "Close")).clicked() {
                        close_error = true;
                    }
                });
            if close_error {
                self.last_error = None;
            }
        }
    }
}

fn main() -> eframe::Result {
    let open_path = std::env::args_os().nth(1).map(PathBuf::from);
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("Super PDF Studio")
            .with_inner_size([1420.0, 920.0])
            .with_min_inner_size([960.0, 640.0]),
        ..Default::default()
    };
    eframe::run_native(
        "Super PDF Studio",
        options,
        Box::new(move |_creation_context| {
            let mut app = PdfEditorApp::default();
            if let Some(path) = open_path {
                if let Err(error) = app.open_path(path) {
                    app.set_error(error);
                }
            }
            Ok(Box::new(app))
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_pdf(text: &str) -> Vec<u8> {
        let mut document = PdfDocument::new();
        let mut page = document.new_page(mupdf::Size::new(612.0, 792.0)).unwrap();
        let mut shape = Shape::new(&mut page).unwrap();
        shape
            .insert_text(Point::new(48.0, 72.0), text, &TextOptions::default())
            .unwrap();
        shape.commit(&mut document, true).unwrap();
        drop(page);
        let mut bytes = Vec::new();
        document.write_to(&mut bytes).unwrap();
        bytes
    }

    #[test]
    fn replacement_removes_source_and_writes_searchable_pdf_text() {
        let bytes = fixture_pdf("Original searchable title");
        let mut document = PdfDocument::from_bytes(&bytes).unwrap();

        replace_pdf_text(
            &mut document,
            0,
            "Original searchable title",
            "Replacement content",
        )
        .unwrap();

        let page = document.load_pdf_page(0).unwrap();
        assert!(page
            .search("Original searchable title", 2)
            .unwrap()
            .is_empty());
        assert_eq!(page.search("Replacement content", 2).unwrap().len(), 1);
    }

    #[test]
    fn replacement_rejects_non_unique_text_before_modifying_document() {
        let bytes = fixture_pdf("repeat repeat");
        let mut document = PdfDocument::from_bytes(&bytes).unwrap();

        assert!(replace_pdf_text(&mut document, 0, "repeat", "changed").is_err());

        let page = document.load_pdf_page(0).unwrap();
        assert_eq!(page.search("repeat", 3).unwrap().len(), 2);
    }

    #[test]
    fn preferences_round_trip_language_and_recent_paths() {
        let preferences = Preferences {
            language: Language::Russian,
            recent_files: vec![PathBuf::from("/tmp/document.pdf")],
        };

        let encoded = serde_json::to_vec(&preferences).unwrap();
        let decoded: Preferences = serde_json::from_slice(&encoded).unwrap();

        assert_eq!(decoded.language, Language::Russian);
        assert_eq!(decoded.recent_files, preferences.recent_files);
    }
}
