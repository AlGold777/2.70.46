(() => {
  if (globalThis.NotesChunks) return;

  const { DEFAULT_CHUNK_SIZE } = globalThis.NotesConstants || {};
  const CHUNK_SIZE = typeof DEFAULT_CHUNK_SIZE === 'number' ? DEFAULT_CHUNK_SIZE : 65536;

  const normalizeText = (text) => (typeof text === 'string' ? text : '');

  const splitText = (text, chunkSize = CHUNK_SIZE) => {
    const value = normalizeText(text);
    const chunks = [];
    let idx = 0;
    for (let i = 0; i < value.length; i += chunkSize) {
      chunks.push({ idx, data: value.slice(i, i + chunkSize) });
      idx += 1;
    }
    if (!chunks.length) {
      chunks.push({ idx: 0, data: '' });
    }
    return chunks;
  };

  const joinChunks = (chunks = []) =>
    chunks
      .slice()
      .sort((a, b) => (a.idx || 0) - (b.idx || 0))
      .map((chunk) => chunk.data || '')
      .join('');

  const buildPreview = (text, limit = 140) => {
    const value = normalizeText(text).trim().replace(/\s+/g, ' ');
    if (!value) return '';
    return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
  };

  const buildTitle = (text, fallback = 'Untitled') => {
    const value = normalizeText(text).trim();
    if (!value) return fallback;
    const firstLine = value.split(/\n/)[0].trim();
    return firstLine || fallback;
  };

  globalThis.NotesChunks = {
    CHUNK_SIZE,
    splitText,
    joinChunks,
    buildPreview,
    buildTitle
  };
})();
