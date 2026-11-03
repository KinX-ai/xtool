(function() {
    console.log('💉 Exit Button Handler: Initialized');

    // Function to attach exit button listener
    function attachExitButtonListener() {
        // Try to find exit button by multiple selectors
        const selectors = [
            '#exitBtn',
            '[id*="exit"]',
            '[class*="exit-btn"]',
            'button:contains("Thoát")',
            'button[data-action="exit"]'
        ];

        // Also try to find any button with "Thoát" or "Exit" text
        const buttons = document.querySelectorAll('button');
        for (let btn of buttons) {
            const text = btn.textContent.trim().toLowerCase();
            if (text.includes('thoát') || text.includes('exit') || text.includes('quit')) {
                attachListener(btn);
                console.log('✅ Exit button found and listener attached');
                return;
            }
        }

        console.log('ℹ️ Exit button not found, will check again later');
    }

    function attachListener(btn) {
        // Prevent multiple listeners
        if (btn.dataset.exitListenerAttached) {
            return;
        }

        btn.dataset.exitListenerAttached = 'true';

        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('🔴 Exit button clicked');

            try {
                // Call the exit application handler
                if (window.electronAPI && window.electronAPI.exitApplication) {
                    console.log('📤 Calling exitApplication()...');
                    await window.electronAPI.exitApplication();
                    console.log('✅ Exit application called');
                } else if (window.electronAPI && window.electronAPI.invoke) {
                    console.log('📤 Calling invoke("app:exit-application")...');
                    await window.electronAPI.invoke('app:exit-application');
                    console.log('✅ Exit application invoked');
                } else {
                    console.error('❌ electronAPI not available');
                }
            } catch (error) {
                console.error('❌ Error calling exit:', error);
            }
        });

        console.log('✅ Exit listener attached to button');
    }

    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', attachExitButtonListener);
    } else {
        attachExitButtonListener();
    }

    // Also check periodically (in case button is added dynamically)
    let checkCount = 0;
    const checkInterval = setInterval(() => {
        if (checkCount > 30) { // Stop after 30 seconds
            clearInterval(checkInterval);
            return;
        }
        checkCount++;
        attachExitButtonListener();
    }, 1000);

    // Listen for maintenance popup events
    if (window.electronAPI && window.electronAPI.onAppClosing) {
        window.electronAPI.onAppClosing((data) => {
            console.log('🔔 App closing event received:', data);
            // Show maintenance popup if available
            if (window.showMaintenancePopup) {
                window.showMaintenancePopup(data);
            }
        });
    }

    if (window.electronAPI && window.electronAPI.onEstimatedTimeUpdate) {
        window.electronAPI.onEstimatedTimeUpdate((data) => {
            console.log('⏱️ Estimated time update:', data.timeFormatted);
            // Update UI with estimated time if needed
            const timeElements = document.querySelectorAll('[data-time], [class*="time"]');
            for (let elem of timeElements) {
                if (elem.textContent.includes('--') || elem.textContent.includes('min') || elem.textContent.includes('giờ')) {
                    elem.textContent = `Thời gian: ${data.timeFormatted}`;
                    break;
                }
            }
        });
    }

    console.log('💉 Exit Button Handler: Setup Complete');
})();
