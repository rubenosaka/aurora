(function () {
  var preference = 'system';
  try {
    var stored = localStorage.getItem('aurora.theme');
    if (stored === 'light' || stored === 'dark' || stored === 'system') preference = stored;
  } catch {
    preference = 'system';
  }
  var systemIsDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  var resolved =
    preference === 'dark' || (preference === 'system' && systemIsDark) ? 'dark' : 'light';
  document.documentElement.dataset.theme = resolved;
})();
