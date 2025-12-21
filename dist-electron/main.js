import { ipcMain as i, screen as x, BrowserWindow as I, desktopCapturer as L, shell as M, app as d, dialog as b, nativeImage as U, Tray as C, Menu as A } from "electron";
import { fileURLToPath as j } from "node:url";
import n from "node:path";
import P from "node:fs/promises";
const R = n.dirname(j(import.meta.url)), z = n.join(R, ".."), w = process.env.VITE_DEV_SERVER_URL, _ = n.join(z, "dist");
let m = null;
i.on("hud-overlay-hide", () => {
  m && !m.isDestroyed() && m.minimize();
});
function B() {
  const s = x.getPrimaryDisplay(), { workArea: t } = s, c = 500, u = 100, v = Math.floor(t.x + (t.width - c) / 2), p = Math.floor(t.y + t.height - u - 5), e = new I({
    width: c,
    height: u,
    minWidth: 500,
    maxWidth: 500,
    minHeight: 100,
    maxHeight: 100,
    x: v,
    y: p,
    frame: !1,
    transparent: !0,
    resizable: !1,
    alwaysOnTop: !0,
    skipTaskbar: !0,
    hasShadow: !1,
    webPreferences: {
      preload: n.join(R, "preload.mjs"),
      nodeIntegration: !1,
      contextIsolation: !0,
      backgroundThrottling: !1
    }
  });
  return e.webContents.on("did-finish-load", () => {
    e == null || e.webContents.send("main-process-message", (/* @__PURE__ */ new Date()).toLocaleString());
  }), m = e, e.on("closed", () => {
    m === e && (m = null);
  }), w ? e.loadURL(w + "?windowType=hud-overlay") : e.loadFile(n.join(_, "index.html"), {
    query: { windowType: "hud-overlay" }
  }), e;
}
function H() {
  const s = process.platform === "darwin", t = new I({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    ...s && {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 12, y: 12 }
    },
    transparent: !1,
    resizable: !0,
    alwaysOnTop: !1,
    skipTaskbar: !1,
    title: "OpenScreenW",
    backgroundColor: "#000000",
    icon: n.join(process.env.VITE_PUBLIC || _, "openscreenw.png"),
    webPreferences: {
      preload: n.join(R, "preload.mjs"),
      nodeIntegration: !1,
      contextIsolation: !0,
      webSecurity: !1,
      backgroundThrottling: !1
    }
  });
  return t.maximize(), t.webContents.on("did-finish-load", () => {
    t == null || t.webContents.send("main-process-message", (/* @__PURE__ */ new Date()).toLocaleString());
  }), w ? t.loadURL(w + "?windowType=editor") : t.loadFile(n.join(_, "index.html"), {
    query: { windowType: "editor" }
  }), t;
}
function q() {
  const { width: s, height: t } = x.getPrimaryDisplay().workAreaSize, c = new I({
    width: 620,
    height: 420,
    minHeight: 350,
    maxHeight: 500,
    x: Math.round((s - 620) / 2),
    y: Math.round((t - 420) / 2),
    frame: !1,
    resizable: !1,
    alwaysOnTop: !0,
    transparent: !0,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: n.join(R, "preload.mjs"),
      nodeIntegration: !1,
      contextIsolation: !0
    }
  });
  return w ? c.loadURL(w + "?windowType=source-selector") : c.loadFile(n.join(_, "index.html"), {
    query: { windowType: "source-selector" }
  }), c;
}
let T = null, S = 0;
function N(s, t, c, u, v) {
  i.handle("get-sources", async (e, a) => (await L.getSources(a)).map((r) => ({
    id: r.id,
    name: r.name,
    display_id: r.display_id,
    thumbnail: r.thumbnail ? r.thumbnail.toDataURL() : null,
    appIcon: r.appIcon ? r.appIcon.toDataURL() : null
  }))), i.handle("select-source", (e, a) => {
    T = a;
    const l = u();
    return l && l.close(), T;
  }), i.handle("get-selected-source", () => T), i.handle("open-source-selector", () => {
    const e = u();
    if (e) {
      e.focus();
      return;
    }
    t();
  }), i.handle("switch-to-editor", () => {
    const e = c();
    e && e.close(), s();
  }), i.handle("select-audio-idx", (e, a) => {
    S = a;
  }), i.handle("get-audio-idx", () => S), i.handle("store-recorded-video", async (e, a, l) => {
    try {
      const r = n.join(f, l);
      return await P.writeFile(r, Buffer.from(a)), p = r, {
        success: !0,
        path: r,
        message: "Video stored successfully"
      };
    } catch (r) {
      return console.error("Failed to store video:", r), {
        success: !1,
        message: "Failed to store video",
        error: String(r)
      };
    }
  }), i.handle("get-recorded-video-path", async () => {
    try {
      const a = (await P.readdir(f)).filter((O) => O.endsWith(".webm"));
      if (a.length === 0)
        return { success: !1, message: "No recorded video found" };
      const l = a.sort().reverse()[0];
      return { success: !0, path: n.join(f, l) };
    } catch (e) {
      return console.error("Failed to get video path:", e), { success: !1, message: "Failed to get video path", error: String(e) };
    }
  }), i.handle("set-recording-state", (e, a) => {
    v && v(a, (T || { name: "Screen" }).name);
  }), i.handle("open-external-url", async (e, a) => {
    try {
      return await M.openExternal(a), { success: !0 };
    } catch (l) {
      return console.error("Failed to open URL:", l), { success: !1, error: String(l) };
    }
  }), i.handle("get-asset-base-path", () => {
    try {
      return d.isPackaged ? n.join(process.resourcesPath, "assets") : n.join(d.getAppPath(), "public", "assets");
    } catch (e) {
      return console.error("Failed to resolve asset base path:", e), null;
    }
  }), i.handle("save-exported-video", async (e, a, l) => {
    try {
      const r = await b.showSaveDialog({
        title: "Save Exported Video",
        defaultPath: n.join(d.getPath("downloads"), l),
        filters: [
          { name: "MP4 Video", extensions: ["mp4"] }
        ],
        properties: ["createDirectory", "showOverwriteConfirmation"]
      });
      return r.canceled || !r.filePath ? {
        success: !1,
        cancelled: !0,
        message: "Export cancelled"
      } : (await P.writeFile(r.filePath, Buffer.from(a)), {
        success: !0,
        path: r.filePath,
        message: "Video exported successfully"
      });
    } catch (r) {
      return console.error("Failed to save exported video:", r), {
        success: !1,
        message: "Failed to save exported video",
        error: String(r)
      };
    }
  }), i.handle("open-video-file-picker", async () => {
    try {
      const e = await b.showOpenDialog({
        title: "选择视频文件",
        defaultPath: f,
        filters: [
          { name: "Video Files", extensions: ["webm", "mp4", "mov", "avi", "mkv"] },
          { name: "All Files", extensions: ["*"] }
        ],
        properties: ["openFile"]
      });
      return e.canceled || e.filePaths.length === 0 ? { success: !1, cancelled: !0 } : {
        success: !0,
        path: e.filePaths[0]
      };
    } catch (e) {
      return console.error("Failed to open file picker:", e), {
        success: !1,
        message: "Failed to open file picker",
        error: String(e)
      };
    }
  });
  let p = null;
  i.handle("set-current-video-path", (e, a) => (p = a, { success: !0 })), i.handle("get-current-video-path", () => p ? { success: !0, path: p } : { success: !1 }), i.handle("clear-current-video-path", () => (p = null, { success: !0 })), i.handle("get-platform", () => process.platform);
}
const $ = n.dirname(j(import.meta.url)), f = n.join(d.getPath("userData"), "recordings");
async function G() {
  try {
    await P.mkdir(f, { recursive: !0 }), console.log("RECORDINGS_DIR:", f), console.log("User Data Path:", d.getPath("userData"));
  } catch (s) {
    console.error("Failed to create recordings directory:", s);
  }
}
process.env.APP_ROOT = n.join($, "..");
const J = process.env.VITE_DEV_SERVER_URL, re = n.join(process.env.APP_ROOT, "dist-electron"), F = n.join(process.env.APP_ROOT, "dist");
process.env.VITE_PUBLIC = J ? n.join(process.env.APP_ROOT, "public") : F;
let o = null, g = null, h = null, V = "";
const W = k("openscreenw.png"), K = k("rec-button.png");
function y() {
  o = B();
}
function D() {
  h = new C(W);
}
function k(s) {
  return U.createFromPath(n.join(process.env.VITE_PUBLIC || F, s)).resize({
    width: 24,
    height: 24,
    quality: "best"
  });
}
function E(s = !1) {
  if (!h) return;
  const t = s ? K : W, c = s ? `录制中: ${V}` : "OpenScreenW", u = s ? [
    {
      label: "停止录制",
      click: () => {
        o && !o.isDestroyed() && o.webContents.send("stop-recording-from-tray");
      }
    }
  ] : [
    {
      label: "打开",
      click: () => {
        o && !o.isDestroyed() ? o.isMinimized() && o.restore() : y();
      }
    },
    {
      label: "退出",
      click: () => {
        d.quit();
      }
    }
  ];
  h.setImage(t), h.setToolTip(c), h.setContextMenu(A.buildFromTemplate(u)), h.on("double-click", () => {
    o && !o.isDestroyed() ? (o.isMinimized() && o.restore(), o.focus()) : y();
  });
}
function Q() {
  o && (o.close(), o = null), o = H(), o.on("close", (s) => {
    s.preventDefault(), b.showMessageBoxSync(o, {
      type: "question",
      buttons: ["取消", "确定"],
      defaultId: 0,
      cancelId: 0,
      title: "确认关闭",
      message: "确定要关闭编辑器吗？未保存内容将丢失。"
    }) === 1 && (o.destroy(), y());
  });
}
function X() {
  return g = q(), g.on("closed", () => {
    g = null;
  }), g;
}
d.on("window-all-closed", () => {
});
d.on("activate", () => {
  I.getAllWindows().length === 0 && y();
});
d.whenReady().then(async () => {
  const { ipcMain: s } = await import("electron");
  s.on("hud-overlay-close", () => {
    d.quit();
  }), D(), E(), await G(), N(
    Q,
    X,
    () => o,
    () => g,
    (t, c) => {
      V = c, h || D(), E(t), t || o && o.restore();
    }
  ), y();
});
export {
  re as MAIN_DIST,
  f as RECORDINGS_DIR,
  F as RENDERER_DIST,
  J as VITE_DEV_SERVER_URL
};
