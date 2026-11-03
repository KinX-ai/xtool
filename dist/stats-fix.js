/**
 * Stats Hide Script
 * Completely hides the stats cards section from the dashboard.
 */
(function() {
  function hideStatsCards() {
    var cards = document.querySelectorAll('.card');
    if (!cards || cards.length === 0) return false;
    var statLabels = ['Tổng Video Đã Tạo', 'Total Videos Created', 'Video Thành Công', 'Successful Videos',
      'Video Tháng Này', 'Videos This Month', 'Video Hôm Nay', 'Videos Today'];
    var found = false;
    cards.forEach(function(card) {
      var labelDiv = card.querySelector('div');
      if (!labelDiv) return;
      var labelText = labelDiv.textContent.trim();
      if (statLabels.indexOf(labelText) !== -1) {
        card.style.display = 'none';
        found = true;
      }
    });
    if (found) {
      var grid = document.querySelector('[style*="repeat(4, 1fr)"]');
      if (grid) {
        var visibleChildren = 0;
        grid.childNodes.forEach(function(child) {
          if (child.style && child.style.display !== 'none') visibleChildren++;
        });
        if (visibleChildren === 0) grid.style.display = 'none';
      }
    }
    return found;
  }
  var attempt = 0;
  function tryHide() {
    if (attempt >= 120) return;
    attempt++;
    if (!hideStatsCards()) {
      setTimeout(tryHide, 500);
    }
  }
  setTimeout(tryHide, 1000);
  if (typeof MutationObserver !== 'undefined') {
    var observer = new MutationObserver(function() { hideStatsCards(); });
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    setTimeout(function() { observer.disconnect(); }, 60000);
  }
})();
