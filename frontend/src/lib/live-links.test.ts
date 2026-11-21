import { describe, expect, it } from "vitest";
import { isLiveLink, liveEmbedUrls } from "./live-links";

describe("live links", () => {
  it("knows which links are lives", () => {
    expect(isLiveLink("https://www.twitch.tv/gaules")).toBe(true);
    expect(isLiveLink("https://kick.com/someone")).toBe(true);
    expect(isLiveLink("https://www.youtube.com/@canal/live")).toBe(true);
    expect(isLiveLink("https://www.youtube.com/live/abcdefghijk")).toBe(true);
    expect(isLiveLink("https://www.youtube.com/watch?v=abcdefghijk")).toBe(false);
    expect(isLiveLink("not a link")).toBe(false);
  });

  it("builds the official player and chat for this site", () => {
    const twitch = liveEmbedUrls({ platform: "twitch", channel: "gaules" }, "clips.kikito.site")!;
    expect(twitch.player).toContain("player.twitch.tv/?channel=gaules&parent=clips.kikito.site");
    expect(twitch.chat).toContain("twitch.tv/embed/gaules/chat?parent=clips.kikito.site");
    const youtube = liveEmbedUrls({ platform: "youtube", video_id: "abc" }, "clips.kikito.site")!;
    expect(youtube.chat).toContain("live_chat?v=abc&embed_domain=clips.kikito.site");
    expect(liveEmbedUrls({ platform: "kick", channel: "x" }, "h")!.chat).toBe("https://kick.com/popout/x/chat");
    expect(liveEmbedUrls({ platform: "youtube" }, "h")).toBeNull();
  });
});
