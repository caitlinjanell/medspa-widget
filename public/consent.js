// Cookie consent for Google Analytics (replaces Termly).
// Analytics loads only after the visitor clicks Accept. Browsers sending Global
// Privacy Control are treated as declined and never see the banner.
(function () {
  var GA_ID = 'G-SGQE8EDK4Q';
  var KEY = 'goldie-cookie-consent';

  function getChoice() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function setChoice(v) {
    try { localStorage.setItem(KEY, v); } catch (e) {}
  }

  function loadAnalytics() {
    if (window.__goldieGA) return;
    window.__goldieGA = true;
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', GA_ID, { anonymize_ip: true });
  }

  function removeBanner() {
    var b = document.getElementById('cookie-banner');
    if (b) b.remove();
  }

  function showBanner() {
    removeBanner();
    var b = document.createElement('div');
    b.id = 'cookie-banner';
    b.setAttribute('role', 'dialog');
    b.setAttribute('aria-label', 'Cookie preferences');
    b.innerHTML =
      '<p>We use optional analytics cookies (Google Analytics) to understand how visitors use our site. ' +
      'We never use them on the patient consultation widget. <a href="/cookies">Cookie Policy</a></p>' +
      '<div class="cb-btns"><button type="button" data-choice="declined">Decline</button>' +
      '<button type="button" data-choice="accepted" class="cb-accept">Accept</button></div>';
    var css = document.createElement('style');
    css.textContent =
      '#cookie-banner{position:fixed;left:16px;right:16px;bottom:16px;max-width:560px;margin:0 auto;z-index:9999;' +
      'background:#fff;color:#1a1a1a;border:1px solid rgba(0,0,0,.15);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.15);' +
      'padding:16px 18px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;gap:14px;align-items:center;flex-wrap:wrap}' +
      '#cookie-banner p{flex:1 1 260px;margin:0}#cookie-banner a{color:#3C3489}' +
      '#cookie-banner .cb-btns{display:flex;gap:8px}' +
      '#cookie-banner button{font:inherit;font-weight:600;padding:9px 16px;border-radius:8px;cursor:pointer;border:1px solid #3C3489;background:#fff;color:#3C3489}' +
      '#cookie-banner button.cb-accept{background:#3C3489;color:#fff}' +
      '#cookie-banner button:focus-visible{outline:2px solid #3C3489;outline-offset:2px}';
    b.appendChild(css);
    b.addEventListener('click', function (e) {
      var choice = e.target.getAttribute && e.target.getAttribute('data-choice');
      if (!choice) return;
      setChoice(choice);
      removeBanner();
      if (choice === 'accepted') loadAnalytics();
      else if (window.__goldieGA) location.reload(); // stop analytics already running on this page
    });
    document.body.appendChild(b);
  }

  // Footer "Cookie preferences" links call this
  window.openCookiePreferences = function (e) {
    if (e) e.preventDefault();
    showBanner();
  };

  function init() {
    if (navigator.globalPrivacyControl) return;
    var choice = getChoice();
    if (choice === 'accepted') loadAnalytics();
    else if (choice !== 'declined') showBanner();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
