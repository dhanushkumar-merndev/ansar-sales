// DWG / DXF drawings in the browser (mlightcad's CAD viewer, three.js / WebGL). Loaded only when someone
// opens a drawing: the viewer (~2 MB), the DWG reader (LibreDWG as WebAssembly, ~9 MB, cached after the
// first time) and its workers come from /cad/, copied out of node_modules by scripts/copy-cad-assets.mjs.
// Mouse wheel / pinch zooms, drag pans; the drawing is read-only.

export type CadPoint = { x: number; y: number };
export type CadView = {
  /** Drawing (world) coordinates → pixels inside the container, and back. */
  toScreen: (p: CadPoint) => CadPoint;
  toWorld: (p: CadPoint) => CadPoint;
  /** Called after every pan / zoom / resize; returns the unsubscribe. */
  onChange: (fn: () => void) => () => void;
  fit: () => void;
  /** Canvas colour as 0xRRGGBB; white lines (AutoCAD colour 7) turn dark on a light background. */
  setBackground: (color: number) => void;
  destroy: () => Promise<void>;
};

export const CAD_ASSET_BASE = "/cad/";
let converterRegistered = false;
// The viewer is a singleton (one drawing open at a time): a new one waits until the last one has closed.
let closing: Promise<void> = Promise.resolve();

// Text is laid out in Web Workers. The library starts one per CPU core (up to 4, each with its own copy of
// the fonts) and has no setting for it, so the pool size is read as `textWorkers` while the viewer starts.
// Its main-thread text mode would use less memory but draws "?" for every letter in this version.
// Progressive rendering paints geometry as it's converted; reading the DWG itself is one step.
export type CadOptions = { background: number; progressive?: boolean; textWorkers?: number };

export async function openCad(container: HTMLElement, fileName: string, data: ArrayBuffer, opts: CadOptions): Promise<CadView> {
  const [viewer, model, dwg] = await Promise.all([
    import("@mlightcad/cad-simple-viewer"),
    import("@mlightcad/data-model"),
    import("@mlightcad/libredwg-converter"),
  ]);
  const base = new URL(CAD_ASSET_BASE, window.location.href).href;
  const workers = { dwgParser: base + viewer.LIBREDWG_PARSER_WORKER_FILE, mtextRender: base + viewer.MTEXT_RENDERER_WORKER_FILE };
  if (!converterRegistered) {
    model.AcDbDatabaseConverterManager.instance.register(model.AcDbFileType.DWG,
      new dwg.AcDbLibreDwgConverter({ convertByEntityType: false, useWorker: true, parserWorkerUrl: workers.dwgParser }));
    converterRegistered = true;
  }

  await closing;
  await viewer.AcApDocManager.tryGetInstance()?.destroy();
  Object.defineProperty(navigator, "hardwareConcurrency", { configurable: true, get: () => opts.textWorkers ?? 1 });
  let manager;
  try {
    manager = viewer.AcApDocManager.createInstance({
      container, autoResize: true, webworkerFileUrls: workers, builtinOpenFileDialog: false, disableExport: true,
    });
  } finally {
    delete (navigator as { hardwareConcurrency?: number }).hardwareConcurrency; // back to the real value
  }
  if (!manager) throw new Error("cad_viewer_unavailable");
  const ok = await manager.openDocument(fileName, data, { mode: viewer.AcEdOpenMode.Read, progressiveRendering: opts.progressive ?? true });
  if (!ok) {
    closing = manager.destroy().catch(() => {});
    await closing;
    throw new Error("cad_open_failed");
  }
  const view = manager.mainView;
  view.mode = viewer.AcEdViewMode.PAN; // left-drag pans (the default would box-select)
  view.backgroundColor = opts.background;

  // Keep the whole drawing in view while the frame changes size (the panel sliding open, Expand / back),
  // until the person zooms or moves it themselves; "Fit" goes back to that.
  let moved = false;
  const touched = () => { moved = true; };
  container.addEventListener("wheel", touched, { passive: true });
  container.addEventListener("pointerdown", touched);
  let fitTimer = 0;
  const refit = () => {
    window.clearTimeout(fitTimer);
    fitTimer = window.setTimeout(() => { if (!moved) void view.zoomToSmartExtents(); }, 120);
  };
  view.events.viewResize.addEventListener(refit);
  refit();
  return {
    toScreen: (p) => { const s = view.worldToScreen(p); return { x: s.x, y: s.y }; },
    toWorld: (p) => { const w = view.screenToWorld(p); return { x: w.x, y: w.y }; },
    onChange: (fn) => {
      view.events.viewChanged.addEventListener(fn);
      view.events.viewResize.addEventListener(fn);
      return () => { view.events.viewChanged.removeEventListener(fn); view.events.viewResize.removeEventListener(fn); };
    },
    fit: () => { moved = false; void view.zoomToSmartExtents(); },
    setBackground: (color) => { view.backgroundColor = color; },
    destroy: () => {
      window.clearTimeout(fitTimer);
      view.events.viewResize.removeEventListener(refit);
      container.removeEventListener("wheel", touched);
      container.removeEventListener("pointerdown", touched);
      closing = closing.then(() => manager.destroy()).catch(() => {});
      return closing;
    },
  };
}
