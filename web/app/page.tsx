import type { Metadata, Viewport } from 'next';
import PlayerApp from '@/components/PlayerApp';
import PlayerPageEffects from '@/components/player/PlayerPageEffects';
import Landing from '@/components/Landing';
import { absoluteUrl } from '@/lib/seo';
import { fetchStationMeta } from '@/lib/station';
import { getShowcaseStations } from '@/lib/stations';

// Read at request time so a deployment can flip player ↔ landing by just
// restarting the web container with a different env value, no rebuild.
export const dynamic = 'force-dynamic';

// Per-request metadata for the root. The baseline pins canonical + og:url to
// the absolute origin, which the Metadata API leaves untouched even though it
// drops metadataBase on this force-dynamic route.
//
// In player mode the share-card preview is personalised from the controller's
// station name + description (issues #272, #1086); landing mode, an unset
// station or any controller failure falls through to generic SUB/WAVE branding
// so the preview never breaks.
export async function generateMetadata(): Promise<Metadata> {
  const base: Metadata = {
    alternates: { canonical: absoluteUrl('/') },
    openGraph: { url: absoluteUrl('/') },
  };

  const mode = (process.env.SUBWAVE_HOMEPAGE || 'player').toLowerCase();
  if (mode !== 'player') return base;

  // allowPersonaTagline: issue #272 shipped tagline-personalised previews, so
  // keep them for installs with no station description. Setting one (admin →
  // Station → Share description) takes precedence.
  const meta = await fetchStationMeta({ allowPersonaTagline: true });
  if (!meta) return base;
  const { name, description } = meta;

  // openGraph/twitter are NOT deep-merged across the layout→page chain (see
  // lib/seo.ts pageMeta), so restate them fully here. The layout's hand-written
  // og:image/twitter:image <meta> tags are emitted independently and remain.
  return {
    title: name,
    description,
    alternates: { canonical: absoluteUrl('/') },
    openGraph: {
      title: name,
      description,
      siteName: name,
      url: absoluteUrl('/'),
      type: 'website',
    },
    twitter: { title: name, description },
  };
}

// Fixed app-shell layouts lock out pinch-zoom so they behave like a native app
// on mobile. Merges with the root viewport.
export const viewport: Viewport = {
  maximumScale: 1,
  userScalable: false,
};

export default async function HomePage() {
  const mode = (process.env.SUBWAVE_HOMEPAGE || 'player').toLowerCase();
  if (mode === 'landing') {
    return <Landing stations={await getShowcaseStations()} />;
  }
  return (
    <>
      <PlayerPageEffects />
      <PlayerApp />
    </>
  );
}
