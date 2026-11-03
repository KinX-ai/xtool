/**
 * Inject script: Menu "Tạo Voice" trong sidebar, voice UI inline
 * Layout matches Veo3 exactly:
 *   1. Header config bar — ALL voice settings (language, voice, speed, volume, pitch, output)
 *   2. Toolbar — action buttons + stats
 *   3. 3-column grid of Prompt Cards — each card = 1 text input to generate audio
 *
 * Flow: Pick language → Voice dropdown filters → Add prompt cards → Run all
 */
(function () {
  let isEn = (localStorage.getItem('app-language') || navigator.language || '').includes('en');
  // Monitor language change
  setInterval(() => {
    const currentEn = (localStorage.getItem('app-language') || navigator.language || '').includes('en');
    if (currentEn !== isEn) {
      isEn = currentEn;
      updateVoiceUILanguage();
    }
  }, 500);

  function updateVoiceUILanguage() {
    const voiceItem = document.querySelector('[data-voice-menu]');
    if (voiceItem) {
      const labelEl = voiceItem.querySelector('[data-voice-label]');
      if (labelEl) {
        labelEl.textContent = isEn ? "Create Voice" : "Tạo Voice";
      } else {
        voiceItem.innerHTML = getVoiceMenuItemInnerHTML();
      }
      syncVoiceMenuState();
    }
    
    // Destroy the panel so it completely re-renders in the new language next time it's opened
    const p = document.getElementById('voice-panel');
    if (p) {
        if (p.style.display !== 'none') {
            try { hideVoice(); } catch(e){}
        }
        p.remove();
        panel = null;
    }
  }

  function getVoiceMenuItemInnerHTML() {
    return '<span data-voice-icon="true" class="flex items-center justify-center w-5 h-5 flex-shrink-0 mr-2.5 transition-colors"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="h-5 w-5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z"/></svg></span><span data-voice-label="true" class="font-medium text-sm whitespace-nowrap overflow-hidden text-ellipsis">' + (isEn ? "Create Voice" : "Tạo Voice") + '</span>';
  }

  const VOICE_CSS = `
    #voice-panel {
      display: none;
      position: fixed;
      top: 0; bottom: 0; right: 0; left: 240px;
      z-index: 50;
      overflow-y: auto;
      overflow-x: hidden;
      background: #0f172a;
      color: #f1f5f9;
      font-family: Inter, sans-serif;
    }
    #voice-panel.collapsed { left: 80px; }
    aside { position: relative; z-index: 60 !important; }
    /* Khi đang mở tab Tạo Voice, tạm ẩn nền active của tab React mà không xóa class của React */
    aside.voice-menu-active nav > div:not([data-voice-menu]).bg-gradient-to-r,
    aside.voice-menu-active > div.border-t > div.bg-gradient-to-r {
      background: transparent !important;
      border-color: transparent !important;
      color: rgb(107 114 128) !important;
      box-shadow: none !important;
    }
    body.dark-mode aside.voice-menu-active nav > div:not([data-voice-menu]).bg-gradient-to-r,
    body.dark-mode aside.voice-menu-active > div.border-t > div.bg-gradient-to-r {
      color: #94a3b8 !important;
    }
    aside.voice-menu-active nav > div:not([data-voice-menu]).bg-gradient-to-r:hover,
    aside.voice-menu-active > div.border-t > div.bg-gradient-to-r:hover {
      background-color: rgb(249 250 251) !important;
      color: rgb(17 24 39) !important;
    }
    body.dark-mode aside.voice-menu-active nav > div:not([data-voice-menu]).bg-gradient-to-r:hover,
    body.dark-mode aside.voice-menu-active > div.border-t > div.bg-gradient-to-r:hover {
      background-color: #334155 !important;
      color: #ffffff !important;
    }
    aside.voice-menu-active nav > div:not([data-voice-menu]).bg-gradient-to-r svg,
    aside.voice-menu-active nav > div:not([data-voice-menu]).bg-gradient-to-r span.text-white,
    aside.voice-menu-active > div.border-t > div.bg-gradient-to-r svg,
    aside.voice-menu-active > div.border-t > div.bg-gradient-to-r span {
      color: inherit !important;
    }
    aside.voice-menu-active nav > div:not([data-voice-menu]).bg-gradient-to-r span.text-white\\/80 {
      background-image: linear-gradient(to right, #c084fc, #ec4899, #ef4444) !important;
      -webkit-background-clip: text !important;
      background-clip: text !important;
      color: transparent !important;
    }
    #voice-panel *::-webkit-scrollbar { width: 4px; }
    #voice-panel *::-webkit-scrollbar-track { background: transparent; }
    #voice-panel *::-webkit-scrollbar-thumb { background: #334155; border-radius: 2px; }
    @keyframes vspin { to { transform: rotate(360deg); } }
    #voice-panel .v-prompt-card textarea:focus { outline: none; border-color: #6366f1; }
    #voice-panel select:hover, #voice-panel input:hover, #voice-panel textarea:hover {
      border-color: #475569;
    }
    #voice-panel #vBtnStop,
    #voice-panel #vBtnRunPending {
      display: none !important;
    }
    #voice-panel #vBtnStop.show,
    #voice-panel #vBtnRunPending.show {
      display: inline-flex !important;
    }
    #voice-panel .drop {
      display:flex; align-items:center; gap:6px; padding:8px 12px; border:1px dashed #475569;
      border-radius:10px; background:#0b1220; color:#94a3b8; font-size:12px; cursor:pointer;
      transition:all .15s; min-height:38px;
    }
    #voice-panel .drop.drag { border-color:#6366f1; color:#c7d2fe; background:#111827; }
    #voice-panel .drop #vDropName { color:#34d399; }
    #voice-panel #vBtnLibSave { height:38px !important; box-sizing:border-box; }
  `;
  document.head.appendChild(Object.assign(document.createElement('style'), { textContent: VOICE_CSS }));

  function getVoiceHTML() {
    return `
      <div class="animate-fade-in h-full flex flex-col p-4 gap-3" style="padding-top:20px;">

        <!-- ========== TAB BAR ========== -->
        <div class="flex items-center gap-2 flex-shrink-0" style="margin-top:8px;">
          <button id="vTabCreate" class="px-4 py-2 rounded-lg text-sm font-semibold transition-colors" style="background:#1e293b;color:#f1f5f9;">${isEn ? "Create Voice" : "Tạo Voice"}</button>
          <button id="vTabLibrary" class="px-4 py-2 rounded-lg text-sm font-semibold transition-colors" style="background:#0f172a;color:#94a3b8;">★ ${isEn ? "Voice Library" : "Thư viện giọng"}</button>
          <button id="vTabConversation" class="px-4 py-2 rounded-lg text-sm font-semibold transition-colors" style="background:#0f172a;color:#94a3b8;">💬 ${isEn ? "Conversation" : "Hội thoại"}</button>
          <button id="vTabStr" class="px-4 py-2 rounded-lg text-sm font-semibold transition-colors" style="background:#0f172a;color:#94a3b8;">🎞 STR</button>
        </div>

        <!-- ========== LIBRARY TAB (hidden by default) ========== -->
        <div id="vLibraryTab" style="display:none;" class="flex-1 flex flex-col gap-3 min-h-0">
          <div class="flex flex-wrap items-end gap-x-3 gap-y-2 p-3 bg-secondary rounded-xl border border-border-color shadow-sm flex-shrink-0">
            <div class="flex flex-col gap-1" style="min-width:200px;">
              <label class="text-[12px] font-medium text-dark-text">${isEn ? "Voice name" : "Tên giọng"}</label>
              <input id="vLibName" class="w-full px-2 py-1 text-sm bg-primary border border-border-color rounded-lg outline-none focus:border-accent text-light" style="height:38px;" placeholder="${isEn ? "e.g. Nam MC" : "Ví dụ: Nam MC"}" />
            </div>
            <div class="flex flex-col gap-1 flex-1" style="min-width:220px;">
              <label class="text-[12px] font-medium text-dark-text">${isEn ? "Sample audio" : "File mẫu"}</label>
              <div class="drop" id="vLibDrop"><span id="vLibName2">📁 ${isEn ? "Drop sample or click" : "Thả file mẫu hoặc click"}</span><input type="file" id="vLibRef" accept="audio/*" hidden /></div>
            </div>
            <div class="flex items-end">
              <button id="vBtnLibSave" class="bg-purple-600 hover:bg-purple-700 text-white font-bold rounded-lg transition-colors shadow-lg flex items-center justify-center gap-1.5" style="height:38px;font-size:12px;padding:0 14px;white-space:nowrap;">💾 ${isEn ? "Save voice" : "Lưu giọng"}</button>
            </div>
          </div>
          <div id="vLibGrid" class="flex-1 grid min-h-0 overflow-y-auto" style="grid-template-columns:repeat(auto-fill,minmax(220px,1fr));grid-auto-rows:min-content;gap:10px;align-content:start;"></div>
        </div>

        <!-- ========== CREATE TAB ========== -->
        <div id="vCreateTab" class="flex-1 flex flex-col gap-3 min-h-0">
        <div class="flex items-center gap-3 flex-shrink-0" style="margin-top:20px;margin-bottom:20px;">
          <div style="display:flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,#6366f1,#8b5cf6);font-size:20px;">🎙️</div>
          <div>
            <h1 style="font-size:20px;font-weight:700;color:#f1f5f9;line-height:1.2;">${isEn ? "Create Voice" : "Tạo Voice"}</h1>
            <p style="font-size:11px;color:#64748b;margin-top:1px;">${isEn ? "Text to Speech with Edge TTS" : "Chuyển văn bản thành giọng nói với Edge TTS"}</p>
          </div>
        </div>



        <!-- ========== 1. HEADER CONFIG BAR — matches Veo3 settings ========== -->
        <div class="flex flex-wrap items-end gap-x-3 gap-y-2 p-3 bg-secondary rounded-xl border border-border-color shadow-sm flex-shrink-0">
          <!-- Ngôn ngữ -->
          <div class="v-edge-only flex flex-col gap-1" style="min-width:130px;">
            <label class="text-[12px] font-medium text-dark-text">${isEn ? "Language" : "Ngôn ngữ"}</label>
            <select id="vLanguage" class="w-full px-2 py-1 text-sm bg-primary border border-border-color rounded-lg outline-none focus:border-accent text-light" style="height:38px;"></select>
          </div>
          <!-- Backend -->
          <div class="flex flex-col gap-1" style="min-width:140px;">
            <label class="text-[12px] font-medium text-dark-text">${isEn ? "Backend" : "Công cụ"}</label>
            <select id="vBackend" class="w-full px-2 py-1 text-sm bg-primary border border-border-color rounded-lg outline-none focus:border-accent text-light" style="height:38px;">
              <option value="kinxts">${isEn ? "Local (kinxts)" : "Local (kinxts)"}</option>
              <option value="edge">${isEn ? "Edge TTS" : "Edge TTS"}</option>
            </select>
          </div>
          <!-- Model status -->
          <div class="v-kinxts-only flex flex-col gap-1" style="min-width:150px;">
            <label class="text-[12px] font-medium text-dark-text">${isEn ? "Model" : "Model"}</label>
            <span id="vKinxtsStatus" class="text-[11px] px-2 py-1 rounded-lg border border-border-color bg-primary flex items-center" style="height:38px;color:#fbbf24;">⏳ ${isEn ? "Starting…" : "Đang khởi động…"}</span>
          </div>
          <!-- Giọng nói -->
          <div class="flex flex-col gap-1 flex-1" style="min-width:180px;">
            <label class="text-[12px] font-medium text-dark-text">${isEn ? "Voice" : "Giọng nói"}</label>
            <select id="vVoice" class="w-full px-2 py-1 text-sm bg-primary border border-border-color rounded-lg outline-none focus:border-accent text-light" style="height:38px;"></select>
          </div>
          <!-- Tốc độ -->
          <div class="v-edge-only flex flex-col gap-1" style="width:95px;">
            <label class="text-[12px] font-medium text-dark-text">${isEn ? "Speed" : "Tốc độ"}</label>
            <select id="vRate" class="v-edge-only w-full px-2 py-1 text-sm bg-primary border border-border-color rounded-lg outline-none focus:border-accent text-light" style="height:38px;">
              <option value="+0%">${isEn ? "Normal" : "Bình thường"}</option><option value="-25%">${isEn ? "Slow" : "Chậm"}</option><option value="+25%">${isEn ? "Fast" : "Nhanh"}</option><option value="+50%">${isEn ? "Very Fast" : "Rất nhanh"}</option>
            </select>
          </div>
          <!-- Âm lượng -->
          <div class="v-edge-only flex flex-col gap-1" style="width:95px;">
            <label class="text-[12px] font-medium text-dark-text">${isEn ? "Volume" : "Âm lượng"}</label>
            <select id="vVolume" class="v-edge-only w-full px-2 py-1 text-sm bg-primary border border-border-color rounded-lg outline-none focus:border-accent text-light" style="height:38px;">
              <option value="+0%">${isEn ? "Normal" : "Bình thường"}</option><option value="-25%">Nhỏ</option><option value="+25%">To</option><option value="+50%">Rất to</option>
            </select>
          </div>
          <!-- Cao độ -->
          <div class="v-edge-only flex flex-col gap-1" style="width:95px;">
            <label class="text-[12px] font-medium text-dark-text">${isEn ? "Pitch" : "Cao độ"}</label>
            <select id="vPitch" class="v-edge-only w-full px-2 py-1 text-sm bg-primary border border-border-color rounded-lg outline-none focus:border-accent text-light" style="height:38px;">
              <option value="+0Hz">${isEn ? "Normal" : "Bình thường"}</option><option value="-25Hz">Thấp</option><option value="+25Hz">Cao</option>
            </select>
          </div>
          <!-- Luồng -->
          <div class="flex flex-col gap-1" style="width:55px;">
            <label class="text-[12px] font-medium text-dark-text">Luồng</label>
            <input type="number" id="vMaxThreads" value="3" min="1" max="10" class="w-full px-2 py-1 text-sm bg-primary border border-border-color rounded-lg outline-none focus:border-accent text-light" style="height:38px;" />
          </div>
          <!-- Tự động lưu -->
          <div class="flex flex-col gap-1">
            <label class="text-[12px] font-medium text-dark-text">Tự động lưu</label>
            <div class="flex items-center gap-1" style="height:38px;">
              <span id="vOutputDir" class="text-[10px] text-light bg-primary border border-border-color rounded-lg px-2 truncate flex items-center" style="height:38px;max-width:120px;">Đang tải...</span>
              <button id="vBtnChangeDir" class="bg-primary text-light rounded-lg border border-border-color hover:bg-white/5 transition-colors flex items-center justify-center" style="height:38px;width:38px;font-size:13px;">📁</button>
              <button id="vBtnOpenDir" class="bg-primary text-light rounded-lg border border-border-color hover:bg-white/5 transition-colors flex items-center justify-center" style="height:38px;width:38px;font-size:13px;">📂</button>
            </div>
          </div>
          <!-- Nhập từ TXT -->
          <div class="flex flex-col gap-1">
            <label class="text-[10px] font-medium text-dark-text opacity-0">_</label>
            <button id="vBtnImportTxt" class="bg-blue-500 hover:bg-blue-600 text-white font-bold rounded-lg transition-colors flex items-center gap-1" style="height:38px;font-size:12px;padding:0 12px;">📥 Nhập từ TXT</button>
          </div>
        </div>



        <!-- ========== 2b. STATUS BAR — full width ========== -->
        <div class="bg-secondary rounded-xl border border-border-color shadow-sm flex-shrink-0" style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;padding:10px 16px;">
          <div style="display:flex;align-items:center;gap:18px;font-size:12px;">
            <label for="vSelectAll" style="display:inline-flex;align-items:center;gap:8px;color:#f1f5f9;font-weight:500;cursor:pointer;user-select:none;white-space:nowrap;">
              <input type="checkbox" id="vSelectAll" class="accent-[#7c3aed]" style="width:14px;height:14px;cursor:pointer;margin:0;" />
              <span>${isEn ? "Select all" : "Chọn tất cả"} (<span id="vStatTotal">0</span>)</span>
            </label>
            <button id="vBtnDeleteSelected" style="display:inline-flex;align-items:center;gap:6px;color:#cbd5e1;font-weight:500;background:transparent;border:none;cursor:pointer;padding:0;white-space:nowrap;" onmouseover="this.style.color='#f87171'" onmouseout="this.style.color='#cbd5e1'">
              <svg style="width:14px;height:14px;flex-shrink:0;color:#94a3b8;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
              <span>${isEn ? "Delete all" : "Xóa tất cả"}</span>
            </button>
          </div>

          <div style="display:flex;flex-wrap:wrap;align-items:center;gap:20px;font-size:12px;">
            <span style="display:inline-block;width:1px;height:16px;background:#334155;"></span>
            <span style="display:inline-flex;align-items:center;gap:6px;font-weight:600;color:#f1f5f9;white-space:nowrap;">
              <span style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:9999px;background:#334155;color:#cbd5e1;font-size:10px;line-height:1;">∑</span>
              <span>${isEn ? "Total:" : "Tổng:"} <span id="vStatTotalNum">0</span></span>
            </span>
            <span style="display:inline-flex;align-items:center;gap:6px;font-weight:600;color:#34d399;white-space:nowrap;">
              <span style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:9999px;background:rgba(16,185,129,0.2);color:#34d399;font-size:10px;line-height:1;">✓</span>
              <span>${isEn ? "Success:" : "Thành công:"} <span id="vStatDone">0</span></span>
            </span>
            <span style="display:inline-flex;align-items:center;gap:6px;font-weight:600;color:#f87171;white-space:nowrap;">
              <span style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:9999px;background:rgba(239,68,68,0.2);color:#f87171;font-size:10px;line-height:1;">✕</span>
              <span>${isEn ? "Failed:" : "Thất bại:"} <span id="vStatFail">0</span></span>
            </span>
            <span style="display:inline-flex;align-items:center;gap:6px;font-weight:600;color:#fbbf24;white-space:nowrap;">
              <span style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:9999px;background:rgba(245,158,11,0.2);color:#fbbf24;font-size:10px;line-height:1;">⚠</span>
              <span>${isEn ? "Errors:" : "Có lỗi:"} <span id="vStatWarn">0</span></span>
            </span>
            <span style="display:inline-block;width:1px;height:16px;background:#334155;"></span>
            <span id="vStatRunStatus" style="display:inline-flex;align-items:center;gap:6px;font-weight:500;color:#cbd5e1;white-space:nowrap;">
              <span style="display:inline-block;width:7px;height:7px;border-radius:9999px;background:#94a3b8;"></span>
              <span>${isEn ? "Ready" : "Sẵn sàng"}</span>
            </span>
          </div>
        </div>

        <!-- ========== 2. TOOLBAR — action buttons ========== -->
        <div class="flex items-center gap-3 flex-shrink-0">
          <button id="vBtnAddPrompt" class="bg-primary text-light font-bold rounded-lg border border-border-color hover:bg-white/5 transition-colors flex items-center gap-1.5" style="height:32px;font-size:12px;padding:0 12px;">+ Thêm Prompt</button>
          <button id="vBtnRunAll" class="bg-green-600 hover:bg-green-700 text-white font-bold rounded-lg transition-colors shadow-lg flex items-center gap-1.5" style="height:32px;font-size:12px;padding:0 14px;">▶ Chạy tất cả</button>
          <button id="vBtnStop" class="bg-red-600 hover:bg-red-700 text-white font-bold rounded-lg transition-colors shadow-lg flex items-center gap-1.5" style="height:32px;font-size:12px;padding:0 14px;">⏹ Dừng</button>
          <button id="vBtnRunPending" class="bg-green-500/80 hover:bg-green-600 text-white font-bold rounded-lg transition-colors flex items-center gap-1.5" style="height:32px;font-size:12px;padding:0 12px;">▶ Chạy chưa xong</button>
        </div>


        <!-- ========== 3. PROMPT CARDS GRID — 3 columns ========== -->
        <div id="v-prompts-grid" class="flex-1 grid min-h-0 overflow-y-auto" style="grid-template-columns:repeat(3,1fr);grid-auto-rows:min-content;gap:10px;align-content:start;">

          <!-- Empty state -->
          <div id="v-empty-state" class="col-span-full text-center py-12">
            <div style="font-size:48px;margin-bottom:12px;">🎙️</div>
            <p class="text-sm text-dark-text mb-3">Nhấn "+ Thêm Prompt" hoặc "📥 Nhập từ TXT" để bắt đầu</p>
            <button id="vBtnAddPrompt2" class="bg-accent hover:bg-indigo-600 text-white font-bold rounded-lg transition-colors shadow-lg" style="height:36px;font-size:13px;padding:0 20px;">+ Thêm Prompt</button>
          </div>
        </div>

        </div>

        <!-- ========== CONVERSATION TAB (hidden by default) ========== -->
        <div id="vConversationTab" style="display:none;min-height:500px;" class="flex-1 flex flex-col gap-3 overflow-y-auto box-border">
          <div class="flex items-center gap-3 flex-shrink-0" style="margin-top:20px;margin-bottom:20px;">
            <div style="display:flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,#10b981,#06b6d4);font-size:20px;">💬</div>
            <div>
              <h1 style="font-size:20px;font-weight:700;color:#f1f5f9;line-height:1.2;">${isEn ? 'Multi-Speaker Conversation' : 'Hội thoại đa giọng'}</h1>
              <p style="font-size:11px;color:#64748b;margin-top:1px;">${isEn ? 'Generate conversation with multiple voices (kinxts engine)' : 'Tạo hội thoại nhiều giọng (kinxts engine)'}</p>
            </div>
          </div>
          <!-- Config bar -->
         <div class="flex flex-wrap items-end gap-3 p-3 bg-secondary rounded-xl border border-border-color shadow-sm config-row">

  <!-- Giọng mặc định - GIỮ NGUYÊN -->
  <div class="flex flex-col gap-1 flex-1 min-w-[180px]">
    <label class="text-[12px] font-medium text-dark-text">
      ${isEn ? 'Default voice' : 'Giọng mặc định'}
    </label>
    <select id="vConvVoice"
      class="w-full box-border h-10 px-3 text-sm bg-primary border border-border-color rounded-lg outline-none focus:border-accent text-light"
      style="height:40px;appearance:none;">
    </select>
  </div>

  <!-- Thư mục -->
  <div class="flex flex-col gap-1 flex-1 min-w-[180px]">
    <label class="text-[12px] font-medium text-dark-text">
      ${isEn ? 'Output folder' : 'Thư mục'}
    </label>

    <button id="vBtnConvDir"
      class="w-full h-10 min-h-10 max-h-10 p-0 box-border text-sm bg-primary border border-border-color rounded-lg text-light hover:bg-white/5 transition flex items-center"
      style="height:40px;">
      
      <span class="ml-3 mr-2 shrink-0">📁</span>

      <span id="vConvDir"
        class="flex-1 min-w-0 truncate text-left text-[11px] text-slate-400 mr-3">
        ${isEn ? 'Loading...' : 'Đang tải...'}
      </span>

    </button>
  </div>

  <!-- Nhịp độ - GIỮ NGUYÊN -->
  <div class="flex flex-col gap-1 flex-1 min-w-[180px]">
    <label class="text-[12px] font-medium text-dark-text">
      ${isEn ? 'Temperature' : 'Nhịp độ'}
    </label>
    <input id="vConvTemp" type="number" value="1.0" min="0.1" max="1.5" step="0.1"
      class="w-full box-border h-10 px-3 text-sm bg-primary border border-border-color rounded-lg outline-none focus:border-accent text-light"
      style="height:40px;">
  </div>

  <!-- Tạm dừng - GIỮ NGUYÊN -->
  <div class="flex flex-col gap-1 flex-1 min-w-[180px]">
    <label class="text-[12px] font-medium text-dark-text">
      ${isEn ? 'Pause (s)' : 'Tạm dừng (s)'}
    </label>
    <input id="vConvPause" type="number" value="0.5" min="0" max="3" step="0.1"
      class="w-full box-border h-10 px-3 text-sm bg-primary border border-border-color rounded-lg outline-none focus:border-accent text-light"
      style="height:40px;">
  </div>

  <!-- Phát hiện nhân vật -->
  <div class="flex flex-col gap-1 flex-1 min-w-[180px]">
    <label class="text-[12px] font-medium text-dark-text opacity-0">.</label>

    <button id="vBtnConvDetect"
      class="w-full h-10 min-h-10 max-h-10 p-0 box-border bg-blue-500 hover:bg-blue-600 border border-blue-500 rounded-lg text-white font-semibold transition flex items-center justify-center gap-2"
      style="height:40px;">
      🔍 ${isEn ? 'Detect characters' : 'Phát hiện nhân vật'}
    </button>
  </div>

  <!-- Tạo Audio -->
  <div class="flex flex-col gap-1 flex-1 min-w-[180px]">
    <label class="text-[12px] font-medium text-dark-text opacity-0">.</label>

    <button id="vBtnConvRun"
      class="w-full h-10 min-h-10 max-h-10 p-0 box-border bg-green-600 hover:bg-green-700 border border-green-600 rounded-lg text-white font-semibold transition flex items-center justify-center gap-2 shadow-lg"
      style="height:40px;">
      ▶ ${isEn ? 'Generate' : 'Tạo Audio'}
    </button>
  </div>

</div>

          <!-- Script input -->
          <div class="p-3 bg-secondary rounded-xl border border-border-color shadow-sm flex-shrink-0">
            <label class="text-[12px] font-medium text-dark-text mb-1 block">${isEn ? 'Script (one line per line: Name: dialogue)' : 'Kịch bản (mỗi dòng 1 câu: Tên: lời thoại)'}</label>
            <textarea id="vConvScript" class="w-full px-3 py-2 text-sm bg-primary border border-border-color rounded-lg outline-none focus:border-accent text-light resize-none" style="min-height:430px;font-family:monospace;" placeholder="Minh: Xin chào&#10;Lan: Chào bạn&#10;Minh: Hôm nay thời tiết thế nào?&#10;Lan: Trời đẹp lắm!"></textarea>
          </div>

          <!-- Character voice mapping -->
          <div class="p-3 bg-secondary rounded-xl border border-border-color shadow-sm flex-shrink-0">
            <label class="text-[12px] font-medium text-dark-text mb-2 block">${isEn ? 'Character voice mapping' : 'Gán giọng cho nhân vật'}</label>
            <div id="vConvCharMap" class="flex flex-wrap gap-2"></div>
            <p id="vConvNoChars" class="text-[11px] text-dark-text italic">${isEn ? 'Click "Detect" to auto-detect characters' : 'Nhấn "Phát hiện" để tự nhận diện nhân vật'}</p>
          </div>

          <!-- Status + player -->
          <div class="p-3 bg-secondary rounded-xl border border-border-color shadow-sm flex-shrink-0">
            <div id="vConvStatus" class="text-[12px] text-dark-text mb-2"></div>
            <audio id="vConvPlayer" controls style="width:100%;height:36px;display:none;"></audio>
          </div>

          <div style="height:20px;"></div>
        </div>
        <!-- ========== STR TAB (hidden by default) ========== -->
        <div id="vStrTab" style="display:none;min-height:500px;" class="flex-1 flex flex-col gap-3 overflow-y-auto box-border">
          <div class="flex items-center gap-3 p-3">
            <div style="display:flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,#f59e0b,#ef4444);font-size:20px;">🎞</div>
            <div>
              <h1 style="font-size:20px;font-weight:700;color:#f1f5f9;line-height:1.2;">${isEn ? 'STR Subtitle Voice' : 'Tạo voice từ phụ đề STR'}</h1>
              <p style="font-size:11px;color:#64748b;margin-top:1px;">${isEn ? 'Import .srt file — audio matches subtitle timestamps' : 'Nhập file .srt — audio khớp timeline phụ đề'}</p>
            </div>
          </div>
          <!-- Config bar -->
          <div class="flex flex-wrap items-end gap-3 p-3 bg-secondary rounded-xl border border-border-color shadow-sm config-row">
            <div class="flex flex-col gap-1" style="flex:1 1 180px;min-width:180px;">
              <label class="text-[12px] font-medium text-dark-text">${isEn ? 'Default voice' : 'Giọng mặc định'}</label>
              <select id="vStrVoice" class="w-full px-3 text-sm bg-primary border border-border-color rounded-lg outline-none focus:border-accent text-light" style="height:52px;appearance:none;"></select>
            </div>
            <div class="flex flex-col gap-1" style="flex:1 1 180px;min-width:180px;">
              <label class="text-[12px] font-medium text-dark-text">${isEn ? 'SRT file' : 'File phụ đề'}</label>
              <input type="file" id="vStrFileInput" accept=".srt" style="display:none;" />
              <button id="vBtnStrPick" class="w-full px-3 text-sm bg-primary border border-border-color rounded-lg text-light hover:bg-white/5 transition flex items-center truncate text-left" style="height:52px;">
                <span class="mr-2 shrink-0">📁</span>
                <span id="vStrFileName" class="truncate text-sm text-slate-400">${isEn ? 'Select .srt file...' : 'Chọn file .srt...'}</span>
              </button>
            </div>
            <div class="flex flex-col gap-1" style="flex:1 1 180px;min-width:180px;">
              <label class="text-[12px] font-medium text-dark-text">${isEn ? 'Temperature' : 'Nhịp độ'}</label>
              <input id="vStrTemp" type="number" value="0.1" min="0.1" max="1.5" step="0.1" class="w-full px-3 text-sm bg-primary border border-border-color rounded-lg outline-none focus:border-accent text-light" style="height:52px;">
            </div>
            <div class="flex flex-col gap-1" style="flex:1 1 180px;min-width:180px;">
              <label class="text-[12px] font-medium text-dark-text">${isEn ? 'Output folder' : 'Thư mục lưu'}</label>
              <button id="vBtnStrConvDir" class="w-full px-3 text-sm bg-primary border border-border-color rounded-lg text-light hover:bg-white/5 transition flex items-center truncate text-left" style="height:52px;">
                <span class="mr-2 shrink-0">📁</span>
                <span id="vStrConvDir" class="truncate text-sm text-slate-400">${isEn ? 'Loading...' : 'Đang tải...'}</span>
              </button>
            </div>
            <div class="flex flex-col gap-1" style="flex:1 1 180px;min-width:180px;">
              <label class="text-[12px] font-medium text-dark-text opacity-0">.</label>
              <button id="vBtnStrRun" class="w-full bg-green-600 hover:bg-green-700 border border-green-600 rounded-lg text-white font-semibold transition flex items-center justify-center gap-2 shadow-lg" style="height:52px;font-size:14px;">
                ▶ ${isEn ? 'Generate' : 'Tạo Audio'}
              </button>
            </div>
          </div>
          <!-- Status + progress (hidden until generation starts) -->
          <div id="vStrStatusWrap" style="display:none;" class="p-3 bg-secondary rounded-xl border border-border-color shadow-sm">
            <div id="vStrStatus" class="text-[12px] text-dark-text mb-2"></div>
            <div id="vStrProgress" style="display:none;">
              <div style="width:100%;height:6px;background:#1e293b;border-radius:3px;overflow:hidden;">
                <div id="vStrProgressBar" style="width:0%;height:100%;background:linear-gradient(90deg,#10b981,#06b6d4);border-radius:3px;transition:width 0.3s;"></div>
              </div>
              <div class="flex justify-between mt-1">
                <span id="vStrProgressText" class="text-[11px] text-slate-400"></span>
                <button id="vBtnStrStop" class="text-[11px] text-red-400 hover:text-red-300 font-semibold">⏹ ${isEn ? 'Stop' : 'Dừng'}</button>
              </div>
            </div>
          </div>
          <!-- SRT Preview (hidden until file loaded) -->
          <div id="vStrPreviewWrap" style="display:none;" class="p-3 bg-secondary rounded-xl border border-border-color shadow-sm">
            <div class="flex items-center justify-between mb-2">
              <label class="text-[12px] font-medium text-dark-text">📋 ${isEn ? 'SRT Preview' : 'Xem trước phụ đề'}</label>
              <span id="vStrSegCount" class="text-[11px] text-slate-400"></span>
            </div>
            <div id="vStrPreview" style="max-height:250px;overflow-y:auto;font-family:monospace;font-size:11px;line-height:1.6;"></div>
          </div>
          <!-- Audio player (hidden until audio ready) -->
          <div id="vStrPlayerWrap" style="display:none;" class="p-3 bg-secondary rounded-xl border border-border-color shadow-sm">
            <audio id="vStrPlayer" controls style="width:100%;height:44px;"></audio>
          </div>
          <div style="height:20px;"></div>
        </div>

      </div>
    `;
  }

  // ============================================================
  // Sidebar injection
  // ============================================================
  function syncVoiceMenuState() {
    const aside = document.querySelector('aside');
    const collapsed = !!(aside && aside.classList.contains('w-20'));
    if (aside && aside.classList.contains('voice-menu-active') !== !!voiceActive) {
      aside.classList.toggle('voice-menu-active', !!voiceActive);
    }
    if (panel) {
      if (panel.classList.contains('collapsed') !== collapsed) {
        panel.classList.toggle('collapsed', collapsed);
      }
      const targetLeft = collapsed ? '80px' : '240px';
      if (panel.style.left !== targetLeft) panel.style.left = targetLeft;
    }
    const voiceItem = document.querySelector('[data-voice-menu]');
    if (!voiceItem) return;
    const nextClass = [
      'flex items-center py-2.5 my-0.5 rounded-lg cursor-pointer transition-all duration-200 group',
      collapsed ? 'justify-center' : 'px-3',
      voiceActive
        ? 'v-active bg-gradient-to-r from-blue-600 to-purple-600 text-white'
        : 'text-dark-text hover:bg-primary hover:text-light'
    ].join(' ');
    if (voiceItem.className !== nextClass) voiceItem.className = nextClass;
    const targetTitle = collapsed ? (isEn ? 'Create Voice' : 'Tạo Voice') : null;
    if (targetTitle) {
      if (voiceItem.getAttribute('title') !== targetTitle) voiceItem.setAttribute('title', targetTitle);
    } else if (voiceItem.hasAttribute('title')) {
      voiceItem.removeAttribute('title');
    }
    const iconWrap = voiceItem.querySelector('[data-voice-icon]');
    if (iconWrap) {
      const nextIconClass = [
        'flex items-center justify-center w-5 h-5 flex-shrink-0 transition-colors',
        collapsed ? '' : 'mr-2.5',
        voiceActive ? 'text-white' : 'text-dark-text group-hover:text-light'
      ].join(' ');
      if (iconWrap.className !== nextIconClass) iconWrap.className = nextIconClass;
    }
    const labelEl = voiceItem.querySelector('[data-voice-label]');
    if (labelEl) {
      const nextDisplay = collapsed ? 'none' : '';
      if (labelEl.style.display !== nextDisplay) labelEl.style.display = nextDisplay;
      const nextLabelClass = 'font-medium text-sm whitespace-nowrap overflow-hidden text-ellipsis ' + (voiceActive ? 'text-white' : '');
      if (labelEl.className !== nextLabelClass) labelEl.className = nextLabelClass;
    }
  }

  function injectSidebarItem() {
    const navEl = document.querySelector('aside nav');
    if (!navEl) return false;
    if (navEl.querySelector('[data-voice-menu]')) {
      syncVoiceMenuState();
      return true;
    }
    const items = navEl.querySelectorAll(':scope > div');
    if (items.length === 0) return false;
    // Insert after the first item (Dashboard) for prominence
    const firstItem = items[0];
    const voiceItem = document.createElement('div');
    voiceItem.setAttribute('data-voice-menu', 'true');
    voiceItem.innerHTML = getVoiceMenuItemInnerHTML();
    voiceItem.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); showVoice(); });
    // Insert after first item
    if (firstItem && firstItem.nextSibling) {
      navEl.insertBefore(voiceItem, firstItem.nextSibling);
    } else {
      navEl.insertBefore(voiceItem, navEl.firstChild);
    }
    syncVoiceMenuState();
    console.log('[Voice] ✅ Sidebar menu injected (top position)');
    return true;
  }

  // ============================================================
  // Panel state
  // ============================================================
  let panel = null;
  let voiceActive = false;
  let allVoices = [];
  let promptCards = [];
  let promptIdCounter = 0;
  let completedCount = 0;
  let failCount = 0;
  let stopRequested = false;

  function createPanel() {
    if (panel) return panel;
    const aside = document.querySelector('aside');
    const collapsed = aside && aside.className.includes('w-20');
    panel = document.createElement('div');
    panel.id = 'voice-panel';
    if (collapsed) panel.classList.add('collapsed');
    panel.innerHTML = getVoiceHTML();
    document.body.appendChild(panel);

    setTimeout(applyBackend, 500);

    // Language change → filter voices
    panel.querySelector('#vLanguage').addEventListener('change', (e) => {
      populateVoices(e.target.value);
    });

    // Buttons
    panel.querySelector('#vBtnAddPrompt').addEventListener('click', () => addPromptCard());
    panel.querySelector('#vBtnAddPrompt2').addEventListener('click', () => addPromptCard());
    panel.querySelector('#vBtnRunAll').addEventListener('click', runAll);
    panel.querySelector('#vBtnStop').addEventListener('click', () => { stopRequested = true; });
    panel.querySelector('#vBtnImportTxt').addEventListener('click', handleImportTxt);
    panel.querySelector('#vBtnChangeDir').addEventListener('click', handleChangeDir);
    panel.querySelector('#vBtnOpenDir').addEventListener('click', handleOpenDir);
    panel.querySelector('#vBackend').addEventListener('change', applyBackend);
    // Tabs
    panel.querySelector('#vTabConversation').addEventListener('click', () => switchTab('conversation'));
    panel.querySelector('#vTabCreate').addEventListener('click', () => switchTab('create'));
    panel.querySelector('#vTabLibrary').addEventListener('click', () => switchTab('library'));
    panel.querySelector('#vTabStr').addEventListener('click', () => switchTab('str'));
    // Library save + drop
    setupLibDrop();
    panel.querySelector('#vBtnLibSave').addEventListener('click', saveLibVoice);
    // Kinxts status: poll the exe API directly (authoritative, no bridge flag dependency)
    const refreshKinxtsStatus = () => {
      fetch('http://127.0.0.1:7860/api/status')
        .then(r => r.json())
        .then(s => updateKinxtsStatus({ online: true, modelLoaded: !!s.model_loaded, loading: false }))
        .catch(() => updateKinxtsStatus({ online: false, modelLoaded: false, loading: false }));
    };
    refreshKinxtsStatus();
    setInterval(refreshKinxtsStatus, 2000);
    panel.querySelector('#vSelectAll').addEventListener('change', (e) => {
      panel.querySelectorAll('.v-prompt-check').forEach(cb => { cb.checked = e.target.checked; });
    });
    panel.querySelector('#vBtnDeleteSelected').addEventListener('click', deleteSelected);

    return panel;
  }

  function stripColorClasses(el) {
    Array.from(el.classList).forEach(c => {
      if (/^(bg-|text-|from-|to-|hover:bg-|v-active)/.test(c)) el.classList.remove(c);
    });
    el.classList.add('text-dark-text', 'text-sm');
  }

  function isVoiceSubscriptionInvalid() {
    try {
      const userStr = localStorage.getItem("currentUser");
      if (!userStr) return true;
      const userObj = JSON.parse(userStr);
      if (!userObj || !userObj.subscription || !userObj.subscription.end_date) return true;
      if (userObj.user && userObj.user.status && userObj.user.status !== "active") return true;
      if (new Date(userObj.subscription.end_date) < new Date()) return true;
      return false;
    } catch (e) {
      return false;
    }
  }

  function showVoice() {
    // Check if package is missing or expired
    if (isVoiceSubscriptionInvalid()) {
      toast(isEn ? 'Your subscription has expired or is not active. Please upgrade!' : 'Gói đăng ký của bạn đã hết hạn hoặc chưa kích hoạt. Vui lòng nâng cấp để sử dụng tính năng này!', 'error');
      return;
    }

    createPanel();
    voiceActive = true;
    panel.style.display = 'block';
    syncVoiceMenuState();
  }

  function hideVoice() {
    if (!panel || !voiceActive) return;
    voiceActive = false;
    panel.style.display = 'none';
    syncVoiceMenuState();
  }

  function interceptSidebar() {
    const aside = document.querySelector('aside');
    if (!aside || aside.dataset.voiceInt) return;
    aside.addEventListener('click', (e) => {
      if (!voiceActive) return;
      if (e.target.closest('[data-voice-menu]')) return;
      // Ignore sidebar collapse/expand button at top right of aside
      if (e.target.closest('button.-right-6')) return;
      const inNavItem = e.target.closest('aside nav > div');
      const inBottomMenu = e.target.closest('aside > div.border-t > div');
      const inProfileOrUpgrade = e.target.closest('aside > div:last-child .cursor-pointer, aside > div:last-child button.w-full');
      if (inNavItem && !inNavItem.classList.contains('cursor-not-allowed')) {
        hideVoice();
      } else if (inBottomMenu || inProfileOrUpgrade) {
        hideVoice();
      }
    }, true);
    aside.dataset.voiceInt = 'true';
  }

  // ============================================================
  // Voice loading — populate language dropdown + voice dropdown
  // ============================================================
  async function loadVoices() {
    try {
      const api = window.electronAPI;
      if (!api) { console.warn('[Voice] electronAPI not available'); return; }
      const backend = panel.querySelector('#vBackend').value;
      if (backend === 'kinxts') {
        await loadKinxtsVoices();
      } else {
        if (!api.ttsGetVoices) { console.warn('[Voice] ttsGetVoices not available'); return; }
        allVoices = await api.ttsGetVoices();
        console.log('[Voice] Loaded', allVoices.length, 'voices');
        populateLanguages();
      }
      const dir = await api.ttsGetOutputDir();
      if (dir) panel.querySelector('#vOutputDir').textContent = dir;
    } catch (e) { console.error('[Voice] Load error:', e); }
  }

  async function loadKinxtsVoices() {
    const sel = panel.querySelector('#vVoice');
    sel.innerHTML = '';
    try {
      const [vr, lib] = await Promise.all([
        fetch('http://127.0.0.1:7860/api/voices').then(r => r.json()).catch(() => ({ voices: [] })),
        (window.electronAPI.kinxtsListVoices ? window.electronAPI.kinxtsListVoices() : Promise.resolve([])).catch(() => []),
      ]);
      const preset = (vr.voices || []).map(v => typeof v === 'string' ? v : (v.ShortName || v.name));
      if (preset.length === 0 && (!lib || !lib.length)) {
        sel.innerHTML = '<option value="">Không có giọng</option>';
        return;
      }
      preset.forEach(v => {
        const opt = document.createElement('option');
        opt.value = v; opt.textContent = v; sel.appendChild(opt);
      });
      (lib || []).forEach(v => {
        const opt = document.createElement('option');
        opt.value = 'clone:' + v.id; opt.textContent = '★ ' + v.name; sel.appendChild(opt);
      });
      if (vr.default) sel.value = vr.default;
      console.log('[Kinxts] Loaded', preset.length, 'preset +', (lib || []).length, 'library voices');
    } catch (e) {
      sel.innerHTML = '<option value="">Lỗi tải giọng</option>';
      console.error('[Kinxts] voices error:', e);
    }
  }

  let wasKinxtsModelLoaded = false;
  function updateKinxtsStatus(state) {
    if (!panel) return;
    const el = panel.querySelector('#vKinxtsStatus');
    if (!el) return;
    if (!state.online) {
      wasKinxtsModelLoaded = false;
      el.style.color = '#fbbf24';
      el.textContent = '⏳ ' + (isEn ? 'Starting exe…' : 'Đang khởi động exe…');
    } else if (state.loading || !state.modelLoaded) {
      el.style.color = '#fbbf24';
      el.textContent = '⏳ ' + (isEn ? 'Loading model…' : 'Đang tải model…');
    } else {
      el.style.color = '#34d399';
      el.textContent = '✓ ' + (isEn ? 'Model ready' : 'Model sẵn sàng');
      const backendSel = panel.querySelector('#vBackend');
      const voiceSel = panel.querySelector('#vVoice');
      const needsVoiceReload = !wasKinxtsModelLoaded || (voiceSel && (!voiceSel.options.length || !voiceSel.value));
      wasKinxtsModelLoaded = true;
      if (backendSel && backendSel.value === 'kinxts' && needsVoiceReload) {
        loadKinxtsVoices();
      }
    }
  }

  function applyBackend() {
    const backend = panel.querySelector('#vBackend').value;
    const isLocal = backend === 'kinxts';
    panel.querySelectorAll('.v-edge-only').forEach(el => { el.style.display = isLocal ? 'none' : ''; });
    panel.querySelectorAll('.v-kinxts-only').forEach(el => { el.style.display = isLocal ? '' : 'none'; });
    loadVoices();
  }

  // Map locale to readable language name
  const LOCALE_NAMES = {
    'af-ZA': 'Afrikaans', 'sq-AL': 'Albanian', 'am-ET': 'Amharic', 'ar-AE': 'Arabic (UAE)',
    'ar-SA': 'Arabic (Saudi)', 'az-AZ': 'Azerbaijani', 'bn-BD': 'Bengali', 'bs-BA': 'Bosnian',
    'bg-BG': 'Bulgarian', 'my-MM': 'Burmese', 'ca-ES': 'Catalan', 'zh-CN': 'Chinese (Simplified)',
    'zh-TW': 'Chinese (Traditional)', 'hr-HR': 'Croatian', 'cs-CZ': 'Czech', 'da-DK': 'Danish',
    'nl-NL': 'Dutch', 'en-AU': 'English (Australia)', 'en-CA': 'English (Canada)',
    'en-GB': 'English (UK)', 'en-HK': 'English (HK)', 'en-IN': 'English (India)',
    'en-IE': 'English (Ireland)', 'en-KE': 'English (Kenya)', 'en-NZ': 'English (NZ)',
    'en-NG': 'English (Nigeria)', 'en-PH': 'English (PH)', 'en-SG': 'English (SG)',
    'en-US': 'English (US)', 'en-ZA': 'English (ZA)', 'et-EE': 'Estonian', 'fi-FI': 'Finnish',
    'fr-CA': 'French (Canada)', 'fr-FR': 'French (France)', 'de-AT': 'German (Austria)',
    'de-CH': 'German (Switzerland)', 'de-DE': 'German (Germany)', 'el-GR': 'Greek', 'gu-IN': 'Gujarati',
    'he-IL': 'Hebrew', 'hi-IN': 'Hindi', 'hu-HU': 'Hungarian', 'is-IS': 'Icelandic',
    'id-ID': 'Indonesian', 'ga-IE': 'Irish', 'it-IT': 'Italian', 'ja-JP': 'Japanese',
    'kn-IN': 'Kannada', 'ko-KR': 'Korean', 'lv-LV': 'Latvian', 'lt-LT': 'Lithuanian',
    'mk-MK': 'Macedonian', 'ms-MY': 'Malay', 'mt-MT': 'Maltese', 'mr-IN': 'Marathi',
    'nb-NO': 'Norwegian', 'fa-IR': 'Persian', 'pl-PL': 'Polish', 'pt-BR': 'Portuguese (Brazil)',
    'pt-PT': 'Portuguese (Portugal)', 'ro-RO': 'Romanian', 'ru-RU': 'Russian', 'sr-RS': 'Serbian',
    'sk-SK': 'Slovak', 'sl-SI': 'Slovenian', 'es-AR': 'Spanish (Argentina)', 'es-CO': 'Spanish (Colombia)',
    'es-ES': 'Spanish (Spain)', 'es-MX': 'Spanish (Mexico)', 'sv-SE': 'Swedish', 'sw-KE': 'Swahili',
    'ta-IN': 'Tamil', 'te-IN': 'Telugu', 'th-TH': 'Thai', 'tr-TR': 'Turkish',
    'uk-UA': 'Ukrainian', 'ur-PK': 'Urdu', 'vi-VN': 'Vietnamese', 'cy-GB': 'Welsh',
  };

  function populateLanguages() {
    const sel = panel.querySelector('#vLanguage');
    sel.innerHTML = '';
    const locales = [...new Set(allVoices.map(v => v.Locale))].sort();
    locales.forEach(loc => {
      const name = LOCALE_NAMES[loc] || loc;
      const opt = document.createElement('option');
      opt.value = loc;
      opt.textContent = name;
      sel.appendChild(opt);
    });
    // Default to Vietnamese or English
    const defaultLoc = locales.find(l => l.startsWith('vi')) || locales.find(l => l.startsWith('en')) || locales[0];
    if (defaultLoc) sel.value = defaultLoc;
    populateVoices(defaultLoc);
  }

  function populateVoices(locale) {
    const sel = panel.querySelector('#vVoice');
    sel.innerHTML = '';
    const backend = panel.querySelector('#vBackend').value;
    if (backend === 'kinxts') { loadKinxtsVoices(); return; }
    const voices = allVoices.filter(v => v.Locale === locale);
    sel.innerHTML = voices.map(v => {
      const gender = v.Gender === 'Female' ? 'Nữ' : 'Nam';
      const voiceName = v.ShortName.split('-').pop();
      const displayName = `${voiceName} - ${gender}`;
      return `<option value="${v.ShortName}">${displayName}</option>`;
    }).join('');
  }

  // ============================================================
  // Prompt cards
  // ============================================================
  function renumberPromptCards() {
    if (!panel) return;
    const cards = panel.querySelectorAll('.v-prompt-card');
    cards.forEach((c, idx) => {
      const titleEl = c.querySelector('.v-prompt-title');
      if (titleEl) titleEl.textContent = `Prompt #${idx + 1}`;
    });
  }

  function addPromptCard(text = '') {
    const grid = panel.querySelector('#v-prompts-grid');
    const emptyState = panel.querySelector('#v-empty-state');
    if (emptyState) emptyState.style.display = 'none';

    const id = ++promptIdCounter;
    const displayIndex = promptCards.length + 1;
    const card = document.createElement('div');
    card.className = 'v-prompt-card bg-primary rounded-xl border border-border-color p-3 flex flex-col';
    card.dataset.pid = id;

    card.style.cssText = 'aspect-ratio:3/2;display:flex;flex-direction:column;min-height:0;';

    card.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <div style="display:inline-flex;align-items:center;gap:8px;min-width:0;">
          <input type="checkbox" class="v-prompt-check accent-[#7c3aed]" data-pid="${id}" style="width:14px;height:14px;cursor:pointer;margin:0;flex-shrink:0;" />
          <svg style="width:15px;height:15px;color:#94a3b8;flex-shrink:0;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
          <span class="v-prompt-title" style="font-weight:600;font-size:12px;color:#f1f5f9;white-space:nowrap;">Prompt #${displayIndex}</span>
        </div>
        <div style="display:inline-flex;align-items:center;gap:6px;color:#cbd5e1;flex-shrink:0;">
          <button class="v-btn-play" title="${isEn ? 'Preview / Run' : 'Nghe thử / Chạy'}" style="width:24px;height:24px;border-radius:6px;border:none;background:transparent;color:#cbd5e1;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0;" onmouseover="this.style.background='rgba(255,255,255,0.08)';this.style.color='#ffffff'" onmouseout="this.style.background='transparent';this.style.color='#cbd5e1'">
            <svg style="width:14px;height:14px;fill:currentColor;" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
          </button>
          <button class="v-btn-copy" title="${isEn ? 'Copy text' : 'Sao chép'}" style="width:24px;height:24px;border-radius:6px;border:none;background:transparent;color:#cbd5e1;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0;" onmouseover="this.style.background='rgba(255,255,255,0.08)';this.style.color='#ffffff'" onmouseout="this.style.background='transparent';this.style.color='#cbd5e1'">
            <svg style="width:14px;height:14px;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
          </button>
          <button class="v-btn-edit" title="${isEn ? 'Edit' : 'Chỉnh sửa'}" style="width:24px;height:24px;border-radius:6px;border:none;background:transparent;color:#cbd5e1;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0;" onmouseover="this.style.background='rgba(255,255,255,0.08)';this.style.color='#ffffff'" onmouseout="this.style.background='transparent';this.style.color='#cbd5e1'">
            <svg style="width:14px;height:14px;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>
          </button>
          <button class="v-btn-del" title="${isEn ? 'Delete' : 'Xóa'}" style="width:24px;height:24px;border-radius:6px;border:none;background:transparent;color:#cbd5e1;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0;" onmouseover="this.style.background='rgba(239,68,68,0.18)';this.style.color='#f87171'" onmouseout="this.style.background='transparent';this.style.color='#cbd5e1'">
            <svg style="width:14px;height:14px;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
      </div>
      <textarea class="flex-1 w-full bg-secondary border border-border-color rounded-lg p-2 text-xs text-light resize-none" placeholder="${isEn ? 'Enter content...' : 'Nhập nội dung...'}" style="min-height:40px;"></textarea>
      <div class="v-audio-preview" style="display:none;margin-top:6px;">
        <audio controls style="width:100%;height:28px;border-radius:6px;"></audio>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:8px;padding-top:2px;font-size:11px;">
        <span class="v-char-count" style="color:#94a3b8;white-space:nowrap;">${text.length} ${isEn ? 'chars' : 'ký tự'}</span>
        <div style="display:inline-flex;align-items:center;gap:6px;white-space:nowrap;">
          <span style="color:#94a3b8;">${isEn ? 'Status:' : 'Trạng thái:'}</span>
          <span class="v-status" style="display:inline-flex;align-items:center;gap:5px;padding:2px 10px;border-radius:9999px;font-size:11px;font-weight:500;background:rgba(148,163,184,0.15);color:#cbd5e1;border:1px solid rgba(148,163,184,0.25);">
            <span style="font-size:8px;line-height:1;">●</span>
            <span>${isEn ? 'Not run' : 'Chưa chạy'}</span>
          </span>
        </div>
      </div>
    `;

    grid.appendChild(card);
    const textareaEl = card.querySelector('textarea');
    if (text) textareaEl.value = text;
    const charCountEl = card.querySelector('.v-char-count');
    textareaEl.addEventListener('input', () => {
      if (charCountEl) {
        charCountEl.textContent = `${textareaEl.value.length} ${isEn ? 'chars' : 'ký tự'}`;
      }
    });
    card.querySelector('.v-btn-play').addEventListener('click', () => previewSingle(id));
    card.querySelector('.v-btn-copy').addEventListener('click', () => {
      const val = textareaEl.value || '';
      if (!val) {
        toast(isEn ? 'Nothing to copy' : 'Chưa có nội dung để sao chép', 'info');
        return;
      }
      navigator.clipboard?.writeText(val);
      toast(isEn ? 'Copied to clipboard!' : 'Đã sao chép nội dung!', 'success');
    });
    card.querySelector('.v-btn-edit').addEventListener('click', () => {
      textareaEl.focus();
      textareaEl.setSelectionRange(textareaEl.value.length, textareaEl.value.length);
    });
    card.querySelector('.v-btn-del').addEventListener('click', () => {
      card.remove();
      promptCards = promptCards.filter(c => c.id !== id);
      renumberPromptCards();
      updateStats();
      if (promptCards.length === 0 && emptyState) emptyState.style.display = '';
    });
    promptCards.push({ id, status: 'idle' });
    updateStats();
  }

  function deleteSelected() {
    const grid = panel.querySelector('#v-prompts-grid');
    const emptyState = panel.querySelector('#v-empty-state');
    const allCards = Array.from(grid.querySelectorAll('.v-prompt-card'));
    const checkedCards = allCards.filter(card => {
      const cb = card.querySelector('.v-prompt-check');
      return cb && cb.checked;
    });
    const targetCards = checkedCards.length > 0 ? checkedCards : allCards;
    targetCards.forEach(card => {
      const id = parseInt(card.dataset.pid);
      card.remove();
      promptCards = promptCards.filter(c => c.id !== id);
    });
    const selectAllCb = panel.querySelector('#vSelectAll');
    if (selectAllCb) selectAllCb.checked = false;
    renumberPromptCards();
    updateStats();
    if (promptCards.length === 0 && emptyState) emptyState.style.display = '';
  }

  // ============================================================
  // Import TXT — one file = one card (clear old cards first)
  // ============================================================
  function handleImportTxt() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt';
    input.multiple = true;
    input.onchange = () => {
      const files = Array.from(input.files);
      if (files.length === 0) return;

      // Clear old cards first
      const grid = panel.querySelector('#v-prompts-grid');
      grid.querySelectorAll('.v-prompt-card').forEach(c => c.remove());
      promptCards = [];
      promptIdCounter = 0;
      completedCount = 0;
      failCount = 0;

      files.forEach(file => {
        const reader = new FileReader();
        reader.onload = (e) => {
          const text = e.target.result.trim();
          if (text) addPromptCard(text);
        };
        reader.onloadend = () => {
          if (files.indexOf(file) === files.length - 1) {
            toast(`✅ Đã import ${files.length} file TXT`, 'success');
          }
        };
        reader.readAsText(file);
      });
    };
    input.click();
  }

  // ============================================================
  // Run all prompts
  // ============================================================
  async function runAll() {
    // Check if package is missing or expired
    if (isVoiceSubscriptionInvalid()) {
      toast(isEn ? 'Your subscription has expired or is not active. Please upgrade!' : 'Gói đăng ký của bạn đã hết hạn hoặc chưa kích hoạt. Vui lòng nâng cấp để sử dụng tính năng này!', 'error');
      return;
    }

    const voiceCode = panel.querySelector('#vVoice').value;
    if (!voiceCode) { toast(isEn ? 'Select voice first!' : 'Chọn giọng nói trước!', 'error'); return; }

    const cards = panel.querySelectorAll('.v-prompt-card');
    if (cards.length === 0) { toast(isEn ? 'No prompt!' : 'Chưa có prompt!', 'error'); return; }

    completedCount = 0;
    failCount = 0;

    const tasks = [];
    cards.forEach(card => {
      const text = card.querySelector('textarea').value.trim();
      if (!text) return;
      const pid = parseInt(card.dataset.pid);
      tasks.push({ pid, text, voiceCode });
    });

    if (tasks.length === 0) { toast(isEn ? 'No text to generate!' : 'Không có text để tạo!', 'error'); return; }

    // Toggle buttons: hide RunAll, show Stop
    const btnRunAll = panel.querySelector('#vBtnRunAll');
    const btnStop = panel.querySelector('#vBtnStop');
    const btnAdd = panel.querySelector('#vBtnAddPrompt');
    const btnImport = panel.querySelector('#vBtnImportTxt');
    const btnDelete = panel.querySelector('#vBtnDeleteSelected');
    stopRequested = false;
    btnRunAll.style.opacity = '0.5';
    btnRunAll.style.pointerEvents = 'none';
    btnStop.classList.add('show');
    if (btnAdd) { btnAdd.disabled = true; btnAdd.classList.add('opacity-50','cursor-not-allowed'); }
    if (btnImport) { btnImport.disabled = true; btnImport.classList.add('opacity-50','cursor-not-allowed'); }
    if (btnDelete) { btnDelete.disabled = true; btnDelete.classList.add('opacity-50','cursor-not-allowed'); }

    setRunOverallStatus('running');
    updateStats();

    const maxThreads = parseInt(panel.querySelector('#vMaxThreads').value) || 3;
    const options = {
      rate: panel.querySelector('#vRate').value,
      volume: panel.querySelector('#vVolume').value,
      pitch: panel.querySelector('#vPitch').value,
    };

    // Process with concurrency limit
    let idx = 0;
    async function worker() {
      while (idx < tasks.length && !stopRequested) {
        const task = tasks[idx++];
        const card = panel.querySelector(`[data-pid="${task.pid}"]`);
        if (!card) continue;
        setCardStatus(task.pid, 'processing');

        try {
          let r;
          if (panel.querySelector('#vBackend').value === 'kinxts') {
            const selVal = panel.querySelector('#vVoice').value;
            if (selVal.startsWith('clone:')) {
              const ref = await window.electronAPI.kinxtsVoiceRef({ id: selVal.slice(6) });
              r = await window.electronAPI.kinxtsClone({ text: task.text, refAudioPath: ref.refAudioPath, denoise: true, temperature: 1.0 });
            } else {
              r = await window.electronAPI.kinxtsTts({ text: task.text, voice: selVal, temperature: 1.0 });
            }
          } else {
            r = await window.electronAPI.ttsGenerate({ text: task.text, voiceCode: task.voiceCode, options });
          }
          if (r && r.success) {
            setCardStatus(task.pid, 'done', r.fileName);
            completedCount++;
            // Show audio preview in card
            showCardAudio(task.pid, r.filePath, r.fileName);
          } else {
            setCardStatus(task.pid, 'error', (r && r.error) || (isEn ? 'Error' : 'Lỗi'));
            failCount++;
          }
        } catch (e) {
          setCardStatus(task.pid, 'error', e.message);
          failCount++;
        }
        updateStats();
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(maxThreads, tasks.length); i++) workers.push(worker());
    await Promise.all(workers);

    // Re-enable buttons: show RunAll, hide Stop
    btnRunAll.style.opacity = '1';
    btnRunAll.style.pointerEvents = '';
    btnStop.classList.remove('show');
    if (btnAdd) { btnAdd.disabled = false; btnAdd.classList.remove('opacity-50','cursor-not-allowed'); }
    if (btnImport) { btnImport.disabled = false; btnImport.classList.remove('opacity-50','cursor-not-allowed'); }
    if (btnDelete) { btnDelete.disabled = false; btnDelete.classList.remove('opacity-50','cursor-not-allowed'); }

    updateStats();
    setRunOverallStatus(failCount > 0 ? 'error' : 'done');

    const stopMsg = stopRequested ? ' (đã dừng)' : '';
    toast(`✅ Đã xử lý xong: ${completedCount} thành công, ${failCount} thất bại${stopMsg}`, completedCount > 0 ? 'success' : 'error');
  }

  // ============================================================
  // Preview single card
  // ============================================================
  async function previewSingle(id) {
    // Check if package is missing or expired
    if (isVoiceSubscriptionInvalid()) {
      toast(isEn ? 'Your subscription has expired or is not active. Please upgrade!' : 'Gói đăng ký của bạn đã hết hạn hoặc chưa kích hoạt. Vui lòng nâng cấp để sử dụng tính năng này!', 'error');
      return;
    }

    const card = panel.querySelector(`[data-pid="${id}"]`);
    if (!card) return;
    const text = card.querySelector('textarea').value.trim();
    if (!text) { toast(isEn ? 'Enter text first!' : 'Nhập text trước!', 'error'); return; }
    const voiceCode = panel.querySelector('#vVoice').value;
    if (!voiceCode) { toast('Chọn giọng trước!', 'error'); return; }
    setCardStatus(id, 'processing');
    try {
      let r;
      if (panel.querySelector('#vBackend').value === 'kinxts') {
        const selVal = panel.querySelector('#vVoice').value;
        if (selVal.startsWith('clone:')) {
          const ref = await window.electronAPI.kinxtsVoiceRef({ id: selVal.slice(6) });
          r = await window.electronAPI.kinxtsClone({ text: text.substring(0, 500), refAudioPath: ref.refAudioPath, denoise: true, temperature: 1.0 });
        } else {
          r = await window.electronAPI.kinxtsTts({ text: text.substring(0, 500), voice: selVal, temperature: 1.0 });
        }
      } else {
        r = await window.electronAPI.ttsPreview({ text: text.substring(0, 500), voiceCode });
      }
      if (r && r.success && r.filePath) {
        setCardStatus(id, 'done', r.fileName || 'preview.mp3');
        showCardAudio(id, r.filePath, r.fileName || 'preview.mp3');
      } else {
        setCardStatus(id, 'error', (r && r.error) || (isEn ? 'Error' : 'Lỗi'));
      }
    } catch (e) {
      setCardStatus(id, 'error', e.message);
      toast(isEn ? 'Error: ' : 'Lỗi: ' + e.message, 'error');
    }
    updateStats();
  }

  // ============================================================
  // Show audio player inside a prompt card
  // ============================================================
  function showCardAudio(id, filePath, fileName) {
    const card = panel.querySelector(`[data-pid="${id}"]`);
    if (!card) return;
    const preview = card.querySelector('.v-audio-preview');
    if (!preview) return;
    const audio = preview.querySelector('audio');
    audio.src = 'file:///' + filePath.replace(/\\/g, '/');
    preview.style.display = 'block';
    // Don't auto-play — user clicks play button manually
  }

  // ============================================================
  // Card status helper
  // ============================================================
  function setCardStatus(id, status, info) {
    const card = panel.querySelector(`[data-pid="${id}"]`);
    if (!card) return;
    const badge = card.querySelector('.v-status');
    const map = {
      idle: {
        bg: 'rgba(148,163,184,0.15)',
        border: 'rgba(148,163,184,0.25)',
        color: '#cbd5e1',
        html: `<span style="font-size:8px;line-height:1;">●</span><span>${isEn ? 'Not run' : 'Chưa chạy'}</span>`,
      },
      processing: {
        bg: 'rgba(59,130,246,0.15)',
        border: 'rgba(59,130,246,0.35)',
        color: '#60a5fa',
        html: `<span style="font-size:10px;line-height:1;">⏳</span><span>${isEn ? 'Running...' : 'Đang chạy...'}</span>`,
      },
      done: {
        bg: 'rgba(16,185,129,0.15)',
        border: 'rgba(16,185,129,0.35)',
        color: '#34d399',
        html: `<span style="font-size:10px;line-height:1;">✓</span><span>${isEn ? 'Done' : 'Hoàn thành'}</span>`,
      },
      error: {
        bg: 'rgba(239,68,68,0.15)',
        border: 'rgba(239,68,68,0.35)',
        color: '#f87171',
        html: `<span style="font-size:10px;line-height:1;">✕</span><span>${isEn ? 'Failed' : 'Thất bại'}</span>`,
      },
    };
    const s = map[status] || map.idle;
    if (badge) {
      badge.style.background = s.bg;
      badge.style.borderColor = s.border;
      badge.style.color = s.color;
      badge.innerHTML = s.html;
      if (status === 'error' && info) {
        badge.setAttribute('title', info);
      } else {
        badge.removeAttribute('title');
      }
    }

    const p = promptCards.find(p => p.id === id);
    if (p) p.status = status;
  }

  function setRunOverallStatus(state) {
    if (!panel) return;
    const statusEl = panel.querySelector('#vStatRunStatus');
    if (!statusEl) return;
    if (state === 'running') {
      statusEl.style.color = '#60a5fa';
      statusEl.style.fontWeight = '600';
      statusEl.innerHTML = `<span style="display:inline-block;width:7px;height:7px;border-radius:9999px;background:#60a5fa;"></span><span>${isEn ? 'Processing...' : 'Đang chạy...'}</span>`;
    } else if (state === 'done') {
      statusEl.style.color = '#34d399';
      statusEl.style.fontWeight = '600';
      statusEl.innerHTML = `<span>✓</span><span>${isEn ? 'Completed' : 'Hoàn tất'}</span>`;
    } else if (state === 'error') {
      statusEl.style.color = '#fbbf24';
      statusEl.style.fontWeight = '600';
      statusEl.innerHTML = `<span>⚠</span><span>${isEn ? 'Finished with errors' : 'Có lỗi'}</span>`;
    } else {
      statusEl.style.color = '#cbd5e1';
      statusEl.style.fontWeight = '500';
      statusEl.innerHTML = `<span style="display:inline-block;width:7px;height:7px;border-radius:9999px;background:#94a3b8;"></span><span>${isEn ? 'Ready' : 'Sẵn sàng'}</span>`;
    }
  }

  function updateStats() {
    if (!panel) return;
    const total = promptCards.length;
    const doneNum = promptCards.filter(p => p.status === 'done').length;
    const failNum = promptCards.filter(p => p.status === 'error').length;
    completedCount = doneNum;
    failCount = failNum;
    const elTotal = panel.querySelector('#vStatTotal');
    const elTotalNum = panel.querySelector('#vStatTotalNum');
    const elDone = panel.querySelector('#vStatDone');
    const elFail = panel.querySelector('#vStatFail');
    const elWarn = panel.querySelector('#vStatWarn');
    if (elTotal) elTotal.textContent = total;
    if (elTotalNum) elTotalNum.textContent = total;
    if (elDone) elDone.textContent = doneNum;
    if (elFail) elFail.textContent = failNum;
    if (elWarn) elWarn.textContent = failNum;
  }

  // ============================================================
  // Output dir
  // ============================================================
  async function handleChangeDir() {
    const dir = await window.electronAPI.ttsSetOutputDir();
    if (dir) { panel.querySelector('#vOutputDir').textContent = dir; toast(isEn ? 'Output folder changed!' : 'Đã đổi thư mục!', 'success'); }
  }
  async function handleOpenDir() { await window.electronAPI.ttsOpenOutputDir(); }

  // ============================================================
  // Toast (glassmorphism, matches main app)
  // ============================================================
  function toast(msg, type = 'info') {
    const icons = {
      success: '<svg class="w-6 h-6 text-green-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
      error:   '<svg class="w-6 h-6 text-red-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
      info:    '<svg class="w-6 h-6 text-blue-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
    };
    const container = document.getElementById('voice-toast-container') || (() => {
      const c = document.createElement('div');
      c.id = 'voice-toast-container';
      c.style.cssText = 'position:fixed;top:20px;right:20px;z-index:99999;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
      document.body.appendChild(c);
      return c;
    })();
    const t = document.createElement('div');
    t.style.cssText = 'pointer-events:auto;display:flex;align-items:start;max-width:360px;width:100%;padding:14px 16px;background:rgba(255,255,255,0.10);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.20);border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,0.3);opacity:1;transform:translateX(0);transition:all 0.3s ease-out;color:#f1f5f9;font-family:Inter,sans-serif;';
    t.innerHTML = `
      ${icons[type] || icons.info}
      <div style="margin-left:12px;flex:1;min-width:0;">
        <p style="font-size:13px;font-weight:500;line-height:1.4;white-space:pre-wrap;">${msg}</p>
      </div>
      <button style="margin-left:12px;flex-shrink:0;background:none;border:none;cursor:pointer;color:#94a3b8;padding:2px;border-radius:4px;transition:color 0.15s;" onmouseover="this.style.color='#f1f5f9'" onmouseout="this.style.color='#94a3b8'">
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
      </button>`;
    const close = () => { t.style.opacity = '0'; t.style.transform = 'translateX(16px)'; setTimeout(() => t.remove(), 300); };
    t.querySelector('button').addEventListener('click', close);
    container.appendChild(t);
    setTimeout(close, 3000);
  }

  // ============================================================
  // Tabs + Voice Library
  // ============================================================
  function switchTab(which) {
    const create = which === 'create';
    const conversation = which === 'conversation';
    const str = which === 'str';
    const library = !create && !conversation && !str;
    panel.querySelector('#vCreateTab').style.display = create ? 'flex' : 'none';
    panel.querySelector('#vLibraryTab').style.display = library ? 'flex' : 'none';
    panel.querySelector('#vConversationTab').style.display = conversation ? 'flex' : 'none';
    panel.querySelector('#vStrTab').style.display = str ? 'flex' : 'none';
    const tabs = [
      ['#vTabCreate', create],
      ['#vTabLibrary', library],
      ['#vTabConversation', conversation],
      ['#vTabStr', str]
    ];
    tabs.forEach(([sel, active]) => {
      const btn = panel.querySelector(sel);
      btn.style.background = active ? '#1e293b' : '#0f172a';
      btn.style.color = active ? '#f1f5f9' : '#94a3b8';
    });
    if (library) renderLib();
    if (conversation) setupConversationTab();
    if (str) setupStrTab();
    // Auto-stop running generation when switching away
    if (!str && strRunning) { strRunning = false; if (strAbortController) strAbortController.abort(); }
  }

  function setupLibDrop() {
    const drop = panel.querySelector('#vLibDrop');
    const ref = panel.querySelector('#vLibRef');
    const name = panel.querySelector('#vLibName2');
    if (!drop || !ref) return;
    drop.onclick = () => ref.click();
    ref.onchange = () => { if (ref.files[0]) name.textContent = '✅ ' + ref.files[0].name; };
    ['dragover','dragenter'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('drag'); }));
    ['dragleave','drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('drag'); }));
    drop.ondrop = e => {
      const f = e.dataTransfer.files[0];
      if (f) { const dt = new DataTransfer(); dt.items.add(f); ref.files = dt.files; name.textContent = '✅ ' + f.name; }
    };
  }

  async function saveLibVoice() {
    const ref = panel.querySelector('#vLibRef').files[0];
    const nameVal = panel.querySelector('#vLibName').value.trim();
    if (!ref) { toast(isEn ? 'Choose a sample audio first' : 'Chọn file audio mẫu trước', true); return; }
    if (!nameVal) { toast(isEn ? 'Enter a voice name' : 'Nhập tên giọng', true); return; }
    const dur = await new Promise(res => {
      const a = document.createElement('audio');
      a.onloadedmetadata = () => res(a.duration || 0);
      a.onerror = () => res(0);
      a.src = URL.createObjectURL(ref);
    });
    if (dur > 6) { toast(isEn ? 'Sample must be ≤ 6s (got ' + dur.toFixed(1) + 's)' : 'File mẫu phải ≤ 6s (hiện ' + dur.toFixed(1) + 's)', true); return; }
    const btn = panel.querySelector('#vBtnLibSave');
    btn.disabled = true; btn.textContent = '⏳ …';
    try {
      const b64 = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result.split(',')[1]); fr.readAsDataURL(ref); });
      const r = await window.electronAPI.kinxtsSaveVoice({ name: nameVal, refAudioBase64: b64 });
      if (r && r.id) {
        panel.querySelector('#vLibName').value = '';
        panel.querySelector('#vLibName2').textContent = '📁 ' + (isEn ? 'Drop sample or click' : 'Thả file mẫu hoặc click');
        panel.querySelector('#vLibRef').value = '';
        toast(isEn ? 'Voice saved: ' : 'Đã lưu giọng: ' + r.name);
        renderLib();
        if (panel.querySelector('#vBackend').value === 'kinxts') loadKinxtsVoices();
      } else throw new Error(r && r.error || 'save failed');
    } catch (e) {
      toast(isEn ? 'Save error: ' : 'Lỗi lưu: ' + e.message, true);
    } finally { btn.disabled = false; btn.textContent = '💾 ' + (isEn ? 'Save voice' : 'Lưu giọng'); }
  }

  async function renderLib() {
    const grid = panel.querySelector('#vLibGrid');
    if (!grid) return;
    let voices = [];
    try { voices = await window.electronAPI.kinxtsListVoices(); } catch (e) { console.error('[Lib] list error', e); }
    if (!voices.length) {
      grid.innerHTML = '<div class="col-span-full text-center py-12" style="color:#64748b;">' + (isEn ? 'No saved voices yet. Add one above.' : 'Chưa có giọng nào. Thêm giọng ở trên.') + '</div>';
      return;
    }
    grid.innerHTML = voices.map(v => `
      <div class="p-3 rounded-xl border border-border-color bg-secondary flex flex-col gap-2" style="border-color:#334155;">
        <div class="flex items-center gap-2">
          <span style="font-size:18px;">★</span>
          <span class="font-semibold text-light truncate" style="font-size:13px;">${v.name}</span>
        </div>
        <audio controls src="file:///${v.refAudioPath.replace(/\\\\/g, '/')}" style="height:30px;width:100%;"></audio>
        <button data-del="${v.id}" class="text-red-400 hover:text-red-300 text-xs font-semibold self-end">🗑️ ${isEn ? 'Delete' : 'Xóa'}</button>
      </div>`).join('');
    grid.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
      await window.electronAPI.kinxtsDeleteVoice({ id: b.getAttribute('data-del') });
      renderLib();
    }));
  }

  // ============================================================
  // Conversation tab logic
  // ============================================================
  let convSetupDone = false;
  let convCharacters = [];

  async function setupConversationTab() {
    // Populate voice dropdown from kinxts list-voices (library voices)
    const sel = panel.querySelector('#vConvVoice');
    if (!sel) return;
    const curVal = sel.value;
    let options = '';
    try {
      const voices = await window.electronAPI.kinxtsListVoices();
      (voices || []).forEach(v => {
        options += '<option value="clone:' + v.id + '">' + v.name + '</option>';
      });
    } catch (e) { console.error('[Conv] list-voices error', e); }
    // Also add kinxts built-in voices
    const backend = panel.querySelector('#vBackend');
    if (backend && backend.value === 'kinxts') {
      const vSel = panel.querySelector('#vVoice');
      if (vSel) {
        Array.from(vSel.options).forEach(o => {
          if (!o.value.startsWith('clone:')) {
            options += '<option value="' + o.value + '">' + o.text + '</option>';
          }
        });
      }
    }
    sel.innerHTML = options || '<option value="">' + (isEn ? 'No voices available' : 'Không có giọng') + '</option>';
    if (curVal) sel.value = curVal;

    // Conversation save-folder: populate current dir, wire change/open buttons
    const convDirEl = panel.querySelector('#vConvDir');
    const btnConvDir = panel.querySelector('#vBtnConvDir');
    const refreshConvDir = async () => {
      try {
        const dir = await window.electronAPI.kinxtsGetConvDir();
        if (convDirEl) {
          const parts = dir.replace(/\\/g, '/').split('/');
          convDirEl.textContent = parts[parts.length - 1] || dir;
          convDirEl.title = dir;
        }
      } catch (e) { console.error('[Conv] get-conv-dir error', e); }
    };
    refreshConvDir();
    if (btnConvDir) btnConvDir.onclick = async () => {
      try { await window.electronAPI.kinxtsSetConvDir(); await refreshConvDir(); } catch (e) { console.error('[Conv] set-conv-dir error', e); }
    };

    // Detect characters
    if (!convSetupDone) {
      panel.querySelector('#vBtnConvDetect').addEventListener('click', detectConvCharacters);
      panel.querySelector('#vBtnConvRun').addEventListener('click', runConversation);
      convSetupDone = true;
    }
  }

  function detectConvCharacters() {
    const text = panel.querySelector('#vConvScript').value.trim();
    if (!text) { toast(isEn ? 'Enter a script first' : 'Nhập kịch bản trước', 'error'); return; }
    const charSet = new Set();
    text.split('\n').forEach(line => {
      const m = line.trim().match(/^([^:：]+)[：:]/);
      if (m) charSet.add(m[1].trim());
    });
    convCharacters = Array.from(charSet);
    const mapEl = panel.querySelector('#vConvCharMap');
    const noChars = panel.querySelector('#vConvNoChars');
    if (convCharacters.length === 0) {
      mapEl.innerHTML = '';
      noChars.style.display = '';
      toast(isEn ? 'No characters detected. Use format: Name: dialogue' : 'Không phát hiện nhân vật. Dùng dạng: Tên: lời thoại', 'error');
      return;
    }
    noChars.style.display = 'none';

    // Get available voices for dropdown
    const voiceOpts = panel.querySelector('#vConvVoice').innerHTML;

    mapEl.innerHTML = convCharacters.map((ch, i) => {
      const selId = 'vConvChar_' + i;
      return `<div class="flex items-center gap-2 p-2 bg-primary rounded-lg border border-border-color">
        <span class="font-semibold text-light text-xs whitespace-nowrap">${ch}</span>
        <span class="text-dark-text">→</span>
        <select id="${selId}" class="flex-1 px-2 py-1 text-xs bg-primary border border-border-color rounded-lg outline-none text-light" style="height:30px;" data-char="${ch}">
          ${voiceOpts}
        </select>
      </div>`;
    }).join('');

    toast(isEn ? 'Detected ' + convCharacters.length + ' character(s)' : 'Phát hiện ' + convCharacters.length + ' nhân vật', 'success');
  }

  async function runConversation() {
    const script = panel.querySelector('#vConvScript').value.trim();
    if (!script) { toast(isEn ? 'Enter a script' : 'Nhập kịch bản', 'error'); return; }

    const statusEl = panel.querySelector('#vConvStatus');
    const player = panel.querySelector('#vConvPlayer');
    const btnRun = panel.querySelector('#vBtnConvRun');
    const temperature = parseFloat(panel.querySelector('#vConvTemp').value) || 1.0;
    const silenceDuration = parseFloat(panel.querySelector('#vConvPause').value) || 0.5;

    // Build speakers map
    const speakers = {};
    const defaultVoice = panel.querySelector('#vConvVoice').value;
    convCharacters.forEach((ch, i) => {
      const sel = panel.querySelector('#vConvChar_' + i);
      speakers[ch] = sel ? sel.value : defaultVoice;
    });

    btnRun.disabled = true;
    btnRun.innerHTML = '⏳ ' + (isEn ? 'Generating...' : 'Đang tạo...');
    statusEl.innerHTML = '⏳ ' + (isEn ? 'Generating conversation audio...' : 'Đang tạo audio hội thoại...');
    statusEl.style.color = '#fbbf24';
    player.style.display = 'none';

    try {
      const r = await window.electronAPI.kinxtsConversation({
        script, speakers, temperature, silenceDuration
      });
      if (r && r.success) {
        statusEl.innerHTML = '✅ ' + (isEn ? 'Saved! ' : 'Đã lưu! ') + r.fileName + (r.scriptName ? ' + ' + r.scriptName : '');
        statusEl.style.color = '#34d399';
        player.src = 'file:///' + r.filePath.replace(/\\\\/g, '/');
        player.style.display = 'block';
        player.play().catch(() => {});
      } else {
        throw new Error(r?.error || 'Unknown error');
      }
    } catch (e) {
      statusEl.innerHTML = '❌ ' + (isEn ? 'Error: ' : 'Lỗi: ') + e.message;
      statusEl.style.color = '#f87171';
      toast(isEn ? 'Conversation error: ' + e.message : 'Lỗi hội thoại: ' + e.message, 'error');
    } finally {
      btnRun.disabled = false;
      btnRun.innerHTML = '▶ ' + (isEn ? 'Generate' : 'Tạo Audio');
    }
  }

  // ============================================================
  // STR Tab — parse SRT → TTS per segment → merge with silence
  // ============================================================
  let strRunning = false;
  let strAbortController = null;

  function parseSrt(text) {
    const blocks = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n\n');
    const segments = [];
    for (const block of blocks) {
      const lines = block.trim().split('\n');
      if (lines.length < 2) continue;
      // Find timestamp line
      let tsLine = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('-->')) { tsLine = i; break; }
      }
      if (tsLine < 0) continue;
      const tsMatch = lines[tsLine].match(/(\d{2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,\.]\d{3})/);
      if (!tsMatch) continue;
      const toMs = (s) => {
        const p = s.replace(',', '.').split(':');
        return Math.round((parseInt(p[0]) * 3600 + parseInt(p[1]) * 60 + parseFloat(p[2])) * 1000);
      };
      const text = lines.slice(tsLine + 1).join(' ').trim().replace(/<[^>]+>/g, '');
      if (!text) continue;
      segments.push({
        idx: segments.length + 1,
        start: tsMatch[1],
        end: tsMatch[2],
        startMs: toMs(tsMatch[1]),
        endMs: toMs(tsMatch[2]),
        text
      });
    }
    return segments;
  }

  function setupStrTab() {
    // Populate voice dropdown — always use kinxts engine
    const sel = panel.querySelector('#vStrVoice');
    if (!sel) return;
    sel.innerHTML = '<option value="">' + (isEn ? 'Loading kinxts voices...' : 'Đang tải giọng kinxts...') + '</option>';
    loadStrVoices(sel);
    // File picker
    const fileInput = panel.querySelector('#vStrFileInput');
    const pickBtn = panel.querySelector('#vBtnStrPick');
    const nameEl = panel.querySelector('#vStrFileName');
    const previewWrap = panel.querySelector('#vStrPreviewWrap');
    const previewEl = panel.querySelector('#vStrPreview');
    const segCountEl = panel.querySelector('#vStrSegCount');
    pickBtn.onclick = () => fileInput.click();
    // Output folder picker
    const strConvDirEl = panel.querySelector('#vStrConvDir');
    const strBtnConvDir = panel.querySelector('#vBtnStrConvDir');
    const refreshStrConvDir = async () => {
      try {
        const dir = await window.electronAPI.kinxtsGetConvDir();
        if (strConvDirEl) {
          const parts = (dir || '').replace(/\\/g, '/').split('/').filter(Boolean);
          strConvDirEl.textContent = parts[parts.length - 1] || dir || '';
          strConvDirEl.title = dir || '';
        }
      } catch (e) { console.error('[STR] get-conv-dir error', e); }
    };
    refreshStrConvDir();
    if (strBtnConvDir) strBtnConvDir.onclick = async () => {
      try { await window.electronAPI.kinxtsSetConvDir(); await refreshStrConvDir(); } catch (e) { console.error('[STR] set-conv-dir error', e); }
    };
    fileInput.onchange = () => {
      const f = fileInput.files[0];
      nameEl.textContent = f ? f.name : (isEn ? 'Select .srt file...' : 'Chọn file .srt...');
      nameEl.style.color = f ? '#f1f5f9' : '#94a3b8';
      // Parse and preview SRT
      if (f) {
        f.text().then(txt => {
          const segs = parseSrt(txt);
          if (!segs.length) {
            previewWrap.style.display = 'none';
            return;
          }
          previewWrap.style.display = '';
          segCountEl.textContent = segs.length + ' ' + (isEn ? 'segments' : 'đoạn');
          previewEl.innerHTML = segs.map(s => {
            const bg = s.idx % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent';
            return '<div style="padding:4px 8px;background:' + bg + ';border-radius:4px;">'
              + '<span style="color:#f59e0b;">' + s.start + '</span> '
              + '<span style="color:#64748b;">→</span> '
              + '<span style="color:#f59e0b;">' + s.end + '</span> '
              + '<span style="color:#e2e8f0;margin-left:8px;">' + s.text + '</span>'
              + '</div>';
          }).join('');
        });
      } else {
        previewWrap.style.display = 'none';
      }
    };
    const btnRun = panel.querySelector('#vBtnStrRun');
    const btnStop = panel.querySelector('#vBtnStrStop');
    btnRun.onclick = runStr;
    btnStop.onclick = () => { strRunning = false; if (strAbortController) strAbortController.abort(); };
    btnStop.style.display = 'none';
  }

  async function loadStrVoices(sel) {
    try {
      // Real kinxts voices from API + saved clone voices from library
      const [vr, lib] = await Promise.all([
        fetch('http://127.0.0.1:7860/api/voices').then(r => r.json()).catch(() => ({ voices: [], default: '' })),
        (window.electronAPI.kinxtsListVoices ? window.electronAPI.kinxtsListVoices() : Promise.resolve([])).catch(() => []),
      ]);
      const preset = (vr.voices || []).map(v => typeof v === 'string' ? v : (v.ShortName || v.name));
      if (preset.length === 0 && (!lib || !lib.length)) {
        sel.innerHTML = '<option value="">' + (isEn ? 'No voices' : 'Không có giọng') + '</option>';
        return;
      }
      let html = '';
      if (lib && lib.length) {
        html += '<optgroup label="🎭 ' + (isEn ? 'Library (Clone)' : 'Thư viện (Clone)') + '">';
        lib.forEach(v => { html += '<option value="clone:' + v.id + '">' + v.name + '</option>'; });
        html += '</optgroup>';
      }
      html += '<optgroup label="🎵 ' + (isEn ? 'Kinxts Built-in' : 'Kinxts mặc định') + '">';
      preset.forEach(v => { html += '<option value="' + v + '">' + v + '</option>'; });
      html += '</optgroup>';
      sel.innerHTML = html;
    } catch (e) {
      console.error('[STR] loadStrVoices error', e);
      sel.innerHTML = '<option value="">' + (isEn ? 'Voice load error' : 'Lỗi tải giọng') + '</option>';
    }
  }

  async function runStr() {
    const fileInput = panel.querySelector('#vStrFileInput');
    const voiceSel = panel.querySelector('#vStrVoice');
    const tempEl = panel.querySelector('#vStrTemp');
    const statusEl = panel.querySelector('#vStrStatus');
    const progressWrap = panel.querySelector('#vStrProgress');
    const progressBar = panel.querySelector('#vStrProgressBar');
    const progressText = panel.querySelector('#vStrProgressText');
    const player = panel.querySelector('#vStrPlayer');
    const playerWrap = panel.querySelector('#vStrPlayerWrap');
    const btnRun = panel.querySelector('#vBtnStrRun');
    const btnStop = panel.querySelector('#vBtnStrStop');
    const statusWrap = panel.querySelector('#vStrStatusWrap');

    if (strRunning) return;
    if (!fileInput.files[0]) {
      toast(isEn ? 'Please select an .srt file' : 'Vui lòng chọn file .srt', 'error');
      return;
    }

    strRunning = true;
    strAbortController = new AbortController();
    btnRun.disabled = true;
    btnRun.innerHTML = '⏳ ' + (isEn ? 'Generating...' : 'Đang tạo...');
    btnRun.style.display = 'none';
    btnStop.style.display = 'inline-flex';
    statusWrap.style.display = 'block';
    progressWrap.style.display = 'block';
    progressBar.style.width = '0%';
    progressText.textContent = '';
    statusEl.innerHTML = '📄 ' + (isEn ? 'Parsing SRT...' : 'Đang phân tích SRT...');

    try {
      // Read SRT file
      const srtText = await fileInput.files[0].text();
      const segments = parseSrt(srtText);
      if (!segments.length) throw new Error(isEn ? 'No subtitle segments found' : 'Không tìm thấy đoạn phụ đề');

      statusEl.innerHTML = `📝 ${segments.length} ${isEn ? 'segments found' : 'đoạn được tìm thấy'}`;

      // Setup cancel button
      const voiceVal = voiceSel.value;
      const temp = parseFloat(tempEl.value) || 1.0;
      const outDir = await window.electronAPI.kinxtsGetConvDir();
      const fileBaseName = fileInput.files[0].name.replace(/\.srt$/i, '');

      // Generate TTS. Batch API (one request, one voice) gives consistent
      // timbre across segments — only for built-in voices (no clone batch).
      const ttsFiles = [];
      const isClone = voiceVal && voiceVal.startsWith('clone:');

      if (isClone) {
        const cloneId = voiceVal.slice(6);
        const voices = await window.electronAPI.kinxtsListVoices();
        const saved = voices.find(v => v.id === cloneId);
        if (!saved) throw new Error('Voice not found');
        try {
          // Single-pass: all segments in one /api/batch with the clone's ref
          // audio → one shared speaker embedding → locked timbre across timelaps.
          progressText.textContent = isEn ? 'Synthesizing all segments...' : 'Đang tạo tất cả đoạn...';
          statusEl.innerHTML = `🔊 ${isEn ? `Clone-synthesizing ${segments.length} segments with one shared voice...` : `Đang clone-synthesize ${segments.length} đoạn với một giọng chung...`}`;
          const batchRes = await window.electronAPI.kinxtsBatchTts({
            texts: segments.map(s => s.text),
            refAudioPath: saved.refAudioPath,
            temperature: temp,
          });
          if (!batchRes || !batchRes.success) throw new Error(isEn ? 'Batch clone failed' : 'Tạo batch clone thất bại');
          const byIndex = new Map(batchRes.results.map(r => [r.index, r]));
          for (let i = 0; i < segments.length; i++) {
            const hit = byIndex.get(i);
            if (hit) ttsFiles.push({ filePath: hit.filePath, startMs: segments[i].startMs, endMs: segments[i].endMs, text: segments[i].text });
          }
        } catch (err) {
          // Fallback: per-segment clone if batch+ref_audio unsupported
          console.warn('[STR] Batch+ref_audio failed, falling back to per-segment clone:', err.message);
          for (let i = 0; i < segments.length; i++) {
            if (!strRunning) throw new Error(isEn ? 'Stopped by user' : 'Đã dừng bởi người dùng');
            const seg = segments[i];
            progressText.textContent = `${i + 1}/${segments.length} — ${seg.start} → ${seg.end}`;
            statusEl.innerHTML = `🔊 ${isEn ? 'Cloning segment' : 'Tạo đoạn'} ${i + 1}/${segments.length}`;
            try {
              const r = await window.electronAPI.kinxtsClone({ text: seg.text, refAudioPath: saved.refAudioPath, denoise: true, temperature: temp });
              if (r && r.success) ttsFiles.push({ filePath: r.filePath, startMs: seg.startMs, endMs: seg.endMs, text: seg.text });
            } catch (err2) {
              console.warn(`[STR] Segment ${i + 1} failed:`, err2.message);
              statusEl.innerHTML = `⚠️ ${isEn ? 'Segment' : 'Đoạn'} ${i + 1}: ${err2.message}`;
            }
          }
        }
      } else {
        // Batch all segments in one request → uniform voice
        progressText.textContent = isEn ? 'Synthesizing all segments...' : 'Đang tạo tất cả đoạn...';
        statusEl.innerHTML = `🔊 ${isEn ? `Batch synthesizing ${segments.length} segments with one voice...` : `Đang tạo batch ${segments.length} đoạn với một giọng...`}`;
        const batchRes = await window.electronAPI.kinxtsBatchTts({
          texts: segments.map(s => s.text),
          voice: voiceVal,
          temperature: temp,
        });
        if (!batchRes || !batchRes.success) throw new Error(isEn ? 'Batch synthesis failed' : 'Tạo batch thất bại');
        const byIndex = new Map(batchRes.results.map(r => [r.index, r]));
        for (let i = 0; i < segments.length; i++) {
          const hit = byIndex.get(i);
          if (hit) ttsFiles.push({ filePath: hit.filePath, startMs: segments[i].startMs, endMs: segments[i].endMs, text: segments[i].text });
        }
      }

      if (!strRunning || !ttsFiles.length) throw new Error(isEn ? 'No audio generated' : 'Không tạo được audio');

      // Merge with timestamp-accurate silence
      progressBar.style.width = '95%';
      progressText.textContent = isEn ? 'Merging audio...' : 'Đang ghép audio...';
      statusEl.innerHTML = '🔗 ' + (isEn ? 'Merging audio with timeline silence...' : 'Đang ghép audio với khoảng lặng timeline...');

      const mergeResult = await window.electronAPI.kinxtsStrMergeAudio({
        segments: ttsFiles.map(f => ({ filePath: f.filePath, startMs: f.startMs, endMs: f.endMs })),
        outName: `str_${fileBaseName}_${Date.now()}.wav`
      });

      if (mergeResult && mergeResult.success) {
        progressBar.style.width = '100%';
        progressText.textContent = isEn ? 'Done!' : 'Hoàn thành!';
        const finalDuration = ttsFiles[ttsFiles.length - 1].endMs;
        const durMin = Math.floor(finalDuration / 60000);
        const durSec = ((finalDuration % 60000) / 1000).toFixed(1);
        statusEl.innerHTML = `✅ ${isEn ? 'Complete!' : 'Hoàn thành!'} ${ttsFiles.length} ${isEn ? 'segments, duration:' : 'đoạn, thời lượng:'} ${durMin}:${durSec.padStart(4, '0')}`;
        statusEl.style.color = '#4ade80';
        playerWrap.style.display = 'block';
        player.src = 'file:///' + mergeResult.filePath.replace(/\\\\/g, '/');
        player.style.display = 'block';
        player.play().catch(() => {});
        toast(isEn ? 'STR audio generated!' : 'Tạo audio STR thành công!', 'success');
      } else {
        throw new Error(mergeResult?.error || 'Merge failed');
      }
    } catch (e) {
      statusEl.innerHTML = '❌ ' + (isEn ? 'Error: ' : 'Lỗi: ') + e.message;
      statusEl.style.color = '#f87171';
      toast(isEn ? 'STR error: ' + e.message : 'Lỗi STR: ' + e.message, 'error');
    } finally {
      strRunning = false;
      strAbortController = null;
      btnRun.disabled = false;
      btnRun.innerHTML = '▶ ' + (isEn ? 'Generate' : 'Tạo Audio');
      btnRun.style.display = '';
      btnStop.style.display = 'none';
      btnRun.onclick = runStr;
    }
  }

  // ============================================================
  // Force uniform config-bar control heights (CSS build is missing
  // box-border / min-h-10 / max-h-10 / items-stretch)
  // ============================================================
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    #vConversationTab .config-row{display:flex;flex-wrap:wrap;align-items:stretch;gap:12px;}
    #vConversationTab .config-row > div{flex:1 1 180px;display:flex;flex-direction:column;gap:4px;}
    #vConversationTab .config-row select,
    #vConversationTab .config-row input,
    #vConversationTab .config-row button{
      box-sizing:border-box !important;
      height:40px !important;
      min-height:40px !important;
      max-height:40px !important;
      width:100% !important;
    }
    #vConversationTab .config-row button{display:flex;align-items:center;justify-content:center;}
    #vStrTab .config-row{display:flex;flex-wrap:wrap;align-items:stretch;gap:12px;}
    #vStrTab .config-row > div{flex:1 1 180px;min-width:180px;display:flex;flex-direction:column;gap:4px;}
    #vStrTab .config-row select,
    #vStrTab .config-row input,
    #vStrTab .config-row button{
      box-sizing:border-box !important;
      height:48px !important;
      min-height:48px !important;
      max-height:48px !important;
      width:100% !important;
      padding:0 12px !important;
      margin:0 !important;
      border-radius:10px !important;
    }
    #vStrTab .config-row select{appearance:none !important;-webkit-appearance:none !important;padding-right:32px !important;background-image:none !important;}
    #vStrTab .config-row button{display:flex;align-items:center;justify-content:center;padding:0 12px !important;}
    #vStrTab .config-row input[type=number]{-moz-appearance:textfield !important;}
    #vStrTab .config-row input[type=number]::-webkit-inner-spin-button,
    #vStrTab .config-row input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none !important;margin:0 !important;}
  `;
  document.head.appendChild(styleEl);

  // ============================================================
  // Init
  // ============================================================
  let sidebarObserver = null;
  let observedAside = null;
  let rootObserver = null;
  let rafPending = false;

  function attachSidebarObserver() {
    const aside = document.querySelector('aside');
    const navEl = document.querySelector('aside nav');
    if (!aside || !navEl) return;
    if (sidebarObserver && observedAside === aside) return;
    if (sidebarObserver) {
      try { sidebarObserver.disconnect(); } catch (e) {}
    }
    observedAside = aside;
    sidebarObserver = new MutationObserver(() => {
      const curNav = document.querySelector('aside nav');
      if (curNav && !curNav.querySelector('[data-voice-menu]')) {
        injectSidebarItem();
      } else {
        syncVoiceMenuState();
      }
      interceptSidebar();
    });
    sidebarObserver.observe(aside, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  }

  function ensureVoiceMenu() {
    const aside = document.querySelector('aside');
    if (!aside) {
      if (voiceActive) hideVoice();
      return false;
    }
    if (injectSidebarItem()) {
      interceptSidebar();
      attachSidebarObserver();
      return true;
    }
    return false;
  }

  function scheduleEnsureVoiceMenu() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      ensureVoiceMenu();
    });
  }

  function startVoiceMenuWatchers() {
    // Khởi tạo ngầm panel ngay khi mở app để tự động load danh sách giọng & trạng thái model
    try { createPanel(); } catch (e) {}
    ensureVoiceMenu();
    if (!rootObserver && document.body) {
      rootObserver = new MutationObserver(() => {
        const aside = document.querySelector('aside');
        if (!aside) {
          if (voiceActive) hideVoice();
          return;
        }
        const navEl = aside.querySelector('nav');
        if (navEl && (!navEl.querySelector('[data-voice-menu]') || observedAside !== aside || !aside.dataset.voiceInt)) {
          scheduleEnsureVoiceMenu();
        }
      });
      rootObserver.observe(document.body, { childList: true, subtree: true });
    }
    setInterval(ensureVoiceMenu, 1000);
  }

  // Subscribe to kinxts status broadcasts (bridge → renderer)
  if (window.electronAPI && window.electronAPI.receive) {
    window.electronAPI.receive('kinxts:status', updateKinxtsStatus);
    if (window.electronAPI.kinxtsStatus) {
      window.electronAPI.kinxtsStatus().then(updateKinxtsStatus).catch(() => {});
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      startVoiceMenuWatchers();
      setTimeout(ensureVoiceMenu, 300);
    });
  } else {
    startVoiceMenuWatchers();
    setTimeout(ensureVoiceMenu, 300);
  }
})();