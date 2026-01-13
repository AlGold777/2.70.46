document.addEventListener('DOMContentLoaded', () => {
  const promptInput = document.getElementById('prompt');
  const sendButton = document.getElementById('send-button');
  const getItButton = document.getElementById('get-it-button');
  const compareButton = document.getElementById('compare-button');
  const autoCheckbox = document.getElementById('auto-checkbox');
  const llmCheckboxes = document.querySelectorAll('input[name="llm"]');
  const responseMap = {
    chatgpt: document.querySelector('#chatgpt-response .response-content'),
    claude: document.querySelector('#claude-response .response-content'),
    gemini: document.querySelector('#gemini-response .response-content'),
    grok: document.querySelector('#grok-response .response-content'),
    lechat: document.querySelector('#lechat-response .response-content'),
    qwen: document.querySelector('#qwen-response .response-content'),
    deepseek: document.querySelector('#deepseek-response .response-content'),
    perplexity: document.querySelector('#perplexity-response .response-content')
  };
  const responseBlocks = Object.values(responseMap).filter(Boolean);
  const placeholderText = 'Click to add or edit response';

  const updateCompareButtonState = () => {
    const activeResponses = responseBlocks.filter(block => block.textContent.trim()).length;
    compareButton.disabled = activeResponses < 2;
  };

  responseBlocks.forEach(block => {
    block.setAttribute('contenteditable', 'true');
    block.setAttribute('spellcheck', 'true');
    block.setAttribute('data-placeholder', placeholderText);
    block.setAttribute('aria-label', `${block.closest('.response-column')?.querySelector('h3')?.textContent?.trim() || 'Model'} response (editable)`);
    block.addEventListener('input', () => {
      updateCompareButtonState();
    });
  });

  // Отправка запроса
  sendButton.addEventListener('click', () => {
    const prompt = promptInput.value;
    const selectedLLMs = Array.from(llmCheckboxes)
      .filter(checkbox => checkbox.checked)
      .map(checkbox => checkbox.value);

    chrome.runtime.sendMessage({
      action: 'sendPrompt',
      prompt,
      llms: selectedLLMs,
      auto: autoCheckbox.checked
    });
  });

  // Получение ответов
  getItButton.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'getResponses' });
  });

  // Сравнение ответов
  compareButton.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'compareResponses' });
  });

  // Обновление состояния кнопок
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'updateResponses') {
      Object.entries(responseMap).forEach(([key, element]) => {
        if (!element) return;
        const nextValue = message.responses?.[key] || '';
        element.textContent = nextValue;
      });
      updateCompareButtonState();
    }
  });


  autoCheckbox.addEventListener('change', () => {
    getItButton.disabled = autoCheckbox.checked;
  });

  updateCompareButtonState();
});

document.getElementById('get-it-button').addEventListener('click', async () => {
  const urls = [
    "*://*.chat.openai.com/*",
    "*://*.gemini.google.com/*",
    "*://*.claude.ai/*",
    "*://*.grok.com/*",
    "*://*.chat.qwen.ai/*",
    "*://*.chat.mistral.ai/*",
    "*://*.chat.deepseek.com/*",
    "*://*.perplexity.ai/*"
  ];

  for (const url of urls) {
    const tabs = await chrome.tabs.query({ url });
    for (const tab of tabs) {
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        function: copyLLMResponse,
      });
    }
  }
});

chrome.runtime.onMessage.addListener((request) => {
    if (request.action === "insertResponse") {
        const column = document.querySelector('.target-column'); // Замените селектор на актуальный
        if (column) {
            column.textContent = request.text;
        }
    }
});
// Сохранение списка шаблонов в chrome.storage.local
function saveTemplates(templates) {
    chrome.storage.local.set({ templates: templates }, () => {
        console.log("Шаблоны сохранены:", templates);
    });
}
// Загрузка списка шаблонов из chrome.storage.local
function loadTemplates(callback) {
    chrome.storage.local.get(["templates"], (result) => {
        const templates = result.templates || [];
        callback(templates);
    });
}
// Загрузка шаблонов при открытии popup
document.addEventListener("DOMContentLoaded", () => {
    loadTemplates((templates) => {
        templates.forEach((template) => {
            addTemplateToDOM(template); // Ваша функция для отображения шаблонов в DOM
        });
    });
});
// Пример функции для добавления нового шаблона
function addNewTemplate(newTemplate) {
    loadTemplates((templates) => {
        templates.push(newTemplate);
        saveTemplates(templates);
        addTemplateToDOM(newTemplate); // Обновляем DOM
    });
}
// Пример функции для добавления шаблона в DOM
function addTemplateToDOM(template) {
    const templateList = document.getElementById("template-list"); // Замените на ваш элемент
    const templateElement = document.createElement("div");
    templateElement.textContent = template;
    templateList.appendChild(templateElement);
}
