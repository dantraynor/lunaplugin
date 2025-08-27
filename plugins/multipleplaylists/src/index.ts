import { LunaUnload, Tracer } from "@luna/core";
import { MediaItem, redux, ContextMenu, Playlist } from "@luna/lib";
import { checkSongInUserPlaylists, checkSongInUserPlaylistsByMeta } from "./playlistMembershipUtils";
import { observe } from "./observe";
import type { SongInPlaylistsResult } from "./playlistMembershipUtils";

export const { trace, errSignal } = Tracer("[MultiplePlaylists]");
// You typically will never manually set errSignal. Its handled when trace.err or similar is called

trace.msg.log(`MultiplePlaylists plugin loaded for ${redux.store.getState().user?.meta?.profileName || 'user'}`);

/**
 * Settings toggle to suppress all badges and logs at runtime.
 * Temporary hard switch until Settings UI is wired:
 * - Set to false to enable badges
 * - Set to true to disable badges (default)
 */
const DISABLE_MEMBERSHIP_BADGES = true;

// plugin settings
export { Settings } from "./Settings";
export { checkSongInUserPlaylists };

 // Functions in unloads are called when plugin is unloaded.
 // Used to clean up resources, event listener dispose etc should be added here
 export const unloads = new Set<LunaUnload>();

 // Track id currently shown in the "Add to Multiple Playlists" modal
 let currentSongIdForModal: string | undefined;
 // Current song metadata for modal (for fallback membership checks by title/artist)
 let currentSongMetaForModal: { title: string; artist?: string } | undefined;

 // Remember recent additions so immediate re-open reflects state even if backend/API caches lag
 const recentlyAddedByTrack = new Map<string, Set<string>>();
 function rememberRecentlyAdded(trackId: string, playlistId: string) {
   const tid = String(trackId);
   const pid = String(playlistId);
   let set = recentlyAddedByTrack.get(tid);
   if (!set) {
     set = new Set<string>();
     recentlyAddedByTrack.set(tid, set);
   }
   set.add(pid);
   // Expire after 2 minutes to avoid stale state if the page stays open
   setTimeout(() => {
     const s = recentlyAddedByTrack.get(tid);
     if (!s) return;
     s.delete(pid);
     if (s.size === 0) recentlyAddedByTrack.delete(tid);
   }, 120_000);
 }
 
 // Playlist membership observer: caching, badge rendering, and observe hookup
const membershipResultCache = new Map<string, SongInPlaylistsResult>();
const membershipInFlight = new Map<string, Promise<SongInPlaylistsResult>>();
const MAX_CONCURRENT_MEMBERSHIP = 5;
let inFlightCount = 0;
const membershipQueue: Array<() => void> = [];

 // Simple concurrency gate for membership checks
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

  const existing = membershipInFlight.get(trackId);
  if (existing) return existing;

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

let mlStyleInjected = false;
function ensureMembershipStyle() {
  if (DISABLE_MEMBERSHIP_BADGES) return;
  if (mlStyleInjected) return;
  const style = document.createElement("style");
  style.textContent = `
    .ml-membership-badge { display:inline-block; margin-left:8px; padding:2px 6px; border-radius:10px; background: var(--primary-color, #3a3a3a); color:#fff; font-size:11px; line-height:1; vertical-align: middle; opacity:.9; }
  `;
  document.head.appendChild(style);
  mlStyleInjected = true;
  unloads.add(() => style.remove());
}
// Choose a good container within the row to place the badge
function getBadgeContainer(host: HTMLElement): HTMLElement {
  // If the host itself is the title cell, use it directly
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
// Ensure a placeholder badge exists while membership is being resolved
function ensureRowBadge(row: Element, text: string, title?: string) {
  if (DISABLE_MEMBERSHIP_BADGES) return;
  ensureMembershipStyle();
  const host = row as HTMLElement;
  const container = getBadgeContainer(host);

  let badge = container.querySelector(".ml-membership-badge") as HTMLElement | null;
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "ml-membership-badge";
    container.appendChild(badge);
  }
  badge.textContent = text;
  if (title) badge.title = title;
}

function annotateRowWithMembership(row: Element, result: SongInPlaylistsResult) {
  // Always set attributes (for consumers)
  const host = row as HTMLElement;
  host.setAttribute("data-ml-in-playlists", String(result.existsInPlaylists));
  host.setAttribute("data-ml-playlist-count", String(result.playlists.length));

  // When badges are disabled, surface info via native tooltip instead of UI elements
  if (DISABLE_MEMBERSHIP_BADGES) {
    const count = result.playlists.length;
    const titles = result.playlists.map((p) => p.title).join(", ");
    host.title = count > 0 ? `In playlists: ${count} — ${titles}` : "Not in any playlists";
    return;
  }

  ensureMembershipStyle();
  const container = getBadgeContainer(host);
  let badge = container.querySelector(".ml-membership-badge") as HTMLElement | null;
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "ml-membership-badge";
    container.appendChild(badge);
  }
  const count = result.playlists.length;
  const titles = result.playlists.map((p) => p.title).join(", ");
  badge.textContent = `In playlists: ${count}`;
  badge.title = count > 0 ? titles : "Not in any playlists";
}

// Try to robustly extract a track id from a row
function getTrackIdFromRow(host: HTMLElement): string | undefined {
  // Direct title cell carries the id we need
  if (host.matches?.('[data-test="table-cell-title"]')) {
    const id = host.getAttribute("data-id") || host.getAttribute("data-track-id");
    if (id) return id;
  }

  // Common attribute candidates on row or descendants
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

  // Fallback to anchors that link to a track detail page
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

  // Robust id extraction (attributes, descendants, link fallback)
  const trackId = getTrackIdFromRow(host);

  if (!trackId) {
    host.setAttribute("data-ml-playlist-checked", "1");
    return;
  }

  host.setAttribute("data-ml-playlist-checked", "1");

   // Show placeholder while checking (only when enabled)
  if (!DISABLE_MEMBERSHIP_BADGES) ensureRowBadge(row, "Checking…");

  // Resolve MediaItem for parity with requested flow; tolerate failure
  MediaItem.fromId(trackId, "track").catch(() => undefined);

  getMembership(trackId)
    .then((res) => {
      if (!DISABLE_MEMBERSHIP_BADGES) {
        trace.msg.log(
          `MultiplePlaylists: membership for ${trackId} -> ${res.existsInPlaylists ? res.playlists.length : 0}`
        );
      }
      annotateRowWithMembership(row, res);
    })
    .catch(trace.msg.err.withContext("membership.check"));
}
 // Periodic scanner to catch rows missed by MutationObserver (virtualized lists, delayed renders)
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
 // Debug: mark title cells so we can verify selector coverage quickly
function debugMarkTitles() {
  // When badges are disabled, do nothing (prevent any UI/log spam)
  if (DISABLE_MEMBERSHIP_BADGES) return;
  try {
    const nodes = document.querySelectorAll('[data-test="table-cell-title"]');
    nodes.forEach((n) => {
      const host = n as HTMLElement;
      if (host.querySelector(".ml-debug-title")) return;
      const s = document.createElement("span");
      s.className = "ml-debug-title";
      s.textContent = " ML";
      s.style.cssText =
        "margin-left:6px;padding:1px 4px;border-radius:8px;background:#666;color:#fff;font-size:10px;opacity:.6;";
      host.appendChild(s);
    });
  } catch {
    // swallow debug errors silently
  }
}


function initPlaylistMembershipObserver() {
  // Broaden selector to catch different list implementations
  observe(
    unloads,
    'div[data-test="tracklist-row"], li[data-test="tracklist-row"], [data-track-id], [data-test="track-row"], [data-test="table-cell-title"], a[href*="/track/"], [data-test*="track"]',
    processTrackRow
  );
}
 // moved unloads declaration above

// Function to show playlist selector modal
async function showPlaylistSelector(song: MediaItem) {

    // Create modal overlay
    const overlay = document.createElement('div');
    overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10000;
    `;

    // Create modal content
    const modal = document.createElement('div');
    modal.style.cssText = `
        background: var(--background-color, #1a1a1a);
        border-radius: 8px;
        padding: 24px;
        max-width: 500px;
        width: 90%;
        max-height: 80vh;
        overflow-y: auto;
        color: var(--text-color, white);
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
    `;

    // Get song details
    const songTitle = song.title ? await song.title() : 'Unknown Song';
    let songArtist = 'Unknown Artist';
    
    // Try to get artist information
    try {
        if (song.artist) {
            const artist = await song.artist();
            if (artist && artist.name) {
                songArtist = artist.name;
            }
        } else if (song.artists) {
            const artists = await song.artists();
            if (artists && artists.length > 0) {
                // Get the first artist
                const firstArtist = await artists[0];
                if (firstArtist && firstArtist.name) {
                    songArtist = firstArtist.name;
                }
            }
        }
    } catch (error) {
        trace.err("Error getting artist information:", error);
        songArtist = 'Unknown Artist';
    }

    // Expose meta for membership fallback in list render
    currentSongMetaForModal = { title: songTitle, artist: songArtist !== 'Unknown Artist' ? songArtist : undefined };

    modal.innerHTML = `
        <h2 style="margin: 0 0 16px 0; font-size: 18px;">Add to Multiple Playlists</h2>
        <div style="margin-bottom: 16px; padding: 12px; background: rgba(255,255,255,0.05); border-radius: 4px;">
            <div style="font-weight: 500;">${songTitle}</div>
            <div style="font-size: 14px; opacity: 0.7;">${songArtist}</div>
        </div>
        <p style="margin: 0 0 16px 0; opacity: 0.7;">Select playlists to add this song to:</p>
        <div id="playlist-list" style="margin-bottom: 20px;"></div>
        <div style="display: flex; gap: 12px; justify-content: flex-end;">
            <button id="cancel-btn" style="
                padding: 8px 16px;
                background: transparent;
                border: 1px solid var(--border-color, #444);
                border-radius: 4px;
                color: var(--text-color, white);
                cursor: pointer;
            ">Cancel</button>
            <button id="add-btn" style="
                padding: 8px 16px;
                background: var(--primary-color, #007acc);
                border: none;
                border-radius: 4px;
                color: white;
                cursor: pointer;
            ">Add to Selected Playlists</button>
        </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Populate playlist list
    currentSongIdForModal = song.id;
    populatePlaylistList();

    // Event listeners
    const cancelBtn = modal.querySelector('#cancel-btn');
    const addBtn = modal.querySelector('#add-btn');

    cancelBtn?.addEventListener('click', () => {
        document.body.removeChild(overlay);
    });

    addBtn?.addEventListener('click', () => {
        addToSelectedPlaylists(song);
        document.body.removeChild(overlay);
    });

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            document.body.removeChild(overlay);
        }
    });
}

// Function to populate the playlist list using a safer approach
async function populatePlaylistList() {
    const playlistContainer = document.querySelector('#playlist-list');
    if (!playlistContainer) return;

    try {
        // Try to use Playlist API methods if available (safer approach)
        let playlistsArray: any[] = [];
        
        try {
            if (typeof (Playlist as any).getUserPlaylists === 'function') {
                playlistsArray = await (Playlist as any).getUserPlaylists();
                trace.log("Successfully used Playlist.getUserPlaylists()");
            } else if (typeof (Playlist as any).getMyPlaylists === 'function') {
                playlistsArray = await (Playlist as any).getMyPlaylists();
                trace.log("Successfully used Playlist.getMyPlaylists()");
            } else {
                trace.log("No safer playlist API found, using Redux store with security filtering");
                return populatePlaylistListFromRedux();
            }
        } catch (error) {
            trace.err("Error using Playlist API methods:", error);
            return populatePlaylistListFromRedux();
        }

        if (playlistsArray.length === 0) {
            playlistContainer.innerHTML = '<p style="opacity: 0.7;">No playlists found. Create some playlists first!</p>';
            return;
        }
        
        // Build a set of playlists that already contain the current song
        let inSet = new Set<string>();
        try {
            if (currentSongIdForModal) {
                const res = await checkSongInUserPlaylists(currentSongIdForModal);
                inSet = new Set(res.playlists.map((p) => p.uuid));
            }
        } catch {}
        // Fallback: if id-based check returns nothing, try metadata match
        try {
            if (inSet.size === 0 && currentSongMetaForModal?.title) {
                const resMeta = await checkSongInUserPlaylistsByMeta(currentSongMetaForModal);
                inSet = new Set(resMeta.playlists.map((p) => p.uuid));
            }
        } catch {}

        // Union with locally remembered recent additions (handles API cache lag)
        try {
            const recent = currentSongIdForModal ? recentlyAddedByTrack.get(String(currentSongIdForModal)) : undefined;
            if (recent && recent.size) {
                recent.forEach((pid) => inSet.add(pid));
            }
        } catch {}

        playlistContainer.innerHTML = playlistsArray
            .map((playlist: any) => {
                const uuid = playlist.uuid || playlist.id;
                const inThis = inSet.has(uuid);
                return `
                <label style="
                    display: flex;
                    align-items: center;
                    padding: 8px;
                    margin-bottom: 4px;
                    cursor: pointer;
                    border-radius: 4px;
                    transition: background 0.2s;
                " onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='transparent'">
                    <input type="checkbox"
                           data-playlist-id="${uuid}"
                           ${inThis ? 'checked disabled' : ''}
                           style="margin-right: 12px; cursor: pointer;">
                    <div>
                        <div style="font-weight: 500;">${playlist.title || playlist.name || 'Untitled Playlist'}</div>
                        <div style="font-size: 12px; opacity: 0.7;">
                            ${playlist.numberOfTracks || playlist.trackCount || 0} tracks${inThis ? ' • Already contains' : ''}
                        </div>
                    </div>
                </label>
            `;
            }).join('');
    } catch (error) {
        trace.err("Error loading playlists:", error);
        playlistContainer.innerHTML = '<p style="color: #ff6b6b;">Error loading playlists</p>';
    }
}

// Fallback function to populate playlist list from Redux with enhanced security
async function populatePlaylistListFromRedux() {
    const playlistContainer = document.querySelector('#playlist-list');
    if (!playlistContainer) return;

    try {
        // Get playlists from redux store
        const state = redux.store.getState();
        const playlists = state.content?.playlists || {};

        if (Object.keys(playlists).length === 0) {
            playlistContainer.innerHTML = '<p style="opacity: 0.7;">No playlists found. Create some playlists first!</p>';
            return;
        }

        // Get current user information from the proper location based on Luna patterns
        const currentUser = state.user?.meta;
        const currentUserId = currentUser?.id;
        
        trace.log("Current user ID for playlist filtering:", currentUserId);

        const playlistsArray = Object.values(playlists).filter((playlist: any) => {
            if (!playlist || playlist.type !== 'USER') {
                return false;
            }
            
            // If we can't determine the current user, this is a critical security issue
            // In this case, we should not show any playlists to prevent data leakage
            if (!currentUserId) {
                trace.err("SECURITY WARNING: Cannot determine current user ID - not showing any playlists to prevent showing other users' playlists");
                return false;
            }
            
            // Check playlist ownership using the creator field (as seen in TidaLuna source)
            const playlistCreatorId = playlist.creator?.id;
            
            // Only return playlists that belong to the current user
            const isCurrentUserPlaylist = playlistCreatorId === currentUserId;
            
            if (!isCurrentUserPlaylist) {
                trace.log(`Filtering out playlist "${playlist.title}" - creator ID: ${playlistCreatorId}, current user ID: ${currentUserId}`);
            }
            
            return isCurrentUserPlaylist;
        });
        
        // Additional security check
        if (Object.keys(playlists).length > 0 && playlistsArray.length === 0 && currentUserId) {
            trace.err("SECURITY WARNING: Found playlists in store but none match current user - possible data leakage prevention");
            playlistContainer.innerHTML = '<p style="color: #ff6b6b;">Unable to load your playlists. Please try again.</p>';
            return;
        }
        
        // Build a set of playlists that already contain the current song
        let inSet = new Set<string>();
        try {
            if (currentSongIdForModal) {
                const res = await checkSongInUserPlaylists(currentSongIdForModal);
                inSet = new Set(res.playlists.map((p) => p.uuid));
            }
        } catch {}
        // Fallback: if id-based check returns nothing, try metadata match
        try {
            if (inSet.size === 0 && currentSongMetaForModal?.title) {
                const resMeta = await checkSongInUserPlaylistsByMeta(currentSongMetaForModal);
                inSet = new Set(resMeta.playlists.map((p) => p.uuid));
            }
        } catch {}

        // Union with locally remembered recent additions (handles API cache lag)
        try {
            const recent = currentSongIdForModal ? recentlyAddedByTrack.get(String(currentSongIdForModal)) : undefined;
            if (recent && recent.size) {
                recent.forEach((pid) => inSet.add(pid));
            }
        } catch {}

        playlistContainer.innerHTML = playlistsArray
            .map((playlist: any) => {
                const uuid = playlist.uuid;
                const inThis = inSet.has(uuid);
                return `
                <label style="
                    display: flex;
                    align-items: center;
                    padding: 8px;
                    margin-bottom: 4px;
                    cursor: pointer;
                    border-radius: 4px;
                    transition: background 0.2s;
                " onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='transparent'">
                    <input type="checkbox"
                           data-playlist-id="${uuid}"
                           ${inThis ? 'checked disabled' : ''}
                           style="margin-right: 12px; cursor: pointer;">
                    <div>
                        <div style="font-weight: 500;">${playlist.title || 'Untitled Playlist'}</div>
                        <div style="font-size: 12px; opacity: 0.7;">
                            ${playlist.numberOfTracks || 0} tracks${inThis ? ' • Already contains' : ''}
                        </div>
                    </div>
                </label>
            `;
            }).join('');
    } catch (error) {
        trace.err("Error loading playlists:", error);
        playlistContainer.innerHTML = '<p style="color: #ff6b6b;">Error loading playlists</p>';
    }
}

// Function to add song to selected playlists
async function addToSelectedPlaylists(song: MediaItem) {

    const checkboxes = document.querySelectorAll('#playlist-list input[type="checkbox"]:checked:not(:disabled)');
    const selectedPlaylistIds = Array.from(checkboxes).map((cb: any) => cb.dataset.playlistId);

    if (selectedPlaylistIds.length === 0) {
        showNotification('Please select at least one playlist', 'error');
        return;
    }

    try {
        const songTitle = song.title ? await song.title() : 'Unknown Song';
        let successCount = 0;
        let errorCount = 0;

        // Add to each selected playlist
        for (const playlistId of selectedPlaylistIds) {
            try {
                // Use the Redux action helper method instead of direct dispatch
                redux.actions["content/ADD_MEDIA_ITEMS_TO_PLAYLIST"]({
                    playlistUUID: playlistId,
                    mediaItemIdsToAdd: [song.id],
                    addToIndex: -1, // Add to end
                    onDupes: "SKIP", // Skip if song already exists in playlist
                    showNotification: false // Don't show internal notifications since we handle our own
                });
                // Optimistically remember so re-opening the modal reflects "Already contains" immediately
                rememberRecentlyAdded(String(song.id), String(playlistId));
                successCount++;
            } catch (error) {
                trace.err(`Error adding to playlist ${playlistId}:`, error);
                errorCount++;
            }
        }
        // Invalidate local membership cache for this track so the next modal open refetches
        membershipResultCache.delete(String(song.id));

        // Show result notification (only show errors by default)
        if (errorCount > 0) {
            const message = successCount > 0 
                ? `"${songTitle}" added to ${successCount} playlist${successCount > 1 ? 's' : ''} (${errorCount} failed)`
                : `Failed to add "${songTitle}" to playlists`;
            showNotification(message, 'error');
        }
        // Optionally show success notification (can be made configurable later)
        // else {
        //     showNotification(`"${songTitle}" added to ${successCount} playlist${successCount > 1 ? 's' : ''}`, 'success');
        // }

    } catch (error) {
        trace.err("Error adding song to playlists:", error);
        showNotification('Error adding song to playlists', 'error');
    }
}

// Function to show notification
function showNotification(message: string, type: 'success' | 'warning' | 'error') {
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        padding: 8px 12px;
        border-radius: 4px;
        color: white;
        font-size: 14px;
        z-index: 10001;
        max-width: 250px;
        word-wrap: break-word;
        background: ${type === 'success' ? '#4caf50' : type === 'warning' ? '#ff9800' : '#f44336'};
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
        transform: translateX(300px);
        transition: transform 0.2s ease;
        opacity: 0.9;
    `;
    notification.textContent = message;

    document.body.appendChild(notification);

    // Animate in
    setTimeout(() => {
        notification.style.transform = 'translateX(0)';
    }, 50);

    // Auto remove after 3 seconds (shorter duration)
    setTimeout(() => {
        notification.style.transform = 'translateX(300px)';
        setTimeout(() => {
            if (notification.parentNode) {
                document.body.removeChild(notification);
            }
        }, 200);
    }, 3000);
}

// Initialize plugin
function init() {
    // Add context menu integration
    setupContextMenuIntegration();
    // Start playlist membership observer
    initPlaylistMembershipObserver();
    startRowScan();

    // Remove any previously rendered badges or debug markers when disabled
    if (DISABLE_MEMBERSHIP_BADGES) {
      document.querySelectorAll(".ml-membership-badge,.ml-debug-title").forEach((el) => el.remove());
    }
}

// Setup context menu integration for "Add to Multiple Playlists"
function setupContextMenuIntegration() {
    const contextMenuButton = (ContextMenu as any).addButton(unloads);
    contextMenuButton.text = "Add to Multiple Playlists";
    
    // Store the context menu song ID for use in onClick
    let contextMenuSongId: redux.ItemId | null = null;
    let contextMenuContentType: redux.ContentType = "track";
    
    contextMenuButton.onClick(async () => {
        // Close the context menu first
        redux.actions["contextMenu/CLOSE"]();
        
        // Small delay to ensure context menu is closed
        setTimeout(async () => {
            if (contextMenuSongId) {
                // Get the actual MediaItem instance for the right-clicked song
                try {
                    const mediaItem = await MediaItem.fromId(contextMenuSongId, contextMenuContentType);
                    if (mediaItem) {
                        await showPlaylistSelector(mediaItem);
                    } else {
                        showNotification('Could not load song information', 'error');
                    }
                } catch (error) {
                    trace.err("Error loading MediaItem from context menu:", error);
                    showNotification('Error loading song information', 'error');
                }
            } else {
                showNotification("No song selected", "error");
            }
        }, 100);
    });
    
    // Only show the button for media item context menus and capture the song ID
    ContextMenu.onMediaItem(unloads, async ({ mediaCollection, contextMenu }) => {
        // Store the song ID from the context menu for later use
        try {
            // Handle different types of media collections
            if (mediaCollection && typeof mediaCollection === 'object') {
                // For MediaItems collections, get the first MediaItem
                if ('mediaItems' in mediaCollection && typeof mediaCollection.mediaItems === 'function') {
                    // This is an Album or Playlist
                    const mediaItemsGenerator = await mediaCollection.mediaItems();
                    for await (const mediaItem of mediaItemsGenerator) {
                        contextMenuSongId = mediaItem.id;
                        contextMenuContentType = mediaItem.contentType;
                        break; // We only need the first one
                    }
                } else {
                    // This might be MediaItems collection - try to iterate directly
                    for await (const mediaItem of mediaCollection as any) {
                        contextMenuSongId = mediaItem.id;
                        contextMenuContentType = mediaItem.contentType;
                        break; // We only need the first one
                    }
                }
            }
        } catch (error) {
            trace.err("Error getting MediaItem from context menu:", error);
            contextMenuSongId = null;
        }
        
        // Show our button in the context menu
        await contextMenuButton.show(contextMenu);
    });
}

// Start the plugin
init();