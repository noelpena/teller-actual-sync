const BASE_URL = 'http://localhost:8001';

document.addEventListener('DOMContentLoaded', function() {
  const form = document.getElementById('setup-form');
  const testButton = document.getElementById('test-connection');
  const saveButton = document.getElementById('save-config');
  const statusMessage = document.getElementById('status-message');
  const loading = document.getElementById('loading');

  // Helper functions
  function showLoading(message = 'Testing connection...') {
    loading.querySelector('p').textContent = message;
    loading.classList.remove('hidden');
    testButton.disabled = true;
    saveButton.disabled = true;
  }

  function hideLoading() {
    loading.classList.add('hidden');
    testButton.disabled = false;
    saveButton.disabled = false;
  }

  function showStatus(message, type = 'info') {
    statusMessage.textContent = message;
    statusMessage.className = `status-message ${type}`;
    statusMessage.classList.remove('hidden');

    // Auto-hide after 5 seconds for non-error messages
    if (type !== 'error') {
      setTimeout(() => {
        statusMessage.classList.add('hidden');
      }, 5000);
    }
  }

  function getFormData() {
    return {
      serverURL: document.getElementById('serverURL').value.trim(),
      password: document.getElementById('password').value,
      syncId: document.getElementById('syncId').value.trim(),
      accountId: document.getElementById('accountId').value.trim(),
      daysToSync: document.getElementById('daysToSync').value || '7',
      cronSchedule: document.getElementById('cronSchedule').value.trim() || '0 2 * * *'
    };
  }

  // Test connection to Actual Budget
  testButton.addEventListener('click', async function() {
    const formData = getFormData();

    // Validate required fields
    if (!formData.serverURL || !formData.password) {
      showStatus('Please fill in Server URL and Password', 'error');
      return;
    }

    showLoading('Testing connection to Actual Budget...');

    try {
      const response = await fetch(`${BASE_URL}/api/test/actual`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverURL: formData.serverURL,
          password: formData.password,
          syncId: formData.syncId || undefined
        })
      });

      const result = await response.json();

      if (result.success) {
        showStatus('✅ Successfully connected to Actual Budget!', 'success');
      } else {
        showStatus(`❌ Connection failed: ${result.error}`, 'error');
      }
    } catch (error) {
      showStatus(`❌ Connection test failed: ${error.message}`, 'error');
    } finally {
      hideLoading();
    }
  });

  // Save configuration
  form.addEventListener('submit', async function(e) {
    e.preventDefault();

    const formData = getFormData();

    // Validate required fields
    if (!formData.serverURL || !formData.password || !formData.syncId || !formData.accountId) {
      showStatus('Please fill in all required fields', 'error');
      return;
    }

    // Validate URL format
    try {
      new URL(formData.serverURL);
    } catch {
      showStatus('Invalid Server URL format. Include http:// or https://', 'error');
      return;
    }

    // Validate UUID format for IDs
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidPattern.test(formData.syncId)) {
      showStatus('Invalid Sync ID format. Should be a UUID.', 'error');
      return;
    }
    if (!uuidPattern.test(formData.accountId)) {
      showStatus('Invalid Account ID format. Should be a UUID.', 'error');
      return;
    }

    showLoading('Saving configuration...');

    try {
      const response = await fetch(`${BASE_URL}/api/setup/save-actual`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });

      const result = await response.json();

      if (result.success) {
        showStatus('✅ Configuration saved successfully! Redirecting...', 'success');

        // Redirect to admin after a brief delay
        setTimeout(() => {
          window.location.href = result.redirectTo || '/admin';
        }, 1500);
      } else {
        showStatus(`❌ Failed to save configuration: ${result.error}`, 'error');
        hideLoading();
      }
    } catch (error) {
      showStatus(`❌ Failed to save configuration: ${error.message}`, 'error');
      hideLoading();
    }
  });

  // Add tooltips on hover
  document.querySelectorAll('.tooltip').forEach(el => {
    el.addEventListener('mouseenter', function() {
      const title = this.getAttribute('title');
      if (title) {
        const tooltip = document.createElement('div');
        tooltip.className = 'tooltip-popup';
        tooltip.textContent = title;
        this.appendChild(tooltip);
      }
    });

    el.addEventListener('mouseleave', function() {
      const popup = this.querySelector('.tooltip-popup');
      if (popup) {
        popup.remove();
      }
    });
  });

  // Load existing config if available (for editing)
  async function loadExistingConfig() {
    try {
      const response = await fetch(`${BASE_URL}/api/config/status`);
      const status = await response.json();

      if (status.hasActualConfig) {
        // Config already exists, redirect to admin
        window.location.href = '/admin';
      }
    } catch (error) {
      console.error('Failed to check config status:', error);
    }
  }

  loadExistingConfig();
});
