"use strict";

const dns = require("dns");
const http = require("http");
const https = require("https");
const { URL, URLSearchParams } = require("url");

const USER_AGENT = "SoundTouchBridge/0.2.0";
const API_HOSTS = [
  "de1.api.radio-browser.info",
  "nl1.api.radio-browser.info",
  "at1.api.radio-browser.info",
  "api.radio-browser.info",
];
const SUPPORTED_CODECS = ["MP3", "AAC", "AAC+"];
const SEARCH_LIMIT = 24;
const RESULT_LIMIT = 12;
const RANDOM_RESULT_LIMIT = 24;
const PROBE_CONCURRENCY = 4;
const STREAM_PROBE_TIMEOUT_MS = 5000;

let cachedApiHosts = null;

function normalizeString(value) {
  return String(value == null ? "" : value).trim();
}

function normalizeCountryCode(value) {
  return normalizeString(value).toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);
}

function normalizeCodec(value) {
  return normalizeString(value).toUpperCase();
}

function isSupportedCodec(codec) {
  return SUPPORTED_CODECS.indexOf(normalizeCodec(codec)) !== -1;
}

function shuffle(items) {
  const copy = items.slice();
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const current = copy[index];
    copy[index] = copy[swapIndex];
    copy[swapIndex] = current;
  }
  return copy;
}

function unique(items) {
  return items.filter((item, index) => item && items.indexOf(item) === index);
}

function lookupApiHosts() {
  return new Promise((resolve) => {
    dns.resolve4("all.api.radio-browser.info", (resolveError, addresses) => {
      if (resolveError || !addresses || addresses.length === 0) {
        resolve(API_HOSTS);
        return;
      }

      let pending = addresses.length;
      const hostnames = [];
      addresses.forEach((address) => {
        dns.reverse(address, (reverseError, names) => {
          if (!reverseError && names && names[0]) {
            hostnames.push(names[0].replace(/\.$/, ""));
          }
          pending -= 1;
          if (pending === 0) {
            resolve(unique(hostnames.concat(API_HOSTS)));
          }
        });
      });
    });
  });
}

async function getApiHosts() {
  if (!cachedApiHosts) {
    cachedApiHosts = await lookupApiHosts();
  }
  return shuffle(cachedApiHosts);
}

function requestBody(options) {
  return new Promise((resolve, reject) => {
    const transport = options.protocol === "http:" ? http : https;
    const req = transport.request({
      protocol: options.protocol,
      host: options.host,
      path: options.path,
      method: options.method || "GET",
      headers: Object.assign({
        "User-Agent": USER_AGENT,
        Accept: options.accept || "application/json",
      }, options.headers || {}),
      timeout: options.timeout || 8000,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 120)}`));
          return;
        }
        resolve(body);
      });
    });

    req.on("timeout", () => {
      req.destroy(new Error(`Request timed out: ${options.host}${options.path}`));
    });
    req.on("error", reject);
    req.end();
  });
}

async function requestJsonFromAnyHost(path) {
  const hosts = await getApiHosts();
  let lastError = null;

  for (const host of hosts) {
    try {
      const body = await requestBody({
        protocol: "https:",
        host,
        path,
      });
      return {
        host,
        data: JSON.parse(body),
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Radio Browser API is unavailable.");
}

function buildSearchPath(criteria, { limit = SEARCH_LIMIT } = {}) {
  const params = new URLSearchParams();
  const query = normalizeString(criteria.query);
  const countrycode = normalizeCountryCode(criteria.countrycode);
  const tag = normalizeString(criteria.tag).toLowerCase();

  if (query) {
    params.set("name", query);
  }
  if (countrycode.length === 2) {
    params.set("countrycode", countrycode);
  }
  if (tag) {
    params.set("tag", tag);
  }

  params.set("hidebroken", "true");
  params.set("order", "clickcount");
  params.set("reverse", "true");
  params.set("limit", String(limit));

  return `/json/stations/search?${params.toString()}`;
}

function getStationCandidateUrls(station) {
  const rawUrls = [
    normalizeString(station.url_resolved),
    normalizeString(station.url),
  ];
  const candidates = [];

  rawUrls.forEach((rawUrl) => {
    if (!rawUrl) {
      return;
    }

    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === "http:") {
        candidates.push(parsed.toString());
      } else if (parsed.protocol === "https:") {
        parsed.protocol = "http:";
        candidates.push(parsed.toString());
      }
    } catch (error) {
      // Ignore malformed community database entries.
    }
  });

  return unique(candidates);
}

function isStationMetadataCompatible(station) {
  if (Number(station.lastcheckok) !== 1 || Number(station.hls) === 1) {
    return false;
  }
  if (!isSupportedCodec(station.codec)) {
    return false;
  }
  return getStationCandidateUrls(station).length > 0;
}

function isLikelyAudioContentType(contentType) {
  const normalized = normalizeString(contentType).toLowerCase();
  return normalized.indexOf("audio/") === 0
    || normalized.indexOf("application/octet-stream") === 0
    || normalized.indexOf("application/ogg") === 0;
}

function probeStreamUrl(streamUrl, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(streamUrl);
    } catch (error) {
      reject(error);
      return;
    }

    if (parsed.protocol !== "http:") {
      reject(new Error("Stream is not plain HTTP."));
      return;
    }

    let settled = false;
    const done = (error, result) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };

    const req = http.request({
      protocol: parsed.protocol,
      host: parsed.hostname,
      port: parsed.port || 80,
      path: `${parsed.pathname}${parsed.search}`,
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "audio/*,*/*;q=0.8",
        "Icy-MetaData": "1",
        Range: "bytes=0-2048",
      },
      timeout: STREAM_PROBE_TIMEOUT_MS,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        req.destroy();
        if (redirectsLeft <= 0) {
          done(new Error("Too many stream redirects."));
          return;
        }

        const nextUrl = new URL(res.headers.location, parsed).toString();
        probeStreamUrl(nextUrl, redirectsLeft - 1).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        req.destroy();
        done(new Error(`Stream returned HTTP ${res.statusCode}.`));
        return;
      }

      const contentType = normalizeString(res.headers["content-type"]);
      if (contentType && !isLikelyAudioContentType(contentType)) {
        req.destroy();
        done(new Error(`Stream is ${contentType}, not audio.`));
        return;
      }

      done(null, {
        streamUrl: parsed.toString(),
        contentType,
      });
      req.destroy();
    });

    req.on("timeout", () => {
      req.destroy(new Error("Stream probe timed out."));
    });
    req.on("error", (error) => {
      done(error);
    });
    req.end();
  });
}

async function resolveCompatibleStation(station, index) {
  const urls = getStationCandidateUrls(station);
  for (const streamUrl of urls) {
    try {
      const probe = await probeStreamUrl(streamUrl);
      return {
        id: `${station.stationuuid || "station"}-${index}`,
        stationuuid: station.stationuuid || "",
        name: normalizeString(station.name) || "Radio station",
        streamUrl: probe.streamUrl,
        codec: normalizeCodec(station.codec),
        bitrate: Number(station.bitrate) || 0,
        country: normalizeString(station.country),
        countrycode: normalizeString(station.countrycode),
        tags: normalizeString(station.tags),
        homepage: normalizeString(station.homepage),
        favicon: normalizeString(station.favicon),
        clickcount: Number(station.clickcount) || 0,
        votes: Number(station.votes) || 0,
        contentType: probe.contentType,
      };
    } catch (error) {
      // Try the next candidate URL for this station.
    }
  }
  return null;
}

async function mapCompatibleStations(stations, { limit = RESULT_LIMIT, candidateLimit = SEARCH_LIMIT } = {}) {
  const compatible = [];
  const candidates = stations.filter(isStationMetadataCompatible).slice(0, candidateLimit);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < candidates.length && compatible.length < limit) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      const resolved = await resolveCompatibleStation(candidates[currentIndex], currentIndex);
      if (resolved && compatible.length < limit) {
        compatible.push(resolved);
      }
    }
  }

  const workers = [];
  const workerCount = Math.min(PROBE_CONCURRENCY, candidates.length);
  for (let index = 0; index < workerCount; index += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return dedupeStations(compatible).sort((left, right) => (
    right.clickcount - left.clickcount
    || right.votes - left.votes
    || left.name.localeCompare(right.name)
  ));
}

function dedupeStations(stations) {
  const seen = {};
  return stations.filter((station) => {
    const stationUuid = normalizeString(station.stationuuid).toLowerCase();
    const streamUrl = normalizeString(station.streamUrl).toLowerCase();
    const key = stationUuid || streamUrl;
    if (!key || seen[key]) {
      return false;
    }
    seen[key] = true;
    return true;
  });
}

async function searchCompatibleStations(criteria) {
  const query = normalizeString(criteria && criteria.query);
  const countrycode = normalizeCountryCode(criteria && criteria.countrycode);
  const tag = normalizeString(criteria && criteria.tag);
  if (!query && countrycode.length !== 2 && !tag) {
    throw new Error("Enter a station name, country code, or tag.");
  }

  const response = await requestJsonFromAnyHost(buildSearchPath({ query, countrycode, tag }));
  if (!Array.isArray(response.data)) {
    throw new Error("Radio Browser returned an unexpected response.");
  }

  const results = await mapCompatibleStations(response.data);
  return {
    source: response.host,
    results,
  };
}

async function searchRandomCompatibleStations(criteria) {
  const countrycode = normalizeCountryCode(criteria && criteria.countrycode);
  const tag = normalizeString(criteria && criteria.tag);
  if (!tag) {
    throw new Error("Enter a tag or genre for the random station rule.");
  }

  const response = await requestJsonFromAnyHost(buildSearchPath({
    query: "",
    countrycode,
    tag,
  }, { limit: RANDOM_RESULT_LIMIT }));
  if (!Array.isArray(response.data)) {
    throw new Error("Radio Browser returned an unexpected response.");
  }

  const results = await mapCompatibleStations(response.data, {
    limit: RANDOM_RESULT_LIMIT,
    candidateLimit: RANDOM_RESULT_LIMIT,
  });
  return {
    source: response.host,
    results,
  };
}

async function countStationClick(stationuuid) {
  const uuid = normalizeString(stationuuid);
  if (!uuid) {
    return null;
  }

  try {
    return await requestJsonFromAnyHost(`/json/url/${encodeURIComponent(uuid)}`);
  } catch (error) {
    return null;
  }
}

module.exports = {
  countStationClick,
  searchCompatibleStations,
  searchRandomCompatibleStations,
};
