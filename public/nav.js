// nav.js — injected into every page
(function () {
  const page = location.pathname.split('/').pop().replace('.html', '') || 'index';
  const html = `
    <nav id="nav">
      <a href="index.html" class="nav-logo">
        <div class="nav-logo-icon">🧠</div>
        <div class="nav-logo-text">Cogni<span>Care</span></div>
      </a>
      <div class="nav-links">
        <a href="index.html"     class="nav-link" data-page="index">
          <span class="icon">⌂</span><span class="label">Dashboard</span>
        </a>
        <a href="patient.html"   class="nav-link" data-page="patient">
          <span class="icon">👤</span><span class="label">Patient View</span>
        </a>
        <a href="analyze.html"   class="nav-link" data-page="analyze">
          <span class="icon">🔍</span><span class="label">Analyze</span>
        </a>
        <a href="jsoninput.html" class="nav-link" data-page="jsoninput">
          <span class="icon">📋</span><span class="label">JSON Data</span>
        </a>
        <a href="reminders.html" class="nav-link" data-page="reminders">
          <span class="icon">🔔</span><span class="label">Reminders</span>
        </a>
        <a href="chat.html"      class="nav-link" data-page="chat">
          <span class="icon">💬</span><span class="label">AI Assistant</span>
        </a>
        <a href="caregiver.html" class="nav-link" data-page="caregiver">
          <span class="icon">📁</span><span class="label">Patients</span>
        </a>
      </div>
      <div class="nav-right">
        <div class="nav-status"><div class="nav-status-dot"></div>MONITORING</div>
      </div>
    </nav>`;
  document.body.insertAdjacentHTML('afterbegin', html);
  const active = document.querySelector(`.nav-link[data-page="${page}"]`);
  if (active) active.classList.add('active');
})();
