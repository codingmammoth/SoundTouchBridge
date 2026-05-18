"use strict";

const http = require("http");

const SOUNDTOUCH_PORT = 8090;
const UPNP_PORT = 8091;
const DEFAULT_TESTS = [
  {
    label: "HTTP MP3",
    url: "http://25503.live.streamtheworld.com/OWR_INTERNATIONAL.mp3",
  },
  {
    label: "HTTPS MP3",
    url: "https://25503.live.streamtheworld.com/OWR_INTERNATIONAL.mp3",
  },
  {
    label: "HTTPS HLS",
    url: "https://radio.vrtcdn.be/vrt/stubru/live.m3u8",
  },
];

function usage() {
  console.log([
    "Usage:",
    "  node scripts/test-stream-protocol.js --host <speaker-ip> [--yes]",
    "  node scripts/test-stream-protocol.js --host <speaker-ip> --url <stream-url> [--label <name>] [--yes]",
    "",
    "This test changes playback on the selected SoundTouch speaker.",
    "Use --yes to confirm intentionally starting playback.",
  ].join("\n"));
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--yes") {
      args.yes = true;
    } else if (arg === "--host" || arg === "--url" || arg === "--label") {
      args[arg.slice(2)] = argv[index + 1];
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

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
  timeout = 10000,
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
            reject(new Error(`HTTP ${res.statusCode}: ${compactXml(responseBody)}`));
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
      if (error.code === "ECONNRESET" || error.message === "socket hang up") {
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

function requestSoundTouch(host, path, body = null) {
  return request({
    host,
    port: SOUNDTOUCH_PORT,
    path,
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/xml; charset=utf-8" } : {},
    body,
  });
}

function requestUpnp(host, action, body) {
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

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function playStreamRaw(host, streamUrl) {
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

async function runTest(host, test) {
  console.log(`\n== ${test.label} ==`);
  console.log(test.url);
  await playStreamRaw(host, test.url);
  await wait(3000);
  const nowPlaying = await requestSoundTouch(host, "/now_playing");
  console.log(compactXml(nowPlaying));
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    return;
  }
  if (!args.host) {
    throw new Error("Missing --host <speaker-ip>.");
  }
  if (!args.yes) {
    throw new Error("This changes speaker playback. Rerun with --yes to confirm.");
  }

  const tests = args.url
    ? [{ label: args.label || "Custom stream", url: args.url }]
    : DEFAULT_TESTS;

  console.log(`Testing SoundTouch stream protocols on ${args.host}`);
  for (const test of tests) {
    try {
      await runTest(args.host, test);
    } catch (error) {
      console.log(`FAILED: ${error.message}`);
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  usage();
  process.exit(1);
});
