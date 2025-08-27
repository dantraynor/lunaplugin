import { redux, Playlist, TidalApi } from "@luna/lib";

export type SongInPlaylistsResult = {
  existsInPlaylists: boolean;
  playlists: Array<{ uuid: string; title: string }>;
};

/**
 * Check if a song exists in any of the current user's playlists by exact id match.
 */
export async function checkSongInUserPlaylists(songId: string): Promise<SongInPlaylistsResult> {
  try {
    const state = redux.store.getState();
    const currentUserId: string | undefined = state.user?.meta?.id;

    if (!currentUserId) {
      console.error("checkSongInUserPlaylists: Missing current user id");
      return { existsInPlaylists: false, playlists: [] };
    }

    const playlistsRecord = state.content?.playlists ?? {};
    let userPlaylists = Object.values(playlistsRecord).filter(
      (pl: any) => pl && pl.type === "USER" && pl.creator?.id === currentUserId
    ) as Playlist[];

    // Fallback: if Redux hasn't populated playlists yet, try Playlist API helpers
    if (userPlaylists.length === 0) {
      try {
        const anyPlaylist = Playlist as any;
        if (typeof anyPlaylist?.getUserPlaylists === "function") {
          const arr = await anyPlaylist.getUserPlaylists();
          userPlaylists = Array.isArray(arr) ? arr : [];
          console.debug("checkSongInUserPlaylists: used Playlist.getUserPlaylists fallback");
        } else if (typeof anyPlaylist?.getMyPlaylists === "function") {
          const arr = await anyPlaylist.getMyPlaylists();
          userPlaylists = Array.isArray(arr) ? arr : [];
          console.debug("checkSongInUserPlaylists: used Playlist.getMyPlaylists fallback");
        }
      } catch (e) {
        console.error("checkSongInUserPlaylists: fallback to Playlist.* failed", e);
      }
    }

    if (userPlaylists.length === 0) {
      console.debug("checkSongInUserPlaylists: No user playlists found for current user");
      return { existsInPlaylists: false, playlists: [] };
    }

    const containingPlaylists: Array<{ uuid: string; title: string }> = [];

    await Promise.all(
      userPlaylists.map(async (pl) => {
        try {
          const items = await TidalApi.playlistItems(pl.uuid);
          const rawList: any = Array.isArray(items) ? items : (items as any)?.items ?? [];

          const normalize = (v: any) => (v === undefined || v === null ? undefined : String(v));
          const needle = normalize(songId);

          const exists = rawList.some((it: any) => {
            const entry = it?.item ?? it;
            const candidates = [
              entry?.id,
              entry?.mediaItemId,
              entry?.trackId,
              entry?.itemId,
              entry?.productId,
            ];
            return candidates.map(normalize).some((cid) => cid !== undefined && cid === needle);
          });

          if (exists) {
            containingPlaylists.push({
              uuid: pl.uuid,
              title: (pl as any).title ?? "Untitled Playlist",
            });
          }
        } catch (err) {
          console.error(`checkSongInUserPlaylists: Failed to fetch items for playlist ${pl.uuid}`, err);
        }
      })
    );

    return {
      existsInPlaylists: containingPlaylists.length > 0,
      playlists: containingPlaylists,
    };
  } catch (err) {
    console.error("checkSongInUserPlaylists: Unexpected error", err);
    return { existsInPlaylists: false, playlists: [] };
  }
}

/**
 * Fallback check by metadata (title and optional primary artist).
 * Useful when the exact id for the MediaItem doesn't match the id in playlist entries.
 */
export async function checkSongInUserPlaylistsByMeta(meta: { title: string; artist?: string }): Promise<SongInPlaylistsResult> {
  try {
    const state = redux.store.getState();
    const currentUserId: string | undefined = state.user?.meta?.id;

    if (!currentUserId) {
      console.error("checkSongInUserPlaylistsByMeta: Missing current user id");
      return { existsInPlaylists: false, playlists: [] };
    }

    const playlistsRecord = state.content?.playlists ?? {};
    let userPlaylists = Object.values(playlistsRecord).filter(
      (pl: any) => pl && pl.type === "USER" && pl.creator?.id === currentUserId
    ) as Playlist[];

    if (userPlaylists.length === 0) {
      try {
        const anyPlaylist = Playlist as any;
        if (typeof anyPlaylist?.getUserPlaylists === "function") {
          const arr = await anyPlaylist.getUserPlaylists();
          userPlaylists = Array.isArray(arr) ? arr : [];
        } else if (typeof anyPlaylist?.getMyPlaylists === "function") {
          const arr = await anyPlaylist.getMyPlaylists();
          userPlaylists = Array.isArray(arr) ? arr : [];
        }
      } catch (e) {
        console.error("checkSongInUserPlaylistsByMeta: fallback to Playlist.* failed", e);
      }
    }

    if (userPlaylists.length === 0) {
      return { existsInPlaylists: false, playlists: [] };
    }

    const normalize = (s: any) =>
      String(s ?? "")
        .toLowerCase()
        .replace(/[\s\u00A0]+/g, " ")
        .replace(/[^a-zA-Z0-9\s]/g, "")
        .trim();

    const targetTitle = normalize(meta.title);
    const targetArtist = meta.artist ? normalize(meta.artist) : "";

    const containingPlaylists: Array<{ uuid: string; title: string }> = [];

    await Promise.all(
      userPlaylists.map(async (pl) => {
        try {
          const items = await TidalApi.playlistItems(pl.uuid);
          const rawList: any = Array.isArray(items) ? items : (items as any)?.items ?? [];

          const exists = rawList.some((it: any) => {
            const entry = it?.item ?? it;
            const eTitle = normalize(entry?.title);
            const eArtist =
              normalize(
                entry?.artist?.name ??
                (Array.isArray(entry?.artists) && entry.artists[0]?.name) ??
                (entry?.artists && entry.artists[0] && entry.artists[0].name)
              );

            if (!targetTitle) return false;
            if (targetArtist) {
              return eTitle === targetTitle && eArtist === targetArtist;
            }
            return eTitle === targetTitle;
          });

          if (exists) {
            containingPlaylists.push({
              uuid: pl.uuid,
              title: (pl as any).title ?? "Untitled Playlist",
            });
          }
        } catch (err) {
          console.error(`checkSongInUserPlaylistsByMeta: Failed to fetch items for playlist ${pl.uuid}`, err);
        }
      })
    );

    return {
      existsInPlaylists: containingPlaylists.length > 0,
      playlists: containingPlaylists,
    };
  } catch (err) {
    console.error("checkSongInUserPlaylistsByMeta: Unexpected error", err);
    return { existsInPlaylists: false, playlists: [] };
  }
}