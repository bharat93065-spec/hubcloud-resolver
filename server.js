const express = require("express");
const cors = require("cors");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");

let ffmpegPath = null;
try {
  ffmpegPath = require("ffmpeg-static");
} catch {}
if (!ffmpegPath) {
  try {
    ffmpegPath = require("@ffmpeg-installer/ffmpeg")?.path;
  } catch {}
}
if (!ffmpegPath) {
  ffmpegPath = "ffmpeg";
}

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const FOURK_HOST = "https://4khdhub.one";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const FOURK_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
  "upgrade-insecure-requests": "1",
};

function rot13(str) {
  return str.replace(/[a-zA-Z]/g, (c) =>
    String.fromCharCode((c <= "Z" ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26)
  );
}

function resolveRedirectUrl(html) {
  const m = html.match(/['"]o['"],\s*['"](.*?)['"]/);
  if (!m) return null;
  try {
    const raw = Buffer.from(m[1], "base64").toString("utf-8");
    const raw2 = Buffer.from(raw, "base64").toString("utf-8");
    const rotated = rot13(raw2);
    const decoded = Buffer.from(rotated, "base64").toString("utf-8");
    const json = JSON.parse(decoded);
    if (json.o) {
      return Buffer.from(json.o, "base64").toString("utf-8");
    }
  } catch {
    /* ignore decoding error */
  }
  return null;
}

async function resolveDriveToDirect(driveUrl) {
  try {
    const hcRes = await fetch(driveUrl, { headers: FOURK_HEADERS, signal: AbortSignal.timeout(6000) });
    if (!hcRes.ok) return null;
    const hcHtml = await hcRes.text();
    const phpMatch = hcHtml.match(/var\s+url\s*=\s*['"]([^'"]*hubcloud\.php[^'"]*)['"]/i) ||
                     hcHtml.match(/<a\s+[^>]*id=['"]download['"][^>]*href=['"]([^"']+)['"]/i);
    if (!phpMatch) return null;

    const phpUrl = phpMatch[1].startsWith("http") ? phpMatch[1] : `https://${new URL(driveUrl).host}/${phpMatch[1].replace(/^\/+/, "")}`;
    const phpRes = await fetch(phpUrl, {
      headers: { Referer: driveUrl, ...FOURK_HEADERS },
      signal: AbortSignal.timeout(6000),
    });
    if (!phpRes.ok) return null;
    const phpHtml = await phpRes.text();

    const genLinks = [...phpHtml.matchAll(/<a\s+[^>]*href=['"]([^"']+)['"][^>]*>(.*?)<\/a>/gis)].map((m) => ({
      href: m[1],
      text: m[2].replace(/<[^>]+>/g, "").trim(),
    }));

    // 1. Prefer 10Gbps Pixel / Google direct stream
    const worker10G = genLinks.find(
      (l) => l.href.includes("pixel.hubcloud") || l.href.includes("gpdl.hubcloud") || l.text.includes("10Gbps")
    );
    if (worker10G) {
      try {
        const rawUrl = worker10G.href.replace(/&amp;/g, "&");
        const r1 = await fetch(rawUrl, {
          redirect: "manual",
          headers: { Referer: phpUrl, ...FOURK_HEADERS },
          signal: AbortSignal.timeout(6000),
        });
        const loc1 = r1.headers.get("location");
        if (loc1) {
          let directLoc = loc1;
          try {
            const u1 = new URL(loc1);
            if (u1.searchParams.has("link")) {
              directLoc = u1.searchParams.get("link");
            } else {
              const r2 = await fetch(loc1, {
                redirect: "manual",
                headers: { Referer: rawUrl, ...FOURK_HEADERS },
                signal: AbortSignal.timeout(6000),
              });
              const loc2 = r2.headers.get("location");
              if (loc2) {
                const u2 = new URL(loc2);
                directLoc = u2.searchParams.get("link") || loc2;
              }
            }
          } catch {}
          if (directLoc && (directLoc.startsWith("http://") || directLoc.startsWith("https://"))) {
            return directLoc;
          }
        }
      } catch {
        /* continue to next link */
      }
    }

    // 2. Direct workers.dev file
    const workerDirect = genLinks.find(
      (l) => l.href.includes(".workers.dev") && (l.href.includes(".mkv") || l.href.includes(".mp4"))
    );
    if (workerDirect) return workerDirect.href;

    // 3. PixelDrain file
    const pxl = genLinks.find((l) => l.href.includes("pixeldrain"));
    if (pxl) return pxl.href.replace("/u/", "/api/file/");

    return null;
  } catch {
    return null;
  }
}

async function resolveProtectorToDrive(targetUrl) {
  if (targetUrl.includes("hubcloud.") && targetUrl.includes("/drive/")) return targetUrl;
  try {
    const redRes = await fetch(targetUrl, { headers: FOURK_HEADERS, signal: AbortSignal.timeout(6000) });
    if (!redRes.ok) return null;
    const redHtml = await redRes.text();
    const resolved = resolveRedirectUrl(redHtml);
    if (!resolved) return null;
    if (resolved.includes("hubcloud.") && resolved.includes("/drive/")) return resolved;

    // Intermediate hblinks/hubdrive page
    const hRes = await fetch(resolved, { headers: { Referer: targetUrl, ...FOURK_HEADERS }, signal: AbortSignal.timeout(6000) });
    if (hRes.ok) {
      const hHtml = await hRes.text();
      const m = hHtml.match(/href=['"](https?:\/\/[^'"\s>]*(?:hubcloud|hubdrive)\.[^'"\s>]*\/drive\/[^'"\s>]+)['"]/i);
      if (m) return m[1];
    }
  } catch {}
  return null;
}

async function resolve4kHubStreams({ title, year, type = "movie", season = 1, episode = 1 }) {
  const streams = [];
  try {
    const cleanTitle = title.replace(/[:!?\-]/g, " ").replace(/\s+/g, " ").trim();
    const searchUrl = `${FOURK_HOST}/?s=${encodeURIComponent(cleanTitle)}`;
    const sRes = await fetch(searchUrl, { headers: FOURK_HEADERS, signal: AbortSignal.timeout(6000) });
    if (!sRes.ok) return streams;
    const sHtml = await sRes.text();

    const linkMatches = [...sHtml.matchAll(/<a\s+[^>]*href=['"]([^"']+)['"][^>]*>(.*?)<\/a>/gis)]
      .map((m) => ({
        href: m[1],
        text: m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      }))
      .filter((l) =>
        (type === "tv" ? l.href.includes("series") : l.href.includes("movie")) &&
        !l.href.includes("/category/") &&
        !l.href.includes("/tag/")
      );

    if (!linkMatches.length) return streams;

    let matched = linkMatches[0];
    if (year) {
      const yMatch = linkMatches.find((l) => l.text.includes(String(year)));
      if (yMatch) matched = yMatch;
    }
    const postUrl = matched.href.startsWith("http")
      ? matched.href
      : `${FOURK_HOST}${matched.href.startsWith("/") ? "" : "/"}${matched.href}`;

    const postRes = await fetch(postUrl, { headers: FOURK_HEADERS, signal: AbortSignal.timeout(6000) });
    if (!postRes.ok) return streams;
    const postHtml = await postRes.text();

    if (type === "tv") {
      const epNum = String(episode).padStart(2, "0");
      const patterns = [`Episode-${epNum}`, `Episode-${episode}`, `Episode ${epNum}`, `Episode ${episode}`];
      let targetRedirectUrl = null;
      for (const pat of patterns) {
        const idx = postHtml.indexOf(pat);
        if (idx !== -1) {
          const chunk = postHtml.substring(idx, idx + 1400);
          const m = chunk.match(/href=['"](https?:\/\/[^'"\s>]*(?:greenmotors|hubcloud|gadgetsweb)[^'"\s>]*)['"]/i);
          if (m) {
            targetRedirectUrl = m[1];
            break;
          }
        }
      }
      if (targetRedirectUrl) {
        const driveUrl = await resolveProtectorToDrive(targetRedirectUrl);
        if (driveUrl) {
          const directUrl = await resolveDriveToDirect(driveUrl);
          if (directUrl) {
            streams.push({
              id: "hubcloud-tv-direct",
              name: "MOON [1080p] · Dual Audio Direct",
              server: "MOON",
              language: "hi",
              languageName: "Hindi + English Dual",
              quality: "1080p",
              url: directUrl,
              rawUrl: directUrl,
              type: "video",
              format: "video",
              subtitles: [],
            });
          }
        }
      }
    } else {
      // Movie: Parse sections by file-title
      const parts = postHtml.split(/class=['"]file-title['"][^>]*>/i);
      let fourKLink = null;
      let tenEightyLink = null;

      for (let i = 1; i < parts.length; i++) {
        const fileTitle = parts[i].split("</")[0].trim();
        const chunk = parts[i].substring(0, 2500);
        const m = chunk.match(/href=['"](https?:\/\/[^'"\s>]*(?:greenmotors|hubcloud|gadgetsweb)[^'"\s>]*)['"][^>]*>[\s\S]*?HubCloud/i) ||
                  chunk.match(/href=['"](https?:\/\/[^'"\s>]*(?:greenmotors|hubcloud|gadgetsweb)[^'"\s>]*)['"]/i);
        if (!m) continue;

        const is4K = /2160p|4k\b/i.test(fileTitle);
        const is1080 = /1080p/i.test(fileTitle);

        if (is4K && !fourKLink) {
          fourKLink = { title: fileTitle, url: m[1] };
        } else if (is1080 && !tenEightyLink) {
          tenEightyLink = { title: fileTitle, url: m[1] };
        }
        if (fourKLink && tenEightyLink) break;
      }

      if (fourKLink) {
        const driveUrl = await resolveProtectorToDrive(fourKLink.url);
        if (driveUrl) {
          const directUrl = await resolveDriveToDirect(driveUrl);
          if (directUrl) {
            streams.push({
              id: "hubcloud-4k",
              name: "MOON [4K UHD] · Dual Audio Direct",
              server: "MOON",
              language: "hi",
              languageName: "Hindi + English Dual [4K UHD]",
              quality: "4K",
              url: directUrl,
              rawUrl: directUrl,
              type: "video",
              format: "video",
              subtitles: [],
            });
          }
        }
      }

      if (tenEightyLink) {
        const driveUrl = await resolveProtectorToDrive(tenEightyLink.url);
        if (driveUrl) {
          const directUrl = await resolveDriveToDirect(driveUrl);
          if (directUrl) {
            streams.push({
              id: "hubcloud-1080p",
              name: "MOON [1080p] · Dual Audio Direct",
              server: "MOON",
              language: "hi",
              languageName: "Hindi + English Dual",
              quality: "1080p",
              url: directUrl,
              rawUrl: directUrl,
              type: "video",
              format: "video",
              subtitles: [],
            });
          }
        }
      }
    }
  } catch (err) {
    console.warn("resolve4kHubStreams error:", err);
  }
  return streams;
}

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "hubcloud-4k-resolver", ffmpeg: Boolean(ffmpegPath) });
});

app.get("/debug", (req, res) => {
  try {
    let exists = false;
    if (ffmpegPath && fs.existsSync(ffmpegPath)) {
      exists = true;
      try { fs.chmodSync(ffmpegPath, 0o755); } catch {}
    }
    const versionRun = exists ? spawnSync(ffmpegPath, ["-version"]) : null;
    let urlTest = null;
    if (exists && req.query.url) {
      const p = spawnSync(ffmpegPath, [
        "-hide_banner",
        "-user_agent", UA,
        "-i", req.query.url,
        "-t", "1",
        "-f", "null",
        "-",
      ], { timeout: 6000 });
      urlTest = {
        status: p.status,
        stderr: p.stderr ? p.stderr.toString().slice(-1000) : null,
        error: p.error ? p.error.message : null,
      };
    }
    res.json({
      platform: process.platform,
      arch: process.arch,
      ffmpegPath,
      exists,
      version: versionRun?.stdout ? versionRun.stdout.toString().split("\n")[0] : null,
      spawnError: versionRun?.error ? versionRun.error.message : null,
      urlTest,
    });
  } catch (err) {
    res.json({ error: err.message, stack: err.stack });
  }
});

app.get("/stream", (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("Missing url");

  if (ffmpegPath && fs.existsSync(ffmpegPath)) {
    try { fs.chmodSync(ffmpegPath, 0o755); } catch {}
  }

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Cache-Control", "no-cache");

  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-threads", "1",
    "-fflags", "nobuffer",
    "-analyzeduration", "1000000",
    "-probesize", "1000000",
    "-user_agent", UA,
    "-i", targetUrl,
    "-c:v", "copy",
    "-tag:v", "hvc1",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ac", "2",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4",
    "pipe:1",
  ];

  const proc = spawn(ffmpegPath, args);
  proc.stdout.pipe(res);

  proc.stderr.on("data", (d) => {
    console.warn("[ffmpeg /stream stderr]:", d.toString().slice(0, 200));
  });

  proc.on("error", (err) => {
    console.error("[ffmpeg spawn error]:", err);
    if (!res.headersSent) res.status(500).send("FFmpeg spawn error");
  });

  req.on("close", () => {
    try {
      proc.kill();
    } catch {}
  });
});

app.get("/resolve", async (req, res) => {
  const { title, year, type = "movie", season = 1, episode = 1 } = req.query;
  if (!title) {
    return res.status(400).json({ ok: false, error: "Missing title parameter" });
  }

  try {
    const streams = await resolve4kHubStreams({
      title: String(title),
      year: year ? String(year) : null,
      type: String(type),
      season: Number(season) || 1,
      episode: Number(episode) || 1,
    });

    const host = req.get("host") || "hubcloud-resolver.onrender.com";
    const proto = req.protocol === "http" && !host.includes("localhost") ? "https" : req.protocol;
    const baseUrl = `${proto}://${host}`;

    const formattedStreams = streams.map((s) => {
      if (s.quality === "4K" || s.id === "hubcloud-4k") {
        return {
          ...s,
          url: `${baseUrl}/stream?url=${encodeURIComponent(s.rawUrl || s.url)}`,
          rawUrl: s.rawUrl || s.url,
          type: "fmp4",
          format: "fmp4",
        };
      }
      return s;
    });

    return res.json({ ok: formattedStreams.length > 0, streams: formattedStreams });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`HubCloud 4K Resolver listening on port ${PORT}`);
});
