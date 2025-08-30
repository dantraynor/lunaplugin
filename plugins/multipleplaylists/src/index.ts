import { LunaUnload, Tracer } from "@luna/core";
import { MediaItem, redux, ContextMenu } from "@luna/lib";

export const { trace } = Tracer("[MultiplePlaylists]");

trace.msg.log(`Hello ${redux.store.getState().user.meta.profileName} from the MultiplePlaylists plugin!`);

export { Settings } from "./Settings.js";

export const unloads = new Set<LunaUnload>();

// Example: Log to console whenever changing page
redux.intercept("page/SET_PAGE_ID", unloads, console.log);

// Example: Alert on media transition
MediaItem.onMediaTransition(unloads, async (mediaItem: any) => {
    const title = await mediaItem.title();
    trace.msg.log(`Media item transitioned: ${title}`);
});

// Function to show playlist selector modal (complete implementation)
async function showPlaylistSelector(song: any) {
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
        if ((song as any).artist) {
            const artist = await (song as any).artist();
            if (artist && artist.name) {
                songArtist = artist.name;
            }
        } else if ((song as any).artists) {
            const artists = await (song as any).artists();
            if (artists && artists.length > 0) {
                const firstArtist = await artists[0];
                if (firstArtist && firstArtist.name) {
                    songArtist = firstArtist.name;
                }
            }
        }
    } catch (_error) {
        // swallow artist info errors silently
        songArtist = 'Unknown Artist';
    }

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
    populatePlaylistList();

    // Event listeners
    const cancelBtn = modal.querySelector('#cancel-btn');
    const addBtn = modal.querySelector('#add-btn');

    cancelBtn?.addEventListener('click', () => {
        document.body.removeChild(overlay);
    });

    addBtn?.addEventListener('click', () => {
        void addToSelectedPlaylists(song);
        document.body.removeChild(overlay);
    });

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            document.body.removeChild(overlay);
        }
    });
}

// Function to populate the playlist list
function populatePlaylistList() {
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

        const playlistsArray = Object.values(playlists).filter((playlist: any) => 
            playlist && playlist.type === 'USER'
        );
        
        playlistContainer.innerHTML = playlistsArray
            .map((playlist: any) => `
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
                           data-playlist-id="${playlist.uuid}" 
                           style="margin-right: 12px; cursor: pointer;">
                    <div>
                        <div style="font-weight: 500;">${playlist.title || 'Untitled Playlist'}</div>
                        <div style="font-size: 12px; opacity: 0.7;">${playlist.numberOfTracks || 0} tracks</div>
                    </div>
                </label>
            `).join('');
    } catch (error) {
        // swallow playlist load errors silently
        playlistContainer.innerHTML = '<p style="color: #ff6b6b;">Error loading playlists</p>';
    }
}

// Function to add song to selected playlists from the modal, and persist selection
async function addToSelectedPlaylists(song: any) {
    const checkboxes = document.querySelectorAll('#playlist-list input[type="checkbox"]:checked');
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
                redux.store.dispatch({
                    type: 'content/ADD_MEDIA_ITEMS_TO_PLAYLIST',
                    payload: {
                        playlistUUID: playlistId,
                        mediaItemIdsToAdd: [song.id],
                        addToIndex: -1 // Add to end
                    }
                });
                successCount++;
            } catch (error) {
                // ignore per-playlist errors; we'll reflect in the count
                errorCount++;
            }
        }

        // Show result notification (console only, no UI toast)
        const message = errorCount === 0 
            ? `"${songTitle}" added to ${successCount} playlist${successCount > 1 ? 's' : ''}`
            : `"${songTitle}" added to ${successCount} playlist${successCount > 1 ? 's' : ''} (${errorCount} failed)`;
        showNotification(message, errorCount === 0 ? 'success' : 'warning');

    } catch (error) {
        // ignore outer add errors but surface a generic message
        showNotification('Error adding song to playlists', 'error');
    }
}

// Function to show notification
function showNotification(_message: string, _type: 'success' | 'warning' | 'error') {
    // No-op: intentionally suppress all pop-up/console notifications
}

// Initialize plugin
function init() {
    // Add context menu integration
    setupContextMenuIntegration();
}

// Setup context menu integration for "Add to Multiple Playlists"
function setupContextMenuIntegration() {
    const contextMenuButton = (ContextMenu as any).addButton(unloads);
    contextMenuButton.text = "Add to Multiple Playlists";
    
    // Store the context menu song ID for use in onClick
    let contextMenuSongId: any = null;
    let contextMenuContentType: any = "track";
    
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
                        const title = await mediaItem.title();
                        await showPlaylistSelector(mediaItem);
                    } else {
                        showNotification('Could not load song information', 'error');
                    }
                } catch (error) {
                    // swallow media item load errors
                    showNotification('Error loading song information', 'error');
                }
            } else {
                showNotification("No song selected", "error");
            }
        }, 100);
    });
    
    // Only show the button for media item context menus and capture the song ID
    ContextMenu.onMediaItem(unloads, async ({ mediaCollection, contextMenu }: any) => {
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
        // swallow context menu extraction errors
            contextMenuSongId = null;
        }
        
        // Show our button in the context menu
    await contextMenuButton.show(contextMenu);
    });
}

// Start the plugin
init();