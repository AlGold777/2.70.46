const statusEl = document.getElementById('status');
const selectorsContainer = document.getElementById('selectors');
const saveAllBtn = document.getElementById('save-all');
const addSelectorBtn = document.getElementById('add-selector');
const blocks = new Map();
let activeBlockId = null;
let selectorCounter = 1;

const setStatus = (message, state = 'idle') => {
  statusEl.textContent = message;
  statusEl.dataset.state = state;
};

const copyToClipboard = async (value) => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return true;
  }
  const temp = document.createElement('textarea');
  temp.value = value;
  temp.style.position = 'fixed';
  temp.style.opacity = '0';
  document.body.appendChild(temp);
  temp.select();
  const ok = document.execCommand('copy');
  temp.remove();
  return ok;
};

const downloadJson = (payload, filename) => {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

const stripProtocol = (url) => {
  if (!url) return '';
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
};

const formatSelectorName = (data) => {
  const base = data.baseName || data.query || `Selector ${selectorCounter}`;
  if (!data.url) return base;
  const trimmedUrl = stripProtocol(data.url);
  return trimmedUrl ? `${base} : ${trimmedUrl}` : base;
};

const isUserTabUrl = (url) => {
  if (!url) return false;
  const blocked = ['chrome://', 'chrome-extension://', 'edge://', 'about:'];
  return !blocked.some((prefix) => url.startsWith(prefix));
};

const getTargetTabId = () => new Promise((resolve, reject) => {
  chrome.tabs.query({ currentWindow: true }, (tabs) => {
    if (chrome.runtime.lastError) {
      reject(new Error(chrome.runtime.lastError.message));
      return;
    }
    const candidate = tabs.find((tab) => isUserTabUrl(tab.url));
    if (!candidate?.id) {
      reject(new Error('No eligible tab found'));
      return;
    }
    resolve(candidate.id);
  });
});

const sendToActiveTab = async (payload) => {
  const tabId = await getTargetTabId();
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, payload, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { success: true });
    });
  });
};

const createBlockElement = (data) => {
  const block = document.createElement('section');
  block.className = 'selector-block';
  block.dataset.id = data.id;

  block.innerHTML = `
    <div class="selector-toolbar">
      <div class="icon-group">
        <button class="icon-btn" data-action="toggle" title="Activate picker">
          <img src="icons/pipette.svg" alt="Pick">
        </button>
        <button class="icon-btn" data-action="copy" title="Copy selector">&#x29C9;</button>
        <button class="icon-btn" data-action="clear" title="Clear selector">&#x1F5D1;</button>
      </div>
      <div class="icon-group">
        <button class="icon-btn" data-action="export" title="Export JSON">{}</button>
        <button class="icon-btn" data-action="close" title="Close block">&#x2715;</button>
      </div>
    </div>
    <input id="query-${data.id}" class="selector-name" placeholder="Selector name" type="text" />
    <textarea id="selector-${data.id}" class="selector-output" readonly placeholder="No selector yet"></textarea>
  `;

  const queryInput = block.querySelector('.selector-name');
  const selectorOutput = block.querySelector('.selector-output');
  if (queryInput) queryInput.value = formatSelectorName(data);
  if (selectorOutput) selectorOutput.value = data.selector || '';

  return block;
};

const addSelectorBlock = (seed = {}) => {
  const id = seed.id || `block-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const hasCustomName = typeof seed.query === 'string' && seed.query.trim().length > 0;
  const computedName = hasCustomName ? seed.query : `Selector ${selectorCounter++}`;
  const data = {
    id,
    selector: seed.selector || '',
    query: computedName,
    baseName: computedName,
    url: seed.url || null,
    title: seed.title || null,
    timestamp: seed.timestamp || null
  };

  blocks.set(id, data);
  const element = createBlockElement(data);
  selectorsContainer.appendChild(element);
  return id;
};

const setActiveBlock = (id) => {
  activeBlockId = id;
  document.querySelectorAll('.selector-block').forEach((block) => {
    const btn = block.querySelector('[data-action="toggle"]');
    if (!btn) return;
    const isActive = block.dataset.id === id;
    btn.classList.toggle('active', isActive);
  });
};

const getBlockData = (id) => blocks.get(id);

const updateBlockSelector = (id, selector, meta = {}) => {
  const data = getBlockData(id);
  if (!data) return;
  data.selector = selector || '';
  data.url = meta.url || data.url;
  data.baseName = data.baseName || data.query || `Selector ${selectorCounter}`;
  data.query = data.baseName;
  data.title = meta.title || data.title;
  data.timestamp = meta.timestamp || data.timestamp;

  const block = document.querySelector(`.selector-block[data-id="${id}"]`);
  const output = block?.querySelector('.selector-output');
  if (output) {
    output.value = data.selector || '';
  }
  const nameInput = block?.querySelector('.selector-name');
  if (nameInput) {
    nameInput.value = formatSelectorName(data);
  }
};

const ensureBlockExists = () => {
  if (blocks.size === 0) {
    addSelectorBlock();
  }
};

const activatePicker = async (id) => {
  try {
    if (activeBlockId && activeBlockId !== id) {
      await sendToActiveTab({ action: 'deactivatePicker' });
    }
    const response = await sendToActiveTab({ action: 'activatePicker', blockId: id });
    if (!response?.success) {
      setStatus(response?.error || 'Activation failed', 'error');
      return;
    }
    setActiveBlock(id);
    setStatus('Waiting for element click...', 'active');
  } catch (error) {
    setStatus(error?.message || 'Activation failed', 'error');
  }
};

const deactivatePicker = async () => {
  if (!activeBlockId) return;
  try {
    await sendToActiveTab({ action: 'deactivatePicker' });
  } catch (error) {
    // ignore
  }
  setActiveBlock(null);
  setStatus('Picker cancelled', 'idle');
};

selectorsContainer.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const block = button.closest('.selector-block');
  const id = block?.dataset.id;
  if (!id) return;

  const data = getBlockData(id);
  const output = block.querySelector('.selector-output');

  if (button.dataset.action === 'toggle') {
    if (activeBlockId === id) {
      await deactivatePicker();
    } else {
      await activatePicker(id);
    }
    return;
  }

  if (button.dataset.action === 'copy') {
    const value = (output?.value || '').trim();
    if (!value) {
      setStatus('Nothing to copy', 'error');
      return;
    }
    try {
      const copied = await copyToClipboard(value);
      if (!copied) throw new Error('Copy failed');
      setStatus('Selector copied', 'success');
    } catch (error) {
      setStatus('Copy failed', 'error');
    }
    return;
  }

  if (button.dataset.action === 'clear') {
    if (output) output.value = '';
    if (data) {
      data.selector = '';
      data.url = null;
      data.title = null;
      data.timestamp = null;
    }
    setStatus('Selector cleared', 'idle');
    return;
  }

  if (button.dataset.action === 'export') {
    const payload = {
      id: data.id,
      selector: data.selector || '',
      query: data.query || '',
      url: data.url,
      title: data.title,
      timestamp: data.timestamp
    };
    downloadJson(payload, `selector-${Date.now()}.json`);
    setStatus('Block exported', 'success');
    return;
  }

  if (button.dataset.action === 'close') {
    if (blocks.size <= 1) {
      if (output) output.value = '';
      if (data) {
        data.selector = '';
        data.query = '';
        data.url = null;
        data.title = null;
        data.timestamp = null;
      }
      const queryInput = block.querySelector('.query-input');
      if (queryInput) queryInput.value = '';
      setStatus('Last block cleared', 'idle');
      return;
    }
    if (activeBlockId === id) {
      await deactivatePicker();
    }
    blocks.delete(id);
    block.remove();
    setStatus('Block removed', 'idle');
  }
});

selectorsContainer.addEventListener('input', (event) => {
  const input = event.target.closest('.selector-name');
  if (!input) return;
  const block = input.closest('.selector-block');
  const id = block?.dataset.id;
  if (!id) return;
  const data = getBlockData(id);
  if (data) {
    const parts = input.value.split(' : ');
    const base = parts[0]?.trim() || `Selector ${selectorCounter}`;
    data.baseName = base;
    data.query = base;
  }
});

saveAllBtn.addEventListener('click', () => {
  const list = Array.from(blocks.values()).map((item) => ({
    id: item.id,
    selector: item.selector || '',
    query: item.query || '',
    url: item.url,
    title: item.title,
    timestamp: item.timestamp
  }));

  if (!list.length) {
    setStatus('No selectors to export', 'error');
    return;
  }

  const payload = {
    exportedAt: new Date().toISOString(),
    selectors: list
  };
  downloadJson(payload, `selectors-${Date.now()}.json`);
  setStatus('Selectors exported', 'success');
});

addSelectorBtn.addEventListener('click', () => {
  addSelectorBlock();
  setStatus('Selector added', 'idle');
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.action === 'selectorCaptured' && message?.data?.selector) {
    ensureBlockExists();
    let targetId = blocks.has(message.data.blockId)
      ? message.data.blockId
      : activeBlockId || Array.from(blocks.keys())[0];
    if (targetId) {
      const existing = getBlockData(targetId);
      if (existing?.selector) {
        targetId = addSelectorBlock();
        setStatus('Selector added after capture', 'idle');
        setActiveBlock(targetId);
      }
      updateBlockSelector(targetId, message.data.selector, {
        url: message.data.url,
        title: message.data.title,
        timestamp: Date.now()
      });
    }
    setActiveBlock(null);
    setStatus('Selector captured', 'success');
  }

  if (message?.action === 'pickerCancelled') {
    setActiveBlock(null);
    setStatus('Picker cancelled', 'idle');
  }

  if (message?.action === 'pickerError' && message?.data?.error) {
    setActiveBlock(null);
    setStatus(message.data.error, 'error');
  }
});

addSelectorBlock();
setStatus('Ready', 'idle');
