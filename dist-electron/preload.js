"use strict";
const {
  contextBridge: d,
  ipcRenderer: o,
  clipboard: i,
  shell: a,
} = require("electron");

const completedTasksInSession = new Set();

const checkLimit = async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
        const userStr = localStorage.getItem("currentUser") || localStorage.getItem("user") || localStorage.getItem("session");
        if (!userStr) return true;
        const parsed = JSON.parse(userStr);
        let email = parsed.email || parsed.username || parsed.id;
        if (!email && parsed.user) {
            email = parsed.user.email || parsed.user.username || parsed.user.id;
        }
        if (!email) return true;

        const res = await fetch(`https://tainguyenweb.com/apiveo/limit.php?action=get_stats&email=${encodeURIComponent(email)}`, {
            signal: controller.signal,
        });
        const data = await res.json();

        if (data.status === 'limit_reached' || (data.status === 'success' && typeof data.remaining === 'number' && data.remaining <= 0)) {
            window.dispatchEvent(new CustomEvent("veo-show-limit-alert"));
            return false;
        }
    } catch(e) {
    } finally {
        clearTimeout(timeout);
    }
    return true;
};

const logGeneration = async () => {
    console.log("[Preload] Gửi log_generation theo luồng hoàn thành...");
    try {
        const userStr = localStorage.getItem("currentUser") || localStorage.getItem("user") || localStorage.getItem("session");
        if (!userStr) return;
        const parsed = JSON.parse(userStr);
        let email = parsed.email || parsed.username || parsed.id;
        if (!email && parsed.user) {
            email = parsed.user.email || parsed.user.username || parsed.user.id;
        }
        if (!email) return;

        console.log("[Preload] Gửi log_generation cho tài khoản:", email);
        fetch(`https://tainguyenweb.com/apiveo/limit.php?action=log_generation`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `email=${encodeURIComponent(email)}`
        }).then(res => res.json()).then((data) => {
            window.dispatchEvent(new CustomEvent("veo-generation-done"));
            if (data.status === 'limit_reached' || (data.status === 'success' && typeof data.remaining === 'number' && data.remaining <= 0)) {
                o.send("browser:stop-automation");
                o.send("extended-video:stop");
                o.send("commerce:stop-tasks");
                window.dispatchEvent(new CustomEvent("veo-show-limit-alert"));
            }
        }).catch((err) => {
            console.error("[Preload] Lỗi khi gửi log_generation:", err);
        });
    } catch(e) {
        console.error("[Preload] Lỗi log_generation:", e);
    }
};

// Hàm thống kê theo từng luồng hoàn thành thành công (tránh đúp trong 1 phiên)
const trackThreadSuccess = (taskId, extraInfo = "") => {
    if (taskId === null || taskId === undefined) return;
    const cleanId = String(taskId).trim();
    if (!cleanId || cleanId === "null" || cleanId === "System" || cleanId === "general") return;

    const taskKey = `${cleanId}_${extraInfo}`;
    if (!completedTasksInSession.has(cleanId) && !completedTasksInSession.has(taskKey)) {
        completedTasksInSession.add(cleanId);
        completedTasksInSession.add(taskKey);
        console.log(`[Limit-Client] 🎉 Luồng #${cleanId} chạy thành công! Gửi thống kê lượt tạo...`);
        logGeneration();
    }
};

// 1. Lắng nghe từng luồng chạy thành công từ kênh browser:log
o.on("browser:log", (event, data) => {
    if (!data) return;
    if (data.status === "success" && data.promptId !== null && data.promptId !== undefined) {
        trackThreadSuccess(data.promptId, data.videoUrl || data.message || "");
    }
});

// 2. Lắng nghe từng luồng thành công từ kênh auto-product:log
o.on("auto-product:log", (event, data) => {
    if (!data) return;
    if (data.status === "success" && data.linkId !== null && data.linkId !== undefined) {
        trackThreadSuccess(data.linkId, data.videoUrl || data.message || "");
    }
});

// 3. Lắng nghe từng video tải về thành công từ download-complete
o.on("download-complete", (event, data) => {
    if (!data) return;
    if (data.success && data.promptId !== null && data.promptId !== undefined) {
        trackThreadSuccess(data.promptId, data.path || "");
    }
});

d.exposeInMainWorld("electronAPI", {
  fetch: async (e, t, n) => { 
      if (typeof e === "string" && (e.includes("flowMedia:batchGenerateImages") /* || e.includes("aisandbox-pa.googleapis.com") */ || e.includes("flow.google.com") || e.includes("generateImages") || e.includes("generateVideo"))) {
          if (!(await checkLimit())) {
              const isEn = (localStorage.getItem("app-language") || navigator.language || "").includes("en"); const msg = isEn ? "You have reached your daily limit, please come back tomorrow." : "Bạn đã hết giới hạn trong ngày vui lòng quay lại vào ngày mai"; return Promise.reject(new Error(msg));
          }
          const result = await o.invoke("fetch-api", { url: e, cookie: t, options: n });
          logGeneration();
          return result;
      }
      return o.invoke("fetch-api", { url: e, cookie: t, options: n }); 
  },
  startBrowserAutomation: async (e) => { 
    if (await checkLimit()) { 
      completedTasksInSession.clear(); 
      o.send("browser:start-automation", e); 
    } 
  },
  stopBrowserAutomation: () => o.send("browser:stop-automation"),
  videoCreateFromFrames: async (e) => { 
    if (await checkLimit()) { 
      completedTasksInSession.clear(); 
      o.send("video:create-from-frames", e); 
    } 
  },
  videoCreateFromReferences: async (e) => { 
    if (await checkLimit()) { 
      completedTasksInSession.clear(); 
      o.send("video:create-from-references", e); 
    } 
  },
  videoCreateExtended: async (e) => { 
    if (await checkLimit()) { 
      completedTasksInSession.clear(); 
      o.send("extended-video:start", e); 
    } 
  },
  stopExtendedVideo: () => o.send("extended-video:stop"),
  mergeVideos: (e) => o.invoke("merge-videos", e),
  selectVideoFiles: () => o.invoke("select-video-files"),
  stopMerge: () => o.invoke("stop-merge"),
  getVideoMetadata: (e) => o.invoke("get-video-metadata", e),
  getLoadableVideoSrc: (e) => o.invoke("get-loadable-video-src", e),
  cutVideo: (e) => o.invoke("video:cut", e),
  extractFrames: (e) => o.invoke("video:extract-frames", e),
  stopCut: () => o.invoke("video:stop-cut"),
  downloadVideo: (e) => o.send("download-video", e),
  downloadImage: (e) => o.send("download-image", e),
  selectDownloadDirectory: () => o.invoke("select-download-directory"),
  importPromptsFromFile: () => o.invoke("import-prompts-from-file"),
  importJsonPromptsFromFile: () => o.invoke("import-prompts-from-json"),
  getAppVersion: () => o.invoke("get-app-version"),
  saveImageToDisk: async (config) => { logGeneration(); return o.invoke("save-image-to-disk", config); },
  downloadAndSaveVideo: async (config) => { logGeneration(); return o.invoke("download-and-save-video", config); },
  onDownloadComplete: (e) => {
    const t = (n, r) => e(r);
    return (
      o.on("download-complete", t),
      () => o.removeListener("download-complete", t)
    );
  },
  logToMain: (msg, type = "log") => o.send("renderer:log", { type, message: msg }),
  onBrowserLog: (e) => {
    const t = (n, r) => {
      if (typeof e === "function") {
        if (e.length >= 2) e(n, r);
        else e(r);
      }
    };
    return o.on("browser:log", t), () => o.removeListener("browser:log", t);
  },
  onExtendedVideoLog: (e) => {
    const t = (n, r) => e(r);
    return (
      o.on("extended-video:log", t), () => o.removeListener("extended-video:log", t)
    );
  },
  onCookieUpdate: (e) => {
    const t = (n, r) => e(r);
    return (
      o.on("browser:cookie-update", t), () => o.removeListener("browser:cookie-update", t)
    );
  },
  onCaptchaRequested: (e) => {
    const t = (n, r) => e(r);
    return (
      o.on("captcha:requested", t), () => o.removeListener("captcha:requested", t)
    );
  },
  onNavigateToView: (e) => {
    const t = (n, r) => e(r);
    return o.on("navigate-to-view", t), () => o.removeListener("navigate-to-view", t);
  },
  onMergeProgress: (e) => {
    const t = (n, r) => e(r);
    return o.on("merge-progress", t), () => o.removeListener("merge-progress", t);
  },
  onCutProgress: (e) => {
    return o.on("cut-progress", t), () => o.removeListener("cut-progress", t);
  },
  checkForUpdates: () => o.send("check-for-updates"),
  downloadUpdate: () => o.send("download-update"),
  onUpdateMessage: (e) => {
    const t = (n, r, s) => e(r, s);
    return (
      o.on("update-message", t), () => o.removeListener("update-message", t)
    );
  },
  restartAndInstall: () => o.send("restart-and-install"),
  forceReloadWindow: (e) => o.send("app:force-reload-window", e),
  copyText: (e) => i.writeText(e),
  openExternalLink: (e) => o.send("app:open-external", e),
  // Gemini API methods
  geminiSaveApiKey: (key) => o.invoke("gemini:save-api-key", key),
  geminiGetApiKey: () => o.invoke("gemini:get-api-key"),
  geminiTestApiKey: (key) => o.invoke("gemini:test-api-key", key),
  geminiGenerateImage: async (params) => { if (await checkLimit()) { const r = await o.invoke("gemini:generate-image", params); logGeneration(); return r; } { const isEn = (localStorage.getItem("app-language") || navigator.language || "").includes("en"); const msg = isEn ? "You have reached your daily limit, please come back tomorrow." : "Bạn đã hết giới hạn trong ngày vui lòng quay lại vào ngày mai"; throw new Error(msg); } },
  geminiGenerateVideo: async (params) => { if (await checkLimit()) { const r = await o.invoke("gemini:generate-video", params); logGeneration(); return r; } { const isEn = (localStorage.getItem("app-language") || navigator.language || "").includes("en"); const msg = isEn ? "You have reached your daily limit, please come back tomorrow." : "Bạn đã hết giới hạn trong ngày vui lòng quay lại vào ngày mai"; throw new Error(msg); } },
  geminiPollVideoOperation: (operationName, apiKey) =>
    o.invoke("gemini:poll-video-operation", operationName, apiKey),
  geminiDownloadVideo: (videoUri, apiKey) =>
    o.invoke("gemini:download-video", videoUri, apiKey),
  startAutoProductMaker: async (e) => { 
    if (await checkLimit()) { 
      completedTasksInSession.clear(); 
      o.send("video:auto-product-maker", e); 
    } 
  },
  onAutoProductLog: (e) => {
    const t = (n, r) => e(r);
    return o.on("auto-product:log", t), () => o.removeListener("auto-product:log", t);
  },
  whiskStartImageAutomation: async (e) => { if (await checkLimit()) { const r = await o.invoke("whisk:start-image-automation", e); return r; } { const isEn = (localStorage.getItem("app-language") || navigator.language || "").includes("en"); const msg = isEn ? "You have reached your daily limit, please come back tomorrow." : "Bạn đã hết giới hạn trong ngày vui lòng quay lại vào ngày mai"; throw new Error(msg); } },
  whiskGetProject: (cookie) => o.invoke("whisk:get-project", cookie),
  whiskStoreImage: (e, t) => o.invoke("whisk:store-image", { key: e, base64: t }),
  whiskClearImages: () => o.invoke("whisk:clear-images"),
  onWhiskImageResult: (e) => {
    const t = (n, r) => e(r);
    o.on("whisk:image-result", t);
    return t;
  },
  removeWhiskImageResult: (e) => {
    o.removeListener("whisk:image-result", e);
  },
  geminiStartWebAutomation: async (e) => { if (await checkLimit()) { const r = await o.invoke("gemini:start-web-automation", e); return r; } { const isEn = (localStorage.getItem("app-language") || navigator.language || "").includes("en"); const msg = isEn ? "You have reached your daily limit, please come back tomorrow." : "Bạn đã hết giới hạn trong ngày vui lòng quay lại vào ngày mai"; throw new Error(msg); } },
  studioSaveCharacters: (chars) => o.invoke("studio:save-characters", chars),
  studioLoadCharacters: () => o.invoke("studio:load-characters"),
  studioImportCharactersFromFolder: () => o.invoke("studio:import-characters-from-folder"),
  studioSaveCharacterImage: (data) => o.invoke("studio:save-character-image", data),
  commerceSaveTasks: (tasks) => o.invoke("commerce:save-tasks", tasks),
  commerceLoadTasks: () => o.invoke("commerce:load-tasks"),
  startCommerceTasks: async (e) => { 
    if (await checkLimit()) { 
      completedTasksInSession.clear(); 
      o.send("commerce:start-tasks", e); 
    } 
  },
  stopCommerceTasks: () => o.send("commerce:stop-tasks"),
  extensionCheckStatus: () => o.invoke("extension:check-status"),
  exitApplication: () => o.invoke("app:exit-application"),
  showMaintenancePopup: (data) => o.invoke("app:show-maintenance-popup", data),
  getEstimatedTime: (data) => o.invoke("app:get-estimated-time", data),
  getAppStatus: () => o.invoke("app:get-status"),
  onAppClosing: (callback) => {
    const handler = (event, data) => callback(data);
    o.on("app:closing", handler);
    return () => o.removeListener("app:closing", handler);
  },
  onMaintenancePopup: (callback) => {
    const handler = (event, data) => callback(data);
    o.on("app:show-maintenance-popup", handler);
    return () => o.removeListener("app:show-maintenance-popup", handler);
  },
  onEstimatedTimeUpdate: (callback) => {
    const handler = (event, data) => callback(data);
    o.on("estimated-time:update", handler);
    return () => o.removeListener("estimated-time:update", handler);
  },
  // Generic invoke for any IPC handler
  invoke: (channel, ...args) => o.invoke(channel, ...args),
  receive: (channel, callback) => {
    const handler = (event, data) => callback(data);
    o.on(channel, handler);
    return () => o.removeListener(channel, handler);
  },
  // === TTS Voice API ===
  ttsGetVoices: () => o.invoke("tts:get-voices"),
  stopTts: () => o.invoke("tts:stop"),
  ttsGenerate: (data) => o.invoke("tts:generate", data),
  ttsPreview: (data) => o.invoke("tts:preview", data),
  ttsGenerateBatch: (data) => o.invoke("tts:generate-batch", data),
  ttsSetOutputDir: () => o.invoke("tts:set-output-dir"),
  ttsGetOutputDir: () => o.invoke("tts:get-output-dir"),
  ttsOpenOutputDir: () => o.invoke("tts:open-output-dir"),
  onTtsBatchProgress: (cb) => {
    const handler = (event, data) => cb(data);
    o.on("tts:batch-progress", handler);
    return () => o.removeListener("tts:batch-progress", handler);
  },
  // === Kinxts (VieNeu-TTS local exe) Voice API ===
  kinxtsStatus: () => o.invoke("kinxts:status"),
  kinxtsTts: (data) => o.invoke("kinxts:tts", data),
  kinxtsClone: (data) => o.invoke("kinxts:clone", data),
  kinxtsListVoices: () => o.invoke("kinxts:list-voices"),
  kinxtsSaveVoice: (data) => o.invoke("kinxts:save-voice", data),
  kinxtsDeleteVoice: (data) => o.invoke("kinxts:delete-voice", data),
  kinxtsVoiceRef: (data) => o.invoke("kinxts:voice-ref", data),
  kinxtsConversation: (data) => o.invoke("kinxts:conversation", data),
  kinxtsGetConvDir: () => o.invoke("kinxts:get-conv-dir"),
  kinxtsSetConvDir: () => o.invoke("kinxts:set-conv-dir"),
  kinxtsOpenConvDir: () => o.invoke("kinxts:open-conv-dir"),
  kinxtsStrMergeAudio: (data) => o.invoke("kinxts:str-merge-audio", data),
  kinxtsBatchTts: (data) => o.invoke("kinxts:batchTts", data),
  onKinxtsStatus: (cb) => {
    const handler = (event, data) => cb(data);
    o.on("kinxts:status", handler);
    return () => o.removeListener("kinxts:status", handler);
  },

  // === Profile Manager API ===
  profileSniffAuth: (opts) => o.invoke('profile:sniff-auth', opts),
  profileSilentSniff: (opts) => o.invoke('profile:silent-sniff', opts),
  profileSniffBatch: (opts) => o.invoke('profile:sniff-batch', opts),
  profileClear: (profileId) => o.invoke('profile:clear', profileId),
  profileListChromeProfiles: () => o.invoke('profile:list-chrome-profiles'),
  profileCheckCredit: (opts) => o.invoke('profile:check-credit', opts),
});
