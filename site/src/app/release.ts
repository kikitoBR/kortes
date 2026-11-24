// The newest Kortes installer, so "Baixar" downloads it in one click and shows its
// version and size. Installers live in the public kikitoBR/kortes-releases (the
// code repo is private). Refreshed hourly; if GitHub does not answer, the button
// opens the releases page instead.

const REPO = "kikitoBR/kortes-releases";
const RELEASES = `https://github.com/${REPO}/releases/latest`;

export type Release = { url: string; version: string | null; sizeMb: number | null };

export async function latestRelease(): Promise<Release> {
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
      next: { revalidate: 3600 },
    });
    if (!response.ok) throw new Error(String(response.status));
    const data = (await response.json()) as {
      tag_name?: string;
      assets?: { name: string; size: number; browser_download_url: string }[];
    };
    const exe = data.assets?.find((asset) => /^KortesSetup-.*\.exe$/.test(asset.name));
    if (!exe) throw new Error("no installer");
    return {
      url: exe.browser_download_url,
      version: data.tag_name?.replace(/^v/, "") ?? null,
      sizeMb: Math.round(exe.size / 1024 / 1024),
    };
  } catch {
    return { url: RELEASES, version: null, sizeMb: null };
  }
}
