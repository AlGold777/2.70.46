const UI_URL = chrome.runtime.getURL('popup.html');

const isUserTabUrl = (url) => {
  if (!url) return false;
  const blocked = ['chrome://', 'chrome-extension://', 'edge://', 'about:', 'file://'];
  return !blocked.some((prefix) => url.startsWith(prefix));
};

const queryTabs = (queryInfo = {}) =>
  new Promise((resolve) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      if (chrome.runtime.lastError) {
        resolve([]);
        return;
      }
      resolve(tabs);
    });
  });

const getTabById = (tabId) =>
  new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(tab);
    });
  });

let lastUserTabId = null;

const preserveUserTab = (tab) => {
  if (tab?.id && isUserTabUrl(tab.url)) {
    lastUserTabId = tab.id;
  }
};

const resolveTargetTab = async () => {
  const [activeTab] = await queryTabs({ active: true, lastFocusedWindow: true });
  if (activeTab && isUserTabUrl(activeTab.url)) {
    preserveUserTab(activeTab);
    return activeTab;
  }

  if (lastUserTabId) {
    const rememberedTab = await getTabById(lastUserTabId);
    if (rememberedTab && isUserTabUrl(rememberedTab.url)) {
      return rememberedTab;
    }
  }

  const lastFocusedTabs = await queryTabs({ lastFocusedWindow: true });
  const currentWindowTabs = await queryTabs({ currentWindow: true });
  const allTabs = await queryTabs();

  const fallbackTab =
    lastFocusedTabs.find((tab) => isUserTabUrl(tab.url)) ||
    currentWindowTabs.find((tab) => isUserTabUrl(tab.url)) ||
    allTabs.find((tab) => isUserTabUrl(tab.url));

  if (fallbackTab) {
    preserveUserTab(fallbackTab);
    return fallbackTab;
  }

  return null;
};

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) return;
    preserveUserTab(tab);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab) return;
  if (tabId === lastUserTabId && changeInfo.status === 'loading') {
    lastUserTabId = null;
  }
  if (changeInfo.status === 'complete' || changeInfo.url) {
    preserveUserTab(tab);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === lastUserTabId) {
    lastUserTabId = null;
  }
});

const focusOrCreatePanel = async () => {
  try {
    const existing = await chrome.tabs.query({ url: UI_URL });
    if (existing && existing.length) {
      const panel = existing[0];
      await chrome.tabs.update(panel.id, { active: true });
      if (panel.windowId !== undefined) {
        await chrome.windows.update(panel.windowId, { focused: true });
      }
      return;
    }
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const windowId = activeTab?.windowId;
    await chrome.tabs.create({ url: UI_URL, active: true, windowId });
  } catch (error) {
    console.error('Failed to open extension panel:', error);
  }
};

const activatePicker = async () => {
  const tab = await resolveTargetTab();
  if (!tab?.id || !isUserTabUrl(tab.url)) {
    console.warn('No eligible tab found for picker activation.');
    return;
  }
  chrome.tabs.sendMessage(tab.id, { action: 'activatePicker', blockId: null }, () => {
    if (chrome.runtime.lastError) {
      console.warn('Activation message failed:', chrome.runtime.lastError.message);
    }
  });
};

chrome.action.onClicked.addListener(() => {
  focusOrCreatePanel();
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'activate-picker') {
    activatePicker();
  }
});
