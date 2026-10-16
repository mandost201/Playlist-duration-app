// Vercel serverless function: GET /api/duration?url=<playlist link ya ID>
// YouTube playlist ki tamam public videos ki exact durations jod kar total nikalta hai.
export const maxDuration = 60;

const API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const CLIENT_VERSION = "2.20261015.01.00";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const MAX_PAGES = 45; // ~4500 videos (YouTube playlists max 5000 videos)

function extractPlaylistId(input) {
  const s = String(input || "").trim();
  if (!s) return null;
  try {
    const u = new URL(s.includes("://") ? s : "https://" + s);
    const host = u.hostname.replace(/^www\./, "");
    if (
      host === "youtube.com" ||
      host === "music.youtube.com" ||
      host === "m.youtube.com" ||
      host === "youtu.be"
    ) {
      const list = u.searchParams.get("list");
      if (list) return list;
    }
  } catch {
    /* URL nahi, shayad raw ID hai */
  }
  if (/^[A-Za-z0-9_-]{10,}$/.test(s)) return s;
  return null;
}

function parseDuration(text) {
  const m = /^(\d{1,3}):(\d{2})(?::(\d{2}))?$/.exec(String(text || "").trim());
  if (!m) return null;
  const a = +m[1],
    b = +m[2],
    c = m[3] ? +m[3] : 0;
  if (b > 59 || c > 59) return null;
  return m[3] ? a * 3600 + b * 60 + c : a * 60 + b;
}

async function ytBrowse({ browseId, continuation }) {
  const body = {
    context: {
      client: {
        clientName: "WEB",
        clientVersion: CLIENT_VERSION,
        hl: "en",
        gl: "US",
        userAgent: UA,
      },
    },
    ...(continuation ? { continuation } : { browseId }),
  };
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(
        `https://www.youtube.com/youtubei/v1/browse?key=${API_KEY}&prettyPrint=false`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": UA,
            "X-YouTube-Client-Name": "1",
            "X-YouTube-Client-Version": CLIENT_VERSION,
            Origin: "https://www.youtube.com",
            Referer: "https://www.youtube.com/",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        }
      );
      if (!r.ok) throw new Error("YouTube HTTP " + r.status);
      return await r.json();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw lastErr;
}

function tokenFromContinuationItem(item) {
  return (
    item?.continuationItemViewModel?.continuationCommand?.innertubeCommand
      ?.continuationCommand?.token || null
  );
}

function extractVideos(items, acc) {
  for (const it of items || []) {
    const lv = it?.lockupViewModel;
    if (lv) {
      if (lv.contentType && lv.contentType !== "LOCKUP_CONTENT_TYPE_VIDEO") {
        acc.skipped++;
        continue;
      }
      const overlays = lv?.contentImage?.thumbnailViewModel?.overlays || [];
      let secs = null,
        text = null;
      outer: for (const o of overlays) {
        const badges = o?.thumbnailBottomOverlayViewModel?.badges || [];
        for (const b of badges) {
          const t = b?.thumbnailBadgeViewModel?.text;
          const p = parseDuration(t);
          if (p !== null) {
            secs = p;
            text = String(t).trim();
            break outer;
          }
        }
      }
      const meta = lv?.metadata?.lockupMetadataViewModel || {};
      const title =
        meta?.title?.simpleText ||
        meta?.title?.runs?.[0]?.text ||
        lv.contentId ||
        "Video";
      if (secs === null) {
        acc.skipped++;
      } else {
        acc.total += secs;
        acc.videos.push({ id: lv.contentId, title, seconds: secs, text });
      }
      continue;
    }
    const tok = tokenFromContinuationItem(it);
    if (tok) acc.nextToken = tok;
  }
}

export async function getPlaylistDuration(playlistId) {
  const acc = {
    total: 0,
    skipped: 0,
    videos: [],
    nextToken: null,
    pages: 0,
    title: null,
    truncated: false,
  };
  let resp = await ytBrowse({ browseId: "VL" + playlistId });
  if (resp?.error) throw Object.assign(new Error("NOT_FOUND"), { status: 404 });
  acc.pages++;
  const primary =
    resp?.sidebar?.playlistSidebarRenderer?.items?.[0]
      ?.playlistSidebarPrimaryInfoRenderer;
  acc.title =
    primary?.title?.runs?.[0]?.text ||
    resp?.header?.playlistHeaderRenderer?.title?.simpleText ||
    "Playlist";
  const sections =
    resp?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer
      ?.content?.sectionListRenderer?.contents || [];
  for (const s of sections) {
    const tok = tokenFromContinuationItem(s);
    if (tok) acc.nextToken = tok;
    extractVideos(s?.itemSectionRenderer?.contents, acc);
  }
  while (acc.nextToken && acc.pages < MAX_PAGES) {
    const token = acc.nextToken;
    acc.nextToken = null;
    resp = await ytBrowse({ continuation: token });
    acc.pages++;
    for (const a of resp?.onResponseReceivedActions || []) {
      extractVideos(a?.appendContinuationItemsAction?.continuationItems, acc);
      extractVideos(a?.reloadContinuationItemsCommand?.continuationItems, acc);
    }
  }
  if (acc.nextToken) acc.truncated = true;
  return acc;
}

function formatHMS(total) {
  const h = Math.floor(total / 3600),
    m = Math.floor((total % 3600) / 60),
    s = total % 60;
  const p = (n) => String(n).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(s)}`;
}

export default async function handler(req, res) {
  try {
    const fromQuery = req.query?.url;
    const fromUrl = req.url
      ? new URL(req.url, "http://x").searchParams.get("url")
      : null;
    const pid = extractPlaylistId(fromQuery || fromUrl);
    if (!pid) {
      res
        .status(400)
        .json({ error: "Sahi YouTube playlist link ya playlist ID dalein." });
      return;
    }
    const acc = await getPlaylistDuration(pid);
    if (acc.videos.length === 0 && acc.skipped === 0) {
      res.status(404).json({
        error:
          "Playlist nahi mili — link ghalat hai ya playlist private/empty hai.",
      });
      return;
    }
    const avg = acc.videos.length ? Math.round(acc.total / acc.videos.length) : 0;
    res.status(200).json({
      title: acc.title,
      playlistId: pid,
      totalSeconds: acc.total,
      formatted: formatHMS(acc.total),
      hours: Math.floor(acc.total / 3600),
      minutes: Math.floor((acc.total % 3600) / 60),
      seconds: acc.total % 60,
      videoCount: acc.videos.length,
      skippedCount: acc.skipped,
      averageSeconds: avg,
      averageFormatted: formatHMS(avg),
      truncated: acc.truncated,
      videos: acc.videos,
    });
  } catch (e) {
    const code = e?.status === 404 ? 404 : 502;
    res.status(code).json({
      error:
        code === 404
          ? "Playlist nahi mili — link ghalat hai ya playlist private hai."
          : "YouTube se data lane mein masla hua. Thodi dair baad dobara try karein.",
    });
  }
}
