/* apply theme before first paint (no flash); external file so the page works under a strict CSP */
(function () {
  var t = new URLSearchParams(location.search).get('theme');
  try { t = t || localStorage.getItem('cs.theme'); } catch (e) {}
  document.documentElement.dataset.theme = t || 'dark';
})();
