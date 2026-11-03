// === KIỂM TRA BẢO TRÌ ===
async function checkMaintenance() {
  try {
    const axios = require("axios");
    const response = await axios.get("https://tainguyenweb.com/apiveo/baotri.php?api=1", { timeout: 5000 });
    const data = response.data;
    if (data && data.success && data.maintenance) {
      console.log("[Main] System is in maintenance mode, showing popup...");
      const maintenanceWindow = new he.BrowserWindow({
        width: 500,
        height: 400,
        center: true,
        frame: false,
        transparent: false,
        resizable: false,
        alwaysOnTop: true,
        show: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          preload: ye.join(__dirname, "preload.js")
        }
      });
      
      maintenanceWindow.loadFile(ye.join(__dirname, "..", "dist", "maintenance-popup.html")).catch(() => {
        console.log("[Main] Maintenance popup HTML not found, using fallback");
        maintenanceWindow.loadURL("data:text/html,<html><body style='background:#0f172a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:Arial'><div style='text-align:center;padding:40px'><h1>System Maintenance</h1><p>" + (data.message || "System is under maintenance") + "</p><button onclick=\"require('electron').remote.app.quit()\" style='padding:10px 20px;background:#ef4444;color:#fff;border:none;border-radius:5px;cursor:pointer;margin-top:20px'>Exit</button></div></body></html>");
      });
      
      return true;
    }
    return false;
  } catch (e) {
    console.log("[Main] Maintenance check error (ignoring):", e.message);
    return false;
  }
}
