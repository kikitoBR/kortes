export type LivePlatform = "youtube" | "twitch" | "kick";

export interface LiveEmbed {
  platform: LivePlatform;
  channel?: string;
  video_id?: string;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Twitch and Kick channel links are always lives; YouTube only when the link says /live. */
export function isLiveLink(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  if (host === "twitch.tv" || host.endsWith(".twitch.tv") || host === "kick.com" || host.endsWith(".kick.com")) return true;
  if (host.endsWith("youtube.com")) {
    try {
      return /\/live(\/|$)/.test(new URL(url.trim()).pathname);
    } catch {
      return false;
    }
  }
  return false;
}

/** Official player and chat addresses for a live (the chats need this site's host). */
export function liveEmbedUrls(embed: LiveEmbed, host: string): { player: string; chat: string; page: string } | null {
  if (embed.platform === "youtube" && embed.video_id) {
    const id = encodeURIComponent(embed.video_id);
    return {
      player: `https://www.youtube.com/embed/${id}?autoplay=1&mute=1&playsinline=1`,
      chat: `https://www.youtube.com/live_chat?v=${id}&embed_domain=${encodeURIComponent(host)}&dark_theme=1`,
      page: `https://www.youtube.com/watch?v=${id}`,
    };
  }
  if (embed.platform === "twitch" && embed.channel) {
    const channel = encodeURIComponent(embed.channel);
    const parent = encodeURIComponent(host);
    return {
      player: `https://player.twitch.tv/?channel=${channel}&parent=${parent}&muted=true&autoplay=true`,
      chat: `https://www.twitch.tv/embed/${channel}/chat?parent=${parent}&darkpopout`,
      page: `https://www.twitch.tv/${channel}`,
    };
  }
  if (embed.platform === "kick" && embed.channel) {
    const channel = encodeURIComponent(embed.channel);
    return {
      player: `https://player.kick.com/${channel}?muted=true&autoplay=true`,
      chat: `https://kick.com/popout/${channel}/chat`,
      page: `https://kick.com/${channel}`,
    };
  }
  return null;
}
