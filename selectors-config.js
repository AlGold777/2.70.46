// selectors-config.js
(function () {
  const globalObject = typeof window !== 'undefined' ? window : self;
  if (globalObject.SelectorConfig) {
    console.warn('[SelectorConfig] Duplicate load prevented');
    return;
  }

  /**
   * Evaluates whether a marker definition matches the current DOM.
   * @param {Object} marker - Marker descriptor.
   * @param {Document} doc - Document to evaluate against.
   * @returns {boolean} True when the marker is satisfied.
   */
  const buildMarkerChecker = (marker, doc) => {
    if (!marker) return false;
    if (marker.selector) {
      return !!doc.querySelector(marker.selector);
    }
    if (marker.exists) {
      return marker.exists.every((sel) => !!doc.querySelector(sel));
    }
    if (marker.bodyClass) {
      return doc.body?.classList?.contains(marker.bodyClass);
    }
    if (marker.attribute) {
      const node = doc.querySelector(marker.attribute.selector || 'body');
      if (!node) return false;
      const value = node.getAttribute(marker.attribute.name);
      if (typeof marker.attribute.value === 'string') return value === marker.attribute.value;
      if (Array.isArray(marker.attribute.value)) return marker.attribute.value.includes(value);
      return !!value;
    }
    return false;
  };

  const normalizeSelectorCandidates = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) return Array.from(value);
    if (typeof value === 'object') {
      const preferredOrder = ['primary', 'secondary', 'tertiary', 'fallback', 'all'];
      const result = [];
      for (const key of preferredOrder) {
        if (Array.isArray(value[key])) {
          result.push(...value[key]);
        }
      }
      for (const key of Object.keys(value)) {
        if (!preferredOrder.includes(key) && Array.isArray(value[key])) {
          result.push(...value[key]);
        }
      }
      return result;
    }
    return [];
  };

  const baseModels = globalObject.SelectorConfigRegistry || {};
  let activeModels = cloneModelTree(baseModels);
  let remoteFullModels = {};
  let remoteOverridePatch = null;
  let manualOverrideRegistry = {};

  function cloneModelTree(source) {
    if (typeof structuredClone === 'function') {
      try {
        return structuredClone(source);
      } catch (_) { /* fallback to JSON */ }
    }
    try {
      return JSON.parse(JSON.stringify(source));
    } catch (err) {
      console.warn('[SelectorConfig] Failed to clone base models', err);
      return {};
    }
  }

  function mergeConfigs(base, override) {
    if (!override || typeof override !== 'object') return base;
    const output = Array.isArray(base) ? base.slice() : { ...base };
    Object.keys(override).forEach((key) => {
      const nextValue = override[key];
      const currentValue = output[key];
      if (Array.isArray(nextValue)) {
        output[key] = nextValue.slice();
      } else if (
        nextValue &&
        typeof nextValue === 'object' &&
        currentValue &&
        typeof currentValue === 'object' &&
        !Array.isArray(currentValue)
      ) {
        output[key] = mergeConfigs(currentValue, nextValue);
      } else {
        output[key] = nextValue;
      }
    });
    return output;
  }

  const hasEntries = (obj) => !!obj && typeof obj === 'object' && Object.keys(obj).length > 0;

  function rebuildActiveModels() {
    const combined = cloneModelTree(baseModels);
    if (hasEntries(remoteFullModels)) {
      Object.entries(remoteFullModels).forEach(([modelName, definition]) => {
        if (definition && typeof definition === 'object') {
          combined[modelName] = cloneModelTree(definition);
        }
      });
    }
    activeModels = hasEntries(remoteOverridePatch)
      ? mergeConfigs(combined, remoteOverridePatch)
      : combined;
  }

  function normalizeRemotePayload(payload) {
    if (!payload || typeof payload !== 'object') return { models: {}, overrides: null, manualOverrides: null };
    const bundle = payload.bundle?.selectors || payload;
    const models =
      bundle.fullModels ||
      bundle.models ||
      bundle.configs ||
      bundle.modules ||
      bundle.files ||
      null;
    const overrides =
      bundle.overrides ||
      bundle.patch ||
      bundle.deltas ||
      (models ? null : bundle);
    const manualOverrides =
      bundle.manualOverrides ||
      payload.manualOverrides ||
      null;
    return {
      models: hasEntries(models) ? models : {},
      overrides: hasEntries(overrides) ? overrides : null,
      manualOverrides: hasEntries(manualOverrides) ? manualOverrides : null
    };
  }

  function applyRemoteConfigPayload(payload) {
    const { models, overrides, manualOverrides } = normalizeRemotePayload(payload);
    remoteFullModels = cloneModelTree(models || {});
    remoteOverridePatch = overrides ? cloneModelTree(overrides) : null;
    manualOverrideRegistry = manualOverrides ? cloneModelTree(manualOverrides) : {};
    rebuildActiveModels();
  }

  function primeRemoteOverrides() {
    if (!chrome?.storage?.local?.get) return;
    chrome.storage.local.get('selectors_remote_override', (res) => {
      if (chrome.runtime?.lastError) return;
      if (res?.selectors_remote_override) {
        applyRemoteConfigPayload(res.selectors_remote_override);
        console.info('[SelectorConfig] Remote registry payload applied');
      } else {
        remoteFullModels = {};
        remoteOverridePatch = null;
        rebuildActiveModels();
      }
    });
    if (chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local' || !changes.selectors_remote_override) return;
        applyRemoteConfigPayload(changes.selectors_remote_override.newValue || null);
        console.info('[SelectorConfig] Remote registry payload updated via storage change');
      });
    }
  }

  primeRemoteOverrides();

  const getModelConfig = (modelName) => activeModels[modelName] || null;

  const detectUIVersion = (modelName, doc = document) => {
    const modelConfig = getModelConfig(modelName);
    if (!modelConfig) return 'unknown';
    for (const version of modelConfig.versions || []) {
      const matchAllMarkers = (version.markers || []).every((marker) => buildMarkerChecker(marker, doc));
      if (matchAllMarkers) {
        return version.version;
      }
    }
    return 'unknown';
  };

  const getSelectorsFor = (modelName, versionId, elementType) => {
    const modelConfig = getModelConfig(modelName);
    if (!modelConfig) return [];
    const manualList = Array.isArray(manualOverrideRegistry?.[modelName]?.[elementType])
      ? manualOverrideRegistry[modelName][elementType]
      : [];
    if (versionId === 'emergency') {
      const emergency = Array.from(modelConfig.emergencyFallbacks?.[elementType] || []);
      return manualList.length ? Array.from(new Set([...manualList, ...emergency])) : emergency;
    }
    const versionEntry = (modelConfig.versions || []).find((v) => v.version === versionId);
    if (!versionEntry) {
      return manualList.length ? Array.from(new Set(manualList)) : [];
    }
    const selectors = normalizeSelectorCandidates(versionEntry.selectors?.[elementType]);
    if (!manualList.length) return selectors;
    return Array.from(new Set([...manualList, ...selectors]));
  };

  const getConstraintsFor = (modelName, versionId, elementType) => {
    const modelConfig = getModelConfig(modelName);
    if (!modelConfig) return null;
    const consolidate = [];
    const includeFrom = (versionEntry) => {
      const constraint = versionEntry?.constraints?.[elementType];
      if (constraint?.exclude) {
        consolidate.push(...constraint.exclude);
      }
    };
    if (versionId && versionId !== 'unknown') {
      const versionEntry = (modelConfig.versions || []).find((v) => v.version === versionId);
      includeFrom(versionEntry);
    } else {
      for (const versionEntry of modelConfig.versions || []) {
        includeFrom(versionEntry);
      }
    }
    if (!consolidate.length && Array.isArray(modelConfig?.constraints?.[elementType]?.exclude)) {
      consolidate.push(...modelConfig.constraints[elementType].exclude);
    }
    if (!consolidate.length) return null;
    return { exclude: Array.from(new Set(consolidate)) };
  };

  const getExtractionConfig = (modelName, versionId, elementType) => {
    const modelConfig = getModelConfig(modelName);
    if (!modelConfig) return null;
    const pick = (versionEntry) => versionEntry?.selectors?.[elementType]?.extraction || null;
    if (versionId && versionId !== 'unknown') {
      const versionEntry = (modelConfig.versions || []).find((v) => v.version === versionId);
      const extraction = pick(versionEntry);
      if (extraction) return { ...extraction };
    }
    for (const versionEntry of modelConfig.versions || []) {
      const extraction = pick(versionEntry);
      if (extraction) return { ...extraction };
    }
    return null;
  };

  const listVersions = (modelName) => {
    const modelConfig = getModelConfig(modelName);
    if (!modelConfig) return [];
    return modelConfig.versions.map(({ version, dateCreated, description }) => ({
      version,
      dateCreated,
      description
    }));
  };

  const normalizeVersionMeta = (versionEntry, nowTs) => {
    if (!versionEntry) return null;
    const expiresAtTs = versionEntry.expiresAt ? Date.parse(versionEntry.expiresAt) : null;
    const daysRemaining = Number.isFinite(expiresAtTs)
      ? Math.ceil((expiresAtTs - nowTs) / (24 * 60 * 60 * 1000))
      : null;
    return {
      version: versionEntry.version,
      uiRevision: versionEntry.uiRevision || versionEntry.version || 'unknown',
      expiresAt: versionEntry.expiresAt || null,
      qaNotes: versionEntry.qaNotes || '',
      expired: Number.isFinite(expiresAtTs) ? expiresAtTs < nowTs : false,
      daysRemaining,
      description: versionEntry.description || ''
    };
  };

  const getVersionStatus = (modelName) => {
    const modelConfig = getModelConfig(modelName);
    if (!modelConfig) {
      return { modelName, versions: [], hasVersions: false, fullyExpired: false };
    }
    const now = Date.now();
    const versions = (modelConfig.versions || []).map((entry) => normalizeVersionMeta(entry, now)).filter(Boolean);
    const activeVersions = versions.filter((entry) => !entry.expired);
    return {
      modelName,
      versions,
      hasVersions: versions.length > 0,
      fullyExpired: versions.length > 0 && activeVersions.length === 0,
      updatedAt: new Date(now).toISOString()
    };
  };

  const getAllVersionStatuses = () => {
    const snapshot = {};
    Object.keys(activeModels).forEach((modelName) => {
      snapshot[modelName] = getVersionStatus(modelName);
    });
    return snapshot;
  };

  const getAnchorsFor = (modelName, versionId, elementType) => {
    const modelConfig = getModelConfig(modelName);
    if (!modelConfig) return [];
    const collectAnchors = (versionEntry) => {
      const anchors = versionEntry?.anchors?.[elementType];
      return Array.isArray(anchors) ? anchors : [];
    };
    if (versionId && versionId !== 'unknown') {
      const versionEntry = (modelConfig.versions || []).find((v) => v.version === versionId);
      const anchors = collectAnchors(versionEntry);
      if (anchors.length) return anchors;
    }
    const aggregated = [];
    (modelConfig.versions || []).forEach((versionEntry) => aggregated.push(...collectAnchors(versionEntry)));
    return Array.from(new Set(aggregated));
  };

  const existingOverrides = globalObject.SelectorConfig?.overrides || {};
  const existingCircuit = globalObject.SelectorConfig?.circuitBreaker || {};
  globalObject.SelectorConfig = {
    get models() {
      return activeModels;
    },
    detectUIVersion,
    getModelConfig,
    getSelectorsFor,
    getConstraintsFor,
    getExtractionConfig,
    listVersions,
    getVersionStatus,
    getAllVersionStatuses,
    getAnchorsFor,
    overrides: existingOverrides,
    circuitBreaker: Object.assign({ enabled: true, threshold: 3 }, existingCircuit)
  };
})();
