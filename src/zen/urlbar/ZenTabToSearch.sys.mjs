/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tab-to-site-search: press Tab on a URL suggestion (e.g. youtube.com) to enter
 * that site's search mode, without needing an "@" keyword. Any configured
 * search engine whose domain matches the suggestion can be used; presets make
 * popular sites easy to enable from Search settings.
 */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
  UrlUtils: "resource://gre/modules/UrlUtils.sys.mjs",
  UserSearchEngine:
    "moz-src:///toolkit/components/search/UserSearchEngine.sys.mjs",
});

const SEARCH_ENGINE_TOPIC = "browser-search-engine-modified";
const PREF_ENABLED = "zen.urlbar.tab-to-search.enabled";

/**
 * Popular site search engines that can be toggled in Search settings.
 * `url` uses OpenSearch `{searchTerms}` placeholders.
 */
export const ZEN_TAB_TO_SEARCH_PRESETS = Object.freeze([
  {
    id: "youtube",
    name: "YouTube",
    alias: "youtube",
    url: "https://www.youtube.com/results?search_query={searchTerms}",
    domains: ["youtube.com", "youtu.be", "m.youtube.com"],
  },
  {
    id: "x",
    name: "X",
    alias: "x",
    url: "https://x.com/search?q={searchTerms}&src=typed_query",
    domains: ["x.com", "twitter.com", "mobile.twitter.com"],
  },
  {
    id: "amazon",
    name: "Amazon",
    alias: "amazon",
    url: "https://www.amazon.com/s?k={searchTerms}",
    domains: ["amazon.com"],
  },
  {
    id: "reddit",
    name: "Reddit",
    alias: "reddit",
    url: "https://www.reddit.com/search/?q={searchTerms}",
    domains: ["reddit.com", "old.reddit.com"],
  },
  {
    id: "github",
    name: "GitHub",
    alias: "github",
    url: "https://github.com/search?q={searchTerms}&type=repositories",
    domains: ["github.com"],
  },
  {
    id: "wikipedia",
    name: "Wikipedia",
    alias: "wikipedia",
    url: "https://en.wikipedia.org/wiki/Special:Search?search={searchTerms}",
    domains: ["wikipedia.org", "en.wikipedia.org"],
  },
]);

/**
 * @param {string} host
 * @returns {string}
 */
function normalizeHost(host) {
  if (!host) {
    return "";
  }
  return host.replace(/^www\./i, "").toLowerCase();
}

/**
 * @param {string} host
 * @param {string} domain
 * @returns {boolean}
 */
function hostMatchesDomain(host, domain) {
  let normalizedHost = normalizeHost(host);
  let normalizedDomain = normalizeHost(domain);
  return (
    normalizedHost === normalizedDomain ||
    normalizedHost.endsWith("." + normalizedDomain)
  );
}

class ZenTabToSearchManager {
  /** @type {Map<string, object>} host -> engine */
  #enginesByHost = new Map();

  /** @type {Promise<void>|null} */
  #initPromise = null;

  /** @type {boolean} */
  #observersAdded = false;

  /**
   * @returns {boolean}
   */
  get enabled() {
    return Services.prefs.getBoolPref(PREF_ENABLED, true);
  }

  /**
   * Ensure the domain→engine cache is ready.
   *
   * @returns {Promise<void>}
   */
  async init() {
    if (!this.#initPromise) {
      this.#initPromise = this.#initInternal().catch(ex => {
        this.#initPromise = null;
        throw ex;
      });
    }
    await this.#initPromise;
  }

  async #initInternal() {
    await lazy.SearchService.init();
    await this.#refreshEngines();
    if (!this.#observersAdded) {
      Services.obs.addObserver(this, SEARCH_ENGINE_TOPIC);
      this.#observersAdded = true;
    }
  }

  /**
   * @param {nsISupports} _subject
   * @param {string} topic
   * @param {string} _data
   */
  observe(_subject, topic, _data) {
    if (topic === SEARCH_ENGINE_TOPIC) {
      this.#refreshEngines().catch(console.error);
    }
  }

  async #refreshEngines() {
    this.#enginesByHost.clear();
    let engines = await lazy.SearchService.getVisibleEngines();
    for (let engine of engines) {
      if (engine.hideOneOffButton) {
        continue;
      }
      let host = normalizeHost(engine.searchUrlDomain);
      if (!host) {
        continue;
      }
      // Prefer the first engine registered for a host; presets / user engines
      // typically win because they are added after built-ins in practice, but
      // domain prefix matching below still finds them.
      if (!this.#enginesByHost.has(host)) {
        this.#enginesByHost.set(host, engine);
      }
      // Also index the base domain (e.g. youtube.com from m.youtube.com).
      try {
        let baseDomain = Services.eTLD.getBaseDomainFromHost(host);
        if (baseDomain && !this.#enginesByHost.has(baseDomain)) {
          this.#enginesByHost.set(baseDomain, engine);
        }
      } catch {
        // Invalid host / no eTLD — ignore.
      }
    }
  }

  /**
   * Synchronous lookup after init. Returns null if not ready or no match.
   *
   * @param {string} hostOrUrl
   * @returns {object|null}
   */
  engineForHostOrUrl(hostOrUrl) {
    if (!this.enabled || !hostOrUrl || !this.#enginesByHost.size) {
      return null;
    }

    let host = hostOrUrl;
    try {
      if (/[:/]/.test(hostOrUrl) || hostOrUrl.includes("://")) {
        let uri = Services.io.newURI(
          /:\/\//.test(hostOrUrl) ? hostOrUrl : "https://" + hostOrUrl
        );
        host = uri.host;
      }
    } catch {
      // Treat as a bare host / typed string.
      host = hostOrUrl.replace(/\/.*$/, "");
    }

    host = normalizeHost(host);
    if (!host || host.includes(" ") || /[:/?#]/.test(host)) {
      return null;
    }

    // Exact host match.
    if (this.#enginesByHost.has(host)) {
      return this.#enginesByHost.get(host);
    }

    // Subdomain / base-domain match (e.g. music.youtube.com → youtube.com).
    for (let [engineHost, engine] of this.#enginesByHost) {
      if (
        hostMatchesDomain(host, engineHost) ||
        hostMatchesDomain(engineHost, host)
      ) {
        return engine;
      }
    }

    // Typed domain prefix (e.g. "youtu" / "youtube" → youtube.com), matching
    // Firefox tab-to-search behaviour for incomplete hosts.
    if (!host.includes(".") || lazy.UrlUtils.looksLikeOrigin(host, { noIp: true })) {
      let prefix = host.includes(".")
        ? host.replace(/\.$/, "")
        : host;
      for (let [engineHost, engine] of this.#enginesByHost) {
        if (engineHost.startsWith(prefix)) {
          return engine;
        }
      }
    }

    // Match presets' extra domains (e.g. youtu.be → YouTube engine).
    for (let preset of ZEN_TAB_TO_SEARCH_PRESETS) {
      if (!preset.domains.some(d => hostMatchesDomain(host, d))) {
        continue;
      }
      let engine = this.#findEngineForPreset(preset);
      if (engine) {
        return engine;
      }
    }

    return null;
  }

  /**
   * Async-safe lookup that initializes first when needed.
   *
   * @param {string} hostOrUrl
   * @returns {Promise<object|null>}
   */
  async getEngineForHostOrUrl(hostOrUrl) {
    await this.init();
    return this.engineForHostOrUrl(hostOrUrl);
  }

  /**
   * @param {object} preset
   * @returns {object|null}
   */
  #findEngineForPreset(preset) {
    for (let engine of this.#enginesByHost.values()) {
      if (this.#engineMatchesPreset(engine, preset)) {
        return engine;
      }
    }
    return null;
  }

  /**
   * @param {object} engine
   * @param {object} preset
   * @returns {boolean}
   */
  #engineMatchesPreset(engine, preset) {
    if (engine.name === preset.name) {
      return true;
    }
    let domain = normalizeHost(engine.searchUrlDomain);
    return preset.domains.some(d => hostMatchesDomain(domain, d));
  }

  /**
   * @param {string} presetId
   * @returns {object|null}
   */
  getPreset(presetId) {
    return ZEN_TAB_TO_SEARCH_PRESETS.find(p => p.id === presetId) || null;
  }

  /**
   * @param {string} presetId
   * @returns {Promise<boolean>}
   */
  async isPresetInstalled(presetId) {
    await this.init();
    let preset = this.getPreset(presetId);
    if (!preset) {
      return false;
    }
    let engines = await lazy.SearchService.getVisibleEngines();
    return engines.some(engine => this.#engineMatchesPreset(engine, preset));
  }

  /**
   * @param {string} presetId
   * @returns {Promise<object|null>}
   */
  async installPreset(presetId) {
    await this.init();
    let preset = this.getPreset(presetId);
    if (!preset) {
      return null;
    }
    if (await this.isPresetInstalled(presetId)) {
      return this.#findEngineForPreset(preset);
    }
    let engine = await lazy.SearchService.addUserEngine({
      name: preset.name,
      url: preset.url,
      alias: preset.alias,
    });
    await this.#refreshEngines();
    return engine;
  }

  /**
   * Removes a preset engine only if it is a user-defined engine we (or the
   * user) added for that site — never removes app-provided engines.
   *
   * @param {string} presetId
   * @returns {Promise<boolean>}
   */
  async uninstallPreset(presetId) {
    await this.init();
    let preset = this.getPreset(presetId);
    if (!preset) {
      return false;
    }
    let engines = await lazy.SearchService.getVisibleEngines();
    let engine = engines.find(
      e =>
        e instanceof lazy.UserSearchEngine && this.#engineMatchesPreset(e, preset)
    );
    if (!engine) {
      return false;
    }
    await lazy.SearchService.removeEngine(
      engine,
      lazy.SearchService.CHANGE_REASON.USER
    );
    await this.#refreshEngines();
    return true;
  }
}

export const ZenTabToSearch = new ZenTabToSearchManager();
