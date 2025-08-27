import { LunaUnload, Tracer } from "@luna/core";
import { MediaItem } from "@luna/lib";
import { observe } from "./observe";
import { checkSongInUserPlaylists } from "../../shared/playlistMembershipUtils";
import type { SongInPlaylistsResult } from "../../shared/playlistMembershipUtils";

export const { trace, errSignal } = Tracer("[PlaylistMembership]");
trace.msg.log("PlaylistMembership plugin loaded");

// Settings toggle (default: no badges, only attributes + native tooltip)
const DISABLE_MEMBERSHIP_BADGES = true;

// Optional Settings UI stub (no-op)
export const Settings = () => null;

// Allow Luna to dispose observers/intervals
export const unloads = new Set<LunaUnload>();

// Caching + simple concurrency gate
const membershipResultCache = new Map<string, SongInPlaylistsResult>();
const membershipInFlight = new Map<string, Promise<SongInPlaylistsResult>>();
const MAX_CONCURRENT_MEMBERSHIP = 5;
let inFlightCount = 0;
const membershipQueue: Array<() => void> = [];

function enqueueMembership<T>(task: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const run = () => {
      inFlightCount++;
      task()
        .then(resolve, reject)
        .finally(() => {
          inFlightCount--;
          const next = membershipQueue.shift();
          if (next) next();
        });
    };
    if (inFlightCount < MAX_CONCURRENT_MEMBERSHIP) run();
    else membershipQueue.push(run);
  });
}

async function getMembership(trackId: string): Promise<SongInPlaylistsResult> {
  const cached = membershipResultCache.get(trackId);
  if (cached) return cached;

  const inflight = membershipInFlight.get(trackId);
  if (inflight) return inflight;

  const p = enqueueMembership(async () => {
    const result = await checkSongInUserPlaylists(trackId);
    membershipResultCache.set(trackId, result);
    return result;
  }).finally(() => {
    membershipInFlight.delete(trackId);
  });

  membershipInFlight.set(trackId, p);
  return p;
}

// Optional badge styling (disabled by default)
let styleInjected = false;
function ensureStyle() {
  if (DISABLE_MEMBERSHIP_BADGES) return;
  if (styleInjected) return;
  const style = document.createElement("style");
  style.textContent = `
    .pm-membership-badge {
      display: inline-block;
      margin-left: 8px;
      padding: 2px 6px;
      border-radius: 10px;
      background: var(--primary-color, #3a3a3a);
      color: #fff;
      font-size: 11px;
      line-height: 1;
      vertical-align: middle;
      opacity: .9;
    }
  `;
  document.head.appendChild(style);
  styleInjected = true;
  unloads.add(() => style.remove());
}

function getBadgeContainer(host: HTMLElement): HTMLElement {
  if (host.matches?.('[data-test="table-cell-title"], [data-test="track-title"], [data-test*="title"]')) {
    return host;
  }
  const selectors = [
    '[data-test="table-cell-title"]',
    '[data-test="track-title"]',
    '[data-test*="title"]',
    'a[href*="/track/"]',
    'a[href*="/album/"]',
    '[class*="title"]'
  ];
  for (const sel of selectors) {
    const el = host.querySelector(sel) as HTMLElement | null;
    if (el) return (el.closest("div") as HTMLElement | null) ?? el;
  }
  return host;
}

function ensureRowBadge(row: Element, text: string, title?: string) {
  if (DISABLE_MEMBERSHIP_BADGES) return;
  ensureStyle();
  const host = row as HTMLElement;
  const container = getBadgeContainer(host);

  let badge = container.querySelector(".pm-membership-badge") as HTMLElement | null;
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "pm-membership-badge";
    container.appendChild(badge);
  }
  badge.textContent = text;
  if (title) badge.title = title;
}

function annotateRowWithMembership(row: Element, result: SongInPlaylistsResult) {
  const host = row as HTMLElement;
  host.setAttribute("data-ml-in-playlists", String(result.existsInPlaylists));
  host.setAttribute("data-ml-playlist-count", String(result.playlists.length));

  if (DISABLE_MEMBERSHIP_BADGES) {
    const count = result.playlists.length;
    const titles = result.playlists.map((p) => p.title).join(", ");
    // Native tooltip on host element
    host.title = count > 0 ? `In playlists: ${count} — ${titles}` : "Not in any playlists";
    return;
  }

  ensureStyle();
  const container = getBadgeContainer(host);
  let badge = container.querySelector(".pm-membership-badge") as HTMLElement | null;
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "pm-membership-badge";
    container.appendChild(badge);
  }
  const count = result.playlists.length;
  const titles = result.playlists.map((p) => p.title).join(", ");
  badge.textContent = `In playlists: ${count}`;
  badge.title = count > 0 ? titles : "Not in any playlists";
}

// Track id extraction helpers
function getTrackIdFromRow(host: HTMLElement): string | undefined {
  if (host.matches?.('[data-test="table-cell-title"]')) {
    const id = host.getAttribute("data-id") || host.getAttribute("data-track-id");
    if (id) return id;
  }
  const attrCandidates = [
    "data-track-id",
    "data-id",
    "data-item-id",
    "data-media-item-id",
    "data-product-id",
    "data-media-id",
    "data-row-id"
  ];
  for (const attr of attrCandidates) {
    const direct = host.getAttribute(attr);
    if (direct) return direct;
    const child = host.querySelector(`[${attr}]`) as HTMLElement | null;
    const viaChild = child?.getAttribute?.(attr);
    if (viaChild) return viaChild;
  }
  const link = (host.querySelector('a[href*="/track/"]') as HTMLAnchorElement | null)
    ?? (host.querySelector('a[href*="track/"]') as HTMLAnchorElement | null);
  const href = link?.href ?? link?.getAttribute?.("href");
  if (href) {
    const match = href.match(/\/track\/(\d+)/) ?? href.match(/track\/(\d+)/);
    if (match) return match[1];
  }
  return undefined;
}

function processTrackRow(row: Element) {
  const host = row as HTMLElement;
  if (host.getAttribute("data-ml-playlist-checked") === "1") return;

  const trackId = getTrackIdFromRow(host);
  if (!trackId) {
    host.setAttribute("data-ml-playlist-checked", "1");
    return;
  }

  host.setAttribute("data-ml-playlist-checked", "1");

  if (!DISABLE_MEMBERSHIP_BADGES) ensureRowBadge(row, "Checking…");

  // Warm resolve (best-effort, not awaited)
  MediaItem.fromId(trackId, "track").catch(() => undefined);

  getMembership(trackId)
    .then((res) => {
      if (!DISABLE_MEMBERSHIP_BADGES) {
        trace.msg.log(`PlaylistMembership: ${trackId} in ${res.playlists.length} playlists`);
      }
      annotateRowWithMembership(row, res);
    })
    .catch(trace.msg.err.withContext("membership.check"));
}

// Scan + observe
const rowSelectors = [
  'div[data-test="tracklist-row"]',
  'li[data-test="tracklist-row"]',
  '[data-track-id]',
  '[data-test="track-row"]',
  '[data-test="table-cell-title"]',
  'div[role="row"]',
  '[role="row"]',
  'tr'
];

function scanRowsOnce() {
  try {
    for (const sel of rowSelectors) {
      const nodes = document.querySelectorAll(sel);
      nodes.forEach((el) => {
        const host = el as HTMLElement;
        if (host.getAttribute("data-ml-playlist-checked") === "1") return;
        processTrackRow(host);
      });
    }
  } catch (e) {
    trace.msg.err.withContext("scanRowsOnce")(e);
  }
}

function startRowScan() {
  scanRowsOnce();
  const id = setInterval(scanRowsOnce, 1500);
  unloads.add(() => clearInterval(id));
}

function initObserver() {
  observe(
    unloads,
    'div[data-test="tracklist-row"], li[data-test="tracklist-row"], [data-track-id], [data-test="track-row"], [data-test="table-cell-title"], a[href*="/track/"], [data-test*="track"]',
    processTrackRow
  );
}

// Init
function init() {
  initObserver();
  startRowScan();

  // Clean up any existing badges if disabled
  if (DISABLE_MEMBERSHIP_BADGES) {
    document.querySelectorAll(".pm-membership-badge").forEach((el) => el.remove());
  }
}

init();