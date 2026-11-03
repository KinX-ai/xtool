(function() {
    console.log('💉 Extension Check Script: Initialized');

    function init() {
        if (document.getElementById('extension-check-overlay')) return;

        const style = document.createElement('style');
        style.textContent = `
            #extension-check-overlay {
                position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
                background: rgba(0, 0, 0, 0.95); backdrop-filter: blur(10px);
                z-index: 2147483647; display: none; flex-direction: column;
                align-items: center; justify-content: center; font-family: 'Inter', sans-serif; color: #fff;
            }
            #extension-check-overlay.show { display: flex; }
            .extension-modal {
                background: #0a0a0a; border: 2px solid #FFD700;
                border-radius: 28px; padding: 40px; max-width: 550px; width: 90%;
                text-align: center; box-shadow: 0 40px 100px rgba(0,0,0,0.9);
            }
            .extension-modal h2 { margin: 0 0 10px; font-size: 28px; font-weight: 900; color: #FFD700; }
            .btn-download {
                display: inline-block; background: #FFD700; color: #000;
                padding: 16px 36px; border-radius: 14px; font-weight: 800;
                text-decoration: none; margin: 25px 0; cursor: pointer; border: none; font-size: 18px;
            }
            .instruction-img { width: 100%; border-radius: 14px; cursor: zoom-in; margin-top: 20px; }
            #fullscreen-img-overlay {
                position: fixed; top: 0; left: 0; width: 100%; height: 100%;
                background: rgba(0,0,0,0.98); z-index: 2147483647;
                display: none; align-items: center; justify-content: center;
            }
        `;
        document.head.appendChild(style);

        const overlay = document.createElement('div');
        overlay.id = 'extension-check-overlay';
        overlay.innerHTML = `
            <div class="extension-modal">
                <h2>CÀI ĐẶT EXTENSION</h2>
                <p style="color: #ccc;">Vui lòng cài đặt Extension để tiếp tục sử dụng Tool.</p>
                <div class="btn-download" id="ext-dl-btn">TẢI XUỐNG EXTENSION</div>
                <div style="text-align: left; background: rgba(255,255,255,0.05); padding: 20px; border-radius: 16px; font-size: 14px; line-height: 1.6;">
                    1. Bấm nút màu vàng để tải extension.<br>
                    2. Mở trình duyệt và truy cập: <b style="color: #FFD700">https://labs.google/fx/tools/flow</b><br>
                    3. Đăng nhập và giữ tab đó để giải Captcha.
                </div>
                <img src="https://tainguyenweb.com/extension.png" class="instruction-img" id="ext-instr-img">
            </div>
        `;
        document.body.appendChild(overlay);

        document.getElementById('ext-dl-btn').onclick = () => {
            if (window.electronAPI && window.electronAPI.openExternalLink) {
                window.electronAPI.openExternalLink('https://tai.tainguyenweb.com/z4iYCM');
            }
        };

        const fullOverlay = document.createElement('div');
        fullOverlay.id = 'fullscreen-img-overlay';
        fullOverlay.innerHTML = `<img src="https://tainguyenweb.com/extension.png" style="max-width: 96%; max-height: 96%;">`;
        document.body.appendChild(fullOverlay);
        document.getElementById('ext-instr-img').onclick = () => fullOverlay.style.display = 'flex';
        fullOverlay.onclick = () => fullOverlay.style.display = 'none';

        checkStatus();
    }

    async function checkStatus() {
        if (window.electronAPI && window.electronAPI.extensionCheckStatus) {
            try {
                const status = await window.electronAPI.extensionCheckStatus();
                const overlay = document.getElementById('extension-check-overlay');
                if (overlay) {
                    if (status.workerCount > 0) {
                        overlay.classList.remove('show');
                    } else {
                        overlay.classList.add('show');
                    }
                }
            } catch (e) {}
        }
        setTimeout(checkStatus, 3000);
    }

    init();
})();
