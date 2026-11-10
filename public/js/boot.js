// Runs before first paint (classic script in <head>): apply the saved theme so the page never
// flashes the wrong colours. Kept out of the HTML so the Content-Security-Policy can forbid inline scripts.
try {
  const t = (JSON.parse(localStorage.getItem('sdc.prefs') || '{}').theme) || 'system';
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
} catch (e) { document.documentElement.dataset.theme = 'dark'; }
if (window.desktop) document.documentElement.classList.add('desktop', 'platform-' + window.desktop.platform);
(function () {
  // Inside the tab bar each tab has its own session keys ("sdc.resume@<tab id>").
  var tab = new URLSearchParams(location.search).get('tab');
  if (tab && window.parent !== window) document.documentElement.classList.add('in-tab');
  try { if (sessionStorage.getItem(tab ? 'sdc.resume@' + tab : 'sdc.resume')) document.documentElement.classList.add('resuming'); } catch (e) {}
})();
