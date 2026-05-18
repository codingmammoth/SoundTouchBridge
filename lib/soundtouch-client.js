"use strict";

const http = require("http");
const { URL } = require("url");

const SOUNDTOUCH_PORT = 8090;
const UPNP_PORT = 8091;

function compactXml(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function request({
  host,
  port,
  path,
  method = "GET",
  headers = {},
  body = null,
  timeout = 8000,
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
    req.on("error", reject);

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

async function requestSoundTouch(host, path, body = null) {
  return request({
    host,
    port: SOUNDTOUCH_PORT,
    path,
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/xml; charset=utf-8" } : {},
    body,
  });
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
  });
}

async function getInfo(host) {
  return requestSoundTouch(host, "/info");
}

async function getNowPlaying(host) {
  return requestSoundTouch(host, "/now_playing");
}

async function setVolume(host, volume) {
  if (volume == null || volume === "") {
    return null;
  }

  const parsed = Number(volume);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error("Volume must be between 0 and 100.");
  }

  return requestSoundTouch(host, "/volume", `<volume>${Math.round(parsed)}</volume>`);
}

async function playStream(host, streamUrl, { volume } = {}) {
  const parsedUrl = new URL(streamUrl);
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("Stream URL must start with http:// or https://.");
  }

  await setVolume(host, volume);

  const setUriBody = [
    '<u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">',
    "<InstanceID>0</InstanceID>",
    `<CurrentURI>${escapeXml(streamUrl)}</CurrentURI>`,
    "<CurrentURIMetaData></CurrentURIMetaData>",
    "</u:SetAVTransportURI>",
  ].join("");
  await requestUpnp(host, "SetAVTransportURI", setUriBody);

  const playBody = [
    '<u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">',
    "<InstanceID>0</InstanceID>",
    "<Speed>1</Speed>",
    "</u:Play>",
  ].join("");
  await requestUpnp(host, "Play", playBody);
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
  extractDeviceId,
  extractName,
  extractPresetNumber,
  getInfo,
  getNowPlaying,
  playStream,
  requestSoundTouch,
};
