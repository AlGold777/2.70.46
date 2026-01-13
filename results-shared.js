(function initResultsShared(globalObject) {
  if (globalObject.ResultsShared) return;

  const escapeHtml = (str = '') => str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const stripHtmlToPlainText = (html = '') => {
    if (!html) return '';
    const temp = globalObject.document?.createElement?.('div');
    if (!temp) return String(html);
    temp.innerHTML = html;
    return (temp.textContent || temp.innerText || '').trim();
  };

  const buildResponseCopyHtmlBlock = (name, metadataLine, htmlBody, fallbackText) => {
    const safeBody = (htmlBody && htmlBody.trim())
      ? htmlBody
      : (fallbackText ? `<p>${escapeHtml(fallbackText).replace(/\n/g, '<br>')}</p>` : '');
    if (!safeBody) return '';
    const safeName = escapeHtml(name || 'Response');
    const metaHtml = metadataLine ? `<div class="copied-meta">${escapeHtml(metadataLine)}</div>` : '';
    return `<section class="copied-response"><h2>${safeName}</h2>${metaHtml}<div class="copied-body">${safeBody}</div></section>`;
  };

  const wrapResponsesHtmlBundle = (sectionsHtml = '') => {
    const trimmed = sectionsHtml.trim();
    if (!trimmed) return '';
    return `<article class="llm-copied-responses">${trimmed}</article>`;
  };

  const fallbackCopyViaTextarea = (text = '') => {
    const doc = globalObject.document;
    if (!doc) return;
    const textarea = doc.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'absolute';
    textarea.style.left = '-9999px';
    doc.body.appendChild(textarea);
    textarea.select();
    doc.execCommand('copy');
    doc.body.removeChild(textarea);
  };

  const flashButtonFeedback = (btn, type = 'success', duration = 420) => {
    if (!btn) return;
    const classMap = {
        success: 'btn-flash-success',
        error: 'btn-flash-error',
        warn: 'btn-flash-warn'
    };
    const targetClass = classMap[type] || classMap.success;
    btn.classList.remove('btn-flash-success', 'btn-flash-error', 'btn-flash-warn');
    // force reflow to restart animation
    void btn.offsetWidth;
    btn.classList.add(targetClass);
    setTimeout(() => btn.classList.remove(targetClass), duration);
  };

  const writeRichContentToClipboard = async ({ text = '', html = '' } = {}) => {
    const plainText = text.trim();
    const htmlPayload = html.trim();
    const fallbackText = plainText || (htmlPayload ? stripHtmlToPlainText(htmlPayload) : '');

    if (htmlPayload && globalObject.navigator?.clipboard?.write && typeof ClipboardItem !== 'undefined') {
      const clipboardItem = new ClipboardItem({
        'text/html': new Blob([htmlPayload], { type: 'text/html' }),
        'text/plain': new Blob([(fallbackText || '')], { type: 'text/plain' })
      });
      await globalObject.navigator.clipboard.write([clipboardItem]);
      return;
    }

    if (fallbackText && globalObject.navigator?.clipboard?.writeText) {
      await globalObject.navigator.clipboard.writeText(fallbackText);
      return;
    }

    fallbackCopyViaTextarea(fallbackText);
  };

  globalObject.ResultsShared = {
    escapeHtml,
    stripHtmlToPlainText,
    buildResponseCopyHtmlBlock,
    wrapResponsesHtmlBundle,
    fallbackCopyViaTextarea,
    flashButtonFeedback,
    writeRichContentToClipboard
  };
})(typeof window !== 'undefined' ? window : self);
