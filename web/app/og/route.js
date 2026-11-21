import { ImageResponse } from 'next/og';

// The social share card, served at /og. 1200x630 is the canonical Open Graph
// size. A plain route handler, NOT the `opengraph-image` file convention: that
// rebuilds the URL from `metadataBase`, which Next drops on the force-dynamic
// homepage and pins to localhost. From a normal route app/layout.js emits its
// own absolute <meta og:image>.
//
// With a station logo set (Settings → Station, controller branding/
// station-logo.ts), the card is the station's own: the logo alone, fitted and
// never cropped, on a background taken from the logo (lib/share-card.ts).
// Without one, or when the controller can't be reached, it is the stock
// SUB/WAVE card below, unchanged. Read per request so a new
// logo shows without a rebuild; shared caches keep it an hour.

import sharp from 'sharp';
import { cardColours } from '@/lib/share-card';

export const contentType = 'image/png';
export const dynamic = 'force-dynamic';

const CONTROLLER_BASE = (process.env.CONTROLLER_INTERNAL_URL || 'http://localhost:7701').replace(/\/$/, '');
// The logo's box: the card less a margin, so a wide logo uses the width and a
// square one the height.
const LOGO_W = 1040;
const LOGO_H = 510;
const CACHE = { 'Cache-Control': 'public, max-age=3600' };

const BG = '#100e0c';
const INK = '#ece6dc';
const MUTED = '#8a8278';
const ACCENT = '#d94b2a';

// The station logo's bytes, or null: no logo (the controller redirects to the
// app icon), an error, or a slow answer all mean the stock card.
async function fetchLogo() {
  try {
    const res = await fetch(`${CONTROLLER_BASE}/station-logo`, {
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(2000),
    });
    if (res.status !== 200 || !/^image\//.test(res.headers.get('content-type') || '')) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

// The logo as a PNG fitted into the logo box (any format the upload takes,
// WebP included, which the card renderer can't read), and its colours.
async function prepareLogo(buf) {
  const png = await sharp(buf)
    .resize(LOGO_W, LOGO_H, { fit: 'inside', withoutEnlargement: false })
    .png()
    .toBuffer({ resolveWithObject: true });
  const raw = await sharp(buf)
    .ensureAlpha()
    .resize(32, 32, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    src: `data:image/png;base64,${png.data.toString('base64')}`,
    width: png.info.width,
    height: png.info.height,
    colours: cardColours(new Uint8Array(raw.data), raw.info.width, raw.info.height),
  };
}

// The logo alone, centred and as large as the card's height allows: the
// station name is already the preview's title, so the picture does not
// repeat it.
function LogoCard({ logo }) {
  return (
    <div
      style={{
        width: 1200,
        height: 630,
        background: logo.colours.background,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <img src={logo.src} width={logo.width} height={logo.height} alt="" />
    </div>
  );
}

function StockCard() {
  return (
      <div
        style={{
          width: 1200,
          height: 630,
          background: BG,
          color: INK,
          display: 'flex',
          flexDirection: 'column',
          fontFamily: 'monospace',
          padding: '56px 64px',
          boxSizing: 'border-box',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            paddingBottom: 22,
            borderBottom: `2px solid ${INK}`,
            fontSize: 16,
            letterSpacing: '0.28em',
            textTransform: 'uppercase',
            fontWeight: 700,
          }}
        >
          <span>SUB/WAVE</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: ACCENT, fontSize: 14 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: ACCENT, display: 'block' }} />
            <span>ON AIR</span>
          </div>
        </div>

        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            gap: 26,
          }}
        >
          <div
            style={{
              color: MUTED,
              fontSize: 20,
              letterSpacing: '0.24em',
              textTransform: 'uppercase',
              fontWeight: 700,
            }}
          >
            A real internet radio station
          </div>
          <div
            style={{
              fontSize: 92,
              lineHeight: 0.98,
              fontWeight: 800,
              letterSpacing: '-0.02em',
              color: INK,
            }}
          >
            The radio station with a DJ who never sleeps.
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            paddingTop: 22,
            borderTop: `1px solid ${INK}`,
            color: MUTED,
            fontSize: 18,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
          }}
        >
          <span style={{ color: INK }}>One stream</span>
          <span>·</span>
          <span>AI DJ between tracks</span>
          <span>·</span>
          <span style={{ color: ACCENT }}>Open source</span>
        </div>
      </div>
  );
}

export async function GET() {
  const buf = await fetchLogo();
  if (buf) {
    try {
      const logo = await prepareLogo(buf);
      return new ImageResponse(<LogoCard logo={logo} />, { width: 1200, height: 630, headers: CACHE });
    } catch {
      // An image sharp can't read: the stock card, never a broken preview.
    }
  }
  return new ImageResponse(<StockCard />, { width: 1200, height: 630, headers: CACHE });
}
