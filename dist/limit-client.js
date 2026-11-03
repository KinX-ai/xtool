(function() {
    console.log("[Limit-Client] Initializing limit client...");

        function getUserEmail() {
        const userStr = localStorage.getItem("currentUser") || localStorage.getItem("user") || localStorage.getItem("session") || localStorage.getItem("veo-suite-studio-state");
        if (userStr) {
            try {
                const parsed = JSON.parse(userStr);
                let email = parsed.email || parsed.username || parsed.id;
                if (!email && parsed.user) {
                    email = parsed.user.email || parsed.user.username || parsed.user.id;
                }
                if (!email && parsed.state) {
                    email = parsed.state.userEmail;
                }
                if (email) return email;
            } catch (e) {}
        }
        console.warn("[Limit-Client] No user email found.");
        return null;
    }

    function showLimitAlert() {
        const overlayId = 'veo-limit-alert-overlay';
        if (document.getElementById(overlayId)) return;

        const overlay = document.createElement('div');
        overlay.id = overlayId;
        overlay.style.cssText = "position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(15,23,42,0.85); z-index:999999; display:flex; align-items:center; justify-content:center; backdrop-filter:blur(8px); opacity: 0; transition: opacity 0.3s ease;";
        
        const box = document.createElement('div');
        box.style.cssText = "background:linear-gradient(145deg, #1e293b, #0f172a); padding:40px 30px; border-radius:20px; text-align:center; box-shadow:0 25px 50px -12px rgba(0,0,0,0.5); max-width:420px; width:90%; color:#f8fafc; border: 1px solid rgba(244, 63, 94, 0.3); transform: scale(0.9); transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);";
        
        const isEn = document.body.innerText.includes("Expiry Date") || document.body.innerText.includes("Current Plan");
        const title = isEn ? "Daily Limit Reached!" : "Đã Hết Lượt Tạo!";
        const desc = isEn ? "You have reached your daily generation limit.<br><br>Please come back tomorrow or <b>upgrade your plan</b> for unlimited access." : "Bạn đã sử dụng hết số lượt tạo video/ảnh trong ngày hôm nay.<br><br>Vui lòng quay lại vào ngày mai hoặc <b>nâng cấp gói</b> để sử dụng không giới hạn.";
        const btnText = isEn ? "Got it" : "Đã hiểu";
        box.innerHTML = `
            <h2 style="margin: 0 0 15px 0; font-size: 24px; font-weight: 700; color: #f43f5e; font-family: 'Inter', sans-serif;">${title}</h2>
            <p style="color: #94a3b8; font-size: 15px; margin-bottom: 30px; line-height: 1.6; font-family: 'Inter', sans-serif;">${desc}</p>
            <button id="veo-limit-close-btn" style="background: linear-gradient(135deg, #f43f5e, #e11d48); color:#fff; border:none; padding:12px 35px; border-radius:10px; font-size:16px; cursor:pointer; font-weight:600; font-family: 'Inter', sans-serif; transition: all 0.2s ease; box-shadow: 0 4px 15px rgba(225, 29, 72, 0.4);">${btnText}</button>
        `;
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        requestAnimationFrame(() => {
            overlay.style.opacity = '1';
            box.style.transform = 'scale(1)';
        });
        
        const btn = document.getElementById('veo-limit-close-btn');
        btn.onmouseover = () => btn.style.transform = 'translateY(-2px)';
        btn.onmouseout = () => btn.style.transform = 'translateY(0)';
        
        btn.onclick = () => {
            overlay.style.opacity = '0';
            box.style.transform = 'scale(0.9)';
            setTimeout(() => overlay.remove(), 300);
        };
    }

    function hideLimitAlert() {
        const overlay = document.getElementById('veo-limit-alert-overlay');
        if (overlay) {
            overlay.style.opacity = '0';
            if (overlay.firstChild) overlay.firstChild.style.transform = 'scale(0.9)';
            setTimeout(() => overlay.remove(), 300);
        }
    }

    let currentData = null;

    async function updateDashboardStats() {
        const email = getUserEmail();
        if (!email) return;
        try {
            const response = await fetch(`https://tainguyenweb.com/apiveo/limit.php?action=get_stats&email=${encodeURIComponent(email)}`);
            const data = await response.json();
            currentData = data;
            
            if (data.status === 'limit_reached') {
                showLimitAlert();
            } else {
                hideLimitAlert();
            }
            renderStatsUI();
        } catch (error) {
            console.error("[Limit-Client] Error fetching limit stats:", error);
        }
    }

        function renderStatsUI() {
        if (!currentData) return;
        const data = currentData;
        
        if (data.status === 'success' || data.status === 'limit_reached') {
            injectStatsUI(data.count, data.remaining, data.limit);
        } else {
            const existing = document.getElementById('veo-limit-stats-card');
            if (existing) existing.remove();
        }
    }

    function injectStatsUI(count, remaining, limit) {
        const statsId = 'veo-limit-stats-card';
        let statsCard = document.getElementById(statsId);
        
        if (!statsCard) {
            statsCard = document.createElement('div');
            statsCard.id = statsId;
            statsCard.style.cssText = "font-size: 13px; color: #94a3b8; margin-top: 4px; font-family: 'Inter', sans-serif; display: flex; align-items: center; gap: 15px; white-space: nowrap;";
            
            const isEn = document.body.innerText.includes("Expiry Date") || document.body.innerText.includes("Current Plan");
            const txtCount = isEn ? "Generated" : "Lượt tạo";
            const txtRem = isEn ? "Left" : "Còn";
            const isNearLimit = typeof remaining === 'number' && remaining <= 10;
            const mainColor = isNearLimit ? '#f43f5e' : '#38bdf8';
            const limitColor = isNearLimit ? '#f43f5e' : '#10b981';
            statsCard.innerHTML = `
                <div style="font-size: 14px;">${txtCount}: <strong style="color: ${mainColor};">${count}</strong> / <strong style="color: ${limitColor}; font-size: 15px;">${limit}</strong></div>
            `;
            
            let expiryNode = null;
            const spans = document.querySelectorAll('span, p, div');
            for (let i = spans.length - 1; i >= 0; i--) {
                const text = spans[i].textContent || "";
                if (spans[i].children.length === 0 && (text.includes('Ngày hết hạn') || text.includes('Expired') || text.includes('Expiry Date'))) {
                    const rect = spans[i].getBoundingClientRect();
                    if (rect.left < 300) {
                        expiryNode = spans[i];
                        break;
                    }
                }
            }

            if (expiryNode && expiryNode.parentNode) {
                expiryNode.parentNode.insertBefore(statsCard, expiryNode.nextSibling);
            } else {
                const upgradeBtns = document.querySelectorAll('button, a');
                let foundBtn = null;
                for (let btn of upgradeBtns) {
                    const text = btn.textContent || "";
                    if ((text.includes('Nâng cấp') || text.includes('Upgrade')) && btn.getBoundingClientRect().left < 300) {
                        foundBtn = btn;
                        break;
                    }
                }
                if (foundBtn && foundBtn.parentNode) {
                    foundBtn.parentNode.insertBefore(statsCard, foundBtn);
                } else {
                    statsCard.style.position = 'fixed';
                    statsCard.style.bottom = '20px';
                    statsCard.style.left = '20px';
                    statsCard.style.zIndex = '9999';
                    statsCard.style.background = 'rgba(15,23,42,0.95)';
                    statsCard.style.padding = '10px';
                    statsCard.style.borderRadius = '8px';
                    document.body.appendChild(statsCard);
                }
            }
        } else {
            const isEn = document.body.innerText.includes("Expiry Date") || document.body.innerText.includes("Current Plan");
            const txtCount = isEn ? "Generated" : "Lượt tạo";
            const txtRem = isEn ? "Left" : "Còn";
            const isNearLimit = typeof remaining === 'number' && remaining <= 10;
            const mainColor = isNearLimit ? '#f43f5e' : '#38bdf8';
            const limitColor = isNearLimit ? '#f43f5e' : '#10b981';
            statsCard.innerHTML = `
                <div style="font-size: 14px;">${txtCount}: <strong style="color: ${mainColor};">${count}</strong> / <strong style="color: ${limitColor}; font-size: 15px;">${limit}</strong></div>
            `;
            statsCard.style.display = 'flex';
            
            if (!statsCard.parentNode) {
                let expiryNode = null;
                const spans = document.querySelectorAll('span, p, div');
                for (let i = spans.length - 1; i >= 0; i--) {
                    const text = spans[i].textContent || "";
                    if (spans[i].children.length === 0 && (text.includes('Ngày hết hạn') || text.includes('Expired') || text.includes('Expiry Date'))) {
                        const rect = spans[i].getBoundingClientRect();
                        if (rect.left < 300) {
                            expiryNode = spans[i];
                            break;
                        }
                    }
                }
                if (expiryNode && expiryNode.parentNode) {
                    expiryNode.parentNode.insertBefore(statsCard, expiryNode.nextSibling);
                }
            }
        }
    }

    setTimeout(updateDashboardStats, 1000);
    setInterval(updateDashboardStats, 5000);
    setInterval(renderStatsUI, 2000);

    window.addEventListener('veo-generation-done', () => {
        console.log("[Limit-Client] Received generation done event, updating stats...");
        if (currentData && typeof currentData.count === 'number') {
            currentData.count++;
            if (typeof currentData.remaining === 'number') {
                currentData.remaining = Math.max(0, currentData.remaining - 1);
            }
            renderStatsUI();
        }
        updateDashboardStats();
    });
    window.addEventListener('veo-show-limit-alert', () => { showLimitAlert(); });
})();
