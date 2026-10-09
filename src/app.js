import './styles.css';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as fabric from 'fabric';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { getLocale, setLocale, t, translateDocument } from './locales.js';
import { clearRecentPdfs, getRecentPdfs, removeRecentPdf, saveRecentPdf } from './recent-files.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const $ = (id) => document.getElementById(id);
const dom = {
  open: $('open-file-btn'),
  emptyOpen: $('empty-open-btn'),
  addPages: $('add-pages-btn'),
  file: $('file-input'),
  mergeFiles: $('merge-input'),
  image: $('image-input'),
  font: $('font-input'),
  stage: $('page-stage'),
  emptyState: $('empty-state'),
  shell: $('canvas-shell'),
  base: $('base-canvas'),
  searchCanvas: $('search-canvas'),
  overlay: $('overlay-canvas'),
  thumbnails: $('thumbnail-list'),
  pageCount: $('page-count'),
  docName: $('document-name'),
  pageSize: $('page-size'),
  zoom: $('zoom-label'),
  status: $('status-message'),
  toast: $('toast'),
  ocr: $('ocr-output'),
  ocrStatus: $('ocr-status'),
  objectText: $('object-text'),
  objectFont: $('object-font'),
  objectSize: $('object-size'),
  objectColor: $('object-color'),
  objectOpacity: $('object-opacity'),
  opacityLabel: $('opacity-label'),
  selectionType: $('selection-type')
};

const state = {
  pdf: null,
  bytes: null,
  documentName: '',
  recentId: null,
  pageIds: [],
  currentPage: 0,
  zoom: 1,
  overlay: null,
  overlays: new Map(),
  histories: new Map(),
  customFonts: [],
  customFontBytes: new Map(),
  renderTask: null,
  renderId: 0,
  suppressHistory: false,
  historyTimer: null,
  toastTimer: null,
  ocrWorker: null,
  thumbObserver: null,
  thumbs: new Map(),
  thumbLru: [],
  thumbQueue: [],
  thumbQueued: new Set(),
  thumbRenderCount: 0,
  thumbGeneration: 0,
  dragPageId: null,
  searchToken: 0,
  searchResults: [],
  searchHits: [],
  spaceHeld: false,
  panPoint: null
};

const HISTORY_LIMIT = 35;
const THUMB_CACHE_LIMIT = 18;
const nativeAvailable = isTauri();
const clamp = (number, min, max) => Math.min(max, Math.max(min, number));
const activePageId = () => state.pageIds[state.currentPage - 1];
const localePageLabel = (number) => t(`Page ${number}`);

function setStatus(message) {
  dom.status.textContent = t(message);
}

function notify(message, kind = 'success') {
  clearTimeout(state.toastTimer);
  dom.toast.textContent = t(message);
  dom.toast.className = `toast visible ${kind}`;
  state.toastTimer = setTimeout(() => dom.toast.classList.remove('visible'), 3300);
}

function runAction(action) {
  return async (...args) => {
    try {
      await action(...args);
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`${t('Could not complete action')} · ${message}`);
      notify(message, 'error');
    }
  };
}

function updatePageControls() {
  const hasDocument = Boolean(state.pdf);
  const pages = hasDocument ? state.pdf.numPages : 0;
  dom.pageCount.textContent = String(pages);
  $('page-total').textContent = `${t('of')} ${pages}`;
  $('page-jump').value = String(hasDocument ? state.currentPage : 0);
  $('page-jump').max = String(pages);
  $('page-jump').disabled = !hasDocument;
  $('prev-page-btn').disabled = !hasDocument || state.currentPage <= 1;
  $('next-page-btn').disabled = !hasDocument || state.currentPage >= pages;
  dom.zoom.textContent = `${Math.round(state.zoom * 100)}%`;
  dom.docName.textContent = state.documentName || 'No document open';
  for (const id of ['save-btn', 'rotate-page-btn', 'delete-page-btn', 'ocr-btn']) {
    $(id).disabled = !hasDocument;
  }
  $('zoom-in-btn').disabled = !hasDocument;
  $('zoom-out-btn').disabled = !hasDocument;
  $('split-btn').disabled = !hasDocument;
  $('compress-btn').disabled = !hasDocument;
  $('duplicate-page-btn').disabled = !hasDocument;
  $('insert-page-btn').disabled = !hasDocument;
  for (const id of ['add-line-btn', 'add-ellipse-btn', 'add-note-btn', 'add-signature-btn', 'page-number-btn', 'copy-text-btn']) {
    $(id).disabled = !hasDocument;
  }
  for (const button of document.querySelectorAll('.annotation-tool')) button.disabled = !hasDocument;
  for (const id of ['add-text-btn', 'add-rect-btn', 'add-image-btn', 'add-watermark-btn']) {
    $(id).disabled = !hasDocument;
  }
  $('replace-original-text-btn').disabled = !hasDocument || !nativeAvailable;
  $('ocr-add-text-btn').disabled = !hasDocument || !dom.ocr.value.trim();
}

function setCurrentDocumentName(name) {
  state.documentName = name;
  dom.docName.textContent = name;
  dom.docName.title = name;
}

function createPageIds(count) {
  return Array.from({ length: count }, () => crypto.randomUUID());
}

function overlayJson() {
  return state.overlay ? state.overlay.toJSON() : { version: '6.0.0', objects: [] };
}

function saveCurrentOverlay() {
  if (!state.overlay || !activePageId()) return;
  state.overlays.set(activePageId(), {
    json: overlayJson(),
    width: state.overlay.getWidth(),
    height: state.overlay.getHeight()
  });
}

function historyForPage(id) {
  if (!state.histories.has(id)) {
    const data = state.overlays.get(id) || { json: { version: '6.0.0', objects: [] }, width: 1, height: 1 };
    state.histories.set(id, { undo: [structuredClone(data.json)], redo: [] });
  }
  return state.histories.get(id);
}

function refreshHistoryButtons() {
  const history = activePageId() ? historyForPage(activePageId()) : null;
  $('undo-btn').disabled = !history || history.undo.length < 2;
  $('redo-btn').disabled = !history || history.redo.length === 0;
}

function recordHistory() {
  if (state.suppressHistory || !state.overlay || !activePageId()) return;
  saveCurrentOverlay();
  const history = historyForPage(activePageId());
  history.undo.push(structuredClone(overlayJson()));
  if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
  history.redo.length = 0;
  refreshHistoryButtons();
}

function scheduleTextHistory() {
  clearTimeout(state.historyTimer);
  state.historyTimer = setTimeout(recordHistory, 450);
}

function resizeStoredObjects(json, oldWidth, oldHeight, newWidth, newHeight) {
  const scaleX = newWidth / oldWidth;
  const scaleY = newHeight / oldHeight;
  for (const object of json.objects || []) {
    object.left = (object.left || 0) * scaleX;
    object.top = (object.top || 0) * scaleY;
    object.scaleX = (object.scaleX ?? 1) * scaleX;
    object.scaleY = (object.scaleY ?? 1) * scaleY;
  }
  return json;
}

function updateInspector() {
  const object = state.overlay?.getActiveObject();
  const selected = Boolean(object);
  const singleObject = selected && object.type !== 'activeselection';
  dom.selectionType.textContent = selected ? (object.type || 'OBJECT').toUpperCase() : 'PAGE';
  $('object-text').disabled = !singleObject;
  $('object-font').disabled = !singleObject;
  $('object-size').disabled = !singleObject;
  $('object-color').disabled = !selected;
  $('object-opacity').disabled = !selected;
  $('delete-object-btn').disabled = !selected;
  $('layer-back-btn').disabled = !singleObject;
  $('layer-front-btn').disabled = !singleObject;
  document.querySelectorAll('[data-align]').forEach((button) => { button.disabled = !selected; });
  if (!selected) {
    dom.objectText.value = '';
    return;
  }
  const isText = singleObject && (object.type === 'textbox' || object.type === 'i-text' || object.type === 'text');
  dom.objectText.disabled = !isText;
  dom.objectFont.disabled = !isText;
  dom.objectSize.disabled = !isText;
  dom.objectText.value = isText ? object.text || '' : '';
  if (isText) {
    const font = object.fontFamily || 'Georgia';
    if (![...dom.objectFont.options].some((option) => option.value === font)) {
      dom.objectFont.add(new Option(font, font));
    }
    dom.objectFont.value = font;
    dom.objectSize.value = String(Math.round(object.fontSize || 24));
  }
  const fill = typeof object.fill === 'string' ? object.fill : '#24313a';
  if (/^#[0-9a-f]{6}$/i.test(fill)) dom.objectColor.value = fill;
  dom.objectOpacity.value = String(Math.round((object.opacity ?? 1) * 100));
  dom.opacityLabel.value = `${dom.objectOpacity.value}%`;
}

function attachOverlayEvents(canvas) {
  const changed = () => {
    updateInspector();
    recordHistory();
  };
  canvas.on('object:added', changed);
  canvas.on('object:modified', changed);
  canvas.on('object:removed', changed);
  canvas.on('text:changed', () => {
    updateInspector();
    saveCurrentOverlay();
    scheduleTextHistory();
  });
  canvas.on('selection:created', updateInspector);
  canvas.on('selection:updated', updateInspector);
  canvas.on('selection:cleared', updateInspector);
}

async function disposeOverlay() {
  if (!state.overlay) return;
  saveCurrentOverlay();
  const old = state.overlay;
  state.overlay = null;
  await old.dispose();
}

async function renderPage() {
  if (!state.pdf) return;
  const renderId = ++state.renderId;
  if (state.renderTask) {
    state.renderTask.cancel();
    state.renderTask = null;
  }
  await disposeOverlay();
  const page = await state.pdf.getPage(state.currentPage);
  if (renderId !== state.renderId) return;
  const viewport = page.getViewport({ scale: state.zoom });
  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);
  dom.base.width = width;
  dom.base.height = height;
  dom.base.style.width = `${width}px`;
  dom.base.style.height = `${height}px`;
  dom.overlay.width = width;
  dom.overlay.height = height;
  dom.searchCanvas.width = width;
  dom.searchCanvas.height = height;
  dom.searchCanvas.style.width = `${width}px`;
  dom.searchCanvas.style.height = `${height}px`;
  dom.stage.style.width = `${width}px`;
  dom.stage.style.height = `${height}px`;
  dom.stage.hidden = false;
  dom.emptyState.hidden = true;
  dom.pageSize.textContent = `${Math.round(page.view[2] - page.view[0])} × ${Math.round(page.view[3] - page.view[1])} pt`;

  const context = dom.base.getContext('2d', { alpha: false });
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  state.renderTask = page.render({ canvasContext: context, viewport });
  try {
    await state.renderTask.promise;
  } catch (error) {
    if (error?.name !== 'RenderingCancelledException') throw error;
  }
  if (renderId !== state.renderId) return;
  state.renderTask = null;
  drawSearchHits(viewport);

  const canvas = new fabric.Canvas(dom.overlay, {
    width,
    height,
    enableRetinaScaling: false,
    preserveObjectStacking: true,
    selection: true,
    backgroundColor: 'rgba(0,0,0,0)'
  });
  state.overlay = canvas;
  const id = activePageId();
  const saved = state.overlays.get(id);
  if (saved?.json?.objects?.length) {
    let json = structuredClone(saved.json);
    json = resizeStoredObjects(json, saved.width || width, saved.height || height, width, height);
    state.suppressHistory = true;
    try {
      await canvas.loadFromJSON(json);
    } finally {
      state.suppressHistory = false;
    }

  }
  attachOverlayEvents(canvas);
  canvas.requestRenderAll();
  state.overlays.set(id, { json: overlayJson(), width, height });
  const history = historyForPage(id);
  if (!history.undo.length) history.undo.push(structuredClone(overlayJson()));
  updatePageControls();
  updateInspector();
  refreshHistoryButtons();
  setStatus(`Page ${state.currentPage} ready · local workspace`);
  updateSelectedThumbnail();
}

function drawSearchHits(viewport) {
  const context = dom.searchCanvas.getContext('2d');
  context.clearRect(0, 0, dom.searchCanvas.width, dom.searchCanvas.height);
  const pageHits = state.searchHits.filter((hit) => hit.page === state.currentPage);
  if (!pageHits.length) return;
  context.save();
  context.fillStyle = 'rgba(235, 202, 68, 0.38)';
  context.strokeStyle = 'rgba(192, 151, 17, 0.85)';
  context.lineWidth = 1;
  for (const hit of pageHits) {
    const transform = pdfjsLib.Util.transform(viewport.transform, hit.transform);
    const height = Math.max(5, Math.hypot(transform[2], transform[3]));
    const x = transform[4];
    const y = transform[5] - height;
    const width = Math.max(10, hit.width * viewport.scale);
    context.fillRect(x, y, width, height);
    context.strokeRect(x, y, width, height);
  }
  context.restore();
}

async function loadPdfBytes(bytes, name) {
  state.searchToken += 1;
  state.searchHits = [];
  state.renderId += 1;
  if (state.renderTask) {
    state.renderTask.cancel();
    state.renderTask = null;
  }
  if (state.pdf) {
    await disposeOverlay();
    await state.pdf.destroy();
  }
  state.bytes = new Uint8Array(bytes);
  state.pdf = await pdfjsLib.getDocument({ data: state.bytes.slice() }).promise;
  state.pageIds = createPageIds(state.pdf.numPages);
  state.currentPage = 1;
  state.zoom = 1;
  state.overlays.clear();
  state.histories.clear();
  state.thumbs.clear();
  state.thumbLru = [];
  setCurrentDocumentName(name);
  dom.ocr.value = '';
  dom.ocrStatus.textContent = t('Local English OCR · current page');
  await renderPage();
  await renderThumbnails();
  updatePageControls();
}

async function openPdf(file) {
  if (!file || file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    throw new Error('Choose a PDF file.');
  }
  setStatus(`Opening ${file.name}…`);
  const bytes = await file.arrayBuffer();
  await loadPdfBytes(bytes, file.name);
  const id = `${file.name}:${file.size}:${file.lastModified}`;
  state.recentId = id;
  void rememberPdf({ id, name: file.name, bytes: state.bytes, openedAt: Date.now() });
  notify(`${file.name} opened locally`);
}

async function rememberPdf(record) {
  try {
    await saveRecentPdf(record);
    await renderRecentPdfs();
  } catch (error) {
    console.error('Could not persist PDF in local history:', error);
    notify(t('Could not save PDF history. The PDF is still open.'), 'error');
    try {
      await renderRecentPdfs();
    } catch (refreshError) {
      console.error('Could not refresh local PDF history:', refreshError);
    }
  }
}

function formatRecentDate(timestamp) {
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' })
    .format(new Date(timestamp));
}

async function renderRecentPdfs() {
  const list = $('recent-list');
  const dialogList = $('recent-dialog-list');
  const clearButton = $('clear-recent-btn');
  const records = await getRecentPdfs();
  list.replaceChildren();
  dialogList.replaceChildren();
  clearButton.hidden = records.length === 0;
  $('clear-recent-dialog-btn').hidden = records.length === 0;
  if (!records.length) {
    const empty = document.createElement('span');
    empty.className = 'recent-empty';
    empty.textContent = t('PDFs you open will appear here.');
    list.append(empty);
    dialogList.append(empty.cloneNode(true));
    return;
  }

  const fragments = [document.createDocumentFragment(), document.createDocumentFragment()];
  for (const record of records) {
    const item = document.createElement('div');
    item.className = 'recent-item';
    const openButton = document.createElement('button');
    openButton.className = 'recent-open';
    openButton.type = 'button';
    openButton.dataset.recentId = record.id;
    const name = document.createElement('strong');
    name.textContent = record.name;
    const details = document.createElement('span');
    details.textContent = `${formatRecentDate(record.openedAt)} · ${formatFileSize(record.size)}`;
    openButton.append(name, details);
    const removeButton = document.createElement('button');
    removeButton.className = 'recent-remove';
    removeButton.type = 'button';
    removeButton.dataset.removeRecentId = record.id;
    removeButton.setAttribute('aria-label', `${t('Remove')} ${record.name}`);
    removeButton.title = t('Remove from history');
    removeButton.textContent = '×';
    item.append(openButton, removeButton);
    fragments[0].append(item);
    fragments[1].append(item.cloneNode(true));
  }
  list.append(fragments[0]);
  dialogList.append(fragments[1]);
}

function formatFileSize(size) {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

async function openRecentPdf(id) {
  const records = await getRecentPdfs();
  const record = records.find((item) => item.id === id);
  if (!record) {
    await renderRecentPdfs();
    throw new Error('This PDF is no longer in local history.');
  }
  setStatus(`Opening ${record.name}…`);
  await loadPdfBytes(record.bytes, record.name);
  state.recentId = record.id;
  void rememberPdf({ ...record, bytes: state.bytes, openedAt: Date.now() });
  notify(`${record.name} opened locally`);
}

async function persistCurrentRecentPdf() {
  if (!state.recentId || !state.bytes) return;
  const records = await getRecentPdfs();
  const record = records.find((item) => item.id === state.recentId);
  if (!record) return;
  await rememberPdf({ ...record, bytes: state.bytes, openedAt: Date.now() });
}

function updateSelectedThumbnail() {
  document.querySelectorAll('.thumb-item').forEach((item) => {
    const selected = item.dataset.pageId === activePageId();
    item.classList.toggle('selected', selected);
    if (selected) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
}

function touchThumbnail(pageNumber) {
  const previous = state.thumbLru.indexOf(pageNumber);
  if (previous >= 0) state.thumbLru.splice(previous, 1);
  state.thumbLru.push(pageNumber);
  while (state.thumbLru.length > THUMB_CACHE_LIMIT) {
    const expired = state.thumbLru.shift();
    const oldCanvas = state.thumbs.get(expired);
    if (oldCanvas) {
      oldCanvas.width = 0;
      oldCanvas.height = 0;
      oldCanvas.remove();
      state.thumbs.delete(expired);
    }
  }
}

async function renderThumbnail(pageNumber, container, generation) {
  const pdf = state.pdf;
  if (!pdf || generation !== state.thumbGeneration) return;
  if (state.thumbs.has(pageNumber)) {
    container.replaceChildren(state.thumbs.get(pageNumber));
    touchThumbnail(pageNumber);
    return;
  }
  const page = await pdf.getPage(pageNumber);
  if (generation !== state.thumbGeneration || state.pdf !== pdf) return;
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(174 / baseViewport.width, 225 / baseViewport.height);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  canvas.setAttribute('aria-hidden', 'true');
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  if (generation !== state.thumbGeneration || state.pdf !== pdf || !container.isConnected) {
    canvas.width = 0;
    canvas.height = 0;
    return;
  }
  container.replaceChildren(canvas);
  state.thumbs.set(pageNumber, canvas);
  touchThumbnail(pageNumber);
}

function processThumbnailQueue() {
  while (state.thumbRenderCount < 2 && state.thumbQueue.length) {
    const task = state.thumbQueue.shift();
    state.thumbQueued.delete(`${task.generation}:${task.pageNumber}`);
    if (task.generation !== state.thumbGeneration) continue;
    state.thumbRenderCount += 1;
    renderThumbnail(task.pageNumber, task.container, task.generation)
      .catch((error) => {
        if (task.generation !== state.thumbGeneration) return;
        console.error(error);
        task.container.textContent = t('Preview unavailable');
      })
      .finally(() => {
        state.thumbRenderCount -= 1;
        processThumbnailQueue();
      });
  }
}

async function renderThumbnails() {
  state.thumbGeneration += 1;
  const generation = state.thumbGeneration;
  state.thumbQueue.length = 0;
  state.thumbQueued.clear();
  for (const canvas of state.thumbs.values()) {
    canvas.width = 0;
    canvas.height = 0;
    canvas.remove();
  }
  state.thumbs.clear();
  state.thumbLru.length = 0;
  if (state.thumbObserver) state.thumbObserver.disconnect();
  dom.thumbnails.replaceChildren();
  if (!state.pdf) {
    dom.thumbnails.innerHTML = '<div class="empty-pages"><span class="empty-icon" aria-hidden="true">▧</span><span>Open a PDF to see its pages</span></div>';
    return;
  }
  state.thumbObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const number = Number(entry.target.dataset.pageNumber);
        const preview = entry.target.querySelector('.thumb-preview');
        const key = `${generation}:${number}`;
        if (state.thumbs.has(number) || state.thumbQueued.has(key)) continue;
        state.thumbQueued.add(key);
        state.thumbQueue.push({ pageNumber: number, container: preview, generation });
        processThumbnailQueue();
      }
    }
  }, { root: dom.thumbnails, rootMargin: '150px 0px' });

  const fragment = document.createDocumentFragment();
  for (let index = 0; index < state.pageIds.length; index += 1) {
    const id = state.pageIds[index];
    const number = index + 1;
    const item = document.createElement('article');
    item.className = 'thumb-item';
    item.draggable = true;
    item.dataset.pageId = id;
    item.dataset.pageNumber = String(number);
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.setAttribute('aria-label', `Go to page ${number}`);
    const preview = document.createElement('div');
    preview.className = 'thumb-preview';
    const label = document.createElement('div');
    label.className = 'thumb-page-number';
    const pageLabel = localePageLabel(number);
    label.innerHTML = `<b>${pageLabel}</b><span>↕</span>`;
    item.append(preview, label);
    item.addEventListener('click', runAction(async () => {
      const pageNumber = state.pageIds.indexOf(id) + 1;
      if (pageNumber > 0 && pageNumber !== state.currentPage) {
        saveCurrentOverlay();
        state.currentPage = pageNumber;
        await renderPage();
      }
    }));
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        item.click();
      }
    });
    item.addEventListener('dragstart', (event) => {
      state.dragPageId = id;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', id);
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => {
      state.dragPageId = null;
      item.classList.remove('dragging');
      document.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
    });
    item.addEventListener('dragover', (event) => {
      event.preventDefault();
      item.classList.add('drop-target');
    });
    item.addEventListener('dragleave', () => item.classList.remove('drop-target'));
    item.addEventListener('drop', runAction(async (event) => {
      event.preventDefault();
      item.classList.remove('drop-target');
      const fromId = state.dragPageId || event.dataTransfer.getData('text/plain');
      const fromIndex = state.pageIds.indexOf(fromId);
      const toIndex = state.pageIds.indexOf(id);
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
      await reorderPages(fromIndex, toIndex);
    }));
    fragment.append(item);
    state.thumbObserver.observe(item);
    if ((index + 1) % 100 === 0) {
      dom.thumbnails.append(fragment);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  dom.thumbnails.append(fragment);
  updateSelectedThumbnail();
}

async function reorderPages(fromIndex, toIndex) {
  saveCurrentOverlay();
  const ids = [...state.pageIds];
  const [moved] = ids.splice(fromIndex, 1);
  ids.splice(toIndex, 0, moved);
  const source = await PDFDocument.load(state.bytes);
  const ordered = await PDFDocument.create();
  const pages = await ordered.copyPages(source, ids.map((id) => state.pageIds.indexOf(id)));
  pages.forEach((page) => ordered.addPage(page));
  const bytes = await ordered.save({ useObjectStreams: true });
  const selectedId = activePageId();
  const previousOverlays = new Map(state.overlays);
  const previousHistories = new Map(state.histories);
  await loadPdfBytes(bytes, state.documentName);
  state.pageIds = ids;
  state.currentPage = ids.indexOf(selectedId) + 1;
  state.overlays = previousOverlays;
  state.histories = previousHistories;
  await renderPage();
  await renderThumbnails();
  await persistCurrentRecentPdf();
  notify('Page order updated');
}

async function updatePdf(mutator, successMessage, { removeCurrent = false } = {}) {
  saveCurrentOverlay();
  state.renderId += 1;
  if (state.renderTask) {
    state.renderTask.cancel();
    state.renderTask = null;
  }
  await disposeOverlay();
  const selectedId = activePageId();
  const pdf = await PDFDocument.load(state.bytes);
  await mutator(pdf);
  const bytes = await pdf.save({ useObjectStreams: true });
  const nextIds = removeCurrent ? state.pageIds.filter((id) => id !== selectedId) : [...state.pageIds];
  const name = state.documentName;
  const previousOverlays = new Map(state.overlays);
  const previousHistories = new Map(state.histories);
  if (state.pdf) await state.pdf.destroy();
  state.bytes = bytes;
  state.pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  if (removeCurrent) {
    state.pageIds = nextIds;
    state.currentPage = Math.min(state.currentPage, state.pdf.numPages);
  } else {
    state.pageIds = [...state.pageIds];
  }
  state.overlays = previousOverlays;
  state.histories = previousHistories;
  if (removeCurrent) {
    state.overlays.delete(selectedId);
    state.histories.delete(selectedId);
  }
  setCurrentDocumentName(name);
  await renderPage();
  await renderThumbnails();
  await persistCurrentRecentPdf();
  notify(successMessage);
}

async function reloadPdfKeepingAnnotations(bytes, successMessage) {
  saveCurrentOverlay();
  state.renderId += 1;
  if (state.renderTask) {
    state.renderTask.cancel();
    state.renderTask = null;
  }
  const pageId = activePageId();
  const overlays = new Map(state.overlays);
  const histories = new Map(state.histories);
  const nextPdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  await disposeOverlay();
  await state.pdf.destroy();
  state.bytes = bytes;
  state.pdf = nextPdf;
  state.pageIds = [...state.pageIds];
  state.currentPage = state.pageIds.indexOf(pageId) + 1;
  state.overlays = overlays;
  state.histories = histories;
  await renderPage();
  await renderThumbnails();
  await persistCurrentRecentPdf();
  notify(successMessage);
}

async function deleteCurrentPage() {
  if (!state.pdf || state.pdf.numPages < 2) {
    notify('A PDF must contain at least one page.', 'error');
    return;
  }
  if (!window.confirm(`Delete page ${state.currentPage}? This change can be undone only by reopening the original file.`)) return;
  await updatePdf((pdf) => pdf.removePage(state.currentPage - 1), 'Page deleted', { removeCurrent: true });
}

async function rotateCurrentPage() {
  if (!state.pdf) return;
  const index = state.currentPage - 1;
  if (state.overlay) {
    const oldHeight = state.overlay.getHeight();
    for (const object of state.overlay.getObjects()) {
      const center = object.getCenterPoint();
      object.set({ angle: ((object.angle || 0) + 90) % 360 });
      object.setPositionByOrigin(new fabric.Point(oldHeight - center.y, center.x), 'center', 'center');
      object.setCoords();
    }
    state.overlay.requestRenderAll();
    saveCurrentOverlay();
    recordHistory();
  }
  await updatePdf((pdf) => {
    const page = pdf.getPage(index);
    const rotation = ((page.getRotation().angle + 90) % 360 + 360) % 360;
    page.setRotation(degrees(rotation));
  }, 'Page rotated 90°');
}

function addObject(type, textValue) {
  if (!state.overlay) return;
  const canvas = state.overlay;
  const centerX = canvas.getWidth() / 2;
  const centerY = canvas.getHeight() / 2;
  let object;
  if (type === 'text') {
    object = new fabric.Textbox(textValue || 'Edit text', {
      left: centerX - 115, top: centerY - 20, width: 230, fontSize: 24,
      fontFamily: state.customFonts[0] || 'Georgia', fill: '#27313a',
      backgroundColor: 'rgba(255,255,255,0.72)', padding: 8,
      editable: true, cornerColor: '#dbf276', borderColor: '#91a54e'
    });
  } else if (type === 'rect') {
    object = new fabric.Rect({
      left: centerX - 80, top: centerY - 45, width: 160, height: 90,
      fill: 'rgba(219,242,118,0.3)', stroke: '#a7c653', strokeWidth: 2,
      rx: 7, ry: 7, cornerColor: '#dbf276'
    });
  } else if (type === 'watermark') {
    object = new fabric.Textbox(textValue || 'CONFIDENTIAL', {
      left: centerX - 150, top: centerY - 25, width: 300, angle: -28,
      fontSize: 38, fontWeight: 700, fontFamily: 'Segoe UI',
      fill: 'rgba(76,87,94,0.28)', textAlign: 'center'
    });
  }
  if (!object) return;
  canvas.add(object);
  canvas.setActiveObject(object);
  if (type === 'text') {
    object.enterEditing();
    object.selectAll();
  }
  canvas.requestRenderAll();
  updateInspector();
}

function dataUrlToBytes(dataUrl) {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function makeOverlayPng(data, targetWidth, targetHeight) {
  if (!data?.json?.objects?.length) return null;
  const canvasElement = document.createElement('canvas');
  const exportCanvas = new fabric.StaticCanvas(canvasElement, {
    width: targetWidth, height: targetHeight, enableRetinaScaling: false,
    backgroundColor: 'rgba(0,0,0,0)'
  });
  const json = structuredClone(data.json);
  resizeStoredObjects(json, data.width || targetWidth, data.height || targetHeight, targetWidth, targetHeight);
  await exportCanvas.loadFromJSON(json);
  exportCanvas.renderAll();
  const png = dataUrlToBytes(exportCanvas.toDataURL({ format: 'png', multiplier: 1 }));
  await exportCanvas.dispose();
  return png;
}

async function createExportBytes(compress = false) {
  saveCurrentOverlay();
  const pdf = await PDFDocument.load(state.bytes);
  for (let index = 0; index < pdf.getPageCount(); index += 1) {
    const data = state.overlays.get(state.pageIds[index]);
    if (!data?.json?.objects?.length) continue;
    const page = pdf.getPage(index);
    const { width, height } = page.getSize();
    const rotation = ((page.getRotation().angle % 360) + 360) % 360;
    const quarterTurn = rotation === 90 || rotation === 270;
    const overlayWidth = quarterTurn ? height : width;
    const overlayHeight = quarterTurn ? width : height;
    const scale = 2;
    const png = await makeOverlayPng(data, Math.ceil(overlayWidth * scale), Math.ceil(overlayHeight * scale));
    if (png) {
      const image = await pdf.embedPng(png);
      page.drawImage(image, {
        x: (width - overlayWidth) / 2,
        y: (height - overlayHeight) / 2,
        width: overlayWidth,
        height: overlayHeight,
        rotate: degrees(-rotation)
      });
    }
  }
  return pdf.save({ useObjectStreams: true, objectsPerTick: compress ? 40 : 100 });
}

function downloadPdf(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function exportPdf() {
  if (!state.pdf) throw new Error('Open a PDF before exporting.');
  setStatus('Preparing edited PDF…');
  const bytes = await createExportBytes();
  const basename = state.documentName.replace(/\.pdf$/i, '');
  downloadPdf(bytes, `${basename}-edited.pdf`);
  setStatus('Export complete · saved locally');
  notify('Edited PDF exported');
}

async function compressPdf() {
  if (!state.pdf) throw new Error('Open a PDF before exporting.');
  setStatus('Rewriting PDF structure…');
  const bytes = await createExportBytes(true);
  const basename = state.documentName.replace(/\.pdf$/i, '');
  downloadPdf(bytes, `${basename}-optimized.pdf`);
  setStatus('PDF structure optimized · image data was not recompressed');
  notify('Optimized PDF exported (lossless structure rewrite)');
}

function bytesOfFile(file) {
  return file.arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

async function mergePdfs(files) {
  const sources = [];
  if (state.bytes) sources.push({ bytes: await createExportBytes(), name: state.documentName });
  for (const file of files) {
    if (file.type && file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      throw new Error(`${file.name} is not a PDF.`);
    }
    sources.push({ bytes: await bytesOfFile(file), name: file.name });
  }
  if (sources.length < 2) throw new Error('Choose at least two PDFs, or open a PDF and select another.');
  const combined = await PDFDocument.create();
  for (const source of sources) {
    const document = await PDFDocument.load(source.bytes);
    const pages = await combined.copyPages(document, document.getPageIndices());
    pages.forEach((page) => combined.addPage(page));
  }
  const bytes = await combined.save({ useObjectStreams: true });
  const name = `${sources[0].name.replace(/\.pdf$/i, '')}-merged.pdf`;
  await loadPdfBytes(bytes, name);
  notify(`${sources.length} PDFs merged`);
}

async function splitCurrentPage() {
  if (!state.pdf) throw new Error('Open a PDF before splitting.');
  const source = await PDFDocument.load(await createExportBytes());
  const result = await PDFDocument.create();
  const [page] = await result.copyPages(source, [state.currentPage - 1]);
  result.addPage(page);
  downloadPdf(await result.save({ useObjectStreams: true }), `page-${state.currentPage}.pdf`);
  notify(`Page ${state.currentPage} exported`);
}

function highlightSnippet(text, query) {
  const snippet = document.createElement('span');
  const index = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) {
    snippet.textContent = text;
    return snippet;
  }
  snippet.append(document.createTextNode(text.slice(0, index)));
  const mark = document.createElement('mark');
  mark.textContent = text.slice(index, index + query.length);
  snippet.append(mark, document.createTextNode(text.slice(index + query.length)));
  return snippet;
}

async function searchDocument(query) {
  const needle = query.trim();
  if (!state.pdf || !needle) return;
  const token = ++state.searchToken;
  const results = [];
  $('search-results').replaceChildren();
  $('search-progress').textContent = 'Searching page 1…';
  $('search-form').querySelector('button[type="submit"]').disabled = true;
  try {
    for (let pageNumber = 1; pageNumber <= state.pdf.numPages; pageNumber += 1) {
      if (token !== state.searchToken) return;
      $('search-progress').textContent = `Searching page ${pageNumber} of ${state.pdf.numPages}…`;
      const page = await state.pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!('str' in item) || !item.str) continue;
        const lower = item.str.toLocaleLowerCase();
        let offset = 0;
        while ((offset = lower.indexOf(needle.toLocaleLowerCase(), offset)) >= 0) {
          results.push({
            page: pageNumber,
            text: item.str.trim(),
            transform: [...item.transform],
            width: item.width,
            height: item.height
          });
          offset += Math.max(1, needle.length);
        }
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    if (token !== state.searchToken) return;
    state.searchResults = results;
    if (!results.length) {
      $('search-progress').textContent = t('No matches found.');
      $('search-results').textContent = t('No match found. If this is a scan, run local OCR page by page.');
      return;
    }
    $('search-progress').textContent = `${results.length} match${results.length === 1 ? '' : 'es'} across the document`;
    const fragment = document.createDocumentFragment();
    results.forEach((result, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'search-result';
      button.innerHTML = `<strong><span>${localePageLabel(result.page)}</span><span>${index + 1} / ${results.length}</span></strong>`;
      button.append(highlightSnippet(result.text, needle));
      button.addEventListener('click', runAction(async () => {
        saveCurrentOverlay();
        state.currentPage = result.page;
        state.searchHits = results.filter((entry) => entry.page === result.page);
        $('search-dialog').close();
        await renderPage();
        const thumb = document.querySelector(`.thumb-item[data-page-number="${result.page}"]`);
        thumb?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }));
      fragment.append(button);
    });
    $('search-results').replaceChildren(fragment);
  } finally {
    if (token === state.searchToken) $('search-form').querySelector('button[type="submit"]').disabled = false;
  }
}

function openSearch() {
  if (!state.pdf) {
    notify('Open a PDF before searching.', 'error');
    return;
  }
  state.searchHits = [];
  dom.searchCanvas.getContext('2d').clearRect(0, 0, dom.searchCanvas.width, dom.searchCanvas.height);
  $('search-dialog').showModal();
  $('search-input').focus();
  $('search-input').select();
}

function setDrawingTool(tool) {
  if (!state.overlay) {
    notify('Open a PDF before annotating.', 'error');
    return;
  }
  const canvas = state.overlay;
  const button = document.querySelector(`.annotation-tool[data-draw="${tool}"]`);
  const alreadyActive = button?.classList.contains('active');
  document.querySelectorAll('.annotation-tool').forEach((item) => item.classList.remove('active'));
  if (alreadyActive) {
    canvas.isDrawingMode = false;
    $('stop-draw-btn').hidden = true;
    setStatus('Select mode · ready');
    return;
  }
  const brush = new fabric.PencilBrush(canvas);
  if (tool === 'highlight') {
    brush.color = 'rgba(241, 208, 66, 0.42)';
    brush.width = 18;
  } else {
    brush.color = dom.objectColor.value || '#d8ed78';
    brush.width = 3;
  }
  canvas.freeDrawingBrush = brush;
  canvas.isDrawingMode = true;
  button?.classList.add('active');
  $('stop-draw-btn').hidden = false;
  setStatus(`${tool === 'pen' ? 'Pen' : 'Highlighter'} active · Esc to finish`);
}

function stopDrawing() {
  if (state.overlay) state.overlay.isDrawingMode = false;
  document.querySelectorAll('.annotation-tool').forEach((item) => item.classList.remove('active'));
  $('stop-draw-btn').hidden = true;
  if (state.pdf) setStatus(`Page ${state.currentPage} ready · local workspace`);
}

function addPageObject(type) {
  if (!state.overlay) return;
  const canvas = state.overlay;
  const x = canvas.getWidth() / 2;
  const y = canvas.getHeight() / 2;
  let object;
  if (type === 'line') {
    object = new fabric.Line([x - 95, y, x + 95, y], {
      stroke: dom.objectColor.value || '#d8ed78', strokeWidth: 3,
      cornerColor: '#dbf276', selectable: true
    });
  } else if (type === 'ellipse') {
    object = new fabric.Ellipse({
      left: x - 75, top: y - 43, rx: 75, ry: 43,
      fill: 'rgba(219,242,118,0.12)', stroke: '#c5e568', strokeWidth: 3
    });
  } else if (type === 'note') {
    object = new fabric.Textbox('Note: double-click to edit', {
      left: x - 105, top: y - 42, width: 210, minWidth: 150, fontSize: 16,
      fontFamily: 'Segoe UI', fill: '#373322', backgroundColor: '#fff0a8',
      padding: 13, shadow: new fabric.Shadow({ color: 'rgba(0,0,0,0.18)', blur: 8, offsetX: 1, offsetY: 3 }),
      cornerColor: '#dbf276', borderColor: '#a89548'
    });
  } else if (type === 'signature') {
    const signature = $('signature-input').value.trim();
    if (!signature) {
      $('signature-dialog').showModal();
      $('signature-input').focus();
      return;
    }
    object = new fabric.Textbox(signature, {
      left: x - 115, top: y - 20, width: 230, fontSize: 31, fontStyle: 'italic',
      fontFamily: 'Segoe Script, Brush Script MT, cursive', fill: '#233e64',
      underline: true
    });
  }
  if (!object) return;
  canvas.add(object);
  canvas.setActiveObject(object);
  canvas.requestRenderAll();
  updateInspector();
}

async function addPageNumber() {
  if (!state.overlay || !state.pdf) return;
  const label = `${state.currentPage} / ${state.pdf.numPages}`;
  const object = new fabric.Text(label, {
    left: Math.max(10, state.overlay.getWidth() - 75),
    top: state.overlay.getHeight() - 42, fontSize: 12,
    fontFamily: 'Segoe UI', fill: '#626c72',
    backgroundColor: 'rgba(255,255,255,0.7)', padding: 4
  });
  state.overlay.add(object);
  state.overlay.setActiveObject(object);
  state.overlay.requestRenderAll();
  updateInspector();
}

async function copyPageText() {
  if (!state.pdf) throw new Error('Open a PDF to copy page text.');
  const page = await state.pdf.getPage(state.currentPage);
  const content = await page.getTextContent();
  const text = content.items
    .filter((item) => 'str' in item)
    .map((item) => `${item.str}${item.hasEOL ? '\n' : ' '}`)
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  if (!text) throw new Error('This page has no text layer. Run OCR to read a scanned page.');
  await navigator.clipboard.writeText(text);
  notify('Page text copied to clipboard');
}

async function insertPage({ duplicate = false } = {}) {
  if (!state.pdf || !state.bytes) throw new Error('Open a PDF before adding a page.');
  saveCurrentOverlay();
  const selectedId = activePageId();
  const previousOverlays = new Map(state.overlays);
  const previousHistories = new Map(state.histories);
  const pdf = await PDFDocument.load(state.bytes);
  const insertionIndex = state.currentPage;
  let newId;
  if (duplicate) {
    const source = await PDFDocument.load(state.bytes);
    const [copy] = await pdf.copyPages(source, [state.currentPage - 1]);
    pdf.insertPage(insertionIndex, copy);
    newId = crypto.randomUUID();
    const sourceId = state.pageIds[state.currentPage - 1];
    const sourceData = previousOverlays.get(sourceId);
    if (sourceData) {
      const cloned = structuredClone(sourceData);
      previousOverlays.set(newId, cloned);
      const oldHistory = previousHistories.get(sourceId);
      previousHistories.set(newId, oldHistory
        ? { undo: structuredClone(oldHistory.undo), redo: [] }
        : { undo: [structuredClone(sourceData.json)], redo: [] });
    }
  } else {
    pdf.insertPage(insertionIndex, [612, 792]);
    newId = crypto.randomUUID();
  }
  const bytes = await pdf.save({ useObjectStreams: true });
  const ids = [...state.pageIds];
  ids.splice(insertionIndex, 0, newId);
  const name = state.documentName;
  state.renderId += 1;
  if (state.renderTask) {
    state.renderTask.cancel();
    state.renderTask = null;
  }
  await disposeOverlay();
  await state.pdf.destroy();
  state.bytes = bytes;
  state.pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  state.pageIds = ids;
  state.currentPage = ids.indexOf(newId) + 1;
  state.overlays = previousOverlays;
  state.histories = previousHistories;
  state.thumbs.clear();
  state.thumbLru = [];
  setCurrentDocumentName(name);
  await renderPage();
  await renderThumbnails();
  await persistCurrentRecentPdf();
  notify(duplicate ? 'Page duplicated' : 'Blank page inserted');
}

async function runOcr() {
  if (!state.pdf) throw new Error('Open a PDF before running OCR.');
  $('ocr-btn').disabled = true;
  dom.ocrStatus.textContent = t('Loading local OCR engine…');
  dom.ocr.value = '';
  try {
    if (!state.ocrWorker) {
      const { default: Tesseract } = await import('tesseract.js');
      state.ocrWorker = await Tesseract.createWorker('eng', 1, {
        workerPath: `${import.meta.env.BASE_URL}ocr/worker.min.js`,
        corePath: `${import.meta.env.BASE_URL}ocr`,
        langPath: `${import.meta.env.BASE_URL}ocr/tessdata`,
        workerBlobURL: false,
        cacheMethod: 'none',
        logger: (progress) => {
          if (progress.status === 'recognizing text') {
            dom.ocrStatus.textContent = `${t('Recognizing')} · ${Math.round(progress.progress * 100)}%`;
          }
        }
      });
    }
    const result = await state.ocrWorker.recognize(dom.base);
    dom.ocr.value = result.data.text.trim();
    dom.ocrStatus.textContent = result.data.text.trim() ? 'OCR complete · processed on this device' : 'No text detected on this page.';
    $('ocr-add-text-btn').disabled = !result.data.text.trim();
    notify('OCR finished locally');
  } catch (error) {
    dom.ocrStatus.textContent = t('OCR could not complete.');
    throw error;
  } finally {
    $('ocr-btn').disabled = !state.pdf;
    updatePageControls();
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Could not read image.'));
    reader.readAsDataURL(file);
  });
}

async function addImage(file) {
  if (!state.overlay) throw new Error('Open a PDF before adding an image.');
  const source = await fileToDataUrl(file);
  const image = await fabric.Image.fromURL(source);
  image.scaleToWidth(Math.min(190, state.overlay.getWidth() * 0.42));
  image.set({ left: 50, top: 50, cornerColor: '#dbf276', borderColor: '#91a54e' });
  state.overlay.add(image);
  state.overlay.setActiveObject(image);
  state.overlay.requestRenderAll();
  updateInspector();
}

async function importFont(file) {
  if (!file) return;
  const name = file.name.replace(/\.(ttf|otf)$/i, '').replace(/[^a-zA-Z0-9 _-]/g, '').trim();
  if (!name) throw new Error('The font file needs a valid filename.');
  const bytes = await file.arrayBuffer();
  const face = new FontFace(name, bytes);
  await face.load();
  document.fonts.add(face);
  if (!state.customFonts.includes(name)) state.customFonts.push(name);
  state.customFontBytes.set(name, new Uint8Array(bytes));
  if (![...dom.objectFont.options].some((option) => option.value === name)) {
    dom.objectFont.add(new Option(name, name));
  }
  if (![...$('replace-font').options].some((option) => option.value === name)) {
    $('replace-font').add(new Option(name, name));
  }
  const chip = document.createElement('span');
  chip.textContent = name;
  chip.style.fontFamily = name;
  $('font-list').append(chip);
  notify(`${name} loaded for this session`);
}

function encodeBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function visibleRectToPdfRect(rect, crop, rotation) {
  const corners = [
    [rect.x0, rect.y0], [rect.x1, rect.y0],
    [rect.x0, rect.y1], [rect.x1, rect.y1]
  ];
  const points = corners.map(([x, y]) => {
    switch (rotation) {
      case 90: return [crop.x + y, crop.y + x];
      case 180: return [crop.x + crop.width - x, crop.y + y];
      case 270: return [crop.x + crop.width - y, crop.y + crop.height - x];
      default: return [crop.x + x, crop.y + crop.height - y];
    }
  });
  return {
    x0: Math.min(...points.map(([x]) => x)),
    y0: Math.min(...points.map(([, y]) => y)),
    x1: Math.max(...points.map(([x]) => x)),
    y1: Math.max(...points.map(([, y]) => y))
  };
}

async function replaceOriginalPdfText() {
  if (!state.pdf || !state.bytes) throw new Error('Open a PDF before replacing text.');
  if (!nativeAvailable) throw new Error('Original PDF text replacement is available in the Tauri desktop app.');

  const searchText = $('replace-source-text').value.trim();
  const replacement = $('replace-with-text').value;
  const sourceBytes = state.bytes;
  const sourceRecentId = state.recentId;
  const pageIndex = state.currentPage - 1;
  if (!searchText) throw new Error('Enter the exact text to find on the current page.');
  if (/[\r\n]/.test(replacement)) throw new Error('Use a single line for replacement text.');
  if (!window.confirm('MuPDF will permanently remove this matching text from the in-memory PDF. You can export the edited copy; the original file is not overwritten. Continue?')) return;

  $('replace-original-text-btn').disabled = true;
  setStatus('MuPDF is locating and removing the original text…');
  try {
    const result = await invoke('redact_pdf_text', {
      pdfBase64: encodeBase64(sourceBytes),
      pageIndex,
      searchText
    });
    if (state.bytes !== sourceBytes || state.recentId !== sourceRecentId) {
      throw new Error('The open PDF changed while MuPDF was processing it. The replacement was discarded; retry on the current document.');
    }
    const pdf = await PDFDocument.load(decodeBase64(result.redactedPdfBase64));
    const page = pdf.getPage(pageIndex);
    const crop = page.getCropBox();
    const rotation = ((page.getRotation().angle % 360) + 360) % 360;
    const target = visibleRectToPdfRect(result.rect, crop, rotation);
    const visibleWidth = result.rect.x1 - result.rect.x0;
    const visibleHeight = result.rect.y1 - result.rect.y0;
    if (visibleWidth <= 0 || visibleHeight <= 0) {
      throw new Error('MuPDF returned invalid bounds for the matched text.');
    }

    if (replacement.length > 0) {
      const fontName = $('replace-font').value;
      let font;
      if (fontName === 'Helvetica') {
        font = await pdf.embedFont(StandardFonts.Helvetica);
      } else {
        const fontBytes = state.customFontBytes.get(fontName);
        if (!fontBytes) throw new Error('Import the selected TTF/OTF font again before replacing text.');
        pdf.registerFontkit(fontkit);
        font = await pdf.embedFont(fontBytes, { subset: true });
      }
      let fontSize = Math.min(visibleHeight * 0.82, 36);
      const widthAtSize = font.widthOfTextAtSize(replacement, fontSize);
      if (widthAtSize > visibleWidth) fontSize *= visibleWidth / widthAtSize;
      if (fontSize < 4) throw new Error('Replacement text is too long for the matched area; use a shorter replacement.');

      const textWidth = font.widthOfTextAtSize(replacement, fontSize);
      const textHeight = font.heightAtSize(fontSize);
      const centerX = (target.x0 + target.x1) / 2;
      const centerY = (target.y0 + target.y1) / 2;
      const radians = rotation * Math.PI / 180;
      const localCorners = [[0, 0], [textWidth, 0], [0, textHeight], [textWidth, textHeight]];
      const rotated = localCorners.map(([x, y]) => [
        x * Math.cos(radians) - y * Math.sin(radians),
        x * Math.sin(radians) + y * Math.cos(radians)
      ]);
      const offsetX = (Math.min(...rotated.map(([x]) => x)) + Math.max(...rotated.map(([x]) => x))) / 2;
      const offsetY = (Math.min(...rotated.map(([, y]) => y)) + Math.max(...rotated.map(([, y]) => y))) / 2;
      const color = $('replace-color').value.match(/[0-9a-f]{2}/gi).map((part) => parseInt(part, 16) / 255);
      page.drawText(replacement, {
        x: centerX - offsetX,
        y: centerY - offsetY,
        size: fontSize,
        font,
        color: rgb(...color),
        rotate: degrees(rotation)
      });
    }

    const bytes = new Uint8Array(await pdf.save({ useObjectStreams: true }));
    $('replace-source-text').value = '';
    $('replace-with-text').value = '';
    setStatus('Original PDF text replaced · editable page content');
    await reloadPdfKeepingAnnotations(bytes, 'Original PDF text replaced');
  } finally {
    updatePageControls();
  }
}

async function undo() {
  if (!state.overlay || !activePageId()) return;
  const history = historyForPage(activePageId());
  if (history.undo.length < 2) return;
  history.redo.push(history.undo.pop());
  state.suppressHistory = true;
  try {
    await state.overlay.loadFromJSON(structuredClone(history.undo.at(-1)));
  } finally {
    state.suppressHistory = false;
  }
  state.overlay.requestRenderAll();
  saveCurrentOverlay();
  updateInspector();
  refreshHistoryButtons();
}

async function redo() {
  if (!state.overlay || !activePageId()) return;
  const history = historyForPage(activePageId());
  const next = history.redo.pop();
  if (!next) return;
  history.undo.push(next);
  state.suppressHistory = true;
  try {
    await state.overlay.loadFromJSON(structuredClone(next));
  } finally {
    state.suppressHistory = false;
  }
  state.overlay.requestRenderAll();
  saveCurrentOverlay();
  updateInspector();
  refreshHistoryButtons();
}

function updateObject(change) {
  const object = state.overlay?.getActiveObject();
  if (!object) return;
  object.set(change);
  object.setCoords();
  state.overlay.requestRenderAll();
  saveCurrentOverlay();
  updateInspector();
}

function deleteSelection() {
  if (!state.overlay) return;
  const active = state.overlay.getActiveObject();
  if (!active) return;
  if (active.type === 'activeselection') {
    active.forEachObject((object) => state.overlay.remove(object));
  } else {
    state.overlay.remove(active);
  }
  state.overlay.discardActiveObject();
  state.overlay.requestRenderAll();
  updateInspector();
}

function navigatePage(direction) {
  if (!state.pdf) return;
  const nextPage = clamp(state.currentPage + direction, 1, state.pdf.numPages);
  if (nextPage === state.currentPage) return;
  saveCurrentOverlay();
  state.currentPage = nextPage;
  runAction(renderPage)();
}

function changeZoom(delta) {
  if (!state.pdf) return;
  state.zoom = clamp(state.zoom + delta, 0.5, 2.5);
  runAction(renderPage)();
}

function bindObjectInspector() {
  dom.objectText.addEventListener('input', () => updateObject({ text: dom.objectText.value }));
  dom.objectText.addEventListener('change', recordHistory);
  dom.objectFont.addEventListener('change', () => {
    updateObject({ fontFamily: dom.objectFont.value });
    recordHistory();
  });
  dom.objectSize.addEventListener('change', () => {
    updateObject({ fontSize: clamp(Number(dom.objectSize.value) || 24, 6, 144) });
    recordHistory();
  });
  dom.objectColor.addEventListener('input', () => updateObject({ fill: dom.objectColor.value }));
  dom.objectColor.addEventListener('change', recordHistory);
  dom.objectOpacity.addEventListener('input', () => {
    const value = Number(dom.objectOpacity.value);
    dom.opacityLabel.value = `${value}%`;
    updateObject({ opacity: value / 100 });
  });
  dom.objectOpacity.addEventListener('change', recordHistory);
  document.querySelectorAll('[data-align]').forEach((button) => {
    button.addEventListener('click', () => {
      updateObject({ textAlign: button.dataset.align });
      recordHistory();
    });
  });
}

dom.open.addEventListener('click', () => dom.file.click());
dom.emptyOpen.addEventListener('click', () => dom.file.click());
dom.addPages.addEventListener('click', () => dom.mergeFiles.click());
dom.file.addEventListener('change', runAction(async () => {
  const file = dom.file.files?.[0];
  if (file) await openPdf(file);
  dom.file.value = '';
}));
dom.mergeFiles.addEventListener('change', runAction(async () => {
  const files = [...(dom.mergeFiles.files || [])];
  if (files.length) await mergePdfs(files);
  dom.mergeFiles.value = '';
}));
dom.image.addEventListener('change', runAction(async () => {
  const file = dom.image.files?.[0];
  if (file) await addImage(file);
  dom.image.value = '';
}));
dom.font.addEventListener('change', runAction(async () => {
  const file = dom.font.files?.[0];
  if (file) await importFont(file);
  dom.font.value = '';
}));

$('prev-page-btn')?.addEventListener('click', runAction(async () => {
  if (state.currentPage <= 1) return;
  saveCurrentOverlay();
  state.currentPage -= 1;
  await renderPage();
}));
$('next-page-btn')?.addEventListener('click', runAction(async () => {
  if (!state.pdf || state.currentPage >= state.pdf.numPages) return;
  saveCurrentOverlay();
  state.currentPage += 1;
  await renderPage();
}));
document.addEventListener('keydown', (event) => {
  const modifier = event.ctrlKey || event.metaKey;
  const targetIsEditable = event.target instanceof HTMLElement &&
    event.target.closest('input, textarea, select, [contenteditable="true"]');
  const targetIsInDialog = event.target instanceof HTMLElement && event.target.closest('dialog');
  const targetIsInteractive = event.target instanceof HTMLElement &&
    event.target.closest('button, a, [role="button"], summary');
  const activeObject = state.overlay?.getActiveObject();
  const editingCanvasText = activeObject?.isEditing;
  if (event.code === 'Space' && !targetIsEditable && !targetIsInteractive && !editingCanvasText) {
    state.spaceHeld = true;
    if (state.pdf) event.preventDefault();
    return;
  }
  if (targetIsEditable || targetIsInDialog) return;
  if (event.key === '?' || (event.shiftKey && event.key === '/')) {
    event.preventDefault();
    $('shortcuts-dialog').showModal();
    return;
  }
  if (modifier && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    dom.file.click();
    return;
  }
  if (modifier && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    openSearch();
    return;
  }
  if (editingCanvasText) return;
  if (modifier && event.key.toLowerCase() === 's') {
    event.preventDefault();
    runAction(exportPdf)();
  } else if (modifier && event.key.toLowerCase() === 'z' && event.shiftKey) {
    event.preventDefault();
    runAction(redo)();
  } else if (modifier && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    runAction(undo)();
  } else if (modifier && event.key.toLowerCase() === 'y') {
    event.preventDefault();
    runAction(redo)();
  } else if (modifier && (event.key === '+' || event.key === '=')) {
    event.preventDefault();
    changeZoom(0.15);
  } else if (modifier && event.key === '-') {
    event.preventDefault();
    changeZoom(-0.15);
  } else if (modifier && event.key === '0') {
    event.preventDefault();
    if (state.pdf) {
      state.zoom = 1;
      runAction(renderPage)();
    }
  } else if (event.altKey && event.key === 'ArrowLeft') {
    event.preventDefault();
    navigatePage(-1);
  } else if (event.altKey && event.key === 'ArrowRight') {
    event.preventDefault();
    navigatePage(1);
  } else if (event.key === 'PageUp') {
    event.preventDefault();
    navigatePage(-1);
  } else if (event.key === 'PageDown') {
    event.preventDefault();
    navigatePage(1);
  } else if (event.key === 'Home' && modifier && state.pdf) {
    event.preventDefault();
    navigatePage(1 - state.currentPage);
  } else if (event.key === 'End' && modifier && state.pdf) {
    event.preventDefault();
    navigatePage(state.pdf.numPages - state.currentPage);
  } else if (!modifier && !event.altKey && event.key.toLowerCase() === 'p' && state.overlay) {
    setDrawingTool('pen');
  } else if (!modifier && !event.altKey && event.key.toLowerCase() === 'h' && state.overlay) {
    setDrawingTool('highlight');
  } else if (event.key === 'Delete' && activeObject) {
    deleteSelection();
  } else if (event.key === 'Escape' && state.overlay?.isDrawingMode) {
    stopDrawing();
  } else if (event.key === 'Escape' && state.overlay?.getActiveObject()) {
    state.overlay.discardActiveObject();
    state.overlay.requestRenderAll();
  } else if (modifier && event.key.toLowerCase() === 'a' && state.overlay?.getObjects().length) {
    event.preventDefault();
    state.overlay.discardActiveObject();
    state.overlay.setActiveObject(new fabric.ActiveSelection(state.overlay.getObjects(), { canvas: state.overlay }));
    state.overlay.requestRenderAll();
  } else if (!modifier && !event.altKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key) && activeObject && !state.overlay?.isDrawingMode) {
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    const move = {
      ArrowUp: { top: (activeObject.top || 0) - step },
      ArrowDown: { top: (activeObject.top || 0) + step },
      ArrowLeft: { left: (activeObject.left || 0) - step },
      ArrowRight: { left: (activeObject.left || 0) + step }
    }[event.key];
    activeObject.set(move);
    activeObject.setCoords();
    state.overlay.requestRenderAll();
    saveCurrentOverlay();
    scheduleTextHistory();
  }
});
document.addEventListener('keyup', (event) => {
  if (event.code === 'Space') {
    state.spaceHeld = false;
    state.panPoint = null;
    dom.shell.classList.remove('panning');
  }
});
window.addEventListener('blur', () => {
  state.spaceHeld = false;
  state.panPoint = null;
  dom.shell.classList.remove('panning');
});
dom.shell.addEventListener('pointerdown', (event) => {
  if (event.button !== 1 && !state.spaceHeld) return;
  event.preventDefault();
  state.panPoint = { x: event.clientX, y: event.clientY, left: dom.shell.scrollLeft, top: dom.shell.scrollTop };
  dom.shell.classList.add('panning');
  dom.shell.setPointerCapture(event.pointerId);
});
dom.shell.addEventListener('pointermove', (event) => {
  if (!state.panPoint) return;
  dom.shell.scrollLeft = state.panPoint.left - (event.clientX - state.panPoint.x);
  dom.shell.scrollTop = state.panPoint.top - (event.clientY - state.panPoint.y);
});
dom.shell.addEventListener('pointerup', () => {
  state.panPoint = null;
  dom.shell.classList.remove('panning');
});
dom.shell.addEventListener('wheel', (event) => {
  if (!event.ctrlKey || !state.pdf) return;
  event.preventDefault();
  changeZoom(event.deltaY < 0 ? 0.1 : -0.1);
}, { passive: false });

$('zoom-in-btn').addEventListener('click', runAction(async () => {
  if (!state.pdf) return;
  state.zoom = clamp(state.zoom + 0.15, 0.5, 2.5);
  await renderPage();
}));
$('zoom-out-btn').addEventListener('click', runAction(async () => {
  if (!state.pdf) return;
  state.zoom = clamp(state.zoom - 0.15, 0.5, 2.5);
  await renderPage();
}));
$('add-text-btn').addEventListener('click', runAction(() => addObject('text')));
$('add-rect-btn').addEventListener('click', runAction(() => addObject('rect')));
$('add-watermark-btn').addEventListener('click', runAction(() => addObject('watermark')));
$('add-line-btn').addEventListener('click', runAction(() => addPageObject('line')));
$('add-ellipse-btn').addEventListener('click', runAction(() => addPageObject('ellipse')));
$('add-note-btn').addEventListener('click', runAction(() => addPageObject('note')));
$('add-signature-btn').addEventListener('click', runAction(() => {
  if (!state.pdf) throw new Error('Open a PDF before adding a signature.');
  $('signature-dialog').showModal();
  $('signature-input').focus();
}));
$('signature-input').addEventListener('input', () => {
  $('signature-preview').textContent = $('signature-input').value || 'Your signature';
});
$('signature-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = $('signature-input').value.trim();
  if (!value) return;
  $('signature-dialog').close();
  runAction(() => addPageObject('signature'))();
});
$('close-signature-btn').addEventListener('click', () => $('signature-dialog').close());
$('page-number-btn').addEventListener('click', runAction(addPageNumber));
$('copy-text-btn').addEventListener('click', runAction(copyPageText));
$('stop-draw-btn').addEventListener('click', stopDrawing);
$('duplicate-page-btn').addEventListener('click', runAction(() => insertPage({ duplicate: true })));
$('insert-page-btn').addEventListener('click', runAction(() => insertPage()));
$('search-btn').addEventListener('click', openSearch);
$('search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  runAction(() => searchDocument($('search-input').value))();
});
$('close-search-btn').addEventListener('click', () => {
  state.searchToken += 1;
  $('search-dialog').close();
});
document.querySelectorAll('.annotation-tool').forEach((button) => {
  button.addEventListener('click', () => setDrawingTool(button.dataset.draw));
});
$('page-jump').addEventListener('change', runAction(async () => {
  const page = Number($('page-jump').value);
  if (!state.pdf || !Number.isInteger(page) || page < 1 || page > state.pdf.numPages) {
    updatePageControls();
    throw new Error(`Enter a page from 1 to ${state.pdf?.numPages || 0}.`);
  }
  if (page === state.currentPage) return;
  saveCurrentOverlay();
  state.currentPage = page;
  await renderPage();
}));
$('add-image-btn').addEventListener('click', () => dom.image.click());
$('import-font-btn').addEventListener('click', () => dom.font.click());
$('save-btn').addEventListener('click', runAction(exportPdf));
$('replace-original-text-btn').addEventListener('click', runAction(replaceOriginalPdfText));
$('split-btn')?.addEventListener('click', runAction(splitCurrentPage));
$('compress-btn').addEventListener('click', runAction(compressPdf));
$('rotate-page-btn').addEventListener('click', runAction(rotateCurrentPage));
$('delete-page-btn').addEventListener('click', runAction(deleteCurrentPage));
$('ocr-btn').addEventListener('click', runAction(runOcr));
$('ocr-add-text-btn').addEventListener('click', runAction(() => {
  const text = dom.ocr.value.trim();
  if (!text) throw new Error('Run OCR or enter recognized text before adding it.');
  addObject('text', text);
}));
$('undo-btn').addEventListener('click', runAction(undo));
$('redo-btn').addEventListener('click', runAction(redo));
$('delete-object-btn').addEventListener('click', () => {
  deleteSelection();
});
$('layer-back-btn').addEventListener('click', () => {
  if (!state.overlay) return;
  state.overlay.sendBackwards(state.overlay.getActiveObject());
  state.overlay.requestRenderAll();
  recordHistory();
});
$('layer-front-btn').addEventListener('click', () => {
  if (!state.overlay) return;
  state.overlay.bringForward(state.overlay.getActiveObject());
  state.overlay.requestRenderAll();
  recordHistory();
});
bindObjectInspector();
$('shortcuts-btn').addEventListener('click', () => $('shortcuts-dialog').showModal());

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === tab));
    const targets = {
      edit: [dom.shell, state.pdf ? $('add-text-btn') : dom.open],
      pages: [dom.thumbnails, dom.thumbnails],
      ocr: [document.querySelector('.ocr-section'), $('ocr-btn')],
      fonts: [$('font-manager'), $('import-font-btn')],
      settings: [document.querySelector('.header-actions'), $('language-select')]
    };
    const [region, control] = targets[tab.dataset.tab];
    region?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    control?.focus({ preventScroll: true });
  });
});

$('theme-btn').addEventListener('click', () => {
  document.body.classList.toggle('light-theme');
  const isLight = document.body.classList.contains('light-theme');
  $('theme-btn').textContent = t(isLight ? 'Dark mode' : 'Light mode');
  setStatus(`${t('Appearance')} · ${t(isLight ? 'light' : 'dark')}`);
});

$('language-select').addEventListener('change', (event) => {
  setLocale(event.target.value);
  const isLight = document.body.classList.contains('light-theme');
  $('theme-btn').textContent = t(isLight ? 'Dark mode' : 'Light mode');
  setStatus('Ready · files never leave your device');
  renderRecentPdfs().catch((error) => {
    console.error('Could not refresh local PDF history:', error);
    notify(error.message, 'error');
  });
});

async function handleRecentListClick(event) {
  const removeButton = event.target.closest('[data-remove-recent-id]');
  if (removeButton) {
    await removeRecentPdf(removeButton.dataset.removeRecentId);
    await renderRecentPdfs();
    return;
  }
  const openButton = event.target.closest('[data-recent-id]');
  if (openButton) {
    if ($('recent-dialog').open) $('recent-dialog').close();
    await openRecentPdf(openButton.dataset.recentId);
  }
}

$('recent-list').addEventListener('click', runAction(handleRecentListClick));
$('recent-dialog-list').addEventListener('click', runAction(handleRecentListClick));

$('recent-btn').addEventListener('click', runAction(async () => {
  await renderRecentPdfs();
  $('recent-dialog').showModal();
}));
$('close-recent-btn').addEventListener('click', () => $('recent-dialog').close());

async function clearHistory() {
  await clearRecentPdfs();
  state.recentId = null;
  await renderRecentPdfs();
  notify('PDF history cleared');
}

$('clear-recent-btn').addEventListener('click', runAction(clearHistory));
$('clear-recent-dialog-btn').addEventListener('click', runAction(clearHistory));

dom.shell.addEventListener('dragover', (event) => {
  event.preventDefault();
  dom.shell.classList.add('drag-overlay');
});
dom.shell.addEventListener('dragleave', (event) => {
  if (!dom.shell.contains(event.relatedTarget)) dom.shell.classList.remove('drag-overlay');
});
dom.shell.addEventListener('drop', runAction(async (event) => {
  event.preventDefault();
  dom.shell.classList.remove('drag-overlay');
  const file = [...(event.dataTransfer?.files || [])].find((item) =>
    item.type === 'application/pdf' || item.name.toLowerCase().endsWith('.pdf'));
  if (file) await openPdf(file);
}));

window.addEventListener('beforeunload', () => {
  if (state.ocrWorker) state.ocrWorker.terminate();
});

updatePageControls();
refreshHistoryButtons();
translateDocument();
setLocale(getLocale());
renderRecentPdfs().catch((error) => {
  console.error('Could not load local PDF history:', error);
  notify(error.message, 'error');
});
