async function exitApp() {
    try {
        if (window.electronAPI && window.electronAPI.exitApplication) {
            await window.electronAPI.exitApplication();
        } else {
            console.error('electronAPI không khả dụng');
        }
    } catch (err) {
        console.error('Lỗi thoát ứng dụng:', err);
    }
}

// Attach event listener khi document ready
document.addEventListener('DOMContentLoaded', function() {
    const exitBtn = document.getElementById('exitBtn');
    if (exitBtn) {
        exitBtn.addEventListener('click', exitApp);
    }
});
