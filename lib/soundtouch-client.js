"use strict";

const http = require("http");
const { URL } = require("url");

const SOUNDTOUCH_PORT = 8090;
const UPNP_PORT = 8091;
const UPNP_STOP_SETTLE_MS = 400;
const UPNP_SET_URI_SETTLE_MS = 500;

function compactXml(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function decodeXml(value) {
  return String(value == null ? "" : value)
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function escapeXml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isSocketHangUp(error) {
  return Boolean(error) && (error.code === "ECONNRESET" || error.message === "socket hang up");
}

function extractAttribute(xml, tagName, attributeName) {
  const pattern = new RegExp(`<${tagName}\\b[^>]*\\s${attributeName}="([^"]*)"`, "i");
  const match = String(xml).match(pattern);
  return match ? decodeXml(match[1]) : null;
}

function extractTagValue(xml, tagName) {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>([^<]*)<\\/${tagName}>`, "i");
  const match = String(xml).match(pattern);
  return match ? decodeXml(match[1]).trim() : null;
}

function formatBoseValue(value) {
  if (!value) {
    return null;
  }

  return String(value)
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((part) => {
      if (part === "wifi") {
        return "Wi-Fi";
      }
      if (part === "upnp") {
        return "UPnP";
      }
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function extractConnectionState(message) {
  const xml = String(message || "");
  const rawState = extractAttribute(xml, "connectionStateUpdated", "state");
  if (!rawState) {
    return null;
  }

  const rawSignal = extractAttribute(xml, "connectionStateUpdated", "signal");
  return {
    rawState,
    rawSignal,
    state: formatBoseValue(rawState),
    signal: formatBoseValue(rawSignal),
    up: extractAttribute(xml, "connectionStateUpdated", "up") === "true",
  };
}

function extractNowPlayingStatus(xml) {
  const rawSource = extractAttribute(xml, "nowPlaying", "source")
    || extractAttribute(xml, "ContentItem", "source");
  const rawPlayStatus = extractTagValue(xml, "playStatus");
  const source = formatBoseValue(rawSource);
  const summary = extractTagValue(xml, "stationName")
    || extractTagValue(xml, "itemName")
    || extractTagValue(xml, "track")
    || extractTagValue(xml, "artist")
    || extractAttribute(xml, "ContentItem", "location")
    || source;

  return {
    rawSource,
    rawPlayStatus,
    source,
    summary,
    isPlaying: rawPlayStatus === "PLAY_STATE",
    isStandby: rawSource === "STANDBY",
  };
}

function validateStreamUrl(streamUrl) {
  const parsedUrl = new URL(streamUrl);
  if (parsedUrl.protocol !== "http:") {
    throw new Error("Stream URL must be a direct http:// audio stream. HTTPS streams are not supported reliably by SoundTouch playback.");
  }
  return parsedUrl;
}

function guessAudioMimeType(streamUrl) {
  const pathname = new URL(streamUrl).pathname.toLowerCase();
  if (pathname.endsWith(".aac")) {
    return "audio/aac";
  }
  if (pathname.endsWith(".m4a")) {
    return "audio/mp4";
  }
  return "audio/mpeg";
}

function buildDidlLiteMetadata(streamUrl, { title = "Internet Radio", albumArtUrl = "" } = {}) {
  const escapedTitle = escapeXml(title || "Internet Radio");
  const escapedStreamUrl = escapeXml(streamUrl);
  const mimeType = guessAudioMimeType(streamUrl);
  const albumArt = albumArtUrl
    ? `<upnp:albumArtURI>${escapeXml(albumArtUrl)}</upnp:albumArtURI>`
    : "";

  return [
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ',
    'xmlns:dc="http://purl.org/dc/elements/1.1/" ',
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">',
    '<item id="0" parentID="-1" restricted="false">',
    `<dc:title>${escapedTitle}</dc:title>`,
    "<upnp:class>object.item.audioItem.audioBroadcast</upnp:class>",
    albumArt,
    `<res protocolInfo="http-get:*:${mimeType}:*">${escapedStreamUrl}</res>`,
    "</item>",
    "</DIDL-Lite>",
  ].join("");
}

function request({
  host,
  port,
  path,
  method = "GET",
  headers = {},
  body = null,
  timeout = 8000,
  allowSocketHangUp = false,
}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port,
        path,
        method,
        headers: {
          Connection: "close",
          ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
          ...headers,
        },
        timeout,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const responseBody = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const error = new Error(`HTTP ${res.statusCode}: ${compactXml(responseBody)}`);
            error.statusCode = res.statusCode;
            reject(error);
            return;
          }
          resolve(responseBody);
        });
      },
    );

    req.on("timeout", () => {
      req.destroy(new Error(`Request timed out: ${host}:${port}${path}`));
    });
    req.on("error", (error) => {
      if (allowSocketHangUp && isSocketHangUp(error)) {
        resolve("");
        return;
      }
      reject(error);
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

async function requestSoundTouch(host, path, body = null, timeout = 8000) {
  return request({
    host,
    port: SOUNDTOUCH_PORT,
    path,
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/xml; charset=utf-8" } : {},
    body,
    timeout,
  });
}

async function sendKey(host, key) {
  const escapedKey = escapeXml(key);
  const requestKey = (state) => request({
    host,
    port: SOUNDTOUCH_PORT,
    path: "/key",
    method: "POST",
    headers: { "Content-Type": "text/xml" },
    body: `<key state="${state}" sender="HomeyBose">${escapedKey}</key>`,
  });

  await requestKey("press");
  await requestKey("release");
}

async function requestUpnp(host, action, body) {
  const envelope = [
    '<?xml version="1.0"?>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ',
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
    `<s:Body>${body}</s:Body>`,
    "</s:Envelope>",
  ].join("");

  return request({
    host,
    port: UPNP_PORT,
    path: "/AVTransport/Control",
    method: "POST",
    headers: {
      "Content-Type": 'text/xml; charset="utf-8"',
      SOAPAction: `"urn:schemas-upnp-org:service:AVTransport:1#${action}"`,
    },
    body: envelope,
    allowSocketHangUp: true,
  });
}

async function getTransportInfo(host) {
  const body = [
    '<u:GetTransportInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">',
    "<InstanceID>0</InstanceID>",
    "</u:GetTransportInfo>",
  ].join("");
  return requestUpnp(host, "GetTransportInfo", body);
}

async function getPositionInfo(host) {
  const body = [
    '<u:GetPositionInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">',
    "<InstanceID>0</InstanceID>",
    "</u:GetPositionInfo>",
  ].join("");
  return requestUpnp(host, "GetPositionInfo", body);
}

async function getInfo(host, timeout) {
  return requestSoundTouch(host, "/info", null, timeout);
}

async function getNowPlaying(host) {
  return requestSoundTouch(host, "/now_playing");
}

async function getVolume(host) {
  const volumeXml = await requestSoundTouch(host, "/volume");
  const match = volumeXml.match(/<actualvolume>(\d+)<\/actualvolume>/i)
    || volumeXml.match(/<targetvolume>(\d+)<\/targetvolume>/i)
    || volumeXml.match(/<volume>(\d+)<\/volume>/i);
  return match ? Number(match[1]) : null;
}

async function setVolume(host, volume) {
  if (volume == null || volume === "") {
    return null;
  }

  const parsed = Number(volume);
  if (!Number.isFinite(parsed)) {
    throw new Error("Volume must be a number.");
  }

  const normalized = parsed <= 1 ? parsed * 100 : parsed;
  if (normalized < 0 || normalized > 100) {
    throw new Error("Volume must be between 0 and 100.");
  }

  return requestSoundTouch(host, "/volume", `<volume>${Math.round(normalized)}</volume>`);
}

async function playStream(host, streamUrl, {
  volume,
  onStep,
  title,
  albumArtUrl,
  metadataMode = "didl",
} = {}) {
  validateStreamUrl(streamUrl);

  if (onStep) {
    await onStep("validated");
  }
  await setVolume(host, volume);
  if (volume != null && onStep) {
    await onStep("volume");
  }

  const stopBody = [
    '<u:Stop xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">',
    "<InstanceID>0</InstanceID>",
    "</u:Stop>",
  ].join("");
  if (onStep) {
    await onStep("stop_start");
  }
  try {
    await requestUpnp(host, "Stop", stopBody);
    if (onStep) {
      await onStep("stop_done");
    }
    await wait(UPNP_STOP_SETTLE_MS);
  } catch (error) {
    if (onStep) {
      await onStep(`stop_ignored: ${error.message}`);
    }
  }

  const metadata = metadataMode === "empty"
    ? ""
    : buildDidlLiteMetadata(streamUrl, { title, albumArtUrl });
  const setUriBody = [
    '<u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">',
    "<InstanceID>0</InstanceID>",
    `<CurrentURI>${escapeXml(streamUrl)}</CurrentURI>`,
    `<CurrentURIMetaData>${metadata ? escapeXml(metadata) : ""}</CurrentURIMetaData>`,
    "</u:SetAVTransportURI>",
  ].join("");
  if (onStep) {
    await onStep("set_uri_start");
  }
  await requestUpnp(host, "SetAVTransportURI", setUriBody);
  if (onStep) {
    await onStep("set_uri_done");
  }
  await wait(UPNP_SET_URI_SETTLE_MS);

  const playBody = [
    '<u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">',
    "<InstanceID>0</InstanceID>",
    "<Speed>1</Speed>",
    "</u:Play>",
  ].join("");
  if (onStep) {
    await onStep("play_start");
  }
  await requestUpnp(host, "Play", playBody);
  if (onStep) {
    await onStep("play_done");
  }
}

async function stopPlayback(host) {
  const stopBody = [
    '<u:Stop xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">',
    "<InstanceID>0</InstanceID>",
    "</u:Stop>",
  ].join("");

  try {
    await requestUpnp(host, "Stop", stopBody);
  } catch (error) {
    await sendKey(host, "STOP");
  }
}

async function standby(host) {
  return requestSoundTouch(host, "/standby");
}

async function selectLastSource(host) {
  return requestSoundTouch(host, "/selectLastSource");
}

function extractDeviceId(infoXml) {
  const deviceIdMatch = String(infoXml).match(/<info[^>]*deviceID="([^"]+)"/i);
  if (deviceIdMatch) {
    return deviceIdMatch[1];
  }
  const macMatch = String(infoXml).match(/<macAddress>([^<]+)<\/macAddress>/i);
  return macMatch ? macMatch[1] : null;
}

function extractName(infoXml) {
  const match = String(infoXml).match(/<name>([^<]+)<\/name>/i);
  return match ? match[1] : null;
}

function extractPresetNumber(message) {
  const text = String(message);
  const patterns = [
    /PRESET_([1-6])/i,
    /preset(?:\s|_)?([1-6])/i,
    /<preset[^>]*id="([1-6])"/i,
    /<key[^>]*>\s*PRESET_([1-6])\s*<\/key>/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return Number(match[1]);
    }
  }

  return null;
}

module.exports = {
  SOUNDTOUCH_PORT,
  UPNP_PORT,
  compactXml,
  extractConnectionState,
  extractDeviceId,
  extractName,
  extractNowPlayingStatus,
  extractPresetNumber,
  formatBoseValue,
  buildDidlLiteMetadata,
  getInfo,
  getNowPlaying,
  getPositionInfo,
  getTransportInfo,
  getVolume,
  playStream,
  requestSoundTouch,
  selectLastSource,
  setVolume,
  standby,
  stopPlayback,
  validateStreamUrl,
};
